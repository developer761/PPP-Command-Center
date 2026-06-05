"use client";

import { useMemo, useState } from "react";

type Templates = {
  email_subject: string;
  email_intro: string;
  email_outro: string;
  email_signoff: string;
  form_header_eyebrow: string;
  form_header_title: string;
  form_header_subtitle: string;
  form_intro_body: string;
  form_global_notes_label: string;
  form_thankyou_title: string;
  form_thankyou_body: string;
};

type Props = {
  initial: Templates;
  defaults: Templates;
  isCustomized: boolean;
  updatedAt: string | null;
};

type FieldDef = {
  key: keyof Templates;
  label: string;
  help: string;
  multiline: boolean;
  rows?: number;
};

/** Two semantic groups so the editor reads like a doc, not a settings page. */
const EMAIL_FIELDS: FieldDef[] = [
  {
    key: "email_subject",
    label: "Email subject line",
    help: "Variables: {{wo_number}}, {{customer_first}}",
    multiline: false,
  },
  {
    key: "email_intro",
    label: "Opening paragraph",
    help: "Variables: {{customer_first}}, {{wo_number}}, {{ppp_brand}}",
    multiline: true,
    rows: 4,
  },
  {
    key: "email_outro",
    label: "Closing paragraph (above signoff)",
    help: "Use blank lines to separate paragraphs.",
    multiline: true,
    rows: 4,
  },
  {
    key: "email_signoff",
    label: "Signoff",
    help: "Variables: {{ppp_brand}}. Use \\n for new lines.",
    multiline: true,
    rows: 2,
  },
];

const FORM_FIELDS: FieldDef[] = [
  {
    key: "form_header_eyebrow",
    label: "Small uppercase label above the title",
    help: "Tiny chip-style label. Keep under 30 characters.",
    multiline: false,
  },
  {
    key: "form_header_title",
    label: "Main page title (H1)",
    help: "Variables: {{customer_first}}",
    multiline: false,
  },
  {
    key: "form_header_subtitle",
    label: "Subtitle / description",
    help: "Variables: {{customer_first}}, {{wo_number}}, {{ppp_brand}}",
    multiline: true,
    rows: 4,
  },
  {
    key: "form_global_notes_label",
    label: "Label above the “anything else?” textarea",
    help: "Short — appears as a form label.",
    multiline: false,
  },
  {
    key: "form_thankyou_title",
    label: "Thank-you screen title (H1)",
    help: "Shown after the customer hits Submit.",
    multiline: false,
  },
  {
    key: "form_thankyou_body",
    label: "Thank-you screen body",
    help: "Variables: {{ppp_brand}}",
    multiline: true,
    rows: 4,
  },
];

const ALL_FIELDS: FieldDef[] = [...EMAIL_FIELDS, ...FORM_FIELDS];

/**
 * Variables the customer-form template renderer actually substitutes —
 * MUST stay in lockstep with `buildVars()` in lib/customer-form/templates.ts.
 * Used by the typo linter so a `{{custmer_name}}` lights up as a warning
 * instead of silently shipping into the email as literal text. Round 4
 * audit 2026-06-04: admin editor agent flagged the silent-typo risk.
 */
const KNOWN_VARIABLES = new Set([
  "customer_name",
  "customer_first",
  "wo_number",
  "form_url",
  "ppp_brand",
]);

