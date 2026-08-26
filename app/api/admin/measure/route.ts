import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { capabilitiesFor, normalizeRole } from "@/lib/auth/roles";
import { geometryFromDimensions } from "@/lib/measure/geometry";
import { estimateRoomFromPhoto } from "@/lib/measure/from-photo";
import { suggestFromAddress } from "@/lib/measure/from-address";
import type { MeasureSource, MeasureConfidence } from "@/lib/measure/types";

/**
 * Room measurement capture.
 *
 *   POST { action: "photo",  woliId, roomLabel, imageBase64, mediaType, knownHintFt? }
 *   POST { action: "address", workOrderId, address, rooms[] }
 *   POST { action: "save",   woliId, workOrderId, sqft, lengthFt?, widthFt?,
 *                            ceilingFt?, source, confidence, suggestion? }
 *
 * Gated on canEnterColors, not canOrderMaterials: measuring a room is field
 * work an Account Manager should be able to do. Ordering the paint is still
 * admin-only.
 *
 * "save" writes to wo_li_sqft_overrides — the table the gallon estimator, the
 * order builder and the supplier email ALREADY read — so a number captured
 * here reaches the vendor with no other code involved.
 */
async function authorize() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const profile = await getProfileByUserId(data.user.id);
  if (profile && profile.is_active === false && !isAdminEmail(data.user.email)) {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  const caps = capabilitiesFor(normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(data.user.email)));
  if (!caps.canEnterColors) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { userId: data.user.id, email: data.user.email ?? null };
}

