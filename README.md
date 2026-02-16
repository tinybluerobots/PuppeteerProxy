# PuppeteerProxy

A headless Chrome web fetching service with built-in anti-detection measures. Send a URL, get the fully rendered page content back.

### Prerequisites

- [Bun](https://bun.sh)

### Local Installation

```bash
# Clone the repository
git clone [your-repo-url]
cd PuppeteerProxy

# Install dependencies
./install.sh
# OR
bun install
```

## Usage

### Starting the Server

```bash
bun start
```

The server will start on port 8000 by default, or you can set a custom port using the `PORT` environment variable.

### API Endpoints

#### Health Check

```
GET /
```

Returns "Ready" if the server is up and running.

#### Make a Request

```
POST /
```

Headers:
- `x-api-key`: Your API key for authentication (set via API_KEY environment variable)

Request Body:
```json
{
  "url": "https://example.com",
  "method": "GET",
  "headers": {
    "User-Agent": "Custom User Agent"
  },
  "data": {},
  "timeout": 10000
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | The URL to request |
| `method` | string | No | HTTP method (default: GET) |
| `headers` | object | No | Custom headers to send |
| `data` | object | No | Request body for POST/PUT requests |
| `timeout` | number | No | Request timeout in ms (default: 10000) |
| `proxy` | string | No | Upstream proxy URL (ignored if `HTTP_PROXY` env var is set) |

#### Upstream Proxy Configuration

Route browser traffic through an external proxy:

**1. Environment Variable**

Set `HTTP_PROXY` to use a global proxy for all requests:

```bash
HTTP_PROXY="http://user:pass@proxy.example.com:8080" bun start
```

When `HTTP_PROXY` is set, the per-request `proxy` field is ignored.

**2. Per-Request Proxy**

When `HTTP_PROXY` is not set, you can specify a proxy per request. Supports embedded credentials:

```json
{
  "url": "https://example.com",
  "proxy": "http://user:pass@proxy.example.com:8080"
}
```

Response:
```json
{
  "status": 200,
  "headers": {
    "content-type": "text/html; charset=utf-8",
    ...
  },
  "text": "<html>..."
}
```

### MCP (Model Context Protocol) Endpoint

PuppeteerProxy also exposes an MCP endpoint, allowing AI assistants (Claude Code, Claude Desktop, etc.) to call it directly as a tool.

#### Client Configuration

Add to your MCP client config (e.g. `~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "puppeteer-proxy": {
      "type": "streamable-http",
      "url": "http://localhost:8000/mcp",
      "headers": {
        "x-api-key": "your_api_key"
      }
    }
  }
}
```

#### Tool: `fetch_page`

Fetches a URL using headless Chrome with full JavaScript rendering and anti-bot-detection measures.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | The URL to fetch |
| `method` | string | No | HTTP method (default: GET) |
| `headers` | object | No | Custom request headers |
| `data` | string | No | POST body data (JSON string) |
| `proxy` | string | No | Upstream proxy URL |
| `timeout` | number | No | Navigation timeout in ms (default: 30000) |

#### Manual Testing

```bash
# Initialize a session
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: your_api_key" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
```

## Docker Deployment

```bash
# Build the Docker image
docker build -t puppeteerproxy .

# Run the container
docker run -p 8000:8000 -e API_KEY=your_api_key puppeteerproxy

# Run with proxy
docker run -p 8000:8000 \
  -e API_KEY=your_api_key \
  -e HTTP_PROXY="http://user:pass@proxy.example.com:8080" \
  puppeteerproxy
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 8000 |
| `API_KEY` | API key for authentication | - |
| `HTTP_PROXY` | Upstream proxy URL | - |
