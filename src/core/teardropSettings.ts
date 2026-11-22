/**
 * The settings of Tools › Teardrops: kept apart from the geometry so that the settings module
 * can read them without drawing in the board model.
 */
export interface TeardropSettings {
  style: 'curved' | 'line';
  /** Teardrops made even where they break a clearance. */
  force: boolean;
  /** A teardrop made smaller where there is no room for it at the size asked. */
  adjust: boolean;
  report: boolean;
  /** Via or through-hole pad: per cent of its diameter. */
  viaPad: { on: boolean; length: number; width: number };
  /** SMD pad: per cent of the track's width. */
  smd: { on: boolean; width: number; length: number };
  /** A track's change of width: per cent of the wider track's width. */
  tracks: { on: boolean; length: number };
  /** A track ending on another: per cent of the other's width (the span along it, the height up the track that ends). */
  tJunction: { on: boolean; span: number; height: number };
}
/** The desktop software's own first settings. */
export const TEARDROP_DEFAULTS: TeardropSettings = {
  style: 'curved', force: true, adjust: true, report: false,
  viaPad: { on: true, length: 30, width: 70 }, smd: { on: true, width: 200, length: 100 }, tracks: { on: true, length: 100 }, tJunction: { on: true, span: 300, height: 100 },
};
/** Each per cent kept within what makes a teardrop at all. */
export function cleanTeardropSettings(v: unknown): TeardropSettings {
  const d = TEARDROP_DEFAULTS, o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const pct = (x: unknown, fallback: number, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : fallback);
  const part = (k: string) => (o[k] && typeof o[k] === 'object' ? o[k] : {}) as Record<string, unknown>;
  const on = (x: unknown, fallback: boolean) => (typeof x === 'boolean' ? x : fallback);
  const via = part('viaPad'), smd = part('smd'), tr = part('tracks'), tj = part('tJunction');
  return {
    style: o.style === 'line' ? 'line' : 'curved', force: on(o.force, d.force), adjust: on(o.adjust, d.adjust), report: on(o.report, d.report),
    viaPad: { on: on(via.on, true), length: pct(via.length, d.viaPad.length, 1, 300), width: pct(via.width, d.viaPad.width, 1, 99) },
    smd: { on: on(smd.on, true), width: pct(smd.width, d.smd.width, 101, 1000), length: pct(smd.length, d.smd.length, 1, 1000) },
    tracks: { on: on(tr.on, true), length: pct(tr.length, d.tracks.length, 1, 1000) },
    tJunction: { on: on(tj.on, true), span: pct(tj.span, d.tJunction.span, 101, 2000), height: pct(tj.height, d.tJunction.height, 1, 1000) },
  };
}
