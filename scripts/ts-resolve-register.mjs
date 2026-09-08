/**
 * Registers the extensionless-import resolver. Used with --import.
 * See scripts/ts-resolve-loader.mjs for why this exists.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./ts-resolve-loader.mjs", pathToFileURL(`${import.meta.dirname}/`));
