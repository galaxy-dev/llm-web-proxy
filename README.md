# LLM Web Proxy

Local HTTP API that exposes LLM Web UI via Playwright browser automation.

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
```

## Usage

```bash
# Start MCP server (includes proxy + MCP endpoint)
pnpm run mcp
```

Server binds to `127.0.0.1:3210`. MCP endpoints on `127.0.0.1:3211`:

- `GET /sse` + `POST /message` — legacy HTTP+SSE transport (Claude Code, older clients)
- `/stream-http` — Streamable HTTP transport, `POST`/`GET`/`DELETE` (Codex CLI, modern clients)

On startup, all enabled providers are auth-checked automatically.
Unauthenticated providers open login tabs in parallel for manual login — no separate login step needed.

## Remote access (VM / LAN)

By default the MCP server (3211) binds to `127.0.0.1` with no authentication. To serve a
client on another machine (e.g. a Parallels VM, or Docker inside it) without exposing the
proxy to the rest of the LAN, configure the `mcp` section in `config.json`:

```json
{
  "mcp": {
    "host": "0.0.0.0",
    "port": 3211,
    "authToken": "<paste a long random token, e.g. `openssl rand -hex 32`>"
  }
}
```

| Field | Default | Purpose |
|-------|---------|---------|
| `mcp.host` | `127.0.0.1` | Bind host for the MCP server (3211). Set `0.0.0.0` to reach it from a VM. |
| `mcp.authToken` | `""` | When non-empty, every MCP request must send `Authorization: Bearer <token>`. |
| `mcp.port` | `3211` | MCP server port. |

`config.json` is gitignored, so the token is not committed. Each field can be overridden at
startup by an env var — **env wins over the file** — so you can inject the secret without
writing it to disk: `MCP_HOST`, `MCP_PORT`, `MCP_AUTH_TOKEN`.

```bash
# Equivalent to the config above, but token injected from the environment:
MCP_HOST=0.0.0.0 MCP_AUTH_TOKEN="$(openssl rand -hex 32)" pnpm run mcp
```

The HTTP proxy (3210) is **never** exposed by these settings — it stays loopback-only as the
internal MCP→HTTP hop, so the unauthenticated REST API is never reachable off-box.

On the remote client, point Claude Code's `.mcp.json` at the host's IP and pass the token
(verified to work on Claude Code 2.1.195 — the header is forwarded on every request, and
`${ENV_VAR}` expands from the client's environment):

```json
{
  "mcpServers": {
    "llm-web-proxy": {
      "type": "sse",
      "url": "http://<host-ip>:3211/sse",
      "headers": { "Authorization": "Bearer ${LLM_PROXY_TOKEN}" }
    }
  }
}
```

> **Parallels tip — pick the bind host by who consumes it:**
> - **Both a host-side Docker consumer *and* the VM (use `0.0.0.0`):** `0.0.0.0` is the only
>   host that is a superset of loopback, so it keeps the existing `host.docker.internal` path
>   working *and* reaches the VM. Here the **token does the real work** of keeping the LAN out.
> - **The VM is the only consumer (you may bind the vnic directly):** bind to the host's
>   **Shared/Host-Only** virtual adapter IP (e.g. `10.211.55.2`) — that subnet is private to the
>   Mac and its VMs, so the proxy is off the physical LAN even before the token is checked.
>   Do **not** use vnic-only bind if you also need host-side Docker: Docker Desktop forwards
>   `host.docker.internal` to the host's *loopback*, not to the Parallels interface, so that
>   consumer would break.

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
| `ask` | `provider`, `messageFile`, `responseFile` | One-shot Q&A (auto session lifecycle) |
| `session_create` | `provider` | Create multi-turn session |
| `session_send` | `sessionId`, `messageFile`, `responseFile` | Send message to session |
| `session_send_batch` | `requests[]` | Send to multiple sessions concurrently (fan-out) |
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
| providers.\<name\>.enabled | true (chatgpt) / false (claude) |
| providers.\<name\>.ephemeral | true |
| providers.\<name\>.providerUrl | (from provider definition) |
| account.name | "default" |
| account.storageStatePath | "./.llm-web-proxy/accounts/default.json" |
| timeouts.navigation | 30000 |
| timeouts.responseBase | 120000 |
| timeouts.responsePerKB | 30000 |
| timeouts.stability | 2000 |

`ephemeral` uses temporary/incognito chat mode so conversations are not saved to the account history (ChatGPT: `?temporary-chat=true`, Claude: `?incognito`).

### Multi-provider example

```json
{
  "providers": {
    "chatgpt": { "enabled": true },
    "claude": { "enabled": true, "ephemeral": false }
  }
}
```

Set `"enabled": false` to disable a provider. Set `"ephemeral": false` to save conversations to account history.
