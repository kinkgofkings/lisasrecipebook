import { worldCatalog, worldRecipe } from "../../server/world.js";
import { findCover, paintCover } from "../../server/cover.js";
import { browse, watchClip } from "./browse.js";
import {
  addSignal, askHost, d1Desk, deskSnapshot, ensureDesk, getCall, listSignals, listThreads,
  placeCall, readThread, scopeDesk, searchBook, sendMessage, setCall
} from "../../server/desk.js";
import {
  canCustomize, catalogSites, defaultTenantId, domainTaken, publicSite, recipeVisible,
  regionFor, resolveSite, sanitizeBrand, sanitizeHost, sanitizeTheme, sessionAllowed, siteForHost, tenantForHost
} from "../../shared/white-label.js";
import { cashAppEvent, cashAppSignatureValid, publicOrder, squareEvent, squareSignatureValid, startCheckout } from "../../shared/payments.js";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", "cdn-cache-control": "no-store" }
  });
}

function lines(value) {
  return String(value || "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function cuisineOf(value) {
  if (["cajun", "library", "texmex", "garden", "kids", "pets", "gym"].includes(value)) return value;
  return "texas";
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    bio: row.bio,
    avatar: row.avatar_path
  };
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return new Uint8Array(signature);
}

function sameBytes(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

async function signToken(env, userId) {
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    id: userId,
    tenant: env.SITE?.id || "",
    exp: Date.now() + 1000 * 60 * 60 * 24 * 30
  })));
  const signature = bytesToBase64Url(await hmac(env.AUTH_SECRET, body));
  return `${body}.${signature}`;
}

async function readToken(env, header = "") {
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !token.includes(".") || !env.AUTH_SECRET) return null;
  const [body, signature] = token.split(".");
  const expected = bytesToBase64Url(await hmac(env.AUTH_SECRET, body));
  if (!sameBytes(new TextEncoder().encode(signature), new TextEncoder().encode(expected))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body)));
    if (!payload?.id || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function hashPassword(env, password) {
  const digest = bytesToBase64Url(await hmac(env.AUTH_SECRET, `lisa-password:${password}`));
  return `hmac1:${digest}`;
}

async function checkPassword(env, password, stored) {
  if (stored.startsWith("hmac1:")) {
    const next = await hashPassword(env, password);
    return sameBytes(new TextEncoder().encode(next), new TextEncoder().encode(stored));
  }
  if (stored.startsWith("$2")) {
    const bcrypt = await import("bcryptjs");
    return bcrypt.compare(password, stored);
  }
  return false;
}

async function userFrom(env, request) {
  const payload = await readToken(env, request.headers.get("authorization") || "");
  const site = env.SITE;
  if (!payload || !site || !sessionAllowed(payload, site.id, defaultTenantId())) return null;
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(payload.id).first();
  if (!user) return null;
  if ((user.tenant_id || defaultTenantId()) !== site.id) return null;
  return user;
}

async function recipeRow(env, row) {
  if (!row) return null;
  const media = await env.DB.prepare(
    "SELECT id, kind, path, caption FROM recipe_media WHERE recipe_id = ? ORDER BY id"
  ).bind(row.id).all();
  return {
    id: row.id,
    title: row.title,
    cuisine: row.cuisine,
    category: row.category,
    summary: row.summary,
    yieldText: row.yield_text,
    prepMinutes: row.prep_minutes,
    cookMinutes: row.cook_minutes,
    ingredients: JSON.parse(row.ingredients),
    steps: JSON.parse(row.steps),
    notes: row.notes,
    image: row.image,
    imageCredit: row.image_credit,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    youtube: row.youtube || "",
    family: Boolean(row.family),
    authorId: row.author_id || null,
    updatedAt: row.updated_at,
    media: media.results || []
  };
}

async function savedRecipe(env, user, id, status = 200) {
  const recipe = await recipeRow(env, await env.DB.prepare("SELECT * FROM recipes WHERE id = ?").bind(id).first());
  const [decorated] = await decorateRecipes(env, user, [recipe]);
  return json({ recipe: decorated }, status);
}

async function slugify(env, title) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "recipe";
  let id = base;
  let n = 2;
  while (await env.DB.prepare("SELECT 1 AS found FROM recipes WHERE id = ?").bind(id).first()) id = `${base}-${n++}`;
  return id;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function storePicture(request, env, field) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return { error: json({ error: "That picture could not be read." }, 400) };
  }
  const file = form.get(field);
  if (!file || typeof file === "string") return { error: json({ error: "Choose a picture first." }, 400) };
  const type = file.type || "";
  if (!String(type).startsWith("image/")) {
    return { error: json({ error: "Use a picture." }, 400) };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.byteLength) return { error: json({ error: "That picture was empty." }, 400) };
  const path = await storeChunked(env, type, bytes, file.name);
  return { path, form };
}

async function removeStored(env, path) {
  if (!path?.startsWith("/uploads/")) return;
  await env.DB.prepare("DELETE FROM file_parts WHERE path = ?").bind(path).run();
  await env.DB.prepare("DELETE FROM files WHERE path = ?").bind(path).run();
}

async function uploadAvatar(request, env) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const saved = await storePicture(request, env, "avatar");
  if (saved.error) return saved.error;
  await removeStored(env, user.avatar_path);
  await env.DB.prepare("UPDATE users SET avatar_path = ? WHERE id = ?").bind(saved.path, user.id).run();
  const next = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
  return json({ user: publicUser(next) });
}

async function uploadMedia(request, env, recipeId, url) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const recipe = await env.DB.prepare("SELECT * FROM recipes WHERE id = ?").bind(recipeId).first();
  if (!recipe) return json({ error: "That recipe is not in the book." }, 404);
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await readJson(request);
    const path = String(body.path || "");
    if (!/^\/uploads\/[\w.-]+$/.test(path)) return json({ error: "That file could not be saved." }, 400);
    const row = await env.DB.prepare("SELECT mime FROM files WHERE path = ?").bind(path).first();
    if (!row) return json({ error: "That file could not be saved." }, 400);
    const kind = String(row.mime).startsWith("video/") ? "video" : "image";
    if (url.searchParams.get("role") === "cover" && kind === "image") {
      await removeStored(env, recipe.image);
      await env.DB.prepare("UPDATE recipes SET image = ?, image_credit = ?, updated_at = ? WHERE id = ?")
        .bind(path, "Added by Lisa", new Date().toISOString(), recipe.id).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO recipe_media (recipe_id, kind, path, caption, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(recipe.id, kind, path, "", new Date().toISOString()).run();
    }
    return savedRecipe(env, user, recipe.id, 201);
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "That file could not be read." }, 400);
  }
  const file = form.get("file");
  if (!file || typeof file === "string" || !file.size) return json({ error: "Choose a file first." }, 400);
  const saved = await storeUpload(env, file);
  if (saved.error) return saved.error;
  const kind = saved.meta.kind === "video" ? "video" : "image";
  if (url.searchParams.get("role") === "cover" && kind === "image") {
    await removeStored(env, recipe.image);
    await env.DB.prepare("UPDATE recipes SET image = ?, image_credit = ?, updated_at = ? WHERE id = ?")
      .bind(saved.meta.path, "Added by Lisa", new Date().toISOString(), recipe.id).run();
  } else {
    const caption = String(form.get("caption") || "").slice(0, 160);
    await env.DB.prepare(
      "INSERT INTO recipe_media (recipe_id, kind, path, caption, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(recipe.id, kind, saved.meta.path, caption, new Date().toISOString()).run();
  }
  return savedRecipe(env, user, recipe.id, 201);
}

