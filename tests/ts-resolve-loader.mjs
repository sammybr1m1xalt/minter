// Resolve extensionless relative imports in the compiled test output.
// tsc with --module esnext preserves "./chains" without the .js extension,
// which Node ESM refuses to load. This loader appends .js.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    // Already has a loader-recognized extension — let Node handle it.
    if (/\.(js|mjs|cjs|json|node)$/.test(specifier)) {
      return nextResolve(specifier, context);
    }
    try {
      return await nextResolve(specifier, context);
    } catch (e) {
      if (e.code === "ERR_MODULE_NOT_FOUND") {
        return nextResolve(specifier + ".js", context);
      }
      throw e;
    }
  }
  return nextResolve(specifier, context);
}
