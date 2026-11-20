/** Tools › Supply Impedance, behind its panel: the set-up kept for each board, and the sweep run without freezing the window. */
import { signal } from '@preact/signals';
import type { PcbEditor } from '../editors/pcb/PcbEditor';
import type { PcbDocument } from '../model/pcb';
import { NO_NET } from '../model/pcb';
import { TYPICAL_ESL, buildPdn, capsBetween, conducted, parseCapacitance, pdnSteps, targetImpedance, typicalEsr, type ConductedResult, type NoiseSetup, type PdnCap, type PdnResult, type PdnSetup } from '../analysis/pdn';
import { readForm as readPowerForm } from './powerRun';
import { notify, tick } from './state';
import { breathe } from '../core/breathe';

/** The panel's fields as typed, kept for each board by its name (nets and parts by name). */
export interface PdnForm {
  supply: string; ground: string; source: string;
  /** The source's resistance (mΩ) and inductance (nH). */
  sourceR: string; sourceL: string;
  /** Each capacitor's value, series resistance (mΩ) and inductance (nH) where typed, by designator. */
  caps: Record<string, { c?: string; esr?: string; esl?: string }>;
  voltage: string; ripple: string; step: string;
  /** The sweep's ends, hertz. */
  from: string; to: string;
  /** The part the curve is looked at from. */
  at: string;
  /** Conducted emission: the switching part, its frequency (kHz), current (A), duty (%) and edges (ns). */
  noisePart: string; noiseF: string; noiseI: string; noiseDuty: string; noiseRise: string;
}

const key = (name: string) => `konium.pdn:${name}`;
const num = (s: string | undefined, fallback: number) => { const v = parseFloat((s ?? '').replace(',', '.')); return Number.isFinite(v) ? v : fallback; };

export function readPdnForm(doc: PcbDocument, name: string): PdnForm {
  const p = readPowerForm(doc, name);
  const base: PdnForm = { supply: p.supply, ground: p.ret, source: p.source, sourceR: '5', sourceL: '20', caps: {}, voltage: p.voltage, ripple: '5', step: '1', from: '10000', to: '2000000000', at: '',
    noisePart: '', noiseF: '500', noiseI: '1', noiseDuty: '50', noiseRise: '10' };
  try {
    const raw = globalThis.localStorage?.getItem(key(name));
    if (raw) { const o = JSON.parse(raw) as Partial<PdnForm>; if (o && typeof o === 'object') return { ...base, ...o, caps: { ...(o.caps ?? {}) } }; }
  } catch { /* nothing kept, or not to be read */ }
  return base;
}
export function savePdnForm(name: string, f: PdnForm): void {
  try { globalThis.localStorage?.setItem(key(name), JSON.stringify(f)); } catch { /* no room: it is only a convenience */ }
}

/** The capacitors between the form's two nets, each with what is typed for it over what its value reads as. */
export function formCaps(doc: PcbDocument, f: PdnForm): (PdnCap & { comment: string; known: boolean })[] {
  const supply = doc.nets.findIndex((n) => n.name === f.supply), ground = doc.nets.findIndex((n) => n.name === f.ground);
  if (supply < 0 || ground < 0) return [];
  return capsBetween(doc, supply, ground).map((k) => {
    const o = f.caps[k.designator] ?? {}, typed = o.c ? parseCapacitance(/[a-zµμ]/i.test(o.c) ? o.c : `${o.c}u`) : NaN, c = Number.isFinite(typed) ? typed : k.c;
    return { ...k, c, esr: o.esr ? num(o.esr, NaN) / 1000 : Number.isFinite(c) ? typicalEsr(c) : NaN, esl: o.esl ? num(o.esl, 1) * 1e-9 : TYPICAL_ESL, known: Number.isFinite(c) && c > 0 };
  });
}

