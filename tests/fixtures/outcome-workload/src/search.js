export function searchTotal(values) {
  return values.reduce((sum, value) => sum + value, 0);
}

export function searchLabel(id) {
  return `search-${String(id).padStart(4, '0')}`;
}

export function searchNormalize(input) {
  return String(input ?? '').trim().toLowerCase();
}
