/**
 * Supply Impedance (Tools › Supply Impedance): what a load sees looking into its supply, from a
 * few kilohertz to a few gigahertz. The supply and ground nets, what feeds the supply, the
 * capacitors between them with their values, and the target the impedance should stay under;
 * Analyse draws the impedance at the part picked against frequency, says where it is over the
 * target, and describes the planes. With a switching part given, the differential-mode
 * conducted emission is estimated against the Class A and Class B limits.
 */
import { signal } from '@preact/signals';
import { Icon } from '../icons';
import { SectionHead, Tool } from './kv';
import { active, docs, tick } from '../state';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../../editors/pcb/PcbLibEditor';
import { componentsOn, groundName, railNets } from '../../analysis/rail';
import { cisprLimit, type ConductedResult, type PdnResult } from '../../analysis/pdn';
import { farads, hertz, ohms, pdnReport, platesLine, verdict } from '../../analysis/pdnReport';
import { currentPdn, formCaps, formPdn, formPorts, formTarget, pdnBusy, pdnRun, readPdnForm, runPdn, savePdnForm, type PdnForm } from '../pdnRun';

const forms = new Map<string, PdnForm>(), changed = signal(0);

/** |Z| against frequency, both by decades, with the target across it. */
function ImpedanceChart({ r, port, target }: { r: PdnResult; port: number; target: number }) {
  const W = 320, H = 150, L = 40, B = 18, T = 6, R = 8, z = r.ports[port]!.z;
  let lo = target, hi = target;
  for (const v of z) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const y0 = Math.floor(Math.log10(lo)), y1 = Math.ceil(Math.log10(hi) + 1e-9), x0 = Math.log10(r.f[0]!), x1 = Math.log10(r.f[r.f.length - 1]!);
  const X = (f: number) => L + ((W - L - R) * (Math.log10(f) - x0)) / (x1 - x0), Y = (v: number) => T + (H - T - B) * (1 - (Math.log10(v) - y0) / Math.max(y1 - y0, 1));
  const pts: string[] = [];
  for (let k = 0; k < r.f.length; k++) if (Number.isFinite(z[k]!)) pts.push(`${X(r.f[k]!).toFixed(1)},${Y(z[k]!).toFixed(1)}`);
  /** A power of ten in ohms, as an axis says it: 10 mΩ, 1 Ω. */
  const decade = (d: number) => (d >= 0 ? `${10 ** d} Ω` : d >= -3 ? `${10 ** (d + 3)} mΩ` : `${Math.round(10 ** (d + 6))} µΩ`);
  const decades = (a: number, b: number) => { const o: number[] = []; for (let d = Math.ceil(a - 1e-9); d <= Math.floor(b + 1e-9); d++) o.push(d); return o; };
  return (
    <svg class="pdn-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Impedance at ${r.ports[port]!.designator} from ${hertz(r.f[0]!)} to ${hertz(r.f[r.f.length - 1]!)}, between ${ohms(lo)} and ${ohms(hi)}; the target ${ohms(target)}`}>
      {decades(y0, y1).map((d) => <g key={`y${d}`}><path d={`M${L},${Y(10 ** d).toFixed(1)} H${W - R}`} class="pdn-grid" /><text x={L - 3} y={Y(10 ** d) + 3} text-anchor="end">{decade(d)}</text></g>)}
      {decades(x0, x1).map((d) => <g key={`x${d}`}><path d={`M${X(10 ** d).toFixed(1)},${T} V${H - B}`} class="pdn-grid" /><text x={X(10 ** d)} y={H - 5} text-anchor="middle">{hertz(10 ** d).replace(' ', '')}</text></g>)}
      <path d={`M${L},${Y(target).toFixed(1)} H${W - R}`} class="pdn-target" />
      <polyline points={pts.join(' ')} class="pdn-z" />
    </svg>
  );
}

