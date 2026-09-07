/**
 * Resolve one agent configuration from three layers.
 *
 * global <- state <- workspace, most specific wins.
 *
 * The distinction that matters and is easy to get wrong: NULL means INHERIT,
 * an empty string means DELIBERATELY BLANK. A workspace that should answer
 * nothing when asked where the office is has to be able to say so, and it
 * cannot if we treat empty and absent the same. That is why this is not
 * Object.assign.
 *
 * Pure — the caller supplies the layers, so every combination is testable
 * without a database.
 */

export type ConfigScope = "global" | "state" | "workspace";

export type AgentConfigLayer = {
  scope: ConfigScope;
  state_code?: string | null;
  workspace_id?: string | null;
  persona_name?: string | null;
  persona_role?: string | null;
  required_flow?: string[] | null;
  services_included?: string | null;
  services_excluded?: string | null;
  offsite_rules?: string | null;
  tone_rules?: string | null;
  office_location?: string | null;
  service_area_note?: string | null;
  confidence_threshold?: number | null;
  autosend?: boolean | null;
  max_turns?: number | null;
  booking_hours?: unknown;
};

/** Where each resolved value came from, so the UI can show inheritance rather
 *  than presenting everything as if it were set locally. */
export type Provenance = Partial<Record<keyof AgentConfigLayer, ConfigScope>>;

export type ResolvedConfig = {
  value: AgentConfigLayer;
  from: Provenance;
};

const ORDER: ConfigScope[] = ["global", "state", "workspace"];

/** Fields that carry a value. Scope keys are not inherited — they identify the
 *  layer rather than describe the agent. */
const FIELDS: (keyof AgentConfigLayer)[] = [
  "persona_name", "persona_role", "required_flow",
  "services_included", "services_excluded", "offsite_rules", "tone_rules",
  "office_location", "service_area_note",
  "confidence_threshold", "autosend", "max_turns", "booking_hours",
];

/**
 * Layers may arrive in any order; they are sorted by specificity here rather
 * than trusted, because a caller passing them the wrong way round would
 * silently produce a config where the global default beats the workspace.
 */
export function resolveAgentConfig(layers: AgentConfigLayer[]): ResolvedConfig {
  const sorted = [...layers].sort(
    (a, b) => ORDER.indexOf(a.scope) - ORDER.indexOf(b.scope)
  );

  const value: AgentConfigLayer = { scope: "global" };
  const from: Provenance = {};

  for (const layer of sorted) {
    for (const f of FIELDS) {
      const v = layer[f];
      // undefined = the column was not selected. null = inherit. Neither
      // overrides. An empty string DOES override — that is a deliberate blank.
      if (v === undefined || v === null) continue;
      (value as Record<string, unknown>)[f] = v;
      from[f] = layer.scope;
    }
    // Carry the identifying keys of the most specific layer so the caller
    // knows what it resolved FOR.
    if (layer.state_code != null) value.state_code = layer.state_code;
    if (layer.workspace_id != null) value.workspace_id = layer.workspace_id;
    value.scope = layer.scope;
  }

  return { value, from };
}

/**
 * Which state does a workspace belong to?
 *
 * Derived from the name because that is how PPP names them and there is no
 * state column.
 *
 * An EXPLICIT state prefix always wins over a county name. Nassau County
 * exists in Florida as well as New York, and Suffolk County exists in both
 * too — the first cut checked the county list first, so "FL Nassau Leads"
 * would have resolved to NY and told a Florida customer the office was in
 * Garden City. No such workspace exists today, which is exactly why it would
 * have gone unnoticed until the day one did.
 */
export function stateOfWorkspace(name: string): string | null {
  const n = name.trim();
  if (/^AM - /i.test(n)) {
    // Account-management workspaces carry the region after the prefix.
    return stateOfWorkspace(n.replace(/^AM - /i, ""));
  }

  // 1. Explicit state prefix. Unambiguous, so it is checked first.
  const prefix = /^(NY|NYC|NJ|FL|CT|CA|CO|TX)\b/i.exec(n);
  if (prefix) {
    const p = prefix[1].toUpperCase();
    return p === "NYC" ? "NY" : p;
  }

  // 2. Regional words that imply a state on their own.
  if (/SoFlo/i.test(n)) return "FL";
  if (/\bWC\s+CT\b/i.test(n) || /\bCT\b/i.test(n)) return "CT";
  if (/\bDallas\b/i.test(n)) return "TX";

  // 3. County and borough names, last, so a state prefix always beats them.
  if (/\b(LI|Queens|Wstch|Nassau|Suffolk)\b/i.test(n)) return "NY";

  return null;
}
