/**
 * A supply rail as the designer sees it: a net fed by one component at a voltage, the components
 * that draw from it and what each draws, and the net their currents come back on. Two sums on the
 * copper (analysis/power.ts), one for each net, and what they come to for each load: the voltage
 * it is left with, against the limits set.
 */

import type { BBox, Vec2 } from '../core/geom';
import { NO_NET, type PcbDocument } from '../model/pcb';
import type { LayerId } from '../model/layers';
import { METRE } from './copperNet';
import { startPower, type PowerJob, type PowerResult, type PowerSetup } from './power';

export interface RailSetup {
  /** The supply net, and the net the current returns on (null: the supply's own copper only). */
  supply: number; ret: number | null;
  /** The component that feeds it, and at what voltage. */
  source: number; voltage: number;
  /** What each component draws, amperes. */
  loads: { component: number; current: number }[];
  /** The copper's temperature °C, the plating in holes µm, grid cells a layer. */
  temperature: number; plating: number; cells: number;
  limits: RailLimits;
}
export interface RailLimits {
  /** The most a load may lose, as a percentage of the source's voltage. */
  drop: number;
  /** The temperature rise tracks and vias are allowed (IPC-2221), degrees. */
  rise: number;
  /** The most current a copper area may carry for its cross-section, A/mm². */
  density: number;
}
export const DEFAULT_LIMITS: RailLimits = { drop: 3, rise: 10, density: 50 };

/**
 * The current that raises a conductor's temperature by `rise` degrees: IPC-2221's chart as its
 * formula, I = k·ΔT^0.44·A^0.725 with A in square mils, k 0.048 on an outer layer and 0.024 inside
 * the board.
 */
export function ipc2221(areaM2: number, rise: number, inner: boolean): number {
  return (inner ? 0.024 : 0.048) * Math.max(0, rise) ** 0.44 * (areaM2 / 6.4516e-10) ** 0.725;
}

export interface NetComponent { component: number; designator: string; comment: string; pads: number[]; pins: string[] }

/** The components with pads on a net, in designator order. */
export function componentsOn(doc: PcbDocument, net: number): NetComponent[] {
  const by = new Map<number, NetComponent>();
  doc.prims.forEach((p, i) => {
    if (p.kind !== 'pad' || p.net !== net || p.component === NO_NET) return;
    const c = doc.components[p.component];
    if (!c) return;
    let e = by.get(p.component);
    if (!e) { e = { component: p.component, designator: c.designator, comment: '', pads: [], pins: [] }; by.set(p.component, e); }
    e.pads.push(i); e.pins.push(p.name);
  });
  for (const p of doc.prims) if (p.kind === 'text' && p.isComment && by.has(p.component)) by.get(p.component)!.comment = p.text;
  return [...by.values()].sort((a, b) => a.designator.localeCompare(b.designator, undefined, { numeric: true }));
}

/** The nets worth offering: those with pads on two components or more, the most connected first. */
export function railNets(doc: PcbDocument): { net: number; name: string; components: number }[] {
  const comps = new Map<number, Set<number>>();
  for (const p of doc.prims) if (p.kind === 'pad' && p.net !== NO_NET && p.component !== NO_NET) (comps.get(p.net) ?? comps.set(p.net, new Set()).get(p.net)!).add(p.component);
  return [...comps].filter(([, s]) => s.size >= 2).map(([net, s]) => ({ net, name: doc.nets[net]?.name ?? `Net ${net}`, components: s.size }))
    .sort((a, b) => b.components - a.components || a.name.localeCompare(b.name, undefined, { numeric: true }));
}
/** A net that looks like a ground by its name. */
export const groundName = (name: string): boolean => /^(A|D|P|S)?(GND|GROUND|VSS|0V)/i.test(name) || /GND$/i.test(name);

