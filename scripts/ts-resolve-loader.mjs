/**
 * Let node resolve the extensionless imports TypeScript uses.
 *
 * `import { toE164 } from "./phone"` is valid TypeScript and invalid ESM —
 * node wants "./phone.ts". Rather than change production imports to suit a
 * verification script, this hook appends the extension during resolution.
 *
 * Used by the scripts/ verification runners. The vitest suite resolves
 * these itself and is deliberately kept credential-free (see vitest.config.ts),
 * which is why the end-to-end check is a script rather than a test.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const REPO_ROOT = resolvePath(fileURLToPath(import.meta.url), "../..");
const EXTS = [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, nextResolve) {
  // `server-only` is a Next.js sentinel with no runtime implementation. The
  // vitest config already maps it to the same stub; scripts need it too or any
  // import chain that reaches a server module dies at the first hop.
  if (specifier === "server-only") {
    return nextResolve(pathToFileURL(resolvePath(REPO_ROOT, "__tests__/__stubs__/server-only.ts")).href, context);
  }

  // `@/…` is the tsconfig path alias. Without this a script can only import
  // modules that happen to use relative imports all the way down.
  let base = null;
  if (specifier.startsWith("@/")) {
    base = resolvePath(REPO_ROOT, specifier.slice(2));
  } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/i.test(specifier)) {
    base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
  }

  if (base) {
    if (/\.[a-z]+$/i.test(base) && existsSync(base)) {
      return nextResolve(pathToFileURL(base).href, context);
    }
    for (const ext of EXTS) {
      const candidate = base + ext;
      if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
    }
  }
  return nextResolve(specifier, context);
}
