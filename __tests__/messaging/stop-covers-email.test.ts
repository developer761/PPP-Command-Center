import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordInbound, type Accepted } from "@/lib/messaging/record-inbound";
import type { E164 } from "@/lib/messaging/phone";

/**
 * STOP STOPPED THE TEXT AND NOT THE EMAIL.
 *
 * record-inbound writes the opt-out first — before the workspace lookup,
 * before threading — so the suppression cannot depend on anything that might
 * fail. That ordering is right, and it left the job half done: the row carries
 * `channel: 'sms'` and no address, while gate-deps checks email suppression by
 * ADDRESS. So a customer who replied STOP to the launch text still received
 * the campaign email fifteen minutes later.
 *
 * Migration 186 says precisely this — "PPP campaigns send both channels in one
 * sequence — suppressing the SMS half only would keep emailing somebody who
 * unsubscribed" — and added the channel column for it. Nothing ever wrote
 * 'both'.
 *
 * Against a stub rather than the live database, because the e2e took the other
 * branch: the test number has no email on its record, so it exercised the
 * sms-only path and proved nothing about the widening.
 */

type Call = { table: string; op: string; payload?: Record<string, unknown>; filters: string[] };

function stubClient(conversationEmail: string | null) {
  const calls: Call[] = [];
  const chainFor = (call: Call, result: unknown) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "not", "neq", "order", "limit", "ilike", "in", "gte", "lte"]) {
      chain[m] = (...args: unknown[]) => {
        call.filters.push(`${m}(${args.map(String).join(",")})`);
        return chain;
      };
    }
    chain.maybeSingle = async () => result;
    chain.single = async () => result;
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
    return chain;
  };
  const client = {
    from: (table: string) => {
      const start = (op: string, payload?: Record<string, unknown>) => {
        const call: Call = { table, op, payload, filters: [] };
        calls.push(call);
        // The only read this test cares about: the conversation it widens from.
        const result = table === "sms_conversations" && op === "select"
          ? { data: conversationEmail ? { customer_email: conversationEmail } : null, error: null }
          : { data: null, error: null };
        return chainFor(call, result);
      };
      return {
        insert: (p: Record<string, unknown>) => start("insert", p),
        update: (p: Record<string, unknown>) => start("update", p),
        select: (...a: unknown[]) => {
          const c = start("select");
          return (c as Record<string, (...x: unknown[]) => unknown>).select(...a);
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const stop = (): Accepted => ({
  kind: "accept",
  from: "+15165550147" as E164,
  to: "+15163448418" as E164,
  body: "STOP",
  providerId: "test-1",
  mediaCount: 0,
  keyword: "opt_out",
});

let calls: Call[];

async function ingestStop(conversationEmail: string | null) {
  const s = stubClient(conversationEmail);
  calls = s.calls;
  // The stub cannot carry a whole webhook to completion; the WRITES are what
  // this asserts, and they all happen before anything that could throw.
  await recordInbound(s.client, stop()).catch(() => {});
}

beforeEach(() => { calls = []; });

const optOutWrites = () => calls.filter((c) => c.table === "sms_opt_outs");

describe("a STOP covers the channels PPP actually sends on", () => {
  it("widens the opt-out to email when the record has an address", async () => {
    await ingestStop("customer@example.com");
    const widened = optOutWrites().find((c) => c.op === "update" && c.payload?.channel === "both");
    expect(widened, "no update set channel 'both'").toBeTruthy();
    expect(widened?.payload?.email).toBe("customer@example.com");
    // Only the row that is still active — a re-opted-in person is not re-suppressed.
    expect(widened?.filters.join(" ")).toContain("is(opted_in_at,null)");
  });

  it("leaves it as sms when there is no address to suppress", async () => {
    await ingestStop(null);
    expect(optOutWrites().some((c) => c.op === "update" && c.payload?.channel === "both")).toBe(false);
  });

  it("records the text suppression FIRST, whatever happens after", async () => {
    // The ordering is the safety property. If the widening ever moves ahead of
    // the insert, a failed read would mean no suppression at all.
    await ingestStop("customer@example.com");
    expect(optOutWrites()[0]?.op).toBe("insert");
    expect(optOutWrites()[0]?.payload?.channel).toBe("sms");
  });
});

/**
 * A FAILED WORKSPACE LOOKUP IS NOT "NOBODY OWNS THIS NUMBER".
 *
 * The lookup discarded its error, and the two outcomes are indistinguishable
 * afterwards — `ws` is null either way. Everything downstream is gated on
 * ws?.id: no conversation is created, so the message is never recorded in
 * sms_messages at all, no turn is queued, and the CTIA HELP reply is skipped.
 * The webhook then answers 204, so the carrier does not retry and the text is
 * gone.
 *
 * One timeout therefore drops every inbound for as long as it lasts, while the
 * only trace says a customer texted a number no workspace owns — a
 * configuration message that would send the reader to entirely the wrong
 * place.
 *
 * THE OPT-OUT ORDERING IS WHAT MAKES THROWING SAFE, and that is asserted here
 * too: the suppression insert runs before this lookup on purpose, so a STOP is
 * recorded even when the lookup then fails.
 */
describe("an inbound is not silently dropped when the workspace read fails", () => {
  function failingWorkspaceLookup() {
    const calls: Call[] = [];
    const chain = (call: Call, result: unknown) => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "not", "neq", "order", "limit", "in", "gte"]) {
        c[m] = (...a: unknown[]) => { call.filters.push(`${m}(${a.map(String).join(",")})`); return c; };
      }
      c.maybeSingle = async () => result;
      c.single = async () => result;
      c.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
      return c;
    };
    const client = {
      from: (table: string) => {
        const start = (op: string, payload?: Record<string, unknown>) => {
          const call: Call = { table, op, payload, filters: [] };
          calls.push(call);
          const result = table === "sms_sub_accounts"
            ? { data: null, error: { message: "statement timeout", code: "57014" } }
            : { data: null, error: null };
          return chain(call, result);
        };
        return {
          insert: (p: Record<string, unknown>) => start("insert", p),
          update: (p: Record<string, unknown>) => start("update", p),
          select: (...a: unknown[]) => {
            const c = start("select");
            return (c as Record<string, (...x: unknown[]) => unknown>).select(...a);
          },
        };
      },
    } as unknown as SupabaseClient;
    return { client, calls };
  }

  it("throws rather than reporting the number as unowned", async () => {
    const s = failingWorkspaceLookup();
    await expect(recordInbound(s.client, stop())).rejects.toThrow(/workspace for this number/);
  });

  it("still records the opt-out, because that write comes first", async () => {
    const s = failingWorkspaceLookup();
    await recordInbound(s.client, stop()).catch(() => {});
    const optOut = s.calls.find((c) => c.table === "sms_opt_outs" && c.op === "insert");
    expect(optOut, "a STOP was lost because the workspace lookup failed").toBeTruthy();
    expect(optOut!.payload?.phone_e164).toBe("+15165550147");
  });
});
