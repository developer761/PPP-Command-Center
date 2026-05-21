"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "@/components/sidebar";
import Topbar from "@/components/topbar";

type SearchableSnapshot = {
  reps?: Array<{ id: string; name: string; email?: string | null; region?: string | null }>;
  accounts?: Array<{ id: string; name: string; type?: string | null; region?: string | null }>;
  workOrders?: Array<{
    id: string;
    workOrderNumber: string | null;
    accountName: string | null;
    status: string | null;
    ownerName: string | null;
    opportunityId: string | null;
  }>;
};

type Props = {
  children: React.ReactNode;
  user: {
    email: string;
    fullName: string | null;
    firstName: string | null;
    initial: string;
  };
  searchIndex?: SearchableSnapshot | null;
};

export default function DashboardChrome({ children, user, searchIndex = null }: Props) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (mobileOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [mobileOpen]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  return (
    <div className="flex min-h-screen bg-[var(--color-surface-muted)]">
      <aside className="hidden lg:block shrink-0">
        <Sidebar />
      </aside>

      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-ppp-charcoal/40 backdrop-blur-sm animate-fade-in"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}
      <aside
        className={[
          "lg:hidden fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] shadow-2xl shadow-ppp-charcoal/20",
          "transform transition-transform duration-200 ease-out",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        ].join(" ")}
        aria-hidden={!mobileOpen}
      >
        <Sidebar onNavigate={() => setMobileOpen(false)} />
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <Topbar onOpenMenu={() => setMobileOpen(true)} user={user} searchIndex={searchIndex} />
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 lg:py-10">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
