/**
 * Device-card payload builder for the MCP Apps (SEP-1865) UI surface.
 *
 * action1_get_endpoint results get a normalized `_card` object attached
 * (see domains/endpoints.ts) that the ui:// device card renders from. The
 * card is progressive enhancement: normalization is best-effort, and a null
 * return simply means the host renders no card while the JSON payload is
 * unchanged.
 *
 * action1-mcp v1 is read-only, so the card is read-only too — no write
 * round-trip action.
 */

export const DEVICE_CARD_RESOURCE_URI = "ui://action1/device-card.html";

/** MCP Apps resource MIME (RESOURCE_MIME_TYPE in @modelcontextprotocol/ext-apps). */
export const MCP_APP_RESOURCE_MIME = "text/html;profile=mcp-app";

/**
 * Tool `_meta` advertising the card. Carries both the canonical flat key
 * (RESOURCE_URI_META_KEY in ext-apps) and the nested form ext-apps'
 * registerAppTool emits, so any MCP Apps host revision finds it.
 */
export const DEVICE_CARD_META = {
  "ui/resourceUri": DEVICE_CARD_RESOURCE_URI,
  ui: { resourceUri: DEVICE_CARD_RESOURCE_URI },
} as const;

/** Mirror of Brand in ui/device-card.ts — keep in sync. */
export interface CardBrand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}

/** The BRAND_INJECT comment marker baked into the card HTML (see ui/index.html). */
const BRAND_INJECT_RE = /<!--\s*BRAND_INJECT:[\s\S]*?-->/;

/**
 * Serve-time brand injection: replace the BRAND_INJECT marker with an inline
 * `window.__BRAND__` script so self-hosters can theme the card without
 * rebuilding the bundle. An empty brand returns the HTML unchanged (the card
 * renders its neutral defaults). `<` is escaped so brand values can never
 * break out of the script tag.
 */
export function applyBrandInjection(html: string, brand: CardBrand): string {
  if (!brand || Object.values(brand).every((v) => !v)) return html;
  const json = JSON.stringify(brand).replace(/</g, "\\u003c");
  return html.replace(BRAND_INJECT_RE, `<script>window.__BRAND__=${json}</script>`);
}

/**
 * Resolve brand overrides from MCP_BRAND_* environment variables. Guarded for
 * runtimes without `process` (Cloudflare Workers), where this returns an empty
 * brand and the card serves its neutral defaults.
 */
export function resolveBrandFromEnv(): CardBrand {
  if (typeof process === "undefined" || !process.env) return {};
  const env = process.env;
  const brand: CardBrand = {};
  if (env.MCP_BRAND_NAME) brand.name = env.MCP_BRAND_NAME;
  if (env.MCP_BRAND_LOGO_URL) brand.logoUrl = env.MCP_BRAND_LOGO_URL;
  if (env.MCP_BRAND_PRIMARY_COLOR) brand.primaryColor = env.MCP_BRAND_PRIMARY_COLOR;
  if (env.MCP_BRAND_ACCENT_COLOR) brand.accentColor = env.MCP_BRAND_ACCENT_COLOR;
  if (env.MCP_BRAND_BG) brand.bg = env.MCP_BRAND_BG;
  if (env.MCP_BRAND_TEXT) brand.text = env.MCP_BRAND_TEXT;
  return brand;
}

/** Mirror of DeviceCard in ui/device-card.ts — keep in sync. */
export interface DeviceCard {
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

/** Non-empty string or undefined. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Finite number or undefined (Action1 counters). */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Action1 boolean-ish flags come as booleans or "yes"/"no" strings. */
function flag(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "yes" || s === "true") return true;
    if (s === "no" || s === "false") return false;
  }
  return undefined;
}

/**
 * Normalize an Action1 endpoint record into the flat payload the ui:// device
 * card renders from. Action1 returns resolved strings (no id→label lookups
 * needed); normalization here is field selection plus tolerance for the
 * vendor's naming variants. Requires an id and a display name — anything
 * less is not a device record and yields no card.
 */
export function buildDeviceCard(endpoint: Record<string, unknown>): DeviceCard | null {
  const id = str(endpoint?.id);
  const name = str(endpoint?.name) ?? str(endpoint?.device_name) ?? str(endpoint?.hostname);
  if (!id || !name) return null;

  const card: DeviceCard = { id, name };

  const status = str(endpoint.status) ?? str(endpoint.online_status);
  if (status) card.status = status;

  const os = str(endpoint.OS) ?? str(endpoint.os);
  const osVersion = str(endpoint.OS_version) ?? str(endpoint.os_version);
  if (os) card.os = osVersion ? `${os} (${osVersion})` : os;
  else if (osVersion) card.os = osVersion;

  const platform = str(endpoint.platform);
  if (platform) card.platform = platform;

  const user = str(endpoint.user);
  if (user) card.user = user;

  const serial = str(endpoint.serial);
  if (serial) card.serial = serial;

  const ipAddress = str(endpoint.address) ?? str(endpoint.ip_address);
  if (ipAddress) card.ipAddress = ipAddress;

  const agentVersion = str(endpoint.agent_version);
  if (agentVersion) card.agentVersion = agentVersion;

  const lastSeen = str(endpoint.last_seen);
  if (lastSeen) card.lastSeen = lastSeen;

  const rebootRequired = flag(endpoint.reboot_required);
  if (rebootRequired !== undefined) card.rebootRequired = rebootRequired;

  const critical = num(endpoint.missing_critical_updates);
  if (critical !== undefined) card.missingCriticalUpdates = critical;
  const other = num(endpoint.missing_other_updates);
  if (other !== undefined) card.missingOtherUpdates = other;

  return card;
}
