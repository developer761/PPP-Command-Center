import "server-only";

import { createHash, randomBytes } from "node:crypto";

/**
 * Signing-link tokens. 32 random bytes as base64url (43 chars) in the URL;
 * only the sha256 is stored. Looking a link up means hashing what arrived and
 * matching the hash, so the database never holds a working link.
 */
export function generateSignatureToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashSignatureToken(token) };
}

export function hashSignatureToken(token: string): string {
  return sha256Hex(Buffer.from(token, "utf8"));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
