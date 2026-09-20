#!/usr/bin/env sh
set -eu

output="$(mktemp)"
cleanup() { rm -f "$output"; }
trap cleanup EXIT HUP INT TERM

if npm test >"$output" 2>&1; then
  exit 0
else
  status=$?
fi

cat "$output" >&2
exit "$status"
