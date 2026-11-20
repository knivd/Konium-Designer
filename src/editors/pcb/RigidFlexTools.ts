/**
 * Board Planning Mode's tools, as AD17's: Design › Define Split Line (click near an edge — the
 * line starts at the nearest point of a region's outline — then towards the other side: it runs
 * to the outline it meets, blue where it would cut a region, red where it wouldn't, a red click
 * dropping it), Delete Split Line (click a split line; its two regions become one), Define
 * Bending Line (the same in a flex region). The tools stay for more until right-click or Esc.
 * Advanced Rigid-Flex: Design › Slice Board Region (the same, across one region: it becomes two),
 * a region's vertices dragged by their handles. Coverlay: Design › Place Coverlay Polygon and
 * Place Coverlay Cutout (an outline drawn on a flex region with a coverlay layer).
 */
import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import { distToSegment, pointInPoly } from '../../core/geom';
import { mil } from '../../core/units';
import { notify } from '../../app/state';
import { BEND_DEFAULTS, addSplit, boardRegions, chordAcross, interiorPoint, moveRegionVertex, moveSplit, removeSplit, setRigidFlex, sliceRegion, snapToLoops, splitLines, substacks, withRegion, type RigidFlex } from '../../model/rigidFlex';
import { coverlayLayers, customCoverlayShapes, regionHasCoverlay } from '../../model/coverlay';
import type { PcbEditor } from './PcbEditor';

const BLUE = 0x3d7bff, RED = 0xff3030, ORANGE = 0xff9a2e;

abstract class LineTool implements Tool {
  abstract readonly id: string;
  protected start: Vec2 | null = null;
  protected hover: Vec2 | null = null;
  constructor(protected ed: PcbEditor) { if (!ed.planning) ed.setPlanning(true); }
  /** The outlines the line runs between. */
  protected abstract loops(at: Vec2): Vec2[][];
  /** Whether the line from a to b can go in (and, when it can't, why). */
  protected abstract check(a: Vec2, b: Vec2): string | null;
  protected abstract commit(a: Vec2, b: Vec2): void;
  protected abstract what: string;
  protected colour = BLUE;

  private end(): Vec2 | null {
    if (!this.start || !this.hover) return null;
    return chordAcross(this.loops(this.start), this.start, this.hover);
  }
  hint(): string {
    if (!this.start) return `${this.what}: click near the edge it starts from (right-click or Esc to finish)`;
    const e = this.end();
    const why = e ? this.check(this.start, e) : 'move across the region';
    return `${this.what}: click towards the other side${why ? ` — ${why}` : ''}`;
  }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.start) {
      const loops = this.loops(p.world);
      if (!loops.length) { notify(`${this.what}: click on the board`, 'error'); return; }
      this.start = snapToLoops(loops, p.world).pt;
      return;
    }
    this.hover = p.world;
    const e = this.end();
    // A red line is dropped
    if (e && !this.check(this.start, e)) this.commit(this.start, e);
    this.start = null;
    this.ed.invalidate();
  }
  pointerMove(p: ToolPointer): void { this.hover = p.world; }
  cancel(): boolean { if (!this.start) return false; this.start = null; return true; }
  key(combo: string): boolean {
    if (combo === 'Escape') { if (this.start) this.start = null; else this.ed.setTool(null); return true; }
    return false;
  }
  overlay(): ToolOverlay | null {
    const px = 1 / (this.ed.viewport?.cam.scale ?? 1);
    if (!this.start) {
      if (!this.hover) return null;
      const loops = this.loops(this.hover);
      if (!loops.length) return null;
      const s = snapToLoops(loops, this.hover).pt;
      return { circles: [{ c: s, r: 5 * px, color: this.colour }, { c: s, r: 3 * px, color: 0xffffff }] };
    }
    const e = this.end() ?? this.hover ?? this.start;
    const ok = !!this.end() && !this.check(this.start, e);
    const c = ok ? this.colour : RED;
    return { segments: [{ a: this.start, b: e, width: mil(8), color: c }], circles: [{ c: this.start, r: 5 * px, color: c }, { c: e, r: 5 * px, color: c }] };
  }
}

