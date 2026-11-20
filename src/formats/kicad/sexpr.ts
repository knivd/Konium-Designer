/**
 * KiCad's s-expression files (.kicad_sch, .kicad_pcb, .kicad_sym, .kicad_mod): read into nested
 * lists — a list's first item is its keyword, the rest atoms (numbers and symbols as written, or
 * quoted strings, unescaped) and lists — and written back in KiCad's layout.
 */
export type SAtom = string | number;
export interface SList {
  k: string; items: SNode[];
  /** Its uuid, where a board's are skipped and this one is kept (an item a group or generated object names, the group itself). */
  id?: string;
}
export type SNode = SAtom | SList;

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
/** Space, ( ) and " end a symbol. */
const ends = (c: number) => c <= 32 || c === 40 || c === 41 || c === 34;

/**
 * `skip`: keywords whose lists are left out (a board's UUIDs, which only take memory). `ids`: of
 * those, the ones kept as their list's `id`: a value in `keep`, or any in a list keyword in `of`.
 */
export function parseSexpr(text: string, skip?: Set<string>, ids?: { keep: Set<string>; of: Set<string> }): SList {
  let i = 0;
  const n = text.length;
  const stack: SList[] = [];
  // Keywords and short words once each (a board repeats a few hundred of them millions of times; each copy a string of its own)
  const words = new Map<string, string>();
  const once = (w: string) => { if (w.length > 48) return w; const e = words.get(w); if (e !== undefined) return e; words.set(w, w); return w; };
  let root: SList | null = null;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 40) { // (
      i++;
      let j = i;
      while (j < n && !ends(text.charCodeAt(j))) j++;
      const node: SList = { k: once(text.slice(i, j)), items: [] };
      i = j;
      if (skip?.has(node.k) && stack.length) {
        // Past its closing bracket (strings may hold brackets)
        let depth = 1;
        const from = i;
        while (i < n && depth) { const d = text.charCodeAt(i++); if (d === 40) depth++; else if (d === 41) depth--; else if (d === 34) { while (i < n && text.charCodeAt(i) !== 34) i += text.charCodeAt(i) === 92 ? 2 : 1; i++; } }
        const parent = stack[stack.length - 1]!;
        if (ids && parent.id === undefined && (ids.keep.size || ids.of.has(parent.k))) {
          const v = text.slice(from, i - 1).trim().replace(/^"(.*)"$/, '$1');
          if (ids.keep.has(v) || ids.of.has(parent.k)) parent.id = v;
        }
        continue;
      }
      if (stack.length) stack[stack.length - 1]!.items.push(node); else if (!root) root = node;
      stack.push(node);
    } else if (c === 41) { // )
      // A list's items to their size (an array pushed to holds room for 17)
      const done = stack.pop();
      if (done && done.items.length < 17) done.items = done.items.slice();
      i++;
      if (!stack.length && root) break;
    } else if (c === 34) { // "
      // Unescaped runs are sliced whole
      let j = i + 1, s = '', from = j;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 34) break;
        if (d === 92 && j + 1 < n) {
          const e = text[j + 1]!;
          s += text.slice(from, j) + (e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e);
          j += 2; from = j;
        } else j++;
      }
      s += text.slice(from, j);
      i = j + 1;
      stack[stack.length - 1]?.items.push(once(s));
    } else if (c <= 32) i++;
    else {
      let j = i;
      while (j < n && !ends(text.charCodeAt(j))) j++;
      const t = text.slice(i, j);
      stack[stack.length - 1]?.items.push(NUM.test(t) ? Number(t) : once(t));
      i = j;
    }
  }
  if (!root) throw new Error('Not a KiCad file: no s-expression in it');
  return root;
}

/* ── reading helpers ── */

