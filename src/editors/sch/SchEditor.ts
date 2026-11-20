import { Editor, SelectTool, type Grip, type HitItem, type PropSection, maskLevel } from '../Editor';
import type { CompiledLook } from '../../model/compiledView';
import { PlaceWireTool } from './PlaceWireTool';
import { bezierPts, powerGlyph, type PowerGlyph, type Pt } from './powerPort';
import { ieeeGlyph } from './ieee';
import { embeddedImage, linkedImage } from './schImages';
import { sheetFrame } from './sheetFrame';
import { fromBgr } from '../../model/common';
import { DIFF_PAIR, PARAMETER_SET, JUNCTION_DIAMETER, JUNCTION_SIZES, noErcGlyph, OFF_SHEET, SHEET_ENTRY_TEXT_AT, pinGlyph, portOutline, sheetEntryOutline, type Glyph } from './symbols';
import { autoJunctions, electricalSpots, orphanJunctions, wireConnection } from '../../model/schConnect';
import {
  arcPoints, boxOfPoints, distToArc, roundRectPoints, distToSegment, pointInPoly, triangulate, type BBox, type Vec2,
} from '../../core/geom';
import { SCH_GRIDS, mil, formatCoord, type Coord } from '../../core/units';
import { Scene, css, rgba, type DrawGroup } from '../../render/Scene';
import { hex4, type GridSpec } from '../../render/gl/Renderer';
import { partSuffix, bagOf, DIR_VECTORS, isShown, schCoord, SCH_DEFAULTS, SR, SR_NAME, type SchDocument, type SchObject } from '../../model/sch';
import { specialResolver, type SpecialContext, type SpecialResolver } from '../../model/schSpecial';
import { addRecords, removeObjects, replaceBags, setProps, uniqueId } from '../../model/schEdit';
import { resetPastedDesignators } from '../../model/annotate';
import { ELECTRICAL, compileProject } from '../../model/compile';
import { SchMoveTool, type MoveMode } from './SchMoveTool';
import { SchGripTool } from './SchGripTool';
import { SchPasteTool } from './SchPasteTool';
import { clipboard, setClipboard, type SchClip } from '../clipboard';
import { nextName, stepCopies } from '../../model/schPlace';
import { gripsOf } from '../../model/schGrips';
import { identity, refPoint, transformBag, withChildren } from '../../model/schTransform';
import { alignDeltas, type AlignKind } from '../align';
import { emptyBox, union } from '../../core/geom';
import type { AutoPan } from '../../render/Viewport';
import { connectedTo, hopped, junctionConnections, shownEntryShape, shownPortStyle, touchTest, wireHops } from '../../model/schLook';
import { HARNESS_COLOUR, harnessLooks } from '../../model/schHarness';
import { entryPoint } from '../../model/schHierarchy';
import { ruleParameterText } from '../../model/schRules';

/** Manual Junctions Connection Status ring radius per Size, mil [est]. */
const MANUAL_RING: Record<string, number> = { smallest: 30, small: 45, medium: 60, large: 80 };

const ALIGN_LABEL: Record<AlignKind, string> = { left: 'left', right: 'right', top: 'top', bottom: 'bottom', hCentre: 'horizontal centres', vCentre: 'vertical centres', distributeH: '(distribute horizontally)', distributeV: '(distribute vertically)' };
import type { PropertyBag } from '../../formats/altium/props';
import type { ToolPointer } from '../../core/tools';
import type { Scope } from '../../core/commands';
import { hexToRgb, settings, updateSettings } from '../../core/settings';

const DIR = DIR_VECTORS;

/** Draw symbol glyphs (mil, in a local frame mapped by P). */
function drawGlyphs(s: Scene, g: DrawGroup, parts: Glyph[], P: (p: Pt) => Vec2, col: number): void {
  for (const part of parts) {
    const w = mil(part.w);
    for (const line of part.lines) s.polyline(g, line.map(P), w, col);
    for (const f of part.fills ?? []) { const pts = f.map(P); s.polygon(g, pts, triangulate(pts), col); }
    for (const c of part.circles ?? []) s.arc(g, P(c.c), mil(c.r), 0, 360, w, col);
  }
}

export interface FontSpec { size: number; family?: string; bold: boolean; italic: boolean }

/**
 * Altium sheet font → drawn text. KiCad's importer (tuned against Altium) maps SIZE n to a
 * capital height of n × 5 mil; we convert cap height to em with the typeface's cap ratio.
 */
export function schFont(sheet: SchDocument['sheet'], id: number): FontSpec {
  const f = sheet.fonts[id - 1] ?? sheet.fonts[0] ?? { size: 10, name: 'Arial', bold: false, italic: false, rotation: 0 };
  const serif = /times|serif|garamond|georgia|cambria/i.test(f.name) && !/sans/i.test(f.name);
  const mono = /courier|mono|consol/i.test(f.name);
  const capRatio = serif ? 0.662 : mono ? 0.571 : 0.716;
  const generic = serif ? 'serif' : mono ? 'monospace' : 'Arial, Helvetica, sans-serif';
  return {
    size: ((f.size * mil(5)) / capRatio) * settings.schTextScale,
    // (the Symbol font always: its letters stand for Greek and math characters)
    family: settings.schDocumentFonts || /^symbol$/i.test(f.name.trim()) ? `"${f.name}", ${generic}` : undefined,
    bold: f.bold, italic: f.italic,
  };
}

export class SchEditor extends Editor {
  readonly scope: Scope = 'sch';
  override gridAbove = 'sheet';
  override get cursorColour(): string { return settings.cursorColourSch; }
  /** Set by the app: Tab while placing opens the object's properties; apply() takes the edited bag. */
  /** Tab while placing: the object's properties; `hide` leaves out those the clicks decide (by their names in the dialog). */
  placeProps: ((bag: PropertyBag, apply: (b: PropertyBag) => void, hide?: (name: string) => boolean) => void) | null = null;
  /** Set by the app: Tab while placing a part opens its Component Properties (on the part's records, owners by position). */
  placePartProps: ((items: { bag: PropertyBag; owner: number }[], apply: (items: { bag: PropertyBag; owner: number }[]) => void) => void) | null = null;
  /** Fit Document on a schematic is the sheet (a library symbol: its graphics, around the origin). */
  override fitBounds(): BBox {
    if (this.libraryMode) {
      const b = this.objectBounds();
      const m = mil(200);
      return b.minX <= b.maxX ? { minX: Math.min(b.minX, -m), minY: Math.min(b.minY, -m), maxX: Math.max(b.maxX, m), maxY: Math.max(b.maxY, m) } : { minX: -mil(1000), minY: -mil(700), maxX: mil(1000), maxY: mil(700) };
    }
    return { minX: 0, minY: 0, maxX: this.doc.sheet.width, maxY: this.doc.sheet.height };
  }
  /**
   * Editing a library symbol (the SchLib editor): no sheet, the origin marked, every graphic
   * and pin picked on its own, the component's designator and comment left to its properties.
   */
  libraryMode = false;
  /** View › Show Hidden Pins (the library editor; a part's Show Hidden Pins on a sheet). */
  showHiddenPins = false;
  /**
   * SCH Filter › Mask out (and Find Similar › Mask Matching): only these objects stay as they
   * are and can be picked; the rest are drawn faded. Null: nothing masked.
   */
  mask: Set<number> | null = null;
  /** Records when the mask was made: adding or removing objects renumbers them, so the mask goes. */
  private maskRecords = 0;
  /** How faded masked objects are (Mask Level): 0 clear … 1 invisible. */
  static get maskDim(): number { return maskLevel.dim; }
  static set maskDim(v: number) { maskLevel.dim = v; }
  setMask(passing: Iterable<number> | null): void {
    this.mask = passing ? new Set(passing) : null;
    // Clear (Shift+C) ends navigation's dimming and connection graph too
    if (!passing) { this.navDim = null; this.navGraph = null; }
    this.maskRecords = this.doc.records.length;
    if (this.mask) this.selection = new Set([...this.selection].filter((k) => this.indicesOfKey(k).some((i) => this.unmasked(i))));
    this.invalidate();
    this.changed.emit();
  }
  /**
   * Preferences › Schematic › Compiler › Compiled Names Expansion: one compiled instance of the
   * sheet shown with the names the compile gave it (the tabs under a compiled sheet); edits are
   * refused until the Editor tab is chosen again. Null: the sheet as it is.
   */
  compiledView: CompiledLook | null = null;
  private guardOutside: (() => string | null) | null = null;
  setCompiledView(v: CompiledLook | null): void {
    if (v && !this.compiledView) {
      this.guardOutside = this.undo.guard;
      this.undo.guard = () => (this.compiledView ? 'This is a compiled view of the sheet: choose the Editor tab below it to edit' : this.guardOutside?.() ?? null);
    } else if (!v && this.compiledView) this.undo.guard = this.guardOutside;
    if (!v) this.guardOutside = null;
    this.compiledView = v;
    this.selection = new Set();
    this.invalidate();
    this.invalidateOverlay();
    this.changed.emit();
  }
  /** An object as the compiled view shows it: its name the compile's. */
  private compiledObject(o: SchObject): SchObject {
    const n = this.compiledView?.names.get(o.index);
    if (n === undefined) return o;
    if (o.kind === 'text') return { ...o, text: n };
    if (o.kind === 'port' || o.kind === 'sheetentry') return { ...o, name: n };
    if (o.kind === 'power') return { ...o, text: n };
    return o;
  }
  /** System › Navigation › Dimming: what a cross-probe went to stays as it is, the rest dims (still to be picked). */
  navDim: Set<number> | null = null;
  /** System › Navigation › Connection Graph: lines joining what a cross-probe went to. */
  navGraph: [Vec2, Vec2][] | null = null;
  setNavigation(dim: Iterable<number> | null, graph: [Vec2, Vec2][] | null): void {
    this.navDim = dim ? new Set(dim) : null;
    this.navGraph = graph;
    this.invalidate();
    this.invalidateOverlay();
  }
  protected override graphLines(): [Vec2, Vec2][] | null { return this.navGraph; }
  /** Not masked out: passing the filter itself, or part of a part that does. */
  unmasked(i: number): boolean {
    if (!this.mask) return true;
    if (this.mask.has(i)) return true;
    const o = this.doc.objects[i];
    return !!o && o.owner >= 0 && this.mask.has(o.owner);
  }

  constructor(public doc: SchDocument) {
    const sel = new SelectTool();
    super(sel);
    sel.editor = this;
    this.gridIndex = Math.max(0, this.gridSizes().indexOf(doc.sheet.snapGrid));
    const sb = doc.records.find((r) => r.bag?.int('RECORD', -1) === SR.SHEET)?.bag;
    this.electricalGrid = sb?.has('HOTSPOTGRIDON') ? sb.bool('HOTSPOTGRIDON') : true;
    this.electricalRange = sb?.has('HOTSPOTGRIDSIZE') ? schCoord(sb, 'HOTSPOTGRIDSIZE') : mil(40);
    // Hot spots as the document stands after each edit (never a tool's preview records)
    this.spots = electricalSpots(doc);
    this.undo.changed.on(() => { this.spots = electricalSpots(this.doc); });
  }

