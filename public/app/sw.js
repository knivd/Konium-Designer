// The app's offline cache (konium.app/app/; the website's own worker is ../sw.js). Bump CACHE on
// every release. Paths are relative to the scope, so the app works from any folder on the server.
// Its caches are named konium-app-…: the website's worker keeps konium-site-… and moved the app's
// earlier ones (konium-v…, from before the app moved to app/ in 26.169) out of the way.
const CACHE = 'konium-app-v26.206';
const scoped = (p) => new URL(p, self.registration.scope).href;
// The website's folder: above the app's at …/app/, else the scope itself (the manifest and icon are the website's)
const site = (p) => new URL(p, self.registration.scope.replace(/app\/$/, '')).href;

// A response stored as-is unless it came through a redirect (Chromium refuses a redirected
// response for a navigation): then its body under a fresh response
const plain = async (res) => (res.redirected ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers }) : res);

// Offline, or updates off (Konium's Home page and Preferences): the page Konium has is kept and
// served without asking konium.app — the page sets this flag in a cache of its own
const FLAGS = 'konium-flags';
// The flag as kept under the app's earlier names (made from this one): still honoured, and carried over when this one takes over
const FLAGS_FORMER = ['v', 'l'].map((c) => FLAGS.replace('k', 'j').replace('n', c));
const flagIn = (name) => caches.open(name).then((c) => c.match(scoped('./__pinned'))).then((r) => !!r).catch(() => false);
const flagFormer = async () => { for (const f of FLAGS_FORMER) if (await caches.has(f) && await flagIn(f)) return true; return false; };
const pinned = async () => (await flagIn(FLAGS)) || (await flagFormer());

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // Kept on its version: the page already kept goes into the new cache, nothing fetched
    const kept = (await pinned()) ? await caches.match(scoped('./index.html')) : undefined;
    const page = kept ?? await plain(await fetch(scoped('./'), { cache: 'reload' }));
    if (page.ok) { await c.put(scoped('./'), page.clone()); await c.put(scoped('./index.html'), page); }
    for (const p of ['./manifest.webmanifest', './icon.svg']) {
      const hit = kept ? await caches.match(site(p)) : undefined;
      if (hit) await c.put(site(p), hit); else await c.add(site(p)).catch(() => undefined);
    }
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    if (await flagFormer()) await (await caches.open(FLAGS)).put(scoped('./__pinned'), new Response('1'));
    // The app's earlier caches go (the website's, and its flags, are left alone)
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('konium-app-') && k !== CACHE).map((k) => caches.delete(k)));
    for (const f of FLAGS_FORMER) await caches.delete(f);
    await self.clients.claim();
  })());
});

// Navigation: network first (fresh app when online), cached copy offline or when kept on its version. Everything else: cache first.
// The page is asked for afresh (revalidated, never the browser's own cached copy, which a server
// without cache headers lets go stale for a while after an upload), and a redirect's body kept plain.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // The site's services (AI, parts, reports) answer afresh every time: never kept
  if (new URL(req.url).pathname.startsWith('/api/')) return;
  // The published version number always comes from the network (never kept)
  if (new URL(req.url).pathname.endsWith('/version.json')) return;
  // What's New: the network first (it grows with every release), the last copy read when offline
  if (new URL(req.url).pathname.endsWith('/whats-new.json')) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req)));
    return;
  }
  if (req.mode === 'navigate') {
    // Only the app's own page is kept as the offline copy: not robots.txt, llms.txt, error pages
    const path = new URL(req.url).pathname, root = new URL(self.registration.scope).pathname;
    const app = path === root || path === `${root}index.html`;
    e.respondWith((async () => {
      if (app && await pinned()) { const hit = await caches.match(scoped('./index.html')); if (hit) return hit; }
      return fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(async (res) => {
        const page = await plain(res);
        if (app && page.ok && (page.headers.get('content-type') ?? '').includes('text/html')) {
          const copy = page.clone();
          caches.open(CACHE).then((c) => c.put(scoped('./index.html'), copy));
        }
        return page;
      }).catch(() => (app ? caches.match(scoped('./index.html')) : caches.match(req)).then((hit) => hit ?? caches.match(scoped('./index.html'))));
    })());
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })),
  );
});