let bookReady = null;
function prepareBook(env) {
  if (!bookReady) {
    bookReady = Promise.all([
      env.DB.prepare("ALTER TABLE comments ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'").run().catch(() => {}),
      env.DB.prepare("ALTER TABLE users ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'lisa'").run().catch(() => {}),
      env.DB.prepare("ALTER TABLE recipes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT ''").run().catch(() => {}),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        portal TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        external_id TEXT NOT NULL DEFAULT '',
        checkout_url TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      )`).run(),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS tenant_overrides (
        tenant_id TEXT PRIMARY KEY,
        document TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`).run()
    ]);
  }
  return bookReady;
}

function liveDb(env) {
  try {
    if (typeof env.DB?.withSession === "function") return env.DB.withSession("first-primary");
  } catch { /* the plain binding still reads and writes */ }
  return env.DB;
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") return json({ error: "That page is not in the book." }, 404);
  const bag = { site: tenantForHost(url.hostname) };
  let session = null;
  const bound = new Proxy(env, {
    get(target, prop, receiver) {
      if (prop === "DB") {
        if (!session) session = liveDb(target);
        return session;
      }
      if (prop === "SITE") return bag.site;
      return Reflect.get(target, prop, receiver);
    }
  });
  try {
    await prepareBook(bound);
    bag.site = await siteForHost(url.hostname, async (id) => {
      const row = await bound.DB.prepare("SELECT document FROM tenant_overrides WHERE tenant_id = ?").bind(id).first();
      return row?.document || "";
    });
    return await route(request, bound, url, parts.slice(1));
  } catch (error) {
    const status = error.status || 500;
    return json({
      error: status === 500 ? "The book hit a snag. Please try again." : error.message
    }, status);
  }
}

async function route(request, env, url, parts) {
  const method = request.method;
  const [first, second, third, fourth] = parts;

  if (method === "GET" && first === "health") return json({ ok: true, name: env.SITE.brand.name, tenant: env.SITE.id });
  if (first === "site" && !second && method === "GET") return siteView(request, env);
  if (first === "site" && !second && method === "PATCH") return siteUpdate(request, env);
  if (first === "location" && second === "menu" && method === "GET") return json({ menu: regionFor(env.SITE, { lat: url.searchParams.get("lat"), lng: url.searchParams.get("lng") }) });
  if (first === "payments" && second === "portals" && method === "GET") return json({ payments: publicSite(env.SITE, { env }).payments });
  if (first === "payments" && second === "orders" && method === "GET") return paymentOrders(request, env);
  if (first === "payments" && second === "checkout" && method === "POST") return paymentCheckout(request, env);
  if (first === "payments" && second === "webhook" && third && method === "POST") return paymentWebhook(request, env, third);

  if (first === "auth" && second === "register" && method === "POST") return register(request, env);
  if (first === "auth" && second === "login" && method === "POST") return login(request, env);
  if (first === "auth" && second === "me" && method === "GET") return json({ user: publicUser(await userFrom(env, request)) });
  if (first === "auth" && second === "me" && method === "PATCH") return updateProfile(request, env);
  if (first === "auth" && second === "avatar" && method === "POST") return uploadAvatar(request, env);

  if (first === "recipes" && !second && method === "GET") return listRecipes(request, url, env);
  if (first === "recipes" && second && !third && method === "GET") return oneRecipe(request, env, second);
  if (first === "recipes" && !second && method === "POST") return createRecipe(request, env);
  if (first === "recipes" && second && !third && method === "PATCH") return updateRecipe(request, env, second);
  if (first === "recipes" && second && !third && method === "DELETE") return deleteRecipe(request, env, second);
  if (first === "recipes" && third === "media" && method === "POST") return uploadMedia(request, env, second, url);
  if (first === "recipes" && third === "media" && fourth && method === "DELETE") return deleteMedia(request, env, second, fourth);

  if (first === "notes" && !second && method === "GET") return listNotes(request, env);
  if (first === "notes" && !second && method === "POST") return createNote(request, env);
  if (first === "notes" && second && method === "PATCH") return updateNote(request, env, second);
  if (first === "notes" && second && method === "DELETE") return deleteNote(request, env, second);

  if (first === "people" && !second && method === "GET") return listPeople(request, env);
  if (first === "people" && second && !third && method === "GET") return onePerson(request, env, second);
  if (first === "people" && second && third === "follow" && method === "POST") return toggleFollow(request, env, second);
  if (first === "reactions" && !second && method === "POST") return toggleReaction(request, env);
  if (first === "comments" && !second && method === "POST") return addComment(request, env);
  if (first === "comments" && second && method === "DELETE") return deleteComment(request, env, second);

  if (first === "media" && !second && method === "POST") return startMedia(request, env);
  if (first === "media" && second === "parts" && method === "PUT") return saveMediaPart(request, env, url);

  if (first === "films" && !second && method === "POST") return startFilm(request, env);
  if (first === "films" && second === "parts" && method === "PUT") return saveFilmPart(request, env, url);

  if (first === "library" && !second && method === "GET") return listLibrary(request, env);
  if (first === "library" && !second && method === "POST") return createLibrary(request, env);
  if (first === "library" && second && method === "PATCH") return updateLibrary(request, env, second);
  if (first === "library" && second && method === "DELETE") return deleteLibrary(request, env, second);

  if (first === "world" && !second && method === "GET") return worldList(request, url, env);
  if (first === "world" && second && !third && method === "GET") return worldOne(request, env, second);
  if (first === "world" && third === "keep" && method === "POST") return worldKeep(request, env, second);

  if (first === "browse" && method === "GET") return openBrowse(url);
  if (first === "watch" && method === "GET") return watchLink(url);

  if (["desk", "messages", "calls", "search", "ask"].includes(first)) return deskRoute(request, env, method, first, second, third, url);

  return json({ error: "That page is not in the book." }, 404);
}

let deskReady = null;
async function deskRoute(request, env, method, first, second, third, url) {
  if (!deskReady) {
    deskReady = ensureDesk(d1Desk(env.DB)).catch((error) => {
      deskReady = null;
      throw error;
    });
  }
  await deskReady;
  const db = scopeDesk(d1Desk(env.DB), env.SITE.id);
  const user = await userFrom(env, request);
  const need = () => {
    if (!user) throw Object.assign(new Error("Log in first."), { status: 401 });
    return user;
  };
  try {
    if (first === "desk" && method === "GET") return json(await deskSnapshot(db, need().id));
    if (first === "messages" && !second && method === "GET") {
      const withId = url.searchParams.get("with");
      if (withId) return json(await readThread(db, need().id, withId, url.searchParams.get("after")));
      return json(await listThreads(db, need().id));
    }
    if (first === "messages" && !second && method === "POST") {
      const body = await readJson(request);
      return json({ message: await sendMessage(db, need().id, body) });
    }
    if (first === "calls" && !second && method === "POST") {
      const body = await readJson(request);
      return json(await placeCall(db, need().id, body));
    }
    if (first === "calls" && second && third === "signals" && method === "GET") {
      return json(await listSignals(db, need().id, second, url.searchParams.get("after")));
    }
    if (first === "calls" && second && third === "signals" && method === "POST") {
      const body = await readJson(request);
      return json(await addSignal(db, need().id, second, body.payload));
    }
    if (first === "calls" && second && !third && method === "GET") return json(await getCall(db, need().id, second));
    if (first === "calls" && second && !third && method === "POST") {
      const body = await readJson(request);
      return json(await setCall(db, need().id, second, body));
    }
    if (first === "search" && method === "GET") return json(await searchBook(db, user?.id || null, url.searchParams.get("q")));
    if (first === "ask" && method === "POST") {
      const body = await readJson(request);
      return json(await askHost(db, user?.id || null, body.question, env.AI));
    }
    return json({ error: "That page is not in the book." }, 404);
  } catch (error) {
    return json({ error: error.status ? error.message : "That did not work. Please try again." }, error.status || 500);
  }
}

