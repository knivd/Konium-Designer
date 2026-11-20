/**
 * The CAM document (CAMtastic's .Cam): fabrication files loaded as layers — Gerber layers and
 * NC drill files — each with its type in the layer stack, its colour and whether it shows. The
 * layer's file is kept as it came, so it is written out again unchanged unless edited; the
 * document saves as Konium's own JSON [est: AD's .Cam is a binary format of its own].
 */
import { readDrill, readGerber, sniffCamFile, type DrillLayer, type GerberLayer, type GerberObject, type ReadDefaults } from '../gerber/gerberRead';
import type { BBox, Vec2 } from '../../core/geom';
import { drillTextHits, hitBox, type CamGroup, type CamNet, type CamPart, type CamSub } from './camModel';
import { regenerated, writeDrillOrdered, writeGerberOrdered } from './camWrite';

/** Layer types as CAMtastic's Layers Table lists them [est: the names]. */
export const CAM_LAYER_TYPES = [
  'Top', 'Bottom', 'Internal', 'Plane', 'Top Silk', 'Bottom Silk', 'Top Mask', 'Bottom Mask', 'Top Paste', 'Bottom Paste',
  'Drill Top', 'Drill Drawing', 'Drill Guide', 'Border', 'Mechanical', 'Keep Out', 'Undefined',
] as const;
export type CamLayerType = (typeof CAM_LAYER_TYPES)[number];

export interface CamLayer {
  /** The file name it came from (TOP.GTL). */
  name: string;
  type: CamLayerType;
  colour: string;
  visible: boolean;
  /** The file as loaded (or as last written). */
  text: string;
  data: GerberLayer | DrillLayer;
  /** Objects taken out (Edit › Erase), by index into data's objects / hits. */
  erased?: number[];
  /** Changed beyond erasing (objects placed, moved, apertures added …): written from its objects. */
  edited?: boolean;
  /** Its groups (placed text, polylines, dimensions, drilled text): objects carry the id as grp. */
  groups?: Map<number, CamGroup>;
  /** A composite layer's sub-layers in order (Edit › Composite Layers). */
  composite?: CamSub[];
}

export interface CamDocument {
  kind: 'CamDoc';
  name: string;
  layers: CamLayer[];
  /** The layer new work goes to (the CAMtastic panel's current layer). */
  current: number;
  dirty: boolean;
  /** Edit › Objects › Set Origin: the user origin coordinates are shown from. */
  origin?: Vec2;
  /** View › Film Box: the film the image is placed on. */
  filmBox?: BBox;
  /** Tables › Layers Sets: named sets of layers to show together. */
  layerSets?: { name: string; layers: string[] }[];
  /** Tools › Parts: the parts made of the pad layers' flashes. */
  parts?: CamPart[];
  /** Tools › Netlist › Extract: the nets found. */
  nets?: CamNet[];
  /** File › Import › Netlist: the netlist to compare with (IPC-D-356): net → points. */
  refNets?: { name: string; points: { at: Vec2; side: 'top' | 'bottom' | 'both'; ref?: string; pin?: string }[] }[];
  /** Edit › Composite Layers › Open Composite for editing: the sub-layer edits go to. */
  openComposite?: { layer: string; sub: number };
}

/* ─── Layer types and colours ───────────────────────────────────────────────────────── */

