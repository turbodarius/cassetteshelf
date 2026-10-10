// cassetteshelf checkout backend (Cloudflare Worker).
//
// Routes:
//   GET  /config          publishable key, countries we ship to, prices
//   POST /quote           prices a cart: subtotal, shipping options, tax, total
//   POST /checkout        re-prices the cart and creates a Stripe PaymentIntent
//   POST /webhook         Stripe webhook: records the tax transaction once paid
//   GET  /admin/settings  (admin password) current store settings
//   PUT  /admin/settings  (admin password) saves store settings
//   POST /track           anonymous page-view / checkout-step event (analytics)
//   GET  /admin/analytics (admin password) traffic, funnel, sales, abandoned checkouts
//   GET  /admin/orders    (admin password) paid orders from Stripe, newest first
//   GET/PUT/DELETE /admin/legacy-orders  (admin password) orders imported from Shopify
//   POST /admin/test-email               (admin password) sends a sample order email
//   PUT  /admin/orders/<id>/shipment     (admin password) mark shipped
//   DELETE /admin/orders/<id>/shipment   (admin password) undo "shipped"
//   POST /admin/orders/<id>/shipping-email (admin password) (re)send the customer's shipping email
//   POST /admin/test-shipping-email      (admin password) sends a sample shipping email to the shop
//
// Secrets (set with `wrangler secret put`): STRIPE_SECRET_KEY,
//   STRIPE_WEBHOOK_SECRET, ADMIN_TOKEN (the dashboard password),
//   RESEND_API_KEY (order emails)
// Vars (wrangler.toml): STRIPE_PUBLISHABLE_KEY, ALLOWED_ORIGINS, COLLECT_TAX,
//   ORDER_EMAIL_TO, ORDER_EMAIL_FROM, DASHBOARD_URL
// KV (wrangler.toml): SETTINGS, where the dashboard saves the settings
// D1 (wrangler.toml): ANALYTICS, anonymous visit and checkout-step events

import Stripe from "stripe";
import { CURRENCY, FORMATS, TAX_CODE } from "./catalog.js";
import { SIZES, SettingsError, loadSettings, saveSettings } from "./settings.js";
import { CARRIERS, getOrder, listOrders, markShippingEmailed, setShipment, toOrder } from "./orders.js";
import { PERIODS, analyticsReport, recordEvent } from "./analytics.js";
import { clearLegacyOrders, importLegacyOrders, legacyToOrder, loadLegacyOrders } from "./legacy.js";
import {
  customerEmailConfigured, emailConfigured, sampleOrderPaymentIntent, sendOrderEmail, sendShippingEmail,
} from "./email.js";
import {
  OrderError,
  cleanAddress,
  countryList,
  displayPrices,
  feesFor,
  feesMetadata,
  hasTaxableAddress,
  itemsMetadata,
  priceItems,
  selectShipping,
  shippingOptionsFor,
  validateCheckoutDetails,
} from "./pricing.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Stripe calls the webhook server-to-server, so it skips CORS.
    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }

    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Analytics events: always answered with 204 (a tracking problem must
    // never affect the visitor), and only recorded from our own sites.
    if (url.pathname === "/track" && request.method === "POST") {
      if (cors["Access-Control-Allow-Origin"]) {
        try {
          await recordEvent(env, request);
        } catch (err) {
          console.error("track failed", err);
        }
      }
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname.startsWith("/admin/")) {
        return await handleAdmin(request, env, cors, url);
      }

      let body;
      if (url.pathname === "/config" && request.method === "GET") {
        const { settings } = await loadSettings(env);
        body = {
          publishableKey: env.STRIPE_PUBLISHABLE_KEY,
          currency: CURRENCY,
          countries: countryList(settings),
          prices: displayPrices(settings),
          taxEnabled: settings.collectTax,
        };
      } else if (url.pathname === "/quote" && request.method === "POST") {
        const { settings } = await loadSettings(env);
        const quote = await buildQuote(stripeClient(env), settings, await request.json(), {
          complete: false,
        });
        body = publicQuote(quote);
      } else if (url.pathname === "/checkout" && request.method === "POST") {
        const { settings } = await loadSettings(env);
        body = await createCheckout(stripeClient(env), settings, await request.json());
      } else {
        return json({ error: "not found" }, 404, cors);
      }
      return json(body, 200, cors);
    } catch (err) {
      if (err instanceof OrderError || err instanceof SettingsError) {
        return json({ error: err.message }, err.conflict ? 409 : 400, cors);
      }
      console.error(err);
      return json({ error: "something went wrong, please try again" }, 500, cors);
    }
  },
};

