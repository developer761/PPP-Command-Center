// The "there's like a delay and the UX isn't good" class.
//
// A <form action={serverAction}> with a plain submit button shows NOTHING
// while the action runs — no spinner, no disable, no text change. On a slow
// action the button reads as dead, and people click it again.
//
// STATUS 2026-08-13: 101 found, the high-traffic ones fixed first — the deal
// page's status card (where the next-step buttons land), inline field edit,
// the pipeline quick-flips, and the send-proposal sheet. The rest are mostly
// Settings forms touched once a quarter; they get `SubmitButton` as each area
// is next opened rather than in one 101-file sweep, because two scripted
// sweeps broke things the week this was written.
//
// Fix: swap the <button type="submit"> for
// components/commercial/submit-button.tsx. It must stay a separate client
// component — useFormStatus reports on the form ABOVE it in the tree.
//
// Flags any form whose action is a server action and whose submit button has
// no pending affordance (useFormStatus, a shared pending button, or disabled).
const ts = require("typescript");
const fs = require("fs"), path = require("path");

const files = [];
for (const root of ["app/commercial", "components/commercial"]) {
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith(".tsx")) files.push(p);
    }
  })(root);
}

const tagOf = (n) => ts.isJsxElement(n) ? n.openingElement.tagName.getText()
  : ts.isJsxSelfClosingElement(n) ? n.tagName.getText() : null;

let flagged = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  // Only client components can show a pending state at all. A server component
  // has to delegate to one, so the check is the same either way.
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const visit = (node) => {
    if (tagOf(node) === "form" && ts.isJsxElement(node)) {
      const attrs = node.openingElement.attributes.properties;
      const hasAction = attrs.some((a) => ts.isJsxAttribute(a) && a.name.getText() === "action");
      if (hasAction) {
        const body = node.getText();
        const hasSubmit = /type="submit"/.test(body) || /<button(?![^>]*type=)/.test(body);
        const hasPending =
          /useFormStatus|pending|Pending|disabled=|aria-busy|SubmitButton|PendingButton/.test(body);
        if (hasSubmit && !hasPending) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          // A one-word form (a hidden id + a link-styled button) is usually an
          // instant nav; the ones that matter carry real inputs.
          const inputs = (body.match(/<(input|select|textarea)\b/g) || []).length;
          const visibleInputs = (body.match(/<(input|select|textarea)\b(?![^>]*type="hidden")/g) || []).length;
          console.log(`${f}:${line}  form has no pending state  (${visibleInputs} visible field${visibleInputs === 1 ? "" : "s"}, ${inputs} total)`);
          flagged++;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
console.log(`\n${flagged} form(s) with no pending affordance`);
