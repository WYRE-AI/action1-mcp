/**
 * URL-pinning tests for the embedded Action1 REST client (src/sdk/action1-client.ts).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every other test in this repo mocks `getClient()` and asserts on the handler
 * layer, so none of them observe the URL actually put on the wire. That blind
 * spot let five wrong REST paths ship in v1.0.0–v1.0.3 (fixed in 0603973,
 * released v1.0.4). Action1's gateway answers unknown routes with 403, not 404,
 * so a wrong path presents as a permissions problem and is easy to misdiagnose.
 *
 * These tests therefore instrument the ONLY boundary that matters — global
 * fetch — and pin the exact absolute URL of every request the client makes.
 * They are deliberately literal: the expected strings are spelled out in full
 * rather than built from the same helpers the client uses, so a regression in
 * path construction cannot be masked by a shared bug.
 *
 * Paths verified against Action1Corp/PSAction1 (MIT, vendor-owned) and
 * confirmed end-to-end against a live tenant. Reported and fixed by @noekan in
 * noekan/action1-mcp.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Action1Client, type Action1Region } from "../../sdk/action1-client.js";

const NA = "https://app.action1.com";

const realFetch = globalThis.fetch;

/** URLs captured in call order, token exchange included. */
let calls: string[] = [];

/**
 * Stub global fetch so every request resolves, recording its absolute URL.
 * The token exchange is answered first so resource calls get a bearer token
 * and proceed to the path under test.
 */
function stubFetch(): void {
  calls = [];
  globalThis.fetch = vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);

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

    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function makeClient(
  overrides: { region?: Action1Region; defaultOrgId?: string } = {},
): Action1Client {
  return new Action1Client({
    apiKey: "test-api-key",
    secret: "test-secret",
    region: overrides.region ?? "NorthAmerica",
    defaultOrgId: overrides.defaultOrgId,
  });
}

/** The single resource URL requested after the token exchange. */
function resourceUrl(): string {
  const nonToken = calls.filter((u) => !u.includes("/oauth2/token"));
  expect(nonToken).toHaveLength(1);
  return nonToken[0];
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("Action1Client — OAuth token endpoint", () => {
  it("posts to /api/3.0/oauth2/token, NOT the unprefixed /oauth2/token", async () => {
    await makeClient().listOrganizations();

    expect(calls[0]).toBe(`${NA}/api/3.0/oauth2/token`);
    // Regression guard for the original bug: the bare path must never appear.
    expect(calls[0]).not.toBe(`${NA}/oauth2/token`);
  });

  it("mints the token on the same host as resource calls", async () => {
    await makeClient({ region: "Europe" }).listOrganizations();

    expect(calls[0]).toBe("https://app.eu.action1.com/api/3.0/oauth2/token");
    expect(resourceUrl()).toBe("https://app.eu.action1.com/api/3.0/organizations");
  });

  it("reuses a cached token rather than re-minting per request", async () => {
    const client = makeClient({ defaultOrgId: "org-1" });
    await client.listOrganizations();
    await client.listPolicies({});

    expect(calls.filter((u) => u.includes("/oauth2/token"))).toHaveLength(1);
  });
});

describe("Action1Client — resource paths", () => {
  it("listOrganizations → /api/3.0/organizations", async () => {
    await makeClient().listOrganizations();

    expect(resourceUrl()).toBe(`${NA}/api/3.0/organizations`);
  });

  it("listEndpoints → /api/3.0/endpoints/managed/<org>", async () => {
    await makeClient().listEndpoints({ orgId: "org-1" });

    expect(resourceUrl()).toBe(`${NA}/api/3.0/endpoints/managed/org-1`);
  });

  it("getEndpoint → /api/3.0/endpoints/managed/<org>/<endpoint>", async () => {
    await makeClient().getEndpoint("ep-9", { orgId: "org-1" });

    expect(resourceUrl()).toBe(`${NA}/api/3.0/endpoints/managed/org-1/ep-9`);
  });

  it("listMissingUpdates → /api/3.0/updates/<org>", async () => {
    await makeClient().listMissingUpdates({ orgId: "org-1" });

    expect(resourceUrl()).toBe(`${NA}/api/3.0/updates/org-1`);
  });

  it("listPolicies → /api/3.0/policies/instances/<org>", async () => {
    await makeClient().listPolicies({ orgId: "org-1" });

    expect(resourceUrl()).toBe(`${NA}/api/3.0/policies/instances/org-1`);
  });
});

describe("Action1Client — superseded paths must never reappear", () => {
  /**
   * The exact five paths that shipped broken. Asserting their absence keeps a
   * well-meaning "restore the RESTful nesting" refactor from silently
   * reintroducing routes that Action1 answers with 403.
   */
  const SUPERSEDED = [
    "/oauth2/token",
    "/api/3.0/organizations/org-1/endpoints",
    "/api/3.0/organizations/org-1/endpoints/ep-9",
    "/api/3.0/organizations/org-1/missing_updates",
    "/api/3.0/organizations/org-1/policies",
  ];

  it("exercising the whole read-only surface emits none of them", async () => {
    const client = makeClient({ defaultOrgId: "org-1" });
    await client.listOrganizations();
    await client.listEndpoints({ orgId: "org-1" });
    await client.getEndpoint("ep-9", { orgId: "org-1" });
    await client.listMissingUpdates({ orgId: "org-1" });
    await client.listPolicies({ orgId: "org-1" });

    for (const bad of SUPERSEDED) {
      expect(calls, `superseded path still in use: ${bad}`).not.toContain(`${NA}${bad}`);
    }
  });
});

describe("Action1Client — region hosts", () => {
  const REGIONS: Array<[Action1Region, string]> = [
    ["NorthAmerica", "app.action1.com"],
    ["Europe", "app.eu.action1.com"],
    ["AsiaPacific", "app.ap.action1.com"],
    ["Australia", "app.au.action1.com"],
  ];

  it.each(REGIONS)("%s resolves to https://%s", async (region, host) => {
    await makeClient({ region }).listOrganizations();

    expect(resourceUrl()).toBe(`https://${host}/api/3.0/organizations`);
  });

  it("rejects an unknown region at construction time", () => {
    expect(() => makeClient({ region: "Mars" as Action1Region })).toThrow(
      /Unknown Action1 region/,
    );
  });
});

describe("Action1Client — query + path encoding", () => {
  it("appends limit as a query string without disturbing the path", async () => {
    await makeClient().listEndpoints({ orgId: "org-1", limit: 50 });

    expect(resourceUrl()).toBe(`${NA}/api/3.0/endpoints/managed/org-1?limit=50`);
  });

  it("omits the query string entirely when no limit is given", async () => {
    await makeClient().listMissingUpdates({ orgId: "org-1" });

    expect(resourceUrl()).toBe(`${NA}/api/3.0/updates/org-1`);
  });

  it("percent-encodes org and endpoint ids into the path", async () => {
    await makeClient().getEndpoint("ep/9", { orgId: "org 1" });

    expect(resourceUrl()).toBe(`${NA}/api/3.0/endpoints/managed/org%201/ep%2F9`);
  });

  it("falls back to defaultOrgId when the call omits one", async () => {
    await makeClient({ defaultOrgId: "org-default" }).listPolicies({});

    expect(resourceUrl()).toBe(`${NA}/api/3.0/policies/instances/org-default`);
  });

  it("throws before issuing a request when no org id is available", async () => {
    await expect(makeClient().listEndpoints({})).rejects.toThrow(
      /organization_id is required/,
    );
    expect(calls).toHaveLength(0);
  });
});
