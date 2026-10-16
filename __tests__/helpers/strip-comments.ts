import * as ts from "typescript";

/**
 * Strip comments from source before asserting anything about it.
 *
 * Five separate tests in this suite have now failed — or worse, PASSED —
 * because they matched a COMMENT rather than code: a Slack ordering test, a
 * `reply_to_email` test, a `precisionpaintingplus` ban, hub.ts, and the
 * draft-only-guard test, which went red the moment a docblock explaining WHY
 * the function is exempt from `assertProposalDraft` mentioned the guard by
 * name. A test that reads source text cannot tell prose from behavior unless
 * the prose is removed first.
 *
 * Use this on every `readFileSync` a test then greps. It is deliberately the
 * only copy — both spellings of the same regex drifting apart is the next
 * version of this bug.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PARSER AND NOT A REGEX ANY MORE — 2026-10-16
 * ---------------------------------------------------------------------------
 *
 * It used to be four `.replace()` calls. Both of its own bugs were the same
 * bug: a regex cannot tell a comment from a piece of code that merely LOOKS
 * like one, so it deleted code, and every test built on it was then asserting
 * against source with pieces silently missing.
 *
 *   1. `JSX_COMMENT` ate 35% of components/dashboard-view.tsx — 18,608 of
 *      53,770 characters, `export default function DashboardView` included —
 *      because `/\{\s*\/\*[\s\S]*?\*\/\s*\}/` does not stop at the first
 *      `*␀/`, it runs on to the next one followed by `}`.
 *
 *   2. The trailing-comment rule `/\/\/.*$/gm` deleted the rest of EVERY LINE
 *      CONTAINING TWO ADJACENT SLASHES. Not comments — these:
 *
 *          const URL = "https://hub.precisionpaintingplus.net";  →  const URL = "https:
 *          if (/^https?:\/\//.test(configured)) return configured;  →  if (/^https?:\/\
 *          const t = `see https://x.y`;  →  const t = `see https:
 *
 *      Every URL literal, every protocol-matching regex, every `//` inside a
 *      string. Found by routing 119 more test files through this helper and
 *      watching `email-links-are-absolute` go red on
 *      `APP_ORIGIN_FALLBACK = "https://…"` — an assertion about an absolute
 *      origin, defeated by a stripper that had eaten the `//` that makes an
 *      origin absolute.
 *
 * Knowing where a comment ends requires knowing whether you are inside a
 * string, a template, a regex literal or JSX — which is what a lexer is. So
 * this asks TypeScript's own parser, the one the compiler uses, instead of
 * guessing a fourth time.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DOES NOT USE `getChildren()` — 2026-10-16, same day
 * ---------------------------------------------------------------------------
 *
 * The first parser version walked `node.getChildren(sf)` to reach every token
 * and asked each one for its leading and trailing trivia. Correct, and far too
 * slow to live under a 5-second test timeout: `getChildren()` MATERIALISES the
 * token nodes, which the parse itself never bothers to create. Measured over
 * the 1,196 files under app/ + lib/ + components/ — the walk three suites here
 * do on every run — the parse is 308 ms and the walk is 2,195 ms, and
 * `revision-policy`, `gate-is-the-only-path` and `no-stranded-components` all
 * timed out on it.
 *
 * So the AST is used only for its BOUNDARIES. `forEachChild` costs nothing
 * extra — it is how the parser already stores its children — and the spans it
 * does NOT cover are exactly the trivia and the punctuation it skips over
 * (`,` `.` `]` `=>`). Inside one of those gaps a `/` cannot be division or a
 * regex, because both are nodes in their own right, so two characters are
 * enough to find a comment there. Total 470 ms for 1,814 files.
 *
 * Checked by running both versions over every .ts/.tsx in the repo and
 * diffing the output: 1,813 byte-identical, and the one file that differed
 * differed because the OLD one was wrong. A docblock sitting at the end of a
 * file is attached by TypeScript as JSDoc to the EndOfFileToken, which makes
 * that token's `getChildren()` non-empty — so the old walk recursed past it
 * instead of treating it as a leaf, and left the prose in. That is the bug
 * this whole helper exists to prevent, surviving inside the helper itself.
 *
 * A comment's characters are removed but its NEWLINES ARE KEPT, so the file
 * keeps its line structure. Both halves matter:
 *
 *   - keeping the newlines is what lets the many multiline-anchored regexes
 *     in this suite (`/^[ \t]*await sendEmail/m` and friends) still mean
 *     "at the start of a line";
 *   - removing the characters rather than blanking them is what keeps the
 *     `src.slice(i, i + 400)` window idiom useful. Those windows are written
 *     to span the next few hundred characters OF CODE; pad them with the
 *     whitespace of a deleted docblock and the window reaches nothing.
 */
export function stripComments(src: string): string {
  const hit = CACHE.get(src);
  if (hit !== undefined) return hit;

  const out = excise(src, commentRanges(src));
  // Clear wholesale when full rather than on every insert. Sized above the
  // ~1,200 source files in the repo: at 600 this evicted on every call during
  // the suites that walk all of app/ + lib/, so the cache cost a Map write
  // per file and returned nothing — measured at 1,138 ms cached vs 1,133 ms
  // cold, i.e. no cache at all.
  if (CACHE.size > 4000) CACHE.clear();
  CACHE.set(src, out);
  return out;
}

/**
 * Tests re-read the same handful of files many times over — several suites
 * walk every file under app/ and lib/, and most read the same module in a
 * dozen separate `it` blocks — and a parse is far dearer than a regex pass.
 * Keyed on the content itself, so it can never serve a stale answer for
 * changed source.
 */