/** Each harmonic's level against the two limits, 150 kHz to 30 MHz. */
function EmissionChart({ n }: { n: ConductedResult }) {
  const W = 320, H = 130, L = 30, B = 18, T = 6, R = 8, lo = Math.min(20, Math.floor(Math.min(...n.level) / 20) * 20), hi = Math.max(100, Math.ceil(Math.max(...n.level) / 20) * 20);
  const X = (f: number) => L + ((W - L - R) * (Math.log10(f) - Math.log10(150e3))) / (Math.log10(30e6) - Math.log10(150e3)), Y = (v: number) => T + (H - T - B) * (1 - (Math.max(lo, v) - lo) / (hi - lo));
  const limit = (cls: 'A' | 'B') => [150e3, 499.9e3, 500e3, 4.999e6, 5e6, 30e6].map((f) => `${X(f).toFixed(1)},${Y(cisprLimit(f, cls)).toFixed(1)}`).join(' ');
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += 20) ticks.push(v);
  return (
    <svg class="pdn-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Conducted emission from 150 kHz to 30 MHz: ${n.f.length} harmonics, the nearest to the Class B limit ${Math.abs(n.margin).toFixed(1)} dB ${n.margin >= 0 ? 'under' : 'over'} it at ${hertz(n.marginAt)}`}>
      {ticks.map((v) => <g key={v}><path d={`M${L},${Y(v).toFixed(1)} H${W - R}`} class="pdn-grid" /><text x={L - 3} y={Y(v) + 3} text-anchor="end">{v}</text></g>)}
      {[150e3, 1e6, 10e6, 30e6].map((f) => <text key={f} x={X(f)} y={H - 5} text-anchor={f === 150e3 ? 'start' : f === 30e6 ? 'end' : 'middle'}>{hertz(f).replace(' ', '')}</text>)}
      <polyline points={limit('A')} class="pdn-limit-a" /><polyline points={limit('B')} class="pdn-target" />
      {n.f.map((f, k) => <path key={k} d={`M${X(f).toFixed(1)},${Y(lo)} V${Y(n.level[k]!).toFixed(1)}`} class={n.level[k]! > n.classB[k]! ? 'pdn-bar over' : 'pdn-bar'} />)}
    </svg>
  );
}

