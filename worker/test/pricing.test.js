import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FORMATS } from "../src/catalog.js";
import { SHIPPING_RATES } from "../src/shipping.js";
import { OrderError, priceItems, selectShipping, cleanAddress } from "../src/pricing.js";

// Loads the site's display price tables (plain scripts declaring a const).
function sitePrices(file, name) {
  const source = readFileSync(new URL("../../" + file, import.meta.url), "utf8");
  return new Function(source + "; return " + name)();
}

test("worker catalog matches the prices shown on the site", () => {
  for (const [format, file, name] of [
    ["cassette", "prices.js", "prices"],
    ["cd", "pricesCD.js", "pricesCD"],
  ]) {
    const site = sitePrices(file, name);
    const siteCents = Object.fromEntries(
      Object.entries(site).map(([k, v]) => [k, Math.round(v * 100)]),
    );
    assert.deepEqual(FORMATS[format].prices, siteCents, format + " prices differ from " + file);
  }
});

test("every shipping option has an id, label and integer amount", () => {
  for (const [country, { name, options }] of Object.entries(SHIPPING_RATES)) {
    assert.match(country, /^[A-Z]{2}$/);
    assert.ok(name);
    assert.ok(options.length > 0);
    assert.equal(new Set(options.map((o) => o.id)).size, options.length, "duplicate id in " + country);
    for (const o of options) {
      assert.ok(o.id && o.label);
      assert.ok(Number.isInteger(o.amount) && o.amount >= 0);
    }
  }
});

test("priceItems uses catalog prices and multiplies quantity", () => {
  const [line] = priceItems([{ format: "cassette", size: "2x2", quantity: 3, unitAmount: 1 }]);
  assert.equal(line.unitAmount, FORMATS.cassette.prices["2x2"]);
  assert.equal(line.amount, FORMATS.cassette.prices["2x2"] * 3);
});

test("priceItems rejects bad carts", () => {
  assert.throws(() => priceItems([]), OrderError);
  assert.throws(() => priceItems([{ format: "cassette", size: "9x9", quantity: 1 }]), OrderError);
  assert.throws(() => priceItems([{ format: "vinyl", size: "1x1", quantity: 1 }]), OrderError);
  assert.throws(() => priceItems([{ format: "cassette", size: "1x1", quantity: 0 }]), OrderError);
  assert.throws(() => priceItems([{ format: "cassette", size: "1x1", quantity: 1.5 }]), OrderError);
  assert.throws(() => priceItems([{ format: "cassette", size: "1x1", quantity: 999 }]), OrderError);
  assert.throws(() => priceItems([{ format: "cassette", size: "__proto__", quantity: 1 }]), OrderError);
});

test("selectShipping falls back to the first option and rejects unknown countries", () => {
  assert.equal(selectShipping("CA", "nope").id, SHIPPING_RATES.CA.options[0].id);
  assert.equal(selectShipping("CA", "express").id, "express");
  assert.throws(() => selectShipping("FR"), OrderError);
});

test("cleanAddress keeps only known string fields", () => {
  assert.deepEqual(
    cleanAddress({ line1: " 1 rue ", country: "CA", evil: "x", city: 5 }),
    { line1: "1 rue", country: "CA" },
  );
});
