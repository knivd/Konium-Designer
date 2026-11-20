/**
 * 26.040's 3D tools (board and library, in 3D Layout Mode; a click in 2D switches to it):
 * Tools › 3D Body Placement › Add Snap Points From Vertices, Remove Snap Points, Measure
 * Distances, Position 3D Body, Set Body Height, Align Face With Board, Orient And Position 3D
 * Body, Move Texture Location; Design › Board Shape › Define from 3D body; Tools › Measure 3D
 * Objects (Reports › Measure 3D Objects); Reports › Stackup Compatibility Report.
 */
import type { Command, Scope } from '../core/commands';
import { reportOut } from './pcbReports';
import { active, notify, tick } from './state';
import { showDialog } from './dialogs';
import { InfoDialog } from './dialogs/Confirm';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import type { Hit3D } from '../render/gl3d/Viewer3D';
import type { V3 } from '../formats/step/tessellate';
import { UNITS_PER_MM, formatAltiumLength } from '../core/units';
import type { Vec2 } from '../core/geom';
import type { PcbBody, PcbPad } from '../model/pcb';
import { bodyBag, editBodyRecord, placeBody, placementOf, placePoint, rotationBetween, rotationOf, setSnapPoints, snapPoints, turned } from '../model/body3d';
import { setBoardShape } from '../model/pcbBoard';
import { stackupReport } from '../model/stackupReport';
import * as ClipperNS from 'clipper-lib';

type CL = typeof ClipperNS;
const C: CL = (ClipperNS as unknown as { default?: CL }).default ?? ClipperNS;
const BOTH: Scope[] = ['pcb', 'pcblib'];
const anyPcb = () => { const e = active.value?.editor; return e instanceof PcbEditor ? e : null; };
const board = () => { const e = anyPcb(); return e && !(e instanceof PcbLibEditor) ? e : null; };
const on = (fn: (e: PcbEditor) => void) => () => { const e = anyPcb(); if (e) fn(e); };
const fmt = (mm: number) => `${mm.toFixed(3)}mm (${(mm / 0.0254).toFixed(2)}mil)`;

/** Clicks in the 3D view go to `fn` (true: done); 3D Layout Mode is switched on first. */
function pick3d(e: PcbEditor, hint: string, fn: (h: Hit3D) => boolean | void): void {
  if (!e.mode3d) e.set3d(true);
  const v = e.view3d;
  if (!v || v.failed) { notify('This needs 3D Layout Mode, which needs WebGL 2', 'error'); return; }
  v.setPicker(hint, (h) => {
    if (!h) return;
    if (fn(h) === true) v.setPicker(null);
    tick.value++;
  });
  tick.value++;
}

const bodyPrim = (e: PcbEditor, h: Hit3D): PcbBody | null => {
  const r = h.body?.record;
  if (r === undefined) return null;
  return (e.doc.prims.find((p) => p.kind === 'body' && p.src.storage === 'ComponentBodies6' && p.src.index === r) as PcbBody | undefined) ?? null;
};
/** A STEP body clicked: its record, model and placement (else a message). */
function stepTarget(e: PcbEditor, h: Hit3D) {
  const b = bodyPrim(e, h), m = h.body ? e.view3d?.stepModel(h.body) : null, bag = b ? bodyBag(e.doc, b) : null;
  if (!b || !h.body?.step || !m || !bag) { notify(h.body ? 'That body has no STEP model' : 'Click a 3D body', 'error'); return null; }
  return { b, m, bag, body: h.body, pl: placementOf(bag) };
}
/** The point clicked in the body's own axes: its nearest snap point when near one (1 mm), else the corner nearest the click. */
function modelPointOf(e: PcbEditor, h: Hit3D, snapsFirst = true): V3 | null {
  const v = e.view3d;
  if (!v || !h.body) return null;
  const q = v.toModel(h.body, h.p), corner = v.toModel(h.body, h.vertex);
  if (!q || !corner) return null;
  if (snapsFirst) {
    const near = (h.body.step?.snaps ?? []).map((s) => ({ s, d: Math.hypot(s[0] - q[0], s[1] - q[1], s[2] - q[2]) })).sort((a, b) => a.d - b.d)[0];
    if (near && near.d < 1) return near.s;
  }
  return corner;
}
/** A point on the board clicked: a pad's centre within 1 mm, else where it was. */
function boardTarget(e: PcbEditor, h: Hit3D): Vec2 {
  let best: { p: PcbPad; d: number } | null = null;
  for (const p of e.doc.prims) if (p.kind === 'pad') { const d = Math.hypot(p.at.x - h.board.x, p.at.y - h.board.y); if (d < UNITS_PER_MM && (!best || d < best.d)) best = { p, d }; }
  return best ? best.p.at : { x: Math.round(h.board.x), y: Math.round(h.board.y) };
}
const done = (e: PcbEditor, label: string, change: ReturnType<typeof placeBody>) => {
  if (!change) { notify(`${label}: the body's record couldn't be read`, 'error'); return; }
  e.undo.transact(label, (tx) => tx.add(change));
  e.invalidate();
};

