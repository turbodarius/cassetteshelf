// cassetteshelf admin dashboard: edits the store settings (prices,
// countries, shipping options, fees, sales tax) saved by the checkout
// worker. Everything is checked again by the worker before it's saved.

(function () {

    // Same worker as the checkout (checkout.js).
    const API_BASE = "https://cassetteshelf-checkout.cassetteshelf.workers.dev";
    const TOKEN_KEY = "cassetteshelf-admin";
    const NOT_COUNTRIES = /^(AA|Q[M-Z]|X[A-JL-Z]|ZZ|EU|EZ|UN)$/;  // keep in sync with worker/src/settings.js

    let token = null;
    let draft = null;        // the settings being edited (see fromSettings)
    let updatedAt = null;    // version the draft started from
    let meta = null;         // { sizes, formats, storageReady, orderEmail, customerEmail }
    let dirty = false;

    const $ = (id) => document.getElementById(id);

    // ---- Talking to the worker ------------------------------------------

    async function api(method, body, path = "/admin/settings") {
        let response;
        try {
            response = await fetch(API_BASE + path, {
                method,
                headers: {
                    Authorization: "Bearer " + token,
                    ...(body ? { "Content-Type": "application/json" } : {}),
                },
                body: body ? JSON.stringify(body) : undefined,
            });
        } catch (err) {
            throw Object.assign(new Error("can't reach the checkout server, check your connection"), { status: 0 });
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw Object.assign(new Error(data.error || "something went wrong"), { status: response.status });
        }
        return data;
    }

    // ---- Log in / out ----------------------------------------------------

    async function logIn(password) {
        token = password;
        const data = await api("GET");
        try { sessionStorage.setItem(TOKEN_KEY, password); } catch (e) { /* not remembered */ }
        load(data);
        $("loginView").hidden = true;
        $("editorView").hidden = false;
        $("actions").hidden = false;
        $("tabs").hidden = false;
    }

    function logOut(message) {
        if (dirty && !message && !confirm("You have unsaved changes. Log out anyway?")) return;
        token = null;
        dirty = false;
        try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
        $("editorView").hidden = true;
        $("actions").hidden = true;
        $("tabs").hidden = true;
        orders = [];
        nextOrdersPage = null;
        ordersLoaded = false;
        analyticsLoaded = false;
        analyticsData = null;
        showTab("settings");
        $("loginView").hidden = false;
        $("password").value = "";
        showLoginError(message || "");
    }

    function showLoginError(text) {
        $("loginError").textContent = text;
        $("loginError").hidden = !text;
    }

    // ---- Settings <-> editable draft -------------------------------------

    function load(data) {
        meta = { sizes: data.sizes, formats: data.formats, storageReady: data.storageReady, orderEmail: data.orderEmail,
            customerEmail: data.customerEmail };
        updatedAt = data.updatedAt;
        draft = fromSettings(data.settings);
        setDirty(false);
        render();
        renderOrderEmail();
        if (!meta.storageReady) {
            showMessage("Settings storage isn't set up yet, so you can look around but saving won't work. See worker/README.md.", true);
        } else {
            hideMessage();
        }
    }

    // Countries become a list (keeps their order while editing).
    function fromSettings(settings) {
        return {
            collectTax: settings.collectTax,
            prices: structuredClone(settings.prices),
            countries: Object.entries(settings.countries).map(([code, c]) => ({
                code,
                name: c.name,
                options: c.options.map((o) => ({ ...o })),
                fees: (c.fees || []).map((f) => ({ ...f })),
            })),
        };
    }

    function toSettings() {
        const countries = {};
        for (const c of draft.countries) {
            countries[c.code] = {
                name: c.name.trim(),
                options: withIds(c.options, "option").map(({ id, label, amount }) => ({ id, label: label.trim(), amount })),
                fees: withIds(c.fees, "fee").map(({ id, label, percent }) => ({ id, label: label.trim(), percent })),
            };
        }
        return { collectTax: draft.collectTax, prices: draft.prices, countries };
    }

    // New options/fees get an id from their name (kept if renamed later).
    function withIds(list, fallback) {
        const used = new Set(list.map((x) => x.id).filter(Boolean));
        for (const item of list) {
            if (item.id) continue;
            const base = slug(item.label) || fallback;
            let id = base;
            for (let n = 2; used.has(id); n++) id = (base + "-" + n).slice(0, 30);
            used.add(id);
            item.id = id;
        }
        return list;
    }

    function slug(text) {
        return (text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
            .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 26);
    }

    // "27.51", "27,51" or "$27.51" -> 2751 cents; "" -> null; junk -> NaN.
    function parseMoney(text) {
        const t = text.trim().replace(/^\$|\$$/g, "").replace(",", ".").trim();
        if (!t) return null;
        return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(parseFloat(t) * 100) : NaN;
    }

    function parsePercent(text) {
        const t = text.trim().replace(/%$/, "").replace(",", ".").trim();
        if (!t) return null;
        return /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN;
    }

    function money(cents) {
        return cents === null || cents === undefined ? "" : (cents / 100).toFixed(2);
    }

    // ---- Rendering --------------------------------------------------------

    function render() {
        renderPrices();
        renderCountries();
        $("collectTax").checked = draft.collectTax;
    }

    function renderPrices() {
        const root = $("prices");
        root.replaceChildren();
        for (const [format, { label }] of Object.entries(meta.formats)) {
            const wrap = el("div", { className: "prices" });
            wrap.append(el("h3", { textContent: plural(label) }));
            const table = el("table");
            const head = el("tr", {}, el("th", { className: "corner", textContent: "rows ↓ columns →" }));
            for (let c = 1; c <= 6; c++) head.append(el("th", { textContent: String(c) }));
            table.append(el("thead", {}, head));
            const body = el("tbody");
            for (let r = 1; r <= 6; r++) {
                const row = el("tr", {}, el("th", { textContent: String(r) }));
                for (let c = 1; c <= 6; c++) {
                    const size = c + "x" + r;
                    const input = el("input", {
                        value: money(draft.prices[format][size]),
                        placeholder: "—",
                        inputMode: "decimal",
                        title: size + " " + label,
                        ariaLabel: size + " " + label + " price",
                    });
                    input.addEventListener("input", () => {
                        const cents = parseMoney(input.value);
                        const ok = cents === null || (Number.isInteger(cents) && cents > 0);
                        input.classList.toggle("is-invalid", !ok);
                        if (ok) {
                            if (cents === null) delete draft.prices[format][size];
                            else draft.prices[format][size] = cents;
                        }
                        setDirty(true);
                    });
                    row.append(el("td", {}, input));
                }
                body.append(row);
            }
            table.append(body);
            wrap.append(table);
            root.append(wrap);
        }
    }

    function renderCountries() {
        const root = $("countries");
        root.replaceChildren();
        draft.countries.forEach((country, index) => {
            const card = el("div", { className: "country" });

            const name = el("input", { value: country.name, autocomplete: "off" });
            name.addEventListener("input", () => {
                country.name = name.value;
                name.classList.toggle("is-invalid", !name.value.trim());
                setDirty(true);
            });
            const remove = el("button", { type: "button", className: "pill", textContent: "Remove country" });
            remove.addEventListener("click", () => {
                if (!confirm("Stop shipping to " + (country.name || country.code) + "?")) return;
                draft.countries.splice(index, 1);
                setDirty(true);
                renderCountries();
            });
            card.append(el("div", { className: "country-head" },
                el("label", { className: "field" }, el("span", { textContent: "Country name" }), name),
                el("span", { className: "country-code", textContent: country.code }),
                remove,
            ));

            card.append(el("h4", { textContent: "Shipping options" }));
            card.append(rowList(country.options, {
                nameLabel: "Name (e.g. standard, express)",
                amountLabel: "Price ($)",
                amountKey: "amount",
                format: money,
                parse: (t) => {
                    const v = parseMoney(t);
                    return Number.isInteger(v) && v >= 0 ? v : undefined;
                },
                minRows: 1,
            }));
            card.append(addButton("+ Add shipping option", () => {
                country.options.push({ label: "", amount: null });
            }));

            card.append(el("h4", { textContent: "Fees (percentage of the shelves' total)" }));
            card.append(rowList(country.fees, {
                nameLabel: "Name (e.g. tariffs)",
                amountLabel: "Percent (%)",
                amountKey: "percent",
                format: (v) => (v === null || v === undefined ? "" : String(v)),
                parse: (t) => {
                    const v = parsePercent(t);
                    return Number.isFinite(v) && v > 0 && v <= 1000 ? v : undefined;
                },
                minRows: 0,
            }));
            card.append(addButton("+ Add fee", () => {
                country.fees.push({ label: "", percent: null });
            }));

            root.append(card);
        });
    }

    // Rows of name + number (shipping options or fees) with remove buttons.
    function rowList(list, opts) {
        const wrap = el("div", { className: "rows" });
        list.forEach((item, index) => {
            const row = $("optionRowTemplate").content.firstElementChild.cloneNode(true);
            row.querySelector("[data-name-label]").textContent = opts.nameLabel;
            row.querySelector("[data-amount-label]").textContent = opts.amountLabel;

            const label = row.querySelector('[data-field="label"]');
            label.value = item.label;
            label.addEventListener("input", () => {
                item.label = label.value;
                label.classList.toggle("is-invalid", !label.value.trim());
                setDirty(true);
            });

            const amount = row.querySelector('[data-field="amount"]');
            amount.value = opts.format(item[opts.amountKey]);
            amount.addEventListener("input", () => {
                const value = opts.parse(amount.value);
                amount.classList.toggle("is-invalid", value === undefined);
                item[opts.amountKey] = value === undefined ? null : value;
                setDirty(true);
            });

            const remove = row.querySelector('[data-action="remove"]');
            remove.hidden = list.length <= opts.minRows;
            remove.addEventListener("click", () => {
                list.splice(index, 1);
                setDirty(true);
                renderCountries();
            });
            wrap.append(row);
        });
        return wrap;
    }

    function addButton(text, onClick) {
        const button = el("button", { type: "button", className: "pill add-row", textContent: text });
        button.addEventListener("click", () => {
            onClick();
            setDirty(true);
            renderCountries();
        });
        return button;
    }

    function addCountry() {
        const input = $("newCountryCode");
        const code = input.value.trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(code)) return showMessage("Enter a two-letter country code, e.g. FR.", true);
        if (draft.countries.some((c) => c.code === code)) return showMessage(code + " is already in the list.", true);
        let name;
        // Reserved codes and groupings (EU, UN...) aren't countries.
        if (NOT_COUNTRIES.test(code)) return showMessage(code + " isn't a country code we recognize.", true);
        try {
            name = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }).of(code);
        } catch (e) { /* unknown code */ }
        if (!name) return showMessage(code + " isn't a country code we recognize.", true);
        hideMessage();
        draft.countries.push({ code, name, options: [{ label: "standard", amount: null }], fees: [] });
        input.value = "";
        setDirty(true);
        renderCountries();
        showMessage("Added " + name + ". Set its shipping price, then save.", false);
    }

    // ---- Saving -------------------------------------------------------------

    function problems() {
        if (document.querySelector("#editorView input.is-invalid")) {
            return "Some boxes (outlined in red) have values that aren't valid numbers.";
        }
        if (draft.countries.length === 0) return "Add at least one country you ship to.";
        for (const c of draft.countries) {
            const name = c.name.trim() || c.code;
            if (!c.name.trim()) return c.code + ": the country needs a name.";
            if (c.options.length === 0) return name + ": add at least one shipping option.";
            for (const o of c.options) {
                if (!o.label.trim()) return name + ": every shipping option needs a name.";
                if (o.amount === null) return name + " " + o.label + ": set a shipping price (0 for free shipping).";
            }
            for (const f of c.fees) {
                if (!f.label.trim()) return name + ": every fee needs a name.";
                if (f.percent === null) return name + " " + f.label + ": set a percentage.";
            }
        }
        return null;
    }

    async function save() {
        const problem = problems();
        if (problem) return showMessage(problem, true);
        const button = $("saveButton");
        button.disabled = true;
        $("status").textContent = "Saving…";
        try {
            const saved = await api("PUT", { settings: toSettings(), updatedAt });
            load({ ...meta, settings: saved.settings, updatedAt: saved.updatedAt });
            showMessage("Saved. The site uses the new settings within about a minute.", false);
        } catch (err) {
            if (err.status === 401) return logOut("Your session ended, please log in again.");
            setDirty(true);
            if (err.status === 409) {
                showMessage(err.message, true, { text: "Reload", onClick: reload });
            } else {
                showMessage(err.message, true);
            }
        } finally {
            button.disabled = false;
        }
    }

    async function reload() {
        if (dirty && !confirm("Discard your unsaved changes and load the latest settings?")) return;
        try {
            load(await api("GET"));
        } catch (err) {
            if (err.status === 401) return logOut("Your session ended, please log in again.");
            showMessage(err.message, true);
        }
    }

    // ---- Order emails --------------------------------------------------------

    function renderOrderEmail() {
        const info = meta.orderEmail || { to: "", ready: false };
        $("orderEmailStatus").textContent = info.ready
            ? "An email with the order details goes to " + info.to + " every time a payment succeeds. Replying to it writes to the customer."
            : "Not set up yet: add your Resend key to the worker (see worker/README.md), then emails go to " + (info.to || "ORDER_EMAIL_TO") + " for every paid order.";
        $("testEmailButton").disabled = !info.ready;

        const customer = meta.customerEmail || { from: "", ready: false };
        $("shippingEmailStatus").textContent = customer.ready
            ? "When you mark an order as shipped, the customer can get an email with the carrier and tracking link, from " +
              customer.from + ". Replies come to you. Resend only delivers it once cassetteshelf.com is verified in Resend → Domains."
            : "Not set up yet: needs the Resend key and CUSTOMER_EMAIL_FROM in the worker (see worker/README.md).";
        $("testShippingEmailButton").disabled = !customer.ready;
    }

    async function sendTestEmail(event) {
        const button = event.currentTarget;
        const path = button.id === "testShippingEmailButton" ? "/admin/test-shipping-email" : "/admin/test-email";
        button.disabled = true;
        try {
            const data = await api("POST", null, path);
            showMessage("Test email sent to " + data.sentTo + ". It can take a minute to arrive (check spam the first time).", false);
        } catch (err) {
            if (err.status === 401) return logOut("Your session ended, please log in again.");
            showMessage("Test email failed: " + err.message, true);
        } finally {
            button.disabled = false;
        }
    }

    // ---- Tabs -----------------------------------------------------------------

    function showTab(name) {
        document.querySelectorAll("#tabs .tab").forEach((tab) => {
            tab.classList.toggle("is-active", tab.dataset.tab === name);
        });
        $("settingsTab").hidden = name !== "settings";
        $("ordersTab").hidden = name !== "orders";
        $("analyticsTab").hidden = name !== "analytics";
        document.querySelectorAll("[data-settings-only]").forEach((node) => {
            node.hidden = name !== "settings";
        });
        hideMessage();
        if (name === "orders" && !ordersLoaded) loadOrders(false);
        if (name === "analytics") {
            if (!analyticsLoaded) loadAnalytics();
            else requestAnimationFrame(() => charts.forEach((draw) => draw()));
        }
    }

    // ---- Orders -----------------------------------------------------------

    let orders = [];
    let nextOrdersPage = null;
    let ordersLoaded = false;
    let carriers = {};       // { "canada-post": "Canada Post", ... } from the worker

    // more = false starts over from the newest; true appends the next page.
    async function loadOrders(more) {
        const button = more ? $("loadMoreOrders") : $("refreshOrders");
        button.disabled = true;
        if (!more) $("ordersSummary").textContent = "Loading orders…";
        try {
            const page = more && nextOrdersPage ? "?page=" + encodeURIComponent(nextOrdersPage) : "";
            const [data] = await Promise.all([
                api("GET", null, "/admin/orders" + page),
                more ? null : loadLegacyOrders(),
            ]);
            orders = more ? orders.concat(data.orders) : data.orders;
            nextOrdersPage = data.nextPage;
            carriers = data.carriers || carriers;
            ordersLoaded = true;
            hideMessage();
            renderOrders();
        } catch (err) {
            if (err.status === 401) return logOut("Your session ended, please log in again.");
            $("ordersSummary").textContent = "";
            showMessage("Couldn't load orders: " + err.message, true);
        } finally {
            button.disabled = false;
        }
    }

    // Fully refunded orders don't need shipping.
    function toShip(order) {
        return order.source !== "shopify" && !order.shipment && order.status !== "refunded";
    }

    function renderOrders() {
        const list = $("ordersList");
        const shown = $("onlyToShip").checked ? orders.filter(toShip) : orders;
        list.replaceChildren(...shown.map(orderCard));
        renderLegacy();
        $("loadMoreOrders").hidden = !nextOrdersPage;
        $("downloadCsv").disabled = orders.length + legacyOrders.length === 0;

        const kept = orders.reduce((sum, o) => sum + o.total - o.refunded, 0);
        const waiting = orders.filter(toShip).length;
        $("ordersSummary").textContent = orders.length === 0
            ? "No orders yet. New orders can take about a minute to appear."
            : orders.length + (nextOrdersPage ? " most recent" : "") + " order" + (orders.length === 1 ? "" : "s") +
              " · " + waiting + " to ship · " + cad(kept) + " after refunds. New orders can take about a minute to appear.";
    }

    // Marks an order shipped (shipment = { carrier, tracking, notify }) or
    // not (null). With notify, the customer is also emailed.
    async function updateShipment(order, shipment, button) {
        const path = "/admin/orders/" + encodeURIComponent(order.id) + "/shipment";
        await orderRequest(button, shipment ? "PUT" : "DELETE", shipment, path);
    }

    // (Re)sends the shipping email of a shipped order.
    async function sendShippingEmail(order, button) {
        const path = "/admin/orders/" + encodeURIComponent(order.id) + "/shipping-email";
        await orderRequest(button, "POST", null, path);
    }

    // -> { order, email: null | { sent, to } | { sent: false, error } }
    async function orderRequest(button, method, body, path) {
        button.disabled = true;
        try {
            const { order: updated, email } = await api(method, body, path);
            orders = orders.map((o) => (o.id === updated.id ? updated : o));
            renderOrders();
            if (!email) hideMessage();
            else if (email.sent) showMessage("Shipping email sent to " + email.to + ".", false);
            else showMessage("The order is marked as shipped, but the email to the customer wasn't sent: " + email.error, true);
        } catch (err) {
            if (err.status === 401) return logOut("Your session ended, please log in again.");
            button.disabled = false;
            showMessage("Couldn't update the order: " + err.message, true);
        }
    }

    function canEmailCustomer(order) {
        return Boolean(meta && meta.customerEmail && meta.customerEmail.ready && order.customer.email);
    }

    function shippingLine(order) {
        const line = el("div", { className: "order-shipping" });
        if (order.source === "shopify") {
            line.textContent = order.shipment
                ? "Fulfilled in Shopify on " + new Date(order.shipment.at).toLocaleDateString()
                : "Not fulfilled in Shopify";
            return line;
        }
        if (order.shipment) {
            const s = order.shipment;
            const info = el("span", {}, document.createTextNode(
                "Shipped " + new Date(s.at).toLocaleDateString() + (s.carrierName ? " with " + s.carrierName : "")));
            if (s.tracking) {
                info.append(document.createTextNode(" · tracking "));
                info.append(s.trackingUrl
                    ? el("a", { href: s.trackingUrl, target: "_blank", rel: "noopener", textContent: s.tracking + " ↗" })
                    : el("span", { textContent: s.tracking }));
            }
            info.append(document.createTextNode(s.emailedAt
                ? " · customer emailed " + new Date(s.emailedAt).toLocaleDateString()
                : " · customer not emailed"));
            line.append(info);
            if (canEmailCustomer(order)) {
                const send = el("button", { type: "button", className: "pill pill-small",
                    textContent: s.emailedAt ? "Email again" : "Send shipping email" });
                send.addEventListener("click", () => {
                    if (!s.emailedAt || confirm("Send the shipping email to " + order.customer.email + " again?")) {
                        sendShippingEmail(order, send);
                    }
                });
                line.append(send);
            }
            const undo = el("button", { type: "button", className: "pill pill-small", textContent: "Undo" });
            undo.addEventListener("click", () => {
                if (confirm("Mark this order as not shipped?")) updateShipment(order, null, undo);
            });
            line.append(undo);
            return line;
        }

        const start = el("button", { type: "button", className: "pill pill-black pill-small", textContent: "Mark as shipped" });
        start.addEventListener("click", () => {
            const carrier = el("select", { ariaLabel: "carrier" },
                ...Object.entries(carriers).map(([id, name]) => el("option", { value: id, textContent: name })));
            const tracking = el("input", { placeholder: "Tracking number (optional)", autocomplete: "off", ariaLabel: "tracking number" });
            const canEmail = canEmailCustomer(order);
            const notify = el("input", { type: "checkbox", checked: canEmail, disabled: !canEmail });
            const notifyLabel = el("label", {
                className: "checkbox" + (canEmail ? "" : " is-disabled"),
                title: canEmail ? "Sends the carrier and tracking link to " + order.customer.email
                    : !order.customer.email ? "This order has no email address"
                    : "Customer emails aren't set up (see Settings → Emails)",
            }, notify, el("span", { textContent: "Email the customer" }));
            const confirmButton = el("button", { type: "button", className: "pill pill-black pill-small", textContent: "Confirm shipped" });
            const cancel = el("button", { type: "button", className: "pill pill-small", textContent: "Cancel" });
            confirmButton.addEventListener("click", () => updateShipment(order,
                { carrier: carrier.value, tracking: tracking.value, notify: notify.checked }, confirmButton));
            cancel.addEventListener("click", () => line.replaceWith(shippingLine(order)));
            line.replaceChildren(el("div", { className: "ship-form" }, carrier, tracking, notifyLabel, confirmButton, cancel));
            tracking.focus();
        });
        line.append(start);
        return line;
    }

    function orderCard(order) {
        const card = el("article", { className: "order" });

        card.append(el("div", { className: "order-head" },
            el("span", { className: "order-date", textContent: new Date(order.created).toLocaleString() }),
            el("strong", { className: "order-total", textContent: cad(order.total) }),
            el("span", { className: "badge badge-" + order.status.replace(" ", "-"), textContent:
                order.status === "partially refunded" ? "partially refunded (" + cad(order.refunded) + ")" : order.status }),
            order.shipment
                ? el("span", { className: "badge badge-shipped", textContent: order.source === "shopify" ? "fulfilled" : "shipped" })
                : toShip(order) ? el("span", { className: "badge badge-to-ship", textContent: "to ship" }) : "",
        ));

        const customer = el("div", { className: "order-block" }, el("h4", { textContent: "Customer" }));
        customer.append(el("p", { textContent: order.customer.name || "—" }));
        if (order.customer.email) {
            customer.append(el("p", {}, el("a", { href: "mailto:" + order.customer.email, textContent: order.customer.email })));
        }
        if (order.customer.phone) customer.append(el("p", { textContent: order.customer.phone }));

        const lines = addressLines(order);
        const copy = el("button", { type: "button", className: "pill pill-small", textContent: "Copy address" });
        copy.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(lines.join("\n"));
                copy.textContent = "Copied";
            } catch (e) {
                copy.textContent = "Copy failed";
            }
            setTimeout(() => (copy.textContent = "Copy address"), 1500);
        });
        const shipTo = el("div", { className: "order-block" },
            el("h4", { textContent: "Ship to" }),
            el("p", { className: "order-address", textContent: lines.join("\n") }),
            copy,
        );

        const items = el("ul", { className: "order-items" },
            ...order.items.map((i) => el("li", { textContent: i.quantity + " × " + i.label })));
        const charges = el("dl", { className: "order-charges" });
        const charge = (label, cents) => charges.append(el("dt", { textContent: label }), el("dd", { textContent: cad(cents) }));
        const itemsTotal = order.total - (order.shipping.amount || 0) - (order.tax || 0) -
            order.fees.reduce((sum, f) => sum + f.amount, 0);
        charge("Shelves", itemsTotal);
        charge("Shipping (" + (order.shipping.option || "—") + ")", order.shipping.amount || 0);
        order.fees.forEach((f) => charge(capitalizeWord(f.id), f.amount));
        if (order.tax) charge("Tax", order.tax);
        const bought = el("div", { className: "order-block" }, el("h4", { textContent: "Items" }), items, charges);

        card.append(el("div", { className: "order-body" }, customer, shipTo, bought));
        card.append(shippingLine(order));
        card.append(el("p", { className: "order-foot" },
            document.createTextNode((order.paymentMethod || "Paid") + " · "),
            order.stripeUrl
                ? el("a", { href: order.stripeUrl, target: "_blank", rel: "noopener", textContent: order.source === "shopify" ? "View in Shopify ↗" : "View in Stripe ↗" })
                : "",
            document.createTextNode(" · " + (order.number || order.id)),
        ));
        return card;
    }

    function addressLines(order) {
        const a = order.address;
        let country = a.country;
        try {
            country = new Intl.DisplayNames(["en"], { type: "region" }).of(a.country) || a.country;
        } catch (e) { /* keep the code */ }
        return [
            order.customer.name,
            a.line1,
            a.line2,
            [a.city, a.state, a.postal_code].filter(Boolean).join(" "),
            country,
        ].filter(Boolean);
    }

    // Spreadsheet of the loaded orders (Excel, Numbers, Google Sheets...).
    function downloadCsv() {
        const header = ["date", "order", "status", "shipped", "carrier", "tracking", "total", "refunded", "name", "email", "phone",
            "address line 1", "address line 2", "city", "province/state", "postal code", "country",
            "items", "shipping option", "shipping", "fees", "tax"];
        const rows = orders.concat(legacyOrders).map((o) => [
            o.created, o.id, o.status, o.shipment ? o.shipment.at : "", o.shipment ? o.shipment.carrierName : "",
            o.shipment ? o.shipment.tracking : "", dollars(o.total), dollars(o.refunded),
            o.customer.name, o.customer.email, o.customer.phone,
            o.address.line1, o.address.line2, o.address.city, o.address.state, o.address.postal_code, o.address.country,
            o.items.map((i) => i.quantity + " x " + i.label).join("; "),
            o.shipping.option, dollars(o.shipping.amount || 0),
            o.fees.map((f) => f.id + " " + dollars(f.amount)).join("; "), dollars(o.tax || 0),
        ]);
        const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
        const link = el("a", {
            href: URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" })),
            download: "cassetteshelf-orders-" + new Date().toISOString().slice(0, 10) + ".csv",
        });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }

    function csvCell(value) {
        const text = String(value ?? "");
        // A leading = + - @ would make spreadsheets run it as a formula.
        const safe = /^[=+\-@]/.test(text) ? "'" + text : text;
        return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
    }

    function cad(cents) {
        return dollars(cents) + "$ CAD";
    }

    function dollars(cents) {
        return ((cents || 0) / 100).toFixed(2);
    }

    function capitalizeWord(text) {
        return text.charAt(0).toUpperCase() + text.slice(1);
    }

    // ---- Analytics ------------------------------------------------------------

    let analyticsDays = 30;
    let analyticsLoaded = false;
    let analyticsData = null;

    const STEP_LABELS = {
        pageview: "Visited the site",
        add_to_cart: "Added to cart",
        checkout_open: "Opened checkout",
        checkout_address: "Entered an address",
        checkout_submit: "Pressed Purchase",
        purchase: "Paid",
    };

    async function loadAnalytics() {
        const button = $("refreshAnalytics");
        button.disabled = true;
        const root = $("analytics");
        if (!analyticsData) root.replaceChildren(el("p", { className: "hint", textContent: "Loading analytics…" }));
        try {
            analyticsData = await api("GET", null, "/admin/analytics?days=" + analyticsDays);
            analyticsLoaded = true;
            hideMessage();
            renderAnalytics();
        } catch (err) {
            if (err.status === 401) return logOut("Your session ended, please log in again.");
            root.replaceChildren();
            showMessage("Couldn't load analytics: " + err.message, true);
        } finally {
            button.disabled = false;
        }
    }

    function renderAnalytics() {
        const d = analyticsData;
        const t = d.traffic;
        const s = d.sales;
        const root = $("analytics");
        root.replaceChildren();
        charts = [];

        // Headline: revenue, then the key numbers.
        const head = el("section", { className: "card" },
            el("h2", { textContent: "Revenue" }),
            el("p", { className: "hero", textContent: cad(s.revenue) }),
            el("p", { className: "hero-note", textContent:
                periodText(d) + " · after " + cad(s.refunded) + " in refunds" +
                (s.imported ? " · includes " + s.imported + " order" + (s.imported === 1 ? "" : "s") + " imported from Shopify" : "") +
                (s.truncated ? " · showing the latest 1,000 orders" : "") }),
        );
        // Only orders from days when visits were counted (not imported history).
        const conversion = t && t.visitors ? (100 * (s.ordersWhileTracked ?? s.orders) / t.visitors) : null;
        head.append(el("div", { className: "tiles" },
            tile("Visitors", t ? number(t.visitors) : "—", t ? null : "visit tracking not set up"),
            tile("Page views", t ? number(t.views) : "—"),
            tile("Orders", number(s.orders), number(s.shelvesSold) + " shelves"),
            tile("Conversion", conversion === null ? "—" : conversion.toFixed(1) + "%", "visitors who ordered"),
            tile("Average order", s.orders ? cad(s.averageOrder) : "—"),
            tile("Abandoned", number(d.abandoned.count), d.abandoned.count ? cad(d.abandoned.value) + " not paid" : "pressed Purchase, didn't pay"),
        ));
        root.append(head);

        if (!t) {
            root.append(el("div", { className: "message", textContent:
                "Visit tracking isn't set up yet, so visitors, the funnel and page lists are empty. It's set up by the next `npm run deploy` (see worker/README.md)." }));
        }

        // Daily charts (one measure each).
        const byDay = (rows, key) => new Map(rows.map((r) => [r.day, r[key]]));
        if (t) {
            const visitors = byDay(t.daily, "visitors");
            root.append(chartCard("Visitors per day", d.dayList, d.dayList.map((day) => visitors.get(day) || 0), number, "visitors"));
        }
        const revenue = byDay(s.daily, "revenue");
        root.append(chartCard("Revenue per day", d.dayList, d.dayList.map((day) => revenue.get(day) || 0), cad, "revenue", (v) => compactMoney(v)));

        // Funnel.
        if (t) {
            const funnel = el("section", { className: "card funnel" }, el("h2", { textContent: "Checkout funnel" }),
                el("p", { className: "hint", textContent: "Visitors who reached each step (a visitor counts once per day). The drop between two steps is where people leave." }));
            const top = t.funnel[0].visitors || 0;
            t.funnel.forEach((step, i) => {
                const pct = top ? Math.round((100 * step.visitors) / top) : 0;
                const prev = i > 0 ? t.funnel[i - 1].visitors : null;
                const note = i > 0 && prev ? " · " + Math.round((100 * step.visitors) / prev) + "% of previous" : "";
                funnel.append(rankRow(STEP_LABELS[step.step], step.visitors, top, number(step.visitors) + " (" + pct + "%)" + note));
            });
            root.append(funnel);
        }

        // Ranked lists.
        const lists = el("div", { className: "lists" });
        if (t) {
            lists.append(
                rankList("Top pages", t.pages.map((p) => [p.path === "/" ? "/ (home)" : p.path, p.views]), number, "view"),
                rankList("Where visitors come from", t.referrers.map((r) => [r.source, r.visitors]), number),
                rankList("Visitor countries", t.countries.map((c) => [countryName(c.country), c.visitors]), number),
                rankList("Devices", t.devices.map((x) => [capitalizeWord(x.device), x.visitors]), number),
                rankList("Most added to cart", t.addedToCart.map((a) => [cartLabel(a.detail), a.times]), number, "time"),
            );
        }
        lists.append(
            rankList("Best sellers", s.bestSellers.map((b) => [b.key, b.value]), number),
            rankList("Sales by country", s.countries.map((c) => [countryName(c.key), c.value]), cad),
            rankList("Shipping chosen", s.shippingOptions.map((o) => [capitalizeWord(o.key), o.value]), number, "order"),
            rankList("Fees collected", s.fees.map((f) => [capitalizeWord(f.key), f.value]), cad),
        );
        root.append(el("section", { className: "card" }, el("h2", { textContent: "Details" }), lists));

        root.append(abandonedCard(d.abandoned));
    }

    function periodText(d) {
        const fmt = (day) => new Date(day + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
        return fmt(d.from) + " – " + fmt(d.to);
    }

    function tile(label, value, note) {
        return el("div", { className: "tile" },
            el("p", { className: "tile-label", textContent: label }),
            el("p", { className: "tile-value", textContent: value }),
            note ? el("p", { className: "tile-note", textContent: note }) : "");
    }

    // A column chart of one value per day, with hover tooltips and a table view.
    function chartCard(title, days, values, format, unit, tickFormat = number) {
        const card = el("section", { className: "card" }, el("h2", { textContent: title }));
        const total = values.reduce((a, b) => a + b, 0);
        card.append(el("p", { className: "hint", textContent: format(total) + " in total" }));
        const box = el("div", { className: "chart" });
        card.append(box);
        // Drawn once laid out (it needs the card's width), and again on resize.
        requestAnimationFrame(() => drawColumns(box, days, values, format, tickFormat));
        charts.push(() => drawColumns(box, days, values, format, tickFormat));

        const table = el("table", { className: "data-table" },
            el("tr", {}, el("th", { textContent: "Day" }), el("th", { textContent: capitalizeWord(unit) })),
            ...days.map((day, i) => el("tr", {}, el("td", { textContent: day }), el("td", { className: "num", textContent: format(values[i]) }))));
        card.append(el("details", { className: "table-view" }, el("summary", { textContent: "Show as table" }), table));
        return card;
    }

    let charts = [];
    let resizeTimer = null;
    window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => charts.forEach((draw) => draw()), 150);
    });

    function drawColumns(box, days, values, format, tickFormat) {
        if (!box.isConnected) return;
        const NS = "http://www.w3.org/2000/svg";
        const svgEl = (tag, attrs) => {
            const node = document.createElementNS(NS, tag);
            for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
            return node;
        };
        const width = Math.max(box.clientWidth, 200);
        const height = 180;
        const left = 52, bottom = 22, top = 8;
        const plotW = width - left, plotH = height - bottom - top;
        const max = niceMax(Math.max(...values, 0));
        const slot = plotW / days.length;
        const barW = Math.min(24, Math.max(1, slot - 2));      // 2px gap between bars, 24px cap
        const y = (v) => top + plotH - (max ? (v / max) * plotH : 0);

        const svg = svgEl("svg", { viewBox: "0 0 " + width + " " + height, height, role: "img", "aria-label": "" });
        for (const tick of [0, max / 2, max]) {
            svg.append(svgEl("line", { class: tick ? "grid" : "baseline", x1: left, x2: width, y1: y(tick), y2: y(tick) }));
            const label = svgEl("text", { class: "axis", x: left - 8, y: y(tick) + 4, "text-anchor": "end" });
            label.textContent = tickFormat(tick);
            svg.append(label);
        }
        // Date labels: first, middle, last.
        const dayLabel = (day) => new Date(day + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
        [0, Math.floor((days.length - 1) / 2), days.length - 1].forEach((i, n) => {
            const label = svgEl("text", { class: "axis", x: left + slot * i + slot / 2, y: height - 4, "text-anchor": ["start", "middle", "end"][n] });
            if (n === 0) label.setAttribute("x", left);
            if (n === 2) label.setAttribute("x", width);
            label.textContent = dayLabel(days[i]);
            svg.append(label);
        });

        const tip = el("div", { className: "tooltip", hidden: true });
        days.forEach((day, i) => {
            const v = values[i];
            const x = left + slot * i + (slot - barW) / 2;
            const h = Math.max(0, y(0) - y(v));
            // Hit target: the whole day's column, bigger than the bar.
            const hit = svgEl("rect", { class: "hit", x: left + slot * i, y: top, width: slot, height: plotH });
            const bar = svgEl("path", { class: "bar", d: h > 0 ? columnPath(x, y(0), barW, h) : "" });
            hit.addEventListener("pointerenter", () => {
                bar.classList.add("is-hover");
                tip.replaceChildren(el("strong", { textContent: format(v) }), document.createTextNode(dayLabel(day)));
                tip.hidden = false;
                const tipX = Math.min(Math.max(left + slot * i + slot / 2 - tip.offsetWidth / 2, 0), width - tip.offsetWidth);
                tip.style.left = tipX + "px";
                tip.style.top = Math.max(y(v) - tip.offsetHeight - 8, 0) + "px";
            });
            hit.addEventListener("pointerleave", () => {
                bar.classList.remove("is-hover");
                tip.hidden = true;
            });
            svg.append(hit, bar);
        });
        box.replaceChildren(svg, tip);
    }

    // A column rising from the baseline: square at the bottom, 4px rounded top.
    function columnPath(x, base, w, h) {
        const r = Math.min(4, w / 2, h);
        return "M" + x + "," + base + "V" + (base - h + r) + "Q" + x + "," + (base - h) + " " + (x + r) + "," + (base - h) +
            "H" + (x + w - r) + "Q" + (x + w) + "," + (base - h) + " " + (x + w) + "," + (base - h + r) + "V" + base + "Z";
    }

    // Rounds the top of the scale up to a clean number (1, 2, 5 x 10^n).
    function niceMax(value) {
        if (value <= 0) return 1;
        const power = Math.pow(10, Math.floor(Math.log10(value)));
        for (const step of [1, 2, 5, 10]) if (step * power >= value) return step * power;
        return 10 * power;
    }

    function rankList(title, rows, format, unit) {
        const list = el("div", { className: "list" }, el("h3", { textContent: title }));
        if (rows.length === 0) {
            list.append(el("p", { className: "empty", textContent: "Nothing yet" }));
            return list;
        }
        const max = Math.max(...rows.map((r) => r[1]));
        rows.forEach(([label, value]) =>
            list.append(rankRow(label, value, max, format(value) + (unit ? " " + (value === 1 ? unit : unit + "s") : ""))));
        return list;
    }

    function rankRow(label, value, max, text) {
        return el("div", { className: "rank" },
            el("span", { className: "rank-label", textContent: label, title: label }),
            el("div", { className: "rank-track" }, el("div", { className: "rank-bar", style: "width:" + (max ? (100 * value) / max : 0) + "%" })),
            el("span", { className: "rank-value", textContent: text }));
    }

    function abandonedCard(abandoned) {
        const card = el("section", { className: "card" }, el("h2", { textContent: "Abandoned purchases" }),
            el("p", { className: "hint", textContent:
                "People who pressed Purchase but didn't pay. Their details are in Stripe, so you can follow up; " +
                "\"bought later\" means the same email paid afterwards." + (abandoned.truncated ? " Showing the most recent ones." : "") }));
        if (abandoned.list.length === 0) {
            card.append(el("p", { className: "empty", textContent: "None in this period." }));
            return card;
        }
        const head = el("tr", {}, ...["Date", "Customer", "Cart", "Amount", "What happened", ""].map((h) => el("th", { textContent: h })));
        const rows = abandoned.list.map((a) => el("tr", {},
            el("td", { textContent: new Date(a.created).toLocaleString() }),
            el("td", {},
                el("div", { textContent: a.customer.name || "—" }),
                a.customer.email ? el("a", { href: "mailto:" + a.customer.email, textContent: a.customer.email }) : "",
                a.country ? el("div", { className: "tile-note", textContent: countryName(a.country) }) : ""),
            el("td", { textContent: a.items.map((i) => i.quantity + " × " + i.label).join(", ") }),
            el("td", { textContent: cad(a.amount) }),
            el("td", {},
                document.createTextNode(capitalizeWord(a.reason)),
                a.purchasedLater ? el("div", {}, el("span", { className: "badge badge-shipped", textContent: "bought later" })) : ""),
            el("td", {}, el("a", { href: a.stripeUrl, target: "_blank", rel: "noopener", textContent: "Stripe ↗" })),
        ));
        card.append(el("div", { className: "table-scroll" }, el("table", { className: "abandoned-table" }, el("thead", {}, head), el("tbody", {}, ...rows))));
        return card;
    }

    function number(n) {
        return Math.round(n).toLocaleString();
    }

    // 1234500 cents -> "12.3K$"
    function compactMoney(cents) {
        const dollars = cents / 100;
        if (dollars >= 1000) return (dollars / 1000).toFixed(dollars >= 10000 ? 0 : 1).replace(/\.0$/, "") + "K$";
        return Math.round(dollars) + "$";
    }

    function countryName(code) {
        if (!code || code === "?") return "Unknown";
        try {
            return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code;
        } catch (e) {
            return code;
        }
    }

    // "cassette:2x2" -> "2x2 cassette shelf"
    function cartLabel(detail) {
        const [format, size] = (detail || "").split(":");
        const label = meta && meta.formats[format] ? meta.formats[format].label : format;
        return size ? size + " " + label : detail;
    }

    // ---- Imported Shopify orders --------------------------------------------

    let legacyOrders = [];

    async function loadLegacyOrders() {
        const data = await api("GET", null, "/admin/legacy-orders");
        legacyOrders = data.orders;
    }

    function renderLegacy() {
        $("legacyList").replaceChildren(...legacyOrders.map(orderCard));
        $("removeLegacy").hidden = legacyOrders.length === 0;
        $("legacySummary").textContent = legacyOrders.length === 0
            ? "Orders from your Shopify store. In Shopify, go to Orders → Export, choose \"All orders\" and \"CSV for Excel, Numbers, or other spreadsheet programs\", then import that file here. They're stored privately with your settings; importing the same file again won't duplicate them."
            : legacyOrders.length + " order" + (legacyOrders.length === 1 ? "" : "s") + " imported from Shopify · " +
              cad(legacyOrders.reduce((sum, o) => sum + o.total - o.refunded, 0)) + " after refunds.";
    }

    async function importShopifyCsv(file) {
        let parsed;
        try {
            parsed = parseShopifyOrders(await file.text());
        } catch (err) {
            return showMessage(err.message, true);
        }
        try {
            const data = await api("PUT", { orders: parsed }, "/admin/legacy-orders");
            legacyOrders = data.orders;
            renderLegacy();
            showMessage("Imported " + data.imported + " Shopify order" + (data.imported === 1 ? "" : "s") + ".", false);
        } catch (err) {
            if (err.status === 401) return logOut("Your session ended, please log in again.");
            showMessage("Couldn't import: " + err.message, true);
        }
    }

    async function removeLegacy() {
        if (!confirm("Remove all imported Shopify orders from the dashboard? (Your Shopify account isn't affected.)")) return;
        try {
            await api("DELETE", null, "/admin/legacy-orders");
            legacyOrders = [];
            renderLegacy();
        } catch (err) {
            if (err.status === 401) return logOut("Your session ended, please log in again.");
            showMessage(err.message, true);
        }
    }

    // Shopify "orders export" CSV -> orders for the worker. One row per
    // line item; the order's totals and addresses are on its first row.
    function parseShopifyOrders(text) {
        const rows = parseCsv(text.replace(/^\ufeff/, ""));
        const header = rows.shift() || [];
        const col = Object.fromEntries(header.map((name, i) => [name.trim(), i]));
        for (const required of ["Name", "Created at", "Total", "Lineitem name"]) {
            if (!(required in col)) throw new Error("This doesn't look like a Shopify orders export (missing \"" + required + "\").");
        }
        const get = (row, name) => (name in col ? (row[col[name]] || "").trim() : "");
        // Shopify puts an apostrophe before numbers like postal codes.
        const plain = (value) => value.replace(/^'/, "");
        const cents = (value) => {
            const n = parseFloat(plain(value));
            return Number.isFinite(n) ? Math.round(n * 100) : 0;
        };
        // "2026-09-06 10:11:26 -0400" -> "2026-09-06T10:11:26-04:00"
        const date = (value) => {
            const m = value.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/);
            return m ? m[1] + "T" + m[2] + m[3] + ":" + m[4] : value;
        };

        const orders = new Map();
        for (const row of rows) {
            const number = get(row, "Name");
            if (!number) continue;
            let order = orders.get(number);
            if (!order) {
                const ship = get(row, "Shipping Address1") ? "Shipping" : "Billing";
                order = {
                    number,
                    shopifyId: get(row, "Id"),
                    created: date(get(row, "Created at")),
                    currency: get(row, "Currency") || "CAD",
                    total: cents(get(row, "Total")),
                    refunded: cents(get(row, "Refunded Amount")),
                    tax: cents(get(row, "Taxes")),
                    financialStatus: get(row, "Financial Status").toLowerCase() || "paid",
                    customer: {
                        name: get(row, "Shipping Name") || get(row, "Billing Name"),
                        email: get(row, "Email"),
                        phone: plain(get(row, "Shipping Phone") || get(row, "Phone") || get(row, "Billing Phone")),
                    },
                    address: {
                        line1: get(row, ship + " Address1"),
                        line2: get(row, ship + " Address2"),
                        city: get(row, ship + " City"),
                        state: get(row, ship + " Province"),
                        postal_code: plain(get(row, ship + " Zip")),
                        country: get(row, ship + " Country"),
                    },
                    items: [],
                    shipping: { option: get(row, "Shipping Method"), amount: cents(get(row, "Shipping")) },
                    paymentMethod: get(row, "Payment Method"),
                    fulfilledAt: get(row, "Fulfillment Status") === "fulfilled" && get(row, "Fulfilled at") ? date(get(row, "Fulfilled at")) : null,
                };
                orders.set(number, order);
            }
            order.items.push({ quantity: parseInt(get(row, "Lineitem quantity"), 10) || 1, label: get(row, "Lineitem name") });
        }
        if (orders.size === 0) throw new Error("No orders found in that file.");
        return [...orders.values()];
    }

    // Spreadsheet CSV (quoted fields, "" for quotes, line breaks in quotes).
    function parseCsv(text) {
        const rows = [];
        let row = [], field = "", quoted = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (quoted) {
                if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
                else if (c === '"') quoted = false;
                else field += c;
            } else if (c === '"') quoted = true;
            else if (c === ",") { row.push(field); field = ""; }
            else if (c === "\n" || c === "\r") {
                if (c === "\r" && text[i + 1] === "\n") i++;
                row.push(field); field = "";
                if (row.some((f) => f !== "")) rows.push(row);
                row = [];
            } else field += c;
        }
        row.push(field);
        if (row.some((f) => f !== "")) rows.push(row);
        return rows;
    }

    // ---- Status and messages --------------------------------------------

    function setDirty(value) {
        dirty = value;
        const status = $("status");
        status.classList.toggle("is-dirty", value);
        status.textContent = value
            ? "Unsaved changes"
            : updatedAt ? "Last saved " + new Date(updatedAt).toLocaleString() : "Starting values (never saved)";
    }

    function showMessage(text, isError, action) {
        const box = $("message");
        box.replaceChildren(document.createTextNode(text));
        if (action) {
            const button = el("button", { type: "button", className: "pill", textContent: action.text });
            button.style.marginLeft = "12px";
            button.addEventListener("click", action.onClick);
            box.append(button);
        }
        box.classList.toggle("is-error", Boolean(isError));
        box.hidden = false;
        box.scrollIntoView({ block: "nearest" });
    }

    function hideMessage() {
        $("message").hidden = true;
    }

    // ---- Helpers ----------------------------------------------------------

    function el(tag, props = {}, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (key === "ariaLabel") node.setAttribute("aria-label", value);
            else node[key] = value;
        }
        node.append(...children);
        return node;
    }

    // "cassette shelf" -> "Cassette shelves", "cd shelf" -> "CD shelves"
    function plural(label) {
        const text = label.replace(/^cd\b/, "CD").replace(/shelf$/, "shelves");
        return text.charAt(0).toUpperCase() + text.slice(1);
    }

    // ---- Wiring -----------------------------------------------------------

    $("loginView").addEventListener("submit", async (event) => {
        event.preventDefault();
        showLoginError("");
        try {
            await logIn($("password").value);
        } catch (err) {
            token = null;
            showLoginError(err.message.charAt(0).toUpperCase() + err.message.slice(1) + ".");
        }
    });
    $("logoutButton").addEventListener("click", () => logOut());
    $("testEmailButton").addEventListener("click", sendTestEmail);
    $("testShippingEmailButton").addEventListener("click", sendTestEmail);
    document.querySelectorAll("#tabs .tab").forEach((tab) => {
        tab.addEventListener("click", () => showTab(tab.dataset.tab));
    });
    $("refreshOrders").addEventListener("click", () => loadOrders(false));
    $("loadMoreOrders").addEventListener("click", () => loadOrders(true));
    $("downloadCsv").addEventListener("click", downloadCsv);
    $("onlyToShip").addEventListener("change", renderOrders);
    $("shopifyCsv").addEventListener("change", () => {
        const file = $("shopifyCsv").files[0];
        $("shopifyCsv").value = "";
        if (file) importShopifyCsv(file);
    });
    $("removeLegacy").addEventListener("click", removeLegacy);
    $("refreshAnalytics").addEventListener("click", loadAnalytics);
    document.querySelectorAll(".periods [data-days]").forEach((button) => {
        button.addEventListener("click", () => {
            analyticsDays = Number(button.dataset.days);
            document.querySelectorAll(".periods [data-days]").forEach((b) => b.classList.toggle("is-active", b === button));
            loadAnalytics();
        });
    });
    $("saveButton").addEventListener("click", save);
    $("addCountryButton").addEventListener("click", addCountry);
    $("newCountryCode").addEventListener("keydown", (event) => {
        if (event.key === "Enter") addCountry();
    });
    $("collectTax").addEventListener("change", () => {
        draft.collectTax = $("collectTax").checked;
        setDirty(true);
    });
    window.addEventListener("beforeunload", (event) => {
        if (dirty) event.preventDefault();
    });

    // Stay logged in for this browser tab.
    let remembered = null;
    try { remembered = sessionStorage.getItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    if (remembered) {
        logIn(remembered).catch(() => logOut());
    }
})();
