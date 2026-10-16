import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { languageOf, conversationLanguage } from "@/lib/messaging/language";
import { renderMessage, SILENT_INTENTS } from "@/lib/messaging/render";
import { SAYS_ES } from "@/lib/messaging/render-es";
import { tooManyAsks } from "@/lib/messaging/one-ask";
import { END_INTENTS, CONTINUE_INTENTS, type Intent } from "@/lib/messaging/agent-output";
import { stripComments } from "../helpers/strip-comments";

const ALL: Intent[] = [...END_INTENTS, ...CONTINUE_INTENTS];

/**
 * A30 — "Reply in the customer's language." Live and critical, and the rule
 * card calls the old behaviour what it was: "Guard B12 (other languages ->
 * End: Transferred) is the splint over it."
 *
 * The bug that started this, seen in the simulator: a customer wrote "Hola,
 * necesito pintar mi casa por dentro. No hablo ingles" and got back "Hola!
 * Con gusto le ayudo. What are you looking to have painted?" — the greeting
 * in one language and the question in the other.
 */
describe("A30 — detecting the customer's language", () => {
  it("reads Spanish, including from two words", () => {
    for (const t of [
      "Hola, necesito pintar mi casa por dentro",
      // The corpus trigger named in the rule card.
      "Sábado 9:30 am",
      "Hola",
      "¿Cuánto cuesta?",
      "Buenos dias, quiero un presupuesto",
      "No hablo ingles",
      "Mi direccion es 12 Oak St",
    ]) {
      expect(languageOf(t), t).toBe("es");
    }
  });

  /**
   * THE EXPENSIVE DIRECTION. Answering a fluent English speaker in Spanish is
   * worse than the handover this replaces, so a Spanish word inside an
   * English sentence must not decide it.
   *
   * "exterior and interior painting please" was read as Spanish, because both
   * words are spelled the same in both languages and the first version
   * counted them.
   */
  it("does not turn an English message Spanish on one word", () => {
    for (const t of [
      "Hi, looking for a quote on my kitchen",
      "ok", "yes that works", "11530",
      "I need my living room and hallway painted, about 600 sq ft",
      "exterior and interior painting please",
      "my name is Jose Rodriguez",
      "La Casa Blanca restaurant on Main St",
      "Hi there, hola is all the Spanish I know but I need an estimate for my house",
    ]) {
      expect(languageOf(t), t).toBe(null);
    }
  });

  /** "Do not switch back to English on the next turn." */
  it("keeps the language once the customer has set it", () => {
    expect(conversationLanguage(["Hola, necesito pintar mi casa", "ok"])).toBe("es");
    expect(conversationLanguage(["Hi", "necesito pintar la cocina"])).toBe("es");
    expect(conversationLanguage(["Hi", "yes", "ok"])).toBe("en");
  });
});

