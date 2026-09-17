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
  return next(specifier, context);
}
