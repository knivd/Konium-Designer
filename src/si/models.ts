/**
 * Signal Integrity models: what a pin does to a net. An IC's pins by its technology (AD's default
 * IC models: the driver's output resistance high and low, its edge times, the input capacitance,
 * the input thresholds and clamp diodes [est: typical values for each technology]) or by an IBIS
 * file (its pin's model summed up: resistances from the pull-up and pull-down tables, edges from
 * the ramp, C_comp, thresholds, clamp tables). Resistors, capacitors and inductors by their values.
 */

export interface IcModel {
  /** Where it came from: a technology's name, or "IBIS file: component (model)". */
  name: string;
  vcc: number; vlow: number;
  /** Output resistance driving high and driving low (Ω), and the edges (10–90 %, s). */
  rup: number; rdown: number; tr: number; tf: number;
  /** Input capacitance (F) and thresholds (V). */
  cin: number; vil: number; vih: number;
  /** Clamp tables: current out of the pin (A) against its voltage (to ground; to the supply, v − vcc). */
  gndClamp?: [number, number][]; powerClamp?: [number, number][];
}

/** A diode clamp as a table: off until vf, then a resistance [est]. */
const diode = (vf: number, r: number, sign: 1 | -1): [number, number][] => (sign < 0
  ? [[-vf - 2, (-2) / r], [-vf, -0.0001], [0, 0], [50, 0]]
  : [[-50, 0], [0, 0], [vf, 0.0001], [vf + 2, 2 / r]]);

/** AD's default IC technologies [est: typical figures for each family]. */
export const TECHNOLOGIES: IcModel[] = [
  { name: 'CMOS-3.3V', vcc: 3.3, vlow: 0, rup: 25, rdown: 22, tr: 1e-9, tf: 1e-9, cin: 5e-12, vil: 0.8, vih: 2.0 },
  { name: 'CMOS-5V', vcc: 5, vlow: 0, rup: 30, rdown: 25, tr: 2e-9, tf: 2e-9, cin: 5e-12, vil: 1.5, vih: 3.5 },
  { name: 'CMOS-2.5V', vcc: 2.5, vlow: 0, rup: 28, rdown: 25, tr: 0.8e-9, tf: 0.8e-9, cin: 4e-12, vil: 0.7, vih: 1.7 },
  { name: 'CMOS-1.8V', vcc: 1.8, vlow: 0, rup: 35, rdown: 30, tr: 0.6e-9, tf: 0.6e-9, cin: 3e-12, vil: 0.63, vih: 1.17 },
  { name: 'LVTTL', vcc: 3.3, vlow: 0, rup: 30, rdown: 15, tr: 1.5e-9, tf: 1.2e-9, cin: 5e-12, vil: 0.8, vih: 2.0 },
  { name: 'TTL', vcc: 5, vlow: 0.2, rup: 60, rdown: 12, tr: 3e-9, tf: 2e-9, cin: 5e-12, vil: 0.8, vih: 2.0 },
].map((m) => ({ ...m, gndClamp: diode(0.6, 5, -1), powerClamp: diode(0.6, 5, 1) }));

export const technology = (name: string) => TECHNOLOGIES.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? TECHNOLOGIES[0]!;

/* ─── IBIS ───────────────────────────────────────────────────────────────────────────── */

export interface IbisModel { name: string; type: string; cComp: number; vinl: number; vinh: number; vcc: number; pullup: [number, number][]; pulldown: [number, number][]; gndClamp: [number, number][]; powerClamp: [number, number][]; tr: number; tf: number }
export interface IbisFile { file: string; components: { name: string; pins: Map<string, string> }[]; models: Map<string, IbisModel> }

