/**
 * R10, a PADS board changed in places: written as PADS wrote it but for what changed. Its parts
 * moved, turned or turned over take their new places on their own lines (their labels are their
 * own, in the part's frame); a net whose routes changed in Konium (rerouted, a track moved, added
 * or taken away) has its signal written from Konium's; a free text, line item (drawing, copper,
 * keep-out) or pour changed in Konium is written from Konium's in its place, one taken away is left
 * out, one Konium added is written at its section's end; everything else is the file's, line for
 * line. While the rest of the board (its parts' footprints and references, board outline, nets,
 * rules) is what the import made, in the file's own units (basic, mils, inches or millimetres);
 * else the export writes the whole board from Konium's.
 */
import { cfbStream } from '../cfb/cfb';
import { mil } from '../../core/units';
import type { Vec2 } from '../../core/geom';
import { NO_NET, type PcbDocument, type PcbPrim } from '../../model/pcb';
import { isPlane } from '../../model/layers';
import { binToBytes, bytesToBin } from '../text';
import { readJson } from '../kicad/padPrims';
import { UNIT_FACTOR, padsText, tokens, type PadsUnits } from './ascii';
import { padsFormat, parsePadsLayout, type PadsBoard, type PadsFormat } from './layout';
import type { PadsTrace } from './writeLayout';
import { PADS_SOURCE, padsClass, padsMark, padsObjectSigs, padsPartSig, padsPiece, padsPlace, padsRestSig, padsRouteSigs, pourKey } from './kept';

const norm = (a: number) => ((a % 360) + 360) % 360;

/** The lines a board's object takes: from its line to the next object's (or its section's end). */
function blocks(b: PadsBoard, starts: number[], section: string, total: number): Map<number, number> {
  const end = sectionEnd(b, section, total);
  const sorted = [...starts].sort((x, y) => x - y);
  return new Map(sorted.map((s, i) => [s, sorted[i + 1] ?? end]));
}
/** A section's end: the next section's header (-1: no such section). */
function sectionEnd(b: PadsBoard, section: string, total: number): number {
  const sec = (b.sections ?? []).findIndex((s) => s.name === section);
  return sec >= 0 ? (b.sections![sec + 1]?.line ?? total) : -1;
}

export interface PadsSpliced { bytes: Uint8Array; moved: number; rerouted: number; /** Free texts, line items and pours written from Konium's (changed or added) or left out. */ objects?: number }

/** A length in the file's units as PADS writes it: whole basic units; else as many decimals as a Konium unit needs, no trailing zeros. */
function unitText(v: number, units: PadsUnits): string {
  if (units === 'BASIC') return String(Math.round(v));
  const d = Math.ceil(Math.log10(UNIT_FACTOR[units]));
  const t = v.toFixed(d).replace(/\.?0+$/, '');
  return t === '-0' ? '0' : t;
}

const POUR_TYPES = /^(POUROUT|HATOUT|VOIDOUT|PADTHERM|VIATHERM)$/;
/** PADS's sections in the order it writes them, and the headers of those the splice may add. */
const SECTION_ORDER = ['PCB', 'REUSE', 'TEXT', 'LINES', 'CLUSTER', 'VIA', 'PARTDECAL', 'PARTTYPE', 'PART', 'NET', 'ROUTE', 'TESTPOINT', 'POUR', 'MISC', 'END'];
const SECTION_HEAD = { TEXT: '*TEXT*       FREE TEXT', LINES: '*LINES*      LINES ITEMS', POUR: '*POUR*       POUR ITEMS' };

/**
 * The board as PADS wrote it, what changed in Konium written from Konium's; null when the board
 * changed otherwise (or wasn't read from a PADS file). `generate` writes the whole board from
 * Konium's with PADS's (0, 0) at `org`, in the file's units, and traces what its texts, line
 * items and pours were written from.
 */
