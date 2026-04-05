# Architecture

## Component Overview

```mermaid
flowchart LR
    subgraph Clients
        HTTP["HTTP Client<br/>(curl / script)"]
        MCP["MCP Client<br/>(Claude Code)"]
    end

    subgraph llm-web-proxy
        Server["server.ts<br/>Fastify HTTP API"]
        SM["session-manager.ts<br/>Session CRUD + Lock"]
        Store["session-store.ts<br/>JSON Persistence"]
        BM["browser-manager.ts<br/>Chrome CDP Lifecycle<br/>Per-provider Auth Map"]

        subgraph Providers["providers/"]
            Registry["registry.ts<br/>ProviderDefinition"]
            ChatGPT["chatgpt/<br/>ChatGPTPage"]
            Claude["claude/<br/>ClaudePage"]
        end
    end

    Chrome["Chrome<br/>(real browser via CDP)"]
    ChatGPTUI["ChatGPT Web UI"]
    ClaudeUI["Claude Web UI"]
    MCPServer["mcp-server.ts<br/>8 Provider-agnostic Tools"]

    HTTP --> Server
    MCP -->|stdio / SSE| MCPServer
    MCPServer -->|HTTP calls| Server
    Server --> SM
    SM --> Store
    SM --> BM
    SM --> Registry
    Registry --> ChatGPT
    Registry --> Claude
    BM -->|CDP| Chrome
    ChatGPT -->|Playwright| Chrome
    Claude -->|Playwright| Chrome
    Chrome --> ChatGPTUI
    Chrome --> ClaudeUI
```

Key points:
- **Provider Registry** — each provider self-registers via `registerProvider()` at import time; `ProviderDefinition` defines `pageFactory`, `authChecker`, `authExpiredDetector`, and `baseUrl`
- **MCP Server** is a standalone HTTP client — wraps the REST API as 8 provider-agnostic MCP tools, entirely decoupled from session/browser logic
- **BrowserManager** spawns real Chrome via `child_process` + CDP (not Playwright's built-in launch) to bypass Cloudflare; tracks per-provider auth status via `Map<string, boolean>`; supports parallel multi-tab login (`loginFlowMulti`)
- **ProviderPage** (ChatGPTPage / ClaudePage) automates a single browser tab; resolves selectors dynamically with per-instance cache and multiple fallbacks; uses global clipboard mutex for long text or text with newlines
- **SessionManager** holds active sessions in memory with per-session FIFO mutex (`SessionLock` with 120s timeout); each session carries a `provider` field; enforces `maxSessions` capacity limit; persists metadata atomically after each mutation

## Startup Flow

```mermaid
sequenceDiagram
    participant I as index.ts
    participant C as Config
    participant R as Provider Registry
    participant BM as BrowserManager
    participant SM as SessionManager
    participant S as Fastify Server

    I->>C: loadConfig()
    I->>R: resolveEnabledProviders()
    I->>BM: new BrowserManager(config)
    I->>BM: launch() (headless Chrome)
    I->>BM: checkProviderAuth() for each provider (parallel)

    alt Some providers unauthenticated
        I->>BM: close() headless
        I->>BM: loginFlowMulti() (one tab per provider)
        I->>BM: launch() headless again
        I->>BM: re-check auth
    end

    I->>SM: new SessionManager(config, bm, providerRuntimes)
    I->>S: buildServer() + listen
```

## Request Flow (POST /sessions/:id/chat)

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Fastify Server
    participant SM as SessionManager
    participant Lock as SessionLock
    participant P as ProviderPage
    participant Chrome as Chrome / LLM Web UI

    C->>S: POST /sessions/:id/chat {message}
    S->>SM: sendMessage(id, message)
    SM->>Lock: acquire()
    Lock-->>SM: locked

    SM->>P: sendMessage(text)
    alt text > 2000 chars or contains newlines
        P->>P: acquireClipboard()
        P->>Chrome: clipboard.writeText(text)
        P->>Chrome: Cmd+V (paste)
        P->>P: releaseClipboard()
    else short text without newlines
        P->>Chrome: pressSequentially(text)
    end
    P->>Chrome: waitForSendButton enabled
    P->>Chrome: click send
    P->>Chrome: waitForResponse (stop button + text stability)
    P->>Chrome: getLastAssistantMessage() via locator
    Chrome-->>P: assistant message text

    P-->>SM: response text
    SM->>Lock: release()
    SM-->>S: response
    S-->>C: {response, durationMs}
```

## Session Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Creating : create request (providerName)
    Creating --> Active : page ready
    Creating --> [*] : navigation failed
    Creating --> Expired : auth expired

    Active --> Active : send message
    Active --> Closing : delete request
    Active --> Expired : auth expired

    Closing --> [*] : page closed
    Expired --> [*]

    note right of Active
        Each session binds a ProviderPage
        instance to a dedicated browser tab.
        - SessionLock 120s timeout
        - Metadata persisted atomically
        - Carries provider field
        Capacity limited by maxSessions
    end note

    note left of Creating
        On startup sessions loaded from
        sessions.json are marked stale
        and excluded from active map
    end note
```

## Module Dependencies

```
index.ts
  +-- config.ts --- types.ts
  +-- providers/registry.ts --- types.ts
  |     +-- providers/chatgpt/index.ts + page.ts
  |     +-- providers/claude/index.ts + page.ts
  +-- browser-manager.ts --- types.ts, providers/registry.ts (AuthChecker type)
  +-- session-manager.ts
  |     +-- browser-manager.ts
  |     +-- providers/registry.ts (ProviderPageFactory, AuthExpiredDetector)
  |     +-- session-store.ts
  |     +-- errors.ts
  +-- server.ts --- session-manager.ts, browser-manager.ts, errors.ts

mcp-server.ts (standalone, HTTP client only)
  +-- index.ts (startProxy)
```

Leaf modules with zero outgoing deps: `types.ts`, `errors.ts`, `session-store.ts`.

## Runtime Data

All runtime data lives in `.llm-web-proxy/` (gitignored):

```
.llm-web-proxy/
  accounts/default.json   -- Playwright storageState backup (all providers' cookies)
  chrome-profiles/default/ -- Chrome user data directory (shared across providers)
  sessions.json           -- Session persistence (atomic write via temp+rename)
```

Notes:
- `chrome-profiles/*/SingletonLock` is removed on startup to prevent stale lock issues
- All providers share one Chrome profile (cookies are per-domain, no conflict)
- `accounts/*.json` contains login cookies backup; re-run `pnpm run login` or restart to trigger login flow if auth expires
