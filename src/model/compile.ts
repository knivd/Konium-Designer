/**
 * Project compiler: schematic connectivity, Altium net naming and an ERC subset.
 *
 * Connectivity follows Altium's rules: wires join where an end (or an electrical hot spot —
 * pin end, net label, power port, port end, junction) lies on another wire; plain crossings
 * don't join. Power ports join project-wide by name. Net identifier scope is Altium's
 * "Automatic": sheet entries → hierarchical, else ports → flat (ports global, net labels per
 * sheet), else global (net labels project-wide). Unnamed nets are named Net<Designator>_<Pin>
 * after the first pin, as Altium names them.
 */
import type { Vec2 } from '../core/geom';
import { SCH_UNIT } from '../core/units';
import { DIR_VECTORS, SR, componentKind, isShown, ownedBy, partLetter, type SchDocument, type SchObject } from './sch';
import { isRuleParameter } from './schRules';
import { entryPoint, portsOf, sheetHierarchy, symbolNames, type Hierarchy, type SymbolRef } from './schHierarchy';
import { channelDesignator, isRepeatEntry, repeatEntryName, roomName, sheetInstances, type SheetInstance } from './channels';
import { harnessEntryPoint, harnessTip, harnessType, isHarness } from './schHarness';
import { CONNECTION_CODES, ERC_KINDS, UNCONNECTED, defaultErc, entryCode, ercKind, pinCode, portCode, type ErcSettings } from './erc';

export interface SheetInput { name: string; doc: SchDocument }

export interface ObjRef { sheet: string; index: number }

export interface CompiledPin {
  designator: string;   // component designator
  pin: string;          // pin designator
  name: string;         // pin name
  electrical: number;
  ref: ObjRef;
  /** The sheet instance (its key: the sheet's name, or its channel's path) the pin is in. */
  inst?: string;
}

export interface CompiledNet {
  name: string;
  /** Named by Konium from a pin (no net label, power port or port names it). */
  auto: boolean;
  pins: CompiledPin[];
  sheets: string[];
  refs: ObjRef[];
  /** Its objects with the sheet instance each is in (a sheet used more than once has its objects in each). */
  instRefs?: { ref: ObjRef; inst: string }[];
  /** Design rules from Parameter Sets on it (Rule parameters' values; model/schRules). */
  rules?: string[];
}

export interface CompiledComponent {
  designator: string;
  comment: string;
  libRef: string;
  footprint: string;
  /** The footprint model's PCB Library: MODELDATAFILE0, a library name or a full path ('' or absent: Any). */
  footprintLibrary?: string;
  description: string;
  sheet: string;
  parts: number;
  refs: ObjRef[];
  params: Record<string, string>;
  /** Its design rules (Rule parameters' values; model/schRules). */
  rules?: string[];
  /** The schematic component's UNIQUEID (PCB components carry it as SOURCEUNIQUEID). */
  uniqueId: string;
  /** COMPONENTKIND: 0 Standard, 1 Mechanical, 2 Graphical (never sent to the PCB), 3/4 Net Tie, 5 Standard (No BOM), 6 Jumper. */
  kind: number;
  /** The channel (room) of a part on a multi-channel sheet. */
  channel?: string;
  /** The sheet instance (its key) the part is in. */
  inst?: string;
  /** Each ref's sheet instance (a multi-part package's parts may lie on other sheets). */
  refInsts?: string[];
  /** Placed from a database library: the library and its table (SOURCELIBRARYNAME, DATABASETABLENAME). */
  library?: string;
  table?: string;
  /** The library the part was placed from (SOURCELIBRARYNAME): with the library reference, its design item for a BOM. */
  sourceLibrary?: string;
}

export interface CompileMessage {
  level: 'error' | 'warn' | 'info';
  /** Fatal Error (Project Options › Error Reporting), shown as such in Messages. */
  fatal?: boolean;
  /** The violation (Altium's TErrorKind name), or 'Matrix' for a Connection Matrix violation. */
  kind?: string;
  sheet: string;
  message: string;
  refs: ObjRef[];
  /** Where it happens ("Sheet@x,y" keys): Place NoERC to Suppress finds a violation at the cursor by these. */
  points?: string[];
}

/** What a compile goes by (Project Options). */
export interface CompileOptions {
  erc?: ErcSettings;
  /** Net Identifier Scope (HierarchyMode): 0 Automatic, 1 Flat, 2 Hierarchical, 3 Global. */
  scope?: number;
  /** Sheet sizes for "Object not completely within sheet boundaries". */
  checkBounds?: boolean;
  /** Project Options › Options: Allow Sheet Entries to Name Nets (default on), Allow Ports to Name Nets, Power Port Names Take Priority. */
  allowSheetEntryNetNames?: boolean;
  allowPortNetNames?: boolean;
  powerPortNamesTakePriority?: boolean;
  /** Project Options › Multi-Channel: Designator Format (ChannelDesignatorFormatString) and Room Level Separator. */
  channelFormat?: string;
  channelSeparator?: string;
}

export interface CompiledProject {
  components: CompiledComponent[];
  nets: CompiledNet[];
  messages: CompileMessage[];
  scope: 'hierarchical' | 'flat' | 'global';
  /** The sheet tree (sheet symbols → child sheets). */
  hierarchy: Hierarchy;
}

export const ELECTRICAL = ['Input', 'I/O', 'Output', 'Open Collector', 'Passive', 'HiZ', 'Open Emitter', 'Power'];

/* ─── Union-find ─────────────────────────────────────────────────────────────────────── */

class Dsu {
  private parent = new Map<string, string>();
  add(a: string): void { if (!this.parent.has(a)) this.parent.set(a, a); }
  find(a: string): string {
    this.add(a);
    let r = a;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let x = a;
    while (x !== r) { const n = this.parent.get(x)!; this.parent.set(x, r); x = n; }
    return r;
  }
  union(a: string, b: string): void { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
  keys(): string[] { return [...this.parent.keys()]; }
}

/** Natural sort: C2 before C10, pin 2 before pin 10. */
export const natural = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

const ptKey = (s: string, p: Vec2) => `${s}@${p.x},${p.y}`;

function onSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
  if (p.x < Math.min(a.x, b.x) || p.x > Math.max(a.x, b.x) || p.y < Math.min(a.y, b.y) || p.y > Math.max(a.y, b.y)) return false;
  if (a.x === b.x || a.y === b.y) return true;
  return Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) <= Math.hypot(b.x - a.x, b.y - a.y) * 50;
}

type Wire = SchObject & { kind: 'wire'; pts: Vec2[] };

/** A bus name's members (D[0..3] → D0 … D3, D[3..0] → D3 … D0); null if it isn't one. */
export function busMembers(name: string): string[] | null {
  const m = /^(.*?)\[\s*(\d+)\s*\.\.\s*(\d+)\s*\](.*)$/.exec(name.trim());
  if (!m) return null;
  const a = Number(m[2]), b = Number(m[3]);
  if (Math.abs(a - b) > 4096) return null;
  const out: string[] = [];
  for (let i = a; a <= b ? i <= b : i >= b; i += a <= b ? 1 : -1) out.push(`${m[1]}${i}${m[4]}`);
  return out;
}

