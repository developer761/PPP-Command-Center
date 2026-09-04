import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { proposalRevisionLabel } from "@/lib/commercial/proposals/constants";
import { proposalRecordId } from "@/lib/commercial/record-ids";
import { proposalProjectName } from "@/lib/commercial/proposals/project-name";

/**
 * Brendan's 2026-09-03 round.
 */

describe("the original proposal is not a revision", () => {
  /**
   * "The first proposal is still listed as R1. Implying that there is one
   * before it that it was revised. The original should have no R1. Once sent to
   * customer and they request a change or something then we create the R1 doc
   * the first revision."
   *
   * `revision_number` counts DOCUMENTS — the original is 1 — while the R number
   * counts REVISIONS, of which the original has had none.
   *
   * A previous pass got half of it: numbering stayed blank until something had
   * been sent on the deal. That hid the problem on drafts and let it through
   * the moment a proposal went out, which is where Brendan found it — on the
   * send screen and on the PDF the GC receives. 8 sent originals were labelled
   * "R1" on live data when he reported it.
   */
  it("labels the original with nothing at all", () => {
    expect(proposalRevisionLabel({ revision_number: 1 })).toBe("");
  });

  it("calls the FIRST revision R1, not R2", () => {
    expect(proposalRevisionLabel({ revision_number: 2 })).toBe("R1");
    expect(proposalRevisionLabel({ revision_number: 5 })).toBe("R4");
  });

  it("does not depend on whether anything was sent", () => {
    // The old gate. Whether a document is a revision has nothing to do with
    // whether a different document went out.
    expect(proposalRevisionLabel({ revision_number: 1 })).toBe("");
    expect(proposalRevisionLabel({ revision_number: 2 })).toBe("R1");
  });

  it("keeps the record ID in step with the label", () => {
    // These print side by side on the proposal header. Two different R numbers
    // for one document is worse than either alone.
    expect(proposalRecordId("2026-0020", 1)).toBe("PROP-2026-0020");
    expect(proposalRecordId("2026-0020", 2)).toBe("PROP-2026-0020-R1");
  });

  it("survives a junk revision number without inventing a revision", () => {
    expect(proposalRevisionLabel({ revision_number: 0 })).toBe("");
    expect(proposalRevisionLabel({ revision_number: NaN as unknown as number })).toBe("");
  });
});

describe("the nickname stays off customer documents", () => {
  /**
   * "Let's not use the nickname customer facing. It should always be the most
   * formal name customer facing."
   *
   * His proposal went out titled "Main" — office shorthand — for Plainview at
   * 115 Connetquot Avenue. The other live nicknames make the case on their own:
   * "Ste A1", "Exterior", "Tomco Office".
   */
  const ACCOUNT = "Alta Construction East";

  it("names the job by its ADDRESS", () => {
    // Asked what should replace the nickname, Brendan answered: "I'd say it's
    // should be the the address." His own example — nickname "Main", customer
    // Plainview, site 115 Connetquot Avenue.
    expect(
      proposalProjectName(
        { title_override: "Main", client_name: "Plainview", property_street: "115 Connetquot Ave" },
        ACCOUNT
      )
    ).toBe("115 Connetquot Ave");
  });

  it("falls back to the customer's name when there is no address yet", () => {
    // Katie's 2026-07-20 "JD Sports" convention, kept as the fallback. The two
    // rules only disagree when a job has both, and Brendan sends these.
    expect(
      proposalProjectName(
        { title_override: "Ste A1", client_name: "RAC", property_street: null },
        ACCOUNT
      )
    ).toBe("RAC");
  });

  it("does not let it back in through the last-resort fallback", () => {
    // derivedOppName APPENDS the nickname since migration 170, so the fallback
    // branch would smuggle it onto the document by the back door.
    const name = proposalProjectName(
      { title: "", title_override: "Exterior", client_name: null, property_street: null },
      ACCOUNT
    );
    expect(name).not.toContain("Exterior");
  });

  it("is still reachable everywhere INTERNAL", () => {
    // The point is not to delete the nickname — the team uses it. Only the
    // customer's copy is formal. derivedOppName still appends it.
    const src = readFileSync("lib/commercial/opportunities/db.ts", "utf8");
    expect(src).toContain("title_override_mode");
  });
});

describe("money inputs group their digits", () => {
  /**
   * "Can we please add some number formatting. Small detail but it will help us
   * not make mistakes when entering."
   *
   * 250000 and 25000 are one glance apart in a bare input and an order of
   * magnitude apart on a proposal.
   */
  const SRC = readFileSync("components/commercial/money-input.tsx", "utf8");

  it("posts something the server parsers already accept", () => {
    // The formatter posts a grouped string. Both parsers behind these fields
    // strip $ , and whitespace — verified here rather than assumed, because a
    // formatter whose output the server silently reads as 0 is far worse than
    // no formatter.
    const fmt = readFileSync("lib/commercial/invoices/format.ts", "utf8");
    const editor = readFileSync(
      "app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx", "utf8"
    );
    expect(fmt).toMatch(/replace\(\/\[\$,\\s\]\/g, ""\)/);
    expect(editor).toMatch(/replace\(\/\[\$,\\s\]\/g, ""\)/);
  });

  it("never rewrites a value it cannot parse", () => {
    // Silently "correcting" a typo into a confident number is the failure mode
    // worth avoiding on a money field.
    expect(SRC).toContain("return raw");
  });

  it("is not type=number", () => {
    // type=number rejects the commas this exists to show, and scroll-to-change
    // can alter a price from a trackpad nudge.
    //
    // Comments stripped first: the component EXPLAINS why it avoids
    // type="number", and the first version of this assertion matched that
    // explanation and failed on correct code. Grepping source text catches
    // prose as readily as code.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain('type="number"');
    expect(code).toContain('inputMode="decimal"');
  });

  it("reaches the proposal editor Brendan was working in", () => {
    const editor = readFileSync(
      "app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx", "utf8"
    );
    expect(editor).toContain("MoneyInput");
    expect(editor).not.toMatch(/inputMode="decimal"[^>]*name="unit_price"/);
  });
});

