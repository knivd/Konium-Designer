/**
 * Place menu commands, schematic and PCB: the object follows the cursor (or is drawn by its
 * points), Space turns it, Tab edits it before it goes down, and names step on as Altium's
 * auto-increment does. Each command remembers what was placed last for the next time.
 */
import type { Command, Scope } from '../core/commands';
import type { Vec2 } from '../core/geom';
import { mil } from '../core/units';
import { PropertyBag } from '../formats/altium/props';
import { SchEditor } from '../editors/sch/SchEditor';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { SchPasteTool } from '../editors/sch/SchPasteTool';
import { SchShapeTool, type ShapeSpec } from '../editors/sch/SchShapeTool';
import {
  placeArcAnyTool, placeArcCentreTool, placeArcEdgeTool, placeCircleTool, placeFillTool, placeRegionTool, placeStringTool, placeViaTool,
} from '../editors/pcb/PcbPlaceTools';
import {
  arcBag, bezierBag, blanketBag, busEntryBag, compileMaskBag, directiveItems, ellipseBag, junctionBagAt, labelBag, netClassItems, netLabelBag, nextName, noErcBag,
  imageBag, noteBag, offSheetBag, pieBag, polygonBag, polylineBag, portBag, powerBag, rectBag, textFrameBag,
} from '../model/schPlace';
import { SpecificNoErcDialog } from './dialogs/ProjectOptions';
import { pickFile } from '../platform/fs';
import { imageAspect, linkImage } from '../editors/sch/schImages';
import { active } from './state';
import { settings } from '../core/settings';
import { showDialog } from './dialogs';
import { PlacePartDialog, type PartChoice } from './dialogs/PlacePart';
import { SR } from '../model/sch';
import { PlaceComponentDialog } from './dialogs/PlaceComponent';
import { PcbPasteTool } from '../editors/pcb/PcbPasteTool';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { PlaceWireLinkTool } from '../editors/pcb/PlaceWireLinkTool';
import { footprintComponent, type FoundFootprint } from '../model/pcbEco';
import { projectFootprints } from './eco';
import { activeProject } from './project';
import type { PcbClip } from '../editors/clipboard';
import { autoNext } from './increment';
import { capture, defaultHides, defaultItems, kindOfBag, lay, onSchDefaults, setSchDefault, storedDefault, withDefault, type SchDefault } from '../model/schDefaults';
import { setSchCoord, type SchDocument } from '../model/sch';
import { uniqueId } from '../model/schEdit';
import { SCH_UNIT } from '../core/units';
const paramSetStyle = () => (settings.schParamSetStyle === 'tiny' ? 1 : 0); // STYLE: absent Large, 1 Tiny

const sch = () => (active.value?.editor instanceof SchEditor ? active.value.editor : null);
const pcb = () => (active.value?.editor instanceof PcbEditor ? active.value.editor : null);
const SCH: Scope[] = ['sch'];
const PCB: Scope[] = ['pcb'];

/* ─── Schematic: one object at the cursor ────────────────────────────────────────────── */

/**
 * What each command placed last this session (its text, style, orientation …), at the origin: the
 * next one starts from it. A session's first starts from Preferences › Schematic › Default
 * Primitives; Tab's changes go there too, unless Permanent is on, when they last only while placing.
 */
const last = new Map<string, PropertyBag>();
function rememberLast(id: string, b: PropertyBag): void {
  if (settings.schDefaultsPermanent) return;
  last.set(id, b.clone());
}
/** Tab changed the object being placed: its kind's default from now on (unless Permanent). */
function keepDefault(doc: SchDocument, b: PropertyBag): void {
  const k = kindOfBag(b);
  if (k && !settings.schDefaultsPermanent) setSchDefault(k.name, capture(doc, k, [b]), true);
}
/** Forget what the commands placed last (Preferences › Schematic › Default Primitives › Reset All). */
export function resetPlaceDefaults(): void { last.clear(); portTemplate = null; }
// Edit Values or Reset on the page: the commands of that kind start from the default again
onSchDefaults((name) => {
  for (const [id, b] of [...last]) if (!name || kindOfBag(b)?.name === name) last.delete(id);
  if (!name || name === 'Port') portTemplate = null;
});