  /* ── net colours ── */
  /** View › Set Net Colors: a colour per net name on this sheet (for the session). */
  netColours = new Map<string, number>();
  /** View › Show Net Color Override (F5), for every sheet: Preferences › Graphical Editing › Net Color Override. */
  static get showNetColours(): boolean { return settings.schNetColourOverride; }
  static set showNetColours(on: boolean) { updateSettings({ schNetColourOverride: on }); }
  /** Object index → net colour, while drawing. */
  private overrides: Map<number, number> | null = null;
  /** Set by the app: what special strings (=DocumentName, project parameters …) resolve against. */
  specials: (() => SpecialContext) | null = null;
  private special: SpecialResolver = (t) => t;
  /** The net (by name) the wire, bus, label, power port or junction at p belongs to. */
  netAt(raw: Vec2): string | null {
    const k = this.hits(raw).map((h) => parseInt(h.key.slice(1), 10)).find((i) => { const o = this.doc.objects[i]; return o?.kind === 'wire' || o?.kind === 'bus' || o?.kind === 'junction' || o?.kind === 'power' || (o?.kind === 'text' && o.role === 'netlabel'); });
    if (k === undefined) return null;
    const seed = this.doc.objects[k]!.kind === 'wire' || this.doc.objects[k]!.kind === 'bus' ? k : wireConnection(this.doc, k).find((i) => this.doc.objects[i]?.kind === 'wire');
    if (seed === undefined) return null;
    const net = compileProject([{ name: this.doc.name, doc: this.doc }]).nets.find((n) => n.refs.some((r) => r.index === seed));
    return net?.name ?? null;
  }
  private netOverrides(): Map<number, number> | null {
    if (!SchEditor.showNetColours || !this.netColours.size || this.libraryMode) return null;
    const out = new Map<number, number>();
    for (const n of compileProject([{ name: this.doc.name, doc: this.doc }]).nets) {
      const c = this.netColours.get(n.name);
      if (c === undefined) continue;
      for (const r of n.refs) {
        const o = this.doc.objects[r.index];
        if (o?.kind === 'wire' || o?.kind === 'bus') for (const i of wireConnection(this.doc, r.index)) { const q = this.doc.objects[i]; if (q?.kind === 'wire' || q?.kind === 'bus' || q?.kind === 'junction') out.set(i, c); }
      }
    }
    return out;
  }

  /* ── electrical grid ── */
  /** View › Grids › Toggle Electrical Grid (Shift+E): placing snaps to hot spots within range. */
  electricalGrid = true;
  electricalRange = mil(40);
  private spots: Vec2[] = [];
  /** The hot spot the cursor snapped to, marked as Altium marks it. */
  private hotSpot: Vec2 | null = null;
  /** Tools whose cursor is an electrical point: wires, buses, wire ends, net labels, power ports, ports … */
  private electricalTool(): boolean {
    const id = this.tool.id;
    return id === 'place-wire' || id === 'place-bus' || id === 'sch-grip' || id === 'place-sheet-entry'
      || /^place\.(netLabel|power|gnd|vcc|port|junction|noErc)$/.test(id) || /^ad:Sch:Place(PowerPort_|OffsheetConnector|BusEntry)/.test(id);
  }
  snapPointer(raw: Vec2): Vec2 {
    const s = this.snap(raw);
    const was = this.hotSpot;
    this.hotSpot = null;
    if (this.electricalGrid && !this.libraryMode && this.electricalTool()) {
      let best: Vec2 | null = null, bd = this.electricalRange;
      for (const p of this.spots) { const d = Math.hypot(p.x - raw.x, p.y - raw.y); if (d <= bd) { bd = d; best = p; } }
      if (best) this.hotSpot = best;
    }
    if (was !== this.hotSpot) this.invalidateOverlay();
    return this.hotSpot ?? s;
  }
  protected override cursorMarker(): Vec2 | null { return this.electricalTool() ? this.hotSpot : null; }

  title(): string { return this.doc.name; }
  origin(): Vec2 { return { x: 0, y: 0 }; }
  gridSizes(): number[] {
    const s = this.doc.sheet.snapGrid;
    return SCH_GRIDS.includes(s) ? SCH_GRIDS : [s, ...SCH_GRIDS];
  }
  grid(): GridSpec {
    const c = hexToRgb(settings.schGridColour), dots = settings.schGridStyle === 'dots';
    return { size: this.doc.sheet.visibleGrid || mil(100), dots, color: hex4(c, dots ? 0.7 : 0.32), major: hex4(c, dots ? 0.7 : 0.32) };
  }

  startWire(bus = false): void { this.setTool(new PlaceWireTool(this, bus)); }

  /* ── selection helpers ── */
  /** Object indices behind a selection key ("o12" → [12]). */
  indicesOfKey(key: string): number[] { const i = parseInt(key.slice(1), 10); return this.doc.objects[i] ? [i] : []; }

