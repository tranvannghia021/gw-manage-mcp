# gw-manage-mcp

**A dashboard for running stdio and remote MCP servers as managed, single-PID processes —
with one aggregated gateway endpoint for clients, instead of one connection per server.**

`Node.js 24+` · `no build step`

---

## Why

Running a handful of MCP servers for daily use (GitLab, Vault, Sentry, internal tools…) through a
generic aggregator works, until it doesn't:

- **Restart doesn't kill the old process.** You end up with two, three, four copies of the same
  server running, each holding its own stale connection.
- **Changing an env var means editing a file on disk** and restarting by hand, every time a token
  rotates.
- **Every tool, from every server, loads into every session** — with a dozen servers that's
  hundreds of tool schemas burning context before the conversation even starts.

gw-manage-mcp is a small, single-file-dashboard replacement that fixes exactly those three things,
and nothing else — no plugin system, no multi-tenant anything, no database beyond one `servers`
table.

## Features

- **One PID per server, guaranteed.** Restart kills the entire process group (`setsid`, so
  grandchildren die too) before respawning — never two processes for one server. If the app
  itself crashes, the PID and its kernel start time are persisted and reaped on the next boot,
  without touching a PID that's since been reused by something else.
- **Env lives in the dashboard, not in files.** Set name, command, args, and key/value env per
  server in the UI; it's stored in Postgres and applied on start/restart. Paste a whole `.env`
  block into the editor and it splits into rows automatically.
- **stdio and remote (OAuth) servers, same dashboard.** A `stdio` server is `command` + `args` +
  `env`. A `http` server is just a URL — gw-manage-mcp runs the full OAuth flow (dynamic client
  registration, PKCE, token refresh) and shows a one-click "authorize" link while it waits.
- **A gateway that doesn't dump every schema into context.** `/mcp` (every server) exposes exactly
  two tools: `search_tools(query)` and `call_tool(name, arguments)`. The client searches by
  keyword, gets back matching tools *with their real input schema*, then calls one by exact name —
  hundreds of underlying tools, two tool definitions in the session. `/mcp/:name` (one server) is
  a plain passthrough with full native schemas, for when the tool count is small enough that
  there's nothing to save.
- **Errors you can actually see.** A failed tool call — including a server that reports failure as
  a plain `{"error": ...}` body instead of setting `isError` — is counted and shown on that
  server's card with the last failure's message. A later successful call marks it as history
  instead of an ongoing problem.
- **One page, four sections.** Overview (status at a glance + what needs attention), Servers
  (add/edit/restart/stop/delete, list or grid, search), Integrations (per-client install prompt —
  Claude Code, Claude Desktop, Cursor, generic), Settings (theme, gateway URL). No framework, no
  build step — it's one HTML file.

<!-- Add a screenshot here once the dashboard is deployed somewhere you can link to:
![dashboard](docs/screenshot.png) -->

## Quickstart

### Docker (everything in one command)

```bash
git clone <this repo>
cd gw-manage-mcp
cp .env.docker.example .env   # adjust MCP_DIR/GOBIN_DIR/APP_PORT if yours differ
docker compose up -d --build
```

Dashboard + gateway on `http://127.0.0.1:${APP_PORT:-3100}`, Postgres on `127.0.0.1:5440`.

The app container spawns `stdio` servers the same way the host would, so it bind-mounts the host
directories those servers' binaries/scripts live in (`MCP_DIR`, `GOBIN_DIR` — see
`.env.docker.example`). It is therefore tied to this host's filesystem layout, not a portable
image you can drop on any machine unchanged — that's the trade-off for not having to reinstall
every managed server inside the image. `http` (remote/OAuth) servers have no such dependency.

### Without Docker for the app (Postgres only)

Requires Node.js 24+ (runs the TypeScript sources directly — no build step, no transpiler).

```bash
docker compose up -d db     # Postgres on 127.0.0.1:5440
npm install
npm start                   # dashboard + gateway on http://127.0.0.1:3100
```

## Configuration

Set these as environment variables for the `npm start` process (e.g. in a systemd unit, not in a
checked-in `.env` — see [Running as a service](#running-as-a-service)).

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://mcp:mcp@127.0.0.1:5440/mcp` | Postgres connection string |
| `HOST` | `127.0.0.1` | bind address (set `0.0.0.0` only alongside `AUTH_TOKEN`) |
| `PORT` | `3100` | bind port |
| `AUTH_TOKEN` | unset | if set, `/api/*` and `/mcp*` require `Authorization: Bearer <token>` |
| `PUBLIC_URL` | `http://127.0.0.1:<PORT>` | base URL used to build each remote server's OAuth redirect URI |

Each managed server's *own* secrets (API tokens, connection strings, …) are set per-server from
the dashboard's Add/Edit dialog, not as files on disk.

## Connecting a client

Dashboard → **Integrations** → pick a client → copy the generated prompt into it. Or by hand, for
Claude Code:

```bash
claude mcp add --transport http gw-manage-mcp http://127.0.0.1:3100/mcp
# add --header "Authorization: Bearer <AUTH_TOKEN>" if AUTH_TOKEN is set
```

Point at `http://127.0.0.1:3100/mcp/<server-name>` instead to connect to just one server with its
full native tool schemas.

## Running as a service

Example systemd user unit (`~/.config/systemd/user/gw-manage-mcp.service`):

```ini
[Unit]
Description=gw-manage-mcp (stdio MCP gateway + dashboard on :3100)

[Service]
WorkingDirectory=/path/to/gw-manage-mcp
Environment=PATH=/path/to/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/path/to/node/bin/node src/index.ts
Restart=always
RestartSec=3
# SIGTERM only the app: it stops each managed server's process group itself;
# systemd SIGKILLs anything left after TimeoutStopSec.
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now gw-manage-mcp
loginctl enable-linger "$USER"   # starts on boot even when not logged in
journalctl --user -u gw-manage-mcp -f
```

Behind a corporate TLS proxy with a custom CA, add
`Environment=NODE_OPTIONS=--use-system-ca` — otherwise Node's own TLS client (not just `curl`)
rejects the chain when a remote server does its OAuth handshake.

## Architecture

```
src/
├─ db.ts        Postgres-backed `servers` table: name, type, command/args/env or url,
│                oauth state, enabled, pid + kernel start time (for crash recovery)
├─ manager.ts   spawns/kills stdio servers (process-group aware), or connects http+OAuth
│                servers; tracks tools, logs, and per-server call/error counts
├─ gateway.ts   the two MCP endpoints: /mcp (search_tools + call_tool) and /mcp/:name
│                (full passthrough)
└─ index.ts     Express app: REST API (/api/servers*), OAuth callback route, boot-time
                 orphan reaping, graceful shutdown

public/
└─ index.html  the entire dashboard — single file, no build step, no framework
```

## Testing

```bash
npm test
```

Covers process-group restart/kill (including grandchildren), in-flight call rejection on
restart, crash handling, orphan reaping after an unclean app exit, and tool-error
counting/history.

## License

No license file — all rights reserved. Code is visible on GitHub but not licensed for reuse.
