/**
 * Instrumented call-counter probe for the S2S guard ordering invariant
 * (boss's ordering-catch rule, 2026-07-28 S2S rollout evidence report).
 *
 * action1-mcp is CLASS_II: Action1Client.ensureToken() (src/sdk/action1-client.ts)
 * performs a real outbound OAuth 2.0 client_credentials POST to Action1's own
 * /api/3.0/oauth2/token endpoint, lazily, the first time any tool needing API
 * access executes. A generic 4-case grant/deny test proves the S2S guard
 * rejects/accepts, but not ORDERING — since the exchange only fires deep
 * inside tool dispatch, a future refactor that moved the guard after
 * credential/tool handling would regress silently with no generic test
 * catching it.
 *
 * This drives a REAL tools/call round-trip through the actual HTTP server
 * (src/index.ts's startHttp(), no mocking of index.ts/domains/client.ts),
 * instrumented only at the network boundary: global.fetch is stubbed to
 * intercept calls aimed at Action1's own host and pass everything else
 * (including the test's own loopback request into the in-process server)
 * through to the real fetch.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';

const TEST_PORT = 47004;
const TEST_SECRET = 'test-s2s-guard-ordering-secret-do-not-use-in-prod';
const ACTION1_HOST = 'https://app.action1.com';

let tokenCalls = 0;
let orgsCalls = 0;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.startsWith(`${ACTION1_HOST}/api/3.0/oauth2/token`)) {
      tokenCalls++;
      return new Response(
        JSON.stringify({
          access_token: 'fake-access-token',
          refresh_token: 'fake-refresh-token',
          expires_in: 3600,
          token_type: 'bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.startsWith(`${ACTION1_HOST}/api/3.0/organizations`)) {
      orgsCalls++;
      return new Response(JSON.stringify([{ id: 'org-1', name: 'Test Org' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Everything else (notably the test's own loopback calls into the
    // in-process server below) goes through to the real fetch untouched.
    return realFetch(input, init);
  }) as typeof fetch;

  process.env.MCP_TRANSPORT = 'http';
  process.env.PORT = String(TEST_PORT);
  process.env.CONDUIT_S2S_SECRET = TEST_SECRET;
  await import('../index.js');
  await waitForServerReady();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function mintS2sHeader(secret: string, unixSeconds: number): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

async function waitForServerReady(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await realFetch(`http://127.0.0.1:${TEST_PORT}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('action1-mcp test HTTP server did not become ready in time');
}

async function callListOrganizations(headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${TEST_PORT}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'action1_list_organizations', arguments: {} },
      id: 1,
    }),
  });
}

describe('S2S guard ordering vs. lazy Action1 OAuth exchange', () => {
  it('does NOT call the Action1 OAuth token endpoint when the S2S header is missing', async () => {
    tokenCalls = 0;
    orgsCalls = 0;
    const res = await callListOrganizations({
      'x-action1-api-key': 'test-key',
      'x-action1-secret': 'test-secret',
    });
    expect(res.status).toBe(401);
    expect(tokenCalls).toBe(0);
    expect(orgsCalls).toBe(0);
  });

  it('does NOT call the Action1 OAuth token endpoint when the S2S header is present but invalid', async () => {
    tokenCalls = 0;
    orgsCalls = 0;
    const res = await callListOrganizations({
      'x-gateway-s2s': mintS2sHeader('wrong-secret', Math.floor(Date.now() / 1000)),
      'x-action1-api-key': 'test-key',
      'x-action1-secret': 'test-secret',
    });
    expect(res.status).toBe(401);
    expect(tokenCalls).toBe(0);
    expect(orgsCalls).toBe(0);
  });

  it('DOES call the Action1 OAuth token endpoint exactly once on a real accepted tool call (negative control)', async () => {
    tokenCalls = 0;
    orgsCalls = 0;
    const res = await callListOrganizations({
      'x-gateway-s2s': mintS2sHeader(TEST_SECRET, Math.floor(Date.now() / 1000)),
      'x-action1-api-key': 'test-key',
      'x-action1-secret': 'test-secret',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { isError?: boolean } };
    expect(body.result?.isError).toBeFalsy();
    expect(tokenCalls).toBe(1);
    expect(orgsCalls).toBe(1);
  });
});
