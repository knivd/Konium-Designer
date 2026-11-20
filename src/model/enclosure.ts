/**
 * The enclosure designer's box for a board, made to be 3D printed: what it is (its settings, as an
 * .Enclosure document keeps them) and where everything goes (its layout, worked out from the
 * settings and the board). The solids themselves are made in enclosureSolid.ts. Millimetres, the
 * board's centre at the origin, z up from the base's underside.
 *
 * The box is a base and a top: a flat lid on the walls (its lip inside them), or two shells that
 * meet at a joint part-way up (a lap joint in the walls' thickness). The top is held by its press
 * fit, by snap catches (bumps on the lip, grooves in the wall), or by screws (into bosses in the
 * box's corners, or down through the board's mounting holes). The board sits on standoffs at its
 * mounting holes (a pilot hole for a screw, a heat-set insert, a captive nut, or a locating pin),
 * or on ledges under its corners when it has none, and posts from the top can hold it down.
 */
import { shapesBox, svgShapes } from '../formats/svgShapes';

export type Side = 'S' | 'E' | 'N' | 'W';
export type Face = Side | 'top' | 'bottom';
export type Shape = 'rect' | 'rounded' | 'circle' | 'slot';
/** How a screw holds: a pilot hole it cuts its thread in, a heat-set insert, or a nut in a pocket. */
export type Into = 'pilot' | 'insert' | 'nut';
export type Fix = 'press' | 'snaps' | 'screws';
export type Material = 'PLA' | 'PETG' | 'ABS' | 'ASA';

/** An opening through a face. */
export interface Opening {
  name: string;
  face: Face;
  shape: Shape;
  /**
   * Its centre: on a wall, along it from the wall's middle (left to right seen from outside) and
   * its height above the board's top; on the top or the floor, the board's x and y seen from above.
   */
  x: number; y: number;
  /** Its width and height (on a wall: along it and up it); a circle's diameter is w. */
  w: number; h: number;
  on: boolean;
  /** Found for a part (its designator); kept with the part until changed by hand. */
  auto?: boolean;
  part?: string;
  /**
   * Open up to the joint, so the board goes in with a part reaching into the wall; the top fills
   * the slot above the opening.
   */
  open?: boolean;
  /**
   * A round opening in the top over its part: a tube down to the part (light from an LED stays
   * in it), or a button that presses the part (a switch) — a part of its own, held in by a
   * flange under the top.
   */
  extra?: 'tube' | 'button';
  /** A recess this deep from the face's outside rather than an opening through it (for a sticker, a display's bezel, a finger grip). */
  depth?: number;
  /** A round hole's countersink (90°) or counterbore from the outside, for a screw's head: its diameter, and a counterbore's depth. */
  sink?: { kind: 'cs' | 'cb'; d: number; depth: number };
}

/** What a protrusion is (its defaults and its name in the lists; its solid comes from its shape). */
export type AddKind = 'boss' | 'pin' | 'block' | 'rib';
/**
 * Something added to a face: standing out of it (outside), or into the box from its inside — a
 * boss for a screw, a pin, a block, a rib. Placed as an opening is (on a wall: along it from its
 * middle and above the board's top; on the top or the floor: the board's x and y).
 */
export interface Add {
  name: string; kind: AddKind; face: Face;
  side: 'out' | 'in';
  shape: Shape;
  x: number; y: number;
  /** Its width and height on the face (a circle's diameter is w). */
  w: number; h: number;
  /** How far it stands from the face. */
  height: number;
  /** A hole down its middle from its end to the face (diameter; 0: none), for a screw. */
  hole: number;
  on: boolean;
}

/** A patch of vents on a face: slots, round holes or a honeycomb of hexagons, inside a rectangle. */
export interface Vent {
  name: string; face: Face; pattern: 'slots' | 'holes' | 'honeycomb';
  /** The patch's centre and size (as an opening's). */
  x: number; y: number; w: number; h: number;
  /** A slot's width, a hole's diameter, a hexagon's width across its flats. */
  size: number;
  /** Slots across the patch (up a wall, or along y) rather than along it. */
  across?: boolean;
  on: boolean;
}

/** A drawing (SVG) for a face: its filled shapes in the order drawn (white ones take away what is under them), centred, 1 high (y up), and how wide that makes it. */
export interface Logo { name: string; aspect: number; shapes: { rings: [number, number][][]; evenOdd: boolean; knock?: boolean }[] }

/** Text on a face, in a single-line (stroke) font, or a logo: cut into it, standing out of it, or cut through it. */
export interface Label {
  text: string; face: Face;
  /** Its middle (as an opening's centre). */
  x: number; y: number;
  /** The capital letters' height (a logo's height). */
  size: number;
  depth: number;
  raised: boolean;
  /** Cut through the face (depth and raised aside). */
  through?: boolean;
  /** A logo in place of the text (the text names it). */
  logo?: Logo;
  /**
   * Its own colour (#rrggbb), for printing in two colours: raised, it stands out in it; cut in, the
   * cut is filled flush with it. None: the face's (a cut through has none).
   */
  colour?: string;
  on: boolean;
}

