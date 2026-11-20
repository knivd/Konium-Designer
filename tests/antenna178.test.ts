import { describe, expect, it } from 'vitest';
import { C0, Fdtd } from '../src/analysis/fdtd';
import { HuygensBox, pulse, spectrum } from '../src/analysis/farfield';
import { buildAntenna, matches, startAntenna, type AntennaResult, type AntennaSetup } from '../src/analysis/antenna';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import { addNet, addPads } from '../src/model/pcbEdit';
import { readStack, setStack } from '../src/model/pcbStack';
import { L } from '../src/model/layers';
import { mm } from '../src/core/units';
import type { PcbDocument } from '../src/model/pcb';
import { ANTENNA_SAMPLE, antennaSampleBytes, antennaSampleDoc } from '../src/formats/synthetic/antennaSample';
import { DETAIL, currentAt, currentPixels, feedPads, formAntenna, readAntennaForm } from '../src/app/antennaRun';
import { matchText } from '../src/app/panels/AntennaPanel';
import { antennaReport } from '../src/analysis/antennaReport';

const line = (n: number, d: number, from = 0) => Float64Array.from({ length: n + 1 }, (_, i) => from + i * d);
const dft = spectrum;

describe('FDTD (26.178): the equations', () => {
  it('a closed box of air rings at its resonances: TE101 and TE102 of 50 × 30 × 40 mm, on an uneven grid, within 1 %', () => {
    // Uneven spacing along x: fine in the middle, coarse at the ends
    const xs: number[] = [0];
    const steps = [...Array(8).fill(2.5e-3), ...Array(10).fill(1e-3), ...Array(8).fill(2.5e-3)];
    for (const s of steps) xs.push(xs.at(-1)! + s);
    const sim = new Fdtd({ x: Float64Array.from(xs), y: line(15, 2e-3), z: line(20, 2e-3) });
    expect(xs.at(-1)).toBeCloseTo(0.05, 9);
    // A kick to Ey off the middle (TE10p has Ey alone, uniform along y), then the ring
    const a = 0.05, d = 0.04, f = (m: number, p: number) => (C0 / 2) * Math.hypot(m / a, p / d);
    const kick = sim.at(7, 7, 6), probe = sim.at(19, 7, 13), rec: number[] = [];
    for (let n = 0; n < 6000; n++) {
      const t = n * sim.dt, g = Math.exp(-(((t - 120e-12) / 40e-12) ** 2));
      sim.ey[kick] += g;
      sim.advance();
      rec.push(sim.ey[probe]!);
    }
    // The spectrum's peaks nearest the two resonances
    const peak = (f0: number) => {
      let best = 0, at = 0;
      for (let q = f0 * 0.95; q <= f0 * 1.05; q += f0 * 0.0005) { const [re, im] = dft(rec, sim.dt, q); const m = re * re + im * im; if (m > best) { best = m; at = q; } }
      return at;
    };
    expect(f(1, 1)).toBeCloseTo(4.7995e9, -6);
    expect(Math.abs(peak(f(1, 1)) / f(1, 1) - 1)).toBeLessThan(0.01);
    expect(Math.abs(peak(f(1, 2)) / f(1, 2) - 1)).toBeLessThan(0.01);
    // Nothing is lost in a closed box of air: the field has not died away
    const late = rec.slice(-1500).reduce((m, v) => Math.max(m, Math.abs(v)), 0), early = rec.slice(500, 2000).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(late / early).toBeGreaterThan(0.5);
  }, 120_000);

  it('with the absorber the same box is open space: a pulse leaves, and what comes back is under a five-hundredth of it', () => {
    const run = (n: number, pml: number) => {
      const sim = new Fdtd({ x: line(n, 2e-3), y: line(n, 2e-3), z: line(n, 2e-3), pml });
      const c = Math.floor(n / 2), src = sim.at(c, c, c), probe = sim.at(c + 6, c + 3, c), rec: number[] = [];
      for (let s = 0; s < 170; s++) {
        // A pulse with no constant part, so that no charge is left behind
        const t = s * sim.dt, u = (t - 100e-12) / 30e-12;
        sim.ez[src] += -u * Math.exp(-u * u);
        sim.advance();
        rec.push(sim.ez[probe]!);
      }
      return rec;
    };
    // The same source in a space so large that nothing returns within the record is what there should be
    const open = run(104, 0), small = run(44, 10);
    let worst = 0, top = 0;
    for (let s = 0; s < open.length; s++) { worst = Math.max(worst, Math.abs(small[s]! - open[s]!)); top = Math.max(top, Math.abs(open[s]!)); }
    expect(worst / top).toBeLessThan(0.002);
    // Without the absorber the walls send it all back
    const closed = run(44, 0);
    let diff = 0;
    for (let s = 0; s < open.length; s++) diff = Math.max(diff, Math.abs(closed[s]! - open[s]!));
    expect(diff / top).toBeGreaterThan(0.1);
  }, 120_000);
});

