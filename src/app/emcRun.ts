/** Tools › EMC Check, behind its panel: the rules as set for each board, and the check run on it. */
import { signal } from '@preact/signals';
import type { PcbEditor } from '../editors/pcb/PcbEditor';
import { mm } from '../core/units';
import { DEFAULT_EMC, emcCheck, type EmcResult, type EmcSetup } from '../analysis/emc';
import { notify, tick } from './state';

/** The panel's fields as typed (lengths in millimetres, the frequency in megahertz), kept for each board by its name. */
export interface EmcForm {
  nets: string; frequency: string;
  gaps: boolean; minGap: string;
  edge: boolean; edgeFactor: string; minEdgeRun: string;
  layerChange: boolean; returnVia: string; capDistance: string;
  decoupling: boolean; decouplingDistance: string;
  stitching: boolean;
}
export const defaultEmcForm = (): EmcForm => ({ nets: '', frequency: '1000', gaps: true, minGap: '2.5', edge: true, edgeFactor: '3', minEdgeRun: '5',
  layerChange: true, returnVia: '3', capDistance: '5', decoupling: true, decouplingDistance: '5', stitching: true });

const key = (name: string) => `konium.emc:${name}`;
const num = (s: string, fallback: number) => { const v = parseFloat(s.replace(',', '.')); return Number.isFinite(v) && v > 0 ? v : fallback; };

export function readEmcForm(name: string): EmcForm {
  try {
    const raw = globalThis.localStorage?.getItem(key(name));
    if (raw) { const o = JSON.parse(raw) as Partial<EmcForm>; if (o && typeof o === 'object') return { ...defaultEmcForm(), ...o }; }
  } catch { /* nothing kept, or not to be read */ }
  return defaultEmcForm();
}
export function saveEmcForm(name: string, f: EmcForm): void {
  try { globalThis.localStorage?.setItem(key(name), JSON.stringify(f)); } catch { /* no room: it is only a convenience */ }
}

/** The form as the check's set-up. */
export function formEmc(f: EmcForm): EmcSetup {
  return {
    nets: f.nets.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
    gaps: f.gaps, minGap: mm(num(f.minGap, 2.5)),
    edge: f.edge, edgeFactor: num(f.edgeFactor, DEFAULT_EMC.edgeFactor), minEdgeRun: mm(num(f.minEdgeRun, 5)),
    layerChange: f.layerChange, returnVia: mm(num(f.returnVia, 3)), capDistance: mm(num(f.capDistance, 5)),
    decoupling: f.decoupling, decouplingDistance: mm(num(f.decouplingDistance, 5)),
    stitching: f.stitching, frequency: num(f.frequency, 1000) * 1e6,
  };
}

export interface EmcRun { ed: PcbEditor; result: EmcResult; setup: EmcSetup; revision: number; ms: number }
export const emcRun = signal<EmcRun | null>(null);
export const emcBusy = signal<string | null>(null);

/** The run that belongs to a board as it now stands (null: none, or the board has changed since). */
export function currentEmc(ed: PcbEditor | null): EmcRun | null {
  const r = emcRun.value;
  return r && ed && r.ed === ed && r.revision === ed.undo.revision ? r : null;
}

export async function runEmc(ed: PcbEditor, f: EmcForm): Promise<void> {
  if (emcBusy.value) return;
  emcBusy.value = 'Checking…';
  await new Promise<void>((r) => setTimeout(r, 0));
  const t0 = performance.now();
  try {
    const setup = formEmc(f);
    emcRun.value = { ed, result: emcCheck(ed.doc, setup, (l) => ed.layerLabel(l)), setup, revision: ed.undo.revision, ms: performance.now() - t0 };
  } catch (e) {
    notify(`EMC Check: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    emcBusy.value = null;
    tick.value++;
  }
}
