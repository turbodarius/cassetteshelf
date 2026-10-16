// Custom products: one-off products made in the /admin dashboard, each
// with a code and its own price. A customer who enters the code in the
// cart (or opens cassetteshelf.com/?code=THECODE) gets that product in
// their cart at that price; shipping and fees work as for any shelf.
//
// Stored in Cloudflare KV (binding SETTINGS, key "custom-products"), next
// to the settings and never in the repository. Each product remembers the
// paid orders that used it (from the Stripe webhook), so a code can be
// limited to one order, a number of orders, or none.

import { SIZES, SettingsError } from "./settings.js";
import { FORMATS } from "./catalog.js";

const KV_KEY = "custom-products";
export const MAX_PRODUCTS = 500;
const CODE = /^[A-Z0-9-]{3,30}$/;
const MAX_ORDERS_KEPT = 1000;

// Codes are matched without caring about case or surrounding spaces.
export function normalizeCode(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export async function loadCustomProducts(env) {
  const stored = env.SETTINGS ? await env.SETTINGS.get(KV_KEY, "json") : null;
  return Array.isArray(stored?.products) ? stored.products : [];
}

async function storeCustomProducts(env, products) {
  if (!env.SETTINGS) {
    throw new SettingsError("storage isn't set up yet (see worker/README.md)");
  }
  await env.SETTINGS.put(KV_KEY, JSON.stringify({ products, updatedAt: new Date().toISOString() }));
  return products;
}

// Why a product can't be bought right now, or null if it can.
export function customProductProblem(product) {
  if (!product || !product.active) return "this code isn't valid";
  if (product.maxUses !== null && product.orders.length >= product.maxUses) {
    return "this code has already been used";
  }
  return null;
}

// What the shop's site may see: no private note, no orders.
export function publicCustomProduct(product) {
  return {
    code: product.code,
    name: product.name,
    price: product.price,
    image: product.image,
  };
}

export async function createCustomProduct(env, input) {
  const products = await loadCustomProducts(env);
  if (products.length >= MAX_PRODUCTS) {
    throw new SettingsError("too many custom products; delete some old ones first");
  }
  const product = validateCustomProduct(input);
  if (products.some((p) => p.code === product.code)) {
    throw new SettingsError("the code " + product.code + " is already used by another product");
  }
  products.unshift({ ...product, orders: [], createdAt: new Date().toISOString() });
  return storeCustomProducts(env, products);
}

// Edits everything but the code (which customers may already have).
export async function updateCustomProduct(env, code, input) {
  const products = await loadCustomProducts(env);
  const index = products.findIndex((p) => p.code === normalizeCode(code));
  if (index === -1) throw new SettingsError("this product doesn't exist anymore; reload the page");
  const edited = validateCustomProduct({ ...input, code: products[index].code });
  products[index] = { ...products[index], ...edited };
  return storeCustomProducts(env, products);
}

export async function deleteCustomProduct(env, code) {
  const products = await loadCustomProducts(env);
  return storeCustomProducts(env, products.filter((p) => p.code !== normalizeCode(code)));
}

// Called from the Stripe webhook once an order is paid: records it on
// each custom product it contains (once, even if Stripe retries).
export async function recordCustomProductOrder(env, paymentIntent) {
  const codes = (paymentIntent.metadata?.items ?? "").split(",")
    .map((part) => part.split(":"))
    .filter(([format]) => format === "custom")
    .map(([, code]) => code);
  if (codes.length === 0 || !env.SETTINGS) return;

  const products = await loadCustomProducts(env);
  let changed = false;
  for (const product of products) {
    if (codes.includes(product.code) && !product.orders.includes(paymentIntent.id)) {
      product.orders = [...product.orders, paymentIntent.id].slice(-MAX_ORDERS_KEPT);
      changed = true;
    }
  }
  if (changed) await storeCustomProducts(env, products);
}

// Checks what the dashboard sends; returns a clean product (no orders).
export function validateCustomProduct(input) {
  const fail = (message) => {
    throw new SettingsError(message);
  };
  if (typeof input !== "object" || input === null) fail("invalid product");

  const code = normalizeCode(input.code);
  if (!CODE.test(code)) fail("the code must be 3 to 30 letters, numbers or dashes");

  const name = text(input.name, 80);
  if (!name) fail("the product needs a name");

  const price = input.price;
  if (!Number.isInteger(price) || price < 1 || price > 10_000_000) {
    fail("the price must be between 0.01$ and 100,000$");
  }

  let maxUses = input.maxUses ?? null;
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000)) {
    fail("the number of orders must be between 1 and 1000 (or unlimited)");
  }

  const image = typeof input.image === "string" ? input.image : "";
  if (image) {
    const [format, size] = image.split(":");
    if (!Object.hasOwn(FORMATS, format) || !SIZES.includes(size)) fail("unknown picture");
  }

  if (typeof input.active !== "boolean") fail("the product must be on or off");

  return {
    code,
    name,
    price,
    maxUses,
    image,
    note: text(input.note, 300),
    active: input.active,
  };
}

function text(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "";
}
