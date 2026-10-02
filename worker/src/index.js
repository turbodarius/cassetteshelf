// cassetteshelf checkout backend (Cloudflare Worker).
//
// Routes:
//   GET  /config    publishable key + countries we ship to
//   POST /quote     prices a cart: subtotal, shipping options, tax, total
//   POST /checkout  re-prices the cart and creates a Stripe PaymentIntent
//   POST /webhook   Stripe webhook: records the tax transaction once paid
//
// Secrets (set with `wrangler secret put`): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
// Vars (wrangler.toml): STRIPE_PUBLISHABLE_KEY, ALLOWED_ORIGINS

import Stripe from "stripe";
import { CURRENCY, TAX_CODE } from "./catalog.js";
import {
  OrderError,
  cleanAddress,
  countryList,
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

    try {
      let body;
      if (url.pathname === "/config" && request.method === "GET") {
        body = {
          publishableKey: env.STRIPE_PUBLISHABLE_KEY,
          currency: CURRENCY,
          countries: countryList(),
        };
      } else if (url.pathname === "/quote" && request.method === "POST") {
        const quote = await buildQuote(stripeClient(env), await request.json(), false);
        body = publicQuote(quote);
      } else if (url.pathname === "/checkout" && request.method === "POST") {
        body = await createCheckout(stripeClient(env), await request.json());
      } else {
        return json({ error: "not found" }, 404, cors);
      }
      return json(body, 200, cors);
    } catch (err) {
      if (err instanceof OrderError) {
        return json({ error: err.message }, 400, cors);
      }
      console.error(err);
      return json({ error: "something went wrong, please try again" }, 500, cors);
    }
  },
};

function stripeClient(env) {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

// Prices the cart from the request. With requireTax, an address Stripe
// Tax can't use is an error; otherwise the quote simply has no tax yet.
async function buildQuote(stripe, body, requireTax) {
  const lines = priceItems(body?.items);
  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const address = cleanAddress(body?.address);

  const quote = {
    lines,
    subtotal,
    country: address.country ?? null,
    shippingOptions: [],
    shippingRate: null,
    tax: null,
    taxError: null,
    total: null,
    calculation: null,
  };

  if (!address.country) {
    if (requireTax) throw new OrderError("please choose a country");
    return quote;
  }

  quote.shippingOptions = shippingOptionsFor(address.country);
  quote.shippingRate = selectShipping(address.country, body?.shippingRateId);

  if (!hasTaxableAddress(address)) {
    if (requireTax) throw new OrderError("please complete your shipping address");
    return quote;
  }

  try {
    const calculation = await stripe.tax.calculations.create({
      currency: CURRENCY,
      line_items: lines.map((l) => ({
        amount: l.amount,
        quantity: l.quantity,
        reference: l.format + ":" + l.size,
        tax_code: TAX_CODE,
        tax_behavior: "exclusive",
      })),
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
    if (requireTax) throw new OrderError(message);
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
    tax: quote.tax,
    taxError: quote.taxError,
    total: quote.total,
  };
}

async function createCheckout(stripe, body) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
  const address = cleanAddress(body?.address);
  validateCheckoutDetails({ name, email, address });

  const quote = await buildQuote(stripe, body, true);

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
      tax_amount: String(quote.tax),
      tax_calculation: quote.calculation.id,
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

    // TODO: notify yourself of the new order here (email, Discord, etc.).
    // Everything you need is on paymentIntent: shipping, metadata.items,
    // amount, receipt_email.
    console.log("order paid", paymentIntent.id, paymentIntent.metadata?.items);
  }

  return new Response("ok");
}

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim());
  const origin = request.headers.get("origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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
