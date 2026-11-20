// After the app's build (npm's postbuild): Konium Designer moved into dist/app/ (konium.app/app/),
// its single file's SHA-256 stamped on this version's What's New entry (tests/tools/stamp-sha.mjs),
// and the website written around it (website/site.mjs): its pages, style sheet, fonts, pictures
// and sitemap; the site's worker named for this upload, and the style sheet and pictures asked
// for under addresses that change with their contents. Run again it leaves an app already moved
// where it is.
//   node website/build.mjs [dist]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { notFound, renderSite, sitemap, stampWorker, webpSize } from './site.mjs';

const dist = process.argv[2] ?? 'dist';
const app = join(dist, 'app', 'index.html');
const root = join(dist, 'index.html');

// 1. The app's page into app/ (vite writes it at the top, beside the website's files from public/)
if (existsSync(root) && readFileSync(root, 'utf8').includes('<div id="app">')) {
  mkdirSync(dirname(app), { recursive: true });
  renameSync(root, app);
}
if (!existsSync(app)) throw new Error(`website: no app at ${app}`);

// 2. Its checksum on What's New (public/ and dist/)
execFileSync(process.execPath, ['tests/tools/stamp-sha.mjs', app], { stdio: 'inherit' });

// 3. The website's own files
const copyDir = (from, to, keep = () => true) => {
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(from)) if (statSync(join(from, f)).isFile() && keep(f)) copyFileSync(join(from, f), join(to, f));
};
copyDir('website/img', join(dist, 'assets', 'img'), (f) => /\.(webp|jpg)$/.test(f));
copyFileSync('website/site.css', join(dist, 'assets', 'site.css'));
const fonts = 'node_modules/@fontsource/ibm-plex-sans-condensed';
mkdirSync(join(dist, 'assets', 'fonts'), { recursive: true });
for (const w of [400, 500, 600]) copyFileSync(join(fonts, 'files', `ibm-plex-sans-condensed-latin-${w}-normal.woff2`), join(dist, 'assets', 'fonts', `plex-condensed-${w}.woff2`));
copyFileSync(join(fonts, 'LICENSE'), join(dist, 'assets', 'fonts', 'OFL.txt'));

// 4. The pages
const bytes = readFileSync(app);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [major, minor] = pkg.version.split('.');
const version = `${major}.${String(minor).padStart(3, '0')}`;
const releases = JSON.parse(readFileSync(join(dist, 'whats-new.json'), 'utf8')).releases ?? [];
const size = (path) => { const f = join(dist, path); return existsSync(f) ? webpSize(readFileSync(f)) : null; };
const sha = (b) => createHash('sha256').update(b).digest('hex');
// A file's fingerprint, for its address (?v=…): a changed style sheet or picture is a new address
const ver = (path) => { const f = join(dist, path); return existsSync(f) ? sha(readFileSync(f)).slice(0, 8) : ''; };
const d = { version, sha256: sha(bytes), mb: (bytes.length / 1e6).toFixed(1), releases, size, ver };
const pages = renderSite(d);
for (const [path, html] of [...pages, ['404.html', notFound(d)]]) {
  mkdirSync(dirname(join(dist, path)), { recursive: true });
  writeFileSync(join(dist, path), html);
}
writeFileSync(join(dist, 'sitemap.xml'), sitemap());

// 5. The site's worker, named for this upload: the fingerprint of every file of the website (the
// app's are its own worker's), so an upload that changes any of them is a new worker with a new cache
const files = (dir, under = '') => readdirSync(join(dist, dir)).flatMap((f) => {
  const rel = `${under}${f}`, full = join(dist, dir, f);
  return statSync(full).isDirectory() ? (rel === 'app' ? [] : files(join(dir, f), `${rel}/`)) : (rel === 'sw.js' ? [] : [rel]);
});
const all = createHash('sha256');
for (const f of files('').sort()) all.update(f).update('\0').update(readFileSync(join(dist, f)));
const first = new Set(['index.html', 'features/index.html', 'formats/index.html', 'download/index.html', 'whats-new/index.html', 'faq/index.html', 'support/index.html']);
const more = [...pages.map(([path]) => path).filter((path) => !first.has(path)).map((path) => path.replace(/index\.html$/, '')), `assets/site.css?v=${ver('assets/site.css')}`];
writeFileSync(join(dist, 'sw.js'), stampWorker(readFileSync('public/sw.js', 'utf8'), all.digest('hex').slice(0, 8), more));
console.log(`website: ${pages.length} pages around the app ${version} (${(bytes.length / 1e6).toFixed(1)} MB) in ${dist}/app/`);
