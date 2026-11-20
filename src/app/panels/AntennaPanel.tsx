/**
 * Antenna Analysis (Tools › Antenna Analysis): an antenna drawn in the board's copper, worked out
 * from the copper. The pad it is fed at, the ground it works against, the frequency it is for;
 * Analyse steps Maxwell's equations through the board and the air round it and gives the match
 * across the band (S11, the impedance on a Smith chart), the parts that would match it, how much
 * of the power it radiates and where (three cuts of the pattern), with the current on the copper
 * laid over the board.
 */
import { signal } from '@preact/signals';
import { Icon } from '../icons';
import { SectionHead, Tool } from './kv';
import { active, activeScope, docs, tick } from '../state';
import { commands } from '../../core/commands';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../../editors/pcb/PcbLibEditor';
import { groundName } from '../../analysis/rail';
import type { AntennaResult, Match } from '../../analysis/antenna';
import { antennaReport } from '../../analysis/antennaReport';
import { RAMP_CSS, ramp } from '../../analysis/powerMap';
import { DETAIL, antennaBusy, antennaRun, antennaShow, askGpu, currentAntenna, feedPads, formAntenna, gpuThere, readAntennaForm, runAntenna, saveAntennaForm, showAntenna, stopAntenna, type AntennaForm } from '../antennaRun';

const forms = new Map<string, AntennaForm>(), changed = signal(0);

const mhz = (f: number) => `${(f / 1e6).toFixed(f < 1e9 ? 1 : 0)} MHz`;
const ohm = (z: [number, number]) => `${z[0].toFixed(1)} ${z[1] < 0 ? '−' : '+'} j${Math.abs(z[1]).toFixed(1)} Ω`;
const part = (p: Match['parts'][number]) => `${p.kind === 'L' ? `${(p.value * 1e9).toFixed(p.value < 1e-8 ? 1 : 0)} nH` : `${(p.value * 1e12).toFixed(p.value < 1e-11 ? 1 : 0)} pF`} ${p.where === 'series' ? 'in series' : 'across the feed'}`;
/** A matching network in words: the part at the antenna first. */
export const matchText = (m: Match) => `${part(m.parts[0]!)} at the antenna, then ${part(m.parts[1]!)}`;

/** S11 against frequency, with the -10 dB line and the frequency the antenna is for. */
function MatchChart({ r }: { r: AntennaResult }) {
  const W = 320, H = 140, L = 30, B = 18, T = 6, R = 8;
  const lo = Math.min(-20, Math.floor(Math.min(...r.s11) / 10) * 10), f0 = r.f[0]!, f1 = r.f[r.f.length - 1]!;
  const X = (f: number) => L + ((W - L - R) * (f - f0)) / (f1 - f0), Y = (v: number) => T + ((H - T - B) * Math.min(0, Math.max(lo, v))) / lo;
  const pts = Array.from(r.f, (f, k) => `${X(f).toFixed(1)},${Y(r.s11[k]!).toFixed(1)}`).join(' ');
  const ticks: number[] = [];
  for (let v = 0; v >= lo; v -= 10) ticks.push(v);
  return (
    <svg class="pdn-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`S11 from ${mhz(f0)} to ${mhz(f1)}: ${r.at.s11.toFixed(1)} dB at ${mhz(r.at.f)}, lowest ${r.best.s11.toFixed(1)} dB at ${mhz(r.best.f)}`}>
      {ticks.map((v) => <g key={v}><path d={`M${L},${Y(v).toFixed(1)} H${W - R}`} class="pdn-grid" /><text x={L - 3} y={Y(v) + 3} text-anchor="end">{v}</text></g>)}
      {[f0, (f0 + f1) / 2, f1].map((f, k) => <text key={k} x={X(f)} y={H - 5} text-anchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}>{(f / 1e6).toFixed(0)}{k === 2 ? ' MHz' : ''}</text>)}
      <path d={`M${L},${Y(-10).toFixed(1)} H${W - R}`} class="pdn-target" />
      <path d={`M${X(r.at.f).toFixed(1)},${T} V${H - B}`} class="pdn-limit-a" />
      <polyline points={pts} class="pdn-z" />
    </svg>
  );
}

