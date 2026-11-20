import { PropertyBag } from '../formats/altium/props';
import { splitTextRecords } from '../formats/altium/framing';
import { RULE_KIND_IDS, ruleKind, ruleName } from '../formats/altium/rules';
import { inPour, type PcbDocument } from './pcb';
import type { Change } from '../core/undo';

/**
 * The board's own Design Rule Checker settings and waived violations, as AD keeps them in the
 * PcbDoc: "Design Rule Checker Options6" (which rule kinds Online and Batch DRC check, by rule kind
 * number, and the violation count it stops at) and "WaivedViolations" (violations a designer
 * waived, by rule index and primitive index). AD's DRC honours both, so Konium's does too.
 */

/** AD's own Rules To Check for a board that doesn't set them (the commonest in AD 20–24 boards). */
export const AD_BATCH = [0, 1, 2, 3, 4, 5, 6, 15, 16, 18, 19, 21, 22, 23, 26, 42, 45, 46, 47, 50, 52, 53, 54, 55, 56, 60, 62, 63, 64];
export const AD_ONLINE = [0, 1, 2, 3, 4, 5, 9, 11, 15, 17, 18, 22, 23, 24, 45, 46, 47, 50, 51, 55, 60, 62];
export const AD_STOP_AT = 500;

export interface DrcSettings {
  batch: Set<string>;
  online: Set<string>;
  /** Stop after this many violations (MAXVIOLATIONCOUNT). */
  stopAt: number;
  /** Report Options: Report Drilled SMT Pads, Report Multilayer Pads with 0 size Hole. */
  drilledSmt: boolean;
  zeroHole: boolean;
  /** Verify Shorting Copper, Report Broken Planes. */
  shorting: boolean;
  brokenPlanes: boolean;
  /** Report Dead Copper larger than (sq mil). */
  deadCopper: boolean;
  deadArea: number;
  /** Report Starved Thermals with less than (percent) copper. */
  starved: boolean;
  starvedPct: number;
  /** Sub-Net Details (DOSUBNETDETAILS): an un-routed net's report lists its sub-nets. */
  subNet: boolean;
}

const kindsOfId = (id: number): string[] => Object.entries(RULE_KIND_IDS).filter(([, n]) => n === id).map(([k]) => k);
const ids = (s: string | undefined): number[] | null => (s === undefined ? null : s.split(',').map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n)));
const kinds = (list: number[]) => new Set(list.flatMap(kindsOfId));

export function drcSettings(doc: PcbDocument): DrcSettings {
  const b = doc.drcOptions;
  return {
    batch: kinds(ids(b?.get('RULESETTOCHECK')) ?? AD_BATCH),
    online: kinds(ids(b?.get('ONLINERULESETTOCHECK')) ?? AD_ONLINE),
    stopAt: b?.int('MAXVIOLATIONCOUNT', AD_STOP_AT) || AD_STOP_AT,
    drilledSmt: b ? b.bool('REPORTDRILLEDSMTPADS', true) : true,
    zeroHole: b ? b.bool('REPORTINVALIDMULTILAYERPADS', true) : true,
    shorting: b ? b.bool('VERIFYSHORTINGCOPPER', true) : true,
    brokenPlanes: b ? b.bool('REPORTBROKENPLANES', true) : true,
    deadCopper: b ? b.bool('REPORTDEADCOPPER', true) : true,
    // Internal units squared: 1e10 is 100 sq mil
    deadArea: (b ? b.float('DEADCOPPERMINAREA', 1e10) : 1e10) / 1e8,
    starved: b ? b.bool('REPORTSTARVEDTHERMALS', true) : true,
    starvedPct: b ? b.float('MINSTARVEDCOPPERPERCENT', 50) : 50,
    subNet: b ? b.bool('DOSUBNETDETAILS', true) : true,
  };
}

/** A new options record as AD writes one. */
function newOptions(): PropertyBag {
  return PropertyBag.from({
    RECORD: 'DesignRuleCheckerOptions', DOMAKEDRCFILE: 'TRUE', DOMAKEDRCERRORLIST: 'TRUE', DOSUBNETDETAILS: 'TRUE', REPORTFILENAME: '',
    EXTERNALNETLISTFILENAME: '', CHECKEXTERNALNETLIST: 'FALSE', MAXVIOLATIONCOUNT: AD_STOP_AT, REPORTDRILLEDSMTPADS: 'TRUE', REPORTINVALIDMULTILAYERPADS: 'TRUE',
    RULESETTOCHECK: AD_BATCH.join(','), ONLINERULESETTOCHECK: AD_ONLINE.join(','), INTERNALPLANEWARNINGS: 'TRUE', VERIFYSHORTINGCOPPER: 'TRUE',
    REPORTBROKENPLANES: 'TRUE', REPORTDEADCOPPER: 'TRUE', DEADCOPPERMINAREA: '10000000000.000000', REPORTSTARVEDTHERMALS: 'TRUE',
    MINSTARVEDCOPPERPERCENT: '50', REPORTSTRADLINGHOLES: 'FALSE', REPORTHOLESINVOIDS: 'FALSE',
  });
}