export const isList = (n: SNode | undefined): n is SList => typeof n === 'object' && n !== null;
export const kids = (n: SList | undefined, k: string): SList[] => (n ? n.items.filter((x): x is SList => isList(x) && x.k === k) : []);
export const kid = (n: SList | undefined, k: string): SList | undefined => n?.items.find((x): x is SList => isList(x) && x.k === k);
/** The i-th atom of a list (lists skipped), as text. */
export function str(n: SList | undefined, i = 0): string | undefined {
  if (!n) return undefined;
  let k = 0;
  for (const x of n.items) {
    if (isList(x)) continue;
    if (k++ === i) return String(x);
  }
  return undefined;
}
export function num(n: SList | undefined, i = 0, def = 0): number {
  const s = str(n, i);
  const v = s === undefined ? NaN : Number(s);
  return Number.isFinite(v) ? v : def;
}
/** (key value) under a list: its first atom. */
export const val = (n: SList | undefined, k: string): string | undefined => str(kid(n, k));
export const valNum = (n: SList | undefined, k: string, def = 0): number => num(kid(n, k), 0, def);
/** A yes/no flag: (key yes), (key) alone, or a bare atom in the list. */
export function flag(n: SList | undefined, k: string): boolean {
  if (!n) return false;
  const l = kid(n, k);
  if (l) { const v = str(l); return v === undefined || v === 'yes' || v === 'true'; }
  return n.items.some((x) => !isList(x) && String(x) === k);
}
/** (at x y [angle]) */
export function at(n: SList | undefined): { x: number; y: number; a: number } {
  const l = kid(n, 'at');
  return { x: num(l, 0), y: num(l, 1), a: num(l, 2) };
}
/** (pts (xy x y) …) */
export const pts = (n: SList | undefined): { x: number; y: number }[] => kids(kid(n, 'pts'), 'xy').map((p) => ({ x: num(p, 0), y: num(p, 1) }));
/** A property by name: (property "Reference" "R1" …). */
export const prop = (n: SList | undefined, name: string): SList | undefined => kids(n, 'property').find((p) => str(p, 0) === name);

/* ── writing ── */

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
/** A list to write: keyword then atoms (strings quoted unless `bare`) and lists. */
export type WNode = { k: string; items: (WNode | Written | string | number | Bare)[] };
/** A list already written, at the depth it goes in: a big file's parts (a board's footprints) written as they are made, not all held as lists first. */
export class Written { constructor(readonly s: string) {} }
export const written = (n: WNode, depth: number): Written => new Written(writeSexpr(n, depth));
export class Bare { constructor(readonly s: string) {} }
export const bare = (s: string) => new Bare(s);
export const L = (k: string, ...items: (WNode | Written | string | number | Bare | undefined | null | false)[]): WNode => ({ k, items: items.filter((x): x is WNode | Written | string | number | Bare => x !== undefined && x !== null && x !== false) });
const fmt = (v: number) => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? '0' : String(r); };

/** KiCad's layout: a list on one line when short and flat, else its sub-lists indented by tabs. */
export function writeSexpr(n: WNode, depth = 0): string {
  const atom = (x: string | number | Bare) => (typeof x === 'number' ? fmt(x) : x instanceof Bare ? x.s : quote(x));
  const flat = n.items.every((x) => !(typeof x === 'object' && !(x instanceof Bare)));
  if (flat) return `(${[n.k, ...n.items.map((x) => atom(x as string | number | Bare))].join(' ')})`;
  const head: string[] = [n.k];
  let out = '';
  const tab = '\t'.repeat(depth + 1);
  let inline = true;
  for (const x of n.items) {
    if (typeof x === 'object' && !(x instanceof Bare)) {
      if (x instanceof Written) { inline = false; out += `\n${tab}${x.s}`; continue; }
      const sub = writeSexpr(x as WNode, depth + 1);
      if (inline && sub.length < 60 && !sub.includes('\n') && (x as WNode).items.length <= 3 && out === '') head.push(sub);
      else { inline = false; out += `\n${tab}${sub}`; }
    } else if (inline) head.push(atom(x)); else out += ` ${atom(x)}`;
  }
  return `(${head.join(' ')}${out}${out ? `\n${'\t'.repeat(depth)}` : ''})`;
}
