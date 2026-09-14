export function ledgerTotal(values) {
  return values.reduce((sum, value) => sum + value, 0);
}

export function ledgerLabel(id) {
  return `ledger-${String(id).padStart(4, '0')}`;
}

export function ledgerNormalize(input) {
  return String(input ?? '').trim().toLowerCase();
}
