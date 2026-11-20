# gw-manage-mcp — design

## Intent
Replace MetaMCP for stdio MCP servers. MetaMCP's pain points: restart leaves the old PID alive, and editing env needs a full restart. Want: one small dashboard (name, command, args, env key/value) where Restart really kills the old process and respawns with new env; exactly 1 PID per server; config in Postgres (Docker).

## Goals
- Dashboard CRUD for servers: name, command, args, env (key/value rows), enabled flag.
- Start / Stop / Restart per server; shows status (running/stopped/crashed), PID, last stderr lines.
- Single aggregated MCP endpoint `/mcp` (streamable HTTP); tools exposed as `<server>__<tool>`.
- Restart kills the whole process group (SIGTERM, wait ~5s, SIGKILL) before respawn; never 2 processes for one server.
- Restart of one server does not drop other servers or client connections; send `tools/list_changed`.
- Enabled servers auto-start on boot.

## Non-goals / anti-goals
- No multi-user, namespaces/endpoints, OAuth, tool-level ACL.
- Anti-goal: any state where a stale child process survives a restart.

## Approaches
1. **Node proxy using MCP TypeScript SDK (chosen, user picked "b" = aggregated endpoint, then "1")**: per server a stdio `Client` (process group) + one outer `Server` that merges tools and routes calls. Full control of PIDs. Cost: ~300 lines of proxy.
2. supergateway/mcp-proxy per server + gateway: extra process layer = same stale-PID risk. Rejected.
3. Fork MetaMCP: large, hard to maintain. Rejected.

## Design (my calls, not user-agreed unless noted)
- Stack: Node + TypeScript, `@modelcontextprotocol/sdk`, `pg`, Express, single static HTML dashboard (no frontend framework). Postgres via `docker-compose.yml`.
- Table `servers(id, name unique, command, args jsonb, env jsonb, enabled bool)`.
- Spawn with `detached: true` so child is its own process group; kill via `process.kill(-pid)`.
- Auth: optional bearer token from `AUTH_TOKEN` env; enforced on `/mcp` and dashboard API only if set (user did not decide; default to optional).
- Env values stored plaintext in DB (local tool). Secrets are not masked beyond hiding values in the UI by default.
- Per-server path `/mcp/:name`: only if trivial; otherwise skipped.
- Tests: one integration check — restart spawns a new PID and the old PID is gone (including a child of the child).

## Left to builder
Port numbers, log buffer size, UI styling, crash backoff policy (suggest: no auto-restart, mark `crashed`).
