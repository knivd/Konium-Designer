/**
 * Design › Update PCB Document: compare the compiled schematics with the board and turn every
 * difference into an Engineering Change Order item, grouped as Altium groups them:
 *   Add Components · Add Nets · Add Pins To Nets · Remove Pins From Nets · Change Component
 *   Designators · Change Component Footprints · Change Component Comments · Remove Components
 * Components match by unique ID (schematic UNIQUEID = PCB SOURCEUNIQUEID), then by designator.
 * New components are placed from the project's footprint libraries in a row to the right of
 * the board, as Altium drops them beside it for placement.
 */
import type { Change } from '../core/undo';
import type { BBox, Vec2 } from '../core/geom';
import { mil, mm, formatAltiumLength, parseLength } from '../core/units';
import { natural, type CompiledProject, type CompiledComponent } from './compile';
import { NO_NET, type PcbDocument } from './pcb';
import { L } from './layers';
import { PropertyBag } from '../formats/altium/props';
import { PAD, TEXT, put } from '../formats/altium/pcbLayouts';
import { PCB_TAG, type PcbRawRecord } from '../formats/altium/framing';
import { componentFromBag, encodeText, rebuildPrims } from '../formats/altium/pcbdoc';
import { footprintBounds, placeRecord, placeable, storageFor, type Footprint } from '../formats/altium/pcblib';
import { binToBytes } from '../formats/text';
import { placement, transformRecord } from '../formats/altium/pcbTransform';
import { bodyComponent, newNetBag, removeComponents, replaceRules } from './pcbEdit';
import { componentExtent, editRooms, newRoom, roomsOf, wrapOutline } from './rooms';
import { classBag, setClasses } from './pcbClasses';
import { RULE_KINDS, cloneRule, kindLabel, newRule, nextRuleName, rulePriority, ruleKind, type PcbRule } from '../formats/altium/rules';
import { carriedRules } from './schRules';
import { bagDefaults } from './bagDefaults';
import { isWireLinkComponent } from './wireLink';

const lenOf = (v: string | undefined, d: number) => { const c = parseLength(v); return c !== undefined && c > 0 ? Math.round(c) : d; };

export interface FoundFootprint { library: string; footprint: Footprint }
/** A footprint by name; with `library` (a model's MODELDATAFILE0, a name or a path) only in that library. */
export type FootprintFinder = (pattern: string, library?: string) => FoundFootprint | undefined;

/** Whether a library (by its file name) is the one a model names: a library name, or a path ending in it. */
export function isModelLibrary(libName: string, file: string): boolean {
  const base = file.split(/[\\/]/).pop() ?? file;
  return base.toLowerCase() === libName.toLowerCase();
}

/** How "Footprint Not Found" reads when the model names its library. */
const notFound = (c: CompiledComponent) => `Footprint Not Found ${c.footprint}${c.footprintLibrary ? ` in ${c.footprintLibrary}` : ''}`;

export type PcbEcoItem =
  | { kind: 'addComponent'; group: 'Add Components'; action: 'Add'; object: string; comp: CompiledComponent; at?: Vec2 }
  | { kind: 'addNet'; group: 'Add Nets'; action: 'Add'; object: string; net: string }
  | { kind: 'addPin'; group: 'Add Pins To Nets'; action: 'Add'; object: string; designator: string; pad: string; net: string }
  | { kind: 'removePin'; group: 'Remove Pins From Nets'; action: 'Remove'; object: string; designator: string; pad: string; net: string }
  | { kind: 'changeDesignator'; group: 'Change Component Designators'; action: 'Modify'; object: string; index: number; from: string; to: string }
  | { kind: 'changeFootprint'; group: 'Change Component Footprints'; action: 'Modify'; object: string; index: number; designator: string; from: string; to: string }
  | { kind: 'changeComment'; group: 'Change Component Comments'; action: 'Modify'; object: string; index: number; designator: string; from: string; to: string }
  | { kind: 'removeComponent'; group: 'Remove Components'; action: 'Remove'; object: string; designator: string }
  | { kind: 'addClass'; group: 'Add Component Classes'; action: 'Add'; object: string; name: string; members: string[] }
  | { kind: 'addRoom'; group: 'Add Rooms'; action: 'Add'; object: string; name: string; members: string[] }
  | { kind: 'addRule'; group: 'Add Rules'; action: 'Add'; object: string; scope: string; bag: PropertyBag };