export function padsSplice(doc: PcbDocument, generate: (org: Vec2, trace: PadsTrace, like: { head: string; fmt: PadsFormat }) => Uint8Array): PadsSpliced | null {
  const bag = doc.board.bag;
  if (!bag?.has('PADSREST')) return null;
  const src = cfbStream(doc.cfb.root, `${PADS_SOURCE}/Data`);
  const base = (bag.get('PADSBASE') ?? '').split(' ');
  const units = base[0] as PadsUnits;
  if (!src || !(units in UNIT_FACTOR) || base.length < 3) return null;
  if (doc.dimensions.length) return null;
  if (padsRestSig(doc) !== bag.get('PADSREST') || String(doc.components.length) !== bag.get('PADSPARTS')) return null;
  const byComp = new Map<number, PcbPrim[]>();
  for (const p of doc.prims) if ('component' in p && p.component !== NO_NET && p.component >= 0) byComp.set(p.component, [...(byComp.get(p.component) ?? []), p]);
  for (let ci = 0; ci < doc.components.length; ci++) if (padsPartSig(doc, ci, byComp.get(ci) ?? []) !== doc.components[ci]!.bag.get('PADSPART')) return null;

  const bx = Number(base[1]), by = Number(base[2]), f = UNIT_FACTOR[units];
  const orig = parsePadsLayout(padsText(src));
  const bin = bytesToBin(src);
  const eol = bin.includes('\r\n') ? '\r\n' : '\n';
  const lines = bin.split(/\r?\n/);
  const replace = new Map<number, string>();
  const drop = new Set<number>();
  const insert = new Map<number, string[]>();
  const addAt = (at: number, ls: string[]) => insert.set(at, [...(insert.get(at) ?? []), ...ls]);
  // (the blank lines after an object stay: they part it from what follows)
  const dropBlock = (from: number, to: number) => { while (to > from && !lines[to - 1]!.trim()) to--; for (let i = from; i < to; i++) drop.add(i); };

  // Parts moved, turned or turned over: their lines with their new place (their labels as they were)
  let moved = 0;
  doc.components.forEach((c) => {
    if (padsPlace(c.bag) === c.bag.get('PADSPLACE')) return;
    const part = orig.parts.find((p) => p.ref === c.designator && p.line !== undefined);
    if (!part) return;
    const t = tokens(lines[part.line!]!);
    const bottom = c.layer !== undefined && c.bag.get('LAYER') === 'BOTTOM';
    const ori = bottom ? norm(180 - c.rotation) : norm(c.rotation);
    t[2] = unitText(bx + (c.at.x - mil(1000)) / f, units);
    t[3] = unitText(by + (c.at.y - mil(1000)) / f, units);
    t[4] = /\./.test(t[4] ?? '') ? ori.toFixed(3) : Math.abs(ori - Math.round(ori)) < 1e-6 ? String(Math.round(ori)) : ori.toFixed(3);
    const m = t[6] === 'M' || t[6] === 'N' ? 6 : t[5] === 'M' || t[5] === 'N' ? 5 : -1;
    if (m >= 0) t[m] = bottom ? 'M' : 'N';
    replace.set(part.line!, t.join(' '));
    moved++;
  });

  // What else changed: nets' routes, the file's texts, line items and pours, and what Konium added
  const was = readJson<Record<string, string>>(bag.get('PADSROUTES')) ?? {};
  const now = padsRouteSigs(doc);
  const changed = new Set([...Object.keys(was), ...now.keys()].filter((n) => was[n] !== now.get(n)));
  const objWas = readJson<Record<string, string>>(bag.get('PADSOBJS')) ?? {};
  const objNow = padsObjectSigs(doc);
  const dirty = new Set(Object.keys(objWas).filter((k) => objNow.get(k) !== objWas[k]));
  const added = doc.prims.some((p) => !('component' in p && p.component !== NO_NET && p.component >= 0) && padsClass(doc, p) === '+') || doc.polygons.some((_, i) => pourKey(doc, i) === '+P');
  if (!changed.size && !dirty.size && !added) return { bytes: assemble(lines, replace, drop, insert, eol), moved, rerouted: 0 };
  // A pour on a plane layer is written as the plane's area: not in place
  for (const [i, pg] of doc.polygons.entries()) { const k = pourKey(doc, i); if ((k === '+P' || dirty.has(k)) && isPlane(pg.layer)) return null; }

  const trace: PadsTrace = { texts: [], items: [], pours: [], notRouted: (p) => padsMark(doc, p) === 'I' };
  // (as the file's version writes its lines)
  const like = { head: lines[0]!, fmt: padsFormat(orig.version, lines.filter((l) => l.startsWith('*REMARK*'))) };
  const genBytes = generate({ x: Math.round(mil(1000) - bx * f), y: Math.round(mil(1000) - by * f) }, trace, like);
  const gen = parsePadsLayout(padsText(genBytes));
  const genLines = bytesToBin(genBytes).split(/\r?\n/);

  /* Nets whose routes changed: their signals as Konium has them, their copper off the routes as line items */
  let rerouted = 0;
  if (changed.size) {
    const genBlocks = blocks(gen, gen.routes.map((r) => r.line!).filter((l) => l !== undefined), 'ROUTE', genLines.length);
    const origBlocks = blocks(orig, orig.routes.map((r) => r.line!).filter((l) => l !== undefined), 'ROUTE', lines.length);
    const routeEnd = sectionEnd(orig, 'ROUTE', lines.length);
    if (routeEnd < 0) return null;
    // The via types the new signals use, from Konium's file: as the file's where it has one of that name and size, else added (renamed if the name is taken)
    const viaNames = new Map<string, string>();
    const viaBlock = (b: PadsBoard, ls: string[], name: string) => { const v = b.vias.get(name); if (v?.line === undefined) return []; const vb = blocks(b, [...b.vias.values()].map((x) => x.line!).filter((l) => l !== undefined), 'VIA', ls.length); return ls.slice(v.line, vb.get(v.line)); };
    // (numbers by value: 12008 and 12008.0 alike)
    const viaKey = (ls: string[]) => ls.map((l) => tokens(l).map((x) => (/^-?\d/.test(x) && Number.isFinite(Number(x)) ? String(Number(x)) : x)).join(' ')).filter(Boolean).join('|');
    const viaEnd = sectionEnd(orig, 'VIA', lines.length);
    const viaOf = (name: string): string | null => {
      if (viaNames.has(name)) return viaNames.get(name)!;
      const gb = viaBlock(gen, genLines, name);
      let out = name;
      if (orig.vias.has(name) && viaKey(gb) !== viaKey(viaBlock(orig, lines, name))) { for (let k = 2; orig.vias.has(out) || [...viaNames.values()].includes(out); k++) out = `${name}_${k}`; }
      if (!orig.vias.has(out)) {
        if (viaEnd < 0) return null;
        const t = tokens(gb[0] ?? '');
        if (t.length) t[0] = out;
        addAt(viaEnd, [t.join(' '), ...gb.slice(1)]);
      }
      viaNames.set(name, out);
      return out;
    };
    for (const net of changed) {
      const mine = orig.routes.filter((r) => r.net === net && r.line !== undefined);
      for (const r of mine) dropBlock(r.line!, origBlocks.get(r.line!)!);
      const at = mine.length ? mine[0]!.line! : routeEnd;
      for (const r of gen.routes.filter((x) => x.net === net && x.line !== undefined)) {
        const block = genLines.slice(r.line!, genBlocks.get(r.line!));
        const out: string[] = [];
        for (const l of block) {
          const t = tokens(l);
          // A corner's via by the name the file knows it by
          if (t.length > 5 && /^-?\d/.test(t[0]!)) { for (let k = 5; k < t.length; k++) if (gen.vias.has(t[k]!)) { const v = viaOf(t[k]!); if (v === null) return null; t[k] = v; } out.push(t.join(' ')); }
          else out.push(l.trimEnd());
        }
        addAt(at, out);
      }
      rerouted++;
    }
  }

  /* The file's texts, line items and pours changed or taken away, and Konium's added */
  // Each generated block's object (its primitives')
  const classOf = (ps: PcbPrim[]): string | null => {
    const ks = new Set(ps.map((p) => { const k = padsClass(doc, p); return k === 'route' && 'net' in p ? `route:${doc.nets[p.net]?.name ?? ''}` : k; }));
    return ks.size === 1 ? [...ks][0]! : null;
  };
  const keep = (k: string | null) => k !== null && (k === '+' || k === '+P' || dirty.has(k) || (k.startsWith('route:') && changed.has(k.slice(6))));
  if (trace.texts.some((t) => classOf([t.prim]) === null) || trace.items.some((t) => t.prims.length && classOf(t.prims) === null)) return null;

  let objects = 0;
  // A section the file hasn't: made before the first of those after it that it has (in PADS's order)
  const made = new Set<string>();
  const endOf = (sec: 'TEXT' | 'LINES' | 'POUR'): number => {
    const e = sectionEnd(orig, sec, lines.length);
    if (e >= 0) return e;
    const after = SECTION_ORDER.slice(SECTION_ORDER.indexOf(sec) + 1);
    return (orig.sections ?? []).find((x) => after.includes(x.name))?.line ?? -1;
  };
  const atEnd = (sec: 'TEXT' | 'LINES' | 'POUR', ls: string[]): boolean => {
    const at = endOf(sec);
    if (at < 0) return false;
    if (sectionEnd(orig, sec, lines.length) < 0 && !made.has(sec)) { made.add(sec); addAt(at, [SECTION_HEAD[sec], '']); }
    addAt(at, ls);
    return true;
  };
  const firstAt = new Map<string, number>();
  const renamed = new Map<string, string>();
  const unique = (nm: string, taken: Set<string>) => { let out = nm; for (let n = 2; taken.has(out); n++) out = `${nm}_${n}`; taken.add(out); return out; };
  // Free texts
  const textBlocks = blocks(orig, orig.texts.map((t) => t.line!).filter((l) => l !== undefined), 'TEXT', lines.length);
  orig.texts.forEach((t, i) => { const k = `T${i}`; if (!dirty.has(k) || t.line === undefined) return; dropBlock(t.line, textBlocks.get(t.line)!); firstAt.set(k, t.line); objects++; });
  for (const t of trace.texts) {
    const k = classOf([t.prim]);
    // (a line item's texts go in it)
    if (!keep(k) || /^L\d/.test(k!)) continue;
    const at = firstAt.get(k!);
    if (at !== undefined) addAt(at, t.lines);
    else if (!atEnd('TEXT', t.lines)) return null;
    if (k === '+') objects++;
  }
  // Line items (named as the file's they replace, else by a name the file hasn't)
  const lineBlocks = blocks(orig, orig.lines.map((t) => t.line!).filter((l) => l !== undefined), 'LINES', lines.length);
  const names = new Set(orig.lines.map((l) => l.name));
  orig.lines.forEach((l, i) => { const k = `L${i}`; if (!dirty.has(k) || l.line === undefined) return; dropBlock(l.line, lineBlocks.get(l.line)!); firstAt.set(k, l.line); renamed.set(k, l.name); objects++; });
  // One of the file's written again as one item of each kind, as it had them: each piece's stretches joined end to end again, its texts in it
  interface Group { k: string; type: string; net: string; pieces: { id: number; lines: string[] }[]; texts: string[]; ntext: number }
  const groups: Group[] = [];
  for (const it of trace.items) {
    const k = classOf(it.prims);
    if (!keep(k)) continue;
    const g = readItem(it.lines, like.fmt.lineFlags);
    if (!g) continue;
    const id = Number(/\.(\d+)$/.exec(it.prims[0] ? padsPiece(doc, it.prims[0]) : '')?.[1] ?? Infinity);
    const pieces = g.pieces.map((lines) => ({ id, lines }));
    const prev = /^L\d/.test(k!) ? groups.find((x) => x.k === k && x.type === g.type && x.net === g.net) : undefined;
    if (prev) { prev.pieces.push(...pieces); prev.texts.push(...g.texts); prev.ntext += g.ntext; continue; }
    groups.push({ k: k!, type: g.type, net: g.net, pieces, texts: g.texts, ntext: g.ntext });
  }
  for (const t of trace.texts) {
    const k = classOf([t.prim]);
    if (!keep(k) || !/^L\d/.test(k!)) continue;
    let g = groups.find((x) => x.k === k);
    if (!g) { g = { k: k!, type: orig.lines[Number(k!.slice(1))]?.type ?? 'LINES', net: '', pieces: [], texts: [], ntext: 0 }; groups.push(g); }
    g.texts.push(...t.lines);
    g.ntext += t.prim.kind === 'text' ? t.prim.text.split(/\r?\n/).filter(Boolean).length : 0;
  }
  // (a piece of Konium's at the item's own place: its corners from there)
  const shifted = (ls: string[], ox: number, oy: number): string[] => {
    const shift = (l: string, at: number[]) => { if (!ox && !oy) return l; const t = tokens(l); for (const i of at) if (t[i] !== undefined) t[i] = unitText(Number(t[i]) - (i % 2 ? oy : ox), units); return t.join(' '); };
    return [ls[0]!, ...ls.slice(1).map((c) => shift(c, tokens(c).length >= 8 ? [0, 1, 4, 5, 6, 7] : [0, 1]))];
  };
  const textsAt = (ts: string[], ox: number, oy: number): string[] => {
    const n = like.fmt.font ? 3 : 2;
    return ts.map((l, i) => { if (i % n || (!ox && !oy)) return l; const t = tokens(l); t[0] = unitText(Number(t[0]) - ox, units); t[1] = unitText(Number(t[1]) - oy, units); return t.join(' '); });
  };
  // The file's line items changed: each piece as the file had it while unchanged, else Konium's (under its type), its texts likewise
  const sameSig = (key: string) => objWas[key] === objNow.get(key);
  for (const [n, o] of orig.lines.entries()) {
    const k = `L${n}`;
    if (!dirty.has(k) || o.line === undefined) continue;
    const g = groups.find((x) => x.k === k);
    const block = lines.slice(o.line, lineBlocks.get(o.line)).filter((l) => l.trim() && !l.startsWith('*REMARK*'));
    const ob = readItem(block, like.fmt.lineFlags);
    if (!ob) return null;
    const rem = `${k}.`;
    const out: string[][] = [];
    ob.pieces.forEach((pl, i) => {
      const key = `${k}.${i}`;
      if (!(key in objWas)) { if (sameSig(rem)) out.push(pl); return; }
      if (sameSig(key)) { out.push(pl); return; }
      const mine = joinPieces((g?.pieces ?? []).filter((x) => x.id === i).map((x) => x.lines)).map((x) => shifted(x, o.x, o.y));
      if (mine.length === 1) { const h = tokens(mine[0]![0]!); h[0] = tokens(pl[0]!)[0]!; mine[0]![0] = h.join(' '); }
      out.push(...mine);
    });
    let texts = ob.texts, ntext = ob.ntext;
    if (!sameSig(rem)) {
      out.push(...(g?.pieces ?? []).filter((x) => !Number.isFinite(x.id)).map((x) => shifted(x.lines, o.x, o.y)));
      texts = textsAt(g?.texts ?? [], o.x, o.y); ntext = g?.ntext ?? 0;
    }
    if (!out.length && !ntext) continue;
    const t = tokens(block[0]!);
    const head = `${t.slice(0, 4).join(' ')} ${out.length}${like.fmt.lineFlags ? ` ${t[5] ?? 0}` : ''}${ntext || ob.net ? ` ${ntext}` : ''}${ob.net ? ` ${ob.net}` : ''}`;
    addAt(o.line, [head, ...(ob.reuse ? [ob.reuse] : []), ...out.flat(), ...texts]);
  }
  // Konium's own (and its rerouted nets' copper off the routes)
  for (const g of groups) {
    if (/^L\d/.test(g.k)) continue;
    const name = unique(`${g.type === 'COPPER' ? 'CU' : g.type === 'KEEPOUT' ? 'KO' : 'DRW'}1`, names);
    const pieces = g.pieces.map((x) => x.lines);
    const head = `${name} ${g.type} 0 0 ${pieces.length}${like.fmt.lineFlags ? ' 0' : ''}${g.ntext || g.net ? ` ${g.ntext}` : ''}${g.net ? ` ${g.net}` : ''}`;
    if (!atEnd('LINES', [head, ...pieces.flat(), ...g.texts, ''])) return null;
    if (g.k === '+') objects++;
  }
  // Pours: the file's with its hatches, voids and thermals; Konium's under the pour's name, its other items by names the file hasn't
  const pourBlocks = blocks(orig, orig.pours.map((p) => p.line!).filter((l) => l !== undefined), 'POUR', lines.length);
  const pourNames = new Set(orig.pours.map((p) => p.name));
  for (const [n, po] of orig.pours.entries()) {
    const k = `P${n}`;
    if (!dirty.has(k) || po.type !== 'POUROUT') continue;
    const mine = new Set([po.name]);
    for (let grew = true; grew;) { grew = false; for (const x of orig.pours) if (!mine.has(x.name) && mine.has(x.owner)) { mine.add(x.name); grew = true; } }
    for (const x of orig.pours) if (mine.has(x.name) && x.line !== undefined) dropBlock(x.line, pourBlocks.get(x.line)!);
    if (po.line !== undefined) firstAt.set(k, po.line);
    renamed.set(k, po.name);
    for (const nm of mine) if (nm !== po.name) pourNames.delete(nm);
    objects++;
  }
  for (const p of trace.pours) {
    const k = pourKey(doc, p.polygon);
    if (!keep(k)) continue;
    const at = firstAt.get(k);
    const map = new Map<string, string>();
    const out = p.lines.map((l) => {
      const t = tokens(l);
      if (t.length < 7 || !POUR_TYPES.test(t[1] ?? '')) return l;
      if (!map.has(t[0]!)) map.set(t[0]!, t[1] === 'POUROUT' && renamed.has(k) ? renamed.get(k)! : unique(t[0]!, pourNames));
      t[0] = map.get(t[0]!)!;
      if (map.has(t[6]!)) t[6] = map.get(t[6]!)!;
      return t.join(' ');
    });
    renamed.delete(k);
    if (at !== undefined) addAt(at, out);
    else if (!atEnd('POUR', [...out, ''])) return null;
    if (k === '+P') objects++;
  }
  return { bytes: assemble(lines, replace, drop, insert, eol), moved, rerouted, objects };
}