/** How a part looks: its filament's colour (#rrggbb) and its surface (the view and pictures; the colour goes into the 3MF). */
export type Finish = 'matte' | 'satin' | 'gloss' | 'silk' | 'metal' | 'clear' | 'fuzzy';
export interface Paint { colour: string; finish: Finish }
export interface Looks { base: Paint; top: Paint; buttons: Paint; gasket: Paint }
export const FINISHES: { id: Finish; name: string; title: string }[] = [
  { id: 'matte', name: 'Matte', title: 'Matte filament: no shine' },
  { id: 'satin', name: 'Satin', title: 'Most PLA and PETG as printed: a soft sheen' },
  { id: 'gloss', name: 'Gloss', title: 'A glossy filament, or a part smoothed or lacquered' },
  { id: 'silk', name: 'Silk', title: 'Silk filament: a pearly sheen in its own colour' },
  { id: 'metal', name: 'Metal', title: 'A metal look: metal-filled filament polished, or paint' },
  { id: 'clear', name: 'Clear', title: 'A translucent filament: what is inside shows through' },
  { id: 'fuzzy', name: 'Fuzzy skin', title: 'A rough, grippy surface, as a slicer\'s fuzzy skin setting prints it' },
];
/** Common filament colours. */
export const FILAMENTS: { name: string; colour: string }[] = [
  { name: 'Black', colour: '#1d1e20' }, { name: 'Charcoal', colour: '#3a3d42' }, { name: 'Grey', colour: '#8e9196' }, { name: 'Light grey', colour: '#c7c9cf' }, { name: 'White', colour: '#f1f1ee' },
  { name: 'Red', colour: '#c8102e' }, { name: 'Orange', colour: '#f26b1d' }, { name: 'Yellow', colour: '#f5c400' }, { name: 'Green', colour: '#2e9b4f' }, { name: 'Teal', colour: '#00808a' },
  { name: 'Blue', colour: '#1f5fbf' }, { name: 'Light blue', colour: '#9eb5d1' }, { name: 'Purple', colour: '#6c3fa3' }, { name: 'Wood', colour: '#a07850' }, { name: 'Gold', colour: '#c9a24a' },
];
export const DEFAULT_LOOKS: Looks = {
  base: { colour: '#c7c9cf', finish: 'satin' }, top: { colour: '#9eb5d1', finish: 'satin' },
  buttons: { colour: '#db8c40', finish: 'satin' }, gasket: { colour: '#3a3d42', finish: 'matte' },
};
/**
 * How the box is lit and set for pictures (and in the view): the room's colour (the background, and
 * what tints the ambient light and the shiny surfaces' reflections), the background (shaded, flat,
 * none), where the key light comes from (degrees round the box from the front, + to the right; up
 * from level), how strong it and the ambient light are (1: as set up), and the shadow under the box.
 */
export interface Scene { env: string; background: 'gradient' | 'flat' | 'none'; azimuth: number; elevation: number; key: number; ambient: number; shadow: boolean }
export const DEFAULT_SCENE: Scene = { env: '#e8eaee', background: 'gradient', azimuth: -33, elevation: 45, key: 1, ambient: 1, shadow: true };
/** Rooms to set the box in. */
export const ROOMS: { name: string; colour: string }[] = [
  { name: 'Studio', colour: '#e8eaee' }, { name: 'White', colour: '#ffffff' }, { name: 'Warm', colour: '#efe7dc' }, { name: 'Sky', colour: '#cddff2' },
  { name: 'Sage', colour: '#d3e0d0' }, { name: 'Slate', colour: '#5d6672' }, { name: 'Navy', colour: '#1c2b45' }, { name: 'Dark', colour: '#23272e' }, { name: 'Black', colour: '#0b0c0e' },
];
/** Lighting set-ups: the key light's direction and strength and the ambient light. */
export const LIGHT_SETUPS: { name: string; title: string; set: Pick<Scene, 'azimuth' | 'elevation' | 'key' | 'ambient'> }[] = [
  { name: 'Studio', title: 'A key light from the front left above, a fill and a rim', set: { azimuth: -33, elevation: 45, key: 1, ambient: 1 } },
  { name: 'Soft', title: 'Mostly the room\'s light: few shadows, gentle shading', set: { azimuth: -25, elevation: 60, key: 0.55, ambient: 1.6 } },
  { name: 'Bright', title: 'Strong light all round', set: { azimuth: -40, elevation: 50, key: 1.35, ambient: 1.4 } },
  { name: 'Dramatic', title: 'A low light from the side, a dark room', set: { azimuth: -75, elevation: 22, key: 1.5, ambient: 0.35 } },
];
const HEX = /^#[0-9a-f]{6}$/i;
/** A colour as kept: #rrggbb, else none. */
export const colourOf = (c: unknown): string | undefined => (typeof c === 'string' && HEX.test(c) ? c.toLowerCase() : undefined);
/** A colour as red, green and blue (0 … 1). */
export const rgbOf = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255];

/** A new protrusion of a kind at a place on a face [est: sizes for M3 screws and a 0.4 mm nozzle]; a rib on a wall stands upright. */
export function newAdd(kind: AddKind, face: Face, x: number, y: number, side: 'out' | 'in', n: number): Add {
  const wall = face !== 'top' && face !== 'bottom';
  const base = { kind, face, side, x, y, on: true, hole: 0 };
  switch (kind) {
    case 'boss': return { ...base, name: `Boss ${n}`, shape: 'circle', w: 6, h: 6, height: 5, hole: 2.5 };
    case 'pin': return { ...base, name: `Pin ${n}`, shape: 'circle', w: 3, h: 3, height: 4 };
    case 'block': return { ...base, name: `Block ${n}`, shape: 'rect', w: 10, h: 6, height: 3 };
    case 'rib': return { ...base, name: `Rib ${n}`, shape: 'rect', w: wall ? 1.6 : 20, h: wall ? 8 : 1.6, height: 4 };
  }
}

