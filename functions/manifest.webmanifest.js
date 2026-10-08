import { publicManifest, siteForHost } from "../shared/white-label.js";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  let site = await siteForHost(url.hostname, async () => "");
  try {
    site = await siteForHost(url.hostname, async (id) => {
      const row = await context.env.DB.prepare("SELECT document FROM tenant_overrides WHERE tenant_id = ?").bind(id).first();
      return row?.document || "";
    });
  } catch { /* the file configuration still answers */ }
  return Response.json(publicManifest(site), {
    headers: {
      "content-type": "application/manifest+json",
      "cache-control": "no-store"
    }
  });
}
