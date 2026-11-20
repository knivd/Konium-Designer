/**
 * The layer stack (Design › Layer Stack Manager): overlays, solder masks, copper (signal and
 * internal plane) and the dielectrics between them, read from and written to the Board6 record.
 *
 * Board6 keeps the stack three ways, all kept in step here:
 * - legacy keys per copper layer: LAYERnPREV / LAYERnNEXT (the chain top → bottom), LAYERnNAME,
 *   LAYERnCOPTHICK and the dielectric under it as LAYERnDIELTYPE / DIELCONST / DIELHEIGHT /
 *   DIELMATERIAL; the solder masks as TOPTYPE / TOPCONST / TOPHEIGHT / TOPMATERIAL and BOTTOM…;
 * - AD17's LAYER_V8_i entries and later V9_STACK_LAYERi_ entries: one per layer in stack order
 *   (paste, overlay, solder, copper and dielectric) by 32-bit id, then the other layers.
 * DIELTYPE: 1 Core, 2 Prepreg, 3 Surface Material (solder masks). COMPONENTPLACEMENT: 0 Not
 * Allowed, 1 Top, 2 Bottom. Dielectric ids are 0x01040000 + n; coverlay layers (rigid-flex: a flex
 * stack's polyimide over its outer copper, inserted above or below a layer) 0x01050000 + n [est].
 */
import { PropertyBag } from '../formats/altium/props';
import { formerValue } from '../core/former';
import { toV7 } from '../formats/altium/pcbdoc';
import { formatAltiumLength, mil, parseLength } from '../core/units';
import type { Change } from '../core/undo';
import { L, fromV7, isPlane, isSignal, layerName, type LayerId } from './layers';
import { newGuid, stackSetNames } from '../formats/altium/board6';
import { writeSubstacks, type SubStack } from './rigidFlex';
import type { PcbDocument } from './pcb';

export type StackKind = 'paste' | 'overlay' | 'solder' | 'signal' | 'plane' | 'dielectric' | 'coverlay';

export interface StackLayer {
  kind: StackKind;
  /** The board layer; null for a dielectric. */
  layer: LayerId | null;
  /** 32-bit layer id (V7 and on). */
  v7: number;
  name: string;
  /** Signal and plane: copper thickness. */
  copper: number;
  /** Signal: 0 Not Allowed, 1 Top, 2 Bottom (component placement). */
  placement: number;
  /** Plane: pullback from the board edge. */
  pullback: number;
  /** Dielectric and solder mask. */
  dielType: number; dielMaterial: string; dielConst: number; height: number;
  /** Solder mask and coverlay: Coverlay Expansion (how far the coverlay reaches past its flex region) [est]. */
  coverlay: number;
  /** Added in this session: its id is settled on OK, new layers numbered in stack order (as AD17 does). */
  fresh?: boolean;
  /** Which of the board's layer stacks (substacks, by ID) the layer is in: its {ID}CONTEXT, 0 in, 1 out [est]. Unlisted: in. */
  subs?: Record<string, boolean>;
}

/**
 * LAYERSTACKSTYLE, the Layer Stack Manager's stack style: which dielectrics are cores and which
 * prepregs. 0 Layer Pairs (confirmed: Top-Core-L2-Prepreg-L3-Core-Bottom), 1 Internal Layer Pairs,
 * 2 Build-up [est: 1 and 2].
 */
export const STACK_STYLES: [number, string][] = [[0, 'Layer Pairs'], [1, 'Internal Layer Pairs'], [2, 'Build-up']];
/** AD17's thickness for a dielectric of a type it sets: Core 10 mil, Prepreg 5 mil (Dk 4.2, as on a new board). */
const DIEL_DEFAULT: Record<number, number> = { 1: mil(10), 2: mil(5) };

/** The dielectric type a stack style gives the n-th of k dielectrics between copper layers (0-based). */
export function styleType(style: number, n: number, k: number): 1 | 2 {
  if (style === 1) return n === 0 || n === k - 1 ? 2 : (n % 2 === 1 ? 1 : 2);   // outer prepregs, inner pairs on cores [est]
  if (style === 2) return k % 2 === 1 && n === (k - 1) / 2 ? 1 : k % 2 === 0 && (n === k / 2 - 1 || n === k / 2) && k <= 2 ? 1 : 2; // a core in the middle [est]
  return n % 2 === 0 ? 1 : 2;
}