describe('FDTD (26.178): a half-wave dipole in open space', () => {
  // A wire of 21 edges of 7 mm along z, the middle one the port (50 Ω), 14 cells of air round it and 8 of absorber
  const d = 7e-3, pad = 22, wire = 21;
  const nxy = 1 + 2 * pad, nz = wire + 2 * pad, c = pad, k0 = pad;
  const sim = new Fdtd({
    x: line(nxy, d), y: line(nxy, d), z: line(nz, d), pml: 8,
    pecZ: Array.from({ length: wire }, (_, m) => m).filter((m) => m !== 10).map((m) => c + (nxy + 1) * (c + (nxy + 1) * (k0 + m))),
    ports: [{ axis: 2, i: c, j: c, k: k0 + 10, n: 1, r: 50 }],
  });
  const fBox = 0.95e9, box = new HuygensBox(sim, [11, 11, 11], [nxy - 11, nxy - 11, nz - 11], [fBox], 4);
  const src = pulse(1e9, 1e9), v: number[] = [], cur: number[] = [];
  const steps = Math.ceil((src.length + 7e-9) / sim.dt);
  for (let n = 0; n < steps; n++) {
    sim.advance([src.at((n + 0.5) * sim.dt)]);
    box.sample();
    v.push(sim.portV(0)); cur.push(sim.portI(0, src.at((n + 1) * sim.dt)));
  }
  const z = (f: number): [number, number] => {
    const [vr, vi] = spectrum(v, sim.dt, f, sim.dt), [ir, ii] = spectrum(cur, sim.dt, f, sim.dt), m = ir * ir + ii * ii;
    return [(vr * ir + vi * ii) / m, (vi * ir - vr * ii) / m];
  };

  it('has rung down by the end of the record', () => {
    const top = v.reduce((m, x) => Math.max(m, Math.abs(x)), 0), late = v.slice(-50).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    expect(late / top).toBeLessThan(0.01);
  });

  it('resonates a little under half a wavelength, with about 70 Ω there', () => {
    let fRes = 0;
    for (let f = 0.8e9; f < 1.1e9; f += 1e6) if (z(f)[1] < 0 && z(f + 1e6)[1] >= 0) { fRes = f; break; }
    const length = (wire * d * fRes) / C0;
    expect(length).toBeGreaterThan(0.44); expect(length).toBeLessThan(0.49);
    const r = z(fRes)[0];
    expect(r).toBeGreaterThan(60); expect(r).toBeLessThan(85);
    // Short of resonance it is capacitive, past it inductive, and the resistance rises with frequency
    expect(z(0.8e9)[1]).toBeLessThan(-30); expect(z(1.08e9)[1]).toBeGreaterThan(20);
    expect(z(1.08e9)[0]).toBeGreaterThan(z(0.8e9)[0]);
  });

  it('radiates all it accepts (nothing here loses any), as a dipole does: 1.64 broadside, the same all round, along z', () => {
    const [vr, vi] = spectrum(v, sim.dt, fBox, sim.dt), [ir, ii] = spectrum(cur, sim.dt, fBox, sim.dt);
    const accepted = 0.5 * (vr * ir + vi * ii), radiated = box.power(0);
    expect(radiated / accepted).toBeGreaterThan(0.97); expect(radiated / accepted).toBeLessThan(1.03);
    const p = box.pattern(0, 5), np = p.phi.length;
    // The far field's own sum over the sphere is the power through the box
    expect(p.power / radiated).toBeGreaterThan(0.97); expect(p.power / radiated).toBeLessThan(1.03);
    expect(p.peak).toBeGreaterThan(1.55); expect(p.peak).toBeLessThan(1.75);
    expect(Math.abs(p.peakTheta - Math.PI / 2)).toBeLessThan(0.09);
    const row = Array.from({ length: np }, (_, ip) => p.u[18 * np + ip]!);
    expect(Math.min(...row) / Math.max(...row)).toBeGreaterThan(0.98);
    // Polarised along the wire: nothing in phi; nothing along the wire itself
    expect(Math.max(...p.uPhi) / Math.max(...p.u)).toBeLessThan(1e-3);
    expect(p.u[0]! / Math.max(...p.u)).toBeLessThan(1e-3);
  });
});

