import RBush from 'rbush';
import { Emitter } from '../core/events';
import { UndoStack } from '../core/undo';
import type { Scope } from '../core/commands';
import type { Tool, ToolOverlay, ToolPointer } from '../core/tools';
import { capsule, snapPt, union, emptyBox, triangulateWithHoles, type BBox, type Vec2 } from '../core/geom';
import { Scene, css, rgba, type DrawGroup, type Pattern } from '../render/Scene';
import { Viewport, type ViewportClient } from '../render/Viewport';
import type { GridSpec, Tint } from '../render/gl/Renderer';
import { hexToRgb, settings } from '../core/settings';

/** Something drawable and pickable. Adapters emit these while building the scene. */
export interface HitItem {
  key: string;                       // selection identity (several items may share one)
  /** Selected along with this key too (a component's designator and comment). */
  group?: string;
  bbox: BBox;
  test(p: Vec2, tol: number): boolean;
  draw(scene: Scene, g: DrawGroup, rgbaV: number): void;
  /** Its outline alone (a selection not highlighted in full). */
  outline?(scene: Scene, g: DrawGroup, rgbaV: number): void;
  layer?: number;
  net?: number;
  order: number;                     // larger = on top when picking
}

interface Entry extends BBox { item: HitItem }

/** What live highlighting lights: items filled (alpha), outlined (outlineAlpha), and textured (locked ones). */
export interface LiveHighlight { items: HitItem[]; alpha: number; colour: number; outlines?: HitItem[]; outlineAlpha?: number; textured?: HitItem[]; texture?: Pattern }

export interface PropRow {
  label: string;
  value: string;
  edit?: (v: string) => void;
  /** 'bool' shows a check box (value 'true'/'false'); 'multiline' a text area; 'enum' a list. */
  kind?: 'text' | 'bool' | 'multiline' | 'enum';
  options?: [string, string][];
}
/** An editing handle of the selected object (vertex, corner). */
export interface Grip { at: Vec2; key: string; index: number }

/** Mask Level (the strip at the bottom right): how faded filtered-out objects are, 0 clear … 1 invisible; every editor's. */
export const maskLevel = { dim: 0.75 };

export interface PropSection { title: string; rows: PropRow[]; raw?: Record<string, string> }


/**
 * Base editor: owns the viewport, undo stack, selection, spatial index and active tool.
 * Subclasses build the scene (and hit items) from their document model.
 */
export abstract class Editor implements ViewportClient {
  abstract readonly scope: Scope;
  readonly undo = new UndoStack();
  readonly changed = new Emitter<void>();
  /** The cursor moved (only what shows its position needs redrawing). */
  readonly moved = new Emitter<void>();
  viewport: Viewport | null = null;
  selection = new Set<string>();
  tool: Tool;
  get cursorColour(): string { return settings.selectionColour; }
  gridAbove?: string;
  gridIndex = 0;
  cursor: Vec2 = { x: 0, y: 0 };

  private sceneCache: Scene | null = null;
  private overlayCache: Scene | null = null;
  /** Version compare: objects drawn in colours of their own (added, removed, changed), under the selection. */
  private diffMarks: Map<string, number> | null = null;
  setDiffMarks(m: Map<string, number> | null): void { this.diffMarks = m && m.size ? m : null; this.invalidateOverlay(); }
  private tree: RBush<Entry> | null = null;
  protected items: HitItem[] = [];

  constructor(protected selectTool: Tool) {
    this.tool = selectTool;
    this.undo.changed.on(() => this.invalidate());
    this.undo.around = (fn) => this.aroundEdit(fn);
  }

  /** Calls into the tool are counted: the tool's own edits (its commit) leave it as it is. */
  private toolCalls = 0;
  protected viaTool<T>(fn: () => T): T { this.toolCalls++; try { return fn(); } finally { this.toolCalls--; } }
  /**
   * An edit, undo or redo from outside the tool (a command, a panel): the tool's preview records
   * step out while it runs, and an operation in progress that holds the document's objects is
   * dropped after it changed the document.
   */
  private aroundEdit<T>(fn: () => T): T {
    if (this.toolCalls) return fn();
    const t = this.tool, rev = this.undo.revision;
    const r = this.withToolSuspended(fn);
    if (this.tool === t && t.abort && this.undo.revision !== rev) { this.viaTool(() => t.abort!()); this.invalidateOverlay(); }
    return r;
  }

