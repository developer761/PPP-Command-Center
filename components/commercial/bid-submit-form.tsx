"use client";

/**
 * Public online bid form (R6). A GC fills this to submit an RFP → POSTs to
 * /api/commercial/bid-submit which creates the opportunity + notifies the team.
 * No auth. Uncontrolled inputs read via FormData on submit; the DateField +
 * (optional) Turnstile widget each write a hidden input the FormData picks up.
 */

import { useEffect, useState } from "react";
import { DateField } from "@/components/commercial/date-field";

const LABEL = "block text-[12.5px] font-semibold text-ppp-charcoal-700 mb-1";
const INPUT =
  "w-full rounded-lg border border-ppp-charcoal-200 bg-surface px-3 py-2.5 text-base sm:text-[14px] text-ppp-charcoal placeholder:text-ppp-charcoal-400 focus:border-cc-brand-500 focus:ring-1 focus:ring-cc-brand-500 outline-none min-h-[44px]";

export function BidSubmitForm({ turnstileSiteKey }: { turnstileSiteKey?: string }) {
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  // Load the Turnstile widget script only when a site key is configured.
  useEffect(() => {
    if (!turnstileSiteKey) return;
    if (document.querySelector('script[data-turnstile]')) return;
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    s.async = true;
    s.defer = true;
    s.setAttribute("data-turnstile", "1");
    document.head.appendChild(s);
  }, [turnstileSiteKey]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === "submitting") return;
    const fd = new FormData(e.currentTarget);
    const payload = {
      company: fd.get("company"),
      contact_name: fd.get("contact_name"),
      email: fd.get("email"),
      phone: fd.get("phone"),
      project_title: fd.get("project_title"),
      street: fd.get("street"),
      city: fd.get("city"),
      state: fd.get("state"),
      bid_due_date: fd.get("bid_due_date"),
      details: fd.get("details"),
      company_url: fd.get("company_url"), // honeypot
      turnstile_token: fd.get("cf-turnstile-response"),
    };
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch("/api/commercial/bid-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && json.ok) {
        setStatus("success");
      } else {
        setStatus("error");
        setError(json.error ?? "Something went wrong — please try again.");
      }
    } catch {
      setStatus("error");
      setError("Network error — please try again.");
    }
  }

  if (status === "success") {
    return (
      <div className="text-center py-10">
        <div className="mx-auto mb-4 inline-flex items-center justify-center h-14 w-14 rounded-full bg-ppp-green-50 text-ppp-green-700">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
        </div>
        <h2 className="text-lg font-bold text-ppp-charcoal">Thanks — we&rsquo;ve got it.</h2>
        <p className="text-[13.5px] text-ppp-charcoal-500 mt-1.5 max-w-sm mx-auto">
          Your bid request is in front of our team. We&rsquo;ll be in touch shortly at the email you gave us.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {/* Honeypot — hidden from humans; bots fill it and get silently dropped. */}
      <div aria-hidden className="absolute -left-[9999px] top-0 h-0 w-0 overflow-hidden">
        <label>Company URL<input type="text" name="company_url" tabIndex={-1} autoComplete="off" /></label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={LABEL} htmlFor="bf-company">Your company *</label>
          <input id="bf-company" name="company" required maxLength={200} autoComplete="organization" placeholder="e.g. Turner Construction" className={INPUT} />
        </div>
        <div>
          <label className={LABEL} htmlFor="bf-name">Your name *</label>
          <input id="bf-name" name="contact_name" required maxLength={200} autoComplete="name" placeholder="Jane Doe" className={INPUT} />
        </div>
        <div>
          <label className={LABEL} htmlFor="bf-email">Email *</label>
          <input id="bf-email" name="email" type="email" required maxLength={200} autoComplete="email" placeholder="jane@company.com" className={INPUT} />
        </div>
        <div>
          <label className={LABEL} htmlFor="bf-phone">Phone</label>
          <input id="bf-phone" name="phone" type="tel" maxLength={60} autoComplete="tel" placeholder="(516) 555-1234" className={INPUT} />
        </div>
      </div>

      <div className="border-t border-ppp-charcoal-100 pt-5 space-y-4">
        <div>
          <label className={LABEL} htmlFor="bf-project">Project name</label>
          <input id="bf-project" name="project_title" maxLength={200} placeholder="e.g. Warehouse repaint — Building C" className={INPUT} />
        </div>
        <div>
          <label className={LABEL} htmlFor="bf-street">Street address</label>
          <input id="bf-street" name="street" maxLength={200} autoComplete="address-line1" placeholder="123 Industrial Pkwy" className={INPUT} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="sm:col-span-1">
            <label className={LABEL} htmlFor="bf-city">City</label>
            <input id="bf-city" name="city" maxLength={120} placeholder="Central Islip" className={INPUT} />
          </div>
          <div>
            <label className={LABEL} htmlFor="bf-state">State</label>
            <input id="bf-state" name="state" maxLength={60} placeholder="NY" className={INPUT} />
          </div>
          <div>
            <span className={LABEL}>Bid due</span>
            <DateField ariaLabel="Bid due date" name="bid_due_date" placeholder="Pick a date" />
          </div>
        </div>
        <div>
          <label className={LABEL} htmlFor="bf-details">Project details</label>
          <textarea id="bf-details" name="details" rows={4} maxLength={4000} placeholder="Scope, square footage, timeline, anything that helps us bid it right…" className={`${INPUT} min-h-[100px] resize-y`} />
        </div>
      </div>

      {turnstileSiteKey && (
        <div className="cf-turnstile" data-sitekey={turnstileSiteKey} />
      )}

      {status === "error" && error && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-[13px] text-rose-700" role="alert">{error}</div>
      )}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="w-full inline-flex items-center justify-center rounded-lg bg-cc-brand-600 px-4 py-3 text-[15px] font-semibold text-white hover:bg-cc-brand-700 disabled:opacity-60 min-h-[48px]"
      >
        {status === "submitting" ? "Sending…" : "Submit bid request"}
      </button>
      <p className="text-[11.5px] text-ppp-charcoal-400 text-center">We&rsquo;ll only use this to respond to your request.</p>
    </form>
  );
}
