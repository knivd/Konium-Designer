import { dimensionEdges, dimensionGeometry, geometryBox, geometryStrokes, removeDimensions, textBox } from '../../model/dimensions';
import { Editor, SelectTool, maskLevel, type HitItem, type LiveHighlight, type PropSection } from '../Editor';
import { polygonName } from '../../formats/altium/polygonProps';
import type { Tool, ToolPointer } from '../../core/tools';
import { PlaceTrackTool } from './PlaceTrackTool';
import { RouteTool } from './RouteTool';
import { PlacePadTool, defaultPad, type PadTemplate } from './PlacePadTool';
import { defaultString, type StringTemplate, type ViaTemplate } from './PcbPlaceTools';
import { connectedCopper, connectionLines, jumperLinks, runDrc, type DrcReport, type DrcViolation } from '../../model/drc';
import { drcSettings } from '../../model/drcOptions';
import { DEG, capsule, distToArc, distToSegment, pointInPoly, rotate, triangulate, triangulateWithHoles, type BBox, type Vec2 } from '../../core/geom';
import { PCB_GRIDS, mil, formatCoord, type DisplayUnit } from '../../core/units';
import { PAT, Scene, css, rgba, type DrawGroup, type Pattern } from '../../render/Scene';
import { hex4, type GridSpec, type Tint } from '../../render/gl/Renderer';
import { L, drawOrder, drawZ, isMech, isPlane, kindZ, layerColour, isSignal, layerName, stackOrder, transparencyKey, type LayerId } from '../../model/layers';
import { barcodeShape } from '../../model/barcode';
import { NO_NET, copperNet, netName, slotEnds, type PadStackLayer, type PcbDocument, type PcbPrim } from '../../model/pcb';
import { ownerOf, removeComponents, removePolygons, removePrims, repour, replaceRecords, setComponentProps, setPolygon } from '../../model/pcbEdit';
import { PcbDragTool, drags } from './PcbDragTool';
import { PcbMoveTool, commitMove, type PcbMoveMode, type PcbMoveSet } from './PcbMoveTool';
import { alignDeltas, type AlignKind } from '../align';
import { emptyBox, union } from '../../core/geom';
import { EDGE_GRIP, PcbGripTool } from './PcbGripTool';
import { LineEndTool, RegionVertexTool } from './RigidFlexTools';
import { notify } from '../../app/state';
import { PlacePolygonTool } from './PlacePolygonTool';
import { PcbPasteTool } from './PcbPasteTool';
import { clipboard, setClipboard, type PcbClip } from '../clipboard';
import { PickTool } from '../Editor';
import { editRegionProps, placement } from '../../formats/altium/pcbTransform';
import { bodyIdentifierValue, detachedText, layerToName, toV7 } from '../../formats/altium/pcbdoc';
import { ARC, PAD, TEXT, TRACK, VIA, put, setViaDiameter, type Field } from '../../formats/altium/pcbLayouts';
import { formatAltiumLength, parseLength } from '../../core/units';
import type { PropertyBag } from '../../formats/altium/props';
import type { PcbRawRecord } from '../../formats/altium/framing';
import type { Grip, PropRow } from '../Editor';
import type { Scope } from '../../core/commands';
import { TRANSPARENCY_STANDARD, TRANSPARENCY_TRANSPARENT, hexToRgb, settings, updateSettings, type Settings } from '../../core/settings';
import { VIEW3D_PRESETS, view3dName } from '../../core/view3d';
import { Viewer3D } from '../../render/gl3d/Viewer3D';
import type { AutoPan } from '../../render/Viewport';
import { componentsIn, editRooms, roomsOf } from '../../model/rooms';
import { componentUnion, unionMembers, unionOf } from '../../model/unions';
import { padShapeGroup } from '../../model/padShapes';
import { selects, type SelectionKind } from './selectionFilter';
import { readGrids, readGuides, snapToGuide, snapToLocalGrid, type Guide, type LocalGrid } from '../../model/gridGuides';
import { extentOf, sheetOf, type Sheet } from '../../model/sheet';
import { specialStrings } from '../../formats/gerber/gerber';
import { planeCopper } from '../../model/planes';
import { testpointMarks } from '../../model/drcMore';
import { describe as describePrim } from '../../model/drc';
import { wireLinks } from '../../model/wireLink';

/** Rooms' colour [est: AD17's lilac]. */
/**
 * Board Planning Mode's colours, as AD17 draws it (sampled from its screen): the design shown
 * underneath in one green, pads and holes grey, everything else a darker grey, on warm grey.
 */
/**
 * A region's triangles, worked out once: by the decoded outline while the board is as it was, else
 * by its record while its corners are the same (a big board's pours aren't triangulated again on
 * every redraw, nor after every edit elsewhere).
 */
const trisByOutline = new WeakMap<object, { pts: Vec2[]; idx: number[] }>();
const trisByRecord = new WeakMap<object, { h: number; tri: { pts: Vec2[]; idx: number[] } }>();
function regionTris(doc: { streams: Map<string, { records: object[] }> }, p: { src: { storage: string; index: number }; outline: Vec2[]; holes: Vec2[][] }): { pts: Vec2[]; idx: number[] } {
  const hit = trisByOutline.get(p.outline);
  if (hit) return hit;
  let h = p.outline.length * 7 + p.holes.length;
  for (const ring of [p.outline, ...p.holes]) for (const q of ring) h = (Math.imul(h, 31) + (q.x | 0) * 17 + (q.y | 0)) | 0;
  const rec = doc.streams.get(p.src.storage)?.records[p.src.index];
  const old = rec ? trisByRecord.get(rec) : undefined;
  const n = p.outline.length + p.holes.reduce((t, x) => t + (x.length >= 3 ? x.length : 0), 0);
  const same = old && old.h === h && old.tri.pts.length === n && [0, n >> 1, n - 1].every((k) => { const a = old.tri.pts[k], q = k < p.outline.length ? p.outline[k] : undefined; return !q || (a?.x === q.x && a?.y === q.y); });
  const tri = same ? old.tri : triangulateWithHoles(p.outline, p.holes);
  if (rec) trisByRecord.set(rec, { h, tri });
  trisByOutline.set(p.outline, tri);
  return tri;
}

const PLAN = { bg: 0x6d6a69, board: 0x597941, edge: 0x6c8c54, copper: 0x3c5d25, offBoard: 0x343434, metal: 0xc0c0c0, other: 0x676767, labels: 0xa9c294, split: 0x3d7bff, bend: 0xff9a2e, flex: 0xe0b040, coverlay: 0xd08a2a } as const;
const ROOM = 0xb48ce6;
/** A selection outlined (Highlight In Full off): pixels wide. */
const OUTLINE_PX = 1.5;
/** Board Insight Display › Show Locked Texture on Objects: sparse dark hatching over locked objects [est: AD's texture]. */
const LOCKED_TEXTURE: Pattern = { id: PAT.locked, cell: mil(6), out: PAT.locked };
/** An arc track's outline: its two edges and round ends. */
function arcOutline(s: Scene, g: DrawGroup, c: Vec2, r: number, start: number, end: number, width: number, col: number): void {
  const hw = width / 2;
  s.arc(g, c, r + hw, start, end, 0, col, OUTLINE_PX);
  if (r - hw > 0) s.arc(g, c, r - hw, start, end, 0, col, OUTLINE_PX);
  if (hw <= 0) return;
  const at = (a: number) => ({ x: c.x + r * Math.cos(a * DEG), y: c.y + r * Math.sin(a * DEG) });
  s.arc(g, at(start), hw, start + 180, start + 360, 0, col, OUTLINE_PX);
  s.arc(g, at(end), hw, end, end + 180, 0, col, OUTLINE_PX);
}
/** What the heads-up display calls each kind of object. */
const HUD_KINDS: Record<string, string> = { body: '3D body', fill: 'fill', region: 'region', text: 'string', track: 'track', arc: 'arc', via: 'via', pad: 'pad' };
/** Drawn above every layer (whatever Layer Drawing Order says): net labels, the origin, rooms, guides, rigid-flex regions. */
const ABOVE = 2000;
/** Work guides' colour [est]. */
const GUIDE = 0x4fc3f7;
import { embeddedModels, linkedModels, type ModelFiles } from '../../render/gl3d/stepBodies';
import { affectedWidth, boardRegions, interiorPoint, isAdvanced, removeRegion, removeSplit, setRigidFlex, splitLines, substacks, withRegion, type RigidFlex } from '../../model/rigidFlex';
import { coverlayAreas, coverlayLayers } from '../../model/coverlay';


/** A net's own colour (Nets6 COLOR, a COLORREF), AD's default where it has none. */
function netDrawColour(doc: PcbDocument, net: number): number {
  const b = doc.nets[net]?.bag;
  if (!b?.has('COLOR')) return 0x9ea175;
  const c = b.int('COLOR');
  return ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff);
}
/** A plane area's triangles, worked out once. */
const planeTriCache = new WeakMap<object, { pts: Vec2[]; idx: number[] }>();
function planeTris(r: { outline: Vec2[]; holes: Vec2[][] }): { pts: Vec2[]; idx: number[] } {
  let t = planeTriCache.get(r);
  if (!t) { t = triangulateWithHoles(r.outline, r.holes); planeTriCache.set(r, t); }
  return t;
}

export type SingleLayerMode = 'off' | 'hide' | 'grey' | 'mono';

export class PcbEditor extends Editor {
  readonly scope: Scope = 'pcb';
  override get cursorColour(): string { return settings.cursorColourPcb; }
  /** Fit Document on a board: every object, and the board shape (an empty board shows its outline). */
  override fitBounds(): BBox {
    let b = this.objectBounds();
    for (const v of this.doc.board.outline) b = union(b, { minX: v.x, minY: v.y, maxX: v.x, maxY: v.y });
    return b;
  }
  /* ── 3D Layout Mode (3) ── */
  mode3d = false;
  view3d: Viewer3D | null = null;
  private rebuild3d: ReturnType<typeof setTimeout> | null = null;
  /** View › Board Planning Mode (1): the board shown as its regions, nothing else drawn or picked [est: a rigid board is one region]. */
  planning = false;
  setPlanning(on: boolean): void {
    if (on === this.planning) return;
    if (on) this.set3d(false);
    this.planning = on;
    this.setTool(null);
    this.selection = new Set();
    this.invalidate();
    this.changed.emit();
  }
  /** View › Fold/Unfold (5): a rigid-flex board folded about its bending lines in 3D, or flat again. */
  folded = false;
  toggleFold(): void {
    this.folded = !this.folded;
    this.view3d?.foldTo(this.folded ? 1 : 0);
    this.changed.emit();
  }
  /** The PCB panel's Fold State: folded this far (0 … 1), at once. */
  setFold(v: number): void {
    this.folded = v >= 0.5;
    this.view3d?.setFold(v);
    this.changed.emit();
  }
  /** 2 / 3: the board in 2D (editing) or 3D (viewing). */
  set3d(on: boolean): void {
    if (on && this.planning) { this.planning = false; this.invalidate(); }
    if (on === this.mode3d) return;
    this.mode3d = on;
    if (on) this.open3d();
    else { this.view3d?.dispose(); this.view3d = null; this.viewport?.requestRender(); }
    this.changed.emit();
  }
  private open3d(): void {
    const host = this.viewport?.host;
    if (!host || this.view3d) return;
    this.setTool(null);
    this.view3d = new Viewer3D(host, () => this.doc, undefined, () => this.modelFiles(), { names: () => this.linkedModelNames(), find: (p) => this.findModel(p) }, () => this.folded,
      () => (this.singleLayer !== 'off' ? this.currentLayer : null));
  }
  /** The STEP models the 3D bodies may show (embedded in the file). */
  modelFiles(): ModelFiles { return embeddedModels(this.doc.cfb.root); }
  /** The models the file links to (their paths by model id). */
  linkedModelNames(): Map<string, string> { return linkedModels(this.doc.cfb.root); }
  /** A linked model's file (the app looks in the project's folder and the model folders). */
  findModel: (path: string) => Promise<Uint8Array | null> = async () => null;
  override mount(el: HTMLElement): void { super.mount(el); if (this.mode3d) this.open3d(); }
  override unmount(el?: HTMLElement): void {
    if (el && this.viewport && this.viewport.host.parentElement !== el) return;
    this.view3d?.dispose(); this.view3d = null; super.unmount();
  }
  override fit(): void { if (this.view3d) this.view3d.fit(); else super.fit(); }
  override fitObjects(): void { if (this.view3d) this.view3d.fit(); else super.fitObjects(); }
  override hint(): string {
    if (this.view3d?.pickHint) return this.view3d.pickHint;
    if (this.planning) return 'Board Planning Mode: the board as its regions; double-click a region for its properties; 2 back to 2D Layout Mode, 3 to 3D';
    return this.mode3d ? '3D Layout Mode: Shift+right-drag rotates, right-drag pans, Ctrl+wheel zooms; 0 top, 9 turned, 8 angled view, V, B other side, 2 back to 2D' : super.hint();
  }

  currentLayer: LayerId = L.TOP;
  hidden = new Set<LayerId>();
  singleLayer: SingleLayerMode = 'off';
  highlightNet: number | null = null;
  /**
   * PCB Filter › Mask (and Find Similar's Mask Matching): only these objects stay as they are and
   * can be picked; the rest are drawn faded (Mask Level). Null: nothing masked.
   */
  mask: Set<string> | null = null;
  /** F5 (Net Colour Override): nets with their own colour (Nets6 COLOR, OVERRIDECOLORFORDRAW) drawn in it. */
  static showNetColours = true;
  /** Dim rather than Mask: what doesn't pass is faded but can still be picked. */
  maskPickable = false;
  setMask(keys: Iterable<string> | null, pickable = false): void {
    this.mask = keys ? new Set(keys) : null;
    this.maskPickable = pickable;
    if (this.mask && !pickable) this.selection = new Set([...this.selection].filter((k) => this.mask!.has(k)));
    this.invalidate();
  }
  units: () => DisplayUnit = () => 'mil';
  trackWidth = mil(settings.pcbTrackWidth);
  /** Violations shown as DRC markers: the last batch DRC's, while they last, plus online DRC's. */
  violations: DrcViolation[] = [];
  /** Batch results with the content signature of each object involved (indices shift on edits). */
  private batch: { v: DrcViolation; sigs: string[] }[] = [];
  private baseline: Set<string>;
  private drcTimer: ReturnType<typeof setTimeout> | null = null;

  /** Place › Pad remembers the last pad's settings. */
  padTemplate: PadTemplate = defaultPad();
  /** Place › Via and Place › String defaults (Tab edits them in Properties). */
  viaTemplate: ViaTemplate = { diameter: mil(50), hole: mil(28), fromRule: true };
  /** Interactive Routing › Apply to all layers off: a user width of a layer's own (the rest take the user width). */
  layerWidths = new Map<LayerId, number>();
  stringTemplate: StringTemplate = defaultString();
  doc: PcbDocument;

  constructor(doc: PcbDocument) {
    const sel = new SelectTool();
    super(sel);
    this.doc = doc;
    sel.editor = this;
    this.gridIndex = PCB_GRIDS.indexOf(mil(5));
    this.readSnapOptions();
    this.undo.changed.on(() => this.readSnapOptions()); // Board Options and Shift+E undo too
    this.baseline = new Set(doc.prims.map(primSig));
    this.undo.changed.on(() => this.scheduleOnlineDrc());
    // Opened in its kind's view configuration (a library's scope is known once it is made)
    queueMicrotask(() => this.applyDefaultView());
    // The 3D view follows edits (undo and redo too)
    this.undo.changed.on(() => {
      if (!this.view3d) return;
      if (this.rebuild3d) clearTimeout(this.rebuild3d);
      this.rebuild3d = setTimeout(() => { this.rebuild3d = null; this.view3d?.rebuild(); }, 150);
    });
  }

  /**
   * Preferences › PCB Editor › Display › Default PCB View Configurations: a board, or a footprint
   * library, opens in its 2D and 3D configuration — unless the view has been made one's own
   * (Custom, or a configuration changed), which stays.
   */
  applyDefaultView(): void {
    const lib = this.scope === 'pcblib';
    const want2d = lib ? settings.pcbLibDefault2d : settings.pcbDefault2d, want3d = lib ? settings.pcbLibDefault3d : settings.pcbDefault3d;
    const same = (a: Record<string, number>, b: Record<string, number>) => Object.keys(b).every((k) => (a[k] ?? 0) === b[k]);
    const patch: Partial<Settings> = {};
    const t2 = want2d === 'Transparent 2D' ? TRANSPARENCY_TRANSPARENT : TRANSPARENCY_STANDARD;
    if ([TRANSPARENCY_STANDARD, TRANSPARENCY_TRANSPARENT].some((t) => same(settings.pcbTransparency, t)) && !same(settings.pcbTransparency, t2)) patch.pcbTransparency = { ...t2 };
    const p3 = VIEW3D_PRESETS.find((p) => p.config === want3d);
    if (p3 && view3dName(settings.pcb3d) === settings.pcb3d.config && settings.pcb3d.config !== p3.config) patch.pcb3d = { ...p3 };
    if (Object.keys(patch).length) updateSettings(patch);
  }

  /* ── design rule checking ── */
  /**
   * Tools › Design Rule Check: every violation of the chosen rule kinds becomes a marker; with Stop
   * When N Violations Found, only the first stopAt are kept (the report and Messages list the same).
   */
  runBatchDrc(kinds: Set<string>, stopAt = Infinity): DrcReport {
    const r = runDrc(this.doc, kinds);
    if (r.violations.length > stopAt) r.violations = r.violations.slice(0, Math.max(0, stopAt));
    const sigs = this.doc.prims.map(primSig);
    this.batch = r.violations.map((v) => ({ v, sigs: v.prims.map((i) => sigs[i]!) }));
    this.violations = r.violations;
    this.invalidateOverlay();
    return r;
  }
  /** Tools › Reset Error Markers. */
  resetErrorMarkers(): void { this.batch = []; this.violations = []; this.invalidateOverlay(); }

  private scheduleOnlineDrc(): void {
    if (this.drcTimer) clearTimeout(this.drcTimer);
    this.drcTimer = setTimeout(() => { this.drcTimer = null; this.onlineDrc(); }, 120);
  }
  /**
   * Online DRC, as Altium: after each edit, objects changed since the board was opened are
   * checked (against everything) for the rules ticked Online. Batch results stay marked while
   * every object involved is unchanged.
   */
  onlineDrc(): void {
    const online = settings.pcbOnlineDrc ? drcSettings(this.doc).online : new Set<string>();
    const sigs = this.doc.prims.map(primSig);
    const index = new Map<string, number>();
    const touched = new Set<number>();
    sigs.forEach((s, i) => { if (!index.has(s)) index.set(s, i); if (!this.baseline.has(s)) touched.add(i); });
    const touchedNets = new Set([...touched].map((i) => { const p = this.doc.prims[i]!; return 'net' in p ? p.net : NO_NET; }));
    const kept: DrcViolation[] = [];
    for (const { v, sigs: ss } of this.batch) {
      const idx = ss.map((s) => index.get(s));
      if (idx.some((i) => i === undefined)) continue;
      // A connection made since may have routed the net
      if (v.kind === 'UnRoutedNet' && idx.some((i) => { const p = this.doc.prims[i!]!; return 'net' in p && touchedNets.has(p.net); })) continue;
      kept.push({ ...v, prims: idx as number[] });
    }
    const fresh = online.size && touched.size ? runDrc(this.doc, online, touched).violations : [];
    const seen = new Set<string>();
    this.violations = [...kept, ...fresh].filter((v) => !seen.has(v.message) && !!seen.add(v.message));
    this.invalidateOverlay();
  }

  keyOf(i: number): string | undefined { const p = this.doc.prims[i]; return p ? primKey(p) : undefined; }

  protected override marks() {
    if (!this.violations.length) return null;
    const items = new Set<string>();
    for (const v of this.violations) for (const i of v.prims) { const k = this.keyOf(i); if (k) items.add(k); }
    // Preferences › DRC Violations Display: the objects drawn in the violation colour, a cross at each violation
    // …drawn in the Violation Overlay Style, near and zoomed out
    const id = (v: string) => (v.startsWith('None') ? PAT.none : v.startsWith('Solid') ? PAT.solid : v === 'Style A' ? PAT.hatch : PAT.crossHatch);
    const pattern: Pattern = { id: id(settings.pcbViolationStyle), cell: mil(10), out: id(settings.pcbViolationStyleOut) };
    // System Colours › DRC Error / Waiver Markers (the objects) and DRC Detail Markers (the crosses)
    return { items: settings.pcbViolationOverlay ? items : new Set<string>(), points: settings.pcbViolationDetails ? this.violations.map((v) => v.at) : [],
      colour: hexToRgb(settings.pcbDrcMarkerColour), pointColour: hexToRgb(settings.pcbDrcDetailColour), alpha: 0.75, pattern };
  }

