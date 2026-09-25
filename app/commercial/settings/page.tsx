import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { normalizeRole } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";
import { StartTourButton } from "@/components/commercial/start-tour-button";

/**
 * Commercial Settings hub (RUX-7) — one landing for every admin/config surface
 * that used to be its own sidebar row. Mirrors the residential Command Center's
 * /dashboard/settings hub: the sidebar collapses to a single "Settings" item and
 * the rest live here as cards. Nothing was moved under the hood — each card links
 * to its existing page.
 */

export const metadata = { title: "Settings" };

export const dynamic = "force-dynamic";

type Card = {
  href: string;
  label: string;
  blurb: string;
  icon: React.ReactNode;
  adminOnly?: boolean;
  /** Opens in a new tab — used for the handbook, which is a generated PDF. */
  external?: boolean;
};

const CARDS: Card[] = [
  {
    // First, because it is what you hand somebody on their first morning.
    // Generated on open rather than an uploaded file: a printed process doc
    // starts lying the week a page gets renamed, and nobody notices. This one
    // is built from the platform's own map every time it is opened.
    href: "/api/commercial/guide/pdf",
    label: "The handbook",
    blurb:
      "Running Commercial Work — how to do everything, in plain words, with a page each for Mary's daily jobs, the sales flow, delivery, billing and closeout. Print it and keep it by the desk.",
    icon: <IconBook />,
    external: true,
  },
  {
    href: "/commercial/settings/operating-company",
    label: "Operating Company",
    blurb:
      "The company identity on every document — name, address, phone, website, logo + signature. This is who proposals, work orders, and invoices come from.",
    icon: <IconBuilding />,
    // Admin-gated as of today — it stamps the signature on every invoice, AIA
    // certificate, transmittal and warranty the company sends. The card has to
    // follow the page, or it becomes another silent bounce.
    adminOnly: true,
  },
  {
    // Karan 2026-09-17: "put this in settings, make a new tab for it and call
    // it Recurring Reports." Next to Notifications, which is the other place
    // you decide what leaves the building and when.
    href: "/commercial/settings/recurring-reports",
    label: "Recurring Reports",
    blurb:
      "The whole picture in Alex's inbox on a schedule — is the company making money, what is owed, what came in, and the AR sheet in full. Off until somebody turns it on; preview one to yourself first.",
    icon: <IconClock />,
    // The page behind this is `requireSettingsAdmin`, so without the flag it
    // was offered to Mary and Kelvi and then redirected them OUT of Settings
    // entirely, with no message. Every other admin-only card carries it.
    adminOnly: true,
  },
  {
    href: "/commercial/settings/notifications",
    label: "Notifications",
    blurb:
      "Choose which events email you (proposal approvals, payments, past-due invoices) on top of the in-app bell — and add your own custom rules.",
    icon: <IconBell />,
  },
  {
    href: "/commercial/settings/vendors",
    label: "Vendors",
    blurb:
      "Every store, supplier, crew payee and sub Tomco pays — the list behind the vendor search on each job's transactions. Admins and account managers keep it up to date.",
    icon: <IconStore />,
  },
  {
    href: "/commercial/settings/competitors",
    label: "Competitors",
    blurb:
      "The competitor dictionary used on win/loss debriefs — who you're bidding against, so the Win/Loss report can aggregate by competitor.",
    icon: <IconUsers />,
    adminOnly: true,
  },
  {
    href: "/commercial/settings/ratings",
    label: "Account ratings",
    blurb:
      "What A, B and C actually mean. The letters stay put; the meaning prints beside them everywhere, so a grade is worth reading.",
    icon: <IconUsers />,
    adminOnly: true,
  },
  {
    href: "/commercial/settings/tax",
    label: "Sales tax",
    blurb:
      "Default sales-tax rate + per-jurisdiction overrides applied to invoices. Tax is pass-through (never counted as revenue).",
    icon: <IconDollar />,
    adminOnly: true,
  },
  {
    href: "/commercial/settings/health",
    label: "Setup Health",
    blurb:
      "Live status of every dependency — env vars, migrations, brand assets, email. Green/amber/red so you can spot a misconfig before it bites.",
    icon: <IconHeart />,
    adminOnly: true,
  },
  {
    href: "/commercial/settings/archived",
    label: "Archived opportunities",
    blurb:
      "Opportunities you've archived out of the pipeline. Restore one to bring it back, or leave it filed away — nothing is deleted.",
    icon: <IconArchive />,
    adminOnly: true,
  },
  {
    href: "/commercial/settings/repairs",
    label: "Historical repairs",
    blurb:
      "Records still carrying a figure from before a bug was fixed — an erased signed contract, a certificate that recalculates, a win date overwritten by close-out. Review and approve each one. Admin-only.",
    icon: <IconKey />,
    adminOnly: true,
  },
  {
    href: "/commercial/settings/access",
    label: "Access & Users",
    blurb:
      "Provision Commercial logins (email + password), toggle who can approve proposals, and deactivate anyone. Admin-only.",
    icon: <IconKey />,
    adminOnly: true,
  },
  {
    href: "/commercial/settings/teams",
    label: "Teams",
    blurb:
      "Build reusable teams — a name, a team admin, and members with roles — then assign a whole team to an account or opportunity by name. Admin-only.",
    icon: <IconUsers />,
    adminOnly: true,
  },
  {
    href: "/commercial/settings/report-folders",
    label: "Report folders",
    blurb:
      "Team folders — Manager, Finance, Field Users — and who is in each. Anyone who isn't an admin sees only the reports in their folders. Admin-only.",
    icon: <IconFolder />,
    adminOnly: true,
  },
  {
    href: "/commercial/settings/field-ops",
    label: "Field operations",
    blurb:
      "Clock-in rules for the crew magic-link — the override PIN that lets someone clock in early (crew can't punch until 10 min before their scheduled start). Admin-only.",
    icon: <IconUsers />,
    adminOnly: true,
  },
];

