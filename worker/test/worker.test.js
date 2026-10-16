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
let emails, resendStatus;
let savedMetadata; // metadata updates kept between calls, like Stripe

beforeEach(() => {
  stripeCalls = [];
  taxFails = false;
  emails = [];
  resendStatus = 200;
  savedMetadata = {};
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (new URL(url).hostname === "api.resend.com") {
      emails.push({ body: JSON.parse(init.body), key: init.headers["Idempotency-Key"] });
      const error = { message: "The cassetteshelf.com domain is not verified. Please, add and verify your domain." };
      return new Response(JSON.stringify(resendStatus === 200 ? { id: "email_1" } : error), { status: resendStatus });
    }
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
    const piPath = path.match(/^\/v1\/payment_intents\/(pi_[A-Za-z0-9_]+)$/);
    if (piPath) {
      const pi = structuredClone(SEARCH_PAGE_1.data.find((p) => p.id === piPath[1]) ?? null);
      if (!pi) return respond({ error: { type: "invalid_request_error", message: "No such payment_intent" } }, 404);
      pi.status = piPath[1] === "pi_live2" ? "requires_payment_method" : "succeeded";
      const saved = (savedMetadata[pi.id] ??= {});
      if (init.method === "POST") {
        for (const [key, value] of params) {
          const m = key.match(/^metadata\[(.+)\]$/);
          if (m) saved[m[1]] = value;
        }
      }
      for (const [key, value] of Object.entries(saved)) value === "" ? delete pi.metadata[key] : (pi.metadata[key] = value);
      return respond(pi);
    }
    if (path === "/v1/payment_intents/search") {
      const query = new URL(url).searchParams;
      stripeCalls[stripeCalls.length - 1].params = query;
      return respond(query.get("page") ? SEARCH_PAGE_2 : SEARCH_PAGE_1);
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

// ---- Orders tab ----

const SEARCH_PAGE_1 = {
  object: "search_result",
  data: [
    {
      id: "pi_live1", object: "payment_intent", created: 1760000000, amount: 6627, amount_received: 6627,
      currency: "cad", livemode: true, receipt_email: "buyer@example.com",
      shipping: { name: "Pat Buyer", phone: "+1 555 0100", address: { line1: "1 Main St", line2: "Apt 2", city: "Albany", state: "NY", postal_code: "12207", country: "US" } },
      metadata: { items: "cassette:1x1:1", shipping_rate: "standard", shipping_amount: "2500", fees: "tariffs:1376", tax_amount: "0" },
      latest_charge: { amount_refunded: 0, payment_method_details: { type: "card", card: { brand: "visa", last4: "4242", wallet: null } } },
    },
    {
      id: "pi_live2", object: "payment_intent", created: 1759990000, amount: 20000, amount_received: 20000,
      currency: "cad", livemode: false, receipt_email: null,
      shipping: { name: "Sam", address: { line1: "2 rue X", city: "Montréal", state: "QC", postal_code: "H2X 1Y4", country: "CA" } },
      metadata: { items: "cassette:2x2:2,cd:1x1:1", shipping_rate: "express", shipping_amount: "3000", tax_amount: "1500" },
      latest_charge: { amount_refunded: 5000, billing_details: { email: "sam@example.com" }, payment_method_details: { type: "card", card: { brand: "mastercard", last4: "4444", wallet: { type: "apple_pay" } } } },
    },
  ],
  has_more: true,
  next_page: "page_token_2",
};
const SEARCH_PAGE_2 = { object: "search_result", data: [], has_more: false, next_page: null };

test("orders: password required", async () => {
  const res = await call("/admin/orders", { method: "GET", workerEnv: adminEnv(), headers: { authorization: "Bearer nope" } });
  assert.equal(res.status, 401);
  assert.equal(stripeCalls.length, 0);
});

test("orders: paid payments from Stripe, newest first, with everything needed to ship", async () => {
  const res = await call("/admin/orders", { method: "GET", workerEnv: adminEnv(), headers: { authorization: "Bearer " + PASSWORD } });
  assert.equal(res.status, 200);
  const { orders, nextPage } = await res.json();

  const search = stripeCalls.find((c) => c.path === "/v1/payment_intents/search").params;
  assert.equal(search.get("query"), 'status:"succeeded"');
  assert.equal(search.get("expand[0]"), "data.latest_charge");
  assert.equal(nextPage, "page_token_2");

  const [us, ca] = orders;
  assert.deepEqual(us, {
    id: "pi_live1",
    created: "2025-10-09T08:53:20.000Z",
    total: 6627,
    currency: "cad",
    refunded: 0,
    status: "paid",
    customer: { name: "Pat Buyer", email: "buyer@example.com", phone: "+1 555 0100" },
    address: { line1: "1 Main St", line2: "Apt 2", city: "Albany", state: "NY", postal_code: "12207", country: "US" },
    items: [{ format: "cassette", size: "1x1", quantity: 1, label: "1x1 cassette shelf" }],
    shipping: { option: "standard", amount: 2500 },
    fees: [{ id: "tariffs", amount: 1376 }],
    tax: 0,
    paymentMethod: "Visa •••• 4242",
    shipment: null,
    stripeUrl: "https://dashboard.stripe.com/payments/pi_live1",
  });

  assert.equal(ca.status, "partially refunded");
  assert.equal(ca.refunded, 5000);
  assert.equal(ca.customer.email, "sam@example.com");
  assert.deepEqual(ca.items.map((i) => i.label + " x" + i.quantity), ["2x2 cassette shelf x2", "1x1 cd shelf x1"]);
  assert.equal(ca.paymentMethod, "Mastercard •••• 4444 (Apple Pay)");
  assert.equal(ca.stripeUrl, "https://dashboard.stripe.com/test/payments/pi_live2");
});

test("orders: next page is passed through to Stripe", async () => {
  const res = await call("/admin/orders?page=page_token_2", { method: "GET", workerEnv: adminEnv(), headers: { authorization: "Bearer " + PASSWORD } });
  const body = await res.json();
  assert.equal(stripeCalls.find((c) => c.path === "/v1/payment_intents/search").params.get("page"), "page_token_2");
  assert.deepEqual(body.orders, []);
  assert.equal(body.nextPage, null);
});

// ---- Mark as shipped ----

const ship = (id, method, body, password = PASSWORD) =>
  call("/admin/orders/" + id + "/shipment", { method, body, workerEnv: adminEnv(), headers: { authorization: "Bearer " + password } });

test("shipping: marking an order shipped stores carrier + tracking on the payment", async () => {
  const res = await ship("pi_live1", "PUT", { carrier: "canada-post", tracking: " 1234 5678\u0007 " });
  assert.equal(res.status, 200);
  const { order, email } = await res.json();
  assert.equal(email, null, "no email unless asked");
  const update = stripeCalls.find((c) => c.path === "/v1/payment_intents/pi_live1" && c.params.get("metadata[carrier]"));
  assert.equal(update.params.get("metadata[carrier]"), "canada-post");
  assert.equal(update.params.get("metadata[tracking_number]"), "1234 5678");
  assert.match(update.params.get("metadata[shipped_at]"), /^\d{4}-\d\d-\d\dT/);
  assert.equal(update.params.get("expand[0]"), "latest_charge");
  assert.equal(order.shipment.carrierName, "Canada Post");
  assert.equal(order.shipment.tracking, "1234 5678");
  assert.equal(order.shipment.trackingUrl, "https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=1234%205678");
  assert.equal(order.items[0].label, "1x1 cassette shelf");
});

test("shipping: no tracking number, or 'other' carrier, means no tracking link", async () => {
  const { order: a } = await (await ship("pi_live1", "PUT", { carrier: "ups" })).json();
  assert.equal(a.shipment.trackingUrl, null);
  const { order: b } = await (await ship("pi_live1", "PUT", { carrier: "other", tracking: "ABC" })).json();
  assert.equal(b.shipment.carrierName, "Other");
  assert.equal(b.shipment.trackingUrl, null);
});

test("shipping: undo clears it", async () => {
  const res = await ship("pi_live1", "DELETE");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).order.shipment, null);
  const update = stripeCalls.find((c) => c.path === "/v1/payment_intents/pi_live1" && c.params.has("metadata[shipped_at]"));
  assert.equal(update.params.get("metadata[shipped_at]"), "");
  assert.equal(update.params.get("metadata[shipping_email_sent_at]"), "");
});

test("shipping: refuses bad requests", async () => {
  assert.equal((await ship("pi_live1", "PUT", { carrier: "pigeon" })).status, 400);
  assert.equal((await ship("not-an-id", "PUT", { carrier: "ups" })).status, 400);
  assert.equal((await ship("pi_live2", "PUT", { carrier: "ups" })).status, 400, "unpaid payment");
  assert.equal((await ship("pi_live1", "PUT", { carrier: "ups" }, "wrong")).status, 401);
  assert.ok(!stripeCalls.some((c) => c.path === "/v1/payment_intents/pi_live1" && c.params.get("metadata[carrier]") === "pigeon"));
});

test("orders: shipped orders say so; the list includes the carrier choices", async () => {
  SEARCH_PAGE_1.data[0].metadata = { ...SEARCH_PAGE_1.data[0].metadata, shipped_at: "2026-10-10T12:00:00.000Z", carrier: "usps", tracking_number: "9400" };
  try {
    const body = await (await call("/admin/orders", { method: "GET", workerEnv: adminEnv(), headers: { authorization: "Bearer " + PASSWORD } })).json();
    assert.deepEqual(body.orders[0].shipment, {
      at: "2026-10-10T12:00:00.000Z", carrier: "usps", carrierName: "USPS", tracking: "9400",
      trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400", emailedAt: null,
    });
    assert.equal(body.orders[1].shipment, null);
    assert.equal(body.carriers["canada-post"], "Canada Post");
  } finally {
    for (const k of ["shipped_at", "carrier", "tracking_number"]) delete SEARCH_PAGE_1.data[0].metadata[k];
  }
});

// ---- Shipping emails to customers ----

const emailEnv = () => ({ ...adminEnv(), RESEND_API_KEY: "re_test", ORDER_EMAIL_TO: "contact@cassetteshelf.com", CUSTOMER_EMAIL_FROM: "cassetteshelf <orders@cassetteshelf.com>" });
const adminPost = (path, workerEnv = emailEnv()) =>
  call(path, { method: "POST", workerEnv, headers: { authorization: "Bearer " + PASSWORD } });

test("shipping email: marking shipped with notify emails the customer and records it", async () => {
  const res = await call("/admin/orders/pi_live1/shipment", {
    method: "PUT", body: { carrier: "usps", tracking: "9400", notify: true }, workerEnv: emailEnv(),
    headers: { authorization: "Bearer " + PASSWORD },
  });
  assert.equal(res.status, 200);
  const { order, email } = await res.json();
  assert.deepEqual(email, { sent: true, to: "buyer@example.com" });
  assert.match(order.shipment.emailedAt, /^\d{4}-\d\d-\d\dT/);

  assert.equal(emails.length, 1);
  const sent = emails[0].body;
  assert.equal(sent.from, "cassetteshelf <orders@cassetteshelf.com>");
  assert.deepEqual(sent.to, ["buyer@example.com"]);
  assert.equal(sent.reply_to, "contact@cassetteshelf.com");
  assert.equal(sent.subject, "Your cassetteshelf order is on its way");
  assert.match(sent.text, /Hi Pat,/);
  assert.match(sent.text, /shipped with USPS/);
  assert.match(sent.text, /Tracking number: 9400/);
  assert.match(sent.text, /tLabels=9400/);
  assert.match(sent.text, /1 × 1x1 cassette shelf/);
  assert.match(sent.text, /Albany NY 12207\nUnited States/);
  assert.match(emails[0].key, /^shipping-email-pi_live1-.+-first$/);
});

test("shipping email: if the email fails, the order is still marked shipped", async () => {
  resendStatus = 403;
  const res = await call("/admin/orders/pi_live1/shipment", {
    method: "PUT", body: { carrier: "ups", notify: true }, workerEnv: emailEnv(),
    headers: { authorization: "Bearer " + PASSWORD },
  });
  assert.equal(res.status, 200);
  const { order, email } = await res.json();
  assert.equal(order.shipment.carrierName, "UPS");
  assert.equal(order.shipment.emailedAt, null);
  assert.equal(email.sent, false);
  assert.match(email.error, /verify cassetteshelf\.com in Resend/);
  assert.ok(!stripeCalls.some((c) => c.params.has("metadata[shipping_email_sent_at]")));
});

test("shipping email: not set up, or no customer address, is reported", async () => {
  const notSetUp = await call("/admin/orders/pi_live1/shipment", {
    method: "PUT", body: { carrier: "ups", notify: true }, workerEnv: adminEnv(),
    headers: { authorization: "Bearer " + PASSWORD },
  });
  assert.match((await notSetUp.json()).email.error, /CUSTOMER_EMAIL_FROM/);

  const pi = SEARCH_PAGE_1.data[0];
  const saved = pi.receipt_email;
  pi.receipt_email = null;
  try {
    const res = await call("/admin/orders/pi_live1/shipment", {
      method: "PUT", body: { carrier: "ups", notify: true }, workerEnv: emailEnv(),
      headers: { authorization: "Bearer " + PASSWORD },
    });
    assert.match((await res.json()).email.error, /no customer email/);
  } finally {
    pi.receipt_email = saved;
  }
  assert.equal(emails.length, 0);
});

test("shipping email: send again from the order (only once shipped)", async () => {
  assert.equal((await adminPost("/admin/orders/pi_live1/shipping-email")).status, 400, "not shipped yet");
  assert.equal((await adminPost("/admin/orders/pi_live2/shipping-email")).status, 400, "unpaid");
  assert.equal((await adminPost("/admin/orders/nope/shipping-email")).status, 400);
  assert.equal(emails.length, 0);

  const pi = SEARCH_PAGE_1.data[0];
  pi.metadata = { ...pi.metadata, shipped_at: "2026-10-10T12:00:00.000Z", carrier: "canada-post", tracking_number: "1234", shipping_email_sent_at: "2026-10-10T12:01:00.000Z" };
  try {
    const res = await adminPost("/admin/orders/pi_live1/shipping-email");
    assert.equal(res.status, 200);
    const { order, email } = await res.json();
    assert.equal(email.sent, true);
    assert.notEqual(order.shipment.emailedAt, "2026-10-10T12:01:00.000Z");
    assert.equal(emails[0].key, "shipping-email-pi_live1-2026-10-10T12:00:00.000Z-2026-10-10T12:01:00.000Z");
    assert.match(emails[0].body.text, /shipped with Canada Post/);
  } finally {
    for (const k of ["shipped_at", "carrier", "tracking_number", "shipping_email_sent_at"]) delete pi.metadata[k];
  }
});

test("shipping email: test email goes to the shop; settings report the sender", async () => {
  const res = await adminPost("/admin/test-shipping-email");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sentTo: "contact@cassetteshelf.com" });
  assert.deepEqual(emails[0].body.to, ["contact@cassetteshelf.com"]);
  assert.match(emails[0].body.text, /Tracking number: 1234567890123456/);

  resendStatus = 403;
  const failed = await adminPost("/admin/test-shipping-email");
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /Resend → Domains/);

  assert.equal((await call("/admin/test-shipping-email", { method: "POST", workerEnv: emailEnv(), headers: { authorization: "Bearer x" } })).status, 401);

  const settings = await (await admin(emailEnv())).json();
  assert.deepEqual(settings.customerEmail, { from: "cassetteshelf <orders@cassetteshelf.com>", ready: true });
  assert.equal((await (await admin(adminEnv())).json()).customerEmail.ready, false);
});

