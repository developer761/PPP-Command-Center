/**
 * Registers the resolver hook. Used as:
 *   node --import ./scripts/ts-resolve.mjs scripts/verify-whatever-e2e.mjs
 */
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);
