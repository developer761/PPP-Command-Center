type Row = {
  label: string;
  value: number;
  sublabel?: string;
  /** Tailwind color token, e.g. "ppp-blue" */
  colorToken?: string;
};

type Props = {
  rows: Row[];
  unit?: string;
  formatValue?: (v: number) => string;
};

export default function HorizontalBar({ rows, unit = "", formatValue }: Props) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const fmt = formatValue ?? ((v: number) => `${v}${unit}`);

  return (
    <div className="space-y-3">
      {rows.map((r, i) => {
        const pct = Math.round((r.value / max) * 100);
        const token = r.colorToken ?? "ppp-blue";
        return (
          <div key={i}>
            <div className="flex items-baseline justify-between mb-1.5">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-semibold text-ppp-charcoal">{r.label}</span>
                {r.sublabel && (
                  <span className="text-[11px] text-ppp-charcoal-500">{r.sublabel}</span>
                )}
              </div>
              <span className="text-sm font-semibold text-ppp-charcoal">{fmt(r.value)}</span>
            </div>
            <div className="h-2 w-full bg-ppp-charcoal-50 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${pct}%`,
                  backgroundColor: `var(--color-${token})`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