/** The impedance across the band on a Smith chart for the source's resistance, a dot where the antenna is to work. */
function SmithChart({ r }: { r: AntennaResult }) {
  const S = 150, C = S / 2, Rr = S / 2 - 8, r0 = r.model.setup.r0;
  const gamma = (re: number, im: number): [number, number] => { const a = re / r0, b = im / r0, d = (a + 1) * (a + 1) + b * b; return [(a * a + b * b - 1) / d, (2 * b) / d]; };
  const P = (g: [number, number]) => `${(C + Rr * g[0]).toFixed(1)},${(C - Rr * g[1]).toFixed(1)}`;
  const pts = Array.from(r.f, (_, k) => P(gamma(r.zRe[k]!, r.zIm[k]!))).join(' ');
  const here = gamma(r.at.z[0], r.at.z[1]);
  // Circles of constant resistance, arcs of constant reactance (clipped to the chart)
  const rs = [0.2, 0.5, 1, 2, 5], xs = [0.2, 0.5, 1, 2, 5];
  return (
    <svg class="pdn-chart ant-smith" viewBox={`0 0 ${S} ${S}`} role="img" aria-label={`Smith chart for ${r0} Ω: the impedance from ${mhz(r.f[0]!)} to ${mhz(r.f[r.f.length - 1]!)}; ${ohm(r.at.z)} at ${mhz(r.at.f)}`}>
      <defs><clipPath id="ant-smith-clip"><circle cx={C} cy={C} r={Rr} /></clipPath></defs>
      <g clip-path="url(#ant-smith-clip)">
        {rs.map((q) => <circle key={`r${q}`} cx={C + (Rr * q) / (1 + q)} cy={C} r={Rr / (1 + q)} class="pdn-grid" />)}
        {xs.flatMap((q) => [1, -1].map((sg) => <circle key={`x${q}${sg}`} cx={C + Rr} cy={C - (sg * Rr) / q} r={Rr / q} class="pdn-grid" />))}
        <path d={`M${C - Rr},${C} H${C + Rr}`} class="pdn-grid" />
      </g>
      <circle cx={C} cy={C} r={Rr} class="th-axis" />
      <polyline points={pts} class="pdn-z" />
      <circle cx={C + Rr * here[0]} cy={C - Rr * here[1]} r={3} class="ant-dot" />
    </svg>
  );
}

/** Three cuts of the gain: round the board in its own plane, and over the top through its x and its y. */
function PatternChart({ r }: { r: AntennaResult }) {
  const S = 170, C = S / 2, Rr = S / 2 - 12, p = r.pattern, nt = p.theta.length, np = p.phi.length;
  const gain = (it: number, ip: number) => 10 * Math.log10(Math.max(((4 * Math.PI * p.u[it * np + ip]!) / p.power) * r.efficiencyAll, 1e-9));
  const top = Math.ceil(r.gain), floor = top - 30;
  const rad = (g: number) => (Rr * Math.max(0, g - floor)) / 30;
  // An angle on the chart: 0 at the top, clockwise
  const at = (g: number, a: number) => `${(C + rad(g) * Math.sin(a)).toFixed(1)},${(C - rad(g) * Math.cos(a)).toFixed(1)}`;
  const eq = (nt - 1) / 2;
  // In the board's plane: the angle is the azimuth, +x at the top of the chart turned to the right-hand side as on the board
  const plane = Array.from({ length: np + 1 }, (_, q) => at(gain(eq, q % np), Math.PI / 2 - p.phi[q % np]!)).join(' ');
  // Over the top: from straight up (the top layer's side) down towards +x or +y and round the back
  const over = (ip: number) => [...Array.from({ length: nt }, (_, it) => at(gain(it, ip), p.theta[it]!)), ...Array.from({ length: nt }, (_, it) => at(gain(nt - 1 - it, (ip + np / 2) % np), Math.PI + p.theta[it]!))].join(' ');
  return (
    <svg class="pdn-chart ant-pattern" viewBox={`0 0 ${S} ${S + 14}`} role="img" aria-label={`The antenna's gain in three cuts, the rings ${top}, ${top - 10} and ${top - 20} dBi: round the board in its plane, and over its top through x and through y; the most is ${r.gain.toFixed(1)} dBi`}>
      {[0, 10, 20].map((d) => <circle key={d} cx={C} cy={C} r={(Rr * (30 - d)) / 30} class={d ? 'pdn-grid' : 'th-axis'} />)}
      <path d={`M${C - Rr},${C} H${C + Rr} M${C},${C - Rr} V${C + Rr}`} class="pdn-grid" />
      {[0, 10, 20].map((d) => <text key={d} x={C + 2} y={C - (Rr * (30 - d)) / 30 + 8}>{top - d}</text>)}
      <polyline points={plane} class="ant-cut-plane" /><polyline points={over(0)} class="ant-cut-x" /><polyline points={over(np / 4)} class="ant-cut-y" />
      <g class="ant-legend">
        <path d={`M4,${S + 6} h14`} class="ant-cut-plane" /><text x={20} y={S + 9}>in the board's plane</text>
        <path d={`M92,${S + 6} h10`} class="ant-cut-x" /><text x={104} y={S + 9}>over x</text>
        <path d={`M132,${S + 6} h10`} class="ant-cut-y" /><text x={144} y={S + 9}>over y</text>
      </g>
    </svg>
  );
}

