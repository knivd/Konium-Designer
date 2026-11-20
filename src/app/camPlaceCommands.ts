/**
 * The CAM editor's Place menu (CAMtastic): Flash, Text, Line, Polyline, Rectangle, Ellipse, Polygon,
 * Polygon Void, the five arcs and five circles, the four dimensions and their Settings, and the drills —
 * Drill Point, Slot (G85), Circle (G84), Text (M97 / M98), routed circles (G32 / G33), Modify Drill(s),
 * Build Drill Layer (PTH) and Add Drill to Rout Plunge Point. Objects go on the current layer with its
 * current D-code (Tab while placing picks another), drills on the drill layer with its current tool.
 */
import type { Command, Scope } from '../core/commands';
import type { Vec2 } from '../core/geom';
import { mil } from '../core/units';
import type { CamEditor } from '../editors/cam/CamEditor';
import { arcPath, routePoints } from '../editors/cam/CamEditor';
import { PickTool, PointsTool, PREVIEW, previewPath, previewSegments, type PointsSpec } from '../editors/cam/camTools';
import { arcTangent, circle3, circleTangentTangent } from '../formats/cam/camOps';
import { drillTextHits, findOrAddAperture, findOrAddTool, liveObjects, textDraws, type DimKind } from '../formats/cam/camModel';
import { sortLayers } from '../formats/cam/camDoc';
import type { DrillLayer, GerberObject } from '../formats/gerber/gerberRead';
import { strokeTextWidth } from '../formats/gerber/stroke';
import { activeCam, addHits, addObjects, ask, camEdited, currentAperture, currentTool, drillLayer, emptyLayer, fmtLen, freshLayerName, gerberLayer } from './camCommon';
import { notify, units } from './state';

const CAM: Scope[] = ['cam'];
const id = (n: string) => `ad:CAMTASTIC:${n}`;
type Arc = Extract<GerberObject, { kind: 'arc' }>;

/** Dimension settings (Place › Settings): text height, arrow size, decimals, the gap before extension lines [est: CAMtastic's defaults]. */
export const dimSettings = { textHeight: mil(60), arrow: mil(40), decimals: 3, gap: mil(20), units: 'auto' as 'auto' | 'mil' | 'mm' | 'in' };

/** The aperture width preview segments get for the current layer. */
function apWidth(ed: CamEditor): number {
  const l = ed.layer;
  if (l?.data.kind !== 'gerber') return 0;
  const a = l.data.apertures.get(ed.currentAp.get(l) ?? -1);
  return a ? Math.min(a.w, a.h) || a.w : 0;
}

/** Tab while placing: the D-code to place with (its shape and size). */
function pickAperture(ed: CamEditor): boolean {
  const t = gerberLayer(ed);
  if (!t) return true;
  const { l, g } = t;
  const cur = currentAperture(ed, l, g);
  const codes = [...g.apertures.keys()].sort((a, b) => a - b).map((c) => `D${c}`);
  ask('Aperture', [
    { key: 'code', label: 'D-Code', kind: 'select', value: `D${cur}`, options: [...codes, 'New...'] },
    { key: 'shape', label: 'New aperture shape', kind: 'select', value: 'Round', options: ['Round', 'Rectangular', 'Obround'] },
    { key: 'w', label: 'New aperture width', kind: 'length', value: mil(10), min: 1 },
    { key: 'h', label: 'New aperture height', kind: 'length', value: mil(10), min: 1 },
  ], (v) => {
    if (v.code !== 'New...') { ed.currentAp.set(l, Number(String(v.code).slice(1))); return; }
    const shape = v.shape === 'Rectangular' ? 'R' : v.shape === 'Obround' ? 'O' : 'C';
    ed.edit('Add Aperture', [l], () => { ed.currentAp.set(l, findOrAddAperture(g, shape, v.w as number, shape === 'C' ? (v.w as number) : (v.h as number))); });
  });
  return true;
}

/** A placing tool on the current Gerber layer (Tab picks the D-code). */
function placer(ed: CamEditor, spec: Omit<PointsSpec, 'key'> & { key?: PointsSpec['key'] }): void {
  if (!gerberLayer(ed)) return;
  ed.setTool(new PointsTool(ed, { repeat: true, ...spec, key: (k, pts) => (k === 'Tab' ? pickAperture(ed) : spec.key?.(k, pts) ?? false) }));
}

const seg = (a: Vec2, b: Vec2, w = 0, color = PREVIEW) => ({ a, b, width: w, color });
const circlePts = (c: Vec2, r: number) => arcPath({ x: c.x + r, y: c.y }, { x: c.x + r, y: c.y }, c, false);
const fullCircle = (c: Vec2, r: number, ap: number, dark: boolean): Arc => ({ kind: 'arc', a: { x: c.x + r, y: c.y }, b: { x: c.x + r, y: c.y }, c, cw: false, ap, dark });

/** Ellipse inside a box as a closed polyline of draws (Gerber has no ellipses). */
function ellipsePts(a: Vec2, b: Vec2, n = 48): Vec2[] {
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
  return Array.from({ length: n }, (_, k) => ({ x: c.x + rx * Math.cos((2 * Math.PI * k) / n), y: c.y + ry * Math.sin((2 * Math.PI * k) / n) }));
}
const closedDraws = (pts: Vec2[], ap: number, dark: boolean): GerberObject[] => pts.map((p, k) => ({ kind: 'draw' as const, a: p, b: pts[(k + 1) % pts.length]!, ap, dark }));
const openDraws = (pts: Vec2[], ap: number, dark: boolean): GerberObject[] => pts.slice(1).map((p, k) => ({ kind: 'draw' as const, a: pts[k]!, b: p, ap, dark }));

