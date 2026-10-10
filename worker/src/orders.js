// Orders for the /admin dashboard, read straight from Stripe: every paid
// PaymentIntent is an order, and the checkout stores what was bought in
// its metadata (see createCheckout in index.js). Nothing is copied or
// stored elsewhere, so refunds made in Stripe show up here too.
//
// "Mark as shipped" also lives on the PaymentIntent, as metadata:
// shipped_at, carrier, tracking_number (visible in Stripe as well), and
// shipping_email_sent_at once the customer was emailed about it.

import { FORMATS } from "./catalog.js";
import { OrderError } from "./pricing.js";

// Carriers the dashboard offers, with their public tracking pages.
export const CARRIERS = {
  "canada-post": { name: "Canada Post", track: "https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=" },
  ups: { name: "UPS", track: "https://www.ups.com/track?tracknum=" },
  usps: { name: "USPS", track: "https://tools.usps.com/go/TrackConfirmAction?tLabels=" },
  fedex: { name: "FedEx", track: "https://www.fedex.com/fedextrack/?trknbr=" },
  dhl: { name: "DHL", track: "https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=" },
  purolator: { name: "Purolator", track: "https://www.purolator.com/en/shipping/tracker?pin=" },
  other: { name: "Other", track: null },
};

// shipment = { carrier, tracking } marks the order shipped now;
// shipment = null marks it not shipped (undo). Returns the updated order.
export async function setShipment(stripe, id, shipment) {
  if (!/^pi_[A-Za-z0-9]{1,100}$/.test(id ?? "")) throw new OrderError("unknown order");
  const pi = await stripe.paymentIntents.retrieve(id);
  if (pi.status !== "succeeded") throw new OrderError("this order isn't paid");

  let metadata;
  if (shipment) {
    const carrier = shipment.carrier ?? "";
    if (!Object.hasOwn(CARRIERS, carrier)) throw new OrderError("choose a carrier");
    const tracking = typeof shipment.tracking === "string"
      ? shipment.tracking.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 100)
      : "";
    metadata = { shipped_at: new Date().toISOString(), carrier, tracking_number: tracking };
  } else {
    // Empty values remove the keys from the PaymentIntent.
    metadata = { shipped_at: "", carrier: "", tracking_number: "", shipping_email_sent_at: "" };
  }
  const updated = await stripe.paymentIntents.update(id, { metadata, expand: ["latest_charge"] });
  return toOrder(updated);
}

// A paid order by id (for the "send shipping email" button).
export async function getOrder(stripe, id) {
  if (!/^pi_[A-Za-z0-9]{1,100}$/.test(id ?? "")) throw new OrderError("unknown order");
  const pi = await stripe.paymentIntents.retrieve(id, { expand: ["latest_charge"] });
  if (pi.status !== "succeeded") throw new OrderError("this order isn't paid");
  return toOrder(pi);
}

// Records that the customer got the shipping email. Returns the updated order.
export async function markShippingEmailed(stripe, id) {
  const updated = await stripe.paymentIntents.update(id, {
    metadata: { shipping_email_sent_at: new Date().toISOString() },
    expand: ["latest_charge"],
  });
  return toOrder(updated);
}

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
    shipment: meta.shipped_at ? describeShipment(meta) : null,
    stripeUrl: "https://dashboard.stripe.com/" + (pi.livemode ? "" : "test/") + "payments/" + pi.id,
  };
}

function describeShipment(meta) {
  const carrier = Object.hasOwn(CARRIERS, meta.carrier) ? CARRIERS[meta.carrier] : null;
  const tracking = meta.tracking_number || "";
  return {
    at: meta.shipped_at,
    carrier: meta.carrier || "",
    carrierName: carrier?.name ?? meta.carrier ?? "",
    tracking,
    trackingUrl: carrier?.track && tracking ? carrier.track + encodeURIComponent(tracking) : null,
    emailedAt: meta.shipping_email_sent_at || null,
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
