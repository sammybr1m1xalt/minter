# Site-scanner fixtures

Saved inputs for `src/site-scanner.ts`, run by `scripts/check-scanner-fixtures.mjs`
(`npm run test:scanner`).

Each fixture has an expectation attached in the runner — a top candidate, a
ranking order, or a set of extracted URLs. Nothing here needs a test framework:
the runner states the expectation and reports which cases failed.

## Captured from live sites

| File | Source | Exercises |
|---|---|---|
| `opensea-collection.html` | `opensea.io/collection/gloombles` (2026-11-14) | Real OpenSea page: 160 distinct addresses, depth penalty, key strength, frequency. The collection must win. |
| `opensea-collection.json` | `GET /api/v2/collections/gloombles` | The API payload the page is built from. |
| `fungolabs.org.html` | `fungolabs.org` | The SPA shell: zero addresses. Documents why bundle following exists — the scan is empty and that is the honest answer. |
| `webpack-runtime.js` | webpack 5.94.0 `runtimeChunk: "single"` | The `.u` filename function and the chunk hash map. |
| `webpack-main.js` | same build, entry chunk | The `.e(480)` / `.e(544)` numeric ids. |
| `webpack-chunk.js` | same build, a lazy chunk | What the resolved URLs actually point at. |

The webpack files are a real build, not a transcription: `webpack@5.94.0`,
`optimization.runtimeChunk: "single"`, two dynamic imports. The runtime and the
entry chunk are kept separate on purpose — that split is the whole reason
resolving numeric ids needs two passes.

## Built to exercise one rule

| File | Rule |
|---|---|
| `currency-noise.html` | Native-token sentinels (0x000…000, WETH) repeat more than the collection and must be excluded. |
| `ambiguous-address.json` | `contractAddress` outranks `address`, which outranks `stageAddress`. |
| `depth.json` | A collection-level object beats item objects nested inside it, same key name. |
| `weak-parent.json` | An address under a plain `address` key *inside* `paymentTokens` is a token — the immediate key cannot tell, the enclosing one can. |
| `shared-infrastructure.json` | Seaport is a real contract, so it is demoted rather than excluded. |
| `vite-entry.js` | String-literal chunk paths: `import()`, `new URL(..., import.meta.url)`, quoted assets. |
| `cross-origin-entry.js` | CDN chunks: `import()` and `new URL()` are code references, so cross-origin is allowed there; bare quoted paths stay same-origin. |
| `api-paths.js` | Endpoint discovery, template-literal prefixes, and the static-asset denylist. |
| `html-api-paths.html` | Endpoint paths in the shell — `data-api`, `data-endpoint`, `<form action>`. |
| `base64-payload.html` | `data:application/json;base64,…` is decoded before scanning; the fixture contains no plaintext address at all. |

## Regenerating the live ones

The captures will rot — OpenSea changes its payload shape, fungolabs redeploys.
Re-capture with any authenticated fetch and update the expectations in the
runner if the ranking legitimately changed. A failure means either the scanner
regressed or the fixture is stale; both are worth knowing.
