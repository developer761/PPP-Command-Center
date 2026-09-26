/**
 * Lets a plain Node script import the app's server modules.
 *
 * Three things the bundler does that Node does not: resolve the `server-only`
 * guard (a build-time marker with no runtime behaviour), the `@/` path alias,
 * and extension-less TypeScript imports. Without them a checking script dies on
 * an import rather than on anything it is actually checking.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = process.cwd();

function withExt(pathname) {
  if (existsSync(pathname) && !pathname.endsWith("/")) return pathname;
  for (const ext of [".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx"]) {
    if (existsSync(pathname + ext)) return pathname + ext;
  }
  return pathname;
}

export async function resolve(specifier, context, next) {
  if (specifier === "server-only" || specifier === "client-only") {
    return { url: "data:text/javascript,export{}", shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    return next(pathToFileURL(withExt(join(ROOT, specifier.slice(2)))).href, context);
  }
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const base = new URL(specifier, context.parentURL);
    const fixed = withExt(decodeURIComponent(base.pathname));
    return next(pathToFileURL(fixed).href, context);
  }
  /**
   * `next/server`, `next/headers`, `next/cache` … resolve under the bundler and
   * not under Node, which wants the `.js` that Next's own error message names.
   * A script that imports one report module transitively picks up a dozen of
   * these and dies on the import rather than on what it came to check.
   *
   * Only attempted AFTER the normal resolution fails, so nothing that already
   * works changes shape.
   */
  try {
    return await next(specifier, context);
  } catch (err) {
    if (/^next\/[a-z-]+$/.test(specifier)) {
      return next(`${specifier}.js`, context);
    }
    throw err;
  }
}
