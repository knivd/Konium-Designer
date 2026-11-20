import { Camera } from './Camera';
import { Renderer, type GridSpec, type Tint } from './gl/Renderer';
import { CanvasRenderer } from './gl/canvasRenderer';
import { TextLayer } from './TextLayer';
import type { Scene } from './Scene';
import type { BBox, Vec2 } from '../core/geom';
import type { ToolPointer } from '../core/tools';
import { settings, settingsChanged, wheelAction } from '../core/settings';

export interface ViewportClient {
  scene(): Scene;
  overlay(): Scene | null;
  grid(): GridSpec | null;
  shownGrid?(): GridSpec | null;
  gridAbove?: string;
  tints?(): Map<string, Tint> | undefined;
  hiddenText?(key: string): boolean;
  /** A square in the corner that changes colour at each redraw (Show Repaint Indicator). */
  repaintIndicator?: () => boolean;
  /** Text drawn hard-edged, not smoothed (PCB › Display › Antialiased Text off). */
  hardText?(): boolean;
  /** The colour an area being dragged out to select is shaded (null: outlined only). */
  areaShade?(): string | null;
  /** The heads-up display's lines, drawn beside the cursor (on a dark panel if asked). */
  hud?(): { lines: string[]; background: boolean } | null;
  snap(p: Vec2): Vec2;
  /** Where the cursor lands (grid, or an electrical hot spot nearby); snap() when absent. */
  snapPointer?(p: Vec2): Vec2;
  pointerDown(p: ToolPointer): void;
  pointerMove(p: ToolPointer): void;
  /** Right click without drag. */
  rightClick(p: ToolPointer): void;
  doubleClick?(p: ToolPointer): void;
  /** Rubber-band selection finished (left drag on empty space). */
  boxSelect?(b: BBox, crossing: boolean): void;
  cursorMoved?(world: Vec2): void;
  wantsDrag?(p: ToolPointer): boolean;
  /** Left button released (not after a box selection). */
  pointerUp?(p: ToolPointer, moved: boolean): void;
  cursorColour: string;
  /** What Fit Document shows (the sheet, every object …); the drawn scene's extent otherwise. */
  fitBounds?(): BBox;
  /** Auto pan while placing or moving: how the view follows the cursor past the window edge (null: not now). */
  autoPan?(): AutoPan | null;
}

/** Told once a session: the editors draw without WebGL 2 (listeners: the app's notice). */
export const webGlFallback = { reason: '' as string, listeners: new Set<(reason: string) => void>() };
function noWebGl(e: Error): void {
  if (webGlFallback.reason) return;
  webGlFallback.reason = e.message || 'WebGL 2 is not available';
  for (const l of webGlFallback.listeners) l(webGlFallback.reason);
}

/** Preferences › Graphical Editing › Auto Pan Options. Speed 1–10; steps in screen px. */
export interface AutoPan {
  style: 'off' | 'jump' | 'recenter' | 'speed'; speed: number; step: number; shiftStep: number;
  /** 'speed': world units a second; Shift faster or slower, or gathering speed the longer it pans (Ballistic). */
  worldSpeed?: number; shift?: 'faster' | 'slower'; ballistic?: boolean;
}

/**
 * Canvas host + navigation, Altium-style:
 *   wheel = scroll vertically, Shift+wheel = horizontally, Ctrl+wheel / pinch = zoom at cursor
 *   (or wheel = zoom when Preferences › wheel is set to zoom),
 *   right-drag or middle-drag = pan, right-click = cancel / step back.
 */