/** The style applied: each dielectric between copper layers its style's type; one that changes type takes that type's thickness. */
export function applyStyle(rows: StackLayer[], style: number): StackLayer[] {
  const between = rows.map((r, i) => (r.kind === 'dielectric' ? i : -1)).filter((i) => i >= 0);
  return rows.map((r, i) => {
    const n = between.indexOf(i);
    if (n < 0) return r;
    const t = styleType(style, n, between.length);
    return r.dielType === t ? r : { ...r, dielType: t, height: DIEL_DEFAULT[t]! };
  });
}

/** Board6's stack style (absent: Layer Pairs). */
export const readStackStyle = (b: PropertyBag): number => b.int('LAYERSTACKSTYLE', 0);

export const DIEL_TYPES: Record<number, string> = { 0: 'None', 1: 'Core', 2: 'Prepreg', 3: 'Surface Material' };
const DIEL0 = 0x01040000;
/** Coverlay layers' ids [est]. */
export const COVERLAY0 = 0x01050000;
const len = (v: string | undefined, d = 0) => (v === undefined ? d : parseLength(v) ?? d);
const num = (v: string | undefined, d = 0) => { const n = Number(v); return Number.isFinite(n) && v !== undefined && v !== '' ? n : d; };

function kindOf(v7: number): StackKind | null {
  if (v7 > DIEL0 && v7 < DIEL0 + 0x10000) return 'dielectric';
  if (v7 > COVERLAY0 && v7 < COVERLAY0 + 0x10000) return 'coverlay';
  const l = fromV7(v7);
  if (l === undefined) return null;
  if (isSignal(l)) return 'signal';
  if (isPlane(l)) return 'plane';
  if (l === L.TOP_OVERLAY || l === L.BOTTOM_OVERLAY) return 'overlay';
  if (l === L.TOP_PASTE || l === L.BOTTOM_PASTE) return 'paste';
  if (l === L.TOP_SOLDER || l === L.BOTTOM_SOLDER) return 'solder';
  return null;
}

/* ── the V8 / V9 entry groups ── */

type Family = 'v8' | 'v9' | 'cache';
interface Entry { kv: [string, string][] }
const FAMILY_RE: Record<Family, RegExp> = { v8: /^LAYER_V8_(\d+)(.*)$/, v9: /^V9_STACK_LAYER(\d+)_(.*)$/, cache: /^V9_CACHE_LAYER(\d+)_(.*)$/ };
/** Key suffixes in a common form: substack keys as "{GUID}…", properties as "NAME". */
const canon = (f: Family, suffix: string) => (f === 'v8' && suffix.startsWith('_{') ? suffix.slice(1) : suffix);
const keyOf = (f: Family, i: number, c: string) => (f === 'v8' ? `LAYER_V8_${i}${c.startsWith('{') ? `_${c}` : c}` : f === 'v9' ? `V9_STACK_LAYER${i}_${c}` : `V9_CACHE_LAYER${i}_${c}`);

function entries(b: PropertyBag, f: Family): Entry[] {
  const out: Entry[] = [];
  for (const k of b.keys()) {
    const m = FAMILY_RE[f].exec(k);
    if (!m) continue;
    const i = Number(m[1]);
    (out[i] ??= { kv: [] }).kv.push([canon(f, m[2]!), b.get(k) ?? '']);
  }
  return out.filter(Boolean);
}
const val = (e: Entry, k: string) => e.kv.find(([c]) => c === k)?.[1];
/** Set unless it already says so (a value AD wrote with a stray CR stays as written). */
const setVal = (e: Entry, k: string, v: string) => { const i = e.kv.findIndex(([c]) => c === k); if (i < 0) e.kv.push([k, v]); else if (e.kv[i]![1].trim() !== v) e.kv[i] = [k, v]; };
const put = (b: PropertyBag, k: string, v: string) => { if ((b.get(k) ?? '').trim() !== v || !b.has(k)) b.set(k, v); };

