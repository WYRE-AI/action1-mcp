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

Install via the MCPB bundle from the [latest release](https://github.com/wyre-technology/action1-mcp/releases).

Required credentials (created in Action1 → Settings → API Credentials, **non-recoverable on creation — copy immediately**):
- API Key (Client ID)
- Secret
- Region (`NorthAmerica` default; also `Europe`, `AsiaPacific`, `Australia`)
- Optional default organization id (for single-tenant use)

### Stdio (direct)

```bash
ACTION1_API_KEY=... \
ACTION1_SECRET=... \
ACTION1_REGION=NorthAmerica \
ACTION1_DEFAULT_ORG_ID=org-... \
npx -y github:wyre-technology/action1-mcp
```

### HTTP (gateway mode)

```bash
MCP_TRANSPORT=http PORT=8080 AUTH_MODE=gateway \
  docker run -p 8080:8080 ghcr.io/wyre-technology/action1-mcp:latest
```

Per-request credentials via headers:
- `X-Action1-API-Key`
- `X-Action1-Secret`
- `X-Action1-Region`
- `X-Action1-Default-Org-Id`

## Architecture

```
src/
├── index.ts                  # stdio + HTTP transports, tool dispatch
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