/** A number as IBIS writes it (1.5n, 3.3e-12, 2.2pF, 45m, NA). */
export function ibisNum(s: string | undefined): number {
  if (!s) return NaN;
  const m = /^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*([a-zA-Zµ]*)/.exec(s.trim());
  if (!m) return NaN;
  const k: Record<string, number> = { T: 1e12, G: 1e9, M: 1e6, k: 1e3, m: 1e-3, u: 1e-6, 'µ': 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
  const unit = m[2]!;
  return Number(m[1]) * (unit && k[unit[0]!] !== undefined && !/^meg/i.test(unit) ? k[unit[0]!]! : /^meg/i.test(unit) ? 1e6 : 1);
}

/** Reads an IBIS file: its components and their pins' models, and the models (typical columns). */
export function readIbis(text: string, file: string): IbisFile {
  const out: IbisFile = { file, components: [], models: new Map() };
  let section = '', comp: IbisFile['components'][number] | null = null, model: IbisModel | null = null;
  let table: [number, number][] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\|.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const kw = /^\[([^\]]+)\]\s*(.*)$/.exec(line.trim());
    if (kw) {
      section = kw[1]!.trim().toLowerCase(); table = null;
      const arg = kw[2]!.trim();
      if (section === 'component') { comp = { name: arg, pins: new Map() }; out.components.push(comp); }
      else if (section === 'model') {
        model = { name: arg, type: '', cComp: NaN, vinl: NaN, vinh: NaN, vcc: NaN, pullup: [], pulldown: [], gndClamp: [], powerClamp: [], tr: NaN, tf: NaN };
        out.models.set(arg.toLowerCase(), model);
      } else if (model && section === 'pullup') table = model.pullup;
      else if (model && section === 'pulldown') table = model.pulldown;
      else if (model && section === 'gnd clamp') table = model.gndClamp;
      else if (model && section === 'power clamp') table = model.powerClamp;
      else if (model && section === 'voltage range') model.vcc = ibisNum(arg.split(/\s+/)[0]);
      continue;
    }
    const f = line.trim().split(/\s+/);
    if (section === 'pin' && comp && f.length >= 3 && !/^signal_name$/i.test(f[1]!)) comp.pins.set(f[0]!.toUpperCase(), f[2]!);
    else if (section === 'model' && model) {
      const kv = /^(\w+)\s*=?\s*(\S+)/.exec(line.trim());
      if (!kv) continue;
      const k = kv[1]!.toLowerCase();
      if (k === 'model_type') model.type = kv[2]!;
      else if (k === 'c_comp') model.cComp = ibisNum(kv[2]);
      else if (k === 'vinl') model.vinl = ibisNum(kv[2]);
      else if (k === 'vinh') model.vinh = ibisNum(kv[2]);
    } else if (section === 'ramp' && model) {
      // dV/dt_r 1.08/0.302n: the 20–80 % swing over its time (10–90 % takes 0.8 / 0.6 of it)
      const m = /^dv\/dt_([rf])\s+(\S+)\/(\S+)/i.exec(line.trim());
      if (m) { const t = (ibisNum(m[3]) * 0.8) / 0.6; if (m[1]!.toLowerCase() === 'r') model.tr = t; else model.tf = t; }
    } else if (table && f.length >= 2) {
      const v = ibisNum(f[0]), i = ibisNum(f[1]);
      if (Number.isFinite(v) && Number.isFinite(i)) table.push([v, i]);
    }
  }
  for (const m of out.models.values()) for (const t of [m.pullup, m.pulldown, m.gndClamp, m.powerClamp]) t.sort((a, b) => a[0] - b[0]);
  return out;
}

/** The slope of a table near v (a resistance's conductance), from the points either side. */
function slopeNear(t: [number, number][], v: number): number {
  if (t.length < 2) return NaN;
  let k = 0;
  while (k < t.length - 2 && t[k + 1]![0] < v) k++;
  const a = t[k]!, b = t[k + 1]!;
  return Math.abs((b[1] - a[1]) / (b[0] - a[0] || 1e-12));
}

/**
 * An IBIS model summed up for the solver: the output resistances from the pull-down table near
 * 0 V and the pull-up table near 0 V (it is against Vcc − v), the edges from the ramp, C_comp,
 * the thresholds, the clamps as their tables (power clamp against v − Vcc).
 */