function fromEntry(e: Entry): StackLayer | null {
  const v7 = num(val(e, 'LAYERID'));
  const kind = kindOf(v7);
  if (!kind) return null;
  return {
    kind, layer: kind === 'dielectric' || kind === 'coverlay' ? null : fromV7(v7) ?? null, v7, name: val(e, 'NAME') ?? '',
    copper: len(val(e, 'COPTHICK'), mil(1.4)), placement: num(val(e, 'COMPONENTPLACEMENT')), pullback: len(val(e, 'PULLBACKDISTANCE'), mil(20)),
    dielType: num(val(e, 'DIELTYPE')), dielMaterial: val(e, 'DIELMATERIAL') ?? '', dielConst: num(val(e, 'DIELCONST'), 4.8), height: len(val(e, 'DIELHEIGHT')),
    coverlay: len(val(e, 'COVERLAY_EXPANSION')),
    subs: Object.fromEntries(e.kv.flatMap(([c, v]) => { const m = /^(\{[^}]+\})CONTEXT$/.exec(c); return m ? [[m[1]!, v.trim() !== '1']] : []; })),
  };
}

/** The legacy chain top → bottom (LAYER1NEXT …), or the copper stack the board was read with. */
function legacyChain(b: PropertyBag, fallback: LayerId[]): LayerId[] {
  if (!b.has('LAYER1NEXT')) return fallback;
  const out: LayerId[] = [L.TOP];
  for (let cur: number = L.TOP, g = 0; g < 64; g++) {
    const n = b.int(`LAYER${cur}NEXT`);
    if (!n || out.includes(n) || n > L.PLANE16) break;
    out.push(n); cur = n;
    if (n === L.BOTTOM) break;
  }
  return out.at(-1) === L.BOTTOM ? out : fallback;
}

const blank = (kind: StackKind, layer: LayerId | null, v7: number, name: string): StackLayer =>
  ({ kind, layer, v7, name, copper: mil(1.4), placement: 0, pullback: mil(20), dielType: 0, dielMaterial: '', dielConst: 4.8, height: 0, coverlay: 0 });

/** The stack, top to bottom: from the V9 or V8 entries when the record has them, else from the legacy keys. */
export function readStack(b: PropertyBag, copperStack: LayerId[] = [L.TOP, L.BOTTOM]): StackLayer[] {
  for (const f of ['v9', 'v8'] as Family[]) {
    const rows = entries(b, f).map(fromEntry).filter((x): x is StackLayer => !!x);
    if (rows.some((r) => r.kind === 'signal')) return rows;
  }
  const chain = legacyChain(b, copperStack);
  const solder = (top: boolean): StackLayer => {
    const p = top ? 'TOP' : 'BOTTOM', l = top ? L.TOP_SOLDER : L.BOTTOM_SOLDER;
    return { ...blank('solder', l, toV7(l), layerName(l)), dielType: num(b.get(`${p}TYPE`), 3), dielConst: num(b.get(`${p}CONST`), 3.5),
      height: len(b.get(`${p}HEIGHT`), mil(0.4)), dielMaterial: b.get(`${p}MATERIAL`) ?? 'Solder Resist' };
  };
  const rows: StackLayer[] = [blank('overlay', L.TOP_OVERLAY, toV7(L.TOP_OVERLAY), layerName(L.TOP_OVERLAY)), solder(true)];
  chain.forEach((l, i) => {
    rows.push({ ...blank(isPlane(l) ? 'plane' : 'signal', l, toV7(l), b.get(`LAYER${l}NAME`) ?? layerName(l)), copper: len(b.get(`LAYER${l}COPTHICK`), mil(1.4)),
      placement: l === L.TOP ? 1 : l === L.BOTTOM ? 2 : 0 });
    if (i < chain.length - 1) {
      // (a key missing: a new AD17 board's dielectric, Core 10 mil FR-4, Dk 4.2)
      rows.push({ ...blank('dielectric', null, DIEL0 + i + 1, `Dielectric ${i + 1}`), dielType: num(b.get(`LAYER${l}DIELTYPE`), 1),
        dielConst: num(b.get(`LAYER${l}DIELCONST`), 4.2), height: len(b.get(`LAYER${l}DIELHEIGHT`), mil(10)), dielMaterial: b.get(`LAYER${l}DIELMATERIAL`) ?? 'FR-4' });
    }
  });
  rows.push(solder(false), blank('overlay', L.BOTTOM_OVERLAY, toV7(L.BOTTOM_OVERLAY), layerName(L.BOTTOM_OVERLAY)));
  return rows;
}

/** Copper layers of a stack, top to bottom. */
export const stackCopper = (rows: StackLayer[]): LayerId[] => rows.filter((r) => r.kind === 'signal' || r.kind === 'plane').map((r) => r.layer!);

