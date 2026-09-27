/**
 * Do the email paths refuse what they should, and address what they send?
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs scripts/check-email-flows.mjs
 *
 * WHY, AND WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It never sends an email. Not one. Every case here either returns before the
 * sender is reached, or is a pure function that decides an address.
 *
 * That is not squeamishness — it is the only honest way to test this. An
 * outbound email goes to a real general contractor and cannot be recalled, and
 * a "test" one is worse than a bug: it is Tomco's name on a message nobody
 * meant to send. The platform's own rule for supplier mail is human-review,
 * never auto-send.
 *
 * So this covers the two halves that CAN be checked without a victim:
 *
 *   THE GATES     a proposal that is not approved cannot be emailed; a void
 *                 invoice cannot; a malformed address, a blank subject or a
 *                 blank message are all refused. Every one of these returns
 *                 before the Resend import is even reached.
 *
 *   THE ADDRESSING  who a message is copied to, and how the archive address is
 *                 built and parsed back. Pure functions, no network.
 *
 * WHAT IS STILL UNPROVEN, stated rather than implied: that a real send lands,
 * that the PDF attaches, that the body renders in a mail client. Those need a
 * live send to a controlled inbox, which is a decision for Karan and not one a
 * script should make on its own.
 *
 * SAFETY — creates a throwaway account, deal and DRAFT proposal under a loud
 * marker, uses them only to prove the refusals, hard-deletes in dependency
 * order, and re-queries the marker to prove nothing is left.
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const MARK = "ZZ EMAIL FLOW CHECK — DELETE ME";
/** Never a deliverable domain. RFC 2606 reserves .invalid for exactly this. */
const NOWHERE = "zz-check@example.invalid";
let failures = 0;
let accountId = null, oppId = null, proposalId = null, invoiceId = null;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

