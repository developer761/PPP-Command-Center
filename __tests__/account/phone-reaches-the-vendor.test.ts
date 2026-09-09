import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Karan 2026-09-09: "who should the supplier call — it should be the person
 * who's logged in, and we can add numbers by going to the profile, account
 * settings, save a number there, and it should always populate in the email."
 *
 * Almost all of that already existed and had never worked, which is the
 * interesting part. `profiles.phone` shipped in migration 145; loadViewerContact
 * reads it; the vendor email prints it in the contact block. Nothing anywhere
 * WROTE to it — so the column was empty for every user but one, whose row had
 * been set directly, and every order went out with no number.
 *
 * A chain is only as shipped as its missing link. These assert the whole chain,
 * not the new file.
 */
const ROOT = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

describe("the chain from account settings to the vendor email", () => {
  it("1. account settings offers the field", () => {
    const page = read("app/dashboard/account/page.tsx");
    expect(page).toMatch(/<AccountPhoneForm initial=/);
  });

  it("2. saving writes to the signed-in user's OWN row", () => {
    const route = read("app/api/account/phone/route.ts");
    // No user_id in the body: a person edits their own number and nobody
    // else's, which is why this can sit outside the admin routes.
    expect(route).toMatch(/\.eq\("user_id", data\.user\.id\)/);
    expect(route).not.toMatch(/body\.user_id|body\.userId/);
  });

  it("3. an empty value CLEARS it rather than being rejected", () => {
    // Someone who mistypes must be able to remove the number, not be stuck
    // with a wrong one going out on every order.
    expect(read("app/api/account/phone/route.ts")).toMatch(/phone: raw \|\| null/);
  });

  it("4. the order page reads it back", () => {
    const page = read("app/dashboard/materials/[woId]/order/[supplierId]/page.tsx");
    expect(page).toMatch(/\.select\("phone"\)/);
    expect(page).toMatch(/viewerPhone=\{contact\.phone\}/);
  });

  it("5. it seeds the contact field on the fulfilment step", () => {
    expect(read("components/order-fulfillment-view.tsx")).toMatch(
      /useState\(savedFulfillment\.contactPhone \|\| \(viewerPhone \?\? ""\)\)/
    );
  });

  it("6. and reaches the vendor email", () => {
    expect(read("lib/supplier-order/builder.ts")).toMatch(/contact_phone: \(input\.contactPhone \?\? ""\)/);
  });

  it("the Profile type carries it, so the read is not silently undefined", () => {
    expect(read("lib/auth/profile.ts")).toMatch(/phone\?: string \| null;/);
  });
});
