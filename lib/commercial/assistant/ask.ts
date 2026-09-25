import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { placesForPrompt } from "./places";
import { findRecords, jobSummary, moneyOverview, vendorSpend, crewHours, openBids, arSheet } from "./tools";

/**
 * The assistant: someone who has used this platform for years and does not mind
 * being asked the same thing twice.
 *
 * Karan's brief: "if a person was on the platform and knows it like the back of
 * their hand and could answer any question about it, it should be like that."
 *
 * Two jobs, and they need different things:
 *   WHERE DO I… — answered from `places`, which is in the prompt because it is
 *     small and needed almost every time.
 *   WHAT IS… — answered from the tools, which read the database. The model is
 *     told, plainly, that it may only state figures a tool returned. A number it
 *     worked out itself looks identical on screen to one the database gave it,
 *     and only one of them is safe to act on.
 *
 * Read only. It never records, sends or changes anything — every action here
 * has a form with its own checks behind it.
 */

const MODEL = "claude-opus-5";

export type AskResult = { ok: true; answer: string } | { ok: false; error: string };

export function assistantAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * WHICH TOOLS READ MONEY.
 *
 * The assistant answers in prose, from the same database the pages read — so
 * it is a second door onto every screen, and it has to carry the same locks.
 * These five return what `requireFinanceViewer` guards: the whole book's
 * outstanding and past due, the AR sheet Mary sends Alex, the purchase
 * register, and a job's billed/collected/cost-by-category.
 *
 * Its own docblock said it was "behind the same access check as every
 * commercial page… it can read the company's money, so it is not open to
 * anyone with the URL" — but the check it made was `assertCommercialAccess`,
 * which is the check for using the platform at all, and every sales rep passes
 * it. A rep could not open Accounting and could ask the assistant what was on
 * it. A wrong gate is worse than a missing one: the comment above it reads as
 * a decision that was made.
 *
 * `open_bids` and `crew_hours` stay open — bid values are on the rep's own
 * pipeline, and hours are not pay. `find_records` stays open and drops the
 * invoice totals instead, so it can still tell you a document exists.
 */
const MONEY_TOOLS = new Set(["job_summary", "money_overview", "vendor_spend", "ar_sheet"]);

const TOOLS: Anthropic.Tool[] = [
  {
    name: "find_records",
    description:
      "Find jobs, GCs or invoices whose name contains the text. Use this first whenever somebody names something, so the answer carries a real link.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Part of a job name, GC name or invoice number." } },
      required: ["query"],
    },
  },
  {
    name: "job_summary",
    description:
      "The money on ONE job: contract, billed, collected, outstanding and cost by category. Use for any question about a single job's numbers.",
    input_schema: {
      type: "object",
      properties: { job: { type: "string", description: "Enough of the job name to identify it." } },
      required: ["job"],
    },
  },
  {
    name: "money_overview",
    description:
      "The whole book: outstanding, past due, collected all time, and total costs by category. Use for 'how much are we owed' style questions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "vendor_spend",
    description: "What has been bought and from whom. Pass a vendor name to scope it to one supplier.",
    input_schema: {
      type: "object",
      properties: { vendor: { type: "string", description: "Optional. Part of a vendor name." } },
    },
  },
  {
    name: "open_bids",
    description: "Every bid that is out — how many, what they are worth, and the biggest ones. Use for pipeline questions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "ar_sheet",
    description:
      "The AR sheet: what has been certified and is waiting to be paid, retention separately. Use for 'what are we chasing' questions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "crew_hours",
    description: "Hours recorded on site, totalled per crew. Hours only — crew COST lives on each job's Subcontract lines.",
    input_schema: { type: "object", properties: {} },
  },
];

async function runTool(
  name: string,
  input: Record<string, unknown>,
  canSeeMoney: boolean
): Promise<string> {
  // Belt as well as braces: the money tools are withheld from the tool LIST
  // for a non-finance viewer, so the model cannot ask for one. This refuses it
  // anyway, because a filtered list is a prompt-level control and the data is
  // not.
  if (!canSeeMoney && MONEY_TOOLS.has(name)) {
    return "That figure is on a page this person cannot open. Do not state it. Say it is in Accounting, which is limited to the admin and accounting logins.";
  }
  switch (name) {
    case "find_records":
      return findRecords(String(input.query ?? ""), canSeeMoney);
    case "job_summary":
      return jobSummary(String(input.job ?? ""));
    case "money_overview":
      return moneyOverview();
    case "vendor_spend":
      return vendorSpend(input.vendor ? String(input.vendor) : undefined);
    case "open_bids":
      return openBids();
    case "ar_sheet":
      return arSheet();
    case "crew_hours":
      return crewHours();
    default:
      return `No such lookup: ${name}.`;
  }
}

