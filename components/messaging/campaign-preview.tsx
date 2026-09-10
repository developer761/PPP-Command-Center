"use client";

import { useState } from "react";
import { fillMergeFields, unresolvedFields } from "@/lib/messaging/merge-fields";

type Step = {
  ordinal: number; channel: "sms" | "email"; body: string;
  subject: string | null; timing: string;
};
type Workspace = { id: string; name: string; phone_e164: string | null };

/**
 * The sequence as the customer receives it.
 *
 * The single most useful thing Hatch does not do. PPP finds out a message is
 * broken when somebody gets it — the opener said "Call us at
 * {{workspace_phone}}" and nothing filled it, and nothing on any screen would
 * have shown that before it went out.
 *
 * Picking a workspace fills the blanks with THAT workspace's real values, so
 * Nassau and Queens can be compared side by side and a placeholder nobody
 * defined is visible as itself.
 */
export default function CampaignPreview({
  steps, workspaces,
}: {
  steps: Step[];
  workspaces: Workspace[];
}) {
  const [wsId, setWsId] = useState(workspaces[0]?.id ?? "");
  const ws = workspaces.find((w) => w.id === wsId) ?? workspaces[0];

  const filled = (body: string) =>
    fillMergeFields(body, { workspacePhone: ws?.phone_e164, workspaceName: ws?.name });

  return (
    <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
        <h2 className="font-semibold text-ppp-charcoal text-[14px]">What the customer actually gets</h2>
        <p className="mt-0.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">
          Filled in with one workspace&apos;s real details, so anything still
          showing as a blank would go out that way.
        </p>
      </div>

      {workspaces.length > 1 && (
        <nav className="flex gap-1.5 overflow-x-auto px-3 py-2 border-b border-ppp-charcoal-100">
          {workspaces.map((w) => (
            <button key={w.id} type="button" onClick={() => setWsId(w.id)}
              aria-pressed={w.id === wsId}
              className={[
                "shrink-0 min-h-[36px] px-3 rounded-lg text-[12px] font-medium whitespace-nowrap touch-manipulation",
                w.id === wsId ? "bg-ppp-charcoal text-white" : "bg-white border border-ppp-charcoal-200 text-ppp-charcoal-600",
              ].join(" ")}>
              {w.name}
            </button>
          ))}
        </nav>
      )}

      <ol className="px-3 py-3 space-y-3">
        {steps.map((s) => {
          const body = filled(s.body);
          const blanks = [...new Set(unresolvedFields(body))];
          return (
            <li key={s.ordinal} className="flex gap-2.5">
              <span className="shrink-0 w-16 pt-1 text-[11px] font-medium text-ppp-charcoal-400 leading-snug">
                {s.timing}
              </span>
              <div className="flex-1 min-w-0">
                {s.channel === "email" ? (
                  <div className="rounded-xl border border-ppp-charcoal-100 bg-ppp-charcoal-50 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-ppp-charcoal-400">Email</p>
                    <p className="mt-0.5 text-[13px] font-semibold text-ppp-charcoal">{s.subject ?? "(no subject)"}</p>
                    <p className="mt-1 text-[12.5px] text-ppp-charcoal-600 leading-relaxed whitespace-pre-wrap">{body}</p>
                  </div>
                ) : (
                  <p className="inline-block max-w-full rounded-2xl bg-ppp-charcoal px-3 py-2 text-[13.5px] leading-snug text-white whitespace-pre-wrap">
                    {body}
                  </p>
                )}
                <p className="mt-1 text-[11px] text-ppp-charcoal-400">
                  {s.channel === "sms" && (
                    <>{body.length} characters, about {Math.max(1, Math.ceil(body.length / 160))} text{body.length > 160 ? "s" : ""}</>
                  )}
                </p>
                {blanks.length > 0 && (
                  <p className="mt-1 text-[12px] text-ppp-orange-700 leading-relaxed">
                    Still has {blanks.map((b) => `{{${b}}}`).join(", ")} in it. The send gate refuses
                    messages with a blank left in them, so this one would never go out.
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
