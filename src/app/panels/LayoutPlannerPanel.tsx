import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { Icon } from '../icons';
import { AiOff, EmptyState } from './kv';
import { active, activeId, activeScope, docs, notify, prefsPage, showPrefs, tick } from '../state';
import { commands } from '../../core/commands';
import { settings } from '../../core/settings';
import { activeProject, compileOptions, projectSheets, whenMounted } from '../project';
import { compileProject } from '../../model/compile';
import { LAYOUT, type LayoutPlan } from '../../ai/jobs';
import { designDigest, type DesignDigest } from '../../ai/advise';
import { layoutBrief } from '../../ai/layoutBrief';
import { TEXT_BUDGET } from '../../ai/datasheet';
import { shownId } from '../../ai/models';
import { AiError, NOT_YET, allowanceNote, destination, estimateCost, estimateTokens, listModels, modelFor, money, runJob, serviceConfig, serviceRuns, type ModelInfo, type ServiceConfig, type Usage } from '../../ai/client';
import type { PcbDocument } from '../../model/pcb';
import { connectionLength, planOnBoard, planRooms, planText, resultText, toUnits, type PlanOnBoard, type PlanScope } from '../../model/layoutPlan';
import { placeByPlan } from '../../model/planPlace';
import { moveComponentsEach } from '../../model/pcbEdit';
import type { RouteJob } from '../../model/autoroute';
import { PcbEditor } from '../../editors/pcb/PcbEditor';

/**
 * Layout Planner (Tools › Layout Planner, 26.191): where the board's parts go, planned by the
 * model chosen before any is placed. The model is sent the board as text (its outline, each part
 * with its size, each net with its pins, with what the project's schematic says of them) and what
 * the designer writes, and answers with a plan: the groups of parts that belong together and where
 * each group's middle goes, the parts at the board's edges, what must be close to which pin, what
 * must be kept apart or clear, each with its reason. The plan is shown here and as zones over the
 * board; Make Rooms turns the zones into rooms with their component classes (a room moved or
 * reshaped is then its group's zone). Place by the Plan carries the plan out (model/planPlace):
 * every part to its exact place, in one undo step, and each thing the plan asked is marked as met
 * or not as the board stands. Plan Again sends the plan back with what the placer made of it and
 * what the designer wants changed. A board's plan stays while the panel is closed.
 */

export interface LayoutKept {
  plan: LayoutPlan; scope: PlanScope; brief: string; model: string; usage: Usage; ms: number;
  /** The zones drawn over the board. */
  show: boolean;
  /** How many rounds made it (1: the first plan). */
  round: number;
  /** The round whose zones were made rooms (those rooms, moved or reshaped since, are then its groups' zones). */
  rooms?: number;
  /** What the placer made of it, once it has been carried out. */
  placed?: { moved: number; left: string[]; crowded: string[]; ms: number; before: number; after: number; stopped: boolean };
}
/** Each board's plan, by the document's name (this session's). */
type Kept = LayoutKept;
const plans = signal<Map<string, Kept>>(new Map());
const keep = (name: string, k: Kept | null) => { const m = new Map(plans.value); if (k) m.set(name, k); else m.delete(name); plans.value = m; };
/** A board's plan with what came of it, kept or read from outside the panel (Plan, Place and Route). */
export const keepLayout = keep;
export const layoutKeptOf = (name: string): LayoutKept | null => plans.value.get(name) ?? null;
/** The plan a board has, for tests and scripts of the page. */
export const layoutPlanOf = (name: string): LayoutPlan | null => plans.value.get(name)?.plan ?? null;

/** A colour for each group (they come round again after ten). */
export const ZONE_COLOURS = [0x4fc3f7, 0xffb74d, 0x81c784, 0xf06292, 0xba68c8, 0xfff176, 0x4db6ac, 0xff8a65, 0x9fa8da, 0xa1887f];
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const took = (ms: number) => { const t = Math.max(0, Math.round(ms / 1000)); return t < 60 ? `${t} s` : `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, '0')} s`; };
const mm = (v: number) => Math.round((v / toUnits(1)) * 10) / 10;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** What a plan's answer usually comes to (tokens, with the model's thinking) [est]. */
const TYPICAL_OUT = 9000;

