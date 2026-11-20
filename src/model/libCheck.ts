/**
 * Library reports, as Altium's Reports menu in the library editors makes them: Component Rule
 * Check (.ERR), Component (.CMP) and Library List (.REP) — plain text, Altium's layout.
 */
import type { LibSymbol } from '../formats/altium/schlib';
import type { PcbDocument, PcbPrim } from './pcb';
import { L } from './layers';
import { T, copperShapes, distance } from './drc';
import { partLetter, SR, deriveObject } from './sch';
import { ELECTRICAL, natural } from './compile';
import { symbolFootprint } from './schPlace';

export interface SchCheckOptions {
  duplicateNames: boolean; duplicatePins: boolean;
  missingDescription: boolean; missingPinName: boolean; missingFootprint: boolean; missingPinNumber: boolean; missingDesignator: boolean; missingPinsInSequence: boolean;
}
export const SCH_CHECK_ALL: SchCheckOptions = {
  duplicateNames: true, duplicatePins: true, missingDescription: true, missingPinName: false, missingFootprint: false, missingPinNumber: true, missingDesignator: true, missingPinsInSequence: false,
};

type PinInfo = { designator: string; name: string; part: number; mode: number; electrical: number; hidden: boolean };
export function symbolPins(sym: LibSymbol): PinInfo[] {
  return sym.bags.flatMap((b, i) => {
    if (i === 0 || b.int('RECORD', -1) !== SR.PIN) return [];
    const o = deriveObject(b, i);
    return o.kind === 'pin' ? [{ designator: o.designator, name: o.name, part: o.ownerPartId, mode: o.ownerDisplayMode, electrical: o.electrical, hidden: o.hidden }] : [];
  });
}

/** Tools › Component Rule Check: each symbol with the problems found. */
export function schLibRuleCheck(symbols: LibSymbol[], o: SchCheckOptions): { name: string; errors: string[] }[] {
  const names = new Map<string, number>();
  for (const s of symbols) names.set(s.libRef.toLowerCase(), (names.get(s.libRef.toLowerCase()) ?? 0) + 1);
  const out: { name: string; errors: string[] }[] = [];
  for (const s of symbols) {
    const e: string[] = [];
    const comp = s.bags[0];
    const pins = symbolPins(s).filter((p) => p.mode === 0);
    if (o.duplicateNames && (names.get(s.libRef.toLowerCase()) ?? 0) > 1) e.push('Duplicate Component Name');
    if (o.duplicatePins) {
      const seen = new Map<string, number>();
      for (const p of pins) if (p.designator) seen.set(p.designator, (seen.get(p.designator) ?? 0) + 1);
      const dup = [...seen].filter(([, n]) => n > 1).map(([d]) => d).sort(natural);
      if (dup.length) e.push(`Duplicate Pins : ${dup.join(' ')}`);
    }
    if (o.missingDescription && !(comp?.get('COMPONENTDESCRIPTION') ?? s.description)) e.push('Missing Description');
    if (o.missingPinName) { const m = pins.filter((p) => !p.name.trim()).map((p) => p.designator || '?'); if (m.length) e.push(`Missing Pin Name : ${m.join(' ')}`); }
    if (o.missingFootprint && !symbolFootprint(s.bags)) e.push('Missing Footprint');
    if (o.missingPinNumber && pins.some((p) => !p.designator.trim())) e.push('Missing Pin Number');
    if (o.missingDesignator) {
      const d = s.bags.find((b) => b.int('RECORD', -1) === SR.DESIGNATOR)?.get('TEXT') ?? '';
      if (!d.trim() || d.trim() === '?') e.push('Missing Default Designator');
    }
    if (o.missingPinsInSequence) {
      const nums = [...new Set(pins.map((p) => p.designator).filter((d) => /^\d+$/.test(d)).map(Number))].sort((a, b) => a - b);
      const missing: number[] = [];
      if (nums.length) for (let n = nums[0]!; n <= nums.at(-1)!; n++) if (!nums.includes(n)) missing.push(n);
      if (missing.length) e.push(`Missing Pins in Sequence : ${missing.join(' ')}`);
    }
    if (e.length) out.push({ name: s.libRef, errors: e });
  }
  return out;
}

const col = (s: string, n: number) => (s.length >= n ? `${s} ` : s + ' '.repeat(n - s.length));