const ORDER = ['Add Components', 'Add Nets', 'Change Component Designators', 'Change Component Footprints', 'Change Component Comments', 'Add Pins To Nets', 'Remove Pins From Nets', 'Add Component Classes', 'Add Rooms', 'Add Rules', 'Remove Components'];

/** SOURCEUNIQUEID is a sheet path like \ABCDEFGH (or \SHEETID\ABCDEFGH): the last part is the component's. */
const uidOf = (s: string | undefined) => (s ?? '').split('\\').filter(Boolean).at(-1) ?? '';
/** The whole path (a multi-channel part's: its channel's symbols, then its own ID). */
const uidPath = (s: string | undefined) => (s ?? '').split('\\').filter(Boolean).join('\\');

/** The text of a board component's comment (its comment string), or null when it has none. */
export function pcbComment(doc: PcbDocument, index: number): string | null {
  for (const p of doc.prims) if (p.kind === 'text' && p.isComment && p.component === index) return p.text;
  return null;
}

/** The schematic's parts that go to the board (not graphical, annotated). */
export const boardParts = (project: CompiledProject): CompiledComponent[] =>
  project.components.filter((c) => c.kind !== 2 && c.designator && !c.designator.endsWith('?'));

/**
 * Which board component each schematic part is: by unique ID (SOURCEUNIQUEID), then by
 * designator for parts whose ID the board doesn't know. Schematic designator → component index.
 */
export function matchComponents(project: CompiledProject, doc: PcbDocument): Map<string, number> {
  const sch = boardParts(project);
  const pcbByUid = new Map(doc.components.filter((c) => uidOf(c.bag.get('SOURCEUNIQUEID'))).map((c) => [uidOf(c.bag.get('SOURCEUNIQUEID')), c]));
  const pcbByPath = new Map(doc.components.filter((c) => uidPath(c.bag.get('SOURCEUNIQUEID'))).map((c) => [uidPath(c.bag.get('SOURCEUNIQUEID')), c]));
  const schUids = new Set(sch.map((c) => uidOf(c.uniqueId)).filter(Boolean));
  const matched = new Map<string, number>();
  const pcbUsed = new Set<number>();
  for (const c of sch) {
    // A channel's part by its whole path (the channels share the part's own ID), others by their own ID
    const pc = !c.uniqueId ? undefined : c.uniqueId.includes('\\') ? pcbByPath.get(c.uniqueId) : pcbByUid.get(c.uniqueId);
    if (pc && !pcbUsed.has(pc.index)) { matched.set(c.designator, pc.index); pcbUsed.add(pc.index); }
  }
  for (const c of sch) {
    if (matched.has(c.designator)) continue;
    const pc = doc.components.find((p) => p.designator === c.designator && !pcbUsed.has(p.index) && !schUids.has(uidOf(p.bag.get('SOURCEUNIQUEID'))));
    if (pc) { matched.set(c.designator, pc.index); pcbUsed.add(pc.index); }
  }
  return matched;
}

