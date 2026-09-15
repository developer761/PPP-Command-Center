/**
 * The workspace reply-to address, against the real database.
 *
 * The unit tests prove the validator and that the address reaches Resend's
 * request body as reply_to. They cannot prove the CHECK constraint refuses what
 * the validator refuses — and the constraint is the only guard on a row edited
 * in the dashboard or imported from Hatch. So every case below is written to
 * the real table and the two answers are compared, one by one.
 *
 * Needs 20260915101459_reply_to_email_shape.sql applied. Cleanup in finally.
 */
import { createClient } from "@supabase/supabase-js";
import { validateReplyTo, emailAddressesFor } from "../lib/messaging/reply-to.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

let wsId = null;
let original;

try {
  const { data: ws } = await sb.from("sms_sub_accounts")
    .select("id, name, reply_to_email").eq("is_active", true).limit(1).single();
  wsId = ws.id;
  original = ws.reply_to_email;

  console.log(`\nREPLY-TO — real schema  (via ${ws.name})\n`);

  /* ── The constraint is actually there ─────────────────────────── */
  // Without this, every "refused" below could pass for the wrong reason — or
  // every "accepted" could, on a database the migration never reached.
  const probe = await sb.from("sms_sub_accounts")
    .update({ reply_to_email: "a@b.com\r\nBcc: x@y.com" }).eq("id", wsId);
  ok("the constraint exists (a CRLF address is refused)", probe.error !== null,
     probe.error ? "" : "stored — is the migration applied?");

  /* ── Database and code agree, case by case ────────────────────── */
  const cases = [
    "nassau@precisionpaintingplus.com",
    "Kate.M@precisionpaintingplus.com",
    "first.last+leads@sub.example.co.uk",
    "a@b.com\r\nBcc: everyone@example.com",
    "a@b.com\n",
    "a@\tb.com",
    "a@b.com, c@d.com",
    "a@b.com;c@d.com",
    "Kate <kate@b.com>",
    "kate@localhost",
    "a@b@c.com",
    "ka te@b.com",
    "a".repeat(254) + "@b.com",
  ];
  const disagreements = [];
  for (const raw of cases) {
    const code = validateReplyTo(raw);
    // The code stores its tidied value; the database is asked about exactly that.
    const written = code.ok ? code.value : raw;
    const { error } = await sb.from("sms_sub_accounts").update({ reply_to_email: written }).eq("id", wsId);
    if (code.ok !== (error === null)) {
      disagreements.push(`${JSON.stringify(raw).slice(0, 40)} code=${code.ok} db=${error === null}`);
    }
  }
  ok(`the database and the form agree on all ${cases.length} cases`, disagreements.length === 0,
     disagreements.join(" | "));

  /* ── It stores what the form writes, and a refusal changes nothing ─ */
  const good = validateReplyTo("  nassau@PrecisionPaintingPlus.com ");
  await sb.from("sms_sub_accounts").update({ reply_to_email: good.value }).eq("id", wsId);
  await sb.from("sms_sub_accounts").update({ reply_to_email: "x@y.com, z@w.com" }).eq("id", wsId);
  const { data: back } = await sb.from("sms_sub_accounts").select("reply_to_email").eq("id", wsId).single();
  ok("stores the tidied address, and a refused write left it intact",
     back.reply_to_email === "nassau@precisionpaintingplus.com", JSON.stringify(back.reply_to_email));

  /* ── What the scheduler would send with that row ──────────────── */
  const addr = emailAddressesFor({ workspaceReplyTo: back.reply_to_email, sharedFrom: "hello@precisionpaintingplus.net" });
  ok("the email comes from the shared sender, reply-to the workspace",
     addr.from === "hello@precisionpaintingplus.net" && addr.replyTo === "nassau@precisionpaintingplus.com");

  /* ── Clearing works ───────────────────────────────────────────── */
  const cleared = validateReplyTo("");
  const { error: clearErr } = await sb.from("sms_sub_accounts").update({ reply_to_email: cleared.value }).eq("id", wsId);
  ok("blank clears it to NULL", !clearErr && cleared.value === null, clearErr?.message ?? "");

} finally {
  if (wsId) {
    await sb.from("sms_sub_accounts").update({ reply_to_email: original ?? null }).eq("id", wsId);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