/** A line item's lines: its type, net, pieces (each its header and corners) and texts' lines. */
function readItem(ls: string[], flags: boolean): { type: string; net: string; pieces: string[][]; texts: string[]; ntext: number; reuse?: string } | null {
  const t = tokens(ls[0] ?? '');
  if (t.length < 5) return null;
  const rest = t.slice(5);
  if (flags && rest.length) rest.shift();
  let ntext = 0, net = '';
  if (rest.length >= 2) { ntext = Number(rest[0]) || 0; net = rest[1]!; } else if (rest.length === 1) { if (/^\d+$/.test(rest[0]!)) ntext = Number(rest[0]); else net = rest[0]!; }
  const pieces: string[][] = [];
  let i = 1;
  const reuse = ls[1]?.startsWith('.REUSE.') ? ls[i++] : undefined;
  for (let k = 0, n = Number(t[4]) || 0; k < n && i < ls.length; k++) { const c = Number(tokens(ls[i]!)[1]) || 0; pieces.push(ls.slice(i, i + 1 + c)); i += 1 + c; }
  return { type: t[1]!, net, pieces, texts: ls.slice(i), ntext, reuse };
}

/**
 * Pieces Konium wrote a stretch each (open lines and copper) joined end to end where they meet, as
 * the file's polylines were; one that comes back to its start a closed line again.
 */
