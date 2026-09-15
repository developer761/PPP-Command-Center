"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { DECLINE_REASON_MAX, SIGNER_FIELD_MAX } from "@/lib/commercial/esign/constants";

/**
 * The GC's side of an e-signature: read the proposal, say who you are, sign,
 * agree to do it electronically, submit. Or decline.
 *
 * Two ways to sign, because both fail somebody: typing is the fast path on a
 * phone and what most people pick; drawing is what a person who "doesn't trust
 * a typed name" expects. Either way the server receives a PNG, so the signed
 * contract embeds exactly the mark shown here.
 */

type Props = {
  token: string;
  docTitle: string;
  gcCompany: string;
  signerName: string;
  signerEmail: string;
  companyName: string;
  expiresLabel: string;
  scriptFontFamily: string;
  scriptClassName: string;
};

const LABEL = "mb-1 block text-[12.5px] font-semibold text-ppp-charcoal-700";
const FIELD =
  "min-h-[44px] w-full rounded-lg border border-ppp-charcoal-200 bg-surface px-3 py-2 text-base text-ppp-charcoal outline-none focus:border-cc-brand-500 focus:ring-1 focus:ring-cc-brand-500";
const INK = "#172B4D";

async function post(token: string, payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/sign/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? { ok: true } : { ok: false, error: json.error ?? "Something went wrong — please try again." };
  } catch {
    return { ok: false, error: "No connection — check your signal and try again." };
  }
}

