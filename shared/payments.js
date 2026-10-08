import { portalReady } from "./white-label.js";

const CASHTAG = /^[A-Za-z][A-Za-z0-9_]{0,19}$/;

export function assertAmount(value) {
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount < 100 || amount > 50000) {
    const error = new Error("Choose an amount from $1 to $500.");
    error.status = 400;
    throw error;
  }
  return amount;
}

export function cleanNote(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
}

export function enabledPortal(site, portalId) {
  const portal = site.payments?.portals?.[portalId];
  if (!site.payments?.enabled || !portal?.enabled) {
    const error = new Error("That payment desk is turned off for this book.");
    error.status = 404;
    throw error;
  }
  return { id: portalId, ...portal };
}

export function cashAppUrl(cashtag, amountCents) {
  const tag = String(cashtag || "").replace(/^\$/, "");
  if (!CASHTAG.test(tag)) {
    const error = new Error("Cash App is turned on, but this book has no $cashtag yet.");
    error.status = 503;
    throw error;
  }
  const dollars = (amountCents / 100).toFixed(2);
  return `https://cash.app/$${tag}/${dollars}`;
}

export function publicOrder(order) {
  return {
    id: order.id,
    portal: order.portal,
    amountCents: order.amountCents,
    currency: order.currency,
    note: order.note,
    status: order.status,
    checkoutUrl: order.checkoutUrl,
    createdAt: order.createdAt
  };
}

async function hmacBytes(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameText(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export async function squareSignatureValid({ key, url, body, signature }) {
  if (!key || !signature || !url) return false;
  const digest = bytesToBase64(await hmacBytes(key, `${url}${body}`));
  return sameText(digest, signature);
}

export async function cashAppSignatureValid({ key, body, signature }) {
  if (!key || !signature) return false;
  const digest = bytesToHex(await hmacBytes(key, body));
  return sameText(digest, String(signature).trim().toLowerCase());
}

export function squareEvent(payload) {
  const payment = payload?.data?.object?.payment || {};
  const status = payment.status === "COMPLETED" ? "paid" : (payment.status === "CANCELED" || payment.status === "FAILED" ? "canceled" : "");
  return { externalId: payment.order_id || payload?.data?.id || "", status };
}

export function cashAppEvent(payload) {
  const status = payload?.status === "paid" || payload?.status === "canceled" ? payload.status : "";
  return { orderId: String(payload?.orderId || ""), status };
}

export async function startCheckout({ site, portal, amountCents, note, user, env = {}, save, fetcher = fetch }) {
  const choice = enabledPortal(site, portal);
  const amount = assertAmount(amountCents);
  const label = cleanNote(note) || `Kitchen fund for ${site.brand.name}`;
  const order = {
    id: `ord_${crypto.randomUUID()}`,
    tenantId: site.id,
    userId: user.id,
    portal: choice.id,
    amountCents: amount,
    currency: "USD",
    note: label,
    status: "pending",
    externalId: "",
    checkoutUrl: "",
    createdAt: new Date().toISOString()
  };
  if (choice.id === "square") {
    if (!portalReady(site, "square", env)) {
      const error = new Error("Square is turned on, but this book has no Square credentials yet.");
      error.status = 503;
      throw error;
    }
    const host = choice.environment === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
    const response = await fetcher(`${host}/v2/online-checkout/payment-links`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "Square-Version": "2025-01-23"
      },
      body: JSON.stringify({
        idempotency_key: order.id,
        description: label,
        payment_note: order.id,
        order: {
          location_id: env.SQUARE_LOCATION_ID,
          reference_id: order.id,
          line_items: [{
            name: label,
            quantity: "1",
            base_price_money: { amount, currency: "USD" }
          }]
        },
        checkout_options: { redirect_url: `${site.domain.canonical}#/support` }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.payment_link?.url) {
      const error = new Error("Square could not open a checkout.");
      error.status = 502;
      throw error;
    }
    order.checkoutUrl = data.payment_link.long_url || data.payment_link.url;
    order.externalId = data.payment_link.order_id || data.payment_link.id || "";
  } else if (choice.id === "cashapp") {
    const cashtag = choice.cashtag || env.CASHAPP_CASHTAG || "";
    order.checkoutUrl = cashAppUrl(cashtag, amount);
    order.status = "link";
  } else {
    const error = new Error("That payment desk is not available.");
    error.status = 404;
    throw error;
  }
  await save(order);
  return publicOrder(order);
}