describe("A30 — the Spanish templates", () => {
  const known = {
    address: "12 Oak St, Garden City, NY 11530", phone: "999-784-6046",
    email: "tom@example.com", scope: "pintar la cocina", zip: "11530", state: "Florida",
  };

  /** A new intent with no Spanish words is an empty text to a customer. */
  it("has words for every intent that speaks", () => {
    for (const intent of ALL) {
      if (SILENT_INTENTS.has(intent)) continue;
      if (intent === "answer_question") continue; // the rapport IS the answer
      if (intent === "discard") continue; // covered in render.test.ts, needs a scope
      const out = renderMessage({
        intent, known, language: "es",
        offsiteReason: "no puede estar en la propiedad",
      });
      expect(out.length, intent).toBeGreaterThan(0);
    }
  });

  /**
   * The same safety property as the English table. The model cannot put a
   * price or a time into an outgoing message because it does not write them —
   * so the only way one appears is if somebody typed it here.
   */
  it("quotes no price and offers no specific time", () => {
    for (const intent of ALL) {
      for (const turn of [0, 1, 2]) {
        const out = renderMessage({ intent, turn, known, language: "es" });
        expect(out, `${intent}/${turn}`).not.toMatch(/\$|\b\d+\s*(?:dolares|usd)\b/i);
        expect(out, `${intent}/${turn}`).not.toMatch(/\b\d{1,2}\s*(?:am|pm)\b/i);
        expect(out, `${intent}/${turn}`).not.toMatch(/\b(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i);
      }
    }
  });

  /** A22 binds in Spanish too. */
  it("asks for one thing at a time", () => {
    for (const intent of ALL) {
      if (SILENT_INTENTS.has(intent)) continue;
      for (const turn of [0, 1, 2]) {
        const out = renderMessage({
          intent, turn, known, language: "es",
          offsiteReason: "no puede estar en la propiedad",
        });
        if (!out) continue;
        expect(tooManyAsks(out), `${intent}/${turn}: ${out}`).toBeNull();
      }
    }
  });

  /** A23 binds in Spanish too: no em dash, no ellipsis. */
  it("sounds like the house", () => {
    for (const list of Object.values(SAYS_ES)) {
      for (const t of list) {
        expect(t, t).not.toMatch(/[—–]/);
        expect(t, t).not.toMatch(/\.\.\.|…/);
      }
    }
  });

  /** Every slot the English table fills, spelled the same way. */
  it("uses the same slot names, so the same filler works", () => {
    const slots = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort().join(",");
    for (const intent of ["confirm_address", "confirm_contact", "confirm_scope", "area_not_serviced", "offer_offsite_quote"] as const) {
      const en = renderMessage({ intent, turn: 0, known, offsiteReason: "x" });
      const es = renderMessage({ intent, turn: 0, known, offsiteReason: "x", language: "es" });
      // Both rendered something, and neither left a slot unfilled.
      expect(en.length, intent).toBeGreaterThan(0);
      expect(es.length, intent).toBeGreaterThan(0);
      expect(slots(es), intent).toBe("");
      expect(slots(en), intent).toBe("");
    }
  });

  /** And the whole point: one language per message, never half of each. */
  it("does not mix English into a Spanish message", () => {
    const englishGiveaways = /\b(?:what|would|your|the|and|please|thanks|project|address|email)\b/i;
    for (const intent of ALL) {
      if (SILENT_INTENTS.has(intent)) continue;
      for (const turn of [0, 1, 2]) {
        const out = renderMessage({
          intent, turn, known, language: "es",
          offsiteReason: "no puede estar en la propiedad",
        });
        if (!out) continue;
        // The address slot carries a real US address, so strip the filled
        // values before reading the sentence around them.
        const sentence = out.replace(known.address, "").replace(known.email, "");
        expect(sentence, `${intent}/${turn}: ${out}`).not.toMatch(englishGiveaways);
      }
    }
  });
});

/**
 * ── NO INVERTED PUNCTUATION IN ANYTHING WE SEND ─────────────────────────
 *
 * Kate, 2026-09-28, relaying Mac and Jasmine on the A46 Spanish strings:
 *
 *   "the bot should not use the proper ¿ punctuation. This was a ruling we
 *    used in Hatch that I didn't add to the new rules for the bot: 'use
 *    informal, casual vocabulary, relaxed grammar and punctuation, no
 *    inverted punctuation, in the language used'... they essentially said
 *    using that would be a flag that they're not talking to a spanish
 *    speaking individual."
 *
 * So it is not a typographic preference — correct inverted punctuation reads
 * as machine translation to the people who would receive it, which is the one
 * impression this whole programme is trying not to give.
 *
 * ── AND THE HALF THAT MUST NOT CHANGE ───────────────────────────────────
 *
 * ¿ and ¡ still have two jobs on the way IN, and both are untouched:
 *
 *   language.ts   SPANISH_LETTERS uses them to DETECT Spanish. A customer
 *                 writing "¿Cuánto cuesta?" is how we know to answer in
 *                 Spanish at all.
 *   first-message.ts  the GSM charset allowlist, which decides whether a
 *                 message costs one segment or three.
 *
 * Stripping either would be a real bug wearing this change's clothes, so the
 * test asserts they are still there.
 */
describe("Spanish goes out without inverted punctuation", () => {
  /**
   * ── EVERY MESSAGING FILE, NOT A LIST OF SIX ─────────────────────────────
   *
   * This was a hand-written list of the files known to hold Spanish copy,
   * which means a new template file was unguarded until somebody remembered
   * to add it — and the whole point of a guard is to cover the case nobody
   * remembered. So the directory is the subject now, and a file that needs
   * the characters has to say why here.
   *
   * Same polarity as check:writers: covered by default, exempt only with a
   * reason, and the reason is checked against reality below.
   */
  const MESSAGING = readdirSync("lib/messaging", { recursive: true })
    .filter((f): f is string => typeof f === "string" && /\.tsx?$/.test(f))
    .map((f) => `lib/messaging/${f}`)
    .sort();

  /**
   * A file may contain the characters only to MATCH or to NAME them — never to
   * send them. Both exemptions below are that, and both are narrow.
   */
  const ALLOWED = new Map([
    [
      "lib/messaging/agent-run.ts",
      "the prompt states the rule TO the model, and a prohibition cannot be "
      + "written without naming the character it forbids. Sent to the model, "
      + "never to a customer.",
    ],
  ]);

  const OUTBOUND = MESSAGING.filter((f) => !ALLOWED.has(f));

  it("guards every messaging file, and the list is not empty", () => {
    // A glob that silently matches nothing is a green suite over no checking.
    expect(OUTBOUND.length).toBeGreaterThan(20);
    expect(OUTBOUND).toContain("lib/messaging/render-es.ts");
    expect(OUTBOUND).toContain("lib/messaging/render.ts");
    expect(OUTBOUND).toContain("lib/messaging/disclosure.ts");
  });

  it.each([...ALLOWED.keys()])("exemption for %s is still a real file", (path) => {
    // An exemption outliving its file is an exemption nobody is reading.
    expect(MESSAGING).toContain(path);
  });

  /**
   * ── WHY THIS READS THE SYNTAX TREE AND NOT THE LINES ────────────────────
   *
   * This check used to be `/[¿¡]/.test(line)` over the raw source, and a real
   * ¡ reached customers through it. render.ts had:
   *
   *     "¡Gracias por la foto!"
   *
   * Six ASCII characters on the line, one inverted mark in the message. The
   * grep saw the spelling; the customer saw the character.
   *
   * The escape was not sneaked in — disclosure.ts introduced it deliberately
   * and explained itself: there the marks sit inside a regex that STRIPS what
   * a customer typed, and "the escape says the same thing to the regex engine
   * and nothing to the reader of our outbound copy." That is true and still
   * allowed. What happened next is the ordinary way a workaround spreads: the
   * same spelling got reused in a place that emits rather than matches, where
   * the reasoning does not hold.
   *
   * So the question is not how the character is spelled, it is whether it can
   * be SENT. Strings can be sent; regexes only ever inspect. TypeScript's own
   * parser decodes escapes and gives those two different node kinds, so
   * asking it is both exact about the former and free of a hand-maintained
   * exemption list for the latter — and \xa1, \u{a1}, a literal ¡ and a
   * concatenated fragment all answer the same way, because by the time the
   * value is on the node, the spelling is gone.
   */
  it.each(OUTBOUND)("has none in any string that can be sent from %s", (path) => {
    const src = stripComments(readFileSync(path, "utf8"));
    const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true);
    const hits: string[] = [];

    const visit = (node: ts.Node): void => {
      // The decoded value — "¡Gracias" and "¡Gracias" are both "¡Gracias" here.
      if (
        ts.isStringLiteral(node)
        || ts.isNoSubstitutionTemplateLiteral(node)
        || ts.isTemplateHead(node)
        || ts.isTemplateMiddle(node)
        || ts.isTemplateTail(node)
      ) {
        if (/[¿¡]/.test(node.text)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          hits.push(`${path}:${line + 1} ${JSON.stringify(node.text).slice(0, 72)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    expect(hits).toEqual([]);
  });

  /**
   * The guard above is the one that matters, so it gets a test of its own:
   * a check nobody has watched fail is a check nobody knows the polarity of.
   * Both spellings must be caught, and the regex in disclosure.ts must not be.
   */
  it("catches an escaped mark in outbound copy and spares one in a matcher", () => {
    const find = (src: string) => {
      const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true);
      const found: string[] = [];
      const visit = (n: ts.Node): void => {
        if (ts.isStringLiteral(n) && /[¿¡]/.test(n.text)) found.push(n.text);
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return found;
    };

    // The character itself, and the three ways to spell it that a grep misses.
    expect(find('const a = "¡Gracias!";')).toEqual(["¡Gracias!"]);
    expect(find('const a = "\\u00a1Gracias!";')).toEqual(["¡Gracias!"]);
    expect(find('const a = "\\xa1Gracias!";')).toEqual(["¡Gracias!"]);
    expect(find('const a = "\\u{a1}Gracias!";')).toEqual(["¡Gracias!"]);

    // disclosure.ts's actual line: a matcher, not copy. Must stay legal.
    expect(find("const g = /^[\\s\\u00a1\\u00bf]*(?:hola|hi)\\b/i;")).toEqual([]);

    // And a comment explaining the rule is not a breach of it.
    expect(find('// never write ¡ or ¿ in outbound copy\nconst a = "Gracias!";')).toEqual([]);
  });

  it("still detects Spanish written WITH inverted punctuation", () => {
    // The customer may use it; we simply do not. Dropping this would stop us
    // recognising a Spanish speaker at all.
    expect(conversationLanguage(["¿Cuánto cuesta pintar mi sala?"])).toBe("es");
    expect(conversationLanguage(["¡Hola! Necesito pintar."])).toBe("es");
  });

  it("keeps the GSM charset allowlist intact", () => {
    // Not a sentence — the set of characters that fit one SMS segment.
    expect(stripComments(readFileSync("lib/messaging/first-message.ts", "utf8"))).toContain("¿");
  });
});
