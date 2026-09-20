#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

output="$(mktemp)"
cleanup() { rm -f "$output"; }
trap cleanup EXIT HUP INT TERM

if npm run setup >"$output" 2>&1; then
  exit 0
else
  status=$?
fi

cat "$output" >&2
exit "$status"