test("shipping email: names and addresses are escaped in the HTML", async () => {
  const pi = SEARCH_PAGE_1.data[0];
  const saved = pi.shipping.name;
  pi.shipping.name = "<b>Pat</b> Buyer";
  try {
    await call("/admin/orders/pi_live1/shipment", {
      method: "PUT", body: { carrier: "usps", tracking: "<x>", notify: true }, workerEnv: emailEnv(),
      headers: { authorization: "Bearer " + PASSWORD },
    });
  } finally {
    pi.shipping.name = saved;
  }
  const html = emails[0].body.html;
  assert.ok(!html.includes("<b>Pat"));
  assert.ok(html.includes("&lt;b&gt;Pat&lt;/b&gt;"));
  assert.ok(html.includes("&lt;x&gt;"));
  assert.ok(html.includes("tLabels=%3Cx%3E"));
});

// ---- Imported Shopify orders ----

const legacyOrder = (number, created, extra = {}) => ({
  number, shopifyId: "6821181620421", created, currency: "CAD", total: 12563, refunded: 0, tax: 0,
  financialStatus: "paid",
  customer: { name: "Test Customer", email: "t@example.com", phone: "+1 555 0100" },
  address: { line1: "1 Test St", line2: "", city: "Testville", state: "QC", postal_code: "H0H 0H0", country: "CA" },
  items: [{ quantity: 1, label: "cassetteshelf - 2 / 2" }],
  shipping: { option: "Standard", amount: 5107 },
  paymentMethod: "Shopify Payments",
  fulfilledAt: "2026-09-06T19:35:17.000Z",
  ...extra,
});
const legacy = (env, method, body) => call("/admin/legacy-orders", { method, body, workerEnv: env, headers: { authorization: "Bearer " + PASSWORD } });

