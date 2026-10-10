// Orders from before the switch to Stripe (imported from a Shopify
// "orders export" CSV in the dashboard). They contain customers' personal
// details, so they're kept in Cloudflare KV (the SETTINGS namespace, key
// "legacy-orders") behind the admin password, never in the repository.
// The dashboard parses the CSV; this file checks and stores the result.

import { FORMATS } from "./catalog.js";
import { SettingsError } from "./settings.js";

const KV_KEY = "legacy-orders";
const MAX_ORDERS = 5000;
const SHOPIFY_STORE = "cassetteshelf-com";  // admin.shopify.com/store/<this>

export async function loadLegacyOrders(env) {
  if (!env.SETTINGS) return [];
  return (await env.SETTINGS.get(KV_KEY, "json")) ?? [];
}

// Adds/replaces orders by id (importing the same file twice is harmless).
export async function importLegacyOrders(env, input) {
  if (!env.SETTINGS) throw new SettingsError("settings storage isn't set up yet (see worker/README.md)");
  if (!Array.isArray(input) || input.length === 0) throw new SettingsError("no orders to import");
  const incoming = input.map(cleanOrder);
  const byId = new Map((await loadLegacyOrders(env)).map((o) => [o.id, o]));
  for (const order of incoming) byId.set(order.id, order);
  const all = [...byId.values()].sort((a, b) => (a.created < b.created ? 1 : -1));
  if (all.length > MAX_ORDERS) throw new SettingsError("too many imported orders");
  await env.SETTINGS.put(KV_KEY, JSON.stringify(all));
  return { orders: all, imported: incoming.length };
}

export async function clearLegacyOrders(env) {
  if (env.SETTINGS) await env.SETTINGS.put(KV_KEY, "[]");
}

// Stored order -> the same shape as Stripe orders in the dashboard.
export function legacyToOrder(o) {
  const refunded = o.refunded;
  return {
    id: o.id,
    number: o.number,
    source: "shopify",
    created: o.created,
    total: o.total,
    currency: o.currency,
    refunded,
    status: o.financialStatus === "partially_refunded" ? "partially refunded" : o.financialStatus.replace(/_/g, " "),
    customer: o.customer,
    address: o.address,
    items: o.items.map(shopifyItem),
    shipping: o.shipping,
    fees: [],
    tax: o.tax,
    paymentMethod: o.paymentMethod,
    shipment: o.fulfilledAt ? { at: o.fulfilledAt, carrier: "", carrierName: "", tracking: "", trackingUrl: null } : null,
    stripeUrl: o.shopifyId ? "https://admin.shopify.com/store/" + SHOPIFY_STORE + "/orders/" + o.shopifyId : null,
  };
}

function cleanOrder(o) {
  const fail = (message) => {
    throw new SettingsError("order " + (typeof o?.number === "string" ? o.number : "?") + ": " + message);
  };
  if (typeof o !== "object" || o === null) fail("invalid order");
  const number = text(o.number, 30);
  if (!/^#?[A-Za-z0-9-]{1,30}$/.test(number)) fail("invalid order number");
  const created = isoDate(o.created);
  if (!created) fail("invalid date");
  const money = (v, what) => {
    if (!Number.isInteger(v) || v < 0 || v > 100_000_000) fail("invalid " + what);
    return v;
  };
  const items = Array.isArray(o.items) ? o.items.slice(0, 100).map((i) => ({
    quantity: Number.isInteger(i?.quantity) && i.quantity > 0 ? Math.min(i.quantity, 10000) : 1,
    label: text(i?.label, 120),
  })) : [];
  if (items.length === 0) fail("no items");
  return {
    id: "shopify-" + number.replace(/^#/, ""),
    number: number.startsWith("#") ? number : "#" + number,
    shopifyId: /^\d{1,20}$/.test(o.shopifyId ?? "") ? o.shopifyId : "",
    created,
    currency: /^[A-Za-z]{3}$/.test(o.currency ?? "") ? o.currency.toLowerCase() : "cad",
    total: money(o.total, "total"),
    refunded: money(o.refunded ?? 0, "refunded amount"),
    tax: money(o.tax ?? 0, "tax"),
    financialStatus: /^[a-z_]{1,30}$/.test(o.financialStatus ?? "") ? o.financialStatus : "paid",
    customer: {
      name: text(o.customer?.name, 100),
      email: text(o.customer?.email, 200),
      phone: text(o.customer?.phone, 40),
    },
    address: Object.fromEntries(["line1", "line2", "city", "state", "postal_code", "country"]
      .map((k) => [k, text(o.address?.[k], k === "country" ? 2 : 200)])),
    items,
    shipping: { option: text(o.shipping?.option, 60), amount: money(o.shipping?.amount ?? 0, "shipping") },
    paymentMethod: text(o.paymentMethod, 60),
    fulfilledAt: o.fulfilledAt ? isoDate(o.fulfilledAt) : null,
  };
}

// Shopify named variants "cassetteshelf - <columns> / <rows>"; give them the
// same name as checkout orders ("2x2 cassette shelf") so they add up in
// the analytics. Other names are kept as they are.
function shopifyItem(item) {
  const m = /^cassetteshelf\s*-\s*(\d+)\s*\/\s*(\d+)$/i.exec(item.label ?? "");
  if (!m) return { ...item };
  const size = m[1] + "x" + m[2];
  return { format: "cassette", size, quantity: item.quantity, label: size + " " + FORMATS.cassette.label };
}

function text(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "";
}

function isoDate(value) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
