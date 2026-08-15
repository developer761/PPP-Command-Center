"use client";

import * as React from "react";

/**
 * New-from-RFP client form. Paste the invitation-to-bid, hit "Extract with AI"
 * (→ /api/commercial/rfp/extract), then review/edit the pre-filled fields before
 * creating. Controlled inputs so the extraction can populate them and the person
 * can correct anything. The form itself posts to the page's create server action.
 */

type Fields = {
  title: string;
  gc_company: string;
  property_street: string;
  property_city: string;
  property_state: string;
  property_zip: string;
  bid_due_date: string;
  scope: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
};

const EMPTY: Fields = {
  title: "", gc_company: "", property_street: "", property_city: "", property_state: "",
  property_zip: "", bid_due_date: "", scope: "", contact_name: "", contact_email: "", contact_phone: "",
};

const INPUT =
  "w-full px-3 py-2 text-base sm:text-sm bg-surface border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px]";
const LABEL = "block text-[11px] font-semibold text-ppp-charcoal-600 mb-1";

export function RfpImportForm({ createAction }: { createAction: (fd: FormData) => void | Promise<void> }) {
  const [rfpText, setRfpText] = React.useState("");
  const [fields, setFields] = React.useState<Fields>(EMPTY);
  const [extracting, setExtracting] = React.useState(false);
  const [extractError, setExtractError] = React.useState<string | null>(null);
  const [extracted, setExtracted] = React.useState(false);

  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setFields((f) => ({ ...f, [k]: e.target.value }));

  async function extract() {
    setExtracting(true);
    setExtractError(null);
    try {
      const res = await fetch("/api/commercial/rfp/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: rfpText }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; extract?: Record<string, unknown> };
      if (!data.ok || !data.extract) {
        setExtractError(data.error || "Couldn't extract the fields — fill them in below.");
        setExtracted(true); // still reveal the form so they can type
        return;
      }
      const x = data.extract;
      const str = (v: unknown) => (typeof v === "string" ? v : "");
      setFields({
        title: str(x.title),
        gc_company: str(x.gcCompany),
        property_street: str(x.propertyStreet),
        property_city: str(x.propertyCity),
        property_state: str(x.propertyState),
        property_zip: str(x.propertyZip),
        bid_due_date: str(x.bidDueDate),
        scope: str(x.scope),
        contact_name: str(x.contactName),
        contact_email: str(x.contactEmail),
        contact_phone: str(x.contactPhone),
      });
      setExtracted(true);
    } catch {
      setExtractError("Couldn't reach the extractor — fill the fields in below.");
      setExtracted(true);
    } finally {
      setExtracting(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Paste + extract */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 space-y-3">
        <label className={LABEL} htmlFor="rfp-text">Paste the RFP / invitation-to-bid email</label>
        <textarea
          id="rfp-text"
          value={rfpText}
          onChange={(e) => setRfpText(e.target.value)}
          rows={8}
          placeholder="Paste the full email here — subject, body, signature. Claude pulls out the project, GC, address, bid due date, scope, and contact."
          className="w-full px-3 py-2 text-sm bg-surface border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600"
        />
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={extract}
            disabled={extracting || rfpText.trim().length < 20}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2L12 3z" /></svg>
            {extracting ? "Extracting…" : "Extract with AI"}
          </button>
          {!extracted && (
            <button type="button" onClick={() => setExtracted(true)} className="text-[12px] font-semibold text-ppp-charcoal-500 hover:text-ppp-charcoal underline underline-offset-2">
              or fill it in by hand
            </button>
          )}
        </div>
        {extractError && <p className="text-[12px] text-amber-700">{extractError}</p>}
      </section>

      {/* Review + create */}
      {extracted && (
        <form action={createAction} className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 space-y-3">
          <p className="text-[12px] text-ppp-charcoal-500">Review and fix anything before creating. The GC is matched to an existing account or a new one is created.</p>
          <div>
            <label className={LABEL} htmlFor="f-title">Project title <span className="text-rose-600">*</span></label>
            <input id="f-title" name="title" required value={fields.title} onChange={set("title")} maxLength={200} className={INPUT} />
          </div>
          <div>
            <label className={LABEL} htmlFor="f-gc">General contractor (company) <span className="text-rose-600">*</span></label>
            <input id="f-gc" name="gc_company" required value={fields.gc_company} onChange={set("gc_company")} maxLength={200} className={INPUT} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={LABEL} htmlFor="f-street">Job site street</label>
              <input id="f-street" name="property_street" value={fields.property_street} onChange={set("property_street")} maxLength={200} className={INPUT} />
            </div>
            <div>
              <label className={LABEL} htmlFor="f-due">Bid due date</label>
              <input id="f-due" name="bid_due_date" type="date" value={fields.bid_due_date} onChange={set("bid_due_date")} className={INPUT} />
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="col-span-2 sm:col-span-1">
              <label className={LABEL} htmlFor="f-city">City</label>
              <input id="f-city" name="property_city" value={fields.property_city} onChange={set("property_city")} maxLength={120} className={INPUT} />
            </div>
            <div>
              <label className={LABEL} htmlFor="f-state">State</label>
              <input id="f-state" name="property_state" value={fields.property_state} onChange={set("property_state")} maxLength={60} className={INPUT} />
            </div>
            <div>
              <label className={LABEL} htmlFor="f-zip">ZIP</label>
              <input id="f-zip" name="property_zip" value={fields.property_zip} onChange={set("property_zip")} maxLength={20} className={INPUT} />
            </div>
          </div>
          <div>
            <label className={LABEL} htmlFor="f-scope">Scope</label>
            <textarea id="f-scope" name="scope" value={fields.scope} onChange={set("scope")} rows={3} maxLength={4000} className="w-full px-3 py-2 text-sm bg-surface border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={LABEL} htmlFor="f-cn">Contact name</label>
              <input id="f-cn" name="contact_name" value={fields.contact_name} onChange={set("contact_name")} maxLength={200} className={INPUT} />
            </div>
            <div>
              <label className={LABEL} htmlFor="f-ce">Contact email</label>
              <input id="f-ce" name="contact_email" type="email" value={fields.contact_email} onChange={set("contact_email")} maxLength={200} className={INPUT} />
            </div>
            <div>
              <label className={LABEL} htmlFor="f-cp">Contact phone</label>
              <input id="f-cp" name="contact_phone" value={fields.contact_phone} onChange={set("contact_phone")} maxLength={60} className={INPUT} />
            </div>
          </div>
          <div className="pt-1">
            <button type="submit" className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px]">
              Create opportunity
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