function joinPieces(ps: string[][]): string[][] {
  const xy = (l: string | undefined) => tokens(l ?? '').slice(0, 2).join(' ');
  const like = (a: string[], b: string[]) => a[0] === b[0] && [a[2], ...a.slice(3)].join(' ') === [b[2], ...b.slice(3)].join(' ');
  const left = ps.map((p) => ({ h: tokens(p[0] ?? ''), cs: p.slice(1) }));
  const out: string[][] = [];
  while (left.length) {
    const cur = left.shift()!;
    if (/^(OPEN|COPOPN)$/.test(cur.h[0] ?? '') && cur.cs.length) {
      for (let grew = true; grew;) {
        grew = false;
        const end = xy(cur.cs[cur.cs.length - 1]);
        let i = left.findIndex((q) => q.cs.length && like(q.h, cur.h) && xy(q.cs[0]) === end);
        if (i >= 0) { const q = left.splice(i, 1)[0]!; cur.cs = [...cur.cs.slice(0, -1), ...q.cs]; grew = true; continue; }
        const start = xy(cur.cs[0]);
        i = left.findIndex((q) => q.cs.length && like(q.h, cur.h) && xy(q.cs[q.cs.length - 1]) === start && tokens(q.cs[q.cs.length - 1]!).length === 2);
        if (i >= 0) { const q = left.splice(i, 1)[0]!; cur.cs = [...q.cs.slice(0, -1), ...cur.cs]; grew = true; }
      }
      if (cur.h[0] === 'OPEN' && cur.cs.length >= 4 && xy(cur.cs[0]) === xy(cur.cs[cur.cs.length - 1])) cur.h[0] = 'CLOSED';
    }
    cur.h[1] = String(cur.cs.length);
    out.push([cur.h.join(' '), ...cur.cs]);
  }
  return out;
}

function assemble(lines: string[], replace: Map<number, string>, drop: Set<number>, insert: Map<number, string[]>, eol: string): Uint8Array {
  const out: string[] = [];
  for (let i = 0; i <= lines.length; i++) {
    const ins = insert.get(i);
    if (ins) out.push(...ins);
    if (i === lines.length) break;
    if (drop.has(i)) continue;
    out.push(replace.get(i) ?? lines[i]!);
  }
  return binToBytes(out.join(eol));
}
