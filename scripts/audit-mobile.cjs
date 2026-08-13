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
      // <select> counts too — it was missed on the teams page, where the role
      // dropdown zoomed the page on every tap. Named sizes count as well:
      // text-xs is 12px and text-sm is 14px, both under the 16px threshold.
      const px = line.match(/(?<!sm:)text-\[(\d+(?:\.\d+)?)px\]/);
      const named = /(?<!sm:)\btext-(xs|sm)\b/.exec(line);
      const size = px ? Number(px[1]) : named ? (named[1] === "xs" ? 12 : 14) : null;
      // A line interpolating SELECT_CLS / INPUT_CLS / TEXTAREA_CLS is a field
      // too, even when the <select> tag itself sits on another line. The
      // shared constants are all correctly guarded — every real miss so far
      // has been a per-site OVERRIDE landing after them, which wins.
      // Three ways a line is a form field, learned one miss at a time:
      //   the tag itself · a shared class constant · a LOCAL class constant.
      // The last one is how `FIELD` in proposal-send-control zoomed every
      // input in the send-proposal sheet while this scanner reported zero.
      // A string carrying both a size and field chrome (a border and a
      // padding) is a field classname whatever it happens to be called.
      // …but a BUTTON is not a field: it never focuses a keyboard, so it
      // never zooms. Its size is the tap-target check's business, not this one.
      const looksLikeFieldClass =
        /^\s*(const\s+[A-Z_][A-Z0-9_]*\s*=|["`])/.test(line) &&
        /\bborder\b/.test(line) &&
        /\bp[xy]?-[\d.]+/.test(line) &&
        !/inline-flex|items-center|hover:bg-|cursor-pointer/.test(line);
      const isField =
        /<(input|textarea|select)\b/.test(line) ||
        /\b(SELECT_CLS|INPUT_CLS|TEXTAREA_CLS|FIELD|INPUT|TEXTAREA)\b/.test(line) ||
        looksLikeFieldClass;
      // A base `text-base` elsewhere on the line is the guard we want to see.
      const guarded = /\btext-base\b/.test(line);
      if (isField && size !== null && size < 16 && !guarded) {
        zoom.push(`${at}  field text ${size}px — iOS will zoom on focus`);
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