export class Viewport {
  private snapP(w: Vec2): Vec2 { return this.client.snapPointer ? this.client.snapPointer(w) : this.client.snap(w); }
  readonly cam = new Camera();
  readonly host: HTMLElement;
  private glCanvas: HTMLCanvasElement;
  private textCanvas: HTMLCanvasElement;
  private renderer: Renderer | CanvasRenderer;
  private text: TextLayer;
  private frame = 0;
  private ro: ResizeObserver;
  private offSettings: () => void = () => {};
  private dpr = 1;
  private cursorScreen: Vec2 | null = null;
  /** The mouse over the view, as last seen. */
  private mouseScreen: Vec2 | null = null;
  /**
   * The crosshair was put somewhere by keys or a tool (moveCursorBy, cursorTo) with the mouse at `mouse`: a browser
   * can't move the pointer, so until the mouse really moves a click lands on the crosshair, not under the pointer.
   */
  private kb: { mouse: Vec2 | null } | null = null;
  private drag: { button: number; start: Vec2; last: Vec2; moved: boolean; box: boolean } | null = null;
  private disposed = false;
  /** Fit to content on first real layout. Cleared when a saved camera is restored. */
  autoFitPending = true;
  /**
   * After the first fit, keep the document fitted while the layout settles (docks and panels
   * appearing around a newly opened document) until the user zooms or pans, or a second passes.
   */
  private fitSticky = 0;

  constructor(parent: HTMLElement, private client: ViewportClient, restore?: { cx: number; cy: number; scale: number }) {
    if (restore) { this.autoFitPending = false; Object.assign(this.cam, restore); }
    this.host = document.createElement('div');
    this.host.className = 'viewport';
    this.glCanvas = document.createElement('canvas');
    this.textCanvas = document.createElement('canvas');
    this.textCanvas.className = 'viewport-text';
    this.host.append(this.glCanvas, this.textCanvas);
    this.host.tabIndex = 0;
    parent.append(this.host);
    // No WebGL 2 (turned off, or the graphics driver blocked, as on many Windows 7 computers): the 2D canvas draws instead
    try { this.renderer = new Renderer(this.glCanvas, settings.smoothEdges); } catch (e) {
      const fresh = document.createElement('canvas');
      this.glCanvas.replaceWith(fresh);
      this.glCanvas = fresh;
      this.renderer = new CanvasRenderer(fresh);
      noWebGl(e as Error);
    }
    this.text = new TextLayer(this.textCanvas);
    // The canvas's own device pixels where the browser tells them (a fractional display scaling,
    // 125 % or 150 %, then draws pixel for pixel instead of stretching the picture a little)
    this.ro = new this.win.ResizeObserver((entries) => this.resize(entries[0]?.devicePixelContentBoxSize?.[0]));
    try { this.ro.observe(this.host, { box: 'device-pixel-content-box' }); } catch { this.ro.observe(this.host); }
    this.offSettings = settingsChanged.on((patch) => { if ('smoothEdges' in patch) this.rebuildRenderer(); });
    this.resize();
    this.bind();
    this.watchDpr();
  }

  /** The window the view is in (a document window's, when its document moved there): its frames, pixel ratio and sizes. */
  private get win(): Window & typeof globalThis { return (this.host.ownerDocument.defaultView ?? window) as Window & typeof globalThis; }
  /** The window moved to a screen of another pixel density (or the page was zoomed): sharp again. */
  private watchDpr(): void {
    const w = this.win;
    if (typeof w.matchMedia === 'undefined') return;
    const mq = w.matchMedia(`(resolution: ${w.devicePixelRatio || 1}dppx)`);
    mq.addEventListener?.('change', () => { if (this.disposed) return; this.resize(); this.watchDpr(); }, { once: true });
  }

  get worldCursor(): Vec2 | null { return this.cursorScreen ? this.cam.toWorld(this.cursorScreen) : null; }

  dispose(): void {
    this.disposed = true;
    this.stopPan();
    try { this.win.cancelAnimationFrame(this.frame); } catch { /* its window closed */ }
    this.ro.disconnect();
    this.offSettings();
    this.renderer.dispose();
    this.host.remove();
  }

