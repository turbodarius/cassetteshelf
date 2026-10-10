// Analytics: event recording (against a real SQLite database standing in
// for Cloudflare D1) and the dashboard report (with a fake Stripe API).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { cleanUp, localDay } from "../src/analytics.js";

// Minimal D1 API on top of node:sqlite.
class FakeD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
  }
  prepare(sql) {
    return new FakeStatement(this.sqlite, sql, []);
  }
  async batch(statements) {
    return statements.map((s) => s.runSync());
  }
  rows(sql) {
    return this.sqlite.prepare(sql).all();
  }
}
class FakeStatement {
  constructor(sqlite, sql, args) {
    Object.assign(this, { sqlite, sql, args });
  }
  bind(...args) {
    return new FakeStatement(this.sqlite, this.sql, args);
  }
  runSync() {
    return this.sqlite.prepare(this.sql).run(...this.args);
  }
  async run() {
    return this.runSync();
  }
  async all() {
    return { results: this.sqlite.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) };
  }
  async first() {
    const row = this.sqlite.prepare(this.sql).get(...this.args);
    return row ? { ...row } : null;
  }
}

const PASSWORD = "pw";
const ORIGIN = "https://cassetteshelf.com";
const baseEnv = () => ({
  STRIPE_SECRET_KEY: "sk_test_fake",
  ALLOWED_ORIGINS: ORIGIN,
  ADMIN_TOKEN: PASSWORD,
  ANALYTICS: new FakeD1(),
});

const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1";

function track(env, body, { ua = DESKTOP, ip = "1.2.3.4", origin = ORIGIN, country = "CA" } = {}) {
  const request = new Request("https://worker.example/track", {
    method: "POST",
    headers: { origin, "user-agent": ua, "cf-connecting-ip": ip, "content-type": "text/plain" },
    body: JSON.stringify(body),
  });
  Object.defineProperty(request, "cf", { value: { country } });
  return worker.fetch(request, env);
}

// ---- Fake Stripe: paid and unpaid payments made "recently" ----
const now = Math.floor(Date.now() / 1000);
const pi = (id, minutesAgo, extra = {}) => ({
  id, object: "payment_intent", created: now - minutesAgo * 60, amount: 6627, amount_received: 6627,
  currency: "cad", livemode: true, status: "succeeded", receipt_email: "a@example.com",
  shipping: { name: "A", address: { line1: "1 Main St", city: "Albany", state: "NY", postal_code: "12207", country: "US" } },
  metadata: { items: "cassette:1x1:1", shipping_rate: "standard", shipping_amount: "2500", fees: "tariffs:1376", tax_amount: "0" },
  latest_charge: { amount_refunded: 0 },
  ...extra,
});
const PAID = [
  pi("pi_1", 10),
  pi("pi_2", 60 * 30, {
    amount: 20000, amount_received: 20000, receipt_email: "b@example.com",
    shipping: { name: "B", address: { line1: "2 rue X", city: "Montréal", state: "QC", postal_code: "H2X", country: "CA" } },
    metadata: { items: "cassette:2x2:2,cd:1x1:1", shipping_rate: "express", shipping_amount: "3000", tax_amount: "0" },
    latest_charge: { amount_refunded: 5000 },
  }),
];
const UNPAID = [
  pi("pi_u1", 30, { status: "requires_payment_method", receipt_email: "a@example.com", last_payment_error: { message: "Your card was declined." } }),
  pi("pi_u2", 5, { status: "requires_payment_method", receipt_email: "c@example.com" }),
  pi("pi_u3", 60 * 24 * 60, { status: "canceled", receipt_email: "old@example.com" }), // 60 days ago
  pi("pi_other", 5, { status: "canceled", metadata: {} }), // not from the checkout
];

