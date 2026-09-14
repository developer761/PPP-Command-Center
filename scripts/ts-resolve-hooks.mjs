/**
 * Letting the verify scripts import the app's own modules.
 *
 * tsc and Next resolve `./compliance` to `compliance.ts` and `@/lib/x` to the
 * project root. Node does neither: native ESM has never resolved an
 * extensionless relative specifier, and knows nothing about the alias. So
 * every verify-*-e2e script that reached a module with its own imports died on
 * ERR_MODULE_NOT_FOUND — silently, because nobody runs them in CI.
 *
 * Only verify-handoff-e2e ran, and only because the module it imports has no
 * imports of its own. That is luck, not design.
 *
 * This is a resolver hook, not a change to the app: the source keeps the
 * specifiers tsc and Next expect, and the scripts stop being decoration.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTS = [".ts", ".tsx", ".mjs", ".js"];

function firstThatExists(base) {
  for (const ext of EXTS) if (fs.existsSync(base + ext)) return base + ext;
  // A directory import resolves to its index, same as the bundler does.
  for (const ext of EXTS) {
    const idx = path.join(base, "index" + ext);
    if (fs.existsSync(idx)) return idx;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  // Already has an extension, or is a bare package: leave it alone.
  const relative = specifier.startsWith(".");
  const aliased = specifier.startsWith("@/");

  if ((relative || aliased) && !/\.[mc]?[jt]sx?$/.test(specifier)) {
    const base = aliased
      ? path.join(ROOT, specifier.slice(2))
      : path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    const hit = firstThatExists(base);
    if (hit) return next(pathToFileURL(hit).href, context);
  }

  // An aliased specifier that already carries its extension still needs the
  // alias expanding.
  if (aliased) {
    const abs = path.join(ROOT, specifier.slice(2));
    if (fs.existsSync(abs)) return next(pathToFileURL(abs).href, context);
  }

  return next(specifier, context);
}
