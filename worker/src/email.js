// Emails sent through Resend (resend.com):
// - "New order" to the shop when Stripe confirms a payment (webhook).
// - "Your order is on its way" to the customer when an order is marked
//   shipped in the dashboard. Customer emails need a sender on a domain
//   verified in Resend (CUSTOMER_EMAIL_FROM, e.g. orders@cassetteshelf.com).
//
// Setup (see README): RESEND_API_KEY secret; ORDER_EMAIL_TO / ORDER_EMAIL_FROM
// / DASHBOARD_URL vars in wrangler.toml. With Resend's starter sender
// (onboarding@resend.dev), emails can only go to the address the Resend
// account was created with, so create it with ORDER_EMAIL_TO.

import { toOrder } from "./orders.js";

const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "cassetteshelf orders <onboarding@resend.dev>";

export function emailConfigured(env) {
  return Boolean(env.RESEND_API_KEY && env.ORDER_EMAIL_TO);
}

export function customerEmailConfigured(env) {
  return Boolean(env.RESEND_API_KEY && env.CUSTOMER_EMAIL_FROM);
}

// Posts one email to Resend; throws a readable error if it's refused.
async function sendWithResend(env, email, idempotencyKey) {
  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.RESEND_API_KEY,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(email),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    const hint = /domain/i.test(detail) && /verif/i.test(detail)
      ? " (verify cassetteshelf.com in Resend → Domains, see worker/README.md)"
      : "";
    throw new Error("Resend refused the email (" + response.status + "): " + detail + hint);
  }
}

// Sends the email for a paid PaymentIntent. Returns false (and logs) when
// email isn't set up; throws if Resend refuses the email.
export async function sendOrderEmail(env, paymentIntent) {
  if (!emailConfigured(env)) {
    console.log("order email skipped (RESEND_API_KEY / ORDER_EMAIL_TO not set)", paymentIntent.id);
    return false;
  }
  const order = toOrder(paymentIntent);
  await sendWithResend(env, {
    from: env.ORDER_EMAIL_FROM || DEFAULT_FROM,
    to: env.ORDER_EMAIL_TO.split(",").map((a) => a.trim()).filter(Boolean),
    ...(order.customer.email ? { reply_to: order.customer.email } : {}),
    ...orderEmail(order, env.DASHBOARD_URL),
  // Stripe can send the same webhook twice; Resend then sends once.
  }, "order-email-" + order.id);
  return true;
}

// "Your order is on its way" to the customer of a shipped order. `to`
// overrides the recipient (the dashboard's test sends it to the shop).
export async function sendShippingEmail(env, order, { to, idempotencyKey } = {}) {
  if (!customerEmailConfigured(env)) {
    throw new Error("customer emails aren't set up yet (CUSTOMER_EMAIL_FROM, see worker/README.md)");
  }
  const recipient = to || order.customer.email;
  if (!recipient) throw new Error("this order has no customer email address");
  await sendWithResend(env, {
    from: env.CUSTOMER_EMAIL_FROM,
    to: [recipient],
    reply_to: (env.ORDER_EMAIL_TO || "").split(",")[0].trim() || undefined,
    ...shippingEmail(order),
  }, idempotencyKey);
  return recipient;
}