/**
 * Keyhole slots in the floor (seen from above): for screw heads `head` wide, the entry hole and the
 * slot that runs from it towards the back wall (the box hung with its back wall up), and their
 * places — two apart along x, or one in the middle when the floor is narrow. [est: entry 0.8 mm over
 * the head, the slot 0.6 of the head plus 0.4 wide, the head's travel 0.75 of it plus 1 mm]
 */
export function keyholeLayout(head: number, g: Pick<Layout, 'ix' | 'iy'>): { r: number; slot: number; travel: number; at: P[] } {
  const r = head / 2 + 0.4, slot = head * 0.5 + 0.4, travel = head * 0.75 + 1;
  const wall = r + 1.6, x = Math.round(g.ix * 0.5 * 10) / 10;
  const at = x - wall > 2 ? [{ x: -x, y: -travel / 2 }, { x, y: -travel / 2 }] : [{ x: 0, y: -travel / 2 }];
  return { r, slot, travel, at };
}

/** A logo from a drawing (SVG): its filled shapes centred and made 1 high, and the drawing's own height (mm); null when it fills nothing. */
export function logoOf(svg: string, name: string): { logo: Logo; height: number } | null {
  // White shapes before any dark one take away nothing: left out (a background)
  const drawn = (x: ReturnType<typeof svgShapes>) => x.slice(Math.max(0, x.findIndex((q) => !q.knock)));
  let sh = drawn(svgShapes(svg));
  if (!sh.length || sh[0]!.knock) return null;
  // The extent of what is dark
  let b = shapesBox(sh.filter((q) => !q.knock));
  // Its detail kept to a fraction of its size (a large drawing would carry more points than show)
  const tol = (b.y1 - b.y0) / 1500;
  if (tol > 0.02) { sh = drawn(svgShapes(svg, tol)); b = shapesBox(sh.filter((q) => !q.knock)); }
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  if (!(w > 0 && h > 0)) return null;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, r = (v: number) => Math.round(v * 1e4) / 1e4;
  return { height: h, logo: { name, aspect: r(w / h), shapes: sh.map((s) => ({ evenOdd: s.evenOdd, ...(s.knock ? { knock: true } : {}), rings: s.rings.map((ring) => ring.map(([x, y]) => [r((x - cx) / h), r((y - cy) / h)] as [number, number])) })) } };
}

/** A seal between the base and the top: a groove in the base's rim for a cord (its diameter), or for a gasket printed in TPU (its width), a part of its own. */
export interface Seal { kind: 'none' | 'cord' | 'gasket'; size: number }

/** The first format's openings: along a wall's straight part from its start (counter-clockwise), heights above the board's top. */
export interface Cutout { name: string; side: Side; u0: number; u1: number; z0: number; z1: number; on: boolean; auto?: boolean }

export interface EnclosureSpec {
  v: 2;
  /** The board it is for (its file name in the project). */
  board: string;
  wall: number; floor: number;
  /** The lid's (or top shell's) thickness. */
  top: number;
  /** Between the board's edge and the walls. */
  clearance: number;
  /** The box's corners in plan (outside). */
  radius: number;
  /** The outside's top and bottom edges. */
  edge: 'none' | 'round' | 'chamfer';
  edgeSize: number;
  /** Where the top meets the base: null, a flat lid on the walls; else that far above the board's top (two shells). */
  split: number | null;
  /** Room over the board's top; null: its tallest part and 1.5 mm. */
  above: number | null;
  /** The board's underside above the floor; null: 3 mm, or its tallest underside part and 1 mm. */
  standoff: number | null;
  /** The lip: how far it reaches into the other part, how thick it is, and the gap round it. */
  lipHeight: number; lipWidth: number; fit: number;
  fix: Fix;
  screw: { size: number; into: Into; head: 'countersunk' | 'pan'; at: 'corners' | 'board' };
  /** Snap catches on each side (null: by the side's length). */
  snaps: number | null;
  mount: {
    into: Into | 'pin';
    /** The standoffs' diameter (null: by the screw). */
    dia: number | null;
    /** Ledges under the board's corners when it has no mounting holes. */
    ledges: boolean;
    /** Posts from the top that hold the board down. */
    clamp: boolean;
  };
  openings: Opening[];
  vents: Vent[];
  labels: Label[];
  /** Protrusions: bosses, pins, blocks, ribs, outside or inside. */
  adds: Add[];
  /** Round recesses under the base's corners for stick-on rubber feet (their diameter; 0: none). */
  feet: number;
  /** Flanges at the base's foot on two opposite sides, each with a screw hole, to fix the box to a wall or panel. */
  ears: { sides: 'none' | 'EW' | 'NS'; hole: number };
  /** Keyhole slots in the floor for hanging the box on screws with heads this wide, the back wall up (0: none). */
  keyholes: number;
  seal: Seal;
  /** The parts' colours and surfaces. */
  looks: Looks;
  /** The light and the room for pictures and the view. */
  scene: Scene;
  print: {
    nozzle: number; layer: number; material: Material;
    /** A chamfer on the edges that lie on the print bed, against the first layers squashing out. */
    bedChamfer: number;
    /** Round holes in walls printed as teardrops (no overhang over 45°). */
    teardrops: boolean;
    /** Added to the diameter of holes for screws, inserts and nuts (printed holes come out small); taken off pins. */
    holeComp: number;
  };
  /** The openings were looked for (once, when the document is first made). */
  detected?: boolean;
  /** Openings of the first format, turned into openings once the board is known. */
  cutouts?: Cutout[];
}