// Emails the customer of a shipped order and records it on the order.
// -> { order, email: { sent: true, to } | { sent: false, error } }
async function emailShipping(env, stripe, order) {
  try {
    // A double click sends one email; "send again" after a sent email
    // gets a new key because the last send time is part of it.
    const to = await sendShippingEmail(env, order, {
      idempotencyKey: ["shipping-email", order.id, order.shipment.at, order.shipment.emailedAt ?? "first"].join("-"),
    });
    const updated = await markShippingEmailed(stripe, order.id);
    return { order: updated, email: { sent: true, to } };
  } catch (err) {
    if (err instanceof OrderError) throw err;
    console.error(err);
    return { order, email: { sent: false, error: err.message } };
  }
}

// The dashboard's API. Every request needs the admin password
// (ADMIN_TOKEN secret) as "Authorization: Bearer <password>".
async function handleAdmin(request, env, cors, url) {
  if (!env.ADMIN_TOKEN) {
    return json({ error: "the dashboard isn't set up yet (see worker/README.md)" }, 503, cors);
  }
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!(await sameSecret(given, env.ADMIN_TOKEN))) {
    return json({ error: "wrong password" }, 401, cors);
  }

  if (url.pathname === "/admin/analytics") {
    if (request.method !== "GET") return json({ error: "not found" }, 404, cors);
    const days = Number(url.searchParams.get("days"));
    const report = await analyticsReport(env, stripeClient(env), PERIODS.includes(days) ? days : 30);
    return json(report, 200, cors);
  }

  if (url.pathname === "/admin/test-email") {
    if (request.method !== "POST") return json({ error: "not found" }, 404, cors);
    if (!emailConfigured(env)) {
      return json({ error: "order emails aren't set up yet (RESEND_API_KEY, see worker/README.md)" }, 400, cors);
    }
    try {
      await sendOrderEmail(env, sampleOrderPaymentIntent());
    } catch (err) {
      return json({ error: err.message }, 502, cors);
    }
    return json({ sentTo: env.ORDER_EMAIL_TO }, 200, cors);
  }

  if (url.pathname === "/admin/test-shipping-email") {
    if (request.method !== "POST") return json({ error: "not found" }, 404, cors);
    const to = (env.ORDER_EMAIL_TO ?? "").split(",")[0].trim();
    if (!to) return json({ error: "ORDER_EMAIL_TO isn't set in wrangler.toml" }, 400, cors);
    const sample = sampleOrderPaymentIntent();
    Object.assign(sample.metadata, {
      shipped_at: new Date().toISOString(), carrier: "canada-post", tracking_number: "1234567890123456",
    });
    const order = toOrder(sample);
    try {
      await sendShippingEmail(env, order, { to });
    } catch (err) {
      return json({ error: err.message }, 502, cors);
    }
    return json({ sentTo: to }, 200, cors);
  }

  if (url.pathname === "/admin/legacy-orders") {
    if (request.method === "GET") {
      return json({ orders: (await loadLegacyOrders(env)).map(legacyToOrder) }, 200, cors);
    }
    if (request.method === "PUT") {
      const body = await request.json().catch(() => null);
      const { orders, imported } = await importLegacyOrders(env, body?.orders);
      return json({ orders: orders.map(legacyToOrder), imported }, 200, cors);
    }
    if (request.method === "DELETE") {
      await clearLegacyOrders(env);
      return json({ orders: [] }, 200, cors);
    }
    return json({ error: "not found" }, 404, cors);
  }

  if (url.pathname === "/admin/orders") {
    if (request.method !== "GET") return json({ error: "not found" }, 404, cors);
    const result = await listOrders(stripeClient(env), url.searchParams.get("page"));
    const carriers = Object.fromEntries(Object.entries(CARRIERS).map(([id, c]) => [id, c.name]));
    return json({ ...result, carriers }, 200, cors);
  }

  const shipment = url.pathname.match(/^\/admin\/orders\/([^/]+)\/shipment$/);
  if (shipment) {
    const id = shipment[1];
    if (request.method === "PUT") {
      const body = (await request.json().catch(() => null)) ?? {};
      const stripe = stripeClient(env);
      const order = await setShipment(stripe, id, body);
      if (!body.notify) return json({ order, email: null }, 200, cors);
      // Marking shipped stands even if the email fails; the dashboard
      // shows the error and a button to try again.
      return json(await emailShipping(env, stripe, order), 200, cors);
    }
    if (request.method === "DELETE") {
      return json({ order: await setShipment(stripeClient(env), id, null) }, 200, cors);
    }
    return json({ error: "not found" }, 404, cors);
  }

  const shippingEmailRoute = url.pathname.match(/^\/admin\/orders\/([^/]+)\/shipping-email$/);
  if (shippingEmailRoute) {
    if (request.method !== "POST") return json({ error: "not found" }, 404, cors);
    const stripe = stripeClient(env);
    const order = await getOrder(stripe, shippingEmailRoute[1]);
    if (!order.shipment) throw new OrderError("mark the order as shipped first");
    return json(await emailShipping(env, stripe, order), 200, cors);
  }

  if (url.pathname !== "/admin/settings") return json({ error: "not found" }, 404, cors);

  if (request.method === "GET") {
    const { settings, updatedAt } = await loadSettings(env);
    return json({
      settings,
      updatedAt,
      storageReady: Boolean(env.SETTINGS),
      orderEmail: { to: env.ORDER_EMAIL_TO ?? "", ready: emailConfigured(env) },
      customerEmail: { from: env.CUSTOMER_EMAIL_FROM ?? "", ready: customerEmailConfigured(env) },
      sizes: SIZES,
      formats: Object.fromEntries(Object.entries(FORMATS).map(([id, f]) => [id, { label: f.label }])),
    }, 200, cors);
  }
  if (request.method === "PUT") {
    const body = await request.json().catch(() => null);
    const saved = await saveSettings(env, body?.settings, body?.updatedAt);
    return json(saved, 200, cors);
  }
  return json({ error: "not found" }, 404, cors);
}