describe('Antenna analysis (26.178): matching', () => {
  it('each two-part network brings the antenna to 50 Ω', () => {
    const f = 2.45e9, w = 2 * Math.PI * f;
    // Complex arithmetic enough for a ladder: z in series, or in parallel
    const par = (a: [number, number], b: [number, number]): [number, number] => {
      const nr = a[0] * b[0] - a[1] * b[1], ni = a[0] * b[1] + a[1] * b[0], dr = a[0] + b[0], di = a[1] + b[1], m = dr * dr + di * di;
      return [(nr * dr + ni * di) / m, (ni * dr - nr * di) / m];
    };
    for (const z of [[20, -35], [20, 40], [120, 60], [75, -10], [8, 3], [200, -150], [50, 30]] as [number, number][]) {
      const all = matches(z, f);
      expect(all.length).toBeGreaterThanOrEqual(1);
      for (const net of all) {
        let seen = z;
        for (const part of net.parts) {
          const x = part.kind === 'L' ? w * part.value : -1 / (w * part.value);
          seen = part.where === 'series' ? [seen[0], seen[1] + x] : par(seen, [0, x]);
        }
        expect(seen[0]).toBeCloseTo(50, 6); expect(seen[1]).toBeCloseTo(0, 6);
      }
    }
    // Loads that either order can match have four networks; a matched one needs none
    expect(matches([20, 40], f).length).toBe(4);
    expect(matches([120, 60], f).length).toBe(2);
    expect(matches([50, 0], f).length).toBe(0);
  });
});

/** A run to its end, a breath between slices (a test that holds its worker for a minute is taken for dead). */
async function analyse(doc: PcbDocument, setup: AntennaSetup): Promise<AntennaResult> {
  const job = startAntenna(doc, setup);
  if (typeof job === 'string') throw new Error(job);
  while (!job.advance(400)) await new Promise((r) => setTimeout(r, 0));
  return job.finish();
}

/** A board of its own for an antenna: its size, its laminate, and what is put on it. */
function antennaBoard(w: number, h: number, thick: number, er: number, build: (doc: PcbDocument, P: (x: number, y: number) => { x: number; y: number }, net: (name: string) => number) => void): PcbDocument {
  const doc = readPcbDoc(newPcbDocBytes('PCB1.PcbDoc'), 'PCB1.PcbDoc');
  const rows = readStack(doc.board.bag!, doc.board.copperStack).map((r) => (r.kind === 'dielectric' ? { ...r, height: mm(thick), dielConst: er } : r));
  setStack(doc, rows).apply();
  const P = (x: number, y: number) => ({ x: mm(30 + x), y: mm(30 + y) });
  build(doc, P, (name) => { addNet(doc, name).apply(); return doc.nets.length - 1; });
  doc.board.outline = [P(0, 0), P(w, 0), P(w, h), P(0, h)];
  return doc;
}

