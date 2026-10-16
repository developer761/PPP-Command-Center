/**
 * Is every commercial API route still behind a gate — and does any GET write?
 *
 *   node scripts/check-api-gates.mjs
 *   npm run check:api-gates
 *
 * WHY
 *
 * There is no user→account authorization model in the commercial platform.
 * `commercial_accounts` has no owner column and no viewer filter; the only
 * real boundaries are CREW (a page allowlist) and FINANCE (admin / account
 * manager). RLS is ENABLED on the AIA tables with ZERO policies, and
 * `commercialDb()` holds the service key and bypasses RLS by design.
 *
 * So the application layer is the entire net, and one missing line at the top
 * of one handler is full exposure of whatever that handler reads.
 *
 * That is not hypothetical. The codebase's own comment records it, at
 * lib/commercial/auth.ts:141 —
 *
 *   "roughly two dozen commercial API routes never funnelled through that
 *    helper — they hand-rolled `has_new_platform_access && is_active`, which
 *    EVERY crew login satisfies by definition"
 *
 * Those two dozen were fixed one route at a time. The CLASS was never closed:
 * nothing stops the twenty-fifth from shipping tomorrow, and a hand-rolled
 * check reads, to a reviewer, exactly like a real one.
 *
 * WHAT IT ASSERTS
 *
 *   (a) GATED        every exported handler in app/api/commercial/ route.ts files
 *                    transitively reaches `apiAccessDenied`, `denyCrewApi` or
 *                    `guardExport`. Transitively: the gate may be two or three
 *                    calls down, in another file, and that counts.
 *
 *   (b) ALLOWLISTED  the deliberate exceptions live in a committed file with a
 *                    reason string each (scripts/api-gate-allowlist.mjs), so
 *                    opening a route is a visible decision rather than an
 *                    absence nobody notices. Two kinds: UNGATED (public) and
 *                    CREW_OPEN (gated, but `allowCrew: true`).
 *
 *   (c) NO WRITING GET
 *                    no exported GET transitively reaches .insert / .update /
 *                    .delete / .upsert. The session cookie is SameSite=Lax, so
 *                    a top-level GET navigation from any site on the internet
 *                    arrives authenticated — a writing GET is a one-click CSRF
 *                    with no token to forge. Two existed when this was written:
 *                    the payroll export, which locked pay irreversibly (since
 *                    fixed), and the AIA export, which calls
 *                    reconcileDraftChangeOrderRows.
 *
 * HOW IT LOOKS — AND WHY NOT grep
 *
 * It PARSES. Every file goes through the TypeScript compiler's own parser and
 * the check walks the resulting AST, resolving each call's callee back to a
 * declaration and following it across module boundaries.
 *
 * Grep was never an option here. This repo has shipped a cascade guard that
 * matched the IMPORT line rather than the call, and a source-text assertion
 * that matched its own docblock. For THIS check the failure is worse than
 * cosmetic: `import { denyCrewApi } from "@/lib/commercial/auth"` with the two
 * lines that call it deleted is precisely the bug, and it greps clean. A
 * commented-out gate greps clean. A gate in a sibling file the route never
 * calls greps clean. Only the call graph knows.
 *
 * It states what it scanned and refuses to pass over an empty set, because a
 * matcher that silently matched nothing prints a clean bill either way.
 *
 * PROVEN TO FAIL — 2026-10-16, four ways, each one broken on purpose and
 * watched go red. Eight checks written in this repo in one week could not have
 * failed at all; a check that cannot fail launders a guess into "verified".
 *
 *   1. a temp route hand-rolling `has_new_platform_access`, WITH
 *      `import { denyCrewApi }` left at the top and never called — grep -c
 *      denyCrewApi says 1, this says UNGATED. exit 1.
 *   2. a temp GET calling a helper named `getThing` which calls a helper named
 *      `touchLastViewed` which does `sb.from(...).update(...)` — two files
 *      away, zero write syntax in the route. Caught by file:line. exit 1.
 *   3. deleting the one `denyCrewApi(...)` CALL line from
 *      app/api/commercial/accounts/export/route.ts, import untouched →
 *      UNGATED, exit 1. Restored byte-identical; green again.
 *   4. a bogus allowlist entry naming no real route → ALLOWLIST PROBLEMS,
 *      exit 1.
 *
 * It also fails SAFE. If module resolution broke — a moved auth.ts, a renamed
 * path alias — no handler would resolve a gate and all 76 would report
 * UNGATED. The breakage is loud rather than a silent clean bill.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve as resolvePath } from "node:path";
import ts from "typescript";
import {
  UNGATED,
  CREW_OPEN,
  SOFT_GATE_ONLY,
  GET_WRITES,
  DB_WRITE_RECEIVER,
} from "./api-gate-allowlist.mjs";

const ROOT = process.cwd();
const API_DIR = join(ROOT, "app", "api", "commercial");

/** The three gates. A route must reach one of them. */
const GATES = new Map([
  ["apiAccessDenied", "lib/commercial/auth"],
  ["denyCrewApi", "lib/commercial/auth"],
  ["guardExport", "lib/commercial/reports/export-guard"],
]);
/**
 * SOFT gates — a real boundary, but the wrong one for an API route.
 *
 * `assertCommercialAccess` and `requireCommercialUser` DO default-deny crew
 * (lib/commercial/auth.ts:78-81), so a handler reaching one is not fail-open.
 * They deny by calling `redirect()`, which throws — in a route handler that
 * surfaces as a 307 to the crew home, or as whatever a surrounding catch
 * decides. The API gates return a 403 Response that nothing can swallow.
 *
 * Reported in their own category rather than counted as a pass: a reviewer
 * skimming a handler cannot tell a real gate from a near-miss, and that is
 * exactly how two dozen hand-rolled checks survived review the first time.
 */
