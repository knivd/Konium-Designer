/**
 * File › Fabrication Outputs › IPC-2581 Files: the board as one IPC-2581 revision B XML file —
 * dictionaries of pad shapes and line widths, the layers and their stackup, the board profile
 * (with cut-outs), packages and components, the logical nets, the bill of materials, and each
 * layer's features grouped by net (lines, arcs, pads with their pins, surfaces), the holes on
 * a drill layer. Millimetres from the board's relative origin [est: AD17's element order and
 * naming in detail].
 */
import type { Vec2 } from '../core/geom';
import { rotate } from '../core/geom';
import { L, layerName, type LayerId } from '../model/layers';
import { NO_NET, type PadStackLayer, type PcbDocument, type PcbPad } from '../model/pcb';
import { readStack } from '../model/pcbStack';
import { APP_VERSION } from '../platform/distribution';
import { boardThickness } from '../render/gl3d/boardModel';
import { holes } from './gerber/drill';
import { padOutline, plottableLayers } from './gerber/gerber';
import { layerFeatures, signedArea, type Tagged } from './features';

const MM = 25.4 / 10_000_000;
const n6 = (c: number) => String(+(c * MM).toFixed(6));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface Ipc2581Options { mode?: 'FULL' | 'FABRICATION' | 'ASSEMBLY'; when?: Date; layers?: LayerId[] }

/** A layer's IPC-2581 function and side. */
function layerFunction(doc: PcbDocument, l: LayerId): { fn: string; side: string } {
  const stack = doc.board.copperStack, top = stack[0], bottom = stack.at(-1);
  if (l >= L.TOP && l <= L.BOTTOM) return { fn: 'SIGNAL', side: l === top ? 'TOP' : l === bottom ? 'BOTTOM' : 'INTERNAL' };
  if (l >= L.PLANE1 && l <= L.PLANE16) return { fn: 'PLANE', side: 'INTERNAL' };
  switch (l) {
    case L.TOP_SOLDER: return { fn: 'SOLDERMASK', side: 'TOP' };
    case L.BOTTOM_SOLDER: return { fn: 'SOLDERMASK', side: 'BOTTOM' };
    case L.TOP_PASTE: return { fn: 'SOLDERPASTE', side: 'TOP' };
    case L.BOTTOM_PASTE: return { fn: 'SOLDERPASTE', side: 'BOTTOM' };
    case L.TOP_OVERLAY: return { fn: 'SILKSCREEN', side: 'TOP' };
    case L.BOTTOM_OVERLAY: return { fn: 'SILKSCREEN', side: 'BOTTOM' };
    default: return { fn: 'DOCUMENT', side: 'NONE' };
  }
}

/** Shapes and line widths, each written once and referred to by id. */
class Dictionaries {
  shapes = new Map<string, { id: string; xml: string; user: boolean }>();
  lines = new Map<string, string>();
  shape(st: PadStackLayer, grow = 0): string {
    const w = st.w + 2 * grow, h = st.h + 2 * grow;
    let key: string, xml: string, user = false;
    if (st.shape === 'round' && w === h) { key = `C${w}`; xml = `<Circle diameter="${n6(w)}"/>`; }
    else if (st.shape === 'round') { key = `O${w}x${h}`; xml = `<Oval width="${n6(w)}" height="${n6(h)}"/>`; }
    else if (st.shape === 'rect') { key = `R${w}x${h}`; xml = `<RectCenter width="${n6(w)}" height="${n6(h)}"/>`; }
    else if (st.shape === 'roundrect') {
      const r = Math.min(w, h) / 2 * (st.cornerPct / 100);
      key = `RR${w}x${h}r${r}`; xml = `<RectRound width="${n6(w)}" height="${n6(h)}" radius="${n6(r)}" upperRight="true" upperLeft="true" lowerRight="true" lowerLeft="true"/>`;
    } else {
      // Octagon (and anything else): its outline as a contour
      key = `P${st.shape}${w}x${h}`; user = true;
      const pts = padOutline({ x: 0, y: 0 }, { ...st, w, h }, 0);
      xml = `<UserSpecial><Contour>${polygon(pts)}</Contour></UserSpecial>`;
    }
    let e = this.shapes.get(key);
    if (!e) { e = { id: `${user ? 'SHAPE' : 'PRIM'}_${this.shapes.size + 1}`, xml, user }; this.shapes.set(key, e); }
    return e.id;
  }
  circle(d: number): string { return this.shape({ w: d, h: d, shape: 'round', cornerPct: 0 }); }
  line(w: number): string {
    const k = n6(w);
    let id = this.lines.get(k);
    if (!id) { id = `LINE_${this.lines.size + 1}`; this.lines.set(k, id); }
    return id;
  }
}

