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
    let meta = null;         // { sizes, formats, storageReady }
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
        meta = { sizes: data.sizes, formats: data.formats, storageReady: data.storageReady };
        updatedAt = data.updatedAt;
        draft = fromSettings(data.settings);
        setDirty(false);
        render();
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

    // ---- Tabs -----------------------------------------------------------------

    function showTab(name) {
        document.querySelectorAll("#tabs .tab").forEach((tab) => {
            tab.classList.toggle("is-active", tab.dataset.tab === name);
        });
        $("settingsTab").hidden = name !== "settings";
        $("ordersTab").hidden = name !== "orders";
        document.querySelectorAll("[data-settings-only]").forEach((node) => {
            node.hidden = name !== "settings";
        });
        hideMessage();
        if (name === "orders" && !ordersLoaded) loadOrders(false);
    }

    // ---- Orders -----------------------------------------------------------

    let orders = [];
    let nextOrdersPage = null;
    let ordersLoaded = false;

    // more = false starts over from the newest; true appends the next page.
    async function loadOrders(more) {
        const button = more ? $("loadMoreOrders") : $("refreshOrders");
        button.disabled = true;
        if (!more) $("ordersSummary").textContent = "Loading orders…";
        try {
            const page = more && nextOrdersPage ? "?page=" + encodeURIComponent(nextOrdersPage) : "";
            const data = await api("GET", null, "/admin/orders" + page);
            orders = more ? orders.concat(data.orders) : data.orders;
            nextOrdersPage = data.nextPage;
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

    function renderOrders() {
        const list = $("ordersList");
        list.replaceChildren(...orders.map(orderCard));
        $("loadMoreOrders").hidden = !nextOrdersPage;
        $("downloadCsv").disabled = orders.length === 0;

        const kept = orders.reduce((sum, o) => sum + o.total - o.refunded, 0);
        $("ordersSummary").textContent = orders.length === 0
            ? "No orders yet. New orders can take about a minute to appear."
            : orders.length + (nextOrdersPage ? " most recent" : "") + " order" + (orders.length === 1 ? "" : "s") +
              " · " + cad(kept) + " after refunds. New orders can take about a minute to appear.";
    }

    function orderCard(order) {
        const card = el("article", { className: "order" });

        card.append(el("div", { className: "order-head" },
            el("span", { className: "order-date", textContent: new Date(order.created).toLocaleString() }),
            el("strong", { className: "order-total", textContent: cad(order.total) }),
            el("span", { className: "badge badge-" + order.status.replace(" ", "-"), textContent:
                order.status === "partially refunded" ? "partially refunded (" + cad(order.refunded) + ")" : order.status }),
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
        card.append(el("p", { className: "order-foot" },
            document.createTextNode((order.paymentMethod || "Paid") + " · "),
            el("a", { href: order.stripeUrl, target: "_blank", rel: "noopener", textContent: "View in Stripe ↗" }),
            document.createTextNode(" · " + order.id),
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
        const header = ["date", "order", "status", "total", "refunded", "name", "email", "phone",
            "address line 1", "address line 2", "city", "province/state", "postal code", "country",
            "items", "shipping option", "shipping", "fees", "tax"];
        const rows = orders.map((o) => [
            o.created, o.id, o.status, dollars(o.total), dollars(o.refunded),
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
    document.querySelectorAll("#tabs .tab").forEach((tab) => {
        tab.addEventListener("click", () => showTab(tab.dataset.tab));
    });
    $("refreshOrders").addEventListener("click", () => loadOrders(false));
    $("loadMoreOrders").addEventListener("click", () => loadOrders(true));
    $("downloadCsv").addEventListener("click", downloadCsv);
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
