// Two controls sharing a `name` inside one <form>: the browser submits BOTH
// and `formData.get()` returns the FIRST, so whatever the user typed in the
// second is silently discarded. Found live on the new-deal form, where every
// lead source picked was being thrown away.
//
// KNOWN-LEGITIMATE hits, all verified 2026-08-12 — the scanner cannot see
// which branch of a ternary renders, and cannot tell a bulk-select from a
// mistake:
//   proposal page  show_price      — ternary, only one branch renders
//   add-notification threshold_days— ternary, only one branch renders
//   inline-field   value           — ternary (textarea vs input)
//   settings/archived  id          — bulk multi-select, read with getAll("id")
//
// AST-based: walks JSX, tracks the enclosing <form>, collects name= on
// input/select/textarea, and reports repeats. Radio groups legitimately share
// a name, so type="radio" is excluded.
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
const attrs = (n) => (ts.isJsxElement(n) ? n.openingElement : n).attributes.properties;
const strAttr = (n, key) => {
  for (const a of attrs(n)) {
    if (!ts.isJsxAttribute(a) || a.name.getText() !== key) continue;
    const init = a.initializer;
    if (init && ts.isStringLiteral(init)) return init.text;
    return null; // computed — can't compare reliably, skip
  }
  return undefined;
};

let total = 0;
for (const f of files) {
  const src = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node, form) => {
    let nextForm = form;
    const tag = tagOf(node);
    if (tag === "form") nextForm = { seen: new Map(), line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1 };
    if (form && ["input", "select", "textarea"].includes(tag)) {
      const name = strAttr(node, "name");
      const type = strAttr(node, "type");
      if (name && type !== "radio") {
        const line = src.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (form.seen.has(name)) {
          console.log(`⚠ ${f}:${line}  name="${name}" already used at line ${form.seen.get(name)} in the same <form> (opened line ${form.line}) — the second value is discarded`);
          total++;
        } else form.seen.set(name, line);
      }
    }
    ts.forEachChild(node, (c) => visit(c, nextForm));
  };
  visit(src, null);
}
console.log(total === 0 ? `\n✅ no duplicate field names inside a form (${files.length} files)` : `\n${total} duplicate(s)`);
