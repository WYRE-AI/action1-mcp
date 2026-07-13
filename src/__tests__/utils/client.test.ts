/**
 * Credential-resolution tests for src/utils/client.ts.
 *
 * Regression guard for the MCPB placeholder-injection bug (mirrors itglue-mcp
 * #73): when an OPTIONAL user_config field is left blank, Claude Desktop injects
 * the LITERAL manifest template (e.g. `${user_config.action1_default_org_id}`)
 * into the env var instead of omitting it. Treated as a real value, that blank
 * org id gets encodeURIComponent-ed into the request path (→ 404) and defeats
 * the "organization_id is required" guard, while a blank region throws
 * "Unknown Action1 region".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanCredential, getClient, getCredentials } from "../../utils/client.js";

const originalEnv = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ACTION1_")) delete process.env[key];
  }
}

describe("cleanCredential", () => {
  it("drops empty, whitespace, and ${...} placeholder values", () => {
    expect(cleanCredential(undefined)).toBeUndefined();
    expect(cleanCredential("")).toBeUndefined();
    expect(cleanCredential("   ")).toBeUndefined();
    expect(cleanCredential("${user_config.action1_default_org_id}")).toBeUndefined();
    expect(cleanCredential("  ${user_config.action1_region}  ")).toBeUndefined();
  });

  it("preserves and trims real values", () => {
    expect(cleanCredential("org-abc123")).toBe("org-abc123");
    expect(cleanCredential("  NorthAmerica  ")).toBe("NorthAmerica");
  });
});

describe("getCredentials (MCPB placeholder injection)", () => {
  beforeEach(() => {
    resetEnv();
    process.env.ACTION1_API_KEY = "real-api-key";
    process.env.ACTION1_SECRET = "real-secret";
  });

  afterEach(() => {
    resetEnv();
    Object.assign(process.env, originalEnv);
  });

  it("drops a placeholder ACTION1_DEFAULT_ORG_ID so defaultOrgId is undefined", () => {
    process.env.ACTION1_DEFAULT_ORG_ID = "${user_config.action1_default_org_id}";

    expect(getCredentials()?.defaultOrgId).toBeUndefined();
  });

  it("keeps a real ACTION1_DEFAULT_ORG_ID", () => {
    process.env.ACTION1_DEFAULT_ORG_ID = "org-abc123";

    expect(getCredentials()?.defaultOrgId).toBe("org-abc123");
  });

  it("falls back to NorthAmerica when ACTION1_REGION is an unresolved placeholder", () => {
    process.env.ACTION1_REGION = "${user_config.action1_region}";

    expect(getCredentials()?.region).toBe("NorthAmerica");
  });

  it("keeps a real ACTION1_REGION", () => {
    process.env.ACTION1_REGION = "Europe";

    expect(getCredentials()?.region).toBe("Europe");
  });

  it(
    "a tool call without organization_id raises the clear guard error, " +
      "not a 404 with the placeholder baked into the path (the repro)",
    async () => {
      process.env.ACTION1_DEFAULT_ORG_ID = "${user_config.action1_default_org_id}";

      const client = getClient();

      // With the placeholder stripped, defaultOrgId is undefined, so the guard
      // fires before any request is built. If the placeholder leaked through it
      // would be encodeURIComponent-ed into the endpoints path and 404 instead.
      await expect(client.listEndpoints({})).rejects.toThrow(/organization_id is required/);
    },
  );
});