/** Board thickness: copper, dielectrics and solder masks. */
export const stackThickness = (rows: StackLayer[]): number =>
  rows.reduce((t, r) => t + (r.kind === 'signal' || r.kind === 'plane' ? r.copper : r.kind === 'dielectric' || r.kind === 'solder' || r.kind === 'coverlay' ? r.height : 0), 0);

const guid = newGuid;
const L_ = (v: number) => formatAltiumLength(Math.round(v));

/** The Board6 record with the stack written into every form it keeps (see the module comment). */
export function writeStack(bag: PropertyBag, rows: StackLayer[], copperStack: LayerId[] = [L.TOP, L.BOTTOM], stackIds?: string[]): PropertyBag {
  const b = bag.clone();
  // Legacy: the copper chain, each layer's name, thickness and the dielectric under it
  const copper = rows.filter((r) => r.kind === 'signal' || r.kind === 'plane');
  const old = legacyChain(bag, copperStack);
  for (const l of old) if (!copper.some((r) => r.layer === l)) { put(b, `LAYER${l}PREV`, '0'); put(b, `LAYER${l}NEXT`, '0'); }
  copper.forEach((r, i) => {
    const l = r.layer!;
    put(b, `LAYER${l}NAME`, r.name);
    put(b, `LAYER${l}PREV`, String(copper[i - 1]?.layer ?? 0));
    put(b, `LAYER${l}NEXT`, String(copper[i + 1]?.layer ?? 0));
    put(b, `LAYER${l}COPTHICK`, L_(r.copper));
    const d = rows[rows.indexOf(r) + 1];
    if (d && d.kind === 'dielectric') {
      put(b, `LAYER${l}DIELTYPE`, String(d.dielType)); put(b, `LAYER${l}DIELCONST`, d.dielConst.toFixed(3));
      put(b, `LAYER${l}DIELHEIGHT`, L_(d.height)); put(b, `LAYER${l}DIELMATERIAL`, d.dielMaterial);
    }
  });
  for (const [r, p] of [[rows.find((x) => x.layer === L.TOP_SOLDER), 'TOP'], [rows.find((x) => x.layer === L.BOTTOM_SOLDER), 'BOTTOM']] as [StackLayer | undefined, string][]) {
    if (!r) continue;
    put(b, `${p}TYPE`, String(r.dielType)); put(b, `${p}CONST`, r.dielConst.toFixed(3)); put(b, `${p}HEIGHT`, L_(r.height)); put(b, `${p}MATERIAL`, r.dielMaterial);
  }
  // V8 / V9: the stack entries rebuilt in order (existing ones keep their other keys), then the rest
  const isStack = (e: Entry) => kindOf(num(val(e, 'LAYERID'))) !== null;
  const substacks = (all: Entry[]) => stackIds?.filter(Boolean) ?? [...new Set(all.flatMap((e) => e.kv.map(([c]) => /^(\{[^}]+\})CONTEXT$/.exec(c)?.[1]).filter((g): g is string => !!g)))];
  const fresh = (r: StackLayer, subs: string[]): Entry =>
    ({ kv: [...subs.flatMap((g) => [[`${g}CONTEXT`, '0'], [`${g}USEDBYPRIMS`, 'FALSE']] as [string, string][]), ['ID', guid()], ['NAME', r.name], ['LAYERID', String(r.v7)], ['USEDBYPRIMS', 'FALSE']] });
  /** An entry with the row's name and properties, in AD's key order. */
  const fill = (e: Entry, r: StackLayer, was?: Entry, subs?: string[]): Entry => {
    // Its place in each layer stack, first, in the stacks' order (stacks gone, their keys gone) [est: 1 out]
    if (subs) {
      const own = e.kv.filter(([c]) => !/^\{[^}]+\}(CONTEXT|USEDBYPRIMS)$/.test(c));
      const ctx = subs.flatMap((g): [string, string][] => [[`${g}CONTEXT`, r.subs?.[g] === false ? '1' : (val(e, `${g}CONTEXT`)?.trim() === '1' ? '0' : val(e, `${g}CONTEXT`) ?? '0')], [`${g}USEDBYPRIMS`, val(e, `${g}USEDBYPRIMS`) ?? 'FALSE']]);
      e.kv = [...ctx, ...own];
    }
    setVal(e, 'NAME', r.name);
    if (r.kind === 'signal' || r.kind === 'plane') setVal(e, 'COPTHICK', L_(r.copper));
    if (r.kind === 'signal') setVal(e, 'COMPONENTPLACEMENT', String(r.placement));
    if (r.kind === 'plane') setVal(e, 'PULLBACKDISTANCE', L_(r.pullback));
    if (r.kind === 'dielectric' || r.kind === 'solder' || r.kind === 'coverlay') {
      setVal(e, 'DIELTYPE', String(r.dielType)); setVal(e, 'DIELCONST', r.dielConst.toFixed(3)); setVal(e, 'DIELHEIGHT', L_(r.height)); setVal(e, 'DIELMATERIAL', r.dielMaterial);
    }
    if ((r.kind === 'solder' && (was ? val(was, 'COVERLAY_EXPANSION') !== undefined : true)) || r.kind === 'coverlay') setVal(e, 'COVERLAY_EXPANSION', L_(r.coverlay));
    return e;
  };
  const copy = (e: Entry): Entry => ({ kv: e.kv.map(([k, v]) => [k, v] as [string, string]) });
  const v9 = entries(bag, 'v9');
  for (const f of ['v8', 'v9'] as Family[]) {
    const all = f === 'v9' ? v9 : entries(bag, f);
    if (!all.length) continue;
    const subs = substacks(all);
    const built = rows.map((r) => {
      const was = all.find((e) => isStack(e) && num(val(e, 'LAYERID')) === r.v7);
      return fill(was ? copy(was) : fresh(r, subs), r, was, stackIds ? subs : undefined);
    });
    // Paste layers the stack doesn't list keep their entries, in their place at the ends
    const kept = all.filter((e) => isStack(e) && !rows.some((r) => r.v7 === num(val(e, 'LAYERID'))) && kindOf(num(val(e, 'LAYERID'))) === 'paste');
    const top = kept.filter((e) => num(val(e, 'LAYERID')) === toV7(L.TOP_PASTE)), bottom = kept.filter((e) => !top.includes(e));
    const list = [...top, ...built, ...bottom, ...all.filter((e) => !isStack(e))];
    const kv: [string, string][] = list.flatMap((e, i) => e.kv.map(([c, v]) => [keyOf(f, i, c), v] as [string, string]));
    b.replaceGroup((k) => FAMILY_RE[f].test(k), kv);
  }
  // V9 cache: its stack layers kept in step; a layer joining the stack moves to the end with the
  // stack's keys (AD17: Mid-Layer 1 and 2 left their place and came last as Signal Layer 2 and 1)
  const cache = entries(bag, 'cache');
  if (cache.length && v9.length) {
    const was = new Set(v9.filter(isStack).map((e) => num(val(e, 'LAYERID'))));
    const subs = substacks(v9);
    const at = (v7: number) => cache.findIndex((e) => num(val(e, 'LAYERID')) === v7);
    for (const r of rows) {
      const i = at(r.v7);
      if (i >= 0 && was.has(r.v7)) { cache[i] = fill(copy(cache[i]!), r, cache[i], stackIds ? subs : undefined); continue; }
      if (i >= 0) cache.splice(i, 1);
      cache.push(fill(fresh(r, subs), r, undefined, stackIds ? subs : undefined));
    }
    // A layer that leaves the stack: a dielectric goes, copper goes back to its spare entry [est]
    for (const v7 of was) {
      if (rows.some((r) => r.v7 === v7)) continue;
      const i = at(v7), kind = kindOf(v7);
      if (i < 0) continue;
      if (kind === 'dielectric') { cache.splice(i, 1); continue; }
      const l = fromV7(v7);
      if (l === undefined || (kind !== 'signal' && kind !== 'plane')) continue;
      cache[i] = { kv: [['ID', val(cache[i]!, 'ID') ?? guid()], ['NAME', layerName(l)], ['LAYERID', String(v7)], ['USEDBYPRIMS', 'FALSE'], ['COPTHICK', '1.4mil'],
        kind === 'plane' ? ['PULLBACKDISTANCE', '20mil'] : ['COMPONENTPLACEMENT', '0']] };
    }
    b.replaceGroup((k) => FAMILY_RE.cache.test(k), cache.flatMap((e, i) => e.kv.map(([c, v]) => [keyOf('cache', i, c), v] as [string, string])));
  }
  // The default layer sets (All, Signal, Plane layers) list the stack's mid-layers and planes (AD17: …,DrillDrawing,MidLayer1,MidLayer2)
  const { mids, planes } = stackSetNames(rows);
  for (let i = 1; i <= b.int('LAYERSETSCOUNT'); i++) {
    const name = (b.get(`LAYERSET${i}NAME`) ?? '').trim(), raw = b.get(`LAYERSET${i}LAYERS`);
    if (raw === undefined || !['&All Layers', '&Signal Layers', '&Plane Layers'].includes(name)) continue;
    const cr = raw.endsWith('\r') ? '\r' : '';
    const kept = raw.trim().split(',').filter((x) => x && !/^(MidLayer|InternalPlane)\d+$/.test(x));
    const list = name === '&Plane Layers' ? planes : [...kept, ...mids, ...(name === '&All Layers' ? planes : [])];
    put(b, `LAYERSET${i}LAYERS`, list.join(',') + cr);
    if (name === '&Plane Layers') put(b, `LAYERSET${i}ACTIVELAYER.7`, planes.length ? 'PLANE1' : 'UNKNOWN');
  }
  return b;
}

