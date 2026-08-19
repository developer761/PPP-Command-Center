import Image from "next/image";
import { headers } from "next/headers";
import { validateToken, markOpened, markWoliSnapshotTime, getLatestSubmittedPayload } from "@/lib/customer-form/tokens";
import { loadFormRenderData } from "@/lib/customer-form/render-data";
import { loadTemplates, render, buildVars } from "@/lib/customer-form/templates";
import CustomerFormView from "@/components/customer-form-view";
import { PPP_BRAND } from "@/lib/brand";

/**
 * Public route — no auth, token-gated. Customer lands here from the email
 * Resend sent. We:
 *   1. Validate the token (not found / expired / already submitted / ok)
 *   2. Render an appropriate page state
 *   3. For ok tokens: fetch fresh WO + line items, render the form
 *   4. Mark the token as opened (idempotent — only sets opened_at if null)
 *   5. Capture woli_snapshot_at for drift detection at submit time
 */

export const dynamic = "force-dynamic";

type Params = Promise<{ token: string }>;

export default async function CustomerFormPage({ params }: { params: Params }) {
  const { token } = await params;
  const status = await validateToken(token);

  if (status.kind === "not_found") {
    return <ErrorState heading="Link not found" body="This form link doesn't exist or was removed. If you got it from PPP, please reach out so they can send you a new one." />;
  }
  if (status.kind === "unavailable") {
    // The lookup failed, not the link. Telling a customer their link is dead
    // when it isn't makes them phone PPP or give up on the form entirely.
    return (
      <ErrorState
        heading="We couldn't load your form just now"
        body="This is on our side, not your link — please refresh the page in a moment. If it keeps happening, reply to the PPP email and we'll sort it out."
      />
    );
  }
  if (status.kind === "expired") {
    return <ErrorState heading="This link has expired" body="For your security, this color-form link has expired. Reply to the PPP email you got and we'll send a fresh link." />;
  }
  if (status.kind === "submitted") {
    // Submitted AND past the cutoff (24h before the job start) → locked.
    return (
      <SuccessState
        heading="Thanks — we've got your color picks!"
        body="Your color selections are locked in and our team is preparing your materials order. The window to change them online has closed — if you still need a change, reply to the PPP email or give us a call right away."
      />
    );
  }

  // "ok" (first time) or "editable" (revising before the cutoff) — render the
  // form. For an edit, seed it from the prior submission so the customer sees
  // and tweaks what they already picked.
  const isEditing = status.kind === "editable";
  type SubmittedPayload = {
    lineItems?: Array<{
      id: string;
      surfaces?: Array<{
        surface: string;
        colorId: string | null;
        colorName: string | null;
        colorCode: string | null;
        finish: string | null;
        skipped?: boolean;
      }>;
      notes?: string;
    }>;
    globalNotes?: string;
  };
  // Kate round-3 #10: seed from this token's own submission when it has one,
  // and otherwise from the Command Center's most recent submission for this
  // WORK ORDER.
  //
  // Without the fallback, a re-sent form (a brand-new token) had no prior
  // submission and fell back to reading Salesforce — which is lossy for lines
  // carrying more surfaces than SF has colour fields. Cabinets and Door had
  // gone to Color Notes and the shared Other slot was left blank, so the form
  // showed them empty and the colours looked deleted. They were always in
  // submitted_payload; we just weren't reading it.
  const ownPayload =
    isEditing && status.token.submitted_payload
      ? (status.token.submitted_payload as unknown as SubmittedPayload)
      : null;
  const priorSubmission =
    ownPayload ??
    ((await getLatestSubmittedPayload(status.token.work_order_id)) as SubmittedPayload | null);

  const formData = await loadFormRenderData(status.token.work_order_id);
  if (!formData) {
    return <ErrorState heading="We hit a snag" body="We couldn't load the details for your work order right now. Please try again in a few minutes — if it keeps happening, let PPP know." />;
  }

  // Capture opens + render-time snapshot (best-effort; doesn't block render)
  const headerList = await headers();
  const ip = headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = headerList.get("user-agent") ?? null;
  void markOpened(token, { ip, userAgent });
  void markWoliSnapshotTime(token);

  // Render copy is editable via /dashboard/settings/templates — load + sub
  // variables here so the form gets the customized strings (or the code
  // defaults when admin hasn't overridden anything).
  const { templates } = await loadTemplates();
  const vars = buildVars({
    customerName: status.token.customer_name,
    workOrderNumber: status.token.work_order_number,
  });
  const copy = {
    headerEyebrow: render(templates.form_header_eyebrow, vars),
    headerTitle: render(templates.form_header_title, vars),
    headerSubtitle: render(templates.form_header_subtitle, vars),
    globalNotesLabel: render(templates.form_global_notes_label, vars),
    thankyouTitle: render(templates.form_thankyou_title, vars),
    thankyouBody: render(templates.form_thankyou_body, vars),
  };

  // Preview tokens render the same form but with a banner + a no-op submit.
  // Internal-entry tokens (Kate #4) render the same staff-facing form but
  // DO save (staff entering colors on the customer's behalf).
  const isPreview = status.token.kind === "preview";
  const isInternal = status.token.kind === "internal";

  return (
    <CustomerFormShell>
      <CustomerFormView
        token={token}
        customerName={status.token.customer_name ?? null}
        formData={formData}
        copy={copy}
        isEditing={isEditing}
        priorSubmission={priorSubmission}
        isPreview={isPreview}
        isInternal={isInternal}
        colorDeadline={status.token.color_deadline ?? null}
      />
    </CustomerFormShell>
  );
}

/* ─── Layout shells (server components, branded) ─── */

function CustomerFormShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--color-surface-muted)] flex flex-col">
      <header className="bg-white border-b border-ppp-charcoal-100">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          <Image
            src="/brand/logo.svg"
            alt={PPP_BRAND.name}
            width={180}
            height={60}
            priority
            className="h-9 sm:h-10 w-auto"
          />
          <div className="text-[10px] sm:text-xs font-condensed uppercase tracking-[0.18em] text-ppp-charcoal-500">
            Color Selection
          </div>
        </div>
      </header>
      <main className="flex-1 w-full max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        {children}
      </main>
      <footer className="px-4 sm:px-6 py-6 text-center text-[11px] text-ppp-charcoal-500">
        {PPP_BRAND.name} · {PPP_BRAND.tagline}
      </footer>
    </div>
  );
}

function ErrorState({ heading, body }: { heading: string; body: string }) {
  return (
    <CustomerFormShell>
      <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-8 sm:p-12 text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-ppp-orange-50 text-ppp-orange-700 flex items-center justify-center text-2xl mb-4">
          ⚠
        </div>
        <h1 className="text-xl sm:text-2xl font-bold text-ppp-navy">{heading}</h1>
        <p className="mt-3 text-sm sm:text-base text-ppp-charcoal-500 max-w-md mx-auto">{body}</p>
      </div>
    </CustomerFormShell>
  );
}

function SuccessState({ heading, body }: { heading: string; body: string }) {
  return (
    <CustomerFormShell>
      <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-8 sm:p-12 text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-ppp-green-50 text-ppp-green-700 flex items-center justify-center text-2xl mb-4">
          ✓
        </div>
        <h1 className="text-xl sm:text-2xl font-bold text-ppp-navy">{heading}</h1>
        <p className="mt-3 text-sm sm:text-base text-ppp-charcoal-500 max-w-md mx-auto">{body}</p>
      </div>
    </CustomerFormShell>
  );
}
