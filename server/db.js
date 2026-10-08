import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RECIPES } from "./seed-data.js";

fs.mkdirSync("data", { recursive: true });
export const db = new DatabaseSync(path.resolve("data/book.db"));
db.exec("PRAGMA journal_mode = DELETE");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    avatar_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recipes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    cuisine TEXT NOT NULL,
    category TEXT NOT NULL,
    summary TEXT NOT NULL,
    yield_text TEXT NOT NULL,
    prep_minutes INTEGER NOT NULL,
    cook_minutes INTEGER NOT NULL,
    ingredients TEXT NOT NULL,
    steps TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    image_credit TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    source_title TEXT NOT NULL DEFAULT '',
    youtube TEXT NOT NULL DEFAULT '',
    family INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recipe_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS library_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL,
    following_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (follower_id, following_id)
  );
  CREATE TABLE IF NOT EXISTS reactions (
    user_id INTEGER NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, target_type, target_id, kind)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    body TEXT NOT NULL,
    attachments TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
`);

try {
  db.exec("ALTER TABLE notes ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
} catch { /* the column is already there */ }
try {
  db.exec("ALTER TABLE comments ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
} catch { /* the column is already there */ }
try {
  db.exec("ALTER TABLE recipes ADD COLUMN youtube TEXT NOT NULL DEFAULT ''");
} catch { /* the column is already there */ }
try {
  db.exec("ALTER TABLE users ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'lisa'");
} catch { /* the column is already there */ }
try {
  db.exec("ALTER TABLE recipes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT ''");
} catch { /* the column is already there */ }
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
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
  );
  CREATE TABLE IF NOT EXISTS tenant_overrides (
    tenant_id TEXT PRIMARY KEY,
    document TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

export function seedIfEmpty() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO recipes (
      id, title, cuisine, category, summary, yield_text, prep_minutes, cook_minutes,
      ingredients, steps, notes, image, image_credit, source_url, source_title, youtube, family,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  for (const recipe of RECIPES) {
    insert.run(
      recipe.id,
      recipe.title,
      recipe.cuisine,
      recipe.category,
      recipe.summary,
      recipe.yieldText,
      recipe.prepMinutes,
      recipe.cookMinutes,
      JSON.stringify(recipe.ingredients),
      JSON.stringify(recipe.steps),
      recipe.notes || "",
      recipe.image,
      recipe.imageCredit || "",
      recipe.sourceUrl || "",
      recipe.sourceTitle || "",
      recipe.youtube || "",
      recipe.family ? 1 : 0,
      now,
      now
    );
  }
}

export function recipeRow(row) {
  if (!row) return null;
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
    updatedAt: row.updated_at,
    media: db.prepare("SELECT id, kind, path, caption FROM recipe_media WHERE recipe_id = ? ORDER BY id").all(row.id)
  };
}
