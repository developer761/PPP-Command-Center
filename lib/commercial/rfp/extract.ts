import "server-only";

/**
 * RFP email → structured opportunity fields, via Claude (Karan 2026-08-14).
 *
 * A GC's "invitation to bid" arrives as free-text email — no two the same. Rather
 * than brittle regex, Claude reads it and pulls the fields the New Opportunity
 * form needs. Human-review-before-create: this only EXTRACTS; the UI pre-fills an
 * editable form and the person confirms. Nothing is auto-created.
 *
 * Direct fetch to the Messages API (no SDK dependency — mirrors lib/email/resend).
 * Tool-use forces a typed JSON result, so we never parse loose prose. Fails
 * SOFTLY (returns {ok:false}) so a missing key or API hiccup shows a banner, not
 * a crash — the person can always fill the form by hand.
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
// Capable default for messy real-world RFPs; overridable without a deploy.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

export type RfpExtract = {
  /** Project / job name — the New Opportunity title. */
  title: string | null;
  /** The general contractor / firm that sent the invitation to bid. */
  gcCompany: string | null;
  propertyStreet: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  /** Bid/proposal due date as YYYY-MM-DD, or null if none stated. */
  bidDueDate: string | null;
  /** One or two sentences of the painting scope, if described. */
  scope: string | null;
  /** Estimated contract value in DOLLARS if the RFP states one (rare). */
  estimatedValueDollars: number | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
};

export type RfpExtractResult =
  | { ok: true; extract: RfpExtract }
  | { ok: false; error: string };

const EXTRACT_TOOL = {
  name: "record_rfp_fields",
  description:
    "Record the fields extracted from a general contractor's invitation-to-bid / RFP email so a painting estimator can open an opportunity. Use null for anything not clearly stated — never guess.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: ["string", "null"], description: "The project or job name (e.g. 'Panera Bread — Holbrook interior repaint'). Null if unclear." },
      gcCompany: { type: ["string", "null"], description: "The general contractor / company inviting the bid (the sender's firm), NOT the property owner." },
      propertyStreet: { type: ["string", "null"], description: "Job site street address." },
      propertyCity: { type: ["string", "null"] },
      propertyState: { type: ["string", "null"], description: "2-letter state code if determinable." },
      propertyZip: { type: ["string", "null"] },
      bidDueDate: { type: ["string", "null"], description: "Bid/proposal due date as strict YYYY-MM-DD. Resolve relative dates only if an absolute date is stated. Null otherwise." },
      scope: { type: ["string", "null"], description: "One or two sentences summarizing the painting scope of work, if described." },
      estimatedValueDollars: { type: ["number", "null"], description: "Estimated contract value in whole dollars, ONLY if the RFP explicitly states a budget/value. Usually null." },
      contactName: { type: ["string", "null"], description: "Name of the person to contact / who sent it." },
      contactEmail: { type: ["string", "null"] },
      contactPhone: { type: ["string", "null"] },
    },
    required: [
      "title", "gcCompany", "propertyStreet", "propertyCity", "propertyState",
      "propertyZip", "bidDueDate", "scope", "estimatedValueDollars",
      "contactName", "contactEmail", "contactPhone",
    ],
  },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clean(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export async function extractRfp(rawText: string): Promise<RfpExtractResult> {
  const text = (rawText ?? "").trim();
  if (text.length < 20) return { ok: false, error: "Paste the RFP email text first (it looks empty)." };
  if (text.length > 60_000) return { ok: false, error: "That's very long — trim it to the RFP email itself and try again." };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error:
        process.env.NODE_ENV === "production"
          ? "AI extraction isn't configured yet (ANTHROPIC_API_KEY). Fill the form in by hand for now."
          : "ANTHROPIC_API_KEY not set — cannot extract.",
    };
  }

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: "tool", name: EXTRACT_TOOL.name },
        system:
          "You extract bid-invitation fields for a commercial painting contractor. Only record what the email actually states; use null for anything absent. Never invent a company, address, date, or value.",
        messages: [{ role: "user", content: `Extract the fields from this invitation-to-bid / RFP email:\n\n${text}` }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Couldn't reach the AI service (${msg}). Try again or fill the form by hand.` };
  }

  const bodyText = await res.text();
  if (!res.ok) {
    console.error(`[rfp/extract] Anthropic ${res.status}: ${bodyText.slice(0, 500)}`);
    return { ok: false, error: `The AI service returned an error (${res.status}). Try again or fill the form by hand.` };
  }

  let parsed: { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: "The AI response couldn't be read. Try again or fill the form by hand." };
  }

  const toolBlock = parsed.content?.find((b) => b.type === "tool_use" && b.name === EXTRACT_TOOL.name);
  const raw = toolBlock?.input;
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "The AI didn't return the fields. Try again or fill the form by hand." };
  }

  const dueRaw = clean(raw.bidDueDate, 10);
  const valNum = typeof raw.estimatedValueDollars === "number" && Number.isFinite(raw.estimatedValueDollars) && raw.estimatedValueDollars > 0
    ? Math.round(raw.estimatedValueDollars)
    : null;

  return {
    ok: true,
    extract: {
      title: clean(raw.title, 200),
      gcCompany: clean(raw.gcCompany, 200),
      propertyStreet: clean(raw.propertyStreet, 200),
      propertyCity: clean(raw.propertyCity, 100),
      propertyState: clean(raw.propertyState, 20),
      propertyZip: clean(raw.propertyZip, 20),
      bidDueDate: dueRaw && DATE_RE.test(dueRaw) ? dueRaw : null,
      scope: clean(raw.scope, 2000),
      estimatedValueDollars: valNum,
      contactName: clean(raw.contactName, 200),
      contactEmail: clean(raw.contactEmail, 200),
      contactPhone: clean(raw.contactPhone, 60),
    },
  };
}
