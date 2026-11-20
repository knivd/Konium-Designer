/**
 * Signal Integrity's setup as the project keeps it, and what the design tells it: Setup Options
 * (track impedance, average track length, the default IC technology, supply nets), each part's
 * model and type (Model Assignments), the screening tolerances, the stimulus and the panel's
 * terminations — in the project file's "Konium Signal Integrity" section [est: AD keeps its own
 * setup elsewhere] — and from the schematic: each pin's electrical type, the parts' SI models
 * (Type, Tech) and passives' values. The provider the DRC and the panel ask for a board.
 */
import { iniSection, iniSetSection, type PrjPcb } from '../formats/altium/prjpcb';
import { compileProject, type CompiledProject, type SheetInput } from '../model/compile';
import { ownedBy } from '../model/sch';
import { siModelOf } from '../model/siModels';
import type { PcbDocument } from '../model/pcb';
import { setSiProvider, type SiProvided } from '../si/analyse';
import { modelLine, parseModelLine, technology, valueOf, type IcModel } from '../si/models';
import { DEFAULT_STIMULUS, siNum, siText, type SiLimit, type SiLimits, type Stimulus } from '../si/rules';
import type { TermKind, TermValues } from '../si/screen';
import { SI_TYPES, typeByDesignator, type SiContext, type SiType } from '../si/topology';
import { activeProject, compileOptions, projectSheets } from './project';
import { docs, markProjectDirty, projects, type Project } from './state';
import { mil, parseLength, formatAltiumLength } from '../core/units';

const SECTION = 'Konium Signal Integrity';

export interface SiProjectSetup {
  /** Setup Options: for lines the board doesn't give (Ω), their average length (board units). */
  trackZ: number; avgLength: number;
  /** ICs without a model of their own. */
  tech: string;
  /** Supply nets beyond the board's Supply Nets rules and those named so (name, volts). */
  supplies: [string, number][];
  /** Model Assignments: an IC's model, a part's type (by designator, upper case). */
  models: Map<string, IcModel>;
  types: Map<string, SiType>;
  /** The panel's tolerances (where no rule on the board sets one). */
  tolerances: SiLimits;
  stimulus: Stimulus;
  /** The panel's terminations: tried or not, their values (absent: suggested). */
  terms: Map<TermKind, { on: boolean; values: TermValues }>;
}

/** AD's screening tolerances when nothing else sets them [est: overshoot and undershoot 1 V, the rest unchecked]. */
export const DEFAULT_TOLERANCES: SiLimits = { overshootFalling: 1, overshootRising: 1, undershootFalling: 1, undershootRising: 1 };

export const defaultSiSetup = (): SiProjectSetup => ({
  trackZ: 50, avgLength: mil(2000), tech: 'CMOS-3.3V', supplies: [], models: new Map(), types: new Map(),
  tolerances: { ...DEFAULT_TOLERANCES }, stimulus: { ...DEFAULT_STIMULUS }, terms: new Map(),
});

/** Free documents (no project) keep theirs for the session. */
const loose = new Map<string, SiProjectSetup>();

export function readSiSetup(p: Project | null, key = ''): SiProjectSetup {
  if (!p) return loose.get(key) ?? defaultSiSetup();
  return readSection(p.prj);
}

export function readSection(prj: PrjPcb): SiProjectSetup {
  const s = defaultSiSetup();
  const sec = iniSection(prj, SECTION);
  if (!sec) return s;
  const get = (k: string) => sec.entries.find(([x]) => x.toLowerCase() === k.toLowerCase())?.[1];
  const z = Number(get('TrackImpedance'));
  if (z > 0) s.trackZ = z;
  const len = parseLength(get('AverageTrackLength') ?? '');
  if (len !== undefined && len > 0) s.avgLength = len;
  if (get('Technology')) s.tech = technology(get('Technology')!).name;
  for (const [k, v] of sec.entries) {
    if (/^SupplyNet\d+$/i.test(k)) { const [n, volts] = v.split('|'); const x = Number(volts); if (n && Number.isFinite(x)) s.supplies.push([n, x]); }
    else if (/^Model\d+$/i.test(k)) { const i = v.indexOf('|'); const m = i > 0 ? parseModelLine(v.slice(i + 1)) : null; if (m) s.models.set(v.slice(0, i).toUpperCase(), m); }
    else if (/^Type\d+$/i.test(k)) { const [d, t] = v.split('|'); if (d && SI_TYPES.includes(t as SiType)) s.types.set(d.toUpperCase(), t as SiType); }
  }
  const tol = get('Tolerances');
  if (tol !== undefined) {
    s.tolerances = {};
    for (const part of tol.split(';')) { const [k, v] = part.split(':'); const x = siNum(v); if (k && Number.isFinite(x)) s.tolerances[k as SiLimit] = x; }
  }
  const st = get('Stimulus')?.split('|');
  if (st && st.length === 5) {
    s.stimulus = { kind: /constant/i.test(st[0]!) ? 'Constant Level' : /period/i.test(st[0]!) ? 'Periodic Pulse' : 'Single Pulse', startHigh: /high/i.test(st[1]!),
      start: siNum(st[2]) || DEFAULT_STIMULUS.start, stop: siNum(st[3]) || DEFAULT_STIMULUS.stop, period: siNum(st[4]) || DEFAULT_STIMULUS.period };
  }
  for (const part of (get('Terminations') ?? '').split(';').filter(Boolean)) {
    const [kind, on, ...vals] = part.split(':');
    const values: TermValues = {};
    for (const kv of vals) { const [k, v] = kv.split('='); const x = siNum(v); if ((k === 'r' || k === 'r2' || k === 'c') && Number.isFinite(x)) values[k] = x; }
    s.terms.set(kind as TermKind, { on: on === '1', values });
  }
  return s;
}

