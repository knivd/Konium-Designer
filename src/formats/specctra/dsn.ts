/**
 * R15, a board as a Specctra design (.dsn), what autorouters read (Freerouting opens it with
 * File › Open...): the copper layers (signal layers, internal planes as power layers with their
 * nets' planes), the board's outline as its boundary, cut-outs and keep-outs as keep-outs, the
 * footprints as images (each once, from the top: pins with their padstacks, turned as their pads),
 * the parts placed on them (bottom ones on the back, as Specctra flips them), free pads as parts of
 * their own, every net with its pins, the vias the routes may use, the design rules' track width
 * and clearance, and the routes there are already (locked ones protected). Specctra's axes are AD's
 * (Y up, angles anticlockwise); the file is in µm, AD's coordinates as they are.
 *
 * Specctra flips a back-side part's image across its Y axis, then turns it (its default flip style,
 * mirror first: Freerouting's Pin.relativeLocation) [checked: Freerouting 2.4.1's source]; AD
 * reflects a bottom part across its X axis, then turns it: the same part turned half round more.
 */
import type { Vec2 } from '../../core/geom';
import { UNITS_PER_MM } from '../../core/units';
import { L, isPlane, layerName, type LayerId } from '../../model/layers';
import { NO_NET, type PcbDocument, type PcbPad, type PcbPrim, type PolyVertex } from '../../model/pcb';
import { footprintDoc, footprintsFromBoard } from '../../model/pcbLib';
import { planeCopper } from '../../model/planes';
import { ruleEnabled, ruleKind, ruleLength, ruleScope1, ruleScope2 } from '../altium/rules';
import type { ExportProject, ExportResult } from '../exporters';
import type { ImportMessage } from '../importers';
import { APP_VERSION } from '../../platform/distribution';

/** AD's coordinates in µm. */
const UM = UNITS_PER_MM / 1000;
const um = (v: number) => { const r = Math.round((v / UM) * 10) / 10; return Object.is(r, -0) ? 0 : r; };
const norm = (a: number) => ((a % 360) + 360) % 360;
const deg = (a: number) => Math.round(norm(a) * 1000) / 1000;

