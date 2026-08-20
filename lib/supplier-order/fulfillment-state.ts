/**
 * The fulfilment step's own persisted state (R4.33).
 *
 * Kate: "Anything typed on the Fulfillment step — instructions, required-by,
 * pickup location, address, phone — is gone if you go back to change something
 * on the order and return." And she named the constraint herself: the one-way
 * flow from round 3 #18 is what stops an address edit from wiping typed
 * quantities, and it has to stay.
 *
 * So this lives in its own column, never inside the order payload. The
 * separation is structural rather than a convention: the build route writes
 * `payload` and only `payload`, the fulfilment route writes `fulfillment` and
 * only `fulfillment`. Neither can clobber the other even by mistake, which is
 * exactly the failure mode that produced round 3 #20/#22/#23.
 */

export type DeliveryAddress = {
  street: string;
  city: string;
  state: string;
  postalCode: string;
};

export type FulfillmentState = {
  method: "delivery" | "pickup";
  pickupLocation: string;
  deliveryAddr: DeliveryAddress;
  useCustomAddress: boolean;
  instructions: string;
  /** YYYY-MM-DD. Never trusted on read — see the clamp in the view. */
  requiredBy: string;
  contactPhone: string;
};

export function emptyFulfillmentState(): FulfillmentState {
  return {
    method: "delivery",
    pickupLocation: "",
    deliveryAddr: { street: "", city: "", state: "", postalCode: "" },
    useCustomAddress: false,
    instructions: "",
    requiredBy: "",
    contactPhone: "",
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Coerce whatever is in the column into a usable shape.
 *
 * Same reasoning as the build payload: this JSON is written by one build of the
 * app and read by every later one, so a missing or renamed key must degrade to
 * a sensible default rather than throw on a page an admin is mid-order on.
 */
export function normalizeFulfillmentState(raw: unknown): FulfillmentState {
  const base = emptyFulfillmentState();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const addr = (r.deliveryAddr && typeof r.deliveryAddr === "object"
    ? r.deliveryAddr
    : {}) as Record<string, unknown>;
  return {
    method: r.method === "pickup" ? "pickup" : "delivery",
    pickupLocation: str(r.pickupLocation),
    deliveryAddr: {
      street: str(addr.street),
      city: str(addr.city),
      state: str(addr.state),
      postalCode: str(addr.postalCode),
    },
    useCustomAddress: r.useCustomAddress === true,
    instructions: str(r.instructions),
    requiredBy: str(r.requiredBy).slice(0, 10),
    contactPhone: str(r.contactPhone),
  };
}

/** Nothing worth persisting yet — avoids writing an empty row on every mount. */
export function fulfillmentIsEmpty(s: FulfillmentState): boolean {
  const e = emptyFulfillmentState();
  return JSON.stringify(s) === JSON.stringify(e);
}