export function writeSection(prj: PrjPcb, s: SiProjectSetup): void {
  const e: [string, string][] = [
    ['TrackImpedance', String(s.trackZ)], ['AverageTrackLength', formatAltiumLength(s.avgLength)], ['Technology', s.tech],
    ...s.supplies.map(([n, v], i) => [`SupplyNet${i + 1}`, `${n}|${v}`] as [string, string]),
    ...[...s.models].map(([d, m], i) => [`Model${i + 1}`, `${d}|${modelLine(m)}`] as [string, string]),
    ...[...s.types].map(([d, t], i) => [`Type${i + 1}`, `${d}|${t}`] as [string, string]),
    ['Tolerances', Object.entries(s.tolerances).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}:${siText(v!).trim()}`).join(';')],
    ['Stimulus', [s.stimulus.kind.replace(/ /g, ''), s.stimulus.startHigh ? 'HighLevel' : 'LowLevel', siText(s.stimulus.start).trim(), siText(s.stimulus.stop).trim(), siText(s.stimulus.period).trim()].join('|')],
    ['Terminations', [...s.terms].map(([k, t]) => [k, t.on ? '1' : '0', ...Object.entries(t.values).filter(([, v]) => v !== undefined).map(([n, v]) => `${n}=${siText(v!).trim()}`)].join(':')).join(';')],
  ];
  iniSetSection(prj, SECTION, e);
}

export function saveSiSetup(p: Project | null, s: SiProjectSetup, key = ''): void {
  if (!p) { loose.set(key, s); return; }
  writeSection(p.prj, s);
  markProjectDirty(p);
}

/* ─── What the schematic tells ───────────────────────────────────────────────────── */

export interface DesignFacts {
  pinTypes: Map<string, number>;
  /** Parts' types and IC technologies from their SI models; passives' values. */
  types: Map<string, SiType>;
  techs: Map<string, string>;
  values: Map<string, number>;
  compiled: CompiledProject | null;
  sheets: SheetInput[];
}

const SI_TYPE_NAMES: Record<string, SiType> = { ic: 'IC', resistor: 'Resistor', capacitor: 'Capacitor', inductor: 'Inductor', diode: 'Diode', bjt: 'BJT', connector: 'Connector' };

export function designFacts(p: Project | null): DesignFacts {
  const sheets = projectSheets(p).filter((x) => /\.schdoc$/i.test(x.name));
  const out: DesignFacts = { pinTypes: new Map(), types: new Map(), techs: new Map(), values: new Map(), compiled: null, sheets };
  if (!sheets.length) return out;
  const compiled = compileProject(sheets, compileOptions(p));
  out.compiled = compiled;
  for (const n of compiled.nets) for (const pin of n.pins) out.pinTypes.set(`${pin.designator}-${pin.pin}`.toUpperCase(), pin.electrical);
  const docs = new Map(sheets.map((s) => [s.name.toLowerCase(), s.doc]));
  const owned = new Map<object, ReturnType<typeof ownedBy>>();
  for (const c of compiled.components) {
    const d = c.designator.toUpperCase();
    for (const r of c.refs) {
      const doc = docs.get(r.sheet.toLowerCase());
      if (!doc) continue;
      let o = owned.get(doc);
      if (!o) { o = ownedBy(doc); owned.set(doc, o); }
      const m = siModelOf(doc, r.index, o);
      if (!m) continue;
      const t = SI_TYPE_NAMES[m.type.toLowerCase()];
      if (t) out.types.set(d, t);
      if (m.tech.trim()) out.techs.set(d, m.tech.trim());
      break;
    }
    const type = out.types.get(d) ?? typeByDesignator(c.designator);
    if (type === 'Resistor' || type === 'Capacitor' || type === 'Inductor') {
      const v = valueOf(c.params.Value ?? c.params.VALUE ?? c.comment ?? '', type === 'Resistor' ? 'R' : type === 'Capacitor' ? 'F' : 'H');
      if (Number.isFinite(v) && v > 0) out.values.set(d, v);
    }
  }
  return out;
}

/** The project a board belongs to (the active one for a free board). */
export function projectOfBoard(doc: PcbDocument | null): Project | null {
  const od = doc ? docs.value.find((d) => d.doc === doc) : null;
  if (od?.projectId) return projects.value.find((p) => p.id === od.projectId) ?? null;
  return od ? null : activeProject();
}

/** The context for a board or project: the setup, the models (the user's over the schematic's), the pin types. */
export function siContextOf(setup: SiProjectSetup, facts: DesignFacts, boardSupplies?: Map<string, number>): SiContext {
  const models = new Map<string, IcModel>();
  for (const [d, t] of facts.techs) models.set(d, technology(t));
  for (const [d, m] of setup.models) models.set(d, m);
  const types = new Map<string, SiType>([...facts.types, ...setup.types]);
  return {
    setup: { trackZ: setup.trackZ, avgLength: setup.avgLength, tech: setup.tech, supplies: new Map([...setup.supplies.map(([n, v]) => [n.toUpperCase(), v] as [string, number]), ...(boardSupplies ?? [])]) },
    models, types, values: facts.values, ...(facts.pinTypes.size ? { pinTypes: facts.pinTypes } : {}),
  };
}

/** Registered at start: the DRC's Signal Integrity check asks it for a board. */
export function registerSiProvider(): void {
  setSiProvider((doc): SiProvided => {
    const p = projectOfBoard(doc);
    const setup = readSiSetup(p, doc ? docs.value.find((d) => d.doc === doc)?.name ?? '' : '');
    return { ctx: siContextOf(setup, designFacts(p)), tolerances: setup.tolerances, stimulus: setup.stimulus };
  });
}