  /* ── to implement ── */
  protected abstract build(scene: Scene, emit: (item: HitItem) => void): void;
  abstract origin(): Vec2;
  abstract gridSizes(): number[];
  abstract grid(): GridSpec | null;
  abstract properties(): PropSection[];
  /** Shown in Properties when nothing is selected (Altium's document options). */
  abstract documentProperties(): PropSection[];
  /** Set by the app: right-click in select mode opens the context menu. */
  contextMenu: ((p: ToolPointer) => void) | null = null;
  /** Set by the app: double-click on an object opens its properties (dialog or panel). */
  editObject: ((key: string, p: ToolPointer) => void) | null = null;
  /** Set by the app: a Yes / No question (Altium's Confirm box); without one the answer is Yes. */
  confirm: (message: string, onYes: () => void) => void = (_m, onYes) => onYes();
  abstract deleteSelection(): void;
  abstract title(): string;

  /* ── lifecycle ── */
  private savedCam: { cx: number; cy: number; scale: number } | undefined;

  /** Show the document in a host element (one view at a time: a view elsewhere, in another window or pane, closes first). */
  mount(el: HTMLElement): void {
    if (this.viewport) this.unmount();
    this.viewport = new Viewport(el, this, this.savedCam);
  }
  /** Close the view (only if it is still the one in `el`: it may have moved to another window meanwhile). */
  unmount(el?: HTMLElement): void {
    if (el && this.viewport && this.viewport.host.parentElement !== el) return;
    const c = this.viewport?.cam;
    // A viewport that never got a real layout keeps nothing: the next mount fits the document
    if (c && this.viewport?.laidOut) this.savedCam = { cx: c.cx, cy: c.cy, scale: c.scale };
    this.viewport?.dispose();
    this.viewport = null;
  }

  invalidate(): void {
    this.sceneCache = null;
    this.tree = null;
    this.overlayCache = null;
    this.viewport?.requestRender();
    this.changed.emit();
  }
  invalidateOverlay(): void { this.overlayCache = null; this.viewport?.requestRender(); this.changed.emit(); }

  scene(): Scene {
    if (!this.sceneCache) {
      const s = new Scene(this.origin());
      this.items = [];
      let order = 0;
      this.build(s, (it) => { it.order = order++; this.items.push(it); });
      this.sceneCache = s;
      // Objects removed by an edit or an undo leave the selection
      if (this.selection.size && !this.holdSelection()) {
        const keys = new Set(this.items.map((i) => i.key));
        for (const k of [...this.selection]) if (!keys.has(k)) this.selection.delete(k);
      }
    }
    return this.sceneCache;
  }

  /** True while objects are left out of the scene on purpose (being moved): keep them selected. */
  protected holdSelection(): boolean { return false; }

  private index(): RBush<Entry> {
    if (!this.tree) {
      this.scene();
      this.tree = new RBush<Entry>();
      this.tree.load(this.items.map((item) => ({ ...item.bbox, item })));
    }
    return this.tree;
  }

  /** Items under p, topmost first. */
  hits(p: Vec2, tolPx = 4): HitItem[] {
    const tol = tolPx / (this.viewport?.cam.scale ?? 1);
    return this.index().search({ minX: p.x - tol, minY: p.y - tol, maxX: p.x + tol, maxY: p.y + tol })
      .map((e) => e.item).filter((it) => this.pickable(it) && it.test(p, tol)).sort((a, b) => this.pickRank(b) - this.pickRank(a));
  }
  protected pickable(_it: HitItem): boolean { return true; }
  /** Whether a click or a selection may take the item (layer shown, not masked …). */
  canPick(it: HitItem): boolean { return this.pickable(it); }
  protected pickRank(it: HitItem): number { return it.order; }