export const defaultSpec = (board: string): EnclosureSpec => ({
  v: 2, board, wall: 2, floor: 2, top: 2, clearance: 1, radius: 3, edge: 'none', edgeSize: 1.5, split: null, above: null, standoff: null,
  lipHeight: 3, lipWidth: 1.2, fit: 0.2, fix: 'press', screw: { size: 3, into: 'pilot', head: 'countersunk', at: 'corners' }, snaps: null,
  mount: { into: 'pilot', dia: null, ledges: true, clamp: true }, openings: [], vents: [], labels: [], adds: [], feet: 0, ears: { sides: 'none', hole: 4.5 },
  seal: { kind: 'none', size: 2 }, keyholes: 0, looks: JSON.parse(JSON.stringify(DEFAULT_LOOKS)) as Looks, scene: { ...DEFAULT_SCENE },
  print: { nozzle: 0.4, layer: 0.2, material: 'PLA', bedChamfer: 0.4, teardrops: true, holeComp: 0.15 },
});

/** A document's settings as this version keeps them (the first version's turned over: lid → top, the old fields kept as they were). */
export function normaliseSpec(raw: Partial<EnclosureSpec> & { lid?: number; standoffDia?: number; screwHole?: number }): EnclosureSpec {
  const d = defaultSpec(raw.board ?? '');
  const s: EnclosureSpec = { ...d, ...raw, v: 2, screw: { ...d.screw, ...(raw.screw ?? {}) }, mount: { ...d.mount, ...(raw.mount ?? {}) }, print: { ...d.print, ...(raw.print ?? {}) } };
  if (raw.v !== 2) {
    if (typeof raw.lid === 'number') s.top = raw.lid;
    if (typeof raw.standoffDia === 'number') s.mount.dia = raw.standoffDia;
    // The first version made no chamfers: kept so
    s.print.bedChamfer = 0;
  }
  delete (s as { lid?: number }).lid; delete (s as { standoffDia?: number }).standoffDia; delete (s as { screwHole?: number }).screwHole;
  s.openings = Array.isArray(s.openings) ? s.openings : [];
  s.labels = Array.isArray(s.labels) ? s.labels : [];
  s.adds = Array.isArray(s.adds) ? s.adds : [];
  s.ears = { ...d.ears, ...(raw.ears ?? {}) };
  s.seal = { ...d.seal, ...(raw.seal ?? {}) };
  s.keyholes = typeof raw.keyholes === 'number' && raw.keyholes > 0 ? raw.keyholes : 0;
  const finishes = FINISHES.map((f) => f.id);
  const paint = (p: Partial<Paint> | undefined, dflt: Paint): Paint => ({ colour: colourOf(p?.colour) ?? dflt.colour, finish: p?.finish && finishes.includes(p.finish) ? p.finish : dflt.finish });
  const rl = (raw.looks ?? {}) as Partial<Looks>;
  s.looks = { base: paint(rl.base, DEFAULT_LOOKS.base), top: paint(rl.top, DEFAULT_LOOKS.top), buttons: paint(rl.buttons, DEFAULT_LOOKS.buttons), gasket: paint(rl.gasket, DEFAULT_LOOKS.gasket) };
  for (const l of s.labels) { const c = colourOf(l.colour); if (c) l.colour = c; else delete l.colour; }
  const rs = (raw.scene ?? {}) as Partial<Scene>;
  const num = (v: unknown, dflt: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt);
  s.scene = {
    env: colourOf(rs.env) ?? DEFAULT_SCENE.env, background: rs.background === 'flat' || rs.background === 'none' ? rs.background : 'gradient',
    azimuth: num(rs.azimuth, DEFAULT_SCENE.azimuth, -180, 180), elevation: num(rs.elevation, DEFAULT_SCENE.elevation, 2, 90),
    key: num(rs.key, DEFAULT_SCENE.key, 0, 2), ambient: num(rs.ambient, DEFAULT_SCENE.ambient, 0, 2), shadow: rs.shadow !== false,
  };
  // Vent slots in the lid (the first version's tick): a patch of slots in the middle of the top, sized once the board is known
  if (!Array.isArray(s.vents)) s.vents = (s.vents as unknown) === true ? [{ name: 'Vents', face: 'top', pattern: 'slots', x: 0, y: 0, w: 0, h: 0, size: 1.6, on: true }] : [];
  if (!Array.isArray(s.cutouts) || !s.cutouts.length) delete s.cutouts;
  return s;
}

/** What the enclosure is built round (mm, the board's centre at the origin). */
export interface BoardFacts {
  /** The board's extent. */
  w: number; h: number;
  thickness: number;
  /** Tallest above the board's top, and below its underside (0 when none). */
  top: number; bottom: number;
  /** Mounting holes (centre, diameter). */
  holes: { x: number; y: number; d: number }[];
  /** Parts on top: their extent in plan and their heights above the board's top; what they are, when that can be told. */
  parts: { name: string; x0: number; y0: number; x1: number; y1: number; z1: number; kind?: PartKind }[];
}

