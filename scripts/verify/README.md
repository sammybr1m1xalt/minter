# Verification scripts

Plain node/shell scripts. No test framework — each prints its own PASS/FAIL and
exits non-zero on failure.

    ./run-all.sh                 # every check
    ./run-all.sh race-test.js    # just these
    VERIFY_LIVE=1 ./run-all.sh   # include the ones that hit the network

Three latency probes are NOT in the default run because they need a real
endpoint and print timings rather than PASS/FAIL:

    MEASURE_RPC=https://your-rpc node t0-cost.js
    MEASURE_RPC=https://your-rpc node rpc-floor.js
    MEASURE_RPC=https://your-rpc node cold-start.js

`run.js` is the mock JSON-RPC server and the fire-path harness. It is the one
that measures T-0 latency, the stale-nonce repair, and the payload waves; the
others are unit-level checks against `dist/`.

Build first: `npm run build`. Scripts that need the network are skipped unless
`VERIFY_LIVE=1`.
