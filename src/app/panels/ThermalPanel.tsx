/**
 * Thermal Analysis (Tools › Thermal Analysis): the board's temperature with the heat settled.
 * The air (its temperature; still about a board lying flat or upright, or a coefficient for each
 * face), what each part dissipates and, to tell its junction, its junction-to-board resistance,
 * and optionally the copper's own heat from the supply set up in Power Analysis. Analyse gives
 * the hottest place, each heated part's board and junction temperatures, the warmest parts, and
 * what is over the limits; the board shows the layer in front coloured by temperature, the cursor
 * reading the place under it.
 */
import { signal } from '@preact/signals';
import { Icon } from '../icons';
import { SectionHead, Tool } from './kv';
import { active, docs, tick } from '../state';
import { PcbEditor, primKey } from '../../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../../editors/pcb/PcbLibEditor';
import type { PcbDocument } from '../../model/pcb';
import { RAMP_CSS } from '../../analysis/powerMap';
import { thermalIssues, thermalReport, type ThermalIssue } from '../../analysis/thermalMap';
import { shownBy } from '../analysisShow';
import type { WarmUp } from '../../analysis/thermal';
import { THERMAL_DETAIL, clearThermal, currentThermal, formThermal, readThermalForm, runThermal, runWarmUp, saveThermalForm, showThermal, span, thermalBusy, thermalRun, thermalScale, thermalShow, type ThermalForm } from '../thermalRun';

const forms = new Map<string, ThermalForm>(), changed = signal(0), find = signal('');

/** The board's components with their comments, in designator order (kept while the board is as it was). */
const listed = new WeakMap<object, { component: number; designator: string; comment: string }[]>();
function parts(doc: PcbDocument): { component: number; designator: string; comment: string }[] {
  let out = listed.get(doc.prims);
  if (!out) {
    const comment = new Map<number, string>();
    for (const p of doc.prims) if (p.kind === 'text' && p.isComment) comment.set(p.component, p.text);
    out = doc.components.map((c, i) => ({ component: i, designator: c.designator, comment: comment.get(i) ?? '' })).sort((a, b) => a.designator.localeCompare(b.designator, undefined, { numeric: true }));
    listed.set(doc.prims, out);
  }
  return out;
}

/** The hottest place (heavy line) and each heated part's board (light lines) against time. */
function WarmUpChart({ w, ambient }: { w: WarmUp; ambient: number }) {
  const W = 300, H = 110, L = 34, B = 16, T = 6, R = 6, end = w.times[w.times.length - 1]!, top = Math.max(...w.max, ambient + 0.1);
  const X = (t: number) => L + ((W - L - R) * t) / end, Y = (v: number) => T + (H - T - B) * (1 - (v - ambient) / (top - ambient));
  const line = (v: number[]) => v.map((y, k) => `${X(w.times[k]!).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');
  return (
    <figure class="th-warmup">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Warm-up: the hottest place from ${ambient} °C to ${top.toFixed(1)} °C over ${span(end)}`}>
        <path d={`M${L},${T} V${H - B} H${W - R}`} class="th-axis" />
        {w.parts.map((p) => <polyline key={p.component} points={line(p.t)} class="th-part" />)}
        <polyline points={line(w.max)} class="th-max" />
        <text x={L - 3} y={T + 8} text-anchor="end">{top.toFixed(0)}</text><text x={L - 3} y={H - B} text-anchor="end">{ambient.toFixed(0)}</text>
        <text x={L} y={H - 3}>0</text><text x={W - R} y={H - 3} text-anchor="end">{span(end)}</text>
      </svg>
      <figcaption class="small">The hottest place is half way in {span(w.half)} and nine tenths of the way in {span(w.most)}; the board as one lump has a time constant of {span(w.lump)}. The parts' own mass is not counted.</figcaption>
    </figure>
  );
}