interface BusRun { segs: [Vec2, Vec2][]; labels: { members: string[]; at: Vec2; rank: number }[] }
const busRunCache = new WeakMap<SchDocument, BusRun[]>();
/** A sheet's buses joined where they meet, with the bus names on each run: net labels, else ports, else off-sheet connectors. */
function busRunsOf(doc: SchDocument, objs: SchObject[], masked: (o: SchObject) => boolean): BusRun[] {
  const bs = objs.filter((o): o is SchObject & { kind: 'bus'; pts: Vec2[] } => o.kind === 'bus' && isShown(doc, o) && !masked(o));
  if (!bs.length) return [];
  const segsOf = bs.map((b) => b.pts.slice(1).map((q, i): [Vec2, Vec2] => [b.pts[i]!, q]));
  const up = bs.map((_, i) => i);
  const find = (i: number): number => { while (up[i] !== i) { up[i] = up[up[i]!]!; i = up[i]!; } return i; };
  // Ends meeting other buses, by a grid of the segments (not every pair against every pair)
  const CELL = 2_000_000, grid = new Map<string, number[]>();
  segsOf.forEach((ss, i) => { for (const [a, b] of ss) for (let gx = Math.floor(Math.min(a.x, b.x) / CELL); gx <= Math.floor(Math.max(a.x, b.x) / CELL); gx++) for (let gy = Math.floor(Math.min(a.y, b.y) / CELL); gy <= Math.floor(Math.max(a.y, b.y) / CELL); gy++) { const k = `${gx},${gy}`; const l = grid.get(k); if (l) { if (l[l.length - 1] !== i) l.push(i); } else grid.set(k, [i]); } });
  bs.forEach((b, i) => { for (const p of b.pts) for (const j of grid.get(`${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`) ?? []) if (j !== i && find(i) !== find(j) && segsOf[j]!.some(([a, c]) => onSegment(p, a, c))) up[find(i)] = find(j); });
  const byRoot = new Map<number, BusRun>();
  bs.forEach((_, i) => { const k = find(i); if (!byRoot.has(k)) byRoot.set(k, { segs: [], labels: [] }); byRoot.get(k)!.segs.push(...segsOf[i]!); });
  const runs = [...byRoot.values()];
  const runAt = (pts: Vec2[]) => runs.find((x) => x.segs.some(([a, b]) => pts.some((q) => onSegment(q, a, b))));
  for (const o of objs) {
    if (!isShown(doc, o)) continue;
    const named = o.kind === 'text' && o.role === 'netlabel' ? { text: o.text, pts: [o.at], rank: 0 }
      : o.kind === 'port' ? { text: o.name, pts: [o.at, o.style >= 4 ? { x: o.at.x, y: o.at.y + o.width } : { x: o.at.x + o.width, y: o.at.y }], rank: 1 }
      : o.kind === 'power' && o.crossSheet ? { text: o.text, pts: [o.at], rank: 2 } : null;
    const ms = named ? busMembers(named.text) : null;
    if (!named || !ms) continue;
    runAt(named.pts)?.labels.push({ members: ms, at: named.pts[0]!, rank: named.rank });
  }
  return runs;
}

/* ─── Compile ────────────────────────────────────────────────────────────────────────── */

