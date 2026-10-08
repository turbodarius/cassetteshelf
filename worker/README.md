# cassetteshelf checkout worker

Small Cloudflare Worker that powers the checkout window on the site. It holds
the Stripe secret key and the official prices and shipping rates, and creates
the payment. Sales tax (Stripe Tax) is built in but **off** by default; see
[Turning on sales tax](#turning-on-sales-tax). The site (GitHub Pages) never sees the
secret key and can't change what a customer is charged.

| File | What it's for |
|---|---|
| `src/shipping.js` | **Flat shipping rates per country.** Edit, then redeploy. |
| `src/catalog.js` | **Official prices** (cents). Must match `prices.js` / `pricesCD.js`. |
| `src/pricing.js` | Cart validation and price math (no Stripe calls). |
| `src/index.js` | The routes: `/config`, `/quote`, `/checkout`, `/webhook`. |
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
2. Set `COLLECT_TAX = "true"` in `wrangler.toml` and run `npm run deploy`.

The checkout then shows a tax line (anything marked `data-tax-only` in the
markup) and adds tax to the total once the address is complete. Set it back to
`"false"` to turn tax off again.

## Changing shipping rates or prices

- **Shipping:** edit `src/shipping.js` (amounts in cents, CAD). Countries use
  their two-letter ISO code (`FR`, `GB`, `DE`, ...). New countries just work: the
  province/state field only appears for countries listed in `REGIONS` in
  `../checkout.js` (Canada and the US).
- **Prices:** edit `prices.js` / `pricesCD.js` on the site **and** `src/catalog.js`.

Then:

```sh
npm test        # fails if catalog.js and the site's prices disagree
npm run deploy
```

## Local development

```sh
cp .dev.vars.example .dev.vars          # fill in test keys
npm run dev                             # worker on http://localhost:8787
# in another terminal, from the repo root:
python3 -m http.server 8000             # site on http://localhost:8000
```

While testing locally, set `API_BASE` in `checkout.js` to `http://localhost:8787`.
To receive webhooks locally, use the Stripe CLI:
`stripe listen --forward-to localhost:8787/webhook`.

## Logs

`npx wrangler tail` streams the worker's logs live, including an `order paid` line per order.
To get notified of new orders, fill in the `TODO` in `handleWebhook` (`src/index.js`).
