import { services } from "../../shared/brand-config.js";

function fail(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function blockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => part >= 0 && part <= 255)) {
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  return false;
}

export function publicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw fail("That link is not a web address.", 400);
  }
  if (!["http:", "https:"].includes(url.protocol) || blockedHost(url.hostname)) {
    throw fail("That link stays outside the book.", 400);
  }
  return url;
}

function textFrom(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

export async function browse(raw) {
  let current = publicUrl(raw);
  let response;
  for (let hop = 0; hop < 4; hop += 1) {
    response = await fetch(current, {
      redirect: "manual",
      headers: {
        "User-Agent": services.userAgent,
        Accept: "text/html,application/xhtml+xml"
      }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw fail("The page redirected nowhere.", 502);
      current = publicUrl(new URL(location, current).href);
      continue;
    }
    break;
  }
  if (!response?.ok) throw fail("That page could not be opened.", 502);
  const type = response.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml/i.test(type)) throw fail("That link is not a page the book can show.", 415);
  const html = await response.text();
  if (html.length > 2_000_000) throw fail("That page is too large to open inside the book.", 413);
  const title = textFrom((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "Page")).slice(0, 160) || "Page";
  const article = html.match(/<article[\s\S]*?<\/article>/i)?.[0]
    || html.match(/<main[\s\S]*?<\/main>/i)?.[0]
    || html;
  const text = textFrom(article).slice(0, 20000);
  const page = text
    ? text.split(/\n{2,}/).map((paragraph) => `<p>${escapeHtml(paragraph.trim())}</p>`).join("")
    : "<p>This page had no readable text.</p>";
  return { url: current.href, title, html: page };
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)));
}

function metaContent(html, property) {
  const name = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forward = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i");
  const reverse = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, "i");
  return decodeEntities(html.match(forward)?.[1] || html.match(reverse)?.[1] || "");
}

async function followPublic(start, headers) {
  let current = start;
  let response;
  for (let hop = 0; hop < 5; hop += 1) {
    response = await fetch(current.href, { redirect: "manual", headers });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, current };
    const location = response.headers.get("location");
    if (!location) return { response, current };
    current = publicUrl(new URL(location, current).href);
  }
  throw fail("That link kept redirecting.", 502);
}

async function watchTikTok(start) {
  const { current } = await followPublic(start, { "User-Agent": "Mozilla/5.0", Accept: "text/html" });
  const oembed = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(current.href)}`, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }
  });
  if (!oembed.ok) throw fail("TikTok did not share that video. It may be private.", 502);
  const data = await oembed.json();
  const html = String(data.html || "");
  const videoId = html.match(/data-video-id="(\d+)"/)?.[1] || current.pathname.match(/\/video\/(\d+)/)?.[1] || "";
  if (!videoId) throw fail("That TikTok link did not include a video.", 404);
  return {
    provider: "tiktok",
    videoId,
    url: html.match(/cite="([^"]+)"/)?.[1] || current.href,
    title: String(data.title || "").slice(0, 180),
    author: String(data.author_name || "").slice(0, 80),
    thumbnail: String(data.thumbnail_url || "")
  };
}

async function watchFacebook(start) {
  let response;
  let current;
  try {
    ({ response, current } = await followPublic(start, {
      "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      Accept: "text/html"
    }));
  if (!response?.ok) throw fail("Facebook did not open that link. It may be private.", 502);
  const html = (await response.text()).slice(0, 400000);
  const canonical = metaContent(html, "og:url") || current.href.split("?")[0];
  let page = current;
  try { page = publicUrl(canonical); } catch { /* keep the opened address */ }
  const videoHref = html.match(/https:\/\/www\.facebook\.com\/[^"'\\\s]+\/videos\/\d+/)?.[0] || page.href;
  const plugin = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(videoHref)}&show_text=false&width=500`;
  const pluginPage = await fetch(plugin, { headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" } });
  const pluginHtml = pluginPage.ok ? (await pluginPage.text()).slice(0, 80000) : "";
  const blocked = /can(?:'|&#0*39;)t be embedded|content owned by someone else/i.test(pluginHtml);
  const clip = {
    provider: "facebook",
    url: page.href,
    title: metaContent(html, "og:title").slice(0, 180),
    thumbnail: metaContent(html, "og:image")
  };
  if (blocked || !pluginPage.ok) {
    return {
      ...clip,
      embeddable: false,
      reason: "Facebook will not play this video inside the book. It uses music or pictures that belong to someone else. Open it on Facebook to watch it."
    };
  }
  return { ...clip, embeddable: true, frame: plugin };
  } catch (error) {
    if (error.status) throw error;
    throw fail("Facebook did not open that link. It may be private.", 502);
  }
}

export async function watchClip(raw) {
  const start = publicUrl(raw);
  const host = start.hostname.replace(/^www\./, "");
  if (host.endsWith("tiktok.com")) return watchTikTok(start);
  if (host.endsWith("facebook.com") || host === "fb.watch") return watchFacebook(start);
  throw fail("That link is not a video the book can play.", 400);
}
