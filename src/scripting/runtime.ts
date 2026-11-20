/**
 * What a script sees and does (R8): the board or footprint as plain objects (millimetres from the
 * board's origin, degrees, layers by name), and the changes it asks for, recorded as operations.
 * Nothing here touches the document: the app applies the operations afterwards, all as one undo
 * step (scripting/apply.ts).
 *
 * `scriptRuntime` runs inside the script's sealed frame (scripting/sandbox.ts takes its source
 * with Function.prototype.toString), so it must stand alone: no imports, no outside names, nothing
 * the compiler adds helpers for. Tests call it directly.
 */

/** The document as a script gets it. */
export interface Snapshot {
  kind: 'board' | 'footprint';
  name: string;
  /** The board shape (a footprint has none). */
  outline: { x: number; y: number }[];
  layers: string[];
  nets: string[];
  components: SnapComponent[];
  pads: SnapPrim[]; tracks: SnapPrim[]; arcs: SnapPrim[]; vias: SnapPrim[]; texts: SnapPrim[]; regions: SnapPrim[]; fills: SnapPrim[];
  /** The ids of what is selected. */
  selection: string[];
}
export interface SnapComponent {
  id: string; designator: string; comment: string; footprint: string; x: number; y: number; rotation: number; side: 'top' | 'bottom'; locked: boolean;
}
/** A primitive: its id, kind, and its fields (see API_DOC). */
export type SnapPrim = { id: string; kind: string } & Record<string, unknown>;

/** A change a script asks for. */
export type ScriptOp =
  | { op: 'compMove'; id: string; x: number; y: number }
  | { op: 'compRotate'; id: string; rotation: number }
  | { op: 'designator'; id: string; value: string }
  | { op: 'remove'; id: string }
  | { op: 'net'; id: string; net: string | null }
  | { op: 'move'; id: string; dx: number; dy: number }
  | { op: 'width'; id: string; width: number }
  | { op: 'add'; id: string; kind: 'track' | 'arc' | 'via' | 'text' | 'region' | 'pad'; fields: Record<string, unknown> }
  | { op: 'select'; ids: string[] };

export interface ScriptFile { name: string; text: string }
export type ScriptMessage =
  | { type: 'done'; ops: ScriptOp[]; files: ScriptFile[]; log: string[] }
  | { type: 'error'; message: string; stack?: string; log: string[] };

export type ScriptMain = (board: unknown, output: unknown, print: (...a: unknown[]) => void, mm: (v: number) => number, mil: (v: number) => number, inch: (v: number) => number, toMil: (v: number) => number, toInch: (v: number) => number) => unknown;