  /** Messages double-click: select the violating objects and zoom to them. */
  showViolation(v: DrcViolation): void {
    this.selection = new Set(v.prims.map((i) => this.keyOf(i)).filter((k): k is string => !!k));
    this.invalidateOverlay();
    this.fitSelection(mil(300));
  }

  title(): string { return this.doc.name; }
  origin(): Vec2 { return this.doc.board.origin; }
  gridSizes(): number[] { return PCB_GRIDS; }
  grid(): GridSpec {
    // System Colours › Default Grid Colour - Small and - Large
    const c = hexToRgb(settings.pcbGridColour), big = hexToRgb(settings.pcbGridColourLarge), dots = settings.pcbGridStyle === 'dots';
    return { size: this.gridSize(), dots, color: hex4(c, dots ? 0.5 : 0.18), major: hex4(big, dots ? 0.7 : 0.32) };
  }

  /** Where a layer draws (higher on top): Layer Drawing Order's place for its kind (the current layer its own), flipped board or not. */
  layerZ(l: LayerId): number { return drawZ(l, this.currentLayer, !!this.viewport?.cam.flipX); }
  /** The grid drawn just above the board, or where Layer Drawing Order puts it. */
  override gridAbove = 'gridmark';

  /** Layers worth showing in the layer bar: the copper stack plus anything with content. */
  layers(): LayerId[] {
    const used = new Set<LayerId>(this.doc.board.copperStack);
    for (const p of this.doc.prims) if ('layer' in p && p.layer) used.add(p.layer);
    for (const l of [L.TOP_OVERLAY, L.BOTTOM_OVERLAY, L.TOP_SOLDER, L.BOTTOM_SOLDER, L.KEEPOUT, L.MULTI]) used.add(l);
    used.delete(0);
    return [...used].sort((a, b) => stackOrder(b) - stackOrder(a));
  }
  layerLabel(l: LayerId): string { return this.doc.board.layerNames.get(l) ?? layerName(l); }

  setCurrentLayer(l: LayerId): void {
    const was = this.currentLayer;
    this.currentLayer = l; this.invalidate();
    // (the 3D view shows the layer alone in single layer mode: the other layer now)
    if (l !== was && this.singleLayer !== 'off') this.view3d?.rebuild();
  }
  /** `*` — next signal layer in the stack; +/- step through all visible layers. */
  nextSignalLayer(): void {
    const s = this.doc.board.copperStack.filter(isSignal);
    const i = s.indexOf(this.currentLayer);
    this.setCurrentLayer(s[(i + 1) % s.length] ?? L.TOP);
  }
  /** Shift+* — previous signal layer in the stack. */
  prevSignalLayer(): void {
    const s = this.doc.board.copperStack.filter(isSignal);
    const i = s.indexOf(this.currentLayer);
    this.setCurrentLayer(s[(i - 1 + s.length) % s.length] ?? L.TOP);
  }
  stepLayer(dir: 1 | -1): void {
    const ls = this.layers().filter((l) => !this.hidden.has(l));
    const i = ls.indexOf(this.currentLayer);
    this.setCurrentLayer(ls[(i + dir + ls.length) % ls.length] ?? L.TOP);
  }
  /** Shift+S: off → hide others → grey others → off (Preferences can limit it to one mode). */
  cycleSingleLayer(): void {
    const modes: SingleLayerMode[] = [...(settings.pcbSingleLayerModes === 'both' ? ['off', 'hide', 'grey'] as SingleLayerMode[] : ['off', settings.pcbSingleLayerModes] as SingleLayerMode[]), ...(settings.pcbSingleMono ? ['mono' as const] : [])];
    // In the 3D view there is one way of showing a layer alone (the board seen through, the layer at its depth): on, and off
    if (this.mode3d) this.singleLayer = this.singleLayer === 'off' ? (modes[1] ?? 'hide') : 'off';
    else this.singleLayer = modes[(modes.indexOf(this.singleLayer) + 1) % modes.length] ?? 'off';
    this.invalidate();
    this.view3d?.rebuild();
  }
  toggleLayer(l: LayerId): void { if (this.hidden.has(l)) this.hidden.delete(l); else this.hidden.add(l); this.invalidate(); }

  startTrack(): void { this.setTool(new PlaceTrackTool(this)); }
  startRoute(): void { this.setTool(new RouteTool(this)); }
  startPad(): void { this.setTool(new PlacePadTool(this)); }

  /* ── object hot spots ── */
  /** Toggle Object Hotspot Snapping (Shift+E): placing snaps to pad and via centres and track and arc ends within range. */
  hotspotSnap = true;
  /** Board Options › Snap Distance. */
  hotspotRange = mil(8);
  /** Board Options › Snap On All Layers (else only what is on the current layer, multi-layer pads and vias). */
  hotspotAllLayers = false;
  /** Board Options › Snap To Board Outline: the board shape's vertices are hot spots too. */
  hotspotBoardOutline = false;
  /** Board Options › Snap To Arc Centres: arcs' centres are hot spots too (Board6 EGSNAPTOARCCENTERS). */
  hotspotArcCentres = false;
  /** Board Options › Snap To Grids, Snap To Linear Guides, Snap To Point Guides, Snap To Object Axis and its range (GRIDSNAPENABLED, MGSNAPENABLED, POINTGUIDEENABLED, OGSNAPENABLED; KONIUMAXISSNAPRANGE [est]). */
  snapGrids = true;
  snapLinearGuides = true;
  snapPointGuides = true;
  snapObjectAxis = false;
  axisRange = mil(20);
  private hotSpot: Vec2 | null = null;
  /** The Board6 record keeps these as ELECTRICALGRIDENABLED / RANGE / USEALLLAYERS / SNAPTOBO. */
  readSnapOptions(): void {
    const b = this.doc.board.bag;
    if (!b) return;
    // Absent keys are Altium's defaults: on, 8 mil
    this.hotspotSnap = b.has('ELECTRICALGRIDENABLED') ? b.bool('ELECTRICALGRIDENABLED') : true;
    const r = parseLength(b.getRaw('ELECTRICALGRIDRANGE'));
    this.hotspotRange = r && r > 0 ? Math.round(r) : mil(8);
    this.hotspotAllLayers = b.bool('ELECTRICALGRIDUSEALLLAYERS');
    this.hotspotBoardOutline = b.bool('ELECTRICALGRIDSNAPTOBO');
    // As the board says (AD writes guides, object axis and arc centres off, grids on); absent, guides snap as they did before 26.109
    const on = (k: string, d: boolean) => (b.has(k) ? b.bool(k) : d);
    this.hotspotArcCentres = on('EGSNAPTOARCCENTERS', false);
    this.snapGrids = on('GRIDSNAPENABLED', true);
    this.snapLinearGuides = on('MGSNAPENABLED', true);
    this.snapPointGuides = on('POINTGUIDEENABLED', true);
    this.snapObjectAxis = on('OGSNAPENABLED', false);
    const ar = parseLength(b.getRaw('KONIUMAXISSNAPRANGE'));
    this.axisRange = ar && ar > 0 ? Math.round(ar) : mil(20);
  }
  /** The Grid Manager's grids and the work guides, read from Board6 once per change of it. */
  private gg: { bag: unknown; grids: LocalGrid[]; guides: Guide[] } | null = null;
  gridsAndGuides(): { grids: LocalGrid[]; guides: Guide[] } {
    const b = this.doc.board.bag;
    if (!this.gg || this.gg.bag !== b) this.gg = { bag: b, grids: readGrids(b), guides: readGuides(b) };
    return this.gg;
  }
  /** Snapping: a work guide within reach, else the grid whose area holds the point, else the global snap grid. */
  override snap(p: Vec2): Vec2 {
    const { grids, guides } = this.gridsAndGuides();
    // Board Options › Snap To Linear Guides / Point Guides / Grids
    const usable = guides.filter((g) => (g.kind === 'point' ? this.snapPointGuides : this.snapLinearGuides));
    if (usable.length) { const q = snapToGuide(usable, p, 6 / (this.viewport?.cam.scale ?? 1e-4)); if (q) return q; }
    if (!this.snapGrids) return { x: Math.round(p.x), y: Math.round(p.y) };
    return (grids.length ? snapToLocalGrid(grids, p) : null) ?? super.snap(p);
  }
  private placing(): boolean { const id = this.tool.id; return /^(place|route|slice-tracks|measure|drag-track-end)/.test(id); }
  snapPointer(raw: Vec2): Vec2 {
    const s = this.snap(raw);
    const was = this.hotSpot;
    this.hotSpot = null;
    if (this.hotspotSnap && this.placing()) {
      let best: Vec2 | null = null, bd = this.hotspotRange;
      const near = (v: Vec2) => { const d = Math.hypot(v.x - raw.x, v.y - raw.y); if (d <= bd) { bd = d; best = v; } };
      const r = this.hotspotRange;
      const cur = this.currentLayer, all = this.hotspotAllLayers;
      for (const p of this.doc.prims) {
        if (!all && 'layer' in p && p.layer !== cur && p.layer !== L.MULTI) continue;
        switch (p.kind) {
          case 'pad': case 'via': if (Math.abs(p.at.x - raw.x) <= r && Math.abs(p.at.y - raw.y) <= r) near(p.at); break;
          case 'track': near(p.a); near(p.b); break;
          case 'arc':
            if (Math.abs(Math.hypot(raw.x - p.c.x, raw.y - p.c.y) - p.r) <= r) for (const a of [p.start, p.end]) near({ x: Math.round(p.c.x + p.r * Math.cos(a * DEG)), y: Math.round(p.c.y + p.r * Math.sin(a * DEG)) });
            // Board Options › Snap To Arc Centres
            if (this.hotspotArcCentres) near(p.c);
            break;
        }
      }
      if (this.hotspotBoardOutline) for (const v of this.doc.board.vertices) near(v.p);
      this.hotSpot = best;
    }
    if (was !== this.hotSpot) this.invalidateOverlay();
    const hadAlign = this.alignAt.length > 0;
    this.alignAt = [];
    let out = this.hotSpot ?? s;
    if (!this.hotSpot && this.snapObjectAxis && this.placing()) out = this.lineUp(raw, out);
    if (hadAlign || this.alignAt.length) this.invalidateOverlay();
    return out;
  }
  /**
   * Board Options › Snap To Object Axis: the cursor lined up with a nearby object's hot spot (pad
   * and via centres, track ends) across or down, within the Axis Snap Range, a line drawn from it
   * [est: objects up to 1000 mil away, Board6 NEARDISTANCE's default].
   */
  private lineUp(raw: Vec2, at: Vec2): Vec2 {
    const range = this.axisRange, far = mil(1000);
    let bx: { d: number; v: Vec2 } | null = null, by: { d: number; v: Vec2 } | null = null;
    const look = (v: Vec2) => {
      if (Math.abs(v.x - raw.x) > far || Math.abs(v.y - raw.y) > far) return;
      const dx = Math.abs(v.x - raw.x), dy = Math.abs(v.y - raw.y);
      if (dx <= range && dy > range && (!bx || dx < bx.d)) bx = { d: dx, v };
      if (dy <= range && dx > range && (!by || dy < by.d)) by = { d: dy, v };
    };
    for (const p of this.doc.prims) {
      if (p.kind === 'pad' || p.kind === 'via') look(p.at);
      else if (p.kind === 'track') { look(p.a); look(p.b); }
    }
    const x = bx as { d: number; v: Vec2 } | null, y = by as { d: number; v: Vec2 } | null;
    const out = { x: x ? x.v.x : at.x, y: y ? y.v.y : at.y };
    if (x) this.alignAt.push([x.v, out]);
    if (y) this.alignAt.push([y.v, out]);
    return out;
  }
  private alignAt: [Vec2, Vec2][] = [];
  protected override alignLines(): [Vec2, Vec2][] | null { return this.alignAt.length ? this.alignAt : null; }
  protected override cursorMarker(): Vec2 | null { return this.placing() ? this.hotSpot : null; }

  /* ── scene ── */
  private layerVisible(l: LayerId): boolean {
    if (this.hidden.has(l)) return false;
    if (this.singleLayer === 'hide' && l !== this.currentLayer && l !== L.MULTI && !this.mechInSingle(l)) return false;
    // Linked To Sheet: shown with the sheet
    if (isMech(l)) { const sh = this.sheet(); if (!sh.show && sh.linked.has(l)) return false; }
    return true;
  }
  /** Board Layers And Colours › Mechanical › Single Layer: a mechanical layer kept beside the current one in single layer mode. */
  private mechInSingle(l: LayerId): boolean { return isMech(l) && settings.pcbMechSingleLayer.includes(l); }
  /** Board Options' sheet and the layers linked to it. */
  sheet(): Sheet {
    const o = this.sheetOverride;
    if (!o) return sheetOf(this.doc);
    if (o.auto && this.autoSheet?.prims !== this.doc.prims) {
      const e = extentOf(this.doc, () => true), m = mil(100);
      this.autoSheet = { prims: this.doc.prims, rect: e ? { minX: e.minX - m, minY: e.minY - m, maxX: e.maxX + m, maxY: e.maxY + m } : o.rect };
    }
    return { rect: o.auto && this.autoSheet ? this.autoSheet.rect : o.rect, show: o.show, lock: o.lock, auto: o.auto, linked: new Set() };
  }
  /** A library's sheet (Library Options), kept while it is open: auto-sized, round the footprint with 100 mil to spare [est]. */
  sheetOverride: { show: boolean; lock: boolean; auto: boolean; rect: BBox } | null = null;
  private autoSheet: { prims: unknown; rect: BBox } | null = null;

  protected build(scene: Scene, emit: (it: HitItem) => void): void {
    const doc = this.doc;
    // Board Planning Mode: the design drawn as usual in AD's planning colours, nothing on it
    // picked; only the board region takes clicks (drawPlanning)
    const plan = this.planning, pickRegion = emit;
    if (plan) emit = () => {};
    const BG = plan ? PLAN.bg : hexToRgb(settings.pcbBackground), BOARD = plan ? PLAN.board : hexToRgb(settings.pcbBoardColour);
    const HOLE = plan ? PLAN.metal : hexToRgb(settings.pcbHoleColour), VIA = plan ? PLAN.metal : hexToRgb(settings.pcbViaColour);
    scene.background = BG;
    // System Colours › Workspace Start (top) and End (bottom) Colour
    scene.backgroundEnd = plan ? undefined : hexToRgb(settings.pcbWorkspaceEnd);
    // Board Options › Display Sheet: the sheet under the board, in Sheet Area and Line Colour
    const sheet = this.sheet();
    if (sheet.show && !plan) {
      const sg = scene.group('sheet', -101), r = sheet.rect;
      const pts = [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY }, { x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY }];
      scene.polygon(sg, pts, [0, 1, 2, 0, 2, 3], rgba(hexToRgb(settings.pcbSheetAreaColour)));
      scene.polyline(sg, pts, 0, rgba(hexToRgb(settings.pcbSheetLineColour)), true, 1);
    }
    const board = scene.group('board', -100);
    if (doc.board.outline.length >= 3) {
      scene.polygon(board, doc.board.outline, triangulate(doc.board.outline), rgba(BOARD));
      scene.polyline(board, doc.board.outline, mil(4), rgba(plan ? PLAN.edge : hexToRgb(settings.pcbBoardLineColour)), true);
    }
    // View Configurations › Transparency: each kind of layer see-through as set (not while planning)
    const tr = settings.pcbTransparency;
    const see = (k: string) => (plan ? 1 : Math.max(0.1, 1 - (tr[k] ?? 0) / 100));
    const groupFor = (l: LayerId): DrawGroup => {
      // In Preferences › PCB Editor › Display › Layer Drawing Order (AD's: multi-layer, the overlays, the connections, the current layer …)
      const g = scene.group(`L${l}`, this.layerZ(l));
      g.visible = this.layerVisible(l);
      g.alpha = see(transparencyKey(l));
      return g;
    };
    // Vias draw with the multi-layer pads, their holes above them; the grid where the order puts it (over the board)
    const holes = scene.group('holes', kindZ('multi', drawOrder()) + 99.5);
    const vias = scene.group('vias', kindZ('multi', drawOrder()) + 99);
    scene.group('gridmark', kindZ('grid', drawOrder()) + 99);
    vias.visible = !this.hidden.has(L.MULTI);
    vias.alpha = see('multi');
    holes.visible = vias.visible && settings.pcbShowHoles;

    const colour = (l: LayerId) => (!plan ? layerColour(l) : isSignal(l) || (l >= L.PLANE1 && l <= L.PLANE16) ? PLAN.copper : l === L.MULTI ? PLAN.metal : PLAN.other);
    const outline = doc.board.outline, onBoard = (q: Vec2) => outline.length < 3 || pointInPoly(q, outline);

