import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The measure tool opens a live camera IN the page — no shutter, no camera
 * roll, nothing handed off to the phone's Camera app. That needs the origin to
 * be permitted to ask for camera access.
 *
 * `camera=()` means "no origin may use this, including us". It shipped that way
 * and would have made the viewfinder fail on every phone with what looks like a
 * user permission problem — a support ticket that leads nowhere, because the
 * user's settings are fine and the header is the cause.
 *
 * This is a plausible thing for a future security pass to "tidy" back, so it is
 * pinned here with the reason attached. `(self)` does NOT grant access — the
 * browser still prompts. It only says we are allowed to prompt.
 */
const src = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
const header = src.match(/"Permissions-Policy",\s*value:\s*"([^"]+)"/)?.[1];

describe("Permissions-Policy", () => {
  it("is actually present in next.config.ts", () => {
    // Guards the guard: if the shape changes, every assertion below would pass
    // against `undefined` and this file would silently stop protecting anything.
    expect(header, "could not find the Permissions-Policy value to check").toBeTruthy();
  });

  it("lets our own origin ask for the camera", () => {
    expect(header).toMatch(/camera=\(self\)/);
    expect(header, "camera=() blocks the measure tool's viewfinder").not.toMatch(/camera=\(\)/);
  });

  it("still denies everything the app does not use", () => {
    for (const api of ["microphone", "geolocation", "payment"]) {
      expect(header, `${api} should stay fully disabled`).toMatch(
        new RegExp(`${api}=\\(\\)`)
      );
    }
  });

  it("does not hand the camera to third parties", () => {
    // `camera=*` would let any embedding origin use it.
    expect(header).not.toMatch(/camera=\*/);
    expect(header).not.toMatch(/camera=\([^)]*https?:/);
  });
});