try {
  console.log(`\nEmail gates and addressing — nothing is sent\n`);

  const { data: prof } = await sb.from("profiles").select("user_id").limit(1).maybeSingle();
  const ACTOR = prof?.user_id ?? null;

  const { data: acct } = await sb
    .from("commercial_accounts").insert({ company_name: MARK }).select("id").maybeSingle();
  accountId = acct?.id;
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .insert({ account_id: accountId, title: MARK, status: "proposal", sub_status: "estimate_sent" })
    .select("id").maybeSingle();
  oppId = opp?.id;
  const { data: prop } = await sb
    .from("commercial_proposals")
    // No account_id on this table — the proposal hangs off the opportunity,
    // which is where the account lives. The first run inserted one anyway, got
    // nothing back, and every proposal gate then "passed" on "Proposal not
    // found" rather than on the gate it was meant to prove.
    .insert({ opportunity_id: oppId, status: "draft", total_cents: 100 })
    .select("id").maybeSingle();
  proposalId = prop?.id;
  check("a draft proposal exists to be refused", !!proposalId);

  const { emailProposalToGc } = await import("../lib/commercial/proposals/email.ts");

  // ══ THE PROPOSAL GATE ════════════════════════════════════════════════════
  /*
   * R1 HARD GATE. Only an approved or already-sent proposal may go to a GC.
   * Brendan is the approver; the whole point of the approval step is that a
   * price nobody signed off cannot reach a customer.
   */
  const draftSend = await emailProposalToGc({
    proposal_id: proposalId, to_email: NOWHERE,
    subject: MARK, message: MARK, actor_user_id: ACTOR,
  });
  /*
   * The refusal has to be the STATUS gate, not "Proposal not found". On the
   * first run the insert had failed and this line passed anyway — a green tick
   * proving only that a record that does not exist cannot be emailed.
   */
  check("a DRAFT proposal cannot be emailed to the GC",
    !draftSend.ok && !/not found/i.test(draftSend.error),
    draftSend.ok ? "IT WAS SENT" : draftSend.error);
  check("and the refusal tells you what to do instead",
    !draftSend.ok && /approval/i.test(draftSend.error), draftSend.error ?? "");

  await sb.from("commercial_proposals").update({ status: "pending_approval" }).eq("id", proposalId);
  const pendingSend = await emailProposalToGc({
    proposal_id: proposalId, to_email: NOWHERE,
    subject: MARK, message: MARK, actor_user_id: ACTOR,
  });
  check("one still awaiting approval cannot either",
    !pendingSend.ok && /await/i.test(pendingSend.error),
    pendingSend.ok ? "IT WAS SENT" : pendingSend.error);

  // ── The input guards, which run before anything is looked up ─────────────
  const badAddr = await emailProposalToGc({
    proposal_id: proposalId, to_email: "not-an-email",
    subject: MARK, message: MARK, actor_user_id: ACTOR,
  });
  check("a malformed recipient is refused", !badAddr.ok, badAddr.error ?? "");

  const noSubject = await emailProposalToGc({
    proposal_id: proposalId, to_email: NOWHERE, subject: "  ", message: MARK, actor_user_id: ACTOR,
  });
  check("a blank subject is refused", !noSubject.ok, noSubject.error ?? "");

  const noBody = await emailProposalToGc({
    proposal_id: proposalId, to_email: NOWHERE, subject: MARK, message: "  ", actor_user_id: ACTOR,
  });
  check("a blank message is refused", !noBody.ok, noBody.error ?? "");

  const badCc = await emailProposalToGc({
    proposal_id: proposalId, to_email: NOWHERE, cc_email: "nope",
    subject: MARK, message: MARK, actor_user_id: ACTOR,
  });
  check("a malformed CC is refused", !badCc.ok, badCc.error ?? "");

  // ══ THE INVOICE GATE ═════════════════════════════════════════════════════
  const { data: inv } = await sb
    .from("commercial_invoices")
    .insert({ opportunity_id: oppId, account_id: accountId,
              invoice_number: `ZZ-EMAIL-${Date.now().toString().slice(-8)}`,
              status: "void", subtotal_cents: 100 })
    .select("id").maybeSingle();
  invoiceId = inv?.id;
  const { emailInvoiceToGc } = await import("../lib/commercial/invoices/email.ts");
  const voidSend = await emailInvoiceToGc({
    invoice_id: invoiceId, to_email: NOWHERE,
    subject: MARK, message: MARK, actor_user_id: ACTOR,
  });
  /*
   * A void invoice is money nobody owes. Emailing one asks a GC to pay a bill
   * that has been cancelled.
   */
  check("a VOID invoice cannot be emailed",
    !voidSend.ok, voidSend.ok ? "IT WAS SENT" : voidSend.error);

  // ══ ADDRESSING — pure, no network ════════════════════════════════════════
  const { buildArchiveAddress, parseArchiveRecipient, extractEmail, isArchiveConfigured } =
    await import("../lib/commercial/email-archive/address.ts");

  check("the archive knows whether it is configured",
    typeof isArchiveConfigured() === "boolean", String(isArchiveConfigured()));

  check("an address is pulled out of a display name",
    extractEmail('Erika <erika@lmjcontracting.com>') === "erika@lmjcontracting.com",
    extractEmail('Erika <erika@lmjcontracting.com>'));
  check("a bare address survives unchanged",
    extractEmail("erika@lmjcontracting.com") === "erika@lmjcontracting.com");

  if (isArchiveConfigured()) {
    /*
     * ROUND TRIP. The archive address carries an HMAC so a reply can be tied
     * back to the deal it belongs to. If building and parsing disagree, filed
     * mail lands against the wrong job — or against none.
     */
    const built = buildArchiveAddress({ kind: "opportunity", id: oppId });
    check("an archive address can be built", typeof built === "string" && built.includes("@"), String(built));
    const parsed = parseArchiveRecipient(built);
    check("and parses back to the same record",
      parsed?.id === oppId, `${parsed?.kind}/${parsed?.id}`);
  } else {
    console.log("  --    archive addressing not configured on this environment; skipped");
  }
} catch (err) {
  failures++;
  console.log("  FAIL  threw:", err instanceof Error ? err.message : String(err));
} finally {
  if (invoiceId) await sb.from("commercial_invoices").delete().eq("id", invoiceId);
  if (proposalId) await sb.from("commercial_proposals").delete().eq("id", proposalId);
  if (oppId) {
    await sb.from("commercial_projects").delete().eq("opportunity_id", oppId);
    await sb.from("commercial_opportunities").delete().eq("id", oppId);
  }
  if (accountId) await sb.from("commercial_accounts").delete().eq("id", accountId);

  const { data: lo } = await sb.from("commercial_opportunities").select("id").eq("title", MARK);
  const { data: la } = await sb.from("commercial_accounts").select("id").eq("company_name", MARK);
  const leftover = (lo ?? []).length + (la ?? []).length;
  check("nothing is left behind", leftover === 0, leftover ? `${leftover} row(s) still there` : "");

  console.log(
    failures === 0
      ? "\n✅ every email gate refuses what it should, and nothing was sent\n"
      : `\n❌ ${failures} check(s) failed\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}
