/**
 * Power Analysis (Tools › Power Analysis): a supply net at DC. The net, the net its current
 * returns on, the component that feeds it and at what voltage, and what each of the other
 * components on it draws; Analyse works out the voltage each load is left with, the current in
 * every piece of the net's copper and in every via, and sets them against the limits. The board
 * shows the copper coloured by voltage drop or by current density (the layer in front; the
 * cursor reads the place under it), the panel the loads and what is out of limits: a click goes
 * there.
 */
import { signal } from '@preact/signals';
import { Icon } from '../icons';
import { SectionHead, Tool } from './kv';
import { active, docs, tick } from '../state';
import { PcbEditor, primKey } from '../../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../../editors/pcb/PcbLibEditor';
import { isSignal } from '../../model/layers';
import { componentsOn, groundName, railNets, railReport, type RailIssue } from '../../analysis/rail';
import { RAMP_CSS, type MapKind } from '../../analysis/powerMap';
import { shownBy } from '../analysisShow';
import { DETAIL, clearPower, currentRun, formRail, powerBusy, powerRun, powerShow, readForm, runPower, saveForm, scaleMax, showOnBoard, type PowerForm } from '../powerRun';

const forms = new Map<string, PowerForm>(), changed = signal(0);

const amps = (a: number) => (a >= 1 ? `${a.toFixed(2)} A` : `${(a * 1000).toFixed(0)} mA`);