const SOFT = new Map([
  ["requireCommercialUser", "lib/commercial/auth"],
  ["assertCommercialAccess", "lib/commercial/auth"],
]);
/**
 * Recorded for the baseline table only. `financeApiDenied` is a ROLE test
 * layered on top of access and never a substitute for it — the deposited
 * checkbox was exactly that confusion in reverse.
 */
const NOTED = new Map([["financeApiDenied", "lib/commercial/auth"]]);

const HANDLERS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const WRITE_METHODS = new Set(["insert", "update", "delete", "upsert"]);

/** Depth cap: a cycle is already handled, this bounds a pathological graph. */
const MAX_DEPTH = 30;

// ---------------------------------------------------------------- resolution

const EXT = [".ts", ".tsx", ".mts", ".js", ".mjs"];

/** `@/x` → <root>/x · `./x` → sibling. node_modules and bare specifiers: null. */
function resolveModule(fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolvePath(dirname(fromFile), spec);
  else return null; // a package — we do not follow into node_modules
  for (const e of EXT) if (existsSync(base + e)) return base + e;
  for (const e of EXT) {
    const i = join(base, "index" + e);
    if (existsSync(i)) return i;
  }
  if (existsSync(base) && statSync(base).isFile()) return base;
  return null;
}

// -------------------------------------------------------------------- parse

const fileCache = new Map();

/**
 * Parse one file into the three maps the walk needs.
 *
 *   imports   local name  → { spec, imported }   (`imported` may be "*")
 *   locals    local name  → declaration node
 *   aliases   exported name → local name          (`export { a as b }`)
 *   reexports exported name → { spec, imported }  (`export { x } from "…"`)
 *   stars     specs of `export * from "…"`
 */
function parse(file) {
  if (fileCache.has(file)) return fileCache.get(file);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    const empty = { sf: null, imports: new Map(), locals: new Map(), aliases: new Map(), reexports: new Map(), stars: [] };
    fileCache.set(file, empty);
    return empty;
  }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = { sf, text, imports: new Map(), locals: new Map(), aliases: new Map(), reexports: new Map(), stars: [] };

  for (const st of sf.statements) {
    // import … from "…"
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      // `import type { X }` carries no runtime call — skip it, or a type-only
      // import of a gate's return type would vouch for a route that never
      // calls it.
      if (st.importClause?.isTypeOnly) continue;
      const spec = st.moduleSpecifier.text;
      const c = st.importClause;
      if (!c) continue;
      if (c.name) out.imports.set(c.name.text, { spec, imported: "default" });
      const b = c.namedBindings;
      if (b && ts.isNamespaceImport(b)) out.imports.set(b.name.text, { spec, imported: "*" });
      if (b && ts.isNamedImports(b)) {
        for (const el of b.elements) {
          if (el.isTypeOnly) continue;
          out.imports.set(el.name.text, { spec, imported: (el.propertyName ?? el.name).text });
        }
      }
      continue;
    }
    // export { a as b } [from "…"]
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      for (const el of st.exportClause.elements) {
        const local = (el.propertyName ?? el.name).text;
        if (spec) out.reexports.set(el.name.text, { spec, imported: local });
        else out.aliases.set(el.name.text, local);
      }
      continue;
    }
    // export * from "…"
    if (ts.isExportDeclaration(st) && !st.exportClause && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      out.stars.push(st.moduleSpecifier.text);
      continue;
    }
    if (ts.isFunctionDeclaration(st) && st.name) out.locals.set(st.name.text, st);
    if (ts.isClassDeclaration(st) && st.name) out.locals.set(st.name.text, st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!d.initializer) continue;
        // `const { isCrewOnlyUser } = await import("@/lib/…")` — a dynamic
        // import destructure. auth.ts itself is written this way; without this
        // the graph stops dead at the first one.
        const dyn = dynamicImportSpec(d.initializer);
        if (dyn && ts.isObjectBindingPattern(d.name)) {
          for (const el of d.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const imported = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            out.imports.set(el.name.text, { spec: dyn, imported });
          }
          continue;
        }
        if (ts.isIdentifier(d.name)) out.locals.set(d.name.text, d);
      }
    }
  }
  fileCache.set(file, out);
  return out;
}

