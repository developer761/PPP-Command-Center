/**
 * Loading the snippets a person can drop into one thread — already filled in.
 *
 * ── FILLED HERE, NOT IN THE COMPOSER, AND NOT BY THE GATE ───────────────
 *
 * A snippet may carry `{{customer_name}}`. Three places could resolve it and
 * only one is right:
 *
 *   the gate       too late. It refuses an unfilled field, which arrives
 *                  after the rep hit send, on a screen that has moved on.
 *   the composer   it would need the customer's name, the workspace's name
 *                  and phone as props, which is the conversation's business
 *                  and not a text box's.
 *   HERE           the snippet arrives as the sentence it will actually be,
 *                  so what the rep reads is what the customer gets.
 *
 * That last property is the whole point. `fillMergeFields` deliberately
 * leaves an unfillable field in place rather than blanking it — so if this
 * did not fill them, the rep would be inserting a literal "{{customer_name}}"
 * into a message to a customer and it would look like it was going to work.
 *
 * Not cached. The standing answers are cached because they are read on every
 * agent turn; this is read when a person opens a thread, which is rare, and
 * the values baked into each snippet are per-conversation anyway.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fillMergeFields } from "./merge-fields";
import { agentConfigFor } from "./agent-config-for";
import { resolveSnippets, usableSnippets, type Snippet } from "./snippets";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReadySnippet = { id: string; name: string; body: string; shared: boolean };

/**
 * Every snippet this conversation can use, with the merge fields resolved
 * against it.
 *
 * Returns [] rather than throwing on any failure. A composer that cannot list
 * its snippets should still let somebody type — losing the shortcut is a
 * nuisance, losing the reply box is a customer with nobody able to answer
 * them, which is the hole the composer exists to close.
 */
export async function snippetsForConversation(
  sb: SupabaseClient, conversationId: string
): Promise<ReadySnippet[]> {
  if (!UUID.test(conversationId)) {
    console.error(`[snippets] not a conversation id: ${JSON.stringify(conversationId)}`);
    return [];
  }

  const { data: conv, error: convErr } = await sb
    .from("sms_conversations")
    .select("id, customer_name, workspace_id, sms_sub_accounts(id, name, phone_e164)")
    .eq("id", conversationId)
    .maybeSingle();
  if (convErr || !conv) {
    if (convErr) console.error(`[snippets] could not read the conversation: ${convErr.message}`);
    return [];
  }

  const ws = conv.sms_sub_accounts as unknown as
    { id: string; name: string | null; phone_e164: string | null } | null;
  const workspaceId = (conv as { workspace_id: string | null }).workspace_id;

  let rows: { id: string; name: string; body: string; workspace_id: string | null }[];
  try {
    // Both tiers. A shared snippet belongs to no workspace and is offered in
    // every one, so filtering to this workspace would hide most of the list.
    const q = sb.from("sms_snippets")
      .select("id, name, body, workspace_id, sort_order")
      .eq("is_active", true)
      .order("sort_order").order("name");
    const { data, error } = workspaceId && UUID.test(workspaceId)
      ? await q.or(`workspace_id.eq.${workspaceId},workspace_id.is.null`)
      : await q.is("workspace_id", null);
    if (error) throw new Error(error.message);
    rows = (data ?? []) as typeof rows;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Could not find the table|PGRST205|does not exist/i.test(msg)) {
      console.warn(
        "[snippets] sms_snippets is not in the database yet — the composer has no "
        + "shortcuts and still works. Apply supabase/migrations/20260929170000_snippets.sql."
      );
    } else {
      console.error(`[snippets] could not read the snippets: ${msg}`);
    }
    return [];
  }

  const withTier: (Snippet & { id: string })[] = rows.map((r) => ({
    id: r.id, name: r.name, body: r.body, shared: r.workspace_id === null,
  }));

  /**
   * VALIDATE FIRST, THEN LET THE SURVIVORS COMPETE.
   *
   * This was the other way round, with a comment asserting the other way
   * round was correct. It is not, and the reasoning is short enough that
   * getting it wrong twice is inexcusable: resolveSnippets puts LOCAL rows
   * first, so a broken local snippet WINS its name, and usableSnippets then
   * drops it — taking the perfectly good shared snippet of the same name with
   * it, because that was already evicted. The rep ends up with neither, the
   * editor still lists both rows as normal, and the only trace is a line in a
   * server log.
   *
   * workspace-faq-db.ts had the identical bug, was fixed, and carries the
   * same note — "the workspace ends up with neither" — plus a regression test
   * crossing validity with precedence. The snippet tests ported the
   * precedence cases and the validity cases separately and never crossed
   * them, which is exactly why the suite was green.
   */
  const { usable: valid, rejected } = usableSnippets(withTier);
  const usable = resolveSnippets(valid);
  for (const r of rejected) {
    console.error(
      `[snippets] not offering ${JSON.stringify(r.snippet.name)}: `
      + r.problems.map((p) => p.why).join("; ")
    );
  }

  /**
   * {{office_location}} IS A KNOWN FIELD, SO IT HAS TO BE FILLED HERE.
   *
   * It is in KNOWN_MERGE_FIELDS, so checkSnippet accepts it, so the editor
   * lets it save — and this function filled four fields and not that one.
   * fillMergeFields deliberately leaves an unfilled field in place, so the
   * rep's composer would show a literal "{{office_location}}", it would look
   * like the system was going to handle it, and the gate would then refuse
   * the send with `unresolved_merge_field` after they had pressed Send.
   *
   * This is the identical bug the campaign path already had and fixed —
   * scheduler-db.ts:167 carries the note: "office_location is offered by the
   * editor and was never passed here, so a message using it was refused at
   * every attempt until it failed." Same fix, same shape: looked up only when
   * something actually wants it, because it is a second query.
   */
  const wantsOffice = usable.some((s) => s.body.includes("{{office_location}}"));
  const cfg = wantsOffice && ws?.id ? await agentConfigFor(ws.id) : null;

  /**
   * AND ONE LAST LOOK AFTER FILLING.
   *
   * checkSnippet runs before the merge fields are resolved, so it can only
   * catch a field it knows nothing fills. A field that is KNOWN but happens
   * to have no value for this conversation — an office with no location set —
   * survives every check and arrives as a raw token, because fillMergeFields
   * deliberately leaves it in place. Dropping it here is the difference
   * between a shortcut quietly missing and a rep pasting "{{office_location}}"
   * to a customer and having the gate refuse it after they pressed Send.
   */
  const filled = usable.map((s) => ({
    id: s.id,
    name: s.name,
    body: fillMergeFields(s.body, {
      workspacePhone: ws?.phone_e164 ?? null,
      workspaceName: ws?.name ?? null,
      customerName: (conv as { customer_name: string | null }).customer_name,
      officeLocation: cfg?.cfg.office_location ?? null,
      // The same fallback the campaign path uses. A lead with a phone and no
      // name is ordinary, and "Hi there" is a sentence; "Hi {{customer_name}}"
      // is a bug the rep would have to spot and fix by hand every time.
      customerNameFallback: "there",
    }),
    shared: s.shared === true,
  }));

  return filled.filter((s) => {
    if (!/\{\{[^}]+\}\}/.test(s.body)) return true;
    console.error(
      `[snippets] not offering ${JSON.stringify(s.name)}: it still has a blank in it after `
      + "filling, so the gate would refuse it. Check the workspace has the value it wants."
    );
    return false;
  });
}
