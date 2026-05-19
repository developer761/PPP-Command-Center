"use client";

import { useEffect, useState } from "react";

export default function Topbar() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!now) return <header className="h-[73px] bg-white border-b border-ppp-charcoal-100" />;

  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const dateText = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <header className="bg-white border-b border-ppp-charcoal-100 px-8 py-4 flex items-center justify-between">
      <div>
        <h2 className="text-base font-semibold text-ppp-charcoal">
          {greeting}, Aaron
        </h2>
        <p className="text-xs text-ppp-charcoal-500 mt-0.5">{dateText}</p>
      </div>

      <div className="flex items-center gap-3">
        <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 bg-ppp-green-50 border border-ppp-green-100 rounded-full">
          <span className="h-1.5 w-1.5 rounded-full bg-ppp-green animate-pulse" />
          <span className="text-[11px] font-medium text-ppp-green-700">Live · synced 2 min ago</span>
        </div>

        <button
          type="button"
          className="text-sm font-medium text-ppp-charcoal-500 hover:text-ppp-blue transition-colors px-3 py-1.5 rounded-lg hover:bg-ppp-blue-50"
        >
          Refresh
        </button>

        <div className="h-9 w-9 rounded-full bg-ppp-blue text-white flex items-center justify-center font-semibold text-sm shadow-sm shadow-ppp-blue/30">
          A
        </div>
      </div>
    </header>
  );
}
