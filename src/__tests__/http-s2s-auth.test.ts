/**
 * HTTP transport fail-closed auth (CWE-306).
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * That bypass binds 127.0.0.1 only. Known placeholders are rejected.
 * AUTH_MODE=gateway rejects requests that omit X-Action1 credential headers
 * and must not fall back to ACTION1_* in process.env.
 */

import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startHttp } from "../index.js";

const S2S_SECRET = "s2s-do-not-log-7f3a";
const ENV_API_KEY = "env-api-key-must-not-be-used";
const ENV_SECRET = "env-secret-must-not-be-used";
const HEADER_API_KEY = "header-client-id";
const HEADER_SECRET = "header-client-secret";

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "PORT",
  "AUTH_MODE",
  "ACTION1_API_KEY",
  "ACTION1_SECRET",
  "ACTION1_REGION",
  "ACTION1_DEFAULT_ORG_ID",
  "MCP_TRANSPORT",
] as const;

const savedEnv = new Map<string, string | undefined>();
const realFetch = globalThis.fetch;
const servers: Server[] = [];
let errorLogs: string[] = [];

interface Action1Call {
  url: string;
  body: string;
}

let action1Calls: Action1Call[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function bodyText(body: RequestInit["body"]): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return String(body);
}

function installFetchMock(): void {
  action1Calls = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("action1.com")) {
      const recorded = { url, body: bodyText(init?.body) };
      action1Calls.push(recorded);
      if (url.includes("/oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "fake-access-token",
            refresh_token: "fake-refresh-token",
            expires_in: 3600,
            token_type: "bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify([{ id: "org-1", name: "Header Org" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

function exitSpy(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

function logged(): string {
  return errorLogs.join("\n");
}

function assertNoSecrets(text: string, extra: string[] = []): void {
  expect(text).not.toContain(S2S_SECRET);
  expect(text).not.toContain(ENV_API_KEY);
  expect(text).not.toContain(ENV_SECRET);
  expect(text).not.toContain(HEADER_SECRET);
  for (const value of extra) expect(text).not.toContain(value);
}

async function listen(): Promise<{ port: number; address: string }> {
  const server = await startHttp();
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return { port: bound.port, address: bound.address };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

function toolCall(name: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: name === "action1_navigate" ? { domain: "organizations" } : {} },
  });
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  delete process.env.PORT;
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.ACTION1_API_KEY;
  delete process.env.ACTION1_SECRET;
  delete process.env.ACTION1_REGION;
  delete process.env.ACTION1_DEFAULT_ORG_ID;
  errorLogs = [];
  action1Calls = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLogs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe("HTTP startup", () => {
  it("refuses to start when CONDUIT_S2S_SECRET is empty", async () => {
    const exit = exitSpy();
    await expect(startHttp()).rejects.toThrow("process.exit:1");
    expect(exit).toHaveBeenCalledWith(1);
    const text = logged();
    expect(text).toContain("Refusing to start HTTP transport");
    expect(text).toContain("CONDUIT_S2S_SECRET is empty");
    expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
    assertNoSecrets(text);
  });

  it("still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    process.env.CONDUIT_S2S_SECRET = "   ";
    const exit = exitSpy();
    await expect(startHttp()).rejects.toThrow("process.exit:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(logged()).toContain("Refusing to start HTTP transport");
  });

  it.each(["changeme", "ChangeMe", "replace-with-a-real-secret", "s2s-secret", "  Your-S2S-Secret  "])(
    "refuses placeholder secret %j and does not log it",
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = placeholder;
      delete process.env.MCP_ALLOW_INSECURE_DEV;
      const exit = exitSpy();
      await expect(startHttp()).rejects.toThrow("process.exit:1");
      expect(exit).toHaveBeenCalledWith(1);
      const text = logged();
      expect(text).toContain("known placeholder");
      expect(text).toContain("openssl rand -hex 32");
      const redacted = text.replaceAll("CONDUIT_S2S_SECRET", "");
      expect(redacted.toLowerCase()).not.toContain(placeholder.trim().toLowerCase());
      assertNoSecrets(text);
    },
  );

  it("refuses a placeholder even when MCP_ALLOW_INSECURE_DEV=1", async () => {
    process.env.CONDUIT_S2S_SECRET = "  Your-S2S-Secret  ";
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const exit = exitSpy();
    await expect(startHttp()).rejects.toThrow("process.exit:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(logged()).toContain("known placeholder");
    expect(logged()).not.toContain("Your-S2S-Secret");
  });

  it("allows startup with a warning and binds 127.0.0.1 when MCP_ALLOW_INSECURE_DEV=1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    delete process.env.MCP_HTTP_HOST;
    const exit = exitSpy();
    const server = await listen();
    expect(exit).not.toHaveBeenCalled();
    expect(server.address).toBe("127.0.0.1");
    const text = logged();
    expect(text).toContain("SECURITY WARNING");
    expect(text).toContain("CONDUIT_S2S_SECRET");
    expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
    expect(text).toContain("127.0.0.1");
    assertNoSecrets(text);
  });

  it.each(["localhost", "::1", "[::1]"])(
    "forces 127.0.0.1 when the dev bypass host is %s",
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      process.env.MCP_HTTP_HOST = host;
      const exit = exitSpy();
      const server = await listen();
      expect(exit).not.toHaveBeenCalled();
      expect(server.address).toBe("127.0.0.1");
      expect(logged()).toContain("SECURITY WARNING");
    },
  );

  it.each(["0.0.0.0", "10.1.2.3"])(
    "refuses the dev bypass when MCP_HTTP_HOST is %s",
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      process.env.MCP_HTTP_HOST = host;
      const exit = exitSpy();
      await expect(startHttp()).rejects.toThrow("process.exit:1");
      expect(exit).toHaveBeenCalledWith(1);
      const text = logged();
      expect(text).toContain("Refusing to start HTTP transport");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV");
      expect(text).toContain("127.0.0.1");
      expect(text).toContain(`MCP_HTTP_HOST=${host}`);
      assertNoSecrets(text);
    },
  );

  it("still binds a non-loopback host when CONDUIT_S2S_SECRET is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const server = await listen();
    expect(server.address).toBe("0.0.0.0");
    expect(logged()).not.toContain("not loopback");
    assertNoSecrets(logged());
  });

  it("binds 127.0.0.1 when MCP_HTTP_HOST is unset and a secret is set", async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    expect(server.address).toBe("127.0.0.1");
  });

  it("honors PORT when MCP_HTTP_PORT is unset", async () => {
    delete process.env.MCP_HTTP_PORT;
    process.env.PORT = "0";
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    expect(server.port).toBeGreaterThan(0);
    expect(server.address).toBe("127.0.0.1");
  });
});

