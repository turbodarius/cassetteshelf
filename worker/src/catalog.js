// Official price list used to charge customers, in cents (CAD).
//
// The site's prices.js / pricesCD.js are only used for display on the
// page. THIS file decides what customers actually pay, so whenever you
// change a price, change it in both places. `npm test` (in /worker)
// fails if the two ever disagree.

export const CURRENCY = "cad";

// Stripe Tax product tax code applied to every shelf.
// txcd_99999999 = "General - Tangible Goods".
export const TAX_CODE = "txcd_99999999";

export const FORMATS = {
  cassette: {
    label: "cassette shelf",
    prices: {
      "1x1": 2751,
      "1x2": 4219,
      "1x3": 5686,
      "1x4": 7358,
      "1x5": 8825,
      "1x6": 10497,
      "2x1": 4702,
      "2x2": 7297,
      "2x3": 9892,
      "2x4": 12897,
      "2x5": 15492,
      "2x6": 18497,
      "3x1": 6652,
      "3x2": 10375,
      "3x3": 14097,
      "3x4": 18436,
      "3x5": 22158,
      "3x6": 26497,
      "4x1": 8602,
      "4x2": 13453,
      "4x3": 18303,
      "4x4": 23975,
      "4x5": 28825,
      "4x6": 34497,
      "5x1": 10552,
      "5x2": 16331,
      "5x3": 22509,
      "5x4": 29513,
      "5x5": 35492,
      "5x6": 42496,
      "6x1": 12503,
      "6x2": 19609,
      "6x3": 26715,
      "6x4": 35052,
      "6x5": 42158,
      "6x6": 50496,
    },
  },
  cd: {
    label: "cd shelf",
    prices: {
      "1x1": 2694,
      "1x2": 3957,
      "1x3": 5220,
      "1x4": 6483,
      "1x5": 7746,
      "1x6": 9009,
      "2x1": 4423,
      "2x2": 6611,
      "2x3": 8799,
      "2x4": 10988,
      "2x5": 13176,
      "2x6": 15364,
      "3x1": 6151,
      "3x2": 9265,
      "3x3": 12379,
      "3x4": 15492,
      "3x5": 18606,
      "3x6": 21720,
      "4x1": 7880,
      "4x2": 11919,
      "4x3": 15958,
      "4x4": 19997,
      "4x5": 24036,
      "4x6": 28075,
      "5x1": 9608,
      "5x2": 14573,
      "5x3": 19537,
      "5x4": 24501,
      "5x5": 29466,
      "5x6": 34430,
      "6x1": 11337,
      "6x2": 17226,
      "6x3": 23116,
      "6x4": 29006,
      "6x5": 34896,
      "6x6": 40785,
    },
  },
};
