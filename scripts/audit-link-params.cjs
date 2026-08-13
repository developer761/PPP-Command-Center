// The ?action=change-status class: a URL carries a query param the destination
// page never reads. Nothing errors — the page renders unchanged and the button
// looks broken.
//
// 2026-08-13: the first version only read `href=` attributes and reported
// ZERO while four live sites still emitted the dead param — a server-action
// `redirect()` and two `window.location.href` assignments in the kanban.
// A checker that only knows one of the ways a URL is emitted will keep
// reporting clean. It now covers all three.
// KNOWN false positive, verified 2026-08-13:
//   invoices/new -> accounts/[id]/costs/[dealId]?back=
// That route is a REDIRECT that forwards every param to the opportunity page,
// which does read `back`. This checker doesn't follow redirects.
const fs = require("fs"), path = require("path");

const pages = [];
(function walk(dir, url) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith("_") || e.name === "api") continue;
    const seg = /^\(.+\)$/.test(e.name) ? "" : `/${e.name}`;
    const next = url + seg;
    const p = path.join(dir, e.name, "page.tsx");
    if (fs.existsSync(p)) pages.push({ url: next || "/", file: p });
    walk(path.join(dir, e.name), next);
  }
})("app", "");

function pageFor(p) {
  const parts = p.split("/").filter(Boolean);
  let best = null;
  outer: for (const pg of pages) {
    const rp = pg.url.split("/").filter(Boolean);
    if (rp.length !== parts.length) continue;
    let score = 0;
    for (let i = 0; i < rp.length; i++) {
      if (rp[i].startsWith("[")) continue;
      if (rp[i] !== parts[i]) continue outer;
      score++;
    }
    if (!best || score > best.score) best = { ...pg, score };
  }
  return best;
}

const cache = new Map();
function sourceWithChildren(file, depth = 0) {
  if (cache.has(file)) return cache.get(file);
  let src = "";
  try { src = fs.readFileSync(file, "utf8"); } catch { return ""; }
  let out = src;
  if (depth < 2) {
    for (const m of src.matchAll(/from "@\/((?:app|components|lib)\/[^"]+)"/g)) {
      for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
        const p = m[1] + ext;
        if (fs.existsSync(p)) { out += "\n" + sourceWithChildren(p, depth + 1); break; }
      }
    }
  }
  cache.set(file, out);
  return out;
}

const files = [];
for (const root of ["app/commercial", "components"]) {
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(p)) files.push(p);
    }
  })(root);
}

// Every way a URL leaves this codebase.
const EMITTERS = [
  /href=(?:"|\{`)(\/commercial[^"`\s]*)/g,          // <Link> / <a>
  /redirect\(\s*`(\/commercial[^`]*)`/g,             // server action redirect
  /redirect\(\s*"(\/commercial[^"]*)"/g,
  /location\.href\s*=\s*`(\/commercial[^`]*)`/g,     // client navigation
  /router\.(?:push|replace)\(\s*`(\/commercial[^`]*)`/g,
];

const bad = [];
for (const f of files) {
  fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    for (const re of EMITTERS) {
      for (const m of line.matchAll(re)) {
        const [pathPart, queryPart] = m[1].split("#")[0].split("?");
        if (!queryPart) continue;
        const concrete = pathPart.replace(/\$\{[^}]*\}/g, "x");
        const pg = pageFor(concrete);
        if (!pg) continue;
        const src = sourceWithChildren(pg.file);
        for (const kv of queryPart.split("&")) {
          const key = kv.split("=")[0].replace(/\$\{[^}]*\}/g, "").trim();
          if (!key || key.includes("$")) continue;
          const reads =
            new RegExp(`\\bsp\\.${key}\\b`).test(src) ||
            new RegExp(`["'\`]${key}["'\`]`).test(src) ||
            new RegExp(`\\b${key}:`).test(src);
          if (!reads) bad.push(`${f}:${i + 1}  →  ${concrete}?${key}=  (destination never reads "${key}")`);
        }
      }
    }
  });
}
console.log(bad.length ? bad.join("\n") : "✅ every emitted URL param is read by its destination");
console.log(`\n${bad.length} unread param(s) · ${files.length} files · ${EMITTERS.length} emitter forms`);
