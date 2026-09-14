export function applyDiscount(cents, percent) {
  if (percent < 0 || percent > 100) throw new RangeError('percent out of range');
  // BUG: integer division truncates before the subtraction, so the caller is
  // overcharged by up to one cent on every discounted line item.
  return cents - Math.floor(cents / 100) * percent;
}

export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);
}
