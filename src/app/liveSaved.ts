/**
 * What a sheet keeps of its Live Simulation from one session to the next (26.186): the monitors
 * kept on it, the scopes side by side with what each draws and how, and whether a run starts with
 * everything discharged. It is the text of one parameter of the sheet, LiveSimulation, so it is
 * saved with the file, comes back with it (through the desktop software too, which keeps a
 * document's parameters), and a change to it is undone like any other change to the sheet.
 *
 *   v=1;scopes=time,spectrum;zero=1;keep=R1>1,1200:3400>2,C3>0
 *
 * `scopes`: each scope's view, left to right. `keep`: each monitor's place, a two-pin part by its
 * designator or a point of a wire or pin in mils, and after the `>` the scope that draws it (its
 * place in the list, from 1; 0: on the sheet only). A sheet with nothing kept, one scope against
 * time and a run from its operating point has no such parameter.
 */
import type { Vec2 } from '../core/geom';

export type SavedView = 'time' | 'spectrum' | 'response';
export interface LiveSaved {
  /** Each scope's view, in order (the scopes after the last one that draws a monitor or has a view of its own are not kept). */
  views: SavedView[];
  /** A run starts with everything discharged. */
  zero: boolean;
  /** The monitors: where each was taken, and the scope that draws it (1 for the first; 0: on the sheet only). */
  keep: { from: { at: Vec2 } | { part: string }; scope: number }[];
}
/** The parameter's name. */
export const LIVE_SAVED = 'LiveSimulation';
const VIEWS: readonly SavedView[] = ['time', 'spectrum', 'response'];
/** Document units to a mil. */
const MIL = 10_000;
const mils = (v: number): string => String(Math.round(v / MIL * 100) / 100);

/** The parameter's text ('' where there is nothing worth keeping). */
export function liveSavedText(s: LiveSaved): string {
  // The scopes after the last one that matters are whatever a run gives the sheet anyway
  let n = s.views.length;
  while (n > 0 && s.views[n - 1] === 'time' && !s.keep.some((k) => k.scope === n)) n--;
  const parts: string[] = [];
  if (n > 0) parts.push(`scopes=${s.views.slice(0, n).join(',')}`);
  if (s.zero) parts.push('zero=1');
  if (s.keep.length) parts.push(`keep=${s.keep.map((k) => `${'part' in k.from ? encodeURIComponent(k.from.part) : `${mils(k.from.at.x)}:${mils(k.from.at.y)}`}>${k.scope}`).join(',')}`);
  return parts.length ? `v=1;${parts.join(';')}` : '';
}

/** The parameter read: null where it is empty or not one of these (a later version's, something typed over it). */
export function readLiveSaved(text: string): LiveSaved | null {
  const fields = new Map(text.split(';').map((p): [string, string] => { const i = p.indexOf('='); return i < 0 ? [p.trim(), ''] : [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()]; }));
  if (fields.get('v') !== '1') return null;
  const views = (fields.get('scopes') ?? '').split(',').map((v) => v.trim().toLowerCase()).filter((v): v is SavedView => (VIEWS as readonly string[]).includes(v)).slice(0, 6);
  const keep: LiveSaved['keep'] = [];
  for (const item of (fields.get('keep') ?? '').split(',')) {
    const i = item.lastIndexOf('>');
    if (i <= 0) continue;
    const place = item.slice(0, i).trim(), scope = Number(item.slice(i + 1));
    if (!Number.isInteger(scope) || scope < 0 || scope > 6) continue;
    const xy = /^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/.exec(place);
    if (xy) keep.push({ from: { at: { x: Math.round(Number(xy[1]) * MIL), y: Math.round(Number(xy[2]) * MIL) } }, scope });
    else { try { const part = decodeURIComponent(place); if (part) keep.push({ from: { part }, scope }); } catch { /* not a name */ } }
  }
  return { views, zero: fields.get('zero') === '1', keep: keep.slice(0, 24) };
}

/** Two of these keep the same monitors and scopes (how a run starts apart). */
export const sameWatch = (a: LiveSaved | null, b: LiveSaved | null): boolean => liveSavedText({ views: a?.views ?? [], keep: a?.keep ?? [], zero: false }) === liveSavedText({ views: b?.views ?? [], keep: b?.keep ?? [], zero: false });
