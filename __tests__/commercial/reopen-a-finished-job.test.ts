import { describe, it, expect } from "vitest";
import { sensibleNextStatuses } from "@/lib/commercial/opportunities/attention";
import { ALLOWED_TRANSITIONS } from "@/lib/commercial/opportunities/constants";

/**
 * Stephanie 2026-08-20: "there are many times when we think we are done and
 * they call us back, sometimes months later, and we have to reopen the job."
 *
 * The DAG always allowed it and the writer always cleared closed_out_at on the
 * way out. What made it feel impossible was the PICKER: closed jobs returned
 * no suggested moves, so reopening lived behind the "show every status"
 * disclosure — the place reserved for rare corrections, which warns you the
 * move is unusual. Coming back to a finished job is a punch-list, not an
 * anomaly.
 */
describe("reopening a completed job", () => {
  it("offers In Progress directly, not behind the every-status disclosure", () => {
    expect(sensibleNextStatuses("post_sale_closed", "closed")).toContain("in_progress");
  });

  it("is still a legal transition in the DAG", () => {
    const allowed = ALLOWED_TRANSITIONS["post_sale_closed"] as readonly string[];
    expect(allowed).toContain("in_progress");
  });

  it("does not offer the status it is already on", () => {
    // The picker prepends the current status itself; listing it here showed it
    // twice, which is the bug the 2026-08-12 audit found on Qualifying.
    expect(sensibleNextStatuses("post_sale_closed", "closed")).not.toContain("post_sale_closed");
  });
});
