/**
 * EMC Check (Tools › EMC Check): the board's layout looked over for the places where a signal's
 * return current has no easy way back. The nets to check and the highest frequency of concern,
 * the rules with their figures, Check, and what was found, rule by rule: a click goes to the
 * place with its objects selected.
 */
import { signal } from '@preact/signals';
import { Icon } from '../icons';
import { SectionHead, Tool } from './kv';
import { active, docs, tick } from '../state';
import { PcbEditor, primKey } from '../../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../../editors/pcb/PcbLibEditor';
import { UNITS_PER_MM } from '../../core/units';
import { EMC_KINDS, emcReport, type EmcFinding } from '../../analysis/emc';
import { currentEmc, emcBusy, emcRun, readEmcForm, runEmc, saveEmcForm, type EmcForm } from '../emcRun';

const forms = new Map<string, EmcForm>(), changed = signal(0);

export function EmcPanel() {
  void tick.value; void changed.value; void emcRun.value;
  const od = active.value, e = od?.editor;
  const kept = emcRun.value;
  if (kept && !emcBusy.value && !docs.value.some((d) => d.editor === kept.ed)) queueMicrotask(() => { if (emcRun.value === kept) emcRun.value = null; });
  if (!od || !(e instanceof PcbEditor) || e instanceof PcbLibEditor) return <p class="panel-empty">Open a board to check its layout.</p>;
  const doc = e.doc;
  let f = forms.get(od.id);
  if (!f) { f = readEmcForm(od.name); forms.set(od.id, f); }
  const set = (patch: Partial<EmcForm>) => { const next = { ...f!, ...patch }; forms.set(od.id, next); saveEmcForm(od.name, next); changed.value++; };
  const busy = emcBusy.value, run = currentEmc(e), stale = !run && emcRun.value?.ed === e;
  type TextKey = 'minGap' | 'edgeFactor' | 'minEdgeRun' | 'returnVia' | 'capDistance' | 'decouplingDistance' | 'frequency';
  const box = (k: TextKey, name: string, on = true) => <input aria-label={name} inputMode="decimal" disabled={!on} value={f![k]} onChange={(ev) => set({ [k]: (ev.target as HTMLInputElement).value.trim() } as Partial<EmcForm>)} />;
  const tick_ = (k: 'gaps' | 'edge' | 'layerChange' | 'decoupling' | 'stitching', name: string) => <input type="checkbox" aria-label={name} checked={f![k]} onChange={(ev) => set({ [k]: (ev.target as HTMLInputElement).checked } as Partial<EmcForm>)} />;
  /** A rule's row: its tick, what it looks for, its figure and the figure's unit, each in a column. */
  const rule = (tick: preact.JSX.Element | null, name: string, title: string, figure?: preact.JSX.Element, unit = '') => (
    figure
      ? <label class="emc-rule" title={title}>{tick ?? <span />}<span>{name}</span>{figure}<span>{unit}</span></label>
      : <label class="emc-rule wide" title={title}>{tick ?? <span />}<span>{name}</span></label>
  );
  const goTo = (i: EmcFinding) => {
    const keys = (i.prims ?? []).map((p) => doc.prims[p]).filter((p) => !!p).map((p) => primKey(p!));
    if (i.layer !== undefined && e.currentLayer !== i.layer) e.setCurrentLayer(i.layer);
    e.select(keys);
    const b = i.box ?? (keys.length ? e.boundsOf(keys) : null);
    if (b) e.zoomToBox(b, 2_000_000);
  };
  const report = () => {
    if (!run) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([emcReport(run.result, run.setup, od.name)], { type: 'text/plain' }));
    a.download = `${od.name.replace(/\.[^.]+$/, '')}_EMCCheck.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const r = run?.result;
  return (
    <div class="panel-body powerpanel emcpanel">
      <section aria-label="What to check">
        <h4>What to check</h4>
        <label class="pw-field" title="Names separated by commas, * for any run of characters (CLK*, USB_D?). Empty: every net that is neither a supply nor a ground">Nets <input class="emc-nets" aria-label="Nets" placeholder="Every signal net" value={f.nets} onChange={(ev) => set({ nets: (ev.target as HTMLInputElement).value.trim() })} /></label>
        <label class="pw-field" title="The highest frequency that matters on the board: a clock's harmonics count, not only its rate. Ground copper is wanted within a twentieth of its wavelength of a via">Up to {box('frequency', 'Frequency')} MHz</label>
      </section>
      <section aria-label="Rules" class="emc-rules">
        <h4>Rules</h4>
        {rule(tick_('gaps', 'Tracks over gaps'), 'Tracks over gaps of at least', 'A track over a slot, a split or the open edge of the copper on the layer next to it. A gap counts by its length, however narrow', box('minGap', 'Gap length', f.gaps), 'mm')}
        {rule(tick_('edge', 'Tracks along an edge'), 'Along an edge, within', 'A track running along the edge of the copper under it, nearer than so many times its height above that copper', box('edgeFactor', 'Edge distance in heights', f.edge), 'heights')}
        {rule(null, 'for at least', 'How far the track must run that near the edge to be listed', box('minEdgeRun', 'Edge run', f.edge), 'mm')}
        {rule(tick_('layerChange', 'Layer changes'), 'Layer changes: a via within', 'A via that takes a signal between layers whose reference copper differs: the same net on two layers wants a via of that net close by', box('returnVia', 'Return via distance', f.layerChange), 'mm')}
        {rule(null, 'or a capacitor within', 'Where the two layers\' reference copper is of two nets, a capacitor between them is wanted close by', box('capDistance', 'Capacitor distance', f.layerChange), 'mm')}
        {rule(tick_('decoupling', 'Decoupling'), 'Decoupling: capacitor within', 'Each supply pin of an IC (a part named U or IC with four pads or more) wants a capacitor to ground on its net within this of the pin', box('decouplingDistance', 'Decoupling distance', f.decoupling), 'mm')}
        {rule(tick_('stitching', 'Ground stitching'), 'Ground copper within reach of a via', 'Ground copper on a signal layer, where the ground has copper on another layer too, wants a via within a twentieth of a wavelength at the frequency above')}
      </section>
      <div class="pw-run">
        <button class="btn default" disabled={!!busy} onClick={() => void runEmc(e, f!)}><Icon name="kpStart" />Check</button>
        <span class="muted small" role="status">{busy ?? (stale ? 'The board has changed since the check: check again.' : '')}</span>
      </div>
      {run && r && (
        <section aria-label="Results" class="pw-results">
          <SectionHead title="Results"><Tool icon="anReport" label="Report..." title="Report: what was analysed and what was found, as a file" onClick={report} /></SectionHead>
          <p class="small">{r.findings.length ? `${r.findings.length} to look at.` : <span class="pw-ok">Nothing found.</span>} Looked at {r.tracks} track{r.tracks === 1 ? '' : 's'} of {r.nets} net{r.nets === 1 ? '' : 's'}, {r.vias} of their vias and {r.ics} IC{r.ics === 1 ? '' : 's'}; a twentieth of a wavelength in the board is {(r.lambda20 / UNITS_PER_MM).toFixed(1)} mm. <span class="muted">({(run.ms / 1000).toFixed(1)} s)</span></p>
          {EMC_KINDS.map((k) => {
            const list = r.findings.filter((x) => x.kind === k.kind);
            return list.length ? (
              <details key={k.kind} open class="emc-kind">
                <summary>{k.title} ({list.length})</summary>
                <ul class="pw-issues" aria-label={k.title}>
                  {list.map((i, n) => <li key={n}><button class="linklike" onClick={() => goTo(i)}>{i.message}</button></li>)}
                </ul>
              </details>
            ) : null;
          })}
        </section>
      )}
    </div>
  );
}