export function planPcbUpdate(project: CompiledProject, doc: PcbDocument, find: FootprintFinder): PcbEcoItem[] {
  const out: PcbEcoItem[] = [];
  const sch = boardParts(project);
  const schByDesig = new Map(sch.map((c) => [c.designator, c]));
  const matched = matchComponents(project, doc); // schematic designator → PCB component index
  const pcbUsed = new Set(matched.values());

  // Components
  for (const c of sch) {
    const idx = matched.get(c.designator);
    if (idx === undefined) { out.push({ kind: 'addComponent', group: 'Add Components', action: 'Add', object: c.designator, comp: c }); continue; }
    const pc = doc.components[idx]!;
    if (pc.designator !== c.designator) out.push({ kind: 'changeDesignator', group: 'Change Component Designators', action: 'Modify', object: `${pc.designator} -> ${c.designator}`, index: idx, from: pc.designator, to: c.designator });
    if (c.footprint && pc.pattern.toLowerCase() !== c.footprint.toLowerCase()) {
      out.push({ kind: 'changeFootprint', group: 'Change Component Footprints', action: 'Modify', object: `${c.designator}: ${pc.pattern} -> ${c.footprint}`, index: idx, designator: pc.designator, from: pc.pattern, to: c.footprint });
    }
    const comment = pcbComment(doc, idx);
    if (comment !== null && comment !== c.comment) {
      out.push({ kind: 'changeComment', group: 'Change Component Comments', action: 'Modify', object: `${c.designator}: ${comment} -> ${c.comment}`, index: idx, designator: pc.designator, from: comment, to: c.comment });
    }
  }
  for (const pc of doc.components) {
    // A Graphical component placed on the board alone (a logo) isn't the schematic's to remove [est], nor a wire link (Place › Wire Link)
    if (!pcbUsed.has(pc.index) && pc.designator && !(pc.bag.int('COMPONENTKIND') === 2 && !pc.bag.get('SOURCEUNIQUEID')) && !(isWireLinkComponent(pc) && !pc.bag.get('SOURCEUNIQUEID'))) out.push({ kind: 'removeComponent', group: 'Remove Components', action: 'Remove', object: pc.designator, designator: pc.designator });
  }

  // Nets and pins
  const pcbNets = new Set(doc.nets.map((n) => n.name));
  const pinNet = new Map<string, string>(); // "R1\u0000 1" → net
  const live = (des: string) => schByDesig.has(des);
  for (const n of project.nets) {
    const pins = n.pins.filter((p) => live(p.designator));
    if (!pins.length) continue;
    if (!pcbNets.has(n.name)) out.push({ kind: 'addNet', group: 'Add Nets', action: 'Add', object: n.name, net: n.name });
    for (const p of pins) pinNet.set(`${p.designator}\u0000${p.pin}`, n.name);
  }
  // Pads now on the board, keyed by the schematic designator of their component
  const pads = new Map<string, string>(); // key → current net name ('' = No Net)
  const toSch = new Map<number, string>([...matched].map(([d, i]) => [i, d]));
  for (const p of doc.prims) {
    if (p.kind !== 'pad' || p.component === NO_NET || !p.name) continue;
    const des = toSch.get(p.component);
    if (!des) continue;
    // Pads of one name (a thermal pad in several pieces) are one pin: on two nets, it needs setting
    const key = `${des}\u0000${p.name}`, net = p.net === NO_NET ? '' : doc.nets[p.net]?.name ?? '';
    const had = pads.get(key);
    pads.set(key, had === undefined || had === net ? net : '\u0001');
  }
  for (const [key, net] of pinNet) {
    const [des, pin] = key.split('\u0000') as [string, string];
    if (matched.has(des) && pads.get(key) === net) continue;
    out.push({ kind: 'addPin', group: 'Add Pins To Nets', action: 'Add', object: `${des}-${pin} to ${net}`, designator: des, pad: pin, net });
  }
  for (const [key, net] of pads) {
    if (!net || net === '\u0001' || pinNet.has(key)) continue;
    const [des, pin] = key.split('\u0000') as [string, string];
    out.push({ kind: 'removePin', group: 'Remove Pins From Nets', action: 'Remove', object: `${des}-${pin} from ${net}`, designator: des, pad: pin, net });
  }

  // Multi-channel: a component class and a room for each channel, the room around its parts [est]
  const channels = new Map<string, string[]>();
  for (const c of sch) if (c.channel) channels.set(c.channel, [...(channels.get(c.channel) ?? []), c.designator]);
  const rooms = new Set(roomsOf(doc).map((r) => r.name.toLowerCase()));
  for (const [room, members] of [...channels].sort((a, b) => natural(a[0], b[0]))) {
    if (!doc.classes.some((k) => k.kind === 1 && k.name.toLowerCase() === room.toLowerCase())) out.push({ kind: 'addClass', group: 'Add Component Classes', action: 'Add', object: room, name: room, members });
    if (!rooms.has(room.toLowerCase())) out.push({ kind: 'addRoom', group: 'Add Rooms', action: 'Add', object: `${room} (Scope=InComponentClass('${room}'))`, name: room, members });
  }

  // Design rules from the schematic's parameters (Parameter Sets on nets, components' Rule parameters), each once:
  // not when the board has a rule of that kind with that scope already
  const has = new Set(doc.rules.map((r) => `${ruleKind(r)}|${(r.bag.get('SCOPE1EXPRESSION') ?? '').replace(/\s+/g, '')}`.toLowerCase()));
  for (const r of carriedRules(project)) {
    const kind = r.bag.get('RULEKIND')!, key = `${kind}|${r.scope.replace(/\s+/g, '')}`.toLowerCase();
    if (has.has(key)) continue;
    has.add(key);
    out.push({ kind: 'addRule', group: 'Add Rules', action: 'Add', object: `${kindLabel(kind)} (${r.scope})`, scope: r.scope, bag: r.bag });
  }

  // Placement of new parts: a row to the right of the board, 2.5 mm apart
  const ob = boardBox(doc);
  let x = ob.maxX + mm(5), rowTop = ob.maxY;
  for (const it of out) {
    if (it.kind !== 'addComponent') continue;
    const f = it.comp.footprint ? find(it.comp.footprint, it.comp.footprintLibrary) : undefined;
    if (!f) continue;
    const b = footprintBounds(f.footprint);
    it.at = { x: snap(x - b.minX), y: snap(rowTop - b.maxY) };
    x += b.maxX - b.minX + mm(2.5);
  }
  return out.sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group) || natural(a.object, b.object));
}

