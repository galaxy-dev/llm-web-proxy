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

### File-based chat for isolated clients (no shared filesystem)

The MCP file tools (`ask`, `session_send`) take filesystem **paths** that are read/written by
the proxy process — so they only work when the client and proxy **share a filesystem** (e.g. a
host-mounted sandbox). A **fully isolated** client (a Parallels VM with no mount, Docker inside
it) can't use them: its paths don't exist on the proxy host.

For that case the MCP server (3211) exposes two raw-HTTP endpoints where **the request body is
the prompt and the response body is the reply** — content travels over the wire instead of via
a shared path. The agent assembles the prompt and consumes the reply with shell + `curl`, so
large content (diffs, file dumps) **never enters its context window**:

| Method | Path | Body in | Body out |
|--------|------|---------|----------|
| POST | `/ask-file?provider=NAME` | prompt | reply (one-shot; auto session lifecycle) |
| POST | `/sessions/:id/chat-file` | prompt | reply (multi-turn; `:id` from `session_create`) |

```bash
# build the prompt locally — bytes stay on disk, never in the agent's context
git diff > /tmp/p.txt && cat src/foo.ts >> /tmp/p.txt

# send it and stream the reply to a file (both directions via curl, not context).
# NOTE: do NOT use curl -f/--fail here — it discards the body on errors, which would
# throw away the partial-reply text on a 504. Capture the status code instead.
code=$(curl -sS -H "Authorization: Bearer $LLM_PROXY_TOKEN" \
     --data-binary @/tmp/p.txt \
     "http://<host-ip>:3211/ask-file?provider=chatgpt" \
     -o /tmp/reply.txt -w '%{http_code}')
# /tmp/reply.txt now holds: the reply (200), the partial reply (504), or an error message.

# read only what you need from the reply — without cat-ing the whole thing into context
grep -n "risk\|error" /tmp/reply.txt
```

- **Auth:** same bearer token as the rest of 3211 (the `Authorization` header is required).
- **Size:** capped by `maxMessageBytes` (config, default 1MB).
- **Reply is always text in the body** so `curl -o` captures it in every case: full reply →
  `200`; **timeout with a partial reply → `504` + header `X-Partial: true`, body = the partial
  text** (so a slow answer isn't lost); other errors → the proxy's status + an `X-Error` header.
  Check the HTTP status to distinguish (e.g. `curl -w '%{http_code}'`).

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
