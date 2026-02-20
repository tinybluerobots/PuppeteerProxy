import { describe, test, expect, beforeAll, afterAll } from 'bun:test'

const PORT = 9876
const API_KEY = 'test-api-key-12345'
const BASE_URL = `http://localhost:${PORT}`

let serverProcess: import('bun').Subprocess

beforeAll(async () => {
  serverProcess = Bun.spawn(['bun', 'run', 'index.ts'], {
    env: { ...process.env, PORT: String(PORT), API_KEY },
    stdout: 'pipe',
    stderr: 'pipe'
  })

  // Wait for server to be ready
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE_URL}/`)
      if (res.ok) break
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
})

afterAll(() => {
  serverProcess?.kill()
})

// Parse SSE response body into JSON-RPC messages
async function parseSSEResponse(res: Response): Promise<any[]> {
  const text = await res.text()
  const messages: any[] = []
  for (const block of text.split('\n\n')) {
    const dataLine = block
      .split('\n')
      .find((line) => line.startsWith('data: '))
    if (dataLine) {
      messages.push(JSON.parse(dataLine.slice(6)))
    }
  }
  return messages
}

// Helper to make JSON-RPC requests to the MCP endpoint
async function mcpRequest(
  body: object,
  headers: Record<string, string> = {}
): Promise<{ res: Response; messages: any[] }> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-api-key': API_KEY,
      ...headers
    },
    body: JSON.stringify(body)
  })

  // For error responses, don't try to parse SSE
  if (res.status >= 400) {
    return { res, messages: [] }
  }

  const messages = await parseSSEResponse(res)
  return { res, messages }
}

// Initialize an MCP session and return the session ID
async function initializeSession(): Promise<string> {
  const { res } = await mcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    }
  })

  const sessionId = res.headers.get('mcp-session-id')
  if (!sessionId) throw new Error('No session ID returned')

  // Send initialized notification
  await mcpRequest(
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    },
    { 'mcp-session-id': sessionId }
  )

  return sessionId
}

describe('MCP endpoint', () => {
  test('rejects requests without API key', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' }
        }
      })
    })
    expect(res.status).toBe(403)
  })

  test('rejects requests with wrong API key', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'x-api-key': 'wrong-key'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' }
        }
      })
    })
    expect(res.status).toBe(403)
  })

  test('initializes a session', async () => {
    const { res, messages } = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    })

    expect(res.status).toBe(200)
    const sessionId = res.headers.get('mcp-session-id')
    expect(sessionId).toBeTruthy()

    const body = messages[0]
    expect(body.result).toBeDefined()
    expect(body.result.protocolVersion).toBe('2025-03-26')
    expect(body.result.serverInfo.name).toBe('puppeteer-proxy')
    expect(body.result.capabilities.tools).toBeDefined()
  })

  test('lists tools with fetch_page', async () => {
    const sessionId = await initializeSession()

    const { res, messages } = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      },
      { 'mcp-session-id': sessionId }
    )

    expect(res.status).toBe(200)
    const body = messages[0]
    expect(body.result.tools).toBeArray()
    expect(body.result.tools.length).toBe(1)

    const tool = body.result.tools[0]
    expect(tool.name).toBe('fetch_page')
    expect(tool.description).toContain('headless Chrome')
    expect(tool.inputSchema.properties.url).toBeDefined()
    expect(tool.inputSchema.properties.method).toBeDefined()
    expect(tool.inputSchema.properties.headers).toBeDefined()
    expect(tool.inputSchema.properties.timeout).toBeDefined()
    expect(tool.inputSchema.required).toContain('url')
  })

  test('calls fetch_page tool', async () => {
    const sessionId = await initializeSession()

    const { res, messages } = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'fetch_page',
          arguments: {
            url: 'https://example.com',
            timeout: 15000
          }
        }
      },
      { 'mcp-session-id': sessionId }
    )

    expect(res.status).toBe(200)
    const body = messages[0]
    expect(body.result).toBeDefined()
    expect(body.result.content).toBeArray()
    expect(body.result.content[0].type).toBe('text')
    expect(body.result.content[0].text).toContain('Status: 200')
    expect(body.result.content[0].text).toContain('Example Domain')
  }, 30000)

  test('rejects non-initialize request without session', async () => {
    const { res } = await mcpRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    })

    expect(res.status).toBe(400)
  })

  test('rejects request with invalid session ID', async () => {
    const { res } = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      },
      { 'mcp-session-id': 'non-existent-session' }
    )

    // Transport rejects unknown sessions
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

describe('Resource blocking', () => {
  test('blocks image and media subrequests but allows scripts', async () => {
    const requestedPaths: string[] = []
    const trackingServer = Bun.serve({
      port: 9877,
      fetch(req) {
        const url = new URL(req.url)
        requestedPaths.push(url.pathname)
        if (url.pathname === '/') {
          return new Response(`
            <html>
              <body>
                <h1>Resource Test</h1>
                <img src="/image.png">
                <video src="/video.mp4"></video>
                <script src="/script.js"></script>
              </body>
            </html>
          `, { headers: { 'Content-Type': 'text/html' } })
        }
        if (url.pathname === '/script.js') {
          return new Response('document.title = "loaded"', {
            headers: { 'Content-Type': 'application/javascript' }
          })
        }
        return new Response('', { status: 200 })
      }
    })

    try {
      const res = await fetch(`${BASE_URL}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY
        },
        body: JSON.stringify({
          url: 'http://localhost:9877/',
          timeout: 15000
        })
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe(200)
      expect(body.text).toContain('Resource Test')

      // Scripts should be allowed through
      expect(requestedPaths).toContain('/script.js')
      // Images and media should be blocked
      expect(requestedPaths).not.toContain('/image.png')
      expect(requestedPaths).not.toContain('/video.mp4')
    } finally {
      trackingServer.stop()
    }
  }, 30000)
})

describe('REST endpoint', () => {
  test('still works after MCP changes', async () => {
    const res = await fetch(`${BASE_URL}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify({
        url: 'https://example.com',
        timeout: 15000
      })
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe(200)
    expect(body.text).toContain('Example Domain')
  }, 30000)
})
