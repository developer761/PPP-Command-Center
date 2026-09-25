/**
 * One shape for a phone number on screen.
 *
 * Numbers arrive however whoever typed them felt like typing them, so a column
 * you read down at speed ran "631-224-8894" to "5165236737" to "(516) 312-9981"
 * and back. Brendan's Pipeline Manager exists to be worked down — its own blurb
 * says so — and one row in a different shape is where a misdial comes from.
 *
 * Display only. The `tel:` target keeps the raw digits: formatting is for the
 * eye, and a dialler should never be given a guess about what the punctuation
 * meant.
 *
 * ANYTHING IT DOESN'T RECOGNISE COMES BACK UNTOUCHED. An extension, an
 * international number, a note somebody typed in the phone field — all of them
 * are returned exactly as stored. Inventing a shape for a number this does not
 * understand would be worse than leaving it alone: the reader can see an odd
 * number and check it, and cannot see a tidy one that is wrong.
 */
export function formatUsPhone(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  // 10 digits, or 11 starting with the US country code.
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    const d = digits.slice(1);
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return s;
}
