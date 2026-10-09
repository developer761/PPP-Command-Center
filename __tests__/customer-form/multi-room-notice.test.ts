/**
 * Kate p19 — a line item whose scope covers several rooms, on the customer's
 * form. The card is titled with ONE room, so the customer gives one set of
 * colors for four.
 *
 * Her primary ask was to drop the surface pickers and leave only notes,
 * marked "an ask/not required". Her fallback, which she wrote out with a
 * worked example, is a room+surface template in the notes. The fallback is
 * what is built: it tells the customer the same thing without moving the
 * colors out of structured fields and onto somebody's desk.
 */
/**
 * NOTE ON stripComments: it removes block comments FIRST and never tries to
 * match the `{ ... }` of a JSX comment.
 *
 * The obvious pattern — /\{\s*\/\*[\s\S]*?\*\/\s*\}/ — is a trap. It
 * requires the closing `*\/` to be followed by `}`, so when the nearest one
 * is not, it keeps scanning for a later `*\/` that is and swallows every line
 * in between. Measured on components/order-builder-view.tsx: 118 characters
 * of real code gone, silently, which is how a source assertion passes for a
 * reason that has nothing to do with the code under test.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { roomSurfaceTemplate } from "@/lib/supplier-order/multi-room";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

describe("the template Kate specified", () => {
  it("matches the shape in her PDF", () => {
    expect(roomSurfaceTemplate(["primary bedroom", "bedroom 2"], ["Walls", "Ceiling", "Trim"]))
      .toBe(
        "Primary Bedroom\nWalls:\nCeiling:\nTrim:\n\nBedroom 2\nWalls:\nCeiling:\nTrim:"
      );
  });

  it("title-cases the detected room names", () => {
    expect(roomSurfaceTemplate(["upstairs hallway", "bathroom"], ["Ceiling"]))
      .toContain("Upstairs Hallway");
  });

  it("falls back to a plain Color line when the WOLI lists no surfaces", () => {
    expect(roomSurfaceTemplate(["kitchen", "pantry"], [])).toBe("Kitchen\nColor:\n\nPantry\nColor:");
  });

  it("produces nothing for a single room — there is no list to give", () => {
    expect(roomSurfaceTemplate(["kitchen"], ["Walls"])).toBe("");
    expect(roomSurfaceTemplate([], ["Walls"])).toBe("");
  });
});

describe("the notice on the customer's form", () => {
  const src = () => strip(read("components/customer-form-view.tsx"));

  it("tells the customer the line covers several rooms", () => {
    expect(src()).toMatch(/isMultiRoom && \(/);
    expect(src()).toContain("This line covers {multiRooms.length} rooms");
  });

  it("detects from the rep's scope note, interior only", () => {
    const s = src();
    expect(s).toMatch(/roomsNamedIn\(lineItem\.lineItemNotes\)/);
    expect(s).toMatch(/isInteriorLine\(lineItem\.productFamily\)/);
  });

  it("does NOT pre-fill the textarea", () => {
    // Seeding this box from Salesforce was tried and reverted on 2026-06-09:
    // the Description is PPP's quote boilerplate and it confused customers.
    // A skeleton nobody touched would also submit as if they had written it.
    const s = src();
    expect(s).not.toMatch(/value=\{[^}]*roomSurfaceTemplate/);
    expect(s).not.toMatch(/notes:\s*roomSurfaceTemplate/);
    // It goes in only on a click.
    expect(s).toMatch(/onClick=\{\(\) => onNotesChange\(roomSurfaceTemplate\(/);
  });

  it("offers the list only while the notes are empty", () => {
    // Otherwise the button would wipe what the customer already wrote.
    expect(src()).toMatch(/!state\.notes\.trim\(\) && \(/);
  });

  it("gives the box room to hold the list", () => {
    expect(src()).toMatch(/rows=\{isMultiRoom \? 8 : 2\}/);
  });

  it("runs the detection as a hook ABOVE the state guard", () => {
    // This file carries a docblock about a conditional-hook crash on a
    // customer's form mid-entry. The detection must not reintroduce it.
    const s = src();
    const hookAt = s.indexOf("const multiRooms = useMemo");
    const guardAt = s.indexOf("if (!state)");
    expect(hookAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(-1);
    expect(hookAt).toBeLessThan(guardAt);
  });
});
