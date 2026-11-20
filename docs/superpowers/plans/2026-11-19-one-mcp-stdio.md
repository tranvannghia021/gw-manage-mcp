# gw-manage-mcp Implementation Plan

**Goal:** Dashboard + single `/mcp` endpoint managing stdio MCP servers, 1 PID each, config in Postgres.
**Spec:** `docs/superpowers/specs/2026-11-19-one-mcp-stdio-design.md`
**Stack:** Node 24 (runs .ts directly, no build), MCP SDK, express, pg, node:test.

## Tasks
1. `src/db.ts` — pool, `init()`, `list/get/upsert/remove` for `servers`. `docker-compose.yml` Postgres on host port 5440 (5433 is taken by MetaMCP).
2. `src/manager.ts` — `Manager`: `start/stop/restart(name)`, `status()`, `listTools()`, `callTool()`. Spawn as `setsid <cmd>` so pid == pgid; stop = `kill(-pid, SIGTERM)`, wait 5s, `SIGKILL`. Test `test/restart.test.ts`: fake server spawns a grandchild; after restart old pid and grandchild are dead, new pid differs.
3. `src/gateway.ts` — per-session MCP `Server` + streamable HTTP transport; tools prefixed `name__tool`; manager `changed` event -> `sendToolListChanged`.
4. `src/index.ts` + `public/index.html` — REST `/api/servers`, `/api/servers/:name/{start,stop,restart}`, optional `AUTH_TOKEN` bearer, dashboard.

## Review Focus
- Restart while a tool call is in flight → call rejects with error, not hang.
- Server crashes on start → status `crashed`, stderr shown, no auto-restart.
- Duplicate name / empty command → 400.
