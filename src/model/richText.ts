/**
 * A requirement's rich text: a small, safe subset of HTML (paragraphs, bold, italic, underline,
 * strike, sub- and superscript, headings, lists, tables, links, quotes, code and pictures), kept
 * with the requirement beside its plain text (for search, checks, the AI, Excel and CSV). Whatever
 * is pasted (from Word, a web page) is cut down to that subset: other tags dropped (their text
 * kept), scripts and styles dropped whole, links only to web and mail addresses, pictures only the
 * requirement's own (kfile:) or pasted ones (data: PNG, JPEG, GIF, WebP, BMP). No DOM needed.
 * Its plain text keeps tables as Markdown rows (| a | b |) and lists as "- " and "1. ", so plain
 * text with those turns back into tables and lists.
 */

/** A file kept with a requirement: a picture in its text (inline) or an attachment. */
export interface ReqFile { id: string; name: string; type: string; data: string; inline?: boolean }
export const FILE_REF = 'kfile:';

const BLOCK = new Set(['p', 'h3', 'h4', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'pre']);
const INLINE = new Set(['b', 'i', 'u', 's', 'sub', 'sup', 'code', 'a']);
const VOID = new Set(['br', 'img']);
const RENAME: Record<string, string> = { strong: 'b', em: 'i', strike: 's', del: 's', ins: 'u', h1: 'h3', h2: 'h3', h5: 'h4', h6: 'h4', div: 'p', tt: 'code', kbd: 'code', dir: 'ul', menu: 'ul', caption: 'p', tfoot: 'tbody' };
/** Blocks a paragraph can't hold: one opening closes the paragraph (or heading) open. */
const BREAKS_P = new Set(['p', 'h3', 'h4', 'ul', 'ol', 'table', 'blockquote', 'pre']);
const PICTURE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$/i;

const attrsOf = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([a-zA-Z_:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) out[m[1]!.toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
};
const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '–', mdash: '—', hellip: '…', deg: '°', plusmn: '±', micro: 'µ', times: '×', middot: '·', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', copy: '©', reg: '®', trade: '™', le: '≤', ge: '≥', ne: '≠', ohm: 'Ω', Omega: 'Ω', mu: 'μ', pound: '£', euro: '€' };
export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}
const escText = (s: string) => decode(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Pasted or stored HTML cut down to the subset kept. */
export function sanitiseHtml(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[[\s\S]*?\]>/g, '').replace(/<!doctype[^>]*>/gi, '');
  s = s.replace(/<(script|style|head|title|xml|template|noscript|iframe|object|embed|svg|math|select|textarea|button)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<(script|style|iframe|object|embed|link|meta|base|input)\b[^>]*>/gi, '');
  const body = /<body\b[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(s);
  if (body) s = body[1]!;
  const out: string[] = [];
  const stack: string[] = [];
  const closeTo = (i: number) => { while (i >= 0 && stack.length > i) out.push(`</${stack.pop()}>`); };
  const close = (until: (t: string) => boolean) => { let i = stack.length - 1; while (i >= 0 && !until(stack[i]!)) i--; closeTo(i); };
  const inTag = (t: string) => stack.includes(t);
  const last = (...ts: string[]) => Math.max(...ts.map((x) => stack.lastIndexOf(x)));
  for (const m of s.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+|<)/g)) {
    if (m[4] !== undefined) { if (!stack.length && m[4].trim()) { out.push('<p>'); stack.push('p'); } out.push(escText(m[4])); continue; }
    const end = m[1] === '/';
    let t = m[2]!.toLowerCase();
    t = RENAME[t] ?? t;
    if (!BLOCK.has(t) && !INLINE.has(t) && !VOID.has(t)) continue;
    if (end) {
      if (VOID.has(t)) continue;
      if (t === 'p' || t === 'h3' || t === 'h4') { close((x) => x === t); continue; }
      close((x) => x === t);
      continue;
    }
    const a = attrsOf(m[3] ?? '');
    // Text, inline tags and pictures outside any block: in a paragraph
    if (!stack.length && !BLOCK.has(t)) { out.push('<p>'); stack.push('p'); }
    if (t === 'br') { out.push('<br>'); continue; }
    if (t === 'img') {
      const src = (a.src ?? '').trim();
      if (!(src.startsWith(FILE_REF) && /^kfile:[\w-]{1,40}$/.test(src)) && !PICTURE.test(src)) { if (a.alt) out.push(escText(`[${a.alt}]`)); continue; }
      const w = Number(a.width);
      out.push(`<img src="${attr(src.replace(/\s+/g, ''))}"${a.alt ? ` alt="${attr(a.alt)}"` : ''}${Number.isFinite(w) && w >= 16 && w <= 4000 ? ` width="${Math.round(w)}"` : ''}>`);
      continue;
    }
    if (BREAKS_P.has(t)) close((x) => x === 'p' || x === 'h3' || x === 'h4');
    // A list item closes the one open in its own list; a row the row open in its table; a cell the cell open in its row
    if (t === 'li') { const li = last('li'), list = last('ul', 'ol'); if (li > list) closeTo(li); if (list < 0) { out.push('<ul>'); stack.push('ul'); } }
    if (t === 'tr') { if (!inTag('table')) continue; const tr = last('tr'); if (tr > last('table')) closeTo(tr); }
    if (t === 'td' || t === 'th') { if (!inTag('table')) continue; const td = last('td', 'th'); if (td > last('tr', 'table')) closeTo(td); if (last('tr') < last('table')) { out.push('<tr>'); stack.push('tr'); } }
    if ((t === 'thead' || t === 'tbody') && !inTag('table')) continue;
    if (t === 'a') {
      const href = (a.href ?? '').trim();
      if (!/^(https?:\/\/|mailto:)/i.test(href)) continue;
      out.push(`<a href="${attr(href)}">`); stack.push('a'); continue;
    }
    let extra = '';
    if (t === 'td' || t === 'th') for (const k of ['colspan', 'rowspan']) { const n = Number(a[k]); if (Number.isInteger(n) && n > 1 && n <= 50) extra += ` ${k}="${n}"`; }
    out.push(`<${t}${extra}>`); stack.push(t);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  // Empty paragraphs and inline tags dropped; runs of blank paragraphs kept to one
  return out.join('').replace(/<(b|i|u|s|sub|sup|code|a)(?: [^>]*)?><\/\1>/g, '').replace(/<p>(\s|&nbsp;|\u00a0|<br>)*<\/p>/g, '<p></p>').replace(/(<p><\/p>){2,}/g, '<p></p>').replace(/^(<p><\/p>)+|(<p><\/p>)+$/g, '').trim();
}

