import type { Metadata } from "next";
import { Dancing_Script } from "next/font/google";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { formatSignedAt } from "@/lib/commercial/esign/constants";
import { lookupSignatureLink, type LinkLookup } from "@/lib/commercial/esign/db";
import { proposalLabel } from "@/lib/commercial/proposals/constants";
import { SignProposalForm } from "@/components/commercial/esign/sign-proposal-form";

/**
 * Public e-signature page — a GC reviews and signs a proposal. No login: the
 * link token is the credential. Lives outside /commercial so the authed shell
 * never runs. Mobile first: most GCs open this from an email on a phone.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Review & sign your proposal",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// Typed signatures render in this face — on screen AND in the PNG the signature
// page embeds, so what the signer sees is what gets filed.
const script = Dancing_Script({ subsets: ["latin"], weight: ["600"], display: "swap" });

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [lookup, oc] = await Promise.all([lookupSignatureLink(token), getOperatingCompany()]);

  return (
    <main className="min-h-dvh bg-ppp-charcoal-50/40 px-4 py-6 sm:py-10">
      <div className="mx-auto max-w-2xl">
        <header className="mb-5 text-center">
          <div className="font-condensed text-xl font-black uppercase tracking-tight text-ppp-navy-700">{oc.name}</div>
          <span aria-hidden className="mx-auto mt-3 block h-1 w-12 rounded-full bg-cc-brand-600" />
        </header>

        <Body lookup={lookup} token={token} companyName={oc.name} companyPhone={oc.phone} scriptFontFamily={script.style.fontFamily} scriptClassName={script.className} />

        <footer className="mt-6 text-center text-[12px] text-ppp-charcoal-500">
          {[oc.name, oc.phone, oc.email].filter(Boolean).join(" · ")}
        </footer>
      </div>
    </main>
  );
}

function Body({
  lookup,
  token,
  companyName,
  companyPhone,
  scriptFontFamily,
  scriptClassName,
}: {
  lookup: LinkLookup;
  token: string;
  companyName: string;
  companyPhone: string | null;
  scriptFontFamily: string;
  scriptClassName: string;
}) {
  const contact = companyPhone ? `Call ${companyName} at ${companyPhone}` : `Reply to the email from ${companyName}`;

  if (!lookup.found) {
    if (lookup.reason === "unavailable") {
      return (
        <Notice tone="amber" title="We couldn't load this right now">
          Our system didn&rsquo;t respond. Your link is fine — please try again in a minute.
        </Notice>
      );
    }
    return (
      <Notice tone="grey" title="This link isn't valid">
        Check that the whole link from your email was opened. {contact} if you need a new one.
      </Notice>
    );
  }

  const { request, proposal, state } = lookup;
  const project = proposal.header_json.project_name?.trim() || proposal.opportunity_title || "your project";
  const docTitle = `${proposalLabel(proposal)} — ${project}`;

  switch (state.kind) {
    case "signed":
      return state.status === "completed" ? (
        <Notice tone="green" title="Fully signed">
          {docTitle} was signed by {request.customer_name} on {formatSignedAt(request.customer_signed_at)} and countersigned by {companyName} on {formatSignedAt(request.countersigned_at)}.
          {request.signed_document_id ? (
            <a href={`/api/sign/${token}/document?download=1`} className="mt-4 flex min-h-[44px] items-center justify-center rounded-lg bg-cc-brand-600 px-4 text-[14px] font-semibold text-white hover:bg-cc-brand-700">
              Download the signed copy
            </a>
          ) : null}
        </Notice>
      ) : (
        <Notice tone="green" title="Signed — thank you">
          {docTitle} was signed by {request.customer_name} on {formatSignedAt(request.customer_signed_at)}. {companyName} will countersign it and email the fully signed copy to {request.signer_email}.
        </Notice>
      );
    case "declined":
      return (
        <Notice tone="grey" title="Signature declined">
          This request was declined on {formatSignedAt(request.declined_at)}. {contact} if that was a mistake.
        </Notice>
      );
    case "expired":
      return (
        <Notice tone="grey" title="This link has expired">
          Signing links stay open for 30 days. {contact} for a fresh one.
        </Notice>
      );
    case "voided":
      return (
        <Notice tone="grey" title="This link is no longer active">
          {/* Generic on purpose: staff type the void reason for the audit
              trail ("sent to the wrong contact"), not for the customer. */}
          The proposal has changed or been replaced since this link was sent. {contact} for the current proposal.
        </Notice>
      );
    case "sign":
      return (
        <SignProposalForm
          token={token}
          docTitle={docTitle}
          gcCompany={proposal.header_json.gc_company?.trim() || ""}
          signerName={request.signer_name?.trim() || proposal.header_json.attention?.trim() || ""}
          signerEmail={request.signer_email}
          companyName={companyName}
          expiresLabel={formatSignedAt(request.expires_at)}
          scriptFontFamily={scriptFontFamily}
          scriptClassName={scriptClassName}
        />
      );
  }
}

function Notice({ tone, title, children }: { tone: "green" | "amber" | "grey"; title: string; children: React.ReactNode }) {
  const bar = tone === "green" ? "bg-emerald-600" : tone === "amber" ? "bg-amber-500" : "bg-ppp-charcoal-300";
  return (
    <div className="overflow-hidden rounded-2xl border border-ppp-charcoal-100 bg-surface shadow-sm">
      <div className={`h-1 ${bar}`} />
      <div className="p-5 sm:p-7">
        <h1 className="text-xl font-bold text-ppp-charcoal">{title}</h1>
        <div className="mt-2 text-[14px] leading-relaxed text-ppp-charcoal-600">{children}</div>
      </div>
    </div>
  );
}
