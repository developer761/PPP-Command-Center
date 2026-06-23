import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for lib/commercial/email-archive/address.ts — HMAC build +
 * verify, address parsing, spoofing resistance.
 *
 * Why this matters: Stage 2 audits caught 4 bugs in this file that
 * would have killed the entire BCC archive feature on day one:
 *   - .ilike on UUID column (dead-on-arrival)
 *   - HMAC entropy too low at 6 hex chars
 *   - Display-name forms ("Alex" <a@b>) silently rejected
 *   - Sanitizer bypass via entity-encoded URL schemes
 *
 * These tests lock in the fixes so future refactors can't regress.
 */

const FIXED_SECRET = "test-secret-for-vitest-32-chars-long-1234567890";

// Re-import the module fresh on each test so env-var reads at module
// load take effect. vi.resetModules() is the ESM-safe equivalent of
// delete require.cache. We can't just change process.env mid-test —
// the module captured the values at import time.
async function reimportAddress() {
  vi.resetModules();
  return await import("@/lib/commercial/email-archive/address");
}

describe("address.ts — HMAC roundtrip + spoofing", () => {
  beforeEach(() => {
    process.env.COMMERCIAL_ARCHIVE_HMAC_SECRET = FIXED_SECRET;
    process.env.COMMERCIAL_ARCHIVE_LOCAL = "orders";
    process.env.COMMERCIAL_ARCHIVE_DOMAIN = "orders.precisionpaintingplus.net";
  });

  it("buildArchiveAddress + verifyArchiveHmac round-trips for opp kind", async () => {
    const { buildArchiveAddress, verifyArchiveHmac } = await reimportAddress();
    const oppId = "abcd1234-1111-2222-3333-444444444444";
    const addr = buildArchiveAddress("opp", oppId);
    expect(addr).not.toBeNull();
    expect(addr).toMatch(/^orders\+archive-opp-abcd1234-[0-9a-f]{10}@orders\.precisionpaintingplus\.net$/);
    expect(verifyArchiveHmac(addr!, oppId)).toBe(true);
  });

  it("buildArchiveAddress + verifyArchiveHmac round-trips for acc kind", async () => {
    const { buildArchiveAddress, verifyArchiveHmac } = await reimportAddress();
    const accId = "deadbeef-5555-6666-7777-888888888888";
    const addr = buildArchiveAddress("acc", accId);
    expect(addr).not.toBeNull();
    expect(verifyArchiveHmac(addr!, accId)).toBe(true);
  });

  it("rejects HMAC for wrong UUID (spoofing attempt)", async () => {
    const { buildArchiveAddress, verifyArchiveHmac } = await reimportAddress();
    const correctId = "abcd1234-1111-2222-3333-444444444444";
    const wrongId = "abcd1234-aaaa-bbbb-cccc-dddddddddddd"; // same shortId, different UUID
    const addr = buildArchiveAddress("opp", correctId)!;
    expect(verifyArchiveHmac(addr, wrongId)).toBe(false);
  });

  it("rejects HMAC for completely different shortId", async () => {
    const { buildArchiveAddress, verifyArchiveHmac } = await reimportAddress();
    const addr = buildArchiveAddress("opp", "abcd1234-1111-2222-3333-444444444444")!;
    expect(verifyArchiveHmac(addr, "ffff9999-1111-2222-3333-444444444444")).toBe(false);
  });

  it("returns null when HMAC secret is unset", async () => {
    process.env.COMMERCIAL_ARCHIVE_HMAC_SECRET = "";
    const { buildArchiveAddress, isArchiveConfigured } = await reimportAddress();
    expect(isArchiveConfigured()).toBe(false);
    expect(buildArchiveAddress("opp", "abcd1234-1111-2222-3333-444444444444")).toBeNull();
  });

  it("returns null when HMAC secret is too short", async () => {
    process.env.COMMERCIAL_ARCHIVE_HMAC_SECRET = "too-short";
    const { isArchiveConfigured } = await reimportAddress();
    expect(isArchiveConfigured()).toBe(false);
  });

  it("HMAC uses 10 hex chars (40 bits of entropy)", async () => {
    const { buildArchiveAddress, parseArchiveRecipient } = await reimportAddress();
    const oppId = "abcd1234-1111-2222-3333-444444444444";
    const addr = buildArchiveAddress("opp", oppId)!;
    const parsed = parseArchiveRecipient(addr);
    expect(parsed?.providedHmac.length).toBe(10);
    expect(parsed?.providedHmac).toMatch(/^[0-9a-f]{10}$/);
  });
});

