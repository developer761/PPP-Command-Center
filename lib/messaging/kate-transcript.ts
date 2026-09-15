/**
 * Kate's numbered transcript, the source of truth for order and attribution.
 *
 * Kate, 2026-09-15: "campaign msgs are being attributed to Emily/the bot. The
 * hub should copy my turn numbering + message attribution."
 *
 * The first import built transcripts from the JSON payload in her sheet. That
 * payload is Hatch's CHATBOT record, which (a) always starts with the
 * customer, because a model conversation has to, and (b) labels everything we
 * sent as the assistant, campaign messages included. So the campaign opener
 * came second and belonged to Emily, and every T-number after it was off.
 *
 * Her sheet also carries the conversation as it happened, next to the payload:
 *
 *   --- 2026-08-30 ---[1] 02:41 [SMS] CAMPAIGN: Hello, this is ...[2] 02:42
 *   [SMS] CUSTOMER: Have 11 lower office cabinets ...[3] 02:43 [SMS] AI
 *   (Emily): Got it. ...
 *   7 turns | 0 not delivered | 0 AI-composed-not-sent
 *
 * That is what this reads. Her [n] IS the turn number, and it is checked
 * against her own "N turns" count rather than trusted.
 *
 * Pure.
 */

export type KateTurn = {
  turn: number;
  at: string;
  channel: "SMS" | "EMAIL" | "CALL";
  /** Stored speaker label. Only Emily's lines are the bot's. */
  speaker: "Campaign" | "Customer" | "Emily" | "Human agent" | "Auto-reply";
  text: string;
};

export type ParseResult =
  | { ok: true; turns: KateTurn[] }
  | { ok: false; error: string };

const SPEAKERS: Record<string, KateTurn["speaker"]> = {
  "CAMPAIGN": "Campaign",
  "CUSTOMER": "Customer",
  "AI (Emily)": "Emily",
  "HUMAN AGENT": "Human agent",
  // Hatch's after-hours reply. Not Emily, and not a campaign step either.
  "AUTO-REPLY": "Auto-reply",
};

const ENTRY = /\[(\d+)\]\s*(\d{1,2}:\d{2})\s*\[(SMS|EMAIL|CALL)\]\s*(CAMPAIGN|CUSTOMER|HUMAN AGENT|AUTO-REPLY|AI \(Emily\)|[A-Z][A-Za-z ()-]*?):\s?/g;

/**
 * Parse one conversation from her sheet. `block` is the text from the first
 * entry up to and including her "N turns" footer.
 */
export function parseKateTranscript(block: string): ParseResult {
  const footer = /(\d+)\s+turns\s*\|/.exec(block);
  if (!footer) return { ok: false, error: "no \"N turns\" footer to check against" };
  const body = block.slice(0, footer.index);
  const expected = Number(footer[1]);

  const heads = [...body.matchAll(ENTRY)];
  const turns: KateTurn[] = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const label = SPEAKERS[h[4].trim()];
    if (!label) return { ok: false, error: `unknown speaker "${h[4]}" at [${h[1]}]` };
    const start = h.index! + h[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index! : body.length;
    const text = body.slice(start, end)
      // Day separators sit between messages, not inside them.
      .replace(/---\s*\d{4}-\d{2}-\d{2}\s*---/g, " ")
      // One message is one stored line. A wrap in the PDF is not a paragraph,
      // and a stray line that happened to start "Customer:" would become a
      // message nobody sent.
      .replace(/\s*\n\s*/g, " ")
      .trim();
    turns.push({
      turn: Number(h[1]), at: h[2], channel: h[3] as KateTurn["channel"],
      speaker: label, text,
    });
  }

  if (turns.length !== expected) {
    return { ok: false, error: `read ${turns.length} messages, her sheet says ${expected}` };
  }
  const gap = turns.findIndex((t, i) => t.turn !== i + 1);
  if (gap !== -1) return { ok: false, error: `numbering jumps at [${turns[gap].turn}]` };
  return { ok: true, turns };
}

/**
 * The stored form: one line per message, her speaker, channel marked when it
 * is not a text. turnsOf() in repair.ts reads this back with the same numbers.
 */
export function storedTranscript(turns: KateTurn[]): string {
  return turns
    .map((t) => `${t.speaker}: ${t.channel === "SMS" ? "" : `[${t.channel === "EMAIL" ? "Email" : "Call"}] `}${t.text}`)
    .join("\n");
}