/** What a part is, for the openings it wants: light out, a finger in, a window, sound out, a cable in. */
export type PartKind = 'led' | 'switch' | 'display' | 'sound' | 'connector' | 'other';
/** A part's kind from its designator's letters, its footprint and its description. */
export function partKind(designator: string, footprint = '', description = ''): PartKind {
  const t = `${footprint} ${description}`.toUpperCase(), pre = designator.replace(/[^A-Za-z].*$/, '').toUpperCase();
  if (pre === 'LED' || /\bLED/.test(t)) return 'led';
  if (['SW', 'S', 'BTN', 'B', 'K', 'KEY', 'PB'].includes(pre) || /SWITCH|TACT|BUTTON|PUSH/.test(t)) return 'switch';
  if (['DS', 'LCD', 'DISP', 'OLED', 'LD'].includes(pre) || /LCD|OLED|DISPLAY|7.?SEG|SEGMENT/.test(t)) return 'display';
  if (['BZ', 'LS', 'SP', 'BUZ'].includes(pre) || /BUZZER|SPEAKER|SOUNDER/.test(t)) return 'sound';
  if (['J', 'P', 'CN', 'X', 'CON', 'USB', 'JP'].includes(pre) || /USB|CONN|HEADER|JACK|RJ45|HDMI|SMA|TERMINAL|SOCKET/.test(t)) return 'connector';
  return 'other';
}

/* ─── Screws ─── */

/** A metric screw's holes (mm): pilot for a self-tapping screw in plastic, clearance, head, heat-set insert hole and length, nut across flats and thickness. */
export interface ScrewSize { pilot: number; clear: number; head: number; insert: number; insertL: number; nutAF: number; nutH: number }
export const SCREWS: Record<string, ScrewSize> = {
  2: { pilot: 1.6, clear: 2.4, head: 4.0, insert: 3.2, insertL: 3.0, nutAF: 4.0, nutH: 1.6 },
  2.5: { pilot: 2.0, clear: 2.9, head: 5.0, insert: 3.6, insertL: 4.0, nutAF: 5.0, nutH: 2.0 },
  3: { pilot: 2.5, clear: 3.4, head: 6.0, insert: 4.0, insertL: 5.7, nutAF: 5.5, nutH: 2.4 },
  4: { pilot: 3.3, clear: 4.5, head: 8.0, insert: 5.6, insertL: 8.1, nutAF: 7.0, nutH: 3.2 },
};
export const screwOf = (size: number): ScrewSize => SCREWS[String(size)] ?? SCREWS['3']!;
/** The screw a board's mounting hole takes. */
export const screwForHole = (d: number): number => (d < 2.4 ? 2 : d < 2.9 ? 2.5 : d < 3.9 ? 3 : 4);
/** A boss round a screw's hole: walls two nozzle widths or more round the hole, the insert or the nut. */
export function bossDia(size: number, into: Into | 'pin'): number {
  const k = screwOf(size);
  if (into === 'insert') return k.insert + 3.2;
  if (into === 'nut') return k.nutAF / Math.cos(Math.PI / 6) + 2.4;
  return Math.max(size * 2.2, k.pilot + 3.6);
}
const LENGTHS = [4, 5, 6, 8, 10, 12, 14, 16, 20, 25, 30, 35, 40, 45, 50];
/** The longest standard length up to l. */
/** A locating pin's radius in a hole of diameter d (half the hole allowance taken off). */
export const pinRadius = (d: number, holeComp: number): number => Math.max(0.6, d / 2 - 0.15 - Math.max(0, Math.min(0.6, holeComp)) / 2);
/** Where a blind hole in a standoff stops: clear of the recesses for feet under the floor. */
export const blindBottom = (s: EnclosureSpec): number => (s.feet > 0 ? Math.min(0.8, s.floor - 0.6) + 0.6 : 0.8);
export const screwLength = (l: number): number => [...LENGTHS].reverse().find((x) => x <= l + 1e-6) ?? 0;

/* ─── Layout ─── */

interface P { x: number; y: number }
/** A wall's frame: its middle on the inside face, the way along it (left to right seen from outside), out through it, its straight part's length. */
export interface WallFrame { m: P; d: P; n: P; len: number }

export interface Layout {
  /** The cavity's and the outside's half sizes, their corner radii. */
  ix: number; iy: number; ox: number; oy: number; ri: number; ro: number;
  floorTop: number; boardBottom: number; boardTop: number;
  /** The cavity's top (the top's underside), the outside's height, the joint's height. */
  rim: number; height: number; joint: number;
  flatLid: boolean;
  /** The outside's top and bottom edges as made (0: none). */
  edge: number;
  /** The board's standoffs: where, the screw its hole takes. */
  standoffs: { x: number; y: number; size: number; d: number }[];
  /** Ledges under the board's corners. */
  ledges: P[];
  /** Posts from the top down onto the board. */
  clamps: (P & { r: number })[];
  /** The top's screws: where, their size, the length they can be; into nuts, the nut pocket's top (the nut set high enough for that length to go through it). */
  screws: { at: P[]; size: number; length: number; boss: number; nutTop?: number } | null;
  sides: Record<Side, WallFrame>;
  /** What was left out or changed, to say. */
  notes: string[];
}