/** The two sums of a rail: the supply's and, if it has one, the return's. `field`: the copper's temperature from place to place, from a thermal analysis. */
export function railSetups(doc: PcbDocument, rail: RailSetup, field?: PowerSetup['field']): { supply: PowerSetup; ret: PowerSetup | null } {
  const name = (c: number) => doc.components[c]?.designator ?? String(c);
  const padsOf = (net: number, c: number) => { const out: number[] = []; doc.prims.forEach((p, i) => { if (p.kind === 'pad' && p.net === net && p.component === c) out.push(i); }); return out; };
  const loads = rail.loads.filter((l) => l.current > 0 && l.component !== rail.source);
  const common = { temperature: rail.temperature, plating: rail.plating * 1e-6, cells: rail.cells, picture: true, field };
  const supply: PowerSetup = { net: rail.supply, ...common, sources: [{ pads: padsOf(rail.supply, rail.source), voltage: rail.voltage }], loads: loads.map((l) => ({ name: name(l.component), pads: padsOf(rail.supply, l.component), current: l.current })) };
  const rn = rail.ret;
  const ret: PowerSetup | null = rn === null ? null
    : { net: rn, ...common, sources: [{ pads: padsOf(rn, rail.source), voltage: 0 }], loads: loads.map((l) => ({ name: name(l.component), pads: padsOf(rn, l.component), current: -l.current })) };
  return { supply, ret };
}

export interface RailRow {
  component: number; designator: string; current: number;
  /** The potential of its supply pads and of its return pads (0 with no return net); NaN where no copper joins them to the source. */
  supplyV: number; returnV: number;
  /** What it is left with between them, what it has lost, and that as a percentage of the source's voltage. */
  voltage: number; drop: number; percent: number;
  /** Fed, short of the limit, or not joined to the source (on which net). */
  state: 'ok' | 'over' | 'open'; open?: 'supply' | 'return' | 'both';
}

export interface RailIssue {
  kind: 'open' | 'drop' | 'track' | 'via' | 'density' | 'nopad';
  message: string;
  /** Where to look. */
  box?: BBox; layer?: LayerId; prims?: number[];
}

export interface RailResult {
  rail: RailSetup; supply: PowerResult; ret: PowerResult | null;
  rows: RailRow[]; issues: RailIssue[];
  /** What the source gives (amperes) and what the copper of both nets turns to heat (watts). */
  current: number; loss: number;
  /** The worst load's drop (volts), and the hardest worked copper (A/m²). */
  worstDrop: number; peakDensity: number;
}

const amps = (a: number): string => (Math.abs(a) >= 1 ? `${a.toFixed(2)} A` : `${(a * 1000).toFixed(0)} mA`);
const around = (at: Vec2, r: number): BBox => ({ minX: at.x - r, minY: at.y - r, maxX: at.x + r, maxY: at.y + r });

/** What one net's sum has to say against the limits. */
function netIssues(doc: PcbDocument, res: PowerResult, limits: RailLimits, layerName: (l: LayerId) => string): RailIssue[] {
  const out: RailIssue[] = [], cn = res.cn, net = doc.nets[cn.net]?.name ?? '', nL = cn.grid.layers.length;
  for (const i of res.missing) { const p = doc.prims[i]; if (p?.kind === 'pad') out.push({ kind: 'nopad', message: `${doc.components[p.component]?.designator ?? 'Pad'}-${p.name}: no copper of ${net} found under the pad`, box: around(p.at, 500000), prims: [i] }); }
  // Tracks: the worst length of each, against what IPC-2221 allows its cross-section
  const worst = new Map<number, { over: number; i: number; allow: number; k: number }>();
  cn.tracks.forEach((tp, k) => {
    const i = Math.abs(res.current[tp.link]!), allow = ipc2221(tp.width * METRE * cn.stack[tp.layer]!.thickness, limits.rise, tp.layer > 0 && tp.layer < nL - 1);
    if (i <= allow) return;
    const w = worst.get(tp.prim);
    if (!w || i / allow > w.over) worst.set(tp.prim, { over: i / allow, i, allow, k });
  });
  for (const [prim, w] of [...worst].sort((a, b) => b[1].over - a[1].over).slice(0, 50)) {
    const tp = cn.tracks[w.k]!, layer = cn.grid.layers[tp.layer]!;
    out.push({ kind: 'track', message: `${net}: a track on ${layerName(layer)} carries ${amps(w.i)}; ${amps(w.allow)} raises it ${limits.rise} °C`, layer, prims: [prim],
      box: { minX: Math.min(tp.a.x, tp.b.x) - tp.width, minY: Math.min(tp.a.y, tp.b.y) - tp.width, maxX: Math.max(tp.a.x, tp.b.x) + tp.width, maxY: Math.max(tp.a.y, tp.b.y) + tp.width } });
  }
  // Vias and plated holes: the barrel's wall as a conductor inside the board
  const vias: { over: number; issue: RailIssue }[] = [];
  cn.barrels.forEach((b, k) => {
    const i = res.barrelCurrent[k]!, plating = res.setup.plating ?? 25e-6, allow = ipc2221(Math.PI * (b.hole * METRE + plating) * plating, limits.rise, true);
    if (i > allow) vias.push({ over: i / allow, issue: { kind: 'via', message: `${net}: a ${doc.prims[b.prim]?.kind === 'pad' ? 'plated hole' : 'via'} carries ${amps(i)}; ${amps(allow)} raises it ${limits.rise} °C`, box: around(b.at, b.hole * 2), prims: [b.prim] } });
  });
  for (const v of vias.sort((a, b) => b.over - a.over).slice(0, 50)) out.push(v.issue);
  // Copper areas: the hardest worked place on each layer
  const { w: W, hgt: H, h, minX, minY } = cn.grid, limit = limits.density * 1e6;
  for (let li = 0; li < nL; li++) {
    let peak = 0, at = -1, over = 0;
    for (let c = 0; c < W * H; c++) { const j = res.density[li * W * H + c]!; if (j > limit) { over++; if (j > peak) { peak = j; at = c; } } }
    if (at < 0) continue;
    const p = { x: minX + ((at % W) + 0.5) * h, y: minY + (Math.floor(at / W) + 0.5) * h }, layer = cn.grid.layers[li]!;
    out.push({ kind: 'density', message: `${net}: copper on ${layerName(layer)} carries up to ${(peak / 1e6).toFixed(0)} A/mm² (${((over * h * h * METRE * METRE) * 1e6).toFixed(2)} mm² over ${limits.density} A/mm²)`, layer, box: around(p, Math.max(h * 12, 400000)) });
  }
  return out;
}

