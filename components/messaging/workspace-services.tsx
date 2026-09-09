"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setWorkspaceService, clearWorkspaceServices } from "@/lib/messaging/services-write";
import type { ResolvedService } from "@/lib/messaging/services";

/**
 * What this workspace covers.
 *
 * Every service shows its own state AND whether that differs from the default,
 * because the question being answered is never "does this workspace do
 * flooring" on its own — it is "does this workspace differ from everywhere
 * else", and an unmarked list cannot answer that.
 */
export default function WorkspaceServices({
  workspaceId, workspaceName, services,
}: {
  workspaceId: string;
  workspaceName: string;
  services: ResolvedService[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [local, setLocal] = useState(services);

  const toggle = async (key: string, covered: boolean) => {
    setBusy(key); setErr(null);
    // Optimistic, because a checklist that lags feels broken.
    setLocal((p) => p.map((s) => (s.key === key ? { ...s, covered } : s)));
    try {
      const res = await setWorkspaceService({ workspaceId, serviceKey: key, covered });
      if (!res.ok) {
        setErr(res.error);
        setLocal(services);
        return;
      }
      setLocal((p) => p.map((s) => (s.key === key ? { ...s, covered, isException: res.isException } : s)));
      router.refresh();
    } catch {
      setErr("Could not save that. Nothing changed.");
      setLocal(services);
    } finally { setBusy(null); }
  };

  const reset = async () => {
    setBusy("__all"); setErr(null);
    try {
      const res = await clearWorkspaceServices(workspaceId);
      if (!res.ok) { setErr(res.error); return; }
      router.refresh();
    } finally { setBusy(null); }
  };

  const differs = local.filter((s) => s.isException).length;

  return (
    <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
        <h2 className="font-semibold text-ppp-charcoal text-[14px]">What {workspaceName} covers</h2>
        <p className="mt-0.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">
          {differs === 0
            ? "Everything the default covers. Untick anything this area does not do."
            : `${differs} ${differs === 1 ? "difference" : "differences"} from the default.`}
          {" "}Anything unticked, the bot is told explicitly that we do not do it here.
        </p>
      </div>

      <ul className="divide-y divide-ppp-charcoal-100">
        {local.map((s) => (
          <li key={s.key}>
            <button
              type="button"
              onClick={() => void toggle(s.key, !s.covered)}
              disabled={busy !== null}
              aria-pressed={s.covered}
              className="w-full min-h-[52px] px-4 py-2 flex items-center gap-3 text-left touch-manipulation disabled:opacity-50"
            >
              <span aria-hidden className={[
                "shrink-0 h-5 w-5 rounded-md border-2 flex items-center justify-center",
                s.covered ? "bg-ppp-charcoal border-ppp-charcoal text-white" : "border-ppp-charcoal-200",
              ].join(" ")}>
                {s.covered && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                )}
              </span>
              <span className="flex-1 min-w-0">
                <span className={`block text-[13.5px] ${s.covered ? "text-ppp-charcoal" : "text-ppp-charcoal-400 line-through"}`}>
                  {s.label}
                </span>
                {s.isException && (
                  <span className="block text-[11.5px] text-ppp-orange-700">
                    Different from the default
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {err && <p className="px-4 py-2 text-[12.5px] text-ppp-orange-700 bg-ppp-orange-50">{err}</p>}

      {differs > 0 && (
        <div className="px-4 py-3 border-t border-ppp-charcoal-100">
          <button type="button" onClick={() => void reset()} disabled={busy !== null}
            className="min-h-[44px] px-3 rounded-lg border border-ppp-charcoal-200 bg-white text-[12.5px] font-semibold text-ppp-charcoal-600 touch-manipulation">
            Put this workspace back on the default
          </button>
        </div>
      )}

      <p className="px-4 py-3 border-t border-ppp-charcoal-100 text-[11.5px] text-ppp-charcoal-400 leading-relaxed">
        Bathtubs, appliances, vehicles, industrial equipment, pool liners, murals
        and standalone furniture are not here on purpose. We never do those
        anywhere, and the rule is enforced in code — a workspace could not opt
        into one even if this screen offered it.
      </p>
    </section>
  );
}
