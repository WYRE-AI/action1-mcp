# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **Region hosts corrected.** The `AsiaPacific` region pointed at `app.ap.action1.com`, which does
  not exist — the name is NXDOMAIN and is absent from Action1's official OpenAPI `servers` list,
  from PSAction1's `Action1.Hosts.ps1`, and from `Set-Action1Region`'s accepted values. Selecting it
  failed with an opaque DNS error on the first tool call. It has been removed, and the real
  `NorthAmerica-2` region (`app.na-2.action1.com`, verified live) added in its place, along with the
  vendor's `NA-2` shorthand. `AsiaPacific` is deliberately **not** remapped to Australia: that would
  move customer data across a residency boundary without consent, so it now raises an explicit error
  naming the valid regions. Australia remains Action1's only Asia-Pacific-area data centre.
- `server.json` now advertises the credential environment variables the runtime actually reads
  (`ACTION1_API_KEY`, `ACTION1_SECRET`, `ACTION1_REGION`, `ACTION1_DEFAULT_ORG_ID`). It previously
  listed `ACTION1_CLIENT_ID`, `ACTION1_CLIENT_SECRET`, `ACTION1_TENANT` and `ACTION1_BASE_URL`,
  none of which `getCredentials()` reads, so anyone installing from the MCP Registry or via
  `docker run` set four variables and still got "Action1 credentials not configured".
  `manifest.json` (the MCPB desktop bundle) always had the correct names, which is why the
  mismatch went unnoticed. `ACTION1_REGION` now also declares its four valid choices and its
  `NorthAmerica` default. Reported and fixed by [@noekan](https://github.com/noekan) in
  [noekan/action1-mcp](https://github.com/noekan/action1-mcp).
- Credential resolution now ignores unresolved MCPB `${user_config.X}` placeholders for the
  optional `ACTION1_REGION` and `ACTION1_DEFAULT_ORG_ID` fields (env and gateway-header paths).
  When an optional user_config field is left blank, Claude Desktop injects the literal template
  string into the env var rather than omitting it. A blank `ACTION1_DEFAULT_ORG_ID` previously
  became a real org id: it was `encodeURIComponent`-ed into the request path (→ 404) and defeated
  the "organization_id is required" guard, and a blank `ACTION1_REGION` would throw "Unknown
  Action1 region". A new `cleanCredential` helper strips blank/whitespace/placeholder values so
  they read as absent. Mirrors itglue-mcp #73.
- Added an unconditional `200` `/health` liveness route to the HTTP transport. The server
  previously had no `/health` endpoint at all, so the Azure Container Apps liveness probe
  (`GET /health`, no credentials/Accept headers) fell through to the MCP transport, got a
  non-2xx response, and crash-looped the container every ~90 seconds.
- HTTP transport now builds a fresh `Server` + `StreamableHTTPServerTransport` per `/mcp` request in stateless mode (no `sessionIdGenerator`), instead of sharing one stateful transport across all requests. The shared stateful transport accepted only one `initialize` per container lifetime, so behind the multi-user gateway every client after the first received `-32600 "Server already initialized"` and saw 0 tools until a restart. Per-request servers are created inside the `runWithCredentials` context and disposed on response close, and the request handler is now wrapped so a failure returns a JSON-RPC `-32603` 500 instead of escaping as an unhandled rejection.
- Corrected Action1 REST API paths in `src/sdk/action1-client.ts`: OAuth token endpoint now uses the `/api/3.0/oauth2/token` prefix, and the endpoints/updates/policies resource paths now match the real API (`/endpoints/managed/{org}`, `/updates/{org}`, `/policies/instances/{org}`). Previously every tool call 403'd at the token request. Action1's gateway answers unknown routes with `403` rather than `404`, so the wrong paths presented as a permissions problem. Independently reported and fixed by [@noekan](https://github.com/noekan) in [noekan/action1-mcp](https://github.com/noekan/action1-mcp). (#22)
- `pack:mcpb` / `validate:mcpb` now invoke `@anthropic-ai/mcpb` instead of the non-existent bare `mcpb` npm package.

### Added
- URL-pinning tests for the embedded REST client (`src/__tests__/sdk/action1-client.test.ts`).
  Every existing test mocks `getClient()` and asserts on the handler layer, so none observed the
  URL actually put on the wire — the blind spot that let the wrong REST paths ship in v1.0.0–v1.0.3.
  The new suite stubs global `fetch` and pins the exact absolute URL of every request, asserts the
  five superseded paths never reappear, and covers all four region hosts plus query/percent
  encoding. A companion suite (`src/__tests__/server-manifest.test.ts`) pins `server.json`'s
  advertised credential variables to the ones `getCredentials()` reads, so that manifest cannot
  drift from the runtime again.
- **Interactive device card via MCP Apps (SEP-1865).** `action1_get_endpoint` results now render as an interactive card in MCP Apps hosts (Claude Desktop/web, and other hosts advertising the `io.modelcontextprotocol/ui` extension), instead of a wall of JSON. The card shows the device name, connection status, OS/platform, logged-on user, IP, serial, agent version, last-seen, a reboot-required badge, and missing-update counts. Non-App hosts are unaffected: the tool's JSON payload is unchanged apart from a new additive `_card` field. The card is read-only, matching the server's v1 read-only surface — no write round-trip.
  - The renderable tool advertises the UI via `_meta` (`ui/resourceUri`, plus the nested `ui.resourceUri` form) pointing at a new `ui://action1/device-card.html` resource served as `text/html;profile=mcp-app`. The card HTML is a self-contained vite single-file bundle embedded at build time (`src/generated/device-card-html.ts`, committed), so it serves identically from stdio and Node HTTP without vite at runtime. The server now declares the `resources` capability and answers `resources/list` / `resources/read` (`src/resources.ts`).
  - The card is neutral by default (system fonts, no vendor identity, no external fetches) and brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`): at serve time the server replaces the card's BRAND_INJECT marker with an inline, `<`-escaped `window.__BRAND__` script, so self-hosters can theme the card without rebuilding. No brand configured = HTML served byte-identical.
  - Card building is best-effort (`src/card.builder.ts`): a payload that doesn't normalize simply ships without `_card`, never a failed tool result. New contract tests in `src/__tests__/mcp-apps.test.ts` pin the `_meta` advertisement, the `ui://` resource wire shape, the neutral-default/brand-injection behavior, and the card normalization.
- Initial scaffold: 4 domains (organizations / endpoints / policies / updates), 5 read-only tools.
- OAuth 2.0 client-credentials auth, region-aware (NorthAmerica / Europe / AsiaPacific / Australia).
- Stdio + Streamable HTTP transports. Gateway-mode credential isolation via AsyncLocalStorage.
- MCPB manifest + Dockerfile + GHCR publishing via semantic-release.
