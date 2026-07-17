/**
 * MCP Apps (SEP-1865) contract tests — mirrors the checks an MCP Apps host
 * performs to render the device card:
 *   1. the renderable tool advertises the UI resource via _meta (both forms)
 *   2. the ui:// resource lists and reads back as profile=mcp-app HTML
 *   3. buildDeviceCard normalizes an Action1 endpoint into the card payload
 *      the iframe renders from, best-effort (null = no card, tool unchanged)
 *   4. the default bundle is brand-neutral; MCP_BRAND_* injection themes it
 *      at serve time without a rebuild
 */

import { describe, it, expect, vi } from "vitest";
import { getAvailableDomains, getDomainHandler } from "../domains/index.js";
import { endpointsHandler } from "../domains/endpoints.js";
import * as clientModule from "../utils/client.js";
import { listResources, readResource } from "../resources.js";
import {
  buildDeviceCard,
  applyBrandInjection,
  DEVICE_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
} from "../card.builder.js";
import { DEVICE_CARD_HTML } from "../generated/device-card-html.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Read-only card: only the single-entity read tool is renderable. */
const RENDERABLE_TOOLS = ["action1_get_endpoint"];

async function getAllTools(): Promise<Tool[]> {
  const tools: Tool[] = [];
  for (const domain of getAvailableDomains()) {
    const handler = await getDomainHandler(domain);
    tools.push(...handler.tools);
  }
  return tools;
}