test("legacy orders: import, list (newest first), re-import without duplicates, remove", async () => {
  const env = adminEnv();
  let res = await legacy(env, "PUT", { orders: [legacyOrder("#1002", "2026-09-06T14:11:26.000Z"), legacyOrder("#1003", "2026-09-15 10:13:21 -0400")] });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.imported, 2);
  assert.deepEqual(body.orders.map((o) => o.number), ["#1003", "#1002"]);

  const first = body.orders[1];
  assert.equal(first.id, "shopify-1002");
  assert.equal(first.source, "shopify");
  assert.equal(first.status, "paid");
  assert.equal(first.total, 12563);
  assert.equal(first.shipment.at, "2026-09-06T19:35:17.000Z");
  assert.equal(first.stripeUrl, "https://admin.shopify.com/store/cassetteshelf-com/orders/6821181620421");
  assert.equal(body.orders[0].created, "2026-09-15T14:13:21.000Z");

  res = await legacy(env, "PUT", { orders: [legacyOrder("#1002", "2026-09-06T14:11:26.000Z", { refunded: 100, financialStatus: "partially_refunded" })] });
  body = await res.json();
  assert.equal(body.orders.length, 2, "same order number replaces, doesn't duplicate");
  assert.equal(body.orders[1].status, "partially refunded");

  assert.equal((await (await legacy(env, "GET")).json()).orders.length, 2);
  await legacy(env, "DELETE");
  assert.deepEqual((await (await legacy(env, "GET")).json()).orders, []);
});

