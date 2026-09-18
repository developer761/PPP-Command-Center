/**
 * The bookkeeping blocks the submit route writes into `ColorNotes__c`.
 *
 * Each is a heading followed by indented values:
 *
 *     No finish chosen — please confirm with the customer:
 *       Walls
 *       Trim
 *
 * They are written for PPP, not for the customer, and not for a vendor. Two
 * readers have to recognise them, and both got it wrong by holding their own
 * idea of the list (round-six audit, 2026-09-17):
 *
 *   · the re-sent color form pre-filled the customer's own notes box with
 *     them, so the customer was shown PPP's internal note as if they had
 *     typed it — and the next submit stored a second copy;
 *   · the order builder offered their indented values to the estimator as
 *     things to BUY, so a vendor could be asked to price the word "Walls",
 *     or the rejected typo "Regal Selectt".
 *
 * So the strings live here, once, and the writer uses the same constants.
 * Adding a block means adding it here, which is the only way both readers
 * learn about it.
 */
export const MACHINE_NOTE_HEADINGS = {
  /** A finish Salesforce's picklist cannot store, recorded instead. */
  unstorableFinish: "Finish not available in the Salesforce list — recorded here:",
  /** A finish that was not on the list at all (WO 00317803). */
  droppedFinish: "Finish not recognised — please confirm with the customer:",
  /** A color picked with no finish — two sheens are two SKUs. */
  missingFinish: "No finish chosen — please confirm with the customer:",
  /** A paint line the payload carried that PPP does not sell. */
  droppedPaintLine: "Paint line not recognised — please confirm with the customer:",
} as const;

const HEADINGS = Object.values(MACHINE_NOTE_HEADINGS);

/**
 * Matched on the words, not the exact string: the em dash, the spacing and the
 * British/American spelling of "recognised" have each changed at least once,
 * and a stale literal fails SILENTLY — the block simply leaks again.
 */
const HEADING_PATTERNS = HEADINGS.map(
  (h) =>
    new RegExp(
      "^\\s*" +
        h
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          // any dash, spelled either way, any run of whitespace
          .replace(/—/g, "[—–-]")
          .replace(/recognised/g, "recogni[sz]ed")
          .replace(/\s+/g, "\\s+"),
      "i"
    )
);

export function isMachineNoteHeading(line: string): boolean {
  return HEADING_PATTERNS.some((re) => re.test(line));
}

/**
 * Remove every machine block — each heading and the indented values under it.
 *
 * An UNINDENTED line ends a block: the values we write are always indented, so
 * anything flush left after a heading is somebody's own words and is kept. A
 * blank line ends it too.
 */
export function stripMachineNoteBlocks(text: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const line of String(text ?? "").split("\n")) {
    if (isMachineNoteHeading(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (/^\s{2,}\S/.test(line)) continue;
      inBlock = false;
      if (!line.trim()) continue; // the blank line that separated the block
    }
    kept.push(line);
  }
  return kept.join("\n");
}
