import AgentScopePicker from "@/components/messaging/agent-scope-picker";
import AgentConfigEditor from "@/components/messaging/agent-config-editor";
import WorkspaceServices from "@/components/messaging/workspace-services";
import { resolveServices } from "@/lib/messaging/services";
import { loadAgentConfig, activeWorkspaces, workspacesWithOwnConfig, configuredStates, loadWorkspaceServices, END_STATES } from "@/lib/messaging/db";

export const dynamic = "force-dynamic";

const FLOW_LABEL: Record<string, string> = {
  project_details: "Project details",
  full_address: "Full address",
  contact_information: "Contact information",
  appointment_availability: "Appointment availability",
};

/**
 * Configure the chatbot.
 *
 * Emily's rules live in Hatch as one prose block. The parts that genuinely vary
 * are fields here; the parts that are prose stay prose. A workspace inherits
 * the default until it needs its own.
 *
 * The locked panel is the point of the page as much as the editable ones. An
 * operator who cannot find the quiet-hours setting should learn that it is
 * deliberate, not hunt for it — the absence of a control is only reassuring if
 * something says so.
 */
export default async function AgentConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string; state?: string; track?: string }>;
}) {
  const sp = await searchParams;
  const track = sp.track === "nurture" ? "nurture" : "new_lead";
  const [{ config, own, from, isOverride, hasStateLayer, state, hasDefault }, workspaces, overrides, states, svc] = await Promise.all([
    loadAgentConfig(sp.ws, track, sp.state),
    activeWorkspaces(),
    workspacesWithOwnConfig(track),
    configuredStates(track),
    loadWorkspaceServices(sp.ws),
  ]);
  const wsName = workspaces.find((w) => w.id === sp.ws)?.name;

  if (!hasDefault) {
    return (
      <main className="max-w-3xl mx-auto px-4 py-4 pb-safe">
        <div className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-4">
          <p className="font-semibold text-ppp-orange-700">No agent configuration yet</p>
          <p className="mt-1 text-[13px] text-ppp-orange-700/90 leading-relaxed">
            Run migration 185 to seed the default from PPP&apos;s live Hatch prompt.
          </p>
        </div>
      </main>
    );
  }

  const c = config!;
  const flow = Array.isArray(c.required_flow) ? c.required_flow : [];

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe space-y-4">
      <AgentScopePicker workspaces={workspaces} current={sp.ws} currentState={sp.state} states={states} overrides={overrides} track={track} />

      {sp.ws && wsName && svc.services.length > 0 && (
        <WorkspaceServices
          workspaceId={sp.ws}
          workspaceName={wsName}
          services={resolveServices(svc.services, svc.exceptions)}
        />
      )}

      <header>
        <h1 className="text-lg font-bold text-ppp-charcoal">
          {c.persona_name} — {wsName ?? "default for every workspace"}
        </h1>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          {isOverride
            ? `Overrides the default for ${wsName}.`
            : "Inherited by every workspace that has no override of its own."}
          {hasStateLayer && state ? ` Some of it comes from the ${state} rules, shared by every ${state} workspace.` : ""}
        </p>
      </header>

      {/* Locked first, deliberately. The most important thing on this screen is
          what it CANNOT do. */}
      <section className="rounded-xl border border-ppp-charcoal-200 bg-ppp-charcoal-50 px-4 py-3">
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" className="text-ppp-charcoal-500 shrink-0" aria-hidden>
            <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <p className="text-[13px] font-semibold text-ppp-charcoal">Not configurable here, on purpose</p>
        </div>
        <p className="mt-1.5 text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
          Quiet hours, the opt-out list and the per-customer daily cap live in the
          send gate, not on this page. There is no field for them because a
          campaign or an agent must not be able to configure its way into a
          message somebody told us not to send. Changing those is a code change
          with a test behind it.
        </p>
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <h2 className="px-4 py-2.5 border-b border-ppp-charcoal-100 font-semibold text-ppp-charcoal text-[14px]">Behaviour</h2>
        <dl className="divide-y divide-ppp-charcoal-100">
          {[
            ["Sending", c.autosend ? "Auto-send" : "Draft for review", c.autosend
              ? "Replies go out without a human reading them first."
              : "Every reply is read by a person before it sends. Earned per workspace after a clean run, never switched on globally."],
            ["Confidence threshold", String(c.confidence_threshold),
              "Below this the agent escalates instead of answering. Starts strict and comes down as it earns it."],
            ["Max turns", String(c.max_turns),
              "A conversation that runs longer hands to a human rather than looping."],
          ].map(([label, value, note]) => (
            <div key={label} className="px-4 py-3">
              <dt className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] font-medium text-ppp-charcoal">{label}</span>
                <span className="shrink-0 text-[13px] font-semibold text-ppp-charcoal tabular-nums">{value}</span>
              </dt>
              <dd className="mt-1 text-[12px] text-ppp-charcoal-500 leading-relaxed">{note}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <h2 className="px-4 py-2.5 border-b border-ppp-charcoal-100 font-semibold text-ppp-charcoal text-[14px]">
          Required information, in order
        </h2>
        <ol className="px-4 py-3 space-y-2">
          {flow.map((k, i) => (
            <li key={k} className="flex items-center gap-2.5">
              <span className="h-6 w-6 shrink-0 rounded-full bg-ppp-charcoal-50 text-ppp-charcoal-600 text-[11px] font-bold flex items-center justify-center tabular-nums">
                {i + 1}
              </span>
              <span className="text-[13px] text-ppp-charcoal">{FLOW_LABEL[k] ?? k}</span>
            </li>
          ))}
        </ol>
        <p className="px-4 pb-3 text-[12px] text-ppp-charcoal-500 leading-relaxed">
          The order is the rule. Even when an off-site quote replaces the
          appointment, the first three are still collected and never reordered.
        </p>
      </section>

      <AgentConfigEditor
        where={
          sp.ws ? { scope: "workspace", workspaceId: sp.ws }
            : sp.state ? { scope: "state", stateCode: sp.state }
            : { scope: "global" }
        }
        track={track}
        levelName={wsName ? `${wsName} only` : sp.state ? `Emily ${sp.state} — every ${sp.state} workspace` : "the default every workspace inherits"}
        canClear={(!!sp.ws && isOverride) || !!sp.state}
        threshold={Number(c.confidence_threshold ?? 0.95)}
        maxTurns={Number(c.max_turns ?? 20)}
        fields={[
          { key: "persona_name", label: "Name", value: own?.persona_name ?? "", inherited: c.persona_name, from: from?.persona_name },
          { key: "office_location", label: "Office location", value: own?.office_location ?? "", inherited: c.office_location, from: from?.office_location,
            help: "Where we say the office is when somebody asks." },
          { key: "service_area_note", label: "Service area", value: own?.service_area_note ?? "", inherited: c.service_area_note, from: from?.service_area_note },
          { key: "services_included", label: "What we cover", long: true, value: own?.services_included ?? "", inherited: c.services_included, from: from?.services_included },
          { key: "services_excluded", label: "What we do not cover", long: true, value: own?.services_excluded ?? "", inherited: c.services_excluded, from: from?.services_excluded },
          { key: "offsite_rules", label: "Off-site quotes", long: true, value: own?.offsite_rules ?? "", inherited: c.offsite_rules, from: from?.offsite_rules },
          { key: "tone_rules", label: "Tone", long: true, value: own?.tone_rules ?? "", inherited: c.tone_rules, from: from?.tone_rules },
        ]}
      />

      {/* The read-only copies of these four lived here and are gone: the
          editor above shows the same fields, so the page rendered each of
          them twice and Karan read the lower one and asked for it to be made
          editable. It already was, forty lines up. */}

      {/* Only when this level is genuinely still showing the CA-derived
          default. The first version fired whenever a location existed at all,
          so it went on warning that New York needed its own value long after
          New York had one — Garden City, set on the state row. A warning that
          is wrong is worse than no warning: people learn to scroll past it. */}
      {(sp.ws || sp.state) && from?.office_location === "global" && c.office_location && (
        <section className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-3">
          <p className="text-[13px] font-semibold text-ppp-orange-700">Still answering with the default location</p>
          <p className="mt-1.5 text-[12.5px] text-ppp-orange-700/90 leading-relaxed">
            This level has no location of its own, so it inherits the default —
            office in <strong>{c.office_location}</strong>, serving{" "}
            <strong>{c.service_area_note}</strong>. That came from the CA LA
            campaign. Somebody here asking where the office is would be told
            Pasadena, so set a location below before this one goes live.
          </p>
        </section>
      )}

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <h2 className="px-4 py-2.5 border-b border-ppp-charcoal-100 font-semibold text-ppp-charcoal text-[14px]">
          How a conversation ends
        </h2>
        <ul className="divide-y divide-ppp-charcoal-100">
          {END_STATES.map((s) => (
            <li key={s.key} className="px-4 py-2.5">
              <p className="text-[13px] font-medium text-ppp-charcoal">{s.label}</p>
              <p className="mt-0.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">{s.when}</p>
            </li>
          ))}
        </ul>
        <p className="px-4 py-3 text-[12px] text-ppp-charcoal-500 leading-relaxed border-t border-ppp-charcoal-100">
          Hatch&apos;s own vocabulary, kept exactly. The office already knows what
          these mean, and it makes the parallel run comparable without a mapping.
        </p>
      </section>
    </main>
  );
}