  /** Smoothing switched on or off: a new drawing context (multisampling is fixed when a context is made). */
  private rebuildRenderer(): void {
    if (this.disposed || !(this.renderer instanceof Renderer)) return;
    const fresh = document.createElement('canvas');
    fresh.width = this.glCanvas.width; fresh.height = this.glCanvas.height;
    try {
      const r = new Renderer(fresh, settings.smoothEdges);
      this.renderer.dispose();
      this.glCanvas.replaceWith(fresh);
      this.glCanvas = fresh;
      this.renderer = r;
      this.requestRender();
    } catch { /* keep the one there is */ }
  }

  private resize(device?: { inlineSize: number; blockSize: number }): void {
    const r = this.host.getBoundingClientRect();
    this.dpr = this.win.devicePixelRatio || 1;
    let w = Math.max(1, Math.round(r.width * this.dpr)), h = Math.max(1, Math.round(r.height * this.dpr));
    // Only when it agrees with the pixel ratio (an emulated ratio reports CSS pixels there)
    if (device && device.inlineSize > 0 && device.blockSize > 0 && r.width > 0 && Math.abs(device.inlineSize - r.width * this.dpr) <= 2 && Math.abs(device.blockSize - r.height * this.dpr) <= 2) {
      w = device.inlineSize; h = device.blockSize;
      // The scale that maps CSS pixels onto these device pixels exactly
      this.dpr = w / r.width;
    }
    for (const c of [this.glCanvas, this.textCanvas]) { c.width = w; c.height = h; }
    this.cam.width = Math.max(1, r.width);
    this.cam.height = Math.max(1, r.height);
    if (this.autoFitPending && r.width > 1 && r.height > 1) { this.autoFitPending = false; this.fit(); this.fitSticky = performance.now() + 1000; }
    else if (this.fitSticky && performance.now() < this.fitSticky && r.width > 1 && r.height > 1) this.fit();
    this.requestRender();
  }

  /** The user took over the view: stop following layout changes. */
  private navigated(): void { this.fitSticky = 0; }
  /** True once the document has been fitted to a real layout. */
  get laidOut(): boolean { return !this.autoFitPending; }

  fit(): void { this.cam.fit(this.client.fitBounds?.() ?? this.client.scene().bounds); this.requestRender(); }
  /** Centre the view on a world point, keeping the zoom (Auto Zoom off: a jump only pans). */
  centreOn(p: Vec2): void { this.navigated(); this.cam.centreOn(p); this.requestRender(); }
  /** The camera, to remember and put back (the library editor's Remember last zoom). */
  get view(): { cx: number; cy: number; scale: number } { return { cx: this.cam.cx, cy: this.cam.cy, scale: this.cam.scale }; }
  set view(v: { cx: number; cy: number; scale: number }) { this.navigated(); Object.assign(this.cam, v); this.requestRender(); }