/** The next free "<stem> N" name. */
const nextName = (rows: StackLayer[], stem: string) => { let n = 1; while (rows.some((r) => r.name === `${stem} ${n}`)) n++; return `${stem} ${n}`; };

/**
 * A new stack row as AD17 adds it: "Signal Layer N" (or "Internal Plane N" [est]) of 1.417 mil
 * copper, components Not Allowed, on a free id (settled in stack order on OK), and "Dielectric N"
 * (Dk 4.2, no material; its type and thickness come from the stack style).
 */
export function newCopper(rows: StackLayer[], plane: boolean): { copper: StackLayer; dielectric: StackLayer } | null {
  const used = new Set(rows.map((r) => r.layer));
  const free = plane ? Array.from({ length: 16 }, (_, i) => L.PLANE1 + i) : Array.from({ length: 30 }, (_, i) => L.TOP + 1 + i);
  const l = free.find((x) => !used.has(x));
  if (l === undefined) return null;
  const n = Math.max(0, ...rows.filter((r) => r.kind === 'dielectric').map((r) => r.v7 - DIEL0)) + 1;
  return {
    copper: { ...blank(plane ? 'plane' : 'signal', l, toV7(l), nextName(rows, plane ? 'Internal Plane' : 'Signal Layer')), copper: mil(1.417), fresh: true },
    dielectric: { ...blank('dielectric', null, DIEL0 + n, nextName(rows, 'Dielectric')), dielType: 2, dielMaterial: '', dielConst: 4.2, height: mil(5), fresh: true },
  };
}

