import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FORMATS } from "../src/catalog.js";
import { SHIPPING_RATES } from "../src/shipping.js";
import { OrderError, priceItems, selectShipping, cleanAddress, feesFor } from "../src/pricing.js";
import { SettingsError, defaultSettings, validateSettings } from "../src/settings.js";

const defaults = defaultSettings({});

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

test("every fee has an id, label and a positive percent", () => {
  for (const [country, { fees = [] }] of Object.entries(SHIPPING_RATES)) {
    assert.equal(new Set(fees.map((f) => f.id)).size, fees.length, "duplicate fee id in " + country);
    for (const f of fees) {
      assert.ok(f.id && f.label, "fee in " + country + " needs an id and label");
      assert.ok(typeof f.percent === "number" && f.percent > 0, "fee percent in " + country + " must be a positive number");
    }
  }
});

test("feesFor rounds to the nearest cent", () => {
  assert.deepEqual(feesFor(defaults, "US", 2751), [{ id: "tariffs", label: "tariffs", percent: 50, amount: 1376 }]);
  assert.deepEqual(feesFor(defaults, "CA", 2751), []);
  assert.deepEqual(feesFor(defaults, "__proto__", 2751), []);
});

test("priceItems uses catalog prices and multiplies quantity", () => {
  const [line] = priceItems(defaults, [{ format: "cassette", size: "2x2", quantity: 3, unitAmount: 1 }]);
  assert.equal(line.unitAmount, FORMATS.cassette.prices["2x2"]);
  assert.equal(line.amount, FORMATS.cassette.prices["2x2"] * 3);
});

test("priceItems rejects bad carts", () => {
  assert.throws(() => priceItems(defaults, []), OrderError);
  assert.throws(() => priceItems(defaults, [{ format: "cassette", size: "9x9", quantity: 1 }]), OrderError);
  assert.throws(() => priceItems(defaults, [{ format: "vinyl", size: "1x1", quantity: 1 }]), OrderError);
  assert.throws(() => priceItems(defaults, [{ format: "cassette", size: "1x1", quantity: 0 }]), OrderError);
  assert.throws(() => priceItems(defaults, [{ format: "cassette", size: "1x1", quantity: 1.5 }]), OrderError);
  assert.throws(() => priceItems(defaults, [{ format: "cassette", size: "1x1", quantity: 999 }]), OrderError);
  assert.throws(() => priceItems(defaults, [{ format: "cassette", size: "__proto__", quantity: 1 }]), OrderError);
});

test("selectShipping falls back to the first option and rejects unknown countries", () => {
  assert.equal(selectShipping(defaults, "CA", "nope").id, SHIPPING_RATES.CA.options[0].id);
  assert.equal(selectShipping(defaults, "CA", "express").id, "express");
  assert.throws(() => selectShipping(defaults, "FR"), OrderError);
});

test("cleanAddress keeps only known string fields", () => {
  assert.deepEqual(
    cleanAddress({ line1: " 1 rue ", country: "CA", evil: "x", city: 5 }),
    { line1: "1 rue", country: "CA" },
  );
});

test("validateSettings accepts the defaults unchanged", () => {
  assert.deepEqual(validateSettings(defaults), JSON.parse(JSON.stringify(defaults)));
});

test("validateSettings rejects bad input with a readable message", () => {
  const bad = (change, pattern) => {
    const s = structuredClone(defaults);
    change(s);
    assert.throws(() => validateSettings(s), (err) => err instanceof SettingsError && pattern.test(err.message));
  };
  bad((s) => (s.collectTax = "yes"), /sales tax/);
  bad((s) => (s.prices.cassette["1x1"] = 0), /cassette shelf 1x1: price/);
  bad((s) => (s.prices.cassette["1x1"] = 12.5), /price/);
  bad((s) => (s.prices.cassette["9x9"] = 100), /unknown size/);
  bad((s) => (s.countries = {}), /at least one country/);
  bad((s) => (s.countries.fr = s.countries.CA), /two capital letters/);
  // From JSON (as the dashboard sends it), "__proto__" is a real key.
  bad((s) => (s.countries = JSON.parse('{"__proto__": ' + JSON.stringify(s.countries.CA) + "}")), /two capital letters/);
  bad((s) => (s.countries.CA.name = " "), /needs a name/);
  bad((s) => (s.countries.EU = s.countries.CA), /EU isn't a country code/);
  bad((s) => (s.countries.ZZ = s.countries.CA), /ZZ isn't a country code/);
  bad((s) => (s.countries.CA.options = []), /Canada: add at least one shipping option/);
  bad((s) => (s.countries.CA.options[0].amount = -1), /Canada standard: shipping price/);
  bad((s) => (s.countries.CA.options[1].id = "standard"), /same id/);
  bad((s) => (s.countries.US.fees[0].percent = 0), /United States tariffs: percentage/);
  bad((s) => (s.countries.US.fees[0].percent = "50"), /percentage/);
});

test("validateSettings drops unknown fields and allows removing sizes", () => {
  const s = structuredClone(defaults);
  s.extra = 1;
  s.countries.CA.options[0].hack = "x";
  delete s.prices.cd["6x6"];
  const clean = validateSettings(s);
  assert.equal(clean.extra, undefined);
  assert.equal(clean.countries.CA.options[0].hack, undefined);
  assert.equal(clean.prices.cd["6x6"], undefined);
});

test("a size without a price can't be bought", () => {
  const s = structuredClone(defaults);
  delete s.prices.cassette["2x2"];
  assert.throws(() => priceItems(s, [{ format: "cassette", size: "2x2", quantity: 1 }]), OrderError);
});