/** `await import("x")` / `import("x")` → "x" */
function dynamicImportSpec(node) {
  let n = node;
  if (ts.isAwaitExpression(n)) n = n.expression;
  if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const a = n.arguments[0];
    if (a && ts.isStringLiteral(a)) return a.text;
  }
  return null;
}

/** Every exported handler in a route file: GET/POST/… as function or const. */
function exportedHandlers(file) {
  const { sf } = parse(file);
  const found = new Map();
  if (!sf) return found;
  const exported = (st) =>
    ts.canHaveModifiers(st) &&
    (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && exported(st) && HANDLERS.has(st.name.text)) {
      found.set(st.name.text, st);
    }
    if (ts.isVariableStatement(st) && exported(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && HANDLERS.has(d.name.text) && d.initializer) found.set(d.name.text, d);
      }
    }
  }
  return found;
}

// ------------------------------------------------------------------- resolve

/**
 * Find where a name used in `file` is declared — following re-exports.
 * Returns { kind: "local", file, node } | { kind: "gate"|"noted", name } | null.
 */
function resolveName(file, name, hops = 0) {
  if (hops > 12) return null;
  const mod = parse(file);

  const gateHome = GATES.get(name) ?? SOFT.get(name) ?? NOTED.get(name);
  if (gateHome && relative(ROOT, file).replace(/\.tsx?$/, "").split("\\").join("/") === gateHome) {
    const kind = GATES.has(name) ? "gate" : SOFT.has(name) ? "soft" : "noted";
    return { kind, name, file };
  }

  if (mod.imports.has(name)) {
    const { spec, imported } = mod.imports.get(name);
    const target = resolveModule(file, spec);
    if (!target) return null;
    if (imported === "*") return { kind: "namespace", file: target };
    return resolveName(target, imported, hops + 1) ?? { kind: "missing", file: target, name: imported };
  }
  if (mod.aliases.has(name)) return resolveName(file, mod.aliases.get(name), hops + 1);
  if (mod.reexports.has(name)) {
    const { spec, imported } = mod.reexports.get(name);
    const target = resolveModule(file, spec);
    return target ? resolveName(target, imported, hops + 1) : null;
  }
  if (mod.locals.has(name)) return { kind: "local", file, node: mod.locals.get(name) };
  for (const spec of mod.stars) {
    const target = resolveModule(file, spec);
    if (!target) continue;
    const r = resolveName(target, name, hops + 1);
    if (r) return r;
  }
  return null;
}

// ---------------------------------------------------------------------- walk

const memo = new Map();

function emptyResult() {
  return { gates: new Set(), soft: new Set(), noted: new Set(), writes: [], allowCrew: false };
}
function merge(into, from) {
  for (const g of from.gates) into.gates.add(g);
  for (const s of from.soft) into.soft.add(s);
  for (const n of from.noted) into.noted.add(n);
  for (const w of from.writes) into.writes.push(w);
  if (from.allowCrew) into.allowCrew = true;
}

/** Does any argument of this call pass `allowCrew: true`? */
function passesAllowCrew(call) {
  for (const a of call.arguments) {
    if (!ts.isObjectLiteralExpression(a)) continue;
    for (const p of a.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const k = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
      if (k === "allowCrew" && p.initializer.kind !== ts.SyntaxKind.FalseKeyword) return true;
    }
  }
  return false;
}