/**
 * New layers take their ids in stack order (AD17: two signal layers added, the upper one is
 * Mid-Layer 1 whatever order they came in; dielectrics likewise). Existing layers keep theirs.
 */
export function settleIds(rows: StackLayer[]): StackLayer[] {
  const out = [...rows];
  for (const kind of ['signal', 'plane', 'dielectric', 'coverlay'] as StackKind[]) {
    const at = out.map((r, i) => (r.fresh && r.kind === kind ? i : -1)).filter((i) => i >= 0);
    const ids = at.map((i) => out[i]!.v7).sort((a, b) => a - b);
    at.forEach((i, k) => { const v7 = ids[k]!; out[i] = { ...out[i]!, v7, layer: kind === 'dielectric' || kind === 'coverlay' ? null : fromV7(v7) ?? out[i]!.layer, fresh: undefined }; });
  }
  return out;
}

/**
 * Layer Stack Manager's OK: the stack written to Board6, the board's copper stack and copper
 * layer names following. One undo step.
 */
export function setStack(doc: PcbDocument, given: StackLayer[], style?: number, subs?: SubStack[]): Change {
  const bag = doc.board.bag;
  if (!bag) throw new Error('The board has no Board6 record');
  const rows = settleIds(given);
  const ids = subs?.map((x) => x.id).filter(Boolean);
  const before = bag.clone(), next = writeStack(bag, rows, doc.board.copperStack, ids?.length ? ids : undefined);
  if (subs) writeSubstacks(next, subs);
  if (style !== undefined && style !== readStackStyle(bag)) next.set('LAYERSTACKSTYLE', String(style));
  const was = { stack: doc.board.copperStack, names: new Map(doc.board.layerNames), dirty: doc.dirty.has('Board6') };
  const stack = stackCopper(rows);
  return {
    apply() {
      doc.board.bag = next.clone(); doc.board.copperStack = stack;
      for (const r of rows) if (r.layer !== null && (r.kind === 'signal' || r.kind === 'plane')) doc.board.layerNames.set(r.layer, r.name);
      doc.dirty.add('Board6');
    },
    revert() { doc.board.bag = before.clone(); doc.board.copperStack = was.stack; doc.board.layerNames = new Map(was.names); if (!was.dirty) doc.dirty.delete('Board6'); },
  };
}

