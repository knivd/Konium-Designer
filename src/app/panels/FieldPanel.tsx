/**
 * Field Solver (Tools › Field Solver): the impedance of a track from its cross-section, solved
 * rather than fitted. The arrangement (a microstrip, a track embedded in the dielectric, a
 * stripline; alone or as a pair; with grounds beside it or not), its dimensions (typed, or taken
 * from a layer of the board's stack and the selected track), and the answers: impedance,
 * effective dielectric constant, delay, capacitance and inductance, and for a pair its odd, even,
 * differential and common impedances. The cross-section is drawn with the potential about the
 * track. Find the width works back from an impedance.
 */
import { signal } from '@preact/signals';
import { Icon } from '../icons';
import { active, tick } from '../state';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../../editors/pcb/PcbLibEditor';
import { isSignal } from '../../model/layers';
import { METRE } from '../../analysis/copperNet';
import { ramp } from '../../analysis/powerMap';
import { fieldBusy, fieldRun, findWidth, formLine, lineFromStack, readLineForm, runField, saveLineForm, shown, type FieldRun, type LineForm } from '../fieldRun';

const form = signal<LineForm | null>(null);

/** The cross-section about the track, the potential in colour, the copper and the dielectrics' edges over it. */
function draw(canvas: HTMLCanvasElement | null, run: FieldRun): void {
  if (!canvas) return;
  const { xs, ys, v, role } = run.picture, s = run.setup, nx = xs.length, ny = ys.length;
  const span = (s.pair !== undefined ? 2 * s.width + s.pair : s.width) + 2 * (s.coplanar ?? 0), top = s.kind === 'stripline' ? s.h1 + s.h2! : s.h1 + Math.max(s.kind === 'embedded' ? s.h2! : 0, s.thickness) + 1.5 * s.h1;
  const half = span / 2 + 2.5 * Math.max(s.h1, s.width / 2), W = canvas.width, H = canvas.height, k = Math.min(W / (2 * half), H / top);
  const X = (x: number) => W / 2 + x * k, Y = (y: number) => H - y * k;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);
  for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    if (xs[i + 1]! < -half || xs[i]! > half || ys[j]! > top) continue;
    const a = j * nx + i, p = (v[a]! + v[a + 1]! + v[a + nx]! + v[a + nx + 1]!) / 4, c = ramp(p);
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.fillRect(X(xs[i]!), Y(ys[j + 1]!), Math.ceil((xs[i + 1]! - xs[i]!) * k) + 1, Math.ceil((ys[j + 1]! - ys[j]!) * k) + 1);
  }
  // The copper
  ctx.fillStyle = '#26262b';
  for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    const a = j * nx + i;
    if (role[a] && role[a + 1] && role[a + nx] && role[a + nx + 1] && role[a] === role[a + nx + 1]) ctx.fillRect(X(xs[i]!), Y(ys[j + 1]!), Math.ceil((xs[i + 1]! - xs[i]!) * k) + 1, Math.ceil((ys[j + 1]! - ys[j]!) * k) + 1);
  }
  ctx.fillRect(0, H - 3, W, 3);
  if (s.kind === 'stripline') ctx.fillRect(0, Y(top), W, 3);
  // Where the dielectric ends
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
  for (const y of [s.h1, ...(s.kind === 'embedded' ? [s.h1 + s.h2!] : [])]) { ctx.beginPath(); ctx.moveTo(0, Y(y)); ctx.lineTo(W, Y(y)); ctx.stroke(); }
  ctx.setLineDash([]);
}

