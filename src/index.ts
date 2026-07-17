#!/usr/bin/env node
/**
 * Action1 MCP Server
 *
 * Provides MCP tools for Action1 patch management + endpoint inventory.
 * All tools listed upfront for compatibility with remote connectors
 * (claude.ai, mcp-remote) that don't support tools/list_changed.
 *
 * Transports:
 *   stdio (default) — for local CLI usage
 *   http — set MCP_TRANSPORT=http for hosted/gateway deployments
 *
 * Credentials (stdio mode):
 *   ACTION1_API_KEY, ACTION1_SECRET, ACTION1_REGION (default NorthAmerica),
 *   ACTION1_DEFAULT_ORG_ID (optional)
 *
 * Credentials (gateway mode, AUTH_MODE=gateway): from request headers
 *   X-Action1-API-Key, X-Action1-Secret, X-Action1-Region, X-Action1-Default-Org-Id
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { getDomainHandler, getAvailableDomains } from "./domains/index.js";
import { registerResourceHandlers } from "./resources.js";
import { isDomainName } from "./utils/types.js";
import {
  cleanCredential,
  runWithCredentials,
  type Action1Credentials,
  type Action1Region,
} from "./utils/client.js";

const navigateTool: Tool = {
  name: "action1_navigate",
  description:
    "Discover available Action1 tools by domain. All tools are callable at any time — this is a help/discovery aid.",
  inputSchema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        enum: getAvailableDomains(),
        description:
          "endpoints (device inventory), organizations (multi-tenant MSP), " +
          "policies (automation visibility), updates (missing patches).",
      },
    },
    required: ["domain"],
  },
};

async function listAllTools(): Promise<Tool[]> {
  const tools: Tool[] = [navigateTool];
  for (const d of getAvailableDomains()) {
    const handler = await getDomainHandler(d);
    tools.push(...handler.tools);
  }
  return tools;
}

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
) {
  if (name === "action1_navigate") {
    const domain = args.domain as string;
    if (!isDomainName(domain)) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown domain: ${domain}. Available: ${getAvailableDomains().join(", ")}.`,
          },
        ],
        isError: true,
      };
    }
    const handler = await getDomainHandler(domain);
    const summary = handler.tools.map((t) => ({ name: t.name, description: t.description }));
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  }
  for (const d of getAvailableDomains()) {
    const handler = await getDomainHandler(d);
    if (handler.tools.some((t) => t.name === name)) {
      return handler.handle(name, args);
    }
  }
  return {
    content: [
      {
        type: "text",
        text: `Unknown tool: ${name}. Use action1_navigate to discover available tools by domain.`,
      },
    ],
    isError: true,
  };
}

function buildServer(): Server {
  const server = new Server(
    { name: "action1-mcp", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  // MCP Apps (SEP-1865): serves the ui:// device-card resource.
  registerResourceHandlers(server);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await listAllTools(),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, _extra) => {
    const { name } = req.params;
    try {
      return await dispatchTool(name, (req.params.arguments ?? {}) as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });
  return server;
}

function credentialsFromHeaders(req: IncomingMessage): Action1Credentials | null {
  const apiKey = req.headers["x-action1-api-key"];
  const secret = req.headers["x-action1-secret"];
  const region = req.headers["x-action1-region"];
  const defaultOrgId = req.headers["x-action1-default-org-id"];
  if (typeof apiKey !== "string" || typeof secret !== "string") return null;
  // cleanCredential strips blank / unresolved `${user_config.X}` placeholders so
  // a blank optional field reads as absent (region falls back, org id stays unset).
  return {
    apiKey,
    secret,
    region: (cleanCredential(typeof region === "string" ? region : undefined) ??
      "NorthAmerica") as Action1Region,
    defaultOrgId: cleanCredential(typeof defaultOrgId === "string" ? defaultOrgId : undefined),
  };
}

async function startHttp(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);

  createServer((req: IncomingMessage, res: ServerResponse) => {
    // Liveness probe: must answer 200 unconditionally, before any MCP/credential
    // handling — the ACA probe GETs /health with no credentials or Accept
    // headers, and anything non-2xx crash-loops the container.
    if (req.url === "/health" || req.url?.startsWith("/health?")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          transport: "http",
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    // Build a FRESH Server + Transport per request in stateless mode.
    //
    // A single shared stateful transport (sessionIdGenerator set) accepts
    // exactly one `initialize` for its lifetime, so behind the multi-user
    // gateway only the first client since container start got tools — every
    // other client got `-32600 "Server already initialized"` and 0 tools.
    // Stateless per-request servers let each client initialize independently.
    const handleRequest = async (): Promise<void> => {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        // No sessionIdGenerator => stateless: re-initialization is allowed.
        enableJsonResponse: true,
      });
      // Dispose the per-request server + transport when the response closes.
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    };

    const run = async (): Promise<void> => {
      const creds = credentialsFromHeaders(req);
      // Build the fresh server+transport INSIDE the credential context so
      // getClient() resolves per-request credentials from AsyncLocalStorage.
      if (creds) {
        await runWithCredentials(creds, handleRequest);
      } else {
        await handleRequest();
      }
    };

    // Guard every request: an unhandled rejection here could otherwise reach a
    // global handler and crash the container. Never rethrow.
    run().catch((err: unknown) => {
      console.error("action1-mcp request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
          }),
        );
      }
    });
  }).listen(port, () => {
    console.error(`action1-mcp HTTP listening on :${port}`);
  });
}

async function startStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("action1-mcp stdio ready");
}

async function main(): Promise<void> {
  const mode = process.env.MCP_TRANSPORT ?? "stdio";
  if (mode === "http") {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  console.error("action1-mcp fatal:", err);
  process.exit(1);
});
