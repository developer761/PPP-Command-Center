"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Rep } from "@/lib/mock-data";
import { fmtMoneyK } from "@/lib/format";

type SortKey = "revenueSold" | "closeRate" | "avgTicket" | "openPipeline";
type SortDir = "desc" | "asc";

type Props = {
  reps: Rep[];
  teamRevenueTotal: number;
};

const COLUMNS: { key: SortKey; label: string; align: "right"; format: (r: Rep) => string }[] = [
  { key: "revenueSold", label: "Revenue", align: "right", format: (r) => fmtMoneyK(r.revenueSold) },
  { key: "closeRate", label: "Conv.", align: "right", format: (r) => `${r.closeRate.toFixed(1)}%` },
  { key: "avgTicket", label: "Avg Ticket", align: "right", format: (r) => fmtMoneyK(r.avgTicket) },
  { key: "openPipeline", label: "Open Pipeline", align: "right", format: (r) => fmtMoneyK(r.openPipeline) },
];

export default function Leaderboard({ reps, teamRevenueTotal }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("revenueSold");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sorted = useMemo(() => {
    const arr = [...reps];
    arr.sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      return sortDir === "desc" ? vb - va : va - vb;
    });
    return arr;
  }, [reps, sortKey, sortDir]);

  const onHeaderClick = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  if (reps.length === 0) {
    return (
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
        <p className="text-sm font-semibold text-ppp-charcoal">No reps match this filter</p>
        <p className="text-xs text-ppp-charcoal-500 mt-1">Try a different region or period.</p>
      </div>
    );
  }

  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <div className="px-5 sm:px-6 py-4 border-b border-ppp-charcoal-100 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-ppp-charcoal">Rep Leaderboard</h3>
          <p className="text-[11px] sm:text-xs text-ppp-charcoal-500 mt-0.5">
            Click a column header to sort · click a row for the rep deep-dive
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-semibold text-ppp-charcoal">{fmtMoneyK(teamRevenueTotal)}</div>
          <div className="text-[10px] sm:text-[11px] text-ppp-charcoal-500">team total</div>
        </div>
      </div>

      {/* Desktop / tablet: table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead className="bg-ppp-charcoal-50 text-[11px] font-semibold tracking-wide text-ppp-charcoal-500 uppercase">
            <tr>
              <th className="text-left px-6 py-3">Rep</th>
              <th className="text-left px-6 py-3">Region</th>
              <th className="text-left px-6 py-3">Line</th>
              {COLUMNS.map((col) => {
                const active = col.key === sortKey;
                return (
                  <th key={col.key} className="text-right px-6 py-3">
                    <button
                      type="button"
                      onClick={() => onHeaderClick(col.key)}
                      className={[
                        "inline-flex items-center gap-1 group transition-colors",
                        active ? "text-ppp-blue-700" : "hover:text-ppp-charcoal",
                      ].join(" ")}
                    >
                      <span>{col.label}</span>
                      <SortIcon active={active} dir={sortDir} />
                    </button>
                  </th>
                );
              })}
              <th className="px-6 py-3" />
            </tr>
          </thead>
          <tbody className="text-sm">
            {sorted.map((r, i) => (
              <tr
                key={r.id}
                className="group border-t border-ppp-charcoal-100 hover:bg-ppp-blue-50/40 transition-colors"
              >
                <td className="px-6 py-3.5">
                  <Link href={`/dashboard/rep/${r.id}`} className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-ppp-blue-50 text-ppp-blue text-xs font-bold flex items-center justify-center shrink-0">
                      {r.name.split(" ").map((n) => n[0]).join("")}
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-ppp-charcoal group-hover:text-ppp-blue transition-colors truncate">
                        {r.name}
                      </div>
                      <div className="text-[11px] text-ppp-charcoal-500">#{i + 1} this period</div>
                    </div>
                  </Link>
                </td>
                <td className="px-6 py-3.5 text-ppp-charcoal-500">{r.region}</td>
                <td className="px-6 py-3.5">
                  <ServiceLinePill line={r.serviceLine} />
                </td>
                <td className={`px-6 py-3.5 text-right ${sortKey === "revenueSold" ? "font-bold text-ppp-charcoal" : "font-semibold text-ppp-charcoal"}`}>
                  {fmtMoneyK(r.revenueSold)}
                </td>
                <td className={`px-6 py-3.5 text-right ${sortKey === "closeRate" ? "font-bold text-ppp-charcoal" : "text-ppp-charcoal"}`}>
                  {r.closeRate.toFixed(1)}%
                </td>
                <td className={`px-6 py-3.5 text-right ${sortKey === "avgTicket" ? "font-bold text-ppp-charcoal" : "text-ppp-charcoal"}`}>
                  {fmtMoneyK(r.avgTicket)}
                </td>
                <td className={`px-6 py-3.5 text-right ${sortKey === "openPipeline" ? "font-bold text-ppp-charcoal" : "text-ppp-charcoal-500"}`}>
                  {fmtMoneyK(r.openPipeline)}
                </td>
                <td className="px-6 py-3.5 text-right">
                  <Link
                    href={`/dashboard/rep/${r.id}`}
                    className="text-xs font-medium text-ppp-blue opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap"
                  >
                    Open →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: card list (no horizontal scroll, much easier to read) */}
      <div className="md:hidden">
        {/* Sort selector on mobile */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-ppp-charcoal-100 bg-ppp-charcoal-50/40">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ppp-charcoal-500">
            Sort by
          </span>
          <div className="flex flex-wrap gap-1.5">
            {COLUMNS.map((col) => {
              const active = col.key === sortKey;
              return (
                <button
                  key={col.key}
                  type="button"
                  onClick={() => onHeaderClick(col.key)}
                  className={[
                    "px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors inline-flex items-center gap-1",
                    active
                      ? "bg-ppp-blue text-white"
                      : "bg-white border border-ppp-charcoal-100 text-ppp-charcoal hover:border-ppp-blue-200",
                  ].join(" ")}
                >
                  {col.label}
                  {active && <SortIcon active dir={sortDir} />}
                </button>
              );
            })}
          </div>
        </div>

        <ul className="divide-y divide-ppp-charcoal-100">
          {sorted.map((r, i) => (
            <li key={r.id}>
              <Link
                href={`/dashboard/rep/${r.id}`}
                className="flex items-start gap-3 px-5 py-4 active:bg-ppp-blue-50/40"
              >
                <div className="h-10 w-10 rounded-full bg-ppp-blue-50 text-ppp-blue text-sm font-bold flex items-center justify-center shrink-0">
                  {r.name.split(" ").map((n) => n[0]).join("")}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold text-ppp-charcoal truncate">{r.name}</div>
                    <div className="text-[11px] text-ppp-charcoal-500 shrink-0">#{i + 1}</div>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-ppp-charcoal-500">
                    <span>{r.region}</span>
                    <span>·</span>
                    <ServiceLinePill line={r.serviceLine} tight />
                  </div>
                  <div className="mt-2 grid grid-cols-4 gap-2 text-center">
                    {COLUMNS.map((col) => (
                      <div key={col.key}>
                        <div className={`text-xs font-bold ${col.key === sortKey ? "text-ppp-blue-700" : "text-ppp-charcoal"}`}>
                          {col.format(r)}
                        </div>
                        <div className="text-[9px] uppercase tracking-wide text-ppp-charcoal-500 mt-0.5">
                          {col.label === "Open Pipeline" ? "Pipe" : col.label === "Close Rate" ? "Close" : col.label === "Avg Ticket" ? "Tkt" : "Rev"}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) {
    return (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="opacity-40">
        <path d="M8 9l4-4 4 4 M8 15l4 4 4-4" />
      </svg>
    );
  }
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {dir === "desc" ? <path d="M6 9l6 6 6-6" /> : <path d="M6 15l6-6 6 6" />}
    </svg>
  );
}

function ServiceLinePill({ line, tight = false }: { line: Rep["serviceLine"]; tight?: boolean }) {
  return (
    <span
      className={[
        "inline-flex items-center rounded text-[11px] font-medium border",
        tight ? "px-1.5 py-0" : "px-2 py-0.5",
        line === "Commercial"
          ? "text-ppp-orange-700 bg-ppp-orange-50 border-ppp-orange-100"
          : "text-ppp-blue-700 bg-ppp-blue-50 border-ppp-blue-100",
      ].join(" ")}
    >
      {line}
    </span>
  );
}