/** The project's schematic as the adviser reads it, when the board in front has one. */
function designOf(): DesignDigest | null {
  const p = activeProject();
  const sheets = p ? projectSheets(p).filter((x) => /\.schdoc$/i.test(x.name)) : [];
  if (!p || !sheets.length) return null;
  try { return designDigest(p.name, sheets, compileProject(sheets, compileOptions(p))); } catch { return null; }
}

/** The zones as the board editor draws them. */
function zonesFor(on: PlanOnBoard): NonNullable<PcbEditor['planZones']> {
  const f = on.frame;
  return {
    zones: on.zones.map((z) => ({ name: z.name, box: z.box, colour: ZONE_COLOURS[z.group % ZONE_COLOURS.length]!, bottom: z.bottom })),
    marks: on.edges.map((e) => ({ at: e.at, label: e.designator })),
    markSize: Math.max(f.maxX - f.minX, f.maxY - f.minY) / 70,
  };
}

export function LayoutPlannerPanel() {
  const mode = settings.aiMode;
  const d = active.value;
  const ed = d?.editor instanceof PcbEditor ? d.editor : null;
  const doc = ed ? ed.doc as PcbDocument : null;
  const name = d?.name ?? '';
  const kept = plans.value.get(name) ?? null;
  const [scope, setScope] = useState<PlanScope>(kept?.scope ?? 'unlocked');
  const [brief, setBrief] = useState(kept?.brief ?? '');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState<{ since: number; what: string } | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [info, setInfo] = useState<{ model?: ModelInfo; runs: boolean; allowance?: ServiceConfig['allowance'] }>({ runs: true });
  const [, setBeat] = useState(0);
  const stop = useRef<AbortController | null>(null);
  const job = useRef<RouteJob | null>(null);
  void tick.value;

  // Another board in front: its own scope and brief
  useEffect(() => { setScope(kept?.scope ?? 'unlocked'); setBrief(kept?.brief ?? ''); setRemarks(''); setError(''); setOpen(new Set()); }, [name]);
  useEffect(() => {
    if (mode === 'off') return;
    let live = true;
    if (mode === 'konium') void serviceConfig().then((c) => { if (live) setInfo({ runs: serviceRuns(c, 'layout'), allowance: c.allowance, model: c.models.find((m) => m.id === (modelFor(mode) || c.defaults.model)) }); }).catch(() => undefined);
    else void listModels(mode).then((ms) => { if (live) setInfo({ runs: true, model: ms.find((m) => m.id === modelFor(mode)) }); }).catch(() => undefined);
    return () => { live = false; };
  }, [mode]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setBeat((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [!!busy]);

  // The board as it will be sent (written again when the board in front, the scope or the board itself changes)
  const design = useMemo(() => (doc && mode !== 'off' ? designOf() : null), [name, mode, kept?.round]);
  const sent = useMemo(() => (doc && mode !== 'off' ? layoutBrief(doc, { scope, design }) : null), [name, mode, scope, design, tick.value]);
  const on = useMemo(() => (doc && kept ? planOnBoard(doc, kept.plan, kept.scope, { rooms: kept.rooms === kept.round }) : null), [name, kept, tick.value]);
  // The zones over the board, while the plan says to show them
  useEffect(() => { if (ed) ed.setPlanZones(on && kept?.show ? zonesFor(on) : null); }, [ed, on, kept?.show]);

  if (mode === 'off') {
    return (
      <section class="panel docked layout-planner" aria-label="Layout Planner">
        <AiOff sends="Nothing is sent anywhere until you ask for a plan, and the panel says what it will send first." onOpen={() => { prefsPage.value = 'sys-ai'; showPrefs.value = true; }} />
      </section>
    );
  }
  if (!ed || !doc) {
    return (
      <section class="panel docked layout-planner" aria-label="Layout Planner">
        <EmptyState icon="kpBoard" title="No board in front" action={<button class="btn" title="A small board of Konium Designer's own, its parts still beside the outline" onClick={() => void commands.run('ai.layoutExample', activeScope.value)}><Icon name="partsExample" />Open the Example Board</button>}>
          Bring a board in front to plan its layout.
        </EmptyState>
      </section>
    );
  }
  if (!sent) return <section class="panel docked layout-planner" aria-label="Layout Planner"><EmptyState icon="kpBoard" title="No board outline yet">Draw the board's shape first (Design › Board Shape), so the plan knows the room it has.</EmptyState></section>;

  const input = (previous: string, change: string, result = '') => ({ board: sent.text, brief: brief.trim(), parts: sent.parts, previous, result, remarks: change });
  const tooBig = sent.text.length > TEXT_BUDGET[mode];
  const cost = mode === 'local' ? 'Free: it runs on your model.' : mode === 'konium' ? `${allowanceNote(info.allowance, info.model)}.`
    : `Estimated cost: ${money(estimateCost(estimateTokens(LAYOUT.messages(input('', ''))), TYPICAL_OUT, info.model))}.`;
  const who = info.model?.name ?? shownId(modelFor(mode));

  const run = async (again: boolean) => {
    const previous = again && kept ? JSON.stringify({ summary: kept.plan.summary, groups: kept.plan.groups, edges: kept.plan.edges, near: kept.plan.near, apart: kept.plan.apart, clear: kept.plan.clear, notes: kept.plan.notes }) : '';
    const since = Date.now(), board = name;
    stop.current = new AbortController();
    setError(''); setBusy({ since, what: again ? 'Planning again' : 'Planning the layout' });
    try {
      // A second round on a plan that was carried out says what came of it
      const result = again && kept?.placed && on ? resultText(on, { left: on.waiting, crowded: kept.placed.crowded, length: connectionLength(doc) }) : '';
      const r = await runJob(LAYOUT, input(previous, again ? remarks.trim() : '', result), { signal: stop.current.signal });
      keep(board, { plan: r.value, scope, brief: brief.trim(), model: info.model && r.model === info.model.id ? info.model.name : shownId(r.model), usage: r.usage, ms: Date.now() - since, show: true, round: (again && kept ? kept.round : 0) + 1 });
      setRemarks(''); setOpen(new Set());
      if (mode === 'konium') void serviceConfig().then((c) => setInfo((i) => ({ ...i, allowance: c.allowance }))).catch(() => undefined);
    } catch (e) {
      if (!stop.current?.signal.aborted) setError(e instanceof AiError || e instanceof Error ? e.message : String(e));
    }
    stop.current = null; setBusy(null);
  };

  /** Parts selected and shown on the board. */
  const showParts = (designators: string[]) => {
    const od = docs.value.find((x) => x.name === name && x.editor instanceof PcbEditor);
    if (!od) return;
    const e = od.editor as PcbEditor, keys = new Set<string>();
    const want = new Set(designators.map((x) => x.toUpperCase()));
    e.doc.components.forEach((c, i) => { if (want.has(c.designator.toUpperCase())) for (const k of e.componentKeys(i)) keys.add(k); });
    if (!keys.size) { notify('Not found on the board', 'error'); return; }
    activeId.value = od.id;
    whenMounted(e, () => { e.selection = keys; e.invalidateOverlay(); e.jumpToSelection(Math.round(toUnits(6))); tick.value++; });
  };
  const part = (designator: string) => <button class="lp-part" title={`Select ${designator} on the board`} onClick={() => showParts([designator])}>{designator}</button>;
  const partOf = (to: string) => { const dash = to.lastIndexOf('-'); return doc.components.some((c) => c.designator.toUpperCase() === to.toUpperCase()) || dash < 0 ? to : to.slice(0, dash); };

  const makeRooms = () => {
    if (!on || !on.zones.length) return;
    const r = planRooms(doc, on);
    ed.undo.transact('Rooms from the layout plan', (tx) => { for (const c of r.changes) tx.add(c); });
    if (kept) keep(name, { ...kept, show: false, rooms: kept.round });
    ed.invalidate(); tick.value++;
    notify(`${plural(r.rooms, 'room')} from the plan${r.fresh < r.rooms ? ` (${r.rooms - r.fresh} brought up to date)` : ''}, each with a component class of its parts: move or reshape them as any room`);
  };
  /** The plan carried out: every part to place put where the plan asks, in one undo step. */
  const place = async () => {
    if (!kept || !on) return;
    const before = connectionLength(doc), board = name;
    job.current = { cancelled: false, paused: false };
    setError(''); setBusy({ since: Date.now(), what: 'Placing' });
    try {
      const r = await placeByPlan(doc, kept.plan, on, kept.scope, { job: job.current, progress: (i, n) => ed.status?.(`Layout Planner: ${i} of ${n} placed`) });
      if (r.moves.length) ed.undo.transact('Place by the layout plan', (tx) => tx.add(moveComponentsEach(doc, r.moves)));
      keep(board, { ...kept, show: false, placed: { moved: r.moves.length, left: r.left, crowded: r.crowded, ms: r.ms, before, after: connectionLength(doc), stopped: r.stopped } });
      ed.selection = new Set(); ed.invalidate(); tick.value++;
      void commands.run('view.fitBoard', activeScope.value);
      ed.status?.(`Layout Planner: ${plural(r.moves.length, 'part')} placed${r.left.length ? `, ${r.left.length} found no room` : ''}`);
      if (!r.moves.length) notify(r.left.length ? 'The placer found no room on the board for the parts' : 'Nothing to place', 'error');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    job.current = null; setBusy(null);
  };
  const copy = () => { if (kept) void navigator.clipboard?.writeText(planText(kept.plan)).then(() => notify('The plan is on the clipboard'), () => notify('The browser would not let the plan onto the clipboard', 'error')); };

  const plan = kept?.plan;
  const sentPlacing = sent.placing;
  /** "11 of 12 close enough. " for the marks that can be judged (their parts on the board). */
  const tally = (marks: { placed: boolean; ok: boolean }[], what: string) => { const m = marks.filter((x) => x.placed); return m.length ? `${m.filter((x) => x.ok).length} of ${m.length} ${what}. ` : ''; };
  const unmet = on ? [...on.edges, ...on.near, ...on.apart].filter((m) => m.placed && !m.ok).length + on.waiting.length : 0;
  const usage = kept ? [kept.usage.in || kept.usage.out ? `${kept.usage.in.toLocaleString('en-GB')} tokens in, ${kept.usage.out.toLocaleString('en-GB')} out` : '', kept.usage.cost ? money(kept.usage.cost) : ''].filter(Boolean).join(', ') : '';
  return (
    <section class="panel docked layout-planner" aria-label="Layout Planner">
      <div class="kp-board"><Icon name="kpBoard" /><div><b>{name}</b><span>{plural(sent.placing, 'part')} to place{sent.fixed ? `, ${sent.fixed} fixed` : ''}, {plural(sent.nets, 'net')}. Their bodies and pads cover {Math.round(sent.cover * 100)}% of the board.</span></div></div>
      <div class="lp-row"><label for="lp-scope">Plan</label>
        <select id="lp-scope" value={scope} disabled={!!busy} onChange={(e) => setScope((e.currentTarget as HTMLSelectElement).value as PlanScope)}>
          <option value="unlocked">Every part that isn't locked</option>
          <option value="outside">Only the parts not yet on the board</option>
        </select></div>
      <textarea class="lp-brief" aria-label="What the layout must do" placeholder="What must the layout do? (e.g. USB and power at the left edge, the antenna top right, nothing tall near the mounting holes)" value={brief} disabled={!!busy}
        onInput={(e) => setBrief((e.currentTarget as HTMLTextAreaElement).value)} onKeyDown={(e) => e.stopPropagation()} />
      <p class="kp-note"><Icon name="kpSend" size={13} /><span>Sends the board's outline, its parts (designators, values, footprints, sizes) and its nets{design ? ', with the schematic\'s descriptions, sheets and pin names,' : ''} and what you write here to {destination()}. No drawing goes, and no positions but the fixed parts'. {cost}</span></p>
      {!info.runs && <p class="small ai-error">{NOT_YET}.</p>}
      {tooBig && <p class="small ai-error">This board is too large to send in one piece ({Math.round(sent.text.length / 1000)} thousand characters, {Math.round(TEXT_BUDGET[mode] / 1000)} at most{mode === 'local' ? ' for a local model' : ''}).</p>}
      <div class="lp-run">
        <button class="btn default" disabled={!!busy || !info.runs || tooBig || !sent.placing} onClick={() => void run(false)}><Icon name="kpPlanLayout" />{plan ? 'Plan Anew' : 'Plan the Layout'}</button>
        {busy && <button type="button" class="ex-icon-btn" aria-label="Stop" title="Stop" onClick={() => { stop.current?.abort(); if (job.current) job.current.cancelled = true; }}><Icon name="kpStop" /></button>}
        {busy && <span class="lp-busy" role="status">{busy.what}{who ? ` with ${who}` : ''}… {took(Date.now() - busy.since)}</span>}
      </div>
      {!sent.placing && <p class="small muted">Every part is locked{scope === 'outside' ? ' or on the board already' : ''}: there is nothing to plan.</p>}
      {error && <p class="small ai-error" role="alert">{error}</p>}

      {plan && on && <div class="lp-plan">
        <div class="lp-card">
        <div class="lp-card-head"><h4>The plan</h4>
          <span class="lp-tools">
            <button type="button" class="ex-icon-btn" aria-label="Make Rooms" disabled={!!busy || !on.zones.length} title="Make rooms: a room for each group, with a component class of its parts (one undo step). A room moved or reshaped is the zone its group is placed in" onClick={makeRooms}><Icon name="kpRooms" /></button>
            <button type="button" class="ex-icon-btn" aria-label="Copy the Plan" title="Copy the plan as text, onto the clipboard" onClick={copy}><Icon name="kpCopy" /></button>
          </span></div>
        {plan.summary && <p class="small">{plan.summary}</p>}
        <p class="lp-meta">{kept.round > 1 ? `Round ${kept.round}, by` : 'By'} {kept.model || 'the model'} in {took(kept.ms)}{usage ? ` (${usage})` : ''}: {plural(plan.groups.length, 'group')}, {plural(plan.edges.length, 'part')} at the edges, {plural(plan.near.length, 'part')} to keep close.</p>
        {on.shrunk && <p class="small ai-error">With room to route, the parts need about {Math.round(on.fill * 100)}% of the board on one side: the zones are drawn smaller than that to fit. A tight board: both sides, or a larger outline.</p>}
        {plan.unknown.length > 0 && <p class="small ai-error">Left out, not on the board: {plan.unknown.join(', ')}.</p>}
        {plan.ungrouped.length > 0 && <p class="small ai-error">In no group ({plan.ungrouped.length}): {plan.ungrouped.slice(0, 40).join(', ')}{plan.ungrouped.length > 40 ? ' …' : ''}.</p>}
        {on.missing.length > 0 && <p class="small ai-error">Pins the board doesn't have: {on.missing.join(', ')}.</p>}
        <div class="lp-run">
          <label class="lp-check"><input type="checkbox" checked={kept.show} onChange={(e) => keep(name, { ...kept, show: (e.currentTarget as HTMLInputElement).checked })} /> Show the zones on the board</label>
          <span class="spacer" />
          <button class="btn default" disabled={!!busy || !sentPlacing} title="Puts every part the plan covers where the plan asks: at its edge, in its group's zone, beside its pin (one undo step)" onClick={() => void place()}><Icon name="kpPlace" />Place by the Plan</button>
        </div>
        </div>

        {kept.placed && <div class="lp-result" role="status">
          <p class="small"><b>Placed:</b> {plural(kept.placed.moved, 'part')} in {took(kept.placed.ms)}{kept.placed.stopped ? ' (stopped)' : ''}. {tally(on.edges, 'at their edges')}{tally(on.near, 'close enough')}{tally(on.apart, 'far enough apart')}The connections' length is {Math.round(connectionLength(doc))} mm{kept.placed.before > kept.placed.after * 1.05 ? ` (it was ${Math.round(kept.placed.before)} mm)` : ''}.</p>
          {on.waiting.length > 0 && <p class="small ai-error">No room was found for {on.waiting.join(', ')}: {on.waiting.length === 1 ? 'it stays where it was' : 'they stay where they were'}.</p>}
          {kept.placed.crowded.length > 0 && <p class="small ai-error">Closer than asked, for want of room: {kept.placed.crowded.join('; ')}.</p>}
          <p class="small muted">Edit › Undo takes the placing back. What the plan asks is marked below as the board stands: move a part and its mark follows.</p>
        </div>}

        <h4>Groups</h4>
        {plan.groups.map((g, k) => {
          const z = on.zones.find((x) => x.group === k), shown = open.has(k);
          return (
            <div class="lp-group" key={g.name}>
              <div class="lp-head">
                <span class="lp-chip" style={{ background: hex(ZONE_COLOURS[k % ZONE_COLOURS.length]!) }} />
                <button class="lp-name" title="Select the group's parts on the board" onClick={() => showParts(g.parts)}>{g.name}</button>
                <button type="button" class="lp-more" aria-expanded={shown} aria-label={`${g.name}: its parts`} title={shown ? 'Hide its parts' : 'Show its parts'} onClick={() => { const n = new Set(open); if (shown) n.delete(k); else n.add(k); setOpen(n); }}><Icon name="kpMore" size={14} /></button>
              </div>
              <p class="small muted">{plural(g.parts.length, 'part')}, {g.side} side{z ? `, a zone of ${mm(z.box.maxX - z.box.minX)} × ${mm(z.box.maxY - z.box.minY)} mm` : ''}{z?.held === 'edge' ? ` at the ${z.edge} edge` : z?.held === 'room' ? ' (its room)' : z?.held === 'fixed' ? (z.placing.length ? ' round its fixed part' : ', all fixed') : ''}</p>
              {g.why && <p class="small">{g.why}</p>}
              {shown && <p class="small lp-parts">{g.parts.map((p) => <>{part(p)} </>)}</p>}
            </div>
          );
        })}

        {plan.edges.length > 0 && <><h4>At the edges</h4>
          <ul class="lp-list">{plan.edges.map((e) => {
            const m = on.edges.find((x) => x.designator === e.part);
            return <li key={e.part} class="small">{part(e.part)} at the {e.edge} edge, {Math.round(e.along * 100)}% along it{m?.placed ? <span class={m.ok ? 'lp-ok' : 'lp-far'}> ({m.ok ? 'there' : 'not there'})</span> : ''}{e.why ? `. ${e.why}` : ''}</li>;
          })}</ul></>}
        {plan.near.length > 0 && <><h4>Close together</h4>
          <ul class="lp-list">{plan.near.map((n, i) => {
            const m = on.near.find((x) => x.designator === n.part && x.to === n.to);
            return <li key={`${n.part}-${n.to}-${i}`} class="small">{part(n.part)} within {n.mm} mm of <button class="lp-part" title={`Select ${partOf(n.to)} on the board`} onClick={() => showParts([partOf(n.to)])}>{n.to}</button>
              {m?.placed ? <span class={m.ok ? 'lp-ok' : 'lp-far'}> (now {mm(m.now)} mm)</span> : ''}{n.why ? `. ${n.why}` : ''}</li>;
          })}</ul></>}
        {plan.apart.length > 0 && <><h4>Kept apart</h4>
          <ul class="lp-list">{plan.apart.map((a, i) => {
            const m = on.apart.find((x) => x.a === a.a && x.b === a.b);
            return <li key={`${a.a}-${a.b}-${i}`} class="small">{part(a.a)} and {part(a.b)} at least {a.mm} mm{m?.placed ? <span class={m.ok ? 'lp-ok' : 'lp-far'}> (now {mm(m.now)} mm)</span> : ''}{a.why ? `. ${a.why}` : ''}</li>;
          })}</ul></>}
        {plan.clear.length > 0 && <><h4>Kept clear</h4>
          <ul class="lp-list">{plan.clear.map((c) => <li key={c.part} class="small">{part(c.part)}: {c.mm} mm round it{c.why ? `. ${c.why}` : ''}</li>)}</ul></>}
        {plan.notes.length > 0 && <><h4>Notes</h4>
          <ul class="lp-list">{plan.notes.map((n, i) => <li key={i} class="small">{n}</li>)}</ul></>}

        <h4>Change the plan</h4>
        <textarea class="lp-brief" aria-label="What to change in the plan" placeholder="What should change? (e.g. the regulator lower, away from the crystal; J3 on the top edge; the LEDs in one row)" value={remarks} disabled={!!busy}
          onInput={(e) => setRemarks((e.currentTarget as HTMLTextAreaElement).value)} onKeyDown={(e) => e.stopPropagation()} />
        {kept.placed && <p class="small muted">The plan goes back with what the placer made of it: what was met, and what was not and by how much.</p>}
        <div class="lp-run"><button class="btn" disabled={!!busy || !(remarks.trim() || (kept.placed && unmet > 0)) || !info.runs || tooBig} title="Sends the plan back with what you want changed" onClick={() => void run(true)}><Icon name="kpAgain" />Plan Again</button></div>
      </div>}
    </section>
  );
}
