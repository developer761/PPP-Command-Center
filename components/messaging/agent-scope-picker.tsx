"use client";

import { useRouter } from "next/navigation";

/**
 * Which chatbot am I looking at?
 *
 * Karan, 2026-09-08: "I still don't see the workspace-specific chatbots in
 * Chatbot." They existed — eighteen workspace rows and six state rows — but
 * the page only read a ?ws= query parameter and never offered a way to set it,
 * so every one of them was unreachable without hand-editing the URL.
 */
export default function AgentScopePicker({
  workspaces, current, overrides, track,
}: {
  workspaces: { id: string; name: string }[];
  current?: string;
  /** Which of the two conversations we are configuring. */
  track: "new_lead" | "nurture";
  /** Workspace ids that have a row of their own, marked so the list says which
   *  ones differ rather than making Kate click through eighteen to find out. */
  overrides: string[];
}) {
  const router = useRouter();

  const go = (ws: string | undefined, t: string) => {
    const p = new URLSearchParams();
    if (ws) p.set("ws", ws);
    if (t !== "new_lead") p.set("track", t);
    const q = p.toString();
    router.push(`/messaging/agent${q ? `?${q}` : ""}`);
  };

  return (
    <div className="space-y-3">
      {/* Two different conversations, not two settings of one. */}
      <div>
        <span className="block text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-1">
          Which conversation
        </span>
        <div className="flex gap-2">
          {([["new_lead", "New lead"], ["nurture", "Quote already sent"]] as const).map(([v, label]) => (
            <button key={v} type="button" onClick={() => go(current, v)}
              aria-pressed={track === v}
              className={[
                "flex-1 min-h-[44px] px-3 rounded-xl text-[13px] font-semibold border touch-manipulation",
                track === v
                  ? "bg-ppp-charcoal text-white border-ppp-charcoal"
                  : "bg-white text-ppp-charcoal-600 border-ppp-charcoal-200",
              ].join(" ")}>
              {label}
            </button>
          ))}
        </div>
      </div>
    <div>
      <label htmlFor="agent-scope" className="block text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-1">
        Which workspace
      </label>
      <select
        id="agent-scope"
        value={current ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          go(v || undefined, track);
        }}
        className="w-full min-h-[44px] rounded-xl border border-ppp-charcoal-200 bg-white px-3 text-[14px] text-ppp-charcoal touch-manipulation"
      >
        <option value="">The default — every workspace with no rules of its own</option>
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}{overrides.includes(w.id) ? " — has its own rules" : ""}
          </option>
        ))}
      </select>
    </div>
    </div>
  );
}