const snap = (v: number) => Math.round(v / mil(5)) * mil(5);

function boardBox(doc: PcbDocument): BBox {
  const pts = doc.board.outline.length ? doc.board.outline : doc.prims.flatMap((p) => ('at' in p ? [p.at] : 'a' in p ? [p.a, p.b] : []));
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of pts) { b.minX = Math.min(b.minX, p.x); b.minY = Math.min(b.minY, p.y); b.maxX = Math.max(b.maxX, p.x); b.maxY = Math.max(b.maxY, p.y); }
  return b.minX <= b.maxX ? b : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}

/* ─── Validation (Altium's ECO wording) ──────────────────────────────────────────────── */

export function validateItem(doc: PcbDocument, it: PcbEcoItem, plan: PcbEcoItem[], find: FootprintFinder): string | null {
  const planned = (des: string) => plan.some((p) => p.kind === 'addComponent' && p.object === des);
  switch (it.kind) {
    case 'addComponent':
      if (!it.comp.footprint) return 'Footprint Not Found (no footprint model on the schematic component)';
      if (!find(it.comp.footprint, it.comp.footprintLibrary)) return notFound(it.comp);
      if (doc.components.some((c) => c.designator === it.object)) return `Component ${it.object} already exists`;
      return null;
    case 'addNet':
      return doc.nets.some((n) => n.name === it.net) ? `Net ${it.net} already exists` : null;
    case 'addPin': {
      const comp = doc.components.find((c) => c.designator === it.designator);
      if (!comp) {
        const p = plan.find((x) => x.kind === 'addComponent' && x.object === it.designator);
        if (!p || p.kind !== 'addComponent') return `Unknown Component ${it.designator}`;
        const f = p.comp.footprint ? find(p.comp.footprint, p.comp.footprintLibrary) : undefined;
        if (!f) return `Unknown Component ${it.designator}`;
        return f.footprint.prims.some((q) => q.kind === 'pad' && q.name === it.pad) ? null : `Unknown Pin: Pin ${it.designator}-${it.pad}`;
      }
      if (!doc.prims.some((q) => q.kind === 'pad' && q.component === comp.index && q.name === it.pad)) return `Unknown Pin: Pin ${it.designator}-${it.pad}`;
      if (!doc.nets.some((n) => n.name === it.net) && !plan.some((x) => x.kind === 'addNet' && x.net === it.net)) return `Unknown Net ${it.net}`;
      return null;
    }
    case 'removePin': return null;
    case 'changeDesignator':
      if (!doc.components[it.index]) return `Unknown Component ${it.from}`;
      // Taken unless the one that has it is renamed too (designators swapped)
      return doc.components.some((c) => c.designator === it.to && c.index !== it.index) && !planned(it.to)
        && !plan.some((x) => x.kind === 'changeDesignator' && x.from === it.to && x.index !== it.index) ? `Component ${it.to} already exists` : null;
    case 'changeFootprint':
      if (!doc.components[it.index]) return `Unknown Component ${it.designator}`;
      return find(it.to) ? null : `Footprint Not Found ${it.to}`;
    case 'changeComment':
      if (!doc.components[it.index]) return `Unknown Component ${it.designator}`;
      return pcbComment(doc, it.index) === null ? `${it.designator} has no comment text` : null;
    case 'removeComponent': return doc.components.some((c) => c.designator === it.designator) ? null : `Unknown Component ${it.designator}`;
    case 'addClass': return doc.classes.some((k) => k.kind === 1 && k.name === it.name) ? `Component Class ${it.name} already exists` : null;
    case 'addRoom': return roomsOf(doc).some((r) => r.name === it.name) ? `Room ${it.name} already exists` : null;
    case 'addRule': return RULE_KINDS.some((k) => k.kind === it.bag.get('RULEKIND')) || ruleKind({ bag: it.bag } as PcbRule) ? null : 'Unknown rule kind';
  }
}