describe('Antenna analysis (26.178): a patch on its ground plane, fed by a microstrip line', () => {
  // The patch of Sheen and others' paper (1990): 12.45 × 16 mm on 0.794 mm of laminate with a constant of 2.2, a line of
  // 2.46 mm to its edge, made for 7.5 GHz [est: the paper's own figures, from memory of it]. Here: 7.19 GHz with cells of
  // 0.8 mm, 7.41 GHz with cells of 0.4 mm
  let r: AntennaResult, feed = -1, gnd = -1, doc: PcbDocument;
  it('is modelled from the board: the laminate, the copper of both layers, a port through the laminate under the feed pad', () => {
    doc = antennaBoard(24, 40, 0.794, 2.2, (d, P, net) => {
      const ant = net('ANT'); gnd = net('GND');
      addPads(d, [
        { name: 'F', layer: L.TOP, at: P(7.1 + 2.09 + 1.23, 3.5), w: mm(2.46), h: mm(1), shape: 'rect', net: ant },
        { name: 'L', layer: L.TOP, at: P(7.1 + 2.09 + 1.23, 12), w: mm(2.46), h: mm(18), shape: 'rect', net: ant },
        { name: 'P', layer: L.TOP, at: P(7.1 + 6.225, 21 + 8), w: mm(12.45), h: mm(16), shape: 'rect', net: ant },
        { name: 'G', layer: L.BOTTOM, at: P(12, 20), w: mm(24), h: mm(40), shape: 'rect', net: gnd },
      ]).apply();
    });
    feed = doc.prims.findIndex((p) => p.kind === 'pad' && p.name === 'F');
    const model = buildAntenna(doc, { feed, ground: gnd, f0: 7.5e9, cell: 0.8e-3, tanD: 0.001 });
    if (typeof model === 'string') throw new Error(model);
    expect(model.port.kind).toBe('through'); expect(model.port.axis).toBe(2);
    expect(model.layers.map((q) => q.layer)).toEqual([L.TOP, L.BOTTOM]);
    // The laminate's cells between the two planes, inside the outline; air everywhere else
    const nx = model.x.length - 1, ny = model.y.length - 1, kBot = model.layers[1]!.k, kTop = model.layers[0]!.k;
    expect(model.z[kTop]! - model.z[kBot]!).toBeCloseTo(0.794e-3, 6);
    const mid = Math.floor(nx / 2) + nx * Math.floor(ny / 2);
    expect(model.eps[mid + nx * ny * kBot]).toBeCloseTo(2.2, 5); expect(model.eps[mid + nx * ny * (kTop + 1)]).toBe(1); expect(model.eps[nx * ny * kBot]).toBe(1);
    // The ground plane's copper: about its area in conducting edges on the bottom plane; the top has far fewer
    const onPlane = (k: number) => { const sxy = (nx + 1) * (ny + 1); let n = 0; for (const e of model.pecX) if (Math.floor(e / sxy) === k) n++; return n; };
    expect(onPlane(kBot)).toBeGreaterThan(2.5 * onPlane(kTop));
    expect(model.count).toBeLessThan(400_000);
  });

  it('resonates near 7.5 GHz and matches there; radiates most of what it accepts, upwards, with a patch\'s directivity', async () => {
    r = await analyse(doc, { feed, ground: gnd, f0: 7.5e9, cell: 0.8e-3, tanD: 0.001, decay: 0.03 });
    expect(Math.abs(r.best.f / 7.5e9 - 1)).toBeLessThan(0.06);
    expect(r.best.s11).toBeLessThan(-8);
    expect(r.settled).toBe(true);
    expect(r.efficiency).toBeGreaterThan(0.75); expect(r.efficiency).toBeLessThanOrEqual(1);
    // Up from the patch's side (+z), not down through the ground plane
    expect(r.pattern.peakTheta).toBeLessThan((40 * Math.PI) / 180);
    expect(r.directivity).toBeGreaterThan(5); expect(r.directivity).toBeLessThan(9.5);
    const np = r.pattern.phi.length, up = r.pattern.u[0]!, down = r.pattern.u[(r.pattern.theta.length - 1) * np]!;
    expect(up / down).toBeGreaterThan(4);
    // The current is on the patch and its line: the largest on the top layer
    expect(r.current[0]!.max).toBeGreaterThan(0);
    expect(r.copperLoss).toBeGreaterThan(0); expect(r.copperLoss).toBeLessThan(0.2);
    expect(r.efficiencyAll).toBeLessThan(r.efficiency);
  }, 240_000);
});

