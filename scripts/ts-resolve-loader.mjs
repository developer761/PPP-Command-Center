/**
 * Let node resolve the extensionless imports TypeScript uses.
 *
 * `import { toE164 } from "./phone"` is valid TypeScript and invalid ESM —
 * node wants "./phone.ts". Rather than change production imports to suit a
 * verification script, this hook appends the extension during resolution.
 *
 * Used only by scripts/verify-messaging-e2e.mjs. The vitest suite resolves
 * these itself and is deliberately kept credential-free (see vitest.config.ts),
 * which is why the end-to-end check is a script rather than a test.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/i.test(specifier)) {
    const from = dirname(fileURLToPath(context.parentURL));
    for (const ext of [".ts", ".tsx", ".js", ".mjs"]) {
      const candidate = resolvePath(from, specifier + ext);
      if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
    }
  }
  return nextResolve(specifier, context);
}