/* ─── Changes ────────────────────────────────────────────────────────────────────────── */

/** Components6 properties for a footprint placed at `at`, as Altium writes a new component. */
export function componentBag(at: Vec2, f: FoundFootprint, c: { designator: string; libRef?: string; description?: string; uniqueId?: string; kind?: number }): PropertyBag {
  const len = formatAltiumLength;
  return PropertyBag.from({
    SELECTION: 'FALSE', LAYER: 'TOP', LOCKED: 'FALSE', POLYGONOUTLINE: 'FALSE', USERROUTED: 'TRUE', KEEPOUT: 'FALSE', UNIONINDEX: '0', PRIMITIVELOCK: 'TRUE',
    X: len(at.x), Y: len(at.y), PATTERN: f.footprint.name, NAMEON: bagDefaults('Component').NAMEON!, COMMENTON: bagDefaults('Component').COMMENTON!, GROUPNUM: '0', COUNT: '0',
    ROTATION: ' 0.00000000000000E+0000', HEIGHT: f.footprint.height || '0mil', NAMEAUTOPOSITION: '1', COMMENTAUTOPOSITION: '1',
    SOURCEDESIGNATOR: c.designator, SOURCEUNIQUEID: c.uniqueId ? `\\${c.uniqueId}` : '', SOURCEHIERARCHICALPATH: '',
    SOURCEFOOTPRINTLIBRARY: f.library, SOURCECOMPONENTLIBRARY: '', SOURCELIBREFERENCE: c.libRef ?? '', SOURCEDESCRIPTION: c.description ?? '',
    FOOTPRINTDESCRIPTION: f.footprint.description, COMPONENTKIND: String(c.kind ?? 0), CHANNELOFFSET: '-1',
  });
}

/**
 * Place › Component on a board: the footprint as a component at the origin with its designator
 * above and comment below (hidden), ready to follow the cursor like a paste.
 */
export function footprintComponent(f: FoundFootprint, designator: string, comment: string): { bag: PropertyBag; records: { storage: string; rec: PcbRawRecord }[] } {
  const bag = componentBag({ x: 0, y: 0 }, f, { designator });
  const b = footprintBounds(f.footprint);
  const records = f.footprint.records.filter(placeable).map((r) => ({ storage: storageFor(r.tag), rec: placeRecord(r, 0, 0, 0) }));
  // Preferences › Defaults › Component: the strings' sizes
  const cd = bagDefaults('Component'), h = lenOf(cd.DESIGNATORHEIGHT, mil(60)), w = lenOf(cd.DESIGNATORWIDTH, mil(10)), ch = lenOf(cd.COMMENTHEIGHT, mil(60)), cw = lenOf(cd.COMMENTWIDTH, mil(10));
  records.push({ storage: 'Texts6', rec: encodeText({ layer: L.TOP_OVERLAY, at: { x: b.minX, y: b.maxY + mil(15) }, height: h, strokeWidth: w, text: designator, component: 0, isDesignator: true }) });
  records.push({ storage: 'Texts6', rec: encodeText({ layer: L.TOP_OVERLAY, at: { x: b.minX, y: b.minY - mil(15) - ch }, height: ch, strokeWidth: cw, text: comment, component: 0, isComment: true }) });
  return { bag, records };
}

function recordsOf(doc: PcbDocument, storage: string): PcbRawRecord[] {
  let s = doc.streams.get(storage);
  if (!s) { s = { storage, records: [] }; doc.streams.set(storage, s); }
  return s.records;
}

function dirtyGuard(doc: PcbDocument, keys: string[]): () => void {
  const was = keys.filter((k) => doc.dirty.has(k));
  return () => { for (const k of keys) if (!was.includes(k)) doc.dirty.delete(k); };
}

