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
export type Language = "en" | "es";

/**
 * Characters that are Spanish on sight.
 *
 * One of these is enough on its own — no English word carries ñ, ¿ or ¡, and
 * an accented vowel in a text message is somebody writing Spanish, not
 * somebody writing "café".
 */
const SPANISH_LETTERS = /[ñÑ¿¡áéíóúÁÉÍÓÚüÜ]/;

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
  "please", "thanks", "thank", "know", "all", "but", "not", "no", "yes",
  "looking", "there", "here", "what", "when", "where", "how", "on", "at",
  "of", "to", "in", "a", "an", "be", "do", "does", "did", "get", "got",
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
  const raw = (text ?? "").trim();
  if (!raw) return null;

  // A letter no English word has. Enough on its own, per "the signal can be
  // two words" — and "Sábado 9:30 am", the corpus trigger, is caught here.
  if (SPANISH_LETTERS.test(raw)) return "es";

  const folded = fold(raw);
  const strong = new Set((folded.match(STRONG) ?? []).map((w) => w.toLowerCase()));
  const weak = new Set((folded.match(WEAK) ?? []).map((w) => w.toLowerCase()));
  const english = new Set((folded.match(ENGLISH) ?? []).map((w) => w.toLowerCase()));

  // Two unambiguous Spanish words outrank anything English around them.
  if (strong.size >= 2) return "es";

  // ONE Spanish word only decides it when nothing English is competing.
  //
  // "Hi there, hola is all the Spanish I know but I need an estimate for my
  // house" is a customer telling us they DON'T speak Spanish, and it was
  // being answered in Spanish. So was "La Casa Blanca restaurant on Main St",
  // which is a landmark in an address.
  if (english.size === 0 && (strong.size === 1 || weak.size >= 2)) return "es";

  return null;
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
export function conversationLanguage(
  customerMessages: (string | null | undefined)[],
): Language {
  for (const m of customerMessages) {
    if (languageOf(m) === "es") return "es";
  }
  return "en";
}
