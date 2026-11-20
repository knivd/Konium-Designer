/**
 * The CAM editor's Edit menu (CAMtastic): Cut, Copy and Paste (by a reference point; pasted on the
 * layers they came from), Copy on Field, Mirror, Move and Rotate; Layers (Add, Align Selective, Align
 * Border, Copy to Layers, Swap Layers Data, Scale X:Y); Composite Layers (Auto Create, Build, Explode,
 * Modify, Open and Close); Selection (Display, Window, Crossing, Previous, Object, Add, Remove, Flash,
 * Trace, Filter); Groups (Draw to Flash, automatic or selective, and Draw to Custom Aperture); Objects
 * (Array, Break, Chamfer, Extend, Fillet, Join, Modify/Change, Offset, Set Origin, Scale, Text);
 * Explode (Polylines, Text, Custom Apertures); Vertex (Add, Delete, Move); Step/Repeat (Modify,
 * Explode, Add Objects, Remove Objects).
 */
import type { Command, Scope } from '../core/commands';
import type { Vec2, BBox } from '../core/geom';
import { mil } from '../core/units';
import { AreaSelectTool } from '../editors/Editor';
import { camLayerId, type CamEditor, type PickedObject } from '../editors/cam/CamEditor';
import { PickTool, PointsTool, PREVIEW, previewPath, previewSegments } from '../editors/cam/camTools';
import { clipboard, setClipboard, type CamClip } from '../editors/clipboard';
import { breakAt, chainPoints, chains, chamfer, clusters, extendTo, fillet, flashRegions, offsetPolyline, padFromDraws, regionDraws } from '../formats/cam/camOps';
import { customAperture, findOrAddAperture, findOrAddTool, groupMembers, liveObjects, moveXf, nextGroup, textDraws, xf, xfHit, xfObject, xfPoint, xfRoute, type CamGroup, type Xf } from '../formats/cam/camModel';
import { CAM_LAYER_TYPES, camExtent, sortLayers, type CamLayer, type CamLayerType } from '../formats/cam/camDoc';
import type { DrillLayer, GerberLayer, GerberObject } from '../formats/gerber/gerberRead';
import { activeCam, ask, camChanged, camEdited, currentAperture, emptyLayer, freshLayerName } from './camCommon';
import { notify } from './state';

const CAM: Scope[] = ['cam'];
const id = (n: string) => `ad:CAMTASTIC:${n}`;
type Draw = Extract<GerberObject, { kind: 'draw' }>;

/** The selection, said so when there's none. */
function needSelection(ed: CamEditor): PickedObject[] | null {
  const s = ed.selectedObjects();
  if (!s.length && !ed.selectedRoutes().length) { notify('Select the objects first'); return null; }
  return s;
}

/** The layers the picked objects are on. */
const layersOf = (sel: { layer: CamLayer }[]) => [...new Set(sel.map((s) => s.layer))];

/** Every picked object (and the selected routes) placed again by a transform, as one undo step. */
function transformSelection(ed: CamEditor, label: string, t: Xf, copy = false): void {
  const sel = ed.selectedObjects(), routes = ed.selectedRoutes();
  const layers = layersOf([...sel, ...routes]);
  const fresh: string[] = [];
  ed.edit(label, layers, () => {
    // A copy of a group is a new group
    const groupMap = new Map<string, number>();
    for (const { layer, i } of sel) {
      if (layer.data.kind === 'gerber') {
        const g = layer.data, o = g.objects[i]!;
        let moved = xfObject(o, t, g);
        if (copy) {
          if (o.grp) {
            const k = `${camLayerId(layer)}:${o.grp}`;
            if (!groupMap.has(k)) { const n = nextGroup(layer); const og = layer.groups?.get(o.grp); if (og) (layer.groups ??= new Map()).set(n, xfGroup(og, t)); groupMap.set(k, n); }
            moved = { ...moved, grp: groupMap.get(k) };
          }
          const { sr: _s, srCopy: _c, ...plain } = moved;
          g.objects.push(plain);
          fresh.push(ed.keyOf(layer, g.objects.length - 1));
        } else g.objects[i] = moved;
      } else {
        const d = layer.data, h = d.hits[i]!;
        if (copy) { d.hits.push(xfHit({ ...h, grp: undefined }, t)); fresh.push(ed.keyOf(layer, d.hits.length - 1)); } else d.hits[i] = xfHit(h, t);
      }
    }
    if (!copy) {
      // Each group whose members moved: its own record (a text's position) moved once
      const moved = new Map<CamLayer, Set<number>>();
      for (const { layer, i } of sel) {
        const grp = layer.data.kind === 'gerber' ? layer.data.objects[i]?.grp : layer.data.hits[i]?.grp;
        if (grp) { const m = moved.get(layer) ?? new Set<number>(); m.add(grp); moved.set(layer, m); }
      }
      for (const [layer, grps] of moved) for (const k of grps) { const gr = layer.groups?.get(k); if (gr) layer.groups!.set(k, xfGroup(gr, t)); }
    }
    for (const { layer, k } of routes) {
      const d = layer.data as DrillLayer;
      if (copy) d.routes.push(xfRoute(d.routes[k]!, t)); else d.routes[k] = xfRoute(d.routes[k]!, t);
    }
  });
  if (copy && fresh.length) ed.select(ed.normaliseSelection(fresh));
  camEdited();
}

/** A group's own record placed again (text's position and turn). */
function xfGroup(g: CamGroup, t: Xf): CamGroup {
  if (g.kind === 'text') return { ...g, at: xfPoint(g.at, t), rot: (((g.rot + t.rot) % 360) + 360) % 360, height: g.height * Math.abs(t.sy), mirror: g.mirror !== (t.mirrorX !== t.mirrorY) };
  if (g.kind === 'drilltext') return { ...g, at: xfPoint(g.at, t) };
  return g;
}

/** The selection's outline as preview segments, moved by d. */
function selectionPreview(ed: CamEditor, t: Xf): NonNullable<import('../core/tools').ToolOverlay['segments']> {
  const out: NonNullable<import('../core/tools').ToolOverlay['segments']> = [];
  const sel = ed.selectedObjects().slice(0, 400);
  for (const { layer, i } of sel) {
    if (layer.data.kind === 'gerber') out.push(...previewSegments(xfObject(layer.data.objects[i]!, t), layer.data));
    else { const h = xfHit(layer.data.hits[i]!, t), r = (layer.data.tools.get(h.tool) ?? 0) / 2; out.push({ a: { x: h.at.x - r, y: h.at.y }, b: { x: h.at.x + r, y: h.at.y }, width: 0, color: PREVIEW }, { a: { x: h.at.x, y: h.at.y - r }, b: { x: h.at.x, y: h.at.y + r }, width: 0, color: PREVIEW }); }
  }
  if (ed.selectedObjects().length > 400) {
    const b = ed.selectionBounds();
    const c = [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }].map((p) => xfPoint(p, t));
    out.push(...previewPath(c, 0, PREVIEW, true));
  }
  return out;
}

/** The selection copied to the clipboard by a reference point. */
function copySelection(ed: CamEditor, ref: Vec2): number {
  const sel = ed.selectedObjects();
  const clip: CamClip = { kind: 'cam', ref, layers: [] };
  for (const l of layersOf(sel)) {
    const mine = sel.filter((s) => s.layer === l).map((s) => s.i);
    if (l.data.kind === 'gerber') {
      const g = l.data;
      clip.layers.push({ name: l.name, type: l.type, drill: false, units: g.units, apertures: new Map(g.apertures), macros: new Map(g.macros), objects: mine.map((i) => g.objects[i]!), hits: [], tools: new Map(), groups: new Map(l.groups ?? []) });
    } else {
      const d = l.data;
      clip.layers.push({ name: l.name, type: l.type, drill: true, units: d.units, apertures: new Map(), macros: new Map(), objects: [], hits: mine.map((i) => ({ ...d.hits[i]!, grp: undefined })), tools: new Map(d.tools) });
    }
  }
  setClipboard(clip);
  return sel.length;
}

