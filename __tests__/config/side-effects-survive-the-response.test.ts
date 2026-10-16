/**
 * WORK THAT MUST HAPPEN CANNOT BE LEFT DETACHED.
 *
 * On Vercel the instance is frozen the moment the response is written.
 * Anything still awaiting in a `void somePromise()` is dropped — no error,
 * no log, no row. The work simply never happened, intermittently, and
 * nothing anywhere says so.
 *
 * lib/notifications/after-response.ts was written for exactly this, after
 * it was found eating Commercial notifications. It had not been applied to
 * the Command Center, where the same pattern was dropping:
 *
 *   · the customer's color-confirmation email — their only proof that PPP
 *     received the colors they just submitted;
 *   · the vendor-reply notification — the bell and email telling somebody a
 *     supplier had written back, which is the thing Kate reported missing;
 *   · every materials failure alert, so a bounced order could fail to
 *     report that it had failed;
 *   · the view-as audit row, which is supposed to be a record.
 *
 * None of those would ever have shown up as an error. That is the whole
 * problem with the pattern, and why it is worth a test rather than a
 * memory.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";

const root = join(__dirname, "..", "..");
const read = (p: string) => stripComments(readFileSync(join(root, p), "utf8"));

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(rel, acc);
    } else if (e.name.endsWith(".ts")) acc.push(rel);
  }
  return acc;
}

/** Work whose disappearance is invisible: mail, notifications, alerts, audit. */
/**
 * The verb need NOT be followed by a capital. The first version of this
 * required `[A-Z]`, so it matched `void reportError(` but sailed past
 * `void report(` — which is what lib/observability.ts actually had, in the
 * three wrappers every webhook and cron uses to report a failure.
 */
const MUST_SURVIVE = /^\s*void\s+(send|notify|alert|log|report|dispatch|enqueue)\w*\s*\(/m;

/**
 * Deliberately detached, each for a stated reason.
 *
 *   queries.ts  the shared snapshot cache write. A browsing user must not
 *               wait ~20s to populate a cache for somebody else; the CRON
 *               awaits it via `awaitSharedWrite`, which is the path where
 *               losing it would matter.
 */
const ALLOWED = new Set<string>(["lib/salesforce/queries.ts"]);

describe("side effects outlive the response", () => {
  const files = [...walk("app/api"), ...walk("lib")].filter(
    (f) => !/\/commercial\/|\/messaging\//.test(f)
  );

  it("scanned a real number of files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no mail, notification, alert or audit call is left detached", () => {
    const offenders = files.filter((f) => !ALLOWED.has(f) && MUST_SURVIVE.test(read(f)));
    expect(
      offenders,
      "These fire work with `void` and return. On Vercel the instance freezes " +
        "at the response and the work is dropped silently. Use afterResponse() " +
        "from lib/notifications/after-response.ts:\n" + offenders.join("\n")
    ).toEqual([]);
  });

  it("the paths that were fixed use afterResponse", () => {
    for (const [f, label] of [
      ["app/api/customer-form/submit/[token]/route.ts", "customer receipt email"],
      ["app/api/webhooks/resend-inbound/route.ts", "vendor reply notification"],
      ["app/api/admin/supplier-order/send/route.ts", "materials failure alert"],
      ["app/api/webhooks/resend-events/route.ts", "materials failure alert"],
      ["lib/salesforce/writeback.ts", "materials failure alert"],
      ["app/api/admin/proxy/route.ts", "view-as audit row"],
    ] as const) {
      expect(read(f), `${f} no longer defers its side effect`).toContain(`afterResponse("${label}"`);
    }
  });

  it("the webhook still answers before doing the work", () => {
    // Resend retries a non-200, and a retried reply lands twice. afterResponse
    // has to run AFTER the response, never be awaited into it.
    const hook = read("app/api/webhooks/resend-inbound/route.ts");
    expect(hook).not.toMatch(/await notifySupplierReply\(/);
  });

  it("the allowlist still describes something real", () => {
    for (const f of ALLOWED) {
      expect(read(f), `${f} no longer has a detached call — drop it from ALLOWED`)
        .toMatch(/^\s*void\s+\w+\s*\(/m);
    }
  });
});