export function ibisToIc(m: IbisModel, label: string, fallback: IcModel = TECHNOLOGIES[0]!): IcModel {
  const vcc = Number.isFinite(m.vcc) ? m.vcc : fallback.vcc;
  const gd = slopeNear(m.pulldown, 0.2), gu = slopeNear(m.pullup, 0.2);
  const clamp = (t: [number, number][], sign: 1 | -1): [number, number][] | undefined => {
    if (t.length < 2) return undefined;
    // IBIS's current is into the pin, which is out of the net's node; the power clamp's table is against Vcc − v
    return sign < 0 ? t.map(([v, i]) => [v, i] as [number, number]) : t.map(([v, i]) => [-v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  };
  return {
    name: label, vcc, vlow: 0,
    rup: gu > 0 ? Math.min(500, 1 / gu) : fallback.rup, rdown: gd > 0 ? Math.min(500, 1 / gd) : fallback.rdown,
    tr: Number.isFinite(m.tr) ? m.tr : fallback.tr, tf: Number.isFinite(m.tf) ? m.tf : fallback.tf,
    cin: Number.isFinite(m.cComp) ? m.cComp : fallback.cin,
    vil: Number.isFinite(m.vinl) ? m.vinl : fallback.vil, vih: Number.isFinite(m.vinh) ? m.vinh : fallback.vih,
    gndClamp: clamp(m.gndClamp, -1) ?? fallback.gndClamp, powerClamp: clamp(m.powerClamp, 1) ?? fallback.powerClamp,
  };
}

/** A model as the project keeps it (one line), and back. */
export function modelLine(m: IcModel): string {
  const f = (v: number) => Number(v.toPrecision(4));
  return [`name=${m.name.replace(/[;=]/g, ' ')}`, `vcc=${f(m.vcc)}`, `vlow=${f(m.vlow)}`, `rup=${f(m.rup)}`, `rdown=${f(m.rdown)}`, `tr=${f(m.tr)}`, `tf=${f(m.tf)}`, `cin=${f(m.cin)}`, `vil=${f(m.vil)}`, `vih=${f(m.vih)}`,
    ...(m.gndClamp ? [`gnd=${m.gndClamp.map(([v, i]) => `${f(v)}:${f(i)}`).join(',')}`] : []), ...(m.powerClamp ? [`pwr=${m.powerClamp.map(([v, i]) => `${f(v)}:${f(i)}`).join(',')}`] : [])].join(';');
}
export function parseModelLine(s: string): IcModel | null {
  if (!s.includes('=')) return TECHNOLOGIES.find((t) => t.name.toLowerCase() === s.trim().toLowerCase()) ?? null;
  const kv = new Map(s.split(';').map((p) => p.split('=') as [string, string]).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const n = (k: string) => Number(kv.get(k));
  const tab = (k: string) => (kv.get(k) ? kv.get(k)!.split(',').map((p) => p.split(':').map(Number) as [number, number]).filter((x) => x.length === 2 && x.every(Number.isFinite)) : undefined);
  const m: IcModel = { name: kv.get('name') ?? 'IBIS', vcc: n('vcc'), vlow: n('vlow') || 0, rup: n('rup'), rdown: n('rdown'), tr: n('tr'), tf: n('tf'), cin: n('cin'), vil: n('vil'), vih: n('vih'), gndClamp: tab('gnd'), powerClamp: tab('pwr') };
  return [m.vcc, m.rup, m.rdown, m.tr, m.tf, m.cin, m.vil, m.vih].every(Number.isFinite) ? m : null;
}

/** A passive's value from its comment (10k, 4.7uF, 100nF, 2R2, 4K7, 0.1µ). */
export function valueOf(s: string, unit: 'R' | 'F' | 'H'): number {
  const t = s.trim().replace(/Ω|ohms?/gi, '').replace(/\s+/g, '');
  const rkm = /^(\d+)([RKMkmunpµ])(\d+)$/.exec(t);
  if (rkm) return valueOf(`${rkm[1]}.${rkm[3]}${rkm[2] === 'R' ? '' : rkm[2]}`, unit);
  const m = /^(\d*\.?\d+)\s*(meg|[TGMkKmunpfµR])?/i.exec(t);
  if (!m) return NaN;
  const p = m[2] ?? '';
  const mult = /^meg$/i.test(p) ? 1e6 : ({ T: 1e12, G: 1e9, M: unit === 'R' ? 1e6 : 1e-3, k: 1e3, K: 1e3, m: 1e-3, u: 1e-6, 'µ': 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, R: 1 } as Record<string, number>)[p] ?? 1;
  return Number(m[1]) * mult;
}