/** The rail's sums made into what the designer asked: each load's voltage, and what is out of limits. */
export function railResult(doc: PcbDocument, rail: RailSetup, supply: PowerResult, ret: PowerResult | null, layerName: (l: LayerId) => string = (l) => `layer ${l}`): RailResult {
  const rows: RailRow[] = [], issues: RailIssue[] = [];
  const netName = (n: number) => doc.nets[n]?.name ?? `Net ${n}`;
  const loads = rail.loads.filter((l) => l.current > 0 && l.component !== rail.source);
  loads.forEach((l, k) => {
    const s = supply.loads[k]!, r = ret?.loads[k], designator = doc.components[l.component]?.designator ?? String(l.component);
    const supplyV = s.connected ? s.worst : NaN, returnV = ret ? (r!.connected ? r!.worst : NaN) : 0;
    const voltage = supplyV - returnV, drop = rail.voltage - voltage, percent = rail.voltage ? (drop / Math.abs(rail.voltage)) * 100 : 0;
    const open: RailRow['open'] = !s.connected && ret && !r!.connected ? 'both' : !s.connected ? 'supply' : ret && !r!.connected ? 'return' : undefined;
    rows.push({ component: l.component, designator, current: l.current, supplyV, returnV, voltage, drop, percent, state: open ? 'open' : percent > rail.limits.drop ? 'over' : 'ok', open });
    const pads = [...supply.setup.loads[k]!.pads, ...(ret?.setup.loads[k]!.pads ?? [])];
    if (open) issues.push({ kind: 'open', message: `${designator}: no copper joins it to ${doc.components[rail.source]?.designator ?? 'the source'} on ${open === 'both' ? `${netName(rail.supply)} or ${netName(rail.ret!)}` : netName(open === 'supply' ? rail.supply : rail.ret!)}`, prims: pads });
    else if (percent > rail.limits.drop) issues.push({ kind: 'drop', message: `${designator}: ${voltage.toFixed(3)} V, ${(drop * 1000).toFixed(1)} mV (${percent.toFixed(1)} %) below the source; the limit is ${rail.limits.drop} %`, prims: pads });
  });
  if (!supply.setup.sources[0]!.pads.length) issues.unshift({ kind: 'open', message: `${doc.components[rail.source]?.designator ?? 'The source'} has no pad on ${netName(rail.supply)}` });
  issues.push(...netIssues(doc, supply, rail.limits, layerName));
  if (ret) issues.push(...netIssues(doc, ret, rail.limits, layerName));
  const fed = rows.filter((r) => r.state !== 'open');
  return {
    rail, supply, ret, rows, issues,
    current: fed.reduce((s, r) => s + r.current, 0), loss: supply.loss + (ret?.loss ?? 0),
    worstDrop: fed.reduce((m, r) => Math.max(m, r.drop), 0), peakDensity: Math.max(supply.peak?.density ?? 0, ret?.peak?.density ?? 0),
  };
}

