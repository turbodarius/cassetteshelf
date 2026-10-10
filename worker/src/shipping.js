// STARTING countries, shipping rates and fees. Edit them in the /admin
// dashboard instead: these values are only used until its first save.
//
// Flat shipping rates per country, charged once per order.
//
// - Keys are ISO country codes. Only countries listed here can be
//   selected in the checkout window.
// - `amount` is in cents (CAD).
// - `id` must be unique within a country; it is what the browser sends
//   back to say which option the customer picked.
// - The first option of each country is selected by default.
// - `fees` (optional): percentage fees for that country, e.g. tariffs.
//   Each is `percent` of the items' total (shipping not included), shown
//   to the customer as its own line, e.g. "Tariffs (50%)".
//
// The amounts below are PLACEHOLDERS -- set your real rates in the dashboard.

export const SHIPPING_RATES = {
  CA: {
    name: "Canada",
    options: [
      { id: "standard", label: "standard", amount: 1500 },
      { id: "express", label: "express", amount: 3000 },
    ],
  },
  US: {
    name: "United States",
    fees: [
      { id: "tariffs", label: "tariffs", percent: 50 },
    ],
    options: [
      { id: "standard", label: "standard", amount: 2500 },
    ],
  },
};
