"use client";

import { useState } from "react";
import PageHeader from "@/components/page-header";

/**
 * Admin tool for testing the customer color form by Work Order ID.
 *
 * Two modes:
 *   1. Preview — generates a kind="preview" token (24h, no email, no SF
 *      writes on submit), opens the form in a new tab.
 *   2. Send — creates a real customer-form token, sends an invitation
 *      email to the given address, and surfaces the form URL so the
 *      admin can click through immediately without waiting for the email.
 *
 * Bypasses the materials view's WO filter — useful when Katie's test WOs
 * don't appear there (no line items, status filter, work-type filter, etc.).
 *
 * Surfaces error responses verbatim so the admin can diagnose
 * "wo_not_found_in_sf" / "invalid_work_order_id" / etc. inline. Also
 * displays the WO ID's character count to catch invisible characters.
 */
export default function TestFormView({ userEmail }: { userEmail: string }) {
  const [woId, setWoId] = useState("");
  const [email, setEmail] = useState(userEmail);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState<"preview" | "send" | null>(null);
  const [result, setResult] = useState<{
    ok: boolean;
    formUrl?: string;
    error?: string;
    raw?: unknown;
    mode: "preview" | "send";
  } | null>(null);

  const trimmedId = woId.trim();
  // Accept BOTH formats:
  //   - 15/18-char Salesforce record Id ("0WOWj000005e9L3OAI")
  //   - WO number ("00284666" / digits only)
  // The /api/admin/wo-resolve endpoint normalizes either to the canonical Id.
  const looksLikeSfId = /^[a-zA-Z0-9]{15,18}$/.test(trimmedId);
  const looksLikeWoNumber = /^\d{4,15}$/.test(trimmedId.replace(/\s+/g, ""));
  const inputUsable = looksLikeSfId || looksLikeWoNumber;

  /** Normalize whatever's in the input box to the canonical 18-char SF Id.
   *  Returns null + sets result on failure. */
  const resolveToSfId = async (mode: "preview" | "send"): Promise<string | null> => {
    if (looksLikeSfId) return trimmedId; // already canonical, skip the round-trip
    try {
      const res = await fetch(`/api/admin/wo-resolve?q=${encodeURIComponent(trimmedId)}`);
      const data = await res.json();
      if (!res.ok || !data.ok || !data.id) {
        setResult({
          ok: false,
          error: data.message ?? data.error ?? `Couldn't resolve "${trimmedId}" to a WO`,
          raw: data,
          mode,
        });
        return null;
      }
      return data.id as string;
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err), mode });
      return null;
    }
  };

  const onPreview = async () => {
    if (!inputUsable || loading) return;
    setLoading("preview");
    setResult(null);
    const sfId = await resolveToSfId("preview");
    if (!sfId) {
      setLoading(null);
      return;
    }
    // Reserve the popup synchronously inside the click. CRITICAL: don't
    // pass `noopener` — those flags strip our reference to the new tab,
    // making win.location.href silently a no-op (the tab stays on
    // about:blank). Without noopener the new tab inherits an opener
    // reference back to us — fine for an admin-only tool. Audit 2026-06-04.
    const win = window.open("about:blank", "_blank");
    try {
      const res = await fetch("/api/admin/customer-form/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workOrderId: sfId }),
      });
      const data = await res.json();
      setResult({
        ok: !!data.ok,
        formUrl: typeof data.formUrl === "string" ? data.formUrl : undefined,
        error: !data.ok ? (data.message ?? data.error ?? `HTTP ${res.status}`) : undefined,
        raw: data,
        mode: "preview",
      });
      if (data.ok && data.formUrl && win) {
        win.location.href = data.formUrl;
      } else if (win) {
        // Replace about:blank with a small error page so admin sees what
        // went wrong if they look at the popup before noticing the inline
        // result on the main page.
        try {
          win.document.write(`<title>Preview failed</title><body style="font-family:system-ui;padding:2rem;color:#c0392b"><h2>Preview couldn't open</h2><p>${data.message ?? data.error ?? "Unknown error"}</p><p>Check the Test Color Form tab for details.</p></body>`);
          setTimeout(() => { try { win.close(); } catch { /* close blocked by browser; leave the error page */ } }, 8000);
        } catch {
          // Cross-origin write blocked — at minimum try to close
          try { win.close(); } catch { /* noop */ }
        }
      }
    } catch (err) {
      if (win) try { win.close(); } catch { /* noop */ }
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err), mode: "preview" });
    } finally {
      setLoading(null);
    }
  };

  const onSend = async () => {
    if (!inputUsable || loading) return;
    if (!email.trim() || !email.includes("@")) {
      setResult({ ok: false, error: "Email looks invalid — needs an @ and a domain.", mode: "send" });
      return;
    }
    setLoading("send");
    setResult(null);
    const sfId = await resolveToSfId("send");
    if (!sfId) {
      setLoading(null);
      return;
    }
    try {
      const res = await fetch("/api/admin/customer-form/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workOrderId: sfId,
          customerEmail: email.trim(),
          customerName: name.trim() || undefined,
        }),
      });
      const data = await res.json();
      setResult({
        ok: !!data.ok,
        formUrl: typeof data.formUrl === "string" ? data.formUrl : undefined,
        error: !data.ok ? (data.message ?? data.error ?? `HTTP ${res.status}`) : undefined,
        raw: data,
        mode: "send",
      });
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err), mode: "send" });
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-6">
      <PageHeader
        title="Test the customer color form"
        subtitle="Paste either a Salesforce record Id (starts with 0WO) or a WO number (digits only). Preview opens the form in a new tab without sending an email or writing to Salesforce. Send creates a real form, emails the invite, and shows you the URL to click through immediately."
      />

      <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-6 space-y-4">
        <div>
          <label className="block text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-1">
            Work Order — paste either format
          </label>
          <input
            type="text"
            value={woId}
            onChange={(e) => setWoId(e.target.value)}
            placeholder="0WOWj000005e9L3OAI  or  00284666"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className={`w-full px-3 py-2.5 text-base sm:text-sm font-mono border rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue ${
              trimmedId === ""
                ? "border-ppp-charcoal-100"
                : inputUsable
                ? "border-ppp-green-300 bg-ppp-green-50"
                : "border-ppp-orange-300 bg-ppp-orange-50"
            }`}
          />
          {trimmedId && (
            <p className={`text-[11px] mt-1 ${inputUsable ? "text-ppp-green-700" : "text-ppp-orange-700"}`}>
              {looksLikeSfId
                ? `✓ Looks like a Salesforce record Id (${trimmedId.length} chars)`
                : looksLikeWoNumber
                ? `✓ Looks like a WO number (${trimmedId.length} digits) — we'll look it up`
                : `✗ Doesn't match either format. Expected 15/18 alphanumeric (record Id) or all digits (WO number). Check for hidden whitespace or typos.`}
            </p>
          )}
          <p className="text-[10px] text-ppp-charcoal-500 mt-1.5 leading-relaxed">
            <strong>Record Id</strong> (18 chars, starts with <code className="font-mono">0WO</code>) is what shows in the Salesforce URL. <strong>WO number</strong> (digits like <code className="font-mono">00284666</code>) is what shows in the materials list. Either works.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-1">
              Send to email (for Send mode)
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              spellCheck={false}
              className="w-full px-3 py-2.5 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
            />
          </div>
          <div>
            <label className="block text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-1">
              Customer name (optional)
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Defaults to SF account name"
              autoCorrect="off"
              autoCapitalize="words"
              spellCheck={false}
              className="w-full px-3 py-2.5 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <button
            type="button"
            onClick={onPreview}
            disabled={!inputUsable || loading !== null}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-ppp-charcoal-100 bg-white text-sm font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading === "preview" ? "Opening…" : "Preview (no email, no SF writes)"}
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={!inputUsable || loading !== null}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm shadow-ppp-blue/30"
          >
            {loading === "send" ? "Sending…" : "Send real form (writes to SF if WO is on allowlist)"}
          </button>
        </div>
      </div>

      {result && (
        <div className={`border rounded-2xl p-5 ${result.ok ? "border-ppp-green-200 bg-ppp-green-50" : "border-ppp-orange-200 bg-ppp-orange-50"}`}>
          <div className={`font-semibold text-sm ${result.ok ? "text-ppp-green-700" : "text-ppp-orange-700"}`}>
            {result.ok
              ? result.mode === "preview"
                ? "✓ Preview created — form opened in a new tab."
                : "✓ Real form created + email sent."
              : `✗ ${result.mode === "preview" ? "Preview" : "Send"} failed: ${result.error}`}
          </div>
          {result.formUrl && (
            <div className="mt-3 text-xs">
              <div className="text-ppp-charcoal-500 mb-1">Form URL (click to open):</div>
              <a
                href={result.formUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ppp-blue-700 hover:underline break-all font-mono"
              >
                {result.formUrl}
              </a>
            </div>
          )}
          <details className="mt-3 text-[11px]">
            <summary className="cursor-pointer text-ppp-charcoal-500 hover:text-ppp-charcoal-700">Raw response</summary>
            <pre className="mt-2 p-3 bg-white border border-ppp-charcoal-100 rounded-lg overflow-x-auto font-mono text-[10px] text-ppp-charcoal">
              {JSON.stringify(result.raw, null, 2)}
            </pre>
          </details>
        </div>
      )}

      <div className="text-[11px] text-ppp-charcoal-500 leading-relaxed">
        <strong>How to find a WO ID in Salesforce:</strong> open the Work Order record. The 18-character ID is at the end of the URL after <code className="font-mono">/r/WorkOrder/</code> and before <code className="font-mono">/view</code>. Starts with <code className="font-mono">0WO</code>.
      </div>
    </div>
  );
}