/** The undoable edit for one ECO item. Throws (with Altium's wording) when it can't be done now. */
export function itemChange(doc: PcbDocument, it: PcbEcoItem, find: FootprintFinder): Change {
  switch (it.kind) {
    case 'addNet': {
      const bag = newNetBag(it.net);
      const restore = dirtyGuard(doc, ['Nets6']);
      return {
        apply() { doc.nets.push({ index: doc.nets.length, name: it.net, bag }); doc.dirty.add('Nets6'); },
        revert() { doc.nets.pop(); restore(); },
      };
    }
    case 'addComponent': {
      const f = it.comp.footprint ? find(it.comp.footprint, it.comp.footprintLibrary) : undefined;
      if (!f) throw new Error(notFound(it.comp));
      const at = it.at ?? doc.board.origin;
      const c = it.comp;
      const bag = componentBag(at, f, c);
      const b = footprintBounds(f.footprint);
      const added = new Map<string, number>();
      const restore = dirtyGuard(doc, ['Components6', 'Pads6', 'Tracks6', 'Arcs6', 'Fills6', 'Texts6', 'Regions6', 'Vias6']);
      return {
        apply() {
          const index = doc.components.length;
          doc.components.push(componentFromBag(bag, index));
          doc.dirty.add('Components6');
          const push = (storage: string, rec: PcbRawRecord) => { recordsOf(doc, storage).push(rec); added.set(storage, (added.get(storage) ?? 0) + 1); doc.dirty.add(storage); };
          for (const rec of f.footprint.records) {
            if (!placeable(rec)) continue;
            push(storageFor(rec.tag), placeRecord(rec, at.x, at.y, index));
          }
          // Designator above the footprint, comment below it (hidden: COMMENTON=FALSE), as Altium adds them
          const cd = bagDefaults('Component'), h = lenOf(cd.DESIGNATORHEIGHT, mil(60)), w = lenOf(cd.DESIGNATORWIDTH, mil(10)), ch = lenOf(cd.COMMENTHEIGHT, mil(60)), cw = lenOf(cd.COMMENTWIDTH, mil(10));
          push('Texts6', encodeText({ layer: L.TOP_OVERLAY, at: { x: at.x + b.minX, y: at.y + b.maxY + mil(15) }, height: h, strokeWidth: w, text: c.designator, component: index, isDesignator: true }));
          push('Texts6', encodeText({ layer: L.TOP_OVERLAY, at: { x: at.x + b.minX, y: at.y + b.minY - mil(15) - ch }, height: ch, strokeWidth: cw, text: c.comment, component: index, isComment: true }));
          rebuildPrims(doc);
        },
        revert() {
          doc.components.pop();
          for (const [storage, n] of added) { const r = recordsOf(doc, storage); r.splice(r.length - n, n); }
          added.clear();
          restore();
          rebuildPrims(doc);
        },
      };
    }
    case 'addPin': case 'removePin': {
      const comp = doc.components.find((c) => c.designator === it.designator);
      if (!comp) throw new Error(`Unknown Component ${it.designator}`);
      // Every pad of that name (the pin's pieces)
      const at = doc.prims.filter((q) => q.kind === 'pad' && q.component === comp.index && q.name === it.pad).map((q) => q.src);
      if (!at.length) throw new Error(`Unknown Pin: Pin ${it.designator}-${it.pad}`);
      const net = it.kind === 'removePin' ? NO_NET : doc.nets.findIndex((n) => n.name === it.net);
      if (net < 0) throw new Error(`Unknown Net ${it.net}`);
      // The records as they are when applied (an earlier step redone may have made them anew), changed as copies
      const restore = dirtyGuard(doc, [...new Set(at.map((a) => a.storage))]);
      let was: PcbRawRecord[] = [];
      return {
        apply() {
          was = at.map(({ storage: st, index: i }) => {
            const recs = recordsOf(doc, st), r = recs[i]!;
            const subs = r.subs.slice();
            subs[4] = subs[4]!.slice();
            put(subs[4], PAD.net, net);
            recs[i] = { ...r, subs };
            doc.dirty.add(st);
            return r;
          });
          rebuildPrims(doc);
        },
        revert() { at.forEach(({ storage: st, index: i }, k) => { if (was[k]) recordsOf(doc, st)[i] = was[k]!; }); restore(); rebuildPrims(doc); },
      };
    }
    case 'changeDesignator': {
      const comp = doc.components[it.index];
      if (!comp) throw new Error(`Unknown Component ${it.from}`);
      const text = componentTextChange(doc, comp.index, (q) => q.isDesignator, it.to);
      const restore = dirtyGuard(doc, ['Components6']);
      return {
        apply() { comp.bag.set('SOURCEDESIGNATOR', it.to); comp.designator = it.to; doc.dirty.add('Components6'); text.apply(); },
        revert() { comp.bag.set('SOURCEDESIGNATOR', it.from); comp.designator = it.from; text.revert(); restore(); },
      };
    }
    case 'changeComment': {
      if (!doc.components[it.index]) throw new Error(`Unknown Component ${it.designator}`);
      return componentTextChange(doc, it.index, (q) => q.isComment, it.to);
    }
    case 'changeFootprint': {
      const comp = doc.components[it.index];
      const f = find(it.to);
      if (!comp) throw new Error(`Unknown Component ${it.designator}`);
      if (!f) throw new Error(`Footprint Not Found ${it.to}`);
      return swapFootprint(doc, comp.index, f);
    }
    case 'removeComponent': {
      const comp = doc.components.find((c) => c.designator === it.designator);
      if (!comp) throw new Error(`Unknown Component ${it.designator}`);
      return removeComponents(doc, [comp.index]);
    }
    case 'addClass':
      return setClasses(doc, [...doc.classes.map((k) => k.bag), classBag(it.name, 1, it.members)]);
    case 'addRule': {
      // First of its kind (AD gives rules from the schematic the top priority [est]); its values as the parameter has them
      const kind = it.bag.get('RULEKIND')!;
      const rules = doc.rules.map(cloneRule);
      for (const r of rules) if (ruleKind(r) === kind) r.bag.set('PRIORITY', String(rulePriority(r) + 1));
      const name = it.bag.get('NAME') && !rules.some((r) => r.bag.get('NAME') === it.bag.get('NAME')) ? it.bag.get('NAME')! : nextRuleName(rules, kind);
      const r = newRule(kind, name, 1);
      for (const [k, v] of Object.entries(it.bag.toObject())) if (!['NAME', 'PRIORITY', 'SCOPE1EXPRESSION', 'SELECTION', 'UNIQUEID'].includes(k)) r.bag.set(k, v);
      r.bag.set('SCOPE1EXPRESSION', it.scope);
      r.bag.set('COMMENT', 'From the schematic');
      rules.push(r);
      return replaceRules(doc, rules);
    }
    case 'addRoom': {
      // Around the channel's parts as they are when the room is added (after Add Components)
      let inner: Change | null = null;
      return {
        apply() {
          const boxes = doc.components.filter((c) => it.members.includes(c.designator)).map((c) => componentExtent(doc, c.index)).filter((b): b is BBox => !!b);
          const o = doc.board.origin;
          const outline = boxes.length ? wrapOutline(boxes, 'rect', mil(50)) : [o, { x: o.x + mm(10), y: o.y }, { x: o.x + mm(10), y: o.y + mm(10) }, { x: o.x, y: o.y + mm(10) }];
          inner = editRooms(doc, { add: [newRoom(doc.rules, { name: it.name, outline, scope: `InComponentClass('${it.name}')` })] });
          inner.apply();
        },
        revert() { inner?.revert(); },
      };
    }
  }
}