/** Whether HTML holds more than paragraphs and line breaks (if not, its plain text says it all). */
export const isRich = (html: string): boolean => /<(?!\/?(p|br)\b)[a-z]/i.test(html);

/** The pictures in the text: the requirement's files they show. */
export const fileRefs = (html: string): string[] => [...html.matchAll(/src="kfile:([\w-]+)"/g)].map((m) => m[1]!);

/** HTML as plain text: paragraphs apart, lists as "- " and "1. ", tables as Markdown rows, pictures as [Picture]. */
export function htmlToText(html: string): string {
  const out: string[] = [];
  const lists: { ordered: boolean; n: number }[] = [];
  const tables: { rows: number; cells: number; heads: number }[] = [];
  const nl = (n = 1) => { const t = out.join(''); const have = /\n*$/.exec(t)![0].length; if (t && have < n) out.push('\n'.repeat(n - have)); };
  for (const m of html.matchAll(/<(\/?)([a-z][\w]*)([^>]*)>|([^<]+)/gi)) {
    if (m[4] !== undefined) { const t = decode(m[4]).replace(/[ \t\r\n]+/g, ' '); if (t.trim() || out.length) out.push(t); continue; }
    const end = m[1] === '/', t = m[2]!.toLowerCase();
    const tb = tables.at(-1);
    if (t === 'br') { out.push(tb ? ' ' : '\n'); continue; }
    if (t === 'img') { const alt = /alt="([^"]*)"/.exec(m[3] ?? '')?.[1]; out.push(`[Picture${alt ? `: ${decode(alt)}` : ''}]`); continue; }
    if (t === 'table') { nl(2); if (end) tables.pop(); else tables.push({ rows: 0, cells: 0, heads: 0 }); continue; }
    if (tb && t === 'tr') {
      if (!end) { nl(1); tb.cells = 0; tb.heads = 0; continue; }
      out.push(' |');
      // A first row of headings: the Markdown line under it
      if (tb.rows++ === 0 && tb.cells && tb.heads === tb.cells) out.push(`\n|${' --- |'.repeat(tb.cells)}`);
      nl(1);
      continue;
    }
    if (tb && (t === 'td' || t === 'th')) { if (!end) { out.push(tb.cells++ ? ' | ' : '| '); if (t === 'th') tb.heads++; } continue; }
    if (tb) continue;
    if (t === 'ul' || t === 'ol') { if (end) { lists.pop(); if (!lists.length) nl(2); } else { nl(lists.length ? 1 : 2); lists.push({ ordered: t === 'ol', n: 0 }); } continue; }
    if (t === 'li' && !end) { nl(1); const l = lists.at(-1); out.push(`${'  '.repeat(Math.max(0, lists.length - 1))}${l?.ordered ? `${++l.n}. ` : '- '}`); continue; }
    if ((t === 'p' || t === 'h3' || t === 'h4' || t === 'blockquote' || t === 'pre') && !lists.length) nl(2);
  }
  return out.join('').replace(/\u00a0/g, ' ').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Plain text as HTML: paragraphs at blank lines, line breaks kept, lines starting "- ", "* " or
 * "• " as a list, "1. " or "1) " as a numbered one, Markdown table rows (| a | b |, a |---| line
 * under the first making it the heading) as a table.
 */