test("legacy orders: bad data is refused, password required, never in /config", async () => {
  const env = adminEnv();
  assert.equal((await legacy(env, "PUT", { orders: [] })).status, 400);
  assert.equal((await legacy(env, "PUT", { orders: [legacyOrder("#1002", "not a date")] })).status, 400);
  assert.equal((await legacy(env, "PUT", { orders: [legacyOrder("#1002", "2026-09-06T14:11:26Z", { total: -5 })] })).status, 400);
  assert.equal((await legacy(env, "PUT", { orders: [legacyOrder("<script>", "2026-09-06T14:11:26Z")] })).status, 400);
  const res = await call("/admin/legacy-orders", { method: "GET", workerEnv: env, headers: { authorization: "Bearer nope" } });
  assert.equal(res.status, 401);
  await legacy(env, "PUT", { orders: [legacyOrder("#1002", "2026-09-06T14:11:26Z")] });
  const config = await (await call("/config", { method: "GET", workerEnv: env })).text();
  assert.ok(!config.includes("Test Customer"));
});

test("legacy orders: odd values are cleaned (no unsafe links, short fields)", async () => {
  const env = adminEnv();
  const body = await (await legacy(env, "PUT", { orders: [legacyOrder("#1009", "2026-09-06T14:11:26Z", {
    shopifyId: "javascript:alert(1)", customer: { name: "x".repeat(500), email: "e", phone: "p" }, address: { country: "CAN" },
  })] })).json();
  const o = body.orders[0];
  assert.equal(o.stripeUrl, null);
  assert.equal(o.customer.name.length, 100);
  assert.equal(o.address.country, "CA");
});

