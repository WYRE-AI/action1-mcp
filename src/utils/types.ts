import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type DomainName =
  | "endpoints"
  | "organizations"
  | "policies"
  | "updates";

export interface DomainHandler {
  tools: Tool[];
  handle(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

export function isDomainName(s: string): s is DomainName {
  return (
    s === "endpoints" ||
    s === "organizations" ||
    s === "policies" ||
    s === "updates"
  );
}