/**
 * `own`: the properties the command itself decides (a GND port's style and net), which the
 * default leaves alone, and which Tab does not make the default.
 */
function stamp(id: string, what: string, make: () => PropertyBag, increment?: (b: PropertyBag) => PropertyBag, own?: readonly string[]): void {
  const e = sch();
  if (!e) return;
  const bag = last.get(id)?.clone() ?? withDefault(e.doc, make(), own);
  e.setTool(new SchPasteTool(e, { kind: 'sch', ref: { x: 0, y: 0 }, items: [{ bag, owner: -1 }] }, true, {
    id, what, next: increment, remember: (b) => rememberLast(id, b), edited: own ? undefined : (b) => keepDefault(e.doc, b),
  }));
}
const stepText = (key: 'TEXT' | 'NAME') => (b: PropertyBag) => { const n = b.clone(); n.set(key, autoNext(b.get(key) ?? '')); return n; };

/** text: the net name, or a Preferences › Schematic › General default power object name. */
function power(id: string, label: string, style: number, text: string | (() => string)): Command {
  // Place › Power Port places the default as it is; GND, VCC and the rest keep their own style, net and direction
  const own = id === 'place.power' ? undefined : ['STYLE', 'TEXT', 'ORIENTATION'];
  return { id, label, scopes: SCH, run: () => stamp(id, 'power port', () => powerBag(style, typeof text === 'function' ? text() : text), undefined, own), enabled: () => !!sch() };
}
const groundName = () => settings.schPowerGroundName || 'GND';

/* ─── Schematic: objects drawn by their points ───────────────────────────────────────── */

/** A directive's set as its default has it (the name and the style in use stay the command's). */
const setDefault = (doc: SchDocument, items: { bag: PropertyBag; owner: number }[]) => items.map((it, i) => (i ? it : { ...it, bag: withDefault(doc, it.bag, ['NAME', 'STYLE']) }));

/**
 * A shape drawn by its points starts from its kind's default (Preferences › Schematic › Default
 * Primitives), and Tab opens its properties while it is drawn: OK and this one and those after
 * it take them, and they are the default from now on unless Permanent is on. A command with a
 * template of its own (a port, a sheet symbol) is left as it is.
 */
export function defaulted(e: SchEditor, spec: ShapeSpec): ShapeSpec {
  if (spec.edit) return spec;
  let mine: SchDefault | undefined;   // Tab's change, for this placing
  const style = (bags: PropertyBag[]) => bags.map((b, i) => (i ? b : mine ? lay(e.doc, b, mine) : withDefault(e.doc, b)));
  // The kind it places: what it builds from a few points
  const probe = spec.build([{ x: 0, y: 0 }, { x: mil(300), y: 0 }, { x: mil(300), y: -mil(200) }, { x: mil(100), y: -mil(100) }, { x: 0, y: -mil(200) }], 0)[0];
  const kind = probe ? kindOfBag(probe) : undefined;
  return {
    ...spec,
    build: (pts, base) => style(spec.build(pts, base)),
    ghost: spec.ghost ? (p, base) => style(spec.ghost!(p, base)) : undefined,
    edit: kind ? () => e.placeProps?.(defaultItems(e.doc, kind, mine ?? storedDefault(kind.name))[0]!.bag, (b) => {
      mine = capture(e.doc, kind, [b]);
      if (!settings.schDefaultsPermanent) setSchDefault(kind.name, mine, true);
      e.invalidate();
    }, defaultHides(kind)) : undefined,
  };
}