const CACHE = new Map<string, string>();

function excise(src: string, ranges: ts.CommentRange[]): string {
  if (!ranges.length) return src;

  // Spliced rather than character-mapped: `[...src]` iterates CODE POINTS
  // while every `indexOf` and `.length` a test runs counts UTF-16 units, so
  // an emoji in a docblock — this repo's are full of them — shifted every
  // position after it by one.
  const sorted = [...ranges].sort((a, b) => a.pos - b.pos);
  let out = "";
  let cursor = 0;
  for (const r of sorted) {
    if (r.end <= cursor) continue; // nested inside one already removed
    const pos = Math.max(r.pos, cursor);
    out += src.slice(cursor, pos);
    out += src.slice(pos, r.end).replace(/[^\n\r]/g, "");
    cursor = r.end;
  }
  return out + src.slice(cursor);
}

/**
 * Every comment in the file, found from the parsed node boundaries.
 *
 * Parsed as TSX so `{/* … *␀/}` inside JSX is understood as what it is. That
 * leaves `{}` behind where a JSX comment was, which is correct and is the
 * whole point: the parser removes the comment and nothing else.
 *
 * The walk covers the file exhaustively by construction. A node's `pos` is its
 * FULL start — the end of the previous token, trivia included — so a parent's
 * children tile it end to end apart from three kinds of hole, and each is
 * swept:
 *
 *   · between two children, where `forEachChild` skipped a `.` or a `,`;
 *   · after the last child, where the closing `)` `}` `]` `;` lives;
 *   · the whole span of a childless node that is not a token, which is an
 *     empty `catch { … }` or `{}` — braces and trivia, nothing else.
 *
 * A TOKEN's span is different: it is the literal text, and sweeping it would
 * read the `//` in `"https://x"` as a comment — the exact bug the regex
 * version had. So a token contributes only its leading trivia, up to
 * `skipTrivia`. JsxText contributes nothing at all: it has no trivia, and a
 * `//` in rendered copy is copy.
 */
function commentRanges(src: string): ts.CommentRange[] {
  const sf = ts.createSourceFile("source.tsx", src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);

  const out: ts.CommentRange[] = [];

  /** Find the comments in a span the parser left to punctuation and trivia. */
  const sweep = (from: number, to: number): void => {
    let i = from;
    while (i < to - 1) {
      if (src[i] === "/" && src[i + 1] === "/") {
        let j = i + 2;
        while (j < to && src[j] !== "\n" && src[j] !== "\r") j++;
        out.push({ pos: i, end: j, kind: ts.SyntaxKind.SingleLineCommentTrivia, hasTrailingNewLine: false });
        i = j;
      } else if (src[i] === "/" && src[i + 1] === "*") {
        // An unterminated block comment runs to the end of the gap rather
        // than off the end of the file.
        const close = src.indexOf("*/", i + 2);
        const end = close === -1 ? to : Math.min(close + 2, to);
        out.push({ pos: i, end, kind: ts.SyntaxKind.MultiLineCommentTrivia, hasTrailingNewLine: false });
        i = end;
      } else {
        i++;
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JsxText) return;
    if (ts.isToken(node)) {
      // `getStart` is `pos` advanced past the trivia. It is given `sf`
      // explicitly because the parse carries no parent pointers to find it
      // from — that is what makes the parse cheap.
      sweep(node.pos, node.getStart(sf));
      return;
    }

    let cursor = node.pos;
    let hasChild = false;
    ts.forEachChild(node, (child) => {
      hasChild = true;
      if (child.pos > cursor) sweep(cursor, child.pos);
      visit(child);
      cursor = child.end;
    });

    if (!hasChild) sweep(node.pos, node.end);
    else if (cursor < node.end) sweep(cursor, node.end);
  };
  visit(sf);

  return out;
}

/**
 * The same job for SQL, where a comment starts with `--`.
 *
 * A migration's prose hides behavior exactly the way a docblock does. A test
 * asserting a migration `.includes("drop the old index")` passes on the line
 *
 *     -- drop the old index, it was replaced in 162
 *
 * long after the DROP itself is gone — and a migration is append-only, so that
 * green can never turn red on its own. Three tests here read `.sql` and the
 * JS stripper cannot help them: it knows `//` and `/* *␀/`, not `--`.
 *
 * Block comments are handled by `stripComments`, which SQL shares. Dollar-quoted
 * bodies ($$ … $$) are left alone deliberately: a `--` inside a PL/pgSQL
 * function body is still a comment, and removing it changes nothing a test
 * asserts on, while trying to parse the quoting would be a second place to be
 * wrong.
 */
export function stripSqlComments(src: string): string {
  // NOT via stripComments: that one parses as TSX, and handing it SQL asks a
  // TypeScript lexer to reason about `$$`, `::` and dollar-quoting. Block
  // comments are the same in both languages and are cheap to remove directly.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n\r]/g, ""))
    // A `--` inside a single-quoted literal is NOT a comment. Walk the line and
    // only cut at a `--` that is outside quotes — the naive /--.*$/ would eat
    // half of `insert into t values ('a--b')`.
    .split("\n")
    .map((line) => {
      let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'") {
          // '' inside a literal is an escaped quote, not a close.
          if (inQuote && line[i + 1] === "'") { i++; continue; }
          inQuote = !inQuote;
        } else if (!inQuote && c === "-" && line[i + 1] === "-") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}
