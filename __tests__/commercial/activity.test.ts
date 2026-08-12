import { describe, it, expect } from "vitest";
import { buildActivityFeed, dueLabel, type ActivityEntry } from "@/lib/commercial/opportunities/activity";

const TODAY = "2026-08-12";
const e = (over: Partial<ActivityEntry> & { id: string; at: string }): ActivityEntry => ({
  kind: "status",
  title: "Something",
  ...over,
});

describe("buildActivityFeed", () => {
  it("leads with what is overdue, then what is due soonest", () => {
    // The order somebody would work them in — not the order they were created,
    // which is what a plain task list gives you.
    const feed = buildActivityFeed(
      [
        e({ id: "a", at: "2026-08-01", kind: "task", title: "Chase GC", dueAt: "2026-08-20" }),
        e({ id: "b", at: "2026-08-02", kind: "task", title: "Send submittal", dueAt: "2026-08-05" }),
        e({ id: "c", at: "2026-08-03", kind: "task", title: "Order paint", dueAt: "2026-08-13" }),
      ],
      TODAY
    );
    expect(feed.upcoming.map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(feed.overdueCount).toBe(1);
  });

  it("does not count finished work as upcoming", () => {
    const feed = buildActivityFeed(
      [e({ id: "a", at: "2026-08-01", kind: "task", title: "Done thing", dueAt: "2026-08-01", done: true })],
      TODAY
    );
    expect(feed.upcoming).toHaveLength(0);
    expect(feed.overdueCount).toBe(0);
    // …but it stays in the history, because it did happen.
    expect(feed.months[0].entries.map((x) => x.id)).toEqual(["a"]);
  });

  it("ignores a task with no due date — nothing can be late without one", () => {
    const feed = buildActivityFeed(
      [e({ id: "a", at: "2026-08-01", kind: "task", title: "Someday" })],
      TODAY
    );
    expect(feed.upcoming).toHaveLength(0);
  });

  it("groups history newest month first and names the current one 'This month'", () => {
    const feed = buildActivityFeed(
      [
        e({ id: "a", at: "2026-06-14T10:00:00Z" }),
        e({ id: "b", at: "2026-08-02T10:00:00Z" }),
        e({ id: "c", at: "2026-07-30T10:00:00Z" }),
      ],
      TODAY
    );
    expect(feed.months.map((m) => m.label)).toEqual(["This month", "July 2026", "June 2026"]);
  });

  it("orders entries within a month newest first", () => {
    const feed = buildActivityFeed(
      [
        e({ id: "old", at: "2026-08-02T09:00:00Z" }),
        e({ id: "new", at: "2026-08-11T09:00:00Z" }),
        e({ id: "mid", at: "2026-08-07T09:00:00Z" }),
      ],
      TODAY
    );
    expect(feed.months[0].entries.map((x) => x.id)).toEqual(["new", "mid", "old"]);
  });

  it("merges every source into one chronology — the whole point of the rail", () => {
    // The Timeline tab shows the status log alone, which is why nobody opens
    // it. A job's real story is the mix.
    const feed = buildActivityFeed(
      [
        e({ id: "s", at: "2026-08-03T10:00:00Z", kind: "status" }),
        e({ id: "n", at: "2026-08-04T10:00:00Z", kind: "note" }),
        e({ id: "p", at: "2026-08-05T10:00:00Z", kind: "proposal" }),
      ],
      TODAY
    );
    expect(feed.months[0].entries.map((x) => x.kind)).toEqual(["proposal", "note", "status"]);
    expect(feed.total).toBe(3);
  });

  it("survives a job with no history at all", () => {
    const feed = buildActivityFeed([], TODAY);
    expect(feed).toEqual({ upcoming: [], overdueCount: 0, months: [], total: 0 });
  });
});

describe("dueLabel", () => {
  it("says how late, not just that it is late", () => {
    expect(dueLabel("2026-08-08", TODAY)).toEqual({ text: "4 days overdue", overdue: true });
    expect(dueLabel("2026-08-11", TODAY).text).toBe("1 day overdue");
  });

  it("reads naturally at the boundaries instead of '0 days'", () => {
    expect(dueLabel("2026-08-12", TODAY)).toEqual({ text: "due today", overdue: false });
    expect(dueLabel("2026-08-13", TODAY).text).toBe("due tomorrow");
    expect(dueLabel("2026-08-19", TODAY).text).toBe("due in 7 days");
  });

  it("counts calendar days across the DST change", () => {
    // Subtracting timestamps gives 0.958 days here and rounds wrong.
    expect(dueLabel("2026-03-08", "2026-03-07").text).toBe("due tomorrow");
  });
});