/** The type a file is, from its X2 .FileFunction or its name (AD's extensions, KiCad's and Eagle's names). */
export function layerTypeOf(name: string, data: GerberLayer | DrillLayer): CamLayerType {
  if (data.kind === 'drill') return 'Drill Top';
  const ff = (data.attributes['.FileFunction'] ?? '').split(',');
  const side = /Top/i.test(ff.join(',')) ? 'Top' : /Bot/i.test(ff.join(',')) ? 'Bottom' : '';
  switch (ff[0]) {
    case 'Copper': return /Inr/i.test(ff[2] ?? '') ? (/Plane/i.test(ff[3] ?? '') ? 'Plane' : 'Internal') : side === 'Bottom' ? 'Bottom' : 'Top';
    case 'Legend': return side === 'Bottom' ? 'Bottom Silk' : 'Top Silk';
    case 'Soldermask': return side === 'Bottom' ? 'Bottom Mask' : 'Top Mask';
    case 'Paste': return side === 'Bottom' ? 'Bottom Paste' : 'Top Paste';
    case 'Profile': return 'Border';
    case 'Drillmap': return 'Drill Drawing';
    case 'Keep-out': return 'Keep Out';
    case 'Other': case 'Mechanical': return 'Mechanical';
    case 'Plated': case 'NonPlated': return 'Drill Top';
  }
  const ext = (/\.([^.]+)$/.exec(name)?.[1] ?? '').toUpperCase();
  const byExt: Record<string, CamLayerType> = {
    GTL: 'Top', GBL: 'Bottom', GTO: 'Top Silk', GBO: 'Bottom Silk', GTS: 'Top Mask', GBS: 'Bottom Mask', GTP: 'Top Paste', GBP: 'Bottom Paste',
    GKO: 'Keep Out', GD1: 'Drill Drawing', GG1: 'Drill Guide', GM1: 'Mechanical', GML: 'Border', GPB: 'Bottom Paste', GPT: 'Top Paste',
    CMP: 'Top', SOL: 'Bottom', PLC: 'Top Silk', PLS: 'Bottom Silk', STC: 'Top Mask', STS: 'Bottom Mask', CRC: 'Top Paste', CRS: 'Bottom Paste',
  };
  if (byExt[ext]) return byExt[ext]!;
  if (/^G\d+$/.test(ext)) return 'Internal';
  if (/^GP\d+$/.test(ext)) return 'Plane';
  if (/^GM\d+$/.test(ext)) return 'Mechanical';
  if (/^GD\d+$/.test(ext)) return 'Drill Drawing';
  const n = name.toLowerCase();
  const kicad: [RegExp, CamLayerType][] = [[/f[._]cu/, 'Top'], [/b[._]cu/, 'Bottom'], [/in\d+[._]cu/, 'Internal'], [/f[._]silks?/, 'Top Silk'], [/b[._]silks?/, 'Bottom Silk'],
    [/f[._]mask/, 'Top Mask'], [/b[._]mask/, 'Bottom Mask'], [/f[._]paste/, 'Top Paste'], [/b[._]paste/, 'Bottom Paste'], [/edge[._]cuts|outline|profile/, 'Border']];
  for (const [re, t] of kicad) if (re.test(n)) return t;
  return 'Undefined';
}

/** CAMtastic's colours by layer type [est: AD's own defaults]. */
const COLOURS: Record<CamLayerType, string> = {
  Top: '#ff0000', Bottom: '#0000ff', Internal: '#c0c020', Plane: '#00a000', 'Top Silk': '#ffff00', 'Bottom Silk': '#808000',
  'Top Mask': '#800080', 'Bottom Mask': '#a040a0', 'Top Paste': '#808080', 'Bottom Paste': '#a0a0a0',
  'Drill Top': '#00c0c0', 'Drill Drawing': '#ff8000', 'Drill Guide': '#c06000', Border: '#ffffff', Mechanical: '#ff00ff', 'Keep Out': '#ff80c0', Undefined: '#c0c0c0',
};
export const colourOf = (t: CamLayerType): string => COLOURS[t];

/** The stacking order CAMtastic draws them in (bottom first, so the top side is on top). */
const ORDER: CamLayerType[] = ['Border', 'Mechanical', 'Keep Out', 'Bottom Paste', 'Bottom Silk', 'Bottom Mask', 'Bottom', 'Plane', 'Internal', 'Top', 'Top Mask', 'Top Silk', 'Top Paste', 'Drill Guide', 'Drill Drawing', 'Drill Top', 'Undefined'];
export const stackRank = (t: CamLayerType): number => ORDER.indexOf(t);

/* ─── Loading ──────────────────────────────────────────────────────────────────────── */

