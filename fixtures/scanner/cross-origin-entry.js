// Synthetic. CDN-hosted chunks: import() and new URL() are code references, so
// cross-origin is legitimate there. Bare quoted paths stay same-origin only.
import("https://cdn.example.com/chunk-xyz.js");
export const worker = new URL("https://cdn.example.com/worker-1.js", import.meta.url);
export const asset = "/assets/local-2.js";
