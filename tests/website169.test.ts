import { describe, expect, it } from 'vitest';
// @ts-expect-error: the website's generator is plain JavaScript (website/site.mjs)
import { CONNECTIONS, FAQ, KOFI, OG_IMAGE, PAGES, REDIRECT, TOOLS, TOPICS, notFound, renderSite, sitemap, webpSize } from '../website/site.mjs';
// @ts-expect-error: the guides' text is plain JavaScript too (website/guides.mjs)
import { GUIDES } from '../website/guides.mjs';
import { GUIDE_CHAPTERS } from '../src/help/guide';
import { GUIDE_REFERENCE } from '../src/help/guide/reference';
import indexnow from '../website/indexnow.mjs?raw';
import { TOPICS as APP_TOPICS } from '../src/app/dialogs/Contact';
import { SUPPORT } from '../src/app/dialogs/Support';
import { LAUNCH_DB } from '../src/platform/fs';
import { DOWNLOAD_PAGE, siteBase } from '../src/platform/distribution';
import siteSw from '../public/sw.js?raw';
import appSw from '../public/app/sw.js?raw';
import manifestText from '../public/manifest.webmanifest?raw';
import htaccess from '../public/.htaccess?raw';
import distribution from '../src/platform/distribution.ts?raw';

/**
 * 26.169: konium.app is a website (Home, Features, Formats, Download, What's New, FAQ, Support)
 * and Konium Designer itself is at konium.app/app/. Its guides (guides/) are the pages for what
 * people search for, with Altium Designer in their titles.
 */

// (node:fs as the other tests reach it: the project has no Node types)
const nodeMod = (n: string) => import(/* @vite-ignore */ n) as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const { readdirSync, readFileSync } = await nodeMod('node:fs');
const SHA = 'ab'.repeat(32);
const news = JSON.parse(readFileSync('public/whats-new.json', 'utf8')) as { releases: { version: string; items: { image?: string }[] }[] };
const site = renderSite({ version: '26.169', sha256: SHA, mb: '11.1', releases: news.releases, size: () => ({ w: 1180, h: 760 }) }) as [string, string][];
const page = (p: string) => site.find(([f]) => f === p)![1];
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
type Row = { head?: string[]; table?: string[][] };
type Guide = { slug: string; h1: string; description: string; converter?: boolean; name?: string; tools?: string[]; imports?: string[][]; exports?: string[][]; related: string[] };
/** The User Guide's text without its markup. */
const plain = (s: string) => s.replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/ \(see [^)]*\)/g, '');

