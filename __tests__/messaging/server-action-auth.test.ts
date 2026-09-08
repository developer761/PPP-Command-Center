import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { messagingAccessDenied } from "@/lib/messaging/auth";

/**
 * Every messaging server action must check the caller.
 *
 * The /messaging layout gates page RENDERS. A server action POSTs to a path
 * and runs even when that render-time redirect would have fired, and every one
 * of these actions reaches the database through messagingDb(), which uses the
 * SERVICE ROLE key and bypasses RLS entirely. Without a check there is nothing
 * in the way: action ids are build-global, so any signed-in PPP user — a
 * painter with a Dashboard login and no messaging access — could rewrite
 * Emily's rules for every workspace or regrade the training corpus.
 *
 * Commercial found this exact gap in its 2026-07-27 audit. Messaging repeated
 * it. Finding the same class twice is the argument for asserting it
 * structurally rather than trusting the next author to remember.
 */
const DIR = "lib/messaging";

function serverActionFiles(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => readFileSync(`${DIR}/${f}`, "utf8").startsWith('"use server"'));
}

/** Exported async functions, which is what a server action is. */
function exportedActions(src: string): string[] {
  return [...src.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]);
}

/** Source with comments removed — a comment naming the guard is not the guard. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("server actions cannot be called by someone without access", () => {
  it("finds the files it claims to scan", () => {
    const files = serverActionFiles();
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it("every exported action calls assertMessagingAccess", () => {
    const missing: string[] = [];
    for (const f of serverActionFiles()) {
      const src = code(readFileSync(`${DIR}/${f}`, "utf8"));
      const actions = exportedActions(src);
      for (const name of actions) {
        // The body runs to the next top-level export, or the end of the file.
        const start = src.indexOf(`export async function ${name}`);
        const next = src.indexOf("\nexport ", start + 1);
        const body = src.slice(start, next === -1 ? undefined : next);
        if (!body.includes("assertMessagingAccess(")) missing.push(`${f}:${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("detects an unguarded action — proving the check can fail", () => {
    const bad = `export async function doThing(x: string) {\n  const sb = messagingDb();\n}`;
    expect(exportedActions(bad)).toEqual(["doThing"]);
    expect(bad.includes("assertMessagingAccess(")).toBe(false);
  });

  it("does not accept a comment mentioning the guard as the guard", () => {
    const bad = `export async function doThing() {\n  // assertMessagingAccess() should go here\n  return 1;\n}`;
    expect(code(bad).includes("assertMessagingAccess(")).toBe(false);
  });
});

describe("the access policy itself", () => {
  const profile = (o: Record<string, unknown>) => ({
    id: "u", email: "a@precisionpaintingplus.net",
    has_messaging_access: true, is_active: true, ...o,
  } as never);

  it("denies a profile with no messaging access", () => {
    expect(messagingAccessDenied(profile({ has_messaging_access: false }))).toBe(true);
  });

  it("denies a missing profile", () => {
    expect(messagingAccessDenied(null)).toBe(true);
  });

  it("denies a deactivated account even with the flag on", () => {
    expect(messagingAccessDenied(profile({ is_active: false }))).toBe(true);
  });

  it("allows a live account with access", () => {
    expect(messagingAccessDenied(profile({}))).toBe(false);
  });
});