function admin() {
  return createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Migration 156 pending — the tool still works, it just can't remember. */
function isMissingSchema(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const m = e?.message ?? "";
  return (
    e?.code === "42P01" || e?.code === "42703" || e?.code === "PGRST204" || e?.code === "PGRST205" ||
    /column [^\n]*(length_ft|source|confidence|perimeter_lf)[^\n]* does not exist/i.test(m) ||
    /could not find the .*(room_measurement_captures|length_ft)/i.test(m)
  );
}

export async function POST(request: Request) {
  const auth = await authorize();
  if (auth.error) return auth.error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const action = String(body.action ?? "");

  /* ── Work orders, for the picker ──────────────────────────────────────── */
  if (action === "workOrders") {
    const { loadDashboardData } = await import("@/lib/data-source");
    const { deriveOpenMaterialsWorkOrders } = await import("@/lib/salesforce/materials");
    const bundle = await loadDashboardData({}, { materials: true });
    if (!bundle.snapshot) return NextResponse.json({ ok: true, workOrders: [] });
    const q = String(body.query ?? "").trim().toLowerCase();
    const jobs = deriveOpenMaterialsWorkOrders(bundle.snapshot)
      .map((j) => {
        // Surfacing how many rooms still need a number is the whole point of
        // the list — it turns picking a job into triage.
        const unmeasured = j.lineItems.filter(
          (li) => !(li.raw.sqFootage > 0) && !(li.raw.wallSurfaceArea > 0)
        ).length;
        return {
          id: j.wo.id,
          number: j.wo.workOrderNumber ?? j.wo.id.slice(-6),
          customer: j.wo.accountName ?? "(unknown)",
          rooms: j.lineItems.length,
          unmeasured,
        };
      })
      .filter((w) => w.rooms > 0)
      .filter((w) => !q || w.number.toLowerCase().includes(q) || w.customer.toLowerCase().includes(q))
      // Jobs with the most missing measurements first — they're the ones the
      // materials tool currently can't size.
      .sort((a, b) => b.unmeasured - a.unmeasured || a.customer.localeCompare(b.customer))
      .slice(0, 40);
    return NextResponse.json({ ok: true, workOrders: jobs });
  }

  /* ── One work order's rooms ───────────────────────────────────────────── */
  if (action === "rooms") {
    const woId = String(body.workOrderId ?? "").trim();
    if (!woId) return NextResponse.json({ error: "missing_wo" }, { status: 400 });
    const { loadOrderPageData } = await import("@/lib/materials/order-page-data");
    const { roomLabelFrom } = await import("@/lib/customer-form/room-label");
    const data = await loadOrderPageData(woId);
    if (!data) return NextResponse.json({ ok: false, message: "Work order not found." });

    // Whatever has already been captured, so re-opening a job shows the work.
    const ids = data.job.lineItems.map((li) => li.raw.id);
    const saved = new Map<string, Record<string, unknown>>();
    try {
      const { data: rows } = await admin().from("wo_li_sqft_overrides").select("*").in("woli_id", ids);
      for (const r of (rows ?? []) as Array<Record<string, unknown>>) saved.set(String(r.woli_id), r);
    } catch {
      /* pre-156 — nothing captured yet */
    }

    const acct = data.job.wo;
    return NextResponse.json({
      ok: true,
      workOrder: { id: data.workOrderId, number: acct.workOrderNumber ?? null, customer: acct.accountName ?? null },
      address: data.address,
      rooms: data.job.lineItems.map((li) => {
        const s = saved.get(li.raw.id);
        return {
          woliId: li.raw.id,
          label: roomLabelFrom(li.raw.areaLabel, li.raw.productName, "Unnamed area"),
          sfSqft: li.raw.sqFootage || 0,
          savedSqft: s ? Number(s.sqft) || null : null,
          savedSource: (s?.source as string) ?? null,
          lengthFt: s?.length_ft != null ? Number(s.length_ft) : null,
          widthFt: s?.width_ft != null ? Number(s.width_ft) : null,
          ceilingFt: s?.ceiling_ft != null ? Number(s.ceiling_ft) : null,
          surfaces: (li.raw.surfaces ?? "").split(";").map((x) => x.trim()).filter(Boolean),
        };
      }),
    });
  }

  /* ── Photo → dimensions ───────────────────────────────────────────────── */
  if (action === "photo") {
    const imageBase64 = String(body.imageBase64 ?? "");
    if (!imageBase64) return NextResponse.json({ error: "missing_image" }, { status: 400 });
    // ~8MB of base64 ≈ 6MB of image. Beyond that the model call is slow enough
    // that a phone on site will look broken.
    if (imageBase64.length > 8_000_000) {
      return NextResponse.json(
        { error: "image_too_large", message: "That photo is too big — try again, it'll be resized automatically." },
        { status: 413 }
      );
    }
    const mt = String(body.mediaType ?? "image/jpeg");
    const mediaType = (["image/jpeg", "image/png", "image/webp"].includes(mt) ? mt : "image/jpeg") as
      "image/jpeg" | "image/png" | "image/webp";
    const result = await estimateRoomFromPhoto({
      imageBase64,
      mediaType,
      roomLabel: body.roomLabel ? String(body.roomLabel) : null,
      knownHintFt: body.knownHintFt ? Number(body.knownHintFt) : null,
      knownHintLabel: body.knownHintLabel ? String(body.knownHintLabel) : null,
    });
    if ("error" in result) return NextResponse.json({ ok: false, ...result }, { status: 200 });
    return NextResponse.json({ ok: true, suggestion: result });
  }

  /* ── Address → whole-house, distributed ───────────────────────────────── */
  if (action === "address") {
    const rooms = Array.isArray(body.rooms)
      ? (body.rooms as Array<{ id?: unknown; label?: unknown }>)
          .map((r) => ({ id: String(r.id ?? ""), label: String(r.label ?? "") }))
          .filter((r) => r.id)
      : [];
    if (rooms.length === 0) return NextResponse.json({ error: "no_rooms" }, { status: 400 });
    const a = (body.address ?? {}) as Record<string, unknown>;
    const result = await suggestFromAddress({
      address: {
        street: String(a.street ?? ""),
        city: String(a.city ?? ""),
        state: String(a.state ?? ""),
        postalCode: String(a.postalCode ?? ""),
      },
      rooms,
    });
    if ("error" in result) return NextResponse.json({ ok: false, ...result }, { status: 200 });
    return NextResponse.json({ ok: true, ...result });
  }

  /* ── Save an accepted number ────────────────────────────────────────────
   *
   * LIVE when a work order is selected. Writes to wo_li_sqft_overrides — the
   * table the gallon estimator, the order builder and the supplier email
   * already read — so a room measured here reaches the vendor quantities with
   * no other code involved. The free-form sandbox never calls it, so testing
   * still can't touch a real job. */
  if (action === "save") {
    const woliId = String(body.woliId ?? "").trim();
    if (!woliId) return NextResponse.json({ error: "missing_woli" }, { status: 400 });

    const lengthFt = body.lengthFt != null ? Number(body.lengthFt) : null;
    const widthFt = body.widthFt != null ? Number(body.widthFt) : null;
    const ceilingFt = body.ceilingFt != null ? Number(body.ceilingFt) : null;

    // Derive from dimensions when we have them so the stored area and the
    // stored perimeter can never disagree with each other.
    let sqft = Math.round(Number(body.sqft ?? 0));
    // An explicit perimeter comes from WALKING the room, and it is the one
    // number a rectangle cannot express — an L-shaped room has more wall than
    // any length × width implies. Never recompute over it.
    let perimeterLf: number | null =
      body.perimeterLf != null && Number(body.perimeterLf) > 0 ? Number(body.perimeterLf) : null;
    if (perimeterLf == null && lengthFt && widthFt && lengthFt > 0 && widthFt > 0) {
      const geo = geometryFromDimensions({ lengthFt, widthFt, ceilingFt: ceilingFt ?? 0 });
      sqft = Math.round(geo.floorAreaSqft);
      perimeterLf = geo.perimeterLf;
    }
    if (!Number.isFinite(sqft) || sqft <= 0 || sqft > 100000) {
      return NextResponse.json({ error: "bad_sqft", message: "That square footage doesn't look right." }, { status: 400 });
    }

    const source = String(body.source ?? "manual") as MeasureSource;
    const confidence = String(body.confidence ?? "high") as MeasureConfidence;
    const row = {
      woli_id: woliId,
      work_order_id: body.workOrderId ? String(body.workOrderId) : null,
      sqft,
      length_ft: lengthFt,
      width_ft: widthFt,
      ceiling_ft: ceilingFt,
      perimeter_lf: perimeterLf,
      source,
      confidence,
      updated_by: auth.email,
      updated_at: new Date().toISOString(),
    };

    try {
      const sb = admin();
      const { error } = await sb.from("wo_li_sqft_overrides").upsert(row, { onConflict: "woli_id" });
      if (error) throw error;

      // Training signal. Recorded best-effort: losing it must never cost the
      // worker the measurement they just took.
      try {
        const s = (body.suggestion ?? null) as Record<string, unknown> | null;
        await sb.from("room_measurement_captures").insert({
          woli_id: woliId,
          work_order_id: row.work_order_id,
          room_label: body.roomLabel ? String(body.roomLabel) : null,
          source,
          suggested_sqft: s?.sqft != null ? Math.round(Number(s.sqft)) : null,
          suggested_length_ft: s?.lengthFt != null ? Number(s.lengthFt) : null,
          suggested_width_ft: s?.widthFt != null ? Number(s.widthFt) : null,
          confidence,
          accepted_sqft: sqft,
          // The valuable row: a suggestion the human then changed. That gap is
          // the only way to learn a method is wrong for a kind of room.
          accepted: s?.sqft != null ? Math.round(Number(s.sqft)) === sqft : true,
          detail: s ?? null,
          captured_by: auth.email,
        });
      } catch (capErr) {
        console.warn("[measure] capture log skipped:", capErr);
      }

      return NextResponse.json({ ok: true, sqft, perimeterLf });
    } catch (err) {
      if (isMissingSchema(err)) {
        // Fall back to the pre-156 shape so the tool still saves the number.
        try {
          const { error } = await admin()
            .from("wo_li_sqft_overrides")
            .upsert({ woli_id: woliId, work_order_id: row.work_order_id, sqft, updated_by: auth.email }, { onConflict: "woli_id" });
          if (error) throw error;
          return NextResponse.json({ ok: true, sqft, perimeterLf: null, degraded: "migration_156_pending" });
        } catch (inner) {
          console.error("[measure/save fallback]", inner);
        }
      }
      console.error("[measure/save]", err);
      return NextResponse.json(
        { error: "save_failed", message: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}