function receiverText(expr, sf) {
  try {
    return expr.getText(sf);
  } catch {
    return "";
  }
}

/**
 * Every `const x = <expr>` in a file, by name, as source text.
 *
 * Built so a bare identifier receiver can be unfolded one step:
 * `const q = sb.from("x")` … `q.update(...)` is a database write, and the
 * receiver text alone says only "q". Lazily computed, one walk per file.
 */
function varInits(file) {
  const mod = parse(file);
  if (mod.varInit) return mod.varInit;
  const m = new Map();
  mod.varInit = m;
  if (!mod.sf) return m;
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (!m.has(n.name.text)) m.set(n.name.text, receiverText(n.initializer, mod.sf));
    }
    ts.forEachChild(n, visit);
  };
  visit(mod.sf);
  return m;
}

/** Is this `.insert/.update/.delete/.upsert` actually hitting the database? */
function isDbWrite(file, recvText) {
  const hit = (t) => DB_WRITE_RECEIVER.some((re) => re.test(t));
  if (hit(recvText)) return true;
  // One unfold: a bare identifier holding a query builder.
  if (/^[A-Za-z_$][\w$]*$/.test(recvText.trim())) {
    const init = varInits(file).get(recvText.trim());
    if (init && hit(init)) return true;
  }
  return false;
}

/**
 * Everything reachable from `node` in `file`: gates called, writes performed,
 * and whether crew was opted back in. Transitive through local declarations
 * and across imports.
 */
