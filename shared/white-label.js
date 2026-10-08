import { whiteLabel } from "./brand-config.js";

const HOST = /^(?:localhost|127\.0\.0\.1|(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})$/;
const HEX = /^#[0-9a-f]{6}$/i;
const FONT = /^[A-Za-z0-9 ,."'-]{1,80}$/;
const LABEL = /^[a-z0-9-]{1,40}$/;

const themeKeys = ["ink", "muted", "paper", "card", "moss", "moss2", "clay", "gold", "blush", "themeColor"];
const brandKeys = [
  "name", "shortName", "owner", "eyebrow", "description", "heroEyebrow", "heroTitle", "heroBody",
  "installReady", "installAdd", "installIos", "installReadyBody", "installHelp", "imageCredit", "audience"
];

export function normalizeHost(value) {
  return String(value || "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

export function sanitizeHost(value) {
  const host = normalizeHost(value);
  if (!host || host.includes("/") || host.includes("@") || !HOST.test(host)) return "";
  return host;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function tenantForHost(host) {
  const name = normalizeHost(host);
  const tenants = whiteLabel.tenants;
  const exact = Object.values(tenants).find((tenant) => (tenant.hosts || []).includes(name));
  if (exact) return clone(exact);
  const label = name.split(".").find(Boolean) || "";
  if (label && label !== "www" && tenants[label]) return clone(tenants[label]);
  return clone(tenants[whiteLabel.defaultTenant]);
}

export function isListedHost(host) {
  const name = normalizeHost(host);
  if (!name) return false;
  if (Object.values(whiteLabel.tenants).some((tenant) => (tenant.hosts || []).includes(name))) return true;
  const label = name.split(".").find(Boolean) || "";
  return Boolean(label && label !== "www" && whiteLabel.tenants[label]);
}

export function hexToRgba(hex, alpha) {
  const clean = sanitizeHex(hex);
  if (!clean) return "";
  const value = Number.parseInt(clean.slice(1), 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function sanitizeHex(value) {
  const color = String(value || "").trim();
  return HEX.test(color) ? color.toLowerCase() : "";
}

function plainText(value, max) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

export function sanitizeBrand(input) {
  const source = input && typeof input === "object" ? input : {};
  const brand = {};
  for (const key of brandKeys) {
    if (source[key] == null) continue;
    const text = plainText(source[key], key === "description" || key.startsWith("hero") || key.startsWith("install") ? 400 : 80);
    if (text) brand[key] = text;
  }
  return brand;
}

export function sanitizeTheme(input) {
  const source = input && typeof input === "object" ? input : {};
  const theme = {};
  for (const key of themeKeys) {
    const color = sanitizeHex(source[key]);
    if (color) theme[key] = color;
  }
  if (FONT.test(String(source.fontSerif || ""))) theme.fontSerif = String(source.fontSerif).trim();
  if (FONT.test(String(source.fontSans || ""))) theme.fontSans = String(source.fontSans).trim();
  if (theme.clay) {
    theme.line = hexToRgba(theme.clay, 0.16);
    theme.shadow = `0 18px 50px ${hexToRgba(theme.clay, 0.1)}`;
  }
  return theme;
}

export function mergeOverride(site, document) {
  const extra = typeof document === "string" ? JSON.parse(document || "{}") : (document || {});
  const next = clone(site);
  const brand = sanitizeBrand(extra.brand);
  const theme = sanitizeTheme(extra.theme);
  if (Object.keys(brand).length) next.brand = { ...next.brand, ...brand };
  if (Object.keys(theme).length) next.theme = { ...next.theme, ...theme };
  const host = sanitizeHost(extra.domain?.customDomain || "");
  const subdomain = String(extra.domain?.subdomain || "").trim().toLowerCase();
  if (host) {
    next.domain = { ...next.domain, customDomain: host, canonical: `https://${host}/` };
    if (!next.hosts.includes(host)) next.hosts.push(host);
  }
  if (LABEL.test(subdomain)) next.domain = { ...next.domain, subdomain };
  return next;
}

export async function siteForHost(host, readOverride) {
  const name = normalizeHost(host);
  if (isListedHost(name)) {
    const base = tenantForHost(name);
    return resolveSite(name, await readOverride(base.id));
  }
  for (const site of catalogSites()) {
    const document = await readOverride(site.id);
    if (hostsFromOverride(document).includes(name)) return resolveSite(site.hosts[0], document);
  }
  return tenantForHost(name);
}

export function resolveSite(host, overrideDocument = "") {
  const site = tenantForHost(host);
  if (!overrideDocument) return site;
  try {
    return mergeOverride(site, overrideDocument);
  } catch {
    return site;
  }
}

export function domainTaken(host, tenantId, sites) {
  const name = sanitizeHost(host);
  if (!name) return false;
  return sites.some((site) => site.id !== tenantId && (site.hosts || []).includes(name));
}

export function canCustomize(site, user) {
  const email = String(user?.email || "").trim().toLowerCase();
  if (!email) return false;
  if ((site.adminEmails || []).some((item) => String(item).trim().toLowerCase() === email)) return true;
  return site.setup === "members";
}

export function portalReady(site, portalId, env = {}) {
  const portal = site.payments?.portals?.[portalId];
  if (!site.payments?.enabled || !portal?.enabled) return false;
  if (portalId === "square") return Boolean(env.SQUARE_ACCESS_TOKEN && env.SQUARE_LOCATION_ID);
  if (portalId === "cashapp") return Boolean(String(portal.cashtag || "").trim() || env.CASHAPP_CASHTAG);
  return false;
}

export function publicPortals(site, env = {}) {
  if (!site.payments?.enabled) return [];
  return Object.entries(site.payments.portals || [])
    .filter(([, portal]) => portal.enabled)
    .map(([id, portal]) => ({
      id,
      label: portal.label || id,
      enabled: true,
      ready: portalReady(site, id, env),
      environment: id === "square" ? (portal.environment === "production" ? "production" : "sandbox") : undefined
    }));
}

export function publicSite(site, extras = {}) {
  return {
    id: site.id,
    brand: { ...site.brand },
    theme: { ...site.theme },
    domain: {
      canonical: site.domain.canonical,
      customDomain: site.domain.customDomain,
      subdomain: site.domain.subdomain
    },
    services: {
      mealDbHost: whiteLabel.services.mealDbHost,
      pagesProject: whiteLabel.services.pagesProject
    },
    payments: {
      enabled: Boolean(site.payments?.enabled),
      portals: publicPortals(site, extras.env || {})
    },
    location: { defaultRegion: site.locations?.defaultRegion || "home" },
    canCustomize: Boolean(extras.canCustomize)
  };
}

export function publicManifest(site) {
  const brand = site.brand;
  return {
    name: brand.name,
    short_name: brand.shortName,
    description: brand.description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    launch_handler: { client_mode: "navigate-existing" },
    shortcuts: [{
      name: "Find a plate",
      short_name: "Find",
      description: "Look up a plate in the book",
      url: "/?find="
    }],
    background_color: site.theme.paper,
    theme_color: site.theme.themeColor,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}

export function regionFor(site, point = {}) {
  const regions = site.locations?.regions || [];
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  let chosen = null;
  let source = "unset";
  if (hasPoint) {
    chosen = regions.find((region) => {
      const box = region.box;
      if (!box) return false;
      return lat >= box.south && lat <= box.north && lng >= box.west && lng <= box.east;
    }) || null;
    source = chosen ? "approximate" : "default";
  }
  if (!chosen) {
    chosen = regions.find((region) => region.id === site.locations?.defaultRegion) || regions[0] || {
      id: "home",
      label: "Home kitchen",
      cuisines: [],
      services: [],
      note: ""
    };
    if (!hasPoint) source = "unset";
  }
  return {
    id: chosen.id,
    label: chosen.label,
    cuisines: [...(chosen.cuisines || [])],
    services: [...(chosen.services || [])],
    note: chosen.note || "",
    source
  };
}

export function sessionAllowed(payload, tenantId, defaultTenantId, now = Date.now()) {
  if (!payload?.id || !payload.exp || payload.exp < now) return false;
  if (payload.tenant) return payload.tenant === tenantId;
  return tenantId === defaultTenantId;
}

export function recipeVisible(row, tenantId) {
  const stamp = String(row?.tenant_id || "");
  return !stamp || stamp === tenantId;
}

export function defaultTenantId() {
  return whiteLabel.defaultTenant;
}

export function catalogSites() {
  return Object.values(whiteLabel.tenants).map((tenant) => clone(tenant));
}

export function hostsFromOverride(document) {
  try {
    const host = sanitizeHost(JSON.parse(document || "{}").domain?.customDomain || "");
    return host ? [host] : [];
  } catch {
    return [];
  }
}
