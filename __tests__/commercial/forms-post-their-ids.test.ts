import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A server action that validates an id it was never sent is a button that
 * looks like it worked and didn't.
 *
 * Stephanie 2026-08-20 reported two separate symptoms — "once sent for
 * approval, it brings you all the way back to the accounts page" and "change
 * orders emailed to customer not coming through". Both were one omission: the
 * Send form was the only form in the panel not posting opp_id + account_id,
 * and the action bails to /commercial/accounts when either fails UUID_RE —
 * before it sends the email. Nothing threw. The redirect looked deliberate.
 *
 * Type-checking cannot see this: FormData is stringly-typed on both sides.
 * So the check is structural — every form wired to an action in these panels
 * must carry the ids that action reads back out.
 */

type Panel = { file: string; required: string[] };

const PANELS: Panel[] = [
  {
    file: "components/commercial/change-orders-panel.tsx",
    required: ["opp_id", "account_id"],
  },
];

/** Split a source file into its <form …> … </form> blocks. */
function formBlocks(src: string): { index: number; body: string }[] {
  const out: { index: number; body: string }[] = [];
  const open = /<form\s+action=\{/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(src))) {
    const end = src.indexOf("</form>", m.index);
    if (end === -1) continue;
    out.push({ index: m.index, body: src.slice(m.index, end) });
  }
  return out;
}

describe("every action-wired form posts the ids its action validates", () => {
  for (const panel of PANELS) {
    it(panel.file, () => {
      const src = readFileSync(panel.file, "utf8");
      const forms = formBlocks(src);
      expect(forms.length, "no forms found — did the panel get restructured?").toBeGreaterThan(3);

      const offenders: string[] = [];
      for (const f of forms) {
        const line = src.slice(0, f.index).split("\n").length;
        for (const field of panel.required) {
          if (!f.body.includes(`name="${field}"`)) {
            offenders.push(`${panel.file}:${line} — form is missing name="${field}"`);
          }
        }
      }
      expect(offenders, offenders.join("\n")).toEqual([]);
    });
  }
});
