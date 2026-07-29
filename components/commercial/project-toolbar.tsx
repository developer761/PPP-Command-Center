/**
 * Project toolbar (2026-07-28) — one consistent nav across a post-sale deal's
 * production surfaces so Change Orders + AIA Billing (+ Submittals, Invoices)
 * are reachable from anywhere in the project, not buried in the deal drawer.
 * Rendered on the account-scoped Change Orders + AIA pages and the deal
 * overview. Active item highlighted; horizontally scrollable on mobile.
 */
import Link from "next/link";

export type ProjectToolbarActive = "overview" | "change-orders" | "aia" | "submittals" | "invoices";

export function ProjectToolbar({
  accountId,
  dealId,
  active,
}: {
  accountId: string;
  dealId: string;
  active: ProjectToolbarActive;
}) {
  const items: { key: ProjectToolbarActive; label: string; href: string }[] = [
    { key: "overview", label: "Overview", href: `/commercial/accounts/${accountId}?tab=opportunities&edit=${dealId}` },
    { key: "change-orders", label: "Change Orders", href: `/commercial/accounts/${accountId}/change-orders/${dealId}` },
    { key: "aia", label: "AIA Billing", href: `/commercial/accounts/${accountId}/aia/${dealId}` },
    { key: "submittals", label: "Submittals", href: `/commercial/opportunities/${dealId}?tab=submittals` },
    { key: "invoices", label: "Invoices", href: `/commercial/invoices?account_id=${accountId}#opp-${dealId}` },
  ];
  return (
    <nav aria-label="Project" className="-mx-1 overflow-x-auto overscroll-x-contain">
      <div className="flex items-center gap-1.5 px-1 min-w-max">
        {items.map((it) => {
          const on = it.key === active;
          return (
            <Link
              key={it.key}
              href={it.href}
              aria-current={on ? "page" : undefined}
              className={`inline-flex items-center px-3 py-1.5 rounded-full text-[12px] font-semibold whitespace-nowrap min-h-[36px] transition-colors ${
                on
                  ? "bg-cc-brand-600 text-white"
                  : "bg-white border border-ppp-charcoal-200 text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:border-cc-brand-300 hover:text-cc-brand-800"
              }`}
            >
              {it.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
