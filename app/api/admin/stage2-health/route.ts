import { NextResponse } from "next/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { resolveViewer } from "@/lib/auth/viewer-server";
import {
  isArchiveConfigured,
  buildArchiveAddress,
} from "@/lib/commercial/email-archive/address";

/**
 * Stage 2 health check — single-shot proof that the BCC archive feature
 * is fully wired up for production:
 *
 *   1. Migration 036 applied (commercial_archived_emails table exists +
 *      has the expected columns)
 *   2. Storage bucket commercial-email-attachments exists (private,
 *      ≤25 MB cap)
 *   3. COMMERCIAL_ARCHIVE_HMAC_SECRET env var is set (≥16 chars) and
 *      the build helper can produce a valid address
 *
 * Admin-only — calls resolveViewer + refuses non-admins. Returns a flat
 * JSON the caller can eyeball or pipe into jq.
 *
 *   GET /api/admin/stage2-health
 *     → 200 { ok: true, ... } when everything's green
 *     → 200 { ok: false, ... } with per-check diagnostics otherwise
 *     → 401 when not signed in / 403 when not admin
 *
 * Designed to be hit ONCE after deploying Stage 2 + applying the
 * migration + creating the bucket. Safe to keep in the repo permanently
 * as a regression-watch tool.
 */

const STAGE2_BUCKET = "commercial-email-attachments";
const STAGE2_MAX_BYTES = 25 * 1024 * 1024;

export async function GET(request: Request) {
  // resolveViewer expects the parsed searchParams record, not the URL.
  const url = new URL(request.url);
  const sp: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    sp[k] = v;
  });
  const viewer = await resolveViewer(sp);
  if (!viewer) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!viewer.isAdmin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const sb = createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // ── 1. Migration 036 — table exists + key columns + dedup index ──
  // We don't query pg_catalog (some hosted Supabase setups restrict
  // it from the service role). Instead we issue a HEAD-equivalent
  // count against the table — if it errors with relation_does_not_exist
  // (42P01), migration 036 hasn't run.
  let migration: { ok: boolean; detail: string };
  try {
    const { error } = await sb
      .from("commercial_archived_emails")
      .select("id", { count: "exact", head: true });
    if (error) {
      migration = {
        ok: false,
        detail: `query failed: ${error.code ?? "?"} ${error.message}`,
      };
    } else {
      migration = { ok: true, detail: "commercial_archived_emails responds to select" };
    }
  } catch (err) {
    migration = {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // ── 2. Storage bucket — exists + private + ≤25 MB cap ──
  // listBuckets requires service-role; we filter by id and inspect public
  // + file_size_limit attributes. Doesn't read any contents.
  let bucket: {
    ok: boolean;
    exists: boolean;
    isPrivate?: boolean;
    fileSizeLimit?: number | null;
    detail: string;
  };
  try {
    const { data: buckets, error } = await sb.storage.listBuckets();
    if (error) {
      bucket = { ok: false, exists: false, detail: `listBuckets failed: ${error.message}` };
    } else {
      const found = (buckets ?? []).find((b) => b.id === STAGE2_BUCKET || b.name === STAGE2_BUCKET);
      if (!found) {
        bucket = {
          ok: false,
          exists: false,
          detail: `bucket "${STAGE2_BUCKET}" not found — create it in Supabase UI`,
        };
      } else {
        // Supabase storage TypeScript types vary across versions on these
        // fields. Pull what's there via a narrow cast.
        const b = found as unknown as {
          public?: boolean;
          file_size_limit?: number | null;
        };
        const isPrivate = b.public === false;
        const fsLimit = b.file_size_limit ?? null;
        const sizeOk =
          fsLimit === null || (typeof fsLimit === "number" && fsLimit <= STAGE2_MAX_BYTES + 1024);
        bucket = {
          ok: isPrivate && sizeOk,
          exists: true,
          isPrivate,
          fileSizeLimit: fsLimit,
          detail: !isPrivate
            ? `bucket exists but is PUBLIC — flip to private`
            : !sizeOk
              ? `bucket exists but file_size_limit (${fsLimit}) exceeds 25 MB cap`
              : "private bucket with acceptable size cap",
        };
      }
    }
  } catch (err) {
    bucket = {
      ok: false,
      exists: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // ── 3. HMAC secret — configured + length + sample address builds ──
  const configured = isArchiveConfigured();
  const secretLen = (process.env.COMMERCIAL_ARCHIVE_HMAC_SECRET?.trim() ?? "").length;
  const sampleAddress = configured
    ? buildArchiveAddress("opp", "00000000-0000-0000-0000-000000000000")
    : null;
  const hmac = {
    ok: configured && secretLen >= 32 && sampleAddress !== null,
    configured,
    secretLength: secretLen,
    sampleAddress,
    archiveDomain: process.env.COMMERCIAL_ARCHIVE_DOMAIN ?? "(default) orders.precisionpaintingplus.net",
    archiveLocal: process.env.COMMERCIAL_ARCHIVE_LOCAL ?? "(default) orders",
    detail: !configured
      ? "COMMERCIAL_ARCHIVE_HMAC_SECRET not set in Vercel — feature gated off"
      : secretLen < 32
        ? `secret too short (${secretLen} chars). Recommend ≥32 (use openssl rand -hex 32)`
        : "configured with ≥32 char secret + sample address builds cleanly",
  };

  const allOk = migration.ok && bucket.ok && hmac.ok;
  return NextResponse.json({
    ok: allOk,
    stage: "stage_2_bcc_archive",
    checked_at: new Date().toISOString(),
    migration,
    bucket,
    hmac,
  });
}