export function PdnPanel() {
  void tick.value; void changed.value; void pdnRun.value;
  const od = active.value, e = od?.editor;
  const kept = pdnRun.value;
  if (kept && !pdnBusy.value && !docs.value.some((d) => d.editor === kept.ed)) queueMicrotask(() => { if (pdnRun.value === kept) pdnRun.value = null; });
  if (!od || !(e instanceof PcbEditor) || e instanceof PcbLibEditor) return <p class="panel-empty">Open a board to look into its supplies.</p>;
  const doc = e.doc;
  let f = forms.get(od.id);
  if (!f) { f = readPdnForm(doc, od.name); forms.set(od.id, f); }
  const set = (patch: Partial<PdnForm>) => { const next = { ...f!, ...patch }; forms.set(od.id, next); savePdnForm(od.name, next); changed.value++; };
  const nets = railNets(doc), supply = doc.nets.findIndex((n) => n.name === f!.supply);
  const feeders = supply >= 0 ? componentsOn(doc, supply) : [], caps = formCaps(doc, f), ports = formPorts(doc, f);
  const setup = formPdn(doc, f), busy = pdnBusy.value, run = currentPdn(e), stale = !run && pdnRun.value?.ed === e, target = formTarget(f);
  type K = 'sourceR' | 'sourceL' | 'voltage' | 'ripple' | 'step' | 'noiseF' | 'noiseI' | 'noiseDuty' | 'noiseRise';
  const text = (k: K, label: string, unit: string, title: string, name = label) => (
    <label class="pw-field" title={title}>{label} <input aria-label={name} inputMode="decimal" value={f![k]} onChange={(ev) => set({ [k]: (ev.target as HTMLInputElement).value.trim() } as Partial<PdnForm>)} /> {unit}</label>
  );
  const capCell = (d: string, k: 'c' | 'esr' | 'esl', label: string, placeholder: string) => (
    <input type="text" aria-label={`${label} of ${d}`} placeholder={placeholder} value={f!.caps[d]?.[k] ?? ''}
      onChange={(ev) => { const v = (ev.target as HTMLInputElement).value.trim(), all = { ...f!.caps }, one = { ...(all[d] ?? {}) }; if (v) one[k] = v; else delete one[k]; if (Object.keys(one).length) all[d] = one; else delete all[d]; set({ caps: all }); }} />
  );
  const range = (k: 'from' | 'to', name: string, opts: [string, string][]) => <select aria-label={name} value={f![k]} onChange={(ev) => set({ [k]: (ev.target as HTMLSelectElement).value } as Partial<PdnForm>)}>{opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>;
  const r = run?.result, shown = r ? Math.max(0, r.ports.findIndex((p) => p.designator === f!.at)) : 0;
  const report = () => {
    if (!run) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([pdnReport(doc, run.result, od.name, run.target, (l) => e.layerLabel(l), run.noise)], { type: 'text/plain' }));
    a.download = `${od.name.replace(/\.[^.]+$/, '')}_SupplyImpedance.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <div class="panel-body powerpanel pdnpanel">
      <section aria-label="Supply">
        <h4>Supply</h4>
        <label class="pw-field">Net <select aria-label="Supply net" value={f.supply} onChange={(ev) => set({ supply: (ev.target as HTMLSelectElement).value, source: '', at: '' })}>
          <option value="">(pick a net)</option>{nets.map((n) => <option key={n.net} value={n.name}>{n.name} ({n.components})</option>)}
        </select></label>
        <label class="pw-field">Ground <select aria-label="Ground net" value={f.ground} onChange={(ev) => set({ ground: (ev.target as HTMLSelectElement).value })}>
          <option value="">(pick a net)</option>{nets.filter((n) => n.name !== f!.supply).sort((a, b) => Number(groundName(b.name)) - Number(groundName(a.name))).map((n) => <option key={n.net} value={n.name}>{n.name} ({n.components})</option>)}
        </select></label>
        <label class="pw-field" title="The regulator or connector that feeds the net: below the capacitors' reach it sets the impedance">Fed by <select aria-label="Source" value={f.source} onChange={(ev) => set({ source: (ev.target as HTMLSelectElement).value })}>
          <option value="">(nothing)</option>{feeders.map((c) => <option key={c.component} value={c.designator}>{c.designator}{c.comment ? ` ${c.comment}` : ''}</option>)}
        </select></label>
        <div class="pw-grid">
          {text('sourceR', 'its', 'mΩ', 'The source\'s output resistance', 'Source resistance')}
          {text('sourceL', 'and', 'nH', 'The source\'s output inductance: a regulator looks like an inductor above the reach of its loop', 'Source inductance')}
        </div>
      </section>
      <section aria-label="Capacitors" class="pw-loads">
        <h4>Capacitors</h4>
        <div class="pcbp-table" role="grid" aria-label="Capacitors" style={{ '--cols': '50px minmax(54px,1fr) 58px 54px' } as Record<string, string>}>
          <div class="pcbp-row head"><span>Part</span><span title="As read from the part's comment, or typed: 100n, 4u7, 10uF; a bare number is microfarads">Value</span><span title="Series resistance">ESR, mΩ</span><span title="Series inductance, the part's and its mounting's">ESL, nH</span></div>
          <div class="pcbp-body">
            {!caps.length && <p class="panel-empty">{supply < 0 ? 'Pick the nets.' : 'No capacitor between the two nets.'}</p>}
            {caps.map((c) => (
              <div key={c.component} role="row" class={`pcbp-row${c.known ? '' : ' pw-bad'}`}>
                <span title={c.comment}>{c.designator}</span>
                <span>{capCell(c.designator, 'c', 'Value', Number.isFinite(c.c) ? farads(c.c) : 'not given')}</span>
                <span>{capCell(c.designator, 'esr', 'Series resistance', Number.isFinite(c.esr) ? (c.esr * 1000).toFixed(0) : '')}</span>
                <span>{capCell(c.designator, 'esl', 'Series inductance', (c.esl * 1e9).toFixed(1))}</span>
              </div>
            ))}
          </div>
        </div>
        <p class="muted small">{caps.some((c) => !c.known) ? 'A capacitor with no value is left out: type one. ' : ''}Grey figures are taken where none is typed: the value from the part's comment, the resistance usual for a ceramic of that value, 1 nH.</p>
      </section>
      <section aria-label="Target and range">
        <h4>Target and range</h4>
        <div class="pw-grid">
          {text('voltage', 'Supply', 'V', 'The supply\'s voltage', 'Supply voltage')}
          {text('ripple', 'Ripple', '%', 'The ripple allowed, as a share of the voltage')}
          {text('step', 'Step', 'A', 'The largest sudden change in the load\'s current', 'Current step')}
        </div>
        <p class="small">The impedance should stay under {ohms(target)}: the ripple allowed over the step of current.</p>
        <label class="pw-field">From {range('from', 'From', [['100', '100 Hz'], ['1000', '1 kHz'], ['10000', '10 kHz'], ['100000', '100 kHz']])}</label>
        <label class="pw-field">To {range('to', 'To', [['100000000', '100 MHz'], ['1000000000', '1 GHz'], ['2000000000', '2 GHz'], ['5000000000', '5 GHz']])}</label>
      </section>
      <section aria-label="Conducted emission">
        <h4>Conducted emission</h4>
        <label class="pw-field" title="A switching regulator on the net: its pulsed current is the noise. Left empty, no emission is estimated">Switching part <select aria-label="Switching part" value={f.noisePart} onChange={(ev) => set({ noisePart: (ev.target as HTMLSelectElement).value })}>
          <option value="">(none)</option>{ports.map((p) => <option key={p.component} value={p.designator}>{p.designator}</option>)}
        </select></label>
        {f.noisePart && <div class="pw-grid">
          {text('noiseF', 'at', 'kHz', 'Its switching frequency', 'Switching frequency')}
          {text('noiseI', 'Pulses of', 'A', 'The height of the current pulses it draws from the net', 'Pulse current')}
          {text('noiseDuty', 'Duty', '%', 'The share of each cycle the current flows')}
          {text('noiseRise', 'Edges', 'ns', 'The rise and fall time of the pulses', 'Edge time')}
        </div>}
      </section>
      <div class="pw-run">
        <button class="btn default" disabled={!!busy || typeof setup === 'string'} onClick={() => void runPdn(e, f!)}><Icon name="kpStart" />Analyse</button>
        <span class="muted small" role="status">{busy ?? (typeof setup === 'string' ? setup : stale ? 'The board has changed since the analysis: analyse again.' : '')}</span>
      </div>
      {run && r && (
        <section aria-label="Results" class="pw-results">
          <SectionHead title="Results"><Tool icon="anReport" label="Report..." title="Report: what was analysed and what was found, as a file" onClick={report} /></SectionHead>
          <label class="pw-field">Looked at from <select aria-label="Looked at from" value={r.ports[shown]!.designator} onChange={(ev) => set({ at: (ev.target as HTMLSelectElement).value })}>
            {r.ports.map((p) => <option key={p.component} value={p.designator}>{p.designator}</option>)}
          </select></label>
          <ImpedanceChart r={r} port={shown} target={run.target} />
          <p class="small pdn-verdict">{verdict(r, shown, run.target)}</p>
          {r.ports[shown]!.peaks.length > 0 && <p class="small">Peaks: {r.ports[shown]!.peaks.slice(0, 4).map((p) => `${ohms(p.z)} at ${hertz(p.f)}`).join(', ')}.</p>}
          <p class="small muted">{platesLine(r, (l) => e.layerLabel(l), doc.board.copperStack)} <span>({(run.ms / 1000).toFixed(1)} s)</span></p>
          {run.noise && <>
            <EmissionChart n={run.noise} />
            <p class={`small${run.noise.margin < 0 ? ' pw-open' : ''}`}>Differential-mode conducted emission, estimated: {run.noise.margin >= 0 ? `${run.noise.margin.toFixed(1)} dB under` : `${(-run.noise.margin).toFixed(1)} dB over`} the Class B limit at {hertz(run.noise.marginAt)}, where it is nearest. The lines are the Class A and Class B quasi-peak limits; common-mode noise is not in it.</p>
          </>}
        </section>
      )}
    </div>
  );
}