/** Design › Define Split Line. */
export class SplitLineTool extends LineTool {
  readonly id = 'splitLine';
  protected what = 'Define Split Line';
  protected loops(): Vec2[][] { return boardRegions(this.ed.doc).map((r) => r.outline); }
  protected check(a: Vec2, b: Vec2): string | null { return addSplit(this.ed.doc, a, b) ? null : "that wouldn't cut a region in two"; }
  protected commit(a: Vec2, b: Vec2): void {
    const f = addSplit(this.ed.doc, a, b);
    if (f) this.ed.undo.transact('Define split line', (tx) => tx.add(setRigidFlex(this.ed.doc, f)));
  }
}

/** Design › Define Bending Line: only in a region on a flex stack. */
export class BendingLineTool extends LineTool {
  readonly id = 'bendingLine';
  protected what = 'Define Bending Line';
  protected override colour = ORANGE;
  private region(at: Vec2): number {
    const regs = boardRegions(this.ed.doc);
    const inside = regs.findIndex((r) => pointInPoly(at, r.outline));
    if (inside >= 0) return inside;
    let best = -1, d = Infinity;
    regs.forEach((r, i) => { const s = snapToLoops([r.outline], at); if (s.d < d) { d = s.d; best = i; } });
    return best;
  }
  private flex(i: number): boolean {
    const r = boardRegions(this.ed.doc)[i], subs = substacks(this.ed.doc);
    return !!r && !!subs.find((s) => s.id === r.stackId)?.isFlex;
  }
  protected loops(at: Vec2): Vec2[][] {
    const r = boardRegions(this.ed.doc)[this.region(at)];
    return r ? [r.outline] : [];
  }
  protected check(a: Vec2, b: Vec2): string | null {
    const i = this.region({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    return this.flex(i) ? null : 'a bending line only goes in a region on a flex layer stack (Layer Stack Manager › Is Flex)';
  }
  override pointerDown(p: ToolPointer): void {
    if (p.button === 0 && !this.start && !this.flex(this.region(p.world))) { notify('A bending line only goes in a region on a flex layer stack: set one in the Layer Stack Manager (Is Flex), then the region\'s Layer Stack', 'error'); return; }
    super.pointerDown(p);
  }
  protected commit(a: Vec2, b: Vec2): void {
    const i = this.region({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), r = boardRegions(this.ed.doc)[i];
    if (!r) return;
    const top = Math.max(0, ...r.bends.map((l) => l.foldIndex));
    const f = withRegion(this.ed.doc, i, { bends: [...r.bends, { a, b, ...BEND_DEFAULTS, foldIndex: r.bends.length ? top + 1 : BEND_DEFAULTS.foldIndex }] });
    this.ed.undo.transact('Define bending line', (tx) => tx.add(setRigidFlex(this.ed.doc, f)));
  }
}

/** Design › Delete Split Line: click the lines to go. */
export class DeleteSplitLineTool implements Tool {
  readonly id = 'deleteSplitLine';
  private hover: Vec2 | null = null;
  constructor(private ed: PcbEditor) { if (!ed.planning) ed.setPlanning(true); }
  private at(p: Vec2): number {
    const tol = mil(10) + 6 / (this.ed.viewport?.cam.scale ?? 1);
    return splitLines(this.ed.doc).findIndex((l) => distToSegment(p, l.a, l.b) <= tol);
  }
  hint(): string { return splitLines(this.ed.doc).length ? 'Delete Split Line: click a split line (right-click or Esc to finish)' : 'Delete Split Line: the board has no split lines (Esc to finish)'; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const i = this.at(p.raw);
    if (i < 0) return;
    const f = removeSplit(this.ed.doc, i);
    if (f) this.ed.undo.transact('Delete split line', (tx) => tx.add(setRigidFlex(this.ed.doc, f)));
    this.ed.invalidate();
  }
  pointerMove(p: ToolPointer): void { this.hover = p.raw; }
  cancel(): boolean { return false; }
  key(combo: string): boolean { if (combo === 'Escape') { this.ed.setTool(null); return true; } return false; }
  overlay(): ToolOverlay | null {
    const i = this.hover ? this.at(this.hover) : -1;
    const l = splitLines(this.ed.doc)[i];
    return l ? { segments: [{ a: l.a, b: l.b, width: mil(10), color: RED }] } : null;
  }
}

/**
 * A split or bending line's end dragged (its handle, in Board Planning Mode): a split line's end
 * slides along the board's edge or another split line, a bending line's along its region's
 * outline; blue where the line still works, red where it doesn't (dropped there, it stays as it was).
 */
export class LineEndTool implements Tool {
  readonly id = 'lineEnd';
  private at: Vec2 | null = null;
  constructor(private ed: PcbEditor, private what: string, private end: 0 | 1) {}
  private line(): { a: Vec2; b: Vec2 } | undefined {
    if (this.what.startsWith('split:')) return splitLines(this.ed.doc)[Number(this.what.slice(6))];
    const [r, j] = this.what.slice(5).split(':').map(Number);
    return boardRegions(this.ed.doc)[r!]?.bends[j!];
  }
  private loops(): Vec2[][] {
    if (this.what.startsWith('split:')) {
      const i = Number(this.what.slice(6));
      return [this.ed.doc.board.outline, ...splitLines(this.ed.doc).filter((_, k) => k !== i).map((l) => [l.a, l.b])];
    }
    const r = boardRegions(this.ed.doc)[Number(this.what.slice(5).split(':')[0])];
    return r ? [r.outline] : [];
  }
  private result(): RigidFlex | null {
    const l = this.line();
    if (!l || !this.at) return null;
    const a = this.end === 0 ? this.at : l.a, b = this.end === 1 ? this.at : l.b;
    if (this.what.startsWith('split:')) return moveSplit(this.ed.doc, Number(this.what.slice(6)), a, b);
    const [r, j] = this.what.slice(5).split(':').map(Number);
    const reg = boardRegions(this.ed.doc)[r!];
    if (!reg || Math.hypot(b.x - a.x, b.y - a.y) < mil(5)) return null;
    return withRegion(this.ed.doc, r!, { bends: reg.bends.map((x, k) => (k === j ? { ...x, a, b } : x)) });
  }
  hint(): string { return 'Drag the end along the outline; release to place it (red: it wouldn\'t work there)'; }
  pointerMove(p: ToolPointer): void { this.at = snapToLoops(this.loops(), p.world).pt; }
  pointerUp(): void {
    const f = this.result();
    if (f) this.ed.undo.transact(this.what.startsWith('split:') ? 'Move split line' : 'Move bending line', (tx) => tx.add(setRigidFlex(this.ed.doc, f)));
    this.ed.setTool(null);
    this.ed.invalidate();
  }
  cancel(): boolean { this.ed.setTool(null); return true; }
  key(combo: string): boolean { if (combo === 'Escape') { this.ed.setTool(null); return true; } return false; }
  overlay(): ToolOverlay | null {
    const l = this.line();
    if (!l || !this.at) return null;
    const a = this.end === 0 ? this.at : l.a, b = this.end === 1 ? this.at : l.b;
    const c = this.result() ? (this.what.startsWith('split:') ? BLUE : ORANGE) : RED;
    return { segments: [{ a, b, width: mil(8), color: c }], circles: [{ c: this.at, r: 5 / (this.ed.viewport?.cam.scale ?? 1), color: c }] };
  }
}

/** Design › Slice Board Region (Advanced Rigid-Flex): a line across a region cuts it in two. */
export class SliceRegionTool extends LineTool {
  readonly id = 'sliceRegion';
  protected what = 'Slice Board Region';
  private region(at: Vec2): number {
    const regs = boardRegions(this.ed.doc);
    const inside = regs.map((r, i) => ({ r, i })).filter(({ r }) => pointInPoly(at, r.outline)).sort((a, b) => (b.r.priority ?? 0) - (a.r.priority ?? 0));
    if (inside.length) return inside[0]!.i;
    let best = -1, d = Infinity;
    regs.forEach((r, i) => { const q = snapToLoops([r.outline], at); if (q.d < d) { d = q.d; best = i; } });
    return best;
  }
  private picked = -1;
  protected loops(at: Vec2): Vec2[][] {
    const i = this.start ? this.picked : this.region(at);
    if (!this.start) this.picked = i;
    const r = boardRegions(this.ed.doc)[i];
    return r ? [r.outline] : [];
  }
  protected check(a: Vec2, b: Vec2): string | null { return sliceRegion(this.ed.doc, this.picked, a, b) ? null : "that wouldn't cut the region in two"; }
  protected commit(a: Vec2, b: Vec2): void {
    const f = sliceRegion(this.ed.doc, this.picked, a, b);
    if (f) this.ed.undo.transact('Slice board region', (tx) => tx.add(setRigidFlex(this.ed.doc, f)));
  }
}

/** A region's vertex dragged (Advanced Rigid-Flex; its handle in Board Planning Mode). */
export class RegionVertexTool implements Tool {
  readonly id = 'regionVertex';
  private at: Vec2 | null = null;
  constructor(private ed: PcbEditor, private region: number, private vertex: number) {}
  hint(): string { return 'Drag the region\'s vertex; release to place it'; }
  pointerMove(p: ToolPointer): void { this.at = p.world; }
  pointerUp(): void {
    const f = this.at ? moveRegionVertex(this.ed.doc, this.region, this.vertex, this.at) : null;
    if (f) this.ed.undo.transact('Move region vertex', (tx) => tx.add(setRigidFlex(this.ed.doc, f)));
    this.ed.setTool(null);
    this.ed.invalidate();
  }
  cancel(): boolean { this.ed.setTool(null); return true; }
  key(combo: string): boolean { if (combo === 'Escape') { this.ed.setTool(null); return true; } return false; }
  overlay(): ToolOverlay | null {
    const r = boardRegions(this.ed.doc)[this.region];
    if (!r || !this.at) return null;
    const pts = r.outline.map((p, k) => (k === this.vertex ? this.at! : p));
    return { segments: pts.map((p, k) => ({ a: p, b: pts[(k + 1) % pts.length]!, width: mil(6), color: BLUE })), circles: [{ c: this.at, r: 5 / (this.ed.viewport?.cam.scale ?? 1), color: BLUE }] };
  }
}

/**
 * Place Coverlay Polygon / Cutout: the outline drawn goes to the flex region it lies in, on its
 * coverlay layer on the side in view (the top's, unless the board is flipped), and the region's
 * coverlay becomes custom (starting as the automatic one) [est: the layer in view standing for AD's
 * Coverlay layer tab].
 */
export function addCoverlayShape(ed: PcbEditor, outline: Vec2[], cutout: boolean): string | null {
  const doc = ed.doc, regs = boardRegions(doc);
  const c = interiorPoint(outline);
  const i = regs.map((r, k) => ({ r, k })).filter(({ r }) => pointInPoly(c, r.outline)).sort((a, b) => (b.r.priority ?? 0) - (a.r.priority ?? 0))[0]?.k ?? -1;
  const r = regs[i];
  if (!r) return 'Draw the coverlay on a board region';
  const layers = coverlayLayers(doc).filter((x) => regionHasCoverlay(doc, r, x));
  if (!layers.length) return `${r.name} has no coverlay: put it on a flex layer stack with a Coverlay layer (Layer Stack Manager › right-click › Insert layer above / below › Coverlay)`;
  const want = ed.viewport?.cam.flipX ? 'bottom' : 'top';
  const layer = layers.find((x) => x.side === want) ?? layers[0]!;
  const shapes = r.customCoverlay ? [...(r.coverlays ?? [])] : customCoverlayShapes(doc, r);
  shapes.push({ layer: layer.row.v7, outline, cutout });
  const f = withRegion(doc, i, { customCoverlay: true, coverlays: shapes });
  ed.undo.transact(cutout ? 'Place coverlay cutout' : 'Place coverlay polygon', (tx) => tx.add(setRigidFlex(doc, f)));
  ed.invalidate();
  return null;
}