export function ruleCheckReport(libName: string, rows: { name: string; errors: string[] }[], what = 'Errors'): string {
  const lines = [`Component Rule Check Report for : ${libName}`, '', `${col('Name', 40)}${what}`, '-'.repeat(100)];
  for (const r of rows) lines.push(`${col(r.name, 40)}${r.errors.map((x) => `( ${x} )`).join(' ')}`);
  if (!rows.length) lines.push('No errors found');
  return `${lines.join('\r\n')}\r\n`;
}

/** Reports › Component (schematic library): parts, display modes and their pins. */
export function schComponentReport(sym: LibSymbol): string {
  const pins = symbolPins(sym);
  const parts = Math.max(1, sym.parts);
  const modes = Math.max(1, sym.bags[0]?.int('DISPLAYMODECOUNT', 1) ?? 1);
  const des = (sym.bags.find((b) => b.int('RECORD', -1) === SR.DESIGNATOR)?.get('TEXT') ?? 'U?');
  const lines = [`Component Name : ${sym.libRef}`, `Part Count : ${parts + 1}`, ''];
  for (let part = 1; part <= parts; part++) {
    lines.push(`Part : ${des}${parts > 1 ? partLetter(part) : ''}`);
    for (let m = 0; m < modes; m++) {
      const list = pins.filter((p) => (p.part <= 0 || p.part === part) && p.mode === m).sort((a, b) => natural(a.designator, b.designator));
      lines.push(`     Pins - (${m ? `Alternate ${m}` : 'Normal'}) : ${list.length}`);
      for (const p of list) lines.push(`          ${col(p.designator, 9)}${col(p.name, 21)}${ELECTRICAL[p.electrical] ?? ''}${p.hidden ? '  (Hidden)' : ''}`);
    }
    lines.push('');
  }
  return lines.join('\r\n');
}

/** Reports › Library List: every component (or footprint) with its description. */
export function libraryList(libName: string, rows: { name: string; description: string }[]): string {
  const lines = [`Library : ${libName}`, `Library Component Count : ${rows.length}`, '', `${col('Name', 40)}Description`, '-'.repeat(100)];
  for (const r of rows) lines.push(`${col(r.name, 40)}${r.description}`);
  return `${lines.join('\r\n')}\r\n`;
}

/** Library List as CSV (Altium writes both). */
export function libraryCsv(rows: { name: string; description: string }[]): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return `${['Name,Description', ...rows.map((r) => `${q(r.name)},${q(r.description)}`)].join('\r\n')}\r\n`;
}

/* ─── PCB libraries ─────────────────────────────────────────────────────────────────── */

export interface PcbCheckOptions {
  duplicatePads: boolean; duplicatePrimitives: boolean; duplicateFootprints: boolean; missingPadNames: boolean; offsetReference: boolean; mirrored: boolean;
  /** Copper joining pads of different names; copper that reaches no pad (copper text apart) [est: AD's wording in the report]. */
  shortedCopper?: boolean; unconnectedCopper?: boolean;
}
export const PCB_CHECK_ALL: PcbCheckOptions = { duplicatePads: true, duplicatePrimitives: true, duplicateFootprints: true, missingPadNames: true, offsetReference: false, mirrored: false, shortedCopper: true, unconnectedCopper: true };

/** A footprint's copper in pieces: each the primitives (by index) that touch on a copper layer. */
export function copperPieces(prims: PcbPrim[]): number[][] {
  const mids = [...new Set(prims.flatMap((p) => ('layer' in p && p.layer > L.TOP && p.layer < L.BOTTOM ? [p.layer] : [])))].sort((a, b) => a - b);
  const doc = { board: { copperStack: [L.TOP, ...mids, L.BOTTOM] }, polygons: [], nets: [] } as unknown as PcbDocument;
  const shapes = copperShapes(doc, prims).filter((x) => !x.role);
  const up = prims.map((_, i) => i);
  const find = (i: number): number => { while (up[i] !== i) { up[i] = up[up[i]!]!; i = up[i]!; } return i; };
  for (let a = 0; a < shapes.length; a++) {
    const A = shapes[a]!;
    for (let b = a + 1; b < shapes.length; b++) {
      const B = shapes[b]!;
      if (A.layer !== B.layer || find(A.prim) === find(B.prim) || B.minX > A.maxX + T || B.maxX < A.minX - T || B.minY > A.maxY + T || B.maxY < A.minY - T) continue;
      if (distance(A.g, B.g, T * 2) <= T) up[find(A.prim)] = find(B.prim);
    }
  }
  const has = new Set(shapes.map((x) => x.prim));
  const groups = new Map<number, number[]>();
  for (const i of has) { const r = find(i); const g = groups.get(r); if (g) g.push(i); else groups.set(r, [i]); }
  return [...groups.values()].map((g) => g.sort((a, b) => a - b));
}

