/**
 * Design › Simulate › Mixed Sim's netlist: the compiled project as a SPICE netlist (.nsx), each
 * part by its SIM model's netlist template, its model and subcircuit files at the end, the
 * analyses from Analyses Setup. The Spice Reference Net Name (GND) is node 0; a pin on no net
 * gets a node of its own (NC_<designator>_<pin>).
 *
 * A part without a SIM model: a resistor, capacitor or inductor (by its designator) whose Value
 * or Comment reads as a number is netlisted as one [est: AD reports it]; anything else is left
 * out with a warning.
 */
import type { CompiledComponent, CompiledProject, SheetInput } from '../model/compile';
import { ownedBy, partLetter, type SchDocument, type SchObject } from '../model/sch';
import { DEFAULT_TEMPLATES, defaultPrefix, expandTemplate, simModelOf, type SimModel } from '../model/simModels';
import { builtinModel } from './library';
import { isSpiceNumber, spiceNumber } from './num';
import { analysisCards, collectFor, type SimSettings } from './settings';
import { readNetlist } from './netlist';
import { Simulator } from './engine';

export interface NetlistMessage { level: 'error' | 'warn' | 'info'; text: string; designator?: string }

export interface SimNetlist {
  text: string;
  messages: NetlistMessage[];
  /** Signals the run can show: node voltages (nets), then currents and powers by part. */
  signals: string[];
  /** The named nets (net labels, ports, power ports) other than the reference. */
  namedNets: string[];
  /** Model files it took, and where from (project, library, built-in). */
  models: { name: string; from: string }[];
  /** Frequencies of the periodic sources (Use Transient Defaults). */
  sourceFrequencies: number[];
}

/** A model file's text by its name and kind (MDL, CKT): the project's files, then its libraries. */
export type ModelFinder = (entity: string, kind: string) => { text: string; from: string } | null;

