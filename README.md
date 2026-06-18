# docker-mcp-hosted

**Cloudflare Worker-hosted Docker MCP gateway — connect to your Docker daemon from anywhere.**

[![npm](https://img.shields.io/npm/v/@supernova123/docker-mcp-hosted?color=blue)](https://www.npmjs.com/package/@supernova123/docker-mcp-hosted)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What This Is

A Cloudflare Worker that sits between your AI client and your self-hosted Docker MCP server. Your Docker daemon stays on your machine — the Worker is the edge gateway that handles authentication, rate limiting, and tool access tiers.

```
AI Client (Claude Desktop, Cursor, VS Code)
    ↓ HTTPS (MCP protocol)
Cloudflare Worker (auth, metering, tier enforcement)
    ↓ Cloudflare Tunnel
Your Docker MCP Server (local machine)
    ↓ Docker API
Your containers
```

## Why Hosted?

Running `docker-mcp-server` locally works fine when you're on the same machine. But if you want to:

- **Access Docker from multiple devices** (laptop, phone, another server)
- **Share Docker access with a team** without exposing SSH
- **Use AI clients that don't support local MCP servers** (web-based, mobile)
- **Add authentication and rate limiting** to your Docker MCP endpoint

...then a hosted gateway makes sense. Your Docker daemon stays on your machine (no cloud Docker needed), but the MCP interface is accessible anywhere.

## Architecture

| Component | Location | Purpose |
|-----------|----------|---------|
| Cloudflare Worker | Edge | Auth, rate limiting, tool tier enforcement |
| Cloudflare Tunnel | Your machine | Securely exposes your Docker MCP server to the Worker |
| Docker MCP Server | Your machine | Actual Docker operations via Docker API |
| KV Store | Cloudflare | API key storage and tier assignment |
| Durable Object | Cloudflare | Per-user rate limit state |

## Tiers

| Tier | Price | Tools | Rate Limit |
|------|-------|-------|------------|
| Free | $0 | 8 read-only tools | 30 req/min |
| Standard | $19/mo | All 31 tools | 120 req/min |

### Free Tier Tools (read-only)
`list_containers`, `inspect_container`, `container_health_status`, `check_health`, `fleet_status`, `list_images`, `list_networks`, `list_volumes`

### Standard Tier Tools (full access)
All 31 tools including: `create_container`, `start_container`, `stop_container`, `remove_container`, `compose_up`, `compose_down`, `run_command`, `copy_to_container`, `copy_from_container`, `prune_containers`, `prune_images`, `prune_networks`, `prune_volumes`, and more.

## Prerequisites

1. **A Cloudflare account** (free tier works)
2. **`docker-mcp-server`** running on your machine ([npm](https://www.npmjs.com/package/@supernova123/docker-mcp-server))
3. **`cloudflared`** installed on your machine ([install guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/))

## Setup

### 1. Start your Docker MCP server

```bash
# Install if you haven't
npm install -g @supernova123/docker-mcp-server

# Start the server
docker-mcp-server
```

The server runs on `http://localhost:3000` by default.

### 2. Create a Cloudflare Tunnel

```bash
# Login to Cloudflare
cloudflared tunnel login

# Create a tunnel
cloudflared tunnel create docker-mcp

# Configure the tunnel to proxy to your local server
cat > ~/.cloudflared/config.yml << EOF
tunnel: docker-mcp
credentials-file: ~/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: your-tunnel.your-domain.com
    service: http://localhost:3000
  - service: http_status:404
EOF

# Run the tunnel
cloudflared tunnel run docker-mcp
```

### 3. Deploy the Worker

```bash
# Clone this repo
git clone https://github.com/friendlygeorge/docker-mcp-hosted.git
cd docker-mcp-hosted

# Install dependencies
npm install

# Create KV namespace
npx wrangler kv namespace create API_KEYS

# Update wrangler.jsonc with the KV namespace ID
# (replace "placeholder-will-replace" with the actual ID)

# Deploy
npx wrangler deploy
```

### 4. Create an API Key

After deployment, create your first API key via the KV store:

```bash
npx wrangler kv key put --binding=API_KEYS "your-api-key" '{"tier":"standard","userId":"you","tunnelUrl":"https://your-tunnel.your-domain.com","createdAt":"2026-01-01"}'
```

### 5. Connect Your AI Client

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "docker": {
      "url": "https://docker-mcp-hosted.your-subdomain.workers.dev",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

## API

### `GET /health`

Returns server status and version.

### `POST /mcp`

Main MCP protocol endpoint. Accepts JSON-RPC messages with MCP protocol headers.

**Required headers:**
- `Authorization: Bearer <api-key>`
- `Content-Type: application/json`
- `Accept: application/json, text/event-stream`

**Response:** Standard MCP protocol response (JSON-RPC or SSE).

### Error Responses

| Status | Error | Meaning |
|--------|-------|---------|
| 401 | `unauthorized` | Missing or invalid API key |
| 403 | `forbidden` | Tool not available at your tier |
| 429 | `rate_limited` | Too many requests (retry after `retryAfter` ms) |
| 502 | `tunnel_unreachable` | Your Docker MCP server is not reachable via the tunnel |

## Development

```bash
# Install dependencies
npm install

# Run locally (requires KV and DO bindings)
npx wrangler dev

# Type check
npx tsc --noEmit
```

## Security

- API keys stored in Cloudflare KV (encrypted at rest)
- Tunnel traffic is end-to-end encrypted (Cloudflare to your machine)
- Rate limiting enforced per-user via Durable Objects
- Tool access enforced per-tier (free users can't start/stop containers)
- No Docker daemon exposed to the internet — only accessible through the tunnel

## License

MIT
