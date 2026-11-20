/**
 * IPC-2581 (revisions A, B, C) as an AD board: what Allegro, OrCAD PCB, PADS and Xpedition, Zuken,
 * KiCad and AD itself write for fabrication and assembly. The layers (copper in stack order with
 * the stack-up's thicknesses, masks, pastes, silkscreens; assembly, courtyard and documentation
 * layers on mechanical layers), the board profile and its cut-outs, the components (placed as
 * their packages, with bodies from the packages' outlines and heights), the nets, and every
 * layer's features: pads (one AD pad per pin, through-hole when a hole is under it, its shape
 * from the dictionaries), vias from the drill layers' holes, tracks and arcs, copper and other
 * surfaces (with their cut-outs), text. Its footprints become a PcbLib. IPC-2581 carries no
 * design rules or pour settings: the board takes AD's defaults and its copper areas are regions.
 */
import { parseXml, kid, kidsOf, attrNum, descendants, type XEl } from './xml';
import { newBoardRecord } from './altium/board6';
import { assemblePcbDoc, applyStackLayers } from './altium/assemble';
import { encodeArc, encodeBody, encodePad, encodeRegion, encodeText, encodeTrack, encodeVia, flattenVertices, writePcbDoc } from './altium/pcbdoc';
import { writePcbLib, type FootprintDef } from './altium/pcblib';
import { PropertyBag } from './altium/props';
import { altiumFloat } from './altium/pcbTransform';
import type { PcbRawRecord } from './altium/framing';
import { footprintsFromBoard } from '../model/pcbLib';
import { L, mechLayer, type LayerId } from '../model/layers';
import { formatAltiumLength, mil, mm } from '../core/units';
import type { Vec2 } from '../core/geom';
import type { PolyVertex } from '../model/pcb';

const UNITS: Record<string, number> = { MILLIMETER: 1, MM: 1, INCH: 25.4, MICRON: 0.001, MICRONS: 0.001, MILS: 0.0254, MIL: 0.0254 };
const unitOf = (e: XEl | undefined, def = 1) => UNITS[(e?.attrs.units ?? '').toUpperCase()] ?? def;

/** A pad or flash shape (mm, about its centre): AD's pad shape where one fits, else an outline. */
interface Shape { kind: 'round' | 'rect' | 'roundrect' | 'octagon' | 'poly'; w: number; h: number; cornerPct?: number; rot: number; outline?: Vec2[] }

