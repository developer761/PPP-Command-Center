import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { geometryFromDimensions } from "@/lib/measure/geometry";
import type { MeasureSuggestion } from "@/lib/measure/types";

/**
 * Estimate a room's dimensions from a photo.
 *
 * A photo has no inherent scale — but a painted room is full of objects whose
 * real size is standardised by building code and manufacturing, and those give
 * the model a ruler:
 *
 *   interior door        80" tall, 30-36" wide
 *   outlet centre        12-18" above the floor
 *   light switch         48" above the floor
 *   ceiling              8' typical, 9-10' in newer builds
 *   standard step        7" rise
 *   crown/base moulding  3-5"
 *
 * This will not match a tape. It does not need to: paint is bought in whole
 * gallons with a buffer, so a number within ~20% orders the same amount as a
 * perfect one. The job here is to replace "no idea" with "about this", and to
 * SAY how sure it is so a worker knows whether to check it.
 */

const MODEL = "claude-sonnet-4-5";

/** What we ask the model to return. Kept flat and small — the more structure a
 *  vision prompt has to fill, the more it invents. */
type VisionResult = {
  lengthFt: number;
  widthFt: number;
  ceilingFt: number;
  confidence: "high" | "medium" | "low";
  reference: string;
  doors?: number;
  windows?: number;
};

export async function estimateRoomFromPhoto(input: {
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  roomLabel?: string | null;
  /** A dimension the worker already knows — one wall, or the ceiling height.
   *  Anchoring the model to one real number sharply improves the rest. */
  knownHintFt?: number | null;
  knownHintLabel?: string | null;
}): Promise<MeasureSuggestion | { error: string }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: "Photo estimates aren't configured yet (ANTHROPIC_API_KEY not set)." };

  const hint =
    input.knownHintFt && input.knownHintFt > 0
      ? `\n\nThe painter measured one thing already: ${input.knownHintLabel ?? "a wall"} is ${input.knownHintFt} ft. Anchor your scale to that and derive the rest from it.`
      : "";

  const prompt = `You are helping a painting contractor size a room for PAINT, from one photo.

Room: ${input.roomLabel?.trim() || "(unlabelled)"}${hint}

Use standard building dimensions visible in the photo as your ruler:
- interior door 80 in tall, 30-36 in wide
- electrical outlet centre 12-18 in above the floor
- light switch 48 in above the floor
- standard stair rise 7 in
- baseboard 3-5 in tall
- ceilings are usually 8 ft, sometimes 9-10 ft in newer construction

Estimate the room's floor dimensions and ceiling height in FEET, and count the
doors and windows you can actually see.

Be honest about confidence:
- "high"   you can see a full wall and at least two reference objects
- "medium" you can see enough to scale but are extrapolating a dimension
- "low"    a tight crop, an odd angle, or nothing to scale against

Being roughly right is useful; being confidently wrong is not. If you cannot
tell, say low.

Reply with ONLY a JSON object, no prose:
{"lengthFt":number,"widthFt":number,"ceilingFt":number,"confidence":"high|medium|low","reference":"the objects you scaled from, one short phrase","doors":number,"windows":number}`;

  try {
    const client = new Anthropic({ apiKey: key });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: input.mediaType, data: input.imageBase64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    // The model is asked for bare JSON but may still fence it.
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return { error: "Couldn't read an estimate from that photo. Try a wider shot." };

    const parsed = JSON.parse(json) as VisionResult;
    const lengthFt = Number(parsed.lengthFt);
    const widthFt = Number(parsed.widthFt);
    if (!Number.isFinite(lengthFt) || !Number.isFinite(widthFt) || lengthFt <= 0 || widthFt <= 0) {
      return { error: "Couldn't size the room from that photo. Try including a doorway or a full wall." };
    }

    // Clamp to rooms that exist. A model that reads a hallway as 200 ft would
    // otherwise order paint for a warehouse.
    const clamp = (n: number) => Math.min(80, Math.max(2, Math.round(n * 10) / 10));
    const L = clamp(lengthFt);
    const W = clamp(widthFt);
    const H = Math.min(20, Math.max(6, Number(parsed.ceilingFt) || 8));

    const geo = geometryFromDimensions(
      { lengthFt: L, widthFt: W, ceilingFt: H },
      { doors: parsed.doors, windows: parsed.windows }
    );

    // A photo is never a tape. Cap the claim at medium however sure it sounds —
    // "high" here would put a guess on the same footing as a measurement.
    const confidence = parsed.confidence === "low" ? "low" : "medium";

    return {
      source: "photo",
      confidence,
      sqft: geo.floorAreaSqft,
      lengthFt: L,
      widthFt: W,
      ceilingFt: H,
      perimeterLf: geo.perimeterLf,
      rationale: `≈${L}′ × ${W}′, ${H}′ ceiling — scaled from ${parsed.reference || "objects in the photo"}.`,
      detail: { model: MODEL, raw: parsed },
    };
  } catch (err) {
    console.error("[measure/from-photo]", err);
    return { error: err instanceof Error ? err.message : "Photo estimate failed." };
  }
}
