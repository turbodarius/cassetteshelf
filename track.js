// Anonymous analytics for the admin dashboard's Analytics tab: counts page
// views and checkout steps. No cookies and nothing stored in the browser;
// the checkout worker turns each visit into an anonymous code that changes
// every day (see worker/src/analytics.js). Browsers set to "Do Not Track"
// aren't counted.
//
//   cassetteTrack("add_to_cart", "cassette:2x2")   (used by checkout.js)

(function () {
    // Same worker as the checkout (checkout.js).
    const API_BASE = "https://cassetteshelf-checkout.cassetteshelf.workers.dev";

    const off = navigator.doNotTrack === "1" || window.doNotTrack === "1";

    function track(type, detail) {
        if (off) return;
        const body = JSON.stringify({
            type,
            path: location.pathname,
            referrer: document.referrer,
            detail: detail || "",
        });
        try {
            // text/plain keeps it a "simple" request (no CORS preflight).
            const blob = new Blob([body], { type: "text/plain" });
            if (!navigator.sendBeacon || !navigator.sendBeacon(API_BASE + "/track", blob)) {
                fetch(API_BASE + "/track", { method: "POST", body: blob, keepalive: true }).catch(() => {});
            }
        } catch (e) {
            // Analytics must never break the page.
        }
    }

    window.cassetteTrack = track;
    track("pageview");
})();
