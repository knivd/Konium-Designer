/**
 * A board of the older Protel programs (formats/protel/pcbAscii) made a .PcbDoc: its components
 * with their pads, strings and outlines, the free copper and drawing, the vias and the nets. The
 * file says no shape for the board: it is the largest closed outline of tracks and arcs drawn on
 * the keep-out layer, else the one on Mechanical 1, else the rectangle round everything.
 */
import type { Vec2 } from '../../core/geom';
import { mil } from '../../core/units';
import { PropertyBag } from '../altium/props';
import { applyStackLayers, assemblePcbDoc } from '../altium/assemble';
import { newBoardRecord } from '../altium/board6';
import { encodeArc, encodeFill, encodePad, encodeText, encodeTrack, encodeVia, flattenVertices, writePcbDoc } from '../altium/pcbdoc';
import { chainLoops } from '../kicad/board';
import { altiumFloat } from '../altium/pcbTransform';
import { formatAltiumLength } from '../../core/units';
import type { PcbRawRecord } from '../altium/framing';
import { L, mechLayer, type LayerId } from '../../model/layers';
import type { PcbDocument, PolyVertex } from '../../model/pcb';
import { parseProtelAscii, type ProtelArc, type ProtelBoard, type ProtelPrims } from './pcbAscii';


export interface ProtelResult { pcb: PcbDocument; bytes: Uint8Array; board: ProtelBoard; messages: { level: 'info' | 'warn'; message: string }[] }

const isCopper = (l: LayerId): boolean => l <= L.BOTTOM || (l >= L.PLANE1 && l < L.PLANE1 + 16);

/**
 * Copper arcs and fills take the net of what they touch on their layer: an arc the net of a track,
 * pad or via one of its ends is on; a fill the one net of the track ends, pads and vias inside it.
 * (The file's own word for an arc's or a fill's net is not read: formats/protel/pcbAscii.) Returns how many were given one.
 */
export function touchNets(b: ProtelBoard): number {
  const at = new Map<string, number>(), marks: { p: Vec2; layer: LayerId; net: number }[] = [];
  const mark = (p: Vec2, layer: LayerId, net: number): void => { if (net > 0) { marks.push({ p, layer, net }); at.set(`${layer}:${Math.round(p.x / 100)},${Math.round(p.y / 100)}`, net); } };
  const groups: ProtelPrims[] = [b, ...b.comps];
  for (const g of groups) {
    for (const t of g.tracks) if (isCopper(t.layer)) { mark(t.a, t.layer, t.net); mark(t.b, t.layer, t.net); }
    for (const p of g.pads) mark(p.at, p.layer, p.net);
  }
  for (const v of b.vias) mark(v.at, L.MULTI, v.net);
  const on = (p: Vec2, layer: LayerId): number => at.get(`${layer}:${Math.round(p.x / 100)},${Math.round(p.y / 100)}`) ?? at.get(`${L.MULTI}:${Math.round(p.x / 100)},${Math.round(p.y / 100)}`) ?? 0;
  let n = 0;
  for (const g of groups) {
    for (const a of g.arcs) if (isCopper(a.layer) && !a.net) {
      const end = (deg: number): Vec2 => ({ x: a.c.x + a.r * Math.cos(deg * Math.PI / 180), y: a.c.y + a.r * Math.sin(deg * Math.PI / 180) });
      a.net = on(end(a.start), a.layer) || on(end(a.end), a.layer);
      if (a.net) n++;
    }
    for (const f of g.fills) if (isCopper(f.layer) && !f.net && !f.rotation) {
      const x0 = Math.min(f.a.x, f.b.x), x1 = Math.max(f.a.x, f.b.x), y0 = Math.min(f.a.y, f.b.y), y1 = Math.max(f.a.y, f.b.y);
      const nets = new Set(marks.filter((m) => (m.layer === f.layer || m.layer === L.MULTI) && m.p.x >= x0 && m.p.x <= x1 && m.p.y >= y0 && m.p.y <= y1).map((m) => m.net));
      if (nets.size === 1) { f.net = [...nets][0]!; n++; }
    }
  }
  return n;
}