  itemsIn(b: BBox, crossing: boolean): HitItem[] {
    const found = this.index().search(b).map((e) => e.item).filter((it) => this.pickable(it));
    if (crossing) return found;
    // Window select: every item sharing the key must be fully enclosed
    const byKey = new Map<string, HitItem[]>();
    for (const it of this.items) { const a = byKey.get(it.key); if (a) a.push(it); else byKey.set(it.key, [it]); }
    const inside = (x: BBox) => x.minX >= b.minX && x.maxX <= b.maxX && x.minY >= b.minY && x.maxY <= b.maxY;
    return found.filter((it) => byKey.get(it.key)!.every((o) => inside(o.bbox)));
  }

  selectionBounds(): BBox {
    let b = emptyBox();
    for (const it of this.items) if (this.isSelected(it)) b = union(b, it.bbox);
    return b;
  }
  isSelected(it: HitItem): boolean { return this.selection.has(it.key) || (!!it.group && this.selection.has(it.group)); }

  /* ── overlay: selection highlight + tool rubber band ── */
  overlay(): Scene | null {
    const toolOv = this.tool.overlay?.();
    // (Comparing: rule violations aren't shown, so the colours are the differences')
    const marks = this.diffMarks ? null : this.marks();
    const grips = this.tool === this.selectTool ? this.grips() : [];
    const spot = this.cursorMarker();
    const live = this.liveHighlight();
    const graph = this.graphLines();
    const align = this.alignLines();
    const diff = this.diffMarks;
    if (!this.selection.size && !toolOv && !this.extraHighlight().size && !marks && !spot && !live && !graph && !align && !diff && !this.liveDraw) return null;
    // Grips are sized in pixels, so they're redrawn at every zoom
    if (this.overlayCache && !toolOv && !grips.length && !spot && !align) return this.overlayCache;
    const s = new Scene(this.origin());
    const m = s.group('marks', -1);
    const g = s.group('highlight', 0);
    const hi = this.extraHighlight();
    if (this.selection.size || hi.size || marks || live || diff) {
      this.scene();
      // Live highlighting: the net under the cursor lit, fading in and out
      if (live) {
        const lg = s.group('live', -0.5);
        for (const it of live.items) it.draw(s, lg, rgba(live.colour, live.alpha));
        for (const it of live.outlines ?? []) it.outline?.(s, lg, rgba(live.colour, live.outlineAlpha ?? live.alpha));
        // Locked objects it lights, textured (Board Insight Display › Show Locked Texture)
        if (live.textured?.length) {
          const tg = s.group('live-locked', -0.4);
          tg.pattern = live.texture;
          for (const it of live.textured) it.draw(s, tg, rgba(0x000000, 0.55));
        }
      }
      if (marks?.pattern) m.pattern = marks.pattern;
      const inFull = this.highlightInFull(), sel = hexToRgb(settings.selectionColour), hiCol = this.highlightColour();
      const dg = diff ? s.group('diff', -0.2) : null;
      // Comparing: the rest dimmed under the differences, so they stand out from copper of their own colour
      if (diff) {
        const b = this.scene().bounds, w = b.maxX - b.minX, h = b.maxY - b.minY;
        if (w > 0 && h > 0) s.rect(s.group('diff-dim', -0.3), { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, w * 1.5, h * 1.5, 0, 0, rgba(0x000000, 0.5));
      }
      for (const it of this.items) {
        const dc = diff ? diff.get(it.key) ?? (it.group ? diff.get(it.group) : undefined) : undefined;
        if (dc !== undefined && !this.isSelected(it)) { it.draw(s, dg!, rgba(dc, 1)); continue; }
        if (this.isSelected(it)) { if (!inFull && it.outline) it.outline(s, g, rgba(sel, 1)); else it.draw(s, g, rgba(sel, 0.75)); }
        else if (hi.has(it)) it.draw(s, g, rgba(hiCol, 0.55));
        else if (marks?.items.has(it.key)) it.draw(s, m, rgba(marks.colour, marks.alpha ?? 0.6));
      }
      // Error marker: a cross at each violation (15 mil arms, as a DRC detail marker)
      for (const c of marks?.points ?? []) {
        const d = 150_000, w = 20_000;
        s.segment(m, { x: c.x - d, y: c.y - d }, { x: c.x + d, y: c.y + d }, w, rgba(marks!.pointColour ?? marks!.colour, 1));
        s.segment(m, { x: c.x - d, y: c.y + d }, { x: c.x + d, y: c.y - d }, w, rgba(marks!.pointColour ?? marks!.colour, 1));
      }
    }
    // Navigation's connection graph: the navigated net's objects joined by lines
    if (graph) { const gr = s.group('graph', 1.5); for (const [a, b] of graph) s.segment(gr, a, b, 0, rgba(0xc000c0, 0.9), 1.5); }
    if (grips.length) {
      const gg = s.group('grips', 2);
      const px = 1 / (this.viewport?.cam.scale ?? 1);
      const c = rgba(hexToRgb(settings.selectionColour), 1);
      for (const gr of grips) {
        s.rect(gg, gr.at, 8 * px, 8 * px, 0, 0, c);
        s.rect(gg, gr.at, 5 * px, 5 * px, 0, 0, rgba(0xffffff, 1));
      }
    }
    if (toolOv) {
      if (toolOv.polys?.length) {
        const under = s.group('tool-areas', 0.5);
        for (const p of toolOv.polys) { const tri = triangulateWithHoles(p.outline, p.holes); s.polygon(under, tri.pts, tri.idx, rgba(p.color, p.alpha ?? 0.3)); }
      }
      const t = s.group('tool', 1);
      const px = 1 / (this.viewport?.cam.scale ?? 1);
      for (const seg of toolOv.segments ?? []) {
        if (seg.hollow) s.polyline(t, capsule(seg.a, seg.b, seg.width / 2), px, rgba(seg.color, 1), true);
        else s.segment(t, seg.a, seg.b, seg.width, rgba(seg.color, 1));
      }
      for (const c of toolOv.circles ?? []) s.circle(t, c.c, c.r, rgba(c.color, 1));
      for (const l of toolOv.labels ?? []) {
        s.text(t, l.at, { text: l.text, size: (l.px ?? 12) * px, rot: 0, color: css(l.color), h: 1, v: 1 });
      }
    }
    if (spot) {
      // The electrical hot spot under the cursor: Altium's red cross
      const px = 1 / (this.viewport?.cam.scale ?? 1), d = 6 * px, c = rgba(0xff0000, 1);
      const hs = s.group('hotspot', 3);
      s.segment(hs, { x: spot.x - d, y: spot.y - d }, { x: spot.x + d, y: spot.y + d }, 2 * px, c);
      s.segment(hs, { x: spot.x - d, y: spot.y + d }, { x: spot.x + d, y: spot.y - d }, 2 * px, c);
    }
    // Lines from what the cursor lines up with (a board's Snap To Object Axis)
    if (align) { const ag = s.group('align', 2.5); for (const [a, b] of align) s.segment(ag, a, b, 0, rgba(0x4fc3f7, 0.9), 1); }
    // What moves over the document (Live Simulation): drawn afresh each time
    if (this.liveDraw) this.liveDraw(s, 1 / (this.viewport?.cam.scale ?? 1));
    if (!toolOv && !grips.length && !spot && !align && !this.liveDraw) this.overlayCache = s;
    return s;
  }
  /** Drawn over the document by whoever sets it, afresh at every frame (Live Simulation's voltages and currents); `px` is a screen pixel in the document's units. */
  liveDraw: ((s: Scene, px: number) => void) | null = null;
  /** The overlay drawn again (a frame of something that moves). */
  refreshOverlay(): void { this.redrawOverlay(); }
  /** A point to mark under the cursor (the schematic's electrical hot spot). */
  protected cursorMarker(): Vec2 | null { return null; }
  /** Lines from the objects the cursor is lined up with to where it is. */
  protected alignLines(): [Vec2, Vec2][] | null { return null; }
  /** Handles of the selected object; dragging one reshapes it. */
  grips(): Grip[] { return []; }
  gripAt(p: Vec2, tolPx = 6): Grip | null {
    const tol = tolPx / (this.viewport?.cam.scale ?? 1);
    let best: Grip | null = null, bd = Infinity;
    for (const g of this.grips()) { const d = Math.max(Math.abs(g.at.x - p.x), Math.abs(g.at.y - p.y)); if (d <= tol && d < bd) { best = g; bd = d; } }
    return best;
  }
  /** Items to highlight besides the selection (e.g. a net). */
  protected extraHighlight(): Set<HitItem> { return new Set(); }
  /** What the cursor lights up as it passes (the board's live highlighting), and how strongly now; locked objects among them textured. */
  protected liveHighlight(): LiveHighlight | null { return null; }
  /** Lines drawn over the document joining what navigation went to (System › Navigation › Connection Graph). */
  protected graphLines(): [Vec2, Vec2][] | null { return null; }
  /** Selected objects filled in the selection colour (or, where they can be, outlined). */
  protected highlightInFull(): boolean { return true; }
  /** The overlay drawn again, nothing else told (a fade's frames). */
  protected redrawOverlay(): void { this.overlayCache = null; this.viewport?.requestRender(); }
  /** Rule violations: item keys drawn in the marker colour, and a cross at each location. */
  protected marks(): { items: Set<string>; points: Vec2[]; colour: number; pointColour?: number; alpha?: number; pattern?: Pattern } | null { return null; }
  /** What a highlighted net (or other highlighted objects) is drawn in. */
  protected highlightColour(): number { return 0xffffff; }

  tints(): Map<string, Tint> | undefined { return undefined; }

  /* ── grid / snapping ── */
  /** A snap grid set from a menu that isn't one of the presets (Snap Grid › 20 mil …). */
  customGrid: number | null = null;
  /** View › Grids › Toggle Visible Grid. */
  gridVisible = true;
  gridSize(): number { if (this.customGrid) return this.customGrid; const g = this.gridSizes(); return g[this.gridIndex % g.length]!; }
  /** G / Shift+G: next or previous preset snap grid. */
  cycleGrid(dir: 1 | -1 = 1): void {
    const n = this.gridSizes().length;
    this.customGrid = null;
    this.gridIndex = (this.gridIndex + dir + n) % n;
    this.invalidateOverlay();
  }
  setGrid(size: number): void {
    const i = this.gridSizes().indexOf(size);
    if (i >= 0) { this.gridIndex = i; this.customGrid = null; } else this.customGrid = size;
    this.invalidateOverlay();
  }
  /** The grid as drawn (none while View › Grids › Toggle Visible Grid has it off). */
  shownGrid(): GridSpec | null { return this.gridVisible ? this.grid() : null; }

  /* ── views: View › Zoom Last returns to the one before ── */
  private views: { cx: number; cy: number; scale: number }[] = [];
  /** Remember the view before a jump (fit, area, selection …). */
  pushView(): void {
    const c = this.viewport?.cam;
    if (c) { this.views.push({ cx: c.cx, cy: c.cy, scale: c.scale }); if (this.views.length > 20) this.views.shift(); }
  }
  zoomLast(): boolean {
    const v = this.views.pop(), c = this.viewport?.cam;
    if (!v || !c) return false;
    c.cx = v.cx; c.cy = v.cy; c.scale = v.scale;
    this.viewport?.requestRender();
    this.changed.emit();
    return true;
  }
  snap(p: Vec2): Vec2 {
    const o = this.origin();
    const s = snapPt({ x: p.x - o.x, y: p.y - o.y }, this.gridSize());
    return { x: s.x + o.x, y: s.y + o.y };
  }

  /* ── tools ── */
  setTool(t: Tool | null): void {
    this.viaTool(() => {
      this.tool.deactivate?.();
      this.tool = t ?? this.selectTool;
      this.tool.activate?.();
    });
    // A tool at work (placing, moving, routing): floating panels may go see-through (System › Transparency)
    if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-tool-at-work', this.tool !== this.selectTool);
    this.invalidateOverlay();
  }
  /** Run fn with the active tool's preview records out of the document (undo, redo, save). */
  withToolSuspended<T>(fn: () => T): T {
    const t = this.tool;
    this.viaTool(() => t.suspend?.());
    try { return fn(); } finally { if (this.tool === t) this.viaTool(() => t.resume?.()); }
  }
  toolKey(combo: string): boolean {
    if (this.viaTool(() => this.tool.key?.(combo))) { this.invalidateOverlay(); return true; }
    if (combo === 'Escape' && this.tool !== this.selectTool) { this.setTool(null); return true; }
    return false;
  }

  /* ── ViewportClient ── */
  pointerDown(p: ToolPointer): void { this.viaTool(() => this.tool.pointerDown?.(p)); this.invalidateOverlay(); }
  pointerMove(p: ToolPointer): void { const t = this.tool; if (t.pointerMove) { this.viaTool(() => t.pointerMove!(p)); if (this.tool.overlay) this.viewport?.requestRender(); } }
  pointerUp(p: ToolPointer, moved: boolean): void { const t = this.tool; if (t.pointerUp) { this.viaTool(() => t.pointerUp!(p, moved)); this.invalidateOverlay(); } }
  /** No command in hand: the pointer selects. */
  get selecting(): boolean { return this.tool === this.selectTool; }
  /** What the last right-click was over (the right-click menu's "… Actions" follow it). */
  contextKey: string | null = null;
  /** Where the last right-click was (document units, before the grid's snap). */
  contextAt: Vec2 = { x: 0, y: 0 };
  rightClick(p: ToolPointer): void {
    if (this.tool !== this.selectTool) { if (!this.viaTool(() => this.tool.cancel?.())) this.setTool(null); this.invalidateOverlay(); return; }
    const hit = this.hits(p.raw)[0];
    this.contextKey = hit?.key ?? null;
    this.contextAt = p.raw;
    if (hit && !this.selection.has(hit.key)) this.select([hit.key]);
    this.contextMenu?.(p);
  }
  /** Ctrl+double-click: an editor's own meaning (the schematic goes down or up its hierarchy); true when it acted. */
  ctrlDoubleClick?: (p: ToolPointer) => boolean;
  doubleClick(p: ToolPointer): void {
    if (this.tool !== this.selectTool || p.button !== 0) return;
    if (p.ctrl && this.ctrlDoubleClick?.(p)) return;
    const hit = this.hits(p.raw)[0];
    if (hit) this.editObject?.(hit.key, p);
  }
  wantsDrag(p: ToolPointer): boolean { return this.tool === this.selectTool && !this.gripAt(p.raw) && this.hits(p.raw).length === 0; }
  boxSelect(b: BBox, crossing: boolean): void {
    this.selection = new Set(this.normaliseSelection(this.itemsIn(b, crossing).map((i) => i.key), crossing));
    this.invalidateOverlay();
  }
  /** Area selections, made whole: a PCB component is selected with all its primitives or not at all. */
  normaliseSelection(keys: string[], _crossing: boolean): string[] { return keys; }
  /** Edit › Select › Outside Area: everything not touching the box. */
  outsideArea(b: BBox): string[] {
    this.scene();
    const touching = new Set(this.itemsIn(b, true).map((i) => i.key));
    return this.normaliseSelection([...new Set(this.items.filter((i) => this.pickable(i) && !touching.has(i.key)).map((i) => i.key))], false);
  }
  /** Edit › Select › Touching Line: what the line from a to b crosses. */
  touchingLine(a: Vec2, b: Vec2): string[] {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const step = 2 / (this.viewport?.cam.scale ?? 1);
    const n = Math.max(1, Math.ceil(len / step));
    const keys = new Set<string>();
    for (let i = 0; i <= n; i++) for (const h of this.hits({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }, 1)) keys.add(h.key);
    return this.normaliseSelection([...keys], true);
  }
  /**
   * Edit › Find Similar Objects: every object (as the keys that select it) with the attributes
   * the dialog compares — Object Kind first.
   */
  similarObjects(): { keys: string[]; attrs: Record<string, string> }[] { return []; }
  /** Everything drawn and pickable (for commands that filter by layer, net …). */
  allItems(): readonly HitItem[] { this.scene(); return this.items; }
  /** All pickable keys (Select All, Toggle). */
  allKeys(): string[] { this.scene(); return [...new Set(this.items.filter((i) => this.pickable(i)).map((i) => i.key))]; }
  cursorMoved(w: Vec2): void { this.cursor = w; this.moved.emit(); }

  select(keys: Iterable<string>, add = false): void {
    if (!add) this.selection.clear();
    for (const k of keys) { if (add && this.selection.has(k)) this.selection.delete(k); else this.selection.add(k); }
    this.invalidateOverlay();
  }
  selectAll(): void { this.selection = new Set(this.allKeys()); this.invalidateOverlay(); }
  clearSelection(): void { this.selection.clear(); this.invalidateOverlay(); }
  fit(): void { this.pushView(); this.viewport?.fitBox(this.fitBounds()); }
  /** View › Fit Document, and the view a document opens with. Every object by default. */
  fitBounds(): BBox { return this.objectBounds(); }
  /** Everything pickable, ignoring the sheet/board frame. */
  objectBounds(): BBox {
    this.scene();
    let b = emptyBox();
    for (const it of this.items) b = union(b, it.bbox);
    return b;
  }
  /** Fit everything drawn, ignoring the sheet/board frame. */
  fitObjects(): void {
    this.pushView();
    const b = this.objectBounds();
    if (b.minX <= b.maxX) this.viewport?.fitBox(b);
  }
  /** Bounds of what these selection keys draw. */
  boundsOf(keys: Iterable<string>): BBox {
    this.scene();
    const set = new Set(keys);
    let b = emptyBox();
    for (const it of this.items) if (set.has(it.key) || (it.group && set.has(it.group))) b = union(b, it.bbox);
    return b;
  }
  /** Zoom to a box; `minSize` keeps a small object from filling the window. */
  zoomToBox(b: BBox, minSize = 0): void {
    if (!(b.minX <= b.maxX)) return;
    this.pushView();
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const hw = Math.max((b.maxX - b.minX) / 2, minSize / 2), hh = Math.max((b.maxY - b.minY) / 2, minSize / 2);
    this.viewport?.fitBox({ minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh });
  }
  /** Jump to the selection (cross-probe, Find, panels): zoom to it; a schematic with Auto Zoom off only pans. */
  jumpToSelection(minSize = 0): void { this.fitSelection(minSize); }
  /** Zoom to the selection; `minSize` keeps a small object from filling the window (cross-probing). */
  fitSelection(minSize = 0): void {
    this.pushView();
    this.scene();
    const b = this.selectionBounds();
    if (!(b.minX <= b.maxX)) return;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const hw = Math.max((b.maxX - b.minX) / 2, minSize / 2), hh = Math.max((b.maxY - b.minY) / 2, minSize / 2);
    this.viewport?.fitBox({ minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh });
  }

  /** Tool hint for the status bar. */
  hint(): string { return this.tool.hint(); }
}

/** Plain selection tool: click picks topmost, Shift adds, drag on empty space box-selects. */
export class SelectTool implements Tool {
  readonly id = 'select';
  editor!: Editor;
  hint(): string { return 'Click to select, drag across empty space for an area, Shift+click to add'; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const hit = this.editor.hits(p.raw)[0];
    if (!hit) { if (!p.shift) this.editor.clearSelection(); return; }
    this.editor.select([hit.key], p.shift);
  }
}

export type AreaMode = 'inside' | 'outside' | 'touchingRect' | 'touchingLine';

/**
 * Edit › Select › Inside Area / Outside Area / Touching Rectangle / Touching Line: click the
 * first corner (or start), click the second; the selection replaces the old one (Shift adds).
 */
export class AreaSelectTool implements Tool {
  readonly id = 'select-area';
  private a: Vec2 | null = null;
  private b: Vec2 | null = null;
  /** onKeys: what the area picked goes here instead of into the selection (Edit › DeSelect). */
  constructor(private ed: Editor, private mode: AreaMode, private onKeys?: (keys: string[]) => void) {}
  hint(): string {
    const what = { inside: 'Select Inside Area', outside: 'Select Outside Area', touchingRect: 'Select Touching Rectangle', touchingLine: 'Select Touching Line' }[this.mode];
    return `${what}: click the ${this.a ? (this.mode === 'touchingLine' ? 'end of the line' : 'opposite corner') : (this.mode === 'touchingLine' ? 'start of the line' : 'first corner')}`;
  }
  pointerMove(p: ToolPointer): void { this.b = p.raw; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.a) { this.a = p.raw; this.b = p.raw; return; }
    const a = this.a, b = p.raw;
    const box = { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
    const keys = this.mode === 'inside' ? this.ed.normaliseSelection(this.ed.itemsIn(box, false).map((i) => i.key), false)
      : this.mode === 'touchingRect' ? this.ed.normaliseSelection(this.ed.itemsIn(box, true).map((i) => i.key), true)
      : this.mode === 'outside' ? this.ed.outsideArea(box)
      : this.ed.touchingLine(a, b);
    if (this.onKeys) this.onKeys(keys);
    else if (p.shift) for (const k of keys) this.ed.selection.add(k); else this.ed.selection = new Set(keys);
    this.ed.setTool(null);
  }
  cancel(): boolean { if (this.a) { this.a = null; return true; } return false; }
  overlay(): ToolOverlay | null {
    if (!this.a || !this.b) return null;
    const c = hexToRgb(settings.selectionColour), a = this.a, b = this.b;
    if (this.mode === 'touchingLine') return { segments: [{ a, b, width: 0, color: c }] };
    const cs = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    return { segments: cs.map((p, i) => ({ a: p, b: cs[(i + 1) % 4]!, width: 0, color: c })) };
  }
}

/** Edit › Select › Toggle Selection: each click flips an object in or out of the selection. */
export class ToggleSelectTool implements Tool {
  readonly id = 'select-toggle';
  constructor(private ed: Editor, private keysFor: (key: string) => string[] = (k) => [k]) {}
  hint(): string { return 'Toggle Selection: click objects to add or remove them; right-click to finish'; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const hit = this.ed.hits(p.raw)[0];
    if (!hit) return;
    const keys = this.keysFor(hit.key);
    const all = keys.every((k) => this.ed.selection.has(k));
    for (const k of keys) { if (all) this.ed.selection.delete(k); else this.ed.selection.add(k); }
    this.ed.invalidateOverlay();
  }
}

/** A one-click prompt (Select › Net, Move › Polygon Vertices …): returns true when done. */
export class PickTool implements Tool {
  readonly id = 'pick';
  constructor(private ed: Editor, private prompt: string, private onPick: (p: ToolPointer) => boolean, private repeat = false) {}
  hint(): string { return this.prompt; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (this.onPick(p) && !this.repeat) this.ed.setTool(null);
    this.ed.invalidateOverlay();
  }
}

/** View › Area (Zoom › Window): click two corners; the view fits them. */
export class ZoomAreaTool implements Tool {
  readonly id = 'zoom-area';
  private a: Vec2 | null = null;
  private b: Vec2 | null = null;
  constructor(private ed: Editor) {}
  hint(): string { return this.a ? 'Zoom Area: click the opposite corner' : 'Zoom Area: click the first corner'; }
  pointerMove(p: ToolPointer): void { this.b = p.raw; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.a) { this.a = p.raw; this.b = p.raw; return; }
    const a = this.a, b = p.raw;
    if (a.x !== b.x && a.y !== b.y) { this.ed.pushView(); this.ed.viewport?.fitBox({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) }); }
    this.ed.setTool(null);
  }
  cancel(): boolean { if (this.a) { this.a = null; return true; } return false; }
  overlay(): ToolOverlay | null {
    if (!this.a || !this.b) return null;
    const c = hexToRgb(settings.selectionColour), a = this.a, b = this.b;
    const cs = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    return { segments: cs.map((p, i) => ({ a: p, b: cs[(i + 1) % 4]!, width: 0, color: c })) };
  }
}