describe("HTTP authentication", () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.ACTION1_API_KEY = ENV_API_KEY;
    process.env.ACTION1_SECRET = ENV_SECRET;
    process.env.ACTION1_REGION = "NorthAmerica";
    installFetchMock();
  });

  it("returns 401 when the S2S header is missing or invalid and does not log the secret", async () => {
    const server = await listen();
    const missing = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      headers: mcpHeaders({
        "x-action1-api-key": HEADER_API_KEY,
        "x-action1-secret": HEADER_SECRET,
      }),
      body: toolCall("action1_list_organizations"),
    });
    const invalid = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader("wrong-secret"),
        "x-action1-api-key": HEADER_API_KEY,
        "x-action1-secret": HEADER_SECRET,
      }),
      body: toolCall("action1_list_organizations"),
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    const missingBody = await missing.text();
    const invalidBody = await invalid.text();
    expect(missingBody).toContain("X-Gateway-S2S");
    expect(invalidBody).toContain("X-Gateway-S2S");
    assertNoSecrets(missingBody);
    assertNoSecrets(invalidBody);
    assertNoSecrets(logged());
    expect(action1Calls).toEqual([]);
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const server = await listen();
    const response = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
      body: toolCall("action1_list_organizations"),
    });
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toContain("X-Action1-API-Key");
    expect(body).toContain("X-Action1-Secret");
    assertNoSecrets(body);
    expect(action1Calls).toEqual([]);

    const partial = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-action1-api-key": HEADER_API_KEY,
      }),
      body: toolCall("action1_list_organizations"),
    });
    expect(partial.status).toBe(401);
    expect(action1Calls).toEqual([]);
  });

  it("accepts a valid S2S header plus credential headers and uses those credentials", async () => {
    const server = await listen();
    const response = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-action1-api-key": HEADER_API_KEY,
        "x-action1-secret": HEADER_SECRET,
        "x-action1-region": "Europe",
      }),
      body: toolCall("action1_list_organizations"),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    assertNoSecrets(body);
    assertNoSecrets(logged());
    expect(body).not.toContain(ENV_API_KEY);
    expect(action1Calls.length).toBeGreaterThan(0);
    expect(action1Calls[0]?.url).toBe("https://app.eu.action1.com/api/3.0/oauth2/token");
    expect(action1Calls[0]?.body).toContain(`client_id=${HEADER_API_KEY}`);
    expect(action1Calls[0]?.body).toContain(`client_secret=${HEADER_SECRET}`);
    expect(action1Calls[0]?.body).not.toContain(ENV_API_KEY);
    expect(action1Calls[0]?.body).not.toContain(ENV_SECRET);
    expect(action1Calls.some((call) => call.url.startsWith("https://app.action1.com/"))).toBe(false);
  });

  it("serves /health without authentication and without reading credentials", async () => {
    const server = await listen();
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    const body = await response.text();
    const parsed = JSON.parse(body) as { status?: string; transport?: string };

    expect(response.status).toBe(200);
    expect(parsed.status).toBe("ok");
    expect(parsed.transport).toBe("http");
    assertNoSecrets(body);
    expect(action1Calls).toEqual([]);
  });

  it("skips X-Gateway-S2S on the insecure-dev bypass and still rejects missing gateway credentials", async () => {
    delete process.env.CONDUIT_S2S_SECRET;
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const server = await listen();
    expect(server.address).toBe("127.0.0.1");

    const response = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      headers: mcpHeaders(),
      body: toolCall("action1_navigate"),
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("X-Action1-API-Key");
    expect(action1Calls).toEqual([]);
  });
});

describe("HTTP AUTH_MODE=env", () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "env";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.ACTION1_API_KEY = ENV_API_KEY;
    process.env.ACTION1_SECRET = ENV_SECRET;
    installFetchMock();
  });

  it("still requires X-Gateway-S2S", async () => {
    const server = await listen();
    const response = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      headers: mcpHeaders(),
      body: toolCall("action1_navigate"),
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("X-Gateway-S2S");
    expect(action1Calls).toEqual([]);
  });

  it("allows a signed request without vendor headers", async () => {
    const server = await listen();
    const response = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
      body: toolCall("action1_navigate"),
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("action1_list_organizations");
    assertNoSecrets(body);
    expect(action1Calls).toEqual([]);
  });
});