describe('Antenna analysis (26.178): a dipole printed on a board with no ground plane', () => {
  it('is fed across the gap between its arms; resonates shorter than in air; radiates all round its axis and not along it', async () => {
    let a = -1, b = -1;
    // Two arms of 24 mm along x, 1 mm wide, a 1 mm gap between them, on 1.6 mm of FR-4 (60 × 20 mm)
    const doc = antennaBoard(60, 20, 1.6, 4.4, (d, P, net) => {
      a = net('ARM'); b = net('RTN');
      addPads(d, [
        { name: 'A', layer: L.TOP, at: P(17.5, 10), w: mm(24), h: mm(1), shape: 'rect', net: a },
        { name: 'F', layer: L.TOP, at: P(29, 10), w: mm(1), h: mm(1), shape: 'rect', net: a },
        { name: 'B', layer: L.TOP, at: P(42.5, 10), w: mm(24), h: mm(1), shape: 'rect', net: b },
      ]).apply();
    });
    const feed = doc.prims.findIndex((p) => p.kind === 'pad' && p.name === 'F');
    const model = buildAntenna(doc, { feed, ground: b, f0: 2.2e9, cell: 1e-3 });
    if (typeof model === 'string') throw new Error(model);
    expect(model.port.kind).toBe('gap'); expect(model.port.axis).toBe(0);
    expect(model.port.n).toBeGreaterThanOrEqual(1); expect(model.port.n).toBeLessThanOrEqual(2);
    const r = await analyse(doc, { feed, ground: b, f0: 2.2e9, cell: 1e-3, decay: 0.03 });
    // Where the reactance crosses zero going up: the first resonance
    let fRes = 0;
    for (let q = 0; q + 1 < r.f.length; q++) if (r.zIm[q]! < 0 && r.zIm[q + 1]! >= 0) { fRes = r.f[q]!; break; }
    const length = (49e-3 * fRes) / C0;
    // In air it would be about 0.46 of a wavelength; the laminate under it makes it look longer: 0.347 here (2121 MHz), and
    // 0.348 with cells half the size
    expect(length).toBeGreaterThan(0.33); expect(length).toBeLessThan(0.365);
    const at = r.zRe[r.f.findIndex((q) => q >= fRes)]!;
    expect(at).toBeGreaterThan(38); expect(at).toBeLessThan(60);
    // FR-4 loses a little; a dipole's shape: nothing along x, the most across it
    expect(r.efficiency).toBeGreaterThan(0.9); expect(r.efficiency).toBeLessThan(0.99);
    expect(r.directivity).toBeGreaterThan(1.7); expect(r.directivity).toBeLessThan(3.2);
    const np = r.pattern.phi.length, row = (r.pattern.theta.length - 1) / 2, top = Math.max(...r.pattern.u);
    expect(r.pattern.u[row * np]! / top).toBeLessThan(0.05);
    expect(r.pattern.u[row * np + np / 4]! / top).toBeGreaterThan(0.7);
    // No ground on the board at all: the port has nothing to return to, and it is said
    const none = buildAntenna(doc, { feed, ground: doc.nets.findIndex((n) => n.name === 'ARM'), f0: 2.2e9 });
    expect(typeof none).toBe('string');
  }, 240_000);
});