  /* ── auto pan ── */
  private panTimer = 0;
  private panDir = { x: 0, y: 0 };
  private panShift = false;
  private panStart = 0;
  private panLast = 0;
  private stopPan(): void { if (this.panTimer) { clearInterval(this.panTimer); this.panTimer = 0; } }
  /** The cursor at (or past) the window edge while a tool wants it: scroll that way until it leaves the edge. */
  private edgePan(s: Vec2, shift: boolean): void {
    const cfg = this.client.autoPan?.();
    const m = 12;
    const dx = s.x < m ? 1 : s.x > this.cam.width - m ? -1 : 0;
    const dy = s.y < m ? 1 : s.y > this.cam.height - m ? -1 : 0;
    if (!cfg || cfg.style === 'off' || (!dx && !dy)) { this.stopPan(); return; }
    this.panDir = { x: dx, y: dy };
    this.panShift = shift;
    if (!this.panTimer) { this.panStart = this.panLast = performance.now(); this.panTimer = window.setInterval(() => this.panTick(), cfg.style === 'speed' ? 30 : Math.max(25, Math.round(500 / Math.max(1, cfg.speed)))); }
  }
  private panTick(): void {
    const cfg = this.client.autoPan?.();
    const s = this.cursorScreen;
    if (!cfg || cfg.style === 'off' || !s || this.disposed) { this.stopPan(); return; }
    this.navigated();
    const now = performance.now(), dt = Math.min(200, now - this.panLast);
    this.panLast = now;
    if (cfg.style === 'recenter') {
      // The point under the cursor goes to the middle of the window
      const w = this.cam.toWorld(s);
      this.cam.centreOn(w);
    } else if (cfg.style === 'speed') {
      // So many world units a second whatever the zoom: Shift faster or slower; Ballistic gathers speed
      const k = cfg.shift === 'faster' && this.panShift ? 3 : cfg.shift === 'slower' && this.panShift ? 1 / 3 : cfg.ballistic ? Math.min(8, 1 + (now - this.panStart) / 600) : 1;
      const px = Math.max(1, ((cfg.worldSpeed ?? 0) * k * dt) / 1000 * this.cam.scale);
      this.cam.panScreen(this.panDir.x * px, this.panDir.y * px);
    } else {
      const step = this.panShift ? cfg.shiftStep : cfg.step;
      this.cam.panScreen(this.panDir.x * step, this.panDir.y * step);
    }
    const raw = this.cam.toWorld(s);
    const p: ToolPointer = { world: this.snapP(raw), raw, button: 0, shift: this.panShift, ctrl: false, alt: false };
    this.client.pointerMove(p);
    this.client.cursorMoved?.(raw);
    this.requestRender();
  }
  fitBox(b: BBox): void { this.navigated(); this.cam.fit(b); this.requestRender(); }

  zoomStep(inward: boolean, at?: Vec2): void {
    this.navigated();
    const s = at ?? this.cursorScreen ?? { x: this.cam.width / 2, y: this.cam.height / 2 };
    this.cam.zoomAt(s, inward ? settings.zoomStep : 1 / settings.zoomStep);
    this.requestRender();
  }

  /**
   * Keyboard cursor (Altium's arrow keys): move the cursor by (dx, dy) world units from where
   * it is (the snapped point), scrolling the view to keep it inside; tools see a pointer move.
   * Browsers can't move the mouse pointer, so the crosshair moves and the next mouse move takes over.
   */
  moveCursorBy(dx: number, dy: number): void {
    const from = this.cursorScreen ? this.snapP(this.cam.toWorld(this.cursorScreen)) : this.snapP(this.cam.toWorld({ x: this.cam.width / 2, y: this.cam.height / 2 }));
    this.cursorTo({ x: from.x + dx, y: from.y + dy }, false);
  }

  /** Put the cursor on a world point (Jump); off screen, the view centres on it (or always, with centre). */
  cursorTo(w: Vec2, centre = false): void {
    let s = this.cam.toScreen(w);
    const m = 24;
    if (centre || s.x < m || s.y < m || s.x > this.cam.width - m || s.y > this.cam.height - m) {
      if (centre) this.cam.centreOn(w);
      else {
        // Scroll just enough, as Altium's auto-pan does at the window edge
        const dx = s.x < m ? m - s.x : s.x > this.cam.width - m ? this.cam.width - m - s.x : 0;
        const dy = s.y < m ? m - s.y : s.y > this.cam.height - m ? this.cam.height - m - s.y : 0;
        this.cam.panScreen(dx, dy);
      }
      s = this.cam.toScreen(w);
    }
    this.cursorScreen = s;
    this.kb = { mouse: this.mouseScreen };
    const p: ToolPointer = { world: this.snapP(w), raw: w, button: 0, shift: false, ctrl: false, alt: false };
    this.client.pointerMove(p);
    this.client.cursorMoved?.(w);
    this.requestRender();
  }