/**
 * A component's designator or comment string takes new words: the 8-bit string in the record,
 * and no WideStrings6 entry (the old one would show the old words), so saving gives it a new one.
 */
export function componentTextChange(doc: PcbDocument, index: number, which: (t: { isDesignator: boolean; isComment: boolean }) => boolean, text: string): Change {
  // Where they are, not the records as read: each is changed as a copy when applied
  const at = doc.prims.filter((q) => q.kind === 'text' && q.component === index && which(q)).map((q) => q.src);
  const restore = dirtyGuard(doc, ['Texts6']);
  const pascal = (s: string) => { const b = binToBytes(s.slice(0, 255)); const o = new Uint8Array(b.length + 1); o[0] = b.length; o.set(b, 1); return o; };
  let was: PcbRawRecord[] = [];
  return {
    apply() {
      was = at.map(({ storage, index: i }) => {
        const recs = recordsOf(doc, storage), r = recs[i]!;
        const subs = r.subs.slice();
        subs[1] = pascal(text);
        if (subs[0]!.length >= TEXT.wideIndex.off + 4) { subs[0] = subs[0]!.slice(); put(subs[0], TEXT.wideIndex, 0xffffffff); }
        recs[i] = { tag: r.tag, subs, wide: text };
        return r;
      });
      if (at.length) doc.dirty.add('Texts6');
      rebuildPrims(doc);
    },
    revert() { at.forEach(({ storage, index: i }, k) => { if (was[k]) recordsOf(doc, storage)[i] = was[k]!; }); restore(); rebuildPrims(doc); },
  };
}

