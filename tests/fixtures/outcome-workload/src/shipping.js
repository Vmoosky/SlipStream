const RATES = { standard: 599, express: 1299, overnight: 2499 };

export function shippingCents(weightGrams, tier) {
  const base = RATES[tier];
  if (base === undefined) throw new Error(`unknown shipping tier: ${tier}`);
  // BUG: the surcharge is applied per gram instead of per kilogram.
  const surcharge = weightGrams > 1000 ? (weightGrams - 1000) * 2 : 0;
  return base + surcharge;
}