/** A name as Specctra reads it (in quotes where it holds what ends a word or a pin reference, as Freerouting writes them). */
export function qid(s: string): string {
  const t = s.replace(/"/g, '');
  // eslint-disable-next-line no-control-regex
  return !t || /[()\s;\-_/~{}]|[^\x00-\x7f]/.test(t) || /^-?\d/.test(t) ? `"${t}"` : t;
}

/** The board's copper layers as Specctra names them here (AD's names, words joined by dots): top to bottom. */
export function specctraLayers(doc: PcbDocument): { layer: LayerId; name: string; power: boolean }[] {
  const stack = doc.board.copperStack.length >= 2 ? doc.board.copperStack : [L.TOP, L.BOTTOM];
  const taken = new Set<string>();
  return stack.map((l) => {
    let base = (doc.board.layerNames.get(l) ?? layerName(l)).replace(/[^A-Za-z0-9.+]+/g, '.').replace(/^\.+|\.+$/g, '') || 'Layer';
    if (/^\d/.test(base)) base = `L${base}`;
    let name = base;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base}.${k}`;
    taken.add(name.toLowerCase());
    return { layer: l, name, power: isPlane(l) };
  });
}

/** A via's padstack name: its layers (by index in the stack), diameter and hole (µm), as KiCad names them. */
export const viaName = (from: number, to: number, dia: number, hole: number) => `Via[${from}-${to}]_${um(dia)}:${um(hole)}_um`;
/** A via padstack name read back (null when it isn't one of these). */
export function readViaName(s: string): { from: number; to: number; dia: number; hole: number } | null {
  const m = /^Via\[(\d+)-(\d+)\]_([\d.]+):([\d.]+)_um$/.exec(s);
  return m ? { from: Number(m[1]), to: Number(m[2]), dia: Number(m[3]) * UM, hole: Number(m[4]) * UM } : null;
}

/** A pad's pins named in its footprint: its designator, the second and later of a name numbered on (@1 …), an unnamed pad @0 …. */
export function pinNames(pads: { name: string }[]): string[] {
  const seen = new Map<string, number>();
  return pads.map((p) => { const n = seen.get(p.name) ?? 0; seen.set(p.name, n + 1); return n === 0 && p.name.trim() ? p.name : `${p.name}@${n}`; });
}

export interface DsnResult { text: string; warnings: string[]; stats: { layers: number; components: number; nets: number; images: number; wires: number; vias: number } }

export function exportSpecctraDsn(doc: PcbDocument, name: string, host = 'Konium Designer'): DsnResult {
  const tally = new Map<string, number>();
  const note = (w: string) => tally.set(w, (tally.get(w) ?? 0) + 1);
  const layers = specctraLayers(doc);
  const nameOf = new Map(layers.map((l) => [l.layer, l.name]));
  const top = layers[0]!.layer, bottom = layers.at(-1)!.layer;
  const copperName = (l: LayerId) => nameOf.get(l === L.TOP ? top : l === L.BOTTOM ? bottom : l);
  const P = (q: Vec2) => `${um(q.x)} ${um(q.y)}`;
  const ring = (pts: Vec2[]) => [...pts, pts[0]!].map(P).join(' ');
  const netName = (i: number) => (i === NO_NET || i < 0 ? '' : doc.nets[i]?.name ?? '');

  /* The rules' defaults: track width, clearance, the routing via */
  const general = (kind: string) => doc.rules.filter((r) => ruleKind(r) === kind && ruleEnabled(r) && /^\s*All\s*$/i.test(ruleScope1(r)) && /^\s*All\s*$/i.test(ruleScope2(r) || 'All'))[0];
  const clr = general('Clearance'), wid = general('Width'), via = general('RoutingVias');
  const gap = clr ? ruleLength(clr, 'GAP', '10mil') : 100000;
  const width = wid ? ruleLength(wid, 'PREFEREDWIDTH', '10mil') : 100000;
  const viaDia = via ? ruleLength(via, 'WIDTH', '50mil') : 500000, viaHole = via ? ruleLength(via, 'HOLEWIDTH', '28mil') : 280000;

  /* Padstacks: one for each pad shape, size and layers; vias by their layers and sizes */
  const padstacks = new Map<string, string>();   // name → definition
  const shapeOf = (l: string, sh: { w: number; h: number; shape: string; cornerPct?: number }) => {
    const w = sh.w, h = sh.h;
    if (sh.shape === 'rect' || (sh.shape === 'roundrect' && !sh.cornerPct)) return `(rect ${l} ${um(-w / 2)} ${um(-h / 2)} ${um(w / 2)} ${um(h / 2)})`;
    if (sh.shape === 'roundrect' || sh.shape === 'octagon') {
      const pts: Vec2[] = [];
      if (sh.shape === 'octagon') { const c = Math.min(w, h) / 4, hw = w / 2, hh = h / 2; pts.push(...[[hw - c, hh], [-hw + c, hh], [-hw, hh - c], [-hw, -hh + c], [-hw + c, -hh], [hw - c, -hh], [hw, -hh + c], [hw, hh - c]].map(([x, y]) => ({ x: x!, y: y! }))); }
      else {
        const r = (Math.min(w, h) / 2) * Math.min(100, sh.cornerPct ?? 0) / 100, hw = w / 2 - r, hh = h / 2 - r;
        for (const [cx, cy, a0] of [[hw, hh, 0], [-hw, hh, 90], [-hw, -hh, 180], [hw, -hh, 270]] as const) for (let i = 0; i <= 4; i++) { const a = ((a0 + i * 22.5) * Math.PI) / 180; pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
      }
      return `(polygon ${l} 0 ${ring(pts)})`;
    }
    if (Math.abs(w - h) < 2) return `(circle ${l} ${um(w)})`;
    // An oval: a path along its long side, as wide as its short one
    const d = Math.abs(w - h) / 2;
    return w > h ? `(path ${l} ${um(h)} ${um(-d)} 0 ${um(d)} 0)` : `(path ${l} ${um(w)} 0 ${um(-d)} 0 ${um(d)})`;
  };
  const padstackOf = (q: PcbPad): string | null => {
    const multi = q.layer === L.MULTI;
    const on = multi ? layers.map((x) => x.name) : [copperName(q.layer)].filter((x): x is string => !!x);
    if (!on.length) { note('Pads on no copper layer of the stack left out'); return null; }
    let sh = multi ? q.top : q.layer === L.BOTTOM && q.bot.w ? q.bot : q.top;
    if (q.hole > 0 && sh.w <= q.hole && sh.h <= q.hole) sh = { ...sh, w: Math.max(sh.w, q.hole), h: Math.max(sh.h, q.hole), shape: 'round' };
    if (q.slot && q.slot.length > q.hole + 1 && sh.w <= q.hole) note('Slotted holes written as their pads');
    const body = on.map((l) => `(shape ${shapeOf(l, sh)})`).join(' ');
    const key = `${sh.shape}_${um(sh.w)}x${um(sh.h)}${sh.shape === 'roundrect' ? `_${Math.round(sh.cornerPct)}` : ''}_${multi ? 'Through' : on[0]}`;
    let nm = key, k = 2;
    while (padstacks.has(nm) && padstacks.get(nm) !== body) nm = `${key}_${k++}`;
    padstacks.set(nm, body);
    return nm;
  };
  const vias = new Map<string, string>();
  const viaOf = (dia: number, hole: number, a: LayerId, b: LayerId): string => {
    let i = layers.findIndex((x) => x.layer === (a === L.TOP ? top : a)), j = layers.findIndex((x) => x.layer === (b === L.BOTTOM ? bottom : b));
    if (i < 0) i = 0;
    if (j < 0) j = layers.length - 1;
    if (i > j) [i, j] = [j, i];
    const nm = viaName(i, j, dia, hole);
    if (!vias.has(nm)) vias.set(nm, layers.slice(i, j + 1).map((x) => `(shape (circle ${x.name} ${um(dia)}))`).join(' '));
    return nm;
  };
  const defaultVia = viaOf(viaDia, viaHole, top, bottom);

  /* Images: each footprint once, from the top (pads in its own frame) */
  const images: string[] = [];
  const imageOf = new Map<string, { name: string; pins: string[] }>();
  const takenImages = new Set<string>();
  const imageFor = (nm0: string, pads: PcbPad[]) => {
    let nm = nm0 || 'Image';
    for (let k = 2; takenImages.has(nm.toLowerCase()); k++) nm = `${nm0}_${k}`;
    takenImages.add(nm.toLowerCase());
    const names = pinNames(pads);
    const pins = pads.map((q, i) => {
      const ps = padstackOf(q);
      if (!ps) return '';
      const rot = deg(q.rotation);
      return `      (pin ${qid(ps)}${rot ? ` (rotate ${rot})` : ''} ${qid(names[i]!)} ${P(q.at)})`;
    }).filter(Boolean);
    images.push(`    (image ${qid(nm)}\n${pins.join('\n')}\n    )`);
    return { name: nm, pins: names };
  };
  for (const def of footprintsFromBoard(doc)) {
    const d = footprintDoc(def.name, def.records);
    imageOf.set(def.name.toLowerCase(), imageFor(def.name, d.prims.filter((q): q is PcbPad => q.kind === 'pad')));
  }

  /* Parts: placed on their images; their pads' pins on their nets */
  const netPins = new Map<number, string[]>();
  const byComp = new Map<number, PcbPad[]>();
  for (const q of doc.prims) if (q.kind === 'pad' && q.component >= 0 && q.component !== NO_NET && q.component !== 0xffff) byComp.set(q.component, [...(byComp.get(q.component) ?? []), q]);
  const places = new Map<string, string[]>();
  for (const c of doc.components) {
    const im = imageOf.get(c.pattern.toLowerCase());
    if (!im) { note('Components of no footprint left out'); continue; }
    const back = c.layer === L.BOTTOM;
    // Specctra flips the back's image across its Y axis, then turns it: AD's reflection across X, turned half round more
    const rot = deg(back ? c.rotation + 180 : c.rotation);
    places.set(im.name, [...(places.get(im.name) ?? []), `      (place ${qid(c.designator)} ${P(c.at)} ${back ? 'back' : 'front'} ${rot})`]);
    const names = pinNames(byComp.get(c.index) ?? []);
    (byComp.get(c.index) ?? []).forEach((q, i) => {
      if (q.net === NO_NET || q.net < 0 || q.net >= doc.nets.length || !im.pins.includes(names[i]!)) return;
      netPins.set(q.net, [...(netPins.get(q.net) ?? []), `${qid(c.designator)}-${qid(names[i]!)}`]);
    });
  }
  // Free pads: parts of their own
  let freeK = 0;
  for (const q of doc.prims) {
    if (q.kind !== 'pad' || (q.component >= 0 && q.component !== NO_NET && q.component !== 0xffff)) continue;
    const des = `FreePad${++freeK}`;
    const im = imageFor(des, [{ ...q, name: '1', at: { x: 0, y: 0 } }]);
    places.set(im.name, [`      (place ${qid(des)} ${P(q.at)} front 0)`]);
    if (q.net !== NO_NET && q.net >= 0 && q.net < doc.nets.length) netPins.set(q.net, [...(netPins.get(q.net) ?? []), `${qid(des)}-${qid('1')}`]);
  }

  /* The structure: layers, the boundary, keep-outs, planes, vias, rules */
  const structure: string[] = [];
  layers.forEach((x, i) => structure.push(`    (layer ${x.name} (type ${x.power ? 'power' : 'signal'}) (property (index ${i})))`));
  const vs = doc.board.vertices.length ? doc.board.vertices : doc.board.outline.map((p): PolyVertex => ({ p }));
  const outline = flatten(vs);
  if (outline.length >= 3) structure.push(`    (boundary (path pcb 0 ${ring(outline)}))`);
  else note('No board shape: no boundary');
  const keepout = (pts: Vec2[], l: LayerId) => {
    const on = l === L.KEEPOUT || l === L.MULTI ? 'signal' : copperName(l);
    if (!on || pts.length < 3) return;
    structure.push(`    (keepout "" (polygon ${on} 0 ${ring(pts)}))`);
  };
  for (const q of doc.prims) {
    if (q.kind === 'region' && q.boardCutout) { keepout(q.outline, L.KEEPOUT); continue; }
    if ((q.kind === 'region' || q.kind === 'fill') && (q.layer === L.KEEPOUT || q.keepout)) { keepout(q.kind === 'region' ? q.outline : fillCorners(q), q.layer); note('Keep-outs written as keep-outs'); continue; }
    if ((q.kind === 'track' || q.kind === 'arc') && (q.layer === L.KEEPOUT || q.keepout)) note('Keep-out lines left out (Specctra keeps out by areas)');
    // Copper on no net (logos, text drawn in copper): kept out
    if ((q.kind === 'region' || q.kind === 'fill') && copperName(q.layer) && (q.net === NO_NET || q.net < 0) && !(q.kind === 'region' && (q.regionKind !== 0 || (q.polygon >= 0 && q.polygon !== NO_NET && q.polygon !== 0xffff) || q.padShape))) {
      keepout(q.kind === 'region' ? q.outline : fillCorners(q), q.layer);
      note('Copper on no net written as keep-outs');
    }
  }
  const planes: string[] = [];
  for (const x of layers.filter((y) => y.power)) for (const a of planeCopper(doc, x.layer)) for (const r of a.regions) {
    if (a.net === NO_NET || a.net < 0) continue;
    planes.push(`    (plane ${qid(netName(a.net))} (polygon ${x.name} 0 ${ring(r.outline)}))`);
  }
  if (doc.polygons.some((pg) => !pg.type || /^polygon$/i.test(pg.type))) note('Polygon pours aren\'t written: the session\'s import pours them again round the new routes');

  /* The routes there are: tracks (arcs as short lines) and vias by net, locked ones protected */
  const wiring: string[] = [];
  let nWires = 0, nVias = 0;
  for (const q of doc.prims) {
    if (q.kind !== 'track' && q.kind !== 'arc' && q.kind !== 'via') continue;
    if ('component' in q && q.component >= 0 && q.component !== NO_NET && q.component !== 0xffff) continue;
    if ((q.kind === 'track' || q.kind === 'arc') && ((q.polygon >= 0 && q.polygon !== NO_NET && q.polygon !== 0xffff) || q.keepout)) continue;
    const net = netName(q.net);
    const tail = `${net ? ` (net ${qid(net)})` : ''}${q.locked ? ' (type protect)' : ''}`;
    if (q.kind === 'via') { wiring.push(`    (via ${qid(viaOf(q.diameter, q.hole, q.layerStart, q.layerEnd))} ${P(q.at)}${tail})`); nVias++; continue; }
    const l = copperName(q.layer);
    if (!l) continue;
    if (!net) { note('Tracks on no net left out'); continue; }
    if (q.kind === 'track') wiring.push(`    (wire (path ${l} ${um(q.width)} ${P(q.a)} ${P(q.b)})${tail})`);
    else {
      const span = norm(q.end - q.start) || 360, n = Math.max(2, Math.ceil(span / 15));
      const pts = Array.from({ length: n + 1 }, (_, i) => { const a = ((q.start + (span * i) / n) * Math.PI) / 180; return { x: q.c.x + q.r * Math.cos(a), y: q.c.y + q.r * Math.sin(a) }; });
      wiring.push(`    (wire (path ${l} ${um(q.width)} ${pts.map(P).join(' ')})${tail})`);
      note('Arcs written as short straight lines');
    }
    nWires++;
  }

  /* The network: every net with pins, and one class for them all (its via, width and clearance) */
  const nets: string[] = [];
  for (const [i, pins] of [...netPins].sort((a, b) => a[0] - b[0])) nets.push(`    (net ${qid(netName(i))}\n      (pins ${pins.join(' ')})\n    )`);
  const netNames = [...netPins.keys()].sort((a, b) => a - b).map((i) => qid(netName(i)));
  const cls = `    (class default ${netNames.join(' ')}\n      (circuit (use_via ${qid(defaultVia)}))\n      (rule (width ${um(width)}) (clearance ${um(gap)}))\n    )`;

  const text = [
    `(pcb ${qid(name.endsWith('.dsn') ? name : `${name}.dsn`)}`,
    '  (parser', '    (string_quote ")', '    (space_in_quoted_tokens on)', `    (host_cad ${qid(host)})`, `    (host_version ${qid(APP_VERSION)})`, '  )',
    '  (resolution um 10)', '  (unit um)',
    '  (structure', ...structure, ...planes,
    `    (via ${[...vias.keys()].map(qid).join(' ')})`,
    `    (rule (width ${um(width)}) (clearance ${um(gap)}))`,
    '  )',
    '  (placement', ...[...places].map(([im, pl]) => `    (component ${qid(im)}\n${pl.join('\n')}\n    )`), '  )',
    '  (library', ...images,
    ...[...padstacks].map(([nm, body]) => `    (padstack ${qid(nm)} ${body} (attach off))`),
    ...[...vias].map(([nm, body]) => `    (padstack ${qid(nm)} ${body} (attach off))`),
    '  )',
    '  (network', ...nets, cls, '  )',
    '  (wiring', ...wiring, '  )',
    ')', '',
  ].join('\n');
  const warnings = [...tally].map(([k, c]) => (c > 1 ? `${k} (${c})` : k));
  return { text, warnings, stats: { layers: layers.length, components: doc.components.length, nets: netPins.size, images: images.length, wires: nWires, vias: nVias } };
}

/** The board's shape as points (its arcs in short steps). */
function flatten(vs: PolyVertex[]): Vec2[] {
  const out: Vec2[] = [];
  vs.forEach((v, i) => {
    out.push(v.p);
    if (!v.arc) return;
    const nx = vs[(i + 1) % vs.length]!.p;
    const a0 = (Math.atan2(v.p.y - v.arc.c.y, v.p.x - v.arc.c.x) * 180) / Math.PI, a1 = (Math.atan2(nx.y - v.arc.c.y, nx.x - v.arc.c.x) * 180) / Math.PI;
    const ccw = Math.abs(norm(a0) - norm(v.arc.sa)) < 0.5;
    const sw = ccw ? norm(a1 - a0) || 360 : -(norm(a0 - a1) || 360);
    const n = Math.max(2, Math.ceil(Math.abs(sw) / 10));
    for (let k = 1; k < n; k++) { const a = ((a0 + (sw * k) / n) * Math.PI) / 180; out.push({ x: v.arc.c.x + v.arc.r * Math.cos(a), y: v.arc.c.y + v.arc.r * Math.sin(a) }); }
  });
  return out;
}

function fillCorners(q: Extract<PcbPrim, { kind: 'fill' }>): Vec2[] {
  const c = { x: (q.a.x + q.b.x) / 2, y: (q.a.y + q.b.y) / 2 }, hw = Math.abs(q.b.x - q.a.x) / 2, hh = Math.abs(q.b.y - q.a.y) / 2;
  const r = (q.rotation * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => ({ x: c.x + dx! * cs - dy! * sn, y: c.y + dx! * sn + dy! * cs }));
}

/** Export Wizard › Specctra Design: the board as a .dsn. */
export function exportSpecctra(p: ExportProject): ExportResult {
  const name = p.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Project';
  const messages: ImportMessage[] = [];
  if (!p.board) return { files: [], messages: [{ level: 'error', source: name, message: 'Nothing to export: a Specctra design is a board, and the project has none' }] };
  const r = exportSpecctraDsn(p.board, name);
  messages.push({ level: 'info', source: name, message: `Specctra design: ${r.stats.layers} copper layers, ${r.stats.components} components, ${r.stats.nets} nets, ${r.stats.images} images; ${r.stats.wires} wires and ${r.stats.vias} vias routed already` });
  for (const w of r.warnings) messages.push({ level: 'warn', source: name, message: w });
  return { files: [{ path: `${name}/${name}.dsn`, bytes: new TextEncoder().encode(r.text) }], messages };
}
