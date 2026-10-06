import { describe, it, expect } from "vitest";
import fs from "node:fs";

/**
 * A rule picker that can only hold one rule.
 *
 * Kate, 2026-10-06, about the sandbox: "If there are multiple missteps (a9,
 * a23, a15) corrected in the convo, would i tag the main one (a9)? will that
 * leave the others (a23 and a15) untagged in the rules?"
 *
 * It would have. The simulator's "Testing which rule" was a single <select>,
 * so a run that demonstrated three rules counted towards one. The other two
 * stayed on the coverage page's untested list, and the only way to clear them
 * was to run the same conversation again twice.
 *
 * Nothing underneath was wrong, which is what made it hard to see:
 * exportScenarioToTraining has always taken `tagKeys: string[]`, it writes one
 * sms_training_example_tags row per key, and loadTrainingCoverage counts that
 * join table per rule. Storage, server action and report were all many-to-many.
 * The control was the only thing that was not — and a <select> loses the extra
 * rules silently, with no error for anybody to notice.
 *
 * So this guards the SHAPE: every screen that files training tags holds them as
 * a set and hands the set over whole. The scalar-wrap `tagKeys: x ? [x] : []`
 * is the exact line that was wrong, and it type-checks perfectly.
 */

/** Every screen that writes sms_training_example_tags rows. */
const PICKERS = [
  "components/messaging/simulator.tsx",
  "components/messaging/example-writer.tsx",
  "components/messaging/thread-teach.tsx",
  "components/messaging/grader.tsx",
];

/** Comments describe the bug; they must not be read as the bug. */
function code(file: string): string {
  return fs.readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
}

describe("every training-tag picker takes more than one rule", () => {
  it("the files are all still there", () => {
    for (const f of PICKERS) expect(fs.existsSync(f), f).toBe(true);
  });

  it("none of them wraps a single key into the array at the call", () => {
    const offenders: string[] = [];
    for (const f of PICKERS) {
      // `tagKeys: tagKey ? [tagKey] : []` — one rule, dressed as many.
      if (/tagKeys:\s*\w+\s*\?\s*\[/.test(code(f))) offenders.push(f);
    }
    expect(offenders, "a picker is filing one rule where the run showed several").toEqual([]);
  });

  it("none of them puts the rule list in a <select>", () => {
    // A <select> is a single value. The chip list is the idiom here precisely
    // because somebody has to be able to tick three.
    const offenders: string[] = [];
    for (const f of PICKERS) {
      const src = code(f);
      // A select whose options are the tags, however the lines are broken up.
      if (/<select[\s\S]{0,400}?tags\.map\(/.test(src)) offenders.push(f);
    }
    expect(offenders, "the rule picker is a single-value control").toEqual([]);
  });

  it("the sandbox holds its rules as a set and sends all of them", () => {
    const src = code("components/messaging/simulator.tsx");
    expect(src).toMatch(/useState<string\[\]>/);
    expect(src).toMatch(/exportScenarioToTraining\(\{[^}]*tagKeys\s*[,}]/);
  });

  it("the sandbox will not seed itself from a ?tag= that is not a real rule", () => {
    // Chips do not ignore an unknown value the way a <select> did: it would sit
    // in the array invisibly, enable the button, and fail on the foreign key.
    const src = code("components/messaging/simulator.tsx");
    expect(src).toMatch(/initialTagKey && tags\.some\(/);
  });
});
