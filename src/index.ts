import express from "express";
import * as db from "./db.ts";
import { mcpHandler } from "./gateway.ts";
import { Manager, reap } from "./manager.ts";

const manager = new Manager();
const app = express();
app.use(express.json());
app.use(express.static(new URL("../public", import.meta.url).pathname));

const token = process.env.AUTH_TOKEN;
const auth: express.RequestHandler = (req, res, next) =>
  !token || req.header("authorization") === `Bearer ${token}` ? next() : void res.status(401).json({ error: "unauthorized" });

const wrap =
  (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const mcp = mcpHandler(manager);
app.all("/mcp", auth, mcp);
// one server only: keeps a client's tool list (and context) small
app.all("/mcp/:name", auth, wrap(async (req, res, next) => {
  if (!(await db.get(req.params.name))) return void res.status(404).json({ error: "unknown server" });
  next();
}), mcp);

app.get("/api/servers", auth, wrap(async (_req, res) => {
  res.json((await db.list()).map((s) => ({ ...s, ...manager.status(s.name) })));
}));

app.put("/api/servers/:name", auth, wrap(async (req, res) => {
  const { type = "stdio", command, args = [], env = {}, url, enabled = true, description } = req.body ?? {};
  const name = req.params.name;
  if (!/^[A-Za-z0-9-]+$/.test(name)) return void res.status(400).json({ error: "name must match [A-Za-z0-9-]+" });
  if (type !== "stdio" && type !== "http") return void res.status(400).json({ error: "type must be stdio or http" });
  if (typeof env !== "object" || env === null || !Object.values(env).every((v) => typeof v === "string"))
    return void res.status(400).json({ error: "env must be {string:string}" });
  if (description != null && typeof description !== "string") return void res.status(400).json({ error: "description must be a string" });
  const desc = typeof description === "string" ? description.trim() || null : null;
  if (type === "http") {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return void res.status(400).json({ error: "url required (http/https)" });
    await db.upsert({ name, type, command: "", args: [], env, url, enabled: !!enabled, description: desc });
  } else {
    if (typeof command !== "string" || !command.trim()) return void res.status(400).json({ error: "command required" });
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return void res.status(400).json({ error: "args must be string[]" });
    await db.upsert({ name, type, command: command.trim(), args, env, url: null, enabled: !!enabled, description: desc });
  }
  res.json({ ok: true });
}));

app.delete("/api/servers/:name", auth, wrap(async (req, res) => {
  await manager.stop(req.params.name);
  await db.remove(req.params.name);
  res.json({ ok: true });
}));

app.post("/api/servers/:name/:action", auth, wrap(async (req, res) => {
  const { name, action } = req.params;
  if (!["start", "restart", "stop"].includes(action)) return void res.status(404).json({ error: "unknown action" });
  if (action === "stop") await manager.stop(name);
  else {
    const cfg = await db.get(name);
    if (!cfg) return void res.status(404).json({ error: "not found" });
    await manager.start(cfg); // always reads config from DB, so new env applies
  }
  res.json(manager.status(name));
}));

// browser lands here after the user approves access on the remote server's own login page
app.get("/oauth/callback/:name", wrap(async (req, res) => {
  const { code, error } = req.query;
  if (error) return void res.status(400).send(`OAuth error: ${error}`);
  if (typeof code !== "string") return void res.status(400).send("missing code");
  await manager.finishOAuth(req.params.name, code);
  res.send(`<p>Connected ${req.params.name}. You can close this tab.</p>`);
}));

app.use(((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: String(err?.message ?? err) });
}) as express.ErrorRequestHandler);

await db.init();
const port = Number(process.env.PORT ?? 3100);
// Binds to localhost by default; set HOST=0.0.0.0 together with AUTH_TOKEN to expose it.
app.listen(port, process.env.HOST ?? "127.0.0.1", () => console.log(`gw-manage-mcp on :${port}`));

// A previous run may have died (kill -9, crash, hot reload) leaving its children alive: kill them first.
for (const s of await db.list()) {
  if (s.pid) {
    if (await reap(s.pid, s.pid_start)) console.log(`killed leftover process group ${s.pid} of ${s.name}`);
    await db.setPid(s.name, null, null);
  }
}
// Track in-flight pid writes so shutdown can wait for them instead of losing them to process.exit.
const pendingWrites = new Set<Promise<unknown>>();
manager.onPid = (name, pid, start) => {
  const p = db.setPid(name, pid, start).catch(console.error);
  pendingWrites.add(p);
  p.finally(() => pendingWrites.delete(p));
};

for (const s of await db.list()) if (s.enabled) manager.start(s).catch(console.error);

const quit = async () => {
  await manager.stopAll();
  await Promise.all(pendingWrites);
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