/** The clipboard's objects put on a layer moved by d: apertures and tools found or added there; groups made new. */
function pasteInto(l: CamLayer, src: CamClip['layers'][number], t: Xf): number[] {
  const out: number[] = [];
  if (l.data.kind === 'gerber' && !src.drill) {
    const g = l.data;
    const apMap = new Map<number, number>();
    const apFor = (code: number) => {
      if (apMap.has(code)) return apMap.get(code)!;
      const a = src.apertures.get(code);
      let n = code;
      if (a) n = a.shape === 'M' ? customAperture(g, a.shapes ?? []) : findOrAddAperture(g, a.shape, a.w, a.h, a.vertices ?? 0, a.rotation ?? 0);
      apMap.set(code, n);
      return n;
    };
    const grpMap = new Map<number, number>();
    for (const o of src.objects) {
      let m = xfObject(o, t);
      if (m.kind !== 'region') m = { ...m, ap: apFor(m.ap) };
      const { sr: _s, srCopy: _c, sub: _u, grp, ...plain } = m;
      let ng: number | undefined;
      if (grp) {
        if (!grpMap.has(grp)) { const n = nextGroup(l); const og = src.groups?.get(grp); const ng0 = og ? xfGroup(og, t) : { kind: 'polyline' as const }; (l.groups ??= new Map()).set(n, ng0.kind === 'text' ? { ...ng0, ap: apFor(ng0.ap) } : ng0); grpMap.set(grp, n); }
        ng = grpMap.get(grp);
      }
      g.objects.push({ ...plain, ...(ng ? { grp: ng } : {}) } as GerberObject);
      out.push(g.objects.length - 1);
    }
  } else if (l.data.kind === 'drill' && src.drill) {
    const d = l.data;
    for (const h of src.hits) { d.hits.push({ ...xfHit(h, t), tool: findOrAddTool(d, src.tools.get(h.tool) ?? 0) }); out.push(d.hits.length - 1); }
  }
  return out;
}

/** Edit › Paste: the clipboard follows the cursor; a click puts it on the layers it came from (or like ones, else the current layer). */
function pasteTool(ed: CamEditor, repeat: boolean): void {
  const clip = clipboard;
  if (!clip || clip.kind !== 'cam') { notify('Nothing CAM to paste: copy objects first'); return; }
  const target = (src: CamClip['layers'][number]) => ed.doc.layers.find((l) => l.name === src.name && (l.data.kind === 'drill') === src.drill)
    ?? ed.doc.layers.find((l) => l.type === src.type && (l.data.kind === 'drill') === src.drill)
    ?? (ed.layer && (ed.layer.data.kind === 'drill') === src.drill ? ed.layer : undefined);
  ed.setTool(new PointsTool(ed, {
    id: 'cam-paste', count: 1, repeat, hint: () => `Paste: click to place (${clip.layers.reduce((n, l) => n + l.objects.length + l.hits.length, 0)} objects; right-click to finish)`,
    preview: (_p, c) => {
      const t = moveXf(c.x - clip.ref.x, c.y - clip.ref.y);
      return { segments: clip.layers.flatMap((s) => [...s.objects.slice(0, 300).flatMap((o) => previewSegments(xfObject(o, t), { apertures: s.apertures } as GerberLayer)), ...s.hits.slice(0, 300).map((h) => ({ a: xfPoint(h.at, t), b: xfPoint(h.at, t), width: s.tools.get(h.tool) ?? 0, color: PREVIEW }))]) };
    },
    done: ([p]) => {
      const t = moveXf(p!.x - clip.ref.x, p!.y - clip.ref.y);
      const plan = clip.layers.map((s) => [s, target(s)] as const);
      const missing = plan.filter(([, l]) => !l).map(([s]) => s.name);
      const layers = [...new Set(plan.map(([, l]) => l).filter((l): l is CamLayer => !!l))];
      if (!layers.length) { notify(`No layer to paste ${missing.join(', ')} on`, 'error'); return; }
      const keys: string[] = [];
      ed.edit('Paste', layers, () => { for (const [s, l] of plan) if (l) keys.push(...pasteInto(l, s, t).map((i) => ed.keyOf(l, i))); });
      ed.select(ed.normaliseSelection(keys));
      if (missing.length) notify(`Not pasted (no such layer): ${missing.join(', ')}`);
      camEdited();
    },
  }));
}

/** Pick a reference point, then the destination: the selection moved (or copied, again and again with `field`). */
function moveTool(ed: CamEditor, label: string, copy: boolean, field = false): void {
  if (!needSelection(ed)) return;
  let ref: Vec2 | null = null;
  ed.setTool(new PointsTool(ed, {
    id: copy ? 'cam-copy-field' : 'cam-move', count: 1, repeat: true,
    hint: () => (!ref ? `${label}: click the reference point` : `${label}: click where it goes${field ? ' (again for more copies; right-click to finish)' : ''}`),
    preview: (_p, c) => (ref ? { segments: [...selectionPreview(ed, moveXf(c.x - ref.x, c.y - ref.y)), { a: ref, b: c, width: 0, color: 0x808080 }] } : null),
    done: ([p]) => {
      if (!ref) { ref = p!; return; }
      const t = moveXf(p!.x - ref.x, p!.y - ref.y);
      if (copy) {
        // Copy on Field keeps copying the original selection
        const was = new Set(ed.selection);
        transformSelection(ed, label, t, true);
        ed.selection = was;
        ed.invalidateOverlay();
      } else { transformSelection(ed, label, t); ref = null; ed.setTool(null); }
    },
  }));
}

/** Pick a point: the selection turned about it by an angle asked for. */
function rotateTool(ed: CamEditor): void {
  if (!needSelection(ed)) return;
  ed.setTool(new PointsTool(ed, {
    id: 'cam-rotate', count: 1, hint: () => 'Rotate: click the point to turn about',
    done: ([c]) => ask('Rotate', [{ key: 'a', label: 'Angle (degrees, counter-clockwise)', kind: 'number', value: 90 }], (v) => { transformSelection(ed, 'Rotate', xf({ about: c!, rot: v.a as number })); }),
  }));
}

/** Pick a point: the selection mirrored about the line through it, across X or Y. */
function mirrorTool(ed: CamEditor): void {
  if (!needSelection(ed)) return;
  ed.setTool(new PointsTool(ed, {
    id: 'cam-mirror', count: 1, hint: () => 'Mirror: click a point on the mirror line',
    done: ([c]) => ask('Mirror', [{ key: 'axis', label: 'Mirror', kind: 'select', value: 'Left to right (about a vertical line)', options: ['Left to right (about a vertical line)', 'Top to bottom (about a horizontal line)'] }],
      (v) => { transformSelection(ed, 'Mirror', xf({ about: c!, ...(String(v.axis).startsWith('Left') ? { mirrorX: true } : { mirrorY: true }) })); }),
  }));
}

/* ─── Selection ─────────────────────────────────────────────────────────────────────── */

/** Clicks add to (or take from) the selection until ended. */
function clickSelect(ed: CamEditor, mode: 'add' | 'remove' | 'object'): void {
  ed.setTool(new PickTool(ed, `cam-select-${mode}`, mode === 'add' ? 'Selection › Add: click objects to add them (right-click to finish)' : mode === 'remove' ? 'Selection › Remove: click objects to take them out (right-click to finish)' : 'Selection › Object: click an object',
    (hit) => {
      if (!hit) return;
      const k = hit.group ?? hit.key;
      if (mode === 'add') ed.select([...ed.selection, k]);
      else if (mode === 'remove') { const s = new Set(ed.selection); s.delete(k); ed.select([...s]); }
      else { ed.select([k]); return 'end'; }
    }));
}

/** Selection › Trace: an object and everything on its layer it touches, and they touch, in turn. */
function traceFrom(ed: CamEditor, key: string): string[] {
  const p = ed.parseKey(key);
  if (!p || p.layer.data.kind !== 'gerber') return [key];
  const l = p.layer, g = l.data as GerberLayer;
  const objs = liveObjects(l).filter(({ o }) => o.dark);
  const groups = clusters(objs, g);
  const start = p.kind === 'g' ? groupMembers(l, p.n)[0] : p.n;
  const group = groups.find((c) => c.some((k) => objs[k]!.i === start));
  return group ? group.map((k) => ed.keyOf(l, objs[k]!.i)) : [key];
}

/* ─── Composite layers ──────────────────────────────────────────────────────────────── */

