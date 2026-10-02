// Flat shipping rates per country, charged once per order.
//
// - Keys are ISO country codes. Only countries listed here can be
//   selected in the checkout window.
// - `amount` is in cents (CAD).
// - `id` must be unique within a country; it is what the browser sends
//   back to say which option the customer picked.
// - The first option of each country is selected by default.
//
// The amounts below are PLACEHOLDERS -- set your real rates before going live.

export const SHIPPING_RATES = {
  CA: {
    name: "Canada",
    options: [
      { id: "standard", label: "standard shipping", amount: 1500 },
      { id: "express", label: "express shipping", amount: 3000 },
    ],
  },
  US: {
    name: "United States",
    options: [
      { id: "standard", label: "standard shipping", amount: 2500 },
    ],
  },
};