/* ── Add Layer, Delete Layer, Move Up / Down (on the dialog's copy of the stack) ── */

const isCopper = (r: StackLayer | undefined) => !!r && (r.kind === 'signal' || r.kind === 'plane');

/**
 * Add Layer / Add Internal Plane: the new copper goes under the selected copper layer's
 * dielectric, its own dielectric under it (above the bottom layer when that is selected), and the
 * stack style re-types the dielectrics (AD17: Top selected twice gives Top-Core-L2-Prepreg-L3-Core-
 * Bottom, the earlier prepreg turned to a 10 mil core). Null when all ids are taken.
 */
export function addStackLayer(rows: StackLayer[], at: number, plane: boolean, style = 0): { rows: StackLayer[]; index: number } | null {
  const made = newCopper(rows, plane);
  if (!made) return null;
  let i = at;
  while (i > 0 && !isCopper(rows[i])) i--;
  if (!isCopper(rows[i])) i = rows.findIndex(isCopper);
  const out = [...rows];
  const pos = rows[i]!.layer === L.BOTTOM ? i : rows[i + 1]?.kind === 'dielectric' ? i + 2 : i + 1;
  out.splice(pos, 0, made.copper, made.dielectric);
  return { rows: applyStyle(out, style), index: pos };
}

/** Delete Layer: a copper layer other than top and bottom, with the dielectric under it; the style re-types the rest [est]. */
export function deleteStackLayer(rows: StackLayer[], at: number, style = 0): StackLayer[] | string {
  const r = rows[at];
  if (r?.kind === 'coverlay') return rows.filter((_, i) => i !== at);
  if (!isCopper(r)) return 'Select a signal layer or an internal plane to delete';
  if (r!.layer === L.TOP || r!.layer === L.BOTTOM) return 'The top and bottom layers stay';
  const out = [...rows];
  out.splice(at, rows[at + 1]?.kind === 'dielectric' ? 2 : 1);
  return applyStyle(out, style);
}

/** Move Up / Move Down: the copper layer swaps places with the copper layer above or below (not past top or bottom). */
export function moveStackLayer(rows: StackLayer[], at: number, dir: -1 | 1): { rows: StackLayer[]; index: number } | string {
  const r = rows[at];
  if (!isCopper(r) || r!.layer === L.TOP || r!.layer === L.BOTTOM) return 'Select an inner signal layer or internal plane to move';
  let j = at + dir;
  while (j >= 0 && j < rows.length && !isCopper(rows[j])) j += dir;
  const o = rows[j];
  if (!isCopper(o) || o!.layer === L.TOP || o!.layer === L.BOTTOM) return dir < 0 ? 'Already the top inner layer' : 'Already the bottom inner layer';
  const out = [...rows];
  out[at] = o!; out[j] = r!;
  return { rows: out, index: j };
}

/* ── Coverlay (rigid-flex) ── */

/**
 * Layer Stack Manager › right-click › Insert layer above / below › Coverlay: a flex stack's
 * coverlay next to the selected layer — polyimide over the flex's outer copper, in the flex stacks
 * only (the rigid ones leave it out). AD's defaults [est]: 1 mil, Dk 3.5, no expansion.
 */
export function addCoverlay(rows: StackLayer[], at: number, above: boolean, stacks: { id: string; isFlex: boolean }[]): { rows: StackLayer[]; index: number } {
  const n = 1 + Math.max(0, ...rows.filter((r) => r.kind === 'coverlay').map((r) => r.v7 - COVERLAY0));
  const pos = above ? at : at + 1;
  const copper = rows.map((r, i) => (r.kind === 'signal' || r.kind === 'plane' ? i : -1)).filter((i) => i >= 0);
  const side = pos <= (copper[0] ?? 0) ? 'Top' : pos > (copper.at(-1) ?? rows.length) ? 'Bottom' : '';
  const taken = new Set(rows.map((r) => r.name));
  let name = side ? `${side} Coverlay` : 'Coverlay';
  for (let k = 2; taken.has(name); k++) name = `${side ? `${side} ` : ''}Coverlay ${k}`;
  const row: StackLayer = { ...blank('coverlay', null, COVERLAY0 + n, name), dielType: 3, dielMaterial: 'Polyimide', dielConst: 3.5, height: mil(1), coverlay: 0, fresh: true,
    subs: Object.fromEntries(stacks.filter((x) => x.id).map((x) => [x.id, x.isFlex])) };
  const out = [...rows];
  out.splice(pos, 0, row);
  return { rows: out, index: pos };
}

