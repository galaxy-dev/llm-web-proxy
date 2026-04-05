# ChatGPT Browser Proxy

Local HTTP API that exposes ChatGPT Web UI via Playwright browser automation.

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
```

## Usage

```bash
# 1. Login (opens browser for manual auth)
pnpm run login

# 2. Start server
pnpm run dev
```

Server binds to `127.0.0.1:3210`.

## API

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | /health | — | `{ status }` 200 |
| POST | /sessions | — | `{ sessionId, createdAt }` 201 |
| GET | /sessions | — | `SessionInfo[]` 200 |
| GET | /sessions/:id | — | `SessionInfo` 200 |
| POST | /sessions/:id/chat | `{ message }` | `{ response, durationMs }` 200 |
| DELETE | /sessions/:id | — | 204 |

Error shape: `{ error, message }`. 504 may include `partialResponse`.

## Config

Copy `config.example.json` to `config.json`. All fields optional, defaults:

| Field | Default |
|-------|---------|
| port | 3210 |
| headless | true |
| maxSessions | 20 |
| account.name | "default" |
| account.storageStatePath | "./accounts/default.json" |
| timeouts.navigation | 30000 |
| timeouts.response | 120000 |
| timeouts.stability | 2000 |
