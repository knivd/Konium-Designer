import { describe, expect, it } from 'vitest';
// @ts-expect-error: the website's generator is plain JavaScript (website/site.mjs)
import { stampWorker } from '../website/site.mjs';
import siteSw from '../public/sw.js?raw';
import pkg from '../package.json';

/**
 * konium.app's own worker (public/sw.js), run here against caches and a network kept in memory:
 * an upload of the website alone is a new worker with a new cache, and what the cache before it
 * kept of the app (the page kept on its version at the old address, the app's page for offline)
 * goes with it; a copy kept on its version keeps the manifest it was installed with; the style
 * sheet and pictures are asked for by fingerprinted addresses.
 */

const ORIGIN = 'https://konium.app/';
/** The worker's cache as it is named in the source (the release's version; the build adds the upload's fingerprint). */
const SITE = `konium-site-v${pkg.version.replace(/\.0$/, '')}`;

class MemCache {
  readonly map = new Map<string, Response>();
  private key(r: string | Request) { return typeof r === 'string' ? r : r.url; }
  async match(r: string | Request, o?: { ignoreSearch?: boolean }): Promise<Response | undefined> {
    const k = this.key(r), hit = this.map.get(k);
    if (hit) return hit.clone();
    if (o?.ignoreSearch) for (const [u, v] of this.map) if (u.split('?')[0] === k.split('?')[0]) return v.clone();
    return undefined;
  }
  async put(r: string | Request, res: Response) { this.map.set(this.key(r), res); }
  async delete(r: string | Request) { return this.map.delete(this.key(r)); }
}
class World {
  readonly stores = new Map<string, MemCache & { add(r: string | Request): Promise<void> }>();
  readonly net = new Map<string, [string, string]>();
  offline = false;
  asked: string[] = [];
  fetch = async (r: string | Request): Promise<Response> => {
    const url = typeof r === 'string' ? r : r.url;
    this.asked.push(url);
    if (this.offline) throw new TypeError('Failed to fetch');
    const hit = this.net.get(url);
    return hit ? new Response(hit[0], { headers: { 'content-type': hit[1] } }) : new Response('not found', { status: 404 });
  };
  caches = {
    open: async (n: string) => {
      let c = this.stores.get(n);
      if (!c) {
        const m = new MemCache() as MemCache & { add(r: string | Request): Promise<void> };
        m.add = async (r) => { const res = await this.fetch(r); if (!res.ok) throw new TypeError('bad response'); await m.put(r, res); };
        this.stores.set(n, c = m);
      }
      return c;
    },
    keys: async () => [...this.stores.keys()],
    has: async (n: string) => this.stores.has(n),
    delete: async (n: string) => this.stores.delete(n),
    match: async (r: string | Request, o?: { ignoreSearch?: boolean }) => { for (const c of this.stores.values()) { const hit = await c.match(r, o); if (hit) return hit; } return undefined; },
  };
  put(path: string, body: string, type = 'text/html') { this.net.set(ORIGIN + path, [body, type]); }
  async kept(cache: string, path: string) { return (await (await this.caches.open(cache)).match(ORIGIN + path))?.text(); }
}

type Handler = (e: Record<string, unknown>) => void;
function boot(source: string, w: World) {
  const on: Record<string, Handler> = {};
  const self = { addEventListener: (t: string, h: Handler) => { on[t] = h; }, registration: { scope: ORIGIN }, location: { origin: ORIGIN.slice(0, -1) }, skipWaiting: () => undefined, clients: { claim: async () => undefined } };
  new Function('self', 'caches', 'fetch', source)(self, w.caches, w.fetch); // eslint-disable-line @typescript-eslint/no-implied-eval
  const phase = async (t: string) => { let p: Promise<unknown> | undefined; on[t]!({ waitUntil: (x: Promise<unknown>) => { p = x; } }); await p; };
  return {
    install: () => phase('install'),
    activate: () => phase('activate'),
    /** What the worker answers (undefined: left to the browser). */
    async ask(path: string, navigate = false): Promise<Response | undefined> {
      const request = new Request(ORIGIN + path);
      if (navigate) Object.defineProperty(request, 'mode', { value: 'navigate' });
      let p: Promise<Response> | undefined;
      on.fetch!({ request, respondWith: (x: Promise<Response>) => { p = x; } });
      return p;
    },
  };
}

const MANIFEST = JSON.stringify({ id: '/', name: 'Konium Designer', start_url: 'app/', scope: 'app/', file_handlers: [{ action: 'app/', accept: {} }] });
function website(w: World, css = 'aaaa1111') {
  for (const p of ['', 'features/', 'formats/', 'download/', 'whats-new/', 'faq/', 'support/', 'guides/']) w.put(p, `<title>website ${p}</title>`);
  w.put('app/', '<div id="app">the app, 26.169</div>');
  w.put('manifest.webmanifest', MANIFEST, 'application/manifest+json');
  w.put(`assets/site.css?v=${css}`, `/* ${css} */`, 'text/css');
  w.put('assets/site.css', `/* ${css} */`, 'text/css');
  return stampWorker(siteSw, css, ['guides/', `assets/site.css?v=${css}`]) as string;
}
/** The app as it was kept at konium.app itself up to 26.168, on its version (Offline, or updates off). */
async function formerApp(w: World, pinned: boolean) {
  const old = await w.caches.open('konium-v26.168');
  await old.put(`${ORIGIN}index.html`, new Response('<div id="app">the app, 26.168</div>', { headers: { 'content-type': 'text/html' } }));
  if (pinned) await (await w.caches.open('konium-flags')).put(`${ORIGIN}__pinned`, new Response('1'));
}