/** A line object picked (for the tangent arcs and circles): its ends. */
function lineOf(ed: CamEditor, key: string | undefined): [Vec2, Vec2] | null {
  const p = key ? ed.selectedObjects([key])[0] : undefined;
  if (!p || p.layer.data.kind !== 'gerber') return null;
  const o = p.layer.data.objects[p.i]!;
  return o.kind === 'draw' ? [o.a, o.b] : null;
}

/** Tangent, Tangent, Radius: pick two lines, then the radius; `full` makes a circle, else the arc between the tangent points. */
function tangentTangent(ed: CamEditor, full: boolean): void {
  if (!gerberLayer(ed)) return;
  let first: { line: [Vec2, Vec2]; at: Vec2 } | null = null;
  ed.setTool(new PickTool(ed, full ? 'cam-circle-ttr' : 'cam-arc-ttr', `${full ? 'Circle' : 'Arc'} Tangent, Tangent, Radius: click the first line, then the second (near the corner the ${full ? 'circle' : 'arc'} goes in)`, (hit, _at, raw) => {
    const line = lineOf(ed, hit?.key);
    if (!line) { notify('Click a line'); return; }
    if (!first) { first = { line, at: raw }; return; }
    const l1 = first.line, l2 = line;
    // The corner between the two clicks
    const hint = { x: (first.at.x + raw.x) / 2, y: (first.at.y + raw.y) / 2 };
    first = null;
    ask(full ? 'Circle Radius' : 'Arc Radius', [{ key: 'r', label: 'Radius', kind: 'length', value: mil(50), min: 1 }], (v) => {
      const k = circleTangentTangent(l1, l2, v.r as number, hint);
      if (!k) return 'The lines are parallel';
      addObjects(ed, full ? 'Place Circle' : 'Place Arc', (ap, dark) => {
        if (full) return [fullCircle(k.c, v.r as number, ap, dark)];
        const cw = (k.t1.x - k.c.x) * (k.t2.y - k.c.y) - (k.t1.y - k.c.y) * (k.t2.x - k.c.x) < 0;
        return [{ kind: 'arc', a: k.t1, b: k.t2, c: k.c, cw, ap, dark }];
      });
    });
  }));
}

/** The text a dimension shows for a length. */
function dimText(v: number): string {
  const u = dimSettings.units === 'auto' ? units.value : dimSettings.units;
  const n = u === 'mm' ? v / 393700.787 : u === 'in' ? v / 1e7 : v / 1e4;
  return `${n.toFixed(dimSettings.decimals)}${u === 'in' ? '"' : u}`;
}

/** A dimension's draws: extension lines, the dimension line with arrows, and its text. */
function dimensionDraws(kind: DimKind, a: Vec2, b: Vec2, at: Vec2, ap: number, dark: boolean, grp: number): { objs: GerberObject[]; text: string } {
  const s = dimSettings, out: GerberObject[] = [];
  const line = (p: Vec2, q: Vec2) => out.push({ kind: 'draw', a: p, b: q, ap, dark, grp });
  const arrowHead = (tip: Vec2, dir: Vec2) => {
    const l = Math.hypot(dir.x, dir.y) || 1, u = { x: dir.x / l, y: dir.y / l }, n = { x: -u.y, y: u.x };
    line(tip, { x: tip.x - u.x * s.arrow + n.x * s.arrow * 0.35, y: tip.y - u.y * s.arrow + n.y * s.arrow * 0.35 });
    line(tip, { x: tip.x - u.x * s.arrow - n.x * s.arrow * 0.35, y: tip.y - u.y * s.arrow - n.y * s.arrow * 0.35 });
  };
  let text = '';
  if (kind === 'horizontal' || kind === 'vertical') {
    const h = kind === 'horizontal';
    const p1 = h ? { x: a.x, y: at.y } : { x: at.x, y: a.y }, p2 = h ? { x: b.x, y: at.y } : { x: at.x, y: b.y };
    const sign = (q: number, r: number) => (q >= r ? 1 : -1);
    // Extension lines from a gap off the points to a little past the dimension line
    for (const [pt, d] of [[a, p1], [b, p2]] as const) {
      const dir = h ? sign(d.y, pt.y) : sign(d.x, pt.x);
      const from = h ? { x: pt.x, y: pt.y + dir * s.gap } : { x: pt.x + dir * s.gap, y: pt.y };
      const to = h ? { x: d.x, y: d.y + dir * s.gap } : { x: d.x + dir * s.gap, y: d.y };
      if (Math.hypot(to.x - from.x, to.y - from.y) > s.gap) line(from, to);
    }
    line(p1, p2);
    arrowHead(p1, { x: p1.x - p2.x, y: p1.y - p2.y });
    arrowHead(p2, { x: p2.x - p1.x, y: p2.y - p1.y });
    text = dimText(Math.abs(h ? b.x - a.x : b.y - a.y));
    const w = strokeTextWidth(text, s.textHeight);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const pos = h ? { x: mid.x - w / 2, y: mid.y + s.gap } : { x: mid.x - s.gap, y: mid.y - w / 2 };
    out.push(...textDraws(text, pos, s.textHeight, h ? 0 : 90, false, ap, dark, grp));
  } else if (kind === 'radius') {
    // a: the centre, b: a point on the circle, at: where the text goes
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    const ang = Math.atan2(at.y - a.y, at.x - a.x), tip = { x: a.x + r * Math.cos(ang), y: a.y + r * Math.sin(ang) };
    line(tip, at);
    arrowHead(tip, { x: tip.x - at.x, y: tip.y - at.y });
    text = `R${dimText(r)}`;
    out.push(...textDraws(text, { x: at.x + (at.x >= tip.x ? s.gap : -s.gap - strokeTextWidth(text, s.textHeight)), y: at.y - s.textHeight / 2 }, s.textHeight, 0, false, ap, dark, grp));
  } else {
    // Ordinate: a is the datum, b the point; the label shows the offset along the axis the leader runs on
    const horiz = Math.abs(at.x - b.x) >= Math.abs(at.y - b.y);
    const v = horiz ? b.y - a.y : b.x - a.x;
    line(b, at);
    text = dimText(v).replace(/^(\d)/, '$1');
    out.push(...textDraws(text, horiz ? { x: at.x + s.gap, y: at.y - s.textHeight / 2 } : { x: at.x - strokeTextWidth(text, s.textHeight) / 2, y: at.y + s.gap }, s.textHeight, 0, false, ap, dark, grp));
  }
  return { objs: out, text };
}