describe('Antenna analysis (26.178): the example board, an inverted F for 2.45 GHz', () => {
  it('is a board like any other: it is written and read back, and the panel\'s first guess is its feed, its ground and its frequency', () => {
    const doc = readPcbDoc(antennaSampleBytes(), ANTENNA_SAMPLE.name);
    expect(doc.nets.map((n) => n.name)).toEqual(['GND', 'RF']);
    expect(doc.prims.filter((p) => p.kind === 'track').length).toBe(3);
    expect(doc.prims.filter((p) => p.kind === 'region').length).toBe(2);
    const f = readAntennaForm(doc, ANTENNA_SAMPLE.name);
    expect(f).toMatchObject({ part: '', pad: 'FEED', ground: 'GND', f0: '2450', detail: 'coarse' });
    expect(feedPads(doc).map((p) => `${p.pad}:${p.net}`)).toEqual(['FEED:RF']);
    const setup = formAntenna(doc, f);
    if (typeof setup === 'string') throw new Error(setup);
    expect(setup).toMatchObject({ f0: 2.45e9, span: 0.6, r0: 50, tanD: 0.02, cell: DETAIL.coarse.cell, cells: DETAIL.coarse.cells });
    // What is missing is said
    expect(formAntenna(doc, { ...f, pad: '' })).toBe('Pick the pad the antenna is fed at.');
    expect(formAntenna(doc, { ...f, ground: '' })).toBe('Pick the ground net.');
    expect(formAntenna(doc, { ...f, f0: '5' })).toBe('Give the frequency, 50 MHz to 30 GHz.');
    // For a lower frequency the cells grow with the wavelength's root
    expect((formAntenna(doc, { ...f, f0: '868' }) as { cell: number }).cell).toBeCloseTo(DETAIL.coarse.cell * Math.sqrt(2450 / 868), 9);
  });

  it('matches at 2.45 GHz, radiates most of what it accepts, and its current is on the antenna', async () => {
    const doc = antennaSampleDoc();
    const setup = formAntenna(doc, readAntennaForm(doc, ANTENNA_SAMPLE.name));
    if (typeof setup === 'string') throw new Error(setup);
    const r = await analyse(doc, setup);
    expect(r.model.port.kind).toBe('gap');
    expect(r.at.s11).toBeLessThan(-12);
    expect(Math.abs(r.best.f / 2.45e9 - 1)).toBeLessThan(0.02);
    expect(r.at.s11).toBeLessThan(-20);
    expect(r.band![0]).toBeLessThan(2.4e9); expect(r.band![1]).toBeGreaterThan(2.5e9);
    expect(r.efficiencyAll).toBeGreaterThan(0.85); expect(r.efficiencyAll).toBeLessThan(1);
    expect(r.gain).toBeGreaterThan(1); expect(r.gain).toBeLessThan(5);
    expect(r.realised).toBeLessThanOrEqual(r.gain);
    expect(r.settled).toBe(true);
    // The current: the most at the foot of the stub to ground (an inverted F's current is largest where it is shorted), little at the arm's open end
    const P = (x: number, y: number) => ({ x: mm(25 + x), y: mm(25 + y) });
    const foot = currentAt(r, P(ANTENNA_SAMPLE.short, 44), L.TOP)!, end = currentAt(r, P(ANTENNA_SAMPLE.end - 0.5, ANTENNA_SAMPLE.arm), L.TOP)!, far = currentAt(r, P(15, 10), L.TOP)!;
    expect(foot.db).toBeGreaterThan(-8);
    expect(end.db).toBeLessThan(foot.db - 6);
    expect(far.db).toBeLessThan(-12);
    expect(currentAt(r, P(-200, 0), L.TOP)).toBeNull();
    // Its picture: the board and a little round it, coloured where the current is within 40 dB of the largest
    const px = currentPixels(r, L.TOP)!;
    expect(px.width).toBeGreaterThan(30); expect(px.height).toBeGreaterThan(px.width);
    let lit = 0;
    for (let q = 3; q < px.data.length; q += 4) if (px.data[q]) lit++;
    expect(lit).toBeGreaterThan(50); expect(lit).toBeLessThan(px.width * px.height);
    expect(currentPixels(r, L.MULTI)).toBeNull();
    // Already matched well: the networks offered would still bring it to 50 Ω
    expect(r.match.length).toBeGreaterThanOrEqual(1);
    expect(matchText(r.match[0]!)).toMatch(/^[\d.]+ (nH|pF) (in series|across the feed) at the antenna, then [\d.]+ (nH|pF) (in series|across the feed)$/);

    // 26.179. The current's two parts at each node make its size; through the cycle its picture changes and comes round
    const sheet = r.current[0]!, at = sheet.a.indexOf(sheet.max);
    expect(Math.hypot(sheet.k[4 * at]!, sheet.k[4 * at + 1]!, sheet.k[4 * at + 2]!, sheet.k[4 * at + 3]!)).toBeCloseTo(sheet.max, 3);
    const frame = (phase: number) => Array.from(currentPixels(r, L.TOP, 40, phase)!.data);
    const f0 = frame(0), f1 = frame(Math.PI / 2);
    expect(f1).not.toEqual(f0);
    expect(frame(2 * Math.PI)).toEqual(f0);
    // Half a cycle on the current is the same size the other way: the same picture
    expect(frame(Math.PI)).toEqual(f0);
    // The report: the set-up, the figures, the match across the band, the gain round the board
    const text = antennaReport(r, { board: ANTENNA_SAMPLE.name, feed: 'pad FEED', ground: 'GND', port: 'across the gap to GND on the pad\'s layer', on: 'the processor', seconds: 31 });
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('Antenna analysis of Antenna Example.PcbDoc');
    expect(lines).toContain('Feed: pad FEED, against GND; the port across the gap to GND on the pad\'s layer; source 50 Ω');
    expect(lines).toContain('For 2450.0 MHz, looked at from 1715.0 MHz to 3185.0 MHz; laminate loss tangent 0.02');
    expect(text).toMatch(/Impedance {6}[\d.]+ [+-] j[\d.]+ Ω/);
    expect(text).toMatch(/Best match -[\d.]+ dB at 24\d\d\.\d MHz/);
    expect(text).toMatch(/Under -10 dB from 22\d\d\.\d MHz to 26\d\d\.\d MHz/);
    expect(lines.filter((l) => /^ +\d+\.\d +-?[\d.]+ +-?[\d.]+ +-[\d.]+$/.test(l)).length).toBe(41);
    expect(lines.filter((l) => /^ +\d+° /.test(l)).length).toBe(24);
    expect(text).not.toMatch(/[–—]|NaN|undefined|Infinity/);
  }, 300_000);
});
