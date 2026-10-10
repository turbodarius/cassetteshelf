// Analytics for the /admin dashboard.
//
// Traffic and the checkout funnel come from small anonymous events the
// site sends to POST /track (see track.js), stored in Cloudflare D1
// (binding ANALYTICS). Like privacy-focused analytics tools, no cookies
// or identifiers are stored on the visitor's device: a visitor is a hash
// of their IP + browser with a random salt that changes every day (old
// salts are deleted), so visitors can't be followed across days or
// identified. Sales and abandoned purchases come straight from Stripe.

import { toOrder } from "./orders.js";

export const TIME_ZONE = "America/Toronto";

// Funnel steps, in order.
export const EVENT_TYPES = [
  "pageview",          // a page was opened
  "add_to_cart",       // "add to cart" (detail: "cassette:2x2")
  "checkout_open",     // the checkout window was opened
  "checkout_address",  // a shipping country was entered (detail: "CA")
  "checkout_submit",   // "Purchase" was pressed with valid details
  "purchase",          // payment succeeded
];

const BOTS = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|monitor|curl|wget|python/i;
const KEEP_DAYS = 400;

// "YYYY-MM-DD" in the shop's time zone.
export function localDay(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(date);
}

// Creates the tables the first time each database is used.
const schemaReady = new WeakMap();
function ensureSchema(db) {
  if (!schemaReady.has(db)) {
    schemaReady.set(db, db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS events (
        ts INTEGER NOT NULL, day TEXT NOT NULL, type TEXT NOT NULL, visitor TEXT NOT NULL,
        path TEXT NOT NULL DEFAULT '', referrer TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
        device TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '')`),
      db.prepare("CREATE INDEX IF NOT EXISTS events_day_type ON events (day, type)"),
      db.prepare("CREATE TABLE IF NOT EXISTS salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL)"),
    ]).catch((err) => {
      schemaReady.delete(db);
      throw err;
    }));
  }
  return schemaReady.get(db);
}

// ---- Recording (POST /track) -------------------------------------------

export async function recordEvent(env, request) {
  const db = env.ANALYTICS;
  if (!db) return;
  const ua = request.headers.get("user-agent") ?? "";
  if (!ua || BOTS.test(ua)) return;

  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return;
  }
  const type = body?.type;
  if (!EVENT_TYPES.includes(type)) return;

  const path = typeof body.path === "string" && body.path.startsWith("/") ? body.path.split(/[?#]/)[0].slice(0, 200) : "";
  if (path.startsWith("/admin")) return;
  const detail = typeof body.detail === "string" ? body.detail.slice(0, 100) : "";

  const now = new Date();
  const day = localDay(now);
  await ensureSchema(db);
  const salt = await dailySalt(db, day);
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "";
  const visitor = (await sha256Hex(salt + "|" + ip + "|" + ua)).slice(0, 16);

  await db.prepare(
    "INSERT INTO events (ts, day, type, visitor, path, referrer, country, device, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    now.getTime(), day, type, visitor, path,
    type === "pageview" ? referrerHost(body.referrer, request.headers.get("origin")) : "",
    String(request.cf?.country ?? "").slice(0, 2),
    deviceOf(ua),
    detail,
  ).run();

  // Now and then, drop old events and salts.
  if (Math.random() < 0.01) await cleanUp(db, now);
}

async function dailySalt(db, day) {
  const fresh = await sha256Hex(crypto.randomUUID() + day);
  await db.prepare("INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)").bind(day, fresh).run();
  return (await db.prepare("SELECT salt FROM salts WHERE day = ?").bind(day).first()).salt;
}

export async function cleanUp(db, now) {
  const oldest = now.getTime() - KEEP_DAYS * 86400000;
  const yesterday = localDay(new Date(now.getTime() - 86400000));
  await db.batch([
    db.prepare("DELETE FROM events WHERE ts < ?").bind(oldest),
    db.prepare("DELETE FROM salts WHERE day < ?").bind(yesterday),
  ]);
}

// "https://www.instagram.com/p/..." -> "instagram.com"; own site / none -> ""
function referrerHost(referrer, origin) {
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, "").toLowerCase();
    const own = origin ? new URL(origin).hostname.replace(/^www\./, "").toLowerCase() : "";
    return host && host !== own ? host.slice(0, 100) : "";
  } catch {
    return "";
  }
}

function deviceOf(ua) {
  if (/ipad|tablet|(android(?!.*mobile))/i.test(ua)) return "tablet";
  if (/mobi|iphone|android/i.test(ua)) return "phone";
  return "desktop";
}

async function sha256Hex(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Report (GET /admin/analytics) ---------------------------------------

export const PERIODS = [7, 30, 90, 365];
const MAX_PAGES = 10;  // Stripe pages of 100 payments per report

export async function analyticsReport(env, stripe, days, now = new Date()) {
  const since = new Date(now.getTime() - (days - 1) * 86400000);
  const sinceDay = localDay(since);
  // Start of the first day, so "7 days" means today + the 6 before it.
  const sinceTs = Math.floor(since.getTime() / 1000) - 86400;

  const [traffic, sales] = await Promise.all([
    env.ANALYTICS ? trafficReport(env.ANALYTICS, sinceDay) : null,
    salesReport(stripe, sinceTs, sinceDay),
  ]);
  return {
    days,
    from: sinceDay,
    to: localDay(now),
    timeZone: TIME_ZONE,
    dayList: dayRange(sinceDay, localDay(now)),
    traffic,
    sales: sales.sales,
    abandoned: sales.abandoned,
  };
}

async function trafficReport(db, sinceDay) {
  await ensureSchema(db);
  const q = (sql, ...args) => db.prepare(sql).bind(sinceDay, ...args).all().then((r) => r.results);
  const visitorsExpr = "COUNT(DISTINCT day || visitor)";
  const [totals, daily, pages, referrers, countries, devices, funnel, added] = await Promise.all([
    q(`SELECT COUNT(*) AS views, ${visitorsExpr} AS visitors FROM events WHERE day >= ? AND type = 'pageview'`),
    q(`SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM events
       WHERE day >= ? AND type = 'pageview' GROUP BY day ORDER BY day`),
    q(`SELECT path, COUNT(*) AS views, ${visitorsExpr} AS visitors FROM events
       WHERE day >= ? AND type = 'pageview' GROUP BY path ORDER BY views DESC LIMIT 10`),
    q(`SELECT CASE WHEN referrer = '' THEN '(direct / unknown)' ELSE referrer END AS source, ${visitorsExpr} AS visitors
       FROM events WHERE day >= ? AND type = 'pageview' GROUP BY source ORDER BY visitors DESC LIMIT 10`),
    q(`SELECT country, ${visitorsExpr} AS visitors FROM events
       WHERE day >= ? AND type = 'pageview' GROUP BY country ORDER BY visitors DESC LIMIT 10`),
    q(`SELECT device, ${visitorsExpr} AS visitors FROM events
       WHERE day >= ? AND type = 'pageview' GROUP BY device ORDER BY visitors DESC`),
    q(`SELECT type, ${visitorsExpr} AS visitors FROM events WHERE day >= ? GROUP BY type`),
    q(`SELECT detail, COUNT(*) AS times FROM events
       WHERE day >= ? AND type = 'add_to_cart' GROUP BY detail ORDER BY times DESC LIMIT 10`),
  ]);
  const byType = Object.fromEntries(funnel.map((r) => [r.type, r.visitors]));
  return {
    views: totals[0]?.views ?? 0,
    visitors: totals[0]?.visitors ?? 0,
    daily,
    pages,
    referrers,
    countries,
    devices,
    funnel: EVENT_TYPES.map((type) => ({ step: type, visitors: byType[type] ?? 0 })),
    addedToCart: added,
  };
}

async function searchAll(stripe, query, stopBefore) {
  const results = [];
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await stripe.paymentIntents.search({
      query, limit: 100, expand: ["data.latest_charge"], ...(page ? { page } : {}),
    });
    for (const pi of res.data) {
      if (stopBefore && pi.created < stopBefore) return { results, truncated: false };
      results.push(pi);
    }
    if (!res.has_more) return { results, truncated: false };
    page = res.next_page;
  }
  return { results, truncated: true };
}

async function salesReport(stripe, sinceTs, sinceDay) {
  const [paid, unpaid] = await Promise.all([
    searchAll(stripe, `status:"succeeded" AND created>=${sinceTs}`),
    // Can't combine OR with AND in Stripe search, so the date is checked here.
    searchAll(stripe, 'status:"requires_payment_method" OR status:"requires_action" OR status:"canceled"', sinceTs),
  ]);

  const orders = paid.results.map(toOrder).filter((o) => localDay(new Date(o.created)) >= sinceDay);
  const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);
  const tally = (pairs) => {
    const map = new Map();
    for (const [key, add] of pairs) map.set(key, (map.get(key) ?? 0) + add);
    return [...map].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
  };

  const gross = sum(orders, (o) => o.total);
  const refunded = sum(orders, (o) => o.refunded);
  const daily = tally(orders.map((o) => [localDay(new Date(o.created)), o.total - o.refunded]))
    .map(({ key, value }) => ({ day: key, revenue: value, orders: orders.filter((o) => localDay(new Date(o.created)) === key).length }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  const sales = {
    orders: orders.length,
    gross,
    refunded,
    revenue: gross - refunded,
    averageOrder: orders.length ? Math.round(gross / orders.length) : 0,
    shelvesSold: sum(orders, (o) => sum(o.items, (i) => i.quantity)),
    shipping: sum(orders, (o) => o.shipping.amount ?? 0),
    tax: sum(orders, (o) => o.tax ?? 0),
    daily,
    bestSellers: tally(orders.flatMap((o) => o.items.map((i) => [i.label, i.quantity]))).slice(0, 10),
    countries: tally(orders.map((o) => [o.address.country || "?", o.total - o.refunded])),
    shippingOptions: tally(orders.map((o) => [o.shipping.option || "?", 1])),
    fees: tally(orders.flatMap((o) => o.fees.map((f) => [f.id, f.amount]))),
    truncated: paid.truncated,
  };

  // Paid later = the same email bought after this attempt.
  const paidAt = new Map();
  for (const o of orders) {
    const email = o.customer.email.toLowerCase();
    if (email && (!paidAt.has(email) || paidAt.get(email) < o.created)) paidAt.set(email, o.created);
  }
  const inPeriod = (pi) => localDay(new Date(pi.created * 1000)) >= sinceDay;
  const abandoned = unpaid.results.filter((pi) => pi.metadata?.items && inPeriod(pi)).map((pi) => {
    const order = toOrder(pi);
    const later = paidAt.get(order.customer.email.toLowerCase());
    return {
      id: order.id,
      created: order.created,
      amount: pi.amount,
      customer: order.customer,
      country: order.address.country,
      items: order.items,
      reason: pi.last_payment_error?.message
        ?? (pi.status === "canceled" ? "canceled" : pi.status === "requires_action" ? "didn't finish card verification" : "didn't complete payment"),
      purchasedLater: Boolean(later && later > order.created),
      stripeUrl: order.stripeUrl,
    };
  });

  abandoned.sort((a, b) => (a.created < b.created ? 1 : -1));  // newest first
  return { sales, abandoned: { count: abandoned.length, value: sum(abandoned, (a) => a.amount), list: abandoned.slice(0, 50), truncated: unpaid.truncated } };
}

function dayRange(from, to) {
  const days = [];
  // Noon UTC avoids any daylight-saving edge when stepping a day at a time.
  for (let d = new Date(from + "T12:00:00Z"); localDayUTC(d) <= to; d = new Date(d.getTime() + 86400000)) {
    days.push(localDayUTC(d));
    if (days.length > 400) break;
  }
  return days;
}

function localDayUTC(date) {
  return date.toISOString().slice(0, 10);
}
