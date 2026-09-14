export function invoiceTotal(values) {
  return values.reduce((sum, value) => sum + value, 0);
}

export function invoiceLabel(id) {
  return `invoice-${String(id).padStart(4, '0')}`;
}

export function invoiceNormalize(input) {
  return String(input ?? '').trim().toLowerCase();
}