describe("MCP Apps device card", () => {
  describe("tool _meta advertisement", () => {
    it.each(RENDERABLE_TOOLS)("%s links the card via _meta", async (name) => {
      const tool = (await getAllTools()).find((t) => t.name === name);
      expect(tool).toBeDefined();
      // Canonical flat key (ext-apps RESOURCE_URI_META_KEY) …
      expect(tool?._meta?.["ui/resourceUri"]).toBe(DEVICE_CARD_RESOURCE_URI);
      // … and the nested form registerAppTool also emits.
      expect((tool?._meta?.ui as { resourceUri?: string })?.resourceUri).toBe(
        DEVICE_CARD_RESOURCE_URI,
      );
    });

    it("no other tools carry UI metadata", async () => {
      const others = (await getAllTools()).filter(
        (t) => t._meta && !RENDERABLE_TOOLS.includes(t.name),
      );
      expect(others).toEqual([]);
    });
  });

  describe("ui:// resource", () => {
    it("is listed with the MCP Apps MIME type", () => {
      const card = listResources().find((r) => r.uri === DEVICE_CARD_RESOURCE_URI);
      expect(card?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
    });

    it("reads back as profile=mcp-app HTML containing the card app", () => {
      const content = readResource(DEVICE_CARD_RESOURCE_URI);
      expect(content.mimeType).toBe(MCP_APP_RESOURCE_MIME);
      // No MCP_BRAND_* env set → the embedded HTML is served byte-identical.
      expect(content.text).toBe(DEVICE_CARD_HTML);
      expect(content.text).toContain("card__bar");
      // The injection marker survives the vite build, exactly once.
      expect(content.text.match(/BRAND_INJECT/g)).toHaveLength(1);
      // The vite build must have inlined the bridge script — a bare <script src>
      // would be unloadable from a resources/read HTML string.
      expect(content.text).not.toContain('src="./device-card.ts"');
    });

    it("serves neutral defaults with no vendor identity", () => {
      const { text } = readResource(DEVICE_CARD_RESOURCE_URI);
      expect(text).not.toMatch(/WYRE/i);
      expect(text).not.toContain("00c9db"); // WYRE cyan
      expect(text).not.toContain("ede947"); // WYRE yellow
      expect(text).not.toContain("fonts.googleapis.com"); // no external fetches
    });

    it("injects MCP_BRAND_* env vars into the served HTML", () => {
      vi.stubEnv("MCP_BRAND_NAME", "Acme MSP");
      vi.stubEnv("MCP_BRAND_PRIMARY_COLOR", "#ff0000");
      try {
        const { text } = readResource(DEVICE_CARD_RESOURCE_URI);
        expect(text).toContain(
          '<script>window.__BRAND__={"name":"Acme MSP","primaryColor":"#ff0000"}</script>',
        );
        expect(text).not.toContain("BRAND_INJECT");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("rejects unknown resource URIs", () => {
      expect(() => readResource("ui://action1/nope.html")).toThrow(/Unknown resource/);
    });
  });

  describe("applyBrandInjection", () => {
    const html = DEVICE_CARD_HTML;

    it("replaces the marker with an inline window.__BRAND__ script", () => {
      const out = applyBrandInjection(html, { name: "Acme", primaryColor: "#123456" });
      expect(out).toContain('window.__BRAND__={"name":"Acme","primaryColor":"#123456"}');
      expect(out).not.toContain("BRAND_INJECT");
    });

    it("escapes < so brand values cannot break out of the script tag", () => {
      const out = applyBrandInjection(html, { name: "</script><script>alert(1)" });
      expect(out).not.toContain("</script><script>alert(1)");
      expect(out).toContain("\\u003c/script>\\u003cscript>alert(1)");
    });

    it("returns the HTML byte-identical for an empty brand", () => {
      expect(applyBrandInjection(html, {})).toBe(html);
      expect(applyBrandInjection(html, { name: "" })).toBe(html);
    });
  });

  describe("buildDeviceCard", () => {
    const endpoint = {
      id: "0FED9A99-9384-4D33-8E4D-D2477A2C7D5E",
      name: "DESKTOP-7F2K1",
      status: "Connected",
      OS: "Windows 11 Pro",
      OS_version: "10.0.26100",
      platform: "Windows_64",
      user: "ACME\\druiz",
      serial: "5CD1234XYZ",
      address: "192.168.1.42",
      agent_version: "5.180.777.1",
      last_seen: "2026-07-16 22:11:03",
      reboot_required: "yes",
      missing_critical_updates: 3,
      missing_other_updates: 12,
    };

    it("normalizes an endpoint record into the flat card payload", () => {
      expect(buildDeviceCard(endpoint)).toEqual({
        id: "0FED9A99-9384-4D33-8E4D-D2477A2C7D5E",
        name: "DESKTOP-7F2K1",
        status: "Connected",
        os: "Windows 11 Pro (10.0.26100)",
        platform: "Windows_64",
        user: "ACME\\druiz",
        serial: "5CD1234XYZ",
        ipAddress: "192.168.1.42",
        agentVersion: "5.180.777.1",
        lastSeen: "2026-07-16 22:11:03",
        rebootRequired: true,
        missingCriticalUpdates: 3,
        missingOtherUpdates: 12,
      });
    });

    it("omits fields the API did not return (sparse record)", () => {
      const card = buildDeviceCard({ id: "e1", name: "host-a", status: "Disconnected" });
      expect(card).toEqual({ id: "e1", name: "host-a", status: "Disconnected" });
    });

    it("tolerates vendor field-name variants", () => {
      const card = buildDeviceCard({
        id: "e1",
        device_name: "SRV-01",
        os: "Ubuntu 24.04",
        ip_address: "10.0.0.5",
        reboot_required: false,
      });
      expect(card).toMatchObject({
        name: "SRV-01",
        os: "Ubuntu 24.04",
        ipAddress: "10.0.0.5",
        rebootRequired: false,
      });
    });

    it("returns null for payloads that are not a device record", () => {
      expect(buildDeviceCard({})).toBeNull();
      expect(buildDeviceCard({ id: "e1" })).toBeNull(); // no display name
      expect(buildDeviceCard({ name: "orphan" })).toBeNull(); // no id
      expect(buildDeviceCard({ id: 42, name: "num-id" } as never)).toBeNull();
    });

    it("drops malformed optional fields instead of failing the card", () => {
      const card = buildDeviceCard({
        id: "e1",
        name: "host-a",
        status: 7,
        missing_critical_updates: "three",
        reboot_required: "maybe",
      } as never);
      expect(card).toEqual({ id: "e1", name: "host-a" });
    });
  });

  describe("action1_get_endpoint result (card attachment is best-effort)", () => {
    it("attaches _card to the JSON payload without altering the record", async () => {
      const getEndpoint = vi.fn().mockResolvedValue({ id: "e1", name: "host-a" });
      vi.spyOn(clientModule, "getClient").mockReturnValue({ getEndpoint } as never);

      const result = await endpointsHandler.handle("action1_get_endpoint", {
        endpoint_id: "e1",
      });
      const body = JSON.parse(result.content[0].text);
      expect(body).toMatchObject({ id: "e1", name: "host-a" });
      expect(body._card).toEqual({ id: "e1", name: "host-a" });
    });

    it("returns the payload unchanged when no card can be built", async () => {
      const getEndpoint = vi.fn().mockResolvedValue({ unexpected: "shape" });
      vi.spyOn(clientModule, "getClient").mockReturnValue({ getEndpoint } as never);

      const result = await endpointsHandler.handle("action1_get_endpoint", {
        endpoint_id: "e1",
      });
      expect(JSON.parse(result.content[0].text)).toEqual({ unexpected: "shape" });
    });

    it("survives non-object payloads (card never breaks the tool result)", async () => {
      const getEndpoint = vi.fn().mockResolvedValue(["not", "an", "object"]);
      vi.spyOn(clientModule, "getClient").mockReturnValue({ getEndpoint } as never);

      const result = await endpointsHandler.handle("action1_get_endpoint", {
        endpoint_id: "e1",
      });
      expect(JSON.parse(result.content[0].text)).toEqual(["not", "an", "object"]);
    });
  });
});
