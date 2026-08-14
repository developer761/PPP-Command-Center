import { describe, it, expect } from "vitest";
import { verifyFileMagicBytes } from "@/lib/commercial/accounts/documents";

const bytes = (arr: number[]) => new Uint8Array(arr);
const ascii = (s: string) => new Uint8Array(Array.from(s, (c) => c.charCodeAt(0)));

/**
 * DOC4 regression: text/plain is allowlisted for the documents flow but has no
 * magic number, so it fell through to the fail-closed default and every .txt
 * upload was rejected. It now accepts a text declaration whose head carries no
 * NUL byte, while still blocking a headerless binary renamed .txt.
 */
describe("verifyFileMagicBytes — text/plain", () => {
  it("accepts real plain text", () => {
    expect(verifyFileMagicBytes(ascii("hello, this is a note\nline two"), "text/plain")).toEqual({ ok: true });
  });

  it("rejects a binary (NUL bytes) declared as text/plain", () => {
    const r = verifyFileMagicBytes(bytes([0x68, 0x00, 0x69, 0x00, 0x00, 0x00]), "text/plain");
    expect(r.ok).toBe(false);
  });

  it("still rejects an executable even when declared text/plain (caught by its own signature)", () => {
    const r = verifyFileMagicBytes(bytes([0x4d, 0x5a, 0x90, 0x00]), "text/plain");
    expect(r.ok).toBe(false);
  });

  it("still verifies a PDF against its declared type (unchanged)", () => {
    expect(verifyFileMagicBytes(ascii("%PDF-1.7"), "application/pdf")).toEqual({ ok: true });
  });
});
