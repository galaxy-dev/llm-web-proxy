# LLM Web Proxy

Local HTTP API that exposes LLM Web UI via Playwright browser automation.

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
```

## Usage

```bash
# 1. Login (opens browser for manual auth — all enabled providers)
pnpm run login

# 2. Start server
pnpm run dev

# 3. Start MCP server (includes proxy + MCP endpoint)
pnpm run mcp
```

Server binds to `127.0.0.1:3210`. MCP SSE endpoint on `0.0.0.0:3211`.

On startup (`dev` or `mcp`), all enabled providers are auth-checked.
Unauthenticated providers open login tabs in parallel for manual login.

## API

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | /health | — | `{ status, providers: { [name]: { authenticated } } }` 200 |
| POST | /sessions | `{ provider }` | `{ sessionId, provider, createdAt }` 201 |
| GET | /sessions | — | `SessionInfo[]` 200 |
| GET | /sessions/:id | — | `SessionInfo` 200 |
| POST | /sessions/:id/chat | `{ message }` | `{ response, durationMs }` 200 |
| DELETE | /sessions/:id | — | 204 |

Error shape: `{ error, message }`. 504 may include `partialResponse`.

## MCP Tools

| Tool | Params | Description |
|------|--------|-------------|
| `provider_list` | — | List available providers |
| `health` | — | Per-provider auth status |
| `ask` | `provider`, `message` | One-shot Q&A (auto session lifecycle) |
| `session_create` | `provider` | Create multi-turn session |
| `session_send` | `sessionId`, `message` | Send message to session |
| `session_list` | — | List sessions (includes provider) |
| `session_get` | `sessionId` | Get session details |
| `session_close` | `sessionId` | Close session |

## Config

Copy `config.example.json` to `config.json`. All fields optional, defaults:

| Field | Default |
|-------|---------|
| port | 3210 |
| headless | true |
| maxSessions | 20 |
| providers.chatgpt.enabled | true |
| providers.chatgpt.providerUrl | (from provider definition) |
| account.name | "default" |
| account.storageStatePath | "./.llm-web-proxy/accounts/default.json" |
| timeouts.navigation | 30000 |
| timeouts.response | 120000 |
| timeouts.stability | 2000 |

### Multi-provider example

```json
{
  "providers": {
    "chatgpt": { "enabled": true },
    "claude": { "enabled": true }
  }
}
```

Set `"enabled": false` to disable a provider without removing its config.
