# Action1 MCP Server

[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)

MCP server for [Action1](https://www.action1.com/) — endpoint inventory, patch visibility, and policy automation via the [Model Context Protocol](https://modelcontextprotocol.io).

Read-only in v1. Deploy / automation surface is intentionally separated to a later release for blast-radius reasons (a bad policy push can brick endpoint fleets).

## Tools

| Tool | Description |
|---|---|
| `action1_navigate` | Discover available tools by domain (organizations / endpoints / policies / updates) |
| `action1_list_organizations` | List Action1 tenants accessible to the configured credentials |
| `action1_list_endpoints` | List managed devices in an organization |
| `action1_get_endpoint` | Get a single endpoint by id |
| `action1_list_missing_updates` | List missing OS/application patches across endpoints — Action1's headline value-prop |
| `action1_list_policies` | List automation / policy / remediation rules |

API surface maps to [PSAction1](https://github.com/Action1Corp/PSAction1) (Action1's MIT-licensed PowerShell module). When the v1 surface earns its keep, write tools (deploy, requery, package upload) come in v2 behind separate review.

### Interactive Device Card (MCP Apps)

`action1_get_endpoint` renders as an interactive device-summary card in MCP
Apps hosts (Claude Desktop/web) — status, OS, user, IP, agent version,
reboot-required, and missing-update counts at a glance; plain-JSON behavior is
unchanged in other hosts. The card is read-only (matching the v1 tool surface),
neutral by default, and brandable via `window.__BRAND__` injection or
`MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`,
`MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`,
`MCP_BRAND_TEXT`) — no rebuild needed.

## Usage

### Claude Desktop (MCPB)

Install via the MCPB bundle from the [latest release](https://github.com/WYRE-AI/action1-mcp/releases).

Required credentials (created in Action1 → Settings → API Credentials, **non-recoverable on creation — copy immediately**):
- API Key (Client ID)
- Secret
- Region (`NorthAmerica` default; also `NorthAmerica-2`, `Europe`, `Australia`)
- Optional default organization id (for single-tenant use)

### Stdio (direct)

```bash
ACTION1_API_KEY=... \
ACTION1_SECRET=... \
ACTION1_REGION=NorthAmerica \
ACTION1_DEFAULT_ORG_ID=org-... \
npx -y github:WYRE-AI/action1-mcp
```

### HTTP

`CONDUIT_S2S_SECRET` is required. If it is empty or a known placeholder (`changeme`, `replace-with-a-real-secret`, and similar), the HTTP server logs an error and exits non-zero. It never prints the secret. Generate one with `openssl rand -hex 32`.

`MCP_HTTP_HOST` defaults to `127.0.0.1` when unset. Set `0.0.0.0` only when `CONDUIT_S2S_SECRET` is set. The container image does that and sets `AUTH_MODE=gateway`. `MCP_HTTP_PORT` (or `PORT`) selects the port and defaults to `8080`.

`MCP_ALLOW_INSECURE_DEV=1` starts HTTP without `CONDUIT_S2S_SECRET`, logs a warning, skips `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` (including `0.0.0.0`) refuses to start. A placeholder secret is still rejected. Local development only.

`/health` stays unauthenticated and does not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

#### X-Gateway-S2S

Every HTTP request except `/health` must include `X-Gateway-S2S` when a secret is configured. The value is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of the literal string `t=<unix seconds>` keyed with `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock. A missing or invalid header is HTTP 401, before vendor credentials are read.

```bash
TS=$(date +%s)
SIG=$(printf 't=%s' "$TS" | openssl dgst -sha256 -hmac "$CONDUIT_S2S_SECRET" -hex | awk '{print $NF}')
curl -sS http://127.0.0.1:8080/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-Gateway-S2S: t=${TS},v1=${SIG}" \
  -H "X-Action1-API-Key: $ACTION1_API_KEY" \
  -H "X-Action1-Secret: $ACTION1_SECRET" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

#### Gateway mode (`AUTH_MODE=gateway`)

The Docker image and Compose file default to gateway mode. Every request must include:

- `X-Action1-API-Key`
- `X-Action1-Secret`
- `X-Action1-Region` (optional)
- `X-Action1-Default-Org-Id` (optional)

A request missing the API key or secret gets `401` and does not fall back to `ACTION1_API_KEY` / `ACTION1_SECRET` in the process environment. Those headers are the only credential source for that request.

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  ghcr.io/wyre-ai/action1-mcp:latest
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, publishes `127.0.0.1:8080:8080`, and does not pass static Action1 credentials into the container:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

#### Single-tenant HTTP (`AUTH_MODE=env`)

Requests still require a valid `X-Gateway-S2S` header. Vendor credentials come from `ACTION1_API_KEY` and `ACTION1_SECRET` when the request does not carry those headers.

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e ACTION1_API_KEY="$ACTION1_API_KEY" \
  -e ACTION1_SECRET="$ACTION1_SECRET" \
  -e ACTION1_REGION=NorthAmerica \
  -p 127.0.0.1:8080:8080 \
  ghcr.io/wyre-ai/action1-mcp:latest
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` and logs a warning:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
```

## Architecture

```
src/
├── index.ts                  # stdio + HTTP transports, tool dispatch, S2S startup
├── s2s-verify.ts             # X-Gateway-S2S HMAC-SHA256 check
├── card.builder.ts           # MCP Apps device-card normalization + brand injection
├── resources.ts              # resources/list + resources/read (ui:// device card)
├── generated/
│   └── device-card-html.ts   # committed vite single-file bundle (npm run build:ui)
├── sdk/
│   └── action1-client.ts     # embedded REST + OAuth client (factor-out candidate
│                             # if surface crosses ~20 tools / 2+ domains)
├── utils/
│   ├── client.ts             # credential resolution (env vs gateway headers)
│   └── types.ts              # DomainHandler interface
├── domains/                  # one file per resource type
│   ├── organizations.ts
│   ├── endpoints.ts
│   ├── policies.ts
│   └── updates.ts
└── __tests__/                # domain tests + MCP Apps contract tests
ui/                           # device-card source (index.html + device-card.ts)
```

Per-request credential isolation via `AsyncLocalStorage` — concurrent requests in HTTP mode never share credentials through `process.env`.

## Development

```bash
npm install
npm run build
npm test
npm run dev      # tsc --watch
npm run lint     # eslint
npm run typecheck
```

## License

Apache-2.0. See [LICENSE](LICENSE).