function systemPrompt(canSeeMoney: boolean): string {
  const moneyRule = canSeeMoney
    ? ""
    : `

WHAT THIS PERSON MAY NOT SEE
This person is not on the accounting side. They cannot open Accounting, and you have no lookup for company money — no outstanding balance, no past due, no AR sheet, no purchase spend, and no job's billed / collected / cost. Do not state any such figure, do not estimate one, and do not repeat one from earlier in this conversation.

Say so plainly and move on: "That's in Accounting, which is limited to the admin and accounting logins — Mary or Katie can pull it." Then answer whatever else they asked. Bid values on their own pipeline, hours on site, where a page is, and how something works are all fine.`;
  return `You are the assistant inside Precision Painting Plus's Commercial Command Center — the platform Tomco Painting run their commercial jobs on. You know it the way somebody does who has used it every day for years.

Who asks you things: Alex (owner), Brendan (operations), Katie (admin), Mary (accounting), Stephanie, and the field team. They are busy and on their phones as often as not.

WHERE THINGS ARE — every page, and what people come to it to do:
${placesForPrompt()}

HOW TO ANSWER

"Where do I…" — name the page and give its path as a markdown link, e.g. [Accounting → Receivables](/commercial/accounting?view=receivables). Say in one line what to do when they get there. If there are two reasonable places, give the better one first and mention the other.

"What is / how much…" — call a tool and answer from what it returns.

NEVER state a figure a tool did not give you. Not an estimate, not a total you worked out from two other numbers, not a figure from earlier in the conversation that might have moved. If you do not have it, say so and point at the page that does. A number you invented is indistinguishable on screen from one the database gave you, and somebody will act on it.

Things worth knowing about this business, so you do not give a confusing answer:
- Crews are subcontractors, paid through labor companies. Their HOURS are recorded (Attendance) and their COST sits on each job as a Subcontract line. The two are never added together — that would charge every job twice.
- Retention is held until close-out. It is not late and must never be described as overdue.
- Tomco are still using Salesforce for a couple of weeks while they move over, so figures can move during the day.
- "Subcontract labor" is what Tomco use for paying crews. "Subcontractor" exists but they have never used it.

STYLE
Short. Two or three sentences usually does it. Plain words — you are talking to painters and bookkeepers, not developers. No preamble ("Great question!"), no restating what they asked. If something is genuinely uncertain, say which part and what you would check.${moneyRule}`;
}

export async function askAssistant(
  question: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
  /**
   * Whether this viewer may see company money — admin or account manager, the
   * same predicate the Accounting page enforces. Defaults to FALSE so a caller
   * that forgets to pass it gets the safe answer; the route computes it from
   * the signed-in profile.
   */
  canSeeMoney = false
): Promise<AskResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "No Anthropic API key is configured on this environment." };
  const q = question.trim();
  if (!q) return { ok: false, error: "Ask me something." };

  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [
    // Only the last few turns: this is a question desk, not a long conversation,
    // and a growing transcript is the easiest way to make every answer slower.
    ...history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: q },
  ];

  try {
    // Tool loop, bounded. Four passes is enough for "find the job, then get its
    // money"; a model that wants more than that is going round in circles, and
    // an unbounded loop on somebody's question is a bill with no ceiling.
    for (let turn = 0; turn < 4; turn++) {
      const res: Anthropic.Message = await client.messages.create({
        model: MODEL,
        max_tokens: 2_000,
        output_config: { effort: "low" },
        system: systemPrompt(canSeeMoney),
        tools: canSeeMoney ? TOOLS : TOOLS.filter((t) => !MONEY_TOOLS.has(t.name)),
        messages,
      });

      const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        const text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
        if (text) return { ok: true, answer: text };
        return {
          ok: false,
          error: `No answer came back (stop reason: ${res.stop_reason ?? "unknown"}).`,
        };
      }

      messages.push({ role: "assistant", content: res.content });
      messages.push({
        role: "user",
        content: await Promise.all(
          toolUses.map(async (t) => ({
            type: "tool_result" as const,
            tool_use_id: t.id,
            content: await runTool(t.name, (t.input ?? {}) as Record<string, unknown>, canSeeMoney),
          }))
        ),
      });
    }
    return { ok: false, error: "That took too many lookups to answer — try asking it more narrowly." };
  } catch (err) {
    console.error("[assistant] failed:", err);
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Couldn't answer: ${reason}` };
  }
}
