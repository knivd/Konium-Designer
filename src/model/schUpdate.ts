/**
 * Placed parts brought in line with a library symbol — Tools › Update From Libraries, the
 * library editor's Update Schematics, and Choose… in a part's properties (a different symbol).
 * The part keeps where and how it is placed (location, orientation, mirror, part, display mode,
 * unique id, locks, local colours) and its designator; graphics and pins come from the
 * library; parameters and models as the options say.
 */
import { PropertyBag } from '../formats/altium/props';
import { SR, bagOf, schCoord, type SchDocument, ownedBy } from './sch';
import { partRecords } from './schPlace';
import { identity, transformBag, type SchXform } from './schTransform';
import { addRecords, removeObjects } from './schEdit';
import type { Change } from '../core/undo';

export interface UpdateOptions {
  /** Graphics and pins from the library. */
  graphics: boolean;
  /**
   * keep: the part's own; add: and the library's it lacks; update: and the library's values for
   * those it has; replace: the library's set (values and visibility), positions kept by name.
   */
  parameters: 'keep' | 'add' | 'update' | 'replace';
  /** Footprints and other models from the library. */
  models: boolean;
}
export const UPDATE_ALL: UpdateOptions = { graphics: true, parameters: 'update', models: true };

/** What a placed part keeps of its own when its symbol changes. */
const KEEP = ['LOCATION.X', 'LOCATION.Y', 'LOCATION.X_FRAC', 'LOCATION.Y_FRAC', 'ORIENTATION', 'ISMIRRORED', 'UNIQUEID', 'INDEXINSHEET',
  'DESIGNATORLOCKED', 'PARTIDLOCKED', 'PINSMOVEABLE', 'GRAPHICALLYLOCKED', 'OVERIDECOLORS', 'SHOWHIDDENPINS', 'SHEETPARTFILENAME', 'TARGETFILENAME',
  'COMPONENTKIND', 'COMPONENTKINDVERSION2', 'COMPONENTKINDVERSION3', 'NOTUSEDBTABLENAME'];
const MODEL_RECS = new Set<number>([SR.IMPLEMENTATION_LIST, SR.IMPLEMENTATION, SR.MAP_DEFINER_LIST, SR.MAP_DEFINER, SR.IMPL_PARAMS]);

type Item = { bag: PropertyBag; owner: number };

/** The rotation and mirror (about the origin) that put a symbol where this part is. */
function placement(cb: PropertyBag): SchXform {
  const want = { o: cb.int('ORIENTATION') & 3, m: cb.bool('ISMIRRORED') };
  const at = { x: schCoord(cb, 'LOCATION.X'), y: schCoord(cb, 'LOCATION.Y') };
  const probe = PropertyBag.from({ RECORD: SR.COMPONENT });
  for (const mirrorX of [false, true]) for (let quarter = 0; quarter < 4; quarter++) {
    const x: SchXform = { ...identity(), quarter, mirrorX, d: at };
    const t = transformBag(probe, x);
    if ((t.int('ORIENTATION') & 3) === want.o && t.bool('ISMIRRORED') === want.m) return x;
  }
  return { ...identity(), d: at };
}

/**
 * The records the part at `ci` becomes (the component first, children owning by position) and
 * the objects it replaces (itself and everything it owns). Null if `ci` isn't a part.
 */