export function ThermalPanel() {
  void tick.value; void changed.value; void thermalRun.value;
  const od = active.value, e = od?.editor;
  const kept = thermalRun.value;
  if (kept && !thermalBusy.value && !docs.value.some((d) => d.editor === kept.ed)) queueMicrotask(clearThermal);
  if (!od || !(e instanceof PcbEditor) || e instanceof PcbLibEditor) return <p class="panel-empty">Open a board to find its temperature.</p>;
  const doc = e.doc;
  let f = forms.get(od.id);
  if (!f) { f = readThermalForm(od.name); forms.set(od.id, f); }
  const set = (patch: Partial<ThermalForm>) => { const next = { ...f!, ...patch }; forms.set(od.id, next); saveThermalForm(od.name, next); changed.value++; };
  const setup = formThermal(doc, f), busy = thermalBusy.value;
  const run = currentThermal(e), stale = !run && thermalRun.value?.ed === e;
  const show = thermalShow.value, mine = shownBy.value?.ed === e && shownBy.value.by === 'thermal';
  const text = (k: 'ambient' | 'hTop' | 'hBottom' | 'board' | 'junction' | 'kIn' | 'kZ', label: string, unit: string, title: string, name = label) => (
    <label class="pw-field" title={title}>{label} <input aria-label={name} inputMode="decimal" value={f![k]} onChange={(ev) => set({ [k]: (ev.target as HTMLInputElement).value.trim() } as Partial<ThermalForm>)} /> {unit}</label>
  );
  // The parts: those given a dissipation first, then the rest, by what is typed in Find
  const q = find.value.trim().toLowerCase(), all = parts(doc);
  const match = all.filter((c) => !q || c.designator.toLowerCase().includes(q) || c.comment.toLowerCase().includes(q));
  const rows = [...match.filter((c) => f!.powers[c.designator]), ...match.filter((c) => !f!.powers[c.designator])], shownRows = rows.slice(0, 200);
  const total = all.reduce((s, c) => s + (parseFloat((f!.powers[c.designator] ?? '').replace(',', '.')) || 0), 0);
  const cell = (which: 'powers' | 'thetas', d: string, label: string) => (
    <input type="text" inputMode="decimal" aria-label={`${label} of ${d}`} placeholder={which === 'powers' ? '0' : ''} value={f![which][d] ?? ''}
      onChange={(ev) => { const v = (ev.target as HTMLInputElement).value.trim(), m = { ...f![which] }; if (v) m[d] = v; else delete m[d]; set({ [which]: m } as Partial<ThermalForm>); }} />
  );
  const goTo = (i: Pick<ThermalIssue, 'box' | 'layer' | 'prims'>) => {
    const keys = (i.prims ?? []).map((p) => doc.prims[p]).filter((p) => !!p).map((p) => primKey(p!));
    if (i.layer !== undefined && e.currentLayer !== i.layer) e.setCurrentLayer(i.layer);
    if (keys.length) e.select(keys);
    const box = i.box ?? (keys.length ? e.boundsOf(keys) : null);
    if (box) e.zoomToBox(box, 2_000_000);
  };
  const padsOf = (c: number) => { const o: number[] = []; doc.prims.forEach((p, i) => { if (p.kind === 'pad' && p.component === c) o.push(i); }); return o; };
  const issues = run ? thermalIssues(doc, run.result, run.limits, (l) => e.layerLabel(l)) : [];
  const report = () => {
    if (!run) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([thermalReport(doc, run.result, od.name, run.limits, (l) => e.layerLabel(l), run.warm)], { type: 'text/plain' }));
    a.download = `${od.name.replace(/\.[^.]+$/, '')}_ThermalAnalysis.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const setShow = (patch: Partial<typeof show>) => { thermalShow.value = { ...show, ...patch }; showThermal(); };
  const on = show.on && mine, scale = run ? thermalScale(run, show.scale) : [0, 0];
  const r = run?.result;
  return (
    <div class="panel-body powerpanel thermalpanel">
      <section aria-label="Air">
        <h4>Air</h4>
        {text('ambient', 'At', '°C', 'The temperature of the air about the board, and of the room it radiates to', 'Air temperature')}
        <label class="pw-field" title="How the faces lose their heat. Still air is worked out from how warm each face gets; moving air or an enclosure needs a coefficient from you">Air <select aria-label="Air" value={f.air} onChange={(ev) => set({ air: (ev.target as HTMLSelectElement).value as ThermalForm['air'] })}>
          <option value="flat">Still, the board lying flat</option><option value="upright">Still, the board upright</option><option value="given">Coefficients given</option>
        </select></label>
        {f.air === 'given' && <div class="pw-grid">
          {text('hTop', 'Top', 'W/m²·K', 'What the top face loses for each square metre and degree above the air, radiation included', 'Top coefficient')}
          {text('hBottom', 'Bottom', 'W/m²·K', 'What the bottom face loses for each square metre and degree above the air, radiation included', 'Bottom coefficient')}
        </div>}
      </section>
      <section aria-label="Heat" class="pw-loads">
        <h4>Heat</h4>
        <input class="th-find" type="search" aria-label="Find a part" placeholder="Find a part" value={find.value} onInput={(ev) => { find.value = (ev.target as HTMLInputElement).value; }} />
        <div class="pcbp-table" role="grid" aria-label="Parts" style={{ '--cols': '56px minmax(40px,1fr) 58px 58px' } as Record<string, string>}>
          <div class="pcbp-row head"><span>Part</span><span>Comment</span><span title="What the part dissipates">Power, W</span><span title="Junction to board, to tell the junction's temperature">θJB, K/W</span></div>
          <div class="pcbp-body">
            {!shownRows.length && <p class="panel-empty">{all.length ? 'No part by that name.' : 'The board has no components.'}</p>}
            {shownRows.map((c) => (
              <div key={c.component} role="row" class="pcbp-row">
                <span>{c.designator}</span><span title={c.comment}>{c.comment}</span>
                <span>{cell('powers', c.designator, 'Power')}</span><span>{cell('thetas', c.designator, 'Junction to board')}</span>
              </div>
            ))}
          </div>
        </div>
        <p class="muted small">{total > 0 ? `${total.toFixed(2)} W in all.` : 'Give what each part dissipates.'} A part's heat goes into the board at its pads.{rows.length > shownRows.length ? ` ${rows.length - shownRows.length} more: narrow them with Find.` : ''}</p>
        <label class="small" title="The supply set up in Power Analysis is worked with the board, turn about: its copper's loss heats the board, and the board's temperature raises the copper's resistance">
          <input type="checkbox" checked={f.copper} onChange={(ev) => set({ copper: (ev.target as HTMLInputElement).checked })} />The copper's own heat, from Power Analysis
        </label>
      </section>
      <section aria-label="Limits and board">
        <h4>Limits and board</h4>
        <div class="pw-grid">
          {text('board', 'Board up to', '°C', 'The hottest any place on the board may be', 'Board limit')}
          {text('junction', 'Junctions up to', '°C', 'The hottest a junction may be, for the parts given a junction-to-board resistance', 'Junction limit')}
          {text('kIn', 'Laminate along', 'W/m·K', 'The laminate\'s thermal conductivity along the board (FR-4: about 0.8)', 'Laminate conductivity along the board')}
          {text('kZ', 'through', 'W/m·K', 'The laminate\'s thermal conductivity through the board (FR-4: about 0.3)', 'Laminate conductivity through the board')}
          <label class="pw-field" title="How fine the grid over the board is">Detail <select aria-label="Detail" value={f.detail} onChange={(ev) => set({ detail: (ev.target as HTMLSelectElement).value as ThermalForm['detail'] })}>
            {(Object.keys(THERMAL_DETAIL) as ThermalForm['detail'][]).map((k) => <option key={k} value={k}>{THERMAL_DETAIL[k].label}</option>)}
          </select></label>
        </div>
      </section>
      <div class="pw-run">
        <button class="btn default" disabled={!!busy || typeof setup === 'string'} onClick={() => void runThermal(e, od.name, f!)}><Icon name="kpStart" />Analyse</button>
        <span class="muted small" role="status">{busy ?? (typeof setup === 'string' ? setup : stale ? 'The board has changed since the analysis: analyse again.' : '')}</span>
      </div>
      {run && r && (
        <section aria-label="Results" class="pw-results">
          <SectionHead title="Results">
            <Tool icon="anWarmUp" label="Warm-up" title="Warm-up: how the board warms from the air's temperature once the heat is switched on" disabled={!!busy} onClick={() => void runWarmUp()} />
            <Tool icon="anReport" label="Report..." title="Report: what was analysed and what was found, as a file" onClick={report} />
          </SectionHead>
          <p class="small">
            <button class="linklike th-hot" onClick={() => goTo({ layer: r.model.grid.layers[r.maxAt.layer], box: { minX: r.maxAt.at.x - 1_500_000, minY: r.maxAt.at.y - 1_500_000, maxX: r.maxAt.at.x + 1_500_000, maxY: r.maxAt.at.y + 1_500_000 } })}>Hottest place {r.max.toFixed(1)} °C</button> on {e.layerLabel(r.model.grid.layers[r.maxAt.layer]!)}, {(r.max - r.setup.ambient).toFixed(1)} above the air; the top face {r.top.mean.toFixed(1)} °C on average.
            {' '}{(r.power + r.copperPower).toFixed(2)} W in{r.copperPower > 0 ? ` (${(r.copperPower * 1000).toFixed(0)} mW of it the copper's)` : ''}: {r.top.loss.toFixed(2)} W leaves by the top at {r.top.h.toFixed(1)} W/m²·K, {r.bottom.loss.toFixed(2)} W by the bottom at {r.bottom.h.toFixed(1)}.
            {run.rail ? ` Worked with the supply ${run.turns} time${run.turns === 1 ? '' : 's'}.` : ''} <span class="muted">({(run.ms / 1000).toFixed(1)} s)</span>
          </p>
          {r.parts.length > 0 && <div class="pcbp-table" role="grid" aria-label="Heated parts" style={{ '--cols': '56px 1fr 1fr 1fr' } as Record<string, string>}>
            <div class="pcbp-row head"><span>Part</span><span>Power</span><span>Board</span><span>Junction</span></div>
            <div class="pcbp-body">
              {r.parts.map((p) => (
                <div key={p.component} role="row" class={`pcbp-row${p.junction !== undefined && p.junction > run.limits.junction ? ' pw-bad' : ''}`} onDblClick={() => goTo({ prims: padsOf(p.component) })}>
                  <span>{p.designator}</span><span>{p.power} W</span><span>{p.board.toFixed(1)} °C</span><span>{p.junction !== undefined ? `${p.junction.toFixed(1)} °C` : ''}</span>
                </div>
              ))}
            </div>
          </div>}
          <p class="small th-warm">The warmest parts: {r.components.slice(0, 8).map((c, k) => <span key={c.component}>{k ? ', ' : ''}<button class="linklike" onClick={() => goTo({ prims: padsOf(c.component) })}>{c.designator}</button> {c.t.toFixed(1)} °C</span>)}.</p>
          {issues.length ? (
            <ul class="pw-issues" aria-label="Out of limits">
              {issues.map((i, k) => <li key={k}><button class="linklike" onClick={() => goTo(i)}>{i.message}</button></li>)}
            </ul>
          ) : <p class="small pw-ok">Nothing out of limits.</p>}
          <div class="pw-show" role="group" aria-label="On the board">
            <span class="small">On the board</span>
            <select aria-label="On the board" value={on ? 'on' : 'off'} onChange={(ev) => setShow({ on: (ev.target as HTMLSelectElement).value === 'on' })}>
              <option value="on">Temperature</option><option value="off">Nothing</option>
            </select>
            <select aria-label="Colours" value={show.scale} disabled={!on} onChange={(ev) => setShow({ scale: (ev.target as HTMLSelectElement).value as 'own' | 'limits' })}>
              <option value="own">Over its own range</option><option value="limits">Up to the limit</option>
            </select>
          </div>
          {on && (
            <div class="pw-key" aria-label="Colour key">
              <span>{scale[0]!.toFixed(0)} °C</span><span class="pw-ramp" style={{ background: RAMP_CSS }} /><span>{scale[1]!.toFixed(1)} °C</span>
            </div>
          )}
          {on && <p class="muted small">{doc.board.copperStack.includes(e.currentLayer) ? `${e.layerLabel(e.currentLayer)}: change the layer to see another. The cursor reads the place under it.` : 'Bring a copper layer to the front to see its temperature.'}</p>}
          {run.warm && <WarmUpChart w={run.warm} ambient={r.setup.ambient} />}
        </section>
      )}
    </div>
  );
}
