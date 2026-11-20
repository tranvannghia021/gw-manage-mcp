import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthClientInformation, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as db from "./db.ts";
import type { ServerRow, OAuthState } from "./db.ts";

export type Status = "running" | "stopped" | "crashed" | "needs_auth";
type Entry = {
  status: Status;
  pid?: number;
  client?: Client;
  transport?: StreamableHTTPClientTransport; // kept for "http" servers so finishAuth() can resume it
  authUrl?: string; // login link while status === "needs_auth"
  logs: string[];
  tools: Tool[];
  calls: number;
  errors: number;
  lastError?: { at: number; tool: string; msg: string };
  lastOkAt?: number; // a later success means lastError is history, not a current problem
};

/**
 * OAuthClientProvider for a remote "http" server: persists client registration + tokens in the
 * DB (so a restart doesn't force re-login), and hands the authorization URL to the caller instead
 * of opening a browser itself (this process is headless; the dashboard shows the link).
 */
class DbOAuthProvider implements OAuthClientProvider {
  private saved: OAuthState;
  authUrl?: string;
  private name: string;
  redirectUrl: string;
  constructor(name: string, state: OAuthState | null | undefined, redirectUrl: string) {
    this.name = name;
    this.redirectUrl = redirectUrl;
    this.saved = { ...state };
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "gw-manage-mcp",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client (PKCE)
    };
  }
  clientInformation() {
    return this.saved.clientInformation as OAuthClientInformation | undefined;
  }
  async saveClientInformation(ci: OAuthClientInformation) {
    this.saved.clientInformation = ci;
    await db.setOAuth(this.name, this.saved);
  }
  tokens() {
    return this.saved.tokens as OAuthTokens | undefined;
  }
  async saveTokens(t: OAuthTokens) {
    this.saved.tokens = t;
    await db.setOAuth(this.name, this.saved);
  }
  redirectToAuthorization(url: URL) {
    this.authUrl = String(url); // caller (startHttp) reads this after connect() throws UnauthorizedError
  }
  async saveCodeVerifier(v: string) {
    this.saved.codeVerifier = v;
    await db.setOAuth(this.name, this.saved);
  }
  codeVerifier() {
    if (!this.saved.codeVerifier) throw new Error("no pending OAuth login for this server");
    return this.saved.codeVerifier;
  }
}

/**
 * Text of a failed tool result: real MCP errors, plus servers that report failure as a JSON
 * `{"error": ...}` body without setting isError.
 * shortcut: a legit result with a top-level "error" key counts as a failure, only skews the counter.
 */
function errorText(r: any): string | undefined {
  const text = (r?.content ?? []).map((c: any) => c.text ?? "").join("");
  if (r?.isError) return text || "tool error";
  if (!text.startsWith("{")) return undefined;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object" && j.error) return typeof j.error === "string" ? j.error : JSON.stringify(j.error);
  } catch {}
  return undefined;
}

const alive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Server runs under `setsid`, so pid == pgid and -pid reaches grandchildren too.
async function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  if (alive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(50);
  }
}

/** Kernel start time of a process (Linux /proc): tells a recorded pid from a reused one. */
export function procStart(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19];
  } catch {
    return undefined;
  }
}

/** Kill a group left behind by an earlier run of this app. No-op if the pid now belongs to something else. */
export async function reap(pid: number, start: string | null | undefined) {
  const now = procStart(pid);
  if (!((now === undefined && alive(pid)) || (now !== undefined && now === start))) return false;
  await killGroup(pid);
  return true;
}

export class Manager extends EventEmitter {
  /** Called whenever a server's process group appears (pid) or goes away (null) so it can be persisted. */
  onPid?: (name: string, pid: number | null, start: string | null) => void;
  private entries = new Map<string, Entry>();
  private locks = new Map<string, Promise<unknown>>();

  // Serialise start/stop per server so two processes can never coexist.
  private run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const p = (this.locks.get(name) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.locks.set(name, p);
    return p;
  }

  /** Start (or restart) with the given config. */
  start(cfg: ServerRow) {
    return this.run(cfg.name, async () => {
      await this.stopNow(cfg.name);
      await this.startNow(cfg);
    });
  }

  stop(name: string) {
    return this.run(name, () => this.stopNow(name));
  }

