// Store settings: prices, countries, shipping options, fees, tax switch.
//
// They're edited in the /admin dashboard and saved in Cloudflare KV
// (binding SETTINGS). Until the first save from the dashboard, the
// defaults below are used: prices from catalog.js, countries/shipping/
// fees from shipping.js, and COLLECT_TAX from wrangler.toml. After that,
// the dashboard's values win and edits to those files have no effect.

import { FORMATS } from "./catalog.js";
import { SHIPPING_RATES } from "./shipping.js";

const KV_KEY = "settings";

// Every configurator size, "columns x rows".
export const SIZES = [];
for (let c = 1; c <= 6; c++) for (let r = 1; r <= 6; r++) SIZES.push(c + "x" + r);

export class SettingsError extends Error {}

export function defaultSettings(env) {
  const prices = {};
  for (const [format, { prices: table }] of Object.entries(FORMATS)) {
    prices[format] = { ...table };
  }
  return {
    collectTax: env?.COLLECT_TAX === "true",
    prices,
    countries: structuredClone(SHIPPING_RATES),
  };
}

// -> { settings, updatedAt } (updatedAt is null until the first save)
export async function loadSettings(env) {
  const stored = env.SETTINGS ? await env.SETTINGS.get(KV_KEY, "json") : null;
  if (stored?.settings) return stored;
  return { settings: defaultSettings(env), updatedAt: null };
}

// Saves validated settings. `expectedUpdatedAt` is the version the
// dashboard started from; if someone saved in between, nothing is
// overwritten and the dashboard is told to reload.
export async function saveSettings(env, input, expectedUpdatedAt) {
  if (!env.SETTINGS) {
    throw new SettingsError("settings storage isn't set up yet (see worker/README.md)");
  }
  const current = await loadSettings(env);
  if ((current.updatedAt ?? null) !== (expectedUpdatedAt ?? null)) {
    const err = new SettingsError("the settings were changed somewhere else; reload to see the latest version");
    err.conflict = true;
    throw err;
  }
  const record = { settings: validateSettings(input), updatedAt: new Date().toISOString() };
  await env.SETTINGS.put(KV_KEY, JSON.stringify(record));
  return record;
}

const ID = /^[a-z0-9-]{1,30}$/;
// Two-letter codes that are reserved or groupings (EU, UN...), not countries.
const NOT_COUNTRIES = /^(AA|Q[M-Z]|X[A-JL-Z]|ZZ|EU|EZ|UN)$/;

// Checks everything the dashboard sends and returns a clean copy (unknown
// fields dropped). Errors are written for the dashboard to show as-is.
export function validateSettings(input) {
  const fail = (message) => {
    throw new SettingsError(message);
  };
  if (!isObject(input)) fail("invalid settings");
  if (typeof input.collectTax !== "boolean") fail("sales tax must be on or off");

  const prices = {};
  if (!isObject(input.prices)) fail("prices are missing");
  for (const format of Object.keys(FORMATS)) {
    const table = input.prices[format];
    if (!isObject(table)) fail("prices for " + FORMATS[format].label + "s are missing");
    prices[format] = {};
    for (const [size, amount] of Object.entries(table)) {
      if (!SIZES.includes(size)) fail("unknown size " + size);
      if (!Number.isInteger(amount) || amount < 1 || amount > 10_000_000) {
        fail(FORMATS[format].label + " " + size + ": price must be between 0.01$ and 100,000$");
      }
      prices[format][size] = amount;
    }
  }

  if (!isObject(input.countries)) fail("countries are missing");
  const entries = Object.entries(input.countries);
  if (entries.length === 0) fail("add at least one country you ship to");
  if (entries.length > 100) fail("too many countries");

  const countries = {};
  for (const [code, country] of entries) {
    if (!/^[A-Z]{2}$/.test(code)) fail("country code " + code + " must be two capital letters (e.g. FR)");
    if (NOT_COUNTRIES.test(code)) fail(code + " isn't a country code");
    if (!isObject(country)) fail(code + ": invalid country");
    const name = text(country.name, 60);
    if (!name) fail(code + ": the country needs a name");

    if (!Array.isArray(country.options) || country.options.length === 0) {
      fail(name + ": add at least one shipping option");
    }
    if (country.options.length > 10) fail(name + ": too many shipping options");
    const options = country.options.map((o) => {
      const label = text(o?.label, 40);
      if (!ID.test(o?.id ?? "")) fail(name + ": invalid shipping option id");
      if (!label) fail(name + ": every shipping option needs a name");
      if (!Number.isInteger(o.amount) || o.amount < 0 || o.amount > 1_000_000) {
        fail(name + " " + label + ": shipping price must be between 0$ and 10,000$");
      }
      return { id: o.id, label, amount: o.amount };
    });
    if (new Set(options.map((o) => o.id)).size !== options.length) {
      fail(name + ": two shipping options have the same id");
    }

    const feesIn = country.fees ?? [];
    if (!Array.isArray(feesIn) || feesIn.length > 10) fail(name + ": invalid fees");
    const fees = feesIn.map((f) => {
      const label = text(f?.label, 40);
      if (!ID.test(f?.id ?? "")) fail(name + ": invalid fee id");
      if (!label) fail(name + ": every fee needs a name");
      if (typeof f.percent !== "number" || !Number.isFinite(f.percent) || f.percent <= 0 || f.percent > 1000) {
        fail(name + " " + label + ": percentage must be more than 0 and at most 1000");
      }
      return { id: f.id, label, percent: Math.round(f.percent * 100) / 100 };
    });
    if (new Set(fees.map((f) => f.id)).size !== fees.length) {
      fail(name + ": two fees have the same id");
    }

    countries[code] = fees.length ? { name, fees, options } : { name, options };
  }

  return { collectTax: input.collectTax, prices, countries };
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
