// Mobile pass, mechanical half. Karan reads this platform on a phone every
// day, so these are regressions with a real cost rather than lint.
//
// Two hits are PERMANENT false positives — the scanner reads className
// strings, and these build theirs elsewhere. Both verified to carry
// min-h-[44px] by hand 2026-08-12:
//   submittals/[sid]:1120       — template-literal className
//   change-orders-panel:541     — shared `seg` const (has min-h-[44px])
//
// Known-clean exceptions confirmed by hand 2026-08-12: wide TABLES
// (payroll, AR aging, the AIA grid) sit inside their own `overflow-x-auto`
// so they scroll without the page scrolling; `w-4 h-4` checkboxes are the
// standard box size and are made tappable by their 44px LABEL.
//
// Mobile pass, mechanical half. Three things that are checkable without a
// browser and that Karan meets daily on a phone:
//
//  1. Tap targets under 44px on interactive elements.
//  2. Text inputs below 16px, which makes iOS ZOOM the page on focus and
//     never zoom back — the single most disorienting mobile bug in a form.
//  3. Fixed pixel widths wide enough to force the page to scroll sideways.
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

const small = [], zoom = [], wide = [];
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    const at = `${f}:${i + 1}`;
    const interactive = /<(button|a|Link|select|summary)\b/.test(line) || /type="(checkbox|radio|submit)"/.test(line);

    // A checkbox/radio is 16px by design — the standard box. What has to be
    // 44px is the LABEL wrapping it or pointing at it, since that is the whole
    // tap target. Check that instead of reporting the box forever.
    if (/type="(checkbox|radio)"/.test(line)) {
      // A multi-line <input> puts its type= several lines below the <label>,
      // so look further back than forward.
      const near = lines.slice(Math.max(0, i - 8), i + 4).join(" ");
      const label = /<label\b[^>]*>/.test(near);
      const sized = /min-h-\[(4[4-9]|[5-9]\d|\d{3,})px\]|\bh-11\b/.test(near);
      if (!label) small.push(`${at}  checkbox with no <label> — nothing but the 16px box is tappable`);
      else if (!sized) small.push(`${at}  checkbox label has no 44px height`);
      return;
    }

    // 1. explicit heights below 44px on something you tap
    if (interactive) {
      const h = line.match(/\bh-(\d+(?:\.\d+)?)\b/);
      const minh = line.match(/min-h-\[(\d+)px\]/);
      const hPx = h ? Number(h[1]) * 4 : null;
      const mPx = minh ? Number(minh[1]) : null;
      const best = Math.max(hPx ?? 0, mPx ?? 0);
      // sm: prefixed shrink-on-desktop is fine; only flag the BASE value
      const hasResponsiveGuard = /sm:(min-)?h-/.test(line);
      if (best > 0 && best < 44 && !hasResponsiveGuard) small.push(`${at}  tap target ${best}px`);
    }

    // 2. inputs whose base font is under 16px
    if (/<(input|textarea|select)\b/.test(line) || /className=\{?["`][^"`]*\}?/.test(line) === false) {
      const m = line.match(/text-\[(\d+(?:\.\d+)?)px\]/);
      if (m && /<(input|textarea)\b/.test(line) && Number(m[1]) < 16 && !/sm:text-/.test(line)) {
        zoom.push(`${at}  input text ${m[1]}px — iOS will zoom on focus`);
      }
    }

    // 3. fixed widths that exceed a small phone's viewport
    // Only a BASE width traps a phone. `sm:w-[440px]` is a desktop-only
    // width — on a phone that element is doing something else entirely
    // (usually a full-width bottom sheet), and flagging it is noise.
    const w = line.match(/(?<![\w:-])w-\[(\d+)px\]/);
    if (w && Number(w[1]) > 360 && !/max-w-/.test(line)) wide.push(`${at}  fixed ${w[1]}px wide`);
  });
}
const show = (label, arr) => {
  console.log(`\n── ${label}: ${arr.length}`);
  arr.slice(0, 40).forEach((s) => console.log("  " + s));
  if (arr.length > 40) console.log(`  … ${arr.length - 40} more`);
};
show("Tap targets under 44px", small);
show("Inputs that trigger iOS zoom", zoom);
show("Fixed widths over 360px", wide);
console.log(`\nscanned ${files.length} files`);
