type Props = {
  label: string;
  value: string;
  change: string;
  trend: "up" | "down" | "flat";
  accent?: "blue" | "orange" | "green";
};

const accentRing: Record<NonNullable<Props["accent"]>, string> = {
  blue: "before:bg-ppp-blue",
  orange: "before:bg-ppp-orange",
  green: "before:bg-ppp-green",
};

const trendIcon = {
  up: "▲",
  down: "▼",
  flat: "—",
} as const;

const trendColor = {
  up: "text-ppp-green-700 bg-ppp-green-50 border-ppp-green-100",
  down: "text-ppp-orange-700 bg-ppp-orange-50 border-ppp-orange-100",
  flat: "text-ppp-charcoal-500 bg-ppp-charcoal-50 border-ppp-charcoal-100",
} as const;

export default function KPICard({ label, value, change, trend, accent = "blue" }: Props) {
  return (
    <div
      className={[
        "relative overflow-hidden bg-white rounded-xl border border-ppp-charcoal-100",
        "p-4 sm:p-5",
        // Lift only on devices with real hover — phones triggered the
        // transform on every tap and caused a visible paint flicker.
        "transition-all kpi-card-lift",
        "before:absolute before:top-0 before:left-0 before:h-1 before:w-full",
        accentRing[accent],
      ].join(" ")}
    >
      <div className="font-condensed text-[10px] sm:text-[11px] font-semibold tracking-[0.15em] text-ppp-charcoal-500 uppercase">
        {label}
      </div>
      <div className="font-condensed mt-2 sm:mt-3 text-2xl sm:text-3xl font-bold text-ppp-navy tracking-tight">
        {value}
      </div>
      <div
        className={[
          "mt-2 sm:mt-3 inline-flex items-center gap-1 text-[10px] sm:text-[11px] font-semibold px-1.5 sm:px-2 py-0.5 rounded-md border",
          trendColor[trend],
        ].join(" ")}
      >
        <span>{trendIcon[trend]}</span>
        <span className="whitespace-nowrap">{change}</span>
      </div>
    </div>
  );
}