// ---- Custom products (codes) ----

const customAdmin = (workerEnv, method, path = "", body, password = PASSWORD) =>
  call("/admin/custom-products" + path, {
    method, body, workerEnv, headers: { authorization: "Bearer " + password },
  });
const product = (extra) => ({
  code: " smith-7x3 ", name: "Custom 7x3 cassette shelf", price: 31500,
  maxUses: 1, image: "cassette:6x3", note: "Jane, asked by email", active: true, ...extra,
});
const customCart = (code = "SMITH-7X3", quantity = 1) => [{ format: "custom", code, quantity }];

async function envWithProduct(extra) {
  const workerEnv = { ...adminEnv() };
  const res = await customAdmin(workerEnv, "POST", "", { product: product(extra) });
  assert.equal(res.status, 200);
  return workerEnv;
}

test("custom products: created in the dashboard, code cleaned up, password required", async () => {
  const workerEnv = adminEnv();
  assert.equal((await customAdmin(workerEnv, "GET", "", undefined, "nope")).status, 401);
  assert.deepEqual(await (await customAdmin(workerEnv, "GET")).json(), { products: [] });

  const res = await customAdmin(workerEnv, "POST", "", { product: product() });
  const { products } = await res.json();
  assert.equal(products.length, 1);
  assert.equal(products[0].code, "SMITH-7X3");
  assert.equal(products[0].price, 31500);
  assert.deepEqual(products[0].orders, []);
  assert.match(products[0].createdAt, /^\d{4}-/);
  assert.ok(workerEnv.SETTINGS.store.has("custom-products"));

  const duplicate = await customAdmin(workerEnv, "POST", "", { product: product({ code: "Smith-7x3" }) });
  assert.equal(duplicate.status, 400);
  assert.match((await duplicate.json()).error, /already used/);
});

