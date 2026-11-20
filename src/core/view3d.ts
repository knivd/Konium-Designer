/**
 * The 3D view configuration: View Configurations › Physical Materials as Altium Designer 17
 * has it for 3D Layout Mode. General (workspace colour and gradient, board thickness scale,
 * origin marker, cut-outs, projection), Colours and Visibility (realistic colours or the
 * layers' own; copper, core, silkscreen and solder mask on each side with their opacity) and
 * 3D Bodies (simple and generic bodies, snap point markers, axes). The named configurations
 * are the ones AD17 ships for 3D [est: their colours].
 */
export type BodyShow = 'no' | 'yes' | 'system';
export interface View3D {
  /** The configuration these settings came from ('' after changes of one's own). */
  config: string;
  workspace: string;
  /** −100…100: the workspace from lighter at the top (positive) to lighter at the bottom; 0 none. */
  gradient: number;
  /** Board Thickness: 1× (as built) to 100× in Z. */
  zScale: number;
  showOrigin: boolean;
  showCutouts: boolean;
  /** Rooms as see-through boxes on their side of the board. */
  showRooms: boolean;
  /** The board milled along what is drawn on Board Options' Route Tool Path layer. */
  showRoutePath: boolean;
  projection: 'perspective' | 'orthographic';
  colouring: 'realistic' | 'layers';
  copper: string;
  coreShow: boolean; core: string; coreOpacity: number;
  silkTopShow: boolean; silkTop: string; silkTopOpacity: number;
  silkBottomShow: boolean; silkBottom: string; silkBottomOpacity: number;
  maskTopShow: boolean; maskTop: string; maskTopOpacity: number;
  maskBottomShow: boolean; maskBottom: string; maskBottomOpacity: number;
  simpleBodies: BodyShow;
  genericBodies: BodyShow;
  snapMarkers: boolean;
  axes: boolean;
  /** Components with both simple and generic bodies. */
  both: 'simple' | 'generic' | 'both';
}

const base = (config: string, mask: string, silk: string): View3D => ({
  config, workspace: '#0f1513', gradient: 30, zScale: 1, showOrigin: false, showCutouts: true, showRooms: false, showRoutePath: true, projection: 'perspective',
  colouring: 'realistic', copper: '#d6ae4f',
  coreShow: true, core: '#c7b885', coreOpacity: 100,
  silkTopShow: true, silkTop: silk, silkTopOpacity: 100,
  silkBottomShow: true, silkBottom: silk, silkBottomOpacity: 100,
  maskTopShow: true, maskTop: mask, maskTopOpacity: 92,
  maskBottomShow: true, maskBottom: mask, maskBottomOpacity: 92,
  simpleBodies: 'system', genericBodies: 'system', snapMarkers: true, axes: false, both: 'generic',
});

/** AD17's 3D view configurations [est: mask and silk colours]. */
export const VIEW3D_PRESETS: View3D[] = [
  base('3D Black', '#141414', '#f2f2ec'),
  base('3D Blue', '#0a2a6e', '#f2f2ec'),
  base('3D Brown', '#6b3a0c', '#f2f2ec'),
  base('3D Dk Green', '#004624', '#f2f2ec'),
  base('3D Lt Grey', '#b4b8b6', '#1a1a1a'),
  base('3D White', '#ecece6', '#1a1a1a'),
];
export const VIEW3D_DEFAULT: View3D = VIEW3D_PRESETS.find((p) => p.config === '3D Dk Green')!;

/** Solder mask colours boards are made in. */
export const MASK_COLOURS: [string, string][] = [
  ['Green', '#004624'], ['Matte Green', '#1d5a32'], ['Red', '#8c1010'], ['Blue', '#0a2a6e'], ['Black', '#141414'],
  ['White', '#ecece6'], ['Yellow', '#d9b40c'], ['Purple', '#4a1f6e'],
];
/** Surface finishes. */
export const FINISHES: [string, string][] = [['Gold (ENIG)', '#d6ae4f'], ['Silver (HASL)', '#c8c8c4'], ['Copper (OSP)', '#c9783e']];

