/**
 * Guards server.json's advertised credential env vars against the ones the
 * runtime actually reads (src/utils/client.ts).
 *
 * server.json is what the MCP Registry and `docker run` installs surface to
 * users. It previously advertised ACTION1_CLIENT_ID / ACTION1_CLIENT_SECRET /
 * ACTION1_TENANT / ACTION1_BASE_URL — none of which getCredentials() reads — so
 * a user following it set four variables and the server still reported
 * "Action1 credentials not configured". manifest.json (the MCPB desktop bundle)
 * had the correct names all along, which is why the mismatch went unnoticed.
 *
 * Reported by @noekan in noekan/action1-mcp.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getCredentials } from "../utils/client.js";

const repoFile = (name: string): string =>
  fileURLToPath(new URL(`../../${name}`, import.meta.url));

interface EnvVar {
  name: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  choices?: string[];
}

const serverJson = JSON.parse(readFileSync(repoFile("server.json"), "utf8")) as {
  packages: Array<{ environmentVariables: EnvVar[] }>;
};

const envVars = serverJson.packages[0].environmentVariables;
const byName = (name: string): EnvVar | undefined => envVars.find((v) => v.name === name);

const originalEnv = { ...process.env };

function resetActionEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ACTION1_")) delete process.env[key];
  }
}

describe("server.json credential env vars", () => {
  it("advertises exactly the four ACTION1_* vars the runtime reads", () => {
    const declared = envVars.map((v) => v.name).filter((n) => n.startsWith("ACTION1_"));

    expect(declared.sort()).toEqual([
      "ACTION1_API_KEY",
      "ACTION1_DEFAULT_ORG_ID",
      "ACTION1_REGION",
      "ACTION1_SECRET",
    ]);
  });

  it("no longer advertises the superseded names that the code ignores", () => {
    const declared = envVars.map((v) => v.name);

    for (const stale of [
      "ACTION1_CLIENT_ID",
      "ACTION1_CLIENT_SECRET",
      "ACTION1_TENANT",
      "ACTION1_BASE_URL",
    ]) {
      expect(declared, `server.json still advertises unread ${stale}`).not.toContain(stale);
    }
  });

  it("marks the key and secret required, and the secret as secret", () => {
    expect(byName("ACTION1_API_KEY")?.isRequired).toBe(true);
    expect(byName("ACTION1_SECRET")?.isRequired).toBe(true);
    expect(byName("ACTION1_SECRET")?.isSecret).toBe(true);
  });

  it("marks region and default org optional, matching the runtime fallbacks", () => {
    expect(byName("ACTION1_REGION")?.isRequired).toBeFalsy();
    expect(byName("ACTION1_DEFAULT_ORG_ID")?.isRequired).toBeFalsy();
  });

  it("offers the four supported regions, defaulting to NorthAmerica", () => {
    const region = byName("ACTION1_REGION");

    expect(region?.default).toBe("NorthAmerica");
    expect(region?.choices).toEqual([
      "NorthAmerica",
      "Europe",
      "AsiaPacific",
      "Australia",
    ]);
  });
});

describe("server.json is actionable end to end", () => {
  beforeEach(resetActionEnv);

  afterEach(() => {
    resetActionEnv();
    Object.assign(process.env, originalEnv);
  });

  it("setting only the required vars yields working credentials (the repro)", () => {
    for (const v of envVars.filter((e) => e.isRequired)) {
      process.env[v.name] = `value-for-${v.name}`;
    }

    // Before the fix this returned null: the required names in server.json were
    // ACTION1_CLIENT_ID / ACTION1_CLIENT_SECRET, which getCredentials() ignores.
    const creds = getCredentials();

    expect(creds).not.toBeNull();
    expect(creds?.apiKey).toBe("value-for-ACTION1_API_KEY");
    expect(creds?.secret).toBe("value-for-ACTION1_SECRET");
    expect(creds?.region).toBe("NorthAmerica");
  });

  it("every declared region choice is accepted by the client", async () => {
    const { Action1Client } = await import("../sdk/action1-client.js");

    for (const region of byName("ACTION1_REGION")?.choices ?? []) {
      expect(
        () =>
          new Action1Client({
            apiKey: "k",
            secret: "s",
            region: region as never,
          }),
        `region ${region} advertised but rejected by the client`,
      ).not.toThrow();
    }
  });
});
