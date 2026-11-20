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

function searchTools(manager: Manager, query: string, limit = 8) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const all = manager.allTools();
  const matches = all.filter((t) => {
    const hay = `${t.name} ${t.description ?? ""}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
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
      const server = new Server(
        { name: "gw-manage-mcp", version: "0.1.0" },
        { capabilities: { tools: { listChanged: true } } },
      );
      const only: string | undefined = req.params.name; // set on /mcp/:name, undefined on /mcp
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: only ? manager.allTools(only) : META_TOOLS }));
      server.setRequestHandler(CallToolRequestSchema, async (r) => {
        try {
          if (!only) {
            if (r.params.name === "search_tools") {
              const { query, limit } = (r.params.arguments ?? {}) as { query?: string; limit?: number };
              return { content: [{ type: "text", text: JSON.stringify(searchTools(manager, query ?? "", limit)) }] };
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