  private async startNow(cfg: ServerRow) {
    const e: Entry = { status: "stopped", logs: [], tools: [], calls: 0, errors: 0 };
    this.entries.set(cfg.name, e);
    const log = (s: string) => {
      e.logs.push(...s.split("\n").filter(Boolean));
      if (e.logs.length > 200) e.logs.splice(0, e.logs.length - 200);
    };
    if (cfg.type === "http") return this.startHttp(cfg, e, log);
    const transport = new StdioClientTransport({
      command: "setsid",
      args: [cfg.command, ...cfg.args],
      env: cfg.env,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (d) => log(String(d)));
    const client = new Client({ name: "gw-manage-mcp", version: "0.1.0" });
    transport.onclose = () => {
      if (e.status === "running") {
        e.status = "crashed";
        log("process exited unexpectedly");
        if (e.pid) killGroup(e.pid).then(() => this.onPid?.(cfg.name, null, null)); // sweep leftover children
        this.emit("changed");
      }
    };
    e.client = client;
    try {
      const connecting = client.connect(transport);
      // spawn happens synchronously inside connect(), so the pid is known before the (slow) handshake
      if (transport.pid) {
        e.pid = transport.pid;
        this.onPid?.(cfg.name, e.pid, procStart(e.pid) ?? null);
      }
      await connecting;
      await this.finishConnect(e, client, log);
    } catch (err) {
      e.status = "crashed";
      log(String(err));
      if (transport.pid) await killGroup(transport.pid);
      e.pid = undefined;
      this.onPid?.(cfg.name, null, null);
      await client.close().catch(() => {});
    }
    this.emit("changed");
  }

  /** Remote MCP server reached over HTTP with OAuth instead of a spawned process. */
  private async startHttp(cfg: ServerRow, e: Entry, log: (s: string) => void) {
    const redirectUrl = `${(process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3100}`)}/oauth/callback/${cfg.name}`;
    const provider = new DbOAuthProvider(cfg.name, cfg.oauth, redirectUrl);
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url!), { authProvider: provider });
    const client = new Client({ name: "gw-manage-mcp", version: "0.1.0" });
    e.client = client;
    e.transport = transport;
    try {
      await client.connect(transport);
      await this.finishConnect(e, client, log);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        e.status = "needs_auth";
        e.authUrl = provider.authUrl;
        log(`waiting for OAuth login: ${e.authUrl}`);
      } else {
        e.status = "crashed";
        log(String(err));
      }
    }
    this.emit("changed");
  }

  /** Called after a browser redirects back to /oauth/callback/:name with an authorization code. */
  async finishOAuth(name: string, code: string) {
    const e = this.entries.get(name);
    if (!e?.transport || e.status !== "needs_auth") throw new Error("no pending OAuth login for this server");
    // exchanges the code for tokens and persists them via the provider; the transport itself
    // can't be reused afterwards (StreamableHTTPClientTransport refuses a second start()).
    await e.transport.finishAuth(code);
    const cfg = await db.get(name);
    if (!cfg) throw new Error("server was removed");
    await this.run(name, () => this.startNow(cfg)); // fresh transport, now with saved tokens
  }

  private async finishConnect(e: Entry, client: Client, log: (s: string) => void) {
    let cursor: string | undefined;
    do {
      const r = await client.listTools({ cursor });
      e.tools.push(...r.tools);
      cursor = r.nextCursor;
    } while (cursor);
    e.status = "running";
    e.authUrl = undefined;
  }

  private async stopNow(name: string) {
    const e = this.entries.get(name);
    if (!e) return;
    const { pid, client, transport } = e;
    e.status = "stopped"; // before kill, so onclose does not mark it crashed
    e.tools = [];
    e.client = undefined;
    e.transport = undefined;
    if (pid) await killGroup(pid);
    e.pid = undefined;
    this.onPid?.(name, null, null);
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    this.emit("changed");
  }

  status(name: string) {
    const e = this.entries.get(name);
    return {
      status: e?.status ?? "stopped",
      pid: e?.pid,
      logs: e?.logs.slice(-50) ?? [],
      tools: e?.tools.length ?? 0,
      calls: e?.calls ?? 0,
      errors: e?.errors ?? 0,
      lastError: e?.lastError,
      lastOkAt: e?.lastOkAt,
      authUrl: e?.authUrl,
    };
  }

  /** Tools of running servers (only one server if `only` is set), named `<server>__<tool>`. */
  allTools(only?: string): Tool[] {
    return [...this.entries].flatMap(([n, e]) =>
      e.status === "running" && (!only || n === only) ? e.tools.map((t) => ({ ...t, name: `${n}__${t.name}` })) : [],
    );
  }

  async callTool(full: string, args?: Record<string, unknown>) {
    const i = full.indexOf("__");
    const e = this.entries.get(full.slice(0, i));
    if (i < 0 || !e?.client || e.status !== "running") throw new Error(`unknown or stopped tool: ${full}`);
    const tool = full.slice(i + 2);
    e.calls++;
    try {
      const r = await e.client.callTool({ name: tool, arguments: args });
      const err = errorText(r);
      if (err) this.noteError(e, tool, err);
      else e.lastOkAt = Date.now();
      return r;
    } catch (err) {
      this.noteError(e, tool, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Remember a failed tool call so the dashboard can show it. Does not emit "changed" (that would re-announce the tool list). */
  private noteError(e: Entry, tool: string, msg: string) {
    e.errors++;
    e.lastError = { at: Date.now(), tool, msg: msg.slice(0, 500) };
    e.logs.push(`[tool error] ${tool}: ${msg.slice(0, 300).replace(/\s+/g, " ")}`);
    if (e.logs.length > 200) e.logs.shift();
  }

  async stopAll() {
    await Promise.all([...this.entries.keys()].map((n) => this.stop(n)));
  }
}
