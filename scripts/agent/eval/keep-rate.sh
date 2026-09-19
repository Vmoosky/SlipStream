#!/usr/bin/env sh
set -eu

exec node scripts/agent/eval/keep-rate.mjs "$@"