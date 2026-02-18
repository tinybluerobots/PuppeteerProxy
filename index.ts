import puppeteer, { Browser } from 'puppeteer'
import express from 'express'
import compression from 'compression'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

// Parse proxy URL: http://user:pass@host:port
function parseProxyUrl(proxyEnv?: string) {
  if (!proxyEnv) return { url: undefined, user: undefined, pass: undefined }

  const parsed = new URL(proxyEnv)
  const user = parsed.username || undefined
  const pass = parsed.password || undefined

  // Rebuild URL without credentials
  parsed.username = ''
  parsed.password = ''
  const url = parsed.toString().replace(/\/$/, '') // Remove trailing slash

  return { url, user, pass }
}

const { url: PROXY_URL, user: PROXY_USER, pass: PROXY_PASS } = parseProxyUrl(
  process.env.HTTP_PROXY
)

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-webrtc',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
]

// Persistent browser pool keyed by proxy URL (empty string = no proxy)
const browserPool = new Map<string, { browser: Browser; refCount: number; lastUsed: number }>()

async function getBrowser(proxyUrl?: string): Promise<Browser> {
  const key = proxyUrl || ''
  const entry = browserPool.get(key)

  if (entry) {
    // Verify the browser is still alive
    try {
      await entry.browser.version()
      entry.refCount++
      entry.lastUsed = Date.now()
      return entry.browser
    } catch {
      // Browser died, remove from pool and launch a new one
      browserPool.delete(key)
    }
  }

  const args = [
    ...BROWSER_ARGS,
    ...(proxyUrl ? [`--proxy-server=${proxyUrl}`] : [])
  ]
  const browser = await puppeteer.launch({ headless: true, args })
  browserPool.set(key, { browser, refCount: 1, lastUsed: Date.now() })

  browser.on('disconnected', () => {
    browserPool.delete(key)
  })

  return browser
}

function releaseBrowser(proxyUrl?: string) {
  const key = proxyUrl || ''
  const entry = browserPool.get(key)
  if (entry) {
    entry.refCount = Math.max(0, entry.refCount - 1)
    entry.lastUsed = Date.now()
  }
}

// Evict idle browsers every 30s — closes browsers idle >60s with no active pages
const IDLE_TIMEOUT_MS = 60_000
setInterval(async () => {
  const now = Date.now()
  for (const [key, entry] of browserPool) {
    if (entry.refCount === 0 && now - entry.lastUsed > IDLE_TIMEOUT_MS) {
      console.log(`Evicting idle browser for proxy: ${key || '(direct)'}`)
      browserPool.delete(key)
      await entry.browser.close().catch(() => {})
    }
  }
}, 30_000)

// Concurrency limiter to prevent too many pages at once
const MAX_CONCURRENT_PAGES = parseInt(process.env.MAX_PAGES || '5', 10)
let activePage = 0
const pageQueue: Array<() => void> = []

function acquirePageSlot(): Promise<void> {
  if (activePage < MAX_CONCURRENT_PAGES) {
    activePage++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    pageQueue.push(resolve)
  })
}

function releasePageSlot() {
  activePage--
  const next = pageQueue.shift()
  if (next) {
    activePage++
    next()
  }
}

type HttpRequest = {
  data: object
  headers: Record<string, string>
  method: string
  proxy?: string
  timeout: number
  url: string
}
type HttpResponse = {
  headers: Record<string, string>
  status: number
  text: string
}