interface Xf { x: number; y: number; rot: number; mirror: boolean; scale: number }
const xfOf = (e: XEl | undefined): Xf => {
  const x = kid(e, 'Xform');
  return { x: attrNum(x, 'xOffset'), y: attrNum(x, 'yOffset'), rot: attrNum(x, 'rotation'), mirror: x?.attrs.mirror === 'true', scale: attrNum(x, 'scale', 1) || 1 };
};
/** A placement: turned, then mirrored left to right (as IPC-2581 files have it), then moved. */
const place = (xf: Xf, at: { x: number; y: number }) => (p: { x: number; y: number }) => {
  const r = (xf.rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  let x = (p.x * c - p.y * s) * xf.scale, y = (p.x * s + p.y * c) * xf.scale;
  if (xf.mirror) x = -x;
  return { x: x + xf.x + at.x, y: y + xf.y + at.y };
};

export interface IpcResult { bytes: Uint8Array; name: string; footprints: FootprintDef[]; warnings: string[]; stats: { components: number; pads: number; vias: number; tracks: number; nets: number; layers: number } }

export const isIpc2581 = (head: string): boolean => /<IPC-2581\b/.test(head);

export function convertIpc2581(text: string, fileName: string): IpcResult {
  const doc = parseXml(text);
  const root = doc.children.find((c) => c.name === 'IPC-2581');
  if (!root) throw new Error(`${fileName} isn't an IPC-2581 file`);
  const warnings: string[] = [];
  const content = kid(root, 'Content');
  const ecad = kid(root, 'Ecad');
  const cadData = kid(ecad, 'CadData');
  if (!cadData) throw new Error(`${fileName}: no board (CadData) in it`);
  const k = unitOf(kid(ecad, 'CadHeader'), 25.4);
  const step = kid(cadData, 'Step');
  if (!step) throw new Error(`${fileName}: no Step in it`);
  const name = (ecad?.attrs.name || step.attrs.name || fileName.replace(/\.[^.]+$/, '')).replace(/[\\/:*?"<>|]/g, '_');

  /* ── dictionaries ── */
  const lineWidth = new Map<string, number>();
  for (const d of kidsOf(content, 'DictionaryLineDesc')) { const u = unitOf(d, k); for (const e of kidsOf(d, 'EntryLineDesc')) lineWidth.set(e.attrs.id ?? '', attrNum(kid(e, 'LineDesc'), 'lineWidth') * u); }
  const widthOf = (e: XEl) => { const ref = kid(e, 'LineDescRef')?.attrs.id; return ref !== undefined ? lineWidth.get(ref) ?? 0 : attrNum(kid(e, 'LineDesc'), 'lineWidth') * k; };
  const shapes = new Map<string, Shape>();
  const userShapes = new Map<string, XEl>();
  const userUnits = new Map<string, number>();
  for (const d of kidsOf(content, 'DictionaryStandard')) { const u = unitOf(d, k); for (const e of kidsOf(d, 'EntryStandard')) { const s = e.children[0] ? shapeOf(e.children[0], u) : null; if (s) shapes.set(e.attrs.id ?? '', s); } }
  for (const d of kidsOf(content, 'DictionaryUser')) { const u = unitOf(d, k); for (const e of kidsOf(d, 'EntryUser')) { userShapes.set(e.attrs.id ?? '', e); userUnits.set(e.attrs.id ?? '', u); } }
  const shapeRef = (e: XEl): Shape | null => {
    const sr = kid(e, 'StandardPrimitiveRef')?.attrs.id;
    if (sr !== undefined) return shapes.get(sr) ?? null;
    const ur = kid(e, 'UserPrimitiveRef')?.attrs.id;
    if (ur !== undefined) {
      const u = userShapes.get(ur);
      if (!u) return null;
      const outline = userOutline(u, userUnits.get(ur) ?? k);
      if (!outline.length) return null;
      const xs = outline.map((p) => p.x), ys = outline.map((p) => p.y);
      return { kind: 'poly', w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), rot: 0, outline };
    }
    const own = e.children.find((c) => STANDARD.has(c.name));
    return own ? shapeOf(own, k) : null;
  };

  /* ── layers ── */
  const layerEls = kidsOf(cadData, 'Layer');
  const byName = new Map(layerEls.map((l) => [l.attrs.name ?? '', l]));
  const fn = (l: XEl | undefined) => (l?.attrs.layerFunction ?? '').toUpperCase();
  const isCopper = (l: XEl | undefined) => /^(SIGNAL|CONDUCTOR|PLANE|MIXED|CONDFILM|CONDFOIL|COATINGCOND|POWER_GROUND)$/.test(fn(l));
  // Copper in stack order: the stack-up's sequence, else the layers' order
  const stackLayers = descendants(kid(cadData, 'Stackup') ?? { name: '', attrs: {}, children: [], text: '' }, 'StackupLayer').sort((a, b) => attrNum(a, 'sequence') - attrNum(b, 'sequence'));
  let copperNames = stackLayers.map((s) => s.attrs.layerOrGroupRef ?? '').filter((n) => isCopper(byName.get(n)));
  if (copperNames.length < 2) copperNames = layerEls.filter(isCopper).map((l) => l.attrs.name ?? '');
  if (copperNames.length < 2) { warnings.push('Fewer than two copper layers: a two-layer board'); copperNames = [...copperNames, ...['TOP', 'BOTTOM'].slice(copperNames.length)]; }
  // A negative copper layer inside is an internal plane (AD's are negative too): its clearances aren't copper
  const negative = (n: string) => (byName.get(n)?.attrs.polarity ?? '').toUpperCase() === 'NEGATIVE';
  let nSig = 0, nPlane = 0;
  const copperIds: LayerId[] = copperNames.map((n, i) => (i === 0 ? L.TOP : i === copperNames.length - 1 ? L.BOTTOM
    : negative(n) && nPlane < 16 ? (L.PLANE1 + nPlane++) as LayerId : (L.MID1 + nSig++) as LayerId));
  const isPlane = (l: LayerId) => l >= L.PLANE1 && l <= L.PLANE16;
  const mechNames = new Map<number, string>();
  let nextMech = 2;
  const mech = (n: number, nm: string) => { if (!mechNames.has(n)) mechNames.set(n, nm); return mechLayer(n); };
  const layerOf = new Map<string, LayerId | null>();
  for (const l of layerEls) {
    const nm = l.attrs.name ?? '', f = fn(l), side = (l.attrs.side ?? '').toUpperCase(), bot = side === 'BOTTOM';
    const ci = copperNames.indexOf(nm);
    let id: LayerId | null = null;
    if (ci >= 0) id = copperIds[ci]!;
    else if (/SOLDERMASK|SOLDER_MASK/.test(f)) id = bot ? L.BOTTOM_SOLDER : L.TOP_SOLDER;
    else if (/SOLDERPASTE|PASTEMASK|SOLDER_PASTE/.test(f)) id = bot ? L.BOTTOM_PASTE : L.TOP_PASTE;
    else if (/SILKSCREEN|LEGEND/.test(f) || (/DOCUMENT/.test(f) && /silk|^ss_|legend/i.test(nm))) id = bot ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY;
    else if (/ASSEMBLY/.test(f)) id = mech(bot ? 14 : 13, nm);
    else if (/COURTYARD/.test(f)) id = mech(bot ? 16 : 15, nm);
    else if (/BOARD_OUTLINE|ROUT|PROFILE|BOARDFAB|V_CUT|SCORE/.test(f)) id = mech(1, nm);
    else if (/DRILL|DIEL|STACKUP|COMPONENT_|GLUE|EXCLUDE|KEEP/.test(f)) id = null;
    else if (nextMech <= 12) id = mech(nextMech++, nm);
    layerOf.set(nm, id);
  }
  const drillLayers = layerEls.filter((l) => /DRILL/.test(fn(l)));

  /* ── coordinates: mm (Y up, from the datum) → AD's units, the board's lower left at 1000 mil ── */
  const profilePoly = kid(kid(step, 'Profile'), 'Polygon');
  const bounds = { x: Infinity, y: Infinity };
  for (const e of [...(profilePoly?.children ?? [])]) { if (e.attrs.x !== undefined) { bounds.x = Math.min(bounds.x, attrNum(e, 'x') * k); bounds.y = Math.min(bounds.y, attrNum(e, 'y') * k); } }
  if (!Number.isFinite(bounds.x)) { bounds.x = 0; bounds.y = 0; }
  const P = (p: { x: number; y: number }): Vec2 => ({ x: Math.round(mil(1000) + mm(p.x - bounds.x)), y: Math.round(mil(1000) + mm(p.y - bounds.y)) });
  const len = (v: number) => Math.round(mm(v));

  /** A Polygon / Polyline / Cutout's vertices (mm → AD), each curve step an arc on the vertex before it. */
  const verts = (e: XEl, u = k, map: (p: { x: number; y: number }) => { x: number; y: number } = (p) => p, mirrored = false): PolyVertex[] => {
    const out: PolyVertex[] = [];
    for (const c of e.children) {
      if (c.name !== 'PolyBegin' && c.name !== 'PolyStepSegment' && c.name !== 'PolyStepCurve') continue;
      const p = P(map({ x: attrNum(c, 'x') * u, y: attrNum(c, 'y') * u }));
      if (c.name === 'PolyStepCurve' && out.length) {
        const prev = out[out.length - 1]!;
        const ctr = P(map({ x: attrNum(c, 'centerX') * u, y: attrNum(c, 'centerY') * u }));
        const cw = (c.attrs.clockwise === 'true') !== mirrored;
        const ang = (q: Vec2) => (((Math.atan2(q.y - ctr.y, q.x - ctr.x) * 180) / Math.PI) + 360) % 360;
        const r = Math.round(Math.hypot(prev.p.x - ctr.x, prev.p.y - ctr.y));
        const a0 = ang(prev.p), a1 = ang(p);
        const full = Math.abs(prev.p.x - p.x) < 2 && Math.abs(prev.p.y - p.y) < 2;
        prev.arc = full ? { c: ctr, r, sa: a0, ea: a0 + 360 } : cw ? { c: ctr, r, sa: a1, ea: a1 > a0 ? a0 + 360 : a0 } : { c: ctr, r, sa: a0, ea: a0 > a1 ? a1 + 360 : a1 };
      }
      out.push({ p });
    }
    // The closing copy of the first vertex
    if (out.length > 2) { const f = out[0]!.p, l = out[out.length - 1]!; if (!l.arc && Math.abs(f.x - l.p.x) < 2 && Math.abs(f.y - l.p.y) < 2) out.pop(); }
    return out;
  };
  const flat = (vs: PolyVertex[]): Vec2[] => flattenVertices(vs);

  /* ── nets ── */
  const netIndex = new Map<string, number>();
  const nets: string[] = [];
  const netOf = (n: string | undefined): number | undefined => {
    if (!n || /^(No Net|NoNet|\$NONE\$|N\/C)$/i.test(n)) return undefined;
    if (!netIndex.has(n)) { netIndex.set(n, nets.length); nets.push(n); }
    return netIndex.get(n);
  };
  for (const ln of kidsOf(step, 'LogicalNet')) netOf(ln.attrs.name);

  /* ── packages and components ── */
  const packages = new Map(kidsOf(step, 'Package').map((p) => [p.attrs.name ?? '', p]));
  const compIndex = new Map<string, number>();
  const comps: PropertyBag[] = [];
  const texts: PcbRawRecord[] = [], tracks: PcbRawRecord[] = [], arcs: PcbRawRecord[] = [], regions: PcbRawRecord[] = [], pads: PcbRawRecord[] = [], vias: PcbRawRecord[] = [], bodies: PcbRawRecord[] = [];
  const topName = copperNames[0], botName = copperNames[copperNames.length - 1];
  for (const c of kidsOf(step, 'Component')) {
    const ref = c.attrs.refDes ?? '';
    const xf = xfOf(c), loc = kid(c, 'Location');
    const at = { x: attrNum(loc, 'x') * k, y: attrNum(loc, 'y') * k };
    const bottom = c.attrs.layerRef === botName && c.attrs.layerRef !== topName || xf.mirror && c.attrs.layerRef !== topName;
    // IPC-2581 mirrors after turning; AD turns the library footprint, mirrored top to bottom
    const rot = bottom ? ((180 - xf.rot) % 360 + 360) % 360 : ((xf.rot % 360) + 360) % 360;
    const pos = P({ x: at.x + xf.x * k, y: at.y + xf.y * k });
    const pkg = packages.get(c.attrs.packageRef ?? '');
    const value = kidsOf(c, 'NonstandardAttribute').find((a) => /^(VALUE|COMMENT)$/i.test(a.attrs.name ?? ''))?.attrs.value ?? c.attrs.part ?? '';
    const ci = comps.length;
    compIndex.set(ref, ci);
    comps.push(PropertyBag.from({
      LAYER: bottom ? 'BOTTOM' : 'TOP', PATTERN: c.attrs.packageRef ?? '', SOURCEDESIGNATOR: ref, SOURCEFOOTPRINTLIBRARY: `${name}.PcbLib`, FOOTPRINTDESCRIPTION: pkg?.attrs.type ?? '',
      X: formatAltiumLength(pos.x), Y: formatAltiumLength(pos.y), ROTATION: altiumFloat(rot), HEIGHT: formatAltiumLength(len(attrNum(c, 'height', attrNum(pkg, 'height')) * k)),
      NAMEON: 'FALSE', COMMENTON: 'FALSE', LOCKED: 'FALSE', COMPONENTKIND: /MECHANICAL|DOCUMENT/i.test(c.attrs.mountType ?? '') ? 1 : 0, SOURCELIBREFERENCE: c.attrs.part ?? '',
    }));
    // Designator and comment (shown by the silkscreen's own drawing, hidden here)
    const textAt = { x: pos.x, y: pos.y };
    texts.push(encodeText({ layer: bottom ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY, at: textAt, height: mil(40), text: ref, component: ci, isDesignator: true, mirrored: bottom }));
    texts.push(encodeText({ layer: bottom ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY, at: textAt, height: mil(40), text: value, component: ci, isComment: true, mirrored: bottom }));
    // A body: the package's outline, its height above the standoff
    const outline = kid(kid(pkg, 'Outline'), 'Polygon');
    const height = attrNum(c, 'height', attrNum(pkg, 'height')) * k, standoff = attrNum(c, 'standoff') * k;
    if (outline && height > 0) {
      const map = place({ ...xf, x: 0, y: 0, scale: 1 }, at);
      const pts = flat(verts(outline, k, map, xf.mirror));
      if (pts.length >= 3) bodies.push(encodeBody({ component: ci, outline: pts, standoff: len(standoff), overall: len(standoff + height), colour: 0x606060, layer: bottom ? mechLayer(14) : mechLayer(13), bottom }));
    }
  }

  /* ── holes (drill layers) ── */
  interface Hole { at: Vec2; d: number; status: string; net?: string; span: [LayerId, LayerId]; slot?: { length: number; rotation: number }; used?: boolean }
  const holes: Hole[] = [];
  for (const dl of drillLayers) {
    const span = kid(dl, 'Span');
    const from = span ? copperNames.indexOf(span.attrs.fromLayer ?? '') : 0, to = span ? copperNames.indexOf(span.attrs.toLayer ?? '') : copperNames.length - 1;
    const s: [LayerId, LayerId] = [copperIds[Math.max(0, Math.min(from, to))] ?? L.TOP, copperIds[Math.max(from, to) >= 0 ? Math.max(from, to) : copperIds.length - 1] ?? L.BOTTOM];
    const lf = kidsOf(step, 'LayerFeature').find((f) => f.attrs.layerRef === dl.attrs.name);
    for (const set of kidsOf(lf, 'Set')) {
      for (const h of kidsOf(set, 'Hole')) holes.push({ at: P({ x: attrNum(h, 'x') * k, y: attrNum(h, 'y') * k }), d: len(attrNum(h, 'diameter') * k), status: (h.attrs.platingStatus ?? 'PLATED').toUpperCase(), net: set.attrs.net, span: s });
      for (const h of kidsOf(set, 'SlotCavity')) {
        const loc = kid(h, 'Location'), sh = shapeRef(h);
        if (!sh) continue;
        holes.push({ at: P({ x: attrNum(loc, 'x') * k, y: attrNum(loc, 'y') * k }), d: len(Math.min(sh.w, sh.h)), status: (h.attrs.platingStatus ?? 'PLATED').toUpperCase(), net: set.attrs.net, span: s,
          slot: { length: len(Math.max(sh.w, sh.h)), rotation: (sh.w >= sh.h ? 0 : 90) + xfOf(h).rot + sh.rot } });
      }
    }
  }
  const holeKey = (p: Vec2) => `${Math.round(p.x / 400)},${Math.round(p.y / 400)}`;
  const holeAt = new Map<string, Hole>();
  for (const h of holes) holeAt.set(holeKey(h.at), h);
  const findHole = (p: Vec2) => {
    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
      const h = holeAt.get(`${Math.round(p.x / 400) + dx},${Math.round(p.y / 400) + dy}`);
      if (h && Math.abs(h.at.x - p.x) <= 400 && Math.abs(h.at.y - p.y) <= 400) return h;
    }
    return undefined;
  };

  /* ── features per layer ── */
  interface PadFeat { layer: LayerId; at: Vec2; rot: number; shape: Shape; net?: string; comp?: string; pin?: string; via: boolean }
  const padFeats: PadFeat[] = [];
  let nTracks = 0;
  for (const lf of kidsOf(step, 'LayerFeature')) {
    const lname = lf.attrs.layerRef ?? '';
    if (drillLayers.some((d) => d.attrs.name === lname)) continue;
    const layer = layerOf.get(lname);
    if (layer === undefined || layer === null) continue;
    if (isPlane(layer)) continue;
    const copper = copperIds.includes(layer);
    const maskOrPaste = layer === L.TOP_SOLDER || layer === L.BOTTOM_SOLDER || layer === L.TOP_PASTE || layer === L.BOTTOM_PASTE;
    for (const set of kidsOf(lf, 'Set')) {
      const net = copper ? netOf(set.attrs.net) : undefined;
      const owner = set.attrs.componentRef !== undefined ? compIndex.get(set.attrs.componentRef) : undefined;
      const isVia = /VIA/i.test(set.attrs.padUsage ?? '') || /VIA/i.test(set.attrs.geometry ?? '');
      for (const pad of kidsOf(set, 'Pad')) {
        if (maskOrPaste) continue;
        const sh = shapeRef(pad);
        if (!sh) continue;
        const xf = xfOf(pad), loc = kid(pad, 'Location');
        const at = P({ x: attrNum(loc, 'x') * k + xf.x * k, y: attrNum(loc, 'y') * k + xf.y * k });
        const pr = kid(pad, 'PinRef');
        const turn = xf.mirror ? -(xf.rot + sh.rot) : xf.rot + sh.rot;
        if (copper) padFeats.push({ layer, at, rot: ((turn % 360) + 360) % 360, shape: sh, net: set.attrs.net, comp: pr?.attrs.componentRef, pin: pr?.attrs.pin, via: isVia || /^VIA/i.test(pad.attrs.padstackDefRef ?? '') && !pr });
        else flash(at, sh, ((turn % 360) + 360) % 360, layer, owner);
      }
      for (const fe of kidsOf(set, 'Features')) {
        const loc = kid(fe, 'Location');
        const fxf = xfOf(fe);
        const map = place(fxf, { x: attrNum(loc, 'x') * k, y: attrNum(loc, 'y') * k });
        for (const g of fe.children) {
          switch (g.name) {
            case 'Line': {
              const a = P(map({ x: attrNum(g, 'startX') * k, y: attrNum(g, 'startY') * k })), b = P(map({ x: attrNum(g, 'endX') * k, y: attrNum(g, 'endY') * k }));
              tracks.push(encodeTrack({ layer, a, b, width: Math.max(1, len(widthOf(g))), net, component: owner })); nTracks++;
              break;
            }
            case 'Arc': {
              const a = P(map({ x: attrNum(g, 'startX') * k, y: attrNum(g, 'startY') * k })), b = P(map({ x: attrNum(g, 'endX') * k, y: attrNum(g, 'endY') * k }));
              const c = P(map({ x: attrNum(g, 'centerX') * k, y: attrNum(g, 'centerY') * k }));
              arcs.push(encodeArc({ layer, ...arcOf(a, b, c, (g.attrs.clockwise === 'true') !== fxf.mirror), width: Math.max(1, len(widthOf(g))), net, component: owner })); nTracks++;
              break;
            }
            case 'Polyline': {
              const vs = verts(g, k, map, fxf.mirror), w = Math.max(1, len(widthOf(g)));
              for (let i = 0; i + 1 < vs.length; i++) {
                const v = vs[i]!, n = vs[i + 1]!;
                if (v.arc) arcs.push(encodeArc({ layer, c: v.arc.c, r: v.arc.r, start: norm(v.arc.sa), end: norm(v.arc.ea), width: w, net, component: owner }));
                else tracks.push(encodeTrack({ layer, a: v.p, b: n.p, width: w, net, component: owner }));
                nTracks++;
              }
              break;
            }
            case 'Contour': {
              const poly = kid(g, 'Polygon');
              if (!poly) break;
              const outline = flat(verts(poly, k, map, fxf.mirror));
              const holes2 = kidsOf(g, 'Cutout').map((cu) => flat(verts(cu, k, map, fxf.mirror))).filter((h) => h.length >= 3);
              if (outline.length >= 3) regions.push(encodeRegion({ layer, outline, holes: holes2, net, component: owner }));
              break;
            }
            case 'Circle': case 'RectCenter': case 'RectRound': case 'Oval': case 'RectCham': case 'Octagon': case 'Ellipse': case 'Diamond': case 'Hexagon': case 'Triangle': case 'Donut': {
              const sh = shapeOf(g, k);
              if (sh) flash(P(map({ x: 0, y: 0 })), sh, fxf.rot, layer, owner, net);
              break;
            }
            case 'StandardPrimitiveRef': case 'UserPrimitiveRef': {
              const sh = shapeRef(fe);
              if (sh) flash(P(map({ x: 0, y: 0 })), sh, fxf.rot, layer, owner, net);
              break;
            }
            case 'Text': {
              const t = g.attrs.textString ?? '';
              const bb = kid(g, 'BoundingBox');
              const h = bb ? Math.abs(attrNum(bb, 'upperRightY') - attrNum(bb, 'lowerLeftY')) * k : attrNum(g, 'fontSize', 1) * k;
              const tx = xfOf(g);
              if (t) texts.push(encodeText({ layer, at: P(map({ x: bb ? attrNum(bb, 'lowerLeftX') * k : 0, y: bb ? attrNum(bb, 'lowerLeftY') * k : 0 })), height: Math.max(mil(10), len(h)), text: t, rotation: tx.rot || fxf.rot, mirrored: tx.mirror || fxf.mirror, component: owner }));
              break;
            }
          }
        }
      }
    }
  }

  /** A flash (a shape at a point) as a region: its outline turned into place. */
  function flash(at: Vec2, sh: Shape, rot: number, layer: LayerId, component?: number, net?: number): void {
    const pts = shapeOutline(sh, rot).map((p) => ({ x: Math.round(at.x + mm(p.x)), y: Math.round(at.y + mm(p.y)) }));
    if (pts.length >= 3) regions.push(encodeRegion({ layer, outline: pts, component, net }));
  }

  /* ── pads: one per pin (through-hole where a hole is under it), vias from the rest ── */
  const groups = new Map<string, PadFeat[]>();
  for (const f of padFeats) {
    const key = f.comp !== undefined && f.pin !== undefined ? `pin:${f.comp}\u0000${f.pin}` : `at:${holeKey(f.at)}:${f.net ?? ''}:${f.via ? 'v' : ''}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const copperIndex = (l: LayerId) => copperIds.indexOf(l);
  for (const list of groups.values()) {
    // Through holes: a group whose pads are apart is several pads (a pin of more than one pad)
    const first = list.find((f) => f.layer === L.TOP) ?? list[0]!;
    const hole = findHole(first.at);
    const net = netOf(first.net ?? hole?.net);
    const comp = first.comp !== undefined ? compIndex.get(first.comp) : undefined;
    if (hole && !hole.used) hole.used = true;
    if (hole && (first.via || (!first.pin && hole.status === 'VIA'))) {
      const d = Math.max(...list.map((f) => Math.max(f.shape.w, f.shape.h)));
      const idx = list.map((f) => copperIndex(f.layer)).filter((i) => i >= 0);
      vias.push(encodeVia({ at: hole.at, diameter: Math.max(len(d), hole.d + 1), hole: hole.d, net,
        layerStart: idx.length ? copperIds[Math.min(...idx)] : hole.span[0], layerEnd: idx.length ? copperIds[Math.max(...idx)] : hole.span[1] }));
      continue;
    }
    if (hole) {
      pads.push(padRecord(first, L.MULTI, comp, net, hole.d, hole.status !== 'NONPLATED', hole.slot));
      continue;
    }
    // Surface-mount: each layer's pad (normally one)
    const layers = new Set<LayerId>();
    for (const f of list) {
      if (layers.has(f.layer)) continue;
      layers.add(f.layer);
      pads.push(padRecord(f, f.layer, comp, net));
    }
  }
  // Holes no pad was on: unplated mounting holes (or vias with no pads)
  for (const h of holes) {
    if (h.used) continue;
    if (h.status === 'VIA') vias.push(encodeVia({ at: h.at, diameter: h.d + mil(10), hole: h.d, net: netOf(h.net), layerStart: h.span[0], layerEnd: h.span[1] }));
    else pads.push(encodePad({ name: '', layer: L.MULTI, at: h.at, w: h.slot ? h.slot.length : h.d, h: h.d, shape: 'round', hole: h.d, net: netOf(h.net), plated: h.status !== 'NONPLATED', slot: h.slot }));
  }

  function padRecord(f: PadFeat, layer: LayerId, comp: number | undefined, net: number | undefined, hole?: number, plated?: boolean, slot?: { length: number; rotation: number }): PcbRawRecord {
    const s = f.shape;
    const w = Math.max(1, len(s.w)), h = Math.max(1, len(s.h));
    const shape = s.kind === 'poly' ? 'rect' : s.kind;
    // A shape AD's pads haven't: its outline as copper with the pad
    if (s.kind === 'poly' && s.outline) for (const cl of layer === L.MULTI ? [L.TOP, L.BOTTOM] : [layer]) flash(f.at, s, f.rot, cl, comp, net);
    return encodePad({ name: f.pin ?? '', layer, at: f.at, w: s.kind === 'poly' ? Math.max(1, Math.round(Math.min(w, h) * 0.5)) : w, h: s.kind === 'poly' ? Math.max(1, Math.round(Math.min(w, h) * 0.5)) : h, shape, rotation: f.rot,
      cornerPct: s.cornerPct, hole, plated, slot, net, component: comp });
  }

  /* ── the board shape ── */
  const profile = kid(step, 'Profile');
  let outline: PolyVertex[] = profilePoly ? verts(profilePoly) : [];
  if (outline.length < 3) {
    warnings.push('No board profile: the board shape is drawn round its contents');
    outline = [{ p: P({ x: bounds.x, y: bounds.y }) }, { p: P({ x: bounds.x + 100, y: bounds.y }) }, { p: P({ x: bounds.x + 100, y: bounds.y + 80 }) }, { p: P({ x: bounds.x, y: bounds.y + 80 }) }];
  }
  for (const cu of kidsOf(profile, 'Cutout')) { const pts = flat(verts(cu)); if (pts.length >= 3) regions.push(encodeRegion({ layer: L.MULTI, outline: pts, boardCutout: true })); }
  const datum = kid(step, 'Datum');
  const origin = P({ x: attrNum(datum, 'x') * k, y: attrNum(datum, 'y') * k });
  const xs = outline.map((v) => v.p.x), ys = outline.map((v) => v.p.y);
  const board = newBoardRecord({ fileName: `${name}.PcbDoc`, origin, outline,
    sheet: { x: 0, y: 0, width: Math.max(...xs) + mil(2000), height: Math.max(...ys) + mil(2000) }, mechanical: [1, ...mechNames.keys()] });
  for (const [n, nm] of mechNames) board.set(`LAYER${mechLayer(n)}NAME`, nm);

  // A plane's net: the one most of its layer's sets name
  const planeNet = (n: string) => {
    const count = new Map<string, number>();
    for (const set of kidsOf(kidsOf(step, 'LayerFeature').find((f) => f.attrs.layerRef === n), 'Set')) if (set.attrs.net) count.set(set.attrs.net, (count.get(set.attrs.net) ?? 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const planeNets = new Map(copperNames.map((n, i) => [n, isPlane(copperIds[i]!) ? planeNet(n) : undefined]));
  for (const n of planeNets.values()) netOf(n);

  /* ── the file ── */
  const pcb = assemblePcbDoc({ board, nets, comps, pads, tracks, vias, arcs, texts, regions, bodies }, `${name}.PcbDoc`);
  // The stack: copper names and thicknesses, dielectrics between
  const thick = new Map(stackLayers.map((s) => [s.attrs.layerOrGroupRef ?? '', attrNum(s, 'thickness') * k]));
  const diel = stackLayers.filter((s) => /DIEL/.test(fn(byName.get(s.attrs.layerOrGroupRef ?? ''))));
  applyStackLayers(pcb, copperNames.map((n, i) => ({ name: n, thickness: thick.get(n) ? mm(thick.get(n)!) : undefined, plane: isPlane(copperIds[i]!), net: planeNets.get(n) })),
    diel.map((d) => ({ thickness: mm(attrNum(d, 'thickness') * k) || undefined, prepreg: /PREG/.test(fn(byName.get(d.attrs.layerOrGroupRef ?? ''))) })));
  for (const [n, nm] of mechNames) pcb.board.layerNames.set(mechLayer(n), nm);
  const footprints = footprintsFromBoard(pcb);
  return {
    bytes: writePcbDoc(pcb), name, footprints, warnings,
    stats: { components: comps.length, pads: pads.length, vias: vias.length, tracks: nTracks, nets: nets.length, layers: copperNames.length },
  };
}

export const ipcFootprintLibrary = (fps: FootprintDef[], name: string): Uint8Array => writePcbLib([...fps].sort((a, b) => a.name.localeCompare(b.name)), name);

/* ── shapes ── */

const STANDARD = new Set(['Circle', 'RectCenter', 'RectRound', 'RectCham', 'Oval', 'Octagon', 'Hexagon', 'Diamond', 'Ellipse', 'Triangle', 'Donut', 'Butterfly', 'Thermal', 'Moire', 'RectCorner', 'Contour']);
const norm = (a: number) => ((a % 360) + 360) % 360;

/** A standard primitive (mm): AD's nearest pad shape, its own turn. */
function shapeOf(e: XEl, u: number): Shape | null {
  const rot = attrNum(kid(e, 'Xform'), 'rotation');
  const w = attrNum(e, 'width') * u, h = attrNum(e, 'height') * u;
  switch (e.name) {
    case 'Circle': { const d = attrNum(e, 'diameter') * u; return { kind: 'round', w: d, h: d, rot }; }
    case 'Oval': case 'Ellipse': return { kind: 'round', w, h, rot };
    case 'RectCenter': return { kind: 'rect', w, h, rot };
    case 'RectRound': { const r = attrNum(e, 'radius') * u; return { kind: 'roundrect', w, h, rot, cornerPct: Math.max(0, Math.min(100, (r / (Math.min(w, h) / 2 || 1)) * 100)) }; }
    case 'RectCham': case 'Octagon': case 'Hexagon': { const l = attrNum(e, 'length') * u; return { kind: 'octagon', w: w || l, h: h || l, rot }; }
    case 'Diamond': case 'Triangle': return { kind: 'poly', w, h, rot, outline: e.name === 'Diamond' ? [{ x: w / 2, y: 0 }, { x: 0, y: h / 2 }, { x: -w / 2, y: 0 }, { x: 0, y: -h / 2 }] : [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: 0, y: h / 2 }] };
    case 'Donut': case 'Thermal': case 'Moire': { const d = attrNum(e, 'outerDiameter', attrNum(e, 'diameter')) * u; return { kind: 'round', w: d, h: d, rot }; }
    case 'RectCorner': { const x0 = attrNum(e, 'lowerLeftX') * u, y0 = attrNum(e, 'lowerLeftY') * u, x1 = attrNum(e, 'upperRightX') * u, y1 = attrNum(e, 'upperRightY') * u; return { kind: 'poly', w: x1 - x0, h: y1 - y0, rot, outline: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] }; }
    case 'Contour': {
      const poly = kid(e, 'Polygon');
      if (!poly) return null;
      const pts = poly.children.filter((c) => c.attrs.x !== undefined).map((c) => ({ x: attrNum(c, 'x') * u, y: attrNum(c, 'y') * u }));
      if (pts.length < 3) return null;
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      return { kind: 'poly', w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), rot, outline: pts };
    }
  }
  return null;
}

/** A user primitive's outline (its first contour or polygon, mm). */
function userOutline(e: XEl, u: number): Vec2[] {
  const poly = descendants(e, 'Polygon')[0] ?? descendants(e, 'Polyline')[0];
  if (poly) return poly.children.filter((c) => c.attrs.x !== undefined).map((c) => ({ x: attrNum(c, 'x') * u, y: attrNum(c, 'y') * u }));
  const st = descendants(e, 'UserSpecial')[0]?.children.find((c) => STANDARD.has(c.name));
  const s = st ? shapeOf(st, u) : null;
  return s ? shapeOutline(s, 0) : [];
}

/** A shape's outline about its centre (mm), turned by rot (degrees) and its own turn. */
function shapeOutline(s: Shape, rot: number): Vec2[] {
  const r = ((rot + s.rot) * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
  const turn = (p: Vec2) => ({ x: p.x * c - p.y * sn, y: p.x * sn + p.y * c });
  if (s.outline) return s.outline.map(turn);
  const hw = s.w / 2, hh = s.h / 2;
  if (s.kind === 'round') {
    if (Math.abs(s.w - s.h) < 1e-9) return Array.from({ length: 24 }, (_, i) => turn({ x: hw * Math.cos((i / 24) * 2 * Math.PI), y: hw * Math.sin((i / 24) * 2 * Math.PI) }));
    // A stadium: semicircles on the long axis
    const long = s.w >= s.h, rr = Math.min(hw, hh), off = Math.abs(hw - hh), pts: Vec2[] = [];
    for (const side of [1, -1]) for (let i = 0; i <= 12; i++) {
      const a = (long ? -Math.PI / 2 : 0) + (side < 0 ? Math.PI : 0) + (i / 12) * Math.PI;
      pts.push(long ? { x: side * off + rr * Math.cos(a), y: rr * Math.sin(a) } : { x: rr * Math.cos(a), y: side * off + rr * Math.sin(a) });
    }
    return pts.map(turn);
  }
  if (s.kind === 'octagon') { const q = Math.min(hw, hh) / 2; return [{ x: hw, y: hh - q }, { x: hw - q, y: hh }, { x: -hw + q, y: hh }, { x: -hw, y: hh - q }, { x: -hw, y: -hh + q }, { x: -hw + q, y: -hh }, { x: hw - q, y: -hh }, { x: hw, y: -hh + q }].map(turn); }
  return [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }].map(turn);
}

/** An arc from a to b about c, clockwise or not: AD's centre, radius and anticlockwise angles. */
function arcOf(a: Vec2, b: Vec2, c: Vec2, cw: boolean): { c: Vec2; r: number; start: number; end: number } {
  const ang = (q: Vec2) => norm((Math.atan2(q.y - c.y, q.x - c.x) * 180) / Math.PI);
  const r = Math.round(Math.hypot(a.x - c.x, a.y - c.y));
  if (Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2) return { c, r, start: 0, end: 360 };
  return cw ? { c, r, start: ang(b), end: ang(a) } : { c, r, start: ang(a), end: ang(b) };
}