let stripeCalls, realFetch;
beforeEach(() => {
  stripeCalls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    stripeCalls.push(u);
    const query = u.searchParams.get("query") ?? "";
    const data = query.startsWith('status:"succeeded"') ? PAID : UNPAID;
    return new Response(JSON.stringify({ object: "search_result", data, has_more: false, next_page: null }), {
      headers: { "Content-Type": "application/json" },
    });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const report = async (env, days) => {
  const res = await worker.fetch(new Request("https://worker.example/admin/analytics" + (days ? "?days=" + days : ""), {
    headers: { origin: ORIGIN, authorization: "Bearer " + PASSWORD },
  }), env);
  return { status: res.status, body: await res.json() };
};

test("track: records an anonymous page view", async () => {
  const env = baseEnv();
  const res = await track(env, { type: "pageview", path: "/index.html?utm=x", referrer: "https://www.instagram.com/p/abc" });
  assert.equal(res.status, 204);
  const [row] = env.ANALYTICS.rows("SELECT * FROM events");
  assert.equal(row.type, "pageview");
  assert.equal(row.path, "/index.html");
  assert.equal(row.referrer, "instagram.com");
  assert.equal(row.country, "CA");
  assert.equal(row.device, "desktop");
  assert.equal(row.day, localDay(new Date()));
  assert.match(row.visitor, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(row).includes("1.2.3.4"), "the IP itself is never stored");
});

test("track: the same visitor gets the same code today; others differ; own site isn't a referrer", async () => {
  const env = baseEnv();
  await track(env, { type: "pageview", path: "/", referrer: "https://cassetteshelf.com/faq.html" });
  await track(env, { type: "add_to_cart", path: "/", detail: "cassette:2x2" });
  await track(env, { type: "pageview", path: "/" }, { ua: PHONE });
  await track(env, { type: "pageview", path: "/" }, { ip: "5.6.7.8" });
  const rows = env.ANALYTICS.rows("SELECT * FROM events ORDER BY ts");
  assert.equal(rows[0].referrer, "");
  assert.equal(rows[0].visitor, rows[1].visitor);
  assert.notEqual(rows[0].visitor, rows[2].visitor);
  assert.notEqual(rows[0].visitor, rows[3].visitor);
  assert.equal(rows[2].device, "phone");
  assert.equal(rows[1].detail, "cassette:2x2");
  assert.equal(rows[1].referrer, "", "referrers only kept on page views");
});

test("track: ignores bots, unknown events, the admin page, other sites and junk", async () => {
  const env = baseEnv();
  await track(env, { type: "pageview", path: "/" }); // creates the tables
  await track(env, { type: "pageview", path: "/" }, { ua: "Googlebot/2.1" });
  await track(env, { type: "pageview", path: "/" }, { ua: "" });
  await track(env, { type: "hack", path: "/" });
  await track(env, { type: "pageview", path: "/admin/" });
  await track(env, { type: "pageview", path: "/" }, { origin: "https://evil.example" });
  const bad = new Request("https://worker.example/track", { method: "POST", headers: { origin: ORIGIN, "user-agent": DESKTOP }, body: "{not json" });
  assert.equal((await worker.fetch(bad, env)).status, 204);
  assert.equal(env.ANALYTICS.rows("SELECT * FROM events").length, 1);
});

test("track: without the database it quietly does nothing", async () => {
  const env = { ...baseEnv(), ANALYTICS: undefined };
  assert.equal((await track(env, { type: "pageview", path: "/" })).status, 204);
});

test("clean-up: old events and old daily salts are deleted", async () => {
  const env = baseEnv();
  await track(env, { type: "pageview", path: "/" });
  const db = env.ANALYTICS;
  db.sqlite.prepare("INSERT INTO events (ts, day, type, visitor) VALUES (?, '2020-01-01', 'pageview', 'x')").run(Date.parse("2020-01-01"));
  db.sqlite.prepare("INSERT INTO salts (day, salt) VALUES ('2020-01-01', 's')").run();
  await cleanUp(db, new Date());
  assert.equal(db.rows("SELECT * FROM events").length, 1);
  assert.deepEqual(db.rows("SELECT day FROM salts").map((r) => r.day), [localDay(new Date())]);
});

test("report: password required", async () => {
  const res = await worker.fetch(new Request("https://worker.example/admin/analytics", { headers: { authorization: "Bearer no" } }), baseEnv());
  assert.equal(res.status, 401);
});

test("report: traffic, funnel and top lists from the events", async () => {
  const env = baseEnv();
  const visit = (ip, ua, steps, referrer) =>
    steps.reduce((p, type) => p.then(() => track(env, { type, path: "/", referrer, detail: type === "add_to_cart" ? "cassette:2x2" : "" }, { ip, ua })), Promise.resolve());
  await visit("1.1.1.1", DESKTOP, ["pageview", "pageview", "add_to_cart", "checkout_open", "checkout_address", "checkout_submit", "purchase"], "https://instagram.com/");
  await visit("2.2.2.2", PHONE, ["pageview", "add_to_cart", "checkout_open"], "https://instagram.com/");
  await visit("3.3.3.3", DESKTOP, ["pageview"]);
  await track(env, { type: "pageview", path: "/faq.html" }, { ip: "3.3.3.3" });

  const { status, body } = await report(env, 7);
  assert.equal(status, 200);
  const t = body.traffic;
  assert.equal(t.views, 5);
  assert.equal(t.visitors, 3);
  assert.deepEqual(t.daily, [{ day: localDay(new Date()), views: 5, visitors: 3 }]);
  assert.deepEqual(t.pages[0], { path: "/", views: 4, visitors: 3 });
  assert.deepEqual(t.referrers[0], { source: "instagram.com", visitors: 2 });
  assert.deepEqual(t.devices.map((d) => d.device + ":" + d.visitors).sort(), ["desktop:2", "phone:1"]);
  assert.deepEqual(t.funnel.map((s) => s.step + ":" + s.visitors), [
    "pageview:3", "add_to_cart:2", "checkout_open:2", "checkout_address:1", "checkout_submit:1", "purchase:1",
  ]);
  assert.deepEqual(t.addedToCart, [{ detail: "cassette:2x2", times: 2 }]);
  assert.equal(body.dayList.length, 7);
  assert.equal(body.dayList.at(-1), localDay(new Date()));
});

test("report: sales from Stripe", async () => {
  const { body } = await report(baseEnv(), 30);
  const s = body.sales;
  assert.equal(s.orders, 2);
  assert.equal(s.gross, 6627 + 20000);
  assert.equal(s.refunded, 5000);
  assert.equal(s.revenue, 6627 + 20000 - 5000);
  assert.equal(s.averageOrder, Math.round((6627 + 20000) / 2));
  assert.equal(s.shelvesSold, 4);
  assert.deepEqual(s.bestSellers[0], { key: "2x2 cassette shelf", value: 2 });
  assert.deepEqual(s.countries.map((c) => c.key), ["CA", "US"]);
  assert.deepEqual(s.fees, [{ key: "tariffs", value: 1376 }]);
  assert.deepEqual(s.shippingOptions.map((o) => o.key).sort(), ["express", "standard"]);
  const query = stripeCalls.find((u) => u.searchParams.get("query").startsWith('status:"succeeded"')).searchParams.get("query");
  assert.match(query, /^status:"succeeded" AND created>=\d+$/);
});

test("report: abandoned purchases, with who bought later", async () => {
  const { body } = await report(baseEnv(), 30);
  const a = body.abandoned;
  assert.deepEqual(a.list.map((x) => x.id), ["pi_u2", "pi_u1"], "newest first; 60-day-old attempt and non-checkout payments left out");
  assert.equal(a.count, 2);
  assert.equal(a.value, 6627 * 2);
  const [gone, declined] = a.list;
  assert.equal(declined.reason, "Your card was declined.");
  assert.equal(declined.purchasedLater, true, "a@example.com paid 20 minutes later");
  assert.equal(gone.reason, "didn't complete payment");
  assert.equal(gone.purchasedLater, false);
  assert.equal(gone.customer.email, "c@example.com");
});

test("report: works without the analytics database (sales only)", async () => {
  const { status, body } = await report({ ...baseEnv(), ANALYTICS: undefined }, 7);
  assert.equal(status, 200);
  assert.equal(body.traffic, null);
  assert.equal(body.sales.orders, 2);
});

test("report: unknown period falls back to 30 days", async () => {
  const { body } = await report(baseEnv(), 12345);
  assert.equal(body.days, 30);
});