export function layoutOf(s: EnclosureSpec, b: BoardFacts): Layout {
  const notes: string[] = [];
  const corners = s.fix === 'screws' && s.screw.at === 'corners';
  const boss = corners ? bossDia(s.screw.size, s.screw.into) / 2 : 0;
  // Bosses in the corners: beside the board's corners, inside the outside's rounded corner
  let clearance = s.clearance;
  const radius = Math.max(s.wall + 0.3, s.radius);
  if (corners) {
    const k = screwOf(s.screw.size), hole = (s.screw.into === 'insert' ? k.insert : s.screw.into === 'nut' ? k.nutAF / Math.cos(Math.PI / 6) : k.pilot) / 2;
    const dd = (boss + 0.4) / Math.SQRT2;
    for (let i = 0; i < 400; i++) {
      const ox = b.w / 2 + clearance + s.wall, oy = b.h / 2 + clearance + s.wall;
      const ro = Math.min(radius, ox - 0.5, oy - 0.5);
      const c = { x: b.w / 2 + dd, y: b.h / 2 + dd }, cc = { x: ox - ro, y: oy - ro };
      const outward = c.x > cc.x && c.y > cc.y ? ro - Math.hypot(c.x - cc.x, c.y - cc.y) : Math.min(ox - c.x, oy - c.y);
      if (outward >= hole + 1.2) break;
      clearance += 0.1;
    }
    if (clearance > s.clearance + 0.05) notes.push(`The box is ${(2 * (clearance - s.clearance)).toFixed(1)} mm longer and wider than the clearance alone, to fit the screw bosses beside the board's corners`);
  }
  const ix = b.w / 2 + clearance, iy = b.h / 2 + clearance;
  const ox = ix + s.wall, oy = iy + s.wall;
  // The inside corners follow the outside ones a wall's width in (so the straight parts line up)
  const ro = Math.max(s.wall + 0.3, Math.min(s.radius, ox - 0.5, oy - 0.5)), ri = ro - s.wall;
  const standoffH = s.standoff ?? Math.max(3, b.bottom + 1);
  const above = s.above ?? Math.max(3, b.top + 1.5);
  const floorTop = s.floor, boardBottom = floorTop + standoffH, boardTop = boardBottom + b.thickness, rim = boardTop + above;
  const height = rim + s.top;
  const flatLid = s.split === null;
  const joint = flatLid ? rim : Math.max(floorTop + 2, Math.min(rim - 2, boardTop + s.split!));
  if (!flatLid && Math.abs(joint - (boardTop + s.split!)) > 1e-6) notes.push(`The joint is at ${(joint - boardTop).toFixed(1)} mm above the board, ${joint > boardTop + s.split! ? 'over the floor' : 'under the top'} by 2 mm or more`);
  const edge = s.edge === 'none' ? 0 : Math.max(0, Math.min(s.edgeSize, s.wall * 1.5, s.floor * 1.5, s.top * 1.5, height / 3, ro));
  const sides: Record<Side, WallFrame> = {
    S: { m: { x: 0, y: -iy }, d: { x: 1, y: 0 }, n: { x: 0, y: -1 }, len: 2 * (ix - ri) },
    E: { m: { x: ix, y: 0 }, d: { x: 0, y: 1 }, n: { x: 1, y: 0 }, len: 2 * (iy - ri) },
    N: { m: { x: 0, y: iy }, d: { x: -1, y: 0 }, n: { x: 0, y: 1 }, len: 2 * (ix - ri) },
    W: { m: { x: -ix, y: 0 }, d: { x: 0, y: -1 }, n: { x: -1, y: 0 }, len: 2 * (iy - ri) },
  };
  // In the cavity, clear of its rounded corners, by r
  const inside = (p: P, r: number) => {
    if (Math.abs(p.x) + r > ix || Math.abs(p.y) + r > iy) return false;
    const cx = ix - ri, cy = iy - ri;
    return !(Math.abs(p.x) > cx && Math.abs(p.y) > cy) || Math.hypot(Math.abs(p.x) - cx, Math.abs(p.y) - cy) + r <= ri;
  };
  // A standoff may join the wall; its hole (or nut, insert or pin) must keep clear of it
  const standoffs = standoffH <= 0.5 ? [] : b.holes.flatMap((h) => {
    const size = screwForHole(h.d), k = screwOf(size);
    const r = s.mount.into === 'nut' ? k.nutAF / Math.sqrt(3) : s.mount.into === 'insert' ? k.insert / 2 : s.mount.into === 'pin' ? h.d / 2 : k.pilot / 2;
    if (inside(h, r + 0.8)) return [{ x: h.x, y: h.y, size, d: h.d }];
    notes.push(`No standoff at the hole at ${h.x.toFixed(1)}, ${h.y.toFixed(1)}: its ${s.mount.into === 'pin' ? 'pin' : 'hole'} would run into the wall`);
    return [];
  });
  const ledges = !standoffs.length && s.mount.ledges && standoffH > 0.5 ? [-1, 1].flatMap((sx) => [-1, 1].map((sy) => ({ x: sx * b.w / 2, y: sy * b.h / 2 }))) : [];
  const screwsAtBoard = s.fix === 'screws' && s.screw.at === 'board';
  if (screwsAtBoard && !standoffs.length) notes.push('Screws through the board: it has no mounting holes for them');
  // Posts onto the board where nothing else holds it down: over locating pins (hollow, round the pin's tip) and beside ledges,
  // clear of its parts on top (screws hold it at its other standoffs; where they come down through the board, they are the posts)
  const clear = (p: P, r: number) => b.parts.every((q) => p.x + r < q.x0 - 0.5 || p.x - r > q.x1 + 0.5 || p.y + r < q.y0 - 0.5 || p.y - r > q.y1 + 0.5);
  const pins = s.mount.into === 'pin' ? standoffs.map((p) => ({ x: p.x, y: p.y, r: Math.max(2, pinRadius(p.d, s.print.holeComp) + s.fit + 1.2) })) : [];
  const clamps = s.mount.clamp && !screwsAtBoard ? [...pins, ...ledges.map((p) => ({ x: p.x - Math.sign(p.x) * 2.2, y: p.y - Math.sign(p.y) * 2.2, r: 2 }))].filter((p) => {
    const ok = clear(p, p.r) && inside(p, p.r + s.fit);
    if (!ok) notes.push(`No post onto the board at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}: a part is in the way`);
    return ok;
  }) : [];
  let screws: Layout['screws'] = null;
  /*
   * The longest standard screw from the top's surface that stays in its hole: a pilot hole's or an
   * insert's bottom; into a nut, short of the base's underside, the nut set high enough in its
   * pocket for the screw to go right through it.
   */
  const blind = blindBottom(s);
  const fitScrew = (size: number, into: Into, zTop: number, zBottom: number) => {
    const k = screwOf(size);
    if (into === 'nut') {
      const length = screwLength(height - 0.3), nutTop = Math.max(k.nutH + 0.3, height - length + k.nutH);
      if (nutTop > zTop - 1) notes.push(`M${size} × ${length} mm screws are too short to reach their nuts: a box this tall needs inserts or pilot holes`);
      return { length, nutTop: Math.min(nutTop, zTop - 1) };
    }
    return { length: screwLength(height - (into === 'insert' ? Math.max(zBottom, zTop - k.insertL - 0.5) : zBottom)) };
  };
  if (s.fix === 'screws') {
    if (corners) {
      const dd = (boss + 0.4) / Math.SQRT2;
      const at = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => ({ x: sx * (b.w / 2 + dd), y: sy * (b.h / 2 + dd) })));
      screws = { at, size: s.screw.size, boss: boss * 2, ...fitScrew(s.screw.size, s.screw.into, joint, floorTop + 0.6) };
    } else if (standoffs.length) {
      const size = Math.min(...standoffs.map((p) => p.size));
      screws = { at: standoffs.map((p) => ({ x: p.x, y: p.y })), size, boss: (s.mount.dia ?? bossDia(size, s.mount.into === 'pin' ? 'pilot' : s.mount.into)), ...fitScrew(size, s.mount.into === 'pin' ? 'pilot' : s.mount.into, boardBottom, blind) };
    }
  }
  return { ix, iy, ox, oy, ri, ro, floorTop, boardBottom, boardTop, rim, height, joint, flatLid, edge, standoffs, ledges, clamps, screws, sides, notes };
}