export function PowerPanel() {
  void tick.value; void changed.value; void powerRun.value;
  const od = active.value, e = od?.editor;
  // An analysis of a board since closed is let go (its copper's network is large)
  const kept = powerRun.value;
  if (kept && !powerBusy.value && !docs.value.some((d) => d.editor === kept.ed)) queueMicrotask(clearPower);
  if (!od || !(e instanceof PcbEditor) || e instanceof PcbLibEditor) return <p class="panel-empty">Open a board to analyse its supplies.</p>;
  const doc = e.doc;
  let f = forms.get(od.id);
  if (!f) { f = readForm(doc, od.name); forms.set(od.id, f); }
  const set = (patch: Partial<PowerForm>) => { const next = { ...f!, ...patch }; forms.set(od.id, next); saveForm(od.name, next); changed.value++; };
  const nets = railNets(doc), supply = doc.nets.findIndex((n) => n.name === f!.supply);
  const comps = supply >= 0 ? componentsOn(doc, supply) : [];
  const loads = comps.filter((c) => c.designator !== f!.source);
  const total = loads.reduce((s, c) => s + (parseFloat((f!.loads[c.designator] ?? '').replace(',', '.')) || 0), 0);
  const rail = formRail(doc, f), busy = powerBusy.value;
  const run = currentRun(e), stale = !run && powerRun.value?.ed === e;
  const show = powerShow.value;
  const text = (k: keyof PowerForm, label: string, unit: string, title: string, name = label) => (
    <label class="pw-field" title={title}>{label} <input aria-label={name} inputMode="decimal" value={f![k] as string} onChange={(ev) => set({ [k]: (ev.target as HTMLInputElement).value.trim() } as Partial<PowerForm>)} /> {unit}</label>
  );
  const goTo = (i: RailIssue) => {
    const keys = (i.prims ?? []).map((p) => doc.prims[p]).filter((p) => !!p).map((p) => primKey(p!));
    if (i.layer !== undefined && e.currentLayer !== i.layer) e.setCurrentLayer(i.layer);
    if (keys.length) e.select(keys);
    const box = i.box ?? (keys.length ? e.boundsOf(keys) : null);
    if (box) e.zoomToBox(box, 2_000_000);
  };
  const report = () => {
    if (!run) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([railReport(doc, run.result, od.name)], { type: 'text/plain' }));
    a.download = `${od.name.replace(/\.[^.]+$/, '')}_PowerAnalysis.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const setShow = (patch: Partial<typeof show>) => { powerShow.value = { ...show, ...patch }; showOnBoard(); };
  // (another analysis's picture may be on the board in place of this one's)
  const mine = shownBy.value?.ed === e && shownBy.value.by === 'power';
  const kind: MapKind | null = show.kind === 'off' || !mine ? null : show.kind;
  const max = run && kind ? scaleMax(run.result, kind, show.scale) : 0;
  const onLayer = isSignal(e.currentLayer) || doc.board.copperStack.includes(e.currentLayer);
  return (
    <div class="panel-body powerpanel">
      <section aria-label="Supply">
        <h4>Supply</h4>
        <label class="pw-field">Net <select aria-label="Supply net" value={f.supply} onChange={(ev) => set({ supply: (ev.target as HTMLSelectElement).value, source: '' })}>
          <option value="">(pick a net)</option>
          {nets.map((n) => <option key={n.net} value={n.name}>{n.name} ({n.components})</option>)}
        </select></label>
        <label class="pw-field" title="The net the loads' currents come back to the source on: its rise is taken from each load's voltage">Return <select aria-label="Return net" value={f.ret} onChange={(ev) => set({ ret: (ev.target as HTMLSelectElement).value })}>
          <option value="">(none)</option>
          {nets.filter((n) => n.name !== f!.supply).sort((a, b) => Number(groundName(b.name)) - Number(groundName(a.name))).map((n) => <option key={n.net} value={n.name}>{n.name} ({n.components})</option>)}
        </select></label>
        <label class="pw-field" title="The component whose pads on the net are held at the voltage: a regulator, a connector">Fed by <select aria-label="Source" value={f.source} onChange={(ev) => set({ source: (ev.target as HTMLSelectElement).value })}>
          <option value="">(pick a component)</option>
          {comps.map((c) => <option key={c.component} value={c.designator}>{c.designator}{c.comment ? ` ${c.comment}` : ''}</option>)}
        </select></label>
        {text('voltage', 'at', 'V', 'The voltage at the source\'s pads', 'Voltage')}
      </section>
      <section aria-label="Loads" class="pw-loads">
        <h4>Loads</h4>
        <div class="pcbp-table" role="grid" aria-label="Loads" style={{ '--cols': '56px minmax(40px,1fr) 44px 64px' } as Record<string, string>}>
          <div class="pcbp-row head"><span>Load</span><span>Comment</span><span>Pins</span><span>Current, A</span></div>
          <div class="pcbp-body">
            {!loads.length && <p class="panel-empty">{supply < 0 ? 'Pick the supply net.' : 'No other component is on the net.'}</p>}
            {loads.map((c) => (
              <div key={c.component} role="row" class="pcbp-row">
                <span>{c.designator}</span><span title={c.comment}>{c.comment}</span><span title={c.pins.join(', ')}>{c.pins.length}</span>
                <span><input type="text" inputMode="decimal" aria-label={`Current of ${c.designator}`} placeholder="0" value={f!.loads[c.designator] ?? ''}
                  onChange={(ev) => { const v = (ev.target as HTMLInputElement).value.trim(), l = { ...f!.loads }; if (v) l[c.designator] = v; else delete l[c.designator]; set({ loads: l }); }} /></span>
              </div>
            ))}
          </div>
        </div>
        <p class="muted small">{total > 0 ? `${amps(total)} in all.` : 'Give what each load draws; a load left empty draws nothing.'} A load's current is shared equally among its pads on the net.</p>
      </section>
      <section aria-label="Limits and copper">
        <h4>Limits and copper</h4>
        <div class="pw-grid">
          {text('drop', 'Drop', '%', 'The most a load may lose, as a percentage of the source\'s voltage')}
          {text('rise', 'Rise', '°C', 'The temperature rise allowed in tracks and vias: what current that is for each cross-section is IPC-2221\'s')}
          {text('density', 'Areas', 'A/mm²', 'The most a copper area may carry for its cross-section: your own limit, there is no standard figure')}
          {text('temperature', 'Copper at', '°C', 'The copper\'s temperature: its resistance rises 0.39 % a degree')}
          {text('plating', 'Plating', 'µm', 'The copper plated on the walls of vias and holes')}
          <label class="pw-field" title="How fine the grid laid over the copper areas is: finer is slower and tells narrow necks better">Detail <select aria-label="Detail" value={f.detail} onChange={(ev) => set({ detail: (ev.target as HTMLSelectElement).value as PowerForm['detail'] })}>
            {(Object.keys(DETAIL) as PowerForm['detail'][]).map((k) => <option key={k} value={k}>{DETAIL[k].label}</option>)}
          </select></label>
        </div>
      </section>
      <div class="pw-run">
        <button class="btn default" disabled={!!busy || typeof rail === 'string'} onClick={() => { if (typeof rail !== 'string') void runPower(e, rail); }}><Icon name="kpStart" />Analyse</button>
        <span class="muted small" role="status">{busy ?? (typeof rail === 'string' ? rail : stale ? 'The board has changed since the analysis: analyse again.' : '')}</span>
      </div>
      {run && (
        <section aria-label="Results" class="pw-results">
          <SectionHead title="Results"><Tool icon="anReport" label="Report..." title="Report: what was analysed and what was found, as a file" onClick={report} /></SectionHead>
          <p class="small">{amps(run.result.current)} from {doc.components[run.result.rail.source]?.designator}, {(run.result.loss * 1000).toFixed(1)} mW lost in the copper, worst drop {(run.result.worstDrop * 1000).toFixed(1)} mV. <span class="muted">({(run.ms / 1000).toFixed(1)} s)</span></p>
          <div class="pcbp-table" role="grid" aria-label="Load voltages" style={{ '--cols': '56px 1fr 1fr 48px' } as Record<string, string>}>
            <div class="pcbp-row head"><span>Load</span><span>Voltage</span><span>Drop</span><span>%</span></div>
            <div class="pcbp-body">
              {run.result.rows.map((r) => (
                <div key={r.component} role="row" class={`pcbp-row${r.state === 'ok' ? '' : ' pw-bad'}`} onDblClick={() => goTo({ kind: 'drop', message: '', prims: doc.prims.map((p, i) => (p.kind === 'pad' && p.component === r.component && (p.net === run.result.rail.supply || p.net === run.result.rail.ret) ? i : -1)).filter((i) => i >= 0) })}>
                  <span>{r.designator}</span>
                  {r.state === 'open' ? <span class="pw-open" style={{ gridColumn: 'span 3' }}>Not joined on the {r.open === 'both' ? 'supply or the return' : r.open}</span>
                    : <><span>{r.voltage.toFixed(4)} V</span><span>{(r.drop * 1000).toFixed(1)} mV</span><span>{r.percent.toFixed(1)}</span></>}
                </div>
              ))}
            </div>
          </div>
          {run.result.issues.length ? (
            <ul class="pw-issues" aria-label="Out of limits">
              {run.result.issues.map((i, k) => <li key={k}><button class="linklike" onClick={() => goTo(i)}>{i.message}</button></li>)}
            </ul>
          ) : <p class="small pw-ok">Nothing out of limits.</p>}
          <div class="pw-show" role="group" aria-label="On the board">
            <span class="small">On the board</span>
            <select aria-label="On the board" value={kind ?? 'off'} onChange={(ev) => setShow({ kind: (ev.target as HTMLSelectElement).value as MapKind | 'off' })}>
              <option value="drop">Voltage drop</option><option value="density">Current density</option><option value="off">Nothing</option>
            </select>
            <select aria-label="Colours" value={show.scale} disabled={!kind} onChange={(ev) => setShow({ scale: (ev.target as HTMLSelectElement).value as 'own' | 'limits' })}>
              <option value="own">Over its own range</option><option value="limits">Up to the limits</option>
            </select>
          </div>
          {kind && (
            <div class="pw-key" aria-label="Colour key">
              <span>0</span><span class="pw-ramp" style={{ background: RAMP_CSS }} /><span>{kind === 'drop' ? `${(max * 1000).toFixed(max < 0.01 ? 2 : 1)} mV` : `${(max / 1e6).toFixed(0)} A/mm²`}</span>
            </div>
          )}
          {kind && <p class="muted small">{onLayer ? `${e.layerLabel(e.currentLayer)}: change the layer to see another. The cursor reads the copper under it.` : 'Bring a copper layer to the front to see its copper.'}</p>}
        </section>
      )}
    </div>
  );
}