function draw(spec: Omit<ShapeSpec, 'id'> & { id: string }): void {
  const e = sch();
  if (e) e.setTool(new SchShapeTool(e, defaulted(e, spec)));
}
const r = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const deg = (p: Vec2, c: Vec2) => ((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 360) % 360;

/** Port: click its start, then its other end (width); Port1, Port2 … */
let portTemplate: PropertyBag | null = null;
function placePort(): void {
  const e = sch();
  if (!e) return;
  const t = () => (portTemplate ??= withDefault(e.doc, portBag('Port1', { x: 0, y: 0 }, mil(500))));
  // The port as its template has it (colours, font, border, style …), where it is clicked and as wide as dragged
  const at = (b: PropertyBag, p: Vec2, width: number) => {
    const n = b.clone();
    for (const k of ['OWNERINDEX', 'INDEXINSHEET']) n.delete(k);
    setSchCoord(n, 'LOCATION.X', p.x); setSchCoord(n, 'LOCATION.Y', p.y);
    n.set('WIDTH', String(Math.max(1, Math.round(width / SCH_UNIT))));
    n.setRaw('UNIQUEID', uniqueId());
    return n;
  };
  // Preferences › Schematic › Orcad › Orcad Ports › Mode: a port as wide as its name, placed with one click [est: the width per character]
  const orcad = settings.orcadPorts;
  const fitted = (b: PropertyBag) => Math.max(mil(300), Math.ceil(((b.get('NAME') ?? '').length * 60 + 200) / 100) * mil(100));
  draw({
    id: 'place.port', what: 'port', clicks: orcad ? 1 : 2,
    prompt: (n) => (orcad ? 'click where the port goes (Tab for properties)' : n ? 'click the other end of the port' : 'click the start of the port (Tab for properties)'),
    ghost: (p) => [at(t(), p, orcad ? fitted(t()) : t().int('WIDTH', 50) * 100_000)],
    build: (pts) => {
      const a = pts[0]!, b = pts[1] ?? a;
      if (orcad) return [at(t(), a, fitted(t()))];
      const w = Math.abs(b.x - a.x);
      return [at(t(), { x: Math.min(a.x, b.x), y: a.y }, w || t().int('WIDTH', 50) * 100_000)];
    },
    placed: () => { const b = t().clone(); b.set('NAME', autoNext(b.get('NAME') ?? 'Port1')); portTemplate = b; },
    edit: () => e.placeProps?.(t(), (b) => { portTemplate = b; keepDefault(e.doc, b); }),
  });
}

/** Place › Part: the chosen symbol follows the cursor; multi-part packages step A, B …, then the next designator. */
export function placePart(c: PartChoice): void {
  const e = sch();
  if (!e) return;
  const parts = c.symbol.parts;
  e.setTool(new SchPasteTool(e, { kind: 'sch', ref: { x: 0, y: 0 }, items: c.items }, true, {
    id: 'place.part', what: `part ${c.symbol.libRef}`,
    nextItems: (items) => items.map((it, i) => {
      const b = it.bag.clone();
      const comp = items[0]!.bag, part = comp.int('CURRENTPARTID', 1), wrap = part >= parts;
      if (i === 0) b.set('CURRENTPARTID', String(wrap ? 1 : part + 1));
      else if (b.int('RECORD') === SR.DESIGNATOR && wrap) { const d = b.get('TEXT') ?? ''; if (!d.endsWith('?')) b.set('TEXT', autoNext(d)); }
      return { ...it, bag: b };
    }),
  }));
}

/** Place › Component (P, C): the footprint follows the cursor; the designator steps on after each one. */
export function placeComponent(f: FoundFootprint, designator: string, comment: string): void {
  const e = pcb();
  if (!e) return;
  let d = designator;
  const clip = (): PcbClip => ({ kind: 'pcb', ref: { x: 0, y: 0 }, records: [], components: [footprintComponent(f, d, comment)], polygons: [], nets: new Map() });
  e.setTool(new PcbPasteTool(e, clip(), true, { id: 'place.component', what: `component ${f.footprint.name}`, next: () => { d = nextName(d); return clip(); } }));
}

export function placeCommands(): Command[] {
  return [
    // Schematic
    { id: 'place.part', label: 'Part...', scopes: SCH, run: () => { if (sch()) showDialog(PlacePartDialog, { onPlace: placePart }); }, enabled: () => !!sch() },
    { id: 'place.netLabel', label: 'Net Label', scopes: SCH, run: () => stamp('place.netLabel', 'net label', () => netLabelBag('NetLabel1'), stepText('TEXT')), enabled: () => !!sch() },
    power('place.power', 'Power Port', 2, 'VCC'),
    power('place.gnd', 'GND Power Port', 4, groundName),
    power('place.vcc', 'VCC Power Port', 2, 'VCC'),
    power('ad:Sch:PlacePowerPort_GNDBusPowerPort', 'GND Bus Power Port', 4, groundName),
    power('ad:Sch:PlacePowerPort_VCCBusPowerPort', 'VCC Bus Power Port', 2, 'VCC'),
    power('ad:Sch:PlacePowerPort_+12PowerPort', '+12 Power Port', 2, '+12'),
    power('ad:Sch:PlacePowerPort_+5PowerPort', '+5 Power Port', 2, '+5'),
    power('ad:Sch:PlacePowerPort_-5PowerPort', '-5 Power Port', 2, '-5'),
    power('ad:Sch:PlacePowerPort_ArrowStylePowerPort', 'Arrow Style Power Port', 1, 'VCC'),
    power('ad:Sch:PlacePowerPort_WaveStylePowerPort', 'Wave Style Power Port', 3, 'VCC'),
    power('ad:Sch:PlacePowerPort_BarStylePowerPort', 'Bar Style Power Port', 2, 'VCC'),
    power('ad:Sch:PlacePowerPort_CircleStylePowerPort', 'Circle Style Power Port', 0, 'VCC'),
    power('ad:Sch:PlacePowerPort_SignalGroundPowerPort', 'Signal Ground Power Port', 5, () => settings.schSignalGroundName || 'SGND'),
    power('ad:Sch:PlacePowerPort_EarthPowerPort', 'Earth Power Port', 6, () => settings.schEarthName || 'EARTH'),
    { id: 'place.port', label: 'Port', scopes: SCH, run: placePort, enabled: () => !!sch() },
    { id: 'ad:Sch:PlaceOffsheetConnector', label: 'Off Sheet Connector', scopes: SCH, run: () => stamp('ad:Sch:PlaceOffsheetConnector', 'off sheet connector', () => offSheetBag('OffSheet')), enabled: () => !!sch() },
    { id: 'place.junction', label: 'Manual Junction', scopes: SCH, run: () => stamp('place.junction', 'junction', () => junctionBagAt()), enabled: () => !!sch() },
    { id: 'place.noErc', label: 'Generic No ERC', scopes: SCH, run: () => stamp('place.noErc', 'No ERC', () => noErcBag()), enabled: () => !!sch() },
    // Place › Directives › Differential Pair / Parameter Set / PCB Layout
    ...([['ad:Sch:PlaceDifferentialPair', 'Differential Pair', 'diffpair'], ['ad:Sch:PlaceParameterSet', 'Parameter Set', 'parameterset'], ['ad:Sch:PlacePCBLayoutDirective', 'PCB Layout', 'pcblayout']] as const).map(([id, label, kind]): Command => ({
      id, label, scopes: SCH, enabled: () => !!sch(), run: () => {
        const e = sch();
        if (e) e.setTool(new SchPasteTool(e, { kind: 'sch', ref: { x: 0, y: 0 }, items: setDefault(e.doc, directiveItems(kind, undefined, paramSetStyle())) }, true, { id, what: label.toLowerCase() }));
      },
    })),
    { id: 'ad:Sch:PlaceNetClass', label: 'Net Class', scopes: SCH, enabled: () => !!sch(), run: () => {
      const e = sch();
      if (e) e.setTool(new SchPasteTool(e, { kind: 'sch', ref: { x: 0, y: 0 }, items: setDefault(e.doc, netClassItems(undefined, undefined, paramSetStyle())) }, true, { id: 'ad:Sch:PlaceNetClass', what: 'net class' }));
    } },
    { id: 'ad:Sch:PlaceNoERCTargeting', label: 'Specific No ERC...', scopes: SCH, enabled: () => !!sch(), run: () => {
      if (sch()) showDialog(SpecificNoErcDialog, { onOk: (kinds: string[]) => stamp('ad:Sch:PlaceNoERCTargeting', 'specific No ERC', () => noErcBag(undefined, kinds), undefined, ['SUPPRESSALL', 'ERRORKINDSETTOSUPPRESS']) });
    } },
    { id: 'ad:Sch:PlaceCompileMask', label: 'Compile Mask', scopes: SCH, run: () => draw({
      id: 'ad:Sch:PlaceCompileMask', what: 'compile mask', clicks: 2,
      prompt: (n) => (n ? 'click the opposite corner' : 'click the first corner'),
      build: (pts) => [compileMaskBag(pts[0]!, pts.at(-1)!)],
    }), enabled: () => !!sch() },
    { id: 'ad:Sch:PlaceBlanket', label: 'Blanket', scopes: SCH, run: () => draw({
      id: 'ad:Sch:PlaceBlanket', what: 'blanket', clicks: 0, min: 3,
      build: (pts) => (pts.length >= 2 ? [blanketBag(pts)] : []),
    }), enabled: () => !!sch() },
    { id: 'ad:Sch:PlaceNote', label: 'Note', scopes: SCH, run: () => draw({
      id: 'ad:Sch:PlaceNote', what: 'note', clicks: 2,
      prompt: (n) => (n ? 'click the opposite corner' : 'click the first corner'),
      build: (pts) => [noteBag(pts[0]!, pts.at(-1)!)],
    }), enabled: () => !!sch() },
    { id: 'ad:Sch:PlaceGraphicImage', label: 'Graphic...', scopes: SCH, enabled: () => !!sch(), run: async () => {
      const e = sch();
      if (!e) return;
      const f = await pickFile('image/*,.png,.jpg,.jpeg,.bmp,.gif,.svg');
      if (!f) return;
      linkImage(f.name, f.bytes, () => e.invalidate());
      draw({
        id: 'ad:Sch:PlaceGraphicImage', what: `graphic ${f.name}`, clicks: 2,
        prompt: (n) => (n ? 'click the opposite corner' : 'click the first corner'),
        build: (pts) => {
          const a = pts[0]!, c = pts.at(-1)!, k = imageAspect(f.name);
          // Keep Aspect: the picture's own proportions, as wide as dragged
          const w = c.x - a.x, h = k ? Math.sign(c.y - a.y || 1) * Math.abs(w) / k : c.y - a.y;
          return [imageBag(a, { x: c.x, y: a.y + h }, f.name)];
        },
      });
    } },
    { id: 'ad:Sch:PlacePieChart', label: 'Pie Chart', scopes: SCH, run: () => draw({
      id: 'ad:Sch:PlacePieChart', what: 'pie chart', clicks: 4,
      prompt: (n) => ['click the centre', 'click to set the radius', 'click the start angle', 'click the end angle'][n]!,
      build: (pts) => {
        const c = pts[0]!, rr = pts[1] ? r(pts[1], c) : 0;
        if (!rr) return [];
        if (pts.length <= 2) return [pieBag(c, rr)];
        const s = deg(pts[2]!, c);
        return [pieBag(c, rr, s, pts[3] ? deg(pts[3], c) : s + 90)];
      },
    }), enabled: () => !!sch() },
    { id: 'ad:Sch:PlaceBusEntry', label: 'Bus Entry', scopes: SCH, run: () => stamp('ad:Sch:PlaceBusEntry', 'bus entry', () => busEntryBag()), enabled: () => !!sch() },
    { id: 'ad:Sch:PlaceBusEntryWithContext', label: 'Bus Entry', scopes: SCH, run: () => stamp('ad:Sch:PlaceBusEntry', 'bus entry', () => busEntryBag()), enabled: () => !!sch() },
    { id: 'place.text', label: 'Text String', scopes: ['sch', 'pcb'], run: () => {
      const p = pcb();
      if (p) { p.setTool(placeStringTool(p)); return; }
      stamp('place.text', 'text string', () => labelBag('Text'), stepText('TEXT'));
    }, enabled: () => !!sch() || !!pcb() },
    { id: 'place.textFrame', label: 'Text Frame', scopes: SCH, run: () => draw({
      id: 'place.textFrame', what: 'text frame', clicks: 2,
      prompt: (n) => (n ? 'click the opposite corner' : 'click the first corner'),
      build: (pts) => [textFrameBag(pts[0]!, pts.at(-1)!)],
    }), enabled: () => !!sch() },
    { id: 'ad:Sch:PlaceLine', label: 'Line', scopes: SCH, run: () => draw({
      id: 'ad:Sch:PlaceLine', what: 'line', clicks: 0, min: 2, corners: true,
      build: (pts) => (pts.length >= 2 ? [polylineBag(pts)] : []),
    }), enabled: () => !!sch() },
    { id: 'ad:Sch:PlacePolygon', label: 'Polygon', scopes: SCH, run: () => draw({
      id: 'ad:Sch:PlacePolygon', what: 'polygon', clicks: 0, min: 3,
      build: (pts) => (pts.length >= 2 ? [polygonBag(pts)] : []),
    }), enabled: () => !!sch() },
    { id: 'ad:Sch:PlaceRectangle', label: 'Rectangle', scopes: SCH, run: () => draw({
      id: 'ad:Sch:PlaceRectangle', what: 'rectangle', clicks: 2,
      prompt: (n) => (n ? 'click the opposite corner' : 'click the first corner'),
      build: (pts) => [rectBag(pts[0]!, pts.at(-1)!)],
    }), enabled: () => !!sch() },
    { id: 'ad:Sch:PlaceRoundRectangle', label: 'Round Rectangle', scopes: SCH, run: () => draw({
      id: 'ad:Sch:PlaceRoundRectangle', what: 'round rectangle', clicks: 2,
      prompt: (n) => (n ? 'click the opposite corner' : 'click the first corner'),
      build: (pts) => [rectBag(pts[0]!, pts.at(-1)!, true)],
    }), enabled: () => !!sch() },
    { id: 'ad:Sch:PlaceEllipse', label: 'Ellipse', scopes: SCH, run: () => draw({
      id: 'ad:Sch:PlaceEllipse', what: 'ellipse', clicks: 3,
      prompt: (n) => ['click the centre', 'click to set the X radius', 'click to set the Y radius'][n]!,
      build: (pts) => { const c = pts[0]!, rx = Math.abs((pts[1] ?? c).x - c.x) || r(pts[1] ?? c, c); const ry = pts[2] ? Math.abs(pts[2].y - c.y) : rx; return rx > 0 ? [ellipseBag(c, rx, ry || rx)] : []; },
    }), enabled: () => !!sch() },
    { id: 'ad:Sch:PlaceFullCircle', label: 'Full Circle', scopes: SCH, run: () => draw({
      id: 'ad:Sch:PlaceFullCircle', what: 'full circle', clicks: 2,
      prompt: (n) => (n ? 'click to set the radius' : 'click the centre'),
      build: (pts) => { const c = pts[0]!, rr = pts[1] ? r(pts[1], c) : 0; return rr > 0 ? [arcBag(c, rr)] : []; },
    }), enabled: () => !!sch() },
    { id: 'ad:Sch:PlaceArc', label: 'Arc', scopes: SCH, run: () => draw({
      id: 'ad:Sch:PlaceArc', what: 'arc', clicks: 4,
      prompt: (n) => ['click the centre', 'click to set the radius', 'click the start of the arc', 'click the end of the arc'][n]!,
      build: (pts) => {
        const c = pts[0]!, rr = pts[1] ? r(pts[1], c) : 0;
        if (!rr) return [];
        if (pts.length <= 2) return [arcBag(c, rr)];
        const s = deg(pts[2]!, c);
        return [arcBag(c, rr, s, pts[3] ? deg(pts[3], c) : s + 90)];
      },
    }), enabled: () => !!sch() },
    { id: 'ad:Sch:PlaceEllipticalArc', label: 'Elliptical Arc', scopes: SCH, run: () => draw({
      id: 'ad:Sch:PlaceEllipticalArc', what: 'elliptical arc', clicks: 5,
      prompt: (n) => ['click the centre', 'click to set the X radius', 'click to set the Y radius', 'click the start of the arc', 'click the end of the arc'][n]!,
      build: (pts) => {
        const c = pts[0]!, rx = pts[1] ? Math.abs(pts[1].x - c.x) || r(pts[1], c) : 0;
        if (!rx) return [];
        const ry = pts[2] ? Math.abs(pts[2].y - c.y) || rx : rx;
        if (pts.length <= 3) return [arcBag(c, rx, 0, 360, ry)];
        const s = deg(pts[3]!, c);
        return [arcBag(c, rx, s, pts[4] ? deg(pts[4], c) : s + 90, ry)];
      },
    }), enabled: () => !!sch() },
    { id: 'ad:Sch:PlaceBezier', label: 'Bezier', scopes: SCH, run: () => draw({
      id: 'ad:Sch:PlaceBezier', what: 'bezier', clicks: 4,
      prompt: (n) => ['click the start', 'click the first control point', 'click the second control point', 'click the end'][n]!,
      build: (pts) => (pts.length >= 2 ? [bezierBag(pts.length === 4 ? pts : pts.length === 2 ? [pts[0]!, pts[0]!, pts[1]!, pts[1]!] : [pts[0]!, pts[1]!, pts[2]!, pts[2]!])] : []),
    }), enabled: () => !!sch() },

    // PCB
    { id: 'place.component', label: 'Component...', scopes: PCB, run: () => {
      if (pcb()) showDialog(PlaceComponentDialog, { footprints: projectFootprints(activeProject()), onPlace: placeComponent });
    }, enabled: () => !!pcb() },
    { id: 'place.via', label: 'Via', scopes: PCB, run: () => { const e = pcb(); if (e) e.setTool(placeViaTool(e)); }, enabled: () => !!pcb() },
    { id: 'place.fill', label: 'Fill', scopes: PCB, run: () => { const e = pcb(); if (e) e.setTool(placeFillTool(e)); }, enabled: () => !!pcb() },
    { id: 'place.arc', label: 'Arc (Edge)', scopes: PCB, run: () => { const e = pcb(); if (e) e.setTool(placeArcEdgeTool(e)); }, enabled: () => !!pcb() },
    { id: 'ad:PCB:PlaceArcCenter', label: 'Arc (Centre)', scopes: PCB, run: () => { const e = pcb(); if (e) e.setTool(placeArcCentreTool(e)); }, enabled: () => !!pcb() },
    { id: 'ad:PCB:PlaceArcAnyAngle', label: 'Arc (Any Angle)', scopes: PCB, run: () => { const e = pcb(); if (e) e.setTool(placeArcAnyTool(e)); }, enabled: () => !!pcb() },
    { id: 'ad:PCB:PlaceFullCircle', label: 'Full Circle', scopes: PCB, run: () => { const e = pcb(); if (e) e.setTool(placeCircleTool(e)); }, enabled: () => !!pcb() },
    { id: 'ad:PCB:PlaceSolidRegion', label: 'Solid Region', scopes: PCB, run: () => { const e = pcb(); if (e) e.setTool(placeRegionTool(e)); }, enabled: () => !!pcb() },
    // Konium's: an insulated wire between two pieces of one net (a board's, not a footprint's)
    { id: 'place.wireLink', label: 'Wire Link', scopes: PCB, run: () => { const e = pcb(); if (e && !(e instanceof PcbLibEditor)) e.setTool(new PlaceWireLinkTool(e)); }, enabled: () => { const e = pcb(); return !!e && !(e instanceof PcbLibEditor); } },
  ];
}
