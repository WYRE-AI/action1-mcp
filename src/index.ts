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
 *   Gateway mode never falls back to ACTION1_* env credentials.
 *
 * HTTP transport refuses to start unless CONDUIT_S2S_SECRET is a real secret.
 * Known placeholders are rejected. MCP_ALLOW_INSECURE_DEV=1 is a local-only
 * escape hatch: it logs a warning, skips X-Gateway-S2S, and binds 127.0.0.1 only.
 * A configured secret honors MCP_HTTP_HOST (default 127.0.0.1 when unset).
 * /health stays unauthenticated and does not read credentials.
 * stdio does not use S2S auth.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
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
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

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
    {
      capabilities: {
        tools: {},
        resources: {},
        // MCP Apps (SEP-1865): explicitly declare the extension capability so
        // clients can negotiate UI support without inferring it from the
        // presence of ui:// resources (SEP-1724 extensions mechanism).
        extensions: {
          "io.modelcontextprotocol/ui": {},
        },
      },
    },
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

/** Hosts the insecure-dev bypass is allowed to bind. Anything else is refused. */
const LOOPBACK_HOST = "127.0.0.1";

/**
 * Public example values. A copied placeholder must not verify as a real secret,
 * or anyone who knows the example can forge X-Gateway-S2S.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

function refuseStart(message: string): never {
  console.error(message);
  process.exit(1);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Secret for X-Gateway-S2S. Read at HTTP startup, not module load, and never logged.
 * Empty is fail-closed unless MCP_ALLOW_INSECURE_DEV=1. A known placeholder always
 * refuses to start, including when that flag is set.
 */
function resolveHttpS2s(): { secret: string; insecureDev: boolean } {
  const raw = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    refuseStart(
      "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
        "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.",
    );
  }
  if (raw) return { secret: raw, insecureDev: false };

  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") {
    console.error(
      "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
        "HTTP MCP is not enforcing X-Gateway-S2S and is limited to loopback (127.0.0.1). " +
        "Do not use this outside local development.",
    );
    return { secret: "", insecureDev: true };
  }

  refuseStart(
    "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
      "Set CONDUIT_S2S_SECRET, or set MCP_ALLOW_INSECURE_DEV=1 for local development only.",
  );
}

/**
 * No secret (insecure-dev bypass) always binds 127.0.0.1. A non-loopback
 * MCP_HTTP_HOST is refused rather than honored. A configured secret honors
 * MCP_HTTP_HOST, and still defaults to 127.0.0.1 when that variable is unset.
 */
function resolveBindHost(insecureDev: boolean): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (!insecureDev) return configured || LOOPBACK_HOST;
  if (configured === "" || isLoopbackHost(configured)) return LOOPBACK_HOST;
  refuseStart(
    "Refusing to start HTTP transport: MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET " +
      `only binds 127.0.0.1. MCP_HTTP_HOST=${configured} is not loopback. ` +
      "Unset MCP_HTTP_HOST or set it to 127.0.0.1.",
  );
}

function resolveHttpPort(): number {
  const raw = (process.env.MCP_HTTP_PORT || process.env.PORT || "8080").trim();
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    refuseStart(`Refusing to start HTTP transport: invalid HTTP port "${raw}".`);
  }
  return port;
}

function credentialsFromHeaders(req: IncomingMessage): Action1Credentials | null {
  const apiKey = headerValue(req.headers["x-action1-api-key"]);
  const secret = headerValue(req.headers["x-action1-secret"]);
  const region = req.headers["x-action1-region"];
  const defaultOrgId = req.headers["x-action1-default-org-id"];
  if (!apiKey || !secret) return null;
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

export async function startHttp(): Promise<HttpServer> {
  const { secret: s2sSecret, insecureDev } = resolveHttpS2s();
  const host = resolveBindHost(insecureDev);
  const port = resolveHttpPort();
  const isGatewayMode = process.env.AUTH_MODE === "gateway";

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
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

    // Gateway S2S verification (gateway#377 parity). Runs before any
    // credential extraction — see src/s2s-verify.ts. There's no separate
    // /mcp route check in this server (everything past /health is MCP
    // traffic), so this guard covers all of it. An empty secret is only
    // reachable when MCP_ALLOW_INSECURE_DEV=1; startup refuses otherwise.
    // A configured secret is always enforced. The secret value is never logged.
    if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
      console.error("action1-mcp: rejected request with missing/invalid X-Gateway-S2S header");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Unauthorized: missing or invalid X-Gateway-S2S header",
          },
          id: null,
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
      // Gateway mode: vendor credentials must arrive on every request.
      // Falling through would resolve ACTION1_* from the process environment,
      // which is not request-scoped.
      if (isGatewayMode && !creds) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32001,
              message:
                "Unauthorized: missing required gateway credential headers X-Action1-API-Key and X-Action1-Secret",
            },
            id: null,
          }),
        );
        return;
      }
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
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      console.error(`action1-mcp HTTP listening on ${host}:${port}`);
      resolve();
    });
  });

  return httpServer;
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

// Vitest imports this module to call startHttp. Skip the CLI entrypoint
// there. `node dist/index.js` still starts stdio or HTTP.
if (process.env.VITEST !== "true") {
  main().catch((err) => {
    console.error("action1-mcp fatal:", err);
    process.exit(1);
  });
}
