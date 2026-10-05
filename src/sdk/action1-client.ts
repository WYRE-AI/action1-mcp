/**
 * Action1 REST API client — embedded in action1-mcp for v1.
 *
 * Lives in src/sdk/ (not src/utils/) so the eventual factor-out to
 * @wyre-ai/node-action1 is a `git mv src/sdk/ → new-repo/src/` rather
 * than code archaeology. See playbook §"embed vs separate-SDK is a size-class
 * decision" for the rule.
 *
 * API surface mapped from Action1Corp/PSAction1 (MIT, vendor-owned) Get-Action1
 * Query enum. v1 covers read-only tools only.
 *
 * Auth: OAuth 2.0 client credentials grant
 *   POST https://app.action1.com/api/3.0/oauth2/token (NorthAmerica)
 *   form: grant_type=client_credentials, client_id, client_secret
 *   returns: { access_token (JWT, 1h), refresh_token, expires_in, token_type: 'bearer' }
 *
 * Region routing: Action1 hosts per-region. Base URL is derived from region
 * because the token endpoint and resource endpoints share the same host — never
 * hardcode app.action1.com for the token exchange.
 *
 * Resource paths (read-only v1). Action1's gateway answers an unknown route with
 * 403, not 404, so a wrong path here presents as a permissions problem and is
 * easy to misdiagnose — see src/__tests__/sdk/action1-client.test.ts, which pins
 * every one of these:
 *   GET /api/3.0/organizations
 *   GET /api/3.0/endpoints/managed/<org>          — list endpoints
 *   GET /api/3.0/endpoints/managed/<org>/<eid>    — endpoint detail
 *   GET /api/3.0/updates/<org>                    — missing updates
 *   GET /api/3.0/policies/instances/<org>         — automations / policies
 *
 * NOTE on the last one: Action1 renamed this resource. The current OpenAPI
 * reference documents it as /api/3.0/automations/instances/<org>, though its
 * operationId is still literally `policies_instances_orgId_get`. The vendor's
 * own PSAction1 module still calls /policies/instances/<org>, which remains a
 * live alias and is what we have verified end to end. Migrating to the
 * /automations/ spelling needs live-tenant verification first.
 */

/**
 * Action1's regional API hosts, as listed in the official OpenAPI `servers`
 * array and in PSAction1's Action1.Hosts.ps1.
 *
 * There is deliberately no "AsiaPacific" entry: `app.ap.action1.com` does not
 * exist (NXDOMAIN) and never did. It was carried here as a plausible-looking
 * guess, so selecting that region failed with an opaque DNS error. Australia is
 * Action1's only Asia-Pacific-area data centre. AsiaPacific is NOT silently
 * remapped to Australia — that would move customer data across a residency
 * boundary without consent, so an explicit error is the correct behaviour.
 */
const REGION_HOSTS = {
  NorthAmerica: "app.action1.com",
  "NorthAmerica-2": "app.na-2.action1.com",
  Europe: "app.eu.action1.com",
  Australia: "app.au.action1.com",
} as const;

export type Action1Region = keyof typeof REGION_HOSTS;

/** Shorthand accepted by the vendor's own Set-Action1Region ValidateSet. */
const REGION_ALIASES: Record<string, Action1Region> = {
  "NA-2": "NorthAmerica-2",
};

export interface Action1ClientOptions {
  apiKey: string;
  secret: string;
  region: Action1Region;
  defaultOrgId?: string;
}

interface TokenState {
  accessToken: string;
  expiresAt: number; // epoch ms
  refreshToken: string;
}

export class Action1Client {
  private readonly baseUrl: string;
  private token: TokenState | null = null;

  constructor(private readonly opts: Action1ClientOptions) {
    const region = REGION_ALIASES[opts.region] ?? opts.region;
    const host = REGION_HOSTS[region];
    if (!host) {
      throw new Error(
        `Unknown Action1 region: ${opts.region}. Valid regions are ` +
          `${Object.keys(REGION_HOSTS).join(", ")}. ` +
          `(AsiaPacific was removed — app.ap.action1.com does not exist. ` +
          `Australia is Action1's Asia-Pacific-area data centre, but switching ` +
          `to it changes where your data resides, so set it deliberately.)`,
      );
    }
    this.baseUrl = `https://${host}`;
  }

  private async ensureToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 60_000) {
      return this.token.accessToken;
    }
    // Refresh path skipped for v1 — re-mint via client_credentials. Refresh
    // token plumbing is a follow-up once we have rate-limit pressure.
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.opts.apiKey,
      client_secret: this.opts.secret,
    });
    const res = await fetch(`${this.baseUrl}/api/3.0/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Action1 OAuth token failed: ${res.status} ${text}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
    };
    this.token = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: now + json.expires_in * 1000,
    };
    return this.token.accessToken;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.ensureToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Action1 ${init.method ?? "GET"} ${path} failed: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  // --- v1 read-only surface ---

  async listOrganizations(): Promise<Array<{ id: string; name: string }>> {
    return this.request("/api/3.0/organizations");
  }

  async listEndpoints(args: { orgId?: string; limit?: number }): Promise<unknown[]> {
    const orgId = args.orgId ?? this.opts.defaultOrgId;
    if (!orgId) throw new Error("organization_id is required (no defaultOrgId configured)");
    const params = new URLSearchParams();
    if (args.limit) params.set("limit", String(args.limit));
    const qs = params.toString() ? `?${params}` : "";
    return this.request(`/api/3.0/endpoints/managed/${encodeURIComponent(orgId)}${qs}`);
  }

  async getEndpoint(endpointId: string, args: { orgId?: string }): Promise<unknown> {
    const orgId = args.orgId ?? this.opts.defaultOrgId;
    if (!orgId) throw new Error("organization_id is required (no defaultOrgId configured)");
    return this.request(
      `/api/3.0/endpoints/managed/${encodeURIComponent(orgId)}/${encodeURIComponent(endpointId)}`,
    );
  }

  async listMissingUpdates(args: { orgId?: string; limit?: number }): Promise<unknown[]> {
    const orgId = args.orgId ?? this.opts.defaultOrgId;
    if (!orgId) throw new Error("organization_id is required (no defaultOrgId configured)");
    const params = new URLSearchParams();
    if (args.limit) params.set("limit", String(args.limit));
    const qs = params.toString() ? `?${params}` : "";
    return this.request(`/api/3.0/updates/${encodeURIComponent(orgId)}${qs}`);
  }

  async listPolicies(args: { orgId?: string }): Promise<unknown[]> {
    const orgId = args.orgId ?? this.opts.defaultOrgId;
    if (!orgId) throw new Error("organization_id is required (no defaultOrgId configured)");
    return this.request(`/api/3.0/policies/instances/${encodeURIComponent(orgId)}`);
  }
}
