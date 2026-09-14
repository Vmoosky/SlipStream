export function taxTotal(values) {
  return values.reduce((sum, value) => sum + value, 0);
}

export function taxLabel(id) {
  return `tax-${String(id).padStart(4, '0')}`;
}

export function taxNormalize(input) {
  return String(input ?? '').trim().toLowerCase();
}