/** A node name SPICE takes: spaces and separators as underscores. */
export function spiceNode(name: string): string {
  const s = name.trim().replace(/[\s,()=;'"]+/g, '_');
  return s || '_';
}

const PASSIVE: Record<string, string> = { R: 'resistor', C: 'capacitor', L: 'inductor' };

/** One component part (its object on a sheet) with its pins (its own and those common to every part). */
interface PartRef { doc: SchDocument; comp: SchObject & { kind: 'component' }; pins: { designator: string; name: string }[] }

function partsOf(c: CompiledComponent, sheets: Map<string, SchDocument>): PartRef[] {
  const out: PartRef[] = [];
  for (const r of c.refs) {
    const doc = sheets.get(r.sheet.toLowerCase());
    const comp = doc?.objects[r.index];
    if (!doc || !comp || comp.kind !== 'component') continue;
    const pins = (ownedBy(doc).get(comp.index) ?? [])
      .filter((o) => o.kind === 'pin' && (o.ownerPartId <= 0 || o.ownerPartId === comp.partId) && (o.ownerDisplayMode ?? 0) === comp.displayMode)
      .map((o) => ({ designator: (o as SchObject & { kind: 'pin' }).designator, name: (o as SchObject & { kind: 'pin' }).name }));
    out.push({ doc, comp, pins });
  }
  return out;
}

/** The template's highest %n. */
const pinCount = (tpl: string) => Math.max(0, ...[...tpl.matchAll(/%(\d+)/g)].map((m) => Number(m[1])));

/** Model and subcircuit names a model file defines (.MODEL name / .SUBCKT name). */
const definedIn = (text: string) => [...text.matchAll(/^\s*\.(?:model|subckt)\s+(\S+)/gim)].map((m) => m[1]!.toUpperCase());

/**
 * What Live Simulation reads a running circuit by: each net's node, and each pin's meter (a 0 V
 * source in series with the pin, between its net and a node of the pin's own; its current is the
 * current into the part at that pin, whatever the part is made of).
 */
export interface LiveMap {
  /** A compiled net's name → its node in the netlist ('0': the reference). */
  nets: Map<string, string>;
  /** "designator|pin" → the meter's name and the net's node. */
  pins: Map<string, { meter: string; node: string }>;
}
const meterName = (des: string, pin: string) => `V__${`${des}__${pin}`.replace(/[^A-Za-z0-9_]/g, '_')}`;

export function projectNetlist(compiled: CompiledProject, sheetList: SheetInput[], settings: SimSettings, findModel: ModelFinder = () => null, title = 'Mixed Sim', live?: LiveMap): SimNetlist {
  const messages: NetlistMessage[] = [];
  const sheets = new Map(sheetList.map((s) => [s.name.toLowerCase(), s.doc]));
  const ref = settings.reference.trim().toUpperCase() || 'GND';
  const node = (net: string) => (net.toUpperCase() === ref || net === '0' ? '0' : spiceNode(net));
  const netOf = new Map<string, string>();
  for (const n of compiled.nets) for (const p of n.pins) netOf.set(`${p.designator}|${p.pin}`, node(n.name));
  const namedNets = [...new Set(compiled.nets.filter((n) => !n.auto).map((n) => node(n.name)).filter((n) => n !== '0'))];
  if (live) for (const n of compiled.nets) live.nets.set(n.name, node(n.name));
  const meters: string[] = [];
  /** A pin's node in a device's line: its net's; for Live Simulation a node of the pin's own, joined to the net through its meter. */
  const through = (des: string, pin: string, net: string): string => {
    if (!live) return net;
    const key = `${des}|${pin}`, have = live.pins.get(key);
    const own = `${meterName(des, pin).slice(3)}_P`;
    if (!have) { const meter = meterName(des, pin); live.pins.set(key, { meter, node: net }); meters.push(`${meter} ${net} ${own} 0`); }
    return own;
  };
  const nodes = new Set<string>(compiled.nets.map((n) => node(n.name)).filter((n) => n !== '0'));

  const lines: string[] = [];
  const devices: string[] = [];
  const modelFiles = new Map<string, { text: string; from: string }>();
  const sourceFrequencies: number[] = [];

  const useModel = (m: SimModel, des: string) => {
    const kind = m.fileKind || (/subcircuit/i.test(`${m.kind} ${m.subKind}`) || /^X$/i.test(m.prefix) ? 'CKT' : 'MDL');
    const entity = (m.fileName || m.name).replace(/\.(mdl|ckt)$/i, '');
    if (!entity) return;
    const key = `${entity}.${kind}`.toLowerCase();
    if (modelFiles.has(key)) return;
    const found = findModel(entity, kind) ?? (() => { const b = builtinModel(`${entity}.${kind.toLowerCase()}`) ?? builtinModel(entity); return b ? { text: b.text, from: 'built-in' } : null; })();
    if (!found) {
      // A diode whose model file isn't here: SPICE's default diode (an LED's: a red LED's) stands in [est: AD stops]
      if (/diode/i.test(`${m.kind} ${m.subKind}`) || /^D$/i.test(m.prefix)) {
        const led = /led/i.test(`${entity} ${m.name}`);
        modelFiles.set(key, { text: `.MODEL ${entity} D(${led ? builtinModel('LED_RED')!.text.replace(/^.*D\(|\)\s*$/g, '') : 'IS=1e-14 RS=0.1'})`, from: 'default' });
        messages.push({ level: 'warn', designator: des, text: `${des}: model file ${entity}.${kind.toLowerCase()} not found: ${led ? 'a red LED' : "SPICE's default diode"} stands in for it` });
        return;
      }
      messages.push({ level: 'error', designator: des, text: `${des}: model file ${entity}.${kind.toLowerCase()} not found (in the project, its libraries or Konium Designer's built-in models)` });
      return;
    }
    modelFiles.set(key, found);
  };

  for (const c of compiled.components) {
    if (c.kind === 1 || c.kind === 2) continue; // Mechanical and Graphical parts carry no electrical function
    const parts = partsOf(c, sheets);
    if (!parts.length) continue;
    const first = parts[0]!;
    const model = simModelOf(first.doc, first.comp.index);
    const partParam = (name: string) => { const k = Object.keys(c.params).find((x) => x.toUpperCase() === name); return k !== undefined ? c.params[k] : undefined; };
    if (!model) {
      const letter = /^[A-Za-z]+/.exec(c.designator)?.[0]?.toUpperCase() ?? '';
      const value = [partParam('VALUE'), c.comment].find((v) => v && isSpiceNumber(v));
      if (PASSIVE[letter] && value && first.pins.length >= 2) {
        const [a, b] = first.pins;
        const na = netOf.get(`${c.designator}|${a!.designator}`) ?? `NC_${c.designator}_${a!.designator}`;
        const nb = netOf.get(`${c.designator}|${b!.designator}`) ?? `NC_${c.designator}_${b!.designator}`;
        devices.push(`${c.designator} ${through(c.designator, a!.designator, spiceNode(na))} ${through(c.designator, b!.designator, spiceNode(nb))} ${value}`);
        messages.push({ level: 'warn', designator: c.designator, text: `${c.designator} has no simulation model: netlisted as a ${PASSIVE[letter]} of ${value}` });
      } else {
        messages.push({ level: 'warn', designator: c.designator, text: `${c.designator} (${c.libRef}) has no simulation model and is left out of the simulation` });
      }
      continue;
    }
    const tpl = model.netlist || DEFAULT_TEMPLATES[model.subKind.toLowerCase()] || DEFAULT_TEMPLATES[model.kind.toLowerCase()] || '';
    if (!tpl) { messages.push({ level: 'error', designator: c.designator, text: `${c.designator}: its ${model.kind || 'SIM'} model has no netlist template` }); continue; }
    const prefix = model.prefix || defaultPrefix(model);
    // A multi-part package with a per-part model (an op-amp of a dual): one instance per part
    const perPart = parts.length > 1 || (c.parts > 1 && pinCount(tpl) < first.pins.length);
    const instances = perPart ? parts : [first];
    for (const part of instances) {
      const baseDes = perPart ? `${c.designator}${partLetter(part.comp.partId)}` : c.designator;
      const des = prefix && !baseDes.toUpperCase().startsWith(prefix.toUpperCase()) ? `${prefix}${baseDes}` : baseDes;
      const pinDes = (i: number): string | undefined => {
        const mapped = model.portMap.get(String(i));
        if (mapped !== undefined && part.pins.some((p) => p.designator === mapped)) return mapped;
        if (part.pins.some((p) => p.designator === String(i)) && !model.portMap.size) return String(i);
        return part.pins[i - 1]?.designator;
      };
      const r = expandTemplate(tpl, {
        designator: des,
        model: model.name,
        net: (i) => {
          const pd = pinDes(i);
          if (pd === undefined) return undefined;
          const n = netOf.get(`${c.designator}|${pd}`);
          if (n) return through(c.designator, pd, n);
          const nc = spiceNode(`NC_${c.designator}_${pd}`);
          nodes.add(nc);
          return through(c.designator, pd, nc);
        },
        param: (name) => {
          // A switch or push button: its picture is its state (display mode 1: closed), netlisted as a resistance
          // (a changeover switch's other way is closed when this one is open)
          if (name === 'SWITCH RESISTANCE' || name === 'SWITCH RESISTANCE OTHER') {
            const closed = (part.comp.displayMode === 1) === (name === 'SWITCH RESISTANCE'), own = closed ? 'ON RESISTANCE' : 'OFF RESISTANCE';
            return partParam(own) || model.params.get(own) || (closed ? '1m' : '1G');
          }
          const v = model.params.get(name);
          if (v !== undefined && v !== '' && v !== '*') return v;
          return partParam(name);
        },
      });
      for (const m of r.missing) messages.push({ level: 'error', designator: c.designator, text: `${c.designator}: ${/^pin /.test(m) ? `its model's ${m} has no pin on the part` : `parameter "${m}" has no value`}` });
      devices.push(r.line);
      // A live run paces itself by every source's frequency, however its line gives it (a square wave's is in braces)
      if (live) for (const [name, per] of [['FREQUENCY', false], ['END FREQUENCY', false], ['CARRIER FREQUENCY', false], ['BANDWIDTH', false], ['PERIOD', true]] as const) {
        const raw = model.params.get(name), v = spiceNumber((raw !== undefined && raw !== '' && raw !== '*' ? raw : partParam(name)) ?? '');
        if (v > 0) sourceFrequencies.push(per ? 1 / v : v);
      }
      // Periodic sources set the transient window (Use Transient Defaults)
      const sin = /\bSIN\s*\(([^)]*)\)/i.exec(r.line), pulse = /\bPULSE\s*\(([^)]*)\)/i.exec(r.line);
      if (sin) { const f = spiceNumber(sin[1]!.trim().split(/[\s,]+/)[2] ?? ''); if (f > 0) sourceFrequencies.push(f); }
      if (pulse) { const per = spiceNumber(pulse[1]!.trim().split(/[\s,]+/)[6] ?? ''); if (per > 0) sourceFrequencies.push(1 / per); }
    }
    // The model file: the one it names, else (a template taking @MODEL) the model's name
    if (model.fileName || /(?:@|&)MODEL\b/i.test(tpl)) useModel(model, c.designator);
  }

  // A model file's own .END (vendor files often end with one) would end the netlist where it's pasted
  const noEnd = (t: string) => t.replace(/^[ \t]*\.end[ \t\r]*(?:[;*$][^\n]*)?$/gim, '');
  // Signals: what the simulator keeps for this netlist (nodes, supply currents, device currents and powers as collected)
  let signals = [...nodes].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  try {
    const probe = `*\n${devices.join('\n')}\n${[...modelFiles.values()].map((f) => noEnd(f.text)).join('\n')}\n.END\n`;
    const all = new Simulator(readNetlist(probe), {}, collectFor({ ...settings, collect: settings.collect === 'Active Signals' ? 'Node Voltage, Supply Current, Device Current and Power' : settings.collect }, [])).signalNames();
    if (all.length) signals = all;
  } catch { /* the nets alone */ }
  const active = (settings.activeSignals.length ? settings.activeSignals : namedNets).filter((s) => signals.some((x) => x.toLowerCase() === s.toLowerCase()));
  const cards = analysisCards(settings, { sourceFrequencies, signals: active });
  for (const e of cards.errors) messages.push({ level: 'error', text: e });

  const now = new Date();
  const two = (x: number) => String(x).padStart(2, '0');
  lines.push(`*SPICE Netlist generated by Konium Designer (${title}) on ${two(now.getDate())}/${two(now.getMonth() + 1)}/${now.getFullYear()} ${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`, '');
  lines.push('*Schematic Netlist:', ...devices, '');
  if (meters.length) lines.push('*Each pin through an ammeter of its own (Live Simulation):', ...meters, '');
  if (settings.collect === 'Active Signals' && active.length) lines.push(`.SAVE ${active.map((s) => (/\[|#/.test(s) ? s : `V(${s})`)).join(' ')}`);
  lines.push(...cards.lines, '');
  if (modelFiles.size) {
    lines.push('*Models and Subcircuits:');
    const seen = new Set<string>();
    for (const [, f] of modelFiles) {
      const names = definedIn(f.text);
      if (names.length && names.every((n) => seen.has(n))) continue;
      names.forEach((n) => seen.add(n));
      lines.push(noEnd(f.text.replace(/\r/g, '')).trim(), '');
    }
  }
  lines.push('.END', '');
  return {
    text: lines.join('\n'), messages, signals, namedNets,
    models: [...modelFiles].map(([name, f]) => ({ name, from: f.from })),
    sourceFrequencies,
  };
}

/** The part's own SIM model, for the Properties and the sim-model checks. */
export function hasSimModel(doc: SchDocument, componentIndex: number): boolean {
  return simModelOf(doc, componentIndex) !== null;
}
