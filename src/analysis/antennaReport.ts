/** Tools › Antenna Analysis › Report: the set-up, the results and the match across the band as text. */
import type { AntennaResult, Match } from './antenna';

const mhz = (f: number) => `${(f / 1e6).toFixed(1)} MHz`;
const part = (p: Match['parts'][number]) => `${p.kind === 'L' ? `${(p.value * 1e9).toFixed(2)} nH` : `${(p.value * 1e12).toFixed(2)} pF`} ${p.where === 'series' ? 'in series' : 'across the feed'}`;

export function antennaReport(r: AntennaResult, o: { board: string; feed: string; ground: string; port: string; on: string; seconds: number }): string {
  const s = r.model.setup, L: string[] = [];
  const pad = (t: string, n: number) => t.padStart(n);
  L.push(`Antenna analysis of ${o.board}`, '');
  L.push(`Feed: ${o.feed}, against ${o.ground}; the port ${o.port}; source ${s.r0} Ω`);
  L.push(`For ${mhz(s.f0)}, looked at from ${mhz(r.f[0]!)} to ${mhz(r.f[r.f.length - 1]!)}; laminate loss tangent ${s.tanD}`);
  L.push(`Model: ${r.model.count.toLocaleString('en-GB')} cells, ${(r.model.cell * 1e3).toFixed(2)} mm over the antenna; ${r.steps.toLocaleString('en-GB')} steps (${(r.time * 1e9).toFixed(2)} ns) in ${o.seconds.toFixed(0)} s on ${o.on}`);
  for (const n of r.model.notes) L.push(n);
  if (!r.settled) L.push(`The port was still at ${(r.decay * 100).toFixed(1)} % of its peak when the run ended: the curves have a ripple the antenna does not`);
  L.push('', `At ${mhz(r.at.f)}`);
  L.push(`  Impedance      ${r.at.z[0].toFixed(2)} ${r.at.z[1] < 0 ? '-' : '+'} j${Math.abs(r.at.z[1]).toFixed(2)} Ω`);
  L.push(`  S11            ${r.at.s11.toFixed(2)} dB (VSWR ${Number.isFinite(r.at.vswr) ? r.at.vswr.toFixed(2) : 'very high'})`);
  L.push(`  Radiated       ${(r.efficiencyAll * 100).toFixed(1)} % of the power accepted (the laminate's loss ${((1 - r.efficiency) / (1 + r.copperLoss) * 100).toFixed(1)} %, the copper's about ${(r.copperLoss / (1 + r.copperLoss) * 100).toFixed(1)} %, estimated from the current on it)`);
  L.push(`  Directivity    ${r.directivity.toFixed(2)} dBi`, `  Gain           ${r.gain.toFixed(2)} dBi`, `  With mismatch  ${r.realised.toFixed(2)} dBi`);
  L.push(`  The most goes  ${Math.round((r.pattern.peakTheta * 180) / Math.PI)}° from straight up off the top layer, ${Math.round((r.pattern.peakPhi * 180) / Math.PI)}° round from the board's x`);
  L.push('', `Best match ${r.best.s11.toFixed(2)} dB at ${mhz(r.best.f)}`);
  L.push(r.band ? `Under -10 dB from ${mhz(r.band[0])} to ${mhz(r.band[1])} (${mhz(r.band[1] - r.band[0])} wide)` : 'Nowhere in the band under -10 dB');
  if (r.match.length) { L.push('', `Networks that match it at ${mhz(r.at.f)} (the part at the antenna first)`); for (const m of r.match) L.push(`  ${part(m.parts[0]!)}, then ${part(m.parts[1]!)}`); }
  L.push('', `${pad('MHz', 9)}${pad('R, Ω', 10)}${pad('X, Ω', 10)}${pad('S11, dB', 10)}`);
  for (let q = 0; q < r.f.length; q += 5) L.push(`${pad((r.f[q]! / 1e6).toFixed(1), 9)}${pad(r.zRe[q]!.toFixed(1), 10)}${pad(r.zIm[q]!.toFixed(1), 10)}${pad(r.s11[q]!.toFixed(2), 10)}`);
  // The gain round the board in its plane and over its top, every 15°
  const p = r.pattern, np = p.phi.length, nt = p.theta.length, gain = (it: number, ip: number) => 10 * Math.log10(Math.max(((4 * Math.PI * p.u[it * np + ip]!) / p.power) * r.efficiencyAll, 1e-9));
  L.push('', 'Gain, dBi', `${pad('angle', 7)}${pad('in the plane', 14)}${pad('over x', 9)}${pad('over y', 9)}`);
  for (let a = 0; a < 360; a += 15) {
    const ip = Math.round((a / 360) * np) % np;
    // Over the top: the angle from straight up, down towards +x (or +y) and round the back
    const it = Math.round(((a <= 180 ? a : 360 - a) / 180) * (nt - 1)), back = a > 180 ? np / 2 : 0;
    L.push(`${pad(`${a}°`, 7)}${pad(gain((nt - 1) / 2, ip).toFixed(1), 14)}${pad(gain(it, back % np).toFixed(1), 9)}${pad(gain(it, (np / 4 + back) % np).toFixed(1), 9)}`);
  }
  L.push('', 'The model is the board\'s copper as thin sheets, its vias, the laminate and air. It leaves out the parts, the copper\'s thickness, solder mask, an enclosure, cables and a hand.');
  return L.join('\r\n') + '\r\n';
}
