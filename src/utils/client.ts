/**
 * Credential resolution + client cache for action1-mcp.
 *
 * Separation of concerns (per playbook §"embed vs separate-SDK is a size-class decision"):
 *   src/sdk/action1-client.ts — the embedded Action1 REST client (factor-out candidate)
 *   src/utils/client.ts       — credential resolution (env vs gateway headers) + client cache
 *
 * In gateway (HTTP) mode each inbound request stores its credentials in
 * AsyncLocalStorage so concurrent requests never share credentials via env.
 * In stdio mode the resolver falls back to environment variables.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Action1Client, type Action1Region } from "../sdk/action1-client.js";

export interface Action1Credentials {
  apiKey: string;
  secret: string;
  region: Action1Region;
  defaultOrgId?: string;
}

export type { Action1Region };

export const credentialStore = new AsyncLocalStorage<Action1Credentials>();

export function runWithCredentials<T>(creds: Action1Credentials, fn: () => T): T {
  return credentialStore.run(creds, fn);
}

// MCPB/DXT desktop bundles map env vars to `${user_config.X}` in manifest.json.
// When an OPTIONAL user_config field is left blank, the desktop host injects the
// literal template string (e.g. `${user_config.action1_default_org_id}`) into the
// env var rather than omitting it, so `??` never fires and the placeholder is used
// as a real value — a blank org id becomes a 404 and defeats the "org id required"
// guard. Strip those here so a blank field reads as absent. (issue #73 pattern)
const CONFIG_PLACEHOLDER = /^\$\{.*\}$/;

/** Strip empty/whitespace and unresolved MCPB "${user_config.X}" placeholders (issue #73 pattern). */
export function cleanCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || CONFIG_PLACEHOLDER.test(trimmed)) return undefined;
  return trimmed;
}

export function getCredentials(): Action1Credentials | null {
  const perRequest = credentialStore.getStore();
  if (perRequest) return perRequest;

  const apiKey = process.env.ACTION1_API_KEY;
  const secret = process.env.ACTION1_SECRET;
  const region = (cleanCredential(process.env.ACTION1_REGION) ?? "NorthAmerica") as Action1Region;
  const defaultOrgId = cleanCredential(process.env.ACTION1_DEFAULT_ORG_ID);

  if (!apiKey || !secret) return null;
  return { apiKey, secret, region, defaultOrgId };
}

const clientCache = new Map<string, Action1Client>();

function credentialKey(creds: Action1Credentials): string {
  return `${creds.apiKey}:${creds.region}`;
}

export function getClient(): Action1Client {
  const creds = getCredentials();
  if (!creds) {
    throw new Error(
      "Action1 credentials not configured. Set ACTION1_API_KEY + ACTION1_SECRET in env, " +
        "or provide X-Action1-API-Key + X-Action1-Secret headers in gateway mode.",
    );
  }
  const key = credentialKey(creds);
  let client = clientCache.get(key);
  if (!client) {
    client = new Action1Client({
      apiKey: creds.apiKey,
      secret: creds.secret,
      region: creds.region,
      defaultOrgId: creds.defaultOrgId,
    });
    clientCache.set(key, client);
  }
  return client;
}