export function SignProposalForm(props: Props) {
  const { token } = props;
  const [name, setName] = useState(props.signerName);
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState(props.gcCompany);
  const [method, setMethod] = useState<"typed" | "drawn">("typed");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"signed" | "declined" | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [drawnEmpty, setDrawnEmpty] = useState(true);
  const padRef = useRef<SignaturePadHandle>(null);
  const viewed = useRef(false);
  const consented = useRef(false);

  // VIEW once the page is really open in a browser (see the route's note on
  // mail scanners).
  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    void post(token, { action: "view" });
  }, [token]);

  const onConsent = (checked: boolean) => {
    setConsent(checked);
    if (checked && !consented.current) {
      consented.current = true;
      void post(token, { action: "consent" });
    }
  };

  const typedReady = name.trim().length >= 2;
  const signatureReady = method === "typed" ? typedReady : !drawnEmpty;
  const canSubmit = consent && typedReady && signatureReady && !busy;

  const submit = async () => {
    setError(null);
    if (!consent) return setError("Tick the box to agree to sign electronically.");
    if (!typedReady) return setError("Enter your full name.");
    const signature =
      method === "typed" ? await renderTypedSignature(name.trim(), props.scriptFontFamily) : padRef.current?.toDataUrl() ?? null;
    if (!signature) return setError(method === "typed" ? "Couldn't create the signature — try drawing it instead." : "Draw your signature first.");
    setBusy(true);
    const r = await post(token, { action: "sign", name, title, company, method, signature, consent: true });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? null);
    setDone("signed");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const decline = async () => {
    setError(null);
    setBusy(true);
    const r = await post(token, { action: "decline", reason });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? null);
    setDone("declined");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (done) {
    return (
      <div className="overflow-hidden rounded-2xl border border-ppp-charcoal-100 bg-surface shadow-sm" role="status">
        <div className={`h-1 ${done === "signed" ? "bg-emerald-600" : "bg-ppp-charcoal-300"}`} />
        <div className="p-5 sm:p-7">
          {done === "signed" ? (
            <>
              <h1 className="text-xl font-bold text-ppp-charcoal">Signed — thank you, {name.trim().split(/\s+/)[0]}</h1>
              <p className="mt-2 text-[14px] leading-relaxed text-ppp-charcoal-600">
                Your signature on {props.docTitle} is recorded. A confirmation is on its way to {props.signerEmail}, and {props.companyName} will email you the fully signed copy once it&rsquo;s countersigned.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-bold text-ppp-charcoal">Declined</h1>
              <p className="mt-2 text-[14px] leading-relaxed text-ppp-charcoal-600">
                We&rsquo;ve let {props.companyName} know. Nothing was signed.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  const docHref = `/api/sign/${token}/document`;

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-2xl border border-ppp-charcoal-100 bg-surface shadow-sm">
        <div className="border-b border-ppp-charcoal-100 p-5 sm:px-7">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-ppp-charcoal-500">Step 1 · Review</p>
          <h1 className="mt-1 text-xl font-bold text-ppp-charcoal sm:text-2xl">{props.docTitle}</h1>
          <p className="mt-1 text-[13.5px] text-ppp-charcoal-600">
            From {props.companyName}{props.gcCompany ? ` for ${props.gcCompany}` : ""}. This link is open until {props.expiresLabel}.
          </p>
        </div>
        <div className="bg-ppp-charcoal-50/60 p-3 sm:p-4">
          <iframe
            src={docHref}
            title={props.docTitle}
            className="mx-auto block aspect-[8.5/11] w-full max-w-full rounded-md border border-ppp-charcoal-200 bg-white"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <a href={docHref} target="_blank" rel="noopener" className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-lg border border-ppp-charcoal-200 bg-surface px-4 text-[13.5px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50">
              Open full screen
            </a>
            <a href={`${docHref}?download=1`} className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-lg border border-ppp-charcoal-200 bg-surface px-4 text-[13.5px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50">
              Download PDF
            </a>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-ppp-charcoal-100 bg-surface p-5 shadow-sm sm:p-7">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-ppp-charcoal-500">Step 2 · Sign</p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="esign-name" className={LABEL}>Full name *</label>
            <input id="esign-name" className={FIELD} value={name} maxLength={SIGNER_FIELD_MAX} autoComplete="name" onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="esign-title" className={LABEL}>Title</label>
            <input id="esign-title" className={FIELD} value={title} maxLength={SIGNER_FIELD_MAX} autoComplete="organization-title" placeholder="e.g. Project Manager" onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label htmlFor="esign-company" className={LABEL}>Company</label>
            <input id="esign-company" className={FIELD} value={company} maxLength={SIGNER_FIELD_MAX} autoComplete="organization" onChange={(e) => setCompany(e.target.value)} />
          </div>
        </div>

        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className={LABEL + " mb-0"}>Signature *</span>
            <div role="tablist" aria-label="How to sign" className="inline-flex rounded-lg border border-ppp-charcoal-200 p-0.5">
              {(["typed", "drawn"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={method === m}
                  onClick={() => setMethod(m)}
                  className={`min-h-[40px] rounded-md px-4 text-[13px] font-semibold ${method === m ? "bg-ppp-navy-700 text-white" : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"}`}
                >
                  {m === "typed" ? "Type" : "Draw"}
                </button>
              ))}
            </div>
          </div>
          {method === "typed" ? (
            <div className="flex h-28 items-center overflow-hidden rounded-lg border border-dashed border-ppp-charcoal-300 bg-white px-4" aria-live="polite">
              {typedReady ? (
                <span className={`${props.scriptClassName} truncate text-[40px] leading-none`} style={{ color: INK }}>
                  {name.trim()}
                </span>
              ) : (
                <span className="text-[13px] text-ppp-charcoal-400">Your typed name appears here as your signature.</span>
              )}
            </div>
          ) : (
            <SignaturePad ref={padRef} onEmptyChange={setDrawnEmpty} />
          )}
        </div>

        <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg bg-ppp-charcoal-50/70 p-3">
          <input type="checkbox" checked={consent} onChange={(e) => onConsent(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-cc-brand-600" />
          <span className="text-[13px] leading-relaxed text-ppp-charcoal-700">
            I agree to sign electronically. My electronic signature is legally binding, the same as a handwritten one. I can ask {props.companyName} for a paper copy at any time.
          </span>
        </label>

        <p className="mt-4 text-[13px] leading-relaxed text-ppp-charcoal-600">
          By selecting <strong>Sign &amp; accept</strong>, I accept this proposal — its scope, pricing, inclusions, exclusions and terms — on behalf of {company.trim() || "my company"}, and I confirm I&rsquo;m authorized to do so.
        </p>

        {error ? (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-[13px] text-rose-700" role="alert">{error}</p>
        ) : null}

        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="mt-4 flex min-h-[48px] w-full items-center justify-center rounded-lg bg-cc-brand-600 px-4 text-[15px] font-semibold text-white hover:bg-cc-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && !declining ? "Signing…" : "Sign & accept"}
        </button>

        <div className="mt-4 border-t border-ppp-charcoal-100 pt-4">
          {declining ? (
            <div>
              <label htmlFor="esign-reason" className={LABEL}>Reason (optional)</label>
              <textarea id="esign-reason" rows={3} maxLength={DECLINE_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} className={FIELD + " min-h-[88px]"} placeholder="Let us know what would need to change." />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={decline} disabled={busy} className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-rose-200 bg-rose-50 px-4 text-[13.5px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50">
                  {busy ? "Declining…" : "Decline to sign"}
                </button>
                <button type="button" onClick={() => setDeclining(false)} disabled={busy} className="inline-flex min-h-[44px] items-center px-3 text-[13px] font-medium text-ppp-charcoal-600">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setDeclining(true)} className="inline-flex min-h-[44px] items-center text-[13px] font-medium text-ppp-charcoal-600 underline-offset-2 hover:underline">
              Decline to sign
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

/** Draw the typed name in the script face onto a transparent PNG, sized to the
 *  ink so it sits on the signature line without a margin of empty canvas. */
async function renderTypedSignature(text: string, fontFamily: string): Promise<string | null> {
  try {
    const px = 96;
    const font = `600 ${px}px ${fontFamily}`;
    await document.fonts.load(font, text);
    const measure = document.createElement("canvas").getContext("2d");
    if (!measure) return null;
    measure.font = font;
    const width = Math.ceil(measure.measureText(text).width) + 40;
    const height = Math.ceil(px * 1.5);
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(width, 2400);
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.font = font;
    ctx.fillStyle = INK;
    ctx.textBaseline = "middle";
    ctx.fillText(text, 20, height / 2, canvas.width - 40);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

type SignaturePadHandle = { toDataUrl: () => string | null };

function SignaturePad({ ref, onEmptyChange }: { ref: React.Ref<SignaturePadHandle>; onEmptyChange: (empty: boolean) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const bounds = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);
  const size = useRef<{ w: number; h: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  const setEmptyBoth = useCallback(
    (v: boolean) => {
      setEmpty(v);
      onEmptyChange(v);
    },
    [onEmptyChange]
  );

  const setup = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    size.current = { w: Math.round(rect.width), h: Math.round(rect.height) };
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = INK;
    bounds.current = null;
  }, []);

  useEffect(() => {
    setup();
    // Resizing a canvas wipes it, so start fresh rather than keep a mark whose
    // coordinates no longer line up — but ONLY when the box really changed.
    // Scrolling on an iPhone collapses Safari's toolbar, which fires `resize`
    // at the same width: clearing on that erased the signature every time the
    // GC scrolled down to the Sign button.
    const onResize = () => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const prev = size.current;
      if (prev && Math.round(rect.width) === prev.w && Math.round(rect.height) === prev.h) return;
      setup();
      setEmptyBoth(true);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setup, setEmptyBoth]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const b = bounds.current;
    bounds.current = b
      ? { minX: Math.min(b.minX, x), minY: Math.min(b.minY, y), maxX: Math.max(b.maxX, x), maxY: Math.max(b.maxY, y) }
      : { minX: x, minY: y, maxX: x, maxY: y };
    return { x, y };
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    bounds.current = null;
    setEmptyBoth(true);
  };

  useImperativeHandle(
    ref,
    () => ({
      toDataUrl: () => {
        const canvas = canvasRef.current;
        const b = bounds.current;
        if (!canvas || !b || empty) return null;
        const dpr = window.devicePixelRatio || 1;
        const pad = 8;
        const sx = Math.max(0, Math.floor((b.minX - pad) * dpr));
        const sy = Math.max(0, Math.floor((b.minY - pad) * dpr));
        const sw = Math.min(canvas.width - sx, Math.ceil((b.maxX - b.minX + pad * 2) * dpr));
        const sh = Math.min(canvas.height - sy, Math.ceil((b.maxY - b.minY + pad * 2) * dpr));
        if (sw <= 0 || sh <= 0) return null;
        const out = document.createElement("canvas");
        out.width = sw;
        out.height = sh;
        out.getContext("2d")?.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        return out.toDataURL("image/png");
      },
    }),
    [empty]
  );

  return (
    <div>
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          const ctx = canvasRef.current?.getContext("2d");
          if (!ctx) return;
          const { x, y } = point(e);
          ctx.beginPath();
          ctx.moveTo(x, y);
          // A tap is a dot, not nothing.
          ctx.lineTo(x + 0.1, y + 0.1);
          ctx.stroke();
          if (empty) setEmptyBoth(false);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = canvasRef.current?.getContext("2d");
          if (!ctx) return;
          const { x, y } = point(e);
          ctx.lineTo(x, y);
          ctx.stroke();
          if (empty) setEmptyBoth(false);
        }}
        onPointerUp={() => (drawing.current = false)}
        onPointerCancel={() => (drawing.current = false)}
        className="h-36 w-full touch-none cursor-crosshair rounded-lg border border-dashed border-ppp-charcoal-300 bg-white"
        aria-label="Draw your signature"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className="text-[12px] text-ppp-charcoal-500">Sign with your finger or mouse.</span>
        <button type="button" onClick={clear} disabled={empty} className="min-h-[40px] px-2 text-[13px] font-medium text-ppp-charcoal-600 disabled:opacity-40">
          Clear
        </button>
      </div>
    </div>
  );
}
