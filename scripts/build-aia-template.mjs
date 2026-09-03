/**
 * Re-embed the AIA workbook after replacing the .xlsx.
 *
 *   npm run build:aia-template
 *
 * The template is Stephanie's own form, so it changes only when she sends a new
 * one — which is exactly why this is a script you run deliberately rather than
 * a build step that could silently pick up a half-saved file.
 */
import { readFileSync, writeFileSync } from "node:fs";
const raw = readFileSync("lib/commercial/aia/template/aia-requisition.xlsx");
const b64 = raw.toString("base64");
const chunks = b64.match(/.{1,100}/g) ?? [];
const header = readFileSync("lib/commercial/aia/template/template-b64.ts", "utf8").split("export const AIA_TEMPLATE_B64")[0];
const body = chunks.map((c, i) => `  "${c}"${i === chunks.length - 1 ? ";" : " +"}`).join("\n");
writeFileSync(
  "lib/commercial/aia/template/template-b64.ts",
  `${header}export const AIA_TEMPLATE_B64 =\n${body}\n\n/** The workbook as bytes, ready for \`ExcelJS.Workbook.xlsx.load\`. */\nexport function aiaTemplateBuffer(): Buffer {\n  return Buffer.from(AIA_TEMPLATE_B64, "base64");\n}\n`
);
console.log(`embedded ${raw.length} bytes from aia-requisition.xlsx`);
