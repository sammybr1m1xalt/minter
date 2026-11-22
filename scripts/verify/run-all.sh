#!/usr/bin/env bash
# Run every self-check. No framework: each script prints its own PASS/FAIL and
# exits non-zero on failure.
set -u
cd "$(dirname "$0")"

if [ "$#" -eq 0 ]; then
  set -- *-test.js *-test.mjs *-test.sh stage-probe.js stage-probe2.js gql-stage-probe.mjs
fi

pass=0; fail=0; skip=0
for t in "$@"; do
  [ -f "$t" ] || { echo "SKIP  $t (missing)"; skip=$((skip+1)); continue; }
  case "$t" in
    *.sh) run=(bash "$t") ;;
    *)    run=(node "$t") ;;
  esac
  out="$("${run[@]}" 2>&1)"; code=$?
  if [ $code -eq 0 ]; then
    pass=$((pass+1)); echo "PASS  $t"
  else
    fail=$((fail+1)); echo "FAIL  $t"
    echo "$out" | sed 's/^/      /' | tail -20
  fi
done
echo "--- $pass passed, $fail failed, $skip skipped"
[ $fail -eq 0 ]
