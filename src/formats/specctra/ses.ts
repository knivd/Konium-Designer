/**
 * R15, an autorouter's Specctra session (.ses) read back onto the board its design (.dsn) came from:
 * its routes (each net's wires and vias) in place of the board's, the board's pours poured again
 * round them, as one step. Freerouting writes it with File › Export as a Specctra Session File
 * [checked: Freerouting 2.4.1's source]. A session's numbers are in its resolution's steps (µm in
 * tenths, as Konium's design asks: Freerouting's SesWriter), Y up as AD's; its layers and vias are
 * named as Konium's design names them (dsn.ts). Parts the router moved stay where the board has
 * them (said so).
 */
import type { Vec2 } from '../../core/geom';
import type { Change } from '../../core/undo';
import { UNITS_PER_MM } from '../../core/units';
import { L, type LayerId } from '../../model/layers';
import { NO_NET, type PcbDocument, type PcbPrim } from '../../model/pcb';
import { addTracks, addVias, removePrims, repour } from '../../model/pcbEdit';
import { ruleEnabled, ruleKind, ruleLength, ruleScope1, ruleScope2 } from '../altium/rules';
import { isList, kid, kids, parseSexpr, type SList } from '../kicad/sexpr';
import { readViaName, specctraLayers } from './dsn';

export interface SesWire { layer: string; width: number; pts: Vec2[] }
export interface SesVia { padstack: string; at: Vec2 }
export interface Session {
  name: string; base: string;
  nets: { name: string; wires: SesWire[]; vias: SesVia[] }[];
  /** library_out's via padstacks: their layers and diameter (AD units). */
  padstacks: Map<string, { layers: string[]; dia: number }>;
  placement: Map<string, { at: Vec2; side: string; rot: number }>;
}

const UNIT: Record<string, number> = { inch: UNITS_PER_MM * 25.4, mil: UNITS_PER_MM * 0.0254, cm: UNITS_PER_MM * 10, mm: UNITS_PER_MM, um: UNITS_PER_MM / 1000 };
const atom = (n: SList | undefined, i: number): string => { const v = n?.items[i]; return v === undefined || isList(v) ? '' : String(v); };
const nums = (n: SList, from: number) => n.items.slice(from).filter((x): x is number => typeof x === 'number');

/** A session file read: its routes in AD's units. */
export function readSession(text: string): Session {
  // (a parser's quote character is no string's start)
  const root = parseSexpr(text.replace(/\(string_quote\s+\S\s*\)/g, ''));
  if (root.k.toLowerCase() !== 'session') throw new Error('Not a Specctra session file: no (session …) in it');
  // Its numbers: steps of its resolution (as the session's routes and placement say)
  const scaleOf = (n: SList | undefined) => { const r = kid(n, 'resolution'); const u = UNIT[atom(r, 0).toLowerCase()] ?? UNIT.mil!; const res = Number(r?.items[1] ?? 1) || 1; return u / res; };
  const routes = kid(root, 'routes');
  const k = scaleOf(routes);
  const out: Session = { name: atom(root, 0), base: atom(kid(root, 'base_design'), 0), nets: [], padstacks: new Map(), placement: new Map() };
  for (const ps of kids(kid(routes, 'library_out'), 'padstack')) {
    const shapes = kids(ps, 'shape').map((s) => s.items.find(isList)).filter((s): s is SList => !!s);
    out.padstacks.set(atom(ps, 0), { layers: shapes.map((s) => atom(s, 0)), dia: Math.max(0, ...shapes.filter((s) => s.k === 'circle').map((s) => Number(s.items[1] ?? 0) * k)) });
  }
  for (const n of kids(kid(routes, 'network_out'), 'net')) {
    const net = { name: atom(n, 0), wires: [] as SesWire[], vias: [] as SesVia[] };
    for (const w of kids(n, 'wire')) {
      const path = kid(w, 'path');
      if (!path) continue;   // (a conduction area's polygon: the board's own pour)
      const v = nums(path, 1);
      const pts: Vec2[] = [];
      for (let i = 1; i + 1 < v.length; i += 2) pts.push({ x: v[i]! * k, y: v[i + 1]! * k });
      net.wires.push({ layer: atom(path, 0), width: v[0]! * k, pts });
    }
    for (const v of kids(n, 'via')) { const c = nums(v, 1); if (c.length >= 2) net.vias.push({ padstack: atom(v, 0), at: { x: c[0]! * k, y: c[1]! * k } }); }
    out.nets.push(net);
  }
  const placement = kid(root, 'placement');
  const kp = scaleOf(placement);
  for (const c of kids(placement, 'component')) for (const p of kids(c, 'place')) {
    const v = nums(p, 1);
    if (v.length >= 2) out.placement.set(atom(p, 0), { at: { x: v[0]! * kp, y: v[1]! * kp }, side: p.items.find((x) => x === 'front' || x === 'back') as string ?? 'front', rot: v[2] ?? 0 });
  }
  return out;
}

export interface SessionApplied { change: Change; tracks: number; vias: number; removed: number; nets: number; warnings: string[] }

/**
 * The session's routes in place of the board's (its tracks, arcs and vias on nets, but those of
 * parts and pours), its pours poured again: one change.
 */