/** Layers made into one composite: each a sub-layer of the polarity given, in order; the layers themselves go. */
function buildComposite(ed: CamEditor, name: string, parts: { layer: CamLayer; dark: boolean }[]): void {
  const gl = parts.filter((p) => p.layer.data.kind === 'gerber');
  if (gl.length < 1) { notify('A composite is made of Gerber layers', 'error'); return; }
  const first = gl[0]!.layer;
  const out = emptyLayer(freshLayerName(ed.doc, name), first.type);
  const g = out.data as GerberLayer;
  g.units = (first.data as GerberLayer).units;
  out.composite = gl.map((p) => ({ name: p.layer.name, dark: p.dark }));
  ed.edit('Build Composite', 'all', () => {
    gl.forEach((p, sub) => {
      const src = p.layer.data as GerberLayer;
      const clip = { name: p.layer.name, type: p.layer.type, drill: false, units: src.units, apertures: src.apertures, macros: src.macros, objects: liveObjects(p.layer).map(({ o }) => o), hits: [], tools: new Map() };
      for (const i of pasteInto(out, clip, moveXf(0, 0))) g.objects[i] = { ...g.objects[i]!, sub };
    });
    const at = Math.min(...gl.map((p) => ed.doc.layers.indexOf(p.layer)));
    ed.doc.layers = ed.doc.layers.filter((l) => !gl.some((p) => p.layer === l));
    ed.doc.layers.splice(Math.max(0, at), 0, out);
    ed.doc.current = ed.doc.layers.indexOf(out);
  });
  camEdited();
}

/* ─── Vertices ──────────────────────────────────────────────────────────────────────── */

/** The vertex of a region or polyline nearest a point (within tol): where it is and how to move or delete it. */
function vertexAt(ed: CamEditor, at: Vec2, tol: number): { layer: CamLayer; move: (to: Vec2) => void; del: () => boolean; pos: Vec2 } | null {
  let best: { layer: CamLayer; move: (to: Vec2) => void; del: () => boolean; pos: Vec2 } | null = null, bd = tol;
  for (const l of ed.doc.layers) {
    if (!l.visible || l.data.kind !== 'gerber') continue;
    const g = l.data;
    for (const { o, i } of liveObjects(l)) {
      if (o.kind === 'region') {
        o.contours.forEach((c, ci) => c.forEach((p, pi) => {
          const d = Math.hypot(p.x - at.x, p.y - at.y);
          if (d >= bd) return;
          bd = d;
          best = { layer: l, pos: p,
            move: (to) => { const r = g.objects[i] as typeof o; g.objects[i] = { ...r, contours: r.contours.map((cc, k) => (k === ci ? cc.map((q, j) => (j === pi ? to : q)) : cc)) }; },
            del: () => { const r = g.objects[i] as typeof o; if (r.contours[ci]!.length <= 3) return false; g.objects[i] = { ...r, contours: r.contours.map((cc, k) => (k === ci ? cc.filter((_, j) => j !== pi) : cc)) }; return true; } };
        }));
      } else if ((o.kind === 'draw' || o.kind === 'arc') && o.grp) {
        for (const end of ['a', 'b'] as const) {
          const p = o[end], d = Math.hypot(p.x - at.x, p.y - at.y);
          if (d >= bd) continue;
          bd = d;
          // Every member of the polyline meeting there moves with it
          const grp = o.grp;
          best = { layer: l, pos: p,
            move: (to) => { for (const k of groupMembers(l, grp)) { const q = g.objects[k]!; if (q.kind !== 'draw' && q.kind !== 'arc') continue; const nq = { ...q }; if (Math.hypot(q.a.x - p.x, q.a.y - p.y) < 1) nq.a = to; if (Math.hypot(q.b.x - p.x, q.b.y - p.y) < 1) nq.b = to; g.objects[k] = nq; } },
            del: () => {
              // The two draws meeting there become one
              const meet = groupMembers(l, grp).filter((k) => { const q = g.objects[k]!; return q.kind === 'draw' && (Math.hypot(q.a.x - p.x, q.a.y - p.y) < 1 || Math.hypot(q.b.x - p.x, q.b.y - p.y) < 1); });
              if (meet.length !== 2) return false;
              const [k1, k2] = meet as [number, number];
              const d1 = g.objects[k1] as Draw, d2 = g.objects[k2] as Draw;
              const far1 = Math.hypot(d1.a.x - p.x, d1.a.y - p.y) < 1 ? d1.b : d1.a, far2 = Math.hypot(d2.a.x - p.x, d2.a.y - p.y) < 1 ? d2.b : d2.a;
              g.objects[k1] = { ...d1, a: far1, b: far2 };
              l.erased = [...new Set([...(l.erased ?? []), k2])];
              return true;
            } };
        }
      }
    }
  }
  return best;
}

/** The edge of a region or polyline nearest a point: a vertex put in there. */
function addVertexAt(ed: CamEditor, at: Vec2, tol: number): CamLayer | null {
  let best: { l: CamLayer; apply: () => void } | null = null, bd = tol;
  const segDist = (p: Vec2, a: Vec2, b: Vec2) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0; return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); };
  for (const l of ed.doc.layers) {
    if (!l.visible || l.data.kind !== 'gerber') continue;
    const g = l.data;
    for (const { o, i } of liveObjects(l)) {
      if (o.kind === 'region') o.contours.forEach((c, ci) => c.forEach((p, pi) => {
        const q = c[(pi + 1) % c.length]!, d = segDist(at, p, q);
        if (d < bd) { bd = d; best = { l, apply: () => { const r = g.objects[i] as typeof o; g.objects[i] = { ...r, contours: r.contours.map((cc, k) => (k === ci ? [...cc.slice(0, pi + 1), at, ...cc.slice(pi + 1)] : cc)) }; } }; }
      }));
      else if (o.kind === 'draw') {
        const d = segDist(at, o.a, o.b);
        if (d < bd) { bd = d; best = { l, apply: () => { const r = g.objects[i] as Draw; g.objects[i] = { ...r, b: at }; g.objects.push({ ...r, a: at }); } }; }
      }
    }
  }
  if (!best) return null;
  const b = best as { l: CamLayer; apply: () => void };
  ed.edit('Add Vertex', [b.l], b.apply);
  camEdited();
  return b.l;
}

/* ─── Step and repeat ───────────────────────────────────────────────────────────────── */

/** A block's repeats made again from its objects (the old repeats erased). */
function regenerateBlock(l: CamLayer, id: number): void {
  const g = l.data as GerberLayer;
  const st = g.steps?.find((s) => s.id === id);
  const erased = new Set(l.erased ?? []);
  g.objects.forEach((o, i) => { if (o.sr === id && o.srCopy) erased.add(i); });
  l.erased = [...erased].sort((a, b) => a - b);
  if (!st) return;
  const base = g.objects.map((o, i) => [o, i] as const).filter(([o, i]) => o.sr === id && !o.srCopy && !erased.has(i)).map(([o]) => o);
  for (let a = 0; a < st.nx; a++) for (let b = 0; b < st.ny; b++) {
    if (!a && !b) continue;
    const t = moveXf(a * st.dx, b * st.dy);
    for (const o of base) g.objects.push({ ...xfObject(o, t), sr: id, srCopy: true });
  }
}