// Compares secrets without leaking how much of them matched (hashing
// first makes both sides the same length).
async function sameSecret(a, b) {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all(
    [a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)))),
  );
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function stripeClient(env) {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

// Prices the cart from the request. With `complete`, a missing address
// (or one Stripe Tax can't use) is an error; otherwise the quote simply
// has no total yet. Without `collectTax`, total = items + shipping + fees.
async function buildQuote(stripe, settings, body, { complete }) {
  const collectTax = settings.collectTax;
  const lines = priceItems(settings, body?.items);
  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const address = cleanAddress(body?.address);

  const quote = {
    lines,
    subtotal,
    country: address.country ?? null,
    shippingOptions: [],
    shippingRate: null,
    fees: [],
    tax: null,
    taxError: null,
    total: null,
    calculation: null,
  };

  if (!address.country) {
    if (complete) throw new OrderError("please choose a country");
    return quote;
  }

  quote.shippingOptions = shippingOptionsFor(settings, address.country);
  quote.shippingRate = selectShipping(settings, address.country, body?.shippingRateId);
  quote.fees = feesFor(settings, address.country, subtotal);
  const feesTotal = quote.fees.reduce((sum, f) => sum + f.amount, 0);

  if (!collectTax) {
    quote.tax = 0;
    quote.total = subtotal + quote.shippingRate.amount + feesTotal;
    return quote;
  }

  if (!hasTaxableAddress(address)) {
    if (complete) throw new OrderError("please complete your shipping address");
    return quote;
  }

  try {
    const calculation = await stripe.tax.calculations.create({
      currency: CURRENCY,
      line_items: [
        ...lines.map((l) => ({
          amount: l.amount,
          quantity: l.quantity,
          reference: l.format + ":" + l.size,
          tax_code: TAX_CODE,
          tax_behavior: "exclusive",
        })),
        // Fees are charged on the goods, so they're taxed like them.
        ...quote.fees.filter((f) => f.amount > 0).map((f) => ({
          amount: f.amount,
          reference: "fee:" + f.id,
          tax_code: TAX_CODE,
          tax_behavior: "exclusive",
        })),
      ],
      shipping_cost: {
        amount: quote.shippingRate.amount,
        tax_behavior: "exclusive",
      },
      customer_details: {
        address,
        address_source: "shipping",
      },
    });
    quote.calculation = calculation;
    quote.tax = calculation.tax_amount_exclusive;
    quote.total = calculation.amount_total;
  } catch (err) {
    // Stripe Tax rejects addresses it can't locate (e.g. a postal code
    // that doesn't match the province). Report it instead of failing.
    if (err?.type !== "StripeInvalidRequestError") throw err;
    // Also shows setup problems, e.g. Stripe Tax not activated yet.
    console.warn("tax calculation failed:", err.message);
    const message = "we couldn't calculate tax for this address, please check it";
    if (complete) throw new OrderError(message);
    quote.taxError = message;
  }

  return quote;
}

// What the browser gets to see (no Stripe internals).
function publicQuote(quote) {
  return {
    currency: CURRENCY,
    items: quote.lines,
    subtotal: quote.subtotal,
    shippingOptions: quote.shippingOptions,
    shippingRateId: quote.shippingRate?.id ?? null,
    shipping: quote.shippingRate?.amount ?? null,
    fees: quote.fees,
    tax: quote.tax,
    taxError: quote.taxError,
    total: quote.total,
  };
}

async function createCheckout(stripe, settings, body) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
  const address = cleanAddress(body?.address);
  validateCheckoutDetails({ name, email, address });

  const quote = await buildQuote(stripe, settings, body, { complete: true });

  const paymentIntent = await stripe.paymentIntents.create({
    amount: quote.total,
    currency: CURRENCY,
    automatic_payment_methods: { enabled: true },
    receipt_email: email,
    description: quote.lines.map((l) => l.quantity + " x " + l.label).join(", "),
    shipping: {
      name,
      phone: phone || undefined,
      address,
    },
    metadata: {
      items: itemsMetadata(quote.lines),
      shipping_rate: quote.shippingRate.id,
      shipping_amount: String(quote.shippingRate.amount),
      fees: feesMetadata(quote.fees),
      tax_amount: String(quote.tax),
      // Only set when Stripe Tax is on; the webhook records it as a sale.
      ...(quote.calculation && { tax_calculation: quote.calculation.id }),
    },
  });

  return {
    clientSecret: paymentIntent.client_secret,
    quote: publicQuote(quote),
  };
}

async function handleWebhook(request, env) {
  const stripe = stripeClient(env);
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await request.text(),
      request.headers.get("stripe-signature"),
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (err) {
    return new Response("invalid signature", { status: 400 });
  }

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;
    const calculation = paymentIntent.metadata?.tax_calculation;

    // Turns the tax calculation into a recorded transaction so the sale
    // shows up in Stripe Tax reports. The idempotency key makes Stripe's
    // webhook retries safe.
    if (calculation) {
      await stripe.tax.transactions.createFromCalculation(
        { calculation, reference: paymentIntent.id },
        { idempotencyKey: "tax-transaction-" + paymentIntent.id },
      );
    }

    console.log("order paid", paymentIntent.id, paymentIntent.metadata?.items);

    // "New order" email to the shop. A failure is logged, not retried:
    // the order itself is fine and is in the dashboard either way.
    try {
      await sendOrderEmail(env, paymentIntent);
    } catch (err) {
      console.error("order email failed", paymentIntent.id, err);
    }
  }

  return new Response("ok");
}

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim());
  const origin = request.headers.get("origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
