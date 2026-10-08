import { lookup } from "node:dns/promises";
import net from "node:net";
import * as cheerio from "cheerio";
import { services } from "../shared/brand-config.js";

function blockedIp(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (net.isIP(ip) === 6) {
    const n = ip.toLowerCase();
    if (n === "::1" || n.startsWith("fc") || n.startsWith("fd") || n.startsWith("fe80")) return true;
  }
  return false;
}

export async function publicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("That link is not a web address."), { status: 400 });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw Object.assign(new Error("Only ordinary web pages open inside the book."), { status: 400 });
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw Object.assign(new Error("That link stays outside the book."), { status: 400 });
  }
  const records = await lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some((record) => blockedIp(record.address))) {
    throw Object.assign(new Error("That link cannot be opened inside the book."), { status: 400 });
  }
  return url;
}

function sanitize(html, pageUrl) {
  const $ = cheerio.load(html);
  $("script,noscript,iframe,object,embed,form,link,meta,style,svg,canvas").remove();
  const title = $("title").first().text().replace(/\s+/g, " ").trim().slice(0, 160) || "Page";
  let root = $("#mw-content-text").first();
  if (!root.length) root = $("article").first();
  if (!root.length) root = $("main").first();
  if (!root.length) root = $("body").first();
  root.find(".navbox,.mw-editsection,.reflist,.reference,.infobox,#toc,.shortdescription,.mw-empty-elt").remove();

  root.find("*").each((_, el) => {
    const node = $(el);
    for (const name of Object.keys(el.attribs || {})) {
      if (name.startsWith("on") || name === "style" || name === "srcset") node.removeAttr(name);
    }
    if (el.tagName === "a") {
      const href = node.attr("href") || "";
      try {
        const abs = new URL(href, pageUrl);
        if (!["http:", "https:"].includes(abs.protocol)) node.attr("href", "#");
        else node.attr("href", abs.href);
      } catch {
        node.attr("href", "#");
      }
      node.removeAttr("target");
    }
    if (el.tagName === "img") {
      const src = node.attr("src") || "";
      try {
        const abs = new URL(src, pageUrl);
        if (!["http:", "https:"].includes(abs.protocol)) node.remove();
        else node.attr("src", abs.href);
      } catch {
        node.remove();
      }
    }
  });

  return { title, html: (root.html() || "<p>This page had no readable text.</p>").slice(0, 350000) };
}

export async function browse(raw) {
  let current = await publicUrl(raw);
  let response;
  for (let hop = 0; hop < 4; hop += 1) {
    response = await fetch(current, {
      redirect: "manual",
      headers: {
        "User-Agent": services.userAgent,
        Accept: "text/html,application/xhtml+xml"
      },
      signal: AbortSignal.timeout(12000)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw Object.assign(new Error("The page redirected nowhere."), { status: 502 });
      current = await publicUrl(new URL(location, current).href);
      continue;
    }
    break;
  }
  if (!response?.ok) throw Object.assign(new Error("That page could not be opened."), { status: 502 });
  const type = response.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml/i.test(type)) {
    throw Object.assign(new Error("That link is not a page the book can show."), { status: 415 });
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 2_000_000) {
    throw Object.assign(new Error("That page is too large to open inside the book."), { status: 413 });
  }
  return { url: current.href, ...sanitize(bytes.toString("utf8"), current.href) };
}

function fail(message, status) {
  return Object.assign(new Error(message), { status });
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
    response = await fetch(current.href, { redirect: "manual", headers, signal: AbortSignal.timeout(12000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, current };
    const location = response.headers.get("location");
    if (!location) return { response, current };
    current = await publicUrl(new URL(location, current).href);
  }
  throw fail("That link kept redirecting.", 502);
}

async function watchTikTok(start) {
  const { current } = await followPublic(start, { "User-Agent": "Mozilla/5.0", Accept: "text/html" });
  const oembed = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(current.href)}`, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    signal: AbortSignal.timeout(12000)
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
  try { page = await publicUrl(canonical); } catch { /* keep the opened address */ }
  const videoHref = html.match(/https:\/\/www\.facebook\.com\/[^"'\\\s]+\/videos\/\d+/)?.[0] || page.href;
  const plugin = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(videoHref)}&show_text=false&width=500`;
  const pluginPage = await fetch(plugin, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
    signal: AbortSignal.timeout(12000)
  });
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
  const start = await publicUrl(raw);
  const host = start.hostname.replace(/^www\./, "");
  if (host.endsWith("tiktok.com")) return watchTikTok(start);
  if (host.endsWith("facebook.com") || host === "fb.watch") return watchFacebook(start);
  throw fail("That link is not a video the book can play.", 400);
}
