/**
 * A net as Signal Integrity sees it: its copper made into transmission lines (each track a line of
 * its layer's impedance and delay, from the layer stack and the board's impedance formulas; the
 * track ends that meet, the pads and vias they land on, and the T-junctions made into nodes), the
 * nets joined to it through series resistors and inductors, the pins with their models (the chosen
 * driver a source behind its output resistance; the receivers their input capacitance and clamp
 * diodes) and the resistors and capacitors to supplies and ground. Pads the copper doesn't reach
 * are joined by estimated lines (straight-line distance, the setup's impedance); a net with no
 * pins placed on a board (from the schematic alone) is a star of the setup's average length.
 */
import type { Vec2 } from '../core/geom';
import { UNITS_PER_MM } from '../core/units';
import { NO_NET, copperNet, inPour, type PcbDocument, type PcbPad } from '../model/pcb';
import { isCopper } from '../model/layers';
import { readStack } from '../model/pcbStack';
import { boardFormulas, impedanceOf, stackGeometry, type LayerGeometry } from '../model/impedance';
import { addNode, newCircuit, type Circuit } from './circuit';
import { technology, valueOf, type IcModel } from './models';

const C0 = 299_792_458;
const metres = (u: number) => u / UNITS_PER_MM / 1000;

export interface SiSetup {
  /** For lines the copper doesn't give: the impedance (Ω) and the average length (board units, schematic only). */
  trackZ: number; avgLength: number;
  /** The default IC technology. */
  tech: string;
  /** Supply nets and their voltages, by name (upper case); grounds at 0. */
  supplies: Map<string, number>;
}
export interface SiContext {
  setup: SiSetup;
  /** designator-pin (upper case) → electrical type (the schematic's: 0 input … 7 power). */
  pinTypes?: Map<string, number>;
  /** IC models by designator (upper case); the rest take the setup's technology. */
  models: Map<string, IcModel>;
  /** Parts' Signal Integrity types by designator (upper case): the schematic's SI models, the user's; the rest by their designators. */
  types?: Map<string, SiType>;
  /** Passives' values by designator (upper case; Ω, F, H): the schematic's; the rest from the board's comments. */
  values?: Map<string, number>;
}

/** AD's Signal Integrity model types. */
export type SiType = 'IC' | 'Resistor' | 'Capacitor' | 'Inductor' | 'Diode' | 'BJT' | 'Connector' | 'None';
export const SI_TYPES: SiType[] = ['IC', 'Resistor', 'Capacitor', 'Inductor', 'Diode', 'BJT', 'Connector', 'None'];
/** A part's type by its designator (R1 a resistor, U3 an IC, J2 a connector …), None when it doesn't say. */
export function typeByDesignator(des: string): SiType {
  if (/^R(N)?\d/i.test(des)) return 'Resistor';
  if (/^C\d/i.test(des)) return 'Capacitor';
  if (/^(L|FB)\d/i.test(des)) return 'Inductor';
  if (/^(U|IC)\d/i.test(des)) return 'IC';
  if (/^(D|LED)\d/i.test(des)) return 'Diode';
  if (/^(Q|T)\d/i.test(des)) return 'BJT';
  if (/^(J|P|X|CN|CON)\d/i.test(des)) return 'Connector';
  return 'None';
}
export const siTypeOf = (ctx: SiContext, des: string): SiType => ctx.types?.get(des.toUpperCase()) ?? typeByDesignator(des);

export interface SiPinRef { designator: string; pin: string; node: number; model: IcModel }
export interface SiNetwork {
  circuit: Circuit;
  driver: SiPinRef;
  receivers: SiPinRef[];
  nets: string[];
  /** Routed length (board units), the lines' impedance range, whether some of it is estimated. */
  length: number; zMin: number; zMax: number; estimated: boolean;
  /** The driver's source: its level is set by the analysis (a step up or down). */
  source: number;
}

const GROUND = /^(A|D|P|S|CHASSIS_?|EARTH_?)?(GND|VSS|0V)\w*$/i;