/** A fabrication file as a layer; null when it isn't Gerber or Excellon. */
export function camLayerFrom(name: string, text: string, def: { gerber?: ReadDefaults; drill?: ReadDefaults } = {}): CamLayer | null {
  const what = sniffCamFile(text) ?? (/\.(drl|xln|txt|nc|tap|drd)$/i.test(name) ? 'drill' : /\.(gbr|ger|pho|art|g[a-z0-9]{1,3})$/i.test(name) ? 'gerber' : null);
  if (!what) return null;
  const data = what === 'drill' ? readDrill(text, def.drill) : readGerber(text, def.gerber);
  // Gerber or drill by its name only, and nothing in it: not one
  if (!sniffCamFile(text) && (data.kind === 'gerber' ? !data.objects.length : !data.hits.length && !data.routes.length)) return null;
  const type = layerTypeOf(name, data);
  const l: CamLayer = { name, type, colour: colourOf(type), visible: true, text, data };
  // Drilled text (M97 / M98): the hits it makes, grouped
  if (data.kind === 'drill' && data.texts?.length) {
    l.groups = new Map();
    let k = 1;
    for (const t of data.texts) {
      const grp = k++;
      t.grp = grp;
      const tool = t.tool ?? [...data.tools.keys()][0] ?? 1;
      l.groups.set(grp, { kind: 'drilltext', text: t.text, at: t.at, height: t.height, ...(t.vertical ? { vertical: true } : {}) });
      data.hits.push(...drillTextHits(t.text, t.at, t.height, !!t.vertical, tool, data.tools.get(tool) ?? 0, grp));
    }
  }
  return l;
}

/** Layers in CAMtastic's stack order (a file's place among those of its type kept). */
export function sortLayers(layers: CamLayer[]): CamLayer[] {
  return layers.map((l, i) => ({ l, i })).sort((a, b) => stackRank(a.l.type) - stackRank(b.l.type) || a.i - b.i).map((x) => x.l);
}

export function newCamDocument(name: string, layers: CamLayer[] = []): CamDocument {
  return { kind: 'CamDoc', name, layers: sortLayers(layers), current: 0, dirty: false };
}

/* ─── The .Cam file ────────────────────────────────────────────────────────────────── */

const MAGIC = 'konium-cam';

type CamJsonLayer = {
  name: string; type: CamLayerType; colour: string; visible: boolean; text: string; erased?: number[];
  /** The groups, and each written object's (or hit's) group in the order a reader gets them back. */
  groups?: [number, CamGroup][]; tags?: number[]; composite?: CamSub[];
  /** A composite's objects' sub-layers, in the order a reader gets them back. */
  subs?: number[];
};

/** The document as Konium's .Cam (JSON): each layer's file (regenerated when edited), its look, groups and sub-layers; the document's origin, film box, layer sets, parts and nets. */
export function writeCam(d: CamDocument): string {
  const layers = d.layers.map((l): CamJsonLayer => {
    const base = { name: l.name, type: l.type, colour: l.colour, visible: l.visible };
    // Drilled text comes back from its M97 / M98 lines; other groups are kept with their members' tags
    const groups = [...(l.groups ?? [])].filter(([, g]) => g.kind !== 'drilltext');
    const comp = l.composite?.length ? { composite: l.composite } : {};
    if (!regenerated(l) && !l.composite?.length) return { ...base, text: l.text, ...(groups.length ? { groups } : {}) };
    const w = l.data.kind === 'gerber' ? writeGerberOrdered(l) : writeDrillOrdered(l);
    const list: { grp?: number }[] = l.data.kind === 'gerber' ? l.data.objects : l.data.hits;
    const keep = new Set(groups.map(([k]) => k));
    const tags = w.order.map((i) => { const t = list[i]?.grp ?? 0; return keep.has(t) ? t : 0; });
    const subs = l.composite?.length && l.data.kind === 'gerber' ? w.order.map((i) => (l.data as GerberLayer).objects[i]?.sub ?? 0) : undefined;
    return { ...base, text: w.text, ...(groups.length ? { groups, ...(tags.some((t) => t) ? { tags } : {}) } : {}), ...comp, ...(subs ? { subs } : {}) };
  });
  const extra = {
    ...(d.origin ? { origin: d.origin } : {}), ...(d.filmBox ? { filmBox: d.filmBox } : {}), ...(d.layerSets?.length ? { layerSets: d.layerSets } : {}),
    ...(d.parts?.length ? { parts: d.parts } : {}), ...(d.nets?.length ? { nets: d.nets } : {}), ...(d.refNets?.length ? { refNets: d.refNets } : {}),
  };
  return `${JSON.stringify({ format: MAGIC, version: 2, current: d.current, ...extra, layers }, null, 1)}\n`;
}

export function isCamText(text: string): boolean { return text.slice(0, 200).includes(`"format": "${MAGIC}"`) || text.slice(0, 200).includes(`"format":"${MAGIC}"`); }

