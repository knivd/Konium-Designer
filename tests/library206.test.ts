/**
 * 26.206 (R21, step 5): the world parts library's public pages. Each part has a page at the
 * site's /parts/<its key>, there is a list of the latest and a sitemap. A page says what the
 * library's own files say, everything on it is text (a part's fields, a contributor's name and
 * what is said of a part are other people's words), a company's own part has none, and the app
 * opened from a page has the part's number typed and asks the library nothing by itself. The
 * service's own code is driven, with GitHub, the mail and the DNS stood in for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_MISSES_PER_HOUR, PAGE_SECONDS, handle, isPagePath, type LibraryEnv } from '../cloudflare/library/src/handler';
import { LIST_MOST, LibraryStoreLogic } from '../cloudflare/library/src/store';
import { OrgStoreLogic } from '../cloudflare/library/src/org';
import { partPage, partsSitemap, webAddress } from '../cloudflare/library/src/pages';
import { ENV, T0, sqlite, world } from './helpers/libraryWorld';
import toml from '../cloudflare/library/wrangler.toml?raw';
import { examplePart } from '../src/model/partExample';
import { partKey } from '../src/model/partKey';
import { cleanRecord, partFolder, type LibraryEntry } from '../src/model/worldLibrary';
import { askSignIn, partPageUrl, publishPart, resetLibraryConfig, sayOfPart, sessionFor } from '../src/platform/libraryService';
import { orgClaim, orgPublish, orgStatus } from '../src/platform/orgService';
import { askedPart } from '../src/app/worldLibrary';
import { count, noun } from '../src/core/words';

const PART = examplePart('26.206');
const KEY = partKey(PART.record.mpn);
const SITE = 'https://konium.app';

function service(more: Partial<LibraryEnv> = {}) {
  const env: LibraryEnv = { ...ENV, ORG_DOMAINS: 'example.com', ...more };
  const w = world();
  let store = new LibraryStoreLogic(sqlite());
  const made = new Map<string, OrgStoreLogic>();
  const orgs = (domain: string) => { let o = made.get(domain); if (!o) made.set(domain, o = new OrgStoreLogic(sqlite())); return o; };
  const dns = new Map<string, string[]>();
  const outside = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://cloudflare-dns.com/dns-query?')) return w.fetchFn(input, init);
    const name = new URL(url).searchParams.get('name')!;
    return new Response(JSON.stringify({ Status: 0, Answer: (dns.get(name) ?? []).map((t) => ({ name, type: 16, data: `"${t}"` })) }), { headers: { 'Content-Type': 'application/dns-json' } });
  }) as typeof fetch;
  const clock = { now: T0 };
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return handle(new Request(String(input), { ...init, headers: { 'CF-Connecting-IP': '203.0.113.7', ...headers } }), env, store, outside, clock.now, orgs);
  }) as typeof fetch;
  const as = async (email: string) => {
    clock.now += 3_600_000;
    const { ticket } = await askSignIn(email, f);
    const link = /confirm\?id=([0-9a-f]{32})&code=([0-9a-f]{40})/.exec(w.mails.at(-1)!.text)!;
    await handle(new Request(`${SITE}/api/library/confirm`, { method: 'POST', body: new URLSearchParams({ id: link[1]!, code: link[2]! }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), env, store, outside, clock.now, orgs);
    const s = await sessionFor(ticket, f, clock.now);
    if (s === 'pending') throw new Error('still pending');
    clock.now += 1000;
    return s.user.id;
  };
  /** A page as a visitor's browser asks for it. */
  const get = async (path: string, init: RequestInit = {}, ip = '198.51.100.9') => {
    const res = await handle(new Request(`${SITE}${path}`, { ...init, headers: { 'CF-Connecting-IP': ip } }), env, store, outside, clock.now, orgs);
    return { res, status: res.status, text: await res.text(), type: res.headers.get('Content-Type') ?? '', cache: res.headers.get('Cache-Control') ?? '' };
  };
  const say = (entry: Pick<LibraryEntry, 'key' | 'revision'>, verdict: 'confirm' | 'built' | 'problem', o: { note?: string; name?: string } = {}) => sayOfPart(entry, verdict, o, f, clock.now).then((a) => { clock.now += 1000; return a; });
  const publish = (name?: string, part = PART) => publishPart(part, { agreed: true, name, app: '26.206' }, f, clock.now).then((a) => { clock.now += 1000; return a; });
  /** The index lost: the service starts again with nothing but the repository. */
  const forget = () => { store = new LibraryStoreLogic(sqlite()); };
  return { env, w, f, clock, as, get, say, publish, forget, dns, made };
}

