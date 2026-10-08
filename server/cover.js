import { services } from "../shared/brand-config.js";

const SKIP = /logo|icon|map|flag|diagram|portrait|cartoon|qr code|coat of arms|wrapper|package|person|people|butcher|chart|silhouette|cuts of/i;

export async function findCover(title) {
  const words = String(title || "").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3);
  if (!words.length) return "";
  const url = `${services.wikimediaApi}?action=query&generator=search&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=mime|url&iiurlwidth=960&format=json&gsrsearch=`
    + encodeURIComponent(`${words.slice(0, 4).join(" ")} food`);
  try {
    const response = await fetch(url, { headers: { "User-Agent": services.userAgent } });
    if (!response.ok) return "";
    const data = await response.json();
    const pages = Object.values(data.query?.pages || {});
    for (const page of pages) {
      const name = String(page.title || "");
      if (SKIP.test(name)) continue;
      const info = page.imageinfo?.[0];
      if (!info || !/jpeg|png|webp/i.test(info.mime || "")) continue;
      const picture = info.thumburl || info.url || "";
      if (!picture) continue;
      const hay = name.toLowerCase();
      if (words.some((word) => hay.includes(word))) return picture;
    }
  } catch {
    return "";
  }
  return "";
}

async function imageBytes(result) {
  if (!result) return null;
  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (typeof result === "object" && typeof result.image === "string") {
    const raw = result.image.replace(/^data:image\/\w+;base64,/, "");
    return Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
  }
  if (typeof result.arrayBuffer === "function") return new Uint8Array(await result.arrayBuffer());
  if (typeof result.getReader === "function") return new Uint8Array(await new Response(result).arrayBuffer());
  return null;
}

export async function paintCover(ai, title) {
  if (!ai || typeof ai.run !== "function") return null;
  const dish = String(title || "").replace(/[^\w\s'-]/g, " ").trim().slice(0, 80);
  if (dish.length < 2) return null;
  try {
    const result = await ai.run("@cf/black-forest-labs/flux-1-schnell", {
      prompt: `A realistic cookbook photograph of ${dish}, the finished plate in a pan or on a simple dish, warm kitchen light, no people, no hands, no text, no logos, no packaging`
    });
    const bytes = await imageBytes(result);
    if (!bytes || bytes.byteLength < 2000) return null;
    return bytes;
  } catch {
    return null;
  }
}