test("custom products: bad input is refused", async () => {
  const workerEnv = adminEnv();
  for (const [extra, message] of [
    [{ code: "a" }, /3 to 30/],
    [{ code: "has space" }, /3 to 30/],
    [{ name: " " }, /name/],
    [{ price: 0 }, /price/],
    [{ price: 12.5 }, /price/],
    [{ maxUses: 0 }, /number of orders/],
    [{ image: "cassette:9x9" }, /picture/],
    [{ image: "__proto__:1x1" }, /picture/],
    [{ active: "yes" }, /on or off/],
  ]) {
    const res = await customAdmin(workerEnv, "POST", "", { product: product(extra) });
    assert.equal(res.status, 400, JSON.stringify(extra));
    assert.match((await res.json()).error, message);
  }
  assert.equal((await customAdmin(workerEnv, "POST", "", {})).status, 400);
});

test("custom products: a customer looks up a code (any case) and sees no private details", async () => {
  const workerEnv = await envWithProduct();
  const res = await call("/code", { body: { code: "smith-7x3" }, workerEnv });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    product: { code: "SMITH-7X3", name: "Custom 7x3 cassette shelf", price: 31500, image: "cassette:6x3" },
  });
  const wrong = await call("/code", { body: { code: "NOPE" }, workerEnv });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error, "this code isn't valid");
  assert.equal((await call("/code", { body: {}, workerEnv })).status, 400);
  // Codes are never listed publicly.
  assert.ok(!JSON.stringify(await (await call("/config", { method: "GET", workerEnv })).json()).includes("SMITH"));
});

test("custom products: priced at their own price with normal shipping and fees", async () => {
  const workerEnv = await envWithProduct();
  const res = await call("/quote", {
    body: { items: [...customCart("smith-7x3"), { format: "cassette", size: "1x1", quantity: 1 }], address: { country: "US" } },
    workerEnv,
  });
  assert.equal(res.status, 200);
  const quote = await res.json();
  assert.deepEqual(quote.items[0], {
    format: "custom", size: "SMITH-7X3", label: "Custom 7x3 cassette shelf", quantity: 1, unitAmount: 31500, amount: 31500,
  });
  const shelves = 31500 + FORMATS.cassette.prices["1x1"];
  assert.equal(quote.subtotal, shelves);
  const tariffs = SHIPPING_RATES.US.fees?.[0];
  if (tariffs) assert.equal(quote.fees[0].amount, Math.round((shelves * tariffs.percent) / 100));
  assert.equal(quote.total, shelves + quote.shipping + quote.fees.reduce((s, f) => s + f.amount, 0));
});

