import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Manager } from "./manager.ts";
import { rankTools, list as listServers } from "./db.ts";

/**
 * The aggregate endpoint (/mcp, every server) exposes just these two tools instead of flattening
 * every underlying tool's schema into the session: with 300+ tools across a dozen servers, that
 * schema dump alone was bigger than most conversations. The client searches, then calls by name.
 * A scoped endpoint (/mcp/:name) stays as a normal passthrough: a single server's tool count is
 * small enough that there's nothing to save, and the client gets real per-tool schemas back.
 */
const META_TOOLS: Tool[] = [
  {
    name: "search_tools",
    description:
      "Search across every connected MCP server for tools matching a keyword (name or description). " +
      "Call this first to find the right tool, then call it with call_tool.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "keywords to match, e.g. \"gitlab merge request\"" },
        limit: { type: "number", description: "max results (default 8); each result includes its full input schema, so keep this small and narrow the query instead of raising it" },
      },
      required: ["query"],
    },
  },
  {
    name: "call_tool",
    description: "Call one underlying tool by its exact name, as returned by search_tools (e.g. \"hasaki-gitlab__list_merge_requests\").",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "exact tool name from search_tools" },
        arguments: { type: "object", description: "arguments for that tool" },
      },
      required: ["name"],
    },
  },
];

// Pulls searchable text out of a JSON schema: property names plus every "description"/"enum"
// string, so a param like `scope: enum ["issues", "merge_requests", ...]` makes its tool findable
// by "issue" even though the tool's own top-level description never says that word.
function schemaText(node: unknown): string {
  if (node == null || typeof node !== "object") return "";
  const parts: string[] = [];
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    if (key === "description" && typeof val === "string") parts.push(val);
    else if (key === "enum" && Array.isArray(val)) parts.push(...val.filter((v) => typeof v === "string"));
    else if (key === "properties" && val && typeof val === "object") parts.push(Object.keys(val).join(" "));
    if (val && typeof val === "object") parts.push(schemaText(val));
  }
  return parts.join(" ");
}

async function searchTools(manager: Manager, query: string, limit = 8) {
  const all = manager.allTools();
  const descByServer = new Map((await listServers()).map((s) => [s.name, s.description ?? ""]));
  // "server__tool" -> "server tool" so a query like "gitlab" ranks that server's tools too; the
  // server's own description is mixed in so a query matching its purpose finds its tools even when
  // neither the tool name nor its schema happens to use that wording.
  const items = all.map((t) => {
    const server = t.name.split("__")[0];
    return {
      name: t.name,
      text: `${t.name.replace("__", " ")} ${descByServer.get(server) ?? ""} ${t.description ?? ""} ${schemaText(t.inputSchema)}`,
    };
  });
  const ranked = await rankTools(query, items);
  const byName = new Map(all.map((t) => [t.name, t]));
  const matches = ranked.map((n) => byName.get(n)!).filter(Boolean);
  return {
    total: all.length,
    matched: matches.length,
    // inputSchema included so the caller knows the exact argument shape before calling call_tool
    // (without it, the model has to guess field names/types and gets them wrong).
    tools: matches.slice(0, limit).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
}

/** Express handler for /mcp (all servers) and /mcp/:name (one server): one MCP Server per client session. */
export function mcpHandler(manager: Manager) {
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

  manager.on("changed", () => {
    for (const s of sessions.values()) s.server.sendToolListChanged().catch(() => {});
  });

  return async (req: Request, res: Response) => {
    const id = req.header("mcp-session-id");
    let s = id ? sessions.get(id) : undefined;
    if (!s) {
      if (req.method !== "POST" || !isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "no valid session" }, id: null });
        return;
      }
      const only: string | undefined = req.params.name; // set on /mcp/:name, undefined on /mcp
      // "instructions" is a client-visible hint shown at session start (part of the initialize
      // result) — without it, the model only sees two generically-named tools and has no idea
      // what domains they cover, so it never thinks to reach for them. Naming the connected
      // servers here is what actually gets this MCP considered instead of skipped.
      const running = (await listServers()).filter((s) => manager.status(s.name).status === "running");
      // "mcp123" alone tells a model nothing — the per-server description (set from the dashboard)
      // is what actually explains what each one is for.
      const lines = running.map((s) => (s.description ? `${s.name} — ${s.description}` : s.name)).join("; ");
      const server = new Server(
        { name: "gw-manage-mcp", version: "0.1.0" },
        {
          capabilities: { tools: { listChanged: true } },
          instructions: only
            ? undefined
            : `Gives access to internal tools from: ${lines || "(no server running)"}. ` +
              `Whenever a request might involve one of those services, call search_tools with a keyword first — ` +
              `don't assume it can't be done without checking — then call_tool by the exact name it returns.`,
        },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: only ? manager.allTools(only) : META_TOOLS }));
      server.setRequestHandler(CallToolRequestSchema, async (r) => {
        try {
          if (!only) {
            if (r.params.name === "search_tools") {
              const { query, limit } = (r.params.arguments ?? {}) as { query?: string; limit?: number };
              return { content: [{ type: "text", text: JSON.stringify(await searchTools(manager, query ?? "", limit)) }] };
            }
            if (r.params.name === "call_tool") {
              const { name, arguments: args } = (r.params.arguments ?? {}) as { name?: string; arguments?: Record<string, unknown> };
              if (!name) throw new Error("call_tool needs a tool name (from search_tools)");
              return (await manager.callTool(name, args)) as any;
            }
            throw new Error(`unknown tool: ${r.params.name} (use search_tools, then call_tool)`);
          }
          if (!r.params.name.startsWith(`${only}__`)) throw new Error(`unknown tool: ${r.params.name}`);
          return (await manager.callTool(r.params.name, r.params.arguments)) as any;
        } catch (e) {
          return { isError: true, content: [{ type: "text", text: String(e instanceof Error ? e.message : e) }] };
        }
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sid) => sessions.set(sid, { server, transport }),
      });
      transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
      await server.connect(transport);
      s = { server, transport };
    }
    await s.transport.handleRequest(req, res, req.body);
  };
}
