// Pure order logic (no Stripe calls) so it can be unit tested.
// Everything the browser sends is treated as untrusted: prices always
// come from catalog.js and shipping.js, never from the request.

import { FORMATS } from "./catalog.js";
import { SHIPPING_RATES } from "./shipping.js";

export const MAX_LINES = 20;
export const MAX_QUANTITY = 20;

export class OrderError extends Error {}

// [{ format, size, quantity }] -> priced line items.
export function priceItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new OrderError("your cart is empty");
  }
  if (items.length > MAX_LINES) {
    throw new OrderError("too many items in cart");
  }

  return items.map((item) => {
    const format = ownValue(FORMATS, item?.format);
    const unitAmount = format && ownValue(format.prices, item?.size);
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

// Returns the options for a country, or [] if we don't ship there.
export function shippingOptionsFor(country) {
  return ownValue(SHIPPING_RATES, country)?.options ?? [];
}

// obj[key] for the object's own keys only, so "__proto__" etc. can't match.
function ownValue(obj, key) {
  return typeof key === "string" && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

// Picks the requested option, falling back to the country's first one.
export function selectShipping(country, rateId) {
  const options = shippingOptionsFor(country);
  if (options.length === 0) {
    throw new OrderError("we don't ship to this country yet");
  }
  return options.find((o) => o.id === rateId) ?? options[0];
}

export function countryList() {
  return Object.entries(SHIPPING_RATES).map(([code, c]) => ({ code, name: c.name }));
}

// Enough of an address for Stripe Tax to compute an accurate rate.
export function hasTaxableAddress(address) {
  return Boolean(address?.country && address?.postal_code && address?.state);
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
  for (const field of ["line1", "city", "state", "postal_code", "country"]) {
    if (!address[field]) {
      throw new OrderError("please complete your shipping address");
    }
  }
}