let kept: Map<string, string>;
beforeEach(() => {
  kept = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) });
  resetLibraryConfig();
});
afterEach(() => { vi.unstubAllGlobals(); });

/**
 * Would a browser run or fetch anything by itself on this page: a tag that does, a handler among
 * a tag's attributes (outside their quoted values, where it is only text), or an address that runs.
 */
const runs = (t: string): boolean => /<script|<img|<iframe|<object|<embed|<svg|<form|<base\b|<link(?! rel="canonical")/i.test(t)
  || (t.match(/<[a-zA-Z][^>]*>/g) ?? []).some((tag) => /\son\w+\s*=/i.test(tag.replace(/"[^"]*"/g, '""')))
  || /(?:href|src|action|content)="\s*(?:javascript|data|vbscript):/i.test(t);
/** The tags a page of the library is made of. */
const TAGS = ['a', 'body', 'br', 'dd', 'dl', 'dt', 'footer', 'h1', 'h2', 'head', 'header', 'html', 'li', 'link', 'main', 'meta', 'p', 'small', 'span', 'strong', 'style', 'table', 'td', 'th', 'title', 'tr', 'ul'];

describe('a part\'s public page (26.206)', () => {
  it('says what the library\'s files say: what the part is, its pins, who published it and how to get it', async () => {
    const s = service();
    const ada = await s.as('ada@example.org');
    const p = await s.publish('Ada L.');
    const page = await s.get(`/parts/${KEY}`);
    expect([page.status, page.type, page.cache]).toEqual([200, 'text/html; charset=utf-8', `public, max-age=${PAGE_SECONDS}`]);
    const r = PART.record, t = page.text;
    // (what it is, as its record says)
    for (const said of [r.mpn, r.maker, r.description, r.package.name, r.package.footprint, `${r.package.pins} pins`, 'its pads worked out by IPC-7351B']) expect(t).toContain(said);
    expect(t.match(/<tr><td>/g)).toHaveLength(r.pins.length);
    for (const pin of r.pins) expect(t).toContain(`<tr><td>${pin.number}</td><td>${pin.name}</td>`);
    // (a pin's kind in words, not in the record's short ones)
    expect(t).toContain('<td>PG</td><td>open collector or drain</td>');
    expect(t).toContain('<td>NC</td><td>not connected</td>');
    // (where it stands and whose it is: the name its contributor shows and their number, never their address)
    expect(t).toContain('<span class="chip unverified">Unverified</span>');
    expect(t).toContain('0 of 2 checks');
    expect(t).toMatch(new RegExp(`Published by Ada L\\. <small>\\(${ada}\\)</small> on 20 Nov 2026, revision 1, from Konium Designer 26\\.206`));
    expect(t).not.toMatch(/ada@|example\.org/);
    expect(t).toContain('CC0 1.0 Universal');
    // (how to get it: the app with its number typed, and its files where they are kept, at the commit that holds them)
    expect(t).toContain(`href="${SITE}/app/?part=${encodeURIComponent(r.mpn)}"`);
    expect(t).toContain(`href="https://github.com/o/parts/tree/${p.commit}/${partFolder(KEY)}"`);
    expect(p.commit).toMatch(/^[0-9a-f]{40}$/);
    // (for search engines: its own address, a title and a description with the part's number)
    expect(t).toContain(`<link rel="canonical" href="${SITE}/parts/${KEY}">`);
    expect(/<title>([^<]*)<\/title>/.exec(t)![1]).toBe(`${r.mpn}: symbol and footprint (Konium parts library)`);
    expect(/<meta name="description" content="([^"]*)"/.exec(t)![1]).toContain(`${r.mpn} by ${r.maker}: ${r.package.name}, ${r.package.pins} pins`);
    expect(t).not.toContain('noindex');
    // (a page runs nothing and sits in no frame, whatever is on it)
    expect(runs(t)).toBe(false);
    expect(page.res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect([page.res.headers.get('X-Frame-Options'), page.res.headers.get('X-Content-Type-Options')]).toEqual(['DENY', 'nosniff']);
    // (with or without a stroke at its end, and its head alone)
    expect((await s.get(`/parts/${KEY}/`)).text).toBe(t);
    const head = await s.get(`/parts/${KEY}`, { method: 'HEAD' });
    expect([head.status, head.text, head.type]).toEqual([200, '', 'text/html; charset=utf-8']);
  });

  it('follows what is said of the part: who found it right, who built it, what was found wrong', async () => {
    const s = service();
    await s.as('ada@example.org');
    const p = await s.publish('Ada L.');
    await s.as('bob@example.org'); await s.say(p.entry, 'confirm', { name: 'Bob' });
    expect((await s.get(`/parts/${KEY}`)).text).toMatch(/Unverified<\/strong> \(1 of 2 checks\)[\s\S]*<li>Found right by Bob <small>20 Nov 2026<\/small><\/li>/);
    const cy = await s.as('cy@example.org'); await s.say(p.entry, 'confirm');
    let t = (await s.get(`/parts/${KEY}`)).text;
    expect(t).toContain('<span class="chip confirmed">Confirmed</span>');
    expect(t).toContain(`<li>Found right by ${cy} <small>20 Nov 2026</small></li>`);     // (no name shown: the number alone)
    await s.as('dee@example.org'); await s.say(p.entry, 'built', { name: 'Dee' });
    await s.say(p.entry, 'problem', { note: 'Pin 3 is VOUT in the datasheet, not GND' });
    t = (await s.get(`/parts/${KEY}`)).text;
    expect(t).toContain('<span class="chip proven">Proven</span>');
    expect(t).toContain('checked by 2, built by 1, 1 problem reported');
    expect(t).toContain('<li>Built on a board that works by Dee <small>20 Nov 2026</small></li>');
    expect(t).toContain('<li class="wrong">Pin 3 is VOUT in the datasheet, not GND <small>(Dee, 20 Nov 2026)</small></li>');
    expect(/<meta name="description" content="([^"]*)"/.exec(t)![1]).toMatch(/Proven\.$/);
    expect(t).not.toMatch(/@example\.org/);
  });

  it('writes other people\'s words as text, whatever they are', async () => {
    const s = service();
    // A part put into the repository by hand, its fields written to be read as markup
    const mpn = 'EVIL-<b>1</b>"\'&', key = partKey(mpn);
    expect(key).toBe('EVILB1B');
    const record = {
      ...cleanRecord(PART.record), mpn, maker: '"><img src=x onerror=alert(1)>', description: '</p><script>alert(document.domain)</script>', device: '<svg onload=alert(1)>',
      symbol: '<iframe src=//evil.example>', package: { name: '\'" onmouseover="alert(1)', pins: 2, footprint: '<base href=//evil.example/>', from: 'drawn' },
      pins: [{ number: '<i>1', name: '<script>x</script>', type: '"><b>' }, { number: '2', name: '&lt;ok&gt;', type: 'passive' }],
      datasheet: { ...PART.record.datasheet, url: 'https://sheets.example/a.pdf?x=1&y=<2>', title: '<a href="javascript:alert(1)">sheet</a>' },
    };
    // (its link has marks a record may not have: the library would not take it, so the page shows the note alone)
    s.w.put(`${partFolder(key)}/part.json`, JSON.stringify(record));
    s.w.put(`${partFolder(key)}/library.json`, JSON.stringify({ key, mpn, status: 'proven', by: 'k-0000beef', name: '<script>alert(1)</script>Mal', published: '2026-11-20T10:00:00.000Z<x>', revision: 2, licence: 'CC0-1.0', app: '<b>9</b>',
      problems: [{ by: 'k-0000beef', name: '<img src=x>', at: '"><script>', note: '<img src=x onerror=alert(1)> the pads are wrong' }] }));
    let t = (await s.get(`/parts/${key}`)).text;
    expect(runs(t)).toBe(false);
    expect(t).toContain('The part\'s own file could not be read just now');
    expect(t).not.toContain('<h2>Pins</h2>');
    expect(t).toContain('EVIL-&#60;b&#62;1&#60;/b&#62;&#34;&#39;&#38;');
    expect(t).toContain('&#60;img src=x onerror=alert(1)&#62; the pads are wrong');
    // The same with a link the library takes: the record is shown, every field of it as text
    s.forget();
    s.w.put(`${partFolder(key)}/part.json`, JSON.stringify({ ...record, datasheet: { ...record.datasheet, url: 'https://sheets.example/a.pdf?x=1&y=2' } }));
    t = (await s.get(`/parts/${key}`)).text;
    expect(runs(t)).toBe(false);
    expect(t).toContain('<h2>Pins</h2>');
    expect(t).toContain('<tr><td>&#60;i&#62;1</td><td>&#60;script&#62;x&#60;/script&#62;</td><td>&#34;&#62;&#60;b&#62;</td></tr>');
    expect(t).toContain('<td>&#38;lt;ok&#38;gt;</td>');
    expect(t).toContain('<a href="https://sheets.example/a.pdf?x=1&#38;y=2" rel="nofollow noopener noreferrer ugc">&#60;a href=&#34;javascript:alert(1)&#34;&#62;sheet&#60;/a&#62;</a>');
    // (every tag on the page is one the page wrote itself)
    for (const tag of new Set((t.match(/<\/?[a-zA-Z][\w-]*/g) ?? []).map((x) => x.replace(/[</]/g, '').toLowerCase()))) expect(TAGS).toContain(tag);
    // (and each link leads where the page means it to: the site, the licence, the repository, the datasheet)
    const links = [...t.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&#38;/g, '&'));
    for (const l of links) expect(l).toMatch(/^https:\/\/(konium\.app\/|creativecommons\.org\/publicdomain\/zero\/1\.0\/$|github\.com\/o\/parts\/tree\/|sheets\.example\/a\.pdf\?x=1&y=2$)/);
  });

  it('links a datasheet only by a web address', () => {
    expect(['https://www.example.com/ds.pdf', 'http://example.com/a b', 'javascript:alert(1)', 'data:text/html,<b>', 'https://user:pw@example.com/x', 'ftp://example.com/x', '//example.com/x', 'ds.pdf', ''].map(webAddress))
      .toEqual(['https://www.example.com/ds.pdf', 'http://example.com/a%20b', '', '', '', '', '', '', '']);
    const entry: LibraryEntry = { key: KEY, mpn: PART.record.mpn, status: 'unverified', by: 'k-00000001', name: '', published: '2026-11-20T10:00:00.000Z', revision: 1, licence: 'CC0-1.0', app: '26.206' };
    const page = (url: string, sha256 = '') => partPage({ entry, record: { ...cleanRecord(PART.record), datasheet: { ...PART.record.datasheet, url, sha256 } }, site: SITE, files: 'https://github.com/o/parts/tree/main/x' });
    expect(page('javascript:alert(1)')).toContain('<dt>Datasheet</dt><dd>None named');
    expect(page('', 'a'.repeat(64))).toContain('<dt>Datasheet</dt><dd>A file its author had: not linked');
    expect(page('javascript:alert(1)')).not.toMatch(/href="javascript/);
    // (a part nobody put a name to is its contributor's number's; one with neither is somebody unnamed)
    expect(page('')).toContain('Published by k-00000001 on 20 Nov 2026');
    expect(partPage({ entry: { ...entry, by: '' }, record: null, site: SITE, files: 'https://github.com/o/parts/tree/main/x' })).toContain('Published by someone unnamed on 20 Nov 2026');
  });
});

describe('the pages\' addresses (26.206)', () => {
  it('are the site\'s /parts and nothing of the service\'s own', async () => {
    expect(['/parts', '/parts/', '/parts/ABC123', '/parts/ABC123/', '/parts/sitemap.xml', '/parts/a/b', '/api/library/parts', '/api/library/part/ABC123', '/partsx', '/app/parts'].map(isPagePath))
      .toEqual([true, true, true, true, true, false, false, false, false, false]);
    const s = service();
    const api = await s.get('/api/library/parts');
    expect([api.status, api.type]).toEqual([404, 'application/json']);
  });

  it('lead a part number typed as it is written to its page, and say plainly when there is none', async () => {
    const s = service();
    await s.as('ada@example.org'); await s.publish();
    const typed = await s.get(`/parts/${encodeURIComponent(PART.record.mpn.toLowerCase())}`);
    expect([typed.status, typed.res.headers.get('Location')]).toEqual([301, `${SITE}/parts/${KEY}`]);
    // (a redirect goes to this site's own page and nowhere else, whatever was typed)
    const odd = await s.get('/parts/%2F%2Fevil.example%2F%3Cscript%3E');
    expect([odd.status, odd.res.headers.get('Location')]).toEqual([301, `${SITE}/parts/EVILEXAMPLESCRIPT`]);
    // (an address that is no text at all is read as it came, and breaks nothing)
    expect((await s.get('/parts/%E0%A4%A')).res.headers.get('Location')).toBe(`${SITE}/parts/E0A4A`);
    for (const none of ['/parts/NOSUCHPART1', '/parts/EVILEXAMPLESCRIPT', '/parts/!!', '/parts/E0A4A']) {
      const p = await s.get(none);
      expect([none, p.status, p.cache, p.type]).toEqual([none, 404, 'no-store', 'text/html; charset=utf-8']);
      expect(p.text).toContain('<meta name="robots" content="noindex">');
      expect(p.text).toContain('<h1>No such part</h1>');
      expect(runs(p.text)).toBe(false);
    }
    expect((await s.get('/parts/NOSUCHPART1')).text).toContain('There is no part NOSUCHPART1 in the world parts library yet');
    const post = await s.get(`/parts/${KEY}`, { method: 'POST', body: 'x' });
    expect([post.status, post.res.headers.get('Allow')]).toEqual([405, 'GET, HEAD']);
  });

  it('list the latest parts, and give search engines every page\'s address', async () => {
    const s = service();
    let list = await s.get('/parts');
    expect([list.status, list.cache]).toEqual([200, `public, max-age=${PAGE_SECONDS}`]);
    expect(list.text).toContain('0 parts, each a schematic symbol');
    expect(list.text).toContain('<p>None yet.</p>');
    await s.as('ada@example.org'); await s.publish('Ada L.');
    // (a second part, put into the repository a day later and found there: the newest comes first)
    s.w.put(`${partFolder('KDEX2')}/library.json`, JSON.stringify({ key: 'KDEX2', mpn: 'KD-EX2', status: 'confirmed', by: 'k-0000beef', name: 'Bea', published: '2026-11-21T09:00:00.000Z', revision: 3, licence: 'CC0-1.0', app: '26.206' }));
    expect((await s.get('/parts/KDEX2')).text).toContain('Published by Bea <small>(k-0000beef)</small> on 21 Nov 2026, revision 3');
    list = await s.get('/parts/');
    expect(list.text).toContain('2 parts, each a schematic symbol');
    const rows = [...list.text.matchAll(/<tr><td><a href="([^"]*)">([^<]*)<\/a><\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><\/tr>/g)].map((m) => m.slice(1));
    expect(rows).toEqual([
      [`${SITE}/parts/KDEX2`, 'KD-EX2', '21 Nov 2026 by Bea', 'Confirmed'],
      [`${SITE}/parts/${KEY}`, PART.record.mpn, '20 Nov 2026 by Ada L.', 'Unverified'],
    ]);
    expect(list.text).toContain(`<link rel="canonical" href="${SITE}/parts/">`);
    expect(runs(list.text)).toBe(false);
    const map = await s.get('/parts/sitemap.xml');
    expect([map.status, map.type, map.cache]).toEqual([200, 'application/xml; charset=utf-8', 'public, max-age=3600']);
    expect(map.text).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${SITE}/parts/</loc></url>\n<url><loc>${SITE}/parts/KDEX2</loc><lastmod>2026-11-21</lastmod></url>\n<url><loc>${SITE}/parts/${KEY}</loc><lastmod>2026-11-20</lastmod></url>\n</urlset>\n`);
    // (a sitemap holds 50,000 addresses at most: the list is cut well short of that)
    expect(LIST_MOST).toBeLessThanOrEqual(45_000);
    expect(partsSitemap([{ key: 'ABC', published: 'not a date' }, { key: 'ABD', published: '2026-13-41T00:00:00Z' }], SITE)).toContain(`<url><loc>${SITE}/parts/ABC</loc></url>\n<url><loc>${SITE}/parts/ABD</loc></url>`);
  });
});

describe('what the pages cost and what they keep to themselves (26.206)', () => {
  it('a company\'s own part has no page, is in no list and in no sitemap', async () => {
    const s = service();
    await s.as('ada@example.com');
    const st = await orgStatus('example.com', s.f, s.clock.now);
    s.dns.set(st.record!.name, [st.record!.value]);
    await orgClaim('example.com', s.f, s.clock.now);
    const e = await orgPublish('example.com', PART, { name: 'Ada', app: '26.206' }, s.f, s.clock.now);
    expect([e.org, e.key]).toEqual(['example.com', KEY]);
    const page = await s.get(`/parts/${KEY}`);
    expect(page.status).toBe(404);
    expect(page.text).not.toMatch(/SO-8|Ada/);
    expect((await s.get('/parts')).text).toContain('0 parts, each');
    expect((await s.get('/parts/sitemap.xml')).text).not.toContain(KEY);
    // (and a note in the repository that calls a part a company's is not shown either)
    s.w.put(`${partFolder('ABC123')}/library.json`, JSON.stringify({ key: 'ABC123', mpn: 'ABC-123', status: 'unverified', by: 'k-00000001', name: '', published: '2026-11-20T10:00:00.000Z', revision: 1, licence: 'private', app: '26.206', org: 'example.com' }));
    expect((await s.get('/parts/ABC123')).status).toBe(404);
  });

  it('a visitor gets so many pages a day, and nothing at all until the library is open', async () => {
    const s = service({ PAGE_PER_DAY: '3' });
    await s.as('ada@example.org'); await s.publish();
    expect([(await s.get('/parts')).status, (await s.get(`/parts/${KEY}`)).status, (await s.get('/parts/sitemap.xml')).status]).toEqual([200, 200, 200]);
    const over = await s.get(`/parts/${KEY}`);
    expect([over.status, over.res.headers.get('Retry-After'), over.cache]).toEqual([429, '3600', 'no-store']);
    expect(over.text).toContain('makes 3 pages a day for one visitor');
    // (somebody else is not kept out by that, nor the same visitor the day after)
    expect((await s.get(`/parts/${KEY}`, {}, '198.51.100.77')).status).toBe(200);
    s.clock.now += 86_400_000;
    expect((await s.get(`/parts/${KEY}`)).status).toBe(200);
    const shut = service({ GITHUB_TOKEN: '' });
    for (const path of ['/parts', `/parts/${KEY}`, '/parts/sitemap.xml']) {
      const p = await shut.get(path);
      expect([path, p.status, p.type, p.cache]).toEqual([path, 503, 'text/html; charset=utf-8', 'no-store']);
      expect(p.text).toContain('has not been opened yet');
      expect(p.text).toContain('noindex');
    }
    expect(shut.w.calls).toEqual([]);
  });

  it('the repository is the truth when the index is lost, and is asked about unknown parts no more than the whole service may', async () => {
    const s = service();
    await s.as('ada@example.org'); await s.publish('Ada L.');
    s.forget();
    const raw = () => s.w.calls.filter((c) => c.startsWith('GET raw:')).length;
    let before = raw();
    const page = await s.get(`/parts/${KEY}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Published by Ada L.');
    expect(page.text).toContain(`<tr><td>${PART.record.pins[0]!.number}</td>`);
    expect(page.text).toContain(`href="https://github.com/o/parts/tree/main/${partFolder(KEY)}"`);   // (the commit is not known again: the branch)
    expect(raw() - before).toBe(2);                                                                    // (the note, then the record)
    // (found once, it is in the index again: its page asks for the record alone, and the list has it)
    before = raw();
    await s.get(`/parts/${KEY}`);
    expect(raw() - before).toBe(1);
    expect((await s.get('/parts')).text).toContain('1 part, each');
    // (keys that are no parts: each asks the repository once, until the hour's lot is used up)
    s.env.PAGE_PER_DAY = '100000';
    before = raw();
    for (let i = 0; i < PAGE_MISSES_PER_HOUR + 20; i++) expect((await s.get(`/parts/NOPART${i}`)).status).toBe(404);
    expect(raw() - before).toBe(PAGE_MISSES_PER_HOUR - 1);                                             // (one of the hour's was the lost part's)
    s.clock.now += 3_600_000;
    before = raw();
    await s.get('/parts/NOPART99999');
    expect(raw() - before).toBe(1);
  });

  it('the Worker answers at the site\'s /parts as well as at the service\'s address', () => {
    expect([...toml.matchAll(/pattern = "([^"]+)"/g)].map((m) => m[1])).toEqual(['konium.app/api/library/*', 'konium.app/parts', 'konium.app/parts/*']);
    expect(toml).toMatch(/^PAGE_PER_DAY = "2000"$/m);
  });
});

describe('the app and a part\'s page (26.206)', () => {
  it('a page\'s address is the site\'s; the app opened from one has the number and nothing else', () => {
    expect(partPageUrl(KEY)).toBe(`${SITE}/parts/${KEY}`);
    expect([askedPart(`?part=${encodeURIComponent(PART.record.mpn)}`), askedPart('?features=all&part=LM358DR'), askedPart('?part=ab'), askedPart('?part=%0A%20TPS54331%09DR%0A'), askedPart('?other=1'), askedPart(''), askedPart(`?part=${'A'.repeat(200)}`).length])
      .toEqual([PART.record.mpn, 'LM358DR', '', 'TPS54331 DR', '', '', 80]);
  });

  it('a count is said with its noun in one place', () => {
    expect([count(0, 'part'), count(1, 'part'), count(2, 'part'), count(1, 'net class', 'net classes'), count(3, 'net class', 'net classes'), noun(1, 'page'), noun(4, 'page')])
      .toEqual(['0 parts', '1 part', '2 parts', '1 net class', '3 net classes', 'page', 'pages']);
  });
});