export function convertProtelAscii(text: string, fileName: string): ProtelResult {
  const b = parseProtelAscii(text), name = fileName.replace(/\.[^.]+$/, '');
  const messages: ProtelResult['messages'] = [];
  const touched = touchNets(b);
  const pads: PcbRawRecord[] = [], tracks: PcbRawRecord[] = [], arcs: PcbRawRecord[] = [], fills: PcbRawRecord[] = [], texts: PcbRawRecord[] = [], vias: PcbRawRecord[] = [];
  const comps: PropertyBag[] = [];
  // An object's net: its place in the list from 1, as an index from 0 here
  const net = (n: number): number | undefined => (n >= 1 && n <= b.nets.length ? n - 1 : undefined);
  const put = (p: ProtelPrims, component?: number): void => {
    for (const t of p.tracks) tracks.push(encodeTrack({ layer: t.layer, a: t.a, b: t.b, width: Math.max(1, t.width), net: net(t.net), component }));
    for (const a of p.arcs) arcs.push(encodeArc({ layer: a.layer, c: a.c, r: a.r, start: a.start, end: a.end, width: Math.max(1, a.width), net: net(a.net), component }));
    for (const f of p.fills) fills.push(encodeFill({ layer: f.layer, a: { x: Math.min(f.a.x, f.b.x), y: Math.min(f.a.y, f.b.y) }, b: { x: Math.max(f.a.x, f.b.x), y: Math.max(f.a.y, f.b.y) }, rotation: f.rotation || undefined, net: net(f.net), component }));
    for (const t of p.texts) texts.push(encodeText({ layer: t.layer, at: t.at, height: t.height, text: t.text, rotation: t.rotation, strokeWidth: t.stroke || undefined, mirrored: t.mirrored, component }));
    for (const d of p.pads) {
      const through = d.hole > 0 || d.layer === L.MULTI;
      // A pad on one side is that side's; one with a hole is on every layer, each face as it is given
      const same = d.top.w === d.mid.w && d.top.h === d.mid.h && d.top.shape === d.mid.shape && d.top.w === d.bot.w && d.top.h === d.bot.h && d.top.shape === d.bot.shape;
      const face = d.layer === L.BOTTOM ? d.bot : d.top;
      pads.push(encodePad({ name: d.name, layer: through ? L.MULTI : d.layer, at: d.at, w: face.w, h: face.h, shape: face.shape, hole: d.hole > 0 ? d.hole : undefined, rotation: d.rotation, net: net(d.net), component,
        ...(through && !same ? { mid: d.mid, bot: d.bot } : {}) }));
    }
  };
  b.comps.forEach((c, ci) => {
    const des = c.designator?.text ?? '';
    comps.push(PropertyBag.from({
      LAYER: c.bottom ? 'BOTTOM' : 'TOP', PATTERN: c.pattern, SOURCEDESIGNATOR: des, SOURCEFOOTPRINTLIBRARY: `${name}.PcbLib`, FOOTPRINTDESCRIPTION: '',
      X: formatAltiumLength(c.at.x), Y: formatAltiumLength(c.at.y), ROTATION: altiumFloat(c.rotation), HEIGHT: '0mil', NAMEON: c.nameOn ? 'TRUE' : 'FALSE', COMMENTON: c.commentOn ? 'TRUE' : 'FALSE', LOCKED: 'FALSE',
      SOURCELIBREFERENCE: c.comment?.text ?? '', SOURCEDESCRIPTION: '',
    }));
    put(c, ci);
    const silk: LayerId = c.bottom ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY;
    // Its designator and its comment (one with no place of its own stands at the part)
    for (const [t, which] of [[c.designator, 'isDesignator'], [c.comment, 'isComment']] as const) {
      if (!t && which === 'isComment') continue;
      const at = t && (t.at.x !== 0 || t.at.y !== 0) ? t.at : c.at;
      texts.push(encodeText({ layer: t?.layer ?? silk, at, height: t?.height || mil(60), text: t?.text ?? '', rotation: t?.rotation ?? 0, strokeWidth: t?.stroke || undefined, mirrored: t?.mirrored ?? c.bottom, component: ci, [which]: true }));
    }
  });
  put(b);
  for (const v of b.vias) vias.push(encodeVia({ at: v.at, diameter: v.diameter, hole: v.hole, net: net(v.net) }));

  // The board's shape: the largest closed outline drawn on the keep-out layer, else the one on Mechanical 1, else the rectangle round everything
  const outlineOn = (layer: LayerId): PolyVertex[] | null => {
    const end = (a: ProtelArc, deg: number): Vec2 => ({ x: Math.round(a.c.x + a.r * Math.cos(deg * Math.PI / 180)), y: Math.round(a.c.y + a.r * Math.sin(deg * Math.PI / 180)) });
    const edges = [...b.tracks.filter((t) => t.layer === layer).map((t) => ({ a: t.a, b: t.b })),
      ...b.arcs.filter((a) => a.layer === layer && ((a.end - a.start) % 360 + 360) % 360 !== 0).map((a) => ({ a: end(a, a.start), b: end(a, a.end), arc: { c: a.c, r: a.r, sa: a.start, ea: a.end } }))];
    const loops = chainLoops(edges, mil(0.5)).filter((l) => l.length >= 3 || l.some((v) => v.arc));
    const area = (vs: PolyVertex[]) => { const f = flattenVertices(vs); return Math.abs(f.reduce((sum, v, i) => { const n = f[(i + 1) % f.length]!; return sum + v.x * n.y - n.x * v.y; }, 0)); };
    return loops.sort((p, q) => area(q) - area(p))[0] ?? null;
  };
  const pts: Vec2[] = [...b.tracks.flatMap((t) => [t.a, t.b]), ...b.pads.map((p) => p.at), ...b.vias.map((v) => v.at), ...b.comps.flatMap((c) => [c.at, ...c.pads.map((p) => p.at), ...c.tracks.flatMap((t) => [t.a, t.b])]), ...b.arcs.flatMap((a) => [{ x: a.c.x - a.r, y: a.c.y - a.r }, { x: a.c.x + a.r, y: a.c.y + a.r }])];
  const box = pts.length ? pts : [{ x: 0, y: 0 }, { x: mil(1000), y: mil(1000) }];
  const drawn = outlineOn(L.KEEPOUT) ?? outlineOn(mechLayer(1));
  const flat = drawn ? flattenVertices(drawn) : box;
  const x0 = Math.min(...flat.map((p) => p.x)), x1 = Math.max(...flat.map((p) => p.x)), y0 = Math.min(...flat.map((p) => p.y)), y1 = Math.max(...flat.map((p) => p.y));
  const outline: PolyVertex[] = drawn ?? [{ p: { x: x0, y: y0 } }, { p: { x: x1, y: y0 } }, { p: { x: x1, y: y1 } }, { p: { x: x0, y: y1 } }];
  if (!drawn) messages.push({ level: 'info', message: 'No closed outline is drawn on the keep-out layer or on Mechanical 1: the board\'s shape is the rectangle round everything' });
  const all = pts.length ? pts : box;
  const board = newBoardRecord({ fileName: `${name}.PcbDoc`, origin: { x: x0, y: y0 }, outline,
    sheet: { x: 0, y: 0, width: Math.max(...all.map((p) => p.x)) + mil(1000), height: Math.max(...all.map((p) => p.y)) + mil(1000) }, mechanical: [1, 2, 3, 4] });
  const pcb = assemblePcbDoc({ board, nets: b.nets, comps, pads, tracks, vias, arcs, fills, texts }, `${name}.PcbDoc`);
  // The inner layers its objects are on: mid layers up to the last one used, then planes likewise (the file says no order for them)
  const on = new Set<LayerId>([b, ...b.comps].flatMap((g) => [...g.tracks, ...g.arcs, ...g.fills, ...g.pads, ...g.texts].map((x) => x.layer)));
  const last = (first: LayerId, count: number): number => { for (let k = count; k >= 1; k--) if (on.has((first + k - 1) as LayerId)) return k; return 0; };
  const mids = last(L.MID1, 14), planes = last(L.PLANE1, 4);
  if (mids + planes) {
    applyStackLayers(pcb, [{}, ...Array.from({ length: mids }, () => ({})), ...Array.from({ length: planes }, () => ({ plane: true })), {}], []);
    messages.push({ level: 'info', message: `${mids + planes} inner layer${mids + planes === 1 ? '' : 's'} (${[mids && `${mids} mid`, planes && `${planes} plane`].filter(Boolean).join(', ')}): the file says neither their order in the stack nor a plane's net, so the mid layers are first and the planes have no net. Design › Layer Stack Manager sets both` });
  }
  if (touched) messages.push({ level: 'info', message: `${touched} copper arc${touched === 1 ? ' or fill was' : 's and fills were'} given the net of what ${touched === 1 ? 'it touches' : 'they touch'}` });
  if (Number(b.version) < 2) messages.push({ level: 'warn', message: `Version ${b.version} of this format is read by its published description only (no board in it has been seen here): check the board against its source` });
  if (b.lost.length) messages.push({ level: 'warn', message: `${b.lost.length} record${b.lost.length === 1 ? '' : 's'} could not be read and ${b.lost.length === 1 ? 'was' : 'were'} left out (${b.lost.slice(0, 4).join('; ')}${b.lost.length > 4 ? '; …' : ''})` });
  messages.push({ level: 'info', message: `PCB ASCII ${b.version}: ${b.comps.length} component${b.comps.length === 1 ? '' : 's'}, ${b.nets.length} net${b.nets.length === 1 ? '' : 's'}, ${tracks.length} tracks, ${pads.length} pads, ${vias.length} vias` });
  return { pcb, bytes: writePcbDoc(pcb), board: b, messages };
}
