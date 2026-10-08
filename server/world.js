import { services } from "../shared/brand-config.js";

const BASE = services.mealDbApi;
const cache = new Map();

async function cached(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw Object.assign(new Error("The recipe library could not be reached."), { status: 502 });
  }
  if (!response.ok) throw Object.assign(new Error("The recipe library is not answering."), { status: 502 });
  const data = await response.json();
  cache.set(url, { at: Date.now(), data });
  return data;
}

function stepsFrom(text) {
  const raw = String(text || "").replace(/\r/g, "").trim();
  if (!raw) return ["The library did not include a method for this plate."];
  let parts = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (parts.length === 1 && parts[0].length > 320) {
    parts = parts[0].split(/(?<=[.!])\s+(?=[A-Z0-9])/).map((line) => line.trim()).filter(Boolean);
  }
  return parts.map((line) => line.replace(/^\d+[.)]\s*/, ""));
}

function ingredientsFrom(meal) {
  const items = [];
  for (let index = 1; index <= 20; index += 1) {
    const name = String(meal[`strIngredient${index}`] || "").trim();
    const measure = String(meal[`strMeasure${index}`] || "").trim();
    if (!name) continue;
    items.push(measure ? `${measure} ${name}` : name);
  }
  return items.length ? items : ["See the source for the ingredient list."];
}

export function mapMeal(meal) {
  const id = String(meal.idMeal);
  const source = `${services.mealDbMeal}${id}`;
  const notes = [meal.strYoutube ? `Film: ${meal.strYoutube}` : "", meal.strTags ? `Tags: ${meal.strTags}` : ""]
    .filter(Boolean)
    .join("\n");
  return {
    id: `mealdb-${id}`,
    mealId: id,
    title: meal.strMeal,
    cuisine: "library",
    category: meal.strCategory || "Library",
    area: meal.strArea || "",
    summary: meal.strArea
      ? `${meal.strArea} cooking, brought in from the open recipe library.`
      : "Brought in from the open recipe library.",
    yieldText: "the table",
    prepMinutes: 0,
    cookMinutes: 0,
    ingredients: ingredientsFrom(meal),
    steps: stepsFrom(meal.strInstructions),
    notes,
    image: meal.strMealThumb || "",
    imageCredit: "Photograph via TheMealDB",
    sourceUrl: source,
    sourceTitle: "TheMealDB",
    youtube: meal.strYoutube || "",
    family: false,
    world: true,
    media: []
  };
}

function brief(meal, category = "") {
  return {
    id: String(meal.idMeal),
    title: meal.strMeal,
    image: meal.strMealThumb || "",
    category: meal.strCategory || category,
    area: meal.strArea || ""
  };
}

export async function listCategories() {
  const data = await cached(`${BASE}/categories.php`);
  return (data.categories || []).map((item) => item.strCategory).filter(Boolean);
}

const NEARBY = [
  [/cobbler|crumble|crisp|buckle|slump|grunt/i, ["crumble", "pie", "peach", "apple"]],
  [/pie|tart/i, ["pie", "tart"]],
  [/cake|brownie/i, ["cake"]],
  [/cookie|biscuit/i, ["cookie", "biscuit"]],
  [/bread|roll/i, ["bread"]],
  [/soup|gumbo|stew|chili/i, ["soup", "stew"]],
  [/pancake|waffle/i, ["pancake"]]
];

function addMeals(found, rows) {
  for (const meal of rows || []) {
    const item = meal.strMeal ? brief(meal, meal.strCategory || "") : meal;
    if (!item.id || found.some((saved) => saved.id === item.id)) continue;
    found.push(item);
  }
}

async function mealsNamed(query) {
  const data = await cached(`${BASE}/search.php?s=${encodeURIComponent(query)}`);
  return data.meals || [];
}

async function mealsWithIngredient(query) {
  const data = await cached(`${BASE}/filter.php?i=${encodeURIComponent(query)}`);
  return data.meals || [];
}

async function searchMeals(query) {
  const found = [];
  addMeals(found, await mealsNamed(query));
  if (!found.length) addMeals(found, await mealsWithIngredient(query));
  if (!found.length) {
    for (const word of query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2)) {
      addMeals(found, await mealsNamed(word));
      if (!found.length) addMeals(found, await mealsWithIngredient(word));
      if (found.length) break;
    }
  }
  if (found.length) return { meals: found.slice(0, 24), notice: "" };
  const hints = NEARBY.find(([pattern]) => pattern.test(query));
  for (const term of hints?.[1] || []) {
    addMeals(found, await mealsNamed(term));
    if (found.length >= 12) break;
  }
  if (found.length) {
    return {
      meals: found.slice(0, 24),
      notice: `No ${query} in the book yet. These close plates are from the open library.`
    };
  }
  const letter = query.match(/[a-z]/i)?.[0]?.toLowerCase();
  if (letter) {
    const data = await cached(`${BASE}/search.php?f=${letter}`);
    addMeals(found, data.meals || []);
  }
  if (found.length) {
    return {
      meals: found.slice(0, 24),
      notice: `No ${query} in the book yet. These plates from the open library start with ${letter.toUpperCase()}.`
    };
  }
  const data = await cached(`${BASE}/filter.php?c=Dessert`);
  addMeals(found, (data.meals || []).slice(0, 24));
  return {
    meals: found.slice(0, 24),
    notice: `No ${query} in the book yet. Here are desserts from the open library.`
  };
}

export async function worldCatalog({ q = "", category = "" } = {}) {
  const categories = await listCategories();
  const query = String(q || "").trim();
  const chosen = String(category || "").trim();
  if (query) {
    const result = await searchMeals(query);
    return { categories, category: "", meals: result.meals, notice: result.notice };
  }
  const name = categories.includes(chosen) ? chosen : "Chicken";
  const data = await cached(`${BASE}/filter.php?c=${encodeURIComponent(name)}`);
  return {
    categories,
    category: name,
    meals: (data.meals || []).map((meal) => brief(meal, name)),
    notice: ""
  };
}

export async function worldRecipe(id) {
  if (!/^\d+$/.test(String(id || ""))) {
    throw Object.assign(new Error("That plate is not in the library."), { status: 400 });
  }
  const data = await cached(`${BASE}/lookup.php?i=${id}`);
  const meal = data.meals?.[0];
  if (!meal) throw Object.assign(new Error("That plate is not in the library."), { status: 404 });
  return mapMeal(meal);
}