// -> { subject, text, html } for the customer.
export function shippingEmail(order) {
  const s = order.shipment ?? {};
  const first = (order.customer.name || "").trim().split(/\s+/)[0];
  const items = order.items.map((i) => i.quantity + " × " + i.label);
  const address = addressLines(order);
  const carrier = s.carrierName && s.carrier !== "other" ? s.carrierName : "";
  const shippedWith = carrier ? " with " + carrier : "";

  const subject = "Your cassetteshelf order is on its way";
  const text = [
    (first ? "Hi " + first + "," : "Hi,"),
    "",
    "Good news: your order has shipped" + shippedWith + ".",
    ...(s.tracking ? ["", "Tracking number: " + s.tracking, ...(s.trackingUrl ? ["Track your package: " + s.trackingUrl] : [])] : []),
    "",
    "YOUR ORDER",
    ...items,
    "",
    "SHIPPING TO",
    ...address,
    "",
    "Questions about your order? Just reply to this email.",
    "",
    "Thank you!",
    "cassetteshelf.com",
  ].join("\n");

  const e = escapeHtml;
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#000;line-height:1.5;max-width:520px">
<p style="margin:0 0 12px">${e(first ? "Hi " + first + "," : "Hi,")}</p>
<p style="margin:0 0 16px">Good news: your order has shipped${e(shippedWith)}.</p>
${s.tracking ? `<p style="margin:0 0 16px">Tracking number: <strong>${e(s.tracking)}</strong>${s.trackingUrl
    ? `<br><a href="${e(s.trackingUrl)}" style="display:inline-block;margin-top:10px;padding:8px 20px;border-radius:999px;background:#000;color:#fff;text-decoration:none">Track your package</a>` : ""}</p>` : ""}
<h3 style="margin:20px 0 4px;font-size:15px">Your order</h3>
<p style="margin:0">${items.map(e).join("<br>")}</p>
<h3 style="margin:20px 0 4px;font-size:15px">Shipping to</h3>
<p style="margin:0">${address.map(e).join("<br>")}</p>
<p style="margin:24px 0 0">Questions about your order? Just reply to this email.</p>
<p style="margin:16px 0 0">Thank you!<br><a href="https://cassetteshelf.com" style="color:#000">cassetteshelf.com</a></p>
</div>`;
  return { subject, text, html };
}

function addressLines(order) {
  const a = order.address;
  let country = a.country;
  try {
    country = new Intl.DisplayNames(["en"], { type: "region" }).of(a.country) || a.country;
  } catch {
    // keep the code
  }
  return [order.customer.name, a.line1, a.line2, [a.city, a.state, a.postal_code].filter(Boolean).join(" "), country]
    .filter(Boolean);
}

// -> { subject, text, html }
export function orderEmail(order, dashboardUrl) {
  const money = (cents) => ((cents || 0) / 100).toFixed(2) + "$ " + (order.currency || "cad").toUpperCase();
  const items = order.items.map((i) => i.quantity + " × " + i.label);
  const feesTotal = order.fees.reduce((sum, f) => sum + f.amount, 0);
  const shelves = order.total - (order.shipping.amount || 0) - (order.tax || 0) - feesTotal;
  const charges = [
    ["Shelves", shelves],
    ["Shipping (" + (order.shipping.option || "—") + (order.shipping.waived ? ", WAIVED by the customer" : "") + ")", order.shipping.amount || 0],
    ...order.fees.map((f) => [capitalize(f.id), f.amount]),
    ...(order.tax ? [["Tax", order.tax]] : []),
  ];
  const a = order.address;
  let country = a.country;
  try {
    country = new Intl.DisplayNames(["en"], { type: "region" }).of(a.country) || a.country;
  } catch {
    // keep the code
  }
  const address = [
    order.customer.name, a.line1, a.line2,
    [a.city, a.state, a.postal_code].filter(Boolean).join(" "),
    country,
  ].filter(Boolean);
  const contact = [order.customer.email, order.customer.phone].filter(Boolean);
  const links = [["View in Stripe", order.stripeUrl], ...(dashboardUrl ? [["Open the dashboard", dashboardUrl]] : [])];

  const subject = "New order: " + money(order.total) + " — " + (order.customer.name || "customer") +
    " (" + items.join(", ") + ")";

  const text = [
    "New order " + order.id,
    "",
    "ITEMS",
    ...items,
    "",
    ...charges.map(([label, cents]) => label + ": " + money(cents)),
    "Total: " + money(order.total),
    "",
    "SHIP TO",
    ...address,
    "",
    "CUSTOMER",
    ...contact,
    "",
    ...links.map(([label, url]) => label + ": " + url),
    "",
    "Reply to this email to write to the customer.",
  ].join("\n");

  const e = escapeHtml;
  const row = (label, value, bold) =>
    `<tr><td style="padding:2px 24px 2px 0">${e(label)}</td><td style="padding:2px 0;text-align:right${bold ? ";font-weight:bold" : ""}">${e(value)}</td></tr>`;
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#000;line-height:1.4">
<h2 style="margin:0 0 4px">New order · ${e(money(order.total))}</h2>
<p style="margin:0 0 16px;color:#555">${e(order.id)}</p>
<h3 style="margin:16px 0 4px">Items</h3>
<p style="margin:0">${items.map(e).join("<br>")}</p>
<table style="border-collapse:collapse;margin-top:8px">${charges.map(([l, c]) => row(l, money(c))).join("")}${row("Total", money(order.total), true)}</table>
<h3 style="margin:16px 0 4px">Ship to</h3>
<p style="margin:0">${address.map(e).join("<br>")}</p>
<h3 style="margin:16px 0 4px">Customer</h3>
<p style="margin:0">${contact.map(e).join("<br>") || "—"}</p>
<p style="margin:20px 0 0">${links.map(([l, u]) => `<a href="${e(u)}" style="color:#000">${e(l)}</a>`).join(" · ")}</p>
<p style="margin:16px 0 0;color:#555;font-size:13px">Reply to this email to write to the customer.</p>
</div>`;

  return { subject: subject.slice(0, 250), text, html };
}

// A made-up order for the dashboard's "Send test email" button.
export function sampleOrderPaymentIntent() {
  return {
    id: "pi_TEST_EXAMPLE", object: "payment_intent", created: Math.floor(Date.now() / 1000),
    amount: 6627, amount_received: 6627, currency: "cad", livemode: true, status: "succeeded",
    receipt_email: null,
    shipping: { name: "Test Customer", phone: "", address: { line1: "123 Example St", city: "Montréal", state: "QC", postal_code: "H2X 1Y4", country: "CA" } },
    metadata: { items: "cassette:1x1:1", shipping_rate: "standard", shipping_amount: "2500", fees: "tariffs:1376", tax_amount: "0" },
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