describe("parseArchiveRecipient — RFC 5322 mailbox forms", () => {
  beforeEach(() => {
    process.env.COMMERCIAL_ARCHIVE_HMAC_SECRET = FIXED_SECRET;
    process.env.COMMERCIAL_ARCHIVE_LOCAL = "orders";
    process.env.COMMERCIAL_ARCHIVE_DOMAIN = "orders.precisionpaintingplus.net";
  });

  it("parses bare email address", async () => {
    const { parseArchiveRecipient, buildArchiveAddress } = await reimportAddress();
    const addr = buildArchiveAddress("opp", "abcd1234-1111-2222-3333-444444444444")!;
    const parsed = parseArchiveRecipient(addr);
    expect(parsed?.kind).toBe("opp");
    expect(parsed?.shortId).toBe("abcd1234");
  });

  it('parses "Display Name" <address> form', async () => {
    const { parseArchiveRecipient, buildArchiveAddress } = await reimportAddress();
    const addr = buildArchiveAddress("opp", "abcd1234-1111-2222-3333-444444444444")!;
    const wrapped = `"Alex Archive" <${addr}>`;
    const parsed = parseArchiveRecipient(wrapped);
    expect(parsed?.kind).toBe("opp");
    expect(parsed?.shortId).toBe("abcd1234");
  });

  it("parses bare <address> angle-bracket form", async () => {
    const { parseArchiveRecipient, buildArchiveAddress } = await reimportAddress();
    const addr = buildArchiveAddress("opp", "abcd1234-1111-2222-3333-444444444444")!;
    const wrapped = `<${addr}>`;
    const parsed = parseArchiveRecipient(wrapped);
    expect(parsed?.kind).toBe("opp");
    expect(parsed?.shortId).toBe("abcd1234");
  });

  it("rejects address from wrong domain", async () => {
    const { parseArchiveRecipient } = await reimportAddress();
    const wrong = "orders+archive-opp-abcd1234-1f2e3d4a5b@evil.com";
    expect(parseArchiveRecipient(wrong)).toBeNull();
  });

  it("rejects malformed HMAC (non-hex chars)", async () => {
    const { parseArchiveRecipient } = await reimportAddress();
    const malformed =
      "orders+archive-opp-abcd1234-zzzzzzzzzz@orders.precisionpaintingplus.net";
    expect(parseArchiveRecipient(malformed)).toBeNull();
  });

  it("rejects wrong-length HMAC (6 chars, old format)", async () => {
    const { parseArchiveRecipient } = await reimportAddress();
    const oldFormat =
      "orders+archive-opp-abcd1234-1f2e3d@orders.precisionpaintingplus.net";
    expect(parseArchiveRecipient(oldFormat)).toBeNull();
  });

  it("rejects wrong kind (not opp or acc)", async () => {
    const { parseArchiveRecipient } = await reimportAddress();
    const wrong =
      "orders+archive-foo-abcd1234-1f2e3d4a5b@orders.precisionpaintingplus.net";
    expect(parseArchiveRecipient(wrong)).toBeNull();
  });

  it("is case-insensitive (uppercase domain works)", async () => {
    const { parseArchiveRecipient, buildArchiveAddress } = await reimportAddress();
    const addr = buildArchiveAddress("opp", "abcd1234-1111-2222-3333-444444444444")!;
    const upper = addr.toUpperCase();
    const parsed = parseArchiveRecipient(upper);
    expect(parsed?.kind).toBe("opp");
  });

  it("rejects empty input gracefully", async () => {
    const { parseArchiveRecipient } = await reimportAddress();
    expect(parseArchiveRecipient("")).toBeNull();
    expect(parseArchiveRecipient(" ")).toBeNull();
  });
});

describe("extractEmail — display-name normalization", () => {
  it('extracts "Alex" <a@b>', async () => {
    const { extractEmail } = await reimportAddress();
    expect(extractEmail('"Alex" <a@b.com>')).toBe("a@b.com");
  });

  it("extracts <a@b>", async () => {
    const { extractEmail } = await reimportAddress();
    expect(extractEmail("<a@b.com>")).toBe("a@b.com");
  });

  it("lowercases ALL UPPERCASE input", async () => {
    const { extractEmail } = await reimportAddress();
    expect(extractEmail("ALEX@PRECISIONPAINTINGPLUS.COM")).toBe(
      "alex@precisionpaintingplus.com"
    );
  });

  it("trims whitespace", async () => {
    const { extractEmail } = await reimportAddress();
    expect(extractEmail("  a@b.com  ")).toBe("a@b.com");
  });

  it("returns empty string on empty input", async () => {
    const { extractEmail } = await reimportAddress();
    expect(extractEmail("")).toBe("");
  });
});