/** The settings with every field present and in range (what a file or an earlier build gave, filled in). */
export function view3dFrom(v: unknown, d: View3D = VIEW3D_DEFAULT): View3D {
  const out = { ...d } as unknown as Record<string, unknown>;
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const dv = (d as unknown as Record<string, unknown>)[k];
      if (dv !== undefined && typeof dv === typeof x) out[k] = x;
    }
  }
  const o = out as unknown as View3D;
  const pct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  for (const k of ['coreOpacity', 'silkTopOpacity', 'silkBottomOpacity', 'maskTopOpacity', 'maskBottomOpacity'] as const) o[k] = pct(o[k]);
  o.gradient = Math.max(-100, Math.min(100, Math.round(o.gradient)));
  o.zScale = Math.max(1, Math.min(100, o.zScale));
  for (const k of ['workspace', 'copper', 'core', 'silkTop', 'silkBottom', 'maskTop', 'maskBottom'] as const) if (!/^#[0-9a-f]{6}$/i.test(o[k])) o[k] = d[k];
  if (o.projection !== 'orthographic') o.projection = 'perspective';
  if (o.colouring !== 'layers') o.colouring = 'realistic';
  for (const k of ['simpleBodies', 'genericBodies'] as const) if (!['no', 'yes', 'system'].includes(o[k])) o[k] = 'system';
  if (!['simple', 'generic', 'both'].includes(o.both)) o.both = 'generic';
  return o;
}

/** The name the dialog shows: the configuration's, while nothing has been changed from it. */
export function view3dName(v: View3D): string {
  const p = VIEW3D_PRESETS.find((x) => x.config === v.config);
  if (!p) return 'Custom';
  return (Object.keys(p) as (keyof View3D)[]).every((k) => p[k] === v[k]) ? p.config : `${p.config} (changed)`;
}

/* ── colours ── */
export type RGB = [number, number, number];
export const hexRgb = (h: string): RGB => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export const rgbHex = (c: RGB): string => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** How one face of the board looks: the mask over the laminate and over copper, the finish where pads are open, the silk. */
export interface SideLook {
  /** The face where nothing is printed (laminate, under the mask when there is one). */
  laminate: string;
  /** Copper under the mask (or bare, without a mask). */
  copper: string;
  /** Pads open in the mask. */
  finish: string;
  silk: string | null;
  silkAlpha: number;
  cutouts: boolean;
}

/**
 * A side's colours from the settings: the mask laid over the core and over the copper at its
 * opacity [est: copper under a mask reads lighter than laminate, as copper reflects more].
 * By layer: the 2D colours of the side's copper, solder mask and overlay layers.
 */
export function sideLook(v: View3D, side: 'top' | 'bottom', layerHex?: { copper: string; mask: string; silk: string; board: string }): SideLook {
  const top = side === 'top';
  const silkShow = top ? v.silkTopShow : v.silkBottomShow;
  const maskShow = top ? v.maskTopShow : v.maskBottomShow;
  if (v.colouring === 'layers' && layerHex) {
    return { laminate: maskShow ? layerHex.mask : layerHex.board, copper: layerHex.copper, finish: layerHex.copper, silk: silkShow ? layerHex.silk : null, silkAlpha: 1, cutouts: v.showCutouts };
  }
  const core = hexRgb(v.core), cu = hexRgb(v.copper);
  const op = (top ? v.maskTopOpacity : v.maskBottomOpacity) / 100;
  const mask = hexRgb(top ? v.maskTop : v.maskBottom);
  // Bare copper (no mask) is a darker, redder copper than the finish on the pads
  const bare: RGB = mix(cu, [184, 115, 51], 0.55);
  let laminate: RGB = core, copper: RGB = bare;
  if (maskShow && op > 0) {
    laminate = mix(core, mask, op);
    const lift = 1.25 + 0.35 * (1 - op);
    const under = mix(laminate, cu, 0.1 + 0.6 * (1 - op));
    copper = [under[0] * lift, under[1] * lift, under[2] * lift];
  }
  return {
    laminate: rgbHex(laminate), copper: rgbHex(copper), finish: v.copper,
    silk: silkShow ? (top ? v.silkTop : v.silkBottom) : null,
    silkAlpha: (top ? v.silkTopOpacity : v.silkBottomOpacity) / 100,
    cutouts: v.showCutouts,
  };
}

/** How opaque a side is where only laminate and mask are (the core and the mask over it). */
export function baseOpacity(v: View3D, side: 'top' | 'bottom'): number {
  const core = v.coreShow ? v.coreOpacity / 100 : 0;
  const mask = (side === 'top' ? v.maskTopShow : v.maskBottomShow) ? (side === 'top' ? v.maskTopOpacity : v.maskBottomOpacity) / 100 : 0;
  return 1 - (1 - core) * (1 - mask);
}

/** The workspace's two ends (top, bottom) for the gradient. */
export function workspaceEnds(v: View3D): [RGB, RGB] {
  const c = hexRgb(v.workspace), k = Math.abs(v.gradient) / 100;
  const light = mix(c, [255, 255, 255], 0.45 * k), dark = mix(c, [0, 0, 0], 0.35 * k);
  return v.gradient >= 0 ? [light, dark] : [dark, light];
}