/** A supply's voltage by its name (+3V3 → 3.3, 5V → 5, VCC → the technology's), else null; grounds 0. */
export function supplyVoltage(name: string, setup: SiSetup): number | null {
  const n = name.toUpperCase();
  if (setup.supplies.has(n)) return setup.supplies.get(n)!;
  if (GROUND.test(name)) return 0;
  const m = /^\+?(\d+)V(\d*)$/i.exec(name) ?? /^\+?(\d+(?:\.\d+)?)V$/i.exec(name) ?? /^V(?:CC|DD)_?(\d+)V(\d+)$/i.exec(name) ?? /^\+?(\d+)V(\d+)\w*$/i.exec(name);
  if (m) return Number(`${m[1]}.${m[2] || 0}`);
  // Supplies by their names, at the technology's level when they don't say theirs
  if (/^(A|D)?V(CC|DD|IN|IO|DDIO|DDA|DDD|CORE|BAT|BUS|SYS|REF|PP|DDQ)\w*$/i.test(name) || /^(AVDD|DVDD|AVCC|DVCC|P3V3|V3V3)\w*$/i.test(name)) return technology(setup.tech).vcc;
  return null;
}

export interface Layered { geo: Map<number, LayerGeometry>; f: ReturnType<typeof boardFormulas> }
export function layersOf(doc: PcbDocument): Layered {
  const geo = new Map<number, LayerGeometry>();
  try { for (const g of stackGeometry(readStack(doc.board.bag!, doc.board.copperStack))) geo.set(g.layer, g); } catch { /* no stack: the setup's figures */ }
  return { geo, f: boardFormulas(doc.board.bag) };
}
/** A track's impedance (Ω) and delay per metre (s/m) on its layer. */
export function lineOf(l: Layered, layer: number, width: number, z: number): { z: number; perM: number } {
  const g = l.geo.get(layer);
  if (!g) return { z, perM: Math.sqrt(4) / C0 };
  const zz = impedanceOf(l.f, g, width);
  const h = g.traceToPlane || 1, er = g.er || 4.2;
  const eff = g.kind === 'stripline' ? er : (er + 1) / 2 + (er - 1) / 2 / Math.sqrt(1 + (12 * h) / Math.max(width, 1));
  return { z: Number.isFinite(zz) && zz > 5 && zz < 300 ? zz : z, perM: Math.sqrt(eff) / C0 };
}

interface Graph { nodes: Vec2[]; edges: { a: number; b: number; z: number; td: number; len: number }[]; padNode: Map<PcbPad, number> }

/** A net's copper as nodes and lines. */
function copperGraph(doc: PcbDocument, net: number, l: Layered, z0: number): Graph {
  type Seg = { a: Vec2; b: Vec2; layer: number; width: number; len: number; arc?: boolean };
  const segs: Seg[] = [];
  const pads: PcbPad[] = [], vias: { at: Vec2; d: number }[] = [];
  for (const p of doc.prims) {
    if (p.kind === 'pad') { if (p.net === net) pads.push(p); continue; }
    if (copperNet(doc, p) !== net || inPour(p)) continue;
    if (p.kind === 'via') vias.push({ at: p.at, d: p.diameter });
    else if (p.kind === 'track' && isCopper(p.layer) && !p.keepout) segs.push({ a: p.a, b: p.b, layer: p.layer, width: p.width, len: Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) });
    else if (p.kind === 'arc' && isCopper(p.layer) && !p.keepout) {
      const sweep = (((p.end - p.start) % 360) + 360) % 360 || 360;
      const at = (deg: number) => ({ x: p.c.x + p.r * Math.cos((deg * Math.PI) / 180), y: p.c.y + p.r * Math.sin((deg * Math.PI) / 180) });
      segs.push({ a: at(p.start), b: at(p.start + sweep), layer: p.layer, width: p.width, len: (p.r * Math.PI * sweep) / 180, arc: true });
    }
  }
  const tol = 5000; // half a mil
  // T-junctions: a track end on another track's run splits it there
  const splits = segs.map(() => [] as number[]);
  const ends = segs.flatMap((s) => [{ p: s.a, layer: s.layer }, { p: s.b, layer: s.layer }]);
  segs.forEach((s, k) => {
    if (s.arc) return;
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, l2 = dx * dx + dy * dy;
    if (!l2) return;
    for (const e of ends) {
      if (e.layer !== s.layer) continue;
      const t = ((e.p.x - s.a.x) * dx + (e.p.y - s.a.y) * dy) / l2;
      if (t <= 0.001 || t >= 0.999) continue;
      const d = Math.hypot(s.a.x + t * dx - e.p.x, s.a.y + t * dy - e.p.y);
      if (d <= Math.max(tol, s.width / 2)) splits[k]!.push(t);
    }
  });
  const pieces: Seg[] = [];
  segs.forEach((s, k) => {
    const ts = [...new Set(splits[k]!.map((t) => Math.round(t * 1e6) / 1e6))].sort((a, b) => a - b);
    let from = 0;
    for (const t of [...ts, 1]) {
      const p0 = { x: s.a.x + (s.b.x - s.a.x) * from, y: s.a.y + (s.b.y - s.a.y) * from }, p1 = { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
      pieces.push({ ...s, a: p0, b: p1, len: s.len * (t - from) });
      from = t;
    }
  });
  // Points: pads, vias, piece ends; joined where they meet
  const pts: { p: Vec2; layer: number | null; r: number; w?: number; h?: number }[] = [];
  pads.forEach((p) => pts.push({ p: p.at, layer: p.hole ? null : p.layer, r: 0, w: Math.max(p.top.w, p.top.h) / 2, h: Math.max(p.top.w, p.top.h) / 2 }));
  vias.forEach((v) => pts.push({ p: v.at, layer: null, r: v.d / 2 }));
  const pieceAt = pieces.map((s) => { const i = pts.length; pts.push({ p: s.a, layer: s.layer, r: 0 }, { p: s.b, layer: s.layer, r: 0 }); return i; });
  const up = pts.map((_, i) => i);
  const find = (i: number): number => { while (up[i] !== i) { up[i] = up[up[i]!]!; i = up[i]!; } return i; };
  const join = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) up[x] = y; };
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i]!, b = pts[j]!;
      if (a.layer !== null && b.layer !== null && a.layer !== b.layer) continue;
      const d = Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y);
      const reach = Math.max(tol, a.r, b.r, a.w ?? 0, b.w ?? 0);
      if (d <= reach) join(i, j);
    }
  }
  const nodeOf = new Map<number, number>();
  const nodes: Vec2[] = [];
  const node = (i: number) => { const r = find(i); if (!nodeOf.has(r)) { nodeOf.set(r, nodes.length); nodes.push(pts[r]!.p); } return nodeOf.get(r)!; };
  const padNode = new Map<PcbPad, number>();
  pads.forEach((p, k) => padNode.set(p, node(k)));
  const edges: Graph['edges'] = [];
  pieces.forEach((s, k) => {
    const a = node(pieceAt[k]!), b = node(pieceAt[k]! + 1);
    if (a === b) return;
    const ln = lineOf(l, s.layer, s.width, z0);
    edges.push({ a, b, z: ln.z, td: metres(s.len) * ln.perM, len: s.len });
  });
  return { nodes, edges, padNode };
}