  /** Enter: a click where the cursor is. */
  clickAtCursor(): void {
    if (!this.cursorScreen) return;
    const raw = this.cam.toWorld(this.cursorScreen);
    const p: ToolPointer = { world: this.snapP(raw), raw, button: 0, shift: false, ctrl: false, alt: false };
    this.client.pointerDown(p);
    this.client.pointerUp?.(p, false);
    this.requestRender();
  }

  /** Zoom to an absolute scale (px per world unit) about the cursor, or the view centre. */
  zoomTo(scale: number): void {
    this.navigated();
    const s = this.cursorScreen ?? { x: this.cam.width / 2, y: this.cam.height / 2 };
    this.cam.zoomAt(s, scale / this.cam.scale);
    this.requestRender();
  }

  /** Zoom by a factor about the cursor (Shift+PgUp / PgDn take small steps). */
  zoomBy(factor: number): void {
    this.navigated();
    this.cam.zoomAt(this.cursorScreen ?? { x: this.cam.width / 2, y: this.cam.height / 2 }, factor);
    this.requestRender();
  }

  centreOnCursor(): void {
    const w = this.worldCursor;
    if (w) { this.cam.centreOn(w); this.requestRender(); }
  }

  requestRender(): void {
    if (this.frame || this.disposed) return;
    this.frame = this.win.requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  /** Synchronous render (for screenshots / tests). */
  render(): void {
    const scene = this.client.scene();
    // The overlay once a frame (a tool's look-ahead is built in it)
    const ov = this.client.overlay();
    this.renderer.draw(scene, this.cam, this.dpr, {
      grid: this.client.shownGrid ? this.client.shownGrid() : this.client.grid(), gridAbove: this.client.gridAbove, tints: this.client.tints?.(), overlay: ov ?? undefined,
    });
    this.text.clear();
    this.text.hardText = !!this.client.hardText?.();
    this.text.drawScene(scene, this.cam, this.dpr, this.client.hiddenText);
    if (ov) this.text.drawScene(ov, this.cam, this.dpr);
    if (this.drag?.box) this.text.rubberBand(this.drag.start, this.drag.last, this.dpr, this.client.cursorColour, this.client.areaShade?.());
    if (this.cursorScreen) {
      const snapped = this.cam.toScreen(this.snapP(this.cam.toWorld(this.cursorScreen)));
      this.text.crosshair(snapped, this.dpr, this.client.cursorColour, settings.cursor === 'large');
    }
    const hud = this.cursorScreen ? this.client.hud?.() : null;
    if (hud && this.cursorScreen) this.text.hud(hud.lines, this.cursorScreen, this.dpr, hud.background);
    if (this.client.repaintIndicator?.()) this.text.repaintMark(this.dpr, (this.repaints = (this.repaints + 1) % 2) === 0 ? '#e5484d' : '#3cb371');
    this.afterRender?.();
  }
  /** Called after each frame (the compare view keeps the other side at this one's place and zoom). */
  afterRender: (() => void) | null = null;
  private repaints = 0;

  private pointer(e: PointerEvent | MouseEvent): ToolPointer {
    const r = this.host.getBoundingClientRect();
    // The crosshair the keys put somewhere stands in for the mouse until it moves
    const s = this.kb && this.cursorScreen ? this.cursorScreen : { x: e.clientX - r.left, y: e.clientY - r.top };
    const raw = this.cam.toWorld(s);
    return { world: this.snapP(raw), raw, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
  }

  private bind(): void {
    const h = this.host;
    h.addEventListener('contextmenu', (e) => e.preventDefault());
    h.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.navigated();
      const r = h.getBoundingClientRect();
      const s = { x: e.clientX - r.left, y: e.clientY - r.top };
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.cam.height : 1;
      const act = wheelAction(e);
      // A wheel notch (100 px, or 3 lines) scrolls Preferences' step; a trackpad's fine movement scrolls as it moves
      const notchy = e.deltaMode === 1 || e.deltaMode === 2 || Math.abs(e.deltaY || e.deltaX) >= 50;
      const k = notchy ? settings.wheelScrollPx / (e.deltaMode === 1 ? 3 * 16 : e.deltaMode === 2 ? this.cam.height : 100) : 1;
      if (act === 'none') return;
      if (act === 'zoom') this.cam.zoomAt(s, Math.pow(settings.zoomStep, (-(e.deltaY || e.deltaX) * unit) / 100));
      else if (act === 'hscroll') this.cam.panScreen(-(e.deltaY || e.deltaX) * unit * k, 0);
      else this.cam.panScreen(-e.deltaX * unit * k, -e.deltaY * unit * k);
      this.requestRender();
    }, { passive: false });

    h.addEventListener('pointerdown', (e) => {
      h.focus({ preventScroll: true });
      h.setPointerCapture(e.pointerId);
      const r = h.getBoundingClientRect();
      const s = { x: e.clientX - r.left, y: e.clientY - r.top };
      const p = this.pointer(e);
      if (e.button === 0) {
        const box = !!this.client.wantsDrag?.(p);
        this.drag = { button: 0, start: s, last: s, moved: false, box };
        if (!box) this.client.pointerDown(p);
      } else {
        this.drag = { button: e.button, start: s, last: s, moved: false, box: false };
      }
    });

    h.addEventListener('pointermove', (e) => {
      const r = h.getBoundingClientRect();
      const s = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.mouseScreen = s;
      if (this.kb) {
        // A move of a pixel or two (a press, a jittery mouse) leaves the crosshair where the keys put it
        const m = this.kb.mouse;
        if (m && Math.hypot(s.x - m.x, s.y - m.y) <= 2) return;
        this.kb = null;
      }
      this.cursorScreen = s;
      const d = this.drag;
      if (d) {
        if (Math.hypot(s.x - d.start.x, s.y - d.start.y) > 4) d.moved = true;
        if (d.button === 1 || d.button === 2) { this.navigated(); this.cam.panScreen(s.x - d.last.x, s.y - d.last.y); }
        d.last = s;
      }
      const p = this.pointer(e);
      this.client.pointerMove(p);
      this.client.cursorMoved?.(p.raw);
      this.edgePan(s, e.shiftKey);
      this.requestRender();
    });

    h.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.button === 2 && !d.moved) this.client.rightClick(this.pointer(e));
      if (d.button === 0 && d.box && d.moved) {
        const a = this.cam.toWorld(d.start), b = this.cam.toWorld(d.last);
        // Left→right drag = window (enclosed only); right→left = crossing
        this.client.boxSelect?.({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) }, d.last.x < d.start.x);
      } else if (d.button === 0 && d.box && !d.moved) {
        this.client.pointerDown(this.pointer(e));
      } else if (d.button === 0 && !d.box) {
        this.client.pointerUp?.(this.pointer(e), d.moved);
      }
      this.requestRender();
    });

    // The system took the pointer away mid-press (a gesture, a dialog of its own): the press ends
    // where it is, as a release would end it (a drag-move lets go), with no click or box made of it
    h.addEventListener('pointercancel', (e) => {
      const d = this.drag;
      this.drag = null;
      this.stopPan();
      if (d && d.button === 0 && !d.box) this.client.pointerUp?.(this.pointer(e), d.moved);
      this.requestRender();
    });

    h.addEventListener('dblclick', (e) => this.client.doubleClick?.(this.pointer(e)));
    h.addEventListener('pointerleave', () => { if (!this.drag) { this.stopPan(); this.cursorScreen = null; this.mouseScreen = null; this.kb = null; } this.requestRender(); });
  }

  /** Expose for screenshot tooling. */
  get canvases(): [HTMLCanvasElement, HTMLCanvasElement] { return [this.glCanvas, this.textCanvas]; }
}