export function camEditCommands(): Command[] {
  const on = () => !!activeCam();
  const withCam = (f: (ed: CamEditor) => void) => () => { const e = activeCam(); if (e) f(e); };
  const cmd = (name: string, label: string, run: (ed: CamEditor) => void): Command => ({ id: id(name), label, scopes: CAM, enabled: on, run: withCam(run) });
  const layerNames = (ed: CamEditor, f: (l: CamLayer) => boolean = () => true) => ed.doc.layers.filter(f).map((l) => l.name);
  const byName = (ed: CamEditor, n: string) => ed.doc.layers.find((l) => l.name === n);
  return [
    // Clipboard
    cmd('EditCopy', 'Copy', (ed) => {
      if (!needSelection(ed)) return;
      ed.setTool(new PointsTool(ed, { id: 'cam-copy', count: 1, hint: () => 'Copy: click the reference point', done: ([p]) => notify(`${copySelection(ed, p!)} objects copied`) }));
    }),
    cmd('EditCut', 'Cut', (ed) => {
      if (!needSelection(ed)) return;
      ed.setTool(new PointsTool(ed, { id: 'cam-cut', count: 1, hint: () => 'Cut: click the reference point', done: ([p]) => { copySelection(ed, p!); ed.deleteSelection(); camEdited(); } }));
    }),
    cmd('EditPaste', 'Paste', (ed) => pasteTool(ed, false)),
    cmd('EditCopyMult', 'Copy on Field', (ed) => moveTool(ed, 'Copy on Field', true, true)),
    cmd('EditMove', 'Move', (ed) => moveTool(ed, 'Move', false)),
    cmd('EditRotate', 'Rotate', rotateTool),
    cmd('EditMirror', 'Mirror', mirrorTool),
    // Layers
    cmd('DrawAddLayer', 'Add...', (ed) => ask('Add Layer', [
      { key: 'name', label: 'Name', kind: 'text', value: freshLayerName(ed.doc, 'Layer1.GBR') },
      { key: 'type', label: 'Type', kind: 'select', value: 'Mechanical', options: [...CAM_LAYER_TYPES] },
      { key: 'kind', label: 'Kind', kind: 'select', value: 'Gerber', options: ['Gerber', 'NC drill'] },
    ], (v) => {
      const name = String(v.name).trim();
      if (!name) return 'Give the layer a name';
      if (byName(ed, name)) return 'A layer has that name';
      const l = emptyLayer(name, v.type as CamLayerType, v.kind === 'NC drill');
      ed.edit('Add Layer', 'all', () => { ed.doc.layers = sortLayers([...ed.doc.layers, l]); ed.doc.current = ed.doc.layers.indexOf(l); });
      camEdited();
    })),
    cmd('EditAlign', 'Align Selective', (ed) => {
      const l = ed.layer;
      if (!l) return;
      ed.setTool(new PointsTool(ed, {
        id: 'cam-align', count: 2, raw: false, hint: (n) => (n ? `Align Selective: click where that point of ${l.name} belongs (on the reference layer)` : `Align Selective: click a point of ${l.name} (the current layer) to align`),
        preview: (pts, c) => (pts.length ? { segments: [{ a: pts[0]!, b: c, width: 0, color: PREVIEW }] } : null),
        done: ([a, b]) => {
          const t = moveXf(b!.x - a!.x, b!.y - a!.y);
          ed.edit('Align Layer', [l], () => moveLayer(l, t));
          camEdited();
        },
      }));
    }),
    cmd('EditAlignBorder', 'Align Border (Auto-Detect)', (ed) => {
      // Each shown layer moved so its extent's lower-left corner meets the current layer's [est: CAMtastic finds the border]
      const ref = ed.layer;
      const rb = ref ? camExtent({ ...ed.doc, layers: [ref] }, false) : null;
      if (!ref || !rb) { notify('The current layer is empty'); return; }
      const moves = ed.doc.layers.filter((l) => l !== ref && l.visible).map((l) => [l, camExtent({ ...ed.doc, layers: [l] }, false)] as const).filter((x): x is [CamLayer, BBox] => !!x[1]);
      ed.edit('Align Border', moves.map(([l]) => l), () => { for (const [l, b] of moves) if (Math.abs(b.minX - rb.minX) > 1 || Math.abs(b.minY - rb.minY) > 1) moveLayer(l, moveXf(rb.minX - b.minX, rb.minY - b.minY)); });
      camEdited();
      notify(`${moves.length} layer${moves.length === 1 ? '' : 's'} aligned to ${ref.name}`);
    }),
    cmd('EditCopyLayer', 'Copy to Layers', (ed) => {
      const sel = needSelection(ed);
      if (!sel) return;
      const kinds = new Set(sel.map((s) => s.layer.data.kind));
      ask('Copy to Layers', [{ key: 'to', label: 'Copy the selection to', kind: 'layers', value: [], options: layerNames(ed, (l) => kinds.has(l.data.kind) && !sel.every((s) => s.layer === l)) }], (v) => {
        const to = (v.to as string[]).map((n) => byName(ed, n)!).filter(Boolean);
        if (!to.length) return 'Tick the layers to copy to';
        const ref = { x: 0, y: 0 };
        copySelection(ed, ref);
        const clip = clipboard as CamClip;
        ed.edit('Copy to Layers', to, () => { for (const l of to) for (const s of clip.layers) if ((l.data.kind === 'drill') === s.drill) pasteInto(l, s, moveXf(0, 0)); });
        camEdited();
      });
    }),
    cmd('EditSwapLayers', 'Swap Layers Data...', (ed) => {
      const names = layerNames(ed);
      if (names.length < 2) { notify('Swapping needs two layers'); return; }
      ask('Swap Layers Data', [{ key: 'a', label: 'Layer', kind: 'select', value: names[0]!, options: names }, { key: 'b', label: 'With', kind: 'select', value: names[1]!, options: names }], (v) => {
        const a = byName(ed, String(v.a))!, b = byName(ed, String(v.b))!;
        if (a === b) return 'Pick two different layers';
        ed.edit('Swap Layers Data', [a, b], () => {
          for (const k of ['data', 'text', 'erased', 'edited', 'groups', 'composite'] as const) { const t = a[k]; (a as unknown as Record<string, unknown>)[k] = b[k]; (b as unknown as Record<string, unknown>)[k] = t; }
          for (const l of [a, b]) for (const k of ['erased', 'edited', 'groups', 'composite'] as const) if (l[k] === undefined) delete l[k];
        });
        camEdited();
      });
    }),
    cmd('EditScaleLayer', 'Scale(X:Y)...', (ed) => {
      const l = ed.layer;
      if (!l) return;
      ask('Scale Layer', [
        { kind: 'note', text: `Scales ${l.name} about the origin (a film's shrinkage or stretch).` },
        { key: 'x', label: 'X scale', kind: 'number', value: 1, min: 0.001 },
        { key: 'y', label: 'Y scale', kind: 'number', value: 1, min: 0.001 },
        { key: 'all', label: 'All shown layers', kind: 'bool', value: false },
      ], (v) => {
        const layers = v.all ? ed.doc.layers.filter((x) => x.visible) : [l];
        const t = xf({ about: ed.origin(), sx: v.x as number, sy: v.y as number });
        ed.edit('Scale Layer', layers, () => { for (const x of layers) moveLayer(x, t); });
        camEdited();
      });
    }),
    // Composites
    cmd('BonusComposAuto', 'Auto Create Composite', (ed) => {
      // A layer and its clearances (…CLR, …CLEAR, …NEG, …_C, or a negative image of the same type) [est: how CAMtastic pairs them]
      const isClear = (l: CamLayer) => /(clr|clear|neg|_c)(\.[^.]+)?$/i.test(l.name) || (l.data.kind === 'gerber' && l.data.negative);
      const base = (n: string) => n.replace(/(\.[^.]+)$/, '').replace(/[_-]?(clr|clear|neg|c)$/i, '').toLowerCase();
      const made: string[] = [];
      for (const clear of ed.doc.layers.filter((l) => l.data.kind === 'gerber' && isClear(l))) {
        const dark = ed.doc.layers.find((l) => l !== clear && l.data.kind === 'gerber' && !isClear(l) && (base(l.name) === base(clear.name) || l.type === clear.type) && !l.composite);
        if (!dark || !ed.doc.layers.includes(clear)) continue;
        buildComposite(ed, `${dark.name.replace(/\.[^.]+$/, '')}_COMPOSITE`, [{ layer: dark, dark: true }, { layer: clear, dark: false }]);
        made.push(dark.name);
      }
      notify(made.length ? `Composites made of ${made.join(', ')}` : 'No layer and clearance layer pairs found');
    }),
    cmd('BuildComposite', 'Build Composite...', (ed) => {
      const names = layerNames(ed, (l) => l.data.kind === 'gerber');
      if (!names.length) { notify('A composite is made of Gerber layers'); return; }
      ask('Build Composite', [
        { key: 'name', label: 'Name', kind: 'text', value: 'COMPOSITE' },
        { key: 'dark', label: 'Dark (positive) sub-layers', kind: 'layers', value: [names[0]!], options: names },
        { key: 'clear', label: 'Clear (negative) sub-layers, drawn after the dark ones', kind: 'layers', value: [], options: names },
      ], (v) => {
        const dark = new Set(v.dark as string[]), clear = new Set(v.clear as string[]);
        // The dark sub-layers first, then the clear ones that cut them (each in stack order)
        const parts = [...ed.doc.layers.filter((l) => dark.has(l.name) && !clear.has(l.name)).map((l) => ({ layer: l, dark: true })), ...ed.doc.layers.filter((l) => clear.has(l.name)).map((l) => ({ layer: l, dark: false }))];
        if (parts.length < 2) return 'A composite has two sub-layers or more';
        buildComposite(ed, String(v.name).trim() || 'COMPOSITE', parts);
      }, { width: 520 });
    }),
    cmd('EditExplodeComposite', 'Explode Composite', (ed) => {
      const l = ed.layer;
      if (!l?.composite?.length || l.data.kind !== 'gerber') { notify('The current layer is not a composite'); return; }
      const g = l.data;
      const out = l.composite.map((s) => { const x = emptyLayer(freshLayerName(ed.doc, s.name), l.type); (x.data as GerberLayer).units = g.units; return x; });
      ed.edit('Explode Composite', 'all', () => {
        out.forEach((x, sub) => {
          const objs = liveObjects(l).filter(({ o }) => (o.sub ?? 0) === sub).map(({ o }) => { const { sub: _s, ...r } = o; return r as GerberObject; });
          pasteInto(x, { name: x.name, type: x.type, drill: false, units: g.units, apertures: g.apertures, macros: g.macros, objects: objs, hits: [], tools: new Map() }, moveXf(0, 0));
          // A clear sub-layer keeps its polarity as an image of its own
          if (!l.composite![sub]!.dark) (x.data as GerberLayer).negative = true;
        });
        const at = ed.doc.layers.indexOf(l);
        ed.doc.layers.splice(at, 1, ...out);
        ed.doc.current = at;
        if (ed.doc.openComposite?.layer === l.name) delete ed.doc.openComposite;
      });
      camEdited();
    }),
    cmd('EditModifyComposite', 'Modify Composite', (ed) => {
      const l = ed.layer;
      if (!l?.composite?.length) { notify('The current layer is not a composite'); return; }
      const subs = l.composite;
      ask('Modify Composite', [
        ...subs.flatMap((s, i) => [
          { key: `n${i}`, label: `Sub-layer ${i + 1} name`, kind: 'text' as const, value: s.name },
          { key: `p${i}`, label: `Sub-layer ${i + 1} polarity`, kind: 'select' as const, value: s.dark ? 'Dark' : 'Clear', options: ['Dark', 'Clear'] },
          { key: `o${i}`, label: `Sub-layer ${i + 1} order`, kind: 'number' as const, value: i + 1, min: 1, max: subs.length },
        ]),
      ], (v) => {
        const order = subs.map((_, i) => ({ i, at: v[`o${i}`] as number })).sort((a, b) => a.at - b.at || a.i - b.i).map((x) => x.i);
        ed.edit('Modify Composite', [l], () => {
          l.composite = order.map((i) => ({ name: String(v[`n${i}`]), dark: v[`p${i}`] === 'Dark' }));
          const g = l.data as GerberLayer;
          const to = new Map(order.map((oldI, newI) => [oldI, newI]));
          g.objects = g.objects.map((o) => ({ ...o, sub: to.get(o.sub ?? 0) ?? 0 }));
        });
        camEdited();
      }, { width: 460 });
    }),
    cmd('EditCompositeOpen', 'Open Composite for editing', (ed) => {
      const l = ed.layer;
      if (!l?.composite?.length) { notify('The current layer is not a composite'); return; }
      ask('Open Composite', [{ key: 'sub', label: 'Edit the sub-layer', kind: 'select', value: l.composite[0]!.name, options: l.composite.map((s) => s.name) }], (v) => {
        ed.doc.openComposite = { layer: l.name, sub: l.composite!.findIndex((s) => s.name === v.sub) };
        camChanged(ed);
        notify(`Placing on ${v.sub} (${l.name})`);
      });
    }),
    cmd('EditCompositeClose', 'Close Composite', (ed) => { if (!ed.doc.openComposite) { notify('No composite is open'); return; } delete ed.doc.openComposite; camChanged(ed); }),
    // Selection
    cmd('SelmenuDisplay', 'Display', (ed) => {
      const v = ed.viewport;
      if (!v) return;
      const a = v.cam.toWorld({ x: 0, y: 0 }), b = v.cam.toWorld({ x: v.cam.width, y: v.cam.height });
      ed.boxSelect({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) }, false);
    }),
    cmd('SelmenuWindow', 'Window', (ed) => ed.setTool(new AreaSelectTool(ed, 'inside'))),
    cmd('SelmenuCross', 'Crossing Window', (ed) => ed.setTool(new AreaSelectTool(ed, 'touchingRect'))),
    cmd('SelmenuPrev', 'Previous', (ed) => ed.select(ed.previousSelection)),
    cmd('SelmenuEntity', 'Object', (ed) => clickSelect(ed, 'object')),
    cmd('SelmenuAddToggle', 'Add', (ed) => clickSelect(ed, 'add')),
    cmd('SelmenuRemove', 'Remove', (ed) => clickSelect(ed, 'remove')),
    cmd('SelmenuFlash', 'Flash', (ed) => {
      const l = ed.layer;
      if (l?.data.kind !== 'gerber') { notify('Make a Gerber layer current'); return; }
      ed.select(liveObjects(l).filter(({ o }) => o.kind === 'flash').map(({ i }) => ed.keyOf(l, i)));
    }),
    cmd('SelmenuTrace', 'Trace', (ed) => ed.setTool(new PickTool(ed, 'cam-trace', 'Selection › Trace: click a conductor to select it and all it connects to on its layer', (hit) => { if (hit) ed.select(traceFrom(ed, hit.key), true); }))),
    cmd('SelmenuFilter', 'Filter', (ed) => {
      const gerbers = ed.doc.layers.filter((l) => l.data.kind === 'gerber');
      const codes = [...new Set(gerbers.flatMap((l) => [...(l.data as GerberLayer).apertures.keys()]))].sort((a, b) => a - b);
      ask('Selection Filter', [
        { key: 'layers', label: 'Layers', kind: 'layers', value: ed.doc.layers.filter((l) => l.visible).map((l) => l.name), options: layerNames(ed) },
        { key: 'kind', label: 'Objects', kind: 'select', value: 'Any', options: ['Any', 'Lines', 'Arcs', 'Flashes', 'Polygons', 'Drill hits'] },
        { key: 'ap', label: 'D-Code', kind: 'select', value: 'Any', options: ['Any', ...codes.map((c) => `D${c}`)] },
        { key: 'pol', label: 'Polarity', kind: 'select', value: 'Any', options: ['Any', 'Dark', 'Clear'] },
        { key: 'add', label: 'Add to the selection', kind: 'bool', value: false },
      ], (v) => {
        const want = new Set(v.layers as string[]);
        const kind = { Lines: 'draw', Arcs: 'arc', Flashes: 'flash', Polygons: 'region' }[String(v.kind)] as GerberObject['kind'] | undefined;
        const keys: string[] = [];
        for (const l of ed.doc.layers) {
          if (!want.has(l.name)) continue;
          if (l.data.kind === 'drill') { if (v.kind === 'Any' || v.kind === 'Drill hits') l.data.hits.forEach((_, i) => { if (!(l.erased ?? []).includes(i)) keys.push(ed.keyOf(l, i)); }); continue; }
          if (v.kind === 'Drill hits') continue;
          for (const { o, i } of liveObjects(l)) {
            if (kind && o.kind !== kind) continue;
            if (v.ap !== 'Any' && (o.kind === 'region' || `D${o.ap}` !== v.ap)) continue;
            if (v.pol !== 'Any' && o.dark !== (v.pol === 'Dark')) continue;
            keys.push(ed.keyOf(l, i));
          }
        }
        ed.select(ed.normaliseSelection(keys), false);
        if (v.add) ed.select([...ed.previousSelection, ...ed.selection]);
        notify(`${keys.length} object${keys.length === 1 ? '' : 's'} selected`);
      }, { width: 520 });
    }),
    // Groups: draws to flashes
    cmd('ToolsDraw2Flash', 'Automatic', (ed) => drawsToFlashes(ed, false)),
    cmd('ToolsDraw2FlashSel', 'Selective', (ed) => drawsToFlashes(ed, true)),
    cmd('ToolsDraw2Cust', 'Draw to Custom Aperture', (ed) => {
      const sel = needSelection(ed);
      if (!sel) return;
      const l = sel[0]!.layer;
      if (l.data.kind !== 'gerber' || sel.some((s) => s.layer !== l)) { notify('Select objects of one Gerber layer'); return; }
      const g = l.data;
      ed.edit('Draw to Custom Aperture', [l], () => {
        const f = padFromDraws(sel.map((s) => g.objects[s.i]!), g, true);
        if (!f) return;
        l.erased = [...new Set([...(l.erased ?? []), ...sel.map((s) => s.i)])];
        g.objects.push(f);
        ed.selection = new Set([ed.keyOf(l, g.objects.length - 1)]);
      });
      camEdited();
    }),
    // Objects
    cmd('EditArray', 'Array', (ed) => {
      if (!needSelection(ed)) return;
      ask('Array', [
        { key: 'nx', label: 'Columns', kind: 'number', value: 2, min: 1, max: 1000 },
        { key: 'ny', label: 'Rows', kind: 'number', value: 1, min: 1, max: 1000 },
        { key: 'dx', label: 'Column pitch (X)', kind: 'length', value: mil(100) },
        { key: 'dy', label: 'Row pitch (Y)', kind: 'length', value: mil(100) },
      ], (v) => {
        const nx = Math.round(v.nx as number), ny = Math.round(v.ny as number);
        if (nx * ny < 2) return 'An array has two places or more';
        const was = [...ed.selection];
        ed.undo.transact('Array', () => {
          for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) {
            if (!a && !b) continue;
            ed.selection = new Set(was);
            transformSelection(ed, 'Array', moveXf(a * (v.dx as number), b * (v.dy as number)), true);
          }
        });
        ed.select(was);
        camEdited();
      });
    }),
    cmd('EditBreak', 'Break', (ed) => ed.setTool(new PickTool(ed, 'cam-break', 'Break: click a line or arc where it is to be broken', (hit, _at, raw) => {
      const p = hit ? ed.selectedObjects([hit.key])[0] : undefined;
      if (!p || p.layer.data.kind !== 'gerber') return;
      const g = p.layer.data, parts = breakAt(g.objects[p.i]!, raw);
      if (!parts) { notify('Click a line or arc away from its ends'); return; }
      ed.edit('Break', [p.layer], () => { g.objects[p.i] = parts[0]; g.objects.push(parts[1]); });
      camEdited();
    }))),
    ...(['Chamfer', 'Fillet'] as const).map((what) => cmd(what === 'Chamfer' ? 'EditChamfer' : 'EditFillet', what, (ed) => {
      let first: PickedObject | null = null;
      ed.setTool(new PickTool(ed, `cam-${what.toLowerCase()}`, `${what}: click the first line, then the second at the corner`, (hit) => {
        const p = hit ? ed.selectedObjects([hit.key])[0] : undefined;
        if (!p || p.layer.data.kind !== 'gerber' || p.layer.data.objects[p.i]!.kind !== 'draw') { notify('Click a line'); return; }
        if (!first) { first = p; ed.select([hit!.key]); return; }
        const a = first, b = p;
        first = null;
        if (a.layer !== b.layer || a.i === b.i) { notify('Click two lines of one layer'); return; }
        const g = a.layer.data as GerberLayer;
        ask(what, [{ key: 'd', label: what === 'Chamfer' ? 'Distance back from the corner' : 'Radius', kind: 'length', value: mil(20), min: 1 }], (v) => {
          const l1 = g.objects[a.i] as Draw, l2 = g.objects[b.i] as Draw;
          const r = what === 'Chamfer' ? chamfer(l1, l2, v.d as number) : fillet(l1, l2, v.d as number);
          if (!r) return 'The lines are too short for that, or they don\'t make a corner';
          ed.edit(what, [a.layer], () => { g.objects[a.i] = r.l1; g.objects[b.i] = r.l2; g.objects.push('cut' in r ? r.cut : r.arc); });
          camEdited();
        });
      }));
    })),
    cmd('EditExtend', 'Extend', (ed) => {
      let boundary: PickedObject | null = null;
      ed.setTool(new PickTool(ed, 'cam-extend', 'Extend: click the boundary (a line or arc), then the end of each line to extend to it', (hit, _at, raw) => {
        const p = hit ? ed.selectedObjects([hit.key])[0] : undefined;
        if (!p || p.layer.data.kind !== 'gerber') return;
        if (!boundary) { boundary = p; ed.select([hit!.key]); return; }
        const g = p.layer.data, o = g.objects[p.i]!;
        if (o.kind !== 'draw') { notify('Click a line to extend'); return; }
        const b = boundary.layer.data as GerberLayer;
        const r = extendTo(o, b.objects[boundary.i]!, raw);
        if (!r) { notify('That line doesn\'t meet the boundary ahead of its end'); return; }
        ed.edit('Extend', [p.layer], () => { g.objects[p.i] = r; });
        camEdited();
      }));
    }),
    cmd('EditJoin', 'Join', (ed) => {
      const sel = needSelection(ed);
      if (!sel) return;
      let made = 0;
      const layers = layersOf(sel).filter((l) => l.data.kind === 'gerber');
      ed.edit('Join', layers, () => {
        for (const l of layers) {
          const g = l.data as GerberLayer;
          const objs = sel.filter((s) => s.layer === l).map((s) => ({ o: g.objects[s.i]!, i: s.i }));
          for (const c of chains(objs)) {
            if (c.items.length < 2) continue;
            const grp = nextGroup(l);
            (l.groups ??= new Map()).set(grp, { kind: 'polyline', ...(c.closed ? { closed: true } : {}) });
            for (const { i } of c.items) g.objects[i] = { ...g.objects[i]!, grp };
            made++;
          }
        }
      });
      ed.select(ed.normaliseSelection([...ed.selection]));
      camEdited();
      notify(made ? `${made} polyline${made === 1 ? '' : 's'} joined` : 'Nothing joins: select lines and arcs that meet end to end');
    }),
    cmd('EditModify', 'Modify/Change', (ed) => {
      const sel = needSelection(ed);
      if (!sel) return;
      const gl = sel.filter((s) => s.layer.data.kind === 'gerber');
      const codes = [...new Set(gl.flatMap((s) => [...(s.layer.data as GerberLayer).apertures.keys()]))].sort((a, b) => a - b);
      const gerberNames = layerNames(ed, (l) => l.data.kind === 'gerber');
      ask('Modify/Change', [
        { kind: 'note', text: `${sel.length} object${sel.length === 1 ? '' : 's'} selected. Leave a field as it is to keep it.` },
        { key: 'ap', label: 'D-Code', kind: 'select', value: 'Keep', options: ['Keep', ...codes.map((c) => `D${c}`)] },
        { key: 'pol', label: 'Polarity', kind: 'select', value: 'Keep', options: ['Keep', 'Dark', 'Clear'] },
        { key: 'layer', label: 'Move to layer', kind: 'select', value: 'Keep', options: ['Keep', ...gerberNames] },
        { key: 'rot', label: 'Flash rotation (degrees)', kind: 'text', value: '' },
      ], (v) => {
        const to = v.layer !== 'Keep' ? byName(ed, String(v.layer)) : undefined;
        const layers = [...layersOf(gl), ...(to ? [to] : [])];
        const rot = String(v.rot).trim() === '' ? null : Number(v.rot);
        if (rot !== null && !Number.isFinite(rot)) return 'Rotation: a number of degrees';
        ed.edit('Modify/Change', layers, () => {
          const moved: { o: GerberObject; from: CamLayer }[] = [];
          for (const { layer, i } of gl) {
            const g = layer.data as GerberLayer;
            let o = g.objects[i]!;
            if (v.ap !== 'Keep' && o.kind !== 'region') o = { ...o, ap: Number(String(v.ap).slice(1)) };
            if (v.pol !== 'Keep') o = { ...o, dark: v.pol === 'Dark' };
            if (rot !== null && o.kind === 'flash') o = { ...o, rot: (((rot % 360) + 360) % 360) || undefined };
            if (to && to !== layer) { moved.push({ o, from: layer }); layer.erased = [...new Set([...(layer.erased ?? []), i])]; } else g.objects[i] = o;
          }
          if (to) for (const l of layersOf(moved.map((m) => ({ layer: m.from })))) {
            const g = l.data as GerberLayer;
            pasteInto(to, { name: l.name, type: l.type, drill: false, units: g.units, apertures: g.apertures, macros: g.macros, objects: moved.filter((m) => m.from === l).map((m) => m.o), hits: [], tools: new Map() }, moveXf(0, 0));
          }
        });
        if (to) ed.clearSelection();
        camEdited();
      }, { width: 460 });
    }),
    cmd('EditOffset', 'Offset', (ed) => {
      const sel = needSelection(ed);
      if (!sel) return;
      const l = sel[0]!.layer;
      if (l.data.kind !== 'gerber') return;
      const g = l.data;
      const c = chains(sel.filter((s) => s.layer === l).map((s) => ({ o: g.objects[s.i]!, i: s.i })));
      if (!c.length) { notify('Select lines or a polyline to offset'); return; }
      ed.setTool(new PointsTool(ed, {
        id: 'cam-offset', count: 1, hint: () => 'Offset: click the side to offset to',
        done: ([side]) => ask('Offset', [{ key: 'd', label: 'Distance', kind: 'length', value: mil(20), min: 1 }], (v) => {
          ed.edit('Offset', [l], () => {
            for (const ch of c) {
              const pts = chainPoints(g, ch.items);
              // Which side the click is on, against the first segment
              const a = pts[0]!, b = pts[1] ?? a, s = (b.x - a.x) * (side!.y - a.y) - (b.y - a.y) * (side!.x - a.x);
              const off = offsetPolyline(ch.closed ? pts.slice(0, -1) : pts, (s >= 0 ? 1 : -1) * (v.d as number), ch.closed);
              if (off.length < 2) continue;
              const first = g.objects[ch.items[0]!.i]!, ap = first.kind === 'region' ? currentAperture(ed, l, g) : first.ap;
              const grp = nextGroup(l);
              (l.groups ??= new Map()).set(grp, { kind: 'polyline', ...(ch.closed ? { closed: true } : {}) });
              const ring = ch.closed ? [...off, off[0]!] : off;
              for (let k = 1; k < ring.length; k++) g.objects.push({ kind: 'draw', a: ring[k - 1]!, b: ring[k]!, ap, dark: first.dark, grp });
            }
          });
          camEdited();
        }),
      }));
    }),
    cmd('EditOriginUser', 'Set Origin', (ed) => ed.setTool(new PointsTool(ed, {
      id: 'cam-origin', count: 1, hint: () => 'Set Origin: click the new origin (coordinates are shown from it)',
      done: ([p]) => { ed.edit('Set Origin', [], () => { ed.doc.origin = p!; }); ed.view.origin = true; camEdited(); },
    }))),
    cmd('EditScale', 'Scale', (ed) => {
      if (!needSelection(ed)) return;
      ed.setTool(new PointsTool(ed, {
        id: 'cam-scale', count: 1, hint: () => 'Scale: click the point to scale about',
        done: ([c]) => ask('Scale', [{ key: 'x', label: 'X scale', kind: 'number', value: 2, min: 0.001 }, { key: 'y', label: 'Y scale', kind: 'number', value: 2, min: 0.001 }], (v) => {
          transformSelection(ed, 'Scale', xf({ about: c!, sx: v.x as number, sy: v.y as number }));
        }),
      }));
    }),
    cmd('EditText', 'Text', (ed) => ed.setTool(new PickTool(ed, 'cam-edit-text', 'Text: click a text to change it', (hit) => {
      const p = hit?.group ? ed.parseKey(hit.group) : null;
      const gr = p?.kind === 'g' ? p.layer.groups?.get(p.n) : undefined;
      if (!p || !gr || gr.kind !== 'text') { notify('Click a text placed in the CAM editor'); return; }
      const l = p.layer, g = l.data as GerberLayer;
      ask('Text', [
        { key: 'text', label: 'Text', kind: 'text', value: gr.text },
        { key: 'h', label: 'Height', kind: 'length', value: gr.height, min: 1 },
        { key: 'rot', label: 'Rotation (degrees)', kind: 'number', value: gr.rot },
        { key: 'mirror', label: 'Mirrored', kind: 'bool', value: gr.mirror },
      ], (v) => {
        const text = String(v.text);
        if (!text.trim()) return 'Type the text';
        ed.edit('Edit Text', [l], () => {
          const members = groupMembers(l, p.n);
          const dark = g.objects[members[0]!]?.dark ?? true;
          l.erased = [...new Set([...(l.erased ?? []), ...members])];
          const ng = { ...gr, text, height: v.h as number, rot: v.rot as number, mirror: !!v.mirror };
          l.groups!.set(p.n, ng);
          g.objects.push(...textDraws(text, gr.at, ng.height, ng.rot, ng.mirror, gr.ap, dark, p.n));
        });
        camEdited();
      });
    }))),
    // Explode
    cmd('EditExplodePoly', 'Polylines', (ed) => {
      const sel = needSelection(ed);
      if (!sel) return;
      let n = 0;
      const layers = layersOf(sel).filter((l) => l.data.kind === 'gerber');
      ed.edit('Explode Polylines', layers, () => {
        for (const l of layers) {
          const g = l.data as GerberLayer;
          for (const { i } of sel.filter((s) => s.layer === l)) {
            const o = g.objects[i]!;
            if (o.kind === 'region') {
              // A polygon's outline as lines of the current D-code
              l.erased = [...new Set([...(l.erased ?? []), i])];
              g.objects.push(...regionDraws(o, currentAperture(ed, l, g)));
              n++;
            } else if (o.grp && l.groups?.get(o.grp)?.kind === 'polyline') { const { grp: _g, ...r } = o; g.objects[i] = r as GerberObject; n++; }
          }
          for (const [k, gr] of [...(l.groups ?? [])]) if (gr.kind === 'polyline' && !groupMembers(l, k).length) l.groups!.delete(k);
        }
      });
      ed.clearSelection();
      camEdited();
      notify(n ? `${n} object${n === 1 ? '' : 's'} exploded` : 'Select polylines or polygons');
    }),
    cmd('BonusTextExplode', 'Text', (ed) => {
      const groups = ed.selectedGroups().filter(({ layer, grp }) => { const k = layer.groups?.get(grp)?.kind; return k === 'text' || k === 'drilltext' || k === 'dimension'; });
      if (!groups.length) { notify('Select text first'); return; }
      ed.edit('Explode Text', layersOf(groups), () => {
        for (const { layer, grp } of groups) {
          const list: { grp?: number }[] = layer.data.kind === 'gerber' ? layer.data.objects : layer.data.hits;
          list.forEach((o, i) => { if (o.grp === grp) { const { grp: _g, ...r } = o; list[i] = r; } });
          layer.groups!.delete(grp);
        }
      });
      ed.clearSelection();
      camEdited();
    }),
    cmd('EditExplodeCustom', 'Custom Apertures', (ed) => {
      const sel = ed.selectedObjects();
      const pool = sel.length ? sel : ed.layer ? liveObjects(ed.layer).map(({ i }) => ({ layer: ed.layer!, li: ed.doc.current, i })) : [];
      const targets = pool.filter((s) => { if (s.layer.data.kind !== 'gerber') return false; const o = s.layer.data.objects[s.i]!; return o.kind === 'flash' && s.layer.data.apertures.get(o.ap)?.shape === 'M'; });
      if (!targets.length) { notify('No custom-aperture flashes to explode'); return; }
      ed.edit('Explode Custom Apertures', layersOf(targets), () => {
        for (const { layer, i } of targets) {
          const g = layer.data as GerberLayer, o = g.objects[i] as Extract<GerberObject, { kind: 'flash' }>;
          layer.erased = [...new Set([...(layer.erased ?? []), i])];
          g.objects.push(...flashRegions(o, g.apertures.get(o.ap)!));
        }
      });
      ed.clearSelection();
      camEdited();
      notify(`${targets.length} flash${targets.length === 1 ? '' : 'es'} exploded`);
    }),
    // Vertices
    cmd('EditVertexAdd', 'Add', (ed) => ed.setTool(new PickTool(ed, 'cam-vertex-add', 'Vertex › Add: click an edge of a polygon (or a line) where the new vertex goes', (_h, _at, raw) => {
      if (!addVertexAt(ed, raw, 8 / (ed.viewport?.cam.scale ?? 1))) notify('Click on an edge of a polygon or a line');
    }))),
    cmd('EditVertexDelete', 'Delete', (ed) => ed.setTool(new PickTool(ed, 'cam-vertex-delete', 'Vertex › Delete: click a vertex of a polygon or polyline', (_h, _at, raw) => {
      const v = vertexAt(ed, raw, 8 / (ed.viewport?.cam.scale ?? 1));
      if (!v) { notify('Click a vertex'); return; }
      let ok = true;
      ed.edit('Delete Vertex', [v.layer], () => { ok = v.del(); });
      if (!ok) notify('A polygon keeps three vertices; a polyline vertex joins two lines');
      camEdited();
    }))),
    cmd('EditVertexMove', 'Move', (ed) => {
      let grabbed: ReturnType<typeof vertexAt> = null;
      ed.setTool(new PointsTool(ed, {
        id: 'cam-vertex-move', count: 1, repeat: true, hint: () => (grabbed ? 'Vertex › Move: click where it goes' : 'Vertex › Move: click a vertex of a polygon or polyline'),
        preview: (_p, c) => (grabbed ? { segments: [{ a: grabbed.pos, b: c, width: 0, color: PREVIEW }] } : null),
        done: ([p]) => {
          if (!grabbed) { grabbed = vertexAt(ed, p!, 8 / (ed.viewport?.cam.scale ?? 1)); if (!grabbed) notify('Click a vertex'); return; }
          const v = grabbed;
          grabbed = null;
          ed.edit('Move Vertex', [v.layer], () => v.move(p!));
          camEdited();
        },
      }));
    }),
    // Step and repeat
    cmd('EditModifyStep', 'Modify', (ed) => {
      const blk = blockOfSelection(ed);
      if (!blk) return;
      const { l, g, st } = blk;
      ask('Modify Step/Repeat', [
        { key: 'nx', label: 'Repeats in X', kind: 'number', value: st.nx, min: 1, max: 1000 },
        { key: 'ny', label: 'Repeats in Y', kind: 'number', value: st.ny, min: 1, max: 1000 },
        { key: 'dx', label: 'Step in X', kind: 'length', value: st.dx },
        { key: 'dy', label: 'Step in Y', kind: 'length', value: st.dy },
      ], (v) => {
        ed.edit('Modify Step/Repeat', [l], () => {
          g.steps = g.steps!.map((s) => (s.id === st.id ? { ...s, nx: Math.round(v.nx as number), ny: Math.round(v.ny as number), dx: v.dx as number, dy: v.dy as number } : s));
          regenerateBlock(l, st.id);
        });
        camEdited();
      });
    }),
    cmd('EditExplode', 'Explode', (ed) => {
      const blk = blockOfSelection(ed);
      if (!blk) return;
      const { l, g, st } = blk;
      ed.edit('Explode Step/Repeat', [l], () => {
        g.objects = g.objects.map((o) => { if (o.sr !== st.id) return o; const { sr: _s, srCopy: _c, ...r } = o; return r as GerberObject; });
        g.steps = g.steps!.filter((s) => s.id !== st.id);
        if (!g.steps.length) delete g.steps;
      });
      camEdited();
    }),
    cmd('EditOpenStep', 'Add Objects', (ed) => {
      const sel = needSelection(ed);
      if (!sel) return;
      const l = sel[0]!.layer;
      if (l.data.kind !== 'gerber' || sel.some((s) => s.layer !== l)) { notify('Select objects of one Gerber layer'); return; }
      const g = l.data;
      const blocks = g.steps ?? [];
      ask('Add Objects to Step/Repeat', [
        { key: 'blk', label: 'Block', kind: 'select', value: blocks[0] ? `Block ${blocks[0].id}` : 'New block', options: [...blocks.map((b) => `Block ${b.id}`), 'New block'] },
        { key: 'nx', label: 'New block: repeats in X', kind: 'number', value: 2, min: 1, max: 1000 },
        { key: 'ny', label: 'New block: repeats in Y', kind: 'number', value: 1, min: 1, max: 1000 },
        { key: 'dx', label: 'New block: step in X', kind: 'length', value: mil(1000) },
        { key: 'dy', label: 'New block: step in Y', kind: 'length', value: mil(1000) },
      ], (v) => {
        ed.edit('Add Objects to Step/Repeat', [l], () => {
          let bid: number;
          if (v.blk === 'New block') { bid = Math.max(0, ...blocks.map((b) => b.id)) + 1; g.steps = [...blocks, { id: bid, nx: Math.round(v.nx as number), ny: Math.round(v.ny as number), dx: v.dx as number, dy: v.dy as number }]; }
          else bid = Number(String(v.blk).replace('Block ', ''));
          for (const { i } of sel) { const o = g.objects[i]!; if (!o.srCopy) g.objects[i] = { ...o, sr: bid }; }
          regenerateBlock(l, bid);
        });
        camEdited();
      });
    }),
    cmd('EditCloseStep', 'Remove Objects', (ed) => {
      const sel = ed.selectedObjects().filter((s) => s.layer.data.kind === 'gerber' && (s.layer.data as GerberLayer).objects[s.i]!.sr && !(s.layer.data as GerberLayer).objects[s.i]!.srCopy);
      if (!sel.length) { notify('Select objects of a step/repeat block (the first copy)'); return; }
      ed.edit('Remove Objects from Step/Repeat', layersOf(sel), () => {
        for (const l of layersOf(sel)) {
          const g = l.data as GerberLayer;
          const ids = new Set<number>();
          for (const { i } of sel.filter((s) => s.layer === l)) { const o = g.objects[i]!; ids.add(o.sr!); const { sr: _s, ...r } = o; g.objects[i] = r as GerberObject; }
          for (const b of ids) regenerateBlock(l, b);
        }
      });
      camEdited();
    }),
  ];
}