export function textToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) out.push(`<p>${para.map(esc).join('<br>')}</p>`); para = []; };
  const row = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length;) {
    const l = lines[i]!;
    if (/^\s*\|.*\|\s*$/.test(l)) {
      flush();
      const rows: string[][] = [];
      let head = false;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        const r = row(lines[i]!);
        if (r.every((c) => /^:?-{2,}:?$/.test(c))) { if (rows.length === 1) head = true; } else rows.push(r);
        i++;
      }
      out.push(`<table>${rows.map((r, k) => `<tr>${r.map((c) => (head && k === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</table>`);
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(l), num = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(l);
    if (bullet || num) {
      flush();
      const ordered = !bullet;
      const items: string[] = [];
      while (i < lines.length) {
        const m = ordered ? /^\s*\d{1,3}[.)]\s+(.*)$/.exec(lines[i]!) : /^\s*[-*•]\s+(.*)$/.exec(lines[i]!);
        if (!m) break;
        items.push(m[1]!); i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (!l.trim()) flush(); else para.push(l);
    i++;
  }
  flush();
  return out.join('');
}

/* ─── Files ───────────────────────────────────────────────────────────────────────────── */

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** A file's size in bytes, from its base64. */
export const sizeOf = (f: ReqFile): number => Math.floor((f.data.length * 3) / 4) - (f.data.endsWith('==') ? 2 : f.data.endsWith('=') ? 1 : 0);
export const sizeWords = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
/** The most one file can be (kept in the document, so it stays one file to save and send). */
export const MAX_FILE = 25 * 1024 * 1024;

/**
 * A file's type as it is kept and used: a media type's two names (image/png) and nothing more of
 * what a document may say there; '' when it isn't one. (A type goes into the page with a picture's
 * address and decides how a file opens, and a document can come from anyone.)
 */
export const fileType = (t: unknown): string => {
  const m = typeof t === 'string' ? /^\s*([a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60})\s*(?:;|$)/i.exec(t) : null;
  return m ? m[1]!.toLowerCase() : '';
};

/**
 * Whether a file opens in a tab of its own: only what a browser merely shows (a PDF, a picture, plain
 * text). A web page or an SVG opened that way would be a page of Konium itself, free to run script
 * with everything Konium keeps, so those (and everything else) are saved to the computer instead.
 */
export const opensInTab = (f: ReqFile): boolean => /^(application\/pdf|image\/(png|jpeg|gif|webp|bmp)|text\/plain)$/.test(fileType(f.type));

/** A file's data as a data: URL (to show a picture, to open a file). */
export const dataUrl = (f: ReqFile): string => `data:${fileType(f.type) || 'application/octet-stream'};base64,${f.data}`;

/**
 * The text with its pictures shown (kfile: as data: URLs), for display: pictures only, their
 * addresses written as attributes are. One that can't be shown (its file gone, or not a picture)
 * is an empty picture, still naming its file: nothing for the browser to fetch.
 */
export const showPictures = (html: string, files: ReqFile[] | undefined): string =>
  html.replace(/src="kfile:([\w-]+)"/g, (_m, id: string) => { const f = files?.find((x) => x.id === id); return `src="${f && fileType(f.type).startsWith('image/') ? attr(dataUrl(f)) : 'data:,'}" data-kfile="${id}"`; });

/** A new file identifier, not one of those given. */
export function newFileId(taken: Iterable<string>): string {
  const have = new Set(taken);
  let n = have.size + 1;
  while (have.has(`f${n}`)) n++;
  return `f${n}`;
}

/** A requirement's files as read: well formed, identifiers unique; pictures no longer in its text dropped. */
export function normaliseFiles(raw: unknown, html: string | undefined): ReqFile[] {
  const refs = new Set(html ? fileRefs(html) : []);
  const out: ReqFile[] = [];
  const seen = new Set<string>();
  for (const x of Array.isArray(raw) ? raw : []) {
    const f = x as Partial<ReqFile>;
    if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !/^[\w-]{1,40}$/.test(f.id) || seen.has(f.id) || typeof f.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) continue;
    const inline = refs.has(f.id);
    if (f.inline && !inline) continue;
    seen.add(f.id);
    out.push({ id: f.id, name: (typeof f.name === 'string' && f.name.trim() ? f.name.trim() : f.id).slice(0, 200), type: fileType(f.type), data: f.data, ...(inline ? { inline: true } : {}) });
  }
  return out;
}

/* ─── Undo snapshots without copying files each time ──────────────────────────────────── */

const blobs = new Map<string, string>();
const keys = new Map<string, string>();
const intern = (data: string): string => {
  let k = keys.get(data);
  if (!k) { k = `\u0000${keys.size}`; keys.set(data, k); blobs.set(k, data); }
  return k;
};
/** A snapshot (for undo) with each file's data kept once, not in every snapshot. */
export const snapshot = (o: unknown): string => JSON.stringify(o, (k, v) => (k === 'data' && typeof v === 'string' && v.length > 256 ? intern(v) : v));
export const unsnapshot = <T>(s: string): T => JSON.parse(s, (k, v) => (k === 'data' && typeof v === 'string' && v.startsWith('\u0000') ? blobs.get(v) ?? '' : v)) as T;
