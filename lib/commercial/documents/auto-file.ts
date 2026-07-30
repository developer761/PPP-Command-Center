/**
 * Auto-file — persist a GENERATED document (a PDF/Excel the app produced, not a
 * user upload) into the deal's document store when a delivery tool is
 * sent/finalized. Phase D docs spine (Katie 2026-08): "documents … that we
 * submitted while doing a change order or something" auto-collect here, land
 * under that tool's Project sub-tab (by category), and roll up to the deal
 * Documents tab (parent_type=opportunity).
 *
 * BEST-EFFORT: this never throws and never blocks the status change that
 * triggered it — a render/upload failure is logged and swallowed, because the
 * document snapshot is a nice-to-have, not part of the transactional workflow.
 * Each send/finalize files a fresh dated snapshot (same pattern as a proposal
 * send), so re-sends leave an honest history rather than silently overwriting.
 */

export async function autoFileOpportunityDocument(input: {
  opportunityId: string;
  category: string;
  fileName: string;
  mimeType: string;
  data: Uint8Array;
  notes: string;
  actorUserId: string;
}): Promise<void> {
  try {
    const { uploadDocument } = await import("./db");
    const res = await uploadDocument({
      parent_type: "opportunity",
      parent_id: input.opportunityId,
      category: input.category,
      file_name: input.fileName,
      size_bytes: input.data.length,
      mime_type: input.mimeType,
      notes: input.notes,
      data: input.data,
      uploaded_by_user_id: input.actorUserId,
    });
    if (!res.ok) {
      console.warn(`[auto-file] ${input.category} snapshot skipped: ${res.error}`);
    }
  } catch (err) {
    console.warn(`[auto-file] ${input.category} snapshot failed:`, err);
  }
}

/** Filesystem-safe filename fragment. */
export function safeDocName(...parts: (string | number | null | undefined)[]): string {
  return parts
    .filter((p) => p != null && String(p).trim() !== "")
    .map((p) => String(p).replace(/[^A-Za-z0-9._-]+/g, "_"))
    .join("_")
    .slice(0, 120);
}

/** "sent Aug 14, 2026" ET stamp for the snapshot note. */
export function sentStampNote(prefix: string, dateIso?: string): string {
  const d = dateIso ? new Date(dateIso) : undefined;
  const when = (d ?? new Date()).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `${prefix} — auto-filed ${when}`;
}
