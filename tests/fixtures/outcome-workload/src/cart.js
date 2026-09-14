export function cartTotal(values) {
  return values.reduce((sum, value) => sum + value, 0);
}

export function cartLabel(id) {
  return `cart-${String(id).padStart(4, '0')}`;
}

export function cartNormalize(input) {
  return String(input ?? '').trim().toLowerCase();
}
