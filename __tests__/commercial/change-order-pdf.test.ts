import { describe, it, expect } from "vitest";
import { renderChangeOrderPdf, type ChangeOrderPdfInput } from "@/lib/commercial/change-orders/pdf";

function base(overrides: Partial<ChangeOrderPdfInput> = {}): ChangeOrderPdfInput {
  return {
    coNumber: "CO-001",
    title: "Add second coat to lobby",
    description: "Owner requested an additional finish coat in the main lobby.",
    amountCents: 320000,
    isDeduct: false,
    status: "Approved",
    dateIso: "2026-08-14",
    accountName: "Acme GC",
    billTo: ["123 Main St", "Central Islip, NY 11722"],
    dealName: "Panera — Holbrook",
    priorContractCents: 45000000,
    revisedContractCents: 45320000,
    company: { name: "Tomco Painting", phone: "631-582-2770", website: "https://www.tomcopainting.com", signature_name: "Brendan Dwyer", signature_title: "VP" },
    logo: null,
    signature: null,
    ...overrides,
  };
}

describe("renderChangeOrderPdf", () => {
  it("renders an ADD change order with contract adjustment", async () => {
    const buf = await renderChangeOrderPdf(base());
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders a DEDUCT (credit) change order", async () => {
    const buf = await renderChangeOrderPdf(base({ amountCents: -50000, isDeduct: true, revisedContractCents: 44950000 }));
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders with no known contract (adjustment block hidden) + no description", async () => {
    const buf = await renderChangeOrderPdf(base({ priorContractCents: null, revisedContractCents: null, description: null, status: "Pending" }));
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
