import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { startCheckout, squareSignatureValid, cashAppSignatureValid, enabledPortal } from "../shared/payments.js";
import {
  canCustomize, mergeOverride, publicSite, recipeVisible, regionFor, resolveSite,
  sanitizeHost, sanitizeTheme, sessionAllowed, siteForHost, tenantForHost
} from "../shared/white-label.js";

test("localhost stays Lisa's book and a demo host does not", () => {
  assert.equal(tenantForHost("localhost").brand.name, "Lisa's Recipe Book");
  assert.equal(tenantForHost("lisa.synthetix-labz.cloud").id, "lisa");
  assert.equal(tenantForHost("demo.lisas-recipe-book.pages.dev").id, "demo");
  assert.equal(tenantForHost("demo.example.com").brand.name, "Demo Cookbook");
  assert.equal(tenantForHost("unknown.example.com").id, "lisa");
});

test("public site leaves out secrets and payment handles", () => {
  const site = publicSite(tenantForHost("localhost"), {
    env: { SQUARE_ACCESS_TOKEN: "sq-secret", SQUARE_LOCATION_ID: "loc", CASHAPP_CASHTAG: "LisaCooks" }
  });
  const packed = JSON.stringify(site);
  assert.equal(packed.includes("sq-secret"), false);
  assert.equal(packed.includes("cashtag"), false);
  assert.equal(packed.includes("LisaCooks"), false);
  assert.equal(packed.includes("adminEmails"), false);
  assert.equal(site.payments.portals.find((portal) => portal.id === "square").ready, true);
  assert.equal(site.payments.portals.find((portal) => portal.id === "cashapp").ready, true);
  const demo = publicSite(tenantForHost("demo.example.com"));
  assert.equal(demo.payments.portals.some((portal) => portal.id === "square"), false);
  assert.equal(demo.payments.portals.some((portal) => portal.id === "cashapp"), true);
});

test("theme and domain overrides stay plain and cannot collide", () => {
  const lisa = tenantForHost("localhost");
  const themed = mergeOverride(lisa, {
    brand: { name: "Evening Kitchen", eyebrow: "For the night cook" },
    theme: { moss: "#112233", clay: "red; background:url(https://evil)", fontSerif: "Fraunces" },
    domain: { customDomain: "https://evil.example/steal", subdomain: "Evening Kitchen" }
  });
  assert.equal(themed.brand.name, "Evening Kitchen");
  assert.equal(themed.theme.moss, "#112233");
  assert.equal(themed.theme.clay, lisa.theme.clay);
  assert.equal(themed.domain.customDomain, "lisa.synthetix-labz.cloud");
  const hosted = mergeOverride(lisa, { domain: { customDomain: "kitchen.example.com", subdomain: "kitchen" } });
  assert.equal(hosted.domain.canonical, "https://kitchen.example.com/");
  assert.equal(hosted.domain.subdomain, "kitchen");
  assert.equal(sanitizeHost("kitchen.example.com"), "kitchen.example.com");
  assert.equal(sanitizeHost("javascript:alert(1)"), "");
  assert.deepEqual(sanitizeTheme({ moss: "#aabbcc", paper: "expression(alert(1))" }), { moss: "#aabbcc" });
});

test("a saved custom domain resolves to that book", async () => {
  const saved = { demo: JSON.stringify({ domain: { customDomain: "suppers.example.com" } }) };
  const site = await siteForHost("suppers.example.com", async (id) => saved[id] || "");
  assert.equal(site.id, "demo");
  assert.equal(site.domain.customDomain, "suppers.example.com");
  assert.equal((await siteForHost("localhost", async () => "")).id, "lisa");
});

test("location picks a region and does not echo the pin", () => {
  const lisa = tenantForHost("localhost");
  const gulf = regionFor(lisa, { lat: 29.76, lng: -95.37 });
  assert.equal(gulf.id, "gulf");
  assert.equal(gulf.source, "approximate");
  assert.deepEqual(gulf.cuisines, ["cajun", "texas", "texmex"]);
  assert.equal(JSON.stringify(gulf).includes("29.76"), false);
  const trail = regionFor(lisa, { lat: 47.6, lng: -122.3 });
  assert.equal(trail.id, "trail");
  assert.equal(trail.services.includes("studio"), false);
  assert.equal(trail.services.includes("book"), true);
  const home = regionFor(lisa, {});
  assert.equal(home.id, "home");
  assert.equal(home.source, "unset");
});

test("sessions stay inside the book that issued them", () => {
  const now = 1_000;
  assert.equal(sessionAllowed({ id: 4, tenant: "lisa", exp: 5_000 }, "lisa", "lisa", now), true);
  assert.equal(sessionAllowed({ id: 4, tenant: "lisa", exp: 5_000 }, "demo", "lisa", now), false);
  assert.equal(sessionAllowed({ id: 4, exp: 5_000 }, "lisa", "lisa", now), true);
  assert.equal(sessionAllowed({ id: 4, exp: 5_000 }, "demo", "lisa", now), false);
  assert.equal(sessionAllowed({ id: 4, tenant: "lisa", exp: 500 }, "lisa", "lisa", now), false);
});

