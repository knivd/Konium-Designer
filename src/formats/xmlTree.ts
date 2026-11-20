/**
 * A lossless XML tree for documents Konium edits in place (AD's Draftsman .PCBDwf): elements keep
 * their prefixed names, their attributes as written (raw, still escaped) and their text as written,
 * so what isn't changed is written back byte for byte (attribute quotes become ", the spaces
 * between attributes one). Comments and processing instructions are kept as text.
 */
import { charOf } from './codePoint';
export interface XNode { name: string; attrs: [string, string][]; kids: (XNode | string)[]; empty: boolean; /** Spaces before the tag's close ("<a />"). */ gap?: string }

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

export function parseTree(text: string): { prolog: string; root: XNode } {
  const top: XNode = { name: '#', attrs: [], kids: [], empty: false };
  const stack: XNode[] = [top];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    const cur = stack[stack.length - 1]!;
    if (lt < 0) { cur.kids.push(text.slice(i)); break; }
    if (lt > i) cur.kids.push(text.slice(i, lt));
    i = lt;
    if (text.startsWith('<!--', i)) { const e = text.indexOf('-->', i + 4); const j = e < 0 ? n : e + 3; cur.kids.push(text.slice(i, j)); i = j; continue; }
    if (text.startsWith('<![CDATA[', i)) { const e = text.indexOf(']]>', i + 9); const j = e < 0 ? n : e + 3; cur.kids.push(text.slice(i, j)); i = j; continue; }
    if (text.startsWith('<?', i) || text.startsWith('<!', i)) { const e = text.indexOf('>', i); const j = e < 0 ? n : e + 1; cur.kids.push(text.slice(i, j)); i = j; continue; }
    if (text[i + 1] === '/') {
      // (a file cut short has no '>' here, nor where a tag or a quoted value should end below: it ends there)
      const at = text.indexOf('>', i), e = at < 0 ? n : at;
      const name = text.slice(i + 2, e).trim();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k]!.name === name) { stack.length = k; break; }
      i = e + 1; continue;
    }
    let j = i + 1;
    while (j < n && !isSpace(text.charCodeAt(j)) && text[j] !== '>' && text[j] !== '/') j++;
    const el: XNode = { name: text.slice(i + 1, j), attrs: [], kids: [], empty: false };
    for (;;) {
      const ws = j;
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      const c = text[j];
      if ((c === '>' || c === '/') && j > ws) el.gap = text.slice(ws, j);
      if (c === '>') { j++; break; }
      if (c === '/') { el.empty = true; const e = text.indexOf('>', j); j = e < 0 ? n : e + 1; break; }
      if (j >= n) break;
      let k = j;
      while (k < n && text[k] !== '=' && !isSpace(text.charCodeAt(k)) && text[k] !== '>') k++;
      const an = text.slice(j, k);
      while (k < n && isSpace(text.charCodeAt(k))) k++;
      if (text[k] !== '=') { el.attrs.push([an, '']); j = k; continue; }
      k++;
      while (k < n && isSpace(text.charCodeAt(k))) k++;
      const q = text[k];
      const at = text.indexOf(q === "'" ? "'" : '"', k + 1), e = at < 0 ? n : at;
      el.attrs.push([an, text.slice(k + 1, e)]);
      j = e + 1;
    }
    cur.kids.push(el);
    if (!el.empty) stack.push(el);
    i = j;
  }
  const root = top.kids.find((k): k is XNode => typeof k !== 'string');
  if (!root) throw new Error('No XML element');
  const at = top.kids.indexOf(root);
  return { prolog: top.kids.slice(0, at).map((k) => (typeof k === 'string' ? k : '')).join(''), root };
}

export function writeTree(root: XNode, prolog = ''): string {
  const out: string[] = [prolog];
  const walk = (e: XNode) => {
    out.push('<', e.name);
    for (const [k, v] of e.attrs) out.push(' ', k, '="', v, '"');
    if (e.gap) out.push(e.gap);
    if (e.empty && !e.kids.length) { out.push('/>'); return; }
    out.push('>');
    for (const k of e.kids) { if (typeof k === 'string') out.push(k); else walk(k); }
    out.push('</', e.name, '>');
  };
  walk(root);
  return out.join('');
}

/* ─── Access by local name (prefixes ignored) ─────────────────────────────────────── */

export const localName = (n: string) => { const i = n.indexOf(':'); return i >= 0 ? n.slice(i + 1) : n; };
export const xkids = (e: XNode | undefined): XNode[] => (e ? (e.kids.filter((k) => typeof k !== 'string') as XNode[]) : []);
export const xkid = (e: XNode | undefined, name: string): XNode | undefined => xkids(e).find((k) => localName(k.name) === name);
export const xkidsNamed = (e: XNode | undefined, name: string): XNode[] => xkids(e).filter((k) => localName(k.name) === name);
/** An element's text (unescaped); '' when it has none. */
export function xtext(e: XNode | undefined): string {
  if (!e) return '';
  const raw = e.kids.filter((k): k is string => typeof k === 'string').join('');
  return raw.indexOf('&') < 0 ? raw : raw.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_m, x: string) => (x[0] === '#' ? charOf(x[1] === 'x' || x[1] === 'X' ? parseInt(x.slice(2), 16) : Number(x.slice(1))) : ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[x.toLowerCase()]!));
}
export const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Sets an element's text (its children replaced by it). */
export function xsetText(e: XNode, v: string): void { e.kids = v === '' ? [] : [escapeText(v)]; e.empty = false; }
/** The child at a path of local names (a/b/c), or undefined. */
export function xpath(e: XNode | undefined, path: string): XNode | undefined {
  let cur = e;
  for (const p of path.split('/')) { cur = xkid(cur, p); if (!cur) return undefined; }
  return cur;
}
export const xnum = (e: XNode | undefined, path: string, def = 0): number => { const t = xtext(xpath(e, path)); const v = t === '' ? NaN : Number(t); return Number.isFinite(v) ? v : def; };
export const xstr = (e: XNode | undefined, path: string, def = ''): string => { const n = xpath(e, path); return n ? xtext(n) : def; };
export const xattr = (e: XNode | undefined, local: string): string | undefined => e?.attrs.find(([k]) => localName(k) === local)?.[1];
/** Sets the text at a path when the element is there (a number as .NET writes it: shortest round trip). */
export function xset(e: XNode | undefined, path: string, v: string | number): boolean {
  const n = xpath(e, path);
  if (!n) return false;
  xsetText(n, typeof v === 'number' ? String(v) : v);
  return true;
}
/** An element made from a string of XML (the namespaces its prefixes need declared in it or above). */
export function xfrom(xml: string): XNode { return parseTree(xml).root; }