export function FieldPanel() {
  void tick.value; void fieldRun.value;
  if (!form.value) form.value = readLineForm();
  const f = form.value, od = active.value, e = od?.editor instanceof PcbEditor && !(od.editor instanceof PcbLibEditor) ? od.editor : null;
  const set = (patch: Partial<LineForm>) => { const next = { ...form.value!, ...patch }; form.value = next; saveLineForm(next); };
  const setup = formLine(f), busy = fieldBusy.value, run = fieldRun.value, r = run?.result;
  type K = 'width' | 'gap' | 'side' | 'thickness' | 'h1' | 'er1' | 'above' | 'er2' | 'maskT' | 'maskEr' | 'etch' | 'target';
  const text = (k: K, label: string, unit: string, title: string, name = label) => (
    <label class="pw-field" title={title}>{label} <input aria-label={name} inputMode="decimal" value={f[k]} onChange={(ev) => set({ [k]: (ev.target as HTMLInputElement).value.trim() } as Partial<LineForm>)} /> {unit}</label>
  );
  const u = f.unit;
  // From the board: a signal layer's stack, and the selected track's width
  const layers = e ? e.doc.board.copperStack.filter(isSignal) : [];
  const take = (layer: number) => { if (!e) return; const got = lineFromStack(e.doc, layer as never, u); if (got) set(got); };
  const selected = e ? [...e.selection].map((k) => e.primByKey(k)).find((p) => p?.kind === 'track' || p?.kind === 'arc') : undefined;
  const changeUnit = (to: LineForm['unit']) => {
    if (to === u) return;
    const k = to === 'mil' ? 1 / 0.0254 : 0.0254, conv = (s: string) => { const v = parseFloat(s.replace(',', '.')); return Number.isFinite(v) ? String(Number((v * k).toPrecision(4))) : s; };
    set({ unit: to, width: conv(f.width), gap: conv(f.gap), side: conv(f.side), thickness: conv(f.thickness), h1: conv(f.h1), above: conv(f.above), maskT: conv(f.maskT), etch: conv(f.etch) });
  };
  const z = (v: number) => `${v.toFixed(v >= 100 ? 1 : 2)} Ω`;
  return (
    <div class="panel-body powerpanel fieldpanel">
      <section aria-label="Arrangement">
        <h4>Arrangement</h4>
        <label class="pw-field">Track <select aria-label="Arrangement" value={f.kind} onChange={(ev) => set({ kind: (ev.target as HTMLSelectElement).value as LineForm['kind'] })}>
          <option value="microstrip">On the surface (microstrip)</option><option value="embedded">Under a layer of dielectric (embedded)</option><option value="stripline">Between two planes (stripline)</option>
        </select></label>
        <label class="small"><input type="checkbox" checked={f.pair} onChange={(ev) => set({ pair: (ev.target as HTMLInputElement).checked })} />A pair, side by side</label>
        <label class="small"><input type="checkbox" checked={f.coplanar} onChange={(ev) => set({ coplanar: (ev.target as HTMLInputElement).checked })} />Grounds beside it on its layer</label>
        {e && <label class="pw-field" title="The copper's thickness and the dielectrics about a signal layer, as the Layer Stack Manager has them">From the board <select aria-label="From the board" value="" onChange={(ev) => { const v = (ev.target as HTMLSelectElement).value; if (v) take(Number(v)); (ev.target as HTMLSelectElement).value = ''; }}>
          <option value="">(take a layer's stack)</option>{layers.map((l) => <option key={l} value={l}>{e.layerLabel(l)}</option>)}
        </select></label>}
        {e && selected && 'width' in selected && <button class="btn" onClick={() => { set({ width: shown(selected.width * METRE, u) }); take(selected.layer); }}>Take the selected track's width and layer</button>}
      </section>
      <section aria-label="Dimensions">
        <h4>Dimensions</h4>
        <label class="pw-field">Lengths in <select aria-label="Lengths in" value={u} onChange={(ev) => changeUnit((ev.target as HTMLSelectElement).value as LineForm['unit'])}><option value="mm">mm</option><option value="mil">mil</option></select></label>
        <div class="pw-grid">
          {text('width', 'Width', u, 'The track\'s width at its foot')}
          {f.pair && text('gap', 'Gap', u, 'Between the two tracks of the pair, edge to edge')}
          {f.coplanar && text('side', 'To grounds', u, 'From the track to the ground copper beside it, edge to edge', 'Gap to grounds')}
          {text('thickness', 'Copper', u, 'The copper\'s thickness, plating included', 'Copper thickness')}
          {text('etch', 'Top narrower', u, 'Etching undercuts the copper: how much narrower the track\'s top is than its foot', 'Etch')}
          {text('h1', 'Height', u, 'The dielectric under the track, down to the plane', 'Height under')}
          {text('er1', 'its constant', '', 'The dielectric constant of what is under the track', 'Constant under')}
          {f.kind !== 'microstrip' && text('above', f.kind === 'stripline' ? 'To the plane above' : 'Cover', u, f.kind === 'stripline' ? 'The dielectric over the track\'s top, up to the upper plane' : 'The dielectric over the track\'s top; air above it', 'Height over')}
          {f.kind !== 'microstrip' && text('er2', 'its constant', '', 'The dielectric constant of what is over the track', 'Constant over')}
        </div>
        {f.kind === 'microstrip' && <label class="small"><input type="checkbox" checked={f.mask} onChange={(ev) => set({ mask: (ev.target as HTMLInputElement).checked })} />Solder mask over it</label>}
        {f.kind === 'microstrip' && f.mask && <div class="pw-grid">{text('maskT', 'Mask', u, 'The solder mask\'s thickness', 'Mask thickness')}{text('maskEr', 'its constant', '', 'The solder mask\'s dielectric constant', 'Mask constant')}</div>}
        <label class="pw-field">Detail <select aria-label="Detail" value={f.detail} onChange={(ev) => set({ detail: (ev.target as HTMLSelectElement).value as LineForm['detail'] })}><option value="normal">Normal</option><option value="fine">Fine</option></select></label>
      </section>
      <div class="pw-run">
        <button class="btn default" disabled={!!busy || typeof setup === 'string'} onClick={() => void runField(f)}><Icon name="kpStart" />Solve</button>
        <span class="muted small" role="status">{busy ?? (typeof setup === 'string' ? setup : '')}</span>
      </div>
      <div class="pw-run">
        {text('target', f.pair ? 'Differential' : 'Impedance', 'Ω', 'The impedance wanted (a pair\'s differential impedance)', 'Impedance wanted')}
        <button class="btn" disabled={!!busy || typeof setup === 'string'} onClick={() => void findWidth(f).then((w) => { if (w) { set({ width: w }); void runField({ ...form.value!, width: w }); } })}>Find the width</button>
      </div>
      {run && r && (
        <section aria-label="Results" class="pw-results">
          <h4>Results</h4>
          <canvas class="field-picture" width={600} height={260} role="img" aria-label="The cross-section about the track, coloured by the potential: red at the track, blue at the planes" ref={(c) => draw(c, run)} />
          <dl class="field-figures">
            {r.pair ? <>
              <dt>Differential</dt><dd>{z(r.pair.differential)}</dd><dt>Odd mode</dt><dd>{z(r.pair.odd)}</dd><dt>Even mode</dt><dd>{z(r.pair.even)}</dd><dt>Common</dt><dd>{z(r.pair.common)}</dd>
              <dt>Coupling</dt><dd>{(r.pair.coupling * 100).toFixed(1)} %</dd><dt>One track, the other grounded</dt><dd>{z(r.z0)}</dd>
            </> : <><dt>Impedance</dt><dd>{z(r.z0)}</dd></>}
            <dt>Effective constant</dt><dd>{(r.pair ? r.pair.effOdd : r.eff).toFixed(3)}{r.pair ? ` odd, ${r.pair.effEven.toFixed(3)} even` : ''}</dd>
            <dt>Delay</dt><dd>{((r.pair ? Math.sqrt(r.pair.effOdd) / 299_792_458 : r.delay) * 1e9).toFixed(3)} ps/mm{r.pair ? ' (odd)' : ''}, {((r.pair ? Math.sqrt(r.pair.effOdd) / 299_792_458 : r.delay) * 1e12 * 0.0254).toFixed(1)} ps/in</dd>
            <dt>Capacitance</dt><dd>{(r.c * 1e10).toFixed(3)} pF/cm</dd><dt>Inductance</dt><dd>{(r.l * 1e7).toFixed(3)} nH/cm</dd>
          </dl>
          <p class="muted small">{r.nodes.toLocaleString('en')} points on the finer of two grids, {(run.ms / 1000).toFixed(1)} s. Lossless figures, at the dielectric constants given.</p>
        </section>
      )}
    </div>
  );
}