async function register(request, env) {
  const body = await readJson(request);
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (name.length < 2) return json({ error: "Add the name you want on the book." }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "That email does not look right." }, 400);
  if (password.length < 8) return json({ error: "Use a password of at least 8 characters." }, 400);
  try {
    const result = await env.DB.prepare(`
      INSERT INTO users (email, password_hash, name, bio, avatar_path, created_at, tenant_id)
      VALUES (?, ?, ?, '', '', ?, ?)
    `).bind(email, await hashPassword(env, password), name, new Date().toISOString(), env.SITE.id).run();
    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(result.meta.last_row_id).first();
    return json({ token: await signToken(env, user.id), user: publicUser(user) }, 201);
  } catch (error) {
    if (String(error.message || error).includes("UNIQUE")) return json({ error: "That email already has a profile." }, 409);
    throw error;
  }
}

async function login(request, env) {
  const body = await readJson(request);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ? AND tenant_id = ?").bind(email, env.SITE.id).first();
  if (!user || !(await checkPassword(env, password, user.password_hash))) {
    return json({ error: "That email and password do not match." }, 401);
  }
  return json({ token: await signToken(env, user.id), user: publicUser(user) });
}

async function updateProfile(request, env) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const body = await readJson(request);
  const name = String(body.name ?? user.name).trim();
  const bio = String(body.bio ?? user.bio).slice(0, 500);
  let avatar = user.avatar_path;
  if (typeof body.avatarUrl === "string" && body.avatarUrl.trim()) {
    const next = body.avatarUrl.trim();
    if (!/^https?:\/\//.test(next)) return json({ error: "An avatar link needs to start with http." }, 400);
    avatar = next;
  }
  if (name.length < 2) return json({ error: "Keep a name on the profile." }, 400);
  await env.DB.prepare("UPDATE users SET name = ?, bio = ?, avatar_path = ? WHERE id = ?").bind(name, bio, avatar, user.id).run();
  const saved = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
  return json({ user: publicUser(saved) });
}

async function listRecipes(request, url, env) {
  const user = await userFrom(env, request);
  const cuisine = String(url.searchParams.get("cuisine") || "");
  const q = String(url.searchParams.get("q") || "").trim();
  const rows = await env.DB.prepare(`
    SELECT * FROM recipes
    WHERE (? = '' OR cuisine = ?)
      AND (? = '' OR title LIKE ? OR summary LIKE ?)
      AND (tenant_id = '' OR tenant_id = ?)
    ORDER BY family DESC, title COLLATE NOCASE
  `).bind(cuisine, cuisine, q, `%${q}%`, `%${q}%`, env.SITE.id).all();
  const recipes = [];
  for (const row of rows.results || []) recipes.push(await recipeRow(env, row));
  return json({ recipes: await decorateRecipes(env, user, recipes) });
}

async function oneRecipe(request, env, id) {
  const user = await userFrom(env, request);
  const row = await env.DB.prepare("SELECT * FROM recipes WHERE id = ?").bind(id).first();
  if (!row || !recipeVisible(row, env.SITE.id)) return json({ error: "That recipe is not in the book." }, 404);
  const recipe = await recipeRow(env, row);
  const [decorated] = await decorateRecipes(env, user, [recipe]);
  return json({ recipe: decorated });
}

