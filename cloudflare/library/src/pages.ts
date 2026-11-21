/**
 * The world parts library's public pages (R21, step 5): one for each part, at
 * konium.app/parts/<its key>, a list of the latest, and a sitemap. A page says what the library's
 * files say (the part's record and the library's note): what the part is, its pins, where it
 * stands and who has said what of it, who published it, and how to get it. It is there so that
 * a part can be found from outside the program, and so that anyone can see what a part is before
 * they use it.
 *
 * Everything on a page is somebody else's words: each value is written as text, never as
 * markup; a datasheet's link is one only where it is a web address; there is no script on a
 * page at all, and its policy lets none run. Nothing here reads a library file (no drawing of
 * the symbol or the footprint is made). A company's own parts have no pages: they are not here.
 */
import type { PartRecord } from '../../../src/model/partPackage';
import { count, noun } from '../../../src/core/words';
import {
  CHECKS_TO_CONFIRM, LICENCE_NAME, LICENCE_URL, PROBLEMS_TO_DISPUTE, STATUS_NAMES, standingText, type LibraryEntry, type LibraryWord,
} from '../../../src/model/worldLibrary';

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** The day of a time as the sitemap writes it (2026-11-20), and as a page says it (20 Nov 2026); '' for what is no date. */
const isoDay = (iso: string): string => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return m && +m[2]! >= 1 && +m[2]! <= 12 && +m[3]! >= 1 && +m[3]! <= 31 ? m[0] : ''; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string): string => { const d = isoDay(iso); return d ? `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}` : ''; };
/** A pin's kind in words (a record's own word where it is none of these). */
const KINDS: Record<string, string> = { input: 'input', output: 'output', io: 'input and output', passive: 'passive', power: 'power', ground: 'ground', oc: 'open collector or drain', oe: 'open emitter', hiz: 'three-state', nc: 'not connected' };
/** A web address and nothing else ('' otherwise): what a page may link to. */
export const webAddress = (s: string): string => { try { const u = new URL(s); return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
const who = (w: { name: string; by: string }): string => esc(w.name || w.by || 'someone unnamed');
const FROM: Record<string, string> = { datasheet: 'its pads from the datasheet\'s land pattern', ipc: 'its pads worked out by IPC-7351B', drawn: 'its pads drawn by hand' };
const STANDS: Record<LibraryEntry['status'], string> = {
  unverified: `As its author published it. ${CHECKS_TO_CONFIRM} people other than its author have yet to compare it with the datasheet and find it right: check it yourself before you build with it.`,
  confirmed: `${CHECKS_TO_CONFIRM} people other than its author have compared it with its datasheet and found it right.`,
  proven: `Found right by ${CHECKS_TO_CONFIRM} people other than its author, and built on a board that works.`,
};

const STYLE = `:root{--bg:#f6f7f5;--panel:#fff;--line:#d9dfdb;--text:#1b2622;--dim:#5b6a64;--link:#186553;--gold:#d2b04c;--warn:#a86400;--ok:#2e7d32}
@media(prefers-color-scheme:dark){:root{--bg:#0f1a17;--panel:#13201d;--line:#27413a;--text:#e6eae3;--dim:#9aa59e;--link:#8fd3bd;--warn:#e0a43a;--ok:#6cc08b}}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}
a{color:var(--link)}header,main,footer{max-width:860px;margin:0 auto;padding:0 20px}header{padding-top:18px;font-size:14px;color:var(--dim)}
h1{margin:18px 0 6px;font-size:34px;line-height:1.15;overflow-wrap:anywhere}h2{margin:30px 0 8px;font-size:19px}p{margin:0 0 12px}
.lead{font-size:18px;color:var(--dim)}.chip{display:inline-block;vertical-align:middle;margin-left:8px;padding:2px 12px;border:1px solid var(--line);border-radius:999px;font-size:13px;font-weight:700;color:var(--dim)}
.chip.confirmed{color:var(--link);border-color:var(--link)}.chip.proven{color:var(--ok);border-color:var(--ok)}
.btn{display:inline-block;margin:6px 14px 6px 0;padding:10px 18px;border-radius:8px;background:var(--gold);color:#13201d;font-weight:700;text-decoration:none}
dl{display:grid;grid-template-columns:120px minmax(0,1fr);gap:6px 16px;margin:0}dt{color:var(--dim)}dd{margin:0;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px}th,td{padding:6px 12px;text-align:left;border-top:1px solid var(--line)}
tr:first-child th{border-top:0;font-size:13px;color:var(--dim)}td:first-child{width:90px;font-variant-numeric:tabular-nums}td:last-child{color:var(--dim)}
ul{margin:0 0 12px;padding-left:20px}li.wrong{color:var(--warn)}small{color:var(--dim)}
footer{margin-top:40px;padding-top:16px;padding-bottom:40px;border-top:1px solid var(--line);font-size:14px;color:var(--dim)}`;

function shell(o: { title: string; description: string; canonical: string; body: string; site: string; index?: boolean }): string {
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(o.canonical)}">
<meta property="og:title" content="${esc(o.title)}"><meta property="og:description" content="${esc(o.description)}"><meta property="og:url" content="${esc(o.canonical)}"><meta property="og:type" content="website">
${o.index === false ? '<meta name="robots" content="noindex">\n' : ''}<style>${STYLE}</style></head>
<body>
<header><a href="${esc(o.site)}/">Konium Designer</a> &rsaquo; <a href="${esc(o.site)}/parts/">World parts library</a></header>
<main>
${o.body}
</main>
<footer><p>The parts in this library are made and checked by the people who use Konium Designer, and are given to the public domain (<a href="${LICENCE_URL}" rel="license">${esc(LICENCE_NAME)}</a>). A part is its contributor's work, checked as its page says: compare it with the datasheet before you build with it.</p>
<p><a href="${esc(o.site)}/">Konium Designer</a> is free schematic and PCB design that runs in your browser.</p></footer>
</body></html>
`;
}

const said = (label: string, list: LibraryWord[] | undefined, cls = ''): string =>
  (list ?? []).map((w) => `<li${cls ? ` class="${cls}"` : ''}>${w.note ? `${esc(w.note)} <small>(${who(w)}${day(w.at) ? `, ${day(w.at)}` : ''})</small>` : `${label} ${who(w)}${day(w.at) ? ` <small>${day(w.at)}</small>` : ''}`}</li>`).join('\n');

/** A part's page. `record` is null where the part's own file could not be read: the page then says what the library's note says. */
export function partPage(o: { entry: LibraryEntry; record: PartRecord | null; site: string; files: string }): string {
  const e = o.entry, r = o.record, url = `${o.site}/parts/${e.key}`;
  const sheet = r ? webAddress(r.datasheet.url) : '';
  const pages = (list: number[]) => (list.length ? ` (${noun(list.length, 'page')} ${list.slice(0, 12).join(', ')})` : '');
  const wrong = e.problems?.length ?? 0;
  const about = r ? [r.maker, r.description || r.device].filter(Boolean).join(': ') : '';
  const body = `<h1>${esc(e.mpn)}<span class="chip ${e.status}">${esc(STATUS_NAMES[e.status])}</span></h1>
${about ? `<p class="lead">${esc(about)}</p>\n` : ''}<p>A schematic symbol and a PCB footprint with its 3D body, free to use for anything.</p>
<p><a class="btn" href="${esc(o.site)}/app/?part=${encodeURIComponent(e.mpn)}">Open in Konium Designer</a><a href="${esc(o.files)}" rel="nofollow">Its files in the library's repository</a></p>
${r ? `<h2>What it is</h2>
<dl>
<dt>Maker</dt><dd>${esc(r.maker || 'not said')}</dd>
<dt>Package</dt><dd>${esc(r.package.name)}, ${esc(count(r.package.pins, 'pin'))}</dd>
<dt>Footprint</dt><dd>${esc(r.package.footprint)}, ${esc(FROM[r.package.from] ?? FROM.drawn)}</dd>
<dt>Symbol</dt><dd>${esc(r.symbol)}, ${esc(count(r.pins.length, 'pin'))}</dd>
<dt>Datasheet</dt><dd>${sheet ? `<a href="${esc(sheet)}" rel="nofollow noopener noreferrer ugc">${esc(r.datasheet.title || sheet)}</a>` : r.datasheet.sha256 ? 'A file its author had: not linked' : 'None named'}${r.datasheet.pinPages.length || r.datasheet.packagePages.length ? `<br><small>Read for the pins${esc(pages(r.datasheet.pinPages))} and the package${esc(pages(r.datasheet.packagePages))}</small>` : ''}</dd>
</dl>
<h2>Pins</h2>
<table><tr><th>Pin</th><th>Name</th><th>Kind</th></tr>
${r.pins.slice(0, 2000).map((p) => `<tr><td>${esc(p.number)}</td><td>${esc(p.name || '(unnamed)')}</td><td>${esc(KINDS[p.type] ?? (p.type || 'passive'))}</td></tr>`).join('\n')}
</table>
` : '<p>The part\'s own file could not be read just now: what follows is the library\'s note about it.</p>\n'}<h2>Where it stands</h2>
<p><strong>${esc(STATUS_NAMES[e.status])}</strong> (${esc(standingText(e))}). ${esc(wrong >= PROBLEMS_TO_DISPUTE && e.status === 'unverified' ? 'People have found it wrong: it is for its author to publish it again, put right.' : STANDS[e.status])}</p>
${e.checked?.length || e.built?.length || wrong ? `<ul>\n${[said('Found right by', e.checked), said('Built on a board that works by', e.built), said('', e.problems, 'wrong')].filter(Boolean).join('\n')}\n</ul>\n` : ''}<h2>Who and when</h2>
<p>Published by ${who(e)}${e.name && e.by ? ` <small>(${esc(e.by)})</small>` : ''}${day(e.published) ? ` on ${day(e.published)}` : ''}, revision ${esc(e.revision)}${e.app ? `, from Konium Designer ${esc(e.app)}` : ''}. Given to the public domain (<a href="${LICENCE_URL}" rel="license">${esc(LICENCE_NAME)}</a>): anyone may use it, change it and pass it on, for any purpose.</p>`;
  const stands = STATUS_NAMES[e.status];
  return shell({
    title: `${e.mpn}: symbol and footprint (Konium parts library)`,
    description: `${e.mpn}${r?.maker ? ` by ${r.maker}` : ''}${r ? `: ${r.package.name}, ${count(r.package.pins, 'pin')}` : ''}. A schematic symbol and a PCB footprint with its 3D body, free to use (${LICENCE_NAME}), from the world parts library of Konium Designer. ${stands}.`,
    canonical: url, body, site: o.site,
  });
}

/** The list: how many parts there are and the latest of them. */
export function partsIndex(o: { parts: { key: string; mpn: string; status: string; name: string; by: string; published: string }[]; count: number; site: string }): string {
  const body = `<h1>World parts library</h1>
<p class="lead">${esc(count(o.count, 'part'))}, each a schematic symbol and a PCB footprint with its 3D body, made and checked by the people who use Konium Designer and free to use for anything.</p>
<p>Type a part number in Konium Designer (Tools &rsaquo; Parts) and it is fetched from here; a part that is not here yet is made from its datasheet and can be published for everyone.</p>
<p><a class="btn" href="${esc(o.site)}/app/">Open Konium Designer</a></p>
<h2>The latest</h2>
${o.parts.length ? `<table><tr><th>Part</th><th>Published</th><th>Stands</th></tr>
${o.parts.map((p) => `<tr><td><a href="${esc(o.site)}/parts/${esc(p.key)}">${esc(p.mpn)}</a></td><td>${day(p.published)} by ${who(p)}</td><td>${esc(STATUS_NAMES[p.status as LibraryEntry['status']] ?? STATUS_NAMES.unverified)}</td></tr>`).join('\n')}
</table>` : '<p>None yet.</p>'}`;
  return shell({ title: 'World parts library: symbols and footprints (Konium Designer)', description: `${o.count} free schematic symbols and PCB footprints with 3D bodies, made and checked by the people who use Konium Designer. Given to the public domain.`, canonical: `${o.site}/parts/`, body, site: o.site });
}

/** No such part (or the library is not open): said plainly, and not for a search engine to keep. */
export function partMissing(o: { title: string; text: string; site: string }): string {
  return shell({ title: `${o.title} (Konium parts library)`, description: o.text, canonical: `${o.site}/parts/`, index: false, site: o.site,
    body: `<h1>${esc(o.title)}</h1>\n<p class="lead">${esc(o.text)}</p>\n<p><a class="btn" href="${esc(o.site)}/app/">Open Konium Designer</a><a href="${esc(o.site)}/parts/">The library's latest parts</a></p>` });
}

/** The sitemap of the parts' pages. */
export function partsSitemap(keys: { key: string; published: string }[], site: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${esc(site)}/parts/</loc></url>\n${keys.map((k) => `<url><loc>${esc(site)}/parts/${esc(k.key)}</loc>${isoDay(k.published) ? `<lastmod>${isoDay(k.published)}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`;
}

/** What a page is sent with: text only, no script, in no frame, kept a few minutes by whoever fetched it. */
export const PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