/** Store changed settings in the board (saved with it), as one undoable change; rule kind numbers Konium doesn't know are kept. */
export function setDrcSettings(doc: PcbDocument, s: Partial<DrcSettings>): Change {
  const before = doc.drcOptions?.clone(), wasDirty = doc.dirty.has(STORAGE);
  const b = doc.drcOptions?.clone() ?? newOptions();
  const write = (key: string, chosen: Set<string> | undefined, def: number[]) => {
    if (!chosen) return;
    const known = new Set(Object.values(RULE_KIND_IDS));
    const kept = (ids(b.get(key)) ?? def).filter((n) => !known.has(n));
    const mine = [...new Set([...chosen].map((k) => RULE_KIND_IDS[k]).filter((n): n is number => n !== undefined))];
    b.set(key, [...new Set([...mine, ...kept])].sort((x, y) => x - y).join(','));
  };
  write('RULESETTOCHECK', s.batch, AD_BATCH);
  write('ONLINERULESETTOCHECK', s.online, AD_ONLINE);
  if (s.stopAt) b.set('MAXVIOLATIONCOUNT', String(Math.max(1, Math.round(s.stopAt))));
  if (s.drilledSmt !== undefined) b.set('REPORTDRILLEDSMTPADS', s.drilledSmt ? 'TRUE' : 'FALSE');
  if (s.zeroHole !== undefined) b.set('REPORTINVALIDMULTILAYERPADS', s.zeroHole ? 'TRUE' : 'FALSE');
  const flag = (key: string, v: boolean | undefined) => { if (v !== undefined) b.set(key, v ? 'TRUE' : 'FALSE'); };
  flag('DOSUBNETDETAILS', s.subNet);
  flag('VERIFYSHORTINGCOPPER', s.shorting); flag('REPORTBROKENPLANES', s.brokenPlanes); flag('REPORTDEADCOPPER', s.deadCopper); flag('REPORTSTARVEDTHERMALS', s.starved);
  if (s.deadArea !== undefined) b.set('DEADCOPPERMINAREA', (Math.max(0, s.deadArea) * 1e8).toFixed(6));
  if (s.starvedPct !== undefined) b.set('MINSTARVEDCOPPERPERCENT', String(Math.min(100, Math.max(0, Math.round(s.starvedPct)))));
  return {
    apply() { doc.drcOptions = b.clone(); doc.dirty.add(STORAGE); },
    revert() { doc.drcOptions = before?.clone(); if (!wasDirty) doc.dirty.delete(STORAGE); },
  };
}
const STORAGE = 'Design Rule Checker Options6';

export function readDrcOptions(data: Uint8Array | undefined): PropertyBag | undefined {
  if (!data) return undefined;
  try { return splitTextRecords(data)[0]; } catch { return undefined; }
}

/* ─── Waived violations ───────────────────────────────────────────────────────────────── */

export interface Waiver {
  /** Index into Rules6. */
  rule: number;
  /** AD's object kind (Track, Arc, Pad, Via, Fill, Text, Region, PolyRegion, ComponentBody, Component, Net, DifferentialPair, Board) and its index. */
  objects: { kind: string; index: number }[];
  comment: string;
  author: string;
  created: string;
  /** The record as read (written back with its indices brought up to date). */
  bag?: PropertyBag;
  /** What the indices pointed at when read (the rule's UNIQUEID; each object's record, component, net or pair). */
  ruleId?: string;
  refs?: unknown[];
}

export function readWaivers(data: Uint8Array | undefined): Waiver[] {
  if (!data) return [];
  let bags: PropertyBag[];
  try { bags = splitTextRecords(data); } catch { return []; }
  return bags.filter((b) => b.has('RULEINDEX')).map((b) => {
    const objects: Waiver['objects'] = [];
    for (let n = 1; b.has(`PRIM${n}KIND`); n++) objects.push({ kind: b.get(`PRIM${n}KIND`)!, index: b.int(`PRIM${n}INDEX`, -1) });
    return { rule: b.int('RULEINDEX', -1), objects, comment: b.get('COMMENT') ?? '', author: b.get('AUTHORTITLE') ?? '', created: b.get('CREATEDAT') ?? '', bag: b };
  });
}

const OBJECT_STORAGE: Record<string, string> = {
  Track: 'Tracks6', Arc: 'Arcs6', Pad: 'Pads6', Via: 'Vias6', Fill: 'Fills6', Text: 'Texts6', Region: 'Regions6', PolyRegion: 'Regions6', ComponentBody: 'ComponentBodies6',
};
/** What a waiver's object index stands for in the document as read, and what holds it now. */
function objectList(doc: PcbDocument, kind: string): readonly unknown[] | null {
  const st = OBJECT_STORAGE[kind];
  if (st) return doc.streams.get(st)?.records ?? null;
  if (kind === 'Component') return doc.components;
  if (kind === 'Net') return doc.nets;
  if (kind === 'DifferentialPair') return doc.diffPairs ?? [];
  return null;
}

