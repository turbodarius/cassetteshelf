// Runs the worker's fetch handler end to end with Stripe's HTTP API
// replaced by a fake (the Stripe SDK sends its requests through the
// global fetch), so no Stripe account or network is needed.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import worker from "../src/index.js";
import { FORMATS } from "../src/catalog.js";

const env = {
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_fake",
  STRIPE_PUBLISHABLE_KEY: "pk_test_fake",
  ALLOWED_ORIGINS: "https://cassetteshelf.com",
};

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

function call(path, { method = "POST", body, headers = {} } = {}) {
  return worker.fetch(
    new Request("https://worker.example" + path, {
      method,
      headers: { origin: ORIGIN, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
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