test("custom products: one per order, not twice, turned off or used up codes are refused", async () => {
  const workerEnv = await envWithProduct();
  const quote = (items) => call("/quote", { body: { items, address: { country: "CA" } }, workerEnv });

  assert.match((await (await quote(customCart("SMITH-7X3", 2))).json()).error, /only one/);
  assert.match((await (await quote([...customCart(), ...customCart("smith-7x3")])).json()).error, /twice/);
  assert.match((await (await quote(customCart("OTHER"))).json()).error, /isn't valid \(OTHER\)/);

  await customAdmin(workerEnv, "PUT", "/SMITH-7X3", { product: product({ active: false }) });
  assert.match((await (await quote(customCart())).json()).error, /isn't valid/);
  assert.equal((await call("/code", { body: { code: "SMITH-7X3" }, workerEnv })).status, 400);
});

test("custom products: checkout stores the code and name; the paid order uses up a one-time code", async () => {
  const workerEnv = await envWithProduct();
  const res = await call("/checkout", {
    body: { items: customCart(), address: ADDRESS, name: "Jane", email: "jane@example.com" },
    workerEnv,
  });
  assert.equal(res.status, 200);
  const created = stripeCalls.find((c) => c.path === "/v1/payment_intents").params;
  assert.equal(created.get("metadata[items]"), "custom:SMITH-7X3:1");
  assert.equal(created.get("metadata[custom_products]"), "SMITH-7X3=Custom 7x3 cassette shelf");
  assert.equal(created.get("description"), "1 x Custom 7x3 cassette shelf");

  // Stripe confirms the payment (twice: webhooks can be retried).
  const paid = { id: "pi_paid1", object: "payment_intent", metadata: { items: "custom:SMITH-7X3:1,cassette:1x1:1" } };
  for (let i = 0; i < 2; i++) {
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "payment_intent.succeeded", data: { object: paid } });
    const signature = await new Stripe("sk_test_fake").webhooks.generateTestHeaderStringAsync({ payload, secret: env.STRIPE_WEBHOOK_SECRET });
    const hook = await worker.fetch(new Request("https://worker.example/webhook", { method: "POST", body: payload, headers: { "stripe-signature": signature } }), workerEnv);
    assert.equal(hook.status, 200);
  }
  const { products } = await (await customAdmin(workerEnv, "GET")).json();
  assert.deepEqual(products[0].orders, ["pi_paid1"]);

  const again = await call("/code", { body: { code: "SMITH-7X3" }, workerEnv });
  assert.equal((await again.json()).error, "this code has already been used");

  // Allowing more orders makes it usable again.
  await customAdmin(workerEnv, "PUT", "/SMITH-7X3", { product: product({ maxUses: null }) });
  assert.equal((await call("/code", { body: { code: "SMITH-7X3" }, workerEnv })).status, 200);
  assert.deepEqual((await (await customAdmin(workerEnv, "GET")).json()).products[0].orders, ["pi_paid1"], "edits keep the orders");
});

test("custom products: orders show the product's name; edit keeps the code; delete", async () => {
  SEARCH_PAGE_1.data[0].metadata = { ...SEARCH_PAGE_1.data[0].metadata, items: "custom:SMITH-7X3:1", custom_products: "SMITH-7X3=Custom 7x3 cassette shelf" };
  try {
    const body = await (await call("/admin/orders", { method: "GET", workerEnv: adminEnv(), headers: { authorization: "Bearer " + PASSWORD } })).json();
    assert.deepEqual(body.orders[0].items, [{ format: "custom", size: "SMITH-7X3", quantity: 1, label: "Custom 7x3 cassette shelf (code SMITH-7X3)" }]);
  } finally {
    SEARCH_PAGE_1.data[0].metadata.items = "cassette:1x1:1";
    delete SEARCH_PAGE_1.data[0].metadata.custom_products;
  }

  const workerEnv = await envWithProduct();
  const edited = await (await customAdmin(workerEnv, "PUT", "/smith-7x3", { product: product({ code: "CHANGED", price: 30000 }) })).json();
  assert.equal(edited.products[0].code, "SMITH-7X3");
  assert.equal(edited.products[0].price, 30000);
  assert.equal((await customAdmin(workerEnv, "PUT", "/MISSING", { product: product() })).status, 400);

  const deleted = await (await customAdmin(workerEnv, "DELETE", "/SMITH-7X3")).json();
  assert.deepEqual(deleted.products, []);
});