/* ─── Openings found for the board's parts ─── */

/**
 * Openings for the parts that meet the board's edge (within a millimetre of it, or past it): on
 * the wall they face, as wide and as high as the part and half a millimetre more all round; open
 * to the joint when the part reaches into the wall (so the board can go in). And in the top, over
 * the parts that want one: a round hole over an LED (as wide as it) and over a switch (60% of it,
 * for its button), a window over a display (its outline less a millimetre each side).
 */
export function autoOpenings(s: EnclosureSpec, b: BoardFacts): Opening[] {
  const g = layoutOf(s, b);
  const out: Opening[] = [];
  const m = 0.5, near = 1;
  for (const p of b.parts) {
    const dists: [Side, number][] = [['S', p.y0 + b.h / 2], ['N', b.h / 2 - p.y1], ['W', p.x0 + b.w / 2], ['E', b.w / 2 - p.x1]];
    const [side, d] = dists.sort((x, y) => x[1] - y[1])[0]!;
    if (d > near) continue;
    const f = g.sides[side];
    // Along the wall from its middle: the part's extent seen from outside
    const us = [p.x0, p.x1].flatMap((x) => [p.y0, p.y1].map((y) => x * f.d.x + y * f.d.y));
    const u0 = Math.min(...us) - m, u1 = Math.max(...us) + m, v0 = -m, v1 = p.z1 + m;
    // Past the board's edge further than the clearance: into the wall
    const open = -d > (g.ix - b.w / 2) - 0.3;
    out.push({ name: p.name, face: side, shape: 'rect', x: (u0 + u1) / 2, y: (v0 + v1) / 2, w: u1 - u0, h: v1 - v0, on: true, auto: true, part: p.name, ...(open ? { open: true } : {}) });
  }
  const atEdge = new Set(out.map((o) => o.part));
  for (const p of b.parts) {
    if (atEdge.has(p.name) || !p.kind) continue;
    const x = (p.x0 + p.x1) / 2, y = (p.y0 + p.y1) / 2, w = p.x1 - p.x0, h = p.y1 - p.y0;
    const top = { name: p.name, face: 'top' as const, x, y, on: true, auto: true, part: p.name };
    if (p.kind === 'led') out.push({ ...top, shape: 'circle', w: Math.min(w, h) + 0.4, h: Math.min(w, h) + 0.4 });
    else if (p.kind === 'switch') out.push({ ...top, shape: 'circle', w: Math.max(2, Math.min(w, h) * 0.6), h: Math.max(2, Math.min(w, h) * 0.6) });
    else if (p.kind === 'display' && w > 4 && h > 4) out.push({ ...top, shape: 'rounded', w: w - 2, h: h - 2 });
  }
  return out;
}