export function readCam(text: string, name: string): CamDocument {
  const j = JSON.parse(text) as { format: string; current?: number; layers: (CamJsonLayer & { erased?: number[] })[] } & Partial<Pick<CamDocument, 'origin' | 'filmBox' | 'layerSets' | 'parts' | 'nets' | 'refNets'>>;
  if (j.format !== MAGIC) throw new Error(`${name} isn't a CAM document Konium Designer wrote`);
  const layers: CamLayer[] = [];
  for (const l of j.layers ?? []) {
    const base = camLayerFrom(l.name, l.text);
    if (!base) continue;
    const layer: CamLayer = { ...base, type: CAM_LAYER_TYPES.includes(l.type) ? l.type : base.type, colour: l.colour || base.colour, visible: l.visible !== false, ...(l.erased?.length ? { erased: l.erased } : {}) };
    if (l.groups?.length) {
      layer.groups = new Map([...(layer.groups ?? []), ...l.groups]);
      const list: { grp?: number }[] = layer.data.kind === 'gerber' ? layer.data.objects : layer.data.hits;
      if (l.tags) l.tags.forEach((t, i) => { if (t && list[i] && !list[i]!.grp) list[i] = { ...list[i]!, grp: t }; });
    }
    if (l.composite?.length) {
      layer.composite = l.composite.map((c) => ({ name: c.name, dark: c.dark }));
      if (layer.data.kind === 'gerber' && l.subs) { const objs = layer.data.objects; l.subs.forEach((v, i) => { if (v && objs[i]) objs[i] = { ...objs[i]!, sub: v }; }); }
    }
    layers.push(layer);
  }
  const d: CamDocument = { kind: 'CamDoc', name, layers, current: Math.min(Math.max(0, j.current ?? 0), Math.max(0, layers.length - 1)), dirty: false };
  for (const k of ['origin', 'filmBox', 'layerSets', 'parts', 'nets', 'refNets'] as const) if (j[k] !== undefined) (d as unknown as Record<string, unknown>)[k] = j[k];
  return d;
}

/* ─── Extents and measures ─────────────────────────────────────────────────────────── */

/** A Gerber object's extent (with its aperture). */
export function objectBox(o: GerberObject, apW: (code: number) => number): BBox {
  const pts: Vec2[] = o.kind === 'draw' ? [o.a, o.b] : o.kind === 'arc' ? [o.a, o.b] : o.kind === 'flash' ? [o.at] : o.contours.flat();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  if (o.kind === 'arc') {
    const r = Math.hypot(o.a.x - o.c.x, o.a.y - o.c.y);
    minX = Math.min(minX, o.c.x - r); minY = Math.min(minY, o.c.y - r); maxX = Math.max(maxX, o.c.x + r); maxY = Math.max(maxY, o.c.y + r);
  }
  const w = o.kind === 'region' ? 0 : apW(o.ap) / 2;
  return { minX: minX - w, minY: minY - w, maxX: maxX + w, maxY: maxY + w };
}

/** Every visible layer's extent together (View › Zoom All). */
export function camExtent(d: CamDocument, visibleOnly = true): BBox | null {
  let box: BBox | null = null;
  const grow = (b: BBox) => { box = box ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) } : { ...b }; };
  for (const l of d.layers) {
    if (visibleOnly && !l.visible) continue;
    const erased = new Set(l.erased ?? []);
    if (l.data.kind === 'gerber') { const g = l.data; g.objects.forEach((o, i) => { if (!erased.has(i)) grow(objectBox(o, (c) => Math.max(g.apertures.get(c)?.w ?? 0, g.apertures.get(c)?.h ?? 0))); }); }
    else {
      const dr = l.data;
      dr.hits.forEach((h, i) => { if (!erased.has(i)) grow(hitBox(dr, h)); });
      for (const r of dr.routes) {
        const w = (dr.tools.get(r.tool) ?? 0) / 2;
        const pts = r.circle ? [{ x: r.circle.c.x - r.circle.r, y: r.circle.c.y - r.circle.r }, { x: r.circle.c.x + r.circle.r, y: r.circle.c.y + r.circle.r }] : r.path;
        for (const p of pts) grow({ minX: p.x - w, minY: p.y - w, maxX: p.x + w, maxY: p.y + w });
      }
    }
  }
  return box;
}