/** The drill hits of the current drill layer that are selected (or, with none selected, none). */
function selectedHits(ed: CamEditor): { l: import('../formats/cam/camDoc').CamLayer; d: DrillLayer; i: number[] } | null {
  const sel = ed.selectedObjects().filter((s) => s.layer.data.kind === 'drill');
  if (!sel.length) return null;
  const l = sel[0]!.layer;
  return { l, d: l.data as DrillLayer, i: sel.filter((s) => s.layer === l).map((s) => s.i) };
}

export function camPlaceCommands(): Command[] {
  const on = () => !!activeCam();
  const withCam = (f: (ed: CamEditor) => void) => () => { const e = activeCam(); if (e) f(e); };
  const W = (ed: CamEditor) => apWidth(ed);
  const cmd = (name: string, label: string, run: (ed: CamEditor) => void): Command => ({ id: id(name), label, scopes: CAM, enabled: on, run: withCam(run) });
  return [
    cmd('DrawFlash', 'Flash', (ed) => placer(ed, {
      id: 'cam-flash', count: 1, hint: () => 'Place Flash: click to place a flash of the current D-code (Tab picks the D-code; right-click to finish)',
      preview: (_p, c) => { const l = ed.layer; if (l?.data.kind !== 'gerber') return null; const g = l.data; return { segments: previewSegments({ kind: 'flash', at: c, ap: currentAperture(ed, l, g), dark: true }, g) }; },
      done: ([p]) => { addObjects(ed, 'Place Flash', (ap, dark) => [{ kind: 'flash', at: p!, ap, dark }]); },
    })),
    cmd('DrawLine', 'Line', (ed) => placer(ed, {
      id: 'cam-line', count: 2, hint: (n) => (n ? 'Place Line: click the end' : 'Place Line: click the start (Tab picks the D-code)'),
      preview: (pts, c) => (pts.length ? { segments: [seg(pts[0]!, c, W(ed))] } : null),
      done: ([a, b]) => { addObjects(ed, 'Place Line', (ap, dark) => [{ kind: 'draw', a: a!, b: b!, ap, dark }]); },
    })),
    cmd('DrawPolyline', 'Polyline', (ed) => placer(ed, {
      id: 'cam-polyline', count: 'many', min: 2, hint: (n) => (n ? 'Place Polyline: click the next corner (right-click or Enter finishes; Backspace takes the last back)' : 'Place Polyline: click the start'),
      preview: (pts, c) => (pts.length ? { segments: previewPath([...pts, c], W(ed)) } : null),
      done: (pts) => { addObjects(ed, 'Place Polyline', (ap, dark) => openDraws(pts, ap, dark), { kind: 'polyline' }); },
    })),
    cmd('DrawRect', 'Rectangle', (ed) => placer(ed, {
      id: 'cam-rect', count: 2, hint: (n) => (n ? 'Place Rectangle: click the opposite corner' : 'Place Rectangle: click a corner'),
      preview: (pts, c) => (pts.length ? { segments: previewPath([pts[0]!, { x: c.x, y: pts[0]!.y }, c, { x: pts[0]!.x, y: c.y }], W(ed), PREVIEW, true) } : null),
      done: ([a, b]) => { addObjects(ed, 'Place Rectangle', (ap, dark) => closedDraws([a!, { x: b!.x, y: a!.y }, b!, { x: a!.x, y: b!.y }], ap, dark), { kind: 'polyline', closed: true }); },
    })),
    cmd('DrawEllipse', 'Ellipse', (ed) => placer(ed, {
      id: 'cam-ellipse', count: 2, hint: (n) => (n ? 'Place Ellipse: click the opposite corner of its box' : 'Place Ellipse: click a corner of the box it fills'),
      preview: (pts, c) => (pts.length ? { segments: previewPath(ellipsePts(pts[0]!, c), W(ed), PREVIEW, true) } : null),
      done: ([a, b]) => { addObjects(ed, 'Place Ellipse', (ap, dark) => closedDraws(ellipsePts(a!, b!), ap, dark), { kind: 'polyline', closed: true }); },
    })),
    cmd('DrawPolygon', 'Polygon', (ed) => placer(ed, {
      id: 'cam-polygon', count: 'many', min: 3, hint: (n) => (n ? 'Place Polygon: click the next corner (right-click or Enter closes it)' : 'Place Polygon: click the first corner'),
      preview: (pts, c) => (pts.length ? { segments: previewPath([...pts, c], 0, PREVIEW, true), polys: pts.length >= 2 ? [{ outline: [...pts, c], holes: [], color: PREVIEW, alpha: 0.25 }] : [] } : null),
      done: (pts) => { addObjects(ed, 'Place Polygon', (_ap, dark) => [{ kind: 'region', contours: [pts], dark }]); },
    })),
    cmd('DrawVoid', 'Polygon Void', (ed) => placer(ed, {
      id: 'cam-void', count: 'many', min: 3, hint: (n) => (n ? 'Place Polygon Void: click the next corner (right-click or Enter closes it)' : 'Place Polygon Void: click the first corner of the area to clear'),
      preview: (pts, c) => (pts.length ? { segments: previewPath([...pts, c], 0, 0x80c0ff, true) } : null),
      done: (pts) => { addObjects(ed, 'Place Polygon Void', () => [{ kind: 'region', contours: [pts], dark: false }]); },
    })),
    // Arcs
    cmd('DrawArcCsa', 'Centre, Start, Sweep Angle', (ed) => placer(ed, {
      id: 'cam-arc-csa', count: 2, hint: (n) => (n ? 'Place Arc: click its start (the radius)' : 'Place Arc (Centre, Start, Sweep Angle): click the centre'),
      preview: (pts, c) => (pts.length ? { segments: previewPath(circlePts(pts[0]!, Math.hypot(c.x - pts[0]!.x, c.y - pts[0]!.y)), 0, 0x808080) } : null),
      done: ([c, a]) => {
        ask('Sweep Angle', [{ key: 'deg', label: 'Sweep angle (degrees, counter-clockwise; negative: clockwise)', kind: 'number', value: 90 }], (v) => {
          const sw = v.deg as number, r = Math.hypot(a!.x - c!.x, a!.y - c!.y), s = Math.atan2(a!.y - c!.y, a!.x - c!.x), e = s + (sw * Math.PI) / 180;
          if (!r || !sw) return 'An arc needs a radius and an angle';
          const b = { x: c!.x + r * Math.cos(e), y: c!.y + r * Math.sin(e) };
          addObjects(ed, 'Place Arc', (ap, dark) => [{ kind: 'arc', a: a!, b: Math.abs(sw) >= 360 ? a! : b, c: c!, cw: sw < 0, ap, dark }]);
        });
      },
    })),
    cmd('DrawArcCsed', 'Centre, Start, End', (ed) => placer(ed, {
      id: 'cam-arc-cse', count: 3, hint: (n) => (n === 2 ? 'Place Arc: click its end (counter-clockwise from the start)' : n ? 'Place Arc: click its start' : 'Place Arc (Centre, Start, End): click the centre'),
      preview: (pts, c) => {
        if (!pts.length) return null;
        if (pts.length === 1) return { segments: previewPath(circlePts(pts[0]!, Math.hypot(c.x - pts[0]!.x, c.y - pts[0]!.y)), 0, 0x808080) };
        const r = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y), t = Math.atan2(c.y - pts[0]!.y, c.x - pts[0]!.x);
        return { segments: previewPath(arcPath(pts[1]!, { x: pts[0]!.x + r * Math.cos(t), y: pts[0]!.y + r * Math.sin(t) }, pts[0]!, false), W(ed)) };
      },
      done: ([c, a, e]) => {
        const r = Math.hypot(a!.x - c!.x, a!.y - c!.y), t = Math.atan2(e!.y - c!.y, e!.x - c!.x);
        addObjects(ed, 'Place Arc', (ap, dark) => [{ kind: 'arc', a: a!, b: { x: c!.x + r * Math.cos(t), y: c!.y + r * Math.sin(t) }, c: c!, cw: false, ap, dark }]);
      },
    })),
    cmd('DrawArc2pt', '2-Points', (ed) => placer(ed, {
      id: 'cam-arc-2p', count: 2, hint: (n) => (n ? 'Place Arc: click its end (a half circle, counter-clockwise)' : 'Place Arc (2-Points): click its start'),
      preview: (pts, c) => (pts.length ? { segments: previewPath(arcPath(pts[0]!, c, { x: (pts[0]!.x + c.x) / 2, y: (pts[0]!.y + c.y) / 2 }, false), W(ed)) } : null),
      done: ([a, b]) => { addObjects(ed, 'Place Arc', (ap, dark) => [{ kind: 'arc', a: a!, b: b!, c: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }, cw: false, ap, dark }]); },
    })),
    cmd('DrawArc', '3-Points ( Start, End, Tangent )', (ed) => placer(ed, {
      id: 'cam-arc-3p', count: 3, hint: (n) => (n === 2 ? 'Place Arc: click a point on its tangent at the start' : n ? 'Place Arc: click its end' : 'Place Arc (Start, End, Tangent): click its start'),
      preview: (pts, c) => {
        if (pts.length < 2) return pts.length ? { segments: [seg(pts[0]!, c, 0, 0x808080)] } : null;
        const k = arcTangent(pts[0]!, pts[1]!, c);
        return { segments: [seg(pts[0]!, c, 0, 0x808080), ...(k ? previewPath(arcPath(pts[0]!, pts[1]!, k.c, k.cw), W(ed)) : [])] };
      },
      done: ([a, b, t]) => {
        const k = arcTangent(a!, b!, t!);
        if (!k) { notify('The tangent points along the chord: no arc'); return; }
        addObjects(ed, 'Place Arc', (ap, dark) => [{ kind: 'arc', a: a!, b: b!, c: k.c, cw: k.cw, ap, dark }]);
      },
    })),
    cmd('DrawArcTtr', 'Tangent, Tangent, Radius', (ed) => tangentTangent(ed, false)),
    // Circles
    cmd('DrawCircleCenRad', 'Centre,Tangent Point', (ed) => placer(ed, {
      id: 'cam-circle-ct', count: 2, hint: (n) => (n ? 'Place Circle: click a point on it' : 'Place Circle (Centre, Tangent Point): click the centre'),
      preview: (pts, c) => (pts.length ? { segments: previewPath(circlePts(pts[0]!, Math.hypot(c.x - pts[0]!.x, c.y - pts[0]!.y)), W(ed)) } : null),
      done: ([c, p]) => { const r = Math.hypot(p!.x - c!.x, p!.y - c!.y); if (r) addObjects(ed, 'Place Circle', (ap, dark) => [fullCircle(c!, r, ap, dark)]); },
    })),
    cmd('DrawCircleCenRad2', 'Centre, Radius', (ed) => placer(ed, {
      id: 'cam-circle-cr', count: 1, hint: () => 'Place Circle (Centre, Radius): click the centre, then give the radius',
      done: ([c]) => { ask('Circle Radius', [{ key: 'r', label: 'Radius', kind: 'length', value: mil(50), min: 1 }], (v) => { addObjects(ed, 'Place Circle', (ap, dark) => [fullCircle(c!, v.r as number, ap, dark)]); }); },
    })),
    cmd('DrawCircleTtr', 'Tangent,Tangent,Radius', (ed) => tangentTangent(ed, true)),
    cmd('DrawCircle2P', '2-Points', (ed) => placer(ed, {
      id: 'cam-circle-2p', count: 2, hint: (n) => (n ? 'Place Circle: click the other end of its diameter' : 'Place Circle (2-Points): click one end of its diameter'),
      preview: (pts, c) => (pts.length ? { segments: previewPath(circlePts({ x: (pts[0]!.x + c.x) / 2, y: (pts[0]!.y + c.y) / 2 }, Math.hypot(c.x - pts[0]!.x, c.y - pts[0]!.y) / 2), W(ed)) } : null),
      done: ([a, b]) => { const r = Math.hypot(b!.x - a!.x, b!.y - a!.y) / 2; if (r) addObjects(ed, 'Place Circle', (ap, dark) => [fullCircle({ x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }, r, ap, dark)]); },
    })),
    cmd('DrawCircle3P', '3-Points', (ed) => placer(ed, {
      id: 'cam-circle-3p', count: 3, hint: (n) => `Place Circle (3-Points): click point ${n + 1} of 3 on it`,
      preview: (pts, c) => { if (pts.length < 2) return pts.length ? { segments: [seg(pts[0]!, c, 0, 0x808080)] } : null; const k = circle3(pts[0]!, pts[1]!, c); return k ? { segments: previewPath(circlePts(k.c, k.r), W(ed)) } : null; },
      done: ([a, b, c]) => { const k = circle3(a!, b!, c!); if (!k) { notify('The points are in a line: no circle'); return; } addObjects(ed, 'Place Circle', (ap, dark) => [fullCircle(k.c, k.r, ap, dark)]); },
    })),
    // Text
    cmd('DrawText', 'Text', (ed) => placer(ed, {
      id: 'cam-text', count: 1, hint: () => 'Place Text: click where the text starts (its bottom left), then type it',
      done: ([p]) => {
        ask('Text', [
          { key: 'text', label: 'Text', kind: 'text', value: 'TEXT' },
          { key: 'h', label: 'Height', kind: 'length', value: mil(60), min: 1 },
          { key: 'rot', label: 'Rotation (degrees)', kind: 'number', value: 0 },
          { key: 'mirror', label: 'Mirrored', kind: 'bool', value: false },
        ], (v) => {
          const text = String(v.text);
          if (!text.trim()) return 'Type the text';
          const g = { kind: 'text' as const, text, at: p!, height: v.h as number, rot: v.rot as number, mirror: !!v.mirror, ap: 0 };
          addObjects(ed, 'Place Text', (ap, dark, grp) => { g.ap = ap; return textDraws(text, p!, g.height, g.rot, g.mirror, ap, dark, grp!); }, g);
        });
      },
    })),
    // Dimensions
    ...(['horizontal', 'vertical'] as const).map((k) => cmd(k === 'horizontal' ? 'DrawDimHorz' : 'DrawDimVert', k === 'horizontal' ? 'Horizontal' : 'Vertical', (ed) => placer(ed, {
      id: `cam-dim-${k}`, count: 3, hint: (n) => (n === 2 ? 'Place Dimension: click where the dimension line goes' : n ? 'Place Dimension: click the second point' : `Place Dimension (${k}): click the first point`),
      preview: (pts, c) => {
        if (pts.length < 2) return pts.length ? { segments: [seg(pts[0]!, c, 0, 0x808080)] } : null;
        const d = dimensionDraws(k, pts[0]!, pts[1]!, c, 0, true, 0);
        return { segments: d.objs.flatMap((o) => (o.kind === 'draw' ? [seg(o.a, o.b)] : [])) };
      },
      done: ([a, b, at]) => { const t = dimensionDraws(k, a!, b!, at!, 0, true, 0).text; addObjects(ed, 'Place Dimension', (ap, dark, grp) => dimensionDraws(k, a!, b!, at!, ap, dark, grp!).objs, { kind: 'dimension', dim: k, text: t }); },
    }))),
    cmd('DrawDimRad', 'Radius', (ed) => {
      if (!gerberLayer(ed)) return;
      let arc: Arc | null = null;
      ed.setTool(new PickTool(ed, 'cam-dim-radius', 'Place Dimension (Radius): click an arc or circle, then where the text goes', (hit, at) => {
        if (!arc) {
          const p = hit ? ed.selectedObjects([hit.key])[0] : undefined;
          const o = p && p.layer.data.kind === 'gerber' ? p.layer.data.objects[p.i] : undefined;
          if (o?.kind !== 'arc') { notify('Click an arc or circle'); return; }
          arc = o;
          return;
        }
        const a = arc;
        arc = null;
        const t = dimensionDraws('radius', a.c, a.a, at, 0, true, 0).text;
        addObjects(ed, 'Place Dimension', (ap, dark, grp) => dimensionDraws('radius', a.c, a.a, at, ap, dark, grp!).objs, { kind: 'dimension', dim: 'radius', text: t });
      }));
    }),
    cmd('DrawDimDatum', 'Ordinate', (ed) => {
      if (!gerberLayer(ed)) return;
      let datum: Vec2 | null = null, point: Vec2 | null = null;
      ed.setTool(new PointsTool(ed, {
        id: 'cam-dim-ordinate', count: 1, repeat: true,
        hint: () => (!datum ? 'Place Dimension (Ordinate): click the datum (zero)' : !point ? 'Place Dimension: click a point to dimension' : 'Place Dimension: click where its label goes (along X for its Y, along Y for its X)'),
        preview: (_p, c) => (point ? { segments: [seg(point, c)] } : datum ? { segments: [seg({ x: datum.x - mil(30), y: datum.y }, { x: datum.x + mil(30), y: datum.y }, 0, 0x808080), seg({ x: datum.x, y: datum.y - mil(30) }, { x: datum.x, y: datum.y + mil(30) }, 0, 0x808080)] } : null),
        done: ([p]) => {
          if (!datum) { datum = p!; return; }
          if (!point) { point = p!; return; }
          const d0 = datum, b = point;
          point = null;
          const t = dimensionDraws('ordinate', d0, b, p!, 0, true, 0).text;
          addObjects(ed, 'Place Dimension', (ap, dark, grp) => dimensionDraws('ordinate', d0, b, p!, ap, dark, grp!).objs, { kind: 'dimension', dim: 'ordinate', text: t });
        },
      }));
    }),
    cmd('DrawDimSettings', 'Settings...', () => ask('Dimension Settings', [
      { key: 'h', label: 'Text height', kind: 'length', value: dimSettings.textHeight, min: 1 },
      { key: 'arrow', label: 'Arrow size', kind: 'length', value: dimSettings.arrow, min: 0 },
      { key: 'gap', label: 'Extension line gap', kind: 'length', value: dimSettings.gap, min: 0 },
      { key: 'dec', label: 'Decimal places', kind: 'number', value: dimSettings.decimals, min: 0, max: 6 },
      { key: 'units', label: 'Units', kind: 'select', value: dimSettings.units === 'auto' ? 'As shown' : dimSettings.units, options: ['As shown', 'mil', 'mm', 'in'] },
    ], (v) => { Object.assign(dimSettings, { textHeight: v.h, arrow: v.arrow, gap: v.gap, decimals: Math.round(v.dec as number), units: v.units === 'As shown' ? 'auto' : v.units }); })),
    // Drills
    cmd('DrillAdd', 'Drill Point', (ed) => ed.setTool(new PointsTool(ed, {
      id: 'cam-drill', count: 1, repeat: true, hint: () => 'Place Drill Point: click to drill a hole with the current tool (Tab picks the tool; right-click to finish)',
      key: (k) => (k === 'Tab' ? pickTool(ed) : false),
      preview: (_p, c) => { const { l, d } = drillLayer(ed); const r = (d.tools.get(currentTool(ed, l, d)) ?? 0) / 2; return { circles: [], segments: previewPath(circlePts(c, r)) }; },
      done: ([p]) => addHits(ed, 'Place Drill', (tool) => [{ tool, at: p! }]),
    }))),
    cmd('DrillSlot', 'Drill Slot (G85)', (ed) => ed.setTool(new PointsTool(ed, {
      id: 'cam-slot', count: 2, repeat: true, hint: (n) => (n ? 'Place Drill Slot: click its end' : 'Place Drill Slot (G85): click its start (Tab picks the tool)'),
      key: (k) => (k === 'Tab' ? pickTool(ed) : false),
      preview: (pts, c) => { if (!pts.length) return null; const { l, d } = drillLayer(ed); return { segments: [seg(pts[0]!, c, d.tools.get(currentTool(ed, l, d)) ?? 0)] }; },
      done: ([a, b]) => addHits(ed, 'Place Slot', (tool) => [{ tool, at: a!, slot: b! }]),
    }))),
    cmd('DrillCircle', 'Drill Circle (G84)', (ed) => ed.setTool(new PointsTool(ed, {
      id: 'cam-drill-circle', count: 2, repeat: true, hint: (n) => (n ? 'Place Drill Circle: click a point on the circle' : 'Place Drill Circle (G84): click its centre (Tab picks the tool)'),
      key: (k) => (k === 'Tab' ? pickTool(ed) : false),
      preview: (pts, c) => (pts.length ? { segments: previewPath(circlePts(pts[0]!, Math.hypot(c.x - pts[0]!.x, c.y - pts[0]!.y))) } : null),
      done: ([c, p]) => { const r = Math.hypot(p!.x - c!.x, p!.y - c!.y); if (r) addHits(ed, 'Place Drill Circle', (tool) => [{ tool, at: c!, circle: 2 * r }]); },
    }))),
    cmd('DrillHorText', 'Drill Text (M97,M98)', (ed) => ed.setTool(new PointsTool(ed, {
      id: 'cam-drill-text', count: 1, repeat: true, hint: () => 'Place Drill Text: click where it starts, then type it (Tab picks the tool)',
      key: (k) => (k === 'Tab' ? pickTool(ed) : false),
      done: ([p]) => ask('Drill Text', [
        { key: 'text', label: 'Text', kind: 'text', value: 'A' },
        { key: 'h', label: 'Height', kind: 'length', value: mil(100), min: 1 },
        { key: 'v', label: 'Vertical (M98)', kind: 'bool', value: false },
      ], (v) => {
        const text = String(v.text).toUpperCase();
        if (!text.trim()) return 'Type the text';
        addHits(ed, 'Place Drill Text', (t, dd) => drillTextHits(text, p!, v.h as number, !!v.v, t, dd.tools.get(t) ?? 0, 0), { kind: 'drilltext', text, at: p!, height: v.h as number, ...(v.v ? { vertical: true } : {}) });
      }),
    }))),
    ...(['G32', 'G33'] as const).map((g) => cmd(g === 'G32' ? 'ToolsMillG32' : 'ToolsMillG33', g === 'G32' ? 'Circle Clockwise (G32)' : 'Circle C-Clockwise (G33)', (ed) => ed.setTool(new PointsTool(ed, {
      id: `cam-${g}`, count: 2, repeat: true, hint: (n) => (n ? 'Routed Circle: click a point on it' : `Routed Circle (${g}): click its centre (Tab picks the tool)`),
      key: (k) => (k === 'Tab' ? pickTool(ed) : false),
      preview: (pts, c) => (pts.length ? { segments: previewPath(circlePts(pts[0]!, Math.hypot(c.x - pts[0]!.x, c.y - pts[0]!.y))) } : null),
      done: ([c, p]) => {
        const r = Math.hypot(p!.x - c!.x, p!.y - c!.y);
        if (!r) return;
        const { l, d, added } = drillLayer(ed);
        ed.edit('Place Routed Circle', added ? 'all' : [l], () => {
          if (added) { ed.doc.layers = sortLayers([...ed.doc.layers, l]); ed.doc.current = ed.doc.layers.indexOf(l); }
          d.routes.push({ tool: currentTool(ed, l, d), path: [{ x: c!.x + r, y: c!.y }], circle: { c: c!, r, cw: g === 'G32' } });
        });
        camEdited();
      },
    })))),
    cmd('DrillModify', 'Modify Drill(s)', (ed) => {
      const sel = selectedHits(ed);
      const { l, d } = sel ?? drillLayer(ed);
      if (!d.hits.length && !d.tools.size) { notify('No drills to modify'); return; }
      const tools = [...d.tools.keys()].sort((a, b) => a - b);
      const which = sel ? `${sel.i.length} selected hit${sel.i.length === 1 ? '' : 's'}` : 'all hits of the tool';
      ask('Modify Drill(s)', [
        { kind: 'note', text: `Changes ${which} on ${l.name}.` },
        ...(sel ? [] : [{ key: 'tool', label: 'Tool', kind: 'select' as const, value: `T${String(tools[0] ?? 1).padStart(2, '0')}`, options: tools.map((t) => `T${String(t).padStart(2, '0')}`) }]),
        { key: 'dia', label: 'New diameter', kind: 'length', value: d.tools.get(sel ? d.hits[sel.i[0]!]!.tool : (tools[0] ?? 1)) ?? mil(30), min: 1 },
      ], (v) => {
        ed.edit('Modify Drill(s)', [l], () => {
          const t = findOrAddTool(d, v.dia as number);
          const idx = sel ? sel.i : d.hits.map((h, i) => [h, i] as const).filter(([h]) => `T${String(h.tool).padStart(2, '0')}` === v.tool).map(([, i]) => i);
          for (const i of idx) d.hits[i] = { ...d.hits[i]!, tool: t };
          // A tool no hit or route uses any more goes
          for (const k of [...d.tools.keys()]) if (!d.hits.some((h) => h.tool === k) && !d.routes.some((r) => r.tool === k)) d.tools.delete(k);
        });
        camEdited();
      });
    }),
    cmd('ToolsDrillTemplate', 'Build Drill Layer ( PTH )', (ed) => {
      // Pads flashed at the same place on both outer copper layers are plated holes [est: CAMtastic's pad matching]
      const top = ed.doc.layers.find((l) => l.type === 'Top' && l.data.kind === 'gerber'), bot = ed.doc.layers.find((l) => l.type === 'Bottom' && l.data.kind === 'gerber');
      const src = [top, bot].filter((x): x is NonNullable<typeof x> => !!x);
      if (!src.length) { notify('Build Drill Layer needs a Top or Bottom copper layer', 'error'); return; }
      ask('Build Drill Layer (PTH)', [
        { kind: 'note', text: src.length === 2 ? 'A hole at each pad flashed on both Top and Bottom copper.' : `A hole at each pad flashed on ${src[0]!.name}.` },
        { key: 'mode', label: 'Hole size', kind: 'select', value: 'Percentage of the pad', options: ['Percentage of the pad', 'Fixed'] },
        { key: 'pct', label: 'Percentage', kind: 'number', value: 50, min: 1, max: 100 },
        { key: 'dia', label: 'Fixed diameter', kind: 'length', value: mil(32), min: 1 },
        { key: 'min', label: 'Smallest pad', kind: 'length', value: mil(20), min: 0 },
      ], (v) => {
        const flashes = (l: typeof top) => (l ? liveObjects(l).filter(({ o }) => o.kind === 'flash' && o.dark) as { o: Extract<GerberObject, { kind: 'flash' }>; i: number }[] : []);
        const a = flashes(src[0]!), b = src[1] ? flashes(src[1]) : null;
        const key = (p: Vec2) => `${Math.round(p.x / 2000)},${Math.round(p.y / 2000)}`;
        const onB = b ? new Set(b.map(({ o }) => key(o.at))) : null;
        const g = src[0]!.data as import('../formats/gerber/gerberRead').GerberLayer;
        const pads = a.filter(({ o }) => (!onB || onB.has(key(o.at))) && Math.min(g.apertures.get(o.ap)?.w ?? 0, g.apertures.get(o.ap)?.h ?? 0) >= (v.min as number));
        if (!pads.length) return 'No pads found';
        const l = emptyLayer(freshLayerName(ed.doc, 'PTH.TXT'), 'Drill Top', true);
        const d = l.data as DrillLayer;
        d.plated = true;
        ed.edit('Build Drill Layer', 'all', () => {
          for (const { o } of pads) {
            const ap = g.apertures.get(o.ap)!;
            const dia = v.mode === 'Fixed' ? (v.dia as number) : Math.round((Math.min(ap.w, ap.h) * (v.pct as number)) / 100 / 1000) * 1000;
            d.hits.push({ tool: findOrAddTool(d, dia), at: o.at });
          }
          ed.doc.layers = sortLayers([...ed.doc.layers, l]);
          ed.doc.current = ed.doc.layers.indexOf(l);
        });
        camEdited();
        notify(`${pads.length} holes on ${l.name}`);
      });
    }),
    cmd('DrillAndPlunge', 'Add Drill to Rout Plunge Point', (ed) => {
      const routes = ed.selectedRoutes();
      const all = routes.length ? routes : ed.doc.layers.flatMap((l, li) => (l.data.kind === 'drill' ? l.data.routes.map((_, k) => ({ layer: l, li, k })) : []));
      if (!all.length) { notify('No rout paths'); return; }
      const layers = [...new Set(all.map((r) => r.layer))];
      ed.edit('Add Drill to Rout Plunge Point', layers, () => {
        for (const { layer, k } of all) { const d = layer.data as DrillLayer, r = d.routes[k]!; d.hits.push({ tool: r.tool, at: routePoints(r)[0]! }); }
      });
      camEdited();
      notify(`${all.length} plunge hole${all.length === 1 ? '' : 's'} added`);
    }),
  ];
}

/** Tab while drilling: the tool (or a new one of a size). */
function pickTool(ed: CamEditor): boolean {
  const { l, d } = drillLayer(ed);
  const cur = currentTool(ed, l, d);
  const tools = [...d.tools.keys()].sort((a, b) => a - b).map((t) => `T${String(t).padStart(2, '0')} (${fmtLen(d.tools.get(t)!)})`);
  ask('Drill Tool', [
    { key: 'tool', label: 'Tool', kind: 'select', value: tools.find((t) => t.startsWith(`T${String(cur).padStart(2, '0')}`)) ?? tools[0] ?? 'New...', options: [...tools, 'New...'] },
    { key: 'dia', label: 'New tool diameter', kind: 'length', value: mil(32), min: 1 },
  ], (v) => {
    if (v.tool !== 'New...') { ed.currentTool.set(l, Number(/^T(\d+)/.exec(String(v.tool))![1])); return; }
    ed.edit('Add Tool', [l], () => { ed.currentTool.set(l, findOrAddTool(d, v.dia as number)); });
  });
  return true;
}