/** Tie each waiver to its rule (by UNIQUEID) and to its objects, so a save after edits can renumber them. */
export function bindWaivers(doc: PcbDocument): void {
  for (const w of doc.waivers ?? []) {
    w.ruleId = doc.rules[w.rule]?.bag.get('UNIQUEID');
    w.refs = w.objects.map((o) => objectList(doc, o.kind)?.[o.index]);
  }
}

/**
 * WaivedViolations as saved: null (kept as read) while nothing they point into has changed;
 * else each waiver's indices as its rule and objects stand now, a waiver whose rule or object
 * is gone dropped (a moved object is a new one to it [est: AD's own keeping]).
 */
export function waiversOut(doc: PcbDocument): PropertyBag[] | null {
  const ws = doc.waivers ?? [];
  if (!ws.length) return null;
  const touched = ['Rules6', 'Components6', 'Nets6', 'DifferentialPairs6', ...new Set(Object.values(OBJECT_STORAGE))].some((k) => doc.dirty.has(k));
  if (!touched) return null;
  const out: PropertyBag[] = [];
  for (const w of ws) {
    if (!w.bag) continue;
    const ri = w.ruleId ? doc.rules.findIndex((r) => r.bag.get('UNIQUEID') === w.ruleId) : -1;
    if (ri < 0) continue;
    const idx = w.objects.map((o, k) => (o.kind === 'Board' ? o.index : (objectList(doc, o.kind) ?? []).indexOf(w.refs?.[k] as never)));
    if (idx.some((i) => i < 0)) continue;
    const b = w.bag.clone();
    b.set('RULEINDEX', String(ri));
    idx.forEach((i, k) => b.set(`PRIM${k + 1}INDEX`, String(i)));
    out.push(b);
  }
  return out;
}

const STORAGE_KIND: Record<string, string> = {
  Tracks6: 'Track', Arcs6: 'Arc', Pads6: 'Pad', Vias6: 'Via', Fills6: 'Fill', Texts6: 'Text', Regions6: 'Region', ShapeBasedRegions6: 'Region', ComponentBodies6: 'ComponentBody',
};

/** AD's name for a primitive in a waiver: kind and index in its storage. */
function adObject(doc: PcbDocument, i: number): string | null {
  const p = doc.prims[i];
  if (!p || p.src.index < 0) return null;
  let k = STORAGE_KIND[p.src.storage];
  if (!k) return null;
  if (k === 'Region' && inPour(p)) k = 'PolyRegion';
  return `${k}:${p.src.index}`;
}

/**
 * Whether a violation was waived in AD: same rule, same objects (in either order). Objects AD
 * names that Konium doesn't report as primitives (the board, a net, a pair) don't take part.
 */
export function waiverIndex(doc: PcbDocument): (v: { kind: string; rule: string; prims: number[] }) => boolean {
  const of = waiverOf(doc);
  return (v) => of(v) !== undefined;
}

/** The waiver that covers a violation, if any. */
export function waiverOf(doc: PcbDocument): (v: { kind: string; rule: string; prims: number[] }) => Waiver | undefined {
  const ws = doc.waivers ?? [];
  if (!ws.length) return () => undefined;
  const keys = new Map<string, Waiver>();
  for (const w of ws) {
    const objs = w.objects.filter((o) => o.kind in INDEXED).map((o) => `${o.kind}:${o.index}`).sort();
    if (objs.length) keys.set(`${w.rule}|${objs.join(',')}`, w);
  }
  const ruleIndex = new Map<string, number>();
  doc.rules.forEach((r, i) => { const k = `${ruleKind(r)}|${ruleName(r)}`; if (!ruleIndex.has(k)) ruleIndex.set(k, i); });
  const pairOfNet = new Map<number, number>();
  (doc.diffPairs ?? []).forEach((b, k) => { for (const key of ['POSITIVENETNAME', 'NEGATIVENETNAME']) { const n = doc.nets.findIndex((x) => x.name === b.get(key)); if (n >= 0) pairOfNet.set(n, k); } });
  const has = (ri: number, objs: (string | null)[]) => (objs.length > 0 && objs.every((o) => o !== null) ? keys.get(`${ri}|${[...new Set(objs)].sort().join(',')}`) : undefined);
  return (v) => {
    const ri = ruleIndex.get(`${v.kind}|${v.rule}`);
    if (ri === undefined) return undefined;
    const ps = v.prims.map((i) => doc.prims[i]);
    // By the objects themselves, or (component, net and pair rules) by what they belong to
    return has(ri, v.prims.map((i) => adObject(doc, i)))
      ?? has(ri, ps.map((p) => (p && 'component' in p && p.component !== 0xffff ? `Component:${p.component}` : null)))
      ?? has(ri, ps.map((p) => (p && 'net' in p && p.net !== 0xffff ? `Net:${p.net}` : null)))
      ?? has(ri, ps.map((p) => { const k = p && 'net' in p ? pairOfNet.get(p.net) : undefined; return k === undefined ? null : `DifferentialPair:${k}`; }));
  };
}
const INDEXED: Record<string, true> = { Track: true, Arc: true, Pad: true, Via: true, Fill: true, Text: true, Region: true, PolyRegion: true, ComponentBody: true, Component: true, Net: true, DifferentialPair: true };
