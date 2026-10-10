// "New order" emails: sent from the Stripe webhook through Resend (faked).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import worker from "../src/index.js";
import { orderEmail } from "../src/email.js";
import { toOrder } from "../src/orders.js";

const env = {
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_fake",
  RESEND_API_KEY: "re_fake",
  ORDER_EMAIL_TO: "contact@cassetteshelf.com",
  ORDER_EMAIL_FROM: "cassetteshelf orders <onboarding@resend.dev>",
  DASHBOARD_URL: "https://cassetteshelf.com/admin/",
  ADMIN_TOKEN: "pw",
  ALLOWED_ORIGINS: "https://cassetteshelf.com",
};

const paidIntent = (extra = {}) => ({
  id: "pi_123", object: "payment_intent", created: 1760000000, amount: 6627, amount_received: 6627,
  currency: "cad", livemode: true, status: "succeeded", receipt_email: "buyer@example.com",
  shipping: { name: "Pat <Buyer>", phone: "+1 555 0100", address: { line1: "1 Main St", line2: "Apt 2", city: "Albany", state: "NY", postal_code: "12207", country: "US" } },
  metadata: { items: "cassette:1x1:1", shipping_rate: "standard", shipping_amount: "2500", fees: "tariffs:1376", tax_amount: "0" },
  ...extra,
});

let sent, resendStatus, realFetch;
beforeEach(() => {
  sent = [];
  resendStatus = 200;
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === "api.resend.com") {
      sent.push({ headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(resendStatus === 200 ? { id: "email_1" } : { message: "invalid key" }), { status: resendStatus });
    }
    return new Response("{}", { status: 404 }); // Stripe API (not needed here)
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function webhook(workerEnv, object, type = "payment_intent.succeeded") {
  const payload = JSON.stringify({ id: "evt_1", object: "event", type, data: { object } });
  const signature = await new Stripe("sk_test_fake").webhooks.generateTestHeaderStringAsync({ payload, secret: env.STRIPE_WEBHOOK_SECRET });
  return worker.fetch(new Request("https://worker.example/webhook", { method: "POST", body: payload, headers: { "stripe-signature": signature } }), workerEnv);
}

test("a paid order emails the shop with everything needed", async () => {
  const res = await webhook(env, paidIntent());
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  const { headers, body } = sent[0];
  assert.equal(headers.Authorization, "Bearer re_fake");
  assert.equal(headers["Idempotency-Key"], "order-email-pi_123");
  assert.deepEqual(body.to, ["contact@cassetteshelf.com"]);
  assert.equal(body.from, "cassetteshelf orders <onboarding@resend.dev>");
  assert.equal(body.reply_to, "buyer@example.com");
  assert.equal(body.subject, "New order: 66.27$ CAD — Pat <Buyer> (1 × 1x1 cassette shelf)");
  for (const part of ["1 × 1x1 cassette shelf", "Shelves: 27.51$ CAD", "Shipping (standard): 25.00$ CAD", "Tariffs: 13.76$ CAD",
    "Total: 66.27$ CAD", "1 Main St", "Apt 2", "Albany NY 12207", "United States", "buyer@example.com", "+1 555 0100",
    "View in Stripe: https://dashboard.stripe.com/payments/pi_123", "Open the dashboard: https://cassetteshelf.com/admin/"]) {
    assert.ok(body.text.includes(part), "text email has: " + part);
  }
  assert.ok(body.html.includes("Pat &lt;Buyer&gt;"), "customer text is escaped in the HTML");
  assert.ok(!body.html.includes("<Buyer>"));
});

test("several recipients, and no reply-to without a customer email", async () => {
  await webhook({ ...env, ORDER_EMAIL_TO: "contact@cassetteshelf.com, me@example.com" }, paidIntent({ receipt_email: null }));
  assert.deepEqual(sent[0].body.to, ["contact@cassetteshelf.com", "me@example.com"]);
  assert.equal(sent[0].body.reply_to, undefined);
});

test("without a Resend key nothing is sent and the webhook still succeeds", async () => {
  const res = await webhook({ ...env, RESEND_API_KEY: undefined }, paidIntent());
  assert.equal(res.status, 200);
  assert.equal(sent.length, 0);
});

test("a Resend error doesn't fail the webhook", async () => {
  resendStatus = 403;
  const res = await webhook(env, paidIntent());
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
});

test("other events don't send email", async () => {
  await webhook(env, paidIntent({ status: "requires_payment_method" }), "payment_intent.payment_failed");
  assert.equal(sent.length, 0);
});

test("dashboard test email: password, sample order, clear errors", async () => {
  const post = (workerEnv, password = "pw") => worker.fetch(new Request("https://worker.example/admin/test-email", {
    method: "POST", headers: { origin: "https://cassetteshelf.com", authorization: "Bearer " + password },
  }), workerEnv);
  assert.equal((await post(env, "nope")).status, 401);
  const ok = await post(env);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { sentTo: "contact@cassetteshelf.com" });
  assert.match(sent[0].body.subject, /^New order: 66\.27\$ CAD — Test Customer/);
  const missing = await post({ ...env, RESEND_API_KEY: undefined });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /RESEND_API_KEY/);
  resendStatus = 403;
  const refused = await post(env);
  assert.equal(refused.status, 502);
  assert.match((await refused.json()).error, /Resend refused the email \(403\)/);
});

test("email lists fees and tax only when there are some", () => {
  const { text } = orderEmail(toOrder(paidIntent({ metadata: { items: "cd:2x2:2", shipping_rate: "express", shipping_amount: "3000", tax_amount: "1200" } })));
  assert.ok(text.includes("2 × 2x2 cd shelf"));
  assert.ok(text.includes("Tax: 12.00$ CAD"));
  assert.ok(!text.includes("Tariffs"));
  assert.ok(!text.includes("Open the dashboard"));
});
