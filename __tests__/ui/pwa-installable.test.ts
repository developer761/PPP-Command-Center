import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Chrome will not offer to install unless EVERY criterion is met, and it says
 * nothing when one is missing — the install option simply never appears, which
 * looks like "Android doesn't support this" rather than a broken icon path.
 *
 * So each requirement is asserted separately here, against the real files.
 */
const ROOT = process.cwd();
const manifestSrc = readFileSync(join(ROOT, "app/manifest.ts"), "utf8");

/** PNG dimensions straight from the IHDR chunk — no image library needed. */
function pngSize(path: string): { w: number; h: number } | null {
  if (!existsSync(path)) return null;
  const b = readFileSync(path);
  if (b.length < 24 || b.toString("binary", 1, 4) !== "PNG") return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe("the app stays installable on Android", () => {
  it("declares the fields Chrome requires", () => {
    for (const field of ["name", "short_name", "start_url", "display", "icons"]) {
      expect(manifestSrc, `manifest is missing ${field}`).toMatch(new RegExp(`\\b${field}\\b`));
    }
    // `browser` display mode is explicitly NOT installable.
    expect(manifestSrc).toMatch(/display:\s*"(standalone|fullscreen|minimal-ui)"/);
  });

  it("ships icons at the sizes Chrome checks for, as real PNGs", () => {
    // A 404 or a mis-sized icon silently disqualifies the whole app.
    const icons: Array<[string, number]> = [
      ["public/icon-192.png", 192],
      ["public/icon-512.png", 512],
      ["public/icon-maskable-512.png", 512],
    ];
    for (const [rel, size] of icons) {
      const got = pngSize(join(ROOT, rel));
      expect(got, `${rel} is missing or not a PNG`).not.toBeNull();
      expect(got!.w, `${rel} width`).toBe(size);
      expect(got!.h, `${rel} height`).toBe(size);
    }
  });

  it("has a maskable icon, so Android does not letterbox it", () => {
    // Without `purpose: maskable` Android draws the square icon inside its
    // shape, leaving a white border that looks like a broken install.
    expect(manifestSrc).toMatch(/purpose:\s*"maskable"/);
  });

  it("registers a service worker WITH a fetch handler", () => {
    // Chrome requires a fetch handler specifically; a worker that only caches
    // on install does not qualify.
    const sw = readFileSync(join(ROOT, "public/sw.js"), "utf8");
    expect(sw).toMatch(/addEventListener\(\s*["']fetch["']/);
    const reg = readFileSync(join(ROOT, "components/service-worker-register.tsx"), "utf8");
    expect(reg).toMatch(/serviceWorker\.register\(/);
  });

  it("offers the install in the app, not only in a browser menu", () => {
    const prompt = readFileSync(join(ROOT, "components/install-app-prompt.tsx"), "utf8");
    expect(prompt).toMatch(/beforeinstallprompt/);
    // Chrome's captured event is single-use; prompting twice throws.
    expect(prompt).toMatch(/userChoice/);
    const layout = readFileSync(join(ROOT, "app/layout.tsx"), "utf8");
    expect(layout, "the prompt is never rendered").toMatch(/<InstallAppPrompt/);
  });

  it("never covers a full-screen tool", () => {
    // The install banner is pinned to the bottom of the viewport, which is also
    // where the measure tool puts its capture button. At a higher z-index the
    // nag would sit on top of the thing the app was opened to do.
    const prompt = readFileSync(join(ROOT, "components/install-app-prompt.tsx"), "utf8");
    const z = prompt.match(/fixed inset-x-0 bottom-0 z-\[?(\d+)\]?/)?.[1];
    expect(z, "could not find the banner z-index").toBeTruthy();
    expect(Number(z), "must sit below modals (50), measure (60) and sheets (70)").toBeLessThan(50);
    // ...and above ordinary sticky bars, or it is invisible where it matters.
    expect(Number(z)).toBeGreaterThan(30);
  });

  it("does not nag someone who already installed it", () => {
    const prompt = readFileSync(join(ROOT, "components/install-app-prompt.tsx"), "utf8");
    expect(prompt).toMatch(/display-mode: standalone/);
    expect(prompt).toMatch(/appinstalled/);
  });
});