/** Align Face With Board: the face clicked turned to lie on the board, the body sat on the surface. */
function alignFace(e: PcbEditor, h: Hit3D): boolean {
  const t = stepTarget(e, h);
  if (!t) return false;
  const nm = e.view3d!.toModelDir(t.body, h.n);
  if (!nm) return false;
  const r = rotationOf(...t.pl.rot);
  const w: V3 = [r[0][0] * nm[0] + r[1][0] * nm[1] + r[2][0] * nm[2], r[0][1] * nm[0] + r[1][1] * nm[1] + r[2][1] * nm[2], r[0][2] * nm[0] + r[1][2] * nm[1] + r[2][2] * nm[2]];
  const l = Math.hypot(...w) || 1;
  let pl = turned(t.pl, rotationBetween([w[0] / l, w[1] / l, w[2] / l], [0, 0, -1]));
  // Sat on the surface: its lowest point at the board
  let zMin = Infinity;
  for (const s of t.m.meshes) for (let i = 0; i < s.pos.length; i += 3) zMin = Math.min(zMin, placePoint({ ...pl, dz: 0 }, [s.pos[i]!, s.pos[i + 1]!, s.pos[i + 2]!]).z);
  pl = { ...pl, dz: -zMin };
  done(e, 'Align face with board', placeBody(e.doc, t.b, t.m, pl));
  return true;
}

/** Position 3D Body: a point of the body (first click), then where it goes on the board (second). */
function positionBody(e: PcbEditor, then?: () => void): void {
  let from: { t: NonNullable<ReturnType<typeof stepTarget>>; p: V3 } | null = null;
  pick3d(e, 'Position 3D Body: click a snap point or corner of the body', (h) => {
    if (!from) {
      const t = stepTarget(e, h), p = t ? modelPointOf(e, h) : null;
      if (!t || !p) return;
      from = { t, p };
      e.view3d?.setPicker('Position 3D Body: click where that point goes on the board (pads snap to their centres)', (h2) => {
        if (!h2 || !from) return;
        const to = boardTarget(e, h2), at = placePoint(from.t.pl, from.p);
        const pl = { ...from.t.pl, at: { x: from.t.pl.at.x + to.x - at.x, y: from.t.pl.at.y + to.y - at.y } };
        done(e, 'Position 3D body', placeBody(e.doc, from.t.b, from.t.m, pl));
        e.view3d?.setPicker(null);
        tick.value++;
        then?.();
      });
      return;
    }
  });
}