async function fetchPage(httpRequest: HttpRequest): Promise<HttpResponse> {
  await acquirePageSlot()

  let proxyUrl: string | undefined
  let proxyUser: string | undefined
  let proxyPass: string | undefined

  // Use env var proxy if set, otherwise per-request proxy
  if (PROXY_URL) {
    proxyUrl = PROXY_URL
    proxyUser = PROXY_USER
    proxyPass = PROXY_PASS
  } else if (httpRequest.proxy) {
    const parsed = parseProxyUrl(httpRequest.proxy)
    proxyUrl = parsed.url
    proxyUser = parsed.user
    proxyPass = parsed.pass
  }

  const browser = await getBrowser(proxyUrl)
  let page: Awaited<ReturnType<Browser['newPage']>> | undefined

  try {
    page = await browser.newPage()

    // Authenticate proxy if credentials provided
    if (proxyUser && proxyPass) {
      await page.authenticate({
        username: proxyUser,
        password: proxyPass
      })
    }

    // Set user-agent via CDP (use from headers or default)
    const defaultUserAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    const userAgent =
      httpRequest.headers?.['User-Agent'] ||
      httpRequest.headers?.['user-agent'] ||
      defaultUserAgent
    const client = await page.createCDPSession()
    await client.send('Network.setUserAgentOverride', {
      userAgent,
      userAgentMetadata: {
        brands: [
          { brand: 'Not_A Brand', version: '8' },
          { brand: 'Chromium', version: '120' },
          { brand: 'Google Chrome', version: '120' }
        ],
        fullVersion: '120.0.0.0',
        platform: 'Windows',
        platformVersion: '10.0.0',
        architecture: 'x86',
        model: '',
        mobile: false
      }
    })
    await page.setViewport({ width: 1920, height: 1080 })

    await page.evaluateOnNewDocument(() => {
      // Webdriver - should be undefined, not false
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })

      // Chrome runtime (headless lacks this)
      Object.defineProperty(window, 'chrome', {
        value: {
          runtime: {},
          loadTimes: () => ({}),
          csi: () => ({}),
          app: {}
        }
      })

      // Permissions API fix
      const originalQuery = window.navigator.permissions.query.bind(
        window.navigator.permissions
      )
      Object.defineProperty(window.navigator.permissions, 'query', {
        value: (parameters: PermissionDescriptor) =>
          parameters.name === 'notifications'
            ? Promise.resolve({
                state: Notification.permission
              } as PermissionStatus)
            : originalQuery(parameters)
      })

      // Plugins with realistic structure
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const plugins = [
            {
              name: 'Chrome PDF Plugin',
              filename: 'internal-pdf-viewer',
              description: 'Portable Document Format'
            },
            {
              name: 'Chrome PDF Viewer',
              filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
              description: ''
            },
            {
              name: 'Native Client',
              filename: 'internal-nacl-plugin',
              description: ''
            }
          ]
          return plugins
        }
      })

      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en']
      })

      // WebGL vendor/renderer spoofing
      const getParameterProto =
        WebGLRenderingContext.prototype.getParameter
      WebGLRenderingContext.prototype.getParameter = function (
        parameter: number
      ) {
        // UNMASKED_VENDOR_WEBGL
        if (parameter === 37445) return 'Intel Inc.'
        // UNMASKED_RENDERER_WEBGL
        if (parameter === 37446) return 'Intel Iris OpenGL Engine'
        return getParameterProto.call(this, parameter)
      }

      // Also patch WebGL2
      const getParameter2Proto =
        WebGL2RenderingContext.prototype.getParameter
      WebGL2RenderingContext.prototype.getParameter = function (
        parameter: number
      ) {
        if (parameter === 37445) return 'Intel Inc.'
        if (parameter === 37446) return 'Intel Iris OpenGL Engine'
        return getParameter2Proto.call(this, parameter)
      }

      // User-Agent Client Hints
      Object.defineProperty(navigator, 'userAgentData', {
        get: () => ({
          brands: [
            { brand: 'Not_A Brand', version: '8' },
            { brand: 'Chromium', version: '120' },
            { brand: 'Google Chrome', version: '120' }
          ],
          mobile: false,
          platform: 'Windows',
          getHighEntropyValues: () =>
            Promise.resolve({
              architecture: 'x86',
              model: '',
              platform: 'Windows',
              platformVersion: '10.0.0',
              uaFullVersion: '120.0.0.0'
            })
        })
      })

      // Screen/window dimensions
      Object.defineProperty(window, 'outerWidth', { get: () => 1920 })
      Object.defineProperty(window, 'outerHeight', { get: () => 1080 })
      Object.defineProperty(window, 'innerWidth', { get: () => 1920 })
      Object.defineProperty(window, 'innerHeight', { get: () => 969 })

      // Hardware properties
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 })

      // Connection API
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: 50,
          downlink: 10,
          saveData: false
        })
      })
    })
    page.setDefaultTimeout(httpRequest.timeout || 30000)
    await page.setRequestInterception(true)

    const currentPage = page
    currentPage.on('request', async (request) => {
      // Only modify the main navigation request, let subrequests pass through normally
      if (request.isNavigationRequest() && request.frame() === currentPage.mainFrame()) {
        await request.continue({
          method: httpRequest.method,
          headers: httpRequest.headers || {},
          postData: httpRequest.data
            ? JSON.stringify(httpRequest.data)
            : undefined
        })
      } else {
        await request.continue()
      }
    })

    const response = await page.goto(httpRequest.url)
    if (!response) {
      throw new Error('No response received from page')
    }

    return {
      status: response.status(),
      headers: response.headers(),
      text: await response.text()
    }
  } finally {
    if (page) {
      await page.close().catch(() => {})
    }
    releaseBrowser(proxyUrl)
    releasePageSlot()
  }
}

