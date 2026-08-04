"use client";

/**
 * Kim — "Send proposal" control. The primary button opens a REVIEW sheet
 * (nothing auto-sends): pick the GC recipient, review the prefilled subject +
 * message, preview the attached PDF, then either email it to the GC via Resend
 * or just mark it sent (hand-delivery / plans-portal case).
 *
 * The email path POSTs to /api/commercial/proposals/[id]/email; the mark-sent
 * path submits the existing server action passed in as `markSentAction`.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Contact = { name: string; email: string };

const LABEL = "block text-[12px] font-semibold text-ppp-charcoal-700 mb-1";
const FIELD =
  "w-full rounded-lg border border-ppp-charcoal-200 bg-surface px-3 py-2 text-[13.5px] text-ppp-charcoal focus:border-cc-brand-500 focus:ring-1 focus:ring-cc-brand-500 outline-none min-h-[44px]";

export function ProposalSendControl({
  proposalId,
  accountId,
  dealId,
  revisionNumber,
  projectName,
  gcCompany,
  contacts,
  defaultEmail,
  defaultName,
  ocName,
  pdfHref,
  markSentAction,
  resend = false,
}: {
  proposalId: string;
  accountId: string;
  dealId: string;
  revisionNumber: number;
  projectName: string | null;
  gcCompany: string | null;
  contacts: Contact[];
  defaultEmail: string | null;
  defaultName: string | null;
  ocName: string;
  pdfHref: string;
  markSentAction: (formData: FormData) => void | Promise<void>;
  /** Re-send from an already-sent proposal: hide the "mark sent" escape hatch
   *  + soften the trigger to a text button. */
  resend?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const projectLabel = projectName?.trim() || gcCompany?.trim() || "your project";
  const firstName = (defaultName ?? "").trim().split(/\s+/)[0] || "";
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState(`Proposal — ${projectLabel} · ${ocName}`);
  const [message, setMessage] = useState(
    [
      `Hi${firstName ? ` ${firstName}` : ""},`,
      "",
      `Please find our proposal for ${projectLabel} attached. We'd be glad to walk through the scope or answer any questions.`,
      "",
      "Thank you for the opportunity.",
      "",
      `— ${ocName}`,
    ].join("\n")
  );
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLElement>(null);

  // Focus the first field + Esc-to-close when the sheet opens.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => firstFieldRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && status !== "sending") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, status]);

  const hasContacts = contacts.length > 0;

  async function sendEmail() {
    if (status === "sending") return;
    setStatus("sending");
    setError(null);
    try {
      const res = await fetch(`/api/commercial/proposals/${proposalId}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to_email: email,
          cc_email: showCc && cc.trim() ? cc.trim() : null,
          subject,
          message,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
      if (res.ok && json.ok) {
        setStatus("success");
        router.refresh();
        setTimeout(() => setOpen(false), 1400);
      } else {
        setStatus("error");
        setError(json.detail ?? "Couldn't send — please try again.");
      }
    } catch {
      setStatus("error");
      setError("Network error — please try again.");
    }
  }

  return (
    <>
      {resend ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-cc-brand-700 hover:underline min-h-[36px]"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
          Email again
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 shadow-sm min-h-[40px]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
          Send proposal
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="send-proposal-title">
          <div
            className="absolute inset-0 bg-ppp-navy-900/40 backdrop-blur-sm"
            onClick={() => status !== "sending" && setOpen(false)}
            aria-hidden
          />
          <div className="relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto bg-surface rounded-t-2xl sm:rounded-2xl shadow-2xl">
            {status === "success" ? (
              <div className="text-center py-12 px-6">
                <div className="mx-auto mb-4 inline-flex items-center justify-center h-14 w-14 rounded-full bg-ppp-green-50 text-ppp-green-700">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
                </div>
                <h2 className="text-lg font-bold text-ppp-charcoal">Sent to {email}</h2>
                <p className="text-[13px] text-ppp-charcoal-500 mt-1">The proposal is on its way to the GC.</p>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-ppp-charcoal-100">
                  <div>
                    <h2 id="send-proposal-title" className="text-base font-bold text-ppp-charcoal">Send proposal to the GC</h2>
                    <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">Review before it goes out — R{revisionNumber} · {ocName}</p>
                  </div>
                  <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="p-2 -m-2 text-ppp-charcoal-400 hover:text-ppp-charcoal min-h-[44px] min-w-[44px] flex items-center justify-center">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6L6 18 M6 6l12 12" /></svg>
                  </button>
                </div>

                <div className="px-5 py-4 space-y-4">
                  {/* Recipient */}
                  <div>
                    <label className={LABEL} htmlFor="sp-to">To</label>
                    {hasContacts ? (
                      <select
                        id="sp-to"
                        ref={firstFieldRef as React.RefObject<HTMLSelectElement>}
                        value={contacts.some((c) => c.email === email) ? email : "__custom__"}
                        onChange={(e) => {
                          if (e.target.value === "__custom__") setEmail("");
                          else setEmail(e.target.value);
                        }}
                        className={FIELD}
                      >
                        {contacts.map((c) => (
                          <option key={c.email} value={c.email}>
                            {c.name ? `${c.name} — ${c.email}` : c.email}
                          </option>
                        ))}
                        <option value="__custom__">Other email…</option>
                      </select>
                    ) : (
                      <p className="text-[12px] text-ppp-charcoal-500 mb-1.5">
                        No saved contact has an email.{" "}
                        <a href={`/commercial/accounts/${accountId}?tab=contacts`} className="font-semibold text-cc-brand-700 underline">Add a contact</a>{" "}
                        or type one below.
                      </p>
                    )}
                    {(!hasContacts || !contacts.some((c) => c.email === email)) && (
                      <input
                        type="email"
                        ref={!hasContacts ? (firstFieldRef as React.RefObject<HTMLInputElement>) : undefined}
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="gc@company.com"
                        className={`${FIELD} mt-2`}
                      />
                    )}
                    {!showCc ? (
                      <button type="button" onClick={() => setShowCc(true)} className="mt-1.5 text-[12px] font-semibold text-cc-brand-700 hover:underline">+ Add CC</button>
                    ) : (
                      <input type="email" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="CC (optional)" className={`${FIELD} mt-2`} />
                    )}
                  </div>

                  <div>
                    <label className={LABEL} htmlFor="sp-subject">Subject</label>
                    <input id="sp-subject" type="text" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} className={FIELD} />
                  </div>

                  <div>
                    <label className={LABEL} htmlFor="sp-message">Message</label>
                    <textarea id="sp-message" value={message} onChange={(e) => setMessage(e.target.value)} rows={7} maxLength={8000} className={`${FIELD} min-h-[150px] resize-y`} />
                  </div>

                  {/* Attachment */}
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50/40 px-3 py-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-rose-500 shrink-0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                      <span className="text-[12.5px] font-medium text-ppp-charcoal truncate">Proposal R{revisionNumber} (PDF)</span>
                    </div>
                    <a href={pdfHref} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[12px] font-semibold text-cc-brand-700 hover:underline">Preview</a>
                  </div>

                  {status === "error" && error && (
                    <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[12.5px] text-rose-700" role="alert">{error}</div>
                  )}
                </div>

                <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2 px-5 py-4 border-t border-ppp-charcoal-100">
                  {/* Escape hatch — hand-delivered / portal case. Hidden on re-send
                      (the proposal is already sent). */}
                  {resend ? (
                    <span />
                  ) : (
                    <form action={markSentAction}>
                      <input type="hidden" name="account_id" value={accountId} />
                      <input type="hidden" name="deal_id" value={dealId} />
                      <input type="hidden" name="proposal_id" value={proposalId} />
                      <button type="submit" className="w-full sm:w-auto inline-flex items-center justify-center px-3 py-2 rounded-lg text-[13px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[44px]">
                        Just mark as sent
                      </button>
                    </form>
                  )}
                  <button
                    type="button"
                    onClick={sendEmail}
                    disabled={status === "sending" || !email.trim()}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-cc-brand-600 text-white text-[14px] font-semibold hover:bg-cc-brand-700 disabled:opacity-50 min-h-[48px] shadow-sm"
                  >
                    {status === "sending" ? "Sending…" : "Send to GC"}
                    {status !== "sending" && (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
