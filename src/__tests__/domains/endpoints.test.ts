/**
 * Endpoints domain tests — FLOOR per playbook (general handler bar).
 *
 * Action1's read-only endpoint surface is not security-critical (no
 * credential/auth-touching output that influences access decisions),
 * so the four-layer false-positive-resistant pattern does not apply.
 * Coverage = paired registration + handler-calls-client + handler-returns-shape.
 *
 * If a future tool exposes credential or session data, escalate to the
 * four-layer pattern per playbook §"Higher bar for security-critical surface".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { endpointsHandler } from "../../domains/endpoints.js";
import * as clientModule from "../../utils/client.js";

describe("endpoints domain", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("tool registration (pre-flight)", () => {
    it("registers action1_list_endpoints and action1_get_endpoint", () => {
      const names = endpointsHandler.tools.map((t) => t.name);
      expect(names).toContain("action1_list_endpoints");
      expect(names).toContain("action1_get_endpoint");
    });

    it("action1_get_endpoint requires endpoint_id", () => {
      const tool = endpointsHandler.tools.find(
        (t) => t.name === "action1_get_endpoint",
      );
      expect(tool?.inputSchema.required).toEqual(["endpoint_id"]);
    });
  });

  describe("action1_list_endpoints", () => {
    it("calls client.listEndpoints with org + limit and returns count + endpoints", async () => {
      const listEndpoints = vi.fn().mockResolvedValue([
        { id: "e1", hostname: "host-a" },
        { id: "e2", hostname: "host-b" },
      ]);
      vi.spyOn(clientModule, "getClient").mockReturnValue({
        listEndpoints,
      } as never);

      const result = await endpointsHandler.handle("action1_list_endpoints", {
        organization_id: "org-1",
        limit: 50,
      });

      expect(listEndpoints).toHaveBeenCalledWith({ orgId: "org-1", limit: 50 });
      const body = JSON.parse(result.content[0].text);
      expect(body.count).toBe(2);
      expect(body.endpoints).toHaveLength(2);
    });

    it("defaults limit to 100 when omitted", async () => {
      const listEndpoints = vi.fn().mockResolvedValue([]);
      vi.spyOn(clientModule, "getClient").mockReturnValue({
        listEndpoints,
      } as never);

      await endpointsHandler.handle("action1_list_endpoints", {});

      expect(listEndpoints).toHaveBeenCalledWith({
        orgId: undefined,
        limit: 100,
      });
    });
  });

  describe("action1_get_endpoint", () => {
    it("rejects calls without endpoint_id (negative control — distinct from client failure)", async () => {
      vi.spyOn(clientModule, "getClient").mockReturnValue({
        getEndpoint: vi.fn(),
      } as never);

      await expect(
        endpointsHandler.handle("action1_get_endpoint", {}),
      ).rejects.toThrow(/endpoint_id is required/);
    });

    it("calls client.getEndpoint with id + org scope and returns the record", async () => {
      const getEndpoint = vi.fn().mockResolvedValue({ id: "e1", hostname: "host-a" });
      vi.spyOn(clientModule, "getClient").mockReturnValue({
        getEndpoint,
      } as never);

      const result = await endpointsHandler.handle("action1_get_endpoint", {
        endpoint_id: "e1",
        organization_id: "org-1",
      });

      expect(getEndpoint).toHaveBeenCalledWith("e1", { orgId: "org-1" });
      const body = JSON.parse(result.content[0].text);
      expect(body).toMatchObject({ id: "e1", hostname: "host-a" });
      // MCP Apps: the normalized _card is additive (see mcp-apps.test.ts).
      expect(body._card).toMatchObject({ id: "e1", name: "host-a" });
    });
  });
});
