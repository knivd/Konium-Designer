/**
 * The notices of the software built into Konium Designer: each package's name, version, licence
 * and the text of its own licence file, as the build puts them into the app (vite.config.ts) so
 * that every copy of the one HTML file carries them (Help › About › Third-Party Software).
 *
 * Which packages: those whose modules the build actually took in, and the three it packs in by
 * other means (pdf.js and manifold-3d as files, the typeface through the stylesheet).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The package a module's path belongs to ('' for the app's own files): the innermost node_modules folder's. */
export function packageOf(id) {
  const parts = id.replace(/\\/g, '/').split('/node_modules/');
  if (parts.length < 2) return '';
  const m = /^((?:@[^/]+\/)?[^/?#]+)/.exec(parts[parts.length - 1]);
  return m ? m[1] : '';
}

/** Packed in by other means than an import the bundler follows. */
export const ALWAYS = ['pdfjs-dist', 'manifold-3d', '@fontsource/ibm-plex-sans-condensed'];

/**
 * A package without a licence file of its own: where its notice is to be had instead. Clipper
 * states its licence at the head of its source (the Boost Software License, by a link), with the
 * notice of the big-number code it includes.
 */
const WITHOUT_FILE = {
  'clipper-lib': (dir) => {
    const src = readFileSync(join(dir, 'clipper.js'), 'utf8');
    const head = src.slice(0, src.indexOf('(function ()'));
    if (!/Boost Software License/.test(head) || !/Tom Wu/.test(head)) throw new Error('clipper-lib: the notices at the head of its source have changed');
    return `${head.trim()}\n\n${readFileSync(join(HERE, 'licences', 'BSL-1.0.txt'), 'utf8').trim()}\n`;
  },
};

/**
 * A package that ships no licence file and states a standard licence in its package.json: that
 * licence's own text, under the holder its package.json names. Said as such in the notice.
 */
const STANDARD = { MIT: 'MIT.txt', 'Apache-2.0': 'Apache-2.0.txt' };
function standardNotice(name, pkg, licence) {
  const file = STANDARD[licence];
  if (!file) return null;
  const by = typeof pkg.author === 'string' ? pkg.author : (pkg.author && pkg.author.name) || '';
  // (the holder's name as given, without an address in brackets)
  const who = by.replace(/\s*<[^>]*>/g, '').replace(/\s*\([^)]*\)/g, '').trim() || `the authors of ${name}`;
  return `${name} ships no licence file; its package.json states its licence as ${licence}.\n\nCopyright (c) ${who}\n\n${readFileSync(join(HERE, 'licences', file), 'utf8').trim()}\n`;
}

/** One package's notice; an error when it has neither a licence file nor a rule above (a new dependency needs looking at). */
export function noticeFor(root, name) {
  const dir = join(root, 'node_modules', ...name.split('/'));
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const licence = typeof pkg.license === 'string' ? pkg.license : (pkg.license && pkg.license.type) || '';
  const file = readdirSync(dir).filter((f) => /^(licen[sc]e|copying)(\.|-|$)/i.test(f)).sort()[0];
  let text;
  if (file) text = readFileSync(join(dir, file), 'utf8');
  else if (WITHOUT_FILE[name]) text = WITHOUT_FILE[name](dir);
  else text = standardNotice(name, pkg, licence);
  if (!text) throw new Error(`${name}: no licence file found, and ${licence || 'no licence'} is not one whose text is kept here; add a rule to tests/tools/notices.mjs`);
  if (!licence) throw new Error(`${name}: its package.json names no licence`);
  return { name, version: String(pkg.version ?? ''), licence, text: text.replace(/\r\n/g, '\n').trim() };
}

/** The name Konium Designer's own licence goes under in the list (Help › About › Licence shows it; the third-party list leaves it out). */
export const OWN = 'Konium Designer';

/** Built in other than as a package: data written into the source by hand, with the notice it came with. */
export function builtInByHand() {
  return [{ name: 'Hershey Simplex Roman (the stroke font)', version: '', licence: 'Public domain glyphs; MIT (hersheytext)', text: readFileSync(join(HERE, 'licences', 'hershey.txt'), 'utf8').replace(/\r\n/g, '\n').trim() }];
}

/** Konium Designer's own licence: the GNU General Public License as the repository carries it, so that every copy of the one file does too. */
export function ownLicence(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const text = readFileSync(join(root, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim();
  if (!/GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/.test(text)) throw new Error('LICENSE is not the GNU General Public License, version 3');
  return { name: OWN, version: String(pkg.version ?? ''), licence: 'GPL-3.0-or-later', text };
}

/** The notices of a set of packages, by name, with what is built in by hand; Konium Designer's own licence first. */
export function notices(root, names) {
  const packages = [...new Set([...names, ...ALWAYS])].filter((n) => existsSync(join(root, 'node_modules', ...n.split('/'), 'package.json'))).map((n) => noticeFor(root, n));
  return [ownLicence(root), ...[...packages, ...builtInByHand()].sort((a, b) => a.name.localeCompare(b.name))];
}

/** The notices as they go into the page: JSON in a script element that is data, with nothing in it the page could take for markup. */
export const NOTICES_ID = 'third-party-notices';
export function noticesElement(list) {
  // (a "<" as its escape, so no "</script" can end the element early; the two line separators JSON allows raw, likewise)
  const seps = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');
  const json = JSON.stringify(list).replace(/</g, '\\u003c').replace(seps, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  return `<script type="application/json" id="${NOTICES_ID}">${json}</script>`;
}