/** A pin's part of the circuit: its capacitance and clamps (a receiver), or the source behind it (the driver). */
function addPin(c: Circuit, node: number, m: IcModel): void {
  c.caps.push({ a: node, b: 0, c: m.cin });
  if (m.gndClamp) c.nl.push({ a: node, ref: 0, table: m.gndClamp });
  if (m.powerClamp) c.nl.push({ a: node, ref: m.vcc, table: m.powerClamp });
}

/** The role of a pin: drives (outputs), drives and listens (I/O; any IC pin without the schematic), listens (inputs), none (supplies). */
function roleOf(ctx: SiContext, des: string, pin: string): 'out' | 'io' | 'in' | 'none' {
  const t = ctx.pinTypes?.get(`${des}-${pin}`.toUpperCase());
  if (t === undefined) return 'io';
  return t === 7 ? 'none' : t === 2 || t === 3 || t === 5 || t === 6 ? 'out' : t === 1 ? 'io' : 'in';
}

/**
 * The network of a board's net (and the nets joined to it through series parts), or why it can't
 * be analysed: no driver, no receiver, a supply.
 */
export function boardNetwork(doc: PcbDocument, net: number, ctx: SiContext): SiNetwork | string {
  const name = doc.nets[net]?.name ?? '';
  if (supplyVoltage(name, ctx.setup) !== null) return 'a supply net';
  const isRes = (d: string) => siTypeOf(ctx, d) === 'Resistor', isCap = (d: string) => siTypeOf(ctx, d) === 'Capacitor', isInd = (d: string) => siTypeOf(ctx, d) === 'Inductor';
  const isIc = (d: string) => siTypeOf(ctx, d) === 'IC';
  const desOf = new Map(doc.components.map((k) => [k.index, k.designator]));
  const commentOf = (i: number) => { const t = doc.prims.find((p) => p.kind === 'text' && p.isComment && p.component === i); return t?.kind === 'text' ? t.text : ''; };
  const padsBy = new Map<number, PcbPad[]>();
  for (const p of doc.prims) if (p.kind === 'pad' && p.component !== NO_NET) padsBy.set(p.component, [...(padsBy.get(p.component) ?? []), p]);
  // The nets joined through series resistors and inductors (not to supplies), a few at most
  const set = [net];
  for (let k = 0; k < set.length && set.length < 4; k++) {
    for (const p of doc.prims) {
      if (p.kind !== 'pad' || p.net !== set[k]) continue;
      const d = desOf.get(p.component) ?? '';
      if (!isRes(d) && !isInd(d)) continue;
      const ps = padsBy.get(p.component) ?? [];
      if (ps.length !== 2) continue;
      const other = ps.find((q) => q !== p)!;
      const on = other.net;
      if (on === NO_NET || set.includes(on) || supplyVoltage(doc.nets[on]?.name ?? '', ctx.setup) !== null) continue;
      set.push(on);
    }
  }
  const l = layersOf(doc);
  const c = newCircuit();
  const nodeOf = new Map<string, number>();
  let length = 0, zMin = Infinity, zMax = 0, estimated = false;
  const graphs = set.map((n) => ({ net: n, g: copperGraph(doc, n, l, ctx.setup.trackZ) }));
  for (const { net: n, g } of graphs) {
    g.nodes.forEach((_, i) => nodeOf.set(`${n}:${i}`, addNode(c, `${doc.nets[n]?.name ?? n}#${i}`)));
    for (const e of g.edges) {
      c.tls.push({ a: nodeOf.get(`${n}:${e.a}`)!, b: nodeOf.get(`${n}:${e.b}`)!, z: e.z, td: e.td });
      length += e.len; zMin = Math.min(zMin, e.z); zMax = Math.max(zMax, e.z);
    }
  }
  const padNode = (p: PcbPad) => { const g = graphs.find((x) => x.net === p.net)?.g; const i = g?.padNode.get(p); return i === undefined ? 0 : nodeOf.get(`${p.net}:${i}`)!; };
  // Pins: the passives' elements, the ICs' models and roles
  const pins: { des: string; pin: string; node: number; role: ReturnType<typeof roleOf>; model: IcModel; onMain: boolean }[] = [];
  const done = new Set<number>();
  for (const { net: n } of graphs) {
    for (const p of doc.prims) {
      if (p.kind !== 'pad' || p.net !== n || p.component === NO_NET) continue;
      const des = desOf.get(p.component) ?? '';
      const node = padNode(p);
      if (isRes(des) || isCap(des) || isInd(des)) {
        if (done.has(p.component)) continue;
        const ps = padsBy.get(p.component) ?? [];
        if (ps.length !== 2) continue;
        const other = ps.find((q) => q !== p)!;
        const val = ctx.values?.get(des.toUpperCase()) ?? valueOf(commentOf(p.component), isRes(des) ? 'R' : isCap(des) ? 'F' : 'H');
        const oName = doc.nets[other.net]?.name ?? '';
        const rail = other.net === NO_NET ? null : supplyVoltage(oName, ctx.setup);
        if (set.includes(other.net)) {
          done.add(p.component);
          const b = padNode(other);
          if (isRes(des)) c.res.push({ a: node, b, r: Number.isFinite(val) && val > 0 ? val : 33 });
          else if (isInd(des)) c.res.push({ a: node, b, r: 0.5 });
          else c.caps.push({ a: node, b, c: Number.isFinite(val) && val > 0 ? val : 1e-9 });
        } else if (rail !== null) {
          if (isRes(des) && Number.isFinite(val) && val > 0) { if (rail === 0) c.res.push({ a: node, b: 0, r: val }); else c.srcs.push({ a: node, r: val, v: () => rail }); }
          else if (isCap(des) && Number.isFinite(val) && val > 0) c.caps.push({ a: node, b: 0, c: val });
        }
        continue;
      }
      if (!isIc(des)) continue;
      const role = roleOf(ctx, des, p.name);
      if (role === 'none') continue;
      pins.push({ des, pin: p.name, node, role, model: ctx.models.get(des.toUpperCase()) ?? technology(ctx.setup.tech), onMain: n === net });
    }
  }
  // The driver: an output on the net itself first, then an I/O; the rest listen
  const order = (x: (typeof pins)[number]) => (x.onMain ? 0 : 2) + (x.role === 'out' ? 0 : x.role === 'io' ? 1 : 9);
  const drv = [...pins].filter((x) => x.role === 'out' || x.role === 'io').sort((a, b) => order(a) - order(b) || a.des.localeCompare(b.des, 'en', { numeric: true }))[0];
  if (!drv) return 'no driver (an output or I/O pin) on it';
  const receivers = pins.filter((x) => x !== drv);
  if (!receivers.length) return 'no receiver on it';
  // Pads the copper doesn't reach from the driver: joined by estimated lines to the nearest node reached
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => { adj.set(a, [...(adj.get(a) ?? []), b]); adj.set(b, [...(adj.get(b) ?? []), a]); };
  for (const t of c.tls) link(t.a, t.b);
  for (const r of c.res) if (r.a && r.b) link(r.a, r.b);
  for (const k of c.caps) if (k.a && k.b) link(k.a, k.b);
  const pos = new Map<number, Vec2>();
  for (const { net: n, g } of graphs) g.nodes.forEach((v, i) => pos.set(nodeOf.get(`${n}:${i}`)!, v));
  const reached = new Set<number>([drv.node]);
  const grow = () => { const q = [...reached]; while (q.length) { const x = q.pop()!; for (const y of adj.get(x) ?? []) if (!reached.has(y)) { reached.add(y); q.push(y); } } };
  grow();
  for (const r of receivers) {
    if (reached.has(r.node)) continue;
    const at = pos.get(r.node)!;
    let best = drv.node, bd = Infinity;
    for (const n of reached) { const p = pos.get(n); if (!p) continue; const d = Math.abs(p.x - at.x) + Math.abs(p.y - at.y); if (d < bd) { bd = d; best = n; } }
    const lenU = Number.isFinite(bd) ? bd : ctx.setup.avgLength;
    c.tls.push({ a: best, b: r.node, z: ctx.setup.trackZ, td: Math.max(1e-12, metres(lenU) * (2 / C0)) });
    link(best, r.node); length += lenU; estimated = true;
    zMin = Math.min(zMin, ctx.setup.trackZ); zMax = Math.max(zMax, ctx.setup.trackZ);
    grow();
  }
  for (const r of receivers) addPin(c, r.node, r.model);
  // The driver: its pin's capacitance and clamps, and the source (its level set by the analysis)
  addPin(c, drv.node, drv.model);
  const source = c.srcs.length;
  c.srcs.push({ a: drv.node, r: drv.model.rdown, v: () => drv.model.vlow });
  return {
    circuit: c, source, nets: set.map((n) => doc.nets[n]?.name ?? String(n)),
    driver: { designator: drv.des, pin: drv.pin, node: drv.node, model: drv.model },
    receivers: receivers.map((r) => ({ designator: r.des, pin: r.pin, node: r.node, model: r.model })),
    length, zMin: Number.isFinite(zMin) ? zMin : ctx.setup.trackZ, zMax: zMax || ctx.setup.trackZ, estimated,
  };
}

