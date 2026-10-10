// Checkout window: cart, shipping address, shipping options, Stripe Tax
// and Stripe payment. Markup is in index.html (#checkout), styles in
// checkout.css. Prices, shipping rates and tax are always calculated by
// the checkout worker (/worker); this file only displays them.
//
// Public API (used by the configurator in index.html):
//   cassetteCheckout.add(format, size)   "cassette" | "cd", e.g. "3x4"
//   cassetteCheckout.open()
//   cassetteCheckout.close()

(function () {

    // ---- Settings ---------------------------------------------------------

    // URL of the deployed worker (printed by `npm run deploy` in /worker).
    // While testing locally with `npm run dev`, use "http://localhost:8787".
    const API_BASE = "https://cassetteshelf-checkout.cassetteshelf.workers.dev";

    // Look of Stripe's address and payment fields. They live in a secure
    // iframe, so checkout.css can't reach them; this is the only way to
    // style them. Set up to match the site's own fields (thin pale border,
    // small rounded corners, 16px text, 12px between fields).
    // Reference: https://docs.stripe.com/elements/appearance-api
    const APPEARANCE = {
        theme: "stripe",
        variables: {
            colorPrimary: "#000000",
            colorText: "#000000",
            borderRadius: "6px",
            fontFamily: '"vag", sans-serif',
            fontSizeBase: "16px",
            gridRowSpacing: "12px",
        },
        rules: {
            ".Input": {
                border: "1px solid #b3b3b3",
                boxShadow: "none",
                padding: "7px 8px",
            },
            ".Input:focus": {
                border: "1px solid #000000",
                boxShadow: "none",
            },
            ".Label": {
                fontSize: "16px",
                marginBottom: "4px",
            },
        },
    };

    // Fonts Stripe's fields may use (they can't see the site's own CSS).
    // Stripe's secure frame only loads fonts over https, so the site font
    // shows up there on the live site but not when testing on localhost.
    const STRIPE_FONTS = [
        { family: "vag", src: "url(" + new URL("fonts/vag.ttf", location.href).href + ")" },
    ];

    // How money is displayed everywhere in the window (amounts are cents).
    function formatMoney(cents) {
        return (cents / 100).toFixed(2) + "$ CAD";
    }

    // Image shown next to each cart item.
    function itemImage(item) {
        return item.format === "cd"
            ? "images/cd/thumbs/" + item.size + "cd.png"
            : "images/thumbs/" + item.size + ".png";
    }

    const FORMAT_LABELS = { cassette: "cassette shelf", cd: "cd shelf" };
    const MAX_QUANTITY = 20;  // keep in sync with worker/src/pricing.js
    const CART_KEY = "cassetteshelf-cart";

    // ---- State ------------------------------------------------------------

    let cart = loadCart();      // [{ format, size, quantity }]
    let config = null;          // GET /config response
    let quote = null;           // latest POST /quote response
    let quotedKey = "";         // request body of the latest quote
    let quoteSeq = 0;           // ignores out-of-order quote responses
    let quoteTimer = null;
    let quoteDueAt = 0;         // when the scheduled quote will run
    let quotePending = false;   // a price change hasn't been quoted yet
    let stripe = null;
    let elements = null;
    let addressElement = null;
    let shippingDetails = { name: "", address: {} };  // from the address form
    let busy = false;

    let dialog, form, els;

    // Checkout steps for the dashboard's Analytics tab (track.js).
    const tracked = new Set();
    function track(type, detail, oncePerPage) {
        if (oncePerPage) {
            if (tracked.has(type)) return;
            tracked.add(type);
        }
        if (window.cassetteTrack) window.cassetteTrack(type, detail);
    }

    // ---- Cart storage -----------------------------------------------------

    function loadCart() {
        try {
            const saved = JSON.parse(localStorage.getItem(CART_KEY));
            return Array.isArray(saved) ? saved : [];
        } catch (e) {
            return [];
        }
    }

    function saveCart() {
        try {
            localStorage.setItem(CART_KEY, JSON.stringify(cart));
        } catch (e) {
            // Private mode etc.: the cart just won't survive a reload.
        }
        renderCartButton();
    }

    function add(format, size) {
        const existing = cart.find((i) => i.format === format && i.size === size);
        if (existing) {
            existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + 1);
        } else {
            cart.push({ format, size, quantity: 1 });
        }
        track("add_to_cart", format + ":" + size);
        saveCart();
        open();
    }

    function changeQuantity(index, delta) {
        const item = cart[index];
        item.quantity = Math.min(MAX_QUANTITY, item.quantity + delta);
        if (item.quantity < 1) cart.splice(index, 1);
        saveCart();
        renderItems();
        scheduleQuote(0);
    }

    function removeItem(index) {
        cart.splice(index, 1);
        saveCart();
        renderItems();
        scheduleQuote(0);
    }

    // ---- Opening / closing ------------------------------------------------

    function open() {
        showView("form");
        renderItems();
        if (!dialog.open) dialog.showModal();
        track("checkout_open", "", true);
        setup()
            .then(() => scheduleQuote(0))
            .catch(() => showMessage("checkout is unavailable right now, please try again later."));
    }

    function close() {
        dialog.close();
    }

    // Fetches the worker config (countries, live prices...) once. Called
    // on page load so the configurator shows the dashboard's prices.
    let configPromise = null;
    function loadConfig() {
        if (!configPromise) {
            configPromise = api("GET", "/config")
                .then((cfg) => {
                    applyLivePrices(cfg.prices);
                    return cfg;
                })
                .catch((err) => {
                    configPromise = null; // allow a retry later
                    throw err;
                });
        }
        return configPromise;
    }

    // Replaces the prices.js / pricesCD.js values (in dollars) with the
    // worker's live prices (cents), then tells the page to refresh.
    function applyLivePrices(livePrices) {
        if (!livePrices) return;
        const tables = [
            [typeof prices !== "undefined" ? prices : null, livePrices.cassette],
            [typeof pricesCD !== "undefined" ? pricesCD : null, livePrices.cd],
        ];
        for (const [table, live] of tables) {
            if (!table || !live) continue;
            for (const key of Object.keys(table)) delete table[key];
            for (const [key, cents] of Object.entries(live)) table[key] = cents / 100;
        }
        document.dispatchEvent(new CustomEvent("cassetteshelf:prices"));
        if (els && dialog.open) renderItems();
    }

    // Loads the worker config and Stripe the first time checkout opens.
    let setupPromise = null;
    function setup() {
        if (!setupPromise) {
            setupPromise = Promise.all([loadConfig(), loadStripeJs()])
                .then(([cfg]) => {
                    config = cfg;
                    // Hides the tax line when the worker isn't collecting tax.
                    document.querySelectorAll("[data-tax-only]").forEach((el) => {
                        el.hidden = !config.taxEnabled;
                    });
                    mountStripeElements();
                })
                .catch((err) => {
                    setupPromise = null; // allow a retry on next open
                    throw err;
                });
        }
        return setupPromise;
    }

    function loadStripeJs() {
        if (window.Stripe) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "https://js.stripe.com/v3/";
            script.onload = resolve;
            script.onerror = () => {
                script.remove();
                reject(new Error("could not load Stripe"));
            };
            document.head.appendChild(script);
        });
    }

    function mountStripeElements() {
        stripe = Stripe(config.publishableKey);
        // "Deferred" mode: the payment form is shown before the
        // PaymentIntent exists; the worker creates it when the customer
        // presses pay, with the final server-side total.
        elements = stripe.elements({
            mode: "payment",
            amount: Math.max(estimatedTotal(), 50),
            currency: config.currency,
            appearance: APPEARANCE,
            fonts: STRIPE_FONTS,
        });
        elements.create("payment").mount("#checkoutPaymentElement");

        // Address form with autocomplete (suggestions as you type), limited
        // to the countries the worker ships to (shipping.js).
        addressElement = elements.create("address", {
            mode: "shipping",
            allowedCountries: config.countries.map((c) => c.code),
            autocomplete: { mode: "automatic" },
        });
        addressElement.mount("#checkoutAddressElement");
        addressElement.on("change", (event) => {
            const previousCountry = shippingDetails.address.country;
            shippingDetails = {
                name: event.value.name || "",
                address: { ...event.value.address },
            };
            // "Entered an address" = typed more than the pre-filled country.
            if (shippingDetails.address.line1) track("checkout_address", shippingDetails.address.country, true);
            // A new country changes shipping options right away; other
            // edits wait for a pause in typing.
            scheduleQuote(shippingDetails.address.country !== previousCountry ? 0 : 600);
        });
    }

    // ---- Quotes (prices from the worker) ----------------------------------

    function currentAddress() {
        const address = {};
        for (const field of ["line1", "line2", "city", "state", "postal_code", "country"]) {
            address[field] = (shippingDetails.address[field] || "").trim();
        }
        return address;
    }

    function selectedShippingRate() {
        const checked = form.querySelector('input[name="shippingRate"]:checked');
        return checked ? checked.value : null;
    }

    function orderRequest() {
        return {
            items: cart.map(({ format, size, quantity }) => ({ format, size, quantity })),
            address: currentAddress(),
            shippingRateId: selectedShippingRate(),
        };
    }

    // Quotes are requested when something affecting the price changes.
    // The worker only asks Stripe Tax once the address is complete.
    function scheduleQuote(delay) {
        quotePending = true;
        setLoading(true);
        renderPendingTotals();
        // Never push back a quote that's already due sooner (e.g. a country
        // change followed by more updates from the address form). It reads
        // the latest details when it runs, so nothing is missed.
        const dueAt = Date.now() + delay;
        if (quoteTimer && quoteDueAt <= dueAt) return;
        clearTimeout(quoteTimer);
        quoteDueAt = dueAt;
        quoteTimer = setTimeout(requestQuote, delay);
    }

    async function requestQuote() {
        quoteTimer = null;
        const request = orderRequest();
        const key = JSON.stringify(request);
        if (!config || cart.length === 0 || key === quotedKey) {
            if (cart.length === 0) {
                quote = null;
                quotedKey = "";
            }
            quotePending = false;
            setLoading(false);
            renderQuote();
            return;
        }

        const seq = ++quoteSeq;
        setLoading(true);
        try {
            const result = await api("POST", "/quote", request);
            if (seq !== quoteSeq) return;
            quote = result;
            quotePending = false;
            quotedKey = key;
            hideMessage();
        } catch (err) {
            if (seq !== quoteSeq) return;
            quote = null;
            quotedKey = "";
            quotePending = false;
            showMessage(err.message);
        } finally {
            if (seq === quoteSeq) setLoading(false);
        }
        renderQuote();
    }

    function estimatedTotal() {
        if (quote && quote.total) return quote.total;
        if (quote) return quote.subtotal + (quote.shipping || 0);
        return localSubtotal();
    }

    function localSubtotal() {
        return cart.reduce((sum, item) => sum + (localPrice(item) || 0) * item.quantity, 0);
    }

    // Display-only price from the site's prices.js / pricesCD.js.
    function localPrice(item) {
        const table = item.format === "cd"
            ? (typeof pricesCD !== "undefined" ? pricesCD : {})
            : (typeof prices !== "undefined" ? prices : {});
        return table[item.size] ? Math.round(table[item.size] * 100) : null;
    }

    // ---- Paying -----------------------------------------------------------

    async function pay(event) {
        event.preventDefault();
        if (busy || cart.length === 0 || quotePending) return;
        if (!form.reportValidity() || !stripe) return;

        setBusy(true);
        hideMessage();
        try {
            // Validates the address and payment fields (Stripe shows any
            // problems next to the field) before anything is charged.
            const { error: fieldsError } = await elements.submit();
            if (fieldsError) throw fieldsError;
            if (!quote || !quote.total) {
                throw new Error((quote && quote.taxError) || "please complete your shipping address.");
            }
            track("checkout_submit");

            const data = new FormData(form);
            const request = orderRequest();
            const shownTotal = quote.total;
            const result = await api("POST", "/checkout", {
                ...request,
                name: shippingDetails.name,
                email: data.get("email"),
                phone: data.get("phone"),
            });

            // The worker re-prices everything. If the total moved since it
            // was displayed, show the new one rather than charging it silently.
            quote = result.quote;
            quotedKey = JSON.stringify(request);
            renderQuote();
            if (result.quote.total !== shownTotal) {
                throw new Error("the total was updated, please review it and press pay again.");
            }

            const { error, paymentIntent } = await stripe.confirmPayment({
                elements,
                clientSecret: result.clientSecret,
                confirmParams: { return_url: returnUrl() },
                // Cards complete here; some methods redirect to their bank
                // and come back to return_url (handled in handleReturn).
                redirect: "if_required",
            });
            if (error) throw error;
            finishPayment(paymentIntent, data.get("email"));
        } catch (err) {
            showMessage(err.message || "payment failed, please try again.");
        } finally {
            setBusy(false);
        }
    }

    function finishPayment(paymentIntent, email) {
        if (paymentIntent.status === "succeeded" || paymentIntent.status === "processing") {
            track("purchase");
            cart = [];
            saveCart();
            quote = null;
            quotedKey = "";
            form.reset();
            if (addressElement) addressElement.clear();
            els.successEmail.textContent = email || paymentIntent.receipt_email || "your email";
            showView("success");
        } else {
            showMessage("payment was not completed, please try again.");
        }
    }

    function returnUrl() {
        return location.origin + location.pathname + "?checkout=return";
    }

    // Customers coming back from a redirect-based payment method.
    async function handleReturn() {
        const params = new URLSearchParams(location.search);
        const clientSecret = params.get("payment_intent_client_secret");
        if (params.get("checkout") !== "return" || !clientSecret) return;
        history.replaceState(null, "", location.pathname + location.hash);

        open();
        try {
            await setup();
            const { paymentIntent, error } = await stripe.retrievePaymentIntent(clientSecret);
            if (error) throw error;
            finishPayment(paymentIntent, paymentIntent.receipt_email);
        } catch (err) {
            showMessage(err.message || "we couldn't confirm your payment.");
        }
    }

    // ---- Rendering --------------------------------------------------------

    function renderCartButton() {
        const count = cart.reduce((sum, item) => sum + item.quantity, 0);
        els.cartButton.hidden = count === 0;
        els.cartCount.textContent = count;
    }

    function renderItems() {
        els.items.replaceChildren();
        cart.forEach((item, index) => {
            const row = els.itemTemplate.content.firstElementChild.cloneNode(true);
            const unit = localPrice(item);
            const image = row.querySelector('[data-field="image"]');
            if (image) {
                image.src = itemImage(item);
                image.alt = item.size + " " + FORMAT_LABELS[item.format];
            }
            setField(row, "label", item.size + " " + FORMAT_LABELS[item.format]);
            setField(row, "unit", unit === null ? "" : formatMoney(unit));
            setField(row, "quantity", item.quantity);
            setField(row, "total", unit === null ? "" : formatMoney(unit * item.quantity));
            row.querySelector('[data-action="decrease"]')?.addEventListener("click", () => changeQuantity(index, -1));
            row.querySelector('[data-action="increase"]')?.addEventListener("click", () => changeQuantity(index, 1));
            row.querySelector('[data-action="remove"]')?.addEventListener("click", () => removeItem(index));
            els.items.appendChild(row);
        });

        const empty = cart.length === 0;
        els.empty.hidden = !empty;
        els.details.hidden = empty;
        renderQuote();
    }

    function renderShippingOptions() {
        const options = quote ? quote.shippingOptions : [];
        els.shippingOptions.replaceChildren();
        els.shippingHint.hidden = options.length > 0;

        for (const option of options) {
            const choice = els.shippingTemplate.content.firstElementChild.cloneNode(true);
            const radio = choice.querySelector('input[name="shippingRate"]');
            radio.value = option.id;
            radio.checked = option.id === quote.shippingRateId;
            setField(choice, "label", option.label);
            setField(choice, "amount", formatMoney(option.amount));
            els.shippingOptions.appendChild(choice);
        }
    }

    function renderQuote() {
        renderShippingOptions();
        renderFees();

        setTotal("subtotal", formatMoney(quote ? quote.subtotal : localSubtotal()));
        setTotal("shipping", quote && quote.shipping !== null ? formatMoney(quote.shipping) : "—");
        setTotal("tax", quote && quote.tax !== null
            ? formatMoney(quote.tax)
            : (quote && quote.taxError) || "calculated from your address");
        setTotal("total", quote && quote.total ? formatMoney(quote.total) : "—");
        els.payTotal.textContent = quote && quote.total ? formatMoney(quote.total) : "";

        // Keeps the payment form's wallets (Apple Pay etc.) on the right amount.
        if (elements && cart.length > 0) {
            elements.update({ amount: Math.max(estimatedTotal(), 50) });
        }
    }

    // One summary row per percentage fee (e.g. tariffs), after "shipping".
    function renderFees() {
        form.querySelectorAll(".checkout-row-fee").forEach((row) => row.remove());
        const fees = quote ? quote.fees || [] : [];
        const shippingRow = form.querySelector('[data-total="shipping"]').parentElement;
        const rows = fees.map((fee) => {
            const row = els.feeTemplate.content.firstElementChild.cloneNode(true);
            setField(row, "label", fee.label + " (" + fee.percent + "%)");
            setField(row, "amount", formatMoney(fee.amount));
            return row;
        });
        shippingRow.after(...rows);
    }

    // While a new quote is on its way, don't show totals that may be stale.
    function renderPendingTotals() {
        setTotal("subtotal", formatMoney(localSubtotal()));
        form.querySelectorAll('.checkout-row-fee [data-field="amount"]').forEach((el) => {
            el.textContent = "…";
        });
        setTotal("tax", "…");
        setTotal("total", "…");
        els.payTotal.textContent = "";
    }

    function setField(root, name, value) {
        const el = root.querySelector('[data-field="' + name + '"]');
        if (el) el.textContent = value;
    }

    function setTotal(name, value) {
        const el = form.querySelector('[data-total="' + name + '"]');
        if (el) el.textContent = value;
    }

    function showView(view) {
        form.hidden = view !== "form";
        els.success.hidden = view !== "success";
        if (view === "form") hideMessage();
    }

    function showMessage(text) {
        els.message.textContent = text;
        els.message.hidden = false;
    }

    function hideMessage() {
        els.message.hidden = true;
        els.message.textContent = "";
    }

    // CSS hooks: .checkout.is-loading while a quote is in flight,
    // .checkout.is-busy while a payment is being processed.
    function setLoading(loading) {
        dialog.classList.toggle("is-loading", loading);
    }

    function setBusy(value) {
        busy = value;
        dialog.classList.toggle("is-busy", value);
        els.payButton.disabled = value;
    }

    // ---- Worker requests --------------------------------------------------

    async function api(method, path, body) {
        let response;
        try {
            response = await fetch(API_BASE + path, {
                method,
                headers: body ? { "Content-Type": "application/json" } : undefined,
                body: body ? JSON.stringify(body) : undefined,
            });
        } catch (err) {
            throw new Error("couldn't reach the checkout server, please check your connection.");
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || "something went wrong, please try again.");
        }
        return data;
    }

    // ---- Wiring -----------------------------------------------------------

    function init() {
        dialog = document.getElementById("checkout");
        form = document.getElementById("checkoutForm");
        els = {
            cartButton: document.getElementById("cartButton"),
            cartCount: document.querySelector("[data-cart-count]"),
            items: document.getElementById("checkoutItems"),
            empty: document.getElementById("checkoutEmpty"),
            details: document.getElementById("checkoutDetails"),
            shippingHint: document.getElementById("checkoutShippingHint"),
            shippingOptions: document.getElementById("checkoutShippingOptions"),
            message: document.getElementById("checkoutMessage"),
            payButton: document.getElementById("checkoutPayButton"),
            payTotal: document.querySelector("[data-pay-total]"),
            success: document.getElementById("checkoutSuccess"),
            successEmail: document.querySelector("[data-success-email]"),
            itemTemplate: document.getElementById("checkoutItemTemplate"),
            shippingTemplate: document.getElementById("checkoutShippingTemplate"),
            feeTemplate: document.getElementById("checkoutFeeTemplate"),
        };

        els.cartButton.addEventListener("click", open);
        dialog.querySelectorAll("[data-checkout-close]").forEach((btn) => btn.addEventListener("click", close));

        // Clicking the dimmed area outside the panel closes the window.
        dialog.addEventListener("click", (event) => {
            if (event.target === dialog) close();
        });

        form.addEventListener("submit", pay);
        els.shippingOptions.addEventListener("change", () => scheduleQuote(0));

        renderCartButton();
        handleReturn();
        loadConfig().catch(() => {
            // Worker unreachable: the page keeps the prices.js prices.
        });
    }

    window.cassetteCheckout = { add, open, close };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