describe('the website (26.169)', () => {
  it('has its pages, each with its title, description, canonical address, manifest, style sheet, worker and the trademark line', () => {
    expect(site.map(([f]) => f)).toEqual(PAGES.map((p: { path: string }) => p.path));
    for (const [f, html] of site) {
      const url = `https://konium.app/${f.replace(/index\.html$/, '')}`;
      expect(html, f).toMatch(/^<!doctype html>\n<html lang="en-GB">/);
      expect(html, f).toMatch(/<title>[^<]*Konium Designer[^<]*<\/title>/);
      expect(html, f).toMatch(/<meta name="description" content="[^"]{60,}" \/>/);
      expect(html, f).toContain(`<link rel="canonical" href="${url}" />`);
      expect(html, f).toMatch(/<link rel="manifest" href="(\.\.\/)*manifest\.webmanifest" \/>/);
      expect(html, f).toMatch(/navigator\.serviceWorker\.register\('(\.\.\/)*sw\.js'\)/);
      expect(html, f).toContain('Altium Designer is a trademark of Altium Ltd; Konium Designer is not affiliated with it.');
      expect(html, f).toContain('data-domains="konium.app"');
    }
    // The sitemap: every page at its canonical address, nothing else
    const locs = [...sitemap().matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(site.map(([f]) => `https://konium.app/${f.replace(/index\.html$/, '')}`));
    for (const [f, html] of site) expect(html, f).toContain('<link rel="icon" href="' + '../'.repeat(f.split('/').length - 1) + 'favicon.ico" sizes="48x48" />');
  });

  it("one address for every page: www and plain http sent on to https://konium.app/ (Cloudflare's own protocol header deciding), folders with their slash in one step", () => {
    expect(htaccess).toMatch(/RewriteCond %\{HTTP_HOST\} \^www\\\.\(\.\+\)\$ \[NC\]\n  RewriteRule \^ https:\/\/%1%\{REQUEST_URI\} \[R=301,L\]/);
    expect(htaccess).toMatch(/RewriteCond %\{HTTPS\} !=on\n  RewriteCond %\{HTTP:X-Forwarded-Proto\} !=https\n  RewriteRule \^ https:\/\/%\{HTTP_HOST\}%\{REQUEST_URI\} \[R=301,L\]/);
    expect(htaccess).toMatch(/RewriteCond %\{REQUEST_FILENAME\} -d\n  RewriteCond %\{REQUEST_URI\} !\/\$\n  RewriteRule \^ https:\/\/%\{HTTP_HOST\}%\{REQUEST_URI\}\/ \[R=301,L\]/);
    expect(htaccess).toContain('AddType application/manifest+json .webmanifest');
    expect(htaccess).toMatch(/<FilesMatch "\\\.\(json\|webmanifest\)\$">\n    Header set X-Robots-Tag "noindex"/);
  });

  it('every link goes to a page, a file the site has, or the app', () => {
    const files = new Set(['app/', 'app/index.html', 'assets/site.css', 'assets/fonts/plex-condensed-400.woff2', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'favicon.ico', 'llms.txt', 'api/report',
      ...PAGES.map((p: { path: string }) => p.path.replace(/index\.html$/, '')), ...readdir('website/img').map((f) => `assets/img/${f}`), ...readdir('public/whats-new').map((f) => `whats-new/${f}`)]);
    for (const [f, html] of site) {
      const base = new URL(f, 'https://konium.app/');
      for (const [, ref] of html.matchAll(/(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)) {
        if (/^https?:/.test(ref!) && !ref!.startsWith('https://konium.app/')) continue;
        const path = new URL(ref!, base).pathname.slice(1);
        expect(files.has(path), `${f}: ${ref}`).toBe(true);
      }
      for (const [, ref] of html.matchAll(/fetch\('([^']+)'/g)) expect(files.has(new URL(ref!, base).pathname.slice(1)), `${f}: ${ref}`).toBe(true);
    }
  });

  it('is written plainly: no dashes for punctuation, none of the stock phrases, no earlier names', () => {
    for (const [f, html] of site) {
      const t = text(html);
      expect(t, f).not.toMatch(/[–—]/);
      // (What's New is the app's own log: Unlock there is a command)
      if (f !== 'whats-new/index.html') expect(t, f).not.toMatch(/\bseamless|\bpowerful|\brobust|\beffortless|\bunlock|\belevate|\bleverage|cutting-edge|game.chang|whether you're|dive (in|into)|empower|streamline|supercharge|next-level|not just\b/i);
      for (const old of ['v', 'l'].map((c) => 'konium'.replace('k', 'j').replace('n', c))) expect(html.toLowerCase(), f).not.toContain(old);
    }
  });

  it('home: the app at app/ for an installed app or a link made for the app, its first script; the app\'s description and the program at the top', () => {
    const home = page('index.html');
    expect(home.indexOf(REDIRECT)).toBeGreaterThan(0);
    expect(home.indexOf(REDIRECT)).toBeLessThan(home.indexOf('<title>'));
    expect(REDIRECT).toContain("location.replace('app/' + location.search + location.hash)");
    expect(REDIRECT).toMatch(/display-mode: /);
    expect(REDIRECT).toContain(`indexedDB.open('${LAUNCH_DB}', 1)`);
    for (const [f, html] of site) if (f !== 'index.html') expect(html, f).not.toContain('location.replace');
    expect(home).toContain('"@type":"SoftwareApplication"');
    expect(text(home)).toMatch(/It runs on your computer/);
    expect(home).toContain('href="app/"');
  });

  it('download: the single file under its version\'s name with its checksum, and the commands that check it', () => {
    const d = page('download/index.html');
    expect(d).toContain('href="../app/index.html" download="Konium-26.169.html"');
    expect(d).toContain(`<code class="hash">${SHA}</code>`);
    for (const c of ['Get-FileHash Konium-26.169.html', 'shasum -a 256 Konium-26.169.html', 'sha256sum Konium-26.169.html']) expect(d).toContain(c);
    expect(DOWNLOAD_PAGE).toBe('https://konium.app/download/');
  });

  it("What's New: every public release with its items, pictures and checksums", () => {
    const w = page('whats-new/index.html');
    for (const r of news.releases) expect(w).toContain(`id="v${r.version}"`);
    const pics = news.releases.flatMap((r) => r.items.filter((i) => i.image).map((i) => i.image!));
    for (const p of pics) expect(w).toContain(`src="../${p}"`);
    expect((w.match(/<li><p>/g) ?? []).length).toBe(news.releases.reduce((n, r) => n + r.items.length, 0));
  });

  it('the FAQ lists every connection the User Guide does; the contact form asks what the app\'s does; Ko-fi as the app has it', () => {
    const net = GUIDE_REFERENCE.sections.find((s) => s.id === 'ref-network')!;
    const rows = (net.blocks as Row[]).find((b) => b.table)!.table!;
    expect(CONNECTIONS.map((c: string[]) => c[0])).toEqual(rows.map((r) => r[0]));
    for (const [i, r] of rows.entries()) expect(CONNECTIONS[i]).toEqual(r.map(plain));
    expect(FAQ.some((f: { id: string }) => f.id === 'online')).toBe(true);
    expect(TOPICS).toEqual([...APP_TOPICS]);
    expect(KOFI).toBe(SUPPORT.url);
    const s = page('support/index.html');
    expect(s).toContain("data.append('kind', 'contact')");
    expect(s).toContain('name="website"');
  });

  it('reads a WebP picture\'s size from its header', () => {
    expect(webpSize(readFileSync('website/img/pcb-editor.webp'))).toEqual({ w: 1920, h: 1147 });
    expect(webpSize(readFileSync('public/whats-new/26.168-document-windows.webp'))).toEqual({ w: 1180, h: 505 });
    expect(webpSize((globalThis as any).Buffer.from('not a picture at all, not at all'))).toBeNull(); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});

describe('the guides: the pages for what people search for (26.169)', () => {
  const guides = GUIDES as Guide[];
  const guide = (g: Guide) => page(`guides/${g.slug}/index.html`);

  it('eleven guides and their index: each with Altium in its title, one heading, its address in its structured data; reached from the footer, the header as it was', () => {
    expect(guides.length).toBe(11);
    for (const [f, html] of site) {
      const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
      expect([...nav.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]), f).toEqual(['Features', 'Formats', 'Install', "What's New", 'FAQ', 'Support']);
      expect(html, f).toMatch(/<footer[\s\S]*<a href="(\.\.\/)*guides\/">Guides<\/a>[\s\S]*<\/footer>/);
    }
    const hub = page('guides/index.html');
    expect(hub).toMatch(/<title>[^<]*Altium Designer[^<]*Konium Designer<\/title>/);
    for (const g of guides) {
      const html = guide(g);
      expect((html.match(/<h1>/g) ?? []).length, g.slug).toBe(1);
      expect(text(html), g.slug).toContain(g.h1);
      expect(html, g.slug).toMatch(/<title>[^<]*Altium[^<]*: Konium Designer<\/title>/);
      expect(g.description.length, g.slug).toBeGreaterThanOrEqual(120);
      expect(g.description.length, g.slug).toBeLessThanOrEqual(165);
      expect(hub, g.slug).toContain(`<a href="${g.slug}/">`);
      expect(html, g.slug).toContain('<a class="btn primary install" href="../../app/?install">Install Konium Designer</a>');
      expect(html, g.slug).toContain('<a href="../">Guides</a>');
      const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!) as { '@type': string; itemListElement?: { item: string }[]; headline?: string }[];
      expect(ld.map((x) => x['@type'])).toEqual(['BreadcrumbList', 'TechArticle']);
      expect(ld[0]!.itemListElement!.at(-1)!.item).toBe(`https://konium.app/guides/${g.slug}/`);
      expect(ld[1]!.headline).toBe(g.h1);
      expect(g.related.length).toBe(3);
      for (const r of g.related) expect(guides.some((x) => x.slug === r && x !== g), `${g.slug}: ${r}`).toBe(true);
    }
  });

  it("the converter pages say of each tool what the User Guide's tables say: the wizards' types, what comes in and its files, what is written; and what the Formats table says comes back", () => {
    const files = GUIDE_REFERENCE.sections.find((s) => s.id === 'ref-files')!;
    const table = (first: string) => (files.blocks as Row[]).find((b) => b.head?.[0] === first)!.table!;
    const imports = table('Import Wizard type'), exports = table('Export Wizard type');
    const conv = guides.filter((g) => g.converter);
    expect(conv.map((g) => g.name)).toEqual(['KiCad', 'EAGLE', 'EasyEDA', 'OrCAD and Allegro', 'PADS', 'DipTrace']);
    for (const g of conv) {
      const t = text(guide(g)).replace(/&quot;/g, '"');
      for (const [type, what, ext] of g.imports!) {
        const row = imports.find((r) => r[0] === type);
        expect(row, `${g.slug}: ${type}`).toBeDefined();
        expect([plain(row![2]!), row![1]]).toEqual([what, ext]);
        expect(t).toContain(`${what} The files: ${ext}.`);
      }
      for (const [type, what] of g.exports!) {
        const row = exports.find((r) => r[0] === type);
        expect(row, `${g.slug}: ${type}`).toBeDefined();
        expect(plain(row![1]!)).toBe(what);
        expect(t).toContain(what);
      }
      for (const tool of g.tools!) {
        const row = (TOOLS as string[][]).find((r) => r[0] === tool);
        expect(row, `${g.slug}: ${tool}`).toBeDefined();
        expect(t).toContain(row![3]);
      }
      expect(t).toContain('File › Import Wizard');
      expect(t).toContain('File › Export Wizard');
    }
  });

  it('the opening pages name commands, keys and reports the User Guide has', () => {
    const book = JSON.stringify(GUIDE_CHAPTERS);
    const named: Record<string, string[]> = {
      'open-pcbdoc': ['File › Open...', 'Single Layer Mode', '3D Layout Mode', 'Ctrl+M', 'Tools › Cross Probe', 'File Format Change Report'],
      'open-schdoc': ['File › Open...', 'Reports › Bill of Materials', 'Tools › Cross Probe', 'File › Export Wizard', 'Messages panel'],
      'altium-viewer': ['File › Open Project...', 'Projects panel', 'Single Layer Mode', '3D Layout Mode', 'Ctrl+M', 'Tools › Cross Probe', 'Reports › Bill of Materials'],
      'altium-on-mac-and-linux': ['File › Open Project...'],
    };
    for (const [slug, names] of Object.entries(named)) {
      const t = text(page(`guides/${slug}/index.html`));
      for (const n of names) { expect(t, `${slug}: ${n}`).toContain(n); expect(book, n).toContain(n); }
    }
    expect(book).toContain('Measure Distance');
    // Not made by Altium, said where it is set beside it
    expect(text(page('guides/altium-alternative/index.html'))).toMatch(/independent, and not made by Altium/);
  });

  it('llms.txt lists every guide at its address, under its heading', () => {
    const llms = readFileSync('public/llms.txt', 'utf8') as string;
    for (const g of guides) expect(llms, g.slug).toMatch(new RegExp(`^- [^\\n]*: https://konium\\.app/guides/${g.slug}/$`, 'm'));
    expect((llms.match(/https:\/\/konium\.app\/guides\//g) ?? []).length).toBe(guides.length);
  });

  it("IndexNow: the key file at the site's root holds the key the script sends", () => {
    const key = indexnow.match(/const KEY = '([0-9a-f]{32})';/)![1]!;
    expect(readFileSync(`public/${key}.txt`, 'utf8')).toBe(key);
    expect(indexnow).toContain("fetch('https://api.indexnow.org/indexnow'");
    expect(indexnow).toContain('`${ORIGIN}sitemap.xml`');
  });
});

describe('the website, after its review (26.169)', () => {
  const data = { version: '26.169', sha256: SHA, mb: '11.1', releases: news.releases, size: () => ({ w: 1180, h: 760 }) };

  it('a browser tab in fullscreen is not an installed app: the home page tells one as the app does', () => {
    const modes = "['standalone', 'window-controls-overlay', 'minimal-ui']";
    expect(REDIRECT).toContain(`${modes}.some(`);
    expect(distribution).toContain(`${modes}.some(`);
    expect(REDIRECT).not.toContain("'fullscreen'");
  });

  it('the style sheet and the pictures are asked for by addresses that change with their contents; without a build, plain ones', () => {
    for (const [f, html] of site) { expect(html, f).not.toContain('?v='); expect(html, f).toMatch(/assets\/site\.css" \/>/); }
    const ver = (path: string) => (path.endsWith('.css') ? 'c0ffee00' : 'abcd1234');
    const built = renderSite({ ...data, ver }) as [string, string][];
    for (const [f, html] of built) {
      expect(html, f).toMatch(/<link rel="stylesheet" href="(\.\.\/)*assets\/site\.css\?v=c0ffee00" \/>/);
      for (const [, src] of html.matchAll(/<img src="([^"]+)"/g)) expect(src, f).toMatch(/\.webp\?v=abcd1234$/);
    }
    // (rendered again without one: as before)
    expect((renderSite(data) as [string, string][])[0]![1]).not.toContain('?v=');
  });

  it("each page's first picture is fetched at once, the others when they come near", () => {
    const home = page('index.html'), imgs = [...home.matchAll(/<img [^>]+>/g)].map((m) => m[0]);
    expect(imgs.length).toBe(3);
    expect(imgs[0]).toContain('fetchpriority="high"');
    expect(imgs[0]).not.toContain('loading="lazy"');
    for (const i of imgs.slice(1)) expect(i).toContain('loading="lazy"');
    const feat = [...page('features/index.html').matchAll(/<img [^>]+>/g)].map((m) => m[0]);
    expect(feat.filter((i) => i.includes('fetchpriority="high"')).length).toBe(1);
    expect(feat[0]).toContain('fetchpriority="high"');
  });

  it('a link shared elsewhere shows a JPEG of the size previews use, with its size given', () => {
    const jpg = readFileSync(`website/img/${OG_IMAGE.path.split('/').pop()}`) as { length: number; readUInt16BE(o: number): number; [i: number]: number };
    // Its size from its frame header (SOF0 or SOF2)
    let at = 2, size: number[] = [];
    while (at < jpg.length) {
      const marker = jpg[at + 1]!, len = jpg.readUInt16BE(at + 2);
      if (marker === 0xc0 || marker === 0xc2) { size = [jpg.readUInt16BE(at + 7), jpg.readUInt16BE(at + 5)]; break; }
      at += 2 + len;
    }
    expect([jpg[0], jpg[1]]).toEqual([0xff, 0xd8]);
    expect(size).toEqual([OG_IMAGE.w, OG_IMAGE.h]);
    expect([OG_IMAGE.w, OG_IMAGE.h]).toEqual([1200, 630]);
    for (const [f, html] of site) {
      expect(html, f).toContain('<meta property="og:image" content="https://konium.app/assets/img/og.jpg" />');
      expect(html, f).toContain('<meta property="og:image:width" content="1200" />');
      expect(html, f).toContain('<meta property="og:image:height" content="630" />');
      expect(html, f).toMatch(/<meta property="og:image:alt" content="[^"]{10,}" \/>/);
    }
  });

  it('llms.txt is written as the pages are: no dashes for punctuation; the logo link has a name where its words are hidden; column headings say so', () => {
    expect(readFileSync('public/llms.txt', 'utf8') as string).not.toMatch(/[–—]/);
    for (const [f, html] of site) {
      expect(html, f).toMatch(/<a class="brand" href="[^"]+" aria-label="Konium Designer, home">/);
      expect(html, f).not.toContain('<th>');
    }
  });

  it("an address the site doesn't have: the website's own page, linked from the site's root, kept from search engines", () => {
    const html = notFound(data) as string;
    expect(htaccess).toContain('ErrorDocument 404 /404.html');
    expect(html).toContain('<title>Page not found: Konium Designer</title>');
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('og:url');
    expect((html.match(/<h1>/g) ?? []).length).toBe(1);
    // Shown at any address: nothing in it is relative
    for (const [, ref] of html.matchAll(/(?:href|src)="([^"]+)"/g)) expect(ref, ref).toMatch(/^(\/|https:\/\/)/);
    expect(html).toContain("navigator.serviceWorker.register('/sw.js')");
    for (const p of ['/', '/app/', '/features/', '/formats/', '/download/', '/whats-new/', '/faq/', '/support/', '/guides/']) expect(html, p).toContain(`href="${p}"`);
    expect(html).toContain('Altium Designer is a trademark of Altium Ltd; Konium Designer is not affiliated with it.');
    expect(text(html)).not.toMatch(/[–—]/);
    // Not one of the pages: not in the sitemap
    expect(sitemap()).not.toContain('404');
    expect(site.some(([f]) => f.includes('404'))).toBe(false);
  });
});

describe('the app at app/ (26.169)', () => {
  it('reads the version number, What\'s New and the manifest from the website\'s folder', () => {
    expect(siteBase('https://konium.app/app/')).toBe('https://konium.app/');
    expect(siteBase('https://konium.app/app/index.html?debug')).toBe('https://konium.app/');
    expect(siteBase('http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(siteBase('https://example.org/tools/konium/')).toBe('https://example.org/tools/konium/');
  });

  it('one install, as before: the manifest where it was, the same id, the app at app/', () => {
    const m = JSON.parse(manifestText) as { id: string; start_url: string; scope: string; file_handlers: { action: string }[] };
    // The id an install before 26.169 has: its start_url ./ at konium.app/manifest.webmanifest, konium.app/
    expect(new URL(m.id, new URL(m.start_url, 'https://konium.app/manifest.webmanifest')).href).toBe('https://konium.app/');
    expect([m.start_url, m.scope, m.file_handlers[0]!.action]).toEqual(['app/', 'app/', 'app/']);
  });

  it('two workers, each with its own caches: the website\'s moves the app\'s earlier ones out of the way, and keeps a copy kept on its version', () => {
    expect(appSw).toMatch(/const CACHE = 'konium-app-v26\.\d{3}';/);
    expect(siteSw).toMatch(/const CACHE = 'konium-site-v26\.\d{3}';/);
    expect(appSw).not.toMatch(/k !== CACHE && k !== FLAGS/);
    expect(siteSw).toMatch(/k\.startsWith\('konium-site-'\) && k !== CACHE\) \|\| \/\^konium-v\\d\/\.test\(k\)/);
    expect(siteSw).toMatch(/if \(page && await pinned\(\)\) await c\.put\(KEPT, page\);/);
    expect(siteSw).toMatch(/if \(home && await pinned\(\)\) \{ const hit = await caches\.match\(KEPT\); if \(hit\) return hit; \}/);
    for (const sw of [siteSw, appSw]) {
      expect(sw).toMatch(/pathname\.startsWith\('\/api\/'\)\) return;/);
      expect(sw).toMatch(/pathname\.endsWith\('\/version\.json'\)\) return;/);
    }
  });
});

const readdir = (dir: string): string[] => readdirSync(dir);
