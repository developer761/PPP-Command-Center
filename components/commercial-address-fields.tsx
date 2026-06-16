"use client";

import { useEffect, useRef, useState } from "react";
import { INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";

/**
 * Address fields with Google Places Autocomplete. Drop-in replacement
 * for the 4-input Street / City / State / ZIP block in the account
 * new + edit forms.
 *
 * If NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is set, the Street input gets a
 * dropdown of address suggestions as the user types. Picking one
 * auto-fills the other three fields (city, state, zip).
 *
 * If the key is NOT set, the inputs render as plain text — same shape,
 * same form-submit behavior. Nothing breaks; the autocomplete just
 * isn't active. So this component is safe to deploy before the key
 * lands in Vercel.
 *
 * Props:
 *   - `prefix`: "billing" or "site" — controls input names (billing_street etc.)
 *   - `defaults`: optional initial values for edit-form prefills
 */

type Defaults = {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
};

export default function CommercialAddressFields({
  prefix,
  defaults,
}: {
  prefix: "billing" | "site";
  defaults?: Defaults;
}) {
  const [street, setStreet] = useState(defaults?.street ?? "");
  const [city, setCity] = useState(defaults?.city ?? "");
  const [stateVal, setStateVal] = useState(defaults?.state ?? "");
  const [zip, setZip] = useState(defaults?.zip ?? "");
  const streetRef = useRef<HTMLInputElement | null>(null);
  const [scriptStatus, setScriptStatus] = useState<"unloaded" | "loading" | "ready" | "no-key">(
    "unloaded"
  );

  // Lazy-load the Google Maps JS API on first focus of the street
  // input. Defers the third-party fetch so a user who never edits an
  // address never pays the script-download cost.
  useEffect(() => {
    if (scriptStatus !== "unloaded") return;
    const input = streetRef.current;
    if (!input) return;

    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      setScriptStatus("no-key");
      return;
    }

    const onFocus = () => {
      if (scriptStatus !== "unloaded") return;
      setScriptStatus("loading");

      // If another instance of this component already loaded the
      // script, reuse it.
      const existing = document.querySelector<HTMLScriptElement>(
        'script[data-commercial-gmaps="1"]'
      );
      if (existing) {
        // The script may still be loading; wire up a one-shot listener.
        if ((window as unknown as { google?: { maps?: { places?: unknown } } }).google?.maps?.places) {
          setScriptStatus("ready");
        } else {
          existing.addEventListener("load", () => setScriptStatus("ready"));
        }
        return;
      }
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
        apiKey
      )}&libraries=places&v=weekly`;
      script.async = true;
      script.defer = true;
      script.dataset.commercialGmaps = "1";
      script.onload = () => setScriptStatus("ready");
      script.onerror = () => setScriptStatus("no-key"); // fall back if blocked
      document.head.appendChild(script);
    };
    input.addEventListener("focus", onFocus, { once: true });
    return () => input.removeEventListener("focus", onFocus);
  }, [scriptStatus]);

  // Once the script is ready, attach Autocomplete to the street input.
  useEffect(() => {
    if (scriptStatus !== "ready") return;
    const input = streetRef.current;
    const g = (window as unknown as {
      google?: {
        maps?: {
          places?: {
            Autocomplete: new (
              input: HTMLInputElement,
              opts: { types?: string[]; componentRestrictions?: { country: string[] } }
            ) => {
              addListener: (event: string, cb: () => void) => void;
              getPlace: () => {
                address_components?: Array<{
                  long_name: string;
                  short_name: string;
                  types: string[];
                }>;
              };
            };
          };
        };
      };
    }).google;
    if (!input || !g?.maps?.places) return;
    // Wrap in try/catch — Autocomplete can throw on quota exceeded,
    // billing not enabled, or transient script issues. The input still
    // works as a plain text field; we just lose the autofill dropdown.
    try {
      const ac = new g.maps.places.Autocomplete(input, {
        types: ["address"],
        componentRestrictions: { country: ["us"] },
      });
      ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        const parts = place.address_components ?? [];
        let streetNumber = "";
        let route = "";
        let cityVal = "";
        let stateAbbr = "";
        let zipVal = "";
        for (const c of parts) {
          if (c.types.includes("street_number")) streetNumber = c.long_name;
          if (c.types.includes("route")) route = c.long_name;
          if (c.types.includes("locality")) cityVal = c.long_name;
          if (c.types.includes("administrative_area_level_1")) stateAbbr = c.short_name;
          if (c.types.includes("postal_code")) zipVal = c.long_name;
        }
        const combined = [streetNumber, route].filter(Boolean).join(" ");
        if (combined) setStreet(combined);
        if (cityVal) setCity(cityVal);
        if (stateAbbr) setStateVal(stateAbbr);
        if (zipVal) setZip(zipVal);
      });
    } catch (err) {
      console.warn("[commercial/address-fields] Autocomplete init failed:", err);
      // Downgrade the badge so the user knows manual entry is the path.
      setScriptStatus("no-key");
    }
    // Cleanup not strictly required — Autocomplete listeners are
    // garbage-collected when the input unmounts.
  }, [scriptStatus]);

  return (
    <>
      <div>
        <label htmlFor={`${prefix}_street`} className={LABEL_CLS}>
          Street
          {scriptStatus === "ready" && (
            <span className="ml-1.5 text-[10px] font-normal text-emerald-700 normal-case tracking-normal">
              · Autofill on
            </span>
          )}
        </label>
        <input
          ref={streetRef}
          id={`${prefix}_street`}
          name={`${prefix}_street`}
          type="text"
          value={street}
          onChange={(e) => setStreet(e.target.value)}
          placeholder={scriptStatus === "ready" ? "Start typing an address…" : ""}
          autoComplete="off"
          className={INPUT_CLS}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label htmlFor={`${prefix}_city`} className={LABEL_CLS}>
            City
          </label>
          <input
            id={`${prefix}_city`}
            name={`${prefix}_city`}
            type="text"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            className={INPUT_CLS}
          />
        </div>
        <div>
          <label htmlFor={`${prefix}_state`} className={LABEL_CLS}>
            State
          </label>
          <input
            id={`${prefix}_state`}
            name={`${prefix}_state`}
            type="text"
            value={stateVal}
            // Hard-clamp to 2 chars in JS too — `maxLength` only blocks
            // additional typing, but a fast paste or autocomplete could
            // slip a 3-char value through before re-render.
            onChange={(e) => setStateVal(e.target.value.slice(0, 2).toUpperCase())}
            maxLength={2}
            className={INPUT_CLS}
          />
        </div>
        <div>
          <label htmlFor={`${prefix}_zip`} className={LABEL_CLS}>
            ZIP
          </label>
          <input
            id={`${prefix}_zip`}
            name={`${prefix}_zip`}
            type="text"
            value={zip}
            onChange={(e) => setZip(e.target.value)}
            maxLength={10}
            className={INPUT_CLS}
          />
        </div>
      </div>
    </>
  );
}
