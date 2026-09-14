export function couponTotal(values) {
  return values.reduce((sum, value) => sum + value, 0);
}

export function couponLabel(id) {
  return `coupon-${String(id).padStart(4, '0')}`;
}

export function couponNormalize(input) {
  return String(input ?? '').trim().toLowerCase();
}
