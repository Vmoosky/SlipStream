export function auditTotal(values) {
  return values.reduce((sum, value) => sum + value, 0);
}

export function auditLabel(id) {
  return `audit-${String(id).padStart(4, '0')}`;
}

export function auditNormalize(input) {
  return String(input ?? '').trim().toLowerCase();
}
