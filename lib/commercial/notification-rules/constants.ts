/**
 * Custom notification-rule triggers + channels (Block 3B). Client-safe (no
 * server imports) so the settings UI can render the trigger picker.
 */

export const RULE_TRIGGERS = [
  "invoice_overdue",
  "invoice_due_soon",
  "invoice_paid",
  "proposal_idle",
  "followup_due",
  "opp_no_activity",
  "deal_won",
  "deal_lost",
] as const;
export type RuleTrigger = (typeof RULE_TRIGGERS)[number];

/** Group triggers for the picker UI. */
export const TRIGGER_GROUPS: { heading: string; triggers: RuleTrigger[] }[] = [
  { heading: "Invoices", triggers: ["invoice_overdue", "invoice_due_soon", "invoice_paid"] },
  { heading: "Proposals & deals", triggers: ["proposal_idle", "followup_due", "opp_no_activity", "deal_won", "deal_lost"] },
];

export const RULE_CHANNELS = ["bell", "email", "both"] as const;
export type RuleChannel = (typeof RULE_CHANNELS)[number];

type TriggerMeta = {
  label: string;
  /** Short description shown under the picker. */
  blurb: string;
  /** Does this trigger use the "N days" threshold? followup_due doesn't. */
  usesThreshold: boolean;
  /** Sensible default threshold. */
  defaultDays: number;
  /** Wording for the threshold field, e.g. "days past due". */
  thresholdNoun: string;
};

export const TRIGGER_META: Record<RuleTrigger, TriggerMeta> = {
  invoice_overdue: {
    label: "Invoice past due",
    blurb: "When an invoice is a set number of days past its due date.",
    usesThreshold: true,
    defaultDays: 15,
    thresholdNoun: "days past due",
  },
  invoice_due_soon: {
    label: "Invoice due soon",
    blurb: "When an invoice is coming due within a set number of days.",
    usesThreshold: true,
    defaultDays: 7,
    thresholdNoun: "days before due",
  },
  invoice_paid: {
    label: "Invoice paid",
    blurb: "When an invoice is paid in full.",
    usesThreshold: false,
    defaultDays: 0,
    thresholdNoun: "",
  },
  deal_won: {
    label: "Opportunity won",
    blurb: "When an opportunity is marked won.",
    usesThreshold: false,
    defaultDays: 0,
    thresholdNoun: "",
  },
  deal_lost: {
    label: "Opportunity lost",
    blurb: "When an opportunity is marked lost.",
    usesThreshold: false,
    defaultDays: 0,
    thresholdNoun: "",
  },
  proposal_idle: {
    label: "Proposal with no response",
    blurb: "When a sent proposal has gone this many days without a response.",
    usesThreshold: true,
    defaultDays: 7,
    thresholdNoun: "days since sent",
  },
  followup_due: {
    label: "Follow-up date reached",
    blurb: "When a deal's scheduled follow-up date arrives.",
    usesThreshold: false,
    defaultDays: 0,
    thresholdNoun: "",
  },
  opp_no_activity: {
    label: "Deal with no activity",
    blurb: "When an open deal hasn't been touched in this many days.",
    usesThreshold: true,
    defaultDays: 14,
    thresholdNoun: "days idle",
  },
};

export function ruleTriggerLabel(trigger: string): string {
  return (TRIGGER_META as Record<string, TriggerMeta>)[trigger]?.label ?? trigger;
}

export function ruleChannelLabel(channel: string): string {
  // The bell is always written, so "email" is really "in-app + email" — there
  // is no email-only mode (Karan 2026-07-27 audit).
  switch (channel) {
    case "bell":
      return "In-app only";
    default:
      return "In-app + email";
  }
}

/** One-line human summary of a rule, e.g. "Invoice past due · 15 days past due". */
export function ruleSummary(trigger: string, thresholdDays: number): string {
  const meta = (TRIGGER_META as Record<string, TriggerMeta>)[trigger];
  if (!meta) return trigger;
  if (!meta.usesThreshold) return meta.label;
  return `${meta.label} · ${thresholdDays} ${meta.thresholdNoun}`;
}
