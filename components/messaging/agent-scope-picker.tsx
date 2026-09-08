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
  workspaces, current, overrides,
}: {
  workspaces: { id: string; name: string }[];
  current?: string;
  /** Workspace ids that have a row of their own, marked so the list says which
   *  ones differ rather than making Kate click through eighteen to find out. */
  overrides: string[];
}) {
  const router = useRouter();

  return (
    <div>
      <label htmlFor="agent-scope" className="block text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-1">
        Which workspace
      </label>
      <select
        id="agent-scope"
        value={current ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          router.push(v ? `/messaging/agent?ws=${v}` : "/messaging/agent");
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
  );
}
