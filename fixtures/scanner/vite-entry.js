// Synthetic. Exercises the string-literal chunk paths: dynamic import(),
// new URL(..., import.meta.url), and a bare quoted asset path.
//
// Vite/rollup emit these as literals, so they are resolvable from the bundle
// text alone — unlike webpack's numeric ids, which need the runtime's filename
// function (see webpack-runtime.js).
import("./chunk-abc123.js");

export const loadLazy = () => import("/assets/lazy-456.js");

export const workerUrl = new URL("./worker-789.js", import.meta.url);

export const preloaded = "/assets/preload-def456.js";
