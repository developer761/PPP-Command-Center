"use server";

/**
 * The repair queue, what a repair becomes, and the record of what was rated.
 *
 * A repair is CONSTRUCTED. It is built from a real transcript, so it looks
 * real, and nothing in the text would tell you the customer never received it.
 * Three things keep that honest and all are enforced rather than documented:
 * source='derived' for ever, derived_from pointing at the original, and
 * database triggers that refuse one created already approved and unsign one
 * whose text changes after it was signed.
 */
import { messagingDb } from "./db";
import { assertMessagingAccess } from "./auth";
import { applyRepairs, changedTurns, repairNote, turnsOf } from "./repair";
import { scrub, residualPii } from "./pii";

/** A rule a fix can be filed under: one of Kate's A-codes, or one of ours. */
export type RuleOption = {
  /** "code:A11" or "tag:flow_address". */
  id: string;
  kind: "code" | "tag";
  code: string | null;
  label: string;
  description: string;
  /** The bot rule it feeds. NULL for an A-code nobody has linked yet. */
  tagKey: string | null;
};

export type StoredFix = {
  turn: number;
  replacement: string;
  reason: string;
  ruleIds: string[];
};

export type RepairRecord = {
  id: string;
  approved: boolean;
  transcript: string;
  fixes: StoredFix[];
};

export type ImportedFinding = {
  id: string;
  turnOrdinal: number | null;
  code: string | null;
  severity: string | null;
  what: string;
  shouldHave: string | null;
};

export type RepairCandidate = {
  exampleId: string;
  transcript: string;
  conduct: string | null;
  findings: ImportedFinding[];
  repairs: RepairRecord[];
};

type Db = ReturnType<typeof messagingDb>;

/** Kate's codes first, since those are the names she files under. */
export async function ruleOptions(): Promise<RuleOption[]> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const [{ data: codes }, { data: tags }] = await Promise.all([
    sb.from("sms_audit_codes").select("code, name, description, tag_key").eq("is_active", true),
    sb.from("sms_training_tags").select("key, label, what_to_look_for").eq("is_active", true).order("sort_order"),
  ]);
  const byNumber = (c: string) => [c.replace(/\d+/g, ""), Number(c.replace(/\D+/g, "")) || 0] as const;
  return [
    ...(codes ?? [])
      .sort((a, b) => {
        const [pa, na] = byNumber(a.code); const [pb, nb] = byNumber(b.code);
        return pa.localeCompare(pb) || na - nb;
      })
      .map((c) => ({
        id: `code:${c.code}`, kind: "code" as const, code: c.code,
        label: c.name, description: c.description ?? "", tagKey: c.tag_key,
      })),
    ...(tags ?? []).map((t) => ({
      id: `tag:${t.key}`, kind: "tag" as const, code: null,
      label: t.label, description: t.what_to_look_for ?? "", tagKey: t.key,
    })),
  ];
}

/**
 * Add one of Kate's codes that is not on the list yet.
 *
 * Her sheet is the taxonomy and it grows. Left unlinked to a bot rule: which
 * of Emily's rules it belongs to is a decision, and a guessed link would file
 * her examples under the wrong rule while looking right.
 */
export async function addAuditCode(input: { code: string; name: string; description?: string }): Promise<
  { ok: true; option: RuleOption } | { ok: false; error: string }
> {
  await assertMessagingAccess();
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  if (!/^[A-Z]{1,3}\d{1,3}$/.test(code)) return { ok: false, error: "A code looks like A11: a letter and a number." };
  if (!name) return { ok: false, error: "Give it the name from your sheet." };
  const sb = messagingDb();
  const { data: existing } = await sb.from("sms_audit_codes").select("code").eq("code", code).maybeSingle();
  if (existing) return { ok: false, error: `${code} is already on the list. Search for it.` };
  const description = input.description?.trim() || "";
  const { error } = await sb.from("sms_audit_codes").insert({ code, name, description: description || null });
  if (error) return { ok: false, error: error.message };
  return { ok: true, option: { id: `code:${code}`, kind: "code", code, label: name, description, tagKey: null } };
}

