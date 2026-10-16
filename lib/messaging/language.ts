/**
 * What language is this customer writing in?
 *
 * A30 is live and critical: "Reply in the customer's language." Its card is
 * blunt about the old behaviour — "Guard B12 (other languages -> End:
 * Transferred) is the splint over it" — so handing a Spanish speaker to the
 * office was never the intended answer, it was what we did instead of one.
 *
 * "THE SIGNAL CAN BE TWO WORDS. The trigger in the corpus is a customer
 * opening with 'Sábado 9:30 am' — a day and a time, no sentence. That is
 * enough: match the language they wrote in and KEEP MATCHING IT. Do not wait
 * for a full sentence, and do not switch back to English on the next turn."
 *
 * Spanish only, deliberately. PPP's markets are NY, NJ and South Florida, and
 * a language we cannot actually write is worse than one we hand over: a
 * half-translated message is how you lose someone who was going to book.
 * Everything else still routes to a person, which is what B12 was for.
 */
import { normalizeInbound } from "./inbound-normalize";

export type Language = "en" | "es";

/**
 * Characters that are Spanish on sight — ñ, ¿ and ¡.
 *
 * ── ONE LETTER USED TO DECIDE THE WHOLE CONVERSATION, 2026-10-16 ────────
 *
 * This said "one of these is enough on its own", included every accented
 * vowel and ü, and was tested BEFORE anything looked for English around it.
 * The audit against Kate's corpus found English customers answered in
 * Spanish for the rest of their thread on the strength of "fiancé", "ü600",
 * "ü1800sf" (a phone's autocorrect for ~), "Can you give me an estímate?"
 * and an iPhone tapback from a Spanish-locale phone. The comment's own
 * premise — "an accented vowel is somebody writing Spanish, not somebody
 * writing café" — is what the corpus disproved.
 *
 * So the letters now count as EVIDENCE, weighed with the words, and English
 * words around them win. ñ ¿ ¡ count as one strong signal, since no English
 * word carries them outside a name; an accented vowel counts as one weak
 * one; ü counts for nothing, because the only place it appears in the
 * corpus is in front of a number.
 */
const SPANISH_LETTERS = /[ñÑ¿¡]/;
const ACCENTED_VOWEL = /[áéíóúÁÉÍÓÚ]/;

const words = (list: string[]) => new RegExp("\\b(?:" + list.join("|") + ")\\b", "gi");

/**
 * Spanish and NOT English. One of these is enough.
 *
 * EXTERIOR AND INTERIOR ARE NOT HERE, and they were. They are spelled
 * identically in both languages, so "exterior and interior painting please"
 * counted two Spanish words and answered an English speaker in Spanish —
 * which is a worse outcome than the handover this whole feature replaces.
 */
const STRONG = words([
  // greetings and courtesy
  "hola", "gracias", "buenos", "buenas", "dias", "tardes", "noches", "favor",
  "disculpe", "perdon", "saludos",
  // the ask
  "necesito", "necesitamos", "quiero", "queremos", "quisiera", "quisieramos",
  "busco", "puede", "pueden", "podria", "podrian", "tengo", "tenemos",
  "estoy", "estamos", "somos", "hacer",
  // the work
  "pintar", "pintura", "pintado", "pintor", "presupuesto", "cotizacion",
  "cuanto", "cuesta", "trabajo", "casa", "apartamento", "cocina",
  "bano", "banos", "habitacion", "habitaciones", "cuarto", "cuartos",
  "pared", "paredes", "techo", "techos", "puerta", "puertas", "ventana",
  "ventanas", "gabinetes", "adentro", "afuera",
  // arranging it
  "cita", "disponible", "disponibilidad", "manana", "semana",
  "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo",
  "direccion", "telefono", "correo", "llamar", "llame", "llamen",
  // unambiguous glue
  "porque", "tambien", "donde", "cuando", "usted", "ustedes", "nosotros",
  "gustaria", "hablo", "habla", "espanol", "ingles",
]);

/**
 * Spanish, but short or close enough to English that one proves nothing.
 * Two of these together do.
 */
const WEAK = words([
  "para", "pero", "muy", "mucho", "esta", "estan", "hoy", "precio",
  "mi", "es", "un", "una", "el", "la", "los", "las", "de", "que", "en",
  "por", "con", "sin", "seria", "son", "muchas",
  // "Sí" and "está bien" lost their accent as evidence on their own, so the
  // words carry a share of it: "si" with its accent is two weak signals and
  // decides a message nothing English competes with; bare "si" is one.
  "si", "bien",
]);

/**
 * English function words, used only to say "something else is competing".
 *
 * Not to detect English — to stop ONE Spanish word deciding a sentence that
 * is plainly English around it.
 */
