import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import PageHeader from "@/components/page-header";

/**
 * Settings hub — single landing for every admin tool that used to live
 * as its own sidebar row. Sidebar got overwhelming (6 items under Admin);
 * collapsed to "Integrations + Settings" and the rest moved here as
 * cards. Each card links to the existing page, nothing was moved or
 * renamed under the hood.
 *
 * Admin-only — workers redirect to /dashboard.
 */

export const dynamic = "force-dynamic";

type Card = {
  href: string;
  label: string;
  blurb: string;
  icon: React.ReactNode;
};

const cards: Card[] = [
  {
    href: "/dashboard/settings/health",
    label: "Setup Health",
    blurb:
      "Live status of every dependency — env vars, migrations, Salesforce, suppliers, archive, Slack alerts. Green/amber/red rows refresh every 30s.",
    icon: <IconHeart />,
  },
  {
    href: "/dashboard/integrations",
    label: "Integrations",
    blurb:
      "Connect + manage the Salesforce OAuth integration (the live data source). Disconnect or re-auth when a refresh token expires.",
    icon: <IconPlug />,
  },
  {
    href: "/dashboard/settings/templates",
    label: "Customer Copy",
    blurb:
      "Edit the email + SMS templates customers receive (color form invite, reminders, confirmations). Live preview before save.",
    icon: <IconPencil />,
  },
  {
    href: "/dashboard/settings/suppliers",
    label: "Suppliers",
    blurb:
      "Curate the supplier list shown to crews, set pickup locations, drag to reorder, mark active/inactive. NYC pickup defaults to all 5 boroughs.",
    icon: <IconTruck />,
  },
  {
    href: "/dashboard/settings/supplier-templates",
    label: "Supplier Email Copy",
    blurb:
      "Per-supplier email templates that get sent when a paint order is placed (PO format, greeting, sign-off). Falls back to the default if a supplier has none.",
    icon: <IconMail />,
  },
  {
    href: "/dashboard/settings/test-form",
    label: "Test Color Form",
    blurb:
      "Send a real color-form link to yourself to QA the customer experience without touching a live work order. Useful before pushing template changes.",
    icon: <IconSearch />,
  },
];

export default async function SettingsHubPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/dashboard");

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Settings"
        subtitle="Admin tools — one click to whatever you need to tune. Each card opens its own page."
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="group flex flex-col gap-3 p-5 rounded-xl bg-white border border-ppp-charcoal-100 hover:border-emerald-300 hover:shadow-sm transition-all min-h-[44px]"
          >
            <div className="flex items-center gap-3">
              <span className="flex items-center justify-center h-10 w-10 rounded-lg bg-emerald-50 text-emerald-700 group-hover:bg-emerald-100 transition-colors">
                {card.icon}
              </span>
              <span className="text-base font-semibold text-ppp-charcoal">
                {card.label}
              </span>
            </div>
            <p className="text-sm text-ppp-charcoal-500 leading-relaxed">
              {card.blurb}
            </p>
            <span className="mt-auto text-xs font-medium text-emerald-700 inline-flex items-center gap-1 group-hover:gap-2 transition-all">
              Open
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12h14 M13 5l7 7-7 7" />
              </svg>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* Icons — duplicated from sidebar.tsx rather than imported because the
   sidebar exports them inline (no shared icon module yet). Each is
   18px in the sidebar; bumped to 20 here so the cards read as
   touch-friendly rather than dense. */
function IconPlug() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 2v6 M15 2v6 M7 8h10v4a5 5 0 0 1-10 0z M12 17v5" />
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
function IconPencil() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9 M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}
function IconTruck() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="1" y="3" width="15" height="13" rx="1" />
      <path d="M16 8h4l3 3v5h-7z M5.5 18a2.5 2.5 0 1 0 0 1 M18.5 18a2.5 2.5 0 1 0 0 1" />
    </svg>
  );
}
function IconMail() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 6-10 7L2 6" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}
