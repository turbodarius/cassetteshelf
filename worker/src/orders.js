// Orders for the /admin dashboard, read straight from Stripe: every paid
// PaymentIntent is an order, and the checkout stores what was bought in
// its metadata (see createCheckout in index.js). Nothing is copied or
// stored elsewhere, so refunds made in Stripe show up here too.

import { FORMATS } from "./catalog.js";

const PAGE_SIZE = 25;

// -> { orders: [...], nextPage } (newest first; nextPage is null at the end)
export async function listOrders(stripe, page) {
  const result = await stripe.paymentIntents.search({
    query: 'status:"succeeded"',
    limit: PAGE_SIZE,
    expand: ["data.latest_charge"],
    ...(page ? { page } : {}),
  });
  return {
    orders: result.data.map(toOrder),
    nextPage: result.has_more ? result.next_page : null,
  };
}

// One Stripe PaymentIntent -> the order shown in the dashboard.
export function toOrder(pi) {
  const meta = pi.metadata ?? {};
  const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const refunded = charge?.amount_refunded ?? 0;
  const address = pi.shipping?.address ?? {};

  return {
    id: pi.id,
    created: new Date(pi.created * 1000).toISOString(),
    total: pi.amount_received || pi.amount,
    currency: pi.currency,
    refunded,
    status: refunded === 0 ? "paid" : refunded >= (pi.amount_received || pi.amount) ? "refunded" : "partially refunded",
    customer: {
      name: pi.shipping?.name ?? "",
      email: pi.receipt_email ?? charge?.billing_details?.email ?? "",
      phone: pi.shipping?.phone ?? "",
    },
    address: {
      line1: address.line1 ?? "",
      line2: address.line2 ?? "",
      city: address.city ?? "",
      state: address.state ?? "",
      postal_code: address.postal_code ?? "",
      country: address.country ?? "",
    },
    items: parseItems(meta.items),
    shipping: {
      option: meta.shipping_rate ?? "",
      amount: toInt(meta.shipping_amount),
    },
    fees: parseFees(meta.fees),
    tax: toInt(meta.tax_amount),
    paymentMethod: describePayment(charge?.payment_method_details),
    stripeUrl: "https://dashboard.stripe.com/" + (pi.livemode ? "" : "test/") + "payments/" + pi.id,
  };
}

// "cassette:2x2:1,cd:1x1:2" -> [{ format, size, quantity, label }]
function parseItems(text) {
  if (!text) return [];
  return text.split(",").map((part) => {
    const [format, size, quantity] = part.split(":");
    const label = (Object.hasOwn(FORMATS, format) ? FORMATS[format].label : format) ?? "";
    return { format, size, quantity: toInt(quantity) ?? 1, label: size + " " + label };
  });
}

// "tariffs:1376" -> [{ id, amount }]
function parseFees(text) {
  if (!text) return [];
  return text.split(",").map((part) => {
    const [id, amount] = part.split(":");
    return { id, amount: toInt(amount) ?? 0 };
  });
}

// "Visa •••• 4242", "Visa •••• 4242 (Apple Pay)", or the method's name.
function describePayment(details) {
  if (!details) return "";
  if (details.type === "card" && details.card) {
    const { brand, last4, wallet } = details.card;
    const name = capitalize(brand ?? "card") + " •••• " + (last4 ?? "");
    return wallet?.type ? name + " (" + titleCase(wallet.type) + ")" : name;
  }
  return capitalize((details.type ?? "").replace(/_/g, " "));
}

// "apple_pay" -> "Apple Pay"
function titleCase(text) {
  return text.split("_").map(capitalize).join(" ");
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function toInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}