/** The step/repeat block of the selected object. */
function blockOfSelection(ed: CamEditor): { l: CamLayer; g: GerberLayer; st: NonNullable<GerberLayer['steps']>[number] } | null {
  for (const s of ed.selectedObjects()) {
    if (s.layer.data.kind !== 'gerber') continue;
    const g = s.layer.data, o = g.objects[s.i]!;
    const st = o.sr ? g.steps?.find((x) => x.id === o.sr) : undefined;
    if (st) return { l: s.layer, g, st };
  }
  notify('Select an object of a step/repeat block (Tables › Steps lists them)');
  return null;
}

/** A whole layer moved, turned or scaled. */
function moveLayer(l: CamLayer, t: Xf): void {
  if (l.data.kind === 'gerber') { const g = l.data; g.objects = g.objects.map((o) => xfObject(o, t, g)); if (g.steps) g.steps = g.steps.map((s) => ({ ...s, dx: s.dx * t.sx, dy: s.dy * t.sy })); }
  else { const d = l.data; d.hits = d.hits.map((h) => xfHit(h, t)); d.routes = d.routes.map((r) => xfRoute(r, t)); }
  if (l.groups) for (const [k, g] of l.groups) l.groups.set(k, xfGroup(g, t));
}

/** Edit › Groups › Automatic / Selective: drawn pads (clusters of draws) made flashes. */
function drawsToFlashes(ed: CamEditor, selective: boolean): void {
  const sel = selective ? ed.selectedObjects() : null;
  if (selective && !sel?.length) { notify('Select the drawn pads first'); return; }
  const layers = selective ? layersOf(sel!) : ed.layer ? [ed.layer] : [];
  let made = 0;
  ed.edit(selective ? 'Draw to Flash (Selective)' : 'Draw to Flash (Automatic)', layers.filter((l) => l.data.kind === 'gerber'), () => {
    for (const l of layers) {
      if (l.data.kind !== 'gerber') continue;
      const g = l.data;
      const pool = (selective ? sel!.filter((s) => s.layer === l).map((s) => ({ o: g.objects[s.i]!, i: s.i })) : liveObjects(l))
        .filter(({ o }) => (o.kind === 'draw' || o.kind === 'arc') && o.dark && !o.grp);
      for (const c of clusters(pool, g)) {
        const objs = c.map((k) => pool[k]!);
        // A lone track is a track: a pad is a cluster of short draws, or a draw no longer than its aperture is wide [est]
        const short = objs.every(({ o }) => { const a = g.apertures.get((o as Draw).ap); const w = a ? Math.max(a.w, a.h) : 0; return o.kind === 'draw' && Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y) <= Math.max(3 * w, 1); });
        if (!short || (!selective && objs.length < 2 && objs.every(({ o }) => o.kind === 'draw' && Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y) > 1))) continue;
        const f = padFromDraws(objs.map(({ o }) => o), g);
        if (!f) continue;
        l.erased = [...new Set([...(l.erased ?? []), ...objs.map(({ i }) => i)])];
        g.objects.push(f);
        made++;
      }
    }
  });
  ed.clearSelection();
  camEdited();
  notify(made ? `${made} pad${made === 1 ? '' : 's'} made flashes` : 'No drawn pads found');
}