const primKey = (p: PcbPrim): string | null => {
  switch (p.kind) {
    case 'track': return `t:${p.layer}:${[p.a.x, p.a.y, p.b.x, p.b.y].join(',')}:${p.width}`;
    case 'arc': return `a:${p.layer}:${p.c.x},${p.c.y}:${p.r}:${p.start}:${p.end}:${p.width}`;
    case 'pad': return `p:${p.layer}:${p.at.x},${p.at.y}:${p.name}`;
    case 'via': return `v:${p.at.x},${p.at.y}`;
    case 'fill': return `f:${p.layer}:${p.a.x},${p.a.y},${p.b.x},${p.b.y}`;
    default: return null;
  }
};

/** Layers seen from the top, where a footprint's text reads unmirrored. */
const TOP_SIDE = new Set<number>([L.TOP, L.TOP_OVERLAY, L.TOP_PASTE, L.TOP_SOLDER]);

/** Tools › Component Rule Check (PCB library): each footprint with the problems found. */
export function pcbLibRuleCheck(fps: { name: string; prims: PcbPrim[] }[], o: PcbCheckOptions): { name: string; errors: string[] }[] {
  const names = new Map<string, number>();
  for (const f of fps) names.set(f.name.toLowerCase(), (names.get(f.name.toLowerCase()) ?? 0) + 1);
  const out: { name: string; errors: string[] }[] = [];
  for (const f of fps) {
    const e: string[] = [];
    const pads = f.prims.filter((p): p is Extract<PcbPrim, { kind: 'pad' }> => p.kind === 'pad');
    if (o.duplicateFootprints && (names.get(f.name.toLowerCase()) ?? 0) > 1) e.push('Duplicate Footprint Name');
    if (o.duplicatePads) {
      const seen = new Map<string, number>();
      for (const p of pads) if (p.name) seen.set(p.name, (seen.get(p.name) ?? 0) + 1);
      const dup = [...seen].filter(([, n]) => n > 1).map(([n]) => n).sort(natural);
      if (dup.length) e.push(`Duplicate Pads : ${dup.join(' ')}`);
    }
    if (o.duplicatePrimitives) {
      const seen = new Set<string>(); let n = 0;
      for (const p of f.prims) { const k = primKey(p); if (!k) continue; if (seen.has(k)) n++; else seen.add(k); }
      if (n) e.push(`Duplicate Primitives : ${n}`);
    }
    if (o.missingPadNames && pads.some((p) => !p.name.trim())) e.push('Missing Pad Names');
    if (o.shortedCopper || o.unconnectedCopper) {
      const pieces = copperPieces(f.prims);
      if (o.shortedCopper) {
        const shorted = new Set<string>();
        for (const g of pieces) {
          const named = new Set(g.flatMap((i) => { const p = f.prims[i]!; return p.kind === 'pad' && p.name.trim() ? [p.name.trim()] : []; }));
          if (named.size > 1) for (const n of named) shorted.add(n);
        }
        if (shorted.size) e.push(`Shorted Copper : ${[...shorted].sort(natural).join(' ')}`);
      }
      if (o.unconnectedCopper) {
        const loose = pieces.filter((g) => !g.some((i) => f.prims[i]!.kind === 'pad' || f.prims[i]!.kind === 'via')).flat().filter((i) => f.prims[i]!.kind !== 'text');
        if (loose.length) e.push(`Unconnected Copper : ${loose.length}`);
      }
    }
    // A footprint is drawn from the top: text mirrored on a top-side layer reads backwards there. Text is
    // the only footprint primitive with a mirror flag (the footprint itself has none) [est: AD's wording]
    if (o.mirrored && f.prims.some((p) => p.kind === 'text' && p.mirrored && TOP_SIDE.has(p.layer))) e.push('Mirrored Component');
    if (o.offsetReference && f.prims.length) {
      const xs = f.prims.flatMap((p) => ('at' in p ? [p.at.x] : 'a' in p ? [p.a.x, p.b.x] : 'c' in p ? [p.c.x] : []));
      const ys = f.prims.flatMap((p) => ('at' in p ? [p.at.y] : 'a' in p ? [p.a.y, p.b.y] : 'c' in p ? [p.c.y] : []));
      if (xs.length && (0 < Math.min(...xs) || 0 > Math.max(...xs) || 0 < Math.min(...ys) || 0 > Math.max(...ys))) e.push('Component Reference Offset');
    }
    if (e.length) out.push({ name: f.name, errors: e });
  }
  return out;
}
