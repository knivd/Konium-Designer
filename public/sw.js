// konium.app's own service worker: the website's pages kept for reading offline, and Konium's move
// from here to app/ (26.169). The app has a worker of its own (app/sw.js), which takes app/ over
// once it has run there; this one answers for app/ only until then (offline: the copy kept below).
// Bump CACHE on every release. The website's build (website/build.mjs) adds the fingerprint of the
// site's files to its name and fills MORE, so an upload of the website alone, between releases,
// is a new worker with a new cache: nothing of the upload before it is served again.
const CACHE = 'konium-site-v26.209';
const scoped = (p) => new URL(p, self.registration.scope).href;
// The website's other pages and its style sheet under the address the pages ask for it by (filled by the build)
const MORE = [];
const PAGES = ['./', './features/', './formats/', './download/', './whats-new/', './faq/', './support/', './assets/site.css', './icon.svg', './manifest.webmanifest',
  ...[400, 500, 600].map((w) => `./assets/fonts/plex-condensed-${w}.woff2`), ...MORE];

// A response stored as-is unless it came through a redirect (Chromium refuses a redirected
// response for a navigation): then its body under a fresh response
const plain = async (res) => (res.redirected ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers }) : res);

// Up to 26.168 the app itself was served here, its pages kept in caches named konium-v…, and kept on
// its version (Offline, or updates off) while the page's flag below was set. For such a copy, this
// worker goes on serving the page it kept, here, as that worker did; turned back on, the website
// shows here and the installed app goes on to app/.
const FLAGS = 'konium-flags';
const FLAGS_FORMER = ['v', 'l'].map((c) => FLAGS.replace('k', 'j').replace('n', c));
const flagIn = (name) => caches.open(name).then((c) => c.match(scoped('./__pinned'))).then((r) => !!r).catch(() => false);
const pinned = async () => { if (await flagIn(FLAGS)) return true; for (const f of FLAGS_FORMER) if (await caches.has(f) && await flagIn(f)) return true; return false; };
const KEPT = scoped('./__kept-app.html');
const formerApp = async () => (await caches.keys()).filter((k) => /^konium-v\d/.test(k));

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    for (const p of PAGES) await c.add(new Request(scoped(p), { cache: 'reload' })).catch(() => undefined);
    const former = await formerApp();
    if (former.length) {
      // The app as it was kept here: on its version, its page kept; else the app at app/ kept for offline from now
      const page = await caches.open(former[0]).then((f) => f.match(scoped('./index.html')));
      if (page && await pinned()) await c.put(KEPT, page);
      else await c.add(new Request(scoped('./app/'), { cache: 'reload' })).catch(() => undefined);
    }
    // What this worker's cache before this one kept of the app goes into the new one (activate
    // removes the old): the page kept on its version as it is, the app at app/ afresh if it can be had
    for (const k of (await caches.keys()).filter((n) => n.startsWith('konium-site-') && n !== CACHE)) {
      const old = await caches.open(k);
      const kept = await old.match(KEPT);
      if (kept && !(await c.match(KEPT))) await c.put(KEPT, kept);
      const app = await old.match(scoped('./app/'));
      if (app && !(await c.match(scoped('./app/')))) await c.add(new Request(scoped('./app/'), { cache: 'reload' })).catch(() => c.put(scoped('./app/'), app));
    }
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => (k.startsWith('konium-site-') && k !== CACHE) || /^konium-v\d/.test(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // The site's services (AI, parts, reports) answer afresh every time: never kept
  if (url.pathname.startsWith('/api/')) return;
  // The published version number always comes from the network (never kept)
  if (url.pathname.endsWith('/version.json')) return;
  const root = new URL(self.registration.scope).pathname;
  const inApp = url.pathname.startsWith(`${root}app/`);
  // The manifest for a copy kept on its version here: as it was while the app lived here (its start,
  // scope and file handler this folder), so the browser leaves that install where it is. Anyone
  // else gets the manifest as it is (the app at app/).
  if (url.pathname === `${root}manifest.webmanifest`) {
    e.respondWith((async () => {
      const res = (await caches.match(req)) ?? await fetch(req);
      if (!(await pinned()) || !(await caches.match(KEPT))) return res;
      try {
        const m = await res.clone().json();
        m.start_url = './'; m.scope = './';
        for (const h of m.file_handlers ?? []) h.action = './';
        return new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/manifest+json' } });
      } catch { return res; }
    })());
    return;
  }
  // What's New: the network first (it grows with every release), the last copy read when offline
  if (url.pathname.endsWith('/whats-new.json')) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req)));
    return;
  }
  if (req.mode === 'navigate') {
    const home = url.pathname === root || url.pathname === `${root}index.html`;
    e.respondWith((async () => {
      // A copy of the app kept on its version here (up to 26.168)
      if (home && await pinned()) { const hit = await caches.match(KEPT); if (hit) return hit; }
      return fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(async (res) => {
        const page = await plain(res);
        // The website's pages kept as they are read; the app's page only by the app's own worker
        if (!inApp && page.ok && (page.headers.get('content-type') ?? '').includes('text/html')) {
          const copy = page.clone();
          caches.open(CACHE).then((c) => c.put(req.url.split('#')[0].split('?')[0], copy));
        }
        return page;
      }).catch(async () => (inApp ? await caches.match(scoped('./app/')) : await caches.match(req.url.split('#')[0].split('?')[0])) ?? caches.match(scoped('./')));
    })());
    return;
  }
  // Pictures, the style sheet, fonts: kept once read (the app's own requests go through the app's
  // worker). The pages ask for the style sheet and pictures by an address that changes with their
  // contents (?v=…), so a kept copy is never an older one; offline, a copy under another such
  // address is better than none.
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && !inApp) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch((err) => caches.match(req, { ignoreSearch: true }).then((any) => any ?? Promise.reject(err)))),
  );
});