// --- MCP Server Setup ---

function createMcpServer(): McpServer {
  const mcp = new McpServer({
    name: 'puppeteer-proxy',
    version: '1.0.0'
  })

  mcp.tool(
    'fetch_page',
    'Fetch a URL using a headless Chrome browser with full JavaScript rendering and anti-bot-detection measures',
    {
      url: z.string().describe('The URL to fetch'),
      method: z.string().optional().describe('HTTP method (default: GET)'),
      headers: z.record(z.string(), z.string()).optional().describe('Custom request headers'),
      data: z.string().optional().describe('POST body data (JSON string)'),
      proxy: z.string().optional().describe('Upstream proxy URL'),
      timeout: z.number().optional().describe('Navigation timeout in ms (default: 30000)')
    },
    async (args) => {
      let parsedData: object | undefined
      if (args.data) {
        try {
          parsedData = JSON.parse(args.data)
        } catch {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'Invalid JSON in data parameter' }]
          }
        }
      }

      const httpRequest: HttpRequest = {
        url: args.url,
        method: args.method || 'GET',
        headers: args.headers || {},
        data: parsedData as object,
        proxy: args.proxy,
        timeout: args.timeout || 30000
      }

      try {
        const result = await fetchPage(httpRequest)

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Status: ${result.status}`,
                `Headers: ${JSON.stringify(result.headers)}`,
                '',
                result.text
              ].join('\n')
            }
          ]
        }
      } catch (e) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: `Fetch failed: ${e instanceof Error ? e.message : 'Unknown error'}`
          }]
        }
      }
    }
  )

  return mcp
}

// --- Express App ---

const run = async () => {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(compression())

  function getHeader(req: express.Request, name: string): string | undefined {
    const value = req.headers[name]
    return Array.isArray(value) ? value[0] : value
  }

  app.get('/', (_, res) => {
    res.send('Ready')
  })

  // REST endpoint
  app.post('/', async (req, res) => {
    if (getHeader(req, 'x-api-key') !== process.env.API_KEY) {
      res.status(403).send('Unauthorized')
      return
    }
    const httpRequest: HttpRequest = req.body
    httpRequest.method = httpRequest.method || 'GET'
    if (!httpRequest.url) {
      res.status(400).send('URL is required')
      return
    }

    try {
      const httpResponse = await fetchPage(httpRequest)
      res.send(httpResponse)
    } catch (e) {
      if (e instanceof Error) {
        res.status(500).send(e.message)
      } else {
        res.status(500).send('An error occurred')
      }
    }
  })

  // MCP endpoint - stateful session management
  const transports = new Map<string, StreamableHTTPServerTransport>()

  function getSessionTransport(req: express.Request): StreamableHTTPServerTransport | undefined {
    const sessionId = getHeader(req, 'mcp-session-id')
    return sessionId ? transports.get(sessionId) : undefined
  }

  app.post('/mcp', async (req, res) => {
    if (getHeader(req, 'x-api-key') !== process.env.API_KEY) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null
      })
      return
    }

    try {
      // Existing session
      const existing = getSessionTransport(req)
      if (existing) {
        await existing.handleRequest(req, res, req.body)
        return
      }

      // New session (initialize request)
      if (!getHeader(req, 'mcp-session-id') && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport)
          }
        })

        transport.onclose = () => {
          const sid = transport.sessionId
          if (sid) transports.delete(sid)
        }

        const server = createMcpServer()
        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)
        return
      }

      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Bad Request: No valid session or initialize request' },
        id: null
      })
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error' },
          id: null
        })
      }
    }
  })

  app.get('/mcp', async (req, res) => {
    const transport = getSessionTransport(req)
    if (!transport) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Bad Request: Invalid or missing session ID' },
        id: null
      })
      return
    }
    await transport.handleRequest(req, res)
  })

  app.delete('/mcp', async (req, res) => {
    const transport = getSessionTransport(req)
    if (!transport) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Bad Request: Invalid or missing session ID' },
        id: null
      })
      return
    }
    await transport.handleRequest(req, res)
  })

  app.listen(process.env.PORT || 8000, () => console.log('Server is running'))

  // Graceful shutdown: close all pooled browsers
  const shutdown = async () => {
    console.log('Shutting down, closing browsers...')
    const closes = [...browserPool.values()].map(({ browser }) =>
      browser.close().catch(() => {})
    )
    await Promise.all(closes)
    browserPool.clear()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
run()