export function applySession(doc: PcbDocument, ses: Session): SessionApplied {
  const warnings: string[] = [];
  const tally = new Map<string, number>();
  const note = (w: string) => tally.set(w, (tally.get(w) ?? 0) + 1);
  const layers = specctraLayers(doc);
  const layerOf = new Map(layers.map((x) => [x.name.toLowerCase(), x.layer]));
  const byName = new Map(doc.nets.map((n) => [n.name, n.index]));
  const byUpper = new Map(doc.nets.map((n) => [n.name.toUpperCase(), n.index]));
  const general = (kind: string) => doc.rules.filter((r) => ruleKind(r) === kind && ruleEnabled(r) && /^\s*All\s*$/i.test(ruleScope1(r)) && /^\s*All\s*$/i.test(ruleScope2(r) || 'All'))[0];
  const via = general('RoutingVias');
  const holeDefault = via ? ruleLength(via, 'HOLEWIDTH', '28mil') : 280000;
  const tracks: { layer: LayerId; a: Vec2; b: Vec2; width: number; net?: number }[] = [];
  const vias: { at: Vec2; diameter: number; hole: number; net?: number; layerStart?: LayerId; layerEnd?: LayerId }[] = [];
  const r = (q: Vec2) => ({ x: Math.round(q.x), y: Math.round(q.y) });
  let nets = 0;
  for (const n of ses.nets) {
    const ni = byName.get(n.name) ?? byUpper.get(n.name.toUpperCase());
    if (ni === undefined) { note(`Routes of nets the board hasn't left out (${n.name})`); continue; }
    if (n.wires.length || n.vias.length) nets++;
    for (const w of n.wires) {
      const l = layerOf.get(w.layer.toLowerCase());
      if (l === undefined) { note(`Wires on layers the board hasn't left out (${w.layer})`); continue; }
      for (let i = 1; i < w.pts.length; i++) {
        const a = r(w.pts[i - 1]!), b = r(w.pts[i]!);
        if (a.x === b.x && a.y === b.y) continue;
        tracks.push({ layer: l, a, b, width: Math.max(1, Math.round(w.width)), net: ni });
      }
    }
    for (const v of n.vias) {
      // Konium's own via names say their layers, diameter and hole; another's: its shape, the rules' hole
      const named = readViaName(v.padstack);
      const ps = ses.padstacks.get(v.padstack);
      const span = named ? [layers[named.from]?.layer, layers[named.to]?.layer] : ps?.layers.length ? [layerOf.get(ps.layers[0]!.toLowerCase()), layerOf.get(ps.layers.at(-1)!.toLowerCase())] : [];
      const dia = Math.round(named?.dia ?? ps?.dia ?? 0);
      if (!dia) { note(`Vias of a padstack the session doesn't describe left out (${v.padstack})`); continue; }
      const hole = Math.round(named?.hole ?? Math.min(holeDefault, dia * 0.6));
      const a = span[0] ?? L.TOP, b = span[1] ?? L.BOTTOM;
      vias.push({ at: r(v.at), diameter: dia, hole, net: ni, layerStart: a === layers[0]!.layer ? L.TOP : a, layerEnd: b === layers.at(-1)!.layer ? L.BOTTOM : b });
    }
  }
  // The routes they take the place of: the board's tracks, arcs and vias on nets (not a part's, not a pour's, not a keep-out)
  const inPart = (q: PcbPrim) => 'component' in q && q.component >= 0 && q.component !== NO_NET && q.component !== 0xffff;
  const old = doc.prims.filter((q) => (q.kind === 'track' || q.kind === 'arc' || q.kind === 'via') && !inPart(q) && q.net !== NO_NET && q.net >= 0 && q.net < doc.nets.length
    && !(q.kind !== 'via' && ((q.polygon >= 0 && q.polygon !== NO_NET && q.polygon !== 0xffff) || q.keepout)) && (q.kind === 'via' || layers.some((x) => x.layer === q.layer)));
  // Parts the router moved: the board keeps its places
  let moved = 0;
  for (const c of doc.components) {
    const pl = ses.placement.get(c.designator);
    if (!pl) continue;
    const rot = c.layer === L.BOTTOM ? c.rotation + 180 : c.rotation;
    if (Math.hypot(pl.at.x - c.at.x, pl.at.y - c.at.y) > UNITS_PER_MM / 100 || (pl.side === 'back') !== (c.layer === L.BOTTOM) || Math.abs((((pl.rot - rot) % 360) + 540) % 360 - 180) > 0.01) moved++;
  }
  if (moved) warnings.push(`${moved} part${moved === 1 ? ' was' : 's were'} moved in the router: Konium keeps the board's places, so the routes to ${moved === 1 ? 'it' : 'them'} may not meet their pads`);
  for (const [k, c] of tally) warnings.push(c > 1 ? `${k} (${c})` : k);
  const pours = doc.polygons.filter((pg) => !pg.type || /^polygon$/i.test(pg.type)).map((pg) => pg.index);
  const steps: Change[] = [];
  const change: Change = {
    apply() {
      if (!steps.length) {
        steps.push(removePrims(doc, old));
        steps[0]!.apply();
        steps.push(addTracks(doc, tracks)); steps[1]!.apply();
        steps.push(addVias(doc, vias)); steps[2]!.apply();
        for (const i of pours) { const c = repour(doc, i); c.apply(); steps.push(c); }
        return;
      }
      for (const s of steps) s.apply();
    },
    revert() { for (const s of [...steps].reverse()) s.revert(); },
  };
  return { change, tracks: tracks.length, vias: vias.length, removed: old.length, nets, warnings };
}