export default async function CommercialSettingsHubPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  const isAdmin =
    normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email)) === "admin";

  const cards = CARDS.filter((c) => !c.adminOnly || isAdmin);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
      <div className="mb-5">
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Settings</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">Company config + admin tools. Each card opens its own page.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((card) => {
          // The handbook is a PDF, not a page: a Next <Link> would try to
          // client-navigate to it. A plain anchor in a new tab keeps Settings
          // open behind it, which is what you want when you are reading a
          // handbook about the thing you are looking at.
          const Wrapper = card.external ? "a" : Link;
          return (
          <Wrapper
            key={card.href}
            href={card.href}
            {...(card.external ? { target: "_blank", rel: "noopener" } : {})}
            className="group flex flex-col gap-3 p-5 rounded-xl bg-surface border border-ppp-charcoal-100 hover:border-cc-brand-300 hover:shadow-sm transition-all"
          >
            <div className="flex items-center gap-3">
              <span className="flex items-center justify-center h-10 w-10 rounded-lg bg-cc-brand-50 text-cc-brand-700 group-hover:bg-cc-brand-100 transition-colors">
                {card.icon}
              </span>
              <span className="text-[15px] font-bold text-ppp-charcoal">{card.label}</span>
            </div>
            <p className="text-[13px] text-ppp-charcoal-500 leading-relaxed">{card.blurb}</p>
            <span className="mt-auto text-[12px] font-semibold text-cc-brand-700 inline-flex items-center gap-1 group-hover:gap-2 transition-all">
              {card.external ? "Open the PDF" : "Open"}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12h14 M13 5l7 7-7 7" />
              </svg>
            </span>
          </Wrapper>
          );
        })}
      </div>
      <StartTourButton />
    </div>
  );
}

/* Icons (20px) — match the sidebar's set. */
function IconStore() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 9l1.5-5h15L21 9 M3 9h18 M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0 M5 11.5V21h14v-9.5 M10 21v-5h4v5" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function IconBook() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
function IconBuilding() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="2" width="16" height="20" rx="1" />
      <path d="M9 22v-4h6v4 M8 6h2 M14 6h2 M8 10h2 M14 10h2 M8 14h2 M14 14h2" />
    </svg>
  );
}
function IconFolder() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
function IconBell() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
function IconUsers() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function IconDollar() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2v20 M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}
function IconHeart() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      <polyline points="3.5 12 8 12 10 9 14 15 16 12 20.5 12" />
    </svg>
  );
}
function IconArchive() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="4" width="20" height="4" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <line x1="10" y1="13" x2="14" y2="13" />
    </svg>
  );
}
function IconKey() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.5 12.5 20 3 M17 6l2 2 M14 9l2 2" />
    </svg>
  );
}
