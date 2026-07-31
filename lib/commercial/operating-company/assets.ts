import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commercialDb } from "@/lib/commercial/db";
import { logUpdate } from "@/lib/commercial/audit-log";
import { getOperatingCompany } from "./db";

/**
 * Operating-company brand assets — logo/letterhead + signature image (Phase 0B).
 * Stored in a private `commercial-brand-assets` bucket; the operating-company
 * row holds the object key. Render-time we download the object to a Buffer for
 * react-pdf `<Image>`. Falls back to the bundled Tomco logo so letterhead
 * always renders even before anything is uploaded.
 */
export const BRAND_BUCKET = "commercial-brand-assets";

// Images only (logo + signature). PNG/JPEG/WEBP cover every real case.
export const BRAND_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
export const MAX_BRAND_BYTES = 5 * 1024 * 1024; // 5 MB — plenty for a logo/signature

/** Magic-byte check so a mislabeled/hostile file can't slip in. */
function looksLikeImage(data: Uint8Array, mime: string): boolean {
  const b = data;
  if (b.length < 12) return false;
  const at = (i: number, sig: number[]) => sig.every((x, k) => b[i + k] === x);
  if (at(0, [0x89, 0x50, 0x4e, 0x47])) return mime === "image/png"; // PNG
  if (at(0, [0xff, 0xd8, 0xff])) return mime === "image/jpeg" || mime === "image/jpg"; // JPEG
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return mime === "image/webp"; // WEBP
  return false;
}

type Result = { ok: true } | { ok: false; error: string };

export async function uploadBrandAsset(input: {
  kind: "logo" | "signature";
  data: Uint8Array;
  mime: string;
  actorUserId: string;
}): Promise<Result> {
  if (input.data.length <= 0) return { ok: false, error: "Empty file." };
  if (input.data.length > MAX_BRAND_BYTES) return { ok: false, error: "Image too big (max 5 MB)." };
  if (!BRAND_MIME.has(input.mime)) return { ok: false, error: "Use a PNG, JPEG or WEBP image." };
  if (!looksLikeImage(input.data, input.mime)) return { ok: false, error: "That file doesn't look like a real image." };

  const ext = input.mime === "image/png" ? "png" : input.mime === "image/webp" ? "webp" : "jpg";
  // Deterministic key per kind — overwrite on re-upload so we never orphan.
  const key = `${input.kind}.${ext}`;
  const sb = commercialDb();
  const { error: upErr } = await sb.storage.from(BRAND_BUCKET).upload(key, input.data, {
    contentType: input.mime,
    upsert: true,
  });
  if (upErr) return { ok: false, error: `Upload failed: ${upErr.message}` };

  const before = await getOperatingCompany();
  const col = input.kind === "logo" ? "logo_asset_key" : "signature_asset_key";
  const { error: dbErr } = await sb
    .from("commercial_operating_company")
    .upsert({ id: true, [col]: key, updated_at: new Date().toISOString(), updated_by_user_id: input.actorUserId }, { onConflict: "id" });
  if (dbErr) return { ok: false, error: dbErr.message };
  await logUpdate("commercial_operating_company", `brand:${input.kind}`, before, { [col]: key }, input.actorUserId);
  return { ok: true };
}

export async function clearBrandAsset(kind: "logo" | "signature", actorUserId: string): Promise<Result> {
  const sb = commercialDb();
  const col = kind === "logo" ? "logo_asset_key" : "signature_asset_key";
  const { error } = await sb
    .from("commercial_operating_company")
    .upsert({ id: true, [col]: null, updated_at: new Date().toISOString(), updated_by_user_id: actorUserId }, { onConflict: "id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Download a stored asset to a Buffer for react-pdf. Null on any failure. */
async function downloadAssetBuffer(key: string | null): Promise<Buffer | null> {
  if (!key) return null;
  try {
    const sb = commercialDb();
    const { data, error } = await sb.storage.from(BRAND_BUCKET).download(key);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  } catch {
    return null;
  }
}

// Bundled Tomco logo fallback (the one proposals already use), cached once.
let cachedFileLogo: Buffer | null | undefined = undefined;
function bundledLogo(): Buffer | null {
  if (cachedFileLogo !== undefined) return cachedFileLogo;
  try {
    cachedFileLogo = readFileSync(join(process.cwd(), "public", "brand", "tomco-logo.jpg"));
  } catch {
    cachedFileLogo = null;
  }
  return cachedFileLogo;
}

/** Logo Buffer for a PDF: uploaded override if set, else the bundled Tomco
 *  logo, else null (caller falls back to a text wordmark). */
export async function getBrandLogoBuffer(): Promise<Buffer | null> {
  const c = await getOperatingCompany();
  return (await downloadAssetBuffer(c.logo_asset_key)) ?? bundledLogo();
}

/** Signature Buffer for tap-to-sign (Phase 0C). Null when none uploaded. */
export async function getBrandSignatureBuffer(): Promise<Buffer | null> {
  const c = await getOperatingCompany();
  return downloadAssetBuffer(c.signature_asset_key);
}
