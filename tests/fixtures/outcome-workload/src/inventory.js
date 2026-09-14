export function inventoryTotal(values) {
  return values.reduce((sum, value) => sum + value, 0);
}

export function inventoryLabel(id) {
  return `inventory-${String(id).padStart(4, '0')}`;
}

export function inventoryNormalize(input) {
  return String(input ?? '').trim().toLowerCase();
}