function polygon(pts: Vec2[], o: Vec2 = { x: 0, y: 0 }): string {
  if (pts.length < 3) return '';
  const p = pts.map((v) => `x="${n6(v.x - o.x)}" y="${n6(v.y - o.y)}"`);
  return `<Polygon><PolyBegin ${p[0]}/>${p.slice(1).map((v) => `<PolyStepSegment ${v}/>`).join('')}<PolyStepSegment ${p[0]}/></Polygon>`;
}
const ccw = (p: Vec2[]) => (signedArea(p) >= 0 ? p : [...p].reverse());
const cw = (p: Vec2[]) => (signedArea(p) < 0 ? p : [...p].reverse());

/** Pad position and rotation in its component's own frame (as the package defines it). */
function padInComponent(doc: PcbDocument, p: PcbPad): { at: Vec2; rot: number } {
  const c = doc.components[p.component]!;
  const bottom = c.layer === L.BOTTOM;
  let v = rotate(p.at, -c.rotation, c.at);
  v = { x: v.x - c.at.x, y: v.y - c.at.y };
  if (bottom) v = { x: -v.x, y: v.y };
  const rot = ((bottom ? -(p.rotation - c.rotation) : p.rotation - c.rotation) % 360 + 360) % 360;
  return { at: v, rot };
}

