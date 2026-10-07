/**
 * Is the server we are about to test actually THIS app?
 *
 * smoke-pages and check-tour-targets both default to http://localhost:3000 and
 * both fetch pages as a signed-in user. Neither checked WHOSE localhost:3000 it
 * was, and on 2026-10-06 it was Rooted's dev server — a different project,
 * running from a different directory, on the port this one also uses.
 *
 * Nothing said so. Rooted redirects a signed-out request to /login, so every
 * page came back 307 and both scripts reported with total confidence:
 *
 *   smoke-pages          "1 of 1 pages did not return 200"
 *   check-tour-targets   "53 of 53 walkthrough targets are not rendered"
 *
 * An hour went into the Supabase session cookie — base64 versus base64url,
 * chunk sizes — for a reply that was never going to come from this codebase.
 * Had it been the other way round, a second project's dev server answering 200
 * on every path, the scripts would have reported everything PASSING.
 *
 * Several projects are open on this machine at once, so the port is contested
 * by design. One request, before anything else, and the failure says what is
 * actually wrong.
 */

/** Something only this app serves. The root page's title is enough. */
const MARKER = "PPP Command Center";

export async function assertThisApp(base) {
  let res;
  try {
    res = await fetch(base + "/", { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    console.error(
      `\n✗  Nothing is answering at ${base}.\n`
      + `   Start this app's dev server (npm run dev in connect-hub), or point\n`
      + `   SMOKE_BASE_URL at the server you mean.\n`
      + `   ${e instanceof Error ? e.message : String(e)}`
    );
    process.exit(1);
  }
  const html = res.status === 200 ? await res.text() : "";
  if (!html.includes(MARKER)) {
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim();
    console.error(
      `\n✗  ${base} is not Connect Hub.\n`
      + `   It answered ${res.status}${title ? ` and calls itself "${title}"` : ""}.\n`
      + `   Another project's dev server is probably on that port — several\n`
      + `   share 3000 on this machine. Every result below would have been\n`
      + `   about that app, not this one, so nothing was run.\n`
      + `   Start connect-hub's own dev server, or set SMOKE_BASE_URL.`
    );
    process.exit(1);
  }
}