export function compileProject(sheets: SheetInput[], opts: CompileOptions = {}): CompiledProject {
  const dsu = new Dsu();
  const erc = opts.erc ?? defaultErc();
  const raw: (CompileMessage & { points?: string[] })[] = [];
  /** A violation: dropped at No Report, else Warning / Error / Fatal Error as Project Options say. */
  const report = (kind: string, sheet: string, message: string, refs: ObjRef[], points?: string[]) => {
    const lv = erc.levels.get(ercKind(kind).n) ?? ercKind(kind).def;
    if (lv) raw.push({ level: lv === 1 ? 'warn' : 'error', fatal: lv === 3 || undefined, kind, sheet, message, refs, points });
  };
  const pins = new Map<string, CompiledPin>();             // node → pin
  /** 'member': a bus member a bus entry, port or off-sheet connector meets (joins as a label does, names a net only when nothing else does). */
  type NameKind = 'label' | 'power' | 'port' | 'hidden' | 'entry' | 'harness' | 'offsheet' | 'member';
  /** Names on each node; `inst` is the sheet instance whose scope a label or port belongs to. */
  const names = new Map<string, { text: string; kind: NameKind; ref: ObjRef; inst: string; target?: string }[]>();
  const refsOf = new Map<string, ObjRef[]>();
  const sheetOf = new Map<string, string>();
  const anyEntries = sheets.some((s) => s.doc.objects.some((o) => o.kind === 'sheetentry'));
  const anyPorts = sheets.some((s) => s.doc.objects.some((o) => o.kind === 'port'));
  const scope: CompiledProject['scope'] = opts.scope === 1 ? 'flat' : opts.scope === 2 ? 'hierarchical' : opts.scope === 3 ? 'global'
    : anyEntries ? 'hierarchical' : anyPorts ? 'flat' : 'global';
  const addName = (node: string, text: string, kind: NameKind, ref: ObjRef, inst: string, target?: string) => {
    if (!names.has(node)) names.set(node, []);
    names.get(node)!.push({ text, kind, ref, inst, target });
  };
  // Sheet symbols → child sheets: an entry meets the child's port of the same name
  const hierarchy = sheetHierarchy(sheets);
  if (scope === 'hierarchical') {
    for (const m of hierarchy.missing) {
      report('MissingChildDocument', m.sheet, `Missing child sheet for sheet symbol ${m.designator || '(no designator)'}${m.fileName ? ` (${m.fileName})` : ''}`, [{ sheet: m.sheet, index: m.index }]);
    }
  }
  // Multi-channel: each sheet is compiled once per instance — once, or once per channel when it is
  // used by several symbols or a Repeat symbol (nodes keyed by instance, refs by the real sheet)
  const symUid = (s: SymbolRef) => sheets.find((x) => x.name === s.sheet)?.doc.records[s.index + 1]?.bag?.get('UNIQUEID') ?? '';
  const chFmt = opts.channelFormat || '$Component_$RoomName', chSep = opts.channelSeparator ?? '_';
  const tree = sheetInstances(hierarchy, symUid, chSep);
  const instances: (SheetInput & { inst: SheetInstance; first: boolean })[] = [];
  for (const s of sheets) {
    const own = tree.filter((t) => t.sheet === s.name);
    const list = own.length ? own : [{ sheet: s.name, key: s.name, parent: null, rooms: [], uids: [], index: 1 } as SheetInstance];
    list.forEach((inst, k) => instances.push({ ...s, inst, first: k === 0 }));
  }
  /** The instances a sheet symbol of this instance places (one, or one per channel). */
  const childInstances = (parent: string, sheet: string, symbol: number) => tree.filter((t) => t.parent === parent && t.via?.sheet === sheet && t.via.index === symbol);
  /** Each node's instance (for naming a channel's own nets). */
  const nodeInst = new Map<string, SheetInstance>();
  let curInst = '';
  const refInsts = new Map<string, string[]>();
  const addRef = (node: string, ref: ObjRef) => {
    if (!refsOf.has(node)) { refsOf.set(node, []); refInsts.set(node, []); }
    refsOf.get(node)!.push(ref); refInsts.get(node)!.push(curInst); sheetOf.set(node, ref.sheet);
  };

  const components: CompiledComponent[] = [];
  /** Which part of its package each placed part is (U1A: 1), for Duplicate Sub-Parts. */
  const partOf = new Map<CompiledComponent, number>();
  /** Per node: its connection code (Connection Matrix) and how Messages name it — pins, ports, sheet entries. */
  const items = new Map<string, { code: number; label: string; ref: ObjRef; inst: string }>();
  /** Per node: the points it touches; a No ERC marker on one of them covers what concerns the node. */
  const nodePoints = new Map<string, string[]>();
  const wireInfo = new Map<string, { sheet: string; ref: ObjRef; text: string }>();
  /** Harness bundles: connectors, signal harnesses, harness ports and sheet entries, joined where they meet. */
  const hdsu = new Dsu();
  const bundleEntries: { bundle: string; name: string; node: string; ref: ObjRef }[] = [];
  const bundleNames = new Map<string, string>();
  const harnessPorts: { node: string; name: string; sheet: string }[] = [];
  const harnessSheetEntries: { node: string; name: string; children: string[] }[] = [];
  const noErc = new Map<string, { all: boolean; kinds: Set<string>; matrix: boolean }[]>();
  const diffPairNodes = new Set<string>();
  // Parameter Sets carrying design rules: the net they sit on takes them
  const ruleNodes = new Map<string, string[]>();
  const symbolNamesSeen: { sheet: string; designator: string; ref: ObjRef }[] = [];
  const uniqueIds = new Map<string, { des: string; ref: ObjRef }[]>();
  const docNumbers = new Map<string, string[]>();
  /** Coordinates in Messages: the file's units (10 mil), fractions kept. */
  const mil = (v: number) => Math.round((v / SCH_UNIT) * 1000) / 1000;

  for (const { name: sheet, doc, inst: instance, first } of instances) {
    const inst = instance.key;
    curInst = inst;
    const objs = doc.objects;
    const ref = (o: SchObject): ObjRef => ({ sheet, index: o.index });
    // Sheet-level checks once per sheet (not again for each channel)
    const des = (d: string) => channelDesignator(chFmt, d, instance, chSep);
    const sheetNodes: string[] = [];
    // Compile masks: what lies within one is left out of the compile
    const masks = objs.filter((o): o is SchObject & { kind: 'compilemask' } => o.kind === 'compilemask' && !o.hidden)
      .map((m) => ({ x0: Math.min(m.a.x, m.b.x), x1: Math.max(m.a.x, m.b.x), y0: Math.min(m.a.y, m.b.y), y1: Math.max(m.a.y, m.b.y) }));
    const inMask = (p: Vec2) => masks.some((m) => p.x >= m.x0 && p.x <= m.x1 && p.y >= m.y0 && p.y <= m.y1);
    const masked = (o: SchObject): boolean => {
      if (!masks.length) return false;
      if ('pts' in o && Array.isArray(o.pts)) return o.pts.every(inMask);
      const owner = o.owner >= 0 ? objs[o.owner] : undefined;
      if (owner && 'at' in owner) return inMask(owner.at as Vec2);
      return 'at' in o ? inMask(o.at as Vec2) : false;
    };
    const wires = objs.filter((o): o is Wire => o.kind === 'wire' && isShown(doc, o) && o.pts.length >= 2 && !masked(o));
    // Buses joined where they meet, each run with its bus labels: a bus sheet entry or port meets the members of the
    // bus drawn to it in order (AD matches them by position, not by name) [est]
    let runs = busRunCache.get(doc);
    if (!runs) { runs = busRunsOf(doc, objs, masked); busRunCache.set(doc, runs); }
    const busRuns = runs;
    /** The bus label an object on a bus meets (one of its width, the nearest), and whether it is on a bus at all. */
    const busLabelAt = (pts: Vec2[], n: number): { label: string[] | null; onBus: boolean; kind: NameKind } => {
      for (const r of busRuns) {
        if (!pts.some((p) => r.segs.some(([a, b]) => onSegment(p, a, b)))) continue;
        const fit = r.labels.filter((l) => l.members.length === n);
        const d = (l: { at: Vec2 }) => Math.min(...pts.map((p) => Math.hypot(p.x - l.at.x, p.y - l.at.y)));
        fit.sort((a, b) => a.rank - b.rank || d(a) - d(b));
        // The bus's members name their nets as labels do (a bus with no name: its own members only join)
        return { label: fit[0]?.members ?? null, onBus: true, kind: fit[0] ? 'label' : 'member' };
      }
      return { label: null, onBus: false, kind: 'member' };
    };
    const CELL = 2_000_000;
    const grid = new Map<string, { w: Wire; a: Vec2; b: Vec2 }[]>();
    for (const w of wires) {
      dsu.add(`w:${inst}:${w.index}`);
      addRef(`w:${inst}:${w.index}`, ref(w));
      for (let i = 1; i < w.pts.length; i++) {
        const a = w.pts[i - 1]!, b = w.pts[i]!;
        for (let gx = Math.floor(Math.min(a.x, b.x) / CELL); gx <= Math.floor(Math.max(a.x, b.x) / CELL); gx++) {
          for (let gy = Math.floor(Math.min(a.y, b.y) / CELL); gy <= Math.floor(Math.max(a.y, b.y) / CELL); gy++) {
            const k = `${gx},${gy}`;
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k)!.push({ w, a, b });
          }
        }
      }
    }
    const wiresAt = (p: Vec2): Wire[] => {
      const out = new Set<Wire>();
      for (const s of grid.get(`${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`) ?? []) if (onSegment(p, s.a, s.b)) out.add(s.w);
      return [...out];
    };
    // Every point that something electrical touches
    const touch = new Map<string, Vec2>();
    const hit = (node: string, p: Vec2) => {
      const k = ptKey(inst, p); touch.set(k, p); dsu.union(node, k); nodeInst.set(node, instance);
      const list = nodePoints.get(node), at = ptKey(sheet, p); if (list) list.push(at); else nodePoints.set(node, [at]);
    };
    for (const w of wires) { hit(`w:${inst}:${w.index}`, w.pts[0]!); hit(`w:${inst}:${w.index}`, w.pts.at(-1)!); }

    const floating: { node: string; o: SchObject; what: string }[] = [];

    // Harnesses first: what touches a signal harness carries a bundle, not a net
    const sh = objs.filter((o): o is SchObject & { kind: 'signalharness' } => o.kind === 'signalharness' && !o.hidden && o.pts.length >= 2 && !masked(o));
    const onHarness = (p: Vec2) => sh.filter((s) => s.pts.some((q, i) => i > 0 && onSegment(p, s.pts[i - 1]!, q)));
    const hjoin = (node: string, p: Vec2) => { hdsu.add(node); for (const s of onHarness(p)) hdsu.union(node, `hs:${inst}:${s.index}`); };
    for (const s of sh) { hdsu.add(`hs:${inst}:${s.index}`); for (const v of [s.pts[0]!, s.pts.at(-1)!]) hjoin(`hs:${inst}:${s.index}`, v); }
    const harnessObj = new Set<number>();
    for (const o of objs) {
      if (masked(o)) continue;
      if (isHarness(o)) {
        const hb = `hb:${inst}:${o.index}`;
        hjoin(hb, harnessTip(o));
        const t = harnessType(doc, o.index);
        if (t) bundleNames.set(hb, t);
      } else if (o.kind === 'harnessentry') {
        const h = objs[o.owner];
        if (!isHarness(h)) continue;
        const node = `he:${inst}:${o.index}`;
        dsu.add(node); addRef(node, ref(o));
        hit(node, harnessEntryPoint(h, o));
        bundleEntries.push({ bundle: `hb:${inst}:${h.index}`, name: o.name, node, ref: ref(o) });
      } else if (o.kind === 'port') {
        const ends = [o.at, o.style >= 4 ? { x: o.at.x, y: o.at.y + o.width } : { x: o.at.x + o.width, y: o.at.y }];
        const ht = doc.records[o.index + 1]?.bag?.get('HARNESSTYPE');
        if (!ht && !ends.some((e) => onHarness(e).length)) continue;
        const hn = `hp:${inst}:${o.index}`;
        for (const e of ends) hjoin(hn, e);
        harnessPorts.push({ node: hn, name: o.name, sheet: inst });
        bundleNames.set(hn, o.name);
        harnessObj.add(o.index);
      } else if (o.kind === 'sheetentry') {
        const p = entryPoint(doc, o);
        const ht = doc.records[o.index + 1]?.bag?.get('HARNESSTYPE');
        if (!p || (!ht && !onHarness(p).length)) continue;
        const hn = `hse:${inst}:${o.index}`;
        hjoin(hn, p);
        const kids = childInstances(inst, sheet, o.owner).map((t) => t.key);
        if (kids.length) harnessSheetEntries.push({ node: hn, name: o.name, children: kids });
        harnessObj.add(o.index);
      }
    }

    for (const o of objs) {
      if (masked(o) || harnessObj.has(o.index)) continue;
      switch (o.kind) {
        case 'noerc': {
          const b = doc.records[o.index + 1]?.bag;
          const modern = !!b && (b.has('SUPPRESSALL') || b.has('ISACTIVE'));
          if (modern && !b!.bool('ISACTIVE')) break;
          // Specific No ERC (AD17): SUPPRESSALL=F with the violation labels or connection pairs it covers
          const all = !b || b.bool('SUPPRESSALL') || (!modern && !b.has('ERRORKINDSETTOSUPPRESS') && !b.has('CONNECTIONPAIRSTOSUPPRESS'));
          const kinds = new Set<string>();
          const raw = b?.get('ERRORKINDSETTOSUPPRESS') ?? '';
          for (const m of raw.matchAll(/"([^"]*)"/g)) kinds.add(m[1]!.toLowerCase());
          if (raw && !raw.includes('"')) for (const x of raw.split(',')) if (x.trim()) kinds.add(x.trim().toLowerCase());
          if (!first) break;
          const k = ptKey(sheet, o.at);
          const list = noErc.get(k) ?? [];
          list.push({ all, kinds, matrix: !!b?.get('CONNECTIONPAIRSTOSUPPRESS') });
          noErc.set(k, list);
          break;
        }
        case 'directive': {
          const ruleTexts = (ownedBy(doc).get(o.index) ?? []).filter((c) => c.kind === 'text' && c.role === 'parameter' && isRuleParameter(doc.records[c.index + 1]?.bag?.get('NAME'), c.text)).map((c) => (c.kind === 'text' ? c.text : ''));
          if (ruleTexts.length) { const node = `rule:${inst}:${o.index}`; dsu.add(node); hit(node, o.at); ruleNodes.set(node, ruleTexts); }
          if (o.name.toUpperCase() !== 'DIFFPAIR') break;
          const node = `dp:${inst}:${o.index}`;
          dsu.add(node); hit(node, o.at); diffPairNodes.add(node);
          break;
        }
        case 'sheetsymbol': {
          const n = symbolNames(doc, o.index);
          if (first) symbolNamesSeen.push({ sheet, designator: n.designator, ref: ref(o) });
          break;
        }
        case 'pin': {
          const owner = objs[o.owner];
          const desig = owner?.kind === 'component' ? des(owner.designator) : '';
          const bag = doc.records[o.index + 1]?.bag;
          const node = `p:${inst}:${o.index}`;
          sheetNodes.push(node);
          if (!isShown(doc, o)) {
            // Hidden power pins join the net their HIDDENNETNAME names
            const hiddenNet = bag?.get('HIDDENNETNAME');
            const partOk = owner?.kind === 'component' && (o.ownerPartId <= 0 || o.ownerPartId === owner.partId) && o.ownerDisplayMode === owner.displayMode;
            if (o.hidden && hiddenNet && partOk) {
              dsu.add(node); addRef(node, ref(o));
              pins.set(node, { designator: desig, pin: o.designator, name: o.name, electrical: o.electrical, ref: ref(o), inst });
              addName(node, hiddenNet, 'hidden', ref(o), inst);
            }
            break;
          }
          const d = DIR_VECTORS[o.orient]!;
          const end = { x: o.at.x + d.x * o.length, y: o.at.y + d.y * o.length };
          dsu.add(node); addRef(node, ref(o));
          hit(node, end);
          pins.set(node, { designator: desig, pin: o.designator, name: o.name, electrical: o.electrical, ref: ref(o), inst });
          items.set(node, { code: pinCode(o.electrical), label: `Pin ${desig}-${o.designator}`, ref: ref(o), inst });
          break;
        }
        case 'text':
          if (o.role === 'netlabel' && isShown(doc, o)) {
            const node = `l:${inst}:${o.index}`;
            dsu.add(node); addRef(node, ref(o));
            hit(node, o.at);
            addName(node, o.text, 'label', ref(o), inst);
            floating.push({ node, o, what: `Floating Net Label ${o.text}` });
          }
          break;
        case 'power': {
          const node = `pp:${inst}:${o.index}`;
          dsu.add(node); addRef(node, ref(o));
          hit(node, o.at);
          // An off-sheet connector joins only sheets placed by the same parent, and drives nothing
          const oi = instance.parent ? `${instance.parent}|${instance.via?.sheet}:${instance.via?.index}` : '';
          const bus = o.crossSheet ? busMembers(o.text) : null;
          if (bus) {
            // On a bus: each member joins its namesake on the other sheets, and this sheet's member of the bus
            const { label: lab, kind: lk } = busLabelAt([o.at], bus.length);
            bus.forEach((m, i) => {
              const v = `om:${inst}:${o.index}:${m}`;
              dsu.add(v); addRef(v, ref(o));
              addName(v, m, 'offsheet', ref(o), oi);
              addName(v, lab?.[i] ?? m, lab ? lk : 'member', ref(o), inst);
            });
          } else if (o.crossSheet) addName(node, o.text, 'offsheet', ref(o), oi);
          else addName(node, o.text, 'power', ref(o), inst);
          floating.push({ node, o, what: `Floating Power Object ${o.text}` });
          break;
        }
        case 'port': {
          const node = `port:${inst}:${o.index}`;
          dsu.add(node); addRef(node, ref(o));
          // A child sheet's port must meet an entry on a symbol that stands for the sheet
          const ups = scope === 'hierarchical' ? hierarchy.parents.get(sheet.toLowerCase()) : undefined;
          if (first && ups && !ups.some((u) => sheets.find((x) => x.name === u.sheet)?.doc.objects.some((e) => e.kind === 'sheetentry' && e.owner === u.index && repeatEntryName(e.name).toUpperCase() === o.name.toUpperCase()))) {
            report('PortNotLinkedToSheetSymbol', sheet, `Port ${o.name} not linked to parent sheet symbol`, [ref(o)], [ptKey(sheet, o.at)]);
          }
          // A bus port (D[0..7]): each member its own port, meeting the member of the bus drawn to it
          const members = busMembers(o.name);
          if (members) {
            const ends = [o.at, o.style >= 4 ? { x: o.at.x, y: o.at.y + o.width } : { x: o.at.x + o.width, y: o.at.y }];
            const { label: lab, onBus, kind: lk } = busLabelAt(ends, members.length);
            members.forEach((m, i) => {
              const v = `pm:${inst}:${o.index}:${m}`;
              dsu.add(v); addRef(v, ref(o));
              addName(v, m, 'port', ref(o), inst);
              if (lab || onBus) addName(v, lab?.[i] ?? m, lab ? lk : 'member', ref(o), inst);
            });
            // On no bus: joined to nothing
            if (!onBus) { hit(node, ends[0]!); hit(node, ends[1]!); items.set(node, { code: portCode(o.io), label: `Port ${o.name}`, ref: ref(o), inst }); }
            break;
          }
          hit(node, o.at);
          hit(node, o.style >= 4 ? { x: o.at.x, y: o.at.y + o.width } : { x: o.at.x + o.width, y: o.at.y });
          addName(node, o.name, 'port', ref(o), inst);
          items.set(node, { code: portCode(o.io), label: `Port ${o.name}`, ref: ref(o), inst });
          break;
        }
        case 'sheetentry': {
          const p = entryPoint(doc, o);
          if (!p) break;
          const node = `se:${inst}:${o.index}`;
          dsu.add(node); addRef(node, ref(o));
          hit(node, p);
          const child = hierarchy.childOf.get(`${sheet}:${o.owner}`);
          // A bus entry (D[0..7]): each member meets the child's port member and the member of the bus drawn to it
          const members = isRepeatEntry(o.name) ? null : busMembers(o.name);
          const { label: lab, onBus, kind: lk } = members ? busLabelAt([p], members.length) : { label: null, onBus: false, kind: 'member' as NameKind };
          // On a bus it isn't unconnected (the bus carries its members)
          if (!members || !onBus) items.set(node, { code: entryCode(o.io), label: `Sheet Entry ${o.name}`, ref: ref(o), inst });
          if (child && members) {
            members.forEach((m, i) => {
              const v = `em:${inst}:${o.index}:${m}`;
              dsu.add(v); addRef(v, ref(o));
              for (const t of childInstances(inst, sheet, o.owner)) addName(v, m, 'entry', ref(o), inst, t.key);
              if (lab || onBus) addName(v, lab?.[i] ?? m, lab ? lk : 'member', ref(o), inst);
            });
          }
          if (child) {
            const port = repeatEntryName(o.name);
            if (!members) for (const t of childInstances(inst, sheet, o.owner)) {
              if (isRepeatEntry(o.name) && t.rooms.length > instance.rooms.length) {
                // Repeat(X): each channel's port X is its own signal, X1 … Xn in this sheet (the bus members) [est]
                const v = `rx:${inst}:${o.index}:${t.key}`;
                dsu.add(v); addRef(v, ref(o)); nodeInst.set(v, instance);
                addName(v, port, 'entry', ref(o), inst, t.key);
                addName(v, `${port}${/\d+$/.exec(t.rooms.at(-1)!)?.[0] ?? t.index}`, 'label', ref(o), inst);
              } else addName(node, port, 'entry', ref(o), inst, t.key);
            }
            const cdocs = (hierarchy.childrenOf.get(`${sheet}:${o.owner}`) ?? [child]).map((c) => sheets.find((x) => x.name === c)?.doc).filter((d): d is SchDocument => !!d);
            if (first && cdocs.length && !cdocs.some((cdoc) => portsOf(cdoc).some((q) => q.name.toUpperCase() === port.toUpperCase()))) report('SheetEntryNotLinkedToPort', sheet, `Sheet Entry ${o.name} not linked to child sheet ${child}`, [ref(o)], [ptKey(sheet, p)]);
          }
          break;
        }
        case 'junction': {
          const node = `j:${inst}:${o.index}`;
          dsu.add(node);
          hit(node, o.at);
          break;
        }
        case 'component': {
          if (!isShown(doc, o)) break;
          const owned = ownedBy(doc);
          const kids = owned.get(o.index) ?? [];
          const param = (n: string) => {
            for (const c of kids) {
              if (c.kind !== 'text' || c.role !== 'parameter') continue;
              const b = doc.records[c.index + 1]?.bag;
              if (b?.get('NAME')?.toLowerCase() === n.toLowerCase()) return c.text;
            }
            return '';
          };
          const params: Record<string, string> = {};
          const rules = kids.filter((c) => c.kind === 'text' && c.role === 'parameter' && isRuleParameter(doc.records[c.index + 1]?.bag?.get('NAME'), c.text)).map((c) => (c.kind === 'text' ? c.text : ''));
          for (const c of kids) {
            if (c.kind !== 'text' || c.role !== 'parameter') continue;
            const n = doc.records[c.index + 1]?.bag?.get('NAME');
            if (n) params[n] = c.text;
          }
          const bag = doc.records[o.index + 1]?.bag;
          // Footprint: the current PCBLIB model under the component's implementation list
          let footprint = '', footprintLibrary = '';
          for (const list of kids.filter((c) => c.record === SR.IMPLEMENTATION_LIST)) {
            for (const impl of (owned.get(list.index) ?? []).filter((c) => c.record === SR.IMPLEMENTATION)) {
              const ib = doc.records[impl.index + 1]?.bag;
              if (ib?.get('MODELTYPE')?.toUpperCase() !== 'PCBLIB') continue;
              if (!footprint || ib.bool('ISCURRENT')) { footprint = ib.get('MODELNAME') ?? footprint; footprintLibrary = ib.bool('USECOMPONENTLIBRARY') ? '' : ib.get('MODELDATAFILE0') ?? ''; }
            }
          }
          const uid = bag?.get('UNIQUEID') ?? '';
          if (uid && first) { const l = uniqueIds.get(uid) ?? []; l.push({ des: o.designator, ref: ref(o) }); uniqueIds.set(uid, l); }
          // In a channel: its designator by the channel format, its ID by the channel's path, its room
          components.push({
            designator: des(o.designator), comment: resolveComment(param('Comment'), params), libRef: o.libRef, footprint, ...(footprintLibrary ? { footprintLibrary } : {}),
            description: bag?.get('COMPONENTDESCRIPTION') ?? '', sheet, parts: Math.max(1, o.partCount - 1), refs: [ref(o)], params, ...(rules.length ? { rules } : {}),
            uniqueId: uid && instance.uids.length ? [...instance.uids, uid].join('\\') : uid, kind: bag ? componentKind(bag) : 0,
            ...(instance.rooms.length ? { channel: roomName(instance, chSep) } : {}), inst,
            ...(bag?.get('DATABASETABLENAME') ? { library: bag.get('SOURCELIBRARYNAME') ?? '', table: bag.get('DATABASETABLENAME') } : {}),
            ...(bag?.get('SOURCELIBRARYNAME') ? { sourceLibrary: bag.get('SOURCELIBRARYNAME') } : {}),
          });
          partOf.set(components.at(-1)!, o.partId);
          break;
        }
      }
    }
    // Wires through any touched point join it (T-junctions, pins on a wire, labels on a wire)
    for (const [k, p] of touch) for (const w of wiresAt(p)) dsu.union(`w:${inst}:${w.index}`, k);

    // Floating labels / power objects: no wire or pin of the sheet at their hot spot
    if (first && floating.length) {
      for (const w of wires) sheetNodes.push(`w:${inst}:${w.index}`);
      const roots = new Set(sheetNodes.map((n) => dsu.find(n)));
      // On a bus: not floating (a bus's label names it; an off-sheet connector carries it on)
      const buses = objs.filter((o): o is SchObject & { kind: 'bus'; pts: Vec2[] } => o.kind === 'bus' && isShown(doc, o));
      const onBus = (p: Vec2) => buses.some((b) => b.pts.some((q, i) => i > 0 && onSegment(p, b.pts[i - 1]!, q)));
      for (const f of floating) {
        const p = f.o.kind === 'power' ? f.o.at : (f.o as { at: Vec2 }).at;
        if (!roots.has(dsu.find(ptKey(inst, p))) && !onBus(p)) report(f.o.kind === 'power' ? 'FloatingPowerObject' : 'FloatingNetLabel', sheet, f.what, [ref(f.o)], [ptKey(sheet, p)]);
      }
    }
    if (first) sheetChecks(sheet, doc, ref, wires, masked);
  }

  /* ── Checks on one sheet ── */
  function sheetChecks(sheet: string, doc: SchDocument, ref: (o: SchObject) => ObjRef, wires: Wire[], masked: (o: SchObject) => boolean): void {
    const objs = doc.objects;
    const W = doc.sheet.width, H = doc.sheet.height;
    const at = (p: Vec2) => `${mil(p.x)},${mil(p.y)}`;
    const desc = (o: SchObject): string => o.kind === 'pin' ? `Pin ${(objs[o.owner] as { designator?: string } | undefined)?.designator ?? ''}-${o.designator}`
      : o.kind === 'text' ? `${o.role === 'netlabel' ? 'Net Label' : 'Text'} ${o.text}` : o.kind === 'power' ? `Power Object ${o.text}` : o.kind === 'port' ? `Port ${o.name}`
      : o.kind === 'sheetentry' ? `Sheet Entry ${o.name}` : o.kind === 'component' ? `Part ${o.designator}` : o.kind === 'junction' ? 'Junction' : o.kind === 'wire' ? 'Wire' : o.kind;
    for (const o of objs) {
      if (masked(o) || !isShown(doc, o) || o.kind === 'meta') continue;
      const tpl = o.owner >= 0 && objs[o.owner]?.record === SR.TEMPLATE;
      if (tpl) continue;
      // Off grid: electrical hot spots off Altium's 10 mil base grid
      const hot: Vec2[] = o.kind === 'wire' ? o.pts : o.kind === 'pin' ? [{ x: o.at.x + DIR_VECTORS[o.orient]!.x * o.length, y: o.at.y + DIR_VECTORS[o.orient]!.y * o.length }]
        : (o.kind === 'power' || o.kind === 'port' || o.kind === 'junction' || (o.kind === 'text' && o.role === 'netlabel')) ? [o.at] : [];
      const off = hot.find((p) => p.x % SCH_UNIT !== 0 || p.y % SCH_UNIT !== 0);
      if (off) report('OffGridObject', sheet, `Off grid ${desc(o)} at ${at(off)}`, [ref(o)], [ptKey(sheet, off)]);
      // Outside the sheet
      const pts: Vec2[] = 'pts' in o && Array.isArray(o.pts) ? o.pts : 'a' in o && 'b' in o ? [o.a as Vec2, o.b as Vec2] : 'at' in o ? [o.at as Vec2] : [];
      if (o.owner < 0 && pts.some((p) => p.x < 0 || p.y < 0 || p.x > W || p.y > H)) report('OffDocumentObject', sheet, `Object not completely within sheet boundaries: ${desc(o)}`, [ref(o)]);
    }
    // Wires that join nothing (no pin, port, sheet entry, label or power object anywhere on them)
    for (const w of wires) wireInfo.set(`w:${sheet}:${w.index}`, { sheet, ref: ref(w), text: `Unconnected line (${at(w.pts[0]!)}) To (${at(w.pts.at(-1)!)})` });
    // Duplicate ports, sheet entries in a symbol, pins in a part
    const portNames = new Map<string, SchObject[]>();
    for (const o of objs) if (o.kind === 'port' && !masked(o)) portNames.set(o.name, [...(portNames.get(o.name) ?? []), o]);
    for (const [n, list] of portNames) if (list.length > 1 && n) report('DuplicatePortsInDocument', sheet, `Duplicate Ports ${n} in ${sheet}`, list.map(ref));
    for (const o of objs) {
      if (o.kind === 'sheetsymbol') {
        const seen = new Map<string, SchObject[]>();
        for (const e of objs) if (e.kind === 'sheetentry' && e.owner === o.index) seen.set(e.name, [...(seen.get(e.name) ?? []), e]);
        for (const [n, list] of seen) if (list.length > 1) report('DuplicateSheetEntrysInSheetSymbol', sheet, `Duplicate Sheet Entries ${n} in Sheet Symbol ${symbolNames(doc, o.index).designator}`, list.map(ref));
      } else if (o.kind === 'component' && isShown(doc, o) && !masked(o)) {
        const seen = new Map<string, SchObject[]>();
        for (const pn of ownedBy(doc).get(o.index) ?? []) if (pn.kind === 'pin' && (pn.ownerPartId <= 0 || pn.ownerPartId === o.partId) && pn.ownerDisplayMode === o.displayMode && pn.designator) seen.set(pn.designator, [...(seen.get(pn.designator) ?? []), pn]);
        for (const [n, list] of seen) if (list.length > 1) report('DuplicatePinsInComponent', sheet, `Duplicate pins in component ${o.designator}: Pin ${n}`, list.map(ref));
      } else if (o.kind === 'text' && o.role === 'parameter' && (o.owner < 0 || objs[o.owner]?.record === SR.SHEET)) {
        const n = doc.records[o.index + 1]?.bag?.get('NAME');
        if (n?.toLowerCase() === 'documentnumber' && o.text && o.text !== '*') docNumbers.set(o.text, [...(docNumbers.get(o.text) ?? []), sheet]);
      }
    }
  }

  /* ── Checks on one net ── */
  type Group = { pins: CompiledPin[]; names: { text: string; kind: string; ref: ObjRef }[]; refs: ObjRef[]; instRefs: { ref: ObjRef; inst: string }[]; sheets: Set<string>; wired: boolean;
    points: string[]; items: { code: number; label: string; ref: ObjRef; inst: string }[]; diff: boolean; wires: string[]; insts: Set<SheetInstance>; rules: string[] };
  const diffNets: { name: string; group: Group }[] = [];
  function netChecks(name: string, g: Group): void {
    // Connection Matrix: each pair of kinds of objects on the net
    const byCode = new Map<number, typeof g.items>();
    for (const it of g.items) byCode.set(it.code, [...(byCode.get(it.code) ?? []), it]);
    const codes = [...byCode.keys()].sort((a, b) => a - b);
    for (let i = 0; i < codes.length; i++) {
      for (let j = i; j < codes.length; j++) {
        const a = codes[i]!, b = codes[j]!;
        if (a === b && byCode.get(a)!.length < 2) continue;
        const lv = Math.max(erc.matrix[a]?.[b] ?? 0, erc.matrix[b]?.[a] ?? 0);
        if (!lv) continue;
        let list = a === b ? byCode.get(a)! : [...byCode.get(a)!, ...byCode.get(b)!];
        // A port's or sheet entry's direction is its own sheet's interface: it meets only what is on that sheet [est]
        // (else every Output Pin → Output Port → Output Sheet Entry chain would be an error); pins meet pins across the net.
        if (a >= 8 || b >= 8) {
          const at = (code: number, inst: string) => byCode.get(code)!.filter((x) => x.inst === inst);
          const insts = new Set(list.map((x) => x.inst));
          list = [...insts].flatMap((t) => { const xa = at(a, t), xb = a === b ? xa : at(b, t); return (a === b ? xa.length >= 2 : xa.length && xb.length) ? (a === b ? xa : [...xa, ...xb]) : []; });
          if (!list.length) continue;
        }
        const what = a === b ? `multiple ${CONNECTION_CODES[a]}s` : `${CONNECTION_CODES[a]} and ${CONNECTION_CODES[b]} objects`;
        raw.push({ level: lv === 1 ? 'warn' : 'error', fatal: lv === 3 || undefined, kind: 'Matrix', sheet: list[0]!.ref.sheet,
          message: `Net ${name} contains ${what} (${list.map((x) => x.label).join(',')})`, refs: list.map((x) => x.ref), points: g.points });
      }
    }
    // Inputs with nothing to drive them
    const inputs = g.pins.filter((p) => p.electrical === 0);
    if (inputs.length) {
      // Drivers: outputs, I/O, open collector / emitter, HiZ, power pins, power objects; passives and inputs are not
      const drivers = g.pins.some((p) => [1, 2, 3, 5, 6, 7].includes(p.electrical)) || g.names.some((n) => n.kind === 'power' || n.kind === 'hidden');
      if (!drivers) {
        const pinList = (g.pins.every((p) => p.electrical === 0) ? inputs : g.pins).map((p) => `Pin ${p.designator}-${p.pin}`).join(',');
        if (g.pins.every((p) => p.electrical === 0) && !g.names.length) report('FloatingInputPinsOnNet', inputs[0]!.ref.sheet, `Net ${name} contains floating input pins (${pinList})`, inputs.map((p) => p.ref), g.points);
        else report('NetWithNoDrivingSource', inputs[0]!.ref.sheet, `Net ${name} has no driving source (${pinList})`, inputs.map((p) => p.ref), g.points);
      }
    }
    if (g.diff) diffNets.push({ name, group: g });
  }
  function diffPairChecks(): void {
    const names = new Set(diffNets.map((d) => d.name.toUpperCase()));
    for (const d of diffNets) {
      const m = /^(.*)_([PN])$/i.exec(d.name);
      if (!m) continue;
      const other = `${m[1]}_${m[2]!.toUpperCase() === 'P' ? 'N' : 'P'}`.toUpperCase();
      if (names.has(other)) continue;
      const kind = m[2]!.toUpperCase() === 'P' ? 'DifferentialPairMissingNegativeNet' : 'DifferentialPairMissingPositiveNet';
      report(kind, d.group.refs[0]?.sheet ?? '', `${m[2]!.toUpperCase() === 'P' ? 'Missing Negative Net' : 'Missing Positive Net'} in Differential Pair ${m[1]}`, d.group.refs.slice(0, 1), d.group.points);
    }
  }

  /* ── Checks across the project ── */
  function projectChecks(): void {
    const sym = new Map<string, typeof symbolNamesSeen>();
    for (const s of symbolNamesSeen) if (s.designator) sym.set(s.designator, [...(sym.get(s.designator) ?? []), s]);
    for (const [n, list] of sym) if (list.length > 1 && new Set(list.map((x) => x.sheet)).size === 1) report('DuplicateSheetSymbolDesignator', list[0]!.sheet, `Duplicate Sheet Symbol Names ${n}`, list.map((x) => x.ref));
    for (const [id, list] of uniqueIds) {
      const des = new Set(list.map((x) => x.des));
      if (list.length > 1 && des.size > 1) report('DuplicateUniqueIDs', list[0]!.ref.sheet, `Duplicate Unique ID ${id} (${[...des].join(', ')})`, list.map((x) => x.ref));
    }
    for (const [n, list] of docNumbers) if (list.length > 1) report('DuplicateDocumentNumbers', list[0]!, `Duplicate sheet numbers ${n} (${list.join(', ')})`, []);
    if (scope === 'hierarchical' && hierarchy.roots.filter((r) => r.children.length || hierarchy.roots.length > 1).length > 1) {
      report('MultipleTopLevelDocuments', hierarchy.roots[0]!.sheet, `Multiple Top-Level Documents (${hierarchy.roots.map((r) => r.sheet).join(', ')})`, []);
    }
    // Parts of a multi-part package that were never placed
    const parts = new Map<string, { libRef: string; count: number; placed: Set<number>; ref: ObjRef }>();
    for (const { name: sheet, doc } of sheets) {
      for (const o of doc.objects) {
        if (o.kind !== 'component' || o.partCount <= 2 || !o.designator || o.designator.endsWith('?')) continue;
        const e = parts.get(o.designator) ?? { libRef: o.libRef, count: o.partCount - 1, placed: new Set<number>(), ref: { sheet, index: o.index } };
        e.placed.add(o.partId);
        parts.set(o.designator, e);
      }
    }
    for (const [des, e] of parts) {
      const missing = Array.from({ length: e.count }, (_, i) => i + 1).filter((i) => !e.placed.has(i));
      if (missing.length) report('UnusedPartInComponent', e.ref.sheet, `Component ${des} ${e.libRef} has unused sub-part (${missing.map(partLetter).join(', ')})`, [e.ref]);
    }
    void ERC_KINDS;
  }

  // Harness bundles: a harness port joins the sheet entry that stands for its sheet (or, flat,
  // ports of its name); the same entry name across a bundle is one net, named Bundle.Entry [est]
  for (const e of harnessSheetEntries) for (const p of harnessPorts) if (e.children.includes(p.sheet) && p.name.toUpperCase() === e.name.toUpperCase()) hdsu.union(e.node, p.node);
  if (scope !== 'hierarchical') {
    const first = new Map<string, string>();
    for (const p of harnessPorts) { const f = first.get(p.name); if (f) hdsu.union(f, p.node); else first.set(p.name, p.node); }
  }
  const bundleName = new Map<string, string>();
  for (const [n, v] of bundleNames) { const r = hdsu.find(n); if (!bundleName.has(r) || n.startsWith('hp:')) bundleName.set(r, v); }
  const perSignal = new Map<string, string>();
  for (const be of bundleEntries) {
    const r = hdsu.find(be.bundle);
    const key = `${r}|${be.name}`;
    const prev = perSignal.get(key);
    if (prev) dsu.union(prev, be.node); else perSignal.set(key, be.node);
    addName(be.node, `${bundleName.get(r) ?? 'Harness'}.${be.name}`, 'harness', be.ref, '');
  }

  // Name-based joins (net identifiers are not case-sensitive; labels and ports belong to their sheet instance)
  const byName = new Map<string, string>();
  for (const [node, list] of names) {
    for (const n of list) {
      if (n.kind === 'harness') continue;
      const t = n.text.toUpperCase();
      const key = n.kind === 'power' || n.kind === 'hidden' ? `power:${t}`
        : n.kind === 'entry' ? `port:${n.target}:${t}`
        : n.kind === 'offsheet' ? `offsheet:${n.inst}:${t}`
        : n.kind === 'port' ? (scope === 'flat' || scope === 'global' ? `port:${t}` : `port:${n.inst}:${t}`)
        : scope === 'global' ? `label:${t}` : `label:${n.inst}:${t}`; // labels, and bus members
      const prev = byName.get(key);
      if (prev) dsu.union(node, prev); else byName.set(key, node);
    }
  }

  // Collect nets
  const groups = new Map<string, Group>();
  for (const node of dsu.keys()) {
    if (node.includes('@')) continue;
    const root = dsu.find(node);
    if (!groups.has(root)) groups.set(root, { pins: [], names: [], refs: [], instRefs: [], sheets: new Set(), wired: false, points: [], items: [], diff: false, wires: [], insts: new Set(), rules: [] });
    const g = groups.get(root)!;
    const ni = nodeInst.get(node);
    if (ni) g.insts.add(ni);
    if (node.startsWith('w:')) { g.wired = true; g.wires.push(node); }
    if (diffPairNodes.has(node)) g.diff = true;
    for (const t of ruleNodes.get(node) ?? []) g.rules.push(t);
    const it = items.get(node);
    if (it) g.items.push(it);
    for (const k of nodePoints.get(node) ?? []) g.points.push(k);
    const pin = pins.get(node);
    if (pin) g.pins.push(pin);
    for (const n of names.get(node) ?? []) g.names.push(n);
    const ri = refInsts.get(node) ?? [];
    (refsOf.get(node) ?? []).forEach((r, i) => { g.refs.push(r); g.instRefs.push({ ref: r, inst: ri[i] ?? '' }); g.sheets.add(r.sheet); });
  }

  const nets: CompiledNet[] = [];
  for (const g of groups.values()) {
    if (g.wires.length && !g.pins.length && !g.names.length && !g.items.length) {
      for (const w of g.wires) { const i = wireInfo.get(w); if (i) report('UnconnectedWire', i.sheet, i.text, [i.ref], g.points); }
    }
    // Connection Matrix › Unconnected: a pin, port or sheet entry joined to nothing
    if (g.items.length === 1 && !g.wired && !g.names.some((n) => n.kind === 'label' || n.kind === 'power' || n.kind === 'hidden' || n.kind === 'member')) {
      const it = g.items[0]!, lv = erc.matrix[it.code]?.[UNCONNECTED] ?? 0;
      if (lv) raw.push({ level: lv === 1 ? 'warn' : 'error', fatal: lv === 3 || undefined, kind: 'Matrix', sheet: it.ref.sheet, message: `Unconnected ${CONNECTION_CODES[it.code]} ${it.label.replace(/^(Pin|Port|Sheet Entry) /, '')}`, refs: [it.ref], points: g.points });
    }
    if (!g.pins.length && !g.names.length) continue;
    // A lone unconnected pin, or a label / power object touching nothing, is not a net
    if (!g.wired && g.pins.length < 2 && !(g.pins.length === 1 && g.names.length)) continue;
    g.pins.sort((a, b) => natural(a.designator, b.designator) || natural(a.pin, b.pin));
    // Altium: net labels name nets; power ports too (lower priority); ports don't by default
    const labelNames = distinct(g.names.filter((n) => n.kind === 'label').map((n) => n.text)).sort(natural);
    const powerNames = distinct(g.names.filter((n) => n.kind === 'power' || n.kind === 'hidden').map((n) => n.text)).sort(natural);
    const harnessNames = [...new Set(g.names.filter((n) => n.kind === 'harness').map((n) => n.text))].sort(natural);
    const all = distinct([...labelNames, ...powerNames]);
    // Project Options › Options: sheet entries (and, if allowed, ports and off-sheet connectors) name nets that nothing else names
    const entryNames = opts.allowSheetEntryNetNames === false ? [] : distinct(g.names.filter((n) => n.kind === 'entry').map((n) => n.text)).sort(natural);
    const portNames = distinct(g.names.filter((n) => (opts.allowPortNetNames && n.kind === 'port') || n.kind === 'offsheet').map((n) => n.text)).sort(natural);
    // A bus's member names (a bus label's, port's or off-sheet connector's) name a net nothing else names
    const memberNames = distinct(g.names.filter((n) => n.kind === 'member').map((n) => n.text)).sort(natural);
    let name: string, auto = false;
    if (powerNames.length && (opts.powerPortNamesTakePriority || !labelNames.length)) name = powerNames[0]!;
    else if (labelNames.length) name = labelNames[0]!;
    else if (memberNames.length && g.pins.length) name = memberNames[0]!;
    else if (entryNames.length && g.pins.length) name = entryNames[0]!;
    else if (portNames.length && g.pins.length) name = portNames[0]!;
    else if (harnessNames.length && g.pins.length) name = harnessNames[0]!;
    else if (g.pins.length) { const p = g.pins[0]!; name = `Net${p.designator}_${p.pin}`; auto = true; }
    else continue;
    // A channel's own net (everything on it inside one channel) takes the room after its name [est]
    if (!auto && !powerNames.length) { const room = channelOf(g.insts, chSep); if (room) name = `${name}${chSep}${room}`; }
    const sheetsList = [...g.sheets].sort(natural);
    if (all.length > 1) {
      const what = g.names.filter((n) => n.kind !== 'port' && n.kind !== 'entry' && n.kind !== 'harness').map((n) => `${n.kind === 'label' ? 'Net Label' : 'Power Object'} ${n.text}`);
      report('MultipleNamesForNet', sheetsList[0] ?? '', `Nets Wire ${name} has multiple names (${[...new Set(what)].join(',')})`, g.names.map((n) => n.ref), g.points);
    }
    if (g.pins.length === 1 && (labelNames.length || g.wired)) {
      const p = g.pins[0]!;
      report('SinglePinNet', p.ref.sheet, `Net ${name} has only one pin (Pin ${p.designator}-${p.pin})`, [p.ref], g.points);
    }
    netChecks(name, g);
    nets.push({ name, auto, pins: g.pins, sheets: sheetsList, refs: g.refs, instRefs: g.instRefs, ...(g.rules.length ? { rules: [...new Set(g.rules)] } : {}) });
  }
  nets.sort((a, b) => natural(a.name, b.name));
  diffPairChecks();

  // Components: merge multipart instances, flag duplicates and unannotated parts
  const byDesig = new Map<string, CompiledComponent>();
  const partsSeen = new Map<string, Map<number, ObjRef>>();
  for (const c of components) {
    const prev = byDesig.get(c.designator);
    const part = partOf.get(c) ?? 0;
    if (!prev) { byDesig.set(c.designator, { ...c, refs: [...c.refs], refInsts: c.refs.map(() => c.inst ?? '') }); partsSeen.set(c.designator, new Map([[part, c.refs[0]!]])); continue; }
    if (prev.libRef === c.libRef && prev.parts > 1) {
      // The same part of a package placed twice (two U1A)
      const seen = partsSeen.get(c.designator)!, other = seen.get(part);
      if (other && c.designator && !c.designator.includes('?')) report('DuplicateSubParts', c.sheet, `Duplicate Component Designators ${c.designator}${partLetter(part)}`, [other, ...c.refs]);
      seen.set(part, c.refs[0]!);
      prev.refs.push(...c.refs);
      prev.refInsts?.push(...c.refs.map(() => c.inst ?? ''));
      continue;
    }
    report('DuplicateComponentDesignator', c.sheet, `Duplicate Component Designators ${c.designator}`, [...prev.refs, ...c.refs]);
  }
  for (const c of byDesig.values()) {
    if (!c.designator || c.designator.includes('?')) report('UnDesignatedPart', c.sheet, `Un-Designated Part ${c.designator || '(blank)'}`, c.refs);
  }
  projectChecks();

  // No ERC markers: an active one suppresses what happens at its spot (all, or the kinds it names)
  const kept = raw.filter((m) => !m.points?.some((pt) => noErc.get(pt)?.some((n) => n.all || (m.kind && n.kinds.has(ercKind(m.kind)?.label.toLowerCase() ?? '')) || (m.kind === 'Matrix' && n.matrix))));
  const order = (m: CompileMessage) => (m.fatal ? 0 : m.level === 'error' ? 1 : m.level === 'warn' ? 2 : 3);
  kept.sort((a, b) => order(a) - order(b));
  return { components: [...byDesig.values()].sort((a, b) => natural(a.designator, b.designator)), nets, messages: kept, scope, hierarchy };
}

/** Names without repeats, ignoring case (the first spelling met is kept). */
function distinct(list: string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const n of list) if (!seen.has(n.toUpperCase())) { seen.add(n.toUpperCase()); out.push(n); }
  return out;
}

/** The channel a net lies in: when every instance it touches is in one channel (or below it), that channel's room. */
function channelOf(insts: Set<SheetInstance>, sep = '_'): string | null {
  const list = [...insts];
  if (!list.length || list.some((i) => !i.rooms.length)) return null;
  const top = list.reduce((a, b) => (b.rooms.length < a.rooms.length ? b : a));
  return list.every((i) => top.rooms.every((r, k) => i.rooms[k] === r)) ? top.rooms.join(sep) : null;
}

/** Comment parameters like "=Value" refer to another parameter. */
function resolveComment(c: string, params: Record<string, string>): string {
  if (c.startsWith('=')) {
    const key = c.slice(1).toLowerCase();
    for (const [k, v] of Object.entries(params)) if (k.toLowerCase() === key) return v;
  }
  return c;
}