export function ipc2581(doc: PcbDocument, o: Ipc2581Options = {}): string {
  const when = o.when ?? new Date();
  const iso = when.toISOString().replace(/\.\d{3}Z$/, '');
  const base = doc.name.replace(/\.pcbdoc$/i, '');
  const origin = doc.board.origin;
  const dict = new Dictionaries();
  const lname = (l: LayerId) => doc.board.layerNames.get(l) ?? layerName(l);
  const layers = (o.layers ?? plottableLayers(doc)).filter((l) => !(l >= L.MECH1 && l <= L.MECH16) || doc.prims.some((p) => 'layer' in p && p.layer === l && p.kind !== 'body'));
  const n = doc.board.copperStack.length;
  const drillName = `DRILL_1-${n}`;
  const at = (v: Vec2) => `x="${n6(v.x - origin.x)}" y="${n6(v.y - origin.y)}"`;

  // ── Features per layer, by net ──
  const layerXml: string[] = [];
  for (const l of layers) {
    const items = layerFeatures(doc, l);
    if (!items.length) continue;
    const sets = new Map<string, Tagged[]>();
    for (const t of items) { const k = t.m?.net ?? ''; sets.set(k, [...(sets.get(k) ?? []), t]); }
    const body: string[] = [];
    for (const [net, list] of sets) {
      const feats: string[] = [], pads: string[] = [];
      for (const { f, m } of list) {
        switch (f.t) {
          case 'line': feats.push(`<Line startX="${n6(f.a.x - origin.x)}" startY="${n6(f.a.y - origin.y)}" endX="${n6(f.b.x - origin.x)}" endY="${n6(f.b.y - origin.y)}"><LineDescRef id="${dict.line(f.w)}"/></Line>`); break;
          case 'arc': {
            const sweep = ((f.end - f.start) % 360 + 360) % 360 || 360;
            const p = (d: number) => ({ x: f.c.x + f.r * Math.cos((d * Math.PI) / 180), y: f.c.y + f.r * Math.sin((d * Math.PI) / 180) });
            const a = p(f.start), b = p(f.start + sweep);
            feats.push(`<Arc startX="${n6(a.x - origin.x)}" startY="${n6(a.y - origin.y)}" endX="${n6(b.x - origin.x)}" endY="${n6(b.y - origin.y)}" centerX="${n6(f.c.x - origin.x)}" centerY="${n6(f.c.y - origin.y)}" clockwise="false"><LineDescRef id="${dict.line(f.w)}"/></Arc>`);
            break;
          }
          case 'surface': feats.push(`<Contour>${polygon(ccw(f.outline), origin)}${f.holes.filter((h) => h.length >= 3).map((h) => `<Cutout>${polygon(cw(h), origin).replace(/^<Polygon>|<\/Polygon>$/g, '')}</Cutout>`).join('')}</Contour>`); break;
          case 'pad': case 'dot': {
            const id = f.t === 'pad' ? dict.shape(f.st, f.grow) : dict.circle(f.d);
            const rot = f.t === 'pad' ? ((f.rot % 360) + 360) % 360 : 0;
            const pin = m?.pin ? `<PinRef componentRef="${esc(m.pin[0])}" pin="${esc(m.pin[1])}"/>` : '';
            pads.push(`<Pad>${rot ? `<Xform rotation="${+rot.toFixed(3)}"/>` : ''}<Location ${at(f.at)}/><StandardPrimitiveRef id="${id}"/>${pin}</Pad>`);
            break;
          }
        }
      }
      const netAttr = net ? ` net="${esc(net)}"` : '';
      if (pads.length) body.push(`<Set${netAttr} padUsage="TERMINATION">${pads.join('')}</Set>`);
      if (feats.length) body.push(`<Set${netAttr}><Features>${feats.join('')}</Features></Set>`);
    }
    layerXml.push(`<LayerFeature layerRef="${esc(lname(l))}">${body.join('')}</LayerFeature>`);
  }
  // Holes on the drill layer
  const via = new Set(doc.prims.flatMap((p) => (p.kind === 'via' ? [`${p.at.x},${p.at.y}`] : [])));
  const hl = holes(doc);
  if (hl.length) {
    const byNet = new Map<string, string[]>();
    hl.forEach((h, i) => {
      const prim = doc.prims.find((p) => (p.kind === 'via' || p.kind === 'pad') && p.at.x === h.at.x && p.at.y === h.at.y && p.hole === h.size);
      const net = prim && 'net' in prim && prim.net !== NO_NET ? doc.nets[prim.net]?.name ?? '' : '';
      const status = !h.plated ? 'NONPLATED' : via.has(`${h.at.x},${h.at.y}`) ? 'VIA' : 'PLATED';
      byNet.set(net, [...(byNet.get(net) ?? []), `<Hole name="H${i + 1}" diameter="${n6(h.size)}" platingStatus="${status}" plusTol="0" minusTol="0" ${at(h.at)}/>`]);
    });
    layerXml.push(`<LayerFeature layerRef="${drillName}">${[...byNet].map(([net, hs]) => `<Set${net ? ` net="${esc(net)}"` : ''}>${hs.join('')}</Set>`).join('')}</LayerFeature>`);
  }

  // ── Packages (one per footprint, from its first component) and components ──
  const packages = new Map<string, string>();
  const comps: string[] = [];
  doc.components.forEach((c, ci) => {
    const pads = doc.prims.filter((p): p is PcbPad => p.kind === 'pad' && p.component === ci);
    const name = c.pattern || `PKG_${c.designator}`;
    if (!packages.has(name)) {
      const pins = pads.map((p) => {
        const q = padInComponent(doc, p);
        return `<Pin number="${esc(p.name)}" type="${p.layer === L.MULTI ? 'THRU' : 'SURFACE'}" electricalType="ELECTRICAL">${q.rot ? `<Xform rotation="${+q.rot.toFixed(3)}"/>` : ''}<Location x="${n6(q.at.x)}" y="${n6(q.at.y)}"/><StandardPrimitiveRef id="${dict.shape(p.top)}"/></Pin>`;
      });
      // Outline: the pads' extent
      const pts = pads.map((p) => padInComponent(doc, p).at);
      let outline = '';
      if (pts.length) {
        const m = 250_000;
        const xs = pts.map((v) => v.x), ys = pts.map((v) => v.y);
        const box = [{ x: Math.min(...xs) - m, y: Math.min(...ys) - m }, { x: Math.max(...xs) + m, y: Math.min(...ys) - m }, { x: Math.max(...xs) + m, y: Math.max(...ys) + m }, { x: Math.min(...xs) - m, y: Math.max(...ys) + m }];
        outline = `<Outline>${polygon(box)}<LineDescRef id="${dict.line(100_000)}"/></Outline>`;
      }
      const pinOne = pads.find((p) => p.name === '1')?.name ?? pads[0]?.name ?? '1';
      packages.set(name, `<Package name="${esc(name)}" type="OTHER" pinOne="${esc(pinOne)}" pinOneOrientation="OTHER">${outline}${pins.join('')}</Package>`);
    }
    const mount = pads.some((p) => p.layer === L.MULTI) ? 'THMT' : pads.length ? 'SMT' : 'OTHER';
    const bottom = c.layer === L.BOTTOM;
    comps.push(`<Component refDes="${esc(c.designator)}" packageRef="${esc(name)}" layerRef="${esc(lname(bottom ? doc.board.copperStack.at(-1)! : doc.board.copperStack[0]!))}" part="${esc(c.bag.get('SOURCELIBREFERENCE') ?? name)}" mountType="${mount}"><Xform rotation="${+((c.rotation % 360 + 360) % 360).toFixed(3)}"${bottom ? ' mirror="true"' : ''}/><Location ${at(c.at)}/></Component>`);
  });

  // ── Logical nets ──
  const netPins = new Map<number, string[]>();
  for (const p of doc.prims) {
    if (p.kind !== 'pad' || p.net === NO_NET || p.component === NO_NET) continue;
    const d = doc.components[p.component]?.designator;
    if (d) netPins.set(p.net, [...(netPins.get(p.net) ?? []), `<PinRef componentRef="${esc(d)}" pin="${esc(p.name)}"/>`]);
  }
  const nets = doc.nets.filter((x) => netPins.has(x.index)).map((x) => `<LogicalNet name="${esc(x.name)}">${netPins.get(x.index)!.join('')}</LogicalNet>`);

  // ── Layers and stackup ──
  const layerDefs = layers.map((l) => { const f = layerFunction(doc, l); return `<Layer name="${esc(lname(l))}" layerFunction="${f.fn}" side="${f.side}" polarity="POSITIVE"/>`; });
  if (hl.length) layerDefs.push(`<Layer name="${drillName}" layerFunction="DRILL" side="ALL" polarity="POSITIVE"><Span fromLayer="${esc(lname(doc.board.copperStack[0]!))}" toLayer="${esc(lname(doc.board.copperStack.at(-1)!))}"/></Layer>`);
  const rows = doc.board.bag ? readStack(doc.board.bag, doc.board.copperStack) : [];
  const thick = boardThickness(doc);
  let seq = 0;
  const stackLayers: string[] = [];
  const dielNames: string[] = [];
  for (const r of rows) {
    if (r.kind === 'signal' || r.kind === 'plane') {
      if (r.layer === null || !layers.includes(r.layer)) continue;
      stackLayers.push(`<StackupLayer layerOrGroupRef="${esc(lname(r.layer))}" thickness="${n6(r.copper)}" tolPlus="0" tolMinus="0" sequence="${++seq}"/>`);
    } else if (r.kind === 'dielectric' || r.kind === 'solder') {
      const nm = `${r.kind === 'solder' ? r.name : `Dielectric ${dielNames.length + 1}`}`;
      if (r.kind === 'dielectric') {
        dielNames.push(`<Layer name="${esc(nm)}" layerFunction="${r.dielType === 1 ? 'DIELCORE' : 'DIELPREG'}" side="INTERNAL" polarity="POSITIVE"/>`);
        stackLayers.push(`<StackupLayer layerOrGroupRef="${esc(nm)}" thickness="${n6(r.height)}" tolPlus="0" tolMinus="0" sequence="${++seq}"/>`);
      }
    }
  }

  // ── BOM ──
  const groups = new Map<string, { comment: string; pkg: string; refs: string[]; pins: number; layer: string }>();
  doc.components.forEach((c, ci) => {
    const comment = (doc.prims.find((p) => p.kind === 'text' && p.component === ci && p.isComment) as { text?: string } | undefined)?.text ?? c.pattern;
    const k = `${comment}|${c.pattern}`;
    const g = groups.get(k) ?? { comment, pkg: c.pattern || `PKG_${c.designator}`, refs: [], pins: doc.prims.filter((p) => p.kind === 'pad' && p.component === ci).length, layer: c.layer === L.BOTTOM ? 'BOTTOM' : 'TOP' };
    g.refs.push(c.designator);
    groups.set(k, g);
  });
  const bom = [...groups.values()].map((g) => `<BomItem OEMDesignNumberRef="${esc(g.comment)}" quantity="${g.refs.length}" pinCount="${g.pins}" category="ELECTRICAL">${g.refs.map((r) => `<RefDes name="${esc(r)}" packageRef="${esc(g.pkg)}" populate="true" layerRef="${esc(lname(g.layer === 'BOTTOM' ? doc.board.copperStack.at(-1)! : doc.board.copperStack[0]!))}"/>`).join('')}<Characteristics category="ELECTRICAL"/></BomItem>`);

  // ── Profile ──
  const cutouts = doc.prims.filter((p) => p.kind === 'region' && p.boardCutout).map((p) => (p.kind === 'region' ? p.outline : []));
  const profile = doc.board.outline.length >= 3 ? `<Profile>${polygon(ccw(doc.board.outline), origin)}${cutouts.filter((c) => c.length >= 3).map((c) => `<Cutout>${polygon(cw(c), origin).replace(/^<Polygon>|<\/Polygon>$/g, '')}</Cutout>`).join('')}</Profile>` : '';

  // ── Content ──
  const std = [...dict.shapes.values()].filter((e) => !e.user).map((e) => `<EntryStandard id="${e.id}">${e.xml}</EntryStandard>`);
  const user = [...dict.shapes.values()].filter((e) => e.user).map((e) => `<EntryUser id="${e.id}">${e.xml}</EntryUser>`);
  const lines = [...dict.lines].map(([w, id]) => `<EntryLineDesc id="${id}"><LineDesc lineEnd="ROUND" lineWidth="${w}"/></EntryLineDesc>`);
  const mode = o.mode ?? 'FULL';
  const allLayerNames = [...layers.map(lname), ...(hl.length ? [drillName] : [])];
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<IPC-2581 revision="B" xmlns="http://webstds.ipc.org/2581" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `<Content roleRef="Owner"><FunctionMode mode="${mode}"/><StepRef name="${esc(base)}"/>${allLayerNames.map((x) => `<LayerRef name="${esc(x)}"/>`).join('')}<BomRef name="${esc(base)}_BOM"/>`,
    `<DictionaryStandard units="MILLIMETER">${std.join('')}</DictionaryStandard>`,
    `<DictionaryUser units="MILLIMETER">${user.join('')}</DictionaryUser>`,
    `<DictionaryLineDesc units="MILLIMETER">${lines.join('')}</DictionaryLineDesc>`,
    '</Content>',
    '<LogisticHeader><Role id="Owner" roleFunction="SENDER"/><Enterprise id="Konium" code="NONE"/><Person name="Konium Designer" enterpriseRef="Konium" roleRef="Owner"/></LogisticHeader>',
    `<HistoryRecord number="1" origination="${iso}" software="Konium Designer" lastChange="${iso}"><FileRevision fileRevisionId="1" comment="" label=""><SoftwarePackage name="Konium Designer" revision="${APP_VERSION}" vendor="Konium"><Certification certificationStatus="SELFTEST"/></SoftwarePackage></FileRevision></HistoryRecord>`,
    `<Bom name="${esc(base)}_BOM"><BomHeader assembly="${esc(base)}" revision="1"><StepRef name="${esc(base)}"/></BomHeader>${bom.join('')}</Bom>`,
    `<Ecad name="${esc(base)}"><CadHeader units="MILLIMETER"/><CadData>`,
    ...layerDefs, ...dielNames,
    `<Stackup name="Primary" overallThickness="${+thick.toFixed(4)}" tolPlus="0" tolMinus="0" whereMeasured="METAL"><StackupGroup name="Primary" thickness="${+thick.toFixed(4)}" tolPlus="0" tolMinus="0">${stackLayers.join('')}</StackupGroup></Stackup>`,
    `<Step name="${esc(base)}"><Datum x="0" y="0"/>${profile}`,
    ...packages.values(), ...comps, ...nets, ...layerXml,
    '</Step></CadData></Ecad>',
    '</IPC-2581>', '',
  ];
  return xml.join('\n');
}