/** How the pattern in three dimensions is turned: round the board's z, and tipped towards the eye (radians). */
const turn = signal({ az: -0.6, el: 1.05 });

/** The gain in every direction as a shape: far from the middle where the antenna sends most, coloured the same way; drag to turn it. */
function PatternSolid({ r }: { r: AntennaResult }) {
  const S = 220, { az, el } = turn.value;
  const draw = (cv: HTMLCanvasElement | null) => {
    const g = cv?.getContext('2d');
    if (!cv || !g) return;
    const p = r.pattern, nt = p.theta.length, np = p.phi.length, top = Math.max(...p.u), C = S / 2, R = S / 2 - 14;
    g.clearRect(0, 0, S, S);
    const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
    // Turned round z, then tipped: x to the right, y up the screen, d towards the eye
    const see = (x: number, y: number, z: number) => { const u = x * ca - y * sa, v = x * sa + y * ca; return { x: C + R * u, y: C - R * (v * ce + z * se), d: z * ce - v * se }; };
    // Each direction's place: 30 dB from the most to the middle
    const level = (q: number) => Math.max(0, 1 + (10 * Math.log10(Math.max(p.u[q]! / top, 1e-9))) / 30);
    const at = (it: number, ip: number) => { const q = it * np + (ip % np), l = level(q), st = Math.sin(p.theta[it]!); return { l, ...see(l * st * Math.cos(p.phi[ip % np]!), l * st * Math.sin(p.phi[ip % np]!), l * Math.cos(p.theta[it]!)) }; };
    const faces: { pts: { x: number; y: number }[]; d: number; l: number }[] = [];
    for (let it = 0; it + 1 < nt; it++) for (let ip = 0; ip < np; ip++) {
      const a = at(it, ip), b = at(it + 1, ip), c = at(it + 1, ip + 1), d = at(it, ip + 1);
      faces.push({ pts: [a, b, c, d], d: (a.d + b.d + c.d + d.d) / 4, l: (a.l + b.l + c.l + d.l) / 4 });
    }
    // The board, to its own proportions, and the three axes: what is behind the shape first
    const m = r.model.board, k = 0.42 / Math.max(m.w, m.h), bw = m.w * k, bh = m.h * k;
    const board = [see(-bw, -bh, 0), see(bw, -bh, 0), see(bw, bh, 0), see(-bw, bh, 0)];
    const axes: [string, { x: number; y: number; d: number }, string][] = [['x', see(1.12, 0, 0), '#e0241b'], ['y', see(0, 1.12, 0), '#2e9a44'], ['z', see(0, 0, 1.12), '#1a6fd0']];
    const axis = (a: (typeof axes)[number]) => { g.strokeStyle = a[2]; g.fillStyle = a[2]; g.lineWidth = 1.2; g.beginPath(); g.moveTo(C, C); g.lineTo(a[1].x, a[1].y); g.stroke(); g.font = '10px sans-serif'; g.fillText(a[0], a[1].x + 3, a[1].y + 3); };
    for (const a of axes) if (a[1].d < 0) axis(a);
    faces.sort((a, b) => a.d - b.d);
    g.lineWidth = 0.3;
    for (const f of faces) {
      const [red, gr, bl] = ramp(f.l);
      g.fillStyle = `rgb(${red},${gr},${bl})`; g.strokeStyle = 'rgba(0,0,0,0.25)';
      g.beginPath(); g.moveTo(f.pts[0]!.x, f.pts[0]!.y); for (let q = 1; q < 4; q++) g.lineTo(f.pts[q]!.x, f.pts[q]!.y); g.closePath(); g.fill(); g.stroke();
    }
    g.strokeStyle = 'rgba(128,128,128,0.9)'; g.lineWidth = 1; g.setLineDash([3, 2]);
    g.beginPath(); g.moveTo(board[0]!.x, board[0]!.y); for (let q = 1; q < 4; q++) g.lineTo(board[q]!.x, board[q]!.y); g.closePath(); g.stroke(); g.setLineDash([]);
    for (const a of axes) if (a[1].d >= 0) axis(a);
  };
  const drag = (ev: PointerEvent) => {
    const cv = ev.currentTarget as HTMLCanvasElement, x0 = ev.clientX, y0 = ev.clientY, from = turn.value;
    cv.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => { turn.value = { az: from.az + (e.clientX - x0) * 0.012, el: Math.min(Math.PI / 2, Math.max(0, from.el - (e.clientY - y0) * 0.012)) }; };
    const up = () => { cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up); };
    cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  };
  const key = (ev: KeyboardEvent) => {
    const d = ev.key === 'ArrowLeft' ? [-0.15, 0] : ev.key === 'ArrowRight' ? [0.15, 0] : ev.key === 'ArrowUp' ? [0, 0.15] : ev.key === 'ArrowDown' ? [0, -0.15] : null;
    if (!d) return;
    ev.preventDefault(); ev.stopPropagation();
    turn.value = { az: turn.value.az + d[0]!, el: Math.min(Math.PI / 2, Math.max(0, turn.value.el + d[1]!)) };
  };
  return <canvas class="ant-solid" width={S} height={S} ref={draw} tabIndex={0} role="img" onPointerDown={drag} onKeyDown={key}
    aria-label={`The antenna's gain in every direction as a shape, 30 dB from its most (${r.gain.toFixed(1)} dBi) to its middle, with the board's outline and its x, y and z; drag it or use the arrow keys to turn it`} />;
}

