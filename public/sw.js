/*
 * Service worker — the reason the app is worth installing.
 *
 * The people using this are in someone's house, often a basement or a new build
 * with no drywall and no bars. Without a worker, a dropped signal means Safari's
 * dinosaur and the measurement they just took is gone. With one, the app opens
 * and the parts that don't need the network keep working.
 *
 * WHAT IS AND ISN'T CACHED, deliberately:
 *
 *   · The app shell and static assets — cache-first. They change only on
 *     deploy, and serving them instantly is most of what makes an installed app
 *     feel unlike a website.
 *
 *   · HTML pages — network-first, falling back to a cached copy. Work orders,
 *     colours and quantities are live data; showing yesterday's list as though
 *     it were today's is worse than saying "you're offline". The fallback is
 *     there so the app opens at all.
 *
 *   · API calls and anything authenticated — NEVER cached. A stale supplier
 *     order or a stale permission check is a correctness problem, not a
 *     convenience one, and Salesforce data goes out of date by the minute.
 *
 * The measure tool's tape entry, the floor-plan walk and the perspective maths
 * are pure client-side arithmetic, so they work with no connection at all once
 * the page has loaded — which is precisely the job-site case.
 */

const VERSION = "ppp-v1";
const SHELL = `${VERSION}-shell`;
const PAGES = `${VERSION}-pages`;

const PRECACHE = [
  "/offline",
  "/icon-192.png",
  "/apple-touch-icon.png",
  "/brand/logo.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) =>
      // One bad URL must not fail the whole install and leave the app with no
      // worker at all. Add them individually and tolerate misses.
      Promise.allSettled(PRECACHE.map((u) => c.add(u)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API responses, auth, or anything with a query string that
  // might scope it to a user or a filter.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/login") ||
    url.search
  ) {
    return;
  }

  // Build output is content-hashed, so it can be cached hard and forever.
  if (url.pathname.startsWith("/_next/static/") || /\.(png|svg|jpg|jpeg|webp|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // Pages: live data wins, cache is the safety net.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(PAGES).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(req)) || (await caches.match("/offline")) ||
          new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } }))
    );
  }
});
