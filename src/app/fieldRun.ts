/** Tools › Field Solver, behind its panel: the cross-section as typed, taken from the board's stack, solved. */
import { signal } from '@preact/signals';
import type { PcbDocument } from '../model/pcb';
import type { LayerId } from '../model/layers';
import { readStack } from '../model/pcbStack';
import { METRE } from '../analysis/copperNet';
import { fieldPicture, solveLine, widthFor, type LineKind, type LineResult, type LineSetup } from '../analysis/field2d';
import { notify, tick } from './state';

/** The panel's fields as typed: lengths in `unit`. */
export interface LineForm {
  kind: LineKind; pair: boolean; coplanar: boolean; unit: 'mm' | 'mil';
  width: string; gap: string; side: string; thickness: string;
  /** The dielectric under the track; the dielectric over it (embedded: its cover; stripline: up to the upper plane), measured from the track's top. */
  h1: string; er1: string; above: string; er2: string;
  mask: boolean; maskT: string; maskEr: string;
  /** How much narrower the top is than the foot. */
  etch: string;
  target: string; detail: 'normal' | 'fine';
}
export const defaultLineForm = (): LineForm => ({ kind: 'microstrip', pair: false, coplanar: false, unit: 'mm', width: '0.36', gap: '0.2', side: '0.2', thickness: '0.035', h1: '0.2', er1: '4.3', above: '0.2', er2: '4.3',
  mask: false, maskT: '0.02', maskEr: '3.5', etch: '0', target: '50', detail: 'normal' });

const KEY = 'konium.field';
const num = (s: string, fallback: number) => { const v = parseFloat(s.replace(',', '.')); return Number.isFinite(v) ? v : fallback; };

export function readLineForm(): LineForm {
  try { const raw = globalThis.localStorage?.getItem(KEY); if (raw) { const o = JSON.parse(raw) as Partial<LineForm>; if (o && typeof o === 'object') return { ...defaultLineForm(), ...o }; } } catch { /* nothing kept */ }
  return defaultLineForm();
}
export function saveLineForm(f: LineForm): void { try { globalThis.localStorage?.setItem(KEY, JSON.stringify(f)); } catch { /* no room */ } }

/** Metres in the form's unit. */
export const unitM = (u: LineForm['unit']): number => (u === 'mil' ? 25.4e-6 : 1e-3);
/** A length in metres as the form shows it. */
export const shown = (m: number, u: LineForm['unit']): string => String(Number((m / unitM(u)).toPrecision(4)));

/** The form as a cross-section, or what is wrong with it. */
export function formLine(f: LineForm): LineSetup | string {
  const k = unitM(f.unit), len = (s: string) => num(s, NaN) * k;
  const width = len(f.width), thickness = len(f.thickness), h1 = len(f.h1), er1 = num(f.er1, NaN);
  if (!(width > 0)) return 'Give the track\'s width.';
  if (!(thickness > 0)) return 'Give the copper\'s thickness.';
  if (!(h1 > 0 && er1 >= 1)) return 'Give the height and the constant of the dielectric under the track.';
  const out: LineSetup = { kind: f.kind, width, thickness, h1, er1 };
  if (f.kind !== 'microstrip') {
    const above = len(f.above), er2 = num(f.er2, NaN);
    if (!(above > 0 && er2 >= 1)) return 'Give the height and the constant of the dielectric over the track.';
    out.h2 = above + thickness; out.er2 = er2;
  } else if (f.mask) {
    const t = len(f.maskT), er = num(f.maskEr, NaN);
    if (!(t > 0 && er >= 1)) return 'Give the solder mask\'s thickness and constant.';
    out.mask = { thickness: t, er };
  }
  if (f.pair) { const g = len(f.gap); if (!(g > 0)) return 'Give the gap between the two tracks.'; out.pair = g; }
  if (f.coplanar) { const g = len(f.side); if (!(g > 0)) return 'Give the gap to the grounds beside the track.'; out.coplanar = g; }
  const etch = len(f.etch);
  if (etch > 0) { if (etch >= width) return 'The top cannot be narrower than nothing: the etch is as much as the width.'; out.etch = etch; }
  return out;
}