export function AntennaPanel() {
  void tick.value; void changed.value; void antennaRun.value; void antennaShow.value; void gpuThere.value; void turn.value;
  askGpu();
  const od = active.value, e = od?.editor;
  const kept = antennaRun.value, busy = antennaBusy.value;
  if (kept && !busy && !docs.value.some((d) => d.editor === kept.ed)) queueMicrotask(() => { if (antennaRun.value === kept) antennaRun.value = null; });
  const example = <button class="linklike" title="A two-layer board of Konium's own with an inverted F for 2.45 GHz at its end" onClick={() => commands.run('antenna.example', activeScope.value)}>Open the example board</button>;
  if (!od || !(e instanceof PcbEditor) || e instanceof PcbLibEditor) return <div class="panel-body powerpanel antennapanel"><p class="panel-empty">Open a board to analyse an antenna on it.</p><p class="small">{example}</p></div>;
  const doc = e.doc;
  let f = forms.get(od.id);
  if (!f) { f = readAntennaForm(doc, od.name); forms.set(od.id, f); }
  const set = (patch: Partial<AntennaForm>) => { const next = { ...f!, ...patch }; forms.set(od.id, next); saveAntennaForm(od.name, next); changed.value++; };
  const pads = feedPads(doc), parts = [...new Set(pads.map((p) => p.part))], ofPart = pads.filter((p) => p.part === f!.part);
  // Every net, the grounds first: an antenna's ground may have no part on it at all
  const nets = doc.nets.map((n) => n.name).filter(Boolean).sort((a, b) => Number(groundName(b)) - Number(groundName(a)) || a.localeCompare(b, undefined, { numeric: true }));
  const setup = formAntenna(doc, f), run = currentAntenna(e), stale = !run && antennaRun.value?.ed === e;
  type K = 'f0' | 'span' | 'r0' | 'tanD';
  const text = (k: K, label: string, unit: string, title: string, name = label) => (
    <label class="pw-field" title={title}>{label} <input aria-label={name} inputMode="decimal" value={f![k]} onChange={(ev) => set({ [k]: (ev.target as HTMLInputElement).value.trim() } as Partial<AntennaForm>)} /> {unit}</label>
  );
  // The pad selected on the board, as the feed
  const picked = () => {
    // A free pad is selected by itself; a click on a part's pad selects the part, which is then the part to pick the pad of
    const sel = new Set<unknown>([...e.selection].map((k) => e.primByKey(k)).filter((p) => p?.kind === 'pad'));
    const hits = pads.filter((p) => sel.has(doc.prims[p.prim]));
    if (hits.length === 1) set({ part: hits[0]!.part, pad: hits[0]!.pad });
    else if (hits.length && hits.every((h) => h.part === hits[0]!.part)) set({ part: hits[0]!.part, pad: '' });
  };
  const r = run?.result;
  const portText = (rr: AntennaResult) => (rr.model.port.kind === 'through' ? `through the laminate to ${f!.ground} on ${e.layerLabel(rr.model.port.to!)}` : `across the gap to ${f!.ground} on the pad's layer`);
  const report = () => {
    if (!run) return;
    const text = antennaReport(run.result, { board: od.name, feed: `${f!.part ? `${f!.part} pad ` : 'pad '}${f!.pad}`, ground: f!.ground, port: portText(run.result), on: run.on, seconds: run.ms / 1000 });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `${od.name.replace(/\.[^.]+$/, '')}_Antenna.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const lossy = r ? { laminate: Math.max(0, 1 - r.efficiency) / (1 + r.copperLoss), copper: r.copperLoss / (1 + r.copperLoss) } : null;
  return (
    <div class="panel-body powerpanel antennapanel">
      <section aria-label="Feed">
        <SectionHead title="Feed"><Tool icon="anPick" label="Use the selection" title="Use the selection: takes the pad selected on the board as the feed (or, with a part selected, that part)" onClick={picked} /></SectionHead>
        <div class="pw-grid">
          <label class="pw-field" title="The part whose pad feeds the antenna: the last part before the antenna's own copper (the parts of a matching network are not in the model)">Part <select aria-label="Feed part" value={f.part} onChange={(ev) => set({ part: (ev.target as HTMLSelectElement).value, pad: '' })}>
            {parts.map((p) => <option key={p} value={p}>{p || '(free pads)'}</option>)}
          </select></label>
          <label class="pw-field">Pad <select aria-label="Feed pad" value={f.pad} onChange={(ev) => set({ pad: (ev.target as HTMLSelectElement).value })}>
            <option value="">(pick a pad)</option>{ofPart.map((p) => <option key={p.prim} value={p.pad}>{p.pad} ({p.net})</option>)}
          </select></label>
        </div>
        <label class="pw-field" title="The net the antenna works against: the port is between the feed pad and this net's copper">Ground <select aria-label="Ground net" value={f.ground} onChange={(ev) => set({ ground: (ev.target as HTMLSelectElement).value })}>
          <option value="">(pick a net)</option>{nets.map((n) => <option key={n} value={n}>{n}</option>)}
        </select></label>
      </section>
      <section aria-label="Band and board">
        <h4>Band and board</h4>
        <div class="pw-grid">
          {text('f0', 'For', 'MHz', 'The frequency the antenna is to work at: the efficiency, the pattern and the current are worked out there', 'Frequency')}
          {text('span', 'Band', '%', 'How wide a band round it the match is drawn over, as a share of it', 'Band')}
          {text('r0', 'Source', 'Ω', 'The resistance of what drives the antenna', 'Source resistance')}
          {text('tanD', 'Loss tangent', '', 'The laminate\'s loss tangent: 0.02 for FR-4', 'Loss tangent')}
        </div>
        <label class="pw-field" title="The size of the grid's cells over the antenna: finer is nearer and slower. It follows the wavelength, so these are for 2.45 GHz">Detail <select aria-label="Detail" value={f.detail} onChange={(ev) => set({ detail: (ev.target as HTMLSelectElement).value as AntennaForm['detail'] })}>
          {(Object.keys(DETAIL) as AntennaForm['detail'][]).map((k) => <option key={k} value={k}>{DETAIL[k].label}</option>)}
        </select></label>
      </section>
      {gpuThere.value && <label class="small" title="The steps are taken on the graphics card instead of the processor: the same figures, sooner. Untick it if the card gives trouble"><input type="checkbox" checked={f.gpu} onChange={(ev) => set({ gpu: (ev.target as HTMLInputElement).checked })} /> Run on the graphics card</label>}
      <p class="small muted">The copper is all that is modelled: feed the antenna after any matching parts. No antenna to hand? {example}.</p>
      <div class="pw-run">
        {busy ? <button class="btn" onClick={stopAntenna}><Icon name="kpStop" />Stop</button> : <button class="btn default" disabled={typeof setup === 'string'} onClick={() => void runAntenna(e, f!)}><Icon name="kpStart" />Analyse</button>}
        <span class="muted small" role="status">{busy
          ? (busy.step ? `Step ${busy.step.toLocaleString('en-GB')} of at most ${busy.limit.toLocaleString('en-GB')}; the port at ${(busy.fall * 100).toFixed(busy.fall < 0.1 ? 1 : 0)} % of its peak (${busy.note})` : busy.note)
          : typeof setup === 'string' ? setup : stale ? 'The board has changed since the analysis: analyse again.' : ''}</span>
      </div>
      {busy && busy.step > 0 && <progress aria-label="Progress" max={1} value={Math.max(busy.step / busy.limit, busy.fall < 1 ? Math.min(1, Math.log(busy.fall) / Math.log(0.01)) : 0)} />}
      {run && r && lossy && (
        <section aria-label="Results" class="pw-results">
          <SectionHead title="Results"><Tool icon="anReport" label="Report..." title="Report: what was analysed and what was found, as a file" onClick={report} /></SectionHead>
          <p class="small ant-at">At {mhz(r.at.f)}: {ohm(r.at.z)}, S11 {r.at.s11.toFixed(1)} dB (VSWR {Number.isFinite(r.at.vswr) ? r.at.vswr.toFixed(2) : 'very high'}).</p>
          <MatchChart r={r} />
          <p class={`small${r.band ? '' : ' pw-open'}`}>Best match {r.best.s11.toFixed(1)} dB at {mhz(r.best.f)}. {r.band ? `Under −10 dB from ${mhz(r.band[0])} to ${mhz(r.band[1])} (${Math.round((r.band[1] - r.band[0]) / 1e6)} MHz wide).` : 'Nowhere in the band is it under −10 dB.'}</p>
          <SmithChart r={r} />
          {r.match.length > 0 && r.at.s11 > -20 && <p class="small ant-match">To match it at {mhz(r.at.f)}: {r.match.slice(0, 2).map(matchText).join('; or ')}.</p>}
          <p class="small ant-eff">It radiates {(r.efficiencyAll * 100).toFixed(0)} % of the power it accepts: the laminate takes {(lossy.laminate * 100).toFixed(0)} %, the copper about {(lossy.copper * 100).toFixed(0)} % (estimated from the current on it).</p>
          <PatternChart r={r} />
          <p class="small ant-gain">Directivity {r.directivity.toFixed(1)} dBi, gain {r.gain.toFixed(1)} dBi, {r.realised.toFixed(1)} dBi with the mismatch. The most goes {Math.round((r.pattern.peakTheta * 180) / Math.PI)}° from straight up off the top layer, towards {Math.round((r.pattern.peakPhi * 180) / Math.PI)}° round from the board's x.</p>
          <PatternSolid r={r} />
          <label class="small"><input type="checkbox" checked={antennaShow.value.on} onChange={(ev) => { antennaShow.value = { ...antennaShow.value, on: (ev.target as HTMLInputElement).checked }; showAntenna(); }} /> Show the current on the board</label>
          {antennaShow.value.on && <label class="small" title="The current as it goes through its cycle, sixteen moments of it in turn, instead of its size"><input type="checkbox" checked={antennaShow.value.moving} onChange={(ev) => { antennaShow.value = { ...antennaShow.value, moving: (ev.target as HTMLInputElement).checked }; showAntenna(); }} /> In motion</label>}
          {antennaShow.value.on && <div class="pw-key"><span>−40 dB</span><span class="pw-ramp" style={{ background: RAMP_CSS }} /><span>largest</span></div>}
          <p class="small muted ant-model">{r.model.count.toLocaleString('en-GB')} cells, {(r.model.cell * 1e3).toFixed(2)} mm over the antenna; the port {portText(r)}; {r.steps.toLocaleString('en-GB')} steps ({(r.time * 1e9).toFixed(1)} ns) in {(run.ms / 1000).toFixed(0)} s on {run.on}.</p>
          {!r.settled && <p class="small pw-open">The port was still at {(r.decay * 100).toFixed(1)} % of its peak when the run ended: the curves have a ripple the antenna does not. A sharper resonance needs a longer run.</p>}
          {r.model.notes.map((n, k) => <p key={k} class="small muted">{n}</p>)}
        </section>
      )}
    </div>
  );
}