/** The parts with a pad on the supply that are neither its capacitors nor its source: the places to look from, ICs first. */
export function formPorts(doc: PcbDocument, f: PdnForm): { component: number; designator: string }[] {
  const supply = doc.nets.findIndex((n) => n.name === f.supply);
  if (supply < 0) return [];
  const skip = new Set(formCaps(doc, f).map((c) => c.component)), got = new Set<number>();
  for (const p of doc.prims) if (p.kind === 'pad' && p.net === supply && p.component !== NO_NET && !skip.has(p.component) && doc.components[p.component]?.designator !== f.source) got.add(p.component);
  const ic = (d: string) => (/^(U|IC)\d/i.test(d) ? 0 : 1);
  return [...got].map((component) => ({ component, designator: doc.components[component]?.designator ?? String(component) })).sort((a, b) => ic(a.designator) - ic(b.designator) || a.designator.localeCompare(b.designator, undefined, { numeric: true }));
}

/** The form as the analysis's set-up, or what is missing from it. */
export function formPdn(doc: PcbDocument, f: PdnForm): PdnSetup | string {
  const supply = doc.nets.findIndex((n) => n.name === f.supply), ground = doc.nets.findIndex((n) => n.name === f.ground);
  if (supply < 0) return 'Pick the supply net.';
  if (ground < 0 || ground === supply) return 'Pick the ground net.';
  const ports = formPorts(doc, f);
  if (!ports.length) return 'No part draws from the net: there is nowhere to look from.';
  const source = doc.components.findIndex((c) => c.designator === f.source);
  const fMin = num(f.from, 1e4), fMax = num(f.to, 2e9);
  if (!(fMax > fMin && fMin > 0)) return 'Give a range of frequencies.';
  return { supply, ground, caps: formCaps(doc, f).filter((c) => c.known).map(({ component, designator, c, esr, esl }) => ({ component, designator, c, esr: Number.isFinite(esr) ? esr : typicalEsr(c), esl })),
    source: source >= 0 ? { component: source, r: Math.max(num(f.sourceR, 5), 0.01) / 1000, l: Math.max(num(f.sourceL, 20), 0) * 1e-9 } : null, ports: ports.map((p) => p.component), fMin, fMax };
}
export const formTarget = (f: PdnForm): number => targetImpedance(num(f.voltage, 3.3), Math.max(num(f.ripple, 5), 0.01) / 100, Math.max(num(f.step, 1), 1e-6));
export function formNoise(doc: PcbDocument, f: PdnForm): NoiseSetup | null {
  const component = doc.components.findIndex((c) => c.designator === f.noisePart), frequency = num(f.noiseF, 0) * 1e3;
  return component >= 0 && frequency > 0 ? { component, frequency, amplitude: Math.max(num(f.noiseI, 1), 0), duty: Math.min(0.99, Math.max(0.01, num(f.noiseDuty, 50) / 100)), rise: Math.max(num(f.noiseRise, 10), 0) * 1e-9 } : null;
}

export interface PdnRun { ed: PcbEditor; result: PdnResult; target: number; noise: ConductedResult | null; revision: number; ms: number }
export const pdnRun = signal<PdnRun | null>(null);
export const pdnBusy = signal<string | null>(null);

export function currentPdn(ed: PcbEditor | null): PdnRun | null {
  const r = pdnRun.value;
  return r && ed && r.ed === ed && r.revision === ed.undo.revision ? r : null;
}

export async function runPdn(ed: PcbEditor, f: PdnForm): Promise<void> {
  if (pdnBusy.value) return;
  const setup = formPdn(ed.doc, f);
  if (typeof setup === 'string') { notify(setup, 'error'); return; }
  pdnBusy.value = 'Reading the planes…';
  const pause = breathe;
  await pause();
  const t0 = performance.now();
  try {
    const model = buildPdn(ed.doc, setup), steps = pdnSteps(ed.doc, setup, model);
    let last = performance.now(), result: PdnResult;
    for (;;) {
      const s = steps.next();
      if (s.done) { result = s.value; break; }
      if (performance.now() - last < 80) continue;
      pdnBusy.value = `${Math.round(s.value * 100)} %…`;
      await pause();
      last = performance.now();
    }
    const noise = formNoise(ed.doc, f);
    pdnRun.value = { ed, result, target: formTarget(f), noise: noise ? conducted(ed.doc, setup, noise, model) : null, revision: ed.undo.revision, ms: performance.now() - t0 };
  } catch (e) {
    notify(`Supply Impedance: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    pdnBusy.value = null;
    tick.value++;
  }
}