/** The objects and their methods a script works with; posts what it asked for when the script ends. */
export function scriptRuntime(S: Snapshot, main: ScriptMain, post: (m: ScriptMessage) => void): void {
  const ops: ScriptOp[] = [];
  const files: ScriptFile[] = [];
  const log: string[] = [];
  const MAX_OPS = 200000;
  const op = (o: ScriptOp) => {
    if (ops.length >= MAX_OPS) throw new Error('Too many changes (' + MAX_OPS + ' at most)');
    ops.push(o);
  };
  const text = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  const MAX_LINES = 5000, MAX_FILES = 20;
  const print = (...a: unknown[]) => {
    if (log.length < MAX_LINES) log.push(a.map(text).join(' '));
    else if (log.length === MAX_LINES) log.push('… (lines after ' + MAX_LINES + ' left out)');
  };
  const num = (v: unknown, what: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(what + ' must be a number (got ' + text(v) + ')');
    return n;
  };
  const layerOk = (l: unknown, fallback: string): string => {
    const name = l === undefined ? fallback : String(l);
    const hit = S.layers.find((x) => x.toLowerCase() === name.toLowerCase());
    if (!hit) throw new Error('No layer "' + name + '" (the layers: ' + S.layers.slice(0, 12).join(', ') + '…)');
    return hit;
  };
  const netOk = (n: unknown): string | null => {
    if (n === null || n === undefined || n === '') return null;
    const name = String(n);
    if (S.nets.indexOf(name) < 0) throw new Error('No net "' + name + '" (nets come from the schematic)');
    return name;
  };
  const removed = new Set<string>();
  const live = (o: { id: string }, what: string) => { if (removed.has(o.id)) throw new Error(what + ' ' + o.id + ' was removed'); };
  const unlocked = (c: { locked: boolean; designator: string }) => { if (c.locked) throw new Error(c.designator + ' is locked: unlock it to move it'); };
  type Prim = SnapPrim & { remove(): void; setNet(n: string | null): Prim; moveBy(dx: number, dy: number): Prim; setWidth(w: number): Prim };
  const free = (p: SnapPrim) => !p.component;
  const ofPart = (p: SnapPrim) => 'This ' + p.kind + ' is part of ' + p.component + ': move the part itself (component.moveBy)';
  const norm = (d: number) => ((d % 360) + 360) % 360;
  /** Move a primitive's coordinates by (dx, dy). */
  const shift = (o: Record<string, unknown>, dx: number, dy: number) => {
    for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) if (typeof o[k] === 'number') o[k] = (o[k] as number) + (k[0] === 'x' ? dx : dy);
    if (Array.isArray(o.points)) o.points = (o.points as { x: number; y: number }[]).map((q) => ({ x: q.x + dx, y: q.y + dy }));
  };
  /** Turn a part's primitive by `deg` about (cx, cy), as the part turns. */
  const turn = (o: Record<string, unknown>, deg: number, cx: number, cy: number) => {
    const c = Math.cos((deg * Math.PI) / 180), sn = Math.sin((deg * Math.PI) / 180);
    const r = (x: unknown, y: unknown) => ({ x: cx + ((x as number) - cx) * c - ((y as number) - cy) * sn, y: cy + ((x as number) - cx) * sn + ((y as number) - cy) * c });
    if (o.kind === 'track') { const a = r(o.x1, o.y1), b = r(o.x2, o.y2); o.x1 = a.x; o.y1 = a.y; o.x2 = b.x; o.y2 = b.y; }
    else if (o.kind === 'fill') {
      const hw = ((o.x2 as number) - (o.x1 as number)) / 2, hh = ((o.y2 as number) - (o.y1 as number)) / 2;
      const m = r(((o.x1 as number) + (o.x2 as number)) / 2, ((o.y1 as number) + (o.y2 as number)) / 2);
      o.x1 = m.x - hw; o.y1 = m.y - hh; o.x2 = m.x + hw; o.y2 = m.y + hh; o.rotation = norm((o.rotation as number) + deg);
    } else if (Array.isArray(o.points)) o.points = (o.points as { x: number; y: number }[]).map((q) => r(q.x, q.y));
    else { const q = r(o.x, o.y); o.x = q.x; o.y = q.y; }
    if (o.kind === 'arc' && Math.abs((o.end as number) - (o.start as number)) % 360 !== 0) { o.start = norm((o.start as number) + deg); o.end = norm((o.end as number) + deg); }
    if (o.kind === 'pad' || o.kind === 'text') o.rotation = norm((o.rotation as number) + deg);
  };
  /** Each part's own primitives (its pads, outline, designator…), which move and turn with it. */
  const own = new Map<string, Prim[]>();
  const comps = S.components.map((c) => {
    const mine = () => own.get(c.id) ?? [];
    const o = {
      ...c,
      kind: 'component',
      pads: () => mine().filter((p) => p.kind === 'pad'),
      moveTo(x: number, y: number) {
        unlocked(o);
        const nx = num(x, 'x'), ny = num(y, 'y');
        for (const p of mine()) shift(p, nx - o.x, ny - o.y);
        o.x = nx; o.y = ny; op({ op: 'compMove', id: o.id, x: o.x, y: o.y }); return o;
      },
      moveBy(dx: number, dy: number) { return o.moveTo(o.x + num(dx, 'dx'), o.y + num(dy, 'dy')); },
      rotateTo(deg: number) {
        unlocked(o);
        const to = norm(num(deg, 'rotation'));
        for (const p of mine()) turn(p, to - o.rotation, o.x, o.y);
        o.rotation = to; op({ op: 'compRotate', id: o.id, rotation: o.rotation }); return o;
      },
      rotateBy(deg: number) { return o.rotateTo(o.rotation + num(deg, 'rotation')); },
      setDesignator(v: string) {
        const s = String(v).trim();
        if (!s) throw new Error('A designator can’t be empty');
        o.designator = s;
        for (const p of mine()) p.component = s;
        op({ op: 'designator', id: o.id, value: s }); return o;
      },
    };
    return o;
  });
  /** The lists as they are now (without what was removed), made again only after a change. */
  let version = 0;
  const cache = new Map<Prim[], { v: number; list: Prim[] }>();
  const listed = (l: Prim[]): Prim[] => {
    const c = cache.get(l);
    if (c && c.v === version) return c.list;
    const list = l.filter((o) => !removed.has(o.id));
    cache.set(l, { v: version, list });
    return list;
  };
  const prim = (p: SnapPrim): Prim => {
    const o: Prim = {
      ...p,
      remove() { live(o, o.kind); if (!free(o)) throw new Error(ofPart(o)); removed.add(o.id); version++; op({ op: 'remove', id: o.id }); },
      setNet(n: string | null) { live(o, o.kind); if (o.kind === 'text') throw new Error('A text has no net'); o.net = netOk(n); op({ op: 'net', id: o.id, net: o.net as string | null }); return o; },
      moveBy(dx: number, dy: number) {
        live(o, o.kind);
        if (!free(o)) throw new Error(ofPart(o));
        const x = num(dx, 'dx'), y = num(dy, 'dy');
        shift(o, x, y);
        op({ op: 'move', id: o.id, dx: x, dy: y }); return o;
      },
      setWidth(w: number) { live(o, o.kind); if (o.kind !== 'track' && o.kind !== 'arc') throw new Error('Only tracks and arcs have a width'); o.width = num(w, 'width'); op({ op: 'width', id: o.id, width: o.width as number }); return o; },
    };
    return o;
  };
  const pads = S.pads.map(prim), tracks = S.tracks.map(prim), arcs = S.arcs.map(prim), vias = S.vias.map(prim), texts = S.texts.map(prim), regions = S.regions.map(prim), fills = S.fills.map(prim);
  const byDesignator = new Map<string, string>();
  for (const c of S.components) if (!byDesignator.has(c.designator)) byDesignator.set(c.designator, c.id);
  for (const p of [...pads, ...tracks, ...arcs, ...texts, ...regions, ...fills]) {
    const id = p.component ? byDesignator.get(String(p.component)) : undefined;
    if (id) { const l = own.get(id) ?? []; l.push(p); own.set(id, l); }
  }
  const all = (): (Prim | (typeof comps)[number])[] => [...comps, ...listed(pads), ...listed(tracks), ...listed(arcs), ...listed(vias), ...listed(texts), ...listed(regions), ...listed(fills)];
  let selection = new Set(S.selection);
  let made = 0;
  const add = (kind: 'track' | 'arc' | 'via' | 'text' | 'region' | 'pad', fields: Record<string, unknown>, list: Prim[]) => {
    const id = 'new' + ++made;
    op({ op: 'add', id, kind, fields });
    const o = prim({ id, kind, ...fields });
    list.push(o);
    version++;
    return o;
  };
  const pt = (q: unknown) => {
    if (Array.isArray(q)) return { x: num(q[0], 'x'), y: num(q[1], 'y') };
    const r = q as { x: unknown; y: unknown };
    return { x: num(r?.x, 'x'), y: num(r?.y, 'y') };
  };
  const board = {
    kind: S.kind, name: S.name, outline: S.outline, layers: S.layers, nets: S.nets,
    components: comps,
    get pads() { return listed(pads); }, get tracks() { return listed(tracks); }, get arcs() { return listed(arcs); }, get vias() { return listed(vias); },
    get texts() { return listed(texts); }, get regions() { return listed(regions); }, get fills() { return listed(fills); },
    get selected() { return all().filter((o) => selection.has(o.id)); },
    component(designator: string) { return comps.find((c) => c.designator === String(designator)); },
    net(name: string) {
      const n = String(name);
      const on = (l: Prim[]) => listed(l).filter((o) => o.net === n);
      return { name: n, pads: on(pads), tracks: on(tracks), arcs: on(arcs), vias: on(vias), regions: on(regions), fills: on(fills) };
    },
    addTrack(f: { x1: number; y1: number; x2: number; y2: number; width?: number; layer?: string; net?: string }) {
      return add('track', { x1: num(f.x1, 'x1'), y1: num(f.y1, 'y1'), x2: num(f.x2, 'x2'), y2: num(f.y2, 'y2'), width: num(f.width ?? 0.254, 'width'), layer: layerOk(f.layer, 'Top Layer'), net: netOk(f.net), component: null }, tracks);
    },
    addArc(f: { x: number; y: number; radius: number; start?: number; end?: number; width?: number; layer?: string; net?: string }) {
      return add('arc', { x: num(f.x, 'x'), y: num(f.y, 'y'), radius: num(f.radius, 'radius'), start: num(f.start ?? 0, 'start'), end: num(f.end ?? 360, 'end'), width: num(f.width ?? 0.254, 'width'), layer: layerOk(f.layer, 'Top Layer'), net: netOk(f.net), component: null }, arcs);
    },
    addVia(f: { x: number; y: number; diameter?: number; hole?: number; net?: string }) {
      return add('via', { x: num(f.x, 'x'), y: num(f.y, 'y'), diameter: num(f.diameter ?? 0.6, 'diameter'), hole: num(f.hole ?? 0.3, 'hole'), net: netOk(f.net) }, vias);
    },
    addText(f: { x: number; y: number; text: string; height?: number; layer?: string; rotation?: number }) {
      return add('text', { x: num(f.x, 'x'), y: num(f.y, 'y'), text: String(f.text ?? ''), height: num(f.height ?? 1, 'height'), layer: layerOk(f.layer, 'Top Overlay'), rotation: num(f.rotation ?? 0, 'rotation'), component: null }, texts);
    },
    addPad(f: { x: number; y: number; name?: string; width?: number; height?: number; shape?: string; hole?: number; layer?: string; rotation?: number; net?: string }) {
      const shape = String(f.shape ?? 'round');
      if (['round', 'rect', 'roundrect', 'octagon'].indexOf(shape) < 0) throw new Error('A pad’s shape is round, rect, roundrect or octagon (not "' + shape + '")');
      const hole = num(f.hole ?? 0, 'hole'), width = num(f.width ?? 1, 'width');
      let name = f.name === undefined ? '' : String(f.name);
      if (f.name === undefined) {
        let top = 0;
        for (const p of listed(pads)) if (!p.component && /^\d+$/.test(String(p.name))) top = Math.max(top, Number(p.name));
        name = String(top + 1);
      }
      return add('pad', { x: num(f.x, 'x'), y: num(f.y, 'y'), name, width, height: num(f.height ?? width, 'height'), shape, hole, layer: layerOk(f.layer, hole > 0 ? 'Multi-Layer' : 'Top Layer'), rotation: num(f.rotation ?? 0, 'rotation'), net: netOk(f.net), component: null }, pads);
    },
    addRegion(f: { points: unknown[]; layer?: string; net?: string }) {
      const points = (f.points ?? []).map(pt);
      if (points.length < 3) throw new Error('A region needs 3 points at least');
      return add('region', { points, layer: layerOk(f.layer, 'Top Layer'), net: netOk(f.net), component: null }, regions);
    },
    select(objs: unknown) {
      const ids = (Array.isArray(objs) ? objs : [objs]).map((o) => (typeof o === 'string' ? o : (o as { id: string })?.id)).filter((x): x is string => typeof x === 'string');
      selection = new Set(ids);
      op({ op: 'select', ids });
    },
  };
  const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : typeof v === 'number' ? text(v) : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const file = (name: unknown, body: string) => {
    if (files.length >= MAX_FILES) throw new Error('Too many files (' + MAX_FILES + ' at most)');
    const n = String(name ?? '').trim();
    if (!n) throw new Error('A file needs a name');
    files.push({ name: n, text: body });
  };
  const output = {
    text(name: string, body: unknown) { file(name, String(body)); },
    csv(name: string, rows: unknown[][]) {
      if (!Array.isArray(rows)) throw new Error('output.csv takes a list of rows (each a list of cells)');
      file(name, rows.map((r) => (Array.isArray(r) ? r : [r]).map(csvCell).join(',')).join('\r\n') + '\r\n');
    },
  };
  const mm = (v: number) => v, mil = (v: number) => v * 0.0254, inch = (v: number) => v * 25.4, toMil = (v: number) => v / 0.0254, toInch = (v: number) => v / 25.4;
  let ran: unknown;
  try { ran = main(board, output, print, mm, mil, inch, toMil, toInch); } catch (e) { post({ type: 'error', message: String((e as Error)?.message ?? e), stack: String((e as Error)?.stack ?? ''), log }); return; }
  Promise.resolve(ran).then(
    () => post({ type: 'done', ops, files, log }),
    (e) => post({ type: 'error', message: String((e as Error)?.message ?? e), stack: String((e as Error)?.stack ?? ''), log }),
  );
}