/** A net known only from the schematic: the driver joined to each receiver by a line of the setup's average length. */
export function starNetwork(netName: string, pins: { designator: string; pin: string }[], ctx: SiContext): SiNetwork | string {
  if (supplyVoltage(netName, ctx.setup) !== null) return 'a supply net';
  const ics = pins.filter((p) => siTypeOf(ctx, p.designator) === 'IC').map((p) => ({ ...p, role: roleOf(ctx, p.designator, p.pin), model: ctx.models.get(p.designator.toUpperCase()) ?? technology(ctx.setup.tech) })).filter((p) => p.role !== 'none');
  const drv = [...ics].filter((p) => p.role === 'out' || p.role === 'io').sort((a, b) => (a.role === 'out' ? 0 : 1) - (b.role === 'out' ? 0 : 1))[0];
  if (!drv) return 'no driver (an output or I/O pin) on it';
  const rec = ics.filter((p) => p !== drv);
  if (!rec.length) return 'no receiver on it';
  const c = newCircuit();
  const d = addNode(c, `${drv.designator}-${drv.pin}`);
  const td = metres(ctx.setup.avgLength) * (2 / C0);
  const receivers = rec.map((r) => { const n = addNode(c, `${r.designator}-${r.pin}`); c.tls.push({ a: d, b: n, z: ctx.setup.trackZ, td }); addPin(c, n, r.model); return { designator: r.designator, pin: r.pin, node: n, model: r.model }; });
  addPin(c, d, drv.model);
  const source = c.srcs.length;
  c.srcs.push({ a: d, r: drv.model.rdown, v: () => drv.model.vlow });
  return { circuit: c, source, nets: [netName], driver: { designator: drv.designator, pin: drv.pin, node: d, model: drv.model }, receivers, length: ctx.setup.avgLength * rec.length, zMin: ctx.setup.trackZ, zMax: ctx.setup.trackZ, estimated: true };
}