/**
 * A placed component takes another footprint (ECO Change Component Footprints, the library
 * editor's Update PCB With Footprint): its pads and graphics come from the footprint, placed
 * where and how the component is (rotation, bottom side), pads keeping the nets they had by
 * name; the designator and comment stay as they are. 3D bodies of the old footprint go.
 */
export function swapFootprint(doc: PcbDocument, index: number, f: FoundFootprint): Change {
  const comp = doc.components[index];
  if (!comp) throw new Error(`no component ${index}`);
  const bottom = comp.layer === L.BOTTOM;
  const nets = new Map<string, number>();
  for (const p of doc.prims) if (p.kind === 'pad' && p.component === index && !nets.has(p.name)) nets.set(p.name, p.net);
  const gone = new Map<string, Set<number>>();
  const drop = (storage: string, i: number) => { let x = gone.get(storage); if (!x) gone.set(storage, (x = new Set())); x.add(i); };
  for (const p of doc.prims) if ('component' in p && p.component === index && !(p.kind === 'text' && (p.isDesignator || p.isComment))) drop(p.src.storage, p.src.index);
  (doc.streams.get('ComponentBodies6')?.records ?? []).forEach((r, i) => { if (bodyComponent(r) === index) drop('ComponentBodies6', i); });
  // Bottom side: the footprint reflected top-to-bottom, then turned — a reflection across the vertical, turned 180° more
  const rot = bottom ? comp.rotation + 180 : comp.rotation;
  const map = placement({ x: 0, y: 0 }, rot, comp.at, bottom);
  const added: { storage: string; rec: PcbRawRecord }[] = [];
  for (const rec of f.footprint.records) {
    if (!placeable(rec)) continue;
    const storage = storageFor(rec.tag);
    const name = rec.tag === PCB_TAG.PAD ? padName(rec) : '';
    const placed = placeRecord(rec, 0, 0, index, rec.tag === PCB_TAG.PAD ? nets.get(name) ?? NO_NET : NO_NET);
    added.push({ storage, rec: transformRecord(placed, map, rot, { mirror: bottom, flip: bottom, storage }) });
  }
  const storages = new Set<string>(['Components6', ...gone.keys(), ...added.map((a) => a.storage)]);
  const was = new Set([...storages].filter((st) => doc.dirty.has(st)));
  const before = new Map<string, PcbRawRecord[]>();
  const oldBag = comp.bag.clone(), newBag = comp.bag.clone();
  newBag.set('PATTERN', f.footprint.name);
  newBag.set('HEIGHT', f.footprint.height || '0mil');
  newBag.set('FOOTPRINTDESCRIPTION', f.footprint.description);
  if (f.library) newBag.set('SOURCEFOOTPRINTLIBRARY', f.library);
  return {
    apply() {
      for (const st of storages) {
        const s = doc.streams.get(st) ?? (() => { const n = { storage: st, records: [] as PcbRawRecord[] }; doc.streams.set(st, n); return n; })();
        before.set(st, s.records);
        const kill = gone.get(st);
        s.records = [...(kill ? s.records.filter((_, i) => !kill.has(i)) : s.records), ...added.filter((a) => a.storage === st).map((a) => a.rec)];
        doc.dirty.add(st);
      }
      doc.components[index] = componentFromBag(newBag.clone(), index);
      rebuildPrims(doc);
    },
    revert() {
      for (const [st, recs] of before) { doc.streams.get(st)!.records = recs; if (!was.has(st)) doc.dirty.delete(st); }
      doc.components[index] = componentFromBag(oldBag.clone(), index);
      rebuildPrims(doc);
    },
  };
}

function padName(rec: PcbRawRecord): string {
  const b = rec.subs[0];
  if (!b?.length) return '';
  const n = Math.min(b[0]!, b.length - 1);
  let s = '';
  for (let i = 1; i <= n; i++) s += String.fromCharCode(b[i]!);
  return s;
}
