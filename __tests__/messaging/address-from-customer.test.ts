import { describe, it, expect } from "vitest";
import { addressFromCustomer, addressGap } from "@/lib/messaging/address";

/**
 * customer_address was written once at enrolment, from the Salesforce lead,
 * and never again — so an address a customer typed into the thread was held
 * nowhere at all. The same hole inquiry_scope had.
 *
 * Found in the simulator on one message: "I need my whole house exterior
 * painted, I'm at 4821 Oak Lane, Dallas TX 75201". The reply was refused as
 * commitment_in_free_text, because with nowhere to put the address the model
 * tried to acknowledge it in its own words, and every number a customer sees
 * has to come from a template.
 */
describe("an address the customer typed", () => {
  it("is found in an ordinary sentence", () => {
    expect(addressFromCustomer("I need my whole house exterior painted, I'm at 4821 Oak Lane, Dallas TX 75201"))
      .toBe("4821 Oak Lane, 75201");
    expect(addressFromCustomer("12 Oak St, Garden City, NY 11530")).toBe("12 Oak St, 11530");
    expect(addressFromCustomer("the property is at 55 Hillcrest Road")).toBe("55 Hillcrest Road");
  });

  /**
   * Partial is worth keeping. addressGap then narrows the next question to
   * the half that is missing, which is exactly what A11 requires and the
   * thing it is most often breached for.
   */
  it("keeps a partial address, so the next ask is only for the gap", () => {
    expect(addressGap(addressFromCustomer("its 482 Marchmont Ave"))).toBe("zip");
    expect(addressGap(addressFromCustomer("11530"))).toBe("street");
    expect(addressGap(addressFromCustomer("12 Oak St, Garden City, NY 11530"))).toBe(null);
  });

  /**
   * THE DIRECTION THAT MATTERS. A wrong address is worse than none: it gets
   * read back to the customer as theirs and sent to an estimator.
   *
   * addressParts is not reused for this, and this is why — its street pattern
   * is a house number and any word, which reads "600 sq ft" and "2 bedrooms"
   * as street addresses. Here the street needs a street-type WORD.
   */
  it("invents nothing from the numbers a painting customer actually types", () => {
    for (const t of [
      "I need my living room and hallway painted, about 600 sq ft, walls and ceilings",
      "2 bedrooms and a bathroom",
      "10000 square feet of exterior",
      "how much for a 12x14 bedroom",
      "call me at 999 784 6046",
      "3 rooms please",
      "yes that works",
    ]) {
      expect(addressFromCustomer(t), t).toBeNull();
    }
  });
});
