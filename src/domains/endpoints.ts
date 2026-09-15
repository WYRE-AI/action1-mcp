/**
 * Endpoints domain — list + get device records.
 *
 * Maps PSAction1 Get-Action1 queries: Endpoints, Endpoint (by id), EndpointApps.
 * First ship covers list + get; EndpointApps deferred to follow-up.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DomainHandler } from "../utils/types.js";
import { getClient } from "../utils/client.js";
import { buildDeviceCard, DEVICE_CARD_META } from "../card.builder.js";

const tools: Tool[] = [
  {
    name: "action1_list_endpoints",
    description:
      "List all endpoints (managed devices) in an Action1 organization. " +
      "Returns id, hostname, OS, status, last-seen, and group membership. " +
      "Use the organization id from action1_list_organizations.",
    inputSchema: {
      type: "object",
      properties: {
        organization_id: {
          type: "string",
          description:
            "Action1 organization id. If omitted, uses ACTION1_DEFAULT_ORG_ID from credentials.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 100, max 500).",
          minimum: 1,
          maximum: 500,
        },
      },
    },
  },
  {
    name: "action1_get_endpoint",
    description:
      "Get a single endpoint by id, with full detail: hardware, installed agent version, " +
      "last contact, group memberships, custom attributes.",
    _meta: DEVICE_CARD_META,
    inputSchema: {
      type: "object",
      properties: {
        endpoint_id: {
          type: "string",
          description: "Action1 endpoint id (required).",
        },
        organization_id: {
          type: "string",
          description: "Organization id scope. Defaults to ACTION1_DEFAULT_ORG_ID.",
        },
      },
      required: ["endpoint_id"],
    },
  },
];

export const endpointsHandler: DomainHandler = {
  tools,
  async handle(name, args) {
    const client = getClient();

    if (name === "action1_list_endpoints") {
      const orgId = (args.organization_id as string | undefined) ?? undefined;
      const limit = (args.limit as number | undefined) ?? 100;
      const endpoints = await client.listEndpoints({ orgId, limit });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: endpoints.length, endpoints }, null, 2),
          },
        ],
      };
    }

    if (name === "action1_get_endpoint") {
      const endpointId = args.endpoint_id as string;
      if (!endpointId) {
        throw new Error("endpoint_id is required");
      }
      const orgId = (args.organization_id as string | undefined) ?? undefined;
      const endpoint = await client.getEndpoint(endpointId, { orgId });

      // MCP Apps: attach the normalized card payload the ui:// device card
      // renders from. Best-effort — any failure just means no UI surface,
      // never a failed tool result.
      let payload: Record<string, unknown> | unknown = endpoint;
      let card: ReturnType<typeof buildDeviceCard> = null;
      try {
        if (endpoint && typeof endpoint === "object" && !Array.isArray(endpoint)) {
          const record = endpoint as Record<string, unknown>;
          card = buildDeviceCard(record);
          if (card) payload = { ...record, _card: card };
        }
      } catch {
        payload = endpoint;
      }

      // SEP-1865: content/structuredContent separation — a short text
      // summary goes in `content`, the full record (including _card)
      // moves to `structuredContent`. No fields are dropped, only relocated.
      const displayName = card?.name ?? endpointId;
      return {
        content: [{ type: "text", text: `Retrieved endpoint "${displayName}".` }],
        structuredContent: payload as Record<string, unknown>,
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  },
};
