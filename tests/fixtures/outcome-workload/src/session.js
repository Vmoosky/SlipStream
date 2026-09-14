export function sessionTotal(values) {
  return values.reduce((sum, value) => sum + value, 0);
}

export function sessionLabel(id) {
  return `session-${String(id).padStart(4, '0')}`;
}

export function sessionNormalize(input) {
  return String(input ?? '').trim().toLowerCase();
}