  /**
   * Unions (Edit › Unions): objects that select and move together. Members share a union
   * number in UNIONINDEX [est: the key]; a click on one selects them all.
   */
  static readonly UNION_KEY = 'UNIONINDEX';
  /** Reports › Port Cross References: the reference text for each port (by object index), when shown. */
  portRefs: (() => Map<number, string>) | null = null;
  private refsNow: Map<number, string> | null = null;
  /** After a compile (Preferences › Compiler › Errors & Warnings): objects in violation, wavy-underlined. */
  violations: (() => Map<number, 'fatal' | 'error' | 'warning'> | null) | null = null;
  /** AutoFocus while placing, moving or editing: what joins the work stays, the rest dims; joined wires thicken. */
  focus: { set: Set<number>; dim: boolean; thick: boolean } | null = null;
  private focusTimer = 0;
  private focusActive = false;
  /** Start AutoFocus for an activity (Preferences › Schematic › AutoFocus) on these objects. */
  startFocus(indices: number[], activity: 'Place' | 'Move' | 'Edit' | 'InPlace'): void {
    if (this.libraryMode) return;
    const dim = settings[`schDimOn${activity}`], thick = settings[`schThickenOn${activity}`], zoom = settings[`schZoomOn${activity}`];
    clearTimeout(this.focusTimer);
    if (!dim && !thick && !zoom) { this.focus = null; return; }
    if (!dim && !thick) { if (!this.focusActive) { this.focusActive = true; this.zoomFocus(indices); } return; }
    const set = connectedTo(this.doc, indices);
    const fresh = !this.focusActive;
    this.focusActive = true;
    this.focus = { set, dim, thick };
    if (zoom && fresh) this.zoomFocus(indices, set);
    this.invalidate();
  }
  /** Zoom Connected Objects: the view takes in what joins the work (not for net objects with Restrict To Non-net Objects Only). */
  private zoomFocus(indices: number[], set = connectedTo(this.doc, indices)): void {
    const netOnly = indices.every((i) => { const k = this.doc.objects[i]?.kind; return k === 'wire' || k === 'bus' || k === 'junction' || k === 'power' || k === 'port' || (k === 'text' && (this.doc.objects[i] as { role?: string }).role === 'netlabel'); });
    if (settings.schZoomNonNetOnly && netOnly) return;
    this.zoomToBox(this.boundsOf([...set].map((i) => `o${i}`)), mil(1000));
  }
  /** End it: thickened wires stay thick for the Delay, then everything is drawn as usual. */
  endFocus(): void {
    const f = this.focus;
    this.focusActive = false;
    if (!f) return;
    clearTimeout(this.focusTimer);
    if (f.thick && settings.schThickenDelay > 0) {
      this.focus = { set: f.set, dim: false, thick: true };
      this.focusTimer = window.setTimeout(() => { this.focus = null; this.invalidate(); this.viewport?.requestRender(); }, settings.schThickenDelay);
    } else this.focus = null;
    this.invalidate();
  }
  /** Sheet Entries and Ports use Harness Color: the colours of the harness a port or entry carries. */
  private harnessLook(i: number): { line: number; fill: number } | null {
    const h = this.look.harness;
    if (!h) return null;
    const t = this.doc.records[i + 1]?.bag?.get('HARNESSTYPE');
    if (!t) return null;
    // The colour of the signal harness it meets; else its harness type's connector
    const o = this.doc.objects[i];
    const at = o?.kind === 'port' ? [o.at, o.style >= 4 ? { x: o.at.x, y: o.at.y + o.width } : { x: o.at.x + o.width, y: o.at.y }]
      : o?.kind === 'sheetentry' ? [entryPoint(this.doc, o)].filter((p): p is Vec2 => !!p) : [];
    const on = (p: Vec2, a: Vec2, b: Vec2) => p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)
      && (b.x - a.x) * (p.y - a.y) === (b.y - a.y) * (p.x - a.x);
    const sig = this.doc.objects.find((x) => x.kind === 'signalharness' && at.some((p) => x.pts.some((q, k) => k > 0 && on(p, x.pts[k - 1]!, q))));
    const conn = h.get(t.toLowerCase()) ?? { line: HARNESS_COLOUR.line, fill: HARNESS_COLOUR.fill };
    return sig?.kind === 'signalharness' ? { line: sig.color, fill: conn.fill } : conn;
  }
  /** Per build: what the Preferences drawing options need worked out once. */
  private look: { touches: ((p: Vec2) => boolean) | null; hops: Map<number, Vec2[]> | null; harness: Map<string, { line: number; fill: number }> | null } = { touches: null, hops: null, harness: null };
  /** Set by the app: Edit In-Place on this object (a second click on a selected text). */
  inPlaceEdit: ((key: string) => void) | null = null;
  /** Preferences › Graphical Editing › Auto Zoom off: jumping to an object only pans to it. */
  override jumpToSelection(minSize = 0): void {
    if (this.libraryMode || settings.schAutoZoom) { super.jumpToSelection(minSize); return; }
    this.scene();
    const b = this.selectionBounds();
    if (!(b.minX <= b.maxX)) return;
    this.pushView();
    this.viewport?.centreOn({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
  }
  /** Auto Pan Options: while a tool is placing or moving, the view follows the cursor past the edge. */
  autoPan(): AutoPan | null {
    if (this.tool === this.selectTool) return null;
    return { style: settings.schAutoPan, speed: settings.schAutoPanSpeed, step: settings.schAutoPanStep, shiftStep: settings.schAutoPanShiftStep };
  }
  /** A message for the status bar (a locked object refused, …). */
  notice: ((msg: string) => void) | null = null;

  /** Locked (LOCKED=T, or owned by a locked part); manual junctions are LOCKED too and don't count. */
  isLocked(i: number): boolean {
    const o = this.doc.objects[i];
    if (!o || o.kind === 'junction') return false;
    if (this.doc.records[i + 1]?.bag?.bool('LOCKED')) return true;
    return o.owner >= 0 && this.isLocked(o.owner);
  }
  /** Preferences › Protect Locked Objects: these can't be moved or deleted. */
  unlocked(indices: number[]): number[] {
    if (!settings.schProtectLocked) return indices;
    const out = indices.filter((i) => !this.isLocked(i));
    if (out.length < indices.length) this.notice?.(`${indices.length - out.length} locked object${indices.length - out.length === 1 ? ' is' : 's are'} protected (Preferences › Protect Locked Objects)`);
    return out;
  }
  /** The drawn box of these objects (with what they own). */
  boxOf(indices: number[]): BBox {
    this.scene();
    const set = new Set(indices.map((i) => `o${i}`));
    let b = emptyBox();
    for (const it of this.items) if (set.has(it.key) || (it.group && set.has(it.group))) b = union(b, it.bbox);
    return b;
  }
  /** Project › Variants: parts (object indices) not fitted in the current variant, crossed out. */
  notFitted: (() => Set<number>) | null = null;
  unionOf(i: number): string | undefined {
    if (this.libraryMode) return undefined;
    return this.doc.records[i + 1]?.bag?.get(SchEditor.UNION_KEY) || undefined;
  }
  unionKeys(key: string): string[] {
    const i = parseInt(key.slice(1), 10), u = this.unionOf(i);
    if (!u) return [key];
    return this.doc.objects.filter((o) => o.owner < 0 && this.unionOf(o.index) === u).map((o) => `o${o.index}`);
  }
  override select(keys: Iterable<string>, add = false): void {
    const all = new Set<string>();
    for (const k of keys) for (const u of this.unionKeys(k)) all.add(u);
    super.select(all, add);
  }
  /** Selected objects; a component's own texts drop out when the component is selected too. */
  selectedIndices(): number[] {
    const sel = [...this.selection].flatMap((k) => this.indicesOfKey(k));
    const set = new Set(sel);
    return sel.filter((i) => { const o = this.doc.objects[i]!; return !(o.owner >= 0 && set.has(o.owner)); });
  }

  /* ── moving ── */
  /** copy: pressed with Shift (a drag copies, a click adds to or takes from the selection). */
  private press: { key: string; at: Vec2; raw: Vec2; ctrl: boolean; wasSelected: boolean; copy?: boolean } | null = null;

  /** Move › Move / Drag (click an object), or Move / Drag Selection (click a reference point). */
  startMove(mode: MoveMode, selection = false): void {
    const t = new SchMoveTool(this, mode, null, null);
    t.pickSelection = selection && this.selection.size > 0;
    this.setTool(t);
  }

  /* ── clipboard ── */
  /** Edit › Copy: the selection (with what components own), referenced to the cursor. */
  copy(ref?: Vec2): boolean {
    const clip = this.clipOf(this.selectedIndices(), ref ?? this.snap(this.cursor));
    if (!clip) return false;
    setClipboard(clip);
    return true;
  }
  /** What Copy takes of these objects (with what they own), referenced to `ref`. */
  private clipOf(indices: number[], ref: Vec2): SchClip | null {
    // Preferences › Include with Clipboard: No-ERC markers, parameter sets, notes
    const leave = (o: SchObject) => (o.record === SR.NO_ERC && !settings.schClipNoErc) || (o.record === SR.PARAMETER_SET && !settings.schClipParameterSets) || (o.record === SR.NOTE && !settings.schClipNotes);
    let idx = indices.filter((i) => { const o = this.doc.objects[i]!; const ow = o.owner >= 0 ? this.doc.objects[o.owner] : undefined; return !(ow?.kind === 'component') && !leave(o); });
    if (!idx.length) return null;
    // Add Template to Clipboard: copying everything takes the template's graphics along
    if (settings.schTemplateToClipboard && !this.libraryMode && this.selection.size >= this.allKeys().length) {
      const t = this.doc.objects.find((o) => o.record === SR.TEMPLATE);
      if (t) idx = [...idx, ...this.doc.objects.filter((o) => o.owner === t.index).map((o) => o.index)];
    }
    const all = withChildren(this.doc, idx);
    const pos = new Map(all.map((i, k) => [i, k]));
    return { kind: 'sch', ref, items: all.map((i) => {
      const o = this.doc.objects[i]!;
      const bag = this.doc.records[i + 1]!.bag!.clone();
      if (o.owner >= 0 && this.doc.objects[o.owner]?.record === SR.TEMPLATE) { bag.delete('OWNERINDEX'); bag.set('OWNERPARTID', '-1'); }
      return { bag, owner: o.owner >= 0 && pos.has(o.owner) ? pos.get(o.owner)! : -1 };
    }) };
  }
  /**
   * Shift+drag on an object (or on the selection it is in): a copy follows the cursor and lands
   * where the button is let go, its names a step on (stepCopies), as the desktop software does it.
   * The clipboard is left as it was.
   */
  private copyDrag(indices: number[], at: Vec2): void {
    const clip = this.clipOf(this.unlocked(indices), this.snap(at));
    if (!clip) return;
    const taken = new Set(this.doc.objects.flatMap((o) => (o.kind === 'component' && o.designator ? [o.designator.toUpperCase()] : [])));
    const next = (s: string, secondary = false) => nextName(s, secondary ? settings.schIncSecondary : settings.schIncPrimary, settings.schRemoveLeadingZeroes);
    this.setTool(new SchPasteTool(this, { ...clip, items: stepCopies(clip.items, taken, next) }, false, undefined, true));
  }
  cut(): void { if (this.copy()) this.deleteSelection(); }
  paste(stamp = false): void {
    if (clipboard?.kind !== 'sch') return;
    this.setTool(new SchPasteTool(this, clipboard, stamp));
  }
  /** Edit › Duplicate: a copy placed one grid step down and right, selected. */
  duplicate(): void {
    if (!this.copy() || clipboard?.kind !== 'sch') return;
    const g = this.gridSize();
    const clip = clipboard;
    const base = this.doc.records.length - 1;
    const bags = clip.items.map((it) => {
      const b = transformBag(it.bag, { ...identity(), d: { x: g, y: -g } });
      if (it.owner >= 0) b.setRaw('OWNERINDEX', String(base + it.owner));
      if (b.has('UNIQUEID')) b.setRaw('UNIQUEID', uniqueId());
      return b;
    });
    if (settings.schResetDesignatorsOnPaste) resetPastedDesignators(clip.items, bags);
    this.undo.transact(`Duplicate ${bags.length} object${bags.length === 1 ? '' : 's'}`, (tx) => tx.add(addRecords(this.doc, bags)));
    this.select(clip.items.map((it, k) => (it.owner < 0 ? `o${base + k}` : '')).filter(Boolean));
  }

  /** Edit › Move › Rotate Selection (Space / Shift+Space): about the selection's centre, on the grid. */
  rotateSelection(quarter: number): void {
    const idx = this.selectedIndices();
    if (!idx.length) return;
    const b = this.selectionBounds();
    const pivot = this.snap({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
    this.transformSelection(idx, { ...identity(pivot), quarter }, quarter === 1 ? 'Rotate selection' : 'Rotate selection clockwise');
  }

  /** Ctrl+arrow: one grid step; Shift+Ctrl+arrow: ten. */
  nudge(dx: number, dy: number): void {
    const idx = this.selectedIndices();
    if (!idx.length) return;
    const g = this.gridSize();
    this.transformSelection(idx, { ...identity(), d: { x: dx * g, y: dy * g } }, 'Move selection');
  }

  /** Find Similar Objects: what can be picked on its own, compared by its stored properties. */
  override similarObjects(): { keys: string[]; attrs: Record<string, string> }[] {
    const doc = this.doc;
    const out: { keys: string[]; attrs: Record<string, string> }[] = [];
    const FIELDS: [string, string][] = [['TEXT', 'Text'], ['NAME', 'Name'], ['LIBREFERENCE', 'Library Reference'], ['DESIGNITEMID', 'Design Item ID'],
      ['COLOR', 'Colour'], ['AREACOLOR', 'Fill Colour'], ['LINEWIDTH', 'Line Width'], ['FONTID', 'Font'], ['ORIENTATION', 'Orientation'],
      ['ISMIRRORED', 'Mirrored'], ['STYLE', 'Style'], ['IOTYPE', 'I/O Type'], ['SHOWNETNAME', 'Show Net Name'], ['ISHIDDEN', 'Hidden']];
    for (const o of doc.objects) {
      const owner = o.owner >= 0 ? doc.objects[o.owner] : undefined;
      if (owner?.kind === 'component' && o.kind !== 'text') continue;
      if (owner && owner.kind !== 'component') continue;
      const bag = doc.records[o.index + 1]?.bag;
      if (!bag) continue;
      const a: Record<string, string> = { 'Object Kind': SR_NAME[o.record] ?? o.kind };
      if (owner?.kind === 'component') a.Parent = (owner as { designator?: string }).designator ?? '';
      for (const [k, label] of FIELDS) if (bag.has(k)) a[label] = bag.get(k) ?? '';
      out.push({ keys: [`o${o.index}`], attrs: a });
    }
    return out;
  }

  /** Edit › Align: each selected object (a part with its texts) moves as one. */
  align(kind: AlignKind): void {
    this.scene();
    const units = this.selectedIndices().filter((i) => { const o = this.doc.objects[i]!; return o.owner < 0 || this.doc.objects[o.owner]?.kind !== 'component'; });
    if (units.length < 2) return;
    const boxes = units.map((i) => {
      let b = emptyBox();
      for (const it of this.items) if (it.key === `o${i}` || it.group === `o${i}`) b = union(b, it.bbox);
      return b;
    });
    const deltas = alignDeltas(boxes, kind);
    this.moveUnits(units.map((i, k) => ({ idx: [i], d: deltas[k]! })), `Align ${ALIGN_LABEL[kind]}`);
  }
  /** Edit › Align › Align To Grid: each object's reference point onto the snap grid. */
  alignToGrid(): void {
    const units = this.selectedIndices().filter((i) => { const o = this.doc.objects[i]!; return o.owner < 0 || this.doc.objects[o.owner]?.kind !== 'component'; });
    this.moveUnits(units.map((i) => { const r = refPoint(this.doc, i); const s = r ? this.snap(r) : null; return { idx: [i], d: r && s ? { x: s.x - r.x, y: s.y - r.y } : { x: 0, y: 0 } }; }), 'Align to grid');
  }
  private moveUnits(list: { idx: number[]; d: Vec2 }[], label: string): void {
    const entries = list.filter((u) => u.d.x || u.d.y).flatMap((u) => withChildren(this.doc, u.idx).map((i) => {
      const before = this.doc.records[i + 1]!.bag!;
      return { index: i, before: before.clone(), after: transformBag(before, { ...identity(), d: u.d }) };
    }));
    if (entries.length) this.undo.transact(label, (tx) => tx.add(replaceBags(this.doc, entries)));
  }

  /** Edit › Move › Move Selection by X, Y. */
  moveBy(d: Vec2): void {
    const idx = this.selectedIndices();
    if (idx.length) this.transformSelection(idx, { ...identity(), d }, 'Move selection');
  }

  private transformSelection(idx: number[], x: ReturnType<typeof identity>, label: string): void {
    const all = withChildren(this.doc, idx);
    const entries = all.flatMap((i) => {
      const before = this.doc.records[i + 1]?.bag;
      return before ? [{ index: i, before: before.clone(), after: transformBag(before, x) }] : [];
    });
    this.undo.transact(label, (tx) => tx.add(replaceBags(this.doc, entries)));
  }

  override grips(): Grip[] {
    if (this.selection.size !== 1) return [];
    const key = [...this.selection][0]!;
    const o = this.doc.objects[parseInt(key.slice(1), 10)];
    if (!o || o.owner >= 0) return [];
    return gripsOf(o).map((at, index) => ({ at, key, index }));
  }

  /**
   * Live Simulation's ear on the sheet while it runs: a press on an object (a push button is held from it), the end of
   * the press (a release, or the start of a drag), and whether it was a plain click (a switch thrown, a probe taken).
   */
  liveHit: { down(key: string, p: ToolPointer): void; up(key: string | null, p: ToolPointer, clicked: boolean): void; near(at: Vec2): string | null } | null = null;
  /** A press between the contacts of a running sheet's switch or push button is a press on it, not the start of a selection box. */
  override wantsDrag(p: ToolPointer): boolean { return super.wantsDrag(p) && !this.liveHit?.near(p.raw); }

  override pointerDown(p: ToolPointer): void {
    this.press = null;
    // Shift on an object: a drag copies it; a click adds it to the selection or takes it out (on release)
    if (this.tool === this.selectTool && p.button === 0 && p.shift) {
      const hit = this.hits(p.raw)[0];
      if (hit) { this.press = { key: hit.key, at: p.world, raw: p.raw, ctrl: p.ctrl, wasSelected: this.selection.has(hit.key), copy: true }; return; }
    }
    if (this.tool === this.selectTool && p.button === 0 && !p.shift) {
      const grip = this.gripAt(p.raw);
      if (grip) { this.setTool(new SchGripTool(this, parseInt(grip.key.slice(1), 10), grip.index)); return; }
      // A switch or push button of a running sheet is pressed anywhere on it, between its contacts too
      const near = this.liveHit?.near(p.raw);
      const hit = this.hits(p.raw)[0] ?? (near ? { key: near } : undefined);
      if (hit) {
        const wasSelected = this.selection.has(hit.key);
        // Shift Click To Select: a plain click picks nothing (a drag still moves it)
        if (!wasSelected && !(settings.schShiftClickToSelect && !this.libraryMode)) this.select([hit.key]);
        this.press = { key: hit.key, at: p.world, raw: p.raw, ctrl: p.ctrl, wasSelected };
        this.liveHit?.down(hit.key, p);
        return;
      }
      // Click Clears Selection off: a click on empty space keeps the selection
      if (!settings.schClickClearsSelection && !this.libraryMode) return;
    }
    super.pointerDown(p);
  }

  override pointerMove(p: ToolPointer): void {
    const pr = this.press;
    if (pr && this.tool === this.selectTool) {
      const px = Math.hypot(p.raw.x - pr.raw.x, p.raw.y - pr.raw.y) * (this.viewport?.cam.scale ?? 1);
      if (px > 4) {
        this.press = null;
        if (!pr.copy) this.liveHit?.up(pr.key, p, false);
        if (pr.copy) {
          this.copyDrag(pr.wasSelected ? this.selectedIndices() : this.indicesOfKey(pr.key), pr.at);
          super.pointerMove(p);
          return;
        }
        const mode: MoveMode = pr.ctrl || settings.schAlwaysDrag ? 'drag' : 'move';
        const idx = pr.wasSelected || this.unionKeys(pr.key).length > 1 ? this.selectedIndices() : this.indicesOfKey(pr.key);
        this.setTool(new SchMoveTool(this, mode, idx, pr.at, true));
      }
    }
    super.pointerMove(p);
  }

  override pointerUp(p: ToolPointer, moved: boolean): void {
    const pr = this.press;
    this.press = null;
    // Shift+click: into the selection, or out of it
    if (pr?.copy) { if (!moved) this.select([pr.key], true); super.pointerUp(p, moved); return; }
    if (p.button === 0 && this.tool === this.selectTool) this.liveHit?.up(pr?.key ?? null, p, !moved && !!pr);
    // A click on one object of a multiple selection selects just that object
    if (pr && !moved && pr.wasSelected && this.selection.size > 1) this.select([pr.key]);
    // Enable In-Place Editing: a second click on a selected text edits it where it is
    else if (pr && !moved && pr.wasSelected && settings.schInPlaceEditing && this.selection.size === 1 && this.inPlaceEdit) {
      const o = this.doc.objects[parseInt(pr.key.slice(1), 10)];
      if (o && (o.kind === 'text' || o.kind === 'power' || o.kind === 'port' || o.kind === 'sheetentry')) {
        const key = pr.key;
        clearTimeout(this.editTimer);
        this.editTimer = setTimeout(() => { if (this.selection.has(key) && this.tool === this.selectTool) this.inPlaceEdit?.(key); }, 350);
      }
    }
    super.pointerUp(p, moved);
  }
  /** A second click's in-place edit, waiting out a double-click (which opens the properties instead). */
  private editTimer: ReturnType<typeof setTimeout> | undefined;
  override doubleClick(p: ToolPointer): void { clearTimeout(this.editTimer); super.doubleClick(p); }

  /* ── scene ── */
  protected build(scene: Scene, emit: (it: HitItem) => void): void {
    const doc = this.doc;
    scene.background = hexToRgb(settings.schWorkspaceColour);
    const { width: W, height: H } = doc.sheet;
    scene.inOrder = true;
    const sheet = scene.group('sheet', -10);
    if (this.libraryMode) {
      // The library editor's workspace: the sheet colour everywhere, cross hairs through the origin
      scene.background = doc.sheet.background;
      const big = mil(100_000), c = rgba(0x9aa0a6, 0.9);
      scene.segment(sheet, { x: -big, y: 0 }, { x: big, y: 0 }, 0, c, 1);
      scene.segment(sheet, { x: 0, y: -big }, { x: 0, y: big }, 0, c, 1);
    } else scene.rectFromCorners(sheet, { x: 0, y: 0 }, { x: W, y: H }, rgba(doc.sheet.background));
    const g = scene.group('objects', 0);
    const lib = this.libraryMode;
    const ctx = this.specials?.() ?? { docName: doc.name };
    this.special = lib ? (t) => t : specialResolver(doc, this.compiledView ? { ...ctx, overrides: this.compiledView.specials } : ctx, settings.schShowSpecialNames);
    if (!lib && (doc.sheet.border || doc.sheet.titleBlock)) {
      // Border, reference zones and title block in the sheet's border colour, in the system font
      const sb = doc.records.find((r) => r.bag?.int('RECORD', -1) === SR.SHEET)?.bag;
      const frameCol = sb?.has('COLOR') ? fromBgr(sb.int('COLOR')) : 0x000000;
      const fr = sheetFrame(doc.sheet, !!sb?.bool('USECUSTOMSHEET'), { date: this.special('=CurrentDate', -1), file: this.special('=DocumentFullPathAndName', -1) });
      const f = schFont(doc.sheet, doc.sheet.systemFont);
      for (const [a, b] of fr.lines) scene.segment(sheet, a, b, 0, rgba(frameCol), 1);
      for (const t of fr.texts) {
        scene.text(sheet, t.at, { text: t.text, size: f.size, family: f.family, rot: 0, color: css(t.role === 'value' ? 0x000080 : frameCol), h: t.h, v: t.v, anchor: settings.schTextAnchor });
      }
    }
    if (this.mask && this.maskRecords !== doc.records.length) this.mask = null;
    const masked = this.mask ? scene.group('masked', -1) : null;
    if (masked) masked.alpha = Math.max(0.05, 1 - SchEditor.maskDim);
    const font = (fontId: number) => schFont(doc.sheet, fontId);

    this.overrides = this.netOverrides();
    this.refsNow = this.portRefs?.() ?? null;
    this.look = {
      touches: settings.schPortDirection && !lib ? touchTest(doc) : null,
      hops: settings.schDisplayCrossOvers && !lib ? wireHops(doc) : null,
      harness: settings.schHarnessColour && !lib ? harnessLooks(doc) : null,
    };
    const unfitted = lib ? null : this.notFitted?.() ?? null;
    const partBox = new Map<number, BBox>();
    const viol = lib ? null : this.violations?.() ?? null;
    const violBox = new Map<number, BBox>();
    // AutoFocus: what isn't joined to the work dims (graphics too with All Objects)
    const focus = this.focus?.dim ? this.focus.set : this.navDim;
    const dimmed = focus ? scene.group('dimmed', -1) : null;
    if (dimmed) dimmed.alpha = Math.max(0.05, 1 - settings.schDimLevel / 100);
    const electrical = new Set(['wire', 'bus', 'junction', 'pin', 'component', 'power', 'port', 'sheetentry', 'sheetsymbol', 'busentry', 'harness', 'harnessentry', 'signalharness', 'noerc']);
    for (const o0 of doc.objects) {
      // A compiled view: the names the compile gave
      const o = this.compiledView ? this.compiledObject(o0) : o0;
      const owner = o.owner >= 0 ? doc.objects[o.owner] : undefined;
      // Template graphics (a sheet template's title block, under its TEMPLATE record, which isShown counts as a model's
      // records): drawn with Document Options › Show Template Graphics on, never picked (Design › Templates changes them)
      if (owner?.record === SR.TEMPLATE) {
        if (doc.sheet.showTemplate && !o.hidden && o.kind !== 'meta') this.drawObject(o, font, (_b, _t, draw) => draw(scene, masked && !this.unmasked(o.index) ? masked : g));
        continue;
      }
      if (!isShown(doc, o) && !(o.kind === 'pin' && o.hidden && isShown(doc, { ...o, hidden: false }) && (this.showHiddenPins || this.ownerShowsHidden(o)))) continue;
      if (masked && !this.unmasked(o.index)) {
        // Faded and out of reach until the filter is cleared
        this.drawObject(o, font, (_b, _t, draw) => draw(scene, masked));
        continue;
      }
      if (lib && owner?.kind === 'component' && o.kind === 'text' && (o.role === 'designator' || o.role === 'parameter')) continue;
      // A component's designator and parameters pick on their own (drag them aside), but select with it
      const ownText = owner?.kind === 'component' && o.kind === 'text' && !lib;
      const key = owner?.kind === 'component' && !ownText && !lib ? `o${owner.index}` : `o${o.index}`;
      const group = ownText ? `o${owner!.index}` : undefined;
      const unit = owner?.kind === 'component' ? owner.index : o.index;
      const faded = focus && !focus.has(o.index) && !focus.has(unit) && (settings.schDimAll || electrical.has(o.kind) || owner?.kind === 'component' || (o.kind === 'text' && o.role === 'netlabel'));
      const v = viol?.get(o.index);
      const add = (bbox: BBox, test: HitItem['test'], draw: (s: Scene, gg: DrawGroup, c?: number) => void) => {
        draw(scene, faded ? dimmed! : g);
        emit({ key, group, bbox, test, draw: (s, gg, c) => draw(s, gg, c), order: ownText ? 1 : 0 });
        if (v) violBox.set(o.index, union(violBox.get(o.index) ?? emptyBox(), bbox));
        if (unfitted?.has(owner?.kind === 'component' ? owner.index : o.index) && !(o.kind === 'text')) {
          const k = owner?.kind === 'component' ? owner.index : o.index;
          partBox.set(k, union(partBox.get(k) ?? emptyBox(), bbox));
        }
      };
      this.drawObject(o, font, add);
    }
    // Variants: a part not fitted in the current variant is crossed out in red
    for (const box of partBox.values()) {
      const red = rgba(0xff0000), w = mil(10);
      scene.segment(g, { x: box.minX, y: box.minY }, { x: box.maxX, y: box.maxY }, w, red);
      scene.segment(g, { x: box.minX, y: box.maxY }, { x: box.maxX, y: box.minY }, w, red);
    }
    // Automatic junctions: drawn, never stored or selected (as in Altium); on buses too when asked
    if (settings.schAutoJunctions && !lib) {
      const size = Math.max(0, JUNCTION_SIZES.indexOf(settings.schAutoJunctionSize));
      const r = mil(JUNCTION_DIAMETER[size] ?? JUNCTION_DIAMETER[0]) / 2;
      for (const j of autoJunctions(doc)) scene.circle(g, j.at, r, rgba(hexToRgb(settings.schAutoJunctionColour)));
      if (settings.schAutoJunctionsBuses) for (const j of autoJunctions(doc, 'bus')) scene.circle(g, j.at, r * 2, rgba(hexToRgb(settings.schAutoJunctionBusColour)));
    }
    // Manual Junctions Connection Status: a ring round each, green when it joins three or more
    if (settings.schManualJunctionStatus && !lib) {
      const rr = mil(MANUAL_RING[settings.schManualJunctionSize] ?? 50);
      for (const [i, n] of junctionConnections(doc)) {
        const j = doc.objects[i] as { at: Vec2 };
        scene.arc(g, j.at, rr, 0, 360, mil(6), rgba(n >= 3 ? 0x00b000 : 0xff0000), 1);
      }
    }
    // Errors & Warnings: a wavy line under each object in violation
    for (const [i, b] of violBox) {
      const lv = viol!.get(i)!;
      if (!(lv === 'fatal' ? settings.schShowFatal : lv === 'error' ? settings.schShowErrors : settings.schShowWarnings)) continue;
      const col = rgba(lv === 'warning' ? 0xffa500 : lv === 'fatal' ? 0x800000 : 0xff0000);
      const y = b.minY - mil(15), step = mil(20), amp = mil(8);
      const pts: Vec2[] = [];
      for (let x = b.minX, k = 0; x <= b.maxX + step / 2; x += step, k++) pts.push({ x: Math.min(x, b.maxX), y: y + (k % 2 ? -amp : amp) });
      if (pts.length >= 2) scene.polyline(g, pts, mil(lv === 'fatal' ? 10 : 6), col, false, 1);
    }
  }

  /** A part placed with Show Hidden Pins (SHOWHIDDENPINS) draws its hidden pins. */
  private ownerShowsHidden(o: SchObject): boolean {
    const ow = o.owner >= 0 ? this.doc.objects[o.owner] : undefined;
    return ow?.kind === 'component' && !!this.doc.records[ow.index + 1]?.bag?.bool('SHOWHIDDENPINS');
  }

  private drawObject(
    o: SchObject, font: (fontId: number) => FontSpec,
    add: (bbox: BBox, test: HitItem['test'], draw: (s: Scene, g: DrawGroup, c?: number) => void) => void,
    objs: SchObject[] = this.doc.objects,
  ): void {
    // Document colours, or Konium's palette when Preferences › Schematic says so
    const useDoc = settings.schUseDocumentColours;
    const role = o.kind === 'wire' || o.kind === 'bus' || o.kind === 'junction' || o.kind === 'busentry' ? SCH_DEFAULTS.wire
      : o.kind === 'pin' ? SCH_DEFAULTS.pin : o.kind === 'power' ? SCH_DEFAULTS.power : o.kind === 'port' ? SCH_DEFAULTS.port : SCH_DEFAULTS.body;
    const net = this.overrides?.get(o.index);
    const C = (rgb: number, ov?: number) => ov ?? rgba(net ?? (useDoc ? rgb : role));
    const F = (rgb: number, ov?: number) => ov ?? rgba(useDoc ? rgb : o.kind === 'port' ? SCH_DEFAULTS.portFill : SCH_DEFAULTS.bodyFill);
    const T = (rgb: number) => css(useDoc ? rgb : SCH_DEFAULTS.text);
    // Single '\' Negation: "\RESET" bars the whole name, as "R\E\S\E\T\" does
    const single = settings.schSingleNegation;
    const shown = (t: string) => {
      if (!settings.schOverlines) return t.replace(/\\/g, '');
      if (single && t.length > 1 && t.startsWith('\\') && !t.slice(1).includes('\\')) return [...t.slice(1)].map((c) => `${c}\\`).join('');
      return t;
    };
    const anchor = settings.schTextAnchor;
    const overline = settings.schOverlines;
    const lineW = (w: Coord) => w;
    // Altium's Transparent fill: what is beneath shows through, darkening it (D2's diodes under its body)
    const fillOf = (transparent: boolean, s: Scene, g: DrawGroup, c: number | undefined, fill: () => void) => {
      if (transparent && c === undefined) s.darken(g, fill); else fill();
    };
    const segsTest = (pts: Vec2[], w: Coord) => (p: Vec2, tol: number) => {
      for (let i = 1; i < pts.length; i++) if (distToSegment(p, pts[i - 1]!, pts[i]!) <= Math.max(w / 2, tol)) return true;
      return false;
    };
    const textItem = (at: Vec2, text: string, fs: FontSpec, orient: number, justify: number, color: number) => {
      const size = fs.size;
      // Altium never draws text upside down: 180° and 270° keep upright glyphs and flip the
      // horizontal justification instead (same rule as KiCad's importer).
      const h = (orient >= 2 ? 2 - (justify % 3) : justify % 3) as 0 | 1 | 2, v = Math.floor(justify / 3) as 0 | 1 | 2;
      const w = size * 0.55 * Math.max(1, text.replace(/\\/g, '').length), hgt = size * 0.8;
      // Approximate pick box. Vertical text (90°) reads bottom-to-top with glyph tops to the left.
      const vert = orient % 2 === 1;
      const bw = vert ? hgt : w, bh = vert ? w : hgt;
      const x0 = vert ? at.x - hgt + (v * hgt) / 2 : at.x - (h * w) / 2;
      const y0 = vert ? at.y - (h * w) / 2 : at.y - (v * hgt) / 2;
      const bbox = { minX: x0, minY: y0, maxX: x0 + bw, maxY: y0 + bh };
      add(bbox, (p) => p.x >= bbox.minX && p.x <= bbox.maxX && p.y >= bbox.minY && p.y <= bbox.maxY,
        (s, g, c) => {
          if (c !== undefined) s.rect(g, { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 }, bw, bh, 0, 0, (c & 0x00ffffff) | 0x40000000);
          else s.text(g, at, { text: shown(text), size, rot: vert ? 90 : 0, color: T(color), h, v, bold: fs.bold, italic: fs.italic, family: fs.family, anchor, overline });
        });
    };

    switch (o.kind) {
      case 'wire': case 'bus': case 'polyline': case 'bezier': {
        const pts = o.kind === 'bezier' ? bezier(o.pts) : o.pts;
        // Display Cross-Overs: hops where it crosses another wire; AutoFocus: joined wires thicken
        const hops = o.kind === 'wire' ? this.look.hops?.get(o.index) : undefined;
        const drawn = hops ? hopped(pts, hops, mil(10)) : pts; // [est: radius, from an AD17 screen grab]
        const thick = (o.kind === 'wire' || o.kind === 'bus') && this.focus?.thick && this.focus.set.has(o.index);
        const w = thick ? Math.max(o.width * 2.5, mil(25)) : o.width;
        const pattern = o.kind === 'polyline' && o.style ? linePattern(o.style, o.width) : null;
        add(boxOfPoints(drawn, o.width / 2 + mil(5)), segsTest(pts, o.width), (s, g, c) => {
          if (pattern) for (const [a, b] of dashPattern(drawn, pattern)) s.segment(g, a, b, lineW(w), C(o.color, c));
          else s.polyline(g, drawn, lineW(w), C(o.color, c));
        });
        break;
      }
      case 'polygon': {
        const idx = triangulate(o.pts);
        add(boxOfPoints(o.pts, o.width), (p, tol) => pointInPoly(p, o.pts) || segsTest([...o.pts, o.pts[0]!], o.width)(p, tol), (s, g, c) => {
          if (o.solid) fillOf(o.transparent, s, g, c, () => s.polygon(g, o.pts, idx, F(o.fill, c)));
          s.polyline(g, o.pts, o.width, C(o.color, c), true);
        });
        break;
      }
      case 'rect': {
        // Rounded corners are elliptical and clamped to half the size, so a small square with large radii is a circle [AD].
        const pts = o.r ? roundRectPoints(o.a, o.b, o.r, o.ry) : [o.a, { x: o.b.x, y: o.a.y }, o.b, { x: o.a.x, y: o.b.y }];
        const bb = boxOfPoints([o.a, o.b], o.width);
        add(bb, (p) => p.x >= bb.minX && p.x <= bb.maxX && p.y >= bb.minY && p.y <= bb.maxY, (s, g, c) => {
          if (o.solid) fillOf(o.transparent, s, g, c, () => (o.r ? s.polygon(g, pts, triangulate(pts), F(o.fill, c)) : s.rectFromCorners(g, o.a, o.b, F(o.fill, c))));
          s.polyline(g, pts, o.width, C(o.color, c), true);
        });
        break;
      }
      case 'ellipse': {
        const pts = arcPoints(o.c, o.rx, o.ry || o.rx, 0, 360, 48);
        add(boxOfPoints(pts, o.width), (p) => pointInPoly(p, pts), (s, g, c) => {
          if (o.solid) fillOf(o.transparent, s, g, c, () => s.polygon(g, pts, triangulate(pts), F(o.fill, c)));
          s.polyline(g, pts, o.width, C(o.color, c), true);
        });
        break;
      }
      case 'arc': {
        const bb = { minX: o.c.x - o.rx, minY: o.c.y - o.ry, maxX: o.c.x + o.rx, maxY: o.c.y + o.ry };
        add(bb, (p, tol) => distToArc(p, o.c, o.rx, o.start, o.end) <= tol + o.width / 2, (s, g, c) => {
          if (o.rx === o.ry) s.arc(g, o.c, o.rx, o.start, o.end, o.width, C(o.color, c));
          else s.polyline(g, arcPoints(o.c, o.rx, o.ry, o.start, o.end), o.width, C(o.color, c));
        });
        break;
      }
      case 'text': {
        // A multi-part package shows its part letter after the designator: U1A, U1B
        // Labels and parameters show what their special strings stand for (=Title, =Value …)
        let text = o.role === 'label' || o.role === 'parameter' ? this.special(o.text, o.owner) : o.text;
        // A directive's PCB rule shows as its summary ("Impedance Constraint [Min = 49.00   Max = 51.00   ]"), not its raw value
        if (o.role === 'parameter') {
          const pb = this.doc.records[o.index + 1]?.bag;
          const rule = pb ? ruleParameterText(pb.get('NAME'), o.text, pb.get('DESCRIPTION')) : null;
          if (rule !== null) text = rule;
        }
        const owner = o.role === 'designator' && o.owner >= 0 ? this.doc.objects[o.owner] : undefined;
        if (owner?.kind === 'component' && owner.partCount > 2) text += partSuffix(owner.partId, settings.schSuffix === 'numeric');
        textItem(o.at, text, font(o.font), o.orient, o.justify, o.color);
        // Mark Manual Parameters: a dot by a part's parameter (or designator) whose Autoposition is off (OVERRIDENOTAUTOPOSITION=T, as AD17 writes it)
        if (settings.schMarkManualParams && (o.role === 'parameter' || o.role === 'designator') && this.doc.objects[o.owner]?.kind === 'component'
          && this.doc.records[o.index + 1]?.bag?.bool('OVERRIDENOTAUTOPOSITION')) {
          const at = { x: o.at.x - mil(25), y: o.at.y + mil(25) }, r = mil(8);
          add({ minX: at.x - r, minY: at.y - r, maxX: at.x + r, maxY: at.y + r }, () => false, (s, g, c) => { if (c === undefined) s.circle(g, at, r, rgba(0x808080)); });
        }
        break;
      }
      case 'pin': {
        // +b reads as "above the pin" whichever way it points (IEEE marks keep their side)
        const d = DIR[o.orient]!, flip = o.orient >= 2 ? -1 : 1, n = { x: -d.y * flip, y: d.x * flip };
        const P = ([a, b]: Pt): Vec2 => ({ x: o.at.x + d.x * mil(a) + n.x * mil(b), y: o.at.y + d.y * mil(a) + n.y * mil(b) });
        const end = { x: o.at.x + d.x * o.length, y: o.at.y + d.y * o.length };
        const gl = pinGlyph(o.symbols, o.electrical, settings.schPinDirection);
        add(boxOfPoints([o.at, end], mil(20)), segsTest([o.at, end], mil(20)), (s, g, c) => {
          const col = C(o.color, c);
          const from = Math.min(mil(gl.lineFrom), o.length);
          // As wide as a small wire, as AD17 draws pins
          s.segment(g, { x: o.at.x + d.x * from, y: o.at.y + d.y * from }, end, mil(10), col);
          if (c !== undefined) return;
          drawGlyphs(s, g, gl.parts, P, col);
          const sys = font(this.doc.sheet.systemFont);
          const size = sys.size;
          const rot = o.orient % 2 ? 90 : 0;
          // Name inside the body, designator along the pin (Altium's Pin Margin › Name / Designator)
          if (o.showName && o.name) {
            const m = mil(settings.schPinNameMargin);
            const at = { x: o.at.x - d.x * m, y: o.at.y - d.y * m };
            const h: 0 | 2 = (o.orient === 0 || o.orient === 1) ? 2 : 0;
            s.text(g, at, { text: shown(o.name), size, rot, color: T(0x1d3557), h, v: 1, family: sys.family, anchor, overline });
          }
          if (o.showDesignator && o.designator) {
            const m = mil(settings.schPinNumberMargin);
            const at = { x: o.at.x + d.x * m, y: o.at.y + d.y * m };
            const h: 0 | 2 = (o.orient === 0 || o.orient === 1) ? 0 : 2;
            s.text(g, at, { text: o.designator, size, rot, color: T(0x22252a), h, v: 0, family: sys.family, anchor });
          }
        });
        break;
      }
      case 'junction': {
        // A junction the schematic placed itself (not LOCKED) takes Preferences › Compiler › Auto-Junctions' size and colour, as in AD17
        const auto = !this.libraryMode && !this.doc.records[o.index + 1]?.bag?.bool('LOCKED');
        if (auto && !settings.schAutoJunctions) break;
        const size = auto ? Math.max(0, JUNCTION_SIZES.indexOf(settings.schAutoJunctionSize)) : o.size;
        const r = mil(JUNCTION_DIAMETER[size] ?? JUNCTION_DIAMETER[0]) / 2;
        const col = (c?: number) => (auto && c === undefined && !net ? rgba(hexToRgb(settings.schAutoJunctionColour)) : C(o.color, c));
        add({ minX: o.at.x - r, minY: o.at.y - r, maxX: o.at.x + r, maxY: o.at.y + r }, (p, tol) => Math.hypot(p.x - o.at.x, p.y - o.at.y) <= r + tol,
          (s, g, c) => s.circle(g, o.at, r, col(c)));
        break;
      }
      case 'splice': {
        // A harness splice: a small filled square; a layout's connection point: a ring. Its name above
        const r = mil(o.point ? 15 : 20);
        add({ minX: o.at.x - r, minY: o.at.y - r, maxX: o.at.x + r, maxY: o.at.y + r }, (p, tol) => Math.abs(p.x - o.at.x) <= r + tol && Math.abs(p.y - o.at.y) <= r + tol,
          (s, g, c) => {
            if (o.point) { s.circle(g, o.at, r, C(o.color, c)); s.circle(g, o.at, r * 0.55, c !== undefined ? C(o.color, c) : rgba(0xffffff)); }
            else s.rect(g, o.at, 2 * r, 2 * r, 0, 0, C(o.color, c));
          });
        if (o.showName && o.name) textItem({ x: o.at.x, y: o.at.y + r + mil(12) }, o.name, font(o.font), 0, 1, o.color);
        break;
      }
      case 'power': {
        // Glyph geometry per STYLE in its own frame (a along the stem, b across), mapped by ORIENTATION
        const d = DIR[o.orient]!, n = { x: -d.y, y: d.x };
        const gl: PowerGlyph = o.crossSheet ? { lines: OFF_SHEET.lines, labelAt: OFF_SHEET.labelAt } : powerGlyph(o.style);
        const P = ([a, b]: Pt): Vec2 => ({ x: o.at.x + d.x * mil(a) + n.x * mil(b), y: o.at.y + d.y * mil(a) + n.y * mil(b) });
        const all: Vec2[] = [...gl.lines.flat(), ...(gl.circles ?? []).flatMap((c) => [[c.c[0] + c.r, c.c[1] + c.r], [c.c[0] - c.r, c.c[1] - c.r]] as Pt[]),
          ...(gl.beziers ?? []).flat()].map(P);
        const bb = boxOfPoints(all, mil(10));
        add(bb, (p) => p.x >= bb.minX && p.x <= bb.maxX && p.y >= bb.minY && p.y <= bb.maxY, (s, g, c) => {
          const col = C(o.color, c), w = mil(10);
          for (const line of gl.lines) s.polyline(g, line.map(P), w, col);
          for (const ci of gl.circles ?? []) s.arc(g, P(ci.c), mil(ci.r), 0, 360, mil(ci.w ?? 10), col);
          for (const bz of gl.beziers ?? []) s.polyline(g, bezierPts(bz).map(P), w / 2, col);
          if (o.showText && o.text && c === undefined) {
            const f = font(o.font || this.doc.sheet.systemFont);
            const vertical = o.orient % 2 === 1;
            // Up/down: centred beyond the glyph. Left/right: reads horizontally, starting beyond the glyph.
            s.text(g, P([gl.labelAt, 0]), { text: shown(o.text), size: f.size, family: f.family, bold: f.bold, italic: f.italic, rot: 0, color: T(o.color),
              h: vertical ? 1 : o.orient === 0 ? 0 : 2, v: vertical ? (o.orient === 1 ? 0 : 2) : 1, anchor, overline });
          }
        });
        break;
      }
      case 'port': {
        const { at, width: w, height: h } = o;
        const vertical = o.style >= 4;
        // Horizontal ports run right from LOCATION, vertical ones up
        const place = ([a, b]: Pt): Vec2 => vertical ? { x: at.x + b, y: at.y + a } : { x: at.x + a, y: at.y + b };
        // Port Direction: the shape from the I/O type and the joined end; harness ports in the harness's colours
        const style = this.look.touches ? shownPortStyle(o, this.look.touches, settings.schUnconnectedLeftToRight) : o.style;
        const placed = portOutline(style, w, h).map(place);
        const idx = triangulate(placed);
        const hl = this.harnessLook(o.index);
        add(boxOfPoints(placed), (p) => pointInPoly(p, placed), (s, g, c) => {
          s.polygon(g, placed, idx, hl && c === undefined ? rgba(hl.fill) : F(o.fill, c));
          s.polyline(g, placed, mil(6), hl && c === undefined ? rgba(hl.line) : C(o.color, c), true);
          if (c === undefined && o.name) {
            const f = font(o.font || this.doc.sheet.systemFont);
            // ALIGNMENT 0 centre, 1 right, 2 left; text sits clear of the pointed ends
            const inset = h / 2 + mil(50);
            const a = o.align === 2 ? inset : o.align === 1 ? w - inset : w / 2;
            const hj: 0 | 1 | 2 = o.align === 2 ? 0 : o.align === 1 ? 2 : 1;
            s.text(g, place([a, 0]), { text: shown(o.name), overline, size: f.size, family: f.family, bold: f.bold, italic: f.italic,
              rot: vertical ? 90 : 0, color: css(o.textColor), h: hj, v: 1, anchor });
          }
          // Port cross reference beyond the far end
          const ref = c === undefined ? this.refsNow?.get(o.index) : undefined;
          if (ref) {
            const f = font(this.doc.sheet.systemFont);
            s.text(g, place([w + mil(50), 0]), { text: ref, size: f.size * 0.85, family: f.family, rot: vertical ? 90 : 0, color: T(o.color), h: 0, v: 1, anchor });
          }
        });
        break;
      }
      case 'sheetentry': {
        const sym = this.doc.objects[o.owner];
        if (sym?.kind !== 'sheetsymbol') break;
        // Inward frame from the edge the entry sits on: a inward, b along the edge
        const left = sym.at.x, top = sym.at.y, right = sym.at.x + sym.w, bottom = sym.at.y - sym.h;
        const side = o.side;
        const P = ([a, b]: Pt): Vec2 =>
          side === 1 ? { x: right - mil(a), y: top - o.distance + mil(b) }
          : side === 2 ? { x: left + o.distance + mil(b), y: top - mil(a) }
          : side === 3 ? { x: left + o.distance + mil(b), y: bottom + mil(a) }
          : { x: left + mil(a), y: top - o.distance + mil(b) };
        const placed = sheetEntryOutline(shownEntryShape(o.io, o.style, side, settings.schSheetEntryDirection)).map(P);
        const idx = triangulate(placed);
        const hl = this.harnessLook(o.index);
        add(boxOfPoints(placed), (p) => pointInPoly(p, placed), (s, g, c) => {
          s.polygon(g, placed, idx, hl && c === undefined ? rgba(hl.fill) : F(o.fill, c));
          s.polyline(g, placed, 0, hl && c === undefined ? rgba(hl.line) : C(o.color, c), true, 1);
          if (c === undefined && o.name) {
            const f = font(o.font || this.doc.sheet.systemFont);
            const vertical = side >= 2;
            // Reads inward from the entry: left edge → left-aligned, right edge → right-aligned
            const hj: 0 | 2 = side === 1 || side === 2 ? 2 : 0;
            s.text(g, P([SHEET_ENTRY_TEXT_AT, 0]), { text: shown(o.name), overline, size: f.size, family: f.family, bold: f.bold, italic: f.italic,
              rot: vertical ? 90 : 0, color: T(o.textColor), h: hj, v: 1, anchor });
          }
        });
        break;
      }
      case 'noerc': {
        const gl = noErcGlyph(o.symbol), q = ((o.orient % 4) + 4) % 4;
        const turn = ([u, v]: Pt): Vec2 => { const [x, y] = q === 0 ? [u, v] : q === 1 ? [-v, u] : q === 2 ? [-u, -v] : [v, -u]; return { x: o.at.x + mil(x), y: o.at.y + mil(y) }; };
        const lines = gl.lines.map((l) => l.map(turn));
        const w = mil(gl.w);
        add(boxOfPoints(lines.flat(), w), () => true, (s, g, c) => { for (const l of lines) s.polyline(g, l, w, C(o.color, c)); });
        break;
      }
      case 'busentry':
        add(boxOfPoints([o.a, o.b], mil(10)), segsTest([o.a, o.b], o.width), (s, g, c) => s.segment(g, o.a, o.b, o.width, C(o.color, c)));
        break;
      case 'sheetsymbol': {
        const a = o.at, b = { x: o.at.x + o.w, y: o.at.y - o.h };
        const bb = boxOfPoints([a, b]);
        add(bb, (p) => p.x >= bb.minX && p.x <= bb.maxX && p.y >= bb.minY && p.y <= bb.maxY, (s, g, c) => {
          s.rectFromCorners(g, a, b, F(o.fill, c));
          s.polyline(g, [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], o.width, C(o.color, c), true, 1);
          // A device sheet symbol: a second outline just inside [est: AD17's device sheet look]
          if (o.device) { const k = mil(20); s.polyline(g, [{ x: a.x + k, y: a.y - k }, { x: b.x - k, y: a.y - k }, { x: b.x - k, y: b.y + k }, { x: a.x + k, y: b.y + k }], 0, C(o.color, c), true, 1); }
        });
        break;
      }
      case 'textframe': {
        const bb = boxOfPoints([o.a, o.b]);
        // A Note: a sticky note with its top-right corner folded over
        const note = o.record === SR.NOTE, fold = Math.min(mil(100), (bb.maxX - bb.minX) / 4, (bb.maxY - bb.minY) / 4);
        const outline = note ? [{ x: bb.minX, y: bb.minY }, { x: bb.maxX, y: bb.minY }, { x: bb.maxX, y: bb.maxY - fold }, { x: bb.maxX - fold, y: bb.maxY }, { x: bb.minX, y: bb.maxY }]
          : [o.a, { x: o.b.x, y: o.a.y }, o.b, { x: o.a.x, y: o.b.y }];
        add(bb, (p) => p.x >= bb.minX && p.x <= bb.maxX && p.y >= bb.minY && p.y <= bb.maxY, (s, g, c) => {
          if (note) {
            s.polygon(g, outline, triangulate(outline), F(o.fill, c));
            s.polyline(g, outline, o.width, C(o.color, c), true);
            const corner = [{ x: bb.maxX - fold, y: bb.maxY }, { x: bb.maxX - fold, y: bb.maxY - fold }, { x: bb.maxX, y: bb.maxY - fold }];
            s.polygon(g, corner, [0, 1, 2], c ?? rgba(0xd8d8d8));
            s.polyline(g, corner, o.width, C(o.color, c), false);
          } else if (o.solid || c !== undefined) s.rectFromCorners(g, o.a, o.b, F(o.fill, c));
          if (o.border && !note) s.polyline(g, outline, o.width, C(o.color, c), true);
          const text = this.special(o.text, o.owner);
          if (c === undefined && text) {
            const f = font(o.font);
            const h = (o.align === 2 ? 1 : o.align === 3 ? 2 : 0) as 0 | 1 | 2;
            s.text(g, { x: bb.minX, y: bb.maxY }, { text, size: f.size, family: f.family, bold: f.bold, italic: f.italic, rot: 0, color: T(o.textColor), h, v: 2, anchor,
              frame: { ...bb, margin: o.margin, wrap: o.wrap, clip: o.clip } });
          }
        });
        break;
      }
      case 'image': {
        const pts = [o.a, { x: o.b.x, y: o.a.y }, o.b, { x: o.a.x, y: o.b.y }];
        // An embedded picture once decoded; a linked one (or one still decoding) as a crossed box
        const img = o.embedded ? embeddedImage(this.doc, o.file, () => this.invalidate()) : linkedImage(o.file);
        add(boxOfPoints(pts), () => true, (s, g, c) => {
          if (img && c === undefined) { s.image(g, o.a, o.b, img); return; }
          s.polyline(g, pts, 0, C(0x7a8580, c), true);
          if (!img) { s.segment(g, o.a, o.b, 0, C(0x7a8580, c)); s.segment(g, pts[1]!, pts[3]!, 0, C(0x7a8580, c)); }
        });
        break;
      }
      case 'ieee': {
        // Cell u = SCALEFACTOR × 10 mil; mirror across the cell's left edge, then turn about LOCATION
        const u = mil(10 * o.scale), gl = ieeeGlyph(o.symbol);
        const turn = (x: number, y: number): Vec2 => { for (let i = 0; i < o.orient; i++) [x, y] = [-y, x]; return { x: o.at.x + x, y: o.at.y + y }; };
        const P = ([a, b]: Pt): Vec2 => turn((o.mirrored ? -a : a) * u, b * u);
        const all = [...gl.lines.flat(), ...gl.fills.flat(), ...gl.circles.flatMap((c) => [[c.c[0] - c.r, c.c[1] - c.r], [c.c[0] + c.r, c.c[1] + c.r]] as Pt[])].map(P);
        const bb = boxOfPoints(all, mil(5));
        const w = Math.max(o.width, mil(4));
        add(bb, (p) => p.x >= bb.minX && p.x <= bb.maxX && p.y >= bb.minY && p.y <= bb.maxY, (s, g, c) => {
          const col = C(o.color, c);
          for (const l of gl.lines) s.polyline(g, l.map(P), w, col);
          for (const f of gl.fills) { const pts = f.map(P); s.polygon(g, pts, triangulate(pts), col); }
          for (const ci of gl.circles) s.arc(g, P(ci.c), ci.r * u, 0, 360, w, col);
        });
        break;
      }
      case 'directive': {
        // Differential Pair: two parting lines on a lead; any other Parameter Set: an "i" in a circle on a stem, its name above
        // STYLE: absent Large, 1 Tiny (the only two AD17 offers) [est: Tiny's scale]
        const diff = o.name.toUpperCase() === 'DIFFPAIR', ps = PARAMETER_SET;
        const k = o.style === 1 ? 0.5 : 1;
        // Turned anticlockwise like everything else, the glyph lying along +X at 0: ORIENTATION 0 has the
        // stem pointing left (the circle to the right of the point), 1 stands it up (AD17's PCB Rule
        // directives), 2 the stem pointing right, 3 pointing up. The Differential Pair is defined along +X.
        const quarters = diff ? o.orient : (o.orient + 3) % 4;
        const turn = ([a, b]: Pt): Vec2 => { let x = mil(a * k), y = mil(b * k); for (let i = 0; i < quarters; i++) [x, y] = [-y, x]; return { x: o.at.x + x, y: o.at.y + y }; };
        const outline: Pt[] = diff ? DIFF_PAIR.flat()
          : [...ps.stem, [ps.circle.c[0] - ps.circle.r, ps.circle.c[1] - ps.circle.r], [ps.circle.c[0] + ps.circle.r, ps.circle.c[1] + ps.circle.r]];
        const bb = boxOfPoints(outline.map(turn), mil(10));
        add(bb, (p) => p.x >= bb.minX && p.x <= bb.maxX && p.y >= bb.minY && p.y <= bb.maxY, (s, g, c) => {
          const col = C(o.color, c);
          if (diff) { for (const l of DIFF_PAIR) s.polyline(g, l.map(turn), 0, col, false, 1); return; } // (Tiny scales it too)
          const w = mil(10);
          s.polyline(g, ps.stem.map(turn), w, col);
          const cc = turn(ps.circle.c);
          s.arc(g, cc, mil(ps.circle.r * k), 0, 360, w, col);
          // The "i" stays upright whichever way the stem goes (as AD17's dialog shows it), drawn firm enough to read
          const up = ([a, b]: Pt): Vec2 => ({ x: cc.x + mil((a - ps.circle.c[0]) * k), y: cc.y + mil((b - ps.circle.c[1]) * k) });
          s.circle(g, up(ps.info.dot), mil(ps.info.dotR * 1.6 * k), col);
          s.polyline(g, ps.info.bar.map(up), mil(9 * k), col);
          s.polyline(g, ps.info.foot.map(up), mil(7 * k), col);
          if (c === undefined && o.name) {
            const f = font(1);
            // The name level, beyond the circle on the side away from the stem
            const gap = mil((ps.labelAt[1] - ps.circle.c[1]) * k), r = mil(ps.circle.r * k), side = mil(12);
            const away = DIR[(quarters + 1) % 4]!; // the stem's direction turned round: up when standing
            const at = { x: cc.x + away.x * (away.x ? r + side : 0), y: cc.y + away.y * (away.y ? gap : 0) };
            const h: 0 | 1 | 2 = away.x > 0 ? 0 : away.x < 0 ? 2 : 1, v: 0 | 1 | 2 = away.y > 0 ? 0 : away.y < 0 ? 2 : 1;
            s.text(g, at, { text: o.name, size: f.size, family: f.family, bold: f.bold, italic: f.italic, rot: 0, color: T(o.color), h, v, anchor: 'cell' });
          }
        });
        break;
      }
      case 'piechart': {
        const sweep = ((o.end - o.start) % 360 + 360) % 360 || 360;
        const arc = arcPoints(o.c, o.r, o.r, o.start, o.start + sweep, 48);
        const pts = sweep >= 360 ? arc : [o.c, ...arc];
        add(boxOfPoints(pts, o.width), (p) => pointInPoly(p, pts), (s, g, c) => {
          if (o.solid) s.polygon(g, pts, triangulate(pts), F(o.fill, c));
          s.polyline(g, pts, o.width, C(o.color, c), true);
        });
        break;
      }
      case 'compilemask': {
        // Translucent over what it covers; the triangle at the top-left corner folds it away
        const bb = boxOfPoints([o.a, o.b]);
        const t = mil(60), tri = [{ x: bb.minX, y: bb.maxY }, { x: bb.minX + t, y: bb.maxY }, { x: bb.minX, y: bb.maxY - t }];
        const edge = [{ x: bb.minX, y: bb.minY }, { x: bb.maxX, y: bb.minY }, { x: bb.maxX, y: bb.maxY }, { x: bb.minX, y: bb.maxY }];
        add(o.collapsed ? boxOfPoints(tri) : bb, (p, tol) => pointInPoly(p, tri) || (!o.collapsed && segsTest([...edge, edge[0]!], 0)(p, tol)), (s, g, c) => {
          if (!o.collapsed) {
            if (c === undefined) s.rectFromCorners(s.group('masks', 1), o.a, o.b, rgba(o.fill, 0.6));
            s.polyline(g, edge, 0, C(o.color, c), true, 1);
          }
          s.polygon(g, tri, [0, 1, 2], C(o.color, c));
        });
        break;
      }
      case 'blanket': {
        const pts = o.pts;
        add(boxOfPoints(pts, mil(10)), (p, tol) => segsTest([...pts, pts[0]!], mil(10))(p, tol), (s, g, c) => {
          if (o.solid && !o.collapsed) s.darken(g, () => s.polygon(g, pts, triangulate(pts), F(o.fill, c)));
          const col = C(o.color, c);
          if (o.dashed) for (const [a, b] of dashes([...pts, pts[0]!], mil(40), mil(25))) s.segment(g, a, b, mil(10), col);
          else s.polyline(g, pts, mil(10), col, true);
        });
        break;
      }
      case 'harness': {
        // Body from LOCATION (top-left) down; a pointed nub on the harness side at the primary connection
        const a = o.at, b = { x: o.at.x + o.w, y: o.at.y - o.h };
        const right = o.side === 1, ex = right ? b.x : a.x, out = right ? 1 : -1, py = a.y - o.primary;
        const nub = [{ x: ex, y: py + mil(50) }, { x: ex + out * mil(50), y: py }, { x: ex, y: py - mil(50) }];
        add(boxOfPoints([a, b, ...nub]), () => true, (s, g, c) => {
          s.rectFromCorners(g, a, b, F(o.fill, c));
          s.polyline(g, [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], Math.max(o.width, mil(4)), C(o.color, c), true);
          s.polygon(g, nub, [0, 1, 2], C(o.color, c));
        });
        break;
      }
      case 'harnessentry': {
        const h = objs[o.owner];
        if (h?.kind !== 'harness') break;
        const left = h.at.x, top = h.at.y, right = h.at.x + h.w;
        const onRight = o.side === 1, ex = onRight ? right : left, inward = onRight ? -1 : 1, y = top - o.distance;
        add({ minX: ex - mil(50), minY: y - mil(50), maxX: ex + mil(50), maxY: y + mil(50) }, () => true, (s, g, c) => {
          const col = C(o.color, c);
          s.segment(g, { x: ex, y: y + mil(25) }, { x: ex + inward * mil(40), y }, mil(6), col);
          s.segment(g, { x: ex, y: y - mil(25) }, { x: ex + inward * mil(40), y }, mil(6), col);
          if (c === undefined && o.name) {
            const f = font(o.font || this.doc.sheet.systemFont);
            s.text(g, { x: ex + inward * mil(60), y }, { text: shown(o.name), overline, size: f.size, family: f.family, rot: 0, color: T(o.textColor), h: onRight ? 2 : 0, v: 1, anchor });
          }
        });
        break;
      }
      case 'signalharness':
        add(boxOfPoints(o.pts, o.width), segsTest(o.pts, o.width), (s, g, c) => {
          s.polyline(g, o.pts, o.width, C(o.color, c));
          if (c === undefined) s.polyline(g, o.pts, o.width / 3, rgba(0xffffff, 0.8));
        });
        break;
      case 'component': case 'meta': break;
    }
  }

  /* ── properties ── */
  properties(): PropSection[] {
    const out: PropSection[] = [];
    for (const key of [...this.selection].slice(0, 20)) {
      const o = this.doc.objects[parseInt(key.slice(1), 10)];
      if (!o) continue;
      const bag = bagOf(this.doc, o);
      const rows: PropSection['rows'] = [];
      const fmt = (c: Coord) => formatCoord(c, 'mil');
      if (o.kind === 'component') {
        rows.push({ label: 'Designator', value: o.designator }, { label: 'Library ref', value: o.libRef },
          { label: 'Location', value: `${fmt(o.at.x)}, ${fmt(o.at.y)}` }, { label: 'Part', value: `${o.partId} of ${Math.max(1, o.partCount - 1)}` });
      } else if (o.kind === 'wire' || o.kind === 'bus' || o.kind === 'polyline') {
        rows.push({ label: 'Vertices', value: String(o.pts.length) });
        o.pts.forEach((p, i) => rows.push({ label: `Vertex ${i + 1}`, value: `${fmt(p.x)}, ${fmt(p.y)}` }));
      } else if (o.kind === 'textframe') {
        const set = (label: string, props: Record<string, string | null>) => this.undo.transact(label, (tx) => tx.add(setProps(this.doc, o.index, props)));
        rows.push(
          { label: 'Text', value: o.text, kind: 'multiline', edit: (v) => set('Edit text frame', { TEXT: v.replace(/\r\n?/g, '\n').replace(/\n/g, '~1') }) },
          { label: 'Word Wrap', value: String(o.wrap), kind: 'bool', edit: (v) => set('Word wrap', { WORDWRAP: v === 'true' ? 'T' : null }) },
          { label: 'Clip to Area', value: String(o.clip), kind: 'bool', edit: (v) => set('Clip to area', { CLIPTORECT: v === 'true' ? 'T' : null }) },
          { label: 'Alignment', value: String(o.align), kind: 'enum', options: [['1', 'Left'], ['2', 'Centre'], ['3', 'Right']], edit: (v) => set('Text alignment', { ALIGNMENT: v }) },
          { label: 'Show Border', value: String(o.border), kind: 'bool', edit: (v) => set('Show border', { SHOWBORDER: v === 'true' ? 'T' : null }) },
          { label: 'Fill Background', value: String(o.solid), kind: 'bool', edit: (v) => set('Fill background', { ISSOLID: v === 'true' ? 'T' : null }) },
        );
      } else if (o.kind === 'pin') {
        const set = (label: string, props: Record<string, string | null>) => this.undo.transact(label, (tx) => tx.add(setProps(this.doc, o.index, props)));
        const pc = bag?.int('PINCONGLOMERATE') ?? 0;
        const bit = (m: number, on: boolean) => String(on ? pc | m : pc & ~m);
        const ro = !this.libraryMode;
        rows.push(
          { label: 'Designator', value: o.designator, edit: ro ? undefined : (v) => set('Pin designator', { DESIGNATOR: v }) },
          { label: 'Name', value: o.name, edit: ro ? undefined : (v) => set('Pin name', { NAME: v }) },
          { label: 'Electrical Type', value: String(o.electrical), kind: ro ? undefined : 'enum', options: ELECTRICAL.map((e, i) => [String(i), e] as [string, string]),
            edit: ro ? undefined : (v) => set('Pin electrical type', { ELECTRICAL: v }) },
          { label: 'Length', value: fmt(o.length), edit: ro ? undefined : (v) => { const n = parseFloat(v); if (n > 0) set('Pin length', { PINLENGTH: String(Math.round(n / 10)) }); } },
          { label: 'Show Name', value: String(o.showName), kind: ro ? undefined : 'bool', edit: ro ? undefined : (v) => set('Show pin name', { PINCONGLOMERATE: bit(0x08, v === 'true') }) },
          { label: 'Show Designator', value: String(o.showDesignator), kind: ro ? undefined : 'bool', edit: ro ? undefined : (v) => set('Show pin designator', { PINCONGLOMERATE: bit(0x10, v === 'true') }) },
          { label: 'Location', value: `${fmt(o.at.x)}, ${fmt(o.at.y)}` },
        );
      } else if (o.kind === 'text' || o.kind === 'power') {
        rows.push({ label: 'Text', value: o.text, edit: (v) => this.undo.transact('Edit text', (tx) => tx.add(setProps(this.doc, o.index, { TEXT: v }))) });
      } else if ('at' in o) {
        rows.push({ label: 'Location', value: `${fmt(o.at.x)}, ${fmt(o.at.y)}` });
      }
      const t = SR_NAME[o.record] ?? `record ${o.record}`;
      out.push({ title: t[0]!.toUpperCase() + t.slice(1), rows, raw: bag?.toObject() });
    }
    return out;
  }

  documentProperties(): PropSection[] {
    const d = this.doc, sh = d.sheet;
    const f = (c: Coord) => formatCoord(c, 'mil');
    const count = (k: SchObject['kind']) => d.objects.filter((o) => o.kind === k).length;
    const sys = sh.fonts[sh.systemFont - 1] ?? sh.fonts[0];
    return [
      { title: 'Document options', rows: [
        { label: 'Sheet size', value: `${f(sh.width)} × ${f(sh.height)}` },
        { label: 'Snap grid', value: f(sh.snapGrid) },
        { label: 'Visible grid', value: f(sh.visibleGrid) },
        { label: 'System font', value: sys ? `${sys.name}, ${sys.size}` : '—' },
        { label: 'Fonts', value: String(sh.fonts.length) },
        { label: 'Border', value: sh.border ? 'on' : 'off' },
      ] },
      { title: 'Contents', rows: [
        { label: 'Components', value: String(count('component')) },
        { label: 'Wires', value: String(count('wire')) },
        { label: 'Buses', value: String(count('bus')) },
        { label: 'Net labels', value: String(d.objects.filter((o) => o.kind === 'text' && o.role === 'netlabel').length) },
        { label: 'Power ports', value: String(count('power')) },
        { label: 'Ports', value: String(count('port')) },
        { label: 'Records', value: String(d.records.length - 1) },
      ] },
    ];
  }

  deleteSelection(): void {
    // A component's designator and parameters go only with the component
    const idx = this.unlocked(this.selectedIndices().filter((i) => { const o = this.doc.objects[i]!; const ow = o.owner >= 0 ? this.doc.objects[o.owner] : undefined; return !(ow?.kind === 'component' && o.kind === 'text'); }));
    if (!idx.length) return;
    // Junctions left with fewer than three connections go with the wire, unless LOCKED (manual)
    const orphans = orphanJunctions(this.doc, new Set(idx));
    const all = [...idx, ...orphans];
    const label = `Delete ${idx.length} object${idx.length > 1 ? 's' : ''}${orphans.length ? ` and ${orphans.length} junction${orphans.length > 1 ? 's' : ''}` : ''}`;
    this.undo.transact(label, (tx) => tx.add(removeObjects(this.doc, all)));
    this.selection.clear();
  }
}

/**
 * Line Style's dashes, on and off in turn [est: AD's look, scaled up from the smallest line]:
 * Dashed, Dotted (dots), Dash Dotted.
 */
export function linePattern(style: number, width: Coord): number[] {
  const u = Math.max(width, mil(10));
  return style === 1 ? [3 * u, 2 * u] : style === 2 ? [0.5 * u, 1.5 * u] : style === 3 ? [3 * u, 1.5 * u, 0.5 * u, 1.5 * u] : [];
}
/** A polyline cut into a pattern's dashes (on, off, on, off …), carried on round the corners. */
export function dashPattern(pts: Vec2[], pattern: number[]): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  if (!pattern.length || pattern.some((x) => x <= 0)) return pts.length > 1 ? pts.slice(1).map((b, i) => [pts[i]!, b]) : [];
  let k = 0, carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!, len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) continue;
    const at = (t: number): Vec2 => ({ x: a.x + ((b.x - a.x) * t) / len, y: a.y + ((b.y - a.y) * t) / len });
    let t = 0;
    while (t < len - 1e-6) {
      const step = Math.min(pattern[k]! - carry, len - t);
      if (k % 2 === 0) out.push([at(t), at(t + step)]);
      t += step; carry += step;
      if (carry >= pattern[k]! - 1e-6) { carry = 0; k = (k + 1) % pattern.length; }
    }
  }
  return out;
}

/** A dashed polyline's dashes. */
function dashes(pts: Vec2[], on: number, off: number): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  let carry = 0, drawing = true;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!, len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) continue;
    const at = (t: number): Vec2 => ({ x: a.x + ((b.x - a.x) * t) / len, y: a.y + ((b.y - a.y) * t) / len });
    let t = 0;
    while (t < len) {
      const step = Math.min((drawing ? on : off) - carry, len - t);
      if (drawing) out.push([at(t), at(t + step)]);
      t += step; carry += step;
      if (carry >= (drawing ? on : off) - 1e-6) { carry = 0; drawing = !drawing; }
    }
  }
  return out;
}

function bezier(pts: Vec2[]): Vec2[] {
  if (pts.length < 4) return pts;
  const out: Vec2[] = [pts[0]!];
  for (let i = 0; i + 3 < pts.length; i += 3) {
    const [p0, p1, p2, p3] = [pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!];
    for (let k = 1; k <= 16; k++) {
      const t = k / 16, u = 1 - t;
      out.push({ x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
        y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y });
    }
  }
  return out;
}