describe("konium.app's own worker (26.169)", () => {
  it('as the build sends it out: its cache named for the upload, the other pages and the fingerprinted style sheet kept at once', async () => {
    const w = new World(), sw = website(w);
    expect(sw).toContain(`const CACHE = '${SITE}-aaaa1111';`);
    expect(sw).toContain('const MORE = ["./guides/","./assets/site.css?v=aaaa1111"];');
    expect(() => stampWorker('const CACHE = 1;', 'x', [])).toThrow();
    const a = boot(sw, w);
    await a.install(); await a.activate();
    expect(await w.caches.keys()).toEqual([`${SITE}-aaaa1111`]);
    for (const p of ['', 'features/', 'guides/', 'assets/site.css?v=aaaa1111', 'manifest.webmanifest']) expect(await w.kept(`${SITE}-aaaa1111`, p), p).toBeDefined();
    // Nothing of the app without one kept here before
    expect(await w.kept(`${SITE}-aaaa1111`, 'app/')).toBeUndefined();
    expect(JSON.parse(await (await a.ask('manifest.webmanifest'))!.text()).start_url).toBe('app/');
  });

  it('an upload of the website alone: a new worker, a new cache, the old one gone; a changed style sheet is asked for under its new address', async () => {
    const w = new World();
    const a = boot(website(w, 'aaaa1111'), w);
    await a.install(); await a.activate();
    expect(await (await a.ask('assets/site.css?v=aaaa1111'))!.text()).toBe('/* aaaa1111 */');
    // The website again, its style sheet changed
    const b = boot(website(w, 'bbbb2222'), w);
    // The page of the new upload under the worker before it: the new style sheet is not one it kept, so it is fetched
    w.asked = [];
    expect(await (await a.ask('assets/site.css?v=bbbb2222'))!.text()).toBe('/* bbbb2222 */');
    expect(w.asked).toEqual([`${ORIGIN}assets/site.css?v=bbbb2222`]);
    await b.install(); await b.activate();
    expect(await w.caches.keys()).toEqual([`${SITE}-bbbb2222`]);
    // Offline: the style sheet under the address asked for; one never fetched, the copy there is; nothing at all, the failure
    w.offline = true;
    expect(await (await b.ask('assets/site.css?v=bbbb2222'))!.text()).toBe('/* bbbb2222 */');
    expect(await (await b.ask('assets/site.css?v=cccc3333'))!.text()).toBe('/* bbbb2222 */');
    await expect(b.ask('assets/img/never-seen.webp')).rejects.toThrow('Failed to fetch');
  });

  it('a copy kept on its version at the old address stays through every later worker, with the manifest it was installed with; updates back on, the website and the app at app/', async () => {
    const w = new World();
    await formerApp(w, true);
    const a = boot(website(w, 'aaaa1111'), w);
    await a.install(); await a.activate();
    expect(await w.caches.keys()).toEqual(['konium-flags', `${SITE}-aaaa1111`]);
    expect(await (await a.ask('', true))!.text()).toContain('the app, 26.168');
    // The website uploaded again: the kept page goes into the new cache
    const b = boot(website(w, 'bbbb2222'), w);
    await b.install(); await b.activate();
    expect(await w.caches.keys()).toEqual(['konium-flags', `${SITE}-bbbb2222`]);
    expect(await (await b.ask('', true))!.text()).toContain('the app, 26.168');
    expect(await (await b.ask('index.html', true))!.text()).toContain('the app, 26.168');
    // …and once more
    const c = boot(website(w, 'cccc3333'), w);
    await c.install(); await c.activate();
    expect(await (await c.ask('', true))!.text()).toContain('the app, 26.168');
    // Its manifest as it was while the app lived here, so the browser leaves the install where it is
    const m = JSON.parse(await (await c.ask('manifest.webmanifest'))!.text()) as { id: string; start_url: string; scope: string; file_handlers: { action: string }[] };
    expect([m.id, m.start_url, m.scope, m.file_handlers[0]!.action]).toEqual(['/', './', './', './']);
    // The other pages are the website's
    expect(await (await c.ask('features/', true))!.text()).toContain('website features/');
    // Updates back on (the page takes its flag away): the website here, the manifest as it is
    await (await w.caches.open('konium-flags')).delete(`${ORIGIN}__pinned`);
    expect(await (await c.ask('', true))!.text()).toContain('website ');
    expect(JSON.parse(await (await c.ask('manifest.webmanifest'))!.text()).start_url).toBe('app/');
  });

  it('the app kept here before, not on its version: the app at app/ kept for offline, afresh with each later worker while it can be had', async () => {
    const w = new World();
    await formerApp(w, false);
    const a = boot(website(w, 'aaaa1111'), w);
    await a.install(); await a.activate();
    expect(await w.kept(`${SITE}-aaaa1111`, 'app/')).toContain('the app, 26.169');
    expect(await w.kept(`${SITE}-aaaa1111`, '__kept-app.html')).toBeUndefined();
    const b = boot(website(w, 'bbbb2222'), w);
    w.put('app/', '<div id="app">the app, 26.170</div>');
    await b.install(); await b.activate();
    expect(await w.kept(`${SITE}-bbbb2222`, 'app/')).toContain('the app, 26.170');
    // A later worker installed with app/ out of reach: the copy it had
    const c = boot(website(w, 'cccc3333'), w);
    w.net.delete(`${ORIGIN}app/`);
    await c.install(); await c.activate();
    expect(await w.kept(`${SITE}-cccc3333`, 'app/')).toContain('the app, 26.170');
    w.offline = true;
    expect(await (await c.ask('app/', true))!.text()).toContain('the app, 26.170');
    expect(await (await c.ask('guides/', true))!.text()).toContain('website guides/');
    expect(JSON.parse(await (await c.ask('manifest.webmanifest'))!.text()).start_url).toBe('app/');
  });
});
