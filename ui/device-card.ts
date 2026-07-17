/**
 * Iframe bridge + renderer for the Action1 device card (MCP Apps, SEP-1865).
 *
 * Runs inside the host's sandboxed iframe. Uses the official MCP Apps client
 * (`App`) to receive the tool result from the host. The card is read-only —
 * action1-mcp v1 exposes no write tools, so there is no round-trip action.
 *
 * The server attaches a normalized `_card` payload to action1_get_endpoint
 * results (see src/card.builder.ts) so this renderer never needs to resolve
 * ids or vendor field-name variants itself.
 *
 * Rendering uses DOM construction (no innerHTML) — hostnames, user names, and
 * OS strings are untrusted vendor data, so text only ever lands in text nodes.
 *
 * White-label: the card is neutral by default (no operator identity) and
 * applies an injected `window.__BRAND__` override (set by the MCP server via
 * MCP_BRAND_* env vars, or a gateway per-org) so the same card can render in
 * any operator's brand.
 */
import { App } from "@modelcontextprotocol/ext-apps";

interface Brand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}
declare global {
  interface Window {
    __BRAND__?: Brand;
  }
}

/** Mirror of DeviceCard in src/card.builder.ts — keep in sync. */
interface DeviceCard {
  id: string;
  name: string;
  status?: string;
  os?: string;
  platform?: string;
  user?: string;
  serial?: string;
  ipAddress?: string;
  agentVersion?: string;
  lastSeen?: string;
  rebootRequired?: boolean;
  missingCriticalUpdates?: number;
  missingOtherUpdates?: number;
}

const brand: Brand = window.__BRAND__ ?? {};
const brandName = brand.name ?? "";

// Apply any injected brand overrides onto the CSS custom properties.
function applyBrand(): void {
  const root = document.documentElement.style;
  if (brand.primaryColor) root.setProperty("--brand-primary", brand.primaryColor);
  if (brand.accentColor) root.setProperty("--brand-accent", brand.accentColor);
  if (brand.bg) root.setProperty("--brand-bg", brand.bg);
  if (brand.text) root.setProperty("--brand-text", brand.text);
}

const app = new App({ name: "Action1 Device Card", version: "1.0.0" });

/** Create an element with a class and (safe, text-node) children. */
function el(
  tag: string,
  className = "",
  ...children: Array<Node | string | null>
): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child == null) continue;
    node.append(child); // strings become text nodes — never parsed as HTML
  }
  return node;
}

function fmtDate(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function field(label: string, value: string | undefined): HTMLElement | null {
  if (!value) return null;
  return el(
    "div",
    "field",
    el("div", "field__label", label),
    el("div", "field__value", value),
  );
}

function badge(text: string | undefined, cls: string): HTMLElement | null {
  return text ? el("span", `badge ${cls}`, text) : null;
}

function updatesSection(d: DeviceCard): HTMLElement | null {
  const critical = d.missingCriticalUpdates;
  const other = d.missingOtherUpdates;
  if (critical == null && other == null) return null;
  const parts: string[] = [];
  if (critical != null) parts.push(`${critical} critical`);
  if (other != null) parts.push(`${other} other`);
  const row = el("div", "updates__row");
  row.append(el("span", "updates__count", parts.join(" · ")));
  row.append(" missing");
  return el("div", "updates", el("div", "updates__h", "Missing updates"), row);
}

function render(d: DeviceCard): void {
  // Brand identity only renders when a brand was injected — the neutral
  // default shows just the vendor context in the header.
  let brandId: HTMLElement | null = null;
  if (brandName || brand.logoUrl) {
    brandId = el("span", "brandid");
    if (brand.logoUrl) {
      const logo = document.createElement("img");
      logo.src = brand.logoUrl;
      logo.alt = brandName;
      logo.style.display = "inline-block";
      brandId.append(logo);
    }
    if (brandName) brandId.append(el("span", "brand", brandName));
  }

  const body = el(
    "div",
    "card__body",
    el("div", "brandrow", brandId, el("span", "context", "Action1 endpoint")),
    el("h1", "", d.name),
    el(
      "div",
      "badges",
      badge(d.status, "badge--status"),
      d.rebootRequired ? badge("Reboot required", "badge--warn") : null,
    ),
    el(
      "div",
      "grid",
      field("OS", d.os),
      field("Platform", d.platform),
      field("User", d.user),
      field("IP address", d.ipAddress),
      field("Serial", d.serial),
      field("Agent version", d.agentVersion),
      field("Last seen", d.lastSeen && fmtDate(d.lastSeen)),
    ),
    updatesSection(d),
  );

  const root = document.getElementById("root")!;
  root.replaceChildren(el("div", "card", el("div", "card__bar"), body));
}

// action1-mcp returns the endpoint JSON directly and attaches the normalized
// card to action1_get_endpoint results as _card.
function extractCard(obj: unknown): DeviceCard | null {
  const card = (obj as { _card?: DeviceCard })?._card;
  return card && typeof card.id === "string" && typeof card.name === "string" ? card : null;
}

applyBrand();

// Must be set before connect() so the initial tool-result isn't missed.
app.ontoolresult = (result: { content?: Array<{ type: string; text?: string }> }) => {
  const payload = (result.content ?? []).find((c) => c.type === "text");
  if (!payload?.text) return;
  try {
    const card = extractCard(JSON.parse(payload.text));
    if (card) render(card);
  } catch {
    /* ignore malformed payloads */
  }
};

app.connect();