/** The first format's openings as openings (along from the wall's middle). */
export function fromCutouts(cs: Cutout[], g: Layout): Opening[] {
  return cs.map((c) => {
    const len = g.sides[c.side].len, u0 = Math.min(c.u0, c.u1) - len / 2, u1 = Math.max(c.u0, c.u1) - len / 2, v0 = Math.min(c.z0, c.z1), v1 = Math.max(c.z0, c.z1);
    return { name: c.name, face: c.side, shape: 'rect', x: (u0 + u1) / 2, y: (v0 + v1) / 2, w: u1 - u0, h: v1 - v0, on: c.on, ...(c.auto ? { auto: true, part: c.name } : {}) };
  });
}

/** Snap catches along a wall's straight part: where (along from its middle). */
export function snapPlaces(s: EnclosureSpec, g: Layout, side: Side): number[] {
  const f = g.sides[side];
  const n = s.snaps ?? (f.len > 70 ? 2 : f.len > 24 ? 1 : 0);
  const half = 5;
  const busy = s.openings.filter((o) => o.on && o.face === side).map((o) => [o.x - o.w / 2 - 1.5, o.x + o.w / 2 + 1.5] as const);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let u = -f.len / 2 + ((i + 1) / (n + 1)) * f.len;
    // Moved off an opening, to the nearer side of it that has room
    for (const [a, b] of busy) if (u + half > a && u - half < b) u = u - a < b - u && a - half > -f.len / 2 + 2 ? a - half : b + half;
    if (Math.abs(u) + half <= f.len / 2 - 1 && busy.every(([a, b]) => u + half <= a || u - half >= b)) out.push(u);
  }
  return out;
}

/* ─── Vents ─── */

/**
 * A vent patch's cells, whole ones inside it: slots (their ends' centres), round holes or
 * hexagons (their centres). Hexagons stand on a point in walls and holes come to a point at
 * their top there (teardrops), so they print without bridging; bars between cells at least three
 * nozzle widths.
 */
export interface VentCells { kind: 'slot' | 'hole' | 'hex'; r: number; pointUp: boolean; teardrop: boolean; cells: { x: number; y: number; x2?: number; y2?: number }[] }
export function ventCells(v: Vent, s: Pick<EnclosureSpec, 'print'>): VentCells {
  const wall = v.face !== 'top' && v.face !== 'bottom', sz = Math.max(0.8, v.size), bar = Math.max(1.2, s.print.nozzle * 3);
  const x0 = v.x - v.w / 2, x1 = v.x + v.w / 2, y0 = v.y - v.h / 2, y1 = v.y + v.h / 2;
  if (v.pattern === 'slots') {
    const pitch = sz + bar * 1.5, along = v.across ? v.w : v.h, n = Math.max(0, Math.floor((along - sz) / pitch) + 1);
    const cells: VentCells['cells'] = [];
    for (let i = 0; i < n; i++) {
      const t = -((n - 1) * pitch) / 2 + i * pitch;
      if (!v.across && x1 - x0 > sz) cells.push({ x: x0 + sz / 2, y: v.y + t, x2: x1 - sz / 2, y2: v.y + t });
      if (v.across && y1 - y0 > sz) cells.push({ x: v.x + t, y: y0 + sz / 2, x2: v.x + t, y2: y1 - sz / 2 });
    }
    return { kind: 'slot', r: sz / 2, pointUp: false, teardrop: false, cells };
  }
  const hex = v.pattern === 'honeycomb';
  const R = hex ? sz / Math.sqrt(3) : sz / 2, pitch = sz + (hex ? bar : Math.max(bar, sz * 0.5));
  const pointUp = hex && wall, teardrop = !hex && wall && s.print.teardrops;
  const halfW = hex ? (pointUp ? sz / 2 : R) : R, up = hex ? (pointUp ? R : sz / 2) : teardrop ? R * Math.SQRT2 : R, down = hex ? up : R;
  // Rows of staggered cells (columns, for hexagons lying flat)
  const flat = hex && !pointUp;
  const dx = flat ? pitch * Math.sqrt(3) / 2 : pitch, dy = flat ? pitch : pitch * Math.sqrt(3) / 2;
  const nx = Math.floor(v.w / dx) + 2, ny = Math.floor(v.h / dy) + 2;
  const cells: VentCells['cells'] = [];
  for (let j = -ny; j <= ny; j++) for (let i = -nx; i <= nx; i++) {
    const cx = v.x + i * dx + (flat ? 0 : (Math.abs(j) % 2) * dx / 2), cy = v.y + j * dy + (flat ? (Math.abs(i) % 2) * dy / 2 : 0);
    if (cx - halfW >= x0 - 1e-6 && cx + halfW <= x1 + 1e-6 && cy - down >= y0 - 1e-6 && cy + up <= y1 + 1e-6) cells.push({ x: cx, y: cy });
  }
  return { kind: hex ? 'hex' : 'hole', r: R, pointUp, teardrop, cells };
}

/** The first version's vent slots (a patch sized 0 when read): in the middle of the top, inside its lip. */
export function ventPatch(s: EnclosureSpec, g: Layout): { w: number; h: number } {
  const lx = g.ix - s.fit - s.lipWidth - 2, ly = g.iy - s.fit - s.lipWidth - 2;
  return { w: Math.max(4, Math.round(Math.min(lx * 2 * 0.6, 40))), h: Math.max(4, Math.round(ly * 2 * 0.5)) };
}