/** Define from 3D body: the face clicked (all of it, coplanar triangles together) as the board shape. */
function shapeFromFace(e: PcbEditor, h: Hit3D): boolean {
  const tris = h.coplanar?.() ?? [h.tri];
  const model = e.view3d?.boardModel;
  if (!model) return false;
  const toBoard = (v: V3) => ({ X: Math.round(v[0] * UNITS_PER_MM + model.centre.x), Y: Math.round(v[1] * UNITS_PER_MM + model.centre.y) });
  const c = new C.Clipper();
  for (const t of tris) {
    const path = t.map(toBoard);
    if (Math.abs(C.Clipper.Area(path)) < 1) continue;
    c.AddPath(path, C.PolyType.ptSubject, true);
  }
  const out: ClipperNS.IntPoint[][] = [];
  c.Execute(C.ClipType.ctUnion, out, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  const outer = out.filter((p) => C.Clipper.Orientation(p)).sort((a, b) => Math.abs(C.Clipper.Area(b)) - Math.abs(C.Clipper.Area(a)))[0];
  if (!outer || outer.length < 3) { notify('That face has no area seen from above', 'error'); return false; }
  const clean = C.Clipper.CleanPolygon(outer, 100);
  e.undo.transact('Define board shape from 3D body', (tx) => tx.add(setBoardShape(e.doc, clean.map((p) => ({ p: { x: p.X, y: p.Y } })))));
  e.invalidate();
  notify(`Board shape: ${clean.length} vertices from the face`);
  return true;
}

export function pcb3dCommands(): Command[] {
  const hasStep = () => !!anyPcb()?.doc.prims.some((p) => p.kind === 'body' && p.modelType === 1);
  return [
    { id: 'ad:PCB:AddSTEPSnapPoint', label: 'Add Snap Points From Vertices', scopes: BOTH, enabled: hasStep, run: on((e) => pick3d(e, 'Add Snap Points: click corners of a STEP body (right-click ends)', (h) => {
      const t = stepTarget(e, h), p = t ? modelPointOf(e, h, false) : null;
      if (!t || !p) return;
      const pts = [...snapPoints(t.bag), p];
      const ch = editBodyRecord(e.doc, t.b, (bag) => setSnapPoints(bag, pts));
      if (ch) { e.undo.transact('Add snap point', (tx) => tx.add(ch)); e.invalidate(); }
      notify(`Snap point ${pts.length} at (${p.map((x) => x.toFixed(3)).join(', ')}) mm in the model`);
    })) },
    { id: 'ad:PCB:RemoveSTEPSnapModel', label: 'Remove Snap Points', scopes: BOTH, enabled: hasStep, run: on((e) => pick3d(e, 'Remove Snap Points: click a STEP body', (h) => {
      const t = stepTarget(e, h);
      if (!t) return;
      const n = snapPoints(t.bag).length;
      if (!n) { notify('That body has no snap points'); return true; }
      const ch = editBodyRecord(e.doc, t.b, (bag) => setSnapPoints(bag, []));
      if (ch) { e.undo.transact('Remove snap points', (tx) => tx.add(ch)); e.invalidate(); }
      notify(`${n} snap point${n === 1 ? '' : 's'} removed`);
      return true;
    })) },
    { id: 'ad:PCB:MeasureSTEPSnapDistances', label: 'Measure Distances', scopes: BOTH, enabled: hasStep, run: on((e) => {
      let first: V3 | null = null;
      pick3d(e, 'Measure Distances: click the first snap point or corner', (h) => {
        const p = h.body ? h.vertex : h.p;
        if (!first) { first = p; e.view3d?.setPicker('Measure Distances: click the second', (h2) => { if (h2) { report(first!, h2.body ? h2.vertex : h2.p); e.view3d?.setPicker(null); } }); return; }
      });
    }) },
    { id: 'ad:PCB:Measure3DObjects', label: 'Measure 3D Objects', scopes: ['pcb'], enabled: () => !!board(), run: on((e) => {
      let first: V3 | null = null;
      pick3d(e, 'Measure 3D Objects: click the first point (board or body)', (h) => {
        if (!first) { first = h.p; e.view3d?.setPicker('Measure 3D Objects: click the second point', (h2) => { if (h2) { report(first!, h2.p); e.view3d?.setPicker(null); } }); }
      });
    }) },
    { id: 'ad:PCB:MoveSnapSTEPModel', label: 'Position 3D Body', scopes: BOTH, enabled: hasStep, run: on((e) => positionBody(e)) },
    { id: 'ad:PCB:HeightSnapSTEPModel', label: 'Set Body Height', scopes: BOTH, enabled: hasStep, run: on((e) => pick3d(e, 'Set Body Height: click the point of the body that rests on the board', (h) => {
      const t = stepTarget(e, h), p = t ? modelPointOf(e, h) : null;
      if (!t || !p) return;
      const z = placePoint(t.pl, p).z;
      done(e, 'Set body height', placeBody(e.doc, t.b, t.m, { ...t.pl, dz: t.pl.dz - z }));
      return true;
    })) },
    { id: 'ad:PCB:OrientFace', label: 'Align Face With Board', scopes: BOTH, enabled: hasStep, run: on((e) => pick3d(e, 'Align Face With Board: click the face of the body that rests on the board', (h) => alignFace(e, h))) },
    { id: 'ad:PCB:FullSnapSTEPModel', label: 'Orient And Position 3D Body', scopes: BOTH, enabled: hasStep, run: on((e) => pick3d(e, 'Orient And Position 3D Body: click the face that rests on the board', (h) => {
      if (!alignFace(e, h)) return;
      // Then where it goes, once the 3D view has the new placement
      setTimeout(() => positionBody(e), 250);
      return true;
    })) },
    { id: 'ad:PCB:MoveTextureLocation', label: 'Move Texture Location', scopes: BOTH, enabled: () => !!anyPcb(), run: on((e) => {
      const textured = e.doc.prims.filter((p): p is PcbBody => p.kind === 'body' && !!bodyBag(e.doc, p)?.get('TEXTURE')?.trim());
      if (!textured.length) { notify('No 3D body here has a texture to move'); return; }
      let body: PcbBody | null = null;
      pick3d(e, 'Move Texture Location: click a textured body', (h) => {
        if (!body) {
          const b = bodyPrim(e, h);
          if (!b || !textured.includes(b)) { notify('Click a body with a texture', 'error'); return; }
          body = b;
          e.view3d?.setPicker('Move Texture Location: click the texture\'s new centre', (h2) => {
            if (!h2 || !body) return;
            const ch = editBodyRecord(e.doc, body, (bag) => { bag.set('TEXTURECENTERX', formatAltiumLength(Math.round(h2.board.x))); bag.set('TEXTURECENTERY', formatAltiumLength(Math.round(h2.board.y))); });
            if (ch) { e.undo.transact('Move texture location', (tx) => tx.add(ch)); e.invalidate(); }
            e.view3d?.setPicker(null);
          });
        }
      });
    }) },
    { id: 'ad:PCB:RedefineBoardShapeFromFace', label: 'Define from 3D body', scopes: ['pcb'], enabled: () => !!board()?.doc.prims.some((p) => p.kind === 'body'), run: on((e) => pick3d(e, 'Define from 3D body: click the face of a body that gives the board its shape', (h) => {
      if (!h.body) { notify('Click a face of a 3D body', 'error'); return; }
      return shapeFromFace(e, h);
    })) },
    { id: 'ad:PCB:ReportLayerStackupCompatibility', label: 'Stackup Compatibility Report', scopes: ['pcb'], enabled: () => !!board()?.doc.board.bag, run: on((e) => {
      reportOut('stackup', 'Stackup Compatibility', stackupReport(e.doc), e);
    }) },
  ];
}

function report(a: V3, b: V3): void {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  showDialog(InfoDialog, { title: 'Distance', lines: [`Distance: ${fmt(d)}`, `X: ${fmt(Math.abs(b[0] - a[0]))}`, `Y: ${fmt(Math.abs(b[1] - a[1]))}`, `Z: ${fmt(Math.abs(b[2] - a[2]))}`] });
}

