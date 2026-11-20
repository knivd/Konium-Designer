/**
 * A small XML reader for exchange files (IPC-2581, EasyEDA Pro's, others): elements with their
 * attributes, children and text; namespace prefixes dropped from names; comments, processing
 * instructions, DOCTYPE and CDATA handled. Built for large files: one pass, no regular
 * expressions per character.
 */
import { charOf } from './codePoint';
export interface XEl { name: string; attrs: Record<string, string>; children: XEl[]; text: string }

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export function unescapeXml(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? charOf(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));
}
const local = (n: string) => { const i = n.indexOf(':'); return i >= 0 ? n.slice(i + 1) : n; };
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

export function parseXml(text: string): XEl {
  const root: XEl = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XEl[] = [root];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    const top = stack[stack.length - 1]!;
    if (lt < 0) { top.text += unescapeXml(text.slice(i)); break; }
    if (lt > i) { const t = text.slice(i, lt); if (t.trim()) top.text += unescapeXml(t); }
    i = lt;
    if (text.startsWith('<!--', i)) { const e = text.indexOf('-->', i + 4); i = e < 0 ? n : e + 3; continue; }
    if (text.startsWith('<![CDATA[', i)) { const e = text.indexOf(']]>', i + 9); top.text += text.slice(i + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3; continue; }
    if (text.startsWith('<?', i)) { const e = text.indexOf('?>', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (text.startsWith('<!', i)) {
      // DOCTYPE (with an internal subset in brackets)
      let depth = 0, j = i + 2;
      for (; j < n; j++) { const c = text[j]; if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break; }
      i = j + 1; continue;
    }
    if (text[i + 1] === '/') {
      // (a file cut short has no '>' here, nor where a tag or a quoted value should end below: it ends there)
      const at = text.indexOf('>', i), e = at < 0 ? n : at;
      const name = local(text.slice(i + 2, e).trim());
      // Close up to the matching element (lenient with stray closers)
      for (let k = stack.length - 1; k > 0; k--) if (stack[k]!.name === name) { stack.length = k; break; }
      i = e + 1; continue;
    }
    // A start tag: its name, then attributes
    let j = i + 1;
    while (j < n && !isSpace(text.charCodeAt(j)) && text[j] !== '>' && text[j] !== '/') j++;
    const el: XEl = { name: local(text.slice(i + 1, j)), attrs: {}, children: [], text: '' };
    let selfClose = false;
    for (;;) {
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      const c = text[j];
      if (c === '>') { j++; break; }
      if (c === '/') { selfClose = true; const e = text.indexOf('>', j); j = e < 0 ? n : e + 1; break; }
      if (j >= n) break;
      let k = j;
      while (k < n && text[k] !== '=' && !isSpace(text.charCodeAt(k)) && text[k] !== '>' && text[k] !== '/') k++;
      const an = local(text.slice(j, k));
      while (k < n && isSpace(text.charCodeAt(k))) k++;
      if (text[k] !== '=') { el.attrs[an] = ''; j = k; continue; }
      k++;
      while (k < n && isSpace(text.charCodeAt(k))) k++;
      const q = text[k];
      if (q === '"' || q === "'") { const at = text.indexOf(q, k + 1), e = at < 0 ? n : at; el.attrs[an] = unescapeXml(text.slice(k + 1, e)); j = e + 1; }
      else { let e = k; while (e < n && !isSpace(text.charCodeAt(e)) && text[e] !== '>') e++; el.attrs[an] = unescapeXml(text.slice(k, e)); j = e; }
    }
    top.children.push(el);
    if (!selfClose) stack.push(el);
    i = j;
  }
  return root;
}

/* ── reading helpers ── */
export const kid = (e: XEl | undefined, name: string): XEl | undefined => e?.children.find((c) => c.name === name);
export const kidsOf = (e: XEl | undefined, name: string): XEl[] => (e ? e.children.filter((c) => c.name === name) : []);
/** Every element of this name below (depth first). */
export function descendants(e: XEl, name: string, out: XEl[] = []): XEl[] {
  for (const c of e.children) { if (c.name === name) out.push(c); descendants(c, name, out); }
  return out;
}
export const attrNum = (e: XEl | undefined, a: string, def = 0): number => { const v = e?.attrs[a]; const n = v === undefined || v === '' ? NaN : Number(v); return Number.isFinite(n) ? n : def; };