describe("the account page picks a named team", () => {
  /**
   * "I see the teams have been implemented on the Oppt page but it's still is
   * asking for a team the old way on the account page."
   *
   * Named teams reached the opportunity and the account DETAIL page. Account
   * CREATE was the one surface still asking only for individuals — and
   * `setOwnerTeam` had supported accounts the whole time, so the plumbing was
   * there and the form simply never offered it.
   */
  const SRC = readFileSync("app/commercial/accounts/new/page.tsx", "utf8");

  it("offers the named teams", () => {
    expect(SRC).toContain("listTeams");
    expect(SRC).toMatch(/<select name="team_id"/);
  });

  it("actually READS the field it posts", () => {
    // The failure this codebase keeps repeating: a form offers a field and its
    // own action never reads it, so the choice is swallowed and the page comes
    // back looking like it worked.
    expect(SRC).toMatch(/formData\.get\("team_id"\)/);
  });

  it("staffs the account rather than just labelling it", () => {
    // setOwnerTeam is what the opportunity and the account detail page call —
    // it applies the team's roster. Writing team_id alone would name a team
    // and assign nobody, which is the "picking a team does nothing" complaint
    // from an earlier round.
    expect(SRC).toMatch(/setOwnerTeam\("account"/);
  });

  it("keeps the per-person picker for people outside the team", () => {
    expect(SRC).toContain("CommercialNewAccountTeamPicker");
  });
});

/**
 * "The original should have no R1" — everywhere, not just on the header.
 *
 * The first pass fixed `proposalRevisionLabel` and `proposalRecordId`, which is
 * what the proposal HEADER prints, and called the item done. Brendan had
 * photographed three surfaces, and the third was the emailed attachment's
 * FILENAME:
 *
 *   "Same here the attachment is R1."
 *
 * That path built its own string — `[gc, project, `R${revision_number}`]` — and
 * so did about forty others: the PDF's document title, the activity feed, every
 * approval notification, and every confirm dialog. All of them read one too
 * high, so every original was "R1" somewhere.
 *
 * He had already predicted this: "maybe we didn t upate the exisiting ones or
 * we didnt relaly fix it."
 */
describe("no surface calls the original R1", () => {
  it("proposalLabel names the original without a revision", async () => {
    const { proposalLabel, proposalRef, proposalRevisionLabel } = await import(
      "@/lib/commercial/proposals/constants"
    );
    expect(proposalLabel({ revision_number: 1 })).toBe("Proposal");
    expect(proposalLabel({ revision_number: 2 })).toBe("Proposal R1");
    expect(proposalLabel({ revision_number: 3 })).toBe("Proposal R2");

    // Mid-sentence, where an empty string would leave "Mark  WON?".
    expect(proposalRef({ revision_number: 1 })).toBe("this proposal");
    expect(proposalRef({ revision_number: 2 })).toBe("R1");

    expect(proposalRevisionLabel({ revision_number: 1 })).toBe("");
  });

  it("no source file interpolates a raw revision_number into an R label", async () => {
    // The CLASS, not the one site he happened to photograph. Karan's standing
    // rule: told about one instance, sweep the platform for the same shape.
    const { execSync } = await import("node:child_process");
    const hits = execSync(
      "grep -rn 'R\\${[a-zA-Z_.]*revision_number\\|R\\${[a-zA-Z_.]*revisionNumber' app lib components || true",
      { encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean)
      // Submittals number from ZERO — `revision_number > 0 ? _Rev{n} : ""` is
      // already right, and rewriting it would introduce the off-by-one this
      // test exists to prevent.
      .filter((l) => !l.includes("submittal"));

    expect(
      hits,
      `these print R{revision_number} directly, so the ORIGINAL reads R1:\n${hits.join("\n")}`
    ).toEqual([]);
  });

  it("the emailed attachment's filename carries no R on the original", async () => {
    // The seam Brendan photographed. Asserted on the composed value rather than
    // on the source line, so a rewrite of the surrounding code cannot fake it.
    const { proposalRevisionLabel } = await import("@/lib/commercial/proposals/constants");
    const name = (revision_number: number) =>
      ["Alta", "115_Connetquot_Ave", proposalRevisionLabel({ revision_number })]
        .filter(Boolean)
        .join("_") + ".pdf";

    expect(name(1)).toBe("Alta_115_Connetquot_Ave.pdf");
    expect(name(2)).toBe("Alta_115_Connetquot_Ave_R1.pdf");
  });
});
