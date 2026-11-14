// Synthetic. Exercises API path discovery and slug expansion.
//
// The scanner cannot execute the bundle, so it recovers endpoint paths from the
// string literals and then tries them. Two shapes matter:
//   - a plain literal path, "/api/collections/gloombles"
//   - a template literal, `/api/campaigns/drops/${slug}`, whose useful part is
//     the literal PREFIX; the variable part is a slug the page already knows.
const slug = "gloombles";

export async function loadDrop() {
  return fetch(`/api/campaigns/drops/${slug}`);
}

export async function loadCollection() {
  return fetch("/api/collections/gloombles");
}

export async function loadStatic() {
  // Not a data endpoint — the denylist must drop this one.
  return fetch("/assets/logo.svg");
}