async function createRecipe(request, env) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const body = await readJson(request);
  const title = String(body.title || "").trim();
  const ingredients = Array.isArray(body.ingredients) ? body.ingredients : lines(body.ingredients);
  const steps = Array.isArray(body.steps) ? body.steps : lines(body.steps);
  if (title.length < 2 || !ingredients.length || !steps.length) {
    return json({ error: "A recipe needs a title, ingredients, and steps." }, 400);
  }
  let image = String(body.image || "").trim();
  let imageCredit = String(body.imageCredit || "").trim();
  if (!image) {
    image = await findCover(title);
    if (image) imageCredit = "Wikimedia Commons";
  }
  if (!image) {
    const painted = await paintCover(env.AI, title);
    if (painted) {
      image = await storeChunked(env, "image/jpeg", painted, "cover.jpg");
      imageCredit = env.SITE.brand.imageCredit;
    }
  }
  if (!image) return json({ error: "Add a picture of this plate before saving it." }, 400);
  const now = new Date().toISOString();
  const id = await slugify(env, title);
  await env.DB.prepare(`
    INSERT INTO recipes (
      id, title, cuisine, category, summary, yield_text, prep_minutes, cook_minutes,
      ingredients, steps, notes, image, image_credit, source_url, source_title, family, author_id,
      created_at, updated_at, tenant_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).bind(
    id,
    title,
    cuisineOf(body.cuisine),
    String(body.category || "Mains").slice(0, 40),
    String(body.summary || "").slice(0, 600),
    String(body.yieldText || "A family plate").slice(0, 80),
    Number(body.prepMinutes) || 0,
    Number(body.cookMinutes) || 0,
    JSON.stringify(ingredients.map(String)),
    JSON.stringify(steps.map(String)),
    String(body.notes || "").slice(0, 2000),
    image,
    imageCredit,
    String(body.sourceUrl || "").slice(0, 500),
    String(body.sourceTitle || "").slice(0, 160),
    user.id,
    now,
    now,
    env.SITE.id
  ).run();
  return savedRecipe(env, user, id, 201);
}

async function updateRecipe(request, env, id) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const existing = await env.DB.prepare("SELECT * FROM recipes WHERE id = ?").bind(id).first();
  if (!existing || !recipeVisible(existing, env.SITE.id)) return json({ error: "That recipe is not in the book." }, 404);
  if (existing.author_id && String(existing.author_id) !== String(user.id)) {
    return json({ error: "Only the person who added that recipe can change it." }, 403);
  }
  const body = await readJson(request);
  const ingredients = body.ingredients != null
    ? (Array.isArray(body.ingredients) ? body.ingredients : lines(body.ingredients))
    : JSON.parse(existing.ingredients);
  const steps = body.steps != null
    ? (Array.isArray(body.steps) ? body.steps : lines(body.steps))
    : JSON.parse(existing.steps);
  const title = String(body.title ?? existing.title).trim();
  if (title.length < 2 || !ingredients.length || !steps.length) {
    return json({ error: "Keep a title, ingredients, and steps." }, 400);
  }
  await env.DB.prepare(`
    UPDATE recipes SET title=?, cuisine=?, category=?, summary=?, yield_text=?, prep_minutes=?,
      cook_minutes=?, ingredients=?, steps=?, notes=?, source_url=?, source_title=?, updated_at=?
    WHERE id=?
  `).bind(
    title,
    cuisineOf(body.cuisine ?? existing.cuisine),
    String(body.category ?? existing.category).slice(0, 40),
    String(body.summary ?? existing.summary).slice(0, 600),
    String(body.yieldText ?? existing.yield_text).slice(0, 80),
    Number(body.prepMinutes ?? existing.prep_minutes) || 0,
    Number(body.cookMinutes ?? existing.cook_minutes) || 0,
    JSON.stringify(ingredients.map(String)),
    JSON.stringify(steps.map(String)),
    String(body.notes ?? existing.notes).slice(0, 2000),
    String(body.sourceUrl ?? existing.source_url).slice(0, 500),
    String(body.sourceTitle ?? existing.source_title).slice(0, 160),
    new Date().toISOString(),
    existing.id
  ).run();
  return savedRecipe(env, user, existing.id);
}

async function deleteRecipe(request, env, id) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const existing = await env.DB.prepare("SELECT id, author_id FROM recipes WHERE id = ?").bind(id).first();
  if (!existing || !recipeVisible(existing, env.SITE.id)) return json({ error: "That recipe is not in the book." }, 404);
  if (existing.author_id && String(existing.author_id) !== String(user.id)) {
    return json({ error: "Only the person who added that recipe can delete it." }, 403);
  }
  await env.DB.prepare("DELETE FROM recipe_media WHERE recipe_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM recipes WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function deleteMedia(request, env, recipeId, mediaId) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const media = await env.DB.prepare("SELECT id, path FROM recipe_media WHERE id = ? AND recipe_id = ?").bind(mediaId, recipeId).first();
  if (!media) return json({ error: "That picture is already gone." }, 404);
  await removeStored(env, media.path);
  await env.DB.prepare("DELETE FROM recipe_media WHERE id = ?").bind(media.id).run();
  return savedRecipe(env, user, recipeId);
}

function emptySocial() {
  return { likes: 0, stars: 0, liked: false, starred: false, comments: [] };
}

function person(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, bio: row.bio || "", avatar: row.avatar_path || row.avatar || "" };
}

async function socialFor(env, user, type, ids) {
  const map = {};
  const keys = [...new Set(ids.map((id) => String(id)))].filter(Boolean);
  for (const id of keys) map[id] = emptySocial();
  for (let index = 0; index < keys.length; index += 40) {
    await fillSocial(env, user, type, keys.slice(index, index + 40), map);
  }
  return map;
}

async function fillSocial(env, user, type, keys, map) {
  if (!keys.length) return;
  const marks = keys.map(() => "?").join(",");
  const counts = await env.DB.prepare(
    `SELECT target_id AS targetId, kind, COUNT(*) AS n FROM reactions WHERE target_type = ? AND target_id IN (${marks}) GROUP BY target_id, kind`
  ).bind(type, ...keys).all();
  for (const row of counts.results || []) {
    const box = map[String(row.targetId)];
    if (!box) continue;
    if (row.kind === "like") box.likes = Number(row.n) || 0;
    if (row.kind === "star") box.stars = Number(row.n) || 0;
  }
  if (user) {
    const mine = await env.DB.prepare(
      `SELECT target_id AS targetId, kind FROM reactions WHERE user_id = ? AND target_type = ? AND target_id IN (${marks})`
    ).bind(user.id, type, ...keys).all();
    for (const row of mine.results || []) {
      const box = map[String(row.targetId)];
      if (!box) continue;
      if (row.kind === "like") box.liked = true;
      if (row.kind === "star") box.starred = true;
    }
  }
  const comments = await loadComments(env, type, keys, marks);
  for (const row of comments.results || []) {
    let attachments = [];
    try { attachments = JSON.parse(row.attachments || "[]"); } catch { attachments = []; }
    map[String(row.targetId)]?.comments.push({
      id: Number(row.id),
      body: row.body,
      attachments: Array.isArray(attachments) ? attachments : [],
      createdAt: row.createdAt,
      author: { id: row.userId, name: row.name, avatar: row.avatar }
    });
  }
}

async function loadComments(env, type, keys, marks) {
  const tail = `comments.created_at AS createdAt, comments.target_id AS targetId,
            users.id AS userId, users.name AS name, users.avatar_path AS avatar
     FROM comments JOIN users ON users.id = comments.user_id
     WHERE comments.target_type = ? AND comments.target_id IN (${marks})
     ORDER BY comments.id ASC`;
  try {
    return await env.DB.prepare(
      `SELECT comments.id, comments.body, comments.attachments, ${tail}`
    ).bind(type, ...keys).all();
  } catch {
    return await env.DB.prepare(
      `SELECT comments.id, comments.body, ${tail}`
    ).bind(type, ...keys).all();
  }
}

async function reactionSnapshot(env, user, type, id) {
  const counts = await env.DB.prepare(
    "SELECT kind, COUNT(*) AS n FROM reactions WHERE target_type = ? AND target_id = ? GROUP BY kind"
  ).bind(type, id).all();
  const snap = { likes: 0, stars: 0, liked: false, starred: false };
  for (const row of counts.results || []) {
    if (row.kind === "like") snap.likes = Number(row.n) || 0;
    if (row.kind === "star") snap.stars = Number(row.n) || 0;
  }
  if (user) {
    const mine = await env.DB.prepare(
      "SELECT kind FROM reactions WHERE user_id = ? AND target_type = ? AND target_id = ?"
    ).bind(user.id, type, id).all();
    for (const row of mine.results || []) {
      if (row.kind === "like") snap.liked = true;
      if (row.kind === "star") snap.starred = true;
    }
  }
  return snap;
}

function reactionTarget(item) {
  const source = String(item.sourceUrl || item.source_url || "");
  const fromSource = source.match(/themealdb\.com\/meal\/(\d+)/);
  const mealId = fromSource?.[1] || (item.world ? String(item.mealId || item.id || "").replace(/^mealdb-/, "") : "");
  if (mealId && /^\d+$/.test(mealId)) return { type: "world", id: `mealdb-${mealId}` };
  return { type: "recipe", id: String(item.id) };
}

async function decorateRecipes(env, user, recipes) {
  const keys = recipes.map(reactionTarget);
  const [recipeSocial, worldSocial] = await Promise.all([
    socialFor(env, user, "recipe", keys.filter((key) => key.type === "recipe").map((key) => key.id)),
    socialFor(env, user, "world", keys.filter((key) => key.type === "world").map((key) => key.id))
  ]);
  const ids = [...new Set(recipes.map((item) => item.authorId).filter(Boolean))];
  const authors = {};
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    const rows = await env.DB.prepare(`SELECT id, name, bio, avatar_path FROM users WHERE id IN (${marks})`).bind(...ids).all();
    for (const row of rows.results || []) authors[row.id] = person(row);
  }
  return recipes.map((item, index) => ({
    ...item,
    author: authors[item.authorId] || null,
    social: (keys[index].type === "world" ? worldSocial : recipeSocial)[keys[index].id] || emptySocial()
  }));
}

async function targetExists(env, type, id) {
  if (type === "recipe") return env.DB.prepare("SELECT id FROM recipes WHERE id = ?").bind(id).first();
  if (type === "note") return env.DB.prepare("SELECT id FROM notes WHERE id = ?").bind(id).first();
  if (type === "film") return env.DB.prepare("SELECT id FROM library_items WHERE id = ? AND kind NOT IN ('tiktok', 'facebook')").bind(id).first();
  if (type === "person") return env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first();
  if (type === "world") {
    const mealId = String(id).replace(/^mealdb-/, "");
    if (!/^\d+$/.test(mealId)) return null;
    try {
      await worldRecipe(mealId);
      return { id: `mealdb-${mealId}` };
    } catch {
      return null;
    }
  }
  return null;
}

async function listPeople(request, env) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const people = await env.DB.prepare("SELECT id, name, bio, avatar_path FROM users WHERE tenant_id = ? ORDER BY name COLLATE NOCASE").bind(env.SITE.id).all();
  const follows = await env.DB.prepare("SELECT follower_id AS followerId, following_id AS followingId FROM follows").all();
  const rows = follows.results || [];
  const listed = people.results || [];
  const social = await socialFor(env, user, "person", listed.map((row) => row.id));
  return json({
    people: listed.map((row) => ({
      ...person(row),
      following: rows.some((item) => String(item.followerId) === String(user.id) && String(item.followingId) === String(row.id)),
      followers: rows.filter((item) => String(item.followingId) === String(row.id)).length,
      social: social[String(row.id)] || emptySocial()
    }))
  });
}

async function onePerson(request, env, id) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const row = await env.DB.prepare("SELECT id, name, bio, avatar_path FROM users WHERE id = ? AND tenant_id = ?").bind(id, env.SITE.id).first();
  if (!row) return json({ error: "That person is not in the book." }, 404);
  const follows = await env.DB.prepare("SELECT follower_id AS followerId, following_id AS followingId FROM follows WHERE following_id = ? OR follower_id = ?").bind(id, user.id).all();
  const rows = follows.results || [];
  const social = await socialFor(env, user, "person", [id]);
  return json({
    person: {
      ...person(row),
      following: rows.some((item) => String(item.followerId) === String(user.id) && String(item.followingId) === String(row.id)),
      followers: rows.filter((item) => String(item.followingId) === String(row.id)).length,
      social: social[String(row.id)] || emptySocial()
    }
  });
}

async function toggleFollow(request, env, id) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  if (String(user.id) === String(id)) return json({ error: "That is your own account." }, 400);
  const other = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND tenant_id = ?").bind(id, env.SITE.id).first();
  if (!other) return json({ error: "That person is not in the book." }, 404);
  const existing = await env.DB.prepare("SELECT 1 AS found FROM follows WHERE follower_id = ? AND following_id = ?").bind(user.id, id).first();
  if (existing) {
    await env.DB.prepare("DELETE FROM follows WHERE follower_id = ? AND following_id = ?").bind(user.id, id).run();
    return json({ following: false });
  }
  await env.DB.prepare("INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)").bind(user.id, id, new Date().toISOString()).run();
  return json({ following: true });
}

async function toggleReaction(request, env) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const body = await readJson(request);
  const type = String(body.targetType || "");
  const id = String(body.targetId || "");
  const kind = body.kind === "star" ? "star" : "like";
  if (!["recipe", "note", "film", "world", "person"].includes(type) || !id) return json({ error: "That could not be saved." }, 400);
  if (!await targetExists(env, type, id)) return json({ error: "That could not be found." }, 404);
  const existing = await env.DB.prepare(
    "SELECT 1 AS found FROM reactions WHERE user_id = ? AND target_type = ? AND target_id = ? AND kind = ?"
  ).bind(user.id, type, id, kind).first();
  try {
    if (existing) {
      await env.DB.prepare(
        "DELETE FROM reactions WHERE user_id = ? AND target_type = ? AND target_id = ? AND kind = ?"
      ).bind(user.id, type, id, kind).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO reactions (user_id, target_type, target_id, kind, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(user.id, type, id, kind, new Date().toISOString()).run();
    }
  } catch (error) {
    if (!String(error?.message || error).includes("UNIQUE")) throw error;
  }
  const snap = await reactionSnapshot(env, user, type, id);
  return json({ on: kind === "star" ? snap.starred : snap.liked, ...snap });
}

async function addComment(request, env) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const body = await readJson(request);
  const type = String(body.targetType || "");
  const id = String(body.targetId || "");
  const text = String(body.body || "").trim().slice(0, 1000);
  const attachments = [];
  for (const item of Array.isArray(body.attachments) ? body.attachments : []) {
    const path = String(item?.path || "");
    if (!/^\/uploads\/[\w.-]+$/.test(path)) continue;
    const row = await env.DB.prepare("SELECT mime FROM files WHERE path = ?").bind(path).first();
    if (!row) continue;
    const mime = String(row.mime || "");
    attachments.push({
      path,
      mime,
      name: String(item.name || "File").replace(/[^\w.\- ]+/g, "").slice(0, 80) || "File",
      kind: mime.startsWith("video/") ? "video" : "image"
    });
  }
  if (!["recipe", "note", "film", "world"].includes(type) || !id) return json({ error: "That comment could not be saved." }, 400);
  if (!text && !attachments.length) return json({ error: "Write a comment, or add a picture or video." }, 400);
  if (!await targetExists(env, type, id)) return json({ error: "That could not be found." }, 404);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "INSERT INTO comments (user_id, target_type, target_id, body, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(user.id, type, id, text, JSON.stringify(attachments), now).run();
  const inserted = await env.DB.prepare("SELECT last_insert_rowid() AS id").first();
  return json({
    comment: {
      id: Number(inserted?.id) || Number(result.meta?.last_row_id) || 0,
      body: text,
      attachments,
      createdAt: now,
      author: person(user)
    }
  }, 201);
}

async function deleteComment(request, env, id) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const comment = await env.DB.prepare("SELECT id, attachments FROM comments WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!comment) return json({ error: "That comment is not yours." }, 404);
  let attachments = [];
  try { attachments = JSON.parse(comment.attachments || "[]"); } catch { attachments = []; }
  if (Array.isArray(attachments)) {
    for (const file of attachments) await removeStored(env, file?.path);
  }
  await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

function publicNote(row) {
  let attachments = [];
  try {
    attachments = JSON.parse(row.attachments || "[]");
  } catch { /* an old note has no files */ }
  if (!Array.isArray(attachments)) attachments = [];
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    attachments,
    updatedAt: row.updatedAt || row.updated_at,
    author: row.authorId ? { id: row.authorId, name: row.authorName || "Family", avatar: row.authorAvatar || "" } : null
  };
}

const FILM_PART = 800_000;

function videoExt(mime) {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("quicktime")) return "mov";
  return "webm";
}

function fileExt(mime, name) {
  const known = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "application/pdf": "pdf",
    "text/plain": "txt"
  };
  if (known[mime]) return known[mime];
  const ext = String(name || "").split(".").pop()?.toLowerCase().replace(/[^\w]/g, "").slice(0, 5);
  return ext || "bin";
}

function mediaKind(mime) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

async function storeChunked(env, mime, bytes, name) {
  const path = `/uploads/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${fileExt(mime, name)}`;
  await env.DB.prepare(
    "INSERT INTO files (path, mime, bytes, byte_size, part_size) VALUES (?, ?, ?, ?, ?)"
  ).bind(path, mime, new Uint8Array([0]), bytes.byteLength, FILM_PART).run();
  for (let idx = 0, offset = 0; offset < bytes.byteLength; idx += 1, offset += FILM_PART) {
    const slice = bytes.subarray(offset, Math.min(offset + FILM_PART, bytes.byteLength));
    await env.DB.prepare("INSERT INTO file_parts (path, idx, bytes) VALUES (?, ?, ?)").bind(path, idx, slice).run();
  }
  return path;
}

function cleanMediaType(mime, name) {
  let type = String(mime || "").split(";")[0].trim().toLowerCase();
  const ext = String(name || "").split(".").pop()?.toLowerCase() || "";
  if (!type || type === "application/octet-stream") {
    const guess = {
      mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4",
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic",
      mp3: "audio/mpeg", m4a: "audio/mp4", pdf: "application/pdf", txt: "text/plain"
    }[ext];
    if (guess) type = guess;
  }
  return type || "application/octet-stream";
}

async function startMedia(request, env) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const body = await readJson(request);
  const name = String(body.name || "file").replace(/[^\w.\- ]+/g, "").slice(0, 80) || "file";
  const mime = cleanMediaType(body.mime, name);
  const size = Number(body.size);
  if (!Number.isFinite(size) || size < 1) return json({ error: "That file was empty." }, 400);
  if (size > 40_000_000) return json({ error: "That video is too long for the notepad. Try a shorter clip." }, 400);
  const path = `/uploads/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${fileExt(mime, name)}`;
  await env.DB.prepare(
    "INSERT INTO files (path, mime, bytes, byte_size, part_size) VALUES (?, ?, ?, ?, ?)"
  ).bind(path, mime, new Uint8Array([0]), size, FILM_PART).run();
  return json({ path, partSize: FILM_PART, mime, name, kind: mediaKind(mime) }, 201);
}

async function saveMediaPart(request, env, url) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const path = String(url.searchParams.get("path") || "");
  const idx = Number(url.searchParams.get("idx"));
  if (!/^\/uploads\/[\w.-]+$/.test(path) || !Number.isInteger(idx) || idx < 0) {
    return json({ error: "That file could not be saved." }, 400);
  }
  const row = await env.DB.prepare("SELECT path FROM files WHERE path = ?").bind(path).first();
  if (!row) return json({ error: "That file could not be saved." }, 404);
  let bytes;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return json({ error: "That file could not be saved. Try again." }, 400);
  }
  if (!bytes.byteLength || bytes.byteLength > 1_000_000) {
    return json({ error: "That file could not be saved. Try again." }, 400);
  }
  try {
    await env.DB.prepare(`
      INSERT INTO file_parts (path, idx, bytes) VALUES (?, ?, ?)
      ON CONFLICT(path, idx) DO UPDATE SET bytes = excluded.bytes
    `).bind(path, idx, bytes).run();
  } catch {
    return json({ error: "That video did not save. Try a shorter clip." }, 400);
  }
  return json({ ok: true });
}

async function startFilm(request, env) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const body = await readJson(request);
  const title = String(body.title || "").trim().slice(0, 160);
  if (!title) return json({ error: "Give the film a title." }, 400);
  const mime = String(body.mime || "").split(";")[0].trim().toLowerCase();
  if (!/^video\/(mp4|webm|quicktime)$/.test(mime)) return json({ error: "Use an MP4 or WebM video." }, 400);
  const size = Number(body.size);
  if (!Number.isFinite(size) || size < 1) return json({ error: "That film was empty." }, 400);
  const path = `/uploads/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${videoExt(mime)}`;
  const description = String(body.description || "").slice(0, 5000);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO files (path, mime, bytes, byte_size, part_size) VALUES (?, ?, ?, ?, ?)"
  ).bind(path, mime, new Uint8Array([0]), size, FILM_PART).run();
  const result = await env.DB.prepare(`
    INSERT INTO library_items (user_id, kind, title, url, description, notes, file_path, created_at)
    VALUES (?, 'film', ?, '', ?, '', ?, ?)
  `).bind(user.id, title, description, path, now).run();
  return json({ id: result.meta.last_row_id, path, partSize: FILM_PART }, 201);
}

async function saveFilmPart(request, env, url) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const path = String(url.searchParams.get("path") || "");
  const idx = Number(url.searchParams.get("idx"));
  if (!/^\/uploads\/[\w.-]+$/.test(path) || !Number.isInteger(idx) || idx < 0) {
    return json({ error: "That film could not be saved." }, 400);
  }
  const owned = await env.DB.prepare(
    "SELECT id FROM library_items WHERE file_path = ? AND user_id = ? AND kind = 'film'"
  ).bind(path, user.id).first();
  if (!owned) return json({ error: "That film is not yours." }, 404);
  let bytes;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return json({ error: "That film could not be saved. Try again." }, 400);
  }
  if (!bytes.byteLength || bytes.byteLength > 1_000_000) {
    return json({ error: "That film could not be saved. Try again." }, 400);
  }
  await env.DB.prepare(`
    INSERT INTO file_parts (path, idx, bytes) VALUES (?, ?, ?)
    ON CONFLICT(path, idx) DO UPDATE SET bytes = excluded.bytes
  `).bind(path, idx, bytes).run();
  return json({ ok: true });
}

function noteTitle(text, attachments) {
  const line = text.trim().split(/\n/)[0].slice(0, 80);
  if (line) return line;
  if (attachments.some((item) => item.kind === "video")) return "Video";
  if (attachments.some((item) => item.kind === "file")) return "File";
  return "Photo";
}

async function storeUpload(env, file) {
  const name = String(file.name || "File").replace(/[^\w.\- ]+/g, "").slice(0, 80) || "File";
  const type = cleanMediaType(file.type, name);
  const kind = mediaKind(type);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.byteLength) return { error: json({ error: "That file was empty." }, 400) };
  const path = await storeChunked(env, type, bytes, name);
  return { meta: { path, mime: type, name, kind } };
}

async function listNotes(request, env) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const notes = await env.DB.prepare(`
    SELECT notes.id, notes.title, notes.body, notes.attachments, notes.updated_at AS updatedAt,
           notes.user_id AS authorId, users.name AS authorName, users.avatar_path AS authorAvatar
    FROM notes LEFT JOIN users ON users.id = notes.user_id
    ORDER BY notes.updated_at DESC
  `).all();
  const rows = (notes.results || []).map(publicNote);
  const social = await socialFor(env, user, "note", rows.map((item) => item.id));
  return json({ notes: rows.map((item) => ({ ...item, social: social[String(item.id)] || emptySocial() })) });
}

async function createNote(request, env) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const type = request.headers.get("content-type") || "";
  let text = "";
  const attachments = [];
  if (type.includes("multipart/form-data")) {
    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ error: "That note could not be read. Try it again." }, 400);
    }
    text = String(form.get("body") || "").slice(0, 20000);
    const files = form.getAll("file").filter((file) => file && typeof file !== "string" && file.size);
    if (!text.trim() && !files.length) return json({ error: "Write a note, or add a picture." }, 400);
    for (const file of files) {
      const saved = await storeUpload(env, file);
      if (saved.error) return saved.error;
      attachments.push(saved.meta);
    }
  } else {
    const body = await readJson(request);
    text = String(body.body || "").slice(0, 20000);
    const listed = Array.isArray(body.attachments) ? body.attachments : [];
    for (const item of listed) {
      const path = String(item?.path || "");
      if (!/^\/uploads\/[\w.-]+$/.test(path)) continue;
      const row = await env.DB.prepare("SELECT mime FROM files WHERE path = ?").bind(path).first();
      if (!row) continue;
      const mime = String(row.mime || "");
      const kind = mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "image" : "file";
      attachments.push({
        path,
        mime,
        name: String(item.name || "File").replace(/[^\w.\- ]+/g, "").slice(0, 80) || "File",
        kind
      });
    }
    if (!text.trim() && !attachments.length) return json({ error: "Write a note, or add a picture." }, 400);
  }
  const title = noteTitle(text, attachments);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "INSERT INTO notes (user_id, title, body, attachments, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(user.id, title, text, JSON.stringify(attachments), now).run();
  const inserted = await env.DB.prepare("SELECT last_insert_rowid() AS id").first();
  const id = Number(inserted?.id) || Number(result.meta?.last_row_id) || 0;
  return json({
    note: {
      id,
      title,
      body: text,
      attachments,
      updatedAt: now,
      author: person(user),
      social: emptySocial()
    }
  }, 201);
}

async function updateNote(request, env, id) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const noteId = Number(id);
  if (!Number.isInteger(noteId) || noteId < 1) return json({ error: "That note could not be saved." }, 400);
  const note = await env.DB.prepare(
    "SELECT id, title, body, attachments FROM notes WHERE id = ? AND user_id = ?"
  ).bind(noteId, user.id).first();
  if (!note) return json({ error: "That note is not yours." }, 404);
  const body = await readJson(request);
  const text = String(body.body ?? note.body ?? "").slice(0, 20000);
  const title = String(body.title || text.split("\n")[0] || note.title || "").trim().slice(0, 120) || "Note";
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ? AND user_id = ?"
  ).bind(title, text, updatedAt, noteId, user.id).run();
  let attachments = [];
  try { attachments = JSON.parse(note.attachments || "[]"); } catch { attachments = []; }
  if (!Array.isArray(attachments)) attachments = [];
  return json({
    note: { id: noteId, title, body: text, attachments, updatedAt, author: person(user) }
  });
}

async function deleteNote(request, env, id) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const note = await env.DB.prepare("SELECT attachments FROM notes WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!note) return json({ error: "That note is already gone." }, 404);
  let attachments = [];
  try { attachments = JSON.parse(note.attachments || "[]"); } catch { /* nothing to remove */ }
  if (Array.isArray(attachments)) {
    for (const file of attachments) await removeStored(env, file?.path);
  }
  await env.DB.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  return json({ ok: true });
}

async function listLibrary(request, env) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const items = await env.DB.prepare(`
    SELECT library_items.id, kind, title, url, description, library_items.notes, file_path AS filePath, created_at AS createdAt,
           library_items.user_id AS authorId, users.name AS authorName, users.avatar_path AS authorAvatar
    FROM library_items LEFT JOIN users ON users.id = library_items.user_id
    WHERE kind NOT IN ('tiktok', 'facebook')
    ORDER BY created_at DESC
  `).all();
  const rows = (items.results || []).map((item) => ({
    ...item,
    author: item.authorId ? { id: item.authorId, name: item.authorName || "Family", avatar: item.authorAvatar || "" } : null
  }));
  const social = await socialFor(env, user, "film", rows.map((item) => item.id));
  return json({ items: rows.map((item) => ({ ...item, social: social[String(item.id)] || emptySocial() })) });
}

function savedLinkKind(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); } catch { return ""; }
  if (!["http:", "https:"].includes(url.protocol)) return "";
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host.endsWith("tiktok.com") || host.endsWith("facebook.com") || host === "fb.watch" || host.endsWith("fb.com") || host.endsWith("instagram.com")) return "social";
  if (host === "youtu.be" || host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) return "youtube";
  if (/\.(mp4|webm|mov|m4v|ogg)$/i.test(url.pathname)) return "hosted";
  return "";
}

async function createLibrary(request, env) {
  const type = request.headers.get("content-type") || "";
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  if (type.includes("multipart/form-data")) return saveFilm(env, user, request);
  const body = await readJson(request);
  const title = String(body.title || "").trim().slice(0, 160);
  const link = String(body.url || "").trim();
  const kind = savedLinkKind(link);
  if (!title) return json({ error: "Give it a title." }, 400);
  if (kind === "social") return json({ error: "TikTok and Facebook stay out of the book. Use YouTube, or a video file you host." }, 400);
  if (kind !== "youtube" && kind !== "hosted") return json({ error: "Paste a YouTube link, or a video file you host that ends in .mp4 or .webm." }, 400);
  const now = new Date().toISOString();
  const description = String(body.description || "").slice(0, 5000);
  const notes = String(body.notes || "").slice(0, 2000);
  const result = await env.DB.prepare(`
    INSERT INTO library_items (user_id, kind, title, url, description, notes, file_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '', ?)
  `).bind(user.id, kind, title, link, description, notes, now).run();
  return json({
    item: { id: result.meta.last_row_id, kind, title, url: link, description, notes, filePath: "", createdAt: now }
  }, 201);
}

async function saveFilm(env, user, request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "That film could not be read. Try saving it again." }, 400);
  }
  const title = String(form.get("title") || "").trim().slice(0, 160);
  if (!title) return json({ error: "Give the film a title." }, 400);
  const file = form.get("file");
  if (!file || typeof file === "string" || !file.size) return json({ error: "Record a take or choose a video first." }, 400);
  const saved = await storeUpload(env, file);
  if (saved.error) return saved.error;
  const description = String(form.get("description") || "").slice(0, 5000);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    INSERT INTO library_items (user_id, kind, title, url, description, notes, file_path, created_at)
    VALUES (?, 'film', ?, '', ?, '', ?, ?)
  `).bind(user.id, title, description, saved.meta.path, now).run();
  return json({
    item: { id: result.meta.last_row_id, kind: "film", title, url: "", description, notes: "", filePath: saved.meta.path, createdAt: now }
  }, 201);
}

