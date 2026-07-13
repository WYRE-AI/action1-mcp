# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
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
- Corrected Action1 REST API paths in `src/sdk/action1-client.ts`: OAuth token endpoint now uses the `/api/3.0/oauth2/token` prefix, and the endpoints/updates/policies resource paths now match the real API (`/endpoints/managed/{org}`, `/updates/{org}`, `/policies/instances/{org}`). Previously every tool call 403'd at the token request. (#22)
- `pack:mcpb` / `validate:mcpb` now invoke `@anthropic-ai/mcpb` instead of the non-existent bare `mcpb` npm package.

### Added
- Initial scaffold: 4 domains (organizations / endpoints / policies / updates), 5 read-only tools.
- OAuth 2.0 client-credentials auth, region-aware (NorthAmerica / Europe / AsiaPacific / Australia).
- Stdio + Streamable HTTP transports. Gateway-mode credential isolation via AsyncLocalStorage.
- MCPB manifest + Dockerfile + GHCR publishing via semantic-release.