/** The rail's sums set up, to be worked step by step (the supply's, then the return's). */
export function startRail(doc: PcbDocument, rail: RailSetup, field?: PowerSetup['field']): { jobs: PowerJob[]; finish(layerName?: (l: LayerId) => string): RailResult } | null {
  const s = railSetups(doc, rail, field), supply = startPower(doc, s.supply);
  if (!supply) return null;
  // A source with no pad on the return net gives the return nothing to come back to: the supply is worked alone, and it is said
  const lone = !!s.ret && !s.ret.sources[0]!.pads.length;
  const ret = s.ret && !lone ? startPower(doc, s.ret) : null;
  return { jobs: ret ? [supply, ret] : [supply], finish: (layerName) => {
    const r = railResult(doc, lone ? { ...rail, ret: null } : rail, supply.finish(), ret?.finish() ?? null, layerName);
    if (lone) r.issues.unshift({ kind: 'open', message: `${doc.components[rail.source]?.designator ?? 'The source'} has no pad on ${doc.nets[rail.ret!]?.name ?? 'the return net'}: the return net is left out, and each load's voltage is the supply's alone` });
    return r;
  } };
}

/** A rail worked through in one go. */
export function analyseRail(doc: PcbDocument, rail: RailSetup, layerName?: (l: LayerId) => string, field?: PowerSetup['field']): RailResult | null {
  const run = startRail(doc, rail, field);
  if (!run) return null;
  for (const j of run.jobs) while (!j.solver.step(500)) { /* until it settles */ }
  return run.finish(layerName);
}

/** The analysis as a text report. */
export function railReport(doc: PcbDocument, r: RailResult, title: string): string {
  const net = (n: number) => doc.nets[n]?.name ?? `Net ${n}`, rail = r.rail, out: string[] = [];
  const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  out.push(`Power Analysis: ${title}`, '');
  out.push(`Supply net      ${net(rail.supply)}`, `Return net      ${rail.ret === null ? '(none)' : net(rail.ret)}`);
  out.push(`Source          ${doc.components[rail.source]?.designator ?? ''} at ${rail.voltage} V`, `Source current  ${r.current.toFixed(3)} A`);
  out.push(`Copper loss     ${(r.loss * 1000).toFixed(1)} mW`, `Worst drop      ${(r.worstDrop * 1000).toFixed(1)} mV`, `Peak density    ${(r.peakDensity / 1e6).toFixed(1)} A/mm²`);
  out.push(`Copper at       ${rail.temperature} °C, hole plating ${rail.plating} µm`);
  out.push(`Limits          drop ${rail.limits.drop} %, rise ${rail.limits.rise} °C (IPC-2221), areas ${rail.limits.density} A/mm²`, '');
  out.push(`${pad('Load', 10)}${pad('Current', 11)}${pad('Supply', 11)}${pad('Return', 11)}${pad('Voltage', 11)}${pad('Drop', 12)}State`);
  for (const w of r.rows) {
    const v = (x: number) => (Number.isFinite(x) ? `${x.toFixed(4)} V` : 'not joined');
    out.push(`${pad(w.designator, 10)}${pad(`${w.current} A`, 11)}${pad(v(w.supplyV), 11)}${pad(v(w.returnV), 11)}${pad(v(w.voltage), 11)}${pad(w.state === 'open' ? '' : `${(w.drop * 1000).toFixed(1)} mV ${w.percent.toFixed(1)} %`, 12)}${w.state === 'ok' ? 'OK' : w.state === 'over' ? 'Over the limit' : 'Not joined'}`);
  }
  out.push('', r.issues.length ? `${r.issues.length} to look at:` : 'Nothing out of limits.');
  for (const i of r.issues) out.push(`  ${i.message}`);
  for (const s of [r.supply, r.ret]) if (s) out.push('', `${net(s.cn.net)}: ${s.cn.count} nodes on a ${(s.cn.grid.h / 10000).toFixed(1)} mil grid, ${s.cn.tracks.length} lengths of track, ${s.cn.barrels.length} barrels; ${s.iterations} steps, imbalance ${s.residual.toExponential(1)}`);
  return out.join('\n');
}