/** What the board's stack says of a signal layer, as form fields: an outer layer a microstrip (with the solder mask the stack has), an inner one a stripline between its neighbours. */
export function lineFromStack(doc: PcbDocument, layer: LayerId, unit: LineForm['unit']): Partial<LineForm> | null {
  const rows = doc.board.bag ? readStack(doc.board.bag, doc.board.copperStack) : [], at = rows.findIndex((r) => (r.kind === 'signal' || r.kind === 'plane') && r.layer === layer);
  if (at < 0) return null;
  /** The dielectric from a row to the next copper: its height, and the constant that gives the same capacitance. */
  const between = (dir: 1 | -1) => {
    let h = 0, hOverE = 0, copper = false;
    for (let k = at + dir; k >= 0 && k < rows.length; k += dir) {
      const r = rows[k]!;
      if (r.kind === 'signal' || r.kind === 'plane') { copper = true; break; }
      if (r.kind === 'dielectric' && r.height > 0) { h += r.height; hOverE += r.height / Math.max(r.dielConst, 1); }
    }
    return copper && h > 0 ? { h: h * METRE, er: h / hOverE } : null;
  };
  const mask = (dir: 1 | -1) => { const r = rows[at + dir]; return r?.kind === 'solder' && r.height > 0 ? { t: r.height * METRE, er: Math.max(r.dielConst, 1) } : null; };
  const below = between(1), over = between(-1), t = rows[at]!.copper * METRE, out: Partial<LineForm> = { thickness: shown(t > 0 ? t : 35e-6, unit) };
  if (below && over) return { ...out, kind: 'stripline', h1: shown(below.h, unit), er1: String(Number(below.er.toPrecision(3))), above: shown(over.h, unit), er2: String(Number(over.er.toPrecision(3))), mask: false };
  const inner = below ?? over, m = below ? mask(-1) : mask(1);
  if (!inner) return null;
  return { ...out, kind: 'microstrip', h1: shown(inner.h, unit), er1: String(Number(inner.er.toPrecision(3))), mask: !!m, ...(m ? { maskT: shown(m.t, unit), maskEr: String(Number(m.er.toPrecision(3))) } : {}) };
}

export interface FieldRun { setup: LineSetup; result: LineResult; picture: ReturnType<typeof fieldPicture>; ms: number }
export const fieldRun = signal<FieldRun | null>(null);
export const fieldBusy = signal<string | null>(null);

const detailOf = (f: LineForm) => (f.detail === 'fine' ? 14 : 8);

export async function runField(f: LineForm): Promise<void> {
  if (fieldBusy.value) return;
  const setup = formLine(f);
  if (typeof setup === 'string') { notify(setup, 'error'); return; }
  fieldBusy.value = 'Solving…';
  await new Promise<void>((r) => setTimeout(r, 0));
  const t0 = performance.now();
  try {
    fieldRun.value = { setup, result: solveLine(setup, detailOf(f)), picture: fieldPicture(setup, 8), ms: performance.now() - t0 };
  } catch (e) { notify(`Field Solver: ${e instanceof Error ? e.message : String(e)}`, 'error'); } finally { fieldBusy.value = null; tick.value++; }
}

/** The width that gives the form's target, as the form's text (null: the form is not whole). */
export async function findWidth(f: LineForm): Promise<string | null> {
  if (fieldBusy.value) return null;
  const setup = formLine(f), target = num(f.target, NaN);
  if (typeof setup === 'string') { notify(setup, 'error'); return null; }
  if (!(target > 0)) { notify('Give the impedance wanted.', 'error'); return null; }
  fieldBusy.value = 'Finding the width…';
  await new Promise<void>((r) => setTimeout(r, 0));
  try { return shown(widthFor(setup, target), f.unit); } catch (e) { notify(`Field Solver: ${e instanceof Error ? e.message : String(e)}`, 'error'); return null; } finally { fieldBusy.value = null; tick.value++; }
}