async function updateLibrary(request, env, id) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const item = await env.DB.prepare("SELECT * FROM library_items WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!item) return json({ error: "That one is not yours." }, 404);
  const body = await readJson(request);
  const title = String(body.title ?? item.title).trim().slice(0, 160);
  if (!title) return json({ error: "Give it a title." }, 400);
  const link = String(body.url ?? item.url).trim();
  let kind = item.kind;
  if (item.kind !== "film") {
    kind = savedLinkKind(link);
    if (kind === "social") return json({ error: "TikTok and Facebook stay out of the book. Use YouTube, or a video file you host." }, 400);
    if (kind !== "youtube" && kind !== "hosted") return json({ error: "Paste a YouTube link, or a video file you host that ends in .mp4 or .webm." }, 400);
  }
  const description = String(body.description ?? item.description).slice(0, 5000);
  const notes = String(body.notes ?? item.notes).slice(0, 2000);
  const storedUrl = item.kind === "film" ? item.url : link;
  await env.DB.prepare(
    "UPDATE library_items SET kind = ?, title = ?, url = ?, description = ?, notes = ? WHERE id = ?"
  ).bind(kind, title, storedUrl, description, notes, item.id).run();
  return json({
    item: { id: item.id, kind, title, url: storedUrl, description, notes, filePath: item.file_path, createdAt: item.created_at }
  });
}

