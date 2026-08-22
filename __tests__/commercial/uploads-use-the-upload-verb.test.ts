import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The signed-upload endpoint is PUT. POST at the same path means something else.
 *
 * On storage-v1 the VERB distinguishes two routes that share a URL:
 *   POST /object/upload/sign/{bucket}/{key}  → MINT a signed upload URL
 *   PUT  /object/upload/sign/{bucket}/{key}  → upload TO one
 *
 * Both hand-rolled browser uploaders sent the file with POST, so every upload
 * hit the create-a-URL route carrying a multipart body.
 *
 * Verified against live Storage on 2026-08-22 — same bucket, same signed token,
 * same body, only the verb differing:
 *   POST → HTTP 400, nothing stored
 *   PUT  → HTTP 200, object stored
 *
 * That is Stephanie's "Storage rejected the file (HTTP 400)" on Documents and
 * Work Orders. Migration 137 fixed the OTHER half of the same report — the
 * request ran as `anon` because the client sent the publishable key as its
 * bearer — which is why the error outlived a fix that was correct as far as it
 * went, and why nobody re-tested the transport underneath it.
 *
 * These clients are hand-rolled for upload PROGRESS (XHR gives it, fetch does
 * not), so they cannot simply call the SDK. That makes them a copy of the SDK's
 * behaviour maintained by hand — which is exactly the kind of thing that drifts
 * silently, so it is pinned.
 */

const CLIENTS = [
  "lib/commercial/uploads/direct-upload-client.ts",
  "lib/commercial/uploads/direct-attachment-client.ts",
];

describe("browser upload transport", () => {
  for (const file of CLIENTS) {
    const src = readFileSync(file, "utf8");

    it(`${file} opens the signed URL with PUT`, () => {
      const opens = [...src.matchAll(/x\.open\("(\w+)"/g)].map((m) => m[1]);
      expect(opens.length, "no XHR open() found — did the transport change?").toBeGreaterThan(0);
      for (const verb of opens) {
        expect(
          verb,
          `${file} uploads with ${verb}. POST at /object/upload/sign is the ` +
            `mint-a-URL route and returns 400 with the file discarded.`
        ).toBe("PUT");
      }
    });

    it(`${file} still targets the signed-upload path`, () => {
      // If the path ever changes to /object/{bucket}/{key} the verb rules
      // change with it, and this test would otherwise keep passing.
      expect(src).toContain("/storage/v1/object/upload/sign/");
    });
  }
});