/** Extract every {{token}} from a template body and return the unknown ones. */
function findUnknownVariables(text: string): string[] {
  const out = new Set<string>();
  // Match {{name}} with optional surrounding whitespace; allow [a-z0-9_].
  // Reject Mustache section markers (#name / /name) — those are syntax,
  // not variables, and the customer-form renderer doesn't support them.
  const re = /\{\{\s*([#/]?[a-zA-Z0-9_]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    // Skip Mustache section markers — flag separately if needed; the
    // customer-form templating doesn't support them, but we don't want
    // to spam the editor for now.
    if (raw.startsWith("#") || raw.startsWith("/")) continue;
    if (!KNOWN_VARIABLES.has(raw)) out.add(raw);
  }
  return Array.from(out);
}

export default function TemplatesEditor({ initial, defaults, isCustomized, updatedAt }: Props) {
  const [draft, setDraft] = useState<Templates>(initial);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Track which fields have been modified vs the initial load (NOT vs default
  // — admin might be reverting an old override which is a meaningful edit).
  const dirtyKeys = useMemo(() => {
    const keys = new Set<keyof Templates>();
    for (const k of Object.keys(initial) as Array<keyof Templates>) {
      if (draft[k] !== initial[k]) keys.add(k);
    }
    return keys;
  }, [draft, initial]);

  const isDirty = dirtyKeys.size > 0;

  const save = async () => {
    if (!isDirty || saving) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const patch: Partial<Record<keyof Templates, string>> = {};
      for (const k of dirtyKeys) patch[k] = draft[k];
      const res = await fetch("/api/admin/templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setSaveResult({ ok: false, message: data.message ?? data.error ?? `HTTP ${res.status}` });
      } else {
        setSaveResult({ ok: true, message: "Saved. Next email/form render uses the new copy." });
        // Auto-dismiss the success message after 3s so it doesn't linger
        // through the next edit cycle. Failures stay visible until the next
        // save attempt — admin needs to read the error.
        setTimeout(() => setSaveResult((cur) => (cur?.ok ? null : cur)), 3000);
      }
    } catch (err) {
      setSaveResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const resetFieldToDefault = (k: keyof Templates) => {
    setDraft((prev) => ({ ...prev, [k]: defaults[k] }));
  };

  const resetAllToDefaults = () => {
    if (!confirm("Reset ALL fields to the code defaults? This clears every customization.")) return;
    setDraft(defaults);
  };

  return (
    <div className="space-y-6">
      {/* Status header */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl px-5 py-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-ppp-charcoal-500">
          {isCustomized ? (
            <>
              <strong className="text-ppp-charcoal">Customized.</strong>{" "}
              {updatedAt && (
                <>Last edited {new Date(updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}. </>
              )}
              Empty fields fall back to code defaults.
            </>
          ) : (
            <>
              <strong className="text-ppp-charcoal">Using code defaults.</strong>{" "}
              No overrides set in the database. Edit any field below to customize.
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={resetAllToDefaults}
            className="text-[11px] text-ppp-charcoal-500 hover:text-ppp-orange-700 underline"
          >
            Reset all to defaults
          </button>
        </div>
      </div>

      {/* Variable reference */}
      <div className="bg-ppp-blue-50/40 border border-ppp-blue-100 rounded-xl px-5 py-4">
        <div className="font-condensed text-[11px] uppercase tracking-wider font-bold text-ppp-blue-700 mb-2">
          Available variables
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-[11px]">
          <Variable name="customer_name" desc="Full customer name (or empty)" />
          <Variable name="customer_first" desc="First word of name (or “there”)" />
          <Variable name="wo_number" desc="WorkOrderNumber (e.g. 00012345)" />
          <Variable name="form_url" desc="Email only — full /select/[token] URL" />
          <Variable name="ppp_brand" desc="Constant: Precision Painting Plus" />
        </div>
        <p className="text-[10px] text-ppp-charcoal-500 mt-2 italic">
          Type variables as <code className="font-mono">{`{{name}}`}</code> — they get replaced at send/render time.
          Unknown variables stay as literal text (helps catch typos).
        </p>
      </div>

      {/* Email section */}
      <Section title="Customer invite email" subtitle="Sent when an admin clicks “Send Color Form” on a Work Order">
        {EMAIL_FIELDS.map((f) => (
          <FieldRow
            key={f.key}
            field={f}
            value={draft[f.key]}
            defaultValue={defaults[f.key]}
            isDirty={dirtyKeys.has(f.key)}
            onChange={(v) => setDraft((p) => ({ ...p, [f.key]: v }))}
            onReset={() => resetFieldToDefault(f.key)}
          />
        ))}
      </Section>

      {/* Form section */}
      <Section title="Customer color-pick form" subtitle="The page at /select/[token] customers land on after clicking the email link">
        {FORM_FIELDS.map((f) => (
          <FieldRow
            key={f.key}
            field={f}
            value={draft[f.key]}
            defaultValue={defaults[f.key]}
            isDirty={dirtyKeys.has(f.key)}
            onChange={(v) => setDraft((p) => ({ ...p, [f.key]: v }))}
            onReset={() => resetFieldToDefault(f.key)}
          />
        ))}
      </Section>

      {/* Save bar */}
      <div className="sticky bottom-4 z-10">
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl shadow-xl shadow-ppp-charcoal/10 px-5 py-3 flex items-center justify-between gap-3">
          <div className="text-xs text-ppp-charcoal-500">
            {isDirty
              ? `${dirtyKeys.size} unsaved change${dirtyKeys.size === 1 ? "" : "s"}`
              : "No unsaved changes"}
            {saveResult && (
              <span
                className={`ml-3 font-semibold ${
                  saveResult.ok ? "text-ppp-green-700" : "text-ppp-orange-700"
                }`}
              >
                {saveResult.message}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={save}
            disabled={!isDirty || saving}
            className="px-4 py-2 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Helpers ─── */

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <div className="px-5 sm:px-6 py-4 border-b border-ppp-charcoal-100">
        <h2 className="text-base font-bold text-ppp-charcoal">{title}</h2>
        <p className="text-xs text-ppp-charcoal-500 mt-0.5">{subtitle}</p>
      </div>
      <div className="px-5 sm:px-6 py-5 space-y-5">{children}</div>
    </section>
  );
}

function FieldRow({
  field,
  value,
  defaultValue,
  isDirty,
  onChange,
  onReset,
}: {
  field: FieldDef;
  value: string;
  defaultValue: string;
  isDirty: boolean;
  onChange: (v: string) => void;
  onReset: () => void;
}) {
  const isAtDefault = value === defaultValue;
  const unknownVars = findUnknownVariables(value);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <label className="block text-sm font-semibold text-ppp-charcoal">
          {field.label}
          {isDirty && (
            <span className="ml-2 text-[10px] uppercase tracking-wide font-bold text-ppp-orange-700">
              Unsaved
            </span>
          )}
        </label>
        {!isAtDefault && (
          <button
            type="button"
            onClick={onReset}
            className="text-[11px] text-ppp-blue hover:text-ppp-blue-700 font-medium"
          >
            Reset to default
          </button>
        )}
      </div>
      {field.multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={field.rows ?? 3}
          // text-base on mobile keeps the input ≥16px so iOS doesn't zoom on
          // focus (which then layout-shifts every other field). sm: drops to
          // text-sm for desktop density.
          className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue font-mono leading-relaxed"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue font-mono"
        />
      )}
      <p className="text-[11px] text-ppp-charcoal-500 mt-1">{field.help}</p>
      {unknownVars.length > 0 && (
        <p className="text-[11px] text-ppp-orange-700 mt-1.5 leading-snug">
          ⚠ Unknown variable{unknownVars.length === 1 ? "" : "s"}:{" "}
          {unknownVars.map((v, i) => (
            <span key={v}>
              <code className="font-mono">{`{{${v}}}`}</code>
              {i < unknownVars.length - 1 ? ", " : ""}
            </span>
          ))}
          {" "}— this will render as literal text in the email. Check the spelling
          against the variables list above.
        </p>
      )}
    </div>
  );
}

function Variable({ name, desc }: { name: string; desc: string }) {
  return (
    <div>
      <code className="font-mono text-ppp-blue-700 text-[11px]">{`{{${name}}}`}</code>
      <span className="text-ppp-charcoal-500"> — {desc}</span>
    </div>
  );
}
