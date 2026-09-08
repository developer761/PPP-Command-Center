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
  workspaces, current, currentState, states, overrides, track,
}: {
  workspaces: { id: string; name: string }[];
  current?: string;
  /** The state layer being edited, if any. "Emily NY" is this tier: the main
   *  Emily following New York's rules. */
  currentState?: string;
  states: string[];
  /** Which of the two conversations we are configuring. */
  track: "new_lead" | "nurture";
  /** Workspace ids that have a row of their own, marked so the list says which
   *  ones differ rather than making Kate click through eighteen to find out. */
  overrides: string[];
}) {
  const router = useRouter();

  const go = (opts: { ws?: string; state?: string; t?: string }) => {
    const p = new URLSearchParams();
    if (opts.ws) p.set("ws", opts.ws);
    else if (opts.state) p.set("state", opts.state);
    const t = opts.t ?? track;
    if (t !== "new_lead") p.set("track", t);
    const q = p.toString();
    router.push(`/messaging/agent${q ? `?${q}` : ""}`);
  };

  // One value for the select, so the three levels read as one choice rather
  // than two controls that can contradict each other.
  const selected = current ? `ws:${current}` : currentState ? `st:${currentState}` : "";

  return (
    <div className="space-y-3">
      {/* Two different conversations, not two settings of one. */}
      <div>
        <span className="block text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-1">
          Which conversation
        </span>
        <div className="flex gap-2">
          {([["new_lead", "New lead"], ["nurture", "Quote already sent"]] as const).map(([v, label]) => (
            <button key={v} type="button" onClick={() => go({ ws: current, state: currentState, t: v })}
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
        value={selected}
        onChange={(e) => {
          const v = e.target.value;
          if (v.startsWith("ws:")) go({ ws: v.slice(3) });
          else if (v.startsWith("st:")) go({ state: v.slice(3) });
          else go({});
        }}
        className="w-full min-h-[44px] rounded-xl border border-ppp-charcoal-200 bg-white px-3 text-[14px] text-ppp-charcoal touch-manipulation"
      >
        <option value="">Emily — the default every workspace inherits</option>
        {states.length > 0 && (
          <optgroup label="By state — the main Emily following that state's rules">
            {states.map((st) => (
              <option key={st} value={`st:${st}`}>Emily {st}</option>
            ))}
          </optgroup>
        )}
        <optgroup label="One workspace only">
          {workspaces.map((w) => (
            <option key={w.id} value={`ws:${w.id}`}>
              {w.name}{overrides.includes(w.id) ? " — has its own rules" : ""}
            </option>
          ))}
        </optgroup>
      </select>
    </div>
    </div>
  );
}
