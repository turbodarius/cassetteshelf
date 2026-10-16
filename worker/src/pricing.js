// Pure order logic (no Stripe calls) so it can be unit tested.
// Everything the browser sends is treated as untrusted: prices, shipping
// and fees always come from the store settings (settings.js), never from
// the request.

import { FORMATS } from "./catalog.js";
import { customProductProblem, normalizeCode } from "./custom.js";

export const MAX_LINES = 20;
export const MAX_QUANTITY = 20;

export class OrderError extends Error {}

// [{ format, size, quantity }] -> priced line items. Custom products
// ({ format: "custom", code }) are priced from `customProducts`
// (custom.js), one of each per order.
export function priceItems(settings, items, customProducts = []) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new OrderError("your cart is empty");
  }
  if (items.length > MAX_LINES) {
    throw new OrderError("too many items in cart");
  }

  const codesInCart = new Set();
  return items.map((item) => {
    if (item?.format === "custom") return customLine(item, customProducts, codesInCart);
    const format = ownValue(FORMATS, item?.format);
    const unitAmount = format && ownValue(settings.prices[item.format] ?? {}, item?.size);
    const quantity = Number(item?.quantity);

    if (!Number.isInteger(unitAmount)) {
      throw new OrderError("unknown product: " + item?.format + " " + item?.size);
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      throw new OrderError("invalid quantity for " + item.size);
    }

    return {
      format: item.format,
      size: item.size,
      label: item.size + " " + format.label,
      quantity,
      unitAmount,
      amount: unitAmount * quantity,
    };
  });
}

function customLine(item, customProducts, codesInCart) {
  const code = normalizeCode(item.code);
  const product = customProducts.find((p) => p.code === code);
  const problem = customProductProblem(product);
  if (problem) throw new OrderError(problem + " (" + (code || "no code") + "), please remove it from your cart");
  if (codesInCart.has(code)) throw new OrderError(product.name + " is in your cart twice");
  codesInCart.add(code);
  if (Number(item.quantity) !== 1) throw new OrderError("only one " + product.name + " can be ordered");
  // `size` holds the code, so metadata reads "custom:CODE:1".
  return { format: "custom", size: code, label: product.name, quantity: 1, unitAmount: product.price, amount: product.price };
}

// Returns the options for a country, or [] if we don't ship there.
export function shippingOptionsFor(settings, country) {
  return ownValue(settings.countries, country)?.options ?? [];
}

// obj[key] for the object's own keys only, so "__proto__" etc. can't match.
function ownValue(obj, key) {
  return typeof key === "string" && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

// Picks the requested option, falling back to the country's first one.
export function selectShipping(settings, country, rateId) {
  const options = shippingOptionsFor(settings, country);
  if (options.length === 0) {
    throw new OrderError("we don't ship to this country yet");
  }
  return options.find((o) => o.id === rateId) ?? options[0];
}

// Percentage fees (e.g. tariffs) for a country, as amounts in cents.
// Each fee is a percentage of the items' total, shipping not included.
export function feesFor(settings, country, itemsTotal) {
  const fees = ownValue(settings.countries, country)?.fees ?? [];
  return fees.map((fee) => ({
    id: fee.id,
    label: fee.label,
    percent: fee.percent,
    amount: Math.round((itemsTotal * fee.percent) / 100),
  }));
}

// Compact "id:amount" summary for PaymentIntent metadata.
export function feesMetadata(fees) {
  return fees.map((f) => f.id + ":" + f.amount).join(",");
}

export function countryList(settings) {
  return Object.entries(settings.countries).map(([code, c]) => ({ code, name: c.name }));
}

// Prices for the site to display, in cents: { cassette: { "1x1": 2751, ... }, cd: {...} }
export function displayPrices(settings) {
  const out = {};
  for (const format of Object.keys(FORMATS)) out[format] = { ...(settings.prices[format] ?? {}) };
  return out;
}

// Countries whose addresses need a province/state. Other countries are
// shipped to without one (Stripe's address form adapts to each country).
const COUNTRIES_WITH_STATES = ["CA", "US"];

function needsState(country) {
  return COUNTRIES_WITH_STATES.includes(country);
}

// Enough of an address for Stripe Tax to compute an accurate rate.
export function hasTaxableAddress(address) {
  return Boolean(
    address?.country && address?.postal_code && (address?.state || !needsState(address.country)),
  );
}

// Names of the custom products in an order, for the dashboard and emails
// ("CODE=Name|CODE2=Name2", within Stripe's 500-character limit).
export function customNamesMetadata(lines) {
  let out = "";
  for (const l of lines.filter((l) => l.format === "custom")) {
    const entry = (out ? "|" : "") + l.size + "=" + l.label.replace(/[|=]/g, " ");
    if (out.length + entry.length > 500) break;
    out += entry;
  }
  return out;
}

// Compact "format:size:qty" summary for PaymentIntent metadata
// (Stripe metadata values are capped at 500 characters).
export function itemsMetadata(lines) {
  return lines.map((l) => l.format + ":" + l.size + ":" + l.quantity).join(",");
}

const ADDRESS_FIELDS = ["line1", "line2", "city", "state", "postal_code", "country"];

// Keeps only known address fields, as trimmed strings.
export function cleanAddress(address) {
  const clean = {};
  for (const field of ADDRESS_FIELDS) {
    const value = address?.[field];
    if (typeof value === "string" && value.trim()) {
      clean[field] = value.trim().slice(0, 200);
    }
  }
  return clean;
}

export function validateCheckoutDetails({ name, email, address }) {
  if (typeof name !== "string" || !name.trim()) {
    throw new OrderError("please enter your name");
  }
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new OrderError("please enter a valid email");
  }
  for (const field of ["line1", "city", "postal_code", "country"]) {
    if (!address[field]) {
      throw new OrderError("please complete your shipping address");
    }
  }
  if (needsState(address.country) && !address.state) {
    throw new OrderError("please complete your shipping address");
  }
}