/** Which face a coverlay covers: the one its copper (the nearest copper layer it sits beside, in its own stack) is on. */
export function coverlaySide(rows: StackLayer[], at: number): 'top' | 'bottom' {
  const copper = rows.map((r, i) => (r.kind === 'signal' || r.kind === 'plane' ? i : -1)).filter((i) => i >= 0);
  const mid = ((copper[0] ?? 0) + (copper.at(-1) ?? 0)) / 2;
  return at <= mid ? 'top' : 'bottom';
}

/* ── Presets, Save and Load ── */

/**
 * Layer Stack Manager › Presets: [name, the inner copper from the top down, S signal / P plane]
 * [est: AD17's names; their layer orders].
 */
export const STACK_PRESETS: [string, string][] = [
  ['Two Layer', ''],
  ['Four Layer (2 x Signal, 2 x Plane)', 'PP'],
  ['Six Layer (4 x Signal, 2 x Plane)', 'PSSP'],
  ['Eight Layer (5 x Signal, 3 x Plane)', 'PSPSSP'],
  ['Ten Layer (7 x Signal, 3 x Plane)', 'PSSPSSSP'],
  ['Twelve Layer (8 x Signal, 4 x Plane)', 'PSSPSSPSSP'],
];

/** A preset: the stack's inner copper (and the dielectric under each) replaced by the preset's, the outer layers kept; the style types the dielectrics. */
export function presetStack(rows: StackLayer[], inner: string, style = 0): StackLayer[] | string {
  const isInner = (r: StackLayer) => isCopper(r) && r.layer !== L.TOP && r.layer !== L.BOTTOM;
  let out: StackLayer[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (isInner(r)) { if (rows[i + 1]?.kind === 'dielectric') i++; continue; }
    out.push(r);
  }
  let at = out.findIndex((r) => r.layer === L.TOP);
  if (at < 0 || !out.some((r) => r.layer === L.BOTTOM)) return 'The stack needs its top and bottom layers';
  for (const ch of inner) {
    const r = addStackLayer(out, at, ch === 'P', style);
    if (!r) return 'Not enough free layers';
    out = r.rows; at = r.index;
  }
  return applyStyle(out, style);
}

/** Save...: the stack as a file of its own (Konium's JSON) [est: AD17 saves a .stackup of its own]. */
export function stackFile(rows: StackLayer[], style: number): string {
  return JSON.stringify({ konium: 'layerStack', version: 1, style, rows: rows.map((r) => { const o = { ...r }; delete o.fresh; return o; }) }, null, 1);
}
/** Load...: a stack saved by Save..., or why it can't be used. */
export function readStackFile(text: string): { rows: StackLayer[]; style: number } | string {
  let o: Record<string, unknown> & { konium?: string; style?: number; rows?: StackLayer[] };
  try { o = JSON.parse(text) as typeof o; } catch { return 'not a layer stack file'; }
  if ((o.konium ?? formerValue(o)) !== 'layerStack' || !Array.isArray(o.rows)) return 'not a layer stack file';
  const kinds = new Set<StackKind>(['paste', 'overlay', 'solder', 'signal', 'plane', 'dielectric', 'coverlay']);
  const rows = o.rows.filter((r) => r && kinds.has(r.kind) && typeof r.name === 'string' && typeof r.v7 === 'number');
  if (rows.length !== o.rows.length) return 'a layer in it is not understood';
  if (!rows.some((r) => r.layer === L.TOP) || !rows.some((r) => r.layer === L.BOTTOM)) return 'it has no top or bottom layer';
  return { rows: rows.map((r) => ({ ...r, copper: Number(r.copper) || 0, height: Number(r.height) || 0, pullback: Number(r.pullback) || 0, coverlay: Number(r.coverlay) || 0, dielConst: Number(r.dielConst) || 4.2 })), style: [0, 1, 2].includes(o.style ?? 0) ? o.style ?? 0 : 0 };
}