function walkNode(file, node, depth, stack) {
  const res = emptyResult();
  if (!node || depth > MAX_DEPTH) return res;
  const mod = parse(file);
  const sf = mod.sf;

  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;

      // --- a method call: the write detector, and namespace dispatch -------
      if (ts.isPropertyAccessExpression(callee)) {
        const m = callee.name.text;
        if (WRITE_METHODS.has(m)) {
          const recv = receiverText(callee.expression, sf);
          if (isDbWrite(file, recv)) {
            const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
            const flat = recv.replace(/\s+/g, " ");
            res.writes.push({ file: relative(ROOT, file), line: line + 1, text: `${flat.slice(-64)}.${m}(` });
          }
        }
        if (ts.isIdentifier(callee.expression)) {
          const r = resolveName(file, callee.expression.text);
          if (r && r.kind === "namespace") {
            const sub = reachFrom(r.file, m, depth + 1, stack);
            merge(res, sub);
          }
        }
      }

      // --- a plain call: the gate detector, and the call graph -------------
      if (ts.isIdentifier(callee)) {
        const name = callee.text;
        const r = resolveName(file, name);
        if (r && r.kind === "gate") {
          res.gates.add(r.name);
          if (passesAllowCrew(n)) res.allowCrew = true;
        } else if (r && r.kind === "soft") {
          res.soft.add(r.name);
          if (passesAllowCrew(n)) res.allowCrew = true;
        } else if (r && r.kind === "noted") {
          res.noted.add(r.name);
        } else if (r && r.kind === "local") {
          merge(res, reachNode(r.file, name, r.node, depth + 1, stack));
        }
        /*
         * A HANDLER PASSED TO A WRAPPER — `export const GET = withAuth(impl)`.
         * The wrapper's own body is followed by the branch above; this follows
         * the function it was handed, so a gate living in either half counts.
         */
        for (const a of n.arguments) {
          if (!ts.isIdentifier(a)) continue;
          const ra = resolveName(file, a.text);
          if (ra && ra.kind === "local") merge(res, reachNode(ra.file, a.text, ra.node, depth + 1, stack));
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return res;
}

function reachNode(file, name, node, depth, stack) {
  const key = `${file}::${name}`;
  if (stack.has(key)) return emptyResult(); // cycle
  if (memo.has(key)) return memo.get(key);
  stack.add(key);
  const r = walkNode(file, node, depth, stack);
  stack.delete(key);
  memo.set(key, r);
  return r;
}

function reachFrom(file, name, depth, stack) {
  const r = resolveName(file, name);
  if (!r) return emptyResult();
  if (r.kind === "gate" || r.kind === "soft" || r.kind === "noted") {
    const e = emptyResult();
    e[r.kind === "gate" ? "gates" : r.kind === "soft" ? "soft" : "noted"].add(r.name);
    return e;
  }
  if (r.kind !== "local") return emptyResult();
  return reachNode(r.file, name, r.node, depth, stack);
}

// --------------------------------------------------------------------- scan

function walkDir(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of entries) {
    const f = join(dir, n);
    const st = statSync(f);
    if (st.isDirectory()) walkDir(f, out);
    else if (n === "route.ts" || n === "route.tsx") out.push(f);
  }
  return out;
}

const routeFiles = walkDir(API_DIR).sort();
const routeKey = (f) => relative(API_DIR, f).replace(/\/route\.tsx?$/, "").split("\\").join("/");

const ungatedOk = new Set(UNGATED.map((e) => e.route));
const crewOpenOk = new Set(CREW_OPEN.map((e) => e.route));
const softOk = new Set(SOFT_GATE_ONLY.map((e) => e.route));
const getWritesOk = new Set(GET_WRITES.map((e) => e.route));

const rows = [];
const failUngated = [];
const failSoftOnly = [];
const failWritingGet = [];
const failCrewOpen = [];
const failStaleAllowlist = [];

for (const file of routeFiles) {
  const key = routeKey(file);
  const handlers = exportedHandlers(file);
  if (handlers.size === 0) {
    rows.push({ key, method: "—", gates: "(no exported handler)", flags: "" });
    continue;
  }
  for (const [method, node] of handlers) {
    const body = ts.isVariableDeclaration(node) ? node.initializer : node.body;
    const r = reachNode(file, `${key}#${method}`, body, 0, new Set());
    const gates = [...r.gates].sort();
    const soft = [...r.soft].sort();
    const flags = [];
    if (r.allowCrew) flags.push("allowCrew");

    if (gates.length === 0 && soft.length === 0) {
      if (ungatedOk.has(key)) flags.push("public-by-design");
      else failUngated.push({ key, method, noted: [...r.noted].sort() });
    } else if (gates.length === 0) {
      if (softOk.has(key)) flags.push("soft-gate-by-design");
      else failSoftOnly.push({ key, method, soft });
    } else if (r.allowCrew) {
      if (crewOpenOk.has(key)) flags.push("crew-open-by-design");
      else failCrewOpen.push({ key, method, gates });
    }

    if (method === "GET" && r.writes.length) {
      if (getWritesOk.has(key)) flags.push("GET-write-by-design");
      else failWritingGet.push({ key, method, writes: r.writes.slice(0, 4) });
    }

    const label = [...gates, ...soft.map((s) => `${s}*`), ...[...r.noted].sort().map((n) => `+${n}`)];
    rows.push({
      key,
      method,
      gates: label.length ? label.join(" ") : "(none)",
      flags: flags.join(" "),
      writes: r.writes.length,
    });
  }
}

// An allowlist entry for a route that no longer exists, or no longer needs it,
// is a decision nobody is making any more. Say so, or the list rots into a
// place where things go to be forgotten.
const liveKeys = new Set(routeFiles.map(routeKey));
for (const [label, list] of [
  ["UNGATED", UNGATED],
  ["CREW_OPEN", CREW_OPEN],
  ["SOFT_GATE_ONLY", SOFT_GATE_ONLY],
  ["GET_WRITES", GET_WRITES],
]) {
  for (const e of list) {
    if (!e.reason || e.reason.trim().length < 20) {
      failStaleAllowlist.push(`${label} entry "${e.route}" has no real reason string`);
    }
    if (!liveKeys.has(e.route)) {
      failStaleAllowlist.push(`${label} entry "${e.route}" matches no route under app/api/commercial/`);
    }
  }
}

// ------------------------------------------------------------------- report

console.log(`\nCommercial API authorization gates\n`);
console.log(`  parsed ${routeFiles.length} route files · ${rows.length} exported handlers`);
console.log(`  gates: apiAccessDenied · denyCrewApi · guardExport (followed through imports, not grepped)`);
console.log(
  `  allowlist: ${UNGATED.length} public · ${CREW_OPEN.length} crew-open · ` +
    `${SOFT_GATE_ONLY.length} soft-gate · ${GET_WRITES.length} writing GET\n`,
);
console.log(`  GATE column: bare = an API gate · *suffix = soft gate (redirects, not 403) · +prefix = role test\n`);

if (routeFiles.length === 0 || rows.length === 0) {
  console.log("  Scanned nothing. Refusing to report a clean bill over an empty set.\n");
  process.exit(1);
}

const w1 = Math.max(16, ...rows.map((r) => r.key.length));
const w2 = 7;
const w3 = Math.max(10, ...rows.map((r) => String(r.gates).length));
console.log(`  ${"ROUTE".padEnd(w1)}  ${"METHOD".padEnd(w2)}  ${"GATE".padEnd(w3)}  NOTES`);
console.log(`  ${"-".repeat(w1)}  ${"-".repeat(w2)}  ${"-".repeat(w3)}  -----`);
for (const r of rows) {
  const notes = [r.flags, r.writes ? `${r.writes} write${r.writes > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
  console.log(`  ${r.key.padEnd(w1)}  ${r.method.padEnd(w2)}  ${String(r.gates).padEnd(w3)}  ${notes}`);
}

let failed = 0;

if (failUngated.length) {
  failed += failUngated.length;
  console.log(`\n  UNGATED HANDLERS: ${failUngated.length}`);
  console.log(`  (no call path from this handler reaches apiAccessDenied, denyCrewApi or guardExport)`);
  for (const f of failUngated) {
    const also = f.noted.length ? `  [reaches only: ${f.noted.join(", ")}]` : "";
    console.log(`    ${f.method.padEnd(7)} ${f.key}${also}`);
  }
  console.log(
    `\n    Fix: two lines at the top of the handler, after its auth check —\n` +
      `        const denied = await denyCrewApi(user.id);\n` +
      `        if (denied) return denied;\n` +
      `    A hand-rolled \`has_new_platform_access && is_active\` is NOT this check:\n` +
      `    every crew login satisfies it by definition (lib/commercial/auth.ts:141).\n` +
      `    If the route is public on purpose, add it to scripts/api-gate-allowlist.mjs\n` +
      `    with a reason — that is a decision, and it should show up in a diff.`,
  );
}

if (failSoftOnly.length) {
  failed += failSoftOnly.length;
  console.log(`\n  SOFT GATE ONLY: ${failSoftOnly.length}`);
  console.log(`  (reaches assertCommercialAccess / requireCommercialUser but no API gate)`);
  for (const f of failSoftOnly) console.log(`    ${f.method.padEnd(7)} ${f.key}  [${f.soft.join(", ")}]`);
  console.log(
    `\n    Not fail-open — those two do default-deny crew (lib/commercial/auth.ts:78).\n` +
      `    But they deny by throwing redirect(), which in a route handler is a 307 to\n` +
      `    the crew home, or nothing at all if a catch swallows it. Add the API gate\n` +
      `    alongside, so the deny is a 403 Response and reads as one:\n` +
      `        const denied = await denyCrewApi(user.id);\n` +
      `        if (denied) return denied;`,
  );
}

if (failCrewOpen.length) {
  failed += failCrewOpen.length;
  console.log(`\n  CREW OPTED BACK IN, NOT ALLOWLISTED: ${failCrewOpen.length}`);
  for (const f of failCrewOpen) console.log(`    ${f.method.padEnd(7)} ${f.key}  (${f.gates.join(" + ")})`);
  console.log(
    `\n    \`allowCrew: true\` removes the one real user boundary this platform has.\n` +
      `    Allowlist it with a reason, or drop the flag.`,
  );
}

if (failWritingGet.length) {
  failed += failWritingGet.length;
  console.log(`\n  WRITING GET HANDLERS: ${failWritingGet.length}`);
  console.log(`  (the session cookie is SameSite=Lax — a top-level GET from any site arrives signed in)`);
  for (const f of failWritingGet) {
    console.log(`    GET     ${f.key}`);
    for (const w of f.writes) console.log(`              ${w.file}:${w.line}  ${w.text}`);
  }
  console.log(`\n    Fix: move the write to POST, or make the GET read-only and let the\n` +
    `    page that owns the data do the write. Do not allowlist it to go green.`);
}

if (failStaleAllowlist.length) {
  failed += failStaleAllowlist.length;
  console.log(`\n  ALLOWLIST PROBLEMS: ${failStaleAllowlist.length}`);
  for (const m of failStaleAllowlist) console.log(`    ${m}`);
}

if (!failed) {
  console.log(`\n  PASS — every handler reaches a gate, every exception is written down,\n` +
    `  and no GET writes.\n`);
  process.exit(0);
}

console.log(`\n  FAIL — ${failed} problem${failed > 1 ? "s" : ""}.\n`);
process.exit(1);