    const ghost = this.ghost;
    const hiddenKinds = new Set(settings.pcbHiddenKinds);
    // Net colour override: COLORREF (0x00BBGGRR) → 0xRRGGBB
    const netColour = new Map<number, number>();
    if (PcbEditor.showNetColours && !plan) for (const n of doc.nets) if (n.bag.bool('OVERRIDECOLORFORDRAW') && n.bag.has('COLOR')) { const c = n.bag.int('COLOR'); netColour.set(n.index, ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff)); }
    // Board Insight Colour Overrides: the override drawn through the base pattern over the layer's colour
    // (Solid: the override colour alone); zoomed out, the pattern kept, the override colour or the layer's
    const overId = { Solid: PAT.solid, Checkerboard: PAT.checker, Stripe: PAT.stripe, 'Large Checkerboard': PAT.largeChecker }[settings.pcbOverridePattern] ?? PAT.checker;
    const overPattern: Pattern | null = overId === PAT.solid ? null
      : { id: overId, cell: mil(8), out: settings.pcbOverrideZoomOut === 'override' ? PAT.solid : settings.pcbOverrideZoomOut === 'original' ? PAT.none : overId };
    const besides = (g: DrawGroup, what: string, pattern: Pattern, dz: number) => { const o = scene.group(`${g.key}:${what}`, g.z + dz); o.visible = g.visible; o.alpha = g.alpha; o.pattern = pattern; return o; };
    // Board Insight Display › Show Locked Texture on Objects: Always
    const lockedTexture = settings.pcbLockedTexture === 'always' && !plan;
    // Display › Draft Thresholds: tracks narrower than this drawn as single lines
    const draftTrack = mil(settings.pcbDraftTracks);
    // Show/Hide › Draft: these kinds drawn as outlines; Coordinates are the objects Place › Coordinate makes (a union named Coordinates…)
    const draftKinds = new Set(plan ? [] : settings.pcbDraftKinds);
    const coordUnions = new Set((doc.unionNames ?? []).filter((n) => n.name.startsWith('Coordinates')).map((n) => n.index));
    const kindOf = (p: PcbPrim): string => {
      if (coordUnions.size) { const u = unionOf(doc, p); if (u && coordUnions.has(u)) return 'coordinate'; }
      return 'polygon' in p && p.polygon !== NO_NET ? 'polygon' : p.kind;
    };
    // View Options › Plane Drawing › Solid Net Coloured: each plane's copper filled in its net's colour
    if (settings.pcbPlaneDrawing === 'solid' && !plan) {
      for (const l of doc.board.copperStack) {
        if (!isPlane(l)) continue;
        const g = groupFor(l);
        for (const a of planeCopper(doc, l)) {
          const c = a.net === NO_NET ? colour(l) : netDrawColour(doc, a.net);
          for (const reg of a.regions) { const t = planeTris(reg); scene.polygon(g, t.pts, t.idx, rgba(c, 0.8)); }
        }
      }
    }
    // View Options › Convert Special Strings: .Layer_Name and the rest shown as what they stand for
    const shown = (p: { text: string; layer: LayerId }) => (settings.pcbConvertSpecial && p.text.includes('.') ? specialStrings(doc, p.layer)(p.text) : p.text);
    for (const p of doc.prims) {
      const key = primKey(p);
      if (ghost && (ghost.keys.has(key) || ('component' in p && ghost.comps.has(p.component)))) continue;
      const kind = kindOf(p);
      if (hiddenKinds.has(kind)) continue;
      const draft = draftKinds.has(kind);
      const net = 'net' in p ? copperNet(doc, p) : undefined;
      const pour = key.startsWith('poly:');
      // Masked out by a filter: drawn faded, out of reach
      // (Preferences › Display › Apply Mask During Interactive Editing off: none while a tool is at work)
      const dimmed = !!this.mask && !this.mask.has(key) && (settings.pcbMaskWhileEditing || this.tool === this.selectTool);
      const fade = 1 - maskLevel.dim;
      const locked = 'locked' in p && p.locked;
      const item = (layer: LayerId, bbox: BBox, test: HitItem['test'], draw: (s: Scene, g: DrawGroup, c: number) => void, extra?: (s: Scene) => void, outline?: HitItem['outline']) => {
        const g = groupFor(layer);
        // A keepout draws in the Keep-Out layer's colour, on its own layer
        const keepout = 'keepout' in p && p.keepout;
        const over = net !== undefined && !keepout && (isSignal(layer) || layer === L.MULTI) ? netColour.get(net) : undefined;
        // Polygons' copper and fills / regions take their own transparency on top of the layer's
        const kindSee = pour ? see('polygons') : p.kind === 'fill' || p.kind === 'region' ? see('fills') : 1;
        const base = keepout ? colour(L.KEEPOUT) : (overPattern ? undefined : over) ?? colour(layer);
        // Use Transparent Mode When Masking off: solid, its colour faded towards the background
        const own = dimmed && !settings.pcbMaskTransparent ? rgba(mixRgb(base, BG, 1 - fade), kindSee) : rgba(base, (dimmed ? fade : 1) * kindSee);
        // Draft: the outline alone
        const paint = draft && outline ? outline : draw;
        paint(scene, g, own);
        if (over !== undefined && overPattern && !dimmed && !draft) draw(scene, besides(g, 'over', overPattern, 0.001), rgba(over, kindSee));
        if (locked && lockedTexture && !dimmed && !draft) draw(scene, besides(g, 'locked', LOCKED_TEXTURE, 0.002), rgba(0x000000, 0.55));
        extra?.(scene);
        if (dimmed && !this.maskPickable) return;
        // A selected or highlighted pour is tinted, not painted over, so what lies on it stays visible
        emit({ key, bbox, test, draw: pour && !draft ? (s, gg, c) => draw(s, gg, (c & 0x00ffffff) | 0x48000000) : (s, gg, c) => paint(s, gg, c), outline, layer, net, order: 0 });
      };
      switch (p.kind) {
        case 'track': {
          const r = p.width / 2, thin = p.width < draftTrack;
          item(p.layer, { minX: Math.min(p.a.x, p.b.x) - r, minY: Math.min(p.a.y, p.b.y) - r, maxX: Math.max(p.a.x, p.b.x) + r, maxY: Math.max(p.a.y, p.b.y) + r },
            (q, tol) => distToSegment(q, p.a, p.b) <= r + tol, (s, g, c) => s.segment(g, p.a, p.b, thin ? 0 : p.width, c, thin ? 1 : 0.5), undefined,
            (s, g, c) => s.polyline(g, capsule(p.a, p.b, r), 0, c, true, OUTLINE_PX));
          break;
        }
        case 'arc': {
          const R = p.r + p.width / 2;
          item(p.layer, { minX: p.c.x - R, minY: p.c.y - R, maxX: p.c.x + R, maxY: p.c.y + R },
            (q, tol) => distToArc(q, p.c, p.r, p.start, p.end) <= p.width / 2 + tol, (s, g, c) => s.arc(g, p.c, p.r, p.start, p.end, p.width < draftTrack ? 0 : p.width, c, p.width < draftTrack ? 1 : 0.5), undefined,
            (s, g, c) => arcOutline(s, g, p.c, p.r, p.start, p.end, p.width, c));
          break;
        }
        case 'fill': {
          const ctr = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 };
          const w = Math.abs(p.b.x - p.a.x), h = Math.abs(p.b.y - p.a.y);
          const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => rotate({ x: ctr.x + (sx! * w) / 2, y: ctr.y + (sy! * h) / 2 }, p.rotation, ctr));
          item(p.layer, bboxOf(corners), (q) => pointInPoly(q, corners), (s, g, c) => s.rect(g, ctr, w, h, p.rotation, 0, c), undefined, (s, g, c) => s.polyline(g, corners, 0, c, true, OUTLINE_PX));
          break;
        }
        case 'region': {
          if (p.outline.length < 3 || (p.polygon !== NO_NET && !settings.pcbShowPours)) break;
          const { pts, idx } = regionTris(doc, p);
          const inside = (q: Vec2) => pointInPoly(q, p.outline) && !p.holes.some((h) => pointInPoly(q, h));
          if (p.boardCutout) { scene.polygon(board, pts, idx, rgba(BG)); break; }
          if (p.regionKind === 0) {
            item(p.layer, bboxOf(p.outline), inside, (s, g, c) => s.polygon(g, pts, idx, c), undefined,
              (s, g, c) => { s.polyline(g, p.outline, 0, c, true, OUTLINE_PX); for (const h of p.holes) s.polyline(g, h, 0, c, true, OUTLINE_PX); });
          } else if (p.regionKind === 1 || p.regionKind === 2 || p.regionKind === 4) {
            item(p.layer, bboxOf(p.outline), inside, (s, g, c) => s.polyline(g, p.outline, 0, c, true));
          }
          break;
        }
        case 'body': {
          // A 3D body shows in 2D as a see-through fill of its mechanical layer's colour (about 45%),
          // its outline drawn firm; the small previews cross-hatch it instead (FootprintPreview)
          if (p.outline.length < 3) break;
          const bb = bboxOf(p.outline);
          const tris = triangulate(p.outline);
          item(p.layer, bb, (q) => pointInPoly(q, p.outline), (s, g, c) => {
            s.polygon(g, p.outline, tris, ((c & 0x00ffffff) | (Math.round((c >>> 24) * (plan ? 0.45 : 1 - (tr.bodies ?? 55) / 100)) << 24)) >>> 0);
            s.polyline(g, p.outline, 0, c, true);
          }, undefined, (s, g, c) => s.polyline(g, p.outline, 0, c, true, OUTLINE_PX));
          break;
        }
        case 'text': {
          if ((p.hidden && !settings.pcbShowHiddenText) || !p.text) break;
          const text = shown(p);
          if (p.barcode) {
            // A barcode: its bars (or, inverted, the box less the bars), the words under them when shown
            const bc = barcodeShape(text, p.at, p.rotation, p.mirrored, p.height, p.barcode);
            item(p.layer, bboxOf(bc.box), (q) => pointInPoly(q, bc.box), (s, g, c) => {
              if (c !== rgba(colour(p.layer)) && !(dimmed && c === rgba(colour(p.layer), fade))) { s.polygon(g, bc.box, [0, 1, 2, 0, 2, 3], (c & 0x00ffffff) | 0x50000000); return; }
              for (const r of bc.rects) s.polygon(g, r, [0, 1, 2, 0, 2, 3], c);
              // Inverted: the words cut out of the filled box (drawn in the board's colour)
              const lab = bc.label;
              if (lab) for (const ch of lab.chars) s.text(g, ch.at, { text: ch.text, size: lab.em, rot: p.rotation, color: lab.knockout ? css(BOARD) : css(colour(p.layer), dimmed ? fade : 1), h: 1, v: 0, mirrored: p.mirrored, family: `"${p.barcode!.font}", "${settings.pcbSubstituteFont}", sans-serif` });
            }, undefined, (s, g, c) => s.polyline(g, bc.box, 0, c, true, OUTLINE_PX));
            break;
          }
          const tw = p.height * 0.62 * Math.max(1, text.length);
          const corners = [{ x: 0, y: 0 }, { x: tw, y: 0 }, { x: tw, y: p.height }, { x: 0, y: p.height }]
            .map((v) => rotate({ x: p.at.x + (p.mirrored ? -v.x : v.x), y: p.at.y + v.y }, p.rotation, p.at));
          item(p.layer, bboxOf(corners), (q) => pointInPoly(q, corners), (s, g, c) => {
            if (c !== rgba(colour(p.layer)) && !(dimmed && c === rgba(colour(p.layer), fade))) { s.polygon(g, corners, [0, 1, 2, 0, 2, 3], (c & 0x00ffffff) | 0x50000000); return; }
            // Altium's text height is the capital height (KiCad maps stroke text 1:1, Arial TrueType ×0.63, others ×0.5)
            const tt = p.fontType === 1 && p.fontName;
            const cap = tt ? p.height * (/arial/i.test(p.fontName) ? 0.63 : 0.5) / 0.716 : p.height / 0.7;
            s.text(g, p.at, { text, size: cap, rot: p.rotation, color: css(colour(p.layer), dimmed ? fade : 1), h: 0, v: 0, mirrored: p.mirrored,
              bold: p.bold, italic: p.italic, family: tt ? `"${p.fontName}", "${settings.pcbSubstituteFont}", sans-serif` : undefined,
              draftPx: settings.pcbDraftStrings, draftSize: p.height });
          }, undefined, (s, g, c) => s.polyline(g, corners, 0, c, true, OUTLINE_PX));
          break;
        }
        case 'via': {
          const r = p.diameter / 2;
          const bbox = { minX: p.at.x - r, minY: p.at.y - r, maxX: p.at.x + r, maxY: p.at.y + r };
          const draw = (s: Scene, _g: DrawGroup, c: number) => {
            if (draft) {
              s.arc(vias, p.at, r, 0, 360, 0, c === rgba(colour(L.MULTI)) ? rgba(VIA) : c, OUTLINE_PX);
              if (p.hole) s.arc(holes, p.at, p.hole / 2, 0, 360, 0, rgba(HOLE, dimmed ? fade : 1), OUTLINE_PX);
              return;
            }
            s.circle(vias, p.at, r, c === rgba(colour(L.MULTI)) ? rgba(VIA) : c);
            if (p.hole) s.circle(holes, p.at, p.hole / 2, rgba(HOLE, dimmed ? fade : 1));
          };
          const viaOver = netColour.get(p.net), solidOver = overPattern ? undefined : viaOver;
          draw(scene, vias, dimmed ? rgba(solidOver ?? VIA, fade) : solidOver !== undefined ? rgba(solidOver) : rgba(colour(L.MULTI)));
          if (viaOver !== undefined && overPattern && !dimmed && !draft) scene.circle(besides(vias, 'over', overPattern, 0.001), p.at, r, rgba(viaOver));
          if (p.locked && lockedTexture && !dimmed && !draft) scene.circle(besides(vias, 'locked', LOCKED_TEXTURE, 0.002), p.at, r, rgba(0x000000, 0.55));
          if (!dimmed || this.maskPickable) emit({ key, bbox, test: (q, tol) => Math.hypot(q.x - p.at.x, q.y - p.at.y) <= r + tol,
            draw: (s, g, c) => s.circle(g, p.at, r, c), outline: (s, g, c) => s.arc(g, p.at, r, 0, 360, 0, c, OUTLINE_PX), layer: L.MULTI, net: p.net, order: 0 });
          break;
        }
        case 'pad': {
          const thru = p.layer === L.MULTI;
          const stacks: [LayerId, PadStackLayer][] = thru ? [[L.BOTTOM, p.bot], [L.TOP, p.top], [L.MULTI, p.top]] : [[p.layer, p.top]];
          // Planning: a surface-mount pad off the board shows dark grey, as AD draws it
          const off = plan && !thru && !onBoard(p.at);
          for (const [layer, st] of stacks) {
            const outline = padOutline(p.at, st, p.rotation);
            item(layer, bboxOf(outline), (q) => pointInPoly(q, outline), (s, g, c) => drawPad(s, g, p.at, st, p.rotation, off ? rgba(PLAN.offBoard) : c),
              layer === L.MULTI && p.hole ? (s) => {
                const e = slotEnds(p);
                if (draft) { if (e) s.polyline(holes, capsule(e[0], e[1], p.hole / 2), 0, rgba(HOLE), true, OUTLINE_PX); else s.arc(holes, p.at, p.hole / 2, 0, 360, 0, rgba(HOLE), OUTLINE_PX); }
                else if (e) s.segment(holes, e[0], e[1], p.hole, rgba(HOLE)); else s.circle(holes, p.at, p.hole / 2, rgba(HOLE));
              } : undefined,
              (s, g, c) => s.polyline(g, outline, 0, c, true, OUTLINE_PX));
          }
          break;
        }
      }
    }
    if (!hiddenKinds.has('polygon')) this.drawPolygonOutlines(scene, emit);
    if (!hiddenKinds.has('dimension')) this.drawDimensions(scene, emit, draftKinds.has('dimension'));
    if (!hiddenKinds.has('room')) this.drawRooms(scene, emit, draftKinds.has('room'));
    if (this.planZones && !plan) this.drawPlanZones(scene);
    if (!plan) this.drawGridsAndGuides(scene);
    this.drawWireLinks(scene);
    this.drawConnections(scene);
    // An analysis's picture of the current layer's copper, over the board and under the names
    if (this.analysis && !plan) {
      const g = scene.group('analysis', ABOVE + 855);
      g.alpha = this.analysis.alpha ?? 1;
      for (const im of this.analysis.images(this.currentLayer)) scene.image(g, im.a, im.b, im.src);
    }
    this.drawNetLabels(scene, hiddenKinds);
    if (settings.pcbShowOriginMarker) this.drawOriginMarker(scene);
    if (settings.pcbShowRefPoint && !plan) this.drawRefPoints(scene);
    if (settings.pcbShowTestPoints && !plan) this.drawTestPoints(scene, hiddenKinds);
    if (plan) this.drawPlanning(scene, pickRegion);
  }

  /**
   * Altium's View Options › Show Pad Nets / Pad Numbers / Via Nets and Net Names on Tracks:
   * labels sized to fit each pad (designator over net name), via and track, readable from
   * any side; too small to read, they aren't drawn.
   */
  private drawNetLabels(scene: Scene, hiddenKinds: Set<string>): void {
    const pads = settings.pcbShowPadNumbers || settings.pcbShowPadNets;
    const tracks = settings.pcbTrackNetNames !== 'none';
    if (!pads && !settings.pcbShowViaNets && !tracks) return;
    const g = scene.group('netlabels', ABOVE + 880);
    const doc = this.doc, ghost = this.ghost, flip = !!this.viewport?.cam.flipX;
    const white = this.planning ? css(PLAN.labels, 0.85) : css(0xffffff, 0.92), soft = this.planning ? css(PLAN.labels, 0.6) : css(0xf0f0f0, 0.7);
    // Preferences › Board Insight Display › Pad and Via Display Options: font, style, the sizes on screen, the smallest object named, smart colour
    const font = settings.pcbNetFont, style = settings.pcbNetStyle;
    const opts = { family: `"${font}", Arial, sans-serif`, bold: /Bold/.test(style), italic: /Italic/.test(style), minPx: settings.pcbNetMinPx, maxPx: settings.pcbNetMaxPx };
    const cw = /condensed|narrow/i.test(font) ? 0.56 : 0.62;
    const dark = css(0x101010, 0.9), darkSoft = css(0x101010, 0.72);
    /**
     * Smart Display Colour: dark on light copper, light on dark. By how bright the layer's colour
     * is to the eye (its relative luminance: a pure green is far brighter than a pure red or blue),
     * dark from where dark stands out twice as well as light does.
     */
    const lightLayer = (layer: LayerId) => {
      const c = layerColour(layer), lin = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * lin((c >> 16) & 255) + 0.7152 * lin((c >> 8) & 255) + 0.0722 * lin(c & 255) > 0.274;
    };
    const smart = settings.pcbNetSmartColour && !this.planning;
    const onPad = (layer: LayerId) => (smart && lightLayer(layer) ? dark : white);
    /** …and a track's net name the same way (it was light on any colour: unreadable on a light layer). */
    const onTrack = (layer: LayerId) => (smart && lightLayer(layer) ? darkSoft : soft);
    const label = (at: Vec2, text: string, size: number, rot: number, color = white, obj?: number) => {
      if (size > 0 && text) scene.text(g, at, { text, size, rot, color, h: 1, v: 1, readable: true, ...opts, ...(obj !== undefined ? { objSize: obj, objMinPx: settings.pcbNetMinObjectPx } : {}) });
    };
    /** Font size for lines of text centred in a long × short box. */
    const fit = (lines: string[], long: number, short: number) => {
      const chars = Math.max(...lines.map((l) => l.length), 1);
      return Math.min((short * 0.78) / (lines.length * 1.1), (long * 0.88) / (chars * cw));
    };
    for (const p of doc.prims) {
      if (ghost && (ghost.keys.has(primKey(p)) || ('component' in p && ghost.comps.has(p.component)))) continue;
      if (p.kind === 'pad' && pads && !hiddenKinds.has('pad')) {
        if (!this.layerVisible(p.layer === L.MULTI ? L.MULTI : p.layer)) continue;
        const st = p.layer === L.MULTI ? (this.layerVisible(L.TOP) || !this.layerVisible(L.BOTTOM) ? p.top : p.bot) : p.top;
        if (st.w <= 0 || st.h <= 0) continue;
        const lines = [settings.pcbShowPadNumbers ? p.name : '', settings.pcbShowPadNets && p.net !== NO_NET ? netName(doc, p.net) : ''].filter(Boolean);
        if (!lines.length) continue;
        const along = st.w >= st.h ? p.rotation : p.rotation + 90;
        const long = Math.max(st.w, st.h), short = Math.min(st.w, st.h);
        const size = fit(lines, long, short), ink = onPad(p.layer === L.MULTI ? (this.layerVisible(L.TOP) || !this.layerVisible(L.BOTTOM) ? L.TOP : L.BOTTOM) : p.layer);
        if (lines.length === 1) { label(p.at, lines[0]!, size, along, ink, short); continue; }
        // Two lines: designator above the net name, "above" as the label reads on screen
        let disp = (((flip ? -along : along) % 360) + 360) % 360;
        if (disp > 90 && disp <= 270) disp -= 180;
        const up = ((disp + 90) * Math.PI) / 180, off = size * 0.58;
        const w = { x: Math.cos(up) * off * (flip ? -1 : 1), y: Math.sin(up) * off };
        label({ x: p.at.x + w.x, y: p.at.y + w.y }, lines[0]!, size, along, ink, short);
        label({ x: p.at.x - w.x, y: p.at.y - w.y }, lines[1]!, size, along, ink, short);
      } else if (p.kind === 'via' && settings.pcbShowViaNets && p.net !== NO_NET && !hiddenKinds.has('via')) {
        if (this.hidden.has(L.MULTI)) continue;
        const name = netName(doc, p.net);
        label(p.at, name, fit([name], p.diameter * 0.9, p.diameter * 0.9), 0, onPad(L.MULTI), p.diameter);
      } else if (p.kind === 'track' && tracks && p.net !== NO_NET && p.polygon === NO_NET && !hiddenKinds.has('track')) {
        if (!this.layerVisible(p.layer)) continue;
        const name = netName(doc, p.net);
        const len = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
        const size = p.width * 0.62, tw = size * 0.56 * name.length;
        if (len < tw * 1.4 || size <= 0) continue;
        const ang = (Math.atan2(p.b.y - p.a.y, p.b.x - p.a.x) * 180) / Math.PI;
        const at = (t: number) => ({ x: p.a.x + (p.b.x - p.a.x) * t, y: p.a.y + (p.b.y - p.a.y) * t });
        const ink = onTrack(p.layer);
        if (settings.pcbTrackNetNames === 'single') { label(at(0.5), name, size, ang, ink); continue; }
        const n = Math.max(1, Math.floor(len / (tw * 3)));
        for (let i = 0; i < n; i++) label(at((i + 0.5) / n), name, size, ang, ink);
      }
    }
  }

  /** The relative origin: Altium's circle-and-cross marker. */
  private drawOriginMarker(scene: Scene): void {
    const o = this.doc.board.origin;
    if (!o.x && !o.y) return;
    const g = scene.group('origin', ABOVE + 870), r = mil(20), c = rgba(0xffffff, 0.85);
    scene.polyline(g, Array.from({ length: 33 }, (_, i) => ({ x: o.x + r * Math.cos((i / 32) * 2 * Math.PI), y: o.y + r * Math.sin((i / 32) * 2 * Math.PI) })), mil(1.5), c, false);
    scene.segment(g, { x: o.x - r * 1.6, y: o.y }, { x: o.x + r * 1.6, y: o.y }, mil(1.5), c, 0);
    scene.segment(g, { x: o.x, y: o.y - r * 1.6 }, { x: o.x, y: o.y + r * 1.6 }, mil(1.5), c, 0);
  }

  /** View Options › Show Component Reference Point: a small cross in a circle at each component's reference point, in its side's overlay colour [est]. */
  private drawRefPoints(scene: Scene): void {
    const g = scene.group('refpoints', ABOVE + 869), r = mil(8);
    for (const c of this.doc.components) {
      if (this.ghost?.comps.has(c.index)) continue;
      const side = c.layer === L.BOTTOM ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY;
      if (!this.layerVisible(side)) continue;
      const o = c.at, col = rgba(layerColour(side), 0.95);
      scene.arc(g, o, r, 0, 360, 0, col, 1);
      scene.segment(g, { x: o.x - r * 1.5, y: o.y }, { x: o.x + r * 1.5, y: o.y }, 0, col, 1);
      scene.segment(g, { x: o.x, y: o.y - r * 1.5 }, { x: o.x, y: o.y + r * 1.5 }, 0, col, 1);
    }
  }

  /**
   * View Options › Show Test Points: pads and vias set as testpoints ringed and marked TP, with
   * the sides they are tested from (T, B) and F / A for fabrication and assembly [est: AD's marks].
   */
  private drawTestPoints(scene: Scene, hiddenKinds: Set<string>): void {
    const g = scene.group('testpoints', ABOVE + 878), col = 0xffd400;
    for (const p of this.doc.prims) {
      if ((p.kind !== 'pad' && p.kind !== 'via') || hiddenKinds.has(p.kind)) continue;
      const f = testpointMarks(this.doc, p, 'Fabrication'), a = testpointMarks(this.doc, p, 'Assembly');
      const top = f.top || a.top, bottom = f.bottom || a.bottom;
      if (!top && !bottom) continue;
      if (!this.layerVisible(p.kind === 'via' ? L.MULTI : p.layer === L.MULTI ? L.MULTI : p.layer)) continue;
      const r = p.kind === 'via' ? p.diameter / 2 : Math.max(p.top.w, p.top.h) / 2;
      scene.arc(g, p.at, r * 1.25, 0, 360, 0, rgba(col, 0.95), 1.5);
      const what = `TP ${top && bottom ? 'T/B' : top ? 'T' : 'B'}${(f.top || f.bottom) && (a.top || a.bottom) ? ' F/A' : f.top || f.bottom ? ' F' : ' A'}`;
      scene.text(g, { x: p.at.x, y: p.at.y + r * 1.25 }, { text: what, size: Math.max(mil(6), r * 0.7), rot: 0, color: css(col, 0.95), h: 1, v: 0, readable: true, family: 'Arial, sans-serif' });
    }
  }

  /**
   * Each pour's outline picks and selects it (with its copper). Pours with no copper at all
   * (nothing poured yet, everything removed as dead copper) show their outline so they can
   * still be found, selected and edited.
   */
  private drawPolygonOutlines(scene: Scene, emit: (it: HitItem) => void): void {
    if (!this.doc.polygons.length) return;
    const poured = new Set<number>();
    for (const p of this.doc.prims) if ('polygon' in p && p.polygon !== NO_NET) poured.add(p.polygon);
    for (const poly of this.doc.polygons) {
      const o = poly.outline;
      if (o.length < 3 || this.ghost?.keys.has(`poly:${poly.index}`)) continue;
      const layer = poly.layer;
      const draw = (s: Scene, g: DrawGroup, c: number) => s.polyline(g, o, 0, c, true);
      if (!poured.has(poly.index) || !settings.pcbShowPours) {
        const g = scene.group(`L${layer}`, this.layerZ(layer));
        g.visible = this.layerVisible(layer);
        draw(scene, g, rgba(this.planning ? PLAN.copper : layerColour(layer), this.mask && !this.mask.has(`poly:${poly.index}`) ? 0.9 * (1 - maskLevel.dim) : 0.9));
      }
      if (this.mask && !this.maskPickable && !this.mask.has(`poly:${poly.index}`)) continue;
      emit({ key: `poly:${poly.index}`, bbox: bboxOf(o), layer, net: poly.net, order: 0, draw,
        test: (q, tol) => { for (let i = 0; i < o.length; i++) if (distToSegment(q, o[i]!, o[(i + 1) % o.length]!) <= tol + mil(2)) return true; return false; } });
    }
  }

  /**
   * Board Planning Mode: the board's regions over the design (drawn in planning colours by build),
   * each outlined and labelled as AD labels them — "<region> - <layer stack>", "(flex)" after a
   * flex stack, white on black — the split lines between them in blue with their end handles,
   * and a flex region's bending lines with their bend's width shaded orange. Picks as
   * `region:i`, `split:i` and `bend:i:j`.
   */
  private drawPlanning(scene: Scene, emit: (it: HitItem) => void): void {
    const doc = this.doc, o = doc.board.outline;
    if (o.length < 3) return;
    const g = scene.group('regions', ABOVE + 890);
    const cut = doc.prims.filter((p) => p.kind === 'region' && p.boardCutout).map((p) => (p.kind === 'region' ? p.outline : [])).filter((c) => c.length >= 3);
    const regs = boardRegions(doc), subs = substacks(doc);
    const stackOf = (id: string) => subs.find((x) => x.id === id) ?? subs[0]!;
    const xs = o.map((v) => v.x), ys = o.map((v) => v.y);
    const all = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    const h = (all.maxY - all.minY) * 0.013;
    const px = 1 / (this.viewport?.cam.scale ?? 1);
    // Advanced Rigid-Flex: regions of higher priority drawn over the others where they overlap
    const order = regs.map((r, i) => ({ r, i })).sort((a, b) => (a.r.priority ?? 0) - (b.r.priority ?? 0));
    order.forEach(({ r, i }) => {
      const key = `region:${i}`, sel = this.selection.has(key), st = stackOf(r.stackId);
      const holes = cut.filter((c) => pointInPoly(c[0]!, r.outline));
      if (sel || st.isFlex) { const { pts, idx } = triangulateWithHoles(r.outline, holes); scene.polygon(g, pts, idx, sel ? rgba(0xffffff, 0.12) : rgba(PLAN.flex, 0.22)); }
      scene.polyline(g, r.outline, mil(6), rgba(sel ? 0xffffff : PLAN.edge), true);
      for (const c of holes) scene.polyline(g, c, mil(6), rgba(PLAN.edge), true);
      const text = `${r.name} - ${st.name}${st.isFlex ? ' (flex)' : ''}`, w = text.length * h * 0.56 + h * 0.9;
      const c = interiorPoint(r.outline);
      scene.rect(g, c, w, h * 1.7, 0, 0, rgba(0x000000));
      scene.text(g, c, { text, size: h, rot: 0, color: '#ffffff', h: 1, v: 1, readable: true, family: '"IBM Plex Sans Condensed", Arial, sans-serif' });
      const xr = r.outline.map((v) => v.x), yr = r.outline.map((v) => v.y);
      emit({ key, bbox: { minX: Math.min(...xr), minY: Math.min(...yr), maxX: Math.max(...xr), maxY: Math.max(...yr) }, test: (p) => pointInPoly(p, r.outline) && !holes.some((cc) => pointInPoly(p, cc)), draw: () => {}, order: r.priority ?? 0 });
    });
    // Coverlay: each coverlay layer's areas over its flex regions (custom shapes pick as cover:region:k)
    const cg = scene.group('coverlay', ABOVE + 891);
    for (const c of coverlayLayers(doc)) for (const a of coverlayAreas(doc, c)) {
      const reg = regs[a.region]!;
      for (const o of a.outlines) {
        const { pts, idx } = triangulateWithHoles(o, a.cutouts.filter((h) => pointInPoly(h[0]!, o)));
        scene.polygon(cg, pts, idx, rgba(PLAN.coverlay, c.side === 'top' ? 0.2 : 0.12));
        scene.polyline(cg, o, mil(3), rgba(PLAN.coverlay, 0.9), true);
      }
      for (const h of a.cutouts) scene.polyline(cg, h, mil(3), rgba(PLAN.coverlay, 0.9), true);
      (reg.coverlays ?? []).forEach((sh, k) => {
        if (sh.layer !== c.row.v7) return;
        const key = `cover:${a.region}:${k}`;
        if (this.selection.has(key)) scene.polyline(cg, sh.outline, mil(5), rgba(0xffffff), true);
        emit({ key, bbox: bboxOf(sh.outline), test: (p, tol) => sh.outline.some((q, m) => distToSegment(p, q, sh.outline[(m + 1) % sh.outline.length]!) <= tol + mil(5)), draw: () => {}, order: 100 });
      });
    }
    // (Advanced Rigid-Flex has no split lines: regions stand on their own)
    if (!isAdvanced(doc)) splitLines(doc).forEach((l, i) => {
      const key = `split:${i}`, col = this.selection.has(key) ? 0xffffff : PLAN.split;
      scene.segment(g, l.a, l.b, mil(8), rgba(col), 2);
      for (const e of [l.a, l.b]) { scene.circle(g, e, 5 * px, rgba(col)); scene.circle(g, e, 3 * px, rgba(0xffffff)); }
      emit({ key, bbox: bboxOf([l.a, l.b]), test: (p, tol) => distToSegment(p, l.a, l.b) <= tol + mil(8), draw: () => {}, order: 0 });
    });
    regs.forEach((r, ri) => r.bends.forEach((l, j) => {
      const key = `bend:${ri}:${j}`, col = this.selection.has(key) ? 0xffffff : PLAN.bend;
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, len = Math.hypot(dx, dy) || 1, half = affectedWidth(l) / 2;
      const nx = (-dy / len) * half, ny = (dx / len) * half;
      const strip = [{ x: l.a.x + nx, y: l.a.y + ny }, { x: l.b.x + nx, y: l.b.y + ny }, { x: l.b.x - nx, y: l.b.y - ny }, { x: l.a.x - nx, y: l.a.y - ny }];
      scene.polygon(g, strip, [0, 1, 2, 0, 2, 3], rgba(PLAN.bend, 0.35));
      scene.segment(g, l.a, l.b, mil(6), rgba(col), 2);
      for (const e of [l.a, l.b]) { scene.circle(g, e, 5 * px, rgba(col)); scene.circle(g, e, 3 * px, rgba(0xffffff)); }
      emit({ key, bbox: bboxOf(strip), test: (p, tol) => distToSegment(p, l.a, l.b) <= tol + mil(8), draw: () => {}, order: 0 });
    }));
  }

  /**
   * Rooms (Room Definition rules): a see-through fill, the outline and the name at the top left,
   * in AD17's room colour [est]; each picks by its outline or name as `room:i` (i its rule).
   */
  private drawRooms(scene: Scene, emit: (it: HitItem) => void, draft = false): void {
    const rooms = roomsOf(this.doc);
    if (!rooms.length) return;
    const g = scene.group('rooms', ABOVE + 860);
    for (const r of rooms) {
      const key = `room:${r.rule}`;
      if (this.ghost?.keys.has(key)) continue;
      const o = r.outline, tris = triangulate(o), bb = bboxOf(o);
      const a = r.enabled ? 1 : 0.45;
      if (!draft) scene.polygon(g, o, tris, rgba(ROOM, 0.13 * a));
      scene.polyline(g, o, 0, rgba(ROOM, 0.85 * a), true);
      const size = Math.min(mil(60), Math.max(mil(12), (bb.maxX - bb.minX) / 14));
      const at = { x: bb.minX + size * 0.4, y: bb.maxY - size * 0.3 };
      scene.text(g, at, { text: r.name, size, rot: 0, color: css(ROOM, 0.9 * a), h: 0, v: 2, family: 'Arial, sans-serif' });
      const label = { minX: at.x, maxX: at.x + size * 0.6 * r.name.length, minY: at.y - size, maxY: at.y };
      emit({ key, bbox: bb, layer: r.layer, order: 0, draw: (s, gg, c) => s.polyline(gg, o, 0, c, true),
        test: (q, tol) => { for (let i = 0; i < o.length; i++) if (distToSegment(q, o[i]!, o[(i + 1) % o.length]!) <= tol + mil(3)) return true;
          return q.x >= label.minX && q.x <= label.maxX && q.y >= label.minY && q.y <= label.maxY; } });
    }
  }
  /**
   * The Layout Planner's zones: each group's area as a see-through fill in its own colour with its
   * outline (dashed-looking: thinner for a group on the bottom side) and its name in the middle,
   * and a dot with the designator where the plan puts a part at the board's edge. Nothing to pick.
   */
  private drawPlanZones(scene: Scene): void {
    const z = this.planZones;
    if (!z) return;
    const g = scene.group('planzones', ABOVE + 858);
    for (const zone of z.zones) {
      const b = zone.box, o = [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
      scene.polygon(g, o, [0, 1, 2, 0, 2, 3], rgba(zone.colour, zone.bottom ? 0.1 : 0.2));
      scene.polyline(g, o, 0, rgba(zone.colour, 0.95), true, zone.bottom ? 1 : 2);
      const w = b.maxX - b.minX, h = b.maxY - b.minY;
      const size = Math.max(mil(8), Math.min(mil(80), h / 4, w / Math.max(4, zone.name.length * 0.62)));
      scene.text(g, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, { text: zone.name, size, rot: 0, color: css(zone.colour, 1), h: 1, v: 1, readable: true, family: 'Arial, sans-serif' });
    }
    // The marks sized to the board (a seventieth of its longer side), so they read at the zoom that shows it whole
    const r = z.markSize;
    for (const m of z.marks) {
      scene.circle(g, m.at, r, rgba(0xffffff, 0.95));
      scene.circle(g, m.at, r * 0.68, rgba(0xff8a00, 1));
      scene.text(g, { x: m.at.x, y: m.at.y + r * 1.4 }, { text: m.label, size: r * 1.7, rot: 0, color: '#ffd9a8', h: 1, v: 0, readable: true, family: 'Arial, sans-serif' });
    }
  }
  /** Work guides as thin lines across the board's area (points as small crosses); local grids by their frame and lines. */
  private drawGridsAndGuides(scene: Scene): void {
    const { grids, guides } = this.gridsAndGuides();
    if (!grids.length && !guides.length) return;
    const g = scene.group('guides', ABOVE + 865);
    const o = this.doc.board.outline.length ? this.doc.board.outline : [{ x: 0, y: 0 }, { x: mil(10000), y: mil(8000) }];
    const xs = o.map((q) => q.x), ys = o.map((q) => q.y);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 2 + mil(2000);
    const gc = rgba(GUIDE, 0.7);
    for (const gd of guides) {
      if (!gd.enabled) continue;
      const a = gd.at;
      if (gd.kind === 'h') scene.segment(g, { x: a.x - span, y: a.y }, { x: a.x + span, y: a.y }, 0, gc, 1);
      else if (gd.kind === 'v') scene.segment(g, { x: a.x, y: a.y - span }, { x: a.x, y: a.y + span }, 0, gc, 1);
      else if (gd.kind === 'p45') scene.segment(g, { x: a.x - span, y: a.y - span }, { x: a.x + span, y: a.y + span }, 0, gc, 1);
      else if (gd.kind === 'm45') scene.segment(g, { x: a.x - span, y: a.y + span }, { x: a.x + span, y: a.y - span }, 0, gc, 1);
      else { const r = mil(15); scene.segment(g, { x: a.x - r, y: a.y }, { x: a.x + r, y: a.y }, 0, gc, 1); scene.segment(g, { x: a.x, y: a.y - r }, { x: a.x, y: a.y + r }, 0, gc, 1); }
    }
    const lc = rgba(hexToRgb(settings.pcbGridColour), 0.35), fc = rgba(hexToRgb(settings.pcbGridColour), 0.8);
    for (const gr of grids) {
      if (!gr.enabled) continue;
      if (gr.kind === 'cartesian') {
        const a = gr.area;
        scene.polyline(g, [{ x: a.minX, y: a.minY }, { x: a.maxX, y: a.minY }, { x: a.maxX, y: a.maxY }, { x: a.minX, y: a.maxY }], 0, fc, true, 1);
        const nx = Math.floor((a.maxX - a.minX) / gr.stepX), ny = Math.floor((a.maxY - a.minY) / gr.stepY);
        if (nx + ny > 600) continue;
        for (let i = 1; i < nx + 1; i++) scene.segment(g, { x: a.minX + i * gr.stepX, y: a.minY }, { x: a.minX + i * gr.stepX, y: a.maxY }, 0, lc, 0.5);
        for (let j = 1; j < ny + 1; j++) scene.segment(g, { x: a.minX, y: a.minY + j * gr.stepY }, { x: a.maxX, y: a.minY + j * gr.stepY }, 0, lc, 0.5);
      } else {
        const rings = Math.floor((gr.r1 - gr.r0) / gr.radialStep), spokes = Math.floor((gr.a1 - gr.a0) / gr.angleStep);
        if (rings + spokes > 600) continue;
        for (let i = 0; i <= rings; i++) { const r = gr.r0 + i * gr.radialStep; if (r > 0) scene.arc(g, gr.centre, r, gr.a0, gr.a1, 0, i === 0 || i === rings ? fc : lc, 0.5); }
        for (let k = 0; k <= spokes; k++) { const t = ((gr.a0 + k * gr.angleStep) * Math.PI) / 180; scene.segment(g, { x: gr.centre.x + gr.r0 * Math.cos(t), y: gr.centre.y + gr.r0 * Math.sin(t) }, { x: gr.centre.x + gr.r1 * Math.cos(t), y: gr.centre.y + gr.r1 * Math.sin(t) }, 0, lc, 0.5); }
      }
    }
  }
  selectedRooms(): number[] { return [...this.selection].filter((k) => k.startsWith('room:')).map((k) => Number(k.slice(5))).filter((i) => !!this.doc.rules[i]); }

  /** Dimensions (Dimensions6): lines, arcs and the value text on their layer; each picks as `dim:i`. */
  private drawDimensions(scene: Scene, emit: (it: HitItem) => void, draft = false): void {
    const edge = dimensionEdges(this.doc.prims);
    for (const d of this.doc.dimensions) {
      const key = `dim:${d.index}`;
      if (this.ghost?.keys.has(key)) continue;
      const geo = dimensionGeometry(d, false, edge), strokes = geometryStrokes(geo);
      const draw = (s: Scene, g: DrawGroup, c: number) => {
        // Draft: hairlines
        for (const st of strokes) for (let i = 1; i < st.pts.length; i++) s.segment(g, st.pts[i - 1]!, st.pts[i]!, draft ? 0 : st.w, c, draft ? 1 : 0.5);
        for (const a of geo.arcs) s.arc(g, a.c, a.r, a.start, a.end, draft ? 0 : a.w, c, draft ? 1 : 0.5);
      };
      const g = scene.group(`L${d.layer}`, this.layerZ(d.layer));
      g.visible = this.layerVisible(d.layer);
      draw(scene, g, rgba(this.planning ? PLAN.other : layerColour(d.layer)));
      const boxes = geo.texts.map(textBox);
      emit({ key, bbox: geometryBox(geo), layer: d.layer, order: 0, draw,
        test: (q, tol) => strokes.some((st) => st.pts.some((v, i) => i > 0 && distToSegment(q, st.pts[i - 1]!, v) <= st.w / 2 + tol))
          || geo.arcs.some((a) => distToArc(q, a.c, a.r, a.start, a.end) <= a.w / 2 + tol) || boxes.some((b) => pointInPoly(q, b)) });
    }
  }
  selectedDimensions(): number[] { return [...this.selection].filter((k) => k.startsWith('dim:')).map((k) => Number(k.slice(4))).filter((i) => !!this.doc.dimensions[i]); }

  /** View › Connections › Hide Net / Component Nets: nets whose connection lines aren't drawn. */
  hiddenConnections = new Set<number>();
  /** The layer of what a connection line can end at (pads, vias, track and arc ends), by point. */
  private connectionEnds(): Map<string, LayerId> {
    const m = new Map<string, LayerId>();
    const put = (v: Vec2, l: LayerId) => { const k = `${v.x},${v.y}`; if (!m.has(k) || l === L.MULTI) m.set(k, l); };
    for (const p of this.doc.prims) {
      if (p.kind === 'pad') put(p.at, p.layer);
      else if (p.kind === 'via') put(p.at, L.MULTI);
      else if (p.kind === 'track') { put(p.a, p.layer); put(p.b, p.layer); }
      else if (p.kind === 'arc') for (const a of [p.start, p.end]) put({ x: p.c.x + p.r * Math.cos(a * DEG), y: p.c.y + p.r * Math.sin(a * DEG) }, p.layer);
    }
    return m;
  }
  /** Wire links' wires drawn over the copper (on their mechanical layer alone a pour would hide them), when their layer is shown. */
  private drawWireLinks(scene: Scene): void {
    const links = wireLinks(this.doc);
    if (!links.length) return;
    const g = scene.group('wirelinks', kindZ('connect', drawOrder()) + 40);
    for (const w of links) {
      if (!this.layerVisible(w.layer)) continue;
      if (this.ghost?.comps.has(w.comp)) continue;
      const c = rgba(layerColour(w.layer), 0.9);
      for (const [a, b] of w.segs) scene.segment(g, a, b, w.width, c, 1);
    }
  }
  /** Connection lines (ratsnest) for what is still unrouted. */
  private drawConnections(scene: Scene): void {
    const g = scene.group('connections', kindZ('connect', drawOrder()) + 50);
    g.visible = settings.pcbShowConnections;
    const c = rgba(hexToRgb(settings.pcbConnectionColour));
    const moving = this.ghost?.points;
    // View Options › Show All Connections in Single Layer Mode off: only the lines with an end on the current layer (or on every layer)
    const single = this.singleLayer !== 'off' && !settings.pcbAllConnectionsSingle;
    const byLayer = settings.pcbConnectionLayerColours;
    const ends = single || byLayer ? this.connectionEnds() : null;
    const cur = this.currentLayer;
    // Use Layer Colours For Connection Drawing: each half in its end's layer's colour (an end on every layer takes the other's, or the current signal layer's)
    const own = (l: LayerId | undefined, other: LayerId | undefined) => layerColour(l !== undefined && l !== L.MULTI ? l : other !== undefined && other !== L.MULTI ? other : isSignal(cur) ? cur : L.TOP);
    // Smart Track Ends: a partly routed net's lines from where its copper ends, not only its pads
    for (const k of connectionLines(this.doc, settings.pcbSmartTrackEnds)) {
      // Lines to objects being moved are drawn by the move tool
      if (moving && (moving.has(`${k.a.x},${k.a.y}`) || moving.has(`${k.b.x},${k.b.y}`))) continue;
      if (this.hiddenConnections.has(k.net)) continue;
      const la = ends?.get(`${k.a.x},${k.a.y}`), lb = ends?.get(`${k.b.x},${k.b.y}`);
      if (single && !(la === undefined || la === L.MULTI || la === cur || lb === undefined || lb === L.MULTI || lb === cur)) continue;
      if (!byLayer) { scene.segment(g, k.a, k.b, 0, c, 1); continue; }
      const mid = { x: (k.a.x + k.b.x) / 2, y: (k.a.y + k.b.y) / 2 };
      scene.segment(g, k.a, mid, 0, rgba(own(la, lb)), 1);
      scene.segment(g, mid, k.b, 0, rgba(own(lb, la)), 1);
    }
    // Jumpers: the pads of a Jumper component that share a Jumper ID, joined by an arc, unless the component or the
    // net hides them (View › Jumpers). Pads with an ID in a component of another type are no jumper, nor are a
    // Jumper's pads with no ID: no arc for them. A wire link (Place › Wire Link) shows its own path on its
    // mechanical layer instead.
    const wired = new Set(wireLinks(this.doc).map((w) => w.comp));
    for (const { a, b, net, comp } of jumperLinks(this.doc)) {
      if (wired.has(comp)) continue;
      const cb = this.doc.components[comp]?.bag, nb = this.doc.nets[net]?.bag;
      if (cb?.has('JUMPERSVISIBLE') && !cb.bool('JUMPERSVISIBLE')) continue;
      if (nb?.has('JUMPERSVISIBLE') && !nb.bool('JUMPERSVISIBLE')) continue;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d = Math.hypot(b.x - a.x, b.y - a.y) / 2;
      if (d < 1) continue;
      const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      scene.arc(g, m, d, ang, ang + 180, 0, c, 1);
    }
  }

  /** Objects being moved: the move tool draws them, the scene leaves them out meanwhile (as Altium moves them live). */
  ghost: { keys: Set<string>; comps: Set<number>; points: Set<string> } | null = null;
  setGhost(g: PcbEditor['ghost']): void { this.ghost = g; this.invalidate(); }
  protected override holdSelection(): boolean { return !!this.ghost; }

  protected override pickable(it: HitItem): boolean {
    if (it.layer === undefined) return true;
    // Board Options › Lock sheet primitives: what lies on the linked layers stays put
    if (isMech(it.layer)) { const sh = this.sheet(); if (sh.lock && sh.linked.has(it.layer)) return false; }
    return this.layerVisible(it.layer);
  }
  protected override pickRank(it: HitItem): number {
    // Pour copper is the background: anything else under the cursor is picked first
    const pour = it.key.startsWith('poly:') ? -4e9 : 0;
    // Vias and through-hole pads draw above every layer, so they pick above the current layer too
    return pour + (it.layer === L.MULTI ? 1.5e9 : it.layer === this.currentLayer ? 1e9 : this.layerZ(it.layer ?? 0) * 1e5) + it.order;
  }

  /** Preferences › PCB Editor › Display › Show Repaint Indicator. */
  repaintIndicator = (): boolean => settings.pcbRepaintIndicator;

  override tints(): Map<string, Tint> | undefined {
    if (this.singleLayer !== 'grey' && this.singleLayer !== 'mono') return undefined;
    const m = new Map<string, Tint>();
    // Grey scale: the other layers darkened; monochrome: all in one grey
    const t = this.singleLayer === 'mono' ? { rgb: 0x6c6c6c, amount: 1 } : { rgb: 0x3a4240, amount: 0.8 };
    for (const l of this.layers()) if (l !== this.currentLayer && !this.mechInSingle(l)) m.set(`L${l}`, t);
    return m;
  }

  /** System Colours › Highlight Colour. */
  protected override highlightColour(): number { return hexToRgb(settings.pcbHighlightColour); }

  /** View Options › Show Status Info: what lies under the cursor (kind, place, layer, net), for the status bar. */
  statusInfo(): string {
    if (!settings.pcbShowStatusInfo || this.mode3d || this.planning) return '';
    const h = this.hits(this.cursor)[0];
    if (!h) return '';
    const prim = this.primByKey(h.key);
    if (prim) {
      const i = this.doc.prims.indexOf(prim);
      const net = 'net' in prim ? copperNet(this.doc, prim) : NO_NET;
      return `${describePrim(this.doc, i)}${net !== NO_NET ? `, net ${netName(this.doc, net)}` : ''}`;
    }
    return this.unitKind(this.keysFor(h.key), h.key);
  }

  protected override extraHighlight(): Set<HitItem> {
    if (this.highlightNet === null) return new Set();
    // Preferences › Display › Highlighting Options: none while a tool works (if so set); the net's objects on hidden layers too, or only those shown
    if (!settings.pcbHighlightWhileEditing && this.tool !== this.selectTool) return new Set();
    this.scene();
    return new Set(this.items.filter((i) => i.net === this.highlightNet && (settings.pcbHighlightAllPrims || i.layer === undefined || this.layerVisible(i.layer))));
  }
  /** A tool taken up or put down: the mask comes and goes with it (Apply Mask During Interactive Editing off). */
  override setTool(t: Tool | null): void {
    const was = this.tool === this.selectTool;
    super.setTool(t);
    if (this.mask && !settings.pcbMaskWhileEditing && was !== (this.tool === this.selectTool)) this.invalidate();
  }

  /* ── Board Insight: live highlighting, and the heads-up display by the cursor ── */
  /** The net under the cursor (live highlighting), the one drawn (it stays while it fades), and how lit it is (0–1). */
  private liveNet: number | null = null;
  private liveShown: number | null = null;
  private liveLevel = 0;
  private liveFrame = 0;
  /** What an analysis lays over the board (Tools › Power Analysis): its pictures of a copper layer, and what it says of a place on it. */
  analysis: { images(layer: LayerId): { a: Vec2; b: Vec2; src: CanvasImageSource }[]; probe(at: Vec2, layer: LayerId): string[]; /** How solid the pictures are drawn (1 when not said). */ alpha?: number } | null = null;
  setAnalysis(a: PcbEditor['analysis']): void { this.analysis = a; this.invalidate(); }
  /** The Layout Planner's zones over the board (model/layoutPlan): each group's area with its name, and the parts the plan puts at an edge. */
  planZones: { zones: { name: string; box: BBox; colour: number; bottom: boolean }[]; marks: { at: Vec2; label: string }[]; markSize: number } | null = null;
  setPlanZones(z: PcbEditor['planZones']): void { this.planZones = z; this.invalidate(); }
  private hudAt: Vec2 | null = null;
  private hudDelta: Vec2 | null = null;
  private hudHover = false;
  private hudTimer: ReturnType<typeof setTimeout> | undefined;

  /** The cursor moved: the net it is over lights up (Preferences › Board Insight Display › Live Highlighting); the heads-up display follows it. */
  private hover(p: ToolPointer): void {
    let net: number | null = null;
    if (settings.pcbLive && this.tool === this.selectTool && !this.press && (!settings.pcbLiveShift || p.shift)) {
      net = this.hits(p.raw).find((h) => h.net !== undefined && h.net !== NO_NET)?.net ?? null;
    }
    if (net !== this.liveNet) {
      this.liveNet = net;
      if (net !== null) this.liveShown = net;
      this.animateLive();
    }
    this.hudAt = p.raw;
    // (with the heads-up display off, the cursor resting on a violation still says what the violation is)
    if (settings.pcbHud || this.violations.length || this.analysis) {
      // Resting the cursor (Hover Mode Delay) adds what lies under it
      const was = this.hudHover;
      this.hudHover = false;
      clearTimeout(this.hudTimer);
      this.hudTimer = setTimeout(() => { this.hudHover = true; this.viewport?.requestRender(); }, Math.max(0, settings.pcbHudHoverDelay));
      // (an analysis's read-out follows the cursor as it moves)
      if (settings.pcbHud || was || this.analysis) this.viewport?.requestRender();
    }
  }
  /** The live highlight's fade, frame by frame: up over Ramp Up Time, down over Ramp Down Time. */
  private animateLive(): void {
    if (this.liveFrame || typeof requestAnimationFrame === 'undefined') { if (typeof requestAnimationFrame === 'undefined') { this.liveLevel = this.liveNet !== null ? 1 : 0; if (!this.liveLevel) this.liveShown = null; } return; }
    let last = performance.now();
    // (the frames of the window the board is in: it may be a document window)
    const raf = (f: FrameRequestCallback) => (this.viewport?.host.ownerDocument.defaultView ?? window).requestAnimationFrame(f);
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      const target = this.liveNet !== null ? 1 : 0;
      const ramp = Math.max(1, target ? settings.pcbLiveUp : settings.pcbLiveDown);
      this.liveLevel = target > this.liveLevel ? Math.min(1, this.liveLevel + dt / ramp) : Math.max(0, this.liveLevel - dt / ramp);
      this.redrawOverlay();
      if (this.liveLevel !== target) { this.liveFrame = raf(step); return; }
      this.liveFrame = 0;
      if (!target) this.liveShown = null;
    };
    this.liveFrame = raf(step);
  }
  protected override liveHighlight(): LiveHighlight | null {
    if (this.liveShown === null || this.liveLevel <= 0 || this.liveShown === this.highlightNet) return null;
    this.scene();
    const items = this.items.filter((i) => i.net === this.liveShown && (i.layer === undefined || this.layerVisible(i.layer)));
    // Show Locked Texture on Objects › Only when Live Highlighting: the locked ones it lights, textured
    const textured = settings.pcbLockedTexture === 'live' ? items.filter((i) => { const p = this.primByKey(i.key); return !!p && 'locked' in p && p.locked; }) : [];
    // Lit faintly (a pour not at all, or the board would wash out), outlined as strongly as Outline Strength
    const level = this.liveLevel;
    return items.length ? { items: items.filter((i) => !i.key.startsWith('poly:')), alpha: level * 0.3, colour: 0xffffff,
      outlines: items, outlineAlpha: level * (settings.pcbLiveStrength / 100), textured, texture: LOCKED_TEXTURE } : null;
  }
  /** Display › Highlight In Full: selected objects filled in the selection colour; off, outlined. */
  protected override highlightInFull(): boolean { return settings.pcbHighlightInFull; }
  /** Display › Antialiased Text off: strings hard-edged. */
  hardText(): boolean { return !settings.pcbAntialiasText; }
  /** Display › Use Alpha Blending: the area dragged out to select shaded see-through. */
  areaShade(): string | null { return settings.pcbAlphaBlending ? css(hexToRgb(settings.selectionColour), 0.16) : null; }
  /** The net live highlighting lights now (tests). */
  get liveHighlightNet(): number | null { return this.liveNet; }

  /** Shift+H: the heads-up display on or off. Insert: its delta origin where the cursor is. */
  resetHudDelta(): void { this.hudDelta = this.hudAt ? this.snap(this.hudAt) : null; this.viewport?.requestRender(); }

  /** The violations at the cursor, in words: those marked within reach of it and those of the objects under it (three at most). */
  private violationLines(hits: { key: string }[]): string[] {
    if (!this.hudAt || !this.violations.length) return [];
    const keys = new Set(hits.map((h) => h.key)), near = Math.max(mil(30), 10 / (this.viewport?.cam.scale ?? 1)), at = this.hudAt;
    const here = this.violations.filter((v) => Math.hypot(v.at.x - at.x, v.at.y - at.y) < near || v.prims.some((i) => { const p = this.doc.prims[i]; return !!p && keys.has(primKey(p)); }));
    return [...here.slice(0, 3).map((v) => `Violation: ${v.message}`), ...(here.length > 3 ? [`and ${here.length - 3} more (right-click › Violations, or the PCB Rules And Violations panel)`] : [])];
  }

  /**
   * The heads-up display's lines (Preferences › Board Insight Modes): where the cursor is, how far
   * from the delta origin, the layer, the grid, and — as set, or after the cursor has rested —
   * what lies under it: a summary, its violations, nets, component and the objects themselves.
   */
  hud(): { lines: string[]; background: boolean } | null {
    if (!this.hudAt) return null;
    if (!settings.pcbHud) {
      // The heads-up display off: the violations under a resting cursor all the same (a marker says there is one, not what it is)
      const lines = this.hudHover && this.tool === this.selectTool ? this.violationLines(this.hits(this.hudAt)) : [];
      // …and an analysis's reading of the place under the cursor, as it moves
      const read = this.analysis && this.tool === this.selectTool ? this.analysis.probe(this.hudAt, this.currentLayer) : [];
      return lines.length || read.length ? { lines: [...read, ...lines], background: true } : null;
    }
    const u = this.units(), o = this.origin(), at = this.snap(this.hudAt), f = (v: number) => formatCoord(v, u);
    const lines: string[] = [];
    if (settings.pcbHudCursor) lines.push(`x: ${f(at.x - o.x)}  y: ${f(at.y - o.y)}`);
    if (settings.pcbHudDelta) { const d = this.hudDelta ?? o; lines.push(`dx: ${f(at.x - d.x)}  dy: ${f(at.y - d.y)}`); }
    if (settings.pcbHudLayer) lines.push(this.layerLabel(this.currentLayer));
    if (settings.pcbHudGrid) lines.push(`Snap: ${f(this.gridSize())}`);
    if (settings.pcbHudShortcuts) lines.push('Shift+H heads up   Ins delta origin');
    if (this.analysis) lines.push(...this.analysis.probe(this.hudAt, this.currentLayer));
    const hover = this.hudHover;
    const hits = (hover || settings.pcbHudSummary || settings.pcbHudNet || settings.pcbHudComponent || settings.pcbHudPrimitive || settings.pcbHudViolations) ? this.hits(this.hudAt) : [];
    const prims = [...new Set(hits.map((h) => this.primByKey(h.key)).filter((p): p is PcbPrim => !!p))];
    if ((hover || settings.pcbHudSummary) && hits.length) {
      const kinds = new Map<string, number>();
      for (const p of prims) kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1);
      const name = (k: string, n: number) => { const w = HUD_KINDS[k] ?? k; return n === 1 ? w : w.endsWith('y') ? `${w.slice(0, -1)}ies` : `${w}s`; };
      lines.push(`${prims.length} object${prims.length === 1 ? '' : 's'}: ${[...kinds].map(([k, n]) => `${n} ${name(k, n)}`).join(', ')}`);
    }
    if (hover || settings.pcbHudViolations) lines.push(...this.violationLines(hits));
    if (hover || settings.pcbHudNet) for (const n of [...new Set(hits.map((h) => h.net).filter((n): n is number => n !== undefined && n !== NO_NET))].slice(0, 3)) lines.push(`Net ${netName(this.doc, n)}`);
    if (hover || settings.pcbHudComponent) {
      for (const c of [...new Set(prims.map((p) => ('component' in p ? p.component : NO_NET)).filter((c) => c !== NO_NET && !!this.doc.components[c]))].slice(0, 2)) {
        const comp = this.doc.components[c]!;
        const ct = this.doc.prims.find((q) => q.kind === 'text' && q.isComment && q.component === c);
        const comment = ct?.kind === 'text' ? ct.text : '';
        lines.push(`${comp.designator}${comment ? ` ${comment}` : ''}${comp.pattern ? ` (${comp.pattern})` : ''}`);
      }
    }
    if (hover || settings.pcbHudPrimitive) {
      for (const p of prims.slice(0, 3)) {
        const where = 'layer' in p ? ` on ${this.layerLabel(p.layer)}` : '';
        const size = p.kind === 'track' || p.kind === 'arc' ? ` ${f(p.width)}` : p.kind === 'via' ? ` ${f(p.diameter)}` : p.kind === 'pad' ? ` ${p.name}` : '';
        const w = HUD_KINDS[p.kind] ?? p.kind;
        lines.push(`${w[0]!.toUpperCase()}${w.slice(1)}${size}${where}`);
      }
    }
    return lines.length ? { lines, background: settings.pcbHudBackground } : null;
  }

  /** Ctrl+click: highlight the whole net under the cursor; Ctrl+click empty space clears. */
  highlightNetAt(p: Vec2): void {
    const hit = this.hits(p).find((h) => h.net !== undefined && h.net !== NO_NET);
    this.highlightNet = hit?.net ?? null;
    this.invalidateOverlay();
  }
  clearHighlight(): void { this.highlightNet = null; this.invalidateOverlay(); }

  /* ── selection: a click selects a whole component (its designator or comment alone),
     a pour by its copper or outline, anything else by itself; dragging moves the selection ── */
  private press: { keys: string[]; at: Vec2; raw: Vec2; wasSelected: boolean } | null = null;

  /** The component owning the topmost primitive under p, if any. */
  componentAt(raw: Vec2): number | null {
    for (const h of this.hits(raw)) {
      const prim = this.primByKey(h.key);
      if (prim && 'component' in prim && prim.component !== NO_NET && this.doc.components[prim.component]) return prim.component;
    }
    return null;
  }
  componentKeys(idx: number): string[] {
    return this.doc.prims.filter((q) => 'component' in q && q.component === idx).map(primKey);
  }
  selectComponent(idx: number): void {
    this.selection = new Set(this.componentKeys(idx));
    this.invalidateOverlay();
  }
  /** What a click on this item selects. */
  keysFor(key: string): string[] {
    const prim = this.primByKey(key);
    const own = prim && 'component' in prim && prim.component !== NO_NET && this.doc.components[prim.component]
      && !(prim.kind === 'text' && (prim.isDesignator || prim.isComment)) ? this.componentKeys(prim.component)
      // A polygon pad's pad and shape select together
      : prim ? padShapeGroup(this.doc.prims, prim) : [key];
    // A union's members select together
    const u = prim ? (own.length > 1 && 'component' in prim ? componentUnion(this.doc, prim.component) : unionOf(this.doc, prim)) : 0;
    return u ? this.unionKeys(u) : own;
  }
  /** Every member of a union (its components whole). */
  unionKeys(u: number): string[] {
    const m = unionMembers(this.doc, u);
    return [...new Set([...m.prims.map(primKey), ...m.components.flatMap((c) => this.componentKeys(c))])];
  }
  /** Edit › Move › Component (M, C): click a component, it follows the cursor, click places; repeats. */
  startMoveComponent(): void { this.setTool(new PcbMoveTool(this, { components: [], polygons: [], prims: [] }, this.cursor, false, 'move', true, 'component')); }

  /** Edit › Move › Move / Drag (pick an object), Move Selection / Drag Selection (pick a reference point). */
  startMove(mode: PcbMoveMode, selection = false): void {
    const set: PcbMoveSet = selection ? this.moveSet() : { components: [], polygons: [], prims: [] };
    this.setTool(new PcbMoveTool(this, set, this.cursor, false, mode, true));
  }

  /** A component is selected whole or not at all; a window selection needs all of it inside. */
  override normaliseSelection(keys: string[], crossing: boolean): string[] {
    const set = new Set(keys), out = new Set<string>();
    const comps = new Map<number, string[]>();
    for (const k of keys) {
      const p = this.primByKey(k);
      if (p && 'component' in p && p.component !== NO_NET && this.doc.components[p.component]) { if (!comps.has(p.component)) comps.set(p.component, this.componentKeys(p.component)); }
      else out.add(k);
    }
    // The Selection Filter: kinds that are off are left out
    for (const k of [...out]) if (!selects(this.filterKind(k))) out.delete(k);
    for (const [c, ks] of comps) {
      const shown = ks.filter((k) => { const p = this.primByKey(k); return !(p?.kind === 'text' && p.hidden); });
      if (!selects('Components')) {
        // Components off: its pads on their own (and, with Lock Primitives off, its other primitives), each by its kind
        const locked = this.primsLocked(c);
        for (const k of shown) { const p = this.primByKey(k); if (set.has(k) && p && (p.kind === 'pad' || !locked || (p.kind === 'text' && (p.isDesignator || p.isComment))) && selects(this.filterKind(k))) out.add(k); }
      } else if (crossing ? shown.some((k) => set.has(k)) : shown.every((k) => set.has(k))) { for (const k of ks) out.add(k); }
      else if (!crossing) {
        // The designator or comment on its own, when only it is inside
        for (const k of shown) { const p = this.primByKey(k); if (set.has(k) && p?.kind === 'text' && (p.isDesignator || p.isComment) && selects('Texts')) out.add(k); }
      }
    }
    return [...out];
  }
  /** Edit › Select › All On Layer: everything on the current layer (pads on it or multi-layer). */
  selectAllOnLayer(): void {
    this.scene();
    const l = this.currentLayer;
    this.selection = new Set(this.normaliseSelection([...new Set(this.items.filter((i) => i.layer === l).map((i) => i.key))], true).filter((k) => {
      const p = this.primByKey(k);
      return !p || !('component' in p) || p.component === NO_NET || ('layer' in p && p.layer === l);
    }));
    this.invalidateOverlay();
  }
  /** Edit › Select › Net: every track, arc, via, pad and pour of a net. */
  selectNet(net: number, add = false): void {
    if (net === NO_NET) return;
    if (!add) this.selection.clear();
    for (const p of this.doc.prims) if ('net' in p && p.net === net) this.selection.add(primKey(p));
    for (const pg of this.doc.polygons) if (pg.net === net) this.selection.add(`poly:${pg.index}`);
    this.invalidateOverlay();
  }

  /** Edit › Select › Connected Copper (Ctrl+H): copper touching the object under p, through vias and pads. */
  selectConnectedCopper(raw: Vec2, add = false): boolean {
    const hit = this.hits(raw).find((h) => { const p = this.primByKey(h.key); return !!p && p.kind !== 'text' && p.kind !== 'fill' || !!p && p.kind === 'fill' && isSignal(p.layer); });
    const prim = hit ? this.primByKey(hit.key) : undefined;
    if (!prim) return false;
    const start = this.doc.prims.indexOf(prim);
    if (!add) this.selection.clear();
    for (const i of connectedCopper(this.doc, start)) { const k = this.keyOf(i); if (k) this.selection.add(k); }
    this.invalidateOverlay();
    return true;
  }

  /** The objects a click at p would move (for Move / Drag picking). */
  moveSetAt(raw: Vec2): PcbMoveSet | null {
    const hit = this.hits(raw)[0];
    if (!hit) return null;
    const keys = this.keysFor(hit.key);
    this.select(keys);
    return this.moveSet(keys);
  }

  /** The selection as move targets: whole components, pours, and free objects (or a lone designator). */
  moveSet(keys: Iterable<string> = this.selection): PcbMoveSet {
    const doc = this.doc;
    const polygons = new Set<number>(), dims = new Set<number>(), rooms = new Set<number>(), byComp = new Map<number, PcbPrim[]>(), prims: PcbPrim[] = [];
    const taken = new Set<string>();
    for (const k of keys) {
      taken.add(k);
      if (k.startsWith('poly:')) { const i = Number(k.slice(5)); if (doc.polygons[i]) polygons.add(i); continue; }
      if (k.startsWith('room:')) { const i = Number(k.slice(5)); if (doc.rules[i]) rooms.add(i); continue; }
      if (k.startsWith('dim:')) { const i = Number(k.slice(4)); if (doc.dimensions[i]) dims.add(i); continue; }
      const p = this.primByKey(k);
      if (!p) continue;
      if ('component' in p && p.component !== NO_NET && doc.components[p.component]) {
        const a = byComp.get(p.component);
        if (a) a.push(p); else byComp.set(p.component, [p]);
      } else prims.push(p);
    }
    const components: number[] = [];
    for (const [c, ps] of byComp) {
      if (!ps.some((q) => q.kind !== 'text' || !(q.isDesignator || q.isComment))) prims.push(...ps);
      // With Lock Primitives off, primitives of a component selected without the rest of it are on their own
      else if (!this.primsLocked(c) && !this.componentKeys(c).every((k) => taken.has(k))) prims.push(...ps);
      else components.push(c);
    }
    // A room moves what lies in it (unlocked components)
    for (const r of roomsOf(doc)) if (rooms.has(r.rule)) for (const c of componentsIn(doc, r)) if (!components.includes(c) && !doc.components[c]!.bag.bool('LOCKED')) components.push(c);
    return { components, polygons: [...polygons], prims, dimensions: [...dims], rooms: [...rooms] };
  }

  /** Ctrl + press on an edge of the selected polygon (as in AD): the vertex added there, dragged from the press. */
  private edgeAt(raw: Vec2): number | null {
    const s = this.soleSelection();
    if (!s || !('polygon' in s)) return null;
    const vs = this.doc.polygons[s.polygon]!.vertices;
    const tol = 6 / (this.viewport?.cam.scale ?? 1);
    let best: number | null = null, bd = tol;
    vs.forEach((v, i) => {
      if (v.arc) return;
      const d = distToSegment(raw, v.p, vs[(i + 1) % vs.length]!.p);
      if (d <= bd) { best = i; bd = d; }
    });
    return best;
  }

  override pointerDown(p: ToolPointer): void {
    this.press = null;
    this.cancelChoice();
    // Heads-up display: a click is the new delta origin (Mouse Click Resets Heads Up Delta Origin)
    if (p.button === 0 && settings.pcbHudClickResets) this.hudDelta = this.snap(p.world);
    if (p.ctrl && this.tool === this.selectTool && p.button === 0) {
      const e = this.edgeAt(p.raw);
      const s = this.soleSelection();
      if (e !== null && s) { this.setTool(new PcbGripTool(this, s, EDGE_GRIP + e, p.world)); return; }
    }
    if (p.ctrl && this.tool === this.selectTool) { this.highlightNetAt(p.raw); return; }
    if (this.tool === this.selectTool && p.button === 0) {
      if (!p.shift) {
        const grip = this.gripAt(p.raw);
        if (grip) { this.startGrip(grip, p.world); return; }
      }
      // What is selected already stays the one, where the press is on it (an object chosen from the popup of overlapping objects is the one dragged)
      const units = this.unitsAt(p.raw, p.shift);
      const hit = units.find((u) => u.keys.length === this.selection.size && u.keys.every((k) => this.selection.has(k))) ?? units[0];
      if (hit) {
        const keys = hit.keys;
        if (p.shift) {
          const all = keys.every((k) => this.selection.has(k));
          for (const k of keys) { if (all) this.selection.delete(k); else this.selection.add(k); }
          this.invalidateOverlay();
          return;
        }
        const wasSelected = keys.every((k) => this.selection.has(k));
        if (!wasSelected) this.select(keys);
        this.press = { keys, at: p.world, raw: p.raw, wasSelected };
        return;
      }
      // What is there is not for this click to take (the Selection Filter passes it over, or it wants Shift): as a click on
      // empty space, and the filter's part in it is said so that a click that takes nothing is understood
      const under = this.hits(p.raw);
      if (under.length) {
        const passed = under.map((h) => { const q = this.primByKey(h.key); return q && 'component' in q && q.component !== NO_NET && this.doc.components[q.component] && q.kind !== 'pad' ? 'Components' : this.filterKind(h.key); }).filter((k) => !selects(k));
        if (passed.length) this.status?.(`${[...new Set(passed)].join(', ')} ${new Set(passed).size === 1 ? 'is' : 'are'} off in the Selection Filter (the Inspector, with nothing selected)`);
        if (settings.pcbClickClearsSelection && !p.shift) this.clearSelection();
        return;
      }
      // Click Clears Selection off: a click on empty space keeps the selection
      if (!settings.pcbClickClearsSelection && !p.shift) return;
    }
    super.pointerDown(p);
  }
  override pointerMove(p: ToolPointer): void {
    this.hover(p);
    const pr = this.press;
    if (pr && this.tool === this.selectTool) {
      const px = Math.hypot(p.raw.x - pr.raw.x, p.raw.y - pr.raw.y) * (this.viewport?.cam.scale ?? 1);
      if (px > 4) {
        this.press = null;
        // A lone via or free track drags (Preferences › Interactive Routing › Dragging), keeping its connections
        const one = pr.keys.length === 1 ? this.primByKey(pr.keys[0]!) : undefined;
        if (one && (this.selection.size === 1 || !pr.wasSelected) && drags(one, pr.wasSelected)) {
          this.setTool(new PcbDragTool(this, one, pr.at));
          super.pointerMove(p);
          return;
        }
        const kept = this.unlockedSet(this.moveSet());
        if (!kept) return;
        this.setTool(new PcbMoveTool(this, kept, pr.at, true, 'move'));
      }
    }
    super.pointerMove(p);
  }
  override pointerUp(p: ToolPointer, moved: boolean): void {
    const pr = this.press;
    this.press = null;
    // A click on one object of a larger selection selects just that object
    if (pr && !moved && pr.wasSelected && this.selection.size > pr.keys.length) this.select(pr.keys);
    // Display popup selection dialog: a click on overlapping objects lists them (once it is not a double-click)
    if (pr && !moved && settings.pcbSelectPopup && this.choose && this.tool === this.selectTool) {
      const units = this.unitsAt(pr.raw, p.shift);
      if (units.length > 1) {
        const at = this.viewport?.cam.toScreen(pr.raw), r = this.viewport?.host.getBoundingClientRect();
        this.choiceTimer = setTimeout(() => {
          this.choiceTimer = undefined;
          if (at && r) this.choose?.(units.map((u) => ({ label: u.label, pick: () => { this.select(u.keys); this.status?.(`${u.label} selected`); } })), { x: r.left + at.x + 8, y: r.top + at.y + 8 });
        }, 320);
      }
    }
    super.pointerUp(p, moved);
  }
  override doubleClick(p: ToolPointer): void {
    this.cancelChoice();
    if (this.tool !== this.selectTool || p.button !== 0 || p.ctrl) { super.doubleClick(p); return; }
    // The object the click took (what was selected already, where the click was on it), not whatever is on top
    const units = this.unitsAt(p.raw, p.shift);
    const hit = units.find((u) => u.keys.length === this.selection.size && u.keys.every((k) => this.selection.has(k))) ?? units[0];
    if (hit) this.editObject?.(hit.key, p); else super.doubleClick(p);
  }

  /**
   * Preferences › PCB Editor › General › Autopan Options: while placing or moving, past the
   * window's edge the view follows — re-centred on the cursor, in fixed jumps, or at Speed mils a
   * second (Shift faster or slower; Ballistic gathering speed; Adaptive the same at any zoom).
   */
  autoPan(): AutoPan | null {
    if (this.tool === this.selectTool) return null;
    const st = settings.pcbAutoPan;
    if (st === 'Disable') return { style: 'off', speed: 1, step: 0, shiftStep: 0 };
    if (st === 'Re-Centre') return { style: 'recenter', speed: 3, step: 0, shiftStep: 0 };
    if (st === 'Fixed Size Jump') return { style: 'jump', speed: 5, step: 30, shiftStep: 100 };
    return { style: 'speed', speed: 30, step: 0, shiftStep: 0, worldSpeed: mil(Math.max(1, settings.pcbAutoPanSpeed)),
      shift: st === 'Shift Accelerate' ? 'faster' : st === 'Shift Decelerate' ? 'slower' : undefined, ballistic: st === 'Ballistic' };
  }

  /** Set by the app: a list to choose from at a point on the screen (the popup selection dialog). */
  choose: ((items: { label: string; pick: () => void }[], at: Vec2) => void) | null = null;
  private choiceTimer: ReturnType<typeof setTimeout> | undefined;
  /** A key, a press or a double-click before the popup selection dialog shows: it doesn't. */
  cancelChoice(): void { if (this.choiceTimer) { clearTimeout(this.choiceTimer); this.choiceTimer = undefined; } }

  /** What a click picks at a point: Shift Click To Select's kinds only with Shift. */
  clickable(raw: Vec2, shift: boolean): HitItem[] {
    const hits = this.hits(raw);
    if (!settings.pcbShiftClickSelect || shift) return hits;
    const kinds = new Set(settings.pcbShiftClickKinds);
    return hits.filter((h) => !kinds.has(this.unitKind(this.keysFor(h.key), h.key)));
  }
  /** The kind a selection unit is, as Shift Click To Select's list names it. */
  unitKind(keys: string[], key: string): string {
    if (key.startsWith('poly:')) return 'Polygon';
    if (key.startsWith('dim:')) return 'Dimension';
    if (key.startsWith('room:')) return 'Room';
    const p = this.primByKey(key);
    if (!p) return '';
    if (keys.length > 1 && 'component' in p && p.component !== NO_NET && this.doc.components[p.component]) return 'Component';
    return { track: 'Track', arc: 'Arc', via: 'Via', pad: 'Pad', fill: 'Fill', region: 'Region', text: 'String', body: '3D Body' }[p.kind] ?? '';
  }
  /** A component's primitives are locked to it (Lock Primitives: the default). */
  primsLocked(c: number): boolean { const bag = this.doc.components[c]?.bag; return !bag || !bag.has('PRIMITIVELOCK') || bag.bool('PRIMITIVELOCK'); }
  /** The Selection Filter's kind a key is of. */
  filterKind(key: string): SelectionKind {
    if (key.startsWith('poly:')) return 'Polygons';
    if (key.startsWith('room:')) return 'Rooms';
    const p = this.primByKey(key);
    if (!p) return 'Other';
    if ('keepout' in p && p.keepout) return 'Keepouts';
    return ({ track: 'Tracks', arc: 'Arcs', via: 'Vias', pad: 'Pads', fill: 'Fills', region: 'Regions', text: 'Texts', body: '3D Bodies' } as Record<string, SelectionKind>)[p.kind] ?? 'Other';
  }
  /**
   * The different things a click at a point could select, named, the one a click takes first. A
   * primitive of a component is its component and, for a pad, itself as well (the component first
   * while it locks its primitives; with Lock Primitives off the primitive first, any primitive).
   * The Selection Filter's kinds that are off are passed over, and without Shift the kinds Shift
   * Click To Select names. Where nothing but a pour is under the point and it is inside a
   * component's area, the component is the one thing offered.
   */
  unitsAt(raw: Vec2, shift = false): { keys: string[]; label: string; key: string }[] {
    const out: { keys: string[]; label: string; key: string }[] = [];
    const seen = new Set<string>();
    const shiftKinds = settings.pcbShiftClickSelect && !shift ? new Set(settings.pcbShiftClickKinds) : null;
    const add = (keys: string[], key: string, whole: boolean): void => {
      const id = [...keys].sort().join('|');
      if (seen.has(id) || shiftKinds?.has(whole ? 'Component' : this.unitKind(keys.length > 1 ? [key] : keys, key))) return;
      seen.add(id);
      out.push({ keys, label: whole ? `Component ${this.doc.components[(this.primByKey(key) as { component: number }).component]!.designator}` : this.unitLabel([key], key), key });
    };
    for (const h of this.hits(raw)) {
      const p = this.primByKey(h.key);
      const comp = p && 'component' in p && p.component !== NO_NET && this.doc.components[p.component] && !(p.kind === 'text' && (p.isDesignator || p.isComment)) ? p.component : -1;
      if (comp < 0 || !p) { if (selects(this.filterKind(h.key))) add(this.keysFor(h.key), h.key, false); continue; }
      const locked = this.primsLocked(comp);
      const whole = (): void => { if (selects('Components')) add(this.keysFor(h.key), h.key, true); };
      const own = (): void => { if ((p.kind === 'pad' || !locked) && selects(this.filterKind(h.key))) add(padShapeGroup(this.doc.prims, p), h.key, false); };
      if (locked) { whole(); own(); } else { own(); whole(); }
    }
    // A pour is the background: listed only when nothing else is there
    const solid = out.filter((u) => !u.keys[0]!.startsWith('poly:'));
    if (solid.length) return solid;
    // On nothing but the background, inside a component's area: the component (its pads may be far apart, or its primitives unlocked)
    const around = selects('Components') && !shiftKinds?.has('Component') ? this.componentAround(raw) : -1;
    if (around >= 0) { const first = this.componentKeys(around)[0]; if (first) return [{ keys: this.keysFor(first), label: `Component ${this.doc.components[around]!.designator}`, key: first }]; }
    return out;
  }
  /** The component whose area a point is in, where no primitive is under it: the smallest such, on a layer that is shown (-1: none). */
  componentAround(raw: Vec2): number {
    this.scene();
    const box = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
    for (const it of this.items) {
      const p = this.primByKey(it.key);
      if (!p || !('component' in p) || p.component === NO_NET || !this.doc.components[p.component] || p.kind === 'text' || !this.canPick(it)) continue;
      const b = box.get(p.component);
      if (!b) box.set(p.component, { x0: it.bbox.minX, y0: it.bbox.minY, x1: it.bbox.maxX, y1: it.bbox.maxY });
      else { b.x0 = Math.min(b.x0, it.bbox.minX); b.y0 = Math.min(b.y0, it.bbox.minY); b.x1 = Math.max(b.x1, it.bbox.maxX); b.y1 = Math.max(b.y1, it.bbox.maxY); }
    }
    let best = -1, area = Infinity;
    for (const [c, b] of box) {
      if (raw.x < b.x0 || raw.x > b.x1 || raw.y < b.y0 || raw.y > b.y1) continue;
      const a = (b.x1 - b.x0) * (b.y1 - b.y0);
      if (a < area) { area = a; best = c; }
    }
    return best;
  }
  private unitLabel(keys: string[], key: string): string {
    const kind = this.unitKind(keys, key);
    const net = (n: number) => (n === NO_NET ? '' : ` (${netName(this.doc, n)})`);
    if (key.startsWith('poly:')) { const pg = this.doc.polygons[Number(key.slice(5))]; return pg ? `Polygon ${pg.name}${net(pg.net)} on ${this.layerLabel(pg.layer)}` : 'Polygon'; }
    const p = this.primByKey(key);
    if (!p) return kind || key;
    if (kind === 'Component' && 'component' in p) return `Component ${this.doc.components[p.component]!.designator}`;
    const comp = 'component' in p && p.component !== NO_NET ? this.doc.components[p.component] : undefined;
    const layer = 'layer' in p ? ` on ${this.layerLabel(p.layer)}` : '';
    if (p.kind === 'pad') return `Pad ${comp ? `${comp.designator}-` : ''}${p.name}${net(p.net)}${layer}`;
    if (p.kind === 'text') return `String "${p.text.length > 24 ? `${p.text.slice(0, 24)}…` : p.text}"${layer}`;
    // Tracks that end on one another are told apart by their lengths
    const u = this.units(), long = p.kind === 'track' ? `, ${formatCoord(Math.round(Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y)), u, u === 'mil' ? 1 : 2)} long` : '';
    return `${kind}${'net' in p ? net(p.net) : ''}${layer}${long}`;
  }

  /** Set by the app: a status-bar message. */
  status: ((msg: string) => void) | null = null;

  /**
   * Preferences › PCB Editor › Protect Locked Objects: locked objects stay out of a move or a
   * delete and the rest go (said in the status bar); with nothing else in it, nothing happens.
   * Off, locked objects go with the rest.
   */
  unlockedSet(set: PcbMoveSet): PcbMoveSet | null {
    if (!settings.pcbProtectLocked) return set;
    const first = this.lockedIn(set);
    if (!first) return set;
    const out: PcbMoveSet = { ...set,
      polygons: set.polygons.filter((i) => !this.doc.polygons[i]?.bag.bool('LOCKED')),
      components: set.components.filter((c) => !this.doc.components[c]?.bag.bool('LOCKED')),
      prims: set.prims.filter((p) => !('locked' in p && p.locked)) };
    const n = set.polygons.length - out.polygons.length + set.components.length - out.components.length + set.prims.length - out.prims.length;
    if (!out.polygons.length && !out.components.length && !out.prims.length && !out.dimensions?.length && !out.rooms?.length) { this.status?.(`${first} is locked`); return null; }
    this.status?.(`${n} locked object${n === 1 ? ' stays' : 's stay'} put (Preferences › PCB Editor › Protect Locked Objects)`);
    return out;
  }
  /** A locked object in the set, by name (Altium refuses to move locked objects). */
  private lockedIn(set: PcbMoveSet): string | null {
    for (const i of set.polygons) if (this.doc.polygons[i]?.bag.bool('LOCKED')) return `Polygon ${this.doc.polygons[i]!.name}`;
    for (const c of set.components) if (this.doc.components[c]?.bag.bool('LOCKED')) return `Component ${this.doc.components[c]!.designator}`;
    for (const p of set.prims) if ('locked' in p && p.locked) return `The ${p.kind}`;
    return null;
  }

  /* ── grips: a selected pour's vertices and edge midpoints, a selected track's ends ── */
  private soleSelection(): { polygon: number } | { track: Extract<PcbPrim, { kind: 'track' }> } | null {
    const keys = [...this.selection];
    if (!keys.length) return null;
    if (keys.every((k) => k === keys[0])) {
      const k = keys[0]!;
      if (k.startsWith('poly:')) { const i = Number(k.slice(5)); return this.doc.polygons[i] && !this.doc.polygons[i]!.bag.bool('LOCKED') ? { polygon: i } : null; }
      const p = this.primByKey(k);
      if (p?.kind === 'track' && p.component === NO_NET && !p.locked) return { track: p };
    }
    return null;
  }
  override grips(): Grip[] {
    // Board Planning Mode: a split or bending line's ends
    if (this.planning) {
      const keys = [...this.selection], k = keys[0];
      if (keys.length !== 1 || !k) return [];
      if (k.startsWith('region:') && isAdvanced(this.doc)) {
        const r = boardRegions(this.doc)[Number(k.slice(7))];
        return r ? r.outline.map((at, index) => ({ at, key: k, index })) : [];
      }
      const l = k.startsWith('split:') ? splitLines(this.doc)[Number(k.slice(6))]
        : k.startsWith('bend:') ? (() => { const [r, j] = k.slice(5).split(':').map(Number); return boardRegions(this.doc)[r!]?.bends[j!]; })() : undefined;
      return l ? [{ at: l.a, key: k, index: 0 }, { at: l.b, key: k, index: 1 }] : [];
    }
    const s = this.soleSelection();
    if (!s) return [];
    if ('polygon' in s) {
      const vs = this.doc.polygons[s.polygon]!.vertices, key = `poly:${s.polygon}`;
      const g: Grip[] = vs.map((v, index) => ({ at: v.p, key, index }));
      vs.forEach((v, i) => { if (!v.arc) { const n = vs[(i + 1) % vs.length]!.p; g.push({ at: { x: Math.round((v.p.x + n.x) / 2), y: Math.round((v.p.y + n.y) / 2) }, key, index: EDGE_GRIP + i }); } });
      return g;
    }
    return [{ at: s.track.a, key: primKey(s.track), index: 0 }, { at: s.track.b, key: primKey(s.track), index: 1 }];
  }
  private startGrip(g: Grip, at: Vec2): void {
    if (this.planning && g.key.startsWith('region:')) { this.setTool(new RegionVertexTool(this, Number(g.key.slice(7)), g.index)); return; }
    if (this.planning) { this.setTool(new LineEndTool(this, g.key, g.index as 0 | 1)); return; }
    const s = this.soleSelection();
    if (s) this.setTool(new PcbGripTool(this, s, g.index, at));
  }

  /* ── edits on the selection ── */
  /** Ctrl+arrow: one grid step; Shift+Ctrl+arrow: ten. Tracks attached to moved tracks and vias follow. */
  nudge(dx: number, dy: number): void {
    const set = this.moveSet();
    if (!set.components.length && !set.polygons.length && !set.prims.length) return;
    const kept = this.unlockedSet(set);
    if (!kept) return;
    const g = this.gridSize();
    commitMove(this, kept, placement({ x: 0, y: 0 }, 0, { x: dx * g, y: dy * g }), 0, 'move', 'Move selection');
  }
  /** Edit › Align: components move whole, pours and free objects as themselves. */
  align(kind: AlignKind): void {
    this.scene();
    const set = this.moveSet();
    const units: { set: PcbMoveSet; box: BBox }[] = [];
    const boxOfKeys = (keys: Set<string>) => { let b = emptyBox(); for (const it of this.items) if (keys.has(it.key)) b = union(b, it.bbox); return b; };
    for (const c of set.components) units.push({ set: { components: [c], polygons: [], prims: [] }, box: boxOfKeys(new Set(this.componentKeys(c).filter((k) => { const p = this.primByKey(k); return !(p?.kind === 'text'); }))) });
    for (const i of set.polygons) units.push({ set: { components: [], polygons: [i], prims: [] }, box: bboxOf(this.doc.polygons[i]!.outline) });
    for (const p of set.prims) units.push({ set: { components: [], polygons: [], prims: [p] }, box: boxOfKeys(new Set([primKey(p)])) });
    if (units.length < 2) return;
    const kept = this.unlockedSet(set);
    if (!kept) return;
    const deltas = alignDeltas(units.map((u) => u.box), kind);
    this.undo.transact(`Align ${kind}`, () => {
      // (locked ones, protected, count for the alignment but stay where they are)
      units.forEach((u, k) => { const d = deltas[k]!; if ((d.x || d.y) && (kept === set || !this.lockedIn(u.set))) commitMove(this, u.set, placement({ x: 0, y: 0 }, 0, d), 0, 'move'); });
    });
  }
  /** Edit › Align › Align To Grid: component reference points onto the snap grid. */
  alignToGrid(): void {
    const set = this.moveSet();
    this.undo.transact('Align to grid', () => {
      for (const c of set.components) {
        const at = this.doc.components[c]!.at, s = this.snap(at);
        if (s.x !== at.x || s.y !== at.y) commitMove(this, { components: [c], polygons: [], prims: [] }, placement({ x: 0, y: 0 }, 0, { x: s.x - at.x, y: s.y - at.y }), 0, 'move');
      }
    });
  }
  /** Edit › Select › Board (Ctrl+B): everything inside the board shape. */
  selectBoard(): void {
    const o = this.doc.board.outline;
    if (o.length < 3) { this.selectAll(); return; }
    const b = bboxOf(o);
    this.selection = new Set(this.normaliseSelection(this.itemsIn(b, false).map((i) => i.key), false));
    this.invalidateOverlay();
  }
  /** Edit › DeSelect › All on Layer / Free Objects. */
  deselectWhere(test: (key: string) => boolean): void {
    for (const k of [...this.selection]) if (test(k)) this.selection.delete(k);
    this.invalidateOverlay();
  }

  /** Edit › Move › Rotate Selection…: by any angle (counter-clockwise) about the selection's centre. */
  rotateSelectionBy(deg: number): void {
    const set = this.moveSet();
    if (!set.components.length && !set.polygons.length && !set.prims.length) return;
    const kept = this.unlockedSet(set);
    if (!kept) return;
    const b = this.selectionBounds();
    const c = this.snap({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
    const rot = ((deg % 360) + 360) % 360;
    if (rot) commitMove(this, kept, placement(c, rot, { x: 0, y: 0 }), rot, 'move', `Rotate selection ${+deg.toFixed(3)}°`);
  }
  /** Component Actions › Toggle Component Designator / Comment (NAMEON / COMMENTON). */
  toggleComponentTexts(key: 'NAMEON' | 'COMMENTON'): void {
    const comps = this.moveSet().components;
    if (!comps.length) return;
    this.undo.transact(key === 'NAMEON' ? 'Toggle designators' : 'Toggle comments', (tx) => {
      for (const c of comps) { const comp = this.doc.components[c]!; tx.add(setComponentProps(this.doc, c, { [key]: (key === 'NAMEON' ? comp.nameOn : comp.commentOn) ? 'FALSE' : 'TRUE' })); }
    });
  }

  /** Edit › Move › Move Selection by X, Y. */
  moveBy(d: Vec2): void {
    const set = this.moveSet();
    if (!set.components.length && !set.polygons.length && !set.prims.length) return;
    const kept = this.unlockedSet(set);
    if (!kept) return;
    commitMove(this, kept, placement({ x: 0, y: 0 }, 0, d), 0, 'move', 'Move selection');
  }
  /** Edit › Select › Free Objects / All Locked. */
  selectWhere(test: (p: PcbPrim) => boolean): void {
    this.selection = new Set(this.doc.prims.filter(test).map(primKey));
    this.invalidateOverlay();
  }
  /** Edit › Move › Rotate Selection: by the rotation step about the selection's centre (snapped). */
  rotateSelection(sign: 1 | -1 = 1): void {
    const set = this.moveSet();
    if (!set.components.length && !set.polygons.length && !set.prims.length) return;
    const b = this.selectionBounds();
    const c = this.snap({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
    const rot = ((sign * (settings.pcbRotationStep || 90)) % 360 + 360) % 360;
    commitMove(this, set, placement(c, rot, { x: 0, y: 0 }), rot, 'move', 'Rotate selection');
  }

  /** Find Similar Objects: components and pours whole, everything else by itself. */
  override similarObjects(): { keys: string[]; attrs: Record<string, string> }[] {
    const doc = this.doc, u = this.units();
    const f = (c: number) => formatCoord(c, u, u === 'mil' ? 3 : 4);
    const out: { keys: string[]; attrs: Record<string, string> }[] = [];
    for (const c of doc.components) out.push({ keys: this.componentKeys(c.index), attrs: {
      'Object Kind': 'Component', Layer: c.layer === L.BOTTOM ? 'Bottom Layer' : 'Top Layer', Footprint: c.pattern, Designator: c.designator,
      Rotation: String(+c.rotation.toFixed(3)), Locked: String(c.bag.bool('LOCKED')),
    } });
    for (const p of doc.polygons) out.push({ keys: [`poly:${p.index}`], attrs: {
      'Object Kind': 'Polygon', Layer: this.layerLabel(p.layer), Net: netName(doc, p.net), 'Fill Mode': p.hatch === 'Solid' ? 'Solid' : p.hatch === 'None' ? 'None' : 'Hatched',
      Name: p.name, Locked: String(p.bag.bool('LOCKED')),
    } });
    for (const p of doc.prims) {
      const owned = 'component' in p && p.component !== NO_NET && !!doc.components[p.component];
      if (owned && !(p.kind === 'text' && (p.isDesignator || p.isComment))) continue;
      if ('polygon' in p && p.polygon !== NO_NET) continue;
      const a: Record<string, string> = { 'Object Kind': p.kind[0]!.toUpperCase() + p.kind.slice(1) };
      if ('layer' in p) a.Layer = this.layerLabel(p.layer);
      if ('net' in p) a.Net = netName(doc, p.net);
      if (owned) a.Component = doc.components[(p as { component: number }).component]!.designator;
      switch (p.kind) {
        case 'track': case 'arc': a.Width = f(p.width); break;
        case 'via': a.Diameter = f(p.diameter); a['Hole Size'] = f(p.hole); break;
        case 'pad': a.Shape = p.top.shape; a['X Size'] = f(p.top.w); a['Y Size'] = f(p.top.h); a['Hole Size'] = p.hole ? f(p.hole) : 'none'; a.Designator = p.name; break;
        case 'text': a.Text = p.text; a['Text Height'] = f(p.height); a.Role = p.isDesignator ? 'Designator' : p.isComment ? 'Comment' : 'Free'; break;
        case 'region': a.Kind = p.boardCutout ? 'Board cutout' : p.keepout ? 'Keepout' : 'Copper'; break;
        case 'body': a['Object Kind'] = '3D Body'; a['Overall Height'] = f(p.overall); a['Standoff Height'] = f(p.standoff); break;
      }
      if ('locked' in p) a.Locked = String(p.locked);
      out.push({ keys: [primKey(p)], attrs: a });
    }
    return out;
  }

  /* ── clipboard ── */
  /**
   * Edit › Copy (Ctrl+C): as in Altium's PCB editor, click the reference point the copy will
   * hang from when pasted. Cut deletes once the reference is chosen.
   */
  copy(): boolean { this.chooseReference(false); return false; }
  cut(): void { this.chooseReference(true); }
  private chooseReference(cut: boolean): void {
    const set = this.moveSet();
    if (!set.components.length && !set.polygons.length && !set.prims.length) return;
    this.setTool(new PickTool(this, `${cut ? 'Cut' : 'Copy'}: choose the reference point`, (p) => {
      setClipboard(this.clipOf(set, p.world));
      this.status?.(`${cut ? 'Cut' : 'Copied'} ${set.components.length + set.polygons.length + set.prims.length} object(s)`);
      if (cut) this.deleteSelection();
      return true;
    }));
  }
  clipOf(set: PcbMoveSet, ref: Vec2): PcbClip {
    const doc = this.doc;
    // A text's WideStrings6 entry stays with this board: the copy takes its words instead
    const rec = (p: PcbPrim) => { const r = doc.streams.get(p.src.storage)!.records[p.src.index]!; return { storage: p.src.storage, rec: p.kind === 'text' ? detachedText(r, p.text) : r }; };
    const bodies = doc.streams.get('ComponentBodies6')?.records ?? [];
    return {
      kind: 'pcb', ref,
      records: set.prims.filter((p) => !('component' in p) || p.component === NO_NET || !doc.components[p.component]).map(rec),
      components: set.components.map((c) => ({
        bag: doc.components[c]!.bag.clone(),
        records: [
          ...doc.prims.filter((p) => 'component' in p && p.component === c && p.kind !== 'body').map(rec),
          // Bodies straight from their records: one that didn't decode as a primitive still goes along
          ...bodies.filter((b) => ownerOf(b, 'component') === c).map((b) => ({ storage: 'ComponentBodies6', rec: b })),
        ],
      })),
      polygons: set.polygons.map((i) => doc.polygons[i]!.bag.clone()),
      nets: new Map(doc.nets.map((n) => [n.index, n.name])),
    };
  }
  paste(stamp = false): void {
    if (clipboard?.kind !== 'pcb') return;
    this.setTool(new PcbPasteTool(this, clipboard, stamp));
  }

  /* ── polygon pours ── */
  /** Place › Polygon Pour, after its dialog: the outline is placed vertex by vertex. */
  startPlacePolygon(bag: PropertyBag): void { this.setTool(new PlacePolygonTool(this, bag)); }
  selectedPolygons(): number[] { return [...this.selection].filter((k) => k.startsWith('poly:')).map((k) => Number(k.slice(5))).filter((i) => !!this.doc.polygons[i]); }
  /** Tools › Polygon Pours › Repour All / Repour Selected. */
  repourPolygons(which: number[] = this.doc.polygons.map((p) => p.index)): void {
    if (!which.length) return;
    this.undo.transact(which.length === 1 ? `Repour ${this.doc.polygons[which[0]!]!.name}` : `Repour ${which.length} polygons`, (tx) => { for (const i of which) tx.add(repour(this.doc, i)); });
  }
  /** Tools › Polygon Pours › Shelve / Restore: a shelved pour keeps only its outline (copper removed). */
  shelvePolygons(which: number[], shelve: boolean): void {
    const todo = which.filter((i) => this.doc.polygons[i] && this.doc.polygons[i]!.bag.bool('SHELVED') !== shelve);
    if (!todo.length) return;
    this.undo.transact(`${shelve ? 'Shelve' : 'Restore'} ${todo.length} polygon${todo.length === 1 ? '' : 's'}`, (tx) => {
      for (const i of todo) {
        const g = this.doc.polygons[i]!, b = g.bag.clone();
        b.set('SHELVED', shelve ? 'TRUE' : 'FALSE');
        // As AD keeps a shelved pour: the layer and net it is restored to (UNKNOWN once restored)
        b.set('RESTORELAYER', shelve ? b.get('LAYER') ?? 'UNKNOWN' : 'UNKNOWN');
        if (shelve) b.set('RESTORENET', this.doc.nets[g.net]?.name ?? '');
        tx.add(setPolygon(this.doc, i, b));
        tx.add(repour(this.doc, i));
      }
    });
  }
  /** OK in the Polygon Pour dialog of an existing pour: the new definition, repoured. */
  updatePolygon(i: number, bag: PropertyBag): void {
    this.undo.transact(`Edit polygon ${polygonName(bag)}`.trim(), (tx) => {
      tx.add(setPolygon(this.doc, i, bag));
      tx.add(repour(this.doc, i));
    });
  }

  /* ── properties ── */
  private primMap: { of: PcbPrim[]; map: Map<string, PcbPrim> } | null = null;
  primByKey(key: string): PcbPrim | undefined {
    if (this.primMap?.of !== this.doc.prims) this.primMap = { of: this.doc.prims, map: new Map(this.doc.prims.map((p) => [`${p.src.storage}:${p.src.index}`, p])) };
    return this.primMap.map.get(key);
  }

  /** Replace one primitive's record with an edited copy (Properties panel edits). */
  private editPrim(label: string, p: PcbPrim, f: (subs: Uint8Array[]) => void): void {
    const rec = this.doc.streams.get(p.src.storage)?.records[p.src.index];
    if (!rec) return;
    const subs = rec.subs.map((x) => x.slice());
    f(subs);
    const after: PcbRawRecord = { tag: rec.tag, subs };
    this.undo.transact(label, (tx) => tx.add(replaceRecords(this.doc, [{ storage: p.src.storage, index: p.src.index, after }])));
  }
  /** A length typed in the Properties panel: a bare number is in the current units. */
  parseLen(v: string): number | undefined {
    const t = v.trim();
    return parseLength(/^-?[0-9]*\.?[0-9]+$/.test(t) ? `${t}${this.units()}` : t);
  }

  properties(): PropSection[] {
    const u = this.units();
    const f = (c: number) => formatCoord(c, u, u === 'mil' ? 3 : 4);
    const o = this.origin();
    const out: PropSection[] = [];
    const len = (label: string, value: number, set: (c: number) => void): PropRow => ({ label, value: f(value), edit: (v) => { const c = this.parseLen(v); if (c !== undefined) set(c); } });
    const coordX = (label: string, value: number, set: (c: number) => void): PropRow => ({ label, value: f(value - o.x), edit: (v) => { const c = this.parseLen(v); if (c !== undefined) set(c + o.x); } });
    const coordY = (label: string, value: number, set: (c: number) => void): PropRow => ({ label, value: f(value - o.y), edit: (v) => { const c = this.parseLen(v); if (c !== undefined) set(c + o.y); } });
    const netOptions = (): [string, string][] => [[String(NO_NET), 'No Net'], ...[...this.doc.nets].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((n): [string, string] => [String(n.index), n.name])];
    const layerOptions = (signal: boolean): [string, string][] => (signal ? this.doc.board.copperStack.filter(isSignal) : this.layers().filter((l) => l !== L.MULTI)).map((l) => [String(l), this.layerLabel(l)]);
    const angle = (a: number) => `${+a.toFixed(3)}`;
    const keys = [...this.selection];

    // A pour selected: Altium's Polygon Pour properties
    if (keys.length && keys.every((k) => k === keys[0]) && keys[0]!.startsWith('poly:')) {
      const i = Number(keys[0]!.slice(5)), poly = this.doc.polygons[i];
      if (poly) {
        const b = poly.bag;
        const set = (label: string, props: Record<string, string>) => { const nb = b.clone(); for (const [k, v] of Object.entries(props)) nb.set(k, v); this.updatePolygon(i, nb); this.status?.(label); };
        const hatch = b.get('HATCHSTYLE') ?? 'Solid';
        const mode = hatch === 'Solid' ? 'Solid' : hatch === 'None' ? 'None' : 'Hatched';
        const copper = this.doc.prims.filter((q) => 'polygon' in q && q.polygon === i);
        const area = Math.abs(poly.outline.reduce((a, v, k) => { const n = poly.outline[(k + 1) % poly.outline.length]!; return a + v.x * n.y - n.x * v.y; }, 0) / 2);
        const areaText = u === 'mil' ? `${(area / 1e8).toFixed(0)} sq mils` : `${(area / 1e8 * 0.00064516).toFixed(3)} sq mm`;
        const rows: PropRow[] = [
          { label: 'Name', value: poly.name, edit: (v) => set('Rename polygon', { NAME: v, AUTOGENERATENAME: 'FALSE' }) },
          { label: 'Layer', value: String(poly.layer), kind: 'enum', options: layerOptions(true), edit: (v) => set('Polygon layer', { LAYER: layerToName(Number(v)) }) },
          { label: 'Net', value: String(poly.net), kind: 'enum', options: netOptions(), edit: (v) => set('Polygon net', { NET: v }) },
          { label: 'Fill Mode', value: mode, kind: 'enum', options: [['Solid', 'Solid'], ['Hatched', 'Hatched'], ['None', 'None']], edit: (v) => set('Polygon fill mode', { HATCHSTYLE: v === 'Hatched' ? '90Degree' : v }) },
        ];
        if (mode !== 'Solid') rows.push(len('Track Width', parseLength(b.get('TRACKWIDTH')) ?? mil(8), (c) => set('Polygon track width', { TRACKWIDTH: formatAltiumLength(c) })));
        if (mode === 'Hatched') rows.push(
          len('Grid Size', parseLength(b.get('GRIDSIZE')) ?? mil(20), (c) => set('Polygon grid size', { GRIDSIZE: formatAltiumLength(c) })),
          { label: 'Hatch Mode', value: hatch, kind: 'enum', options: [['90Degree', '90 Degree'], ['45Degree', '45 Degree'], ['Horizontal', 'Horizontal'], ['Vertical', 'Vertical']], edit: (v) => set('Polygon hatch mode', { HATCHSTYLE: v }) });
        if (mode === 'Solid') rows.push(
          { label: 'Remove Islands', value: String(b.bool('REMOVEISLANDSBYAREA')), kind: 'bool', edit: (v) => set('Remove islands', { REMOVEISLANDSBYAREA: v === 'true' ? 'TRUE' : 'FALSE' }) },
          { label: 'Island Area', value: b.get('ISLANDAREATHRESHOLD') ?? '2500', edit: (v) => { if (Number(v) >= 0) set('Island area', { ISLANDAREATHRESHOLD: String(Number(v)) }); } });
        rows.push(
          { label: 'Pour Over', value: b.get('POUROVER') ?? 'SameNet', kind: 'enum', options: [['SameNet', 'All Same Net Objects'], ['SameNetPolygon', 'Same Net Polygons Only'], ['None', "Don't Pour Over"]], edit: (v) => set('Pour over', { POUROVER: v }) },
          { label: 'Remove Dead Copper', value: String(b.has('REMOVEDEAD') ? b.bool('REMOVEDEAD') : true), kind: 'bool', edit: (v) => set('Remove dead copper', { REMOVEDEAD: v === 'true' ? 'TRUE' : 'FALSE' }) },
          len('Min Prim Length', parseLength(b.get('MINPRIMLENGTH')) ?? mil(3), (c) => set('Min prim length', { MINPRIMLENGTH: formatAltiumLength(c) })),
          { label: 'Locked', value: String(b.bool('LOCKED')), kind: 'bool', edit: (v) => { const nb = b.clone(); nb.set('LOCKED', v === 'true' ? 'TRUE' : 'FALSE'); this.undo.transact('Lock polygon', (tx) => tx.add(setPolygon(this.doc, i, nb))); } },
          { label: 'Area', value: areaText },
          { label: 'Vertices', value: String(poly.vertices.length) },
          { label: 'Copper', value: copper.length ? `${copper.length} primitive${copper.length > 1 ? 's' : ''}` : 'none (repour, or all removed as dead copper)' },
        );
        return [{ title: 'Polygon Pour', rows, raw: b.toObject() }];
      }
    }

    // A whole component selected: Altium's Component properties
    let set = this.moveSet();
    // Pads chosen on their own (from the list of overlapping objects, or with Components off in the Selection Filter): the pads' properties, not their components'
    const own = keys.map((k) => this.primByKey(k));
    if (set.components.length && own.every((q) => q?.kind === 'pad') && set.components.every((ci) => !this.componentKeys(ci).every((k) => this.selection.has(k)))) set = { ...set, components: [], prims: [...set.prims, ...(own as PcbPrim[])] };
    if (set.components.length === 1 && !set.prims.length && !set.polygons.length) {
      const ci = set.components[0]!, c = this.doc.components[ci];
      if (c) {
        const b = c.bag;
        const move = (to: Vec2, rot = 0) => { const d = { x: to.x - c.at.x, y: to.y - c.at.y }; if (d.x || d.y || rot) commitMove(this, { components: [ci], polygons: [], prims: [] }, placement(c.at, rot, d), rot, 'move', `Move ${c.designator}`); };
        const comment = this.doc.prims.find((q) => q.kind === 'text' && q.component === c.index && q.isComment) as { text?: string } | undefined;
        return [{ title: 'Component', rows: [
          { label: 'Designator', value: c.designator },
          { label: 'Comment', value: comment?.text ?? '' },
          { label: 'Footprint', value: c.pattern },
          { label: 'Layer', value: c.layer === L.BOTTOM ? 'Bottom Layer' : 'Top Layer' },
          coordX('X', c.at.x, (x) => move({ x, y: c.at.y })),
          coordY('Y', c.at.y, (y) => move({ x: c.at.x, y })),
          { label: 'Rotation', value: angle(c.rotation), edit: (v) => { const r = Number(v); if (Number.isFinite(r)) move(c.at, (((r - c.rotation) % 360) + 360) % 360); } },
          { label: 'Locked', value: String(b.bool('LOCKED')), kind: 'bool', edit: (v) => this.undo.transact('Lock component', (tx) => tx.add(setComponentProps(this.doc, ci, { LOCKED: v === 'true' ? 'TRUE' : 'FALSE' }))) },
          { label: 'Show Designator', value: String(c.nameOn), kind: 'bool', edit: (v) => this.undo.transact('Show designator', (tx) => tx.add(setComponentProps(this.doc, ci, { NAMEON: v === 'true' ? 'TRUE' : 'FALSE' }))) },
          { label: 'Show Comment', value: String(c.commentOn), kind: 'bool', edit: (v) => this.undo.transact('Show comment', (tx) => tx.add(setComponentProps(this.doc, ci, { COMMENTON: v === 'true' ? 'TRUE' : 'FALSE' }))) },
          { label: 'Description', value: b.get('SOURCEDESCRIPTION') ?? '' },
          { label: 'Library', value: b.get('SOURCEFOOTPRINTLIBRARY') ?? '' },
          { label: 'Unique ID', value: b.get('SOURCEUNIQUEID') ?? '' },
          { label: 'Primitives', value: String(this.selection.size) },
        ], raw: b.toObject() }];
      }
    }

    const fieldSet = (s: Uint8Array, fl: Field, v: number) => { put(s, fl, Math.round(v)); };
    for (const key of keys.slice(0, 20)) {
      if (key.startsWith('poly:')) { const pg = this.doc.polygons[Number(key.slice(5))]; if (pg) out.push({ title: 'Polygon Pour', rows: [{ label: 'Name', value: pg.name }, { label: 'Net', value: netName(this.doc, pg.net) }, { label: 'Layer', value: this.layerLabel(pg.layer) }] }); continue; }
      const p = this.primByKey(key);
      if (!p) continue;
      const free = !('component' in p) || p.component === NO_NET;
      const ed = (label: string, fn: (subs: Uint8Array[]) => void) => this.editPrim(label, p, fn);
      const rows: PropRow[] = [];
      if ('net' in p) rows.push({ label: 'Net', value: String(p.net), kind: 'enum', options: netOptions(), edit: free ? (v) => ed('Change net', (ss) => {
        const fl = p.kind === 'track' ? TRACK.net : p.kind === 'arc' ? ARC.net : p.kind === 'via' ? VIA.net : p.kind === 'pad' ? PAD.net : undefined;
        const sub = p.kind === 'pad' ? ss[4] : ss[0];
        if (fl && sub) fieldSet(sub, fl, Number(v));
      }) : undefined });
      if ('layer' in p && (p.kind === 'track' || p.kind === 'arc')) rows.push({ label: 'Layer', value: String(p.layer), kind: 'enum', options: layerOptions(false), edit: free ? (v) => ed('Change layer', (ss) => {
        const l = Number(v), s0 = ss[0]!;
        fieldSet(s0, p.kind === 'track' ? TRACK.layer : ARC.layer, l);
        if (p.kind === 'track' && s0.length >= TRACK.layerV7.off + 4) put(s0, TRACK.layerV7, toV7(l));
        if (p.kind === 'arc' && s0.length >= ARC.layerV7.off + 4) put(s0, ARC.layerV7, toV7(l));
      }) : undefined });
      else if ('layer' in p) rows.push({ label: 'Layer', value: this.layerLabel(p.layer) });
      if (!free && 'component' in p) rows.push({ label: 'Component', value: this.doc.components[p.component]?.designator ?? `#${p.component}` });
      switch (p.kind) {
        case 'track': {
          const s0 = (ss: Uint8Array[]) => ss[0]!;
          rows.push(
            coordX('Start X', p.a.x, (v) => ed('Move track start', (ss) => fieldSet(s0(ss), TRACK.x1, v))),
            coordY('Start Y', p.a.y, (v) => ed('Move track start', (ss) => fieldSet(s0(ss), TRACK.y1, v))),
            coordX('End X', p.b.x, (v) => ed('Move track end', (ss) => fieldSet(s0(ss), TRACK.x2, v))),
            coordY('End Y', p.b.y, (v) => ed('Move track end', (ss) => fieldSet(s0(ss), TRACK.y2, v))),
            len('Width', p.width, (v) => { if (v > 0) ed('Track width', (ss) => fieldSet(s0(ss), TRACK.width, v)); }),
            { label: 'Length', value: f(Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y)) });
          break;
        }
        case 'arc':
          rows.push(
            coordX('Centre X', p.c.x, (v) => ed('Move arc', (ss) => fieldSet(ss[0]!, ARC.cx, v))),
            coordY('Centre Y', p.c.y, (v) => ed('Move arc', (ss) => fieldSet(ss[0]!, ARC.cy, v))),
            len('Radius', p.r, (v) => { if (v > 0) ed('Arc radius', (ss) => fieldSet(ss[0]!, ARC.radius, v)); }),
            { label: 'Start Angle', value: angle(p.start), edit: (v) => { const a = Number(v); if (Number.isFinite(a)) ed('Arc start angle', (ss) => put(ss[0]!, ARC.start, a)); } },
            { label: 'End Angle', value: angle(p.end), edit: (v) => { const a = Number(v); if (Number.isFinite(a)) ed('Arc end angle', (ss) => put(ss[0]!, ARC.end, a)); } },
            len('Width', p.width, (v) => { if (v > 0) ed('Arc width', (ss) => fieldSet(ss[0]!, ARC.width, v)); }));
          break;
        case 'via':
          rows.push(
            coordX('X', p.at.x, (v) => ed('Move via', (ss) => fieldSet(ss[0]!, VIA.x, v))),
            coordY('Y', p.at.y, (v) => ed('Move via', (ss) => fieldSet(ss[0]!, VIA.y, v))),
            len('Diameter', p.diameter, (v) => { if (v > p.hole) ed('Via diameter', (ss) => setViaDiameter(ss[0]!, v)); }),
            len('Hole Size', p.hole, (v) => { if (v > 0 && v < p.diameter) ed('Via hole size', (ss) => fieldSet(ss[0]!, VIA.hole, v)); }),
            { label: 'Span', value: `${this.layerLabel(p.layerStart)} – ${this.layerLabel(p.layerEnd)}` });
          break;
        case 'pad': {
          const s4 = (ss: Uint8Array[]) => ss[4]!;
          rows.push({ label: 'Designator', value: p.name },
            ...(free ? [
              coordX('X', p.at.x, (v) => ed('Move pad', (ss) => fieldSet(s4(ss), PAD.x, v))),
              coordY('Y', p.at.y, (v) => ed('Move pad', (ss) => fieldSet(s4(ss), PAD.y, v))),
              { label: 'Rotation', value: angle(p.rotation), edit: (v: string) => { const a = Number(v); if (Number.isFinite(a)) ed('Pad rotation', (ss) => put(s4(ss), PAD.rotation, a)); } },
            ] : [{ label: 'Location', value: `${f(p.at.x - o.x)}, ${f(p.at.y - o.y)}` }, { label: 'Rotation', value: `${angle(p.rotation)}°` }]),
            { label: 'Size', value: `${f(p.top.w)} × ${f(p.top.h)}` }, { label: 'Shape', value: p.top.shape }, { label: 'Hole Size', value: p.hole ? f(p.hole) : 'none' });
          break;
        }
        case 'fill': rows.push({ label: 'Corner 1', value: `${f(p.a.x - o.x)}, ${f(p.a.y - o.y)}` }, { label: 'Corner 2', value: `${f(p.b.x - o.x)}, ${f(p.b.y - o.y)}` }, { label: 'Rotation', value: `${angle(p.rotation)}°` }); break;
        case 'text':
          rows.push({ label: 'Text', value: p.text },
            coordX('X', p.at.x, (v) => ed('Move text', (ss) => fieldSet(ss[0]!, TEXT.x, v))),
            coordY('Y', p.at.y, (v) => ed('Move text', (ss) => fieldSet(ss[0]!, TEXT.y, v))),
            len('Text Height', p.height, (v) => { if (v > 0) ed('Text height', (ss) => fieldSet(ss[0]!, TEXT.height, v)); }),
            { label: 'Rotation', value: angle(p.rotation), edit: (v) => { const a = Number(v); if (Number.isFinite(a)) ed('Text rotation', (ss) => put(ss[0]!, TEXT.rotation, a)); } },
            { label: 'Font', value: p.fontType === 1 ? `${p.fontName || 'TrueType'}${p.bold ? ' bold' : ''}${p.italic ? ' italic' : ''}` : p.fontType === 2 ? 'Barcode' : 'Stroke' },
            ...(p.isDesignator ? [{ label: 'Role', value: 'Designator' }] : p.isComment ? [{ label: 'Role', value: 'Comment' }] : []));
          break;
        case 'region': rows.push({ label: 'Kind', value: ['Copper', 'Polygon cutout', 'Dashed outline', 'Kind 3', 'Cavity'][p.regionKind] ?? `Kind ${p.regionKind}` },
          { label: 'Vertices', value: String(p.outline.length) }, { label: 'Holes', value: String(p.holes.length) }); break;
        case 'body': {
          const props = (label: string, fn: (b: PropertyBag) => void) => ed(label, (ss) => { ss[0] = editRegionProps(ss[0]!, fn); });
          const height = (label: string, key: string, v: number, ok: (n: number) => boolean) => len(label, v, (n) => { if (ok(n)) props(label, (b) => { b.set(key, formatAltiumLength(n)); if (key === 'OVERALLHEIGHT') b.set('MODEL.EXTRUDED.MAXZ', formatAltiumLength(n)); else b.set('MODEL.EXTRUDED.MINZ', formatAltiumLength(n)); }); });
          const hex = `#${[p.colour & 0xff, (p.colour >> 8) & 0xff, (p.colour >> 16) & 0xff].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
          rows.push(
            { label: 'Body Type', value: ['Extruded', 'Generic', 'Cylinder', 'Sphere'][p.modelType] ?? `Type ${p.modelType}` },
            ...(p.modelName ? [{ label: 'Model', value: p.modelName }] : []),
            { label: 'Body Side', value: p.bottom ? 'Bottom Side' : 'Top Side', kind: 'enum', options: [['Top Side', 'Top Side'], ['Bottom Side', 'Bottom Side']],
              edit: (v) => props('Body side', (b) => b.set('BODYPROJECTION', v === 'Bottom Side' ? '1' : '0')) },
            height('Overall Height', 'OVERALLHEIGHT', p.overall, (n) => n > p.standoff),
            height('Standoff Height', 'STANDOFFHEIGHT', p.standoff, (n) => n >= 0 && n < p.overall),
            { label: 'Colour', value: hex, edit: (v) => { const m = /^#?([0-9a-f]{6})$/i.exec(v.trim()); if (m) { const n = parseInt(m[1]!, 16); props('Body colour', (b) => b.set('BODYCOLOR3D', String(((n & 0xff) << 16) | (n & 0xff00) | (n >> 16)))); } } },
            { label: 'Opacity', value: p.opacity.toFixed(2), edit: (v) => { const n = Number(v); if (n >= 0 && n <= 1) props('Body opacity', (b) => b.set('BODYOPACITY3D', n.toFixed(3))); } },
            { label: 'Identifier', value: p.identifier, edit: (v) => props('Body identifier', (b) => b.set('IDENTIFIER', bodyIdentifierValue(v))) },
            { label: 'Vertices', value: String(p.outline.length) });
          break;
        }
      }
      if ('locked' in p && p.locked) rows.push({ label: 'Locked', value: 'yes' });
      rows.push({ label: 'Source', value: `${p.src.storage} record ${p.src.index}` });
      out.push({ title: p.kind === 'body' ? '3D Body' : p.kind[0]!.toUpperCase() + p.kind.slice(1), rows });
    }
    return out;
  }

  documentProperties(): PropSection[] {
    const d = this.doc, u = this.units();
    const f = (c: number) => formatCoord(c, u);
    const ob = bboxOf(d.board.outline.length ? d.board.outline : [{ x: 0, y: 0 }]);
    const count = (k: PcbPrim['kind']) => d.prims.filter((p) => p.kind === k).length;
    const pours = d.polygons.length;
    return [
      { title: 'Board', rows: [
        { label: 'Size', value: d.board.outline.length ? `${f(ob.maxX - ob.minX)} × ${f(ob.maxY - ob.minY)}` : 'no outline' },
        { label: 'Origin', value: `${f(d.board.origin.x)}, ${f(d.board.origin.y)}` },
        { label: 'Copper layers', value: String(d.board.copperStack.length) },
        { label: 'Units', value: u },
        { label: 'Snap grid', value: f(this.gridSize()) },
      ] },
      { title: 'Contents', rows: [
        { label: 'Components', value: String(d.components.length) },
        { label: 'Nets', value: String(d.nets.length) },
        { label: 'Tracks', value: String(count('track')) },
        { label: 'Arcs', value: String(count('arc')) },
        { label: 'Vias', value: String(count('via')) },
        { label: 'Pads', value: String(count('pad')) },
        { label: 'Regions', value: String(count('region')) },
        { label: 'Polygon pours', value: String(pours) },
        { label: 'Texts', value: String(count('text')) },
      ] },
    ];
  }

  /** Delete: whole components (with their 3D bodies), pours (with their copper) and free objects. */
  deleteSelection(): void {
    // Board Planning Mode: a split line (its regions joined) or bending lines
    if (this.planning) {
      const keys = [...this.selection], split = keys.find((k) => k.startsWith('split:'));
      const bends = keys.filter((k) => k.startsWith('bend:')).map((k) => k.slice(5).split(':').map(Number) as [number, number]);
      let next: RigidFlex | null = null, what = '';
      const covers = keys.filter((k) => k.startsWith('cover:')).map((k) => k.slice(6).split(':').map(Number) as [number, number]);
      const region = keys.find((k) => k.startsWith('region:'));
      if (covers.length) {
        const regs = boardRegions(this.doc);
        for (const ri of new Set(covers.map(([r]) => r))) {
          const left = regs[ri]?.coverlays?.filter((_, k) => !covers.some(([r, j]) => r === ri && j === k)) ?? [];
          next = withRegion({ ...this.doc, flex: next ?? this.doc.flex }, ri, { coverlays: left });
        }
        what = `Delete ${covers.length} coverlay shape${covers.length > 1 ? 's' : ''}`;
      } else if (region && isAdvanced(this.doc) && !split && !keys.some((k) => k.startsWith('bend:'))) {
        const r = removeRegion(this.doc, Number(region.slice(7)));
        if (typeof r === 'string') notify(r, 'error'); else { next = r; what = 'Delete board region'; }
      } else if (split) { next = removeSplit(this.doc, Number(split.slice(6))); what = 'Delete split line'; }
      else if (bends.length) {
        const regs = boardRegions(this.doc);
        for (const ri of new Set(bends.map(([r]) => r))) {
          const left = regs[ri]?.bends.filter((_, j) => !bends.some(([r, k]) => r === ri && k === j)) ?? [];
          next = withRegion({ ...this.doc, flex: next ?? this.doc.flex }, ri, { bends: left });
        }
        what = `Delete ${bends.length} bending line${bends.length > 1 ? 's' : ''}`;
      }
      if (next) { const f = next; this.undo.transact(what, (tx) => tx.add(setRigidFlex(this.doc, f))); }
      this.selection.clear();
      this.invalidate();
      return;
    }
    const set = this.unlockedSet(this.moveSet());
    if (!set) return;
    // A component's designator or comment can't be deleted on its own (as in Altium)
    const prims = set.prims.filter((p) => !('component' in p) || p.component === NO_NET || !this.doc.components[p.component]);
    const dims = set.dimensions ?? [], rooms = set.rooms ?? [];
    // Deleting a room leaves what lies in it
    const comps = rooms.length ? this.moveSet([...this.selection].filter((k) => !k.startsWith('room:'))).components : set.components;
    const n = comps.length + set.polygons.length + prims.length + dims.length + rooms.length;
    if (!n) return;
    this.undo.transact(`Delete ${n} object${n > 1 ? 's' : ''}`, (tx) => {
      if (rooms.length) tx.add(editRooms(this.doc, { remove: new Set(rooms) }));
      if (prims.length) tx.add(removePrims(this.doc, prims));
      if (comps.length) tx.add(removeComponents(this.doc, comps));
      if (set.polygons.length) tx.add(removePolygons(this.doc, set.polygons));
      if (dims.length) tx.add(removeDimensions(this.doc, dims));
    });
    this.selection.clear();
    this.invalidateOverlay();
  }
}

/** Colour a towards b by t (0..1), both 0xRRGGBB. */
function mixRgb(a: number, b: number, t: number): number {
  const ch = (sh: number) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t) << sh;
  return ch(16) | ch(8) | ch(0);
}

/** Selection key: the record, or the pour that owns it. */
export function primKey(p: PcbPrim): string {
  return 'polygon' in p && p.polygon !== NO_NET ? `poly:${p.polygon}` : `${p.src.storage}:${p.src.index}`;
}

/** Identity of a primitive's content, independent of its record index. */
function primSig(p: PcbPrim): string {
  const { src: _src, ...rest } = p;
  return JSON.stringify(rest);
}

function bboxOf(pts: Vec2[]): BBox {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of pts) { b.minX = Math.min(b.minX, p.x); b.minY = Math.min(b.minY, p.y); b.maxX = Math.max(b.maxX, p.x); b.maxY = Math.max(b.maxY, p.y); }
  return b;
}

function padOutline(at: Vec2, st: PadStackLayer, rot: number): Vec2[] {
  const hw = st.w / 2, hh = st.h / 2;
  const pts = st.shape === 'octagon'
    ? (() => { const c = Math.min(hw, hh) * 0.4142 * 1.0; return [[-hw + c, -hh], [hw - c, -hh], [hw, -hh + c], [hw, hh - c], [hw - c, hh], [-hw + c, hh], [-hw, hh - c], [-hw, -hh + c]]; })()
    : [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  return pts.map(([x, y]) => rotate({ x: at.x + x!, y: at.y + y! }, rot, at));
}

function drawPad(s: Scene, g: DrawGroup, at: Vec2, st: PadStackLayer, rot: number, c: number): void {
  if (st.w <= 0 || st.h <= 0) return;
  switch (st.shape) {
    case 'round': {
      if (st.w === st.h) { s.circle(g, at, st.w / 2, c); return; }
      const long = Math.max(st.w, st.h), r = Math.min(st.w, st.h) / 2;
      const ang = (st.w >= st.h ? rot : rot + 90) * DEG;
      const d = { x: Math.cos(ang) * (long / 2 - r), y: Math.sin(ang) * (long / 2 - r) };
      s.segment(g, { x: at.x - d.x, y: at.y - d.y }, { x: at.x + d.x, y: at.y + d.y }, r * 2, c, 0);
      return;
    }
    case 'roundrect': s.rect(g, at, st.w, st.h, rot, (Math.min(st.w, st.h) / 2) * (st.cornerPct / 100), c); return;
    case 'octagon': { const o = padOutline(at, st, rot); s.polygon(g, o, triangulate(o), c); return; }
    default: s.rect(g, at, st.w, st.h, rot, 0, c);
  }
}
