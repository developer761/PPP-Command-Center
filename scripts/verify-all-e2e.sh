#!/usr/bin/env bash
# Every end-to-end check, against the real database.
#
# These import the app's own modules, which use the specifiers tsc and Next
# expect and Node does not resolve. The --import hook bridges that; without it
# every script here dies on ERR_MODULE_NOT_FOUND, which is how they all sat
# broken without anybody noticing.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.local 2>/dev/null; set +a
fails=0
for f in scripts/verify-*-e2e.mjs; do
  out=$(node --import ./scripts/ts-resolve.mjs "$f" 2>&1); code=$?
  summary=$(echo "$out" | grep -E "ALL PASS|passed, .* failed" | tail -1)
  if [ $code -ne 0 ]; then
    printf "  ✗  %-38s %s\n" "$(basename "$f")" "${summary:-exit $code}"
    echo "$out" | tail -15 | sed 's/^/       /'
    fails=$((fails+1))
  else
    printf "  ✓  %-38s %s\n" "$(basename "$f")" "$summary"
  fi
done
echo
[ $fails -eq 0 ] && echo "  every end-to-end check passed" || echo "  $fails script(s) failed"
exit $fails
