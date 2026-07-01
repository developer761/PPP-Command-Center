type Props = {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  /** Accent-bar color above the title. Defaults to ppp-blue (PPP CC).
   *  Commercial CC surfaces can pass "cc-brand" to match the red brand. */
  accent?: "ppp-blue" | "cc-brand" | "emerald" | "none";
};

export default function PageHeader({ title, subtitle, actions, accent = "ppp-blue" }: Props) {
  const accentCls =
    accent === "cc-brand"
      ? "bg-cc-brand-600"
      : accent === "emerald"
      ? "bg-emerald-500"
      : accent === "none"
      ? "hidden"
      : "bg-ppp-blue";
  return (
    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 sm:gap-4 mb-6 sm:mb-8">
      <div className="min-w-0">
        {/* Accent bar — 3px × 40px signature stroke above the title.
            Every page gets a subtle brand touch without adding visual
            weight. Karan 2026-07-01 "more inviting" pass. */}
        <span aria-hidden className={`block h-[3px] w-10 rounded-full mb-3 ${accentCls}`} />
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 sm:mt-1.5 text-xs sm:text-sm text-ppp-charcoal-500">
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}