export function updatedPart(doc: SchDocument, ci: number, symbol: { libRef: string; bags: PropertyBag[] }, libraryName: string, opts: UpdateOptions = UPDATE_ALL): { remove: number[]; items: Item[] } | null {
  const comp = doc.objects[ci];
  const cb = comp ? bagOf(doc, comp) : undefined;
  if (comp?.kind !== 'component' || !cb) return null;
  const lib = partRecords(symbol, libraryName, 1);
  if (!lib.length) return null;
  const x = placement(cb);

  // The part's own records, classified (nested model records follow their list)
  const owned: number[] = [];
  const kids = ownedBy(doc);
  const visit = (i: number) => { for (const o of kids.get(i) ?? []) { owned.push(o.index); visit(o.index); } };
  visit(ci);
  owned.sort((a, b) => a - b);
  const rec = (i: number) => doc.objects[i]!.record;
  // A model's records and whatever is under them (a simulation model's own parameters are under its
  // parameter list): they stay with their model, the part's or the library's, and are never taken for graphics
  const modelish = new Set<number>();
  for (const i of owned) if (MODEL_RECS.has(rec(i)) || modelish.has(doc.objects[i]!.owner)) modelish.add(i);
  const isModel = (i: number) => modelish.has(i);
  const own = {
    designator: owned.filter((i) => rec(i) === SR.DESIGNATOR && doc.objects[i]!.owner === ci),
    params: owned.filter((i) => rec(i) === SR.PARAMETER && doc.objects[i]!.owner === ci),
    models: owned.filter(isModel),
    graphics: owned.filter((i) => !isModel(i) && rec(i) !== SR.DESIGNATOR && !(rec(i) === SR.PARAMETER && doc.objects[i]!.owner === ci)),
  };
  const libKind = (it: Item) => it.bag.int('RECORD', -1);
  const libModel = new Set<number>();
  lib.forEach((it, k) => { if (k && (MODEL_RECS.has(libKind(it)) || libModel.has(it.owner))) libModel.add(k); });
  const libParams = lib.slice(1).filter((it) => libKind(it) === SR.PARAMETER && it.owner === 0);
  const nameOf = (b: PropertyBag) => (b.get('NAME') ?? '').toLowerCase();

  // The component: the library's, with the part's placement and instance settings
  const nc = lib[0]!.bag.clone();
  for (const k of KEEP) { const v = cb.getRaw(k); if (v !== undefined) nc.setRaw(k, v); else nc.delete(k); }
  if (cb.bool('OVERIDECOLORS')) for (const k of ['COLOR', 'AREACOLOR']) { const v = cb.getRaw(k); if (v !== undefined) nc.setRaw(k, v); }
  const parts = Math.max(1, nc.int('PARTCOUNT', 2) - 1), modes = Math.max(1, nc.int('DISPLAYMODECOUNT', 1));
  nc.set('CURRENTPARTID', String(Math.min(parts, Math.max(1, cb.int('CURRENTPARTID', 1)))));
  const mode = Math.min(modes - 1, cb.int('DISPLAYMODE'));
  if (mode > 0) nc.set('DISPLAYMODE', String(mode)); else nc.delete('DISPLAYMODE');
  if (!opts.graphics) for (const k of ['LIBREFERENCE', 'DESIGNITEMID', 'SOURCELIBRARYNAME', 'PARTCOUNT', 'DISPLAYMODECOUNT']) { const v = cb.getRaw(k); if (v !== undefined) nc.setRaw(k, v); }

  const out: Item[] = [{ bag: nc, owner: -1 }];
  const fromLib = (it: Item, at: Map<number, number>, model = false) => {
    const b = model ? it.bag.clone() : transformBag(it.bag, x);
    out.push({ bag: b, owner: it.owner === 0 ? 0 : at.get(it.owner) ?? 0 });
  };
  /** Old records kept: owners re-pointed to their new positions. */
  const keep = (list: number[]) => {
    const pos = new Map<number, number>();
    for (const i of list) {
      const o = doc.objects[i]!;
      pos.set(i, out.length);
      const b = bagOf(doc, o)!.clone();
      b.delete('OWNERINDEX');
      out.push({ bag: b, owner: o.owner === ci ? 0 : pos.get(o.owner) ?? 0 });
    }
  };

  // Designator: the part's (or the library's if it had none)
  if (own.designator.length) keep(own.designator);
  else for (const it of lib.slice(1)) if (libKind(it) === SR.DESIGNATOR) fromLib(it, new Map());

  // Parameters
  const libByName = new Map(libParams.map((it) => [nameOf(it.bag), it]));
  const ownNames = new Set(own.params.map((i) => nameOf(bagOf(doc, doc.objects[i]!)!)));
  for (const i of own.params) {
    const b = bagOf(doc, doc.objects[i]!)!;
    const l = libByName.get(nameOf(b));
    if (opts.parameters === 'replace' && !l) continue;
    const kept = b.clone();
    kept.delete('OWNERINDEX');
    if (l && (opts.parameters === 'update' || opts.parameters === 'replace')) {
      const v = l.bag.get('TEXT');
      if (v !== undefined) kept.set('TEXT', v); else { kept.delete('TEXT'); kept.delete('%UTF8%TEXT'); }
      if (opts.parameters === 'replace') { if (l.bag.bool('ISHIDDEN')) kept.set('ISHIDDEN', 'T'); else kept.delete('ISHIDDEN'); }
    }
    out.push({ bag: kept, owner: 0 });
  }
  if (opts.parameters !== 'keep') for (const it of libParams) if (!ownNames.has(nameOf(it.bag))) fromLib(it, new Map());

  // Graphics and pins
  const libAt = new Map<number, number>();
  if (opts.graphics) {
    lib.forEach((it, k) => {
      if (k === 0 || libKind(it) === SR.DESIGNATOR || (libKind(it) === SR.PARAMETER && it.owner === 0) || libModel.has(k)) return;
      libAt.set(k, out.length);
      fromLib(it, libAt);
    });
  } else keep(own.graphics);

  // Models
  if (opts.models) {
    lib.forEach((it, k) => { if (!libModel.has(k)) return; libAt.set(k, out.length); fromLib(it, libAt, true); });
  } else keep(own.models);

  return { remove: [ci, ...owned], items: out };
}

/** Where a part came from: its library (by name) and symbol. */
export function partSource(doc: SchDocument, ci: number): { library: string; libRef: string } | null {
  const o = doc.objects[ci];
  const b = o ? bagOf(doc, o) : undefined;
  if (o?.kind !== 'component' || !b) return null;
  // Library Name unticked (USELIBRARYNAME=F): any library
  const lib = !b.has('USELIBRARYNAME') || b.bool('USELIBRARYNAME') ? b.get('SOURCELIBRARYNAME') ?? '' : '';
  return { library: lib === '*' ? '' : lib, libRef: b.get('LIBREFERENCE') ?? b.get('DESIGNITEMID') ?? '' };
}

/** Replace parts (as updatedPart worked them out) in one step: the old records go, the new ones join at the end. */
export function applyPartUpdates(doc: SchDocument, results: { remove: number[]; items: Item[] }[]): Change {
  const remove = removeObjects(doc, results.flatMap((r) => r.remove));
  let adds: Change[] | null = null;
  return {
    apply() {
      remove.apply();
      if (adds) { for (const a of adds) a.apply(); return; }
      adds = [];
      for (const r of results) {
        const base = doc.records.length - 1;
        const bags = r.items.map((it) => { const b = it.bag.clone(); if (it.owner >= 0) b.setRaw('OWNERINDEX', String(base + it.owner)); else b.delete('OWNERINDEX'); return b; });
        const a = addRecords(doc, bags);
        a.apply();
        adds.push(a);
      }
    },
    revert() { for (const a of [...(adds ?? [])].reverse()) a.revert(); remove.revert(); },
  };
}