/** Repairs of these conversations, each with the fixes it holds. */
async function repairsFor(sb: Db, originals: { id: string; transcript: string }[]): Promise<Map<string, RepairRecord[]>> {
  const ids = originals.map((o) => o.id);
  const out = new Map<string, RepairRecord[]>();
  if (!ids.length) return out;

  const { data: derived } = await sb.from("sms_training_examples")
    .select("id, derived_from, approved, transcript, conduct_note, created_at")
    .eq("source", "derived").in("derived_from", ids).order("created_at");
  const repairIds = (derived ?? []).map((d) => d.id);
  const [{ data: rows }, { data: tagRows }, { data: codeRows }] = repairIds.length
    ? await Promise.all([
        sb.from("sms_example_findings").select("repair_id, turn_ordinal, code, what, should_have").in("repair_id", repairIds),
        sb.from("sms_training_example_tags").select("example_id, tag_key").in("example_id", repairIds),
        sb.from("sms_audit_codes").select("code, tag_key"),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];
  const tagOfCode = new Map((codeRows ?? []).map((c) => [c.code as string, c.tag_key as string | null]));

  const originalText = new Map(originals.map((o) => [o.id, o.transcript]));
  for (const d of derived ?? []) {
    const mine = (rows ?? []).filter((r) => r.repair_id === d.id);
    let fixes: StoredFix[];
    if (mine.length) {
      const byTurn = new Map<number, StoredFix>();
      for (const r of mine) {
        const turn = r.turn_ordinal ?? 0;
        const f: StoredFix = byTurn.get(turn) ?? { turn, replacement: r.should_have ?? "", reason: r.what, ruleIds: [] };
        if (r.code) f.ruleIds.push(`code:${r.code}`);
        byTurn.set(turn, f);
      }
      fixes = [...byTurn.values()].sort((a, b) => a.turn - b.turn);
      // A rule picked directly, not through a code, is stored only as a tag on
      // the repair. Put those back on the first fix so reopening it does not
      // drop them; tags that a code already explains are left out.
      const codeTags = new Set(mine.map((r) => (r.code ? tagOfCode.get(r.code) : null)).filter(Boolean));
      const direct = (tagRows ?? []).filter((t) => t.example_id === d.id).map((t) => t.tag_key);
      if (fixes[0]) for (const k of direct) if (!codeTags.has(k)) fixes[0].ruleIds.push(`tag:${k}`);
    } else {
      // Saved before fixes were stored per turn. The transcript is the record.
      const legacyReason = /^Repaired: ([\s\S]*?) Was: "/.exec(d.conduct_note ?? "")?.[1]?.trim() ?? "";
      fixes = changedTurns(originalText.get(d.derived_from!) ?? "", d.transcript)
        .map((c) => ({ turn: c.turn, replacement: c.to, reason: legacyReason, ruleIds:
          (tagRows ?? []).filter((t) => t.example_id === d.id).map((t) => `tag:${t.tag_key}`) }));
    }
    const list = out.get(d.derived_from!) ?? [];
    list.push({ id: d.id, approved: d.approved, transcript: d.transcript, fixes });
    out.set(d.derived_from!, list);
  }
  return out;
}

async function candidatesFor(sb: Db, examples: { id: string; transcript: string; conduct: string | null }[]): Promise<RepairCandidate[]> {
  const ids = examples.map((e) => e.id);
  if (!ids.length) return [];
  const [{ data: findings }, repairs] = await Promise.all([
    sb.from("sms_example_findings")
      .select("id, example_id, turn_ordinal, code, severity, what, should_have")
      .in("example_id", ids).is("repair_id", null),
    repairsFor(sb, examples),
  ]);
  return examples.map((e) => ({
    exampleId: e.id, transcript: e.transcript, conduct: e.conduct,
    findings: (findings ?? []).filter((f) => f.example_id === e.id).map((f) => ({
      id: f.id, turnOrdinal: f.turn_ordinal, code: f.code,
      severity: f.severity, what: f.what, shouldHave: f.should_have,
    })),
    repairs: repairs.get(e.id) ?? [],
  }));
}

/**
 * Conversations worth repairing: graded mixed or bad.
 *
 * Unrepaired first, then mixed before bad. A near-miss needs a line or two
 * changed; a bad one may need rewriting whole, and a conversation rewritten
 * end to end is invention rather than repair.
 */
export async function repairQueue(limit = 25): Promise<RepairCandidate[]> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const { data: examples } = await sb.from("sms_training_examples")
    .select("id, transcript, conduct")
    .in("conduct", ["mixed", "bad"])
    .neq("source", "derived")
    .order("created_at");
  const all = await candidatesFor(sb, examples ?? []);
  return all
    .sort((a, b) =>
      a.repairs.length - b.repairs.length
      || (a.conduct === "mixed" ? 0 : 1) - (b.conduct === "mixed" ? 0 : 1)
      || b.findings.length - a.findings.length)
    .slice(0, limit);
}

