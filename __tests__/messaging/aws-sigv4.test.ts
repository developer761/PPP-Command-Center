import { describe, it, expect } from "vitest";
import { signRequest, canonicalRequest, amzDate } from "@/lib/messaging/aws-sigv4";

/**
 * Checked against AWS's published SigV4 test suite (get-vanilla). Using their
 * vector rather than our own output is the point: a test that asserts the code
 * produces what the code produces would pass with the algorithm wrong.
 */
const VECTOR = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
  amzDate: "20150830T123600Z",
};

describe("SigV4", () => {
  it("matches AWS's own get-vanilla vector", () => {
    const { signature } = signRequest({
      ...VECTOR,
      method: "GET",
      path: "/",
      query: "",
      headers: { Host: "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z" },
      body: "",
    });
    expect(signature).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });

  it("sorts and lowercases headers, because AWS requires it byte for byte", () => {
    const { canonical, signedHeaders } = canonicalRequest({
      ...VECTOR, method: "POST", path: "/", body: "{}",
      headers: { "X-Amz-Target": "b", Host: "h", "Content-Type": "a" },
    });
    expect(signedHeaders).toBe("content-type;host;x-amz-target");
    expect(canonical).toContain("content-type:a\nhost:h\nx-amz-target:b\n");
  });

  it("collapses runs of whitespace in header values", () => {
    const { canonical } = canonicalRequest({
      ...VECTOR, method: "POST", path: "/", body: "",
      headers: { Host: "  a   b  " },
    });
    expect(canonical).toContain("host:a b\n");
  });

  it("produces a different signature for a different body", () => {
    const one = signRequest({ ...VECTOR, method: "POST", path: "/", headers: { Host: "h" }, body: '{"a":1}' });
    const two = signRequest({ ...VECTOR, method: "POST", path: "/", headers: { Host: "h" }, body: '{"a":2}' });
    expect(one.signature).not.toBe(two.signature);
  });

  it("is deterministic for the same input", () => {
    const args = { ...VECTOR, method: "POST", path: "/", headers: { Host: "h" }, body: "{}" };
    expect(signRequest(args).signature).toBe(signRequest(args).signature);
  });

  it("names the credential scope in the authorization header", () => {
    const { authorization } = signRequest({ ...VECTOR, method: "GET", path: "/", headers: { Host: "h" }, body: "" });
    expect(authorization).toContain("Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request");
    expect(authorization.startsWith("AWS4-HMAC-SHA256 ")).toBe(true);
  });

  it("formats the timestamp the way AWS expects", () => {
    expect(amzDate(new Date("2026-09-08T13:15:00.123Z"))).toBe("20260908T131500Z");
  });
});
