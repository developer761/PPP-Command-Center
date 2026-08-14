/**
 * Team & contacts for the Project command center (Karan 2026-08-14, block D):
 * "who's on this job and who do I call." The estimator who priced it, whoever's
 * assigned to run it, and the GC's contact — with tap-to-call / tap-to-email so
 * it's one touch from a phone on site.
 */

export type ProjectTeamMember = { name: string; roleLabel: string };
export type ProjectGcContact = {
  name: string;
  title: string | null;
  phone: string | null;
  email: string | null;
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function ProjectTeamCard({
  members,
  estimatorName,
  gcContact,
}: {
  members: ProjectTeamMember[];
  estimatorName: string | null;
  gcContact: ProjectGcContact | null;
}) {
  const hasInternal = members.length > 0 || !!estimatorName;
  if (!hasInternal && !gcContact) {
    return (
      <section className="rounded-xl border border-ppp-charcoal-100 bg-surface overflow-hidden">
        <header className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-ppp-charcoal-600">Team &amp; contacts</h2>
        </header>
        <p className="px-4 py-5 text-[12.5px] text-ppp-charcoal-400 italic text-center">
          No one assigned yet — add a team or an estimator on the deal.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-ppp-charcoal-100 bg-surface overflow-hidden">
      <header className="px-4 py-2.5 border-b border-ppp-charcoal-100">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-ppp-charcoal-600">Team &amp; contacts</h2>
      </header>
      <div className="p-3 space-y-1.5">
        {estimatorName && (
          <div className="flex items-center gap-2.5 px-1.5 py-1.5">
            <span className="h-8 w-8 rounded-full bg-cc-brand-50 text-cc-brand-700 text-[11px] font-bold flex items-center justify-center shrink-0">{initials(estimatorName)}</span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-ppp-charcoal truncate">{estimatorName}</div>
              <div className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">Estimator</div>
            </div>
          </div>
        )}
        {members.map((m, i) => (
          <div key={`${m.name}-${i}`} className="flex items-center gap-2.5 px-1.5 py-1.5">
            <span className="h-8 w-8 rounded-full bg-ppp-charcoal-100 text-ppp-charcoal-600 text-[11px] font-bold flex items-center justify-center shrink-0">{initials(m.name)}</span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-ppp-charcoal truncate">{m.name}</div>
              <div className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">{m.roleLabel}</div>
            </div>
          </div>
        ))}

        {gcContact && (
          <div className="mt-1 pt-2.5 border-t border-ppp-charcoal-100">
            <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400 px-1.5 mb-1">GC contact</div>
            <div className="px-1.5">
              <div className="text-[13px] font-semibold text-ppp-charcoal truncate">
                {gcContact.name}
                {gcContact.title && <span className="font-normal text-ppp-charcoal-500"> · {gcContact.title}</span>}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
                {gcContact.phone && (
                  <a href={`tel:${gcContact.phone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] sm:min-h-0">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
                    {gcContact.phone}
                  </a>
                )}
                {gcContact.email && (
                  <a href={`mailto:${gcContact.email}`} className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] sm:min-h-0 truncate max-w-full">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 5L2 7" /></svg>
                    <span className="truncate">{gcContact.email}</span>
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