/** One conversation, opened directly from the rated list. */
export async function repairCandidate(exampleId: string): Promise<RepairCandidate | null> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const { data } = await sb.from("sms_training_examples")
    .select("id, transcript, conduct").eq("id", exampleId).neq("source", "derived").maybeSingle();
  if (!data) return null;
  return (await candidatesFor(sb, [data]))[0] ?? null;
}

export type SaveRepair =
  | { ok: true; id: string; transcript: string; changed: { turn: number; from: string; to: string }[] }
  | { ok: false; error: string };

/**
 * Save every fix for one repair.
 *
 * The screen sends the COMPLETE set, not just what changed since last time,
 * and the fixes are always applied to the original conversation. Saving twice
 * gives the same repair, and reopening one to add T5 cannot stack a second
 * edit on top of the first.
 */
export async function saveRepair(input: {
  exampleId: string;
  /** Set when reopening an existing repair rather than starting one. */
  repairId?: string | null;
  fixes: { turn: number; replacement: string; reason: string; ruleIds: string[] }[];
}): Promise<SaveRepair> {
  const userId = await assertMessagingAccess();
  const sb = messagingDb();

  const { data: original } = await sb.from("sms_training_examples")
    .select("id, transcript").eq("id", input.exampleId).neq("source", "derived").maybeSingle();
  if (!original) return { ok: false, error: "That conversation no longer exists." };

  for (const f of input.fixes) {
    // A repair with no stated reason is a conversation somebody rewrote. The
    // reason is what makes it teach.
    if (!f.reason.trim()) return { ok: false, error: `Say what was wrong with T${f.turn}.` };
  }

  const applied = applyRepairs({
    transcript: original.transcript,
    fixes: input.fixes.map((f) => ({ turn: f.turn, replacement: f.replacement })),
  });
  if (!applied.ok) return { ok: false, error: applied.error };

  // Scrubbed again. Somebody writing a replacement will type a name or a
  // number without thinking, and the original being clean says nothing about
  // what was just added.
  const { text } = scrub(applied.transcript);
  const leftover = residualPii(text);
  if (leftover.length) {
    return { ok: false, error: `That still looks like real customer data (${leftover.join(", ")}). Use a made-up name or number.` };
  }

  const { data: codes } = await sb.from("sms_audit_codes").select("code, tag_key");
  const tagOfCode = new Map((codes ?? []).map((c) => [c.code, c.tag_key as string | null]));
  const codesOf = (ids: string[]) => ids.filter((r) => r.startsWith("code:")).map((r) => r.slice(5));
  const unknown = input.fixes.flatMap((f) => codesOf(f.ruleIds)).filter((c) => !tagOfCode.has(c));
  if (unknown.length) return { ok: false, error: `${unknown.join(", ")} is not on the rule list.` };

  const tagKeys = new Set<string>();
  for (const f of input.fixes) {
    for (const r of f.ruleIds) {
      if (r.startsWith("tag:")) tagKeys.add(r.slice(4));
      else { const t = tagOfCode.get(r.slice(5)); if (t) tagKeys.add(t); }
    }
  }

  const note = repairNote(applied.changed.map((c) => {
    const f = input.fixes.find((x) => x.turn === c.turn)!;
    return { turn: c.turn, what: f.reason, codes: codesOf(f.ruleIds), from: c.from, to: c.to };
  }));

  let repairId: string;
  if (input.repairId) {
    const { data: existing } = await sb.from("sms_training_examples")
      .select("id, derived_from").eq("id", input.repairId).eq("source", "derived").maybeSingle();
    if (!existing || existing.derived_from !== original.id) {
      return { ok: false, error: "That repair does not belong to this conversation." };
    }
    // The trigger unsigns it when the transcript changes: what was read is
    // no longer what it says.
    const { error } = await sb.from("sms_training_examples").update({
      transcript: text, conduct_note: note, graded_by: userId, graded_at: new Date().toISOString(),
    }).eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
    repairId = existing.id;
    await Promise.all([
      sb.from("sms_example_findings").delete().eq("repair_id", repairId),
      sb.from("sms_training_example_tags").delete().eq("example_id", repairId),
    ]);
  } else {
    const { data, error } = await sb.from("sms_training_examples").insert({
      source: "derived",
      derived_from: original.id,
      transcript: text,
      conduct: "good",
      conduct_note: note,
      pii_scrubbed: true,
      // NOT approved. The trigger refuses it anyway, and a repair nobody has
      // read is somebody's opinion about what good looks like.
      approved: false,
      graded_by: userId,
      graded_at: new Date().toISOString(),
    }).select("id").single();
    if (error) return { ok: false, error: error.message };
    repairId = data.id;
  }

  // One finding per fixed turn per code, in the shape Kate's imported findings
  // already use. A fix filed under no code still gets a row, so its turn and
  // reason are kept.
  const findingRows = applied.changed.flatMap((c) => {
    const f = input.fixes.find((x) => x.turn === c.turn)!;
    const cs = codesOf(f.ruleIds);
    return (cs.length ? cs : [null]).map((code) => ({
      example_id: original.id, repair_id: repairId, turn_ordinal: c.turn, code,
      kind: "fell_short", what: f.reason.trim(), should_have: c.to,
    }));
  });
  const { error: fErr } = await sb.from("sms_example_findings").insert(findingRows);
  if (fErr) return { ok: false, error: `The repair saved, but its per-turn record did not: ${fErr.message}` };

  if (tagKeys.size) {
    const { error: tErr } = await sb.from("sms_training_example_tags")
      .insert([...tagKeys].map((tag_key) => ({ example_id: repairId, tag_key })));
    if (tErr) return { ok: false, error: `The repair saved, but its rules did not: ${tErr.message}` };
  }

  return { ok: true, id: repairId, transcript: text, changed: applied.changed };
}

