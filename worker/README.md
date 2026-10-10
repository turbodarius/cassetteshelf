# cassetteshelf checkout worker

Small Cloudflare Worker that powers the checkout window on the site. It holds
the Stripe secret key and the official prices and shipping rates, and creates
the payment. Sales tax (Stripe Tax) is built in but **off** by default; see
[Turning on sales tax](#turning-on-sales-tax). The site (GitHub Pages) never sees the
secret key and can't change what a customer is charged.

| File | What it's for |
|---|---|
| `src/analytics.js` | Records anonymous visits / checkout steps and builds the Analytics tab's report. |
| `src/email.js` | The "new order" email to the shop and the "order shipped" email to customers, sent through Resend. |
| `src/legacy.js` | Stores orders imported from a Shopify CSV export (in KV, never in the repo). |
| `src/orders.js` | Reads paid orders from Stripe for the dashboard's Orders tab. |
| `src/settings.js` | Loads, checks and saves the store settings edited in the `/admin` dashboard. |
| `src/shipping.js` | Starting countries, shipping rates and fees (until the dashboard's first save). |
| `src/catalog.js` | Product formats and starting prices (cents). Must match `prices.js` / `pricesCD.js`. |
| `src/pricing.js` | Cart validation and price math (no Stripe calls). |
| `src/index.js` | The routes: `/config`, `/quote`, `/checkout`, `/webhook`, `/track` and the `/admin/...` dashboard API. |
| `test/` | `npm test`, runs without a Stripe account. |

## One-time setup

Do everything in **test mode** first (Stripe dashboard toggle, `sk_test_` / `pk_test_` keys).

### 1. Stripe

1. **Receipts:** Settings → Customer emails → enable *Successful payments*.
   Receipts are only emailed in live mode.
2. **Apple Pay / Google Pay:** Settings → Payment methods → Payment method domains → add `cassetteshelf.com`.
3. Copy your **publishable key** and **secret key** (Developers → API keys).

### 2. Deploy the worker

```sh
cd worker
npm install
npx wrangler login                      # opens Cloudflare in the browser
# put your pk_test_... key in wrangler.toml (STRIPE_PUBLISHABLE_KEY)
npx wrangler secret put STRIPE_SECRET_KEY   # paste sk_test_...
npm run deploy                          # prints https://cassetteshelf-checkout.<you>.workers.dev
```

Put that URL in `API_BASE` at the top of `../checkout.js`.

### 3. Webhook

Stripe Dashboard → Developers → Webhooks → *Add endpoint*:

- URL: `https://cassetteshelf-checkout.<you>.workers.dev/webhook`
- Event: `payment_intent.succeeded`

Copy the endpoint's signing secret (`whsec_...`), then run the command below.
With tax off, the webhook only logs orders (and is where you'd add an order
notification); with tax on, it also records each sale in Stripe Tax.

```sh
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

### 4. Try it

Open the site, add a shelf, and pay with test card `4242 4242 4242 4242`
(any future date, any CVC). The payment then shows up in Dashboard → Payments,
with the shipping address and the items (`metadata.items`, e.g. `cassette:2x2:1`).

## Order emails

Every paid order sends an email to `ORDER_EMAIL_TO` in `wrangler.toml`
(`contact@cassetteshelf.com`) with the items, price breakdown, shipping
address, customer contact and links to Stripe and the dashboard. Replying
writes to the customer. It's sent from the Stripe webhook (setup step 3), so
the webhook must be set up. Emails go through [Resend](https://resend.com)
(free up to 3,000 emails a month).

1. Sign up at resend.com **with contact@cassetteshelf.com**. Until you verify
   your domain in Resend, its starter sender (`onboarding@resend.dev`) can only
   email the address the account was created with.
2. In Resend: **API Keys** → **Create API key** (permission: sending access) → copy it.
3. Store it and deploy:
   ```sh
   cd worker
   npx wrangler secret put RESEND_API_KEY
   npm run deploy
   ```
4. In the dashboard, **Settings** → **Emails** → **Send a test email**.

To send from your own address (e.g. `orders@cassetteshelf.com`), verify the
domain (below), then change `ORDER_EMAIL_FROM` in `wrangler.toml` and
redeploy. If an email fails, the order is unaffected; `npx wrangler tail`
shows the error.

## Shipping emails to customers

When you mark an order as shipped in the dashboard, **Email the customer**
(ticked by default) sends them "Your cassetteshelf order is on its way" with
the carrier, tracking number and a tracking link, what they bought and the
shipping address. It's sent from `CUSTOMER_EMAIL_FROM` in `wrangler.toml`
(`orders@cassetteshelf.com`); replies go to `ORDER_EMAIL_TO`. The order then
shows "customer emailed" with the date (also saved on the payment in Stripe
as `shipping_email_sent_at`). If the email fails, the order is still marked
shipped and **Send shipping email** on the order tries again.

Resend only sends to customers from a domain you've verified, once:

1. In Resend: **Domains** → **Add domain** → `cassetteshelf.com`.
2. Add the DNS records it lists (a few TXT/MX records) wherever cassetteshelf.com's
   DNS is managed (your domain registrar, or Cloudflare if the domain uses it).
3. Wait until Resend shows the domain as **Verified** (minutes to a few hours).
4. In the dashboard, **Settings** → **Emails** → **Send a test shipping email**
   (it goes to `ORDER_EMAIL_TO`, not a customer).

## Going live

1. Switch the Stripe dashboard to live mode and repeat the payment method domain and webhook steps (and Stripe Tax, if on) there.
2. Put the `pk_live_...` key in `wrangler.toml`.
3. Run `npx wrangler secret put STRIPE_SECRET_KEY` with the `sk_live_...` key.
4. Run `npx wrangler secret put STRIPE_WEBHOOK_SECRET` with the live webhook's secret.
5. Run `npm run deploy`.

## Turning on sales tax

1. In Stripe: Dashboard → Tax.
   - Set your origin address (Montréal).
   - Add a **registration** for every tax you're registered to collect (e.g. GST/HST, QST, any US states).
   - Stripe Tax only charges tax where you've added a registration; with none, tax will be 0.
2. Tick **Collect sales tax with Stripe Tax** in the dashboard and save.

The checkout then shows a tax line (anything marked `data-tax-only` in the
markup) and adds tax to the total once the address is complete. Untick it to
turn tax off again. (`COLLECT_TAX` in `wrangler.toml` is only the starting
value before the dashboard's first save.)

## Admin dashboard (prices, countries, shipping, fees, tax)

Everything below is edited at **https://cassetteshelf.com/admin/**:

- **Prices** for every size of cassette and CD shelf. Leave a size empty to
  make it unavailable (the site shows "contact us").
- **Countries** you ship to, each with its **shipping options** (flat price per
  order) and **fees** (percentages of the shelves' total, e.g. 50% US tariffs).
- **Sales tax** on/off (see [Turning on sales tax](#turning-on-sales-tax)).

Saving takes effect on the site within about a minute, with no redeploy. The
worker checks every save, so a typo can't break the checkout.

The **Orders** tab lists every paid order, newest first, read straight from
Stripe (nothing is stored elsewhere, so refunds made in Stripe show up too):
customer, shipping address (with a copy button), shelves bought, shipping,
fees, tax, payment method and a link to the payment in Stripe. **Download CSV**
exports the loaded orders for a spreadsheet. New orders can take about a minute
to appear (Stripe's search is updated with a short delay).

**Earlier orders (Shopify)**: import a Shopify orders export (Orders → Export →
"All orders", CSV) with **Import Shopify CSV** in the Orders tab. The orders
are stored privately in Cloudflare KV (`legacy-orders`, next to the settings),
never in this repository, since they contain customers' personal details.
Importing the same file again updates rather than duplicates them; **Remove
imported orders** deletes them from the dashboard (not from Shopify). Shopify's
variant names ("cassetteshelf - 2 / 2", columns / rows) are shown as "2x2
cassette shelf", and the imported orders count in the Analytics tab's sales
on their original dates. Conversion only uses orders from days when visits
were being counted.

**Mark as shipped** (on each order) records the date, carrier and an optional
tracking number on the payment in Stripe (metadata `shipped_at`, `carrier`,
`tracking_number`), so it also shows in Stripe's dashboard, and can email the
customer (see [Shipping emails to customers](#shipping-emails-to-customers)). Orders still to
ship are labelled and counted, and **Only show orders to ship** filters the
list. **Undo** clears it. Carriers and their tracking pages are listed in
`CARRIERS` in `src/orders.js`.

The **Analytics** tab (7 days / 30 days / 90 days / 12 months) shows:

- **Sales** from Stripe: revenue after refunds, orders, average order,
  conversion, revenue per day, best sellers, sales by country, shipping chosen,
  fees collected.
- **Traffic** from the site itself: visitors, page views, visitors per day, top
  pages, where visitors come from, countries, devices, most added to cart.
- **Checkout funnel**: how many visitors visited → added to cart → opened
  checkout → entered an address → pressed Purchase → paid.
- **Abandoned purchases**: people who pressed Purchase but didn't pay, with
  their contact details from Stripe, what happened (e.g. card declined) and
  whether they bought later.

Traffic is counted by `track.js` on the site, sent to `POST /track` and kept in
a Cloudflare D1 database (`ANALYTICS` in `wrangler.toml`, created by the first
`npm run deploy`). It's anonymous: no cookies, nothing stored in the visitor's
browser, no IP addresses saved. Each visitor gets a code made from a random
value that changes daily and is then deleted, so people can't be followed
across days. Bots, the admin page and browsers set to "Do Not Track" aren't
counted, and events older than about 13 months are removed.

### One-time setup

1. Pick a long password and keep it in your password manager. On a Mac,
   `openssl rand -base64 24` makes a good one.
2. Store it in Cloudflare (it's never in the repo):
   ```sh
   cd worker
   npx wrangler secret put ADMIN_TOKEN
   ```
3. Deploy. The first deploy also creates the storage the dashboard saves to
   (`SETTINGS` in `wrangler.toml`); if Wrangler asks, choose to create a new
   KV namespace:
   ```sh
   npm run deploy
   ```
4. Open `/admin/` on the site and log in with the password.

Until the first save, the dashboard shows the starting values from
`src/catalog.js` (prices) and `src/shipping.js` (countries, shipping, fees).
After that, the dashboard's values are used and edits to those files have no
effect. The site's `prices.js` / `pricesCD.js` are only a fallback shown if the
worker can't be reached; `npm test` checks they still match `src/catalog.js`.
