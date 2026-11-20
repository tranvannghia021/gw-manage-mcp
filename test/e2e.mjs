// Manual smoke: node test/e2e.mjs  (app must be running on :3100)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const B = "http://127.0.0.1:3100";
const j = (p, m = "GET", b) => fetch(B + "/api/" + p, { method: m, headers: { "content-type": "application/json" }, body: b && JSON.stringify(b) }).then((r) => r.json());
const fake = new URL("./fake-server.mjs", import.meta.url).pathname;
const put = (g) => j("servers/e2e", "PUT", { command: "node", args: [fake], env: { PIDFILE: "/tmp/e2e-pids", GREETING: g } });

await put("A"); const r1 = await j("servers/e2e/restart", "POST");
const c = new Client({ name: "t", version: "1" });
let changed = 0; 
const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
c.setNotificationHandler(ToolListChangedNotificationSchema, () => changed++);
await c.connect(new StreamableHTTPClientTransport(new URL(B + "/mcp")));
console.log("tools:", (await c.listTools()).tools.map((t) => t.name));
console.log("call A:", JSON.stringify((await c.callTool({ name: "e2e__ping" })).content));
await put("B"); const r2 = await j("servers/e2e/restart", "POST");
console.log("pid", r1.pid, "->", r2.pid, "old alive:", (() => { try { process.kill(r1.pid, 0); return true; } catch { return false; } })());
console.log("call B:", JSON.stringify((await c.callTool({ name: "e2e__ping" })).content));
await new Promise((r) => setTimeout(r, 300));
console.log("list_changed notifications:", changed);
await c.close(); await j("servers/e2e", "DELETE");