/**
 * Sign a repair off, which is what makes the bot able to copy it.
 *
 * Deliberately a separate act from writing it, so somebody reads the whole
 * repaired conversation rather than just the lines they changed.
 */
export async function approveRepair(input: { id: string; approve: boolean }): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const userId = await assertMessagingAccess();
  const sb = messagingDb();
  const { error } = await sb.from("sms_training_examples")
    .update({ approved: input.approve, graded_by: userId, graded_at: new Date().toISOString() })
    .eq("id", input.id).eq("source", "derived");
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export type RatedRow = {
  id: string;
  conduct: string | null;
  firstLine: string;
  turns: number;
  rules: number;
  ratedByPerson: boolean;
  gradedAt: string | null;
  repairs: { total: number; signed: number };
};

/**
 * Every real conversation, with what has been done to it.
 *
 * Kate: "How can I see the already rated conversations?" Grading one used to
 * remove it from the only screen that showed it.
 */
export async function ratedConversations(): Promise<RatedRow[]> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const [{ data: examples }, { data: tags }, { data: derived }] = await Promise.all([
    sb.from("sms_training_examples").select("id, transcript, conduct, graded_at, graded_by")
      .neq("source", "derived").order("graded_at", { ascending: false, nullsFirst: false }),
    sb.from("sms_training_example_tags").select("example_id"),
    sb.from("sms_training_examples").select("derived_from, approved").eq("source", "derived"),
  ]);
  const tagCount = new Map<string, number>();
  for (const t of tags ?? []) tagCount.set(t.example_id, (tagCount.get(t.example_id) ?? 0) + 1);

  return (examples ?? []).map((e) => {
    const mine = (derived ?? []).filter((d) => d.derived_from === e.id);
    const turns = turnsOf(e.transcript);
    const first = turns[0]?.text.split("\n")[0] ?? "";
    const rules = tagCount.get(e.id) ?? 0;
    return {
      id: e.id, conduct: e.conduct,
      firstLine: first.length > 110 ? first.slice(0, 107) + "…" : first,
      turns: turns.length, rules,
      // Imported rows arrive with a grade from Kate's sheet but no rules and
      // no reviewer. Picking rules, or repairing it, is what a person did here.
      ratedByPerson: rules > 0 || !!e.graded_by || mine.length > 0,
      gradedAt: e.graded_at,
      repairs: { total: mine.length, signed: mine.filter((d) => d.approved).length },
    };
  });
}

export type ConversationDetail = {
  id: string;
  conduct: string | null;
  note: string | null;
  transcript: string;
  ruleLabels: string[];
  findings: ImportedFinding[];
  repairs: RepairRecord[];
};

export async function ratedConversation(id: string): Promise<ConversationDetail | null> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const { data: e } = await sb.from("sms_training_examples")
    .select("id, transcript, conduct, conduct_note").eq("id", id).neq("source", "derived").maybeSingle();
  if (!e) return null;
  const [cands, { data: links }, { data: tags }] = await Promise.all([
    candidatesFor(sb, [e]),
    sb.from("sms_training_example_tags").select("tag_key").eq("example_id", id),
    sb.from("sms_training_tags").select("key, label"),
  ]);
  const label = new Map((tags ?? []).map((t) => [t.key, t.label]));
  return {
    id: e.id, conduct: e.conduct, note: e.conduct_note, transcript: e.transcript,
    ruleLabels: (links ?? []).map((l) => label.get(l.tag_key) ?? l.tag_key),
    findings: cands[0]?.findings ?? [],
    repairs: cands[0]?.repairs ?? [],
  };
}
