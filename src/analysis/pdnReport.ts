/** A supply impedance analysis in words: figures with their units, what it found, a report. */
import type { PcbDocument } from '../model/pcb';
import type { LayerId } from '../model/layers';
import { overTarget, type ConductedResult, type PdnResult } from './pdn';

export function hertz(f: number): string {
  if (!Number.isFinite(f)) return '';
  const [v, u] = f >= 1e9 ? [f / 1e9, 'GHz'] : f >= 1e6 ? [f / 1e6, 'MHz'] : f >= 1e3 ? [f / 1e3, 'kHz'] : [f, 'Hz'];
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/\.?0+$/, '')} ${u}`;
}
export function ohms(z: number): string {
  if (!Number.isFinite(z)) return '';
  const [v, u] = z >= 1 ? [z, 'Ω'] : z >= 1e-3 ? [z * 1e3, 'mΩ'] : [z * 1e6, 'µΩ'];
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${u}`;
}
export function farads(c: number): string {
  if (!Number.isFinite(c)) return '';
  const [v, u] = c >= 1e-6 ? [c * 1e6, 'µF'] : c >= 1e-9 ? [c * 1e9, 'nF'] : [c * 1e12, 'pF'];
  return `${Number(v.toPrecision(3))} ${u}`;
}

/** What a port's sweep comes to against a target, in a sentence. */
export function verdict(r: PdnResult, port: number, target: number): string {
  const bands = overTarget(r, port, target), p = r.ports[port]!;
  if (p.z.every((z) => Number.isNaN(z))) return `${p.designator} has no pad on the supply.`;
  if (!bands.length) return `Under the target of ${ohms(target)} from ${hertz(r.f[0]!)} to ${hertz(r.f[r.f.length - 1]!)}.`;
  const worst = bands.reduce((m, b) => (b.worst.z > m.worst.z ? b : m), bands[0]!).worst;
  return `Over the target of ${ohms(target)} ${bands.slice(0, 3).map((b) => (b.from === b.to ? `at ${hertz(b.from)}` : `from ${hertz(b.from)} to ${hertz(b.to)}`)).join(', ')}${bands.length > 3 ? ', and higher' : ''}; the worst ${ohms(worst.z)} at ${hertz(worst.f)}.`;
}

/** The plates, in a sentence (or why there are none). */
export function platesLine(r: PdnResult, layerName: (l: LayerId) => string, layers: LayerId[]): string {
  const p = r.model.plates;
  return p ? `The supply's copper on ${layerName(layers[p.supplyLayer]!)} over the ground's on ${layerName(layers[p.groundLayer]!)}: ${(p.gap * 1000).toFixed(2)} mm apart, ${(p.area * 1e4).toFixed(1)} cm², ${farads(p.capacitance)}; their first resonance about ${hertz(r.firstMode)}.` : r.model.why;
}

export function pdnReport(doc: PcbDocument, r: PdnResult, title: string, target: number, layerName: (l: LayerId) => string, noise?: ConductedResult | null): string {
  const net = (n: number) => doc.nets[n]?.name ?? `Net ${n}`, out: string[] = [`Supply Impedance: ${title}`, ''], pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  out.push(`Supply net      ${net(r.setup.supply)}`, `Ground net      ${net(r.setup.ground)}`);
  out.push(`Source          ${r.setup.source ? `${doc.components[r.setup.source.component]?.designator ?? ''}: ${ohms(r.setup.source.r)}, ${(r.setup.source.l * 1e9).toFixed(1)} nH` : '(none)'}`);
  out.push(`Target          ${ohms(target)}`, `Range           ${hertz(r.f[0]!)} to ${hertz(r.f[r.f.length - 1]!)}, ${r.f.length} frequencies`);
  out.push(`Planes          ${platesLine(r, layerName, doc.board.copperStack)}`, '');
  out.push(`${pad('Capacitor', 11)}${pad('Value', 11)}${pad('ESR', 11)}${pad('ESL', 9)}Resonates at`);
  for (const c of r.setup.caps) out.push(`${pad(c.designator, 11)}${pad(farads(c.c), 11)}${pad(ohms(c.esr), 11)}${pad(`${(c.esl * 1e9).toFixed(1)} nH`, 9)}${c.c > 0 && c.esl > 0 ? hertz(1 / (2 * Math.PI * Math.sqrt(c.c * c.esl))) : ''}`);
  out.push('');
  r.ports.forEach((p, k) => {
    out.push(`Looked at from ${p.designator}: ${verdict(r, k, target)}`);
    for (const q of p.peaks.slice(0, 4)) out.push(`  a peak of ${ohms(q.z)} at ${hertz(q.f)}`);
  });
  if (noise) {
    out.push('', `Conducted emission, differential mode (estimated): ${noise.margin >= 0 ? `${noise.margin.toFixed(1)} dB under` : `${(-noise.margin).toFixed(1)} dB over`} the Class B limit at ${hertz(noise.marginAt)}, where it is nearest.`);
    out.push(`${pad('Frequency', 12)}${pad('Level', 12)}${pad('Class B', 10)}Class A`);
    const worst = noise.f.map((f, k) => ({ f, k })).sort((a, b) => (noise.classB[a.k]! - noise.level[a.k]!) - (noise.classB[b.k]! - noise.level[b.k]!)).slice(0, 12).sort((a, b) => a.f - b.f);
    for (const { f, k } of worst) out.push(`${pad(hertz(f), 12)}${pad(`${noise.level[k]!.toFixed(1)} dBµV`, 12)}${pad(String(Math.round(noise.classB[k]! * 10) / 10), 10)}${noise.classA[k]}`);
  }
  return out.join('\n');
}