async function deleteLibrary(request, env, id) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const item = await env.DB.prepare("SELECT file_path FROM library_items WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!item) return json({ error: "That one is already gone." }, 404);
  await removeStored(env, item.file_path);
  await env.DB.prepare("DELETE FROM library_items WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  return json({ ok: true });
}

async function withWorldSocial(env, user, meals) {
  const social = await socialFor(env, user, "world", meals.map((meal) => `mealdb-${meal.id}`));
  return meals.map((meal) => ({ ...meal, social: social[`mealdb-${meal.id}`] || emptySocial() }));
}

async function worldList(request, url, env) {
  try {
    const user = await userFrom(env, request);
    const catalog = await worldCatalog({ q: url.searchParams.get("q") || "", category: url.searchParams.get("category") || "" });
    catalog.meals = await withWorldSocial(env, user, catalog.meals || []);
    return json(catalog);
  } catch (error) {
    return json({ error: error.message || "The recipe library could not be reached." }, error.status || 502);
  }
}

async function worldOne(request, env, id) {
  try {
    const user = await userFrom(env, request);
    const recipe = await worldRecipe(id);
    const social = await socialFor(env, user, "world", [recipe.id]);
    recipe.social = social[recipe.id] || emptySocial();
    return json({ recipe });
  } catch (error) {
    return json({ error: error.message || "The recipe library could not be reached." }, error.status || 502);
  }
}

async function worldKeep(request, env, mealId) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  try {
    const recipe = await worldRecipe(mealId);
    const existing = await env.DB.prepare("SELECT id FROM recipes WHERE source_url = ? AND (tenant_id = '' OR tenant_id = ?)").bind(recipe.sourceUrl, env.SITE.id).first();
    if (existing) {
      return savedRecipe(env, user, existing.id);
    }
    let image = recipe.image || "";
    let imageCredit = recipe.imageCredit || "";
    if (!image) {
      image = await findCover(recipe.title);
      if (image) imageCredit = "Wikimedia Commons";
    }
    if (!image) {
      const painted = await paintCover(env.AI, recipe.title);
      if (painted) {
        image = await storeChunked(env, "image/jpeg", painted, "cover.jpg");
        imageCredit = env.SITE.brand.imageCredit;
      }
    }
    if (!image) return json({ error: "That plate needs a picture before it can be kept." }, 400);
    const now = new Date().toISOString();
    const id = await slugify(env, recipe.title);
    await env.DB.prepare(`
      INSERT INTO recipes (
        id, title, cuisine, category, summary, yield_text, prep_minutes, cook_minutes,
        ingredients, steps, notes, image, image_credit, source_url, source_title, family, author_id,
        created_at, updated_at, tenant_id
      ) VALUES (?, ?, 'library', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).bind(
      id, recipe.title, recipe.category, recipe.summary, recipe.yieldText,
      JSON.stringify(recipe.ingredients), JSON.stringify(recipe.steps), recipe.notes,
      image, imageCredit, recipe.sourceUrl, recipe.sourceTitle, user.id, now, now, env.SITE.id
    ).run();
    return savedRecipe(env, user, id, 201);
  } catch (error) {
    return json({ error: error.message || "That plate could not be kept." }, error.status || 502);
  }
}

async function watchLink(requestUrl) {
  try {
    return json(await watchClip(String(requestUrl.searchParams.get("url") || "")));
  } catch (error) {
    return json({ error: error.message || "That video could not be opened." }, error.status || 502);
  }
}

async function openBrowse(url) {
  try {
    return json(await browse(String(url.searchParams.get("url") || "")));
  } catch (error) {
    return json({ error: error.status ? error.message : "That page could not be opened." }, error.status || 500);
  }
}

async function siteView(request, env) {
  const user = await userFrom(env, request);
  return json({ site: publicSite(env.SITE, { canCustomize: canCustomize(env.SITE, user), env }) });
}

async function siteUpdate(request, env) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  if (!canCustomize(env.SITE, user)) return json({ error: "This book is styled from its configuration." }, 403);
  const body = await readJson(request);
  const host = sanitizeHost(body?.domain?.customDomain || "");
  if (body?.domain?.customDomain && !host) return json({ error: "That domain name does not look right." }, 400);
  if (host) {
    const sites = [];
    for (const site of catalogSites()) {
      const row = await env.DB.prepare("SELECT document FROM tenant_overrides WHERE tenant_id = ?").bind(site.id).first();
      sites.push(resolveSite(site.hosts[0], row?.document || ""));
    }
    if (domainTaken(host, env.SITE.id, sites)) return json({ error: "That domain is already used by another book." }, 409);
  }
  const document = JSON.stringify({
    brand: sanitizeBrand(body?.brand),
    theme: sanitizeTheme(body?.theme),
    domain: { customDomain: host, subdomain: String(body?.domain?.subdomain || "").trim().toLowerCase() }
  });
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO tenant_overrides (tenant_id, document, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at
  `).bind(env.SITE.id, document, now).run();
  const saved = await env.DB.prepare("SELECT document FROM tenant_overrides WHERE tenant_id = ?").bind(env.SITE.id).first();
  const site = resolveSite(new URL(request.url).hostname, saved?.document || "");
  return json({ site: publicSite(site, { canCustomize: true, env }) });
}

async function paymentOrders(request, env) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const rows = await env.DB.prepare(`
    SELECT id, portal, amount_cents AS amountCents, currency, note, status, checkout_url AS checkoutUrl, created_at AS createdAt
    FROM orders WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20
  `).bind(env.SITE.id, user.id).all();
  return json({ orders: (rows.results || []).map(publicOrder) });
}

