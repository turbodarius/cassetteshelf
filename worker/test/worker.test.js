// Runs the worker's fetch handler end to end with Stripe's HTTP API
// replaced by a fake (the Stripe SDK sends its requests through the
// global fetch), so no Stripe account or network is needed.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import worker from "../src/index.js";
import { FORMATS } from "../src/catalog.js";
import { SHIPPING_RATES } from "../src/shipping.js";

const env = {
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_fake",
  STRIPE_PUBLISHABLE_KEY: "pk_test_fake",
  ALLOWED_ORIGINS: "https://cassetteshelf.com",
  COLLECT_TAX: "true",
};
const noTaxEnv = { ...env, COLLECT_TAX: "false" };

const ORIGIN = "https://cassetteshelf.com";
const ADDRESS = {
  line1: "1 rue Example",
  city: "Montréal",
  state: "QC",
  postal_code: "H2X 1Y4",
  country: "CA",
};

let stripeCalls;
let realFetch;
let taxFails;

beforeEach(() => {
  stripeCalls = [];
  taxFails = false;
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const params = new URLSearchParams(init.body ?? "");
    stripeCalls.push({ path, params, headers: init.headers });
    const respond = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", "request-id": "req_fake" },
      });

    if (path === "/v1/tax/calculations") {
      if (taxFails) {
        return respond({ error: { type: "invalid_request_error", message: "bad address" } }, 400);
      }
      let lines = 0;
      for (const [key, value] of params) {
        if (/^line_items\[\d+\]\[amount\]$/.test(key)) lines += Number(value);
      }
      const shipping = Number(params.get("shipping_cost[amount]"));
      const tax = Math.round((lines + shipping) * 0.14975);
      return respond({
        id: "taxcalc_fake",
        tax_amount_exclusive: tax,
        amount_total: lines + shipping + tax,
      });
    }
    if (path === "/v1/payment_intents") {
      return respond({ id: "pi_fake", client_secret: "pi_fake_secret_x", amount: Number(params.get("amount")) });
    }
    if (path === "/v1/tax/transactions/create_from_calculation") {
      return respond({ id: "tax_txn_fake" });
    }
    return respond({ error: { type: "invalid_request_error", message: "unexpected " + path } }, 404);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function call(path, { method = "POST", body, headers = {}, workerEnv = env } = {}) {
  return worker.fetch(
    new Request("https://worker.example" + path, {
      method,
      headers: { origin: ORIGIN, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    workerEnv,
  );
}

const cart = [
  { format: "cassette", size: "2x2", quantity: 2 },
  { format: "cassette", size: "1x1", quantity: 1 },
];
const subtotal = FORMATS.cassette.prices["2x2"] * 2 + FORMATS.cassette.prices["1x1"];

test("GET /config returns key and countries with CORS for allowed origin", async () => {
  const res = await call("/config", { method: "GET" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
  const body = await res.json();
  assert.equal(body.publishableKey, "pk_test_fake");
  assert.deepEqual(body.countries.map((c) => c.code), ["CA", "US"]);
});

test("unknown origins get no CORS header", async () => {
  const res = await call("/config", { method: "GET", headers: { origin: "https://evil.example" } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("quote without an address: subtotal only, no Stripe call", async () => {
  const body = await (await call("/quote", { body: { items: cart } })).json();
  assert.equal(body.subtotal, subtotal);
  assert.equal(body.total, null);
  assert.deepEqual(body.shippingOptions, []);
  assert.equal(stripeCalls.length, 0);
});

test("quote with only a country: shipping options, no tax yet", async () => {
  const body = await (await call("/quote", {
    body: { items: cart, address: { country: "CA" }, shippingRateId: "express" },
  })).json();
  assert.equal(body.shippingOptions.length, 2);
  assert.equal(body.shippingRateId, "express");
  assert.equal(body.shipping, 3000);
  assert.equal(body.tax, null);
  assert.equal(stripeCalls.length, 0);
});

test("quote with full address calculates tax on items + shipping", async () => {
  const body = await (await call("/quote", {
    body: { items: cart, address: ADDRESS, shippingRateId: "standard" },
  })).json();
  const expectedTax = Math.round((subtotal + 1500) * 0.14975);
  assert.equal(body.tax, expectedTax);
  assert.equal(body.total, subtotal + 1500 + expectedTax);

  const [calc] = stripeCalls;
  assert.equal(calc.path, "/v1/tax/calculations");
  assert.equal(calc.params.get("customer_details[address][state]"), "QC");
  assert.equal(calc.params.get("line_items[0][tax_behavior]"), "exclusive");
});

test("quote reports a tax error instead of failing on a bad address", async () => {
  taxFails = true;
  const res = await call("/quote", { body: { items: cart, address: ADDRESS } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tax, null);
  assert.ok(body.taxError);
});

test("quote rejects countries without shipping rates", async () => {
  const res = await call("/quote", { body: { items: cart, address: { country: "FR" } } });
  assert.equal(res.status, 400);
});

test("client-sent prices are ignored", async () => {
  const body = await (await call("/quote", {
    body: { items: [{ format: "cassette", size: "6x6", quantity: 1, unitAmount: 1, amount: 1 }] },
  })).json();
  assert.equal(body.subtotal, FORMATS.cassette.prices["6x6"]);
});

test("checkout creates a PaymentIntent for the server-calculated total", async () => {
  const res = await call("/checkout", {
    body: { items: cart, address: ADDRESS, shippingRateId: "standard", name: "Test Person", email: "t@example.com" },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.clientSecret, "pi_fake_secret_x");

  const pi = stripeCalls.find((c) => c.path === "/v1/payment_intents");
  assert.equal(Number(pi.params.get("amount")), body.quote.total);
  assert.equal(pi.params.get("currency"), "cad");
  assert.equal(pi.params.get("metadata[tax_calculation]"), "taxcalc_fake");
  assert.equal(pi.params.get("metadata[items]"), "cassette:2x2:2,cassette:1x1:1");
  assert.equal(pi.params.get("shipping[address][postal_code]"), "H2X 1Y4");
  assert.equal(pi.params.get("receipt_email"), "t@example.com");
});

test("checkout refuses incomplete details or untaxable addresses", async () => {
  let res = await call("/checkout", { body: { items: cart, address: ADDRESS, name: "", email: "t@example.com" } });
  assert.equal(res.status, 400);

  res = await call("/checkout", { body: { items: cart, address: { country: "CA" }, name: "A", email: "t@example.com" } });
  assert.equal(res.status, 400);

  taxFails = true;
  res = await call("/checkout", { body: { items: cart, address: ADDRESS, name: "A", email: "t@example.com" } });
  assert.equal(res.status, 400);
  assert.ok(!stripeCalls.some((c) => c.path === "/v1/payment_intents"));
});

test("webhook verifies the signature and records the tax transaction", async () => {
  const payload = JSON.stringify({
    id: "evt_1",
    object: "event",
    type: "payment_intent.succeeded",
    data: { object: { id: "pi_fake", metadata: { tax_calculation: "taxcalc_fake", items: "cassette:1x1:1" } } },
  });
  const stripe = new Stripe("sk_test_fake");

  const bad = await worker.fetch(new Request("https://worker.example/webhook", {
    method: "POST", body: payload, headers: { "stripe-signature": "t=1,v1=nope" },
  }), env);
  assert.equal(bad.status, 400);
  assert.equal(stripeCalls.length, 0);

  const signature = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: env.STRIPE_WEBHOOK_SECRET });
  const good = await worker.fetch(new Request("https://worker.example/webhook", {
    method: "POST", body: payload, headers: { "stripe-signature": signature },
  }), env);
  assert.equal(good.status, 200);

  const txn = stripeCalls.find((c) => c.path === "/v1/tax/transactions/create_from_calculation");
  assert.equal(txn.params.get("calculation"), "taxcalc_fake");
  assert.equal(txn.params.get("reference"), "pi_fake");
});

test("tax off: config says so and quotes are items + shipping, without Stripe Tax", async () => {
  const config = await (await call("/config", { method: "GET", workerEnv: noTaxEnv })).json();
  assert.equal(config.taxEnabled, false);

  const body = await (await call("/quote", {
    body: { items: cart, address: ADDRESS, shippingRateId: "express" },
    workerEnv: noTaxEnv,
  })).json();
  assert.equal(body.tax, 0);
  assert.equal(body.total, subtotal + 3000);

  // A country alone is enough for a total when there's no tax.
  const countryOnly = await (await call("/quote", {
    body: { items: cart, address: { country: "US" } },
    workerEnv: noTaxEnv,
  })).json();
  // US: standard shipping + 50% tariffs on the items.
  assert.equal(countryOnly.total, subtotal + 2500 + Math.round(subtotal * 0.5));
  assert.equal(stripeCalls.length, 0);
});

test("tax off: checkout charges items + shipping with no tax calculation", async () => {
  const res = await call("/checkout", {
    body: { items: cart, address: ADDRESS, shippingRateId: "standard", name: "A", email: "t@example.com" },
    workerEnv: noTaxEnv,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(stripeCalls.map((c) => c.path), ["/v1/payment_intents"]);
  const pi = stripeCalls[0].params;
  assert.equal(Number(pi.get("amount")), subtotal + 1500);
  assert.equal(pi.get("metadata[tax_amount]"), "0");
  assert.equal(pi.get("metadata[tax_calculation]"), null);

  // Address is still required for shipping.
  const incomplete = await call("/checkout", {
    body: { items: cart, address: { country: "CA" }, name: "A", email: "t@example.com" },
    workerEnv: noTaxEnv,
  });
  assert.equal(incomplete.status, 400);
});

test("default (COLLECT_TAX unset) is no tax", async () => {
  const { COLLECT_TAX, ...unset } = env;
  const config = await (await call("/config", { method: "GET", workerEnv: unset })).json();
  assert.equal(config.taxEnabled, false);
});

test("countries without provinces/states (e.g. a newly added FR) can check out", async () => {
  SHIPPING_RATES.FR = { name: "France", options: [{ id: "standard", label: "standard", amount: 4000 }] };
  try {
    const address = { line1: "1 rue de Rivoli", city: "Paris", postal_code: "75001", country: "FR" };
    const res = await call("/checkout", {
      body: { items: cart, address, name: "A", email: "t@example.com" },
      workerEnv: noTaxEnv,
    });
    assert.equal(res.status, 200);
    const pi = stripeCalls.find((c) => c.path === "/v1/payment_intents").params;
    assert.equal(Number(pi.get("amount")), subtotal + 4000);

    // CA/US still require one.
    const noState = await call("/checkout", {
      body: { items: cart, address: { ...ADDRESS, state: undefined }, name: "A", email: "t@example.com" },
      workerEnv: noTaxEnv,
    });
    assert.equal(noState.status, 400);
  } finally {
    delete SHIPPING_RATES.FR;
  }
});

const US_ADDRESS = { line1: "1 Main St", city: "Albany", state: "NY", postal_code: "12207", country: "US" };

test("fees: US quote adds 50% tariffs on the items, not on shipping", async () => {
  const body = await (await call("/quote", { body: { items: cart, address: US_ADDRESS }, workerEnv: noTaxEnv })).json();
  const tariff = Math.round(subtotal * 0.5);
  assert.deepEqual(body.fees, [{ id: "tariffs", label: "tariffs", percent: 50, amount: tariff }]);
  assert.equal(body.total, subtotal + 2500 + tariff);
});

test("fees: countries without fees get none", async () => {
  const body = await (await call("/quote", { body: { items: cart, address: ADDRESS }, workerEnv: noTaxEnv })).json();
  assert.deepEqual(body.fees, []);
  assert.equal(body.total, subtotal + 1500);
});

test("fees: checkout charges them and records them on the payment", async () => {
  const res = await call("/checkout", {
    body: { items: cart, address: US_ADDRESS, name: "A", email: "t@example.com" },
    workerEnv: noTaxEnv,
  });
  assert.equal(res.status, 200);
  const tariff = Math.round(subtotal * 0.5);
  const pi = stripeCalls.find((c) => c.path === "/v1/payment_intents").params;
  assert.equal(Number(pi.get("amount")), subtotal + 2500 + tariff);
  assert.equal(pi.get("metadata[fees]"), "tariffs:" + tariff);
});

test("fees: with tax on, fees are part of the taxed amount", async () => {
  const body = await (await call("/quote", { body: { items: cart, address: US_ADDRESS } })).json();
  const tariff = Math.round(subtotal * 0.5);
  const calc = stripeCalls.find((c) => c.path === "/v1/tax/calculations").params;
  assert.equal(calc.get("line_items[2][reference]"), "fee:tariffs");
  assert.equal(Number(calc.get("line_items[2][amount]")), tariff);
  const tax = Math.round((subtotal + tariff + 2500) * 0.14975);
  assert.equal(body.tax, tax);
  assert.equal(body.total, subtotal + tariff + 2500 + tax);
});

// ---- Admin dashboard API ----

function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

const PASSWORD = "correct horse battery staple";
const adminEnv = () => ({ ...noTaxEnv, ADMIN_TOKEN: PASSWORD, SETTINGS: fakeKV() });
const admin = (workerEnv, { method = "GET", body, password = PASSWORD } = {}) =>
  call("/admin/settings", {
    method,
    body,
    workerEnv,
    headers: password === null ? {} : { authorization: "Bearer " + password },
  });

test("admin: password required, wrong password rejected, unset password disables it", async () => {
  const env = adminEnv();
  assert.equal((await admin(env, { password: null })).status, 401);
  assert.equal((await admin(env, { password: "nope" })).status, 401);
  assert.equal((await admin(env, { password: PASSWORD + "x" })).status, 401);
  assert.equal((await admin({ ...env, ADMIN_TOKEN: undefined })).status, 503);
  const ok = await admin(env);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.updatedAt, null);
  assert.equal(body.settings.prices.cassette["1x1"], FORMATS.cassette.prices["1x1"]);
  assert.equal(body.sizes.length, 36);
  assert.equal(body.storageReady, true);
});

test("admin: CORS lets the dashboard send its password and save", async () => {
  const res = await call("/admin/settings", { method: "OPTIONS", workerEnv: adminEnv() });
  assert.match(res.headers.get("access-control-allow-headers"), /Authorization/);
  assert.match(res.headers.get("access-control-allow-methods"), /PUT/);
});

test("admin: saved settings drive /config, quotes and payments", async () => {
  const env = adminEnv();
  const { settings } = await (await admin(env)).json();
  settings.prices.cassette["1x1"] = 3000;
  delete settings.prices.cassette["2x2"];
  settings.countries.FR = {
    name: "France",
    fees: [{ id: "duties", label: "duties", percent: 20 }],
    options: [{ id: "standard", label: "standard", amount: 4000 }],
  };
  settings.countries.US.fees = [];
  const save = await admin(env, { method: "PUT", body: { settings, updatedAt: null } });
  assert.equal(save.status, 200);
  assert.ok((await save.json()).updatedAt);

  const config = await (await call("/config", { method: "GET", workerEnv: env })).json();
  assert.deepEqual(config.countries.map((c) => c.code), ["CA", "US", "FR"]);
  assert.equal(config.prices.cassette["1x1"], 3000);
  assert.equal(config.prices.cassette["2x2"], undefined);

  const one = [{ format: "cassette", size: "1x1", quantity: 1 }];
  const fr = await (await call("/quote", {
    body: { items: one, address: { country: "FR" } }, workerEnv: env,
  })).json();
  assert.equal(fr.total, 3000 + 4000 + 600);

  const us = await (await call("/quote", { body: { items: one, address: { country: "US" } }, workerEnv: env })).json();
  assert.deepEqual(us.fees, []);

  const gone = await call("/quote", { body: { items: [{ format: "cassette", size: "2x2", quantity: 1 }] }, workerEnv: env });
  assert.equal(gone.status, 400);
});

test("admin: the tax switch is a setting", async () => {
  const env = adminEnv();
  const { settings } = await (await admin(env)).json();
  settings.collectTax = true;
  await admin(env, { method: "PUT", body: { settings, updatedAt: null } });
  const config = await (await call("/config", { method: "GET", workerEnv: env })).json();
  assert.equal(config.taxEnabled, true);
  await call("/quote", { body: { items: cart, address: ADDRESS }, workerEnv: env });
  assert.ok(stripeCalls.some((c) => c.path === "/v1/tax/calculations"));
});

test("admin: invalid settings are refused with a message and nothing is saved", async () => {
  const env = adminEnv();
  const { settings } = await (await admin(env)).json();
  settings.countries.CA.options = [];
  const res = await admin(env, { method: "PUT", body: { settings, updatedAt: null } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Canada: add at least one shipping option/);
  assert.equal(env.SETTINGS.store.size, 0);
});

test("admin: a stale save doesn't overwrite a newer one", async () => {
  const env = adminEnv();
  const { settings } = await (await admin(env)).json();
  const first = await (await admin(env, { method: "PUT", body: { settings, updatedAt: null } })).json();
  // A second tab still thinks nothing was saved yet.
  const stale = await admin(env, { method: "PUT", body: { settings, updatedAt: null } });
  assert.equal(stale.status, 409);
  const fresh = await admin(env, { method: "PUT", body: { settings, updatedAt: first.updatedAt } });
  assert.equal(fresh.status, 200);
});

test("admin: saving without storage set up explains why", async () => {
  const env = { ...adminEnv(), SETTINGS: undefined };
  const { settings } = await (await admin(env)).json();
  const res = await admin(env, { method: "PUT", body: { settings, updatedAt: null } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /storage isn't set up/);
});