const ENGLISH = words([
  "the", "and", "is", "are", "was", "were", "my", "your", "our", "their",
  "i", "we", "you", "he", "she", "it", "they", "need", "needs", "want",
  "have", "has", "had", "with", "for", "this", "that", "these", "those",
  "can", "could", "would", "should", "will", "just", "about", "from",
  "please", "thanks", "thank", "know", "all", "but", "not", "yes",
  "looking", "there", "here", "what", "when", "where", "how", "on", "at",
  "of", "to", "in", "an", "be", "do", "does", "did", "get", "got",
  // "no" and "a" WERE HERE and are Spanish words too. Harmless while an
  // accent decided a message on its own; once it stopped doing so, "No,
  // gracias, está bien" had an English word competing and read as nothing.
]);

/** Accents stripped, so "habitación" and "habitacion" count the same. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * The language of ONE message, or null when it does not say.
 *
 * Null is the common and correct answer: "ok", "yes", "11530" and a photo
 * with no caption are not evidence of anything, and guessing from them is how
 * a conversation flips language halfway through.
 */
export function languageOf(text: string | null | undefined): Language | null {
  return readMessage(text).language;
}

/**
 * One message's verdict, and how much weight it can bear.
 *
 * `decisive` is two unambiguous Spanish signals — enough to hold the
 * conversation in Spanish whatever follows (A30). `clearlyEnglish` is the
 * opposite: English words and no Spanish signal at all. Everything else is
 * tentative, which is what lets one stray word stop being a life sentence.
 */
type Reading = { language: Language | null; decisive: boolean; clearlyEnglish: boolean };

const NOTHING: Reading = { language: null, decisive: false, clearlyEnglish: false };

function readMessage(text: string | null | undefined): Reading {
  const raw = (text ?? "").trim();
  if (!raw) return NOTHING;

  // A tapback is OUR sentence quoted back with the phone's verb in front, so
  // neither half is the customer's language. `Le gustó “What days work?”`
  // is an English customer on a Spanish-locale phone.
  if (normalizeInbound(raw).kind === "reaction") return NOTHING;

  const folded = fold(raw);
  const strong = new Set((folded.match(STRONG) ?? []).map((w) => w.toLowerCase()));
  const weak = new Set((folded.match(WEAK) ?? []).map((w) => w.toLowerCase()));
  const english = new Set((folded.match(ENGLISH) ?? []).map((w) => w.toLowerCase()));
  // The letters as evidence, keyed so they cannot collide with a real word.
  if (SPANISH_LETTERS.test(raw)) strong.add("<spanish-letter>");
  if (ACCENTED_VOWEL.test(raw)) weak.add("<accent>");

  // Two unambiguous Spanish signals outrank anything English around them.
  // "Sábado 9:30 am", the corpus trigger, is one — sabado — and is caught by
  // the rule below instead, since nothing English competes with it.
  if (strong.size >= 2) return { language: "es", decisive: true, clearlyEnglish: false };

  // ONE Spanish signal only decides it when nothing English is competing.
  //
  // "Hi there, hola is all the Spanish I know but I need an estimate for my
  // house" is a customer telling us they DON'T speak Spanish, and it was
  // being answered in Spanish. So was "La Casa Blanca restaurant on Main St",
  // which is a landmark in an address — and, until 2026-10-16, "Can you give
  // me an estímate?", because the accent was read before the English was.
  if (english.size === 0 && (strong.size === 1 || weak.size >= 2)) {
    return { language: "es", decisive: false, clearlyEnglish: false };
  }

  const clearlyEnglish = english.size >= 2 && strong.size === 0;
  return { language: null, decisive: false, clearlyEnglish };
}

/**
 * The language of the CONVERSATION, which is what A30 actually binds.
 *
 * "Do not switch back to English on the next turn." So this reads every
 * customer message, not just the latest: somebody who opened in Spanish and
 * then replies "ok" is still owed Spanish, and "ok" says nothing on its own.
 *
 * Derived rather than stored. A column would need a migration and could drift
 * out of step with what was actually said; the messages are the record.
 */
/**
 * ── A WEAK SIGNAL IS NO LONGER PERMANENT, 2026-10-16 ────────────────────
 *
 * This returned "es" the moment ANY message read as Spanish, so a single
 * tentative verdict — a lone "Hola", one accented word — held the customer
 * in Spanish for every turn after it, however much English they wrote. That
 * is the half of the corpus bug that made it expensive: one false read was
 * not one bad message, it was the rest of the conversation.
 *
 * A30's wording is kept to the letter where it binds. A DECISIVE Spanish
 * message latches: nothing afterwards switches back. A tentative one holds
 * through "ok", "sure", "11530" — which are not evidence of anything — and
 * yields only to a message that is plainly English and carries no Spanish
 * at all. "Sábado 9:30 am" then "ok" then "sure" stays Spanish, as the rule
 * card's own trigger requires.
 */
export function conversationLanguage(
  customerMessages: (string | null | undefined)[],
): Language {
  let language: Language = "en";
  for (const m of customerMessages) {
    const r = readMessage(m);
    if (r.language === "es") {
      if (r.decisive) return "es";
      language = "es";
    } else if (r.clearlyEnglish) {
      language = "en";
    }
  }
  return language;
}
