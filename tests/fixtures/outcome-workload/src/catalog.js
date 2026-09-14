export function catalogTotal(values) {
  return values.reduce((sum, value) => sum + value, 0);
}

export function catalogLabel(id) {
  return `catalog-${String(id).padStart(4, '0')}`;
}

export function catalogNormalize(input) {
  return String(input ?? '').trim().toLowerCase();
}