test("only the book's own plates and members can be styled", () => {
  assert.equal(recipeVisible({ tenant_id: "" }, "demo"), true);
  assert.equal(recipeVisible({ tenant_id: "lisa" }, "demo"), false);
  assert.equal(recipeVisible({ tenant_id: "demo" }, "demo"), true);
  const demo = tenantForHost("demo.example.com");
  assert.equal(canCustomize(demo, { email: "cook@example.com" }), true);
  assert.equal(canCustomize(tenantForHost("localhost"), { email: "cook@example.com" }), false);
  assert.equal(canCustomize(mergeOverride(tenantForHost("localhost"), {}), null), false);
});

test("payment desks can be toggled and never invent a charge", async () => {
  const lisa = tenantForHost("localhost");
  assert.throws(() => enabledPortal(lisa, "missing"), /turned off/);
  assert.throws(() => enabledPortal(tenantForHost("demo.example.com"), "square"), /turned off/);
  await assert.rejects(
    startCheckout({
      site: lisa,
      portal: "square",
      amountCents: 2500,
      note: "Kitchen fund",
      user: { id: 7 },
      env: {},
      save() {}
    }),
    /no Square credentials/
  );
  let stored = null;
  const order = await startCheckout({
    site: mergeOverride(lisa, {}),
    portal: "cashapp",
    amountCents: 1250,
    note: "Sunday plates",
    user: { id: 7 },
    env: { CASHAPP_CASHTAG: "SundayTable" },
    save(row) { stored = row; }
  });
  assert.equal(order.checkoutUrl, "https://cash.app/$SundayTable/12.50");
  assert.equal(order.status, "link");
  assert.equal(stored.tenantId, "lisa");
  assert.equal(JSON.stringify(order).includes("SundayTable") , true);
  await assert.rejects(
    startCheckout({
      site: lisa,
      portal: "square",
      amountCents: 50,
      user: { id: 7 },
      env: { SQUARE_ACCESS_TOKEN: "token", SQUARE_LOCATION_ID: "loc" },
      save() {}
    }),
    /\$1 to \$500/
  );
  let called = null;
  const paid = await startCheckout({
    site: lisa,
    portal: "square",
    amountCents: 1800,
    note: "Brisket fund",
    user: { id: 7 },
    env: { SQUARE_ACCESS_TOKEN: "token", SQUARE_LOCATION_ID: "LOC1" },
    fetcher: async (url, options) => {
      called = { url, options };
      return {
        ok: true,
        json: async () => ({ payment_link: { url: "https://square.example/pay", order_id: "sq-order" } })
      };
    },
    save(row) { stored = row; }
  });
  assert.match(called.url, /^https:\/\/connect\.squareupsandbox\.com\//);
  assert.equal(called.options.headers.Authorization, "Bearer token");
  assert.equal(JSON.parse(called.options.body).order.location_id, "LOC1");
  assert.equal(paid.checkoutUrl, "https://square.example/pay");
  assert.equal(stored.externalId, "sq-order");
  assert.equal(JSON.stringify(paid).includes("token"), false);
});

test("webhook signatures fail closed", async () => {
  const url = "https://lisa.synthetix-labz.cloud/api/payments/webhook/square";
  const body = JSON.stringify({ data: { object: { payment: { order_id: "sq-order", status: "COMPLETED" } } } });
  const signature = crypto.createHmac("sha256", "whsec").update(url + body).digest("base64");
  assert.equal(await squareSignatureValid({ key: "whsec", url, body, signature }), true);
  assert.equal(await squareSignatureValid({ key: "", url, body, signature }), false);
  assert.equal(await squareSignatureValid({ key: "whsec", url, body, signature: `${signature}x` }), false);
  const cash = crypto.createHmac("sha256", "cash").update(body).digest("hex");
  assert.equal(await cashAppSignatureValid({ key: "cash", body, signature: cash }), true);
  assert.equal(await cashAppSignatureValid({ key: "", body, signature: cash }), false);
});

test("the published config matches the default book", () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../public/config.js", import.meta.url), "utf8"), sandbox);
  const site = publicSite(tenantForHost("localhost"));
  assert.equal(sandbox.window.APP_CONFIG.apiBase, "");
  assert.equal(sandbox.window.APP_CONFIG.site.brand.name, site.brand.name);
  assert.equal(sandbox.window.APP_CONFIG.site.domain.canonical, site.domain.canonical);
  assert.equal(sandbox.window.APP_CONFIG.site.theme.moss, site.theme.moss);
});

test("a styled override still resolves on the original host", () => {
  const site = resolveSite("localhost", JSON.stringify({
    brand: { name: "Miller Evening Book" },
    theme: { paper: "#fff8ee" }
  }));
  assert.equal(site.id, "lisa");
  assert.equal(site.brand.name, "Miller Evening Book");
  assert.equal(site.theme.paper, "#fff8ee");
  assert.equal(site.brand.owner, "Lisa Miller");
});
