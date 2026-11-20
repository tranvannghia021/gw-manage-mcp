// Minimal stdio MCP server used by tests; also spawns a grandchild to prove group kill.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const child = spawn("sleep", ["300"], { stdio: "ignore" });
appendFileSync(process.env.PIDFILE, `${child.pid}\n`);
const s = new McpServer({ name: "fake", version: "1.0.0" });
s.tool("ping", async () => ({ content: [{ type: "text", text: `pong ${process.env.GREETING ?? ""}` }] }));
s.tool("hang", () => new Promise(() => {}));
s.tool("fail", async () => ({ isError: true, content: [{ type: "text", text: "403 permission denied" }] }));
s.tool("softfail", async () => ({ content: [{ type: "text", text: JSON.stringify({ error: "session expired" }) }] }));
await s.connect(new StdioServerTransport());