async function paymentCheckout(request, env) {
  const user = await userFrom(env, request);
  if (!user) return json({ error: "Sign in first." }, 401);
  const body = await readJson(request);
  try {
    const order = await startCheckout({
      site: env.SITE,
      portal: String(body?.portal || ""),
      amountCents: body?.amountCents,
      note: body?.note,
      user,
      env,
      async save(row) {
        await env.DB.prepare(`
          INSERT INTO orders (id, tenant_id, user_id, portal, amount_cents, currency, note, status, external_id, checkout_url, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(row.id, row.tenantId, row.userId, row.portal, row.amountCents, row.currency, row.note, row.status, row.externalId, row.checkoutUrl, row.createdAt).run();
      }
    });
    return json({ order }, 201);
  } catch (error) {
    return json({ error: error.status ? error.message : "The payment desk could not open." }, error.status || 500);
  }
}

async function paymentWebhook(request, env, portal) {
  const body = await request.text();
  try {
    if (portal === "square") {
      const ok = await squareSignatureValid({
        key: env.SQUARE_WEBHOOK_SIGNATURE_KEY || "",
        url: request.url,
        body,
        signature: request.headers.get("x-square-hmacsha256-signature") || ""
      });
      if (!ok) return json({ error: "That notice could not be verified." }, 401);
      const event = squareEvent(JSON.parse(body || "{}"));
      if (event.externalId && event.status) {
        await env.DB.prepare("UPDATE orders SET status = ? WHERE external_id = ? AND status != 'paid'").bind(event.status, event.externalId).run();
      }
      return json({ ok: true });
    }
    if (portal === "cashapp") {
      const ok = await cashAppSignatureValid({
        key: env.CASHAPP_WEBHOOK_SECRET || "",
        body,
        signature: request.headers.get("x-cookbook-signature") || ""
      });
      if (!ok) return json({ error: "That notice could not be verified." }, 401);
      const event = cashAppEvent(JSON.parse(body || "{}"));
      if (event.orderId && event.status) {
        await env.DB.prepare("UPDATE orders SET status = ? WHERE id = ? AND portal = 'cashapp' AND status != 'paid'").bind(event.status, event.orderId).run();
      }
      return json({ ok: true });
    }
    return json({ error: "That payment desk is not in the book." }, 404);
  } catch {
    return json({ error: "That notice could not be read." }, 400);
  }
}
