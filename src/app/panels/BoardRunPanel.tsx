import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { Icon } from '../icons';
import { AiOff, EmptyState } from './kv';
import { active, activeScope, prefsPage, showPrefs, tick } from '../state';
import { commands } from '../../core/commands';
import { settings } from '../../core/settings';
import { activeProject, compileOptions, projectSheets } from '../project';
import { compileProject } from '../../model/compile';
import { LAYOUT, ROUTING } from '../../ai/jobs';
import { designDigest, type DesignDigest } from '../../ai/advise';
import { layoutBrief } from '../../ai/layoutBrief';
import { routeBrief } from '../../ai/routeBrief';
import { TEXT_BUDGET } from '../../ai/datasheet';
import { shownId } from '../../ai/models';
import { AiError, NOT_YET, allowanceNote, destination, listModels, modelFor, runJob, serviceConfig, serviceRuns, type ModelInfo, type ServiceConfig } from '../../ai/client';
import type { PcbDocument } from '../../model/pcb';
import { connectionLength, planOnBoard, type PlanScope } from '../../model/layoutPlan';
import { placeByPlan } from '../../model/planPlace';
import { moveComponentsEach } from '../../model/pcbEdit';
import { connections, runDrc } from '../../model/drc';
import { COPPER_KINDS } from '../../model/planRoute';
import { kindLabel } from '../../formats/altium/rules';
import type { RouteJob } from '../../model/autoroute';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { showPanel } from '../dock/store';
import { keepLayout, layoutKeptOf } from './LayoutPlannerPanel';
import { keepRouting, routeOnEditor, routingKeptOf } from './SmartRouterPanel';

/**
 * Plan, Place and Route (Tools › Plan, Place and Route, 26.195): the Layout Planner and the Smart
 * Router as one run, from a board whose parts stand beside its outline to a routed board. Five
 * stages: the layout planned by the model chosen, the parts placed by that plan, the routing
 * planned by the model for the board as placed, the board routed by that plan, and the design
 * rule check. Each stage says what came of it in a line and is one undo step; with Stop after
 * each stage ticked (as it is to begin with) the run waits for a go-ahead before the next, so a
 * plan can be read, and changed in its own panel, before it is carried out. The plans and results
 * are the two panels' own: they show them in full.
 */

type StageId = 'layout' | 'place' | 'routing' | 'route' | 'check';
type StageState = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';
const STAGES: { id: StageId; title: string }[] = [
  { id: 'layout', title: 'Plan the layout' }, { id: 'place', title: 'Place by the plan' }, { id: 'routing', title: 'Plan the routing' },
  { id: 'route', title: 'Route by the plan' }, { id: 'check', title: 'Check' },
];
interface Run { stages: Record<StageId, { state: StageState; line: string }>; /** The stage to do next (5: the run is over). */ next: number; brief: string; stops: boolean }
const fresh = (): Run['stages'] => ({ layout: { state: 'waiting', line: '' }, place: { state: 'waiting', line: '' }, routing: { state: 'waiting', line: '' }, route: { state: 'waiting', line: '' }, check: { state: 'waiting', line: '' } });
/** Each board's run, by the document's name (this session's). */
const runs = signal<Map<string, Run>>(new Map());
const keepRun = (name: string, r: Run) => { const m = new Map(runs.value); m.set(name, r); runs.value = m; };

const took = (ms: number) => { const t = Math.max(0, Math.round(ms / 1000)); return t < 60 ? `${t} s` : `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, '0')} s`; };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The project's schematic as the adviser reads it, when the board in front has one. */
function designOf(): DesignDigest | null {
  const p = activeProject();
  const sheets = p ? projectSheets(p).filter((x) => /\.schdoc$/i.test(x.name)) : [];
  if (!p || !sheets.length) return null;
  try { return designDigest(p.name, sheets, compileProject(sheets, compileOptions(p))); } catch { return null; }
}

export function BoardRunPanel() {
  const mode = settings.aiMode;
  const d = active.value;
  const ed = d?.editor instanceof PcbEditor ? d.editor : null;
  const doc = ed ? ed.doc as PcbDocument : null;
  const name = d?.name ?? '';
  const run = runs.value.get(name) ?? null;
  const [brief, setBrief] = useState(run?.brief ?? '');
  const [stops, setStops] = useState(run?.stops ?? true);
  const [busy, setBusy] = useState<{ since: number; stage: StageId } | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState<{ model?: ModelInfo; runs: boolean; allowance?: ServiceConfig['allowance'] }>({ runs: true });
  const [, setBeat] = useState(0);
  const stop = useRef<AbortController | null>(null);
  const job = useRef<RouteJob | null>(null);
  void tick.value;

  useEffect(() => { setBrief(run?.brief ?? ''); setStops(run?.stops ?? true); setError(''); }, [name]);
  useEffect(() => {
    if (mode === 'off') return;
    let live = true;
    if (mode === 'konium') void serviceConfig().then((c) => { if (live) setInfo({ runs: serviceRuns(c, 'layout') && serviceRuns(c, 'routing'), allowance: c.allowance, model: c.models.find((m) => m.id === (modelFor(mode) || c.defaults.model)) }); }).catch(() => undefined);
    else void listModels(mode).then((ms) => { if (live) setInfo({ runs: true, model: ms.find((m) => m.id === modelFor(mode)) }); }).catch(() => undefined);
    return () => { live = false; };
  }, [mode]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setBeat((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [!!busy]);

  // What there is to do: parts still off the board, connections still to make
  const off = useMemo(() => (doc ? layoutBrief(doc, { scope: 'outside' })?.placing ?? 0 : 0), [name, tick.value]);
  const toRoute = useMemo(() => (doc ? connections(doc).length : 0), [name, tick.value]);

  if (mode === 'off') {
    return (
      <section class="panel docked layout-planner board-run" aria-label="Plan, Place and Route">
        <AiOff sends="Nothing is sent anywhere until you start a run, and the panel says what it will send first." onOpen={() => { prefsPage.value = 'sys-ai'; showPrefs.value = true; }} />
      </section>
    );
  }
  if (!ed || !doc) {
    return (
      <section class="panel docked layout-planner board-run" aria-label="Plan, Place and Route">
        <EmptyState icon="kpBoard" title="No board in front" action={<button class="btn" title="A small board of Konium Designer's own, its parts still beside the outline" onClick={() => { commands.run('ai.layoutExample', activeScope.value); showPanel('boardRun'); }}><Icon name="partsExample" />Open the Example Board</button>}>
          Bring a board in front: one with its parts beside the outline, as an update from the schematic leaves it, or one already placed.
        </EmptyState>
      </section>
    );
  }
  const who = info.model?.name ?? shownId(modelFor(mode));
  const cost = mode === 'local' ? 'Free: it runs on your model.' : mode === 'konium' ? `${allowanceNote(info.allowance, info.model)}, for each of the two plans.` : 'Each plan\'s cost is estimated in its own panel (the Layout Planner, the Smart Router).';

  const set = (r: Run, id: StageId, state: StageState, line: string): Run => ({ ...r, stages: { ...r.stages, [id]: { state, line } } });
  /** One stage; what it leaves in the run. Throws with what went wrong. */
  const stage = async (r: Run, id: StageId): Promise<Run> => {
    const board = name, e = ed;
    const since = Date.now();
    if (id === 'layout') {
      // Every unlocked part when none of them is on the board yet; else only those still off it
      const all = layoutBrief(doc, { scope: 'unlocked' }), out = layoutBrief(doc, { scope: 'outside' });
      if (!out || !all) throw new Error('This board has no outline yet: draw its shape first (Design › Board Shape)');
      if (!out.placing) return set(set(r, 'layout', 'skipped', 'Every part is on the board already.'), 'place', 'skipped', 'Nothing to place.');
      const scope: PlanScope = out.placing === all.placing ? 'unlocked' : 'outside';
      const sent = layoutBrief(doc, { scope, design: designOf() })!;
      if (sent.text.length > TEXT_BUDGET[mode]) throw new Error('This board is too large to send in one piece');
      stop.current = new AbortController();
      const res = await runJob(LAYOUT, { board: sent.text, brief: r.brief, parts: sent.parts, previous: '', result: '', remarks: '' }, { signal: stop.current.signal });
      keepLayout(board, { plan: res.value, scope, brief: r.brief, model: info.model && res.model === info.model.id ? info.model.name : shownId(res.model), usage: res.usage, ms: Date.now() - since, show: true, round: 1 });
      const p = res.value;
      return set(r, 'layout', 'done', `${plural(p.groups.length, 'group')}, ${plural(p.edges.length, 'part')} at the edges, ${plural(p.near.length, 'part')} to keep close${p.unknown.length ? `; ${p.unknown.length} names the board lacks left out` : ''}. ${p.summary}`);
    }
    if (id === 'place') {
      const kept = layoutKeptOf(board);
      if (!kept) throw new Error('There is no layout plan to place by');
      const on = planOnBoard(doc, kept.plan, kept.scope, { rooms: kept.rooms === kept.round });
      if (!on) throw new Error('This board has no outline yet');
      const before = connectionLength(doc);
      job.current = { cancelled: false, paused: false };
      const res = await placeByPlan(doc, kept.plan, on, kept.scope, { job: job.current, progress: (i, n) => e.status?.(`Plan, Place and Route: ${i} of ${n} placed`) });
      if (res.moves.length) e.undo.transact('Place by the layout plan', (tx) => tx.add(moveComponentsEach(doc, res.moves)));
      keepLayout(board, { ...kept, show: false, placed: { moved: res.moves.length, left: res.left, crowded: res.crowded, ms: res.ms, before, after: connectionLength(doc), stopped: res.stopped } });
      e.selection = new Set(); e.invalidate(); tick.value++;
      void commands.run('view.fitBoard', activeScope.value);
      const now = planOnBoard(doc, kept.plan, kept.scope, { rooms: kept.rooms === kept.round });
      const unmet = now ? [...now.edges, ...now.near, ...now.apart].filter((m) => m.placed && !m.ok).length : 0;
      const line = `${plural(res.moves.length, 'part')} placed in ${took(res.ms)}${res.left.length ? `; no room was found for ${res.left.join(', ')}` : ''}${unmet ? `; ${unmet} of what the plan asked is not met` : '; everything the plan asked is met'}. The connections' length is ${Math.round(connectionLength(doc))} mm.`;
      if (res.stopped) throw new Error(`Stopped. ${line}`);
      return set(r, 'place', res.left.length ? 'failed' : 'done', line);
    }
    if (id === 'routing') {
      const sent = routeBrief(doc, { design: designOf() });
      if (!sent) throw new Error('This board has no outline yet');
      if (sent.unplaced) throw new Error(`${plural(sent.unplaced, 'part')} ${sent.unplaced === 1 ? 'is' : 'are'} not on the board: a board is routed once its parts are placed`);
      if (!sent.toRoute) return set(set(r, 'routing', 'skipped', 'Nothing is left to route.'), 'route', 'skipped', 'Nothing to route.');
      if (sent.text.length > TEXT_BUDGET[mode]) throw new Error('This board is too large to send in one piece');
      stop.current = new AbortController();
      const res = await runJob(ROUTING, { board: sent.text, brief: r.brief, nets: sent.nets, layers: sent.layers, previous: '', result: '', remarks: '' }, { signal: stop.current.signal });
      keepRouting(board, { plan: res.value, brief: r.brief, model: info.model && res.model === info.model.id ? info.model.name : shownId(res.model), usage: res.usage, ms: Date.now() - since, round: 1, board: sent.text });
      const p = res.value;
      return set(r, 'routing', 'done', `${plural(p.classes.length, 'class', 'classes')}${p.pours.length ? `, ${plural(p.pours.length, 'pour')}` : ''}${p.pairs.length ? `, ${plural(p.pairs.length, 'differential pair')}` : ''}${p.unknown.length ? `; ${p.unknown.length} names the board lacks left out` : ''}. ${p.summary}`);
    }
    if (id === 'route') {
      const kept = routingKeptOf(board);
      if (!kept) throw new Error('There is no routing plan to route by');
      const why = e.undo.guard?.();
      if (why) throw new Error(why);
      job.current = { cancelled: false, paused: false };
      const done = await routeOnEditor(e, kept.plan, job.current, (t) => e.status?.(`Plan, Place and Route: ${t}`));
      if (!done) throw new Error('The board changed meanwhile, so the routing ended there');
      keepRouting(board, { ...kept, prior: undefined, routed: done });
      const x = done.run;
      const line = `${plural(x.routed, 'connection')} routed in ${took(x.ms)}${x.fanned ? `, ${plural(x.fanned, 'pad')} joined to ${x.fanned === 1 ? 'its' : 'their'} pour or plane` : ''}${x.pairs ? `, ${x.coupled} of ${plural(x.pairs, 'pair')} laid side by side` : ''}${x.flowed ? `, ${plural(x.flowed, 'route')} made free-flowing` : ''}; ${x.left ? `${plural(x.left, 'connection')} of ${x.before} left` : `none of the ${x.before} left`}.`;
      if (x.stopped) throw new Error(`Stopped. ${line}`);
      return set(r, 'route', x.left ? 'failed' : 'done', line);
    }
    // The design rule check as the board's own set of checks has it: what routing answers for (copper, holes, pairs) apart from the rest
    const report = runDrc(doc);
    const mine = new Map<string, number>(), other = new Map<string, number>();
    for (const v of report.violations) { if (v.kind === 'UnRoutedNet') continue; const m = COPPER_KINDS.includes(v.kind) ? mine : other; m.set(v.kind, (m.get(v.kind) ?? 0) + 1); }
    const left = connections(doc).length;
    const list = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${kindLabel(k)} ${n}`).join(', ');
    const count = (m: Map<string, number>) => [...m.values()].reduce((a, n) => a + n, 0);
    const line = `${count(mine) ? `The design rule check finds ${plural(count(mine), 'violation')} of the copper, hole and pair rules (${list(mine)})` : 'The design rule check finds no violation of the copper, hole and pair rules'}, and ${left ? `${plural(left, 'connection')} ${left === 1 ? 'is' : 'are'} left to route` : 'every connection is made'}.`
      + (count(other) ? ` Of its other rules (silkscreen, solder mask and the like) it finds ${count(other)}: ${list(other)}. Tools › Design Rule Check lists them all.` : '');
    return set(r, 'check', count(mine) || left ? 'failed' : 'done', line);
  };

  /** The run from stage `from`: on through the stages until one fails, the run is stopped, or (with stops) a stage that did something is done. */
  const go = async (start: Run) => {
    let r = start;
    setError('');
    for (let k = r.next; k < STAGES.length; k++) {
      const id = STAGES[k]!.id;
      if (r.stages[id].state === 'skipped') { r = { ...r, next: k + 1 }; keepRun(name, r); continue; }
      r = set(r, id, 'running', ''); keepRun(name, r);
      setBusy({ since: Date.now(), stage: id });
      try { r = await stage(r, id); } catch (e) {
        const aborted = stop.current?.signal.aborted;
        r = set(r, id, 'failed', aborted ? 'Stopped.' : e instanceof AiError || e instanceof Error ? e.message : String(e));
        keepRun(name, { ...r, next: k }); stop.current = null; job.current = null; setBusy(null);
        return;
      }
      stop.current = null; job.current = null;
      r = { ...r, next: k + 1 }; keepRun(name, r);
      // A stage that left something undone stops the run; so does any stage that did something, when asked to
      const st = r.stages[id].state;
      if (st === 'failed' || (r.stops && st === 'done' && k + 1 < STAGES.length)) break;
    }
    setBusy(null);
    tick.value++;
  };
  const begin = () => void go({ stages: fresh(), next: 0, brief: brief.trim(), stops });
  const carryOn = () => { if (run) void go({ ...run, stops }); };

  const over = !!run && run.next >= STAGES.length;
  const tooBig = !!doc && ((layoutBrief(doc, { scope: 'unlocked' })?.text.length ?? 0) > TEXT_BUDGET[mode]);
  const nothing = !off && !toRoute;
  const stateWord: Record<StageState, string> = { waiting: '', running: 'now', done: 'done', skipped: 'skipped', failed: 'stopped here' };
  return (
    <section class="panel docked layout-planner board-run" aria-label="Plan, Place and Route">
      <div class="kp-board"><Icon name="kpBoard" /><div><b>{name}</b><span>{off ? `${plural(off, 'part')} to place` : 'every part is on the board'}, {toRoute ? `${plural(toRoute, 'connection')} to route` : 'nothing left to route'}.</span></div></div>
      <textarea class="lp-brief" aria-label="What the board must do" placeholder="What must the board do? Both plans are given this. (e.g. USB and power at the left edge; the 5 V rail carries 2 A; keep the bottom layer for ground)" value={brief} disabled={!!busy}
        onInput={(e) => setBrief((e.currentTarget as HTMLTextAreaElement).value)} onKeyDown={(e) => e.stopPropagation()} />
      <label class="lp-check"><input type="checkbox" checked={stops} disabled={!!busy} onChange={(e) => setStops((e.currentTarget as HTMLInputElement).checked)} /> Stop after each stage for my go-ahead</label>
      <p class="kp-note"><Icon name="kpSend" size={13} /><span>Two plans are asked of the model: the layout's (the board's outline, parts and nets as text) and, once the parts are placed, the routing's (its layers, rules, parts where they stand and nets). Both go with what you write here to {destination()}. No drawing goes. {cost}</span></p>
      {!info.runs && <p class="small ai-error">{NOT_YET}.</p>}
      {tooBig && <p class="small ai-error">This board is too large to send in one piece.</p>}
      <div class="lp-run">
        {(!run || over || !!busy) && <button class="btn default" disabled={!!busy || !info.runs || tooBig || nothing} onClick={begin}><Icon name="kpStart" />{run ? 'Start Anew' : 'Start'}</button>}
        {run && !over && !busy && <button class="btn default" disabled={!info.runs} title="On with the next stage" onClick={carryOn}><Icon name="kpContinue" />Continue</button>}
        {run && !over && !busy && <button type="button" class="ex-icon-btn" aria-label="Start Anew" title="Start anew: both plans asked again from the beginning" disabled={!info.runs || tooBig || nothing} onClick={begin}><Icon name="kpAnew" /></button>}
        {busy && <button type="button" class="ex-icon-btn" aria-label="Stop" title="Stop" onClick={() => { stop.current?.abort(); if (job.current) job.current.cancelled = true; }}><Icon name="kpStop" /></button>}
        {busy && <span class="lp-busy" role="status">{STAGES.find((s) => s.id === busy.stage)!.title}{who && (busy.stage === 'layout' || busy.stage === 'routing') ? ` with ${who}` : ''}… {took(Date.now() - busy.since)}</span>}
      </div>
      {nothing && !run && <p class="small muted">Every part is placed and every connection made: there is nothing for a run to do.</p>}
      {error && <p class="small ai-error" role="alert">{error}</p>}

      {run && <ol class="br-stages">
        {STAGES.map((s, k) => {
          const st = run.stages[s.id];
          return (
            <li key={s.id} class={`br-stage is-${st.state}${k === run.next && !busy && !over ? ' is-next' : ''}`}>
              <div class="lp-head"><span class="sr-order small">{k + 1}</span><span class="lp-name">{s.title}</span>{st.state !== 'waiting' && <span class={`small ${st.state === 'failed' ? 'lp-far' : st.state === 'done' ? 'lp-ok' : 'muted'}`}>{stateWord[st.state]}</span>}</div>
              {st.line && <p class={`small${st.state === 'failed' ? ' ai-error' : ''}`}>{st.line}</p>}
              {s.id === 'layout' && (st.state === 'done' || st.state === 'failed') && <button type="button" class="lp-more lp-link" onClick={() => showPanel('layoutPlanner')}>The plan in the Layout Planner<Icon name="kpGo" size={12} /></button>}
              {s.id === 'routing' && (st.state === 'done' || st.state === 'failed') && <button type="button" class="lp-more lp-link" onClick={() => showPanel('smartRouter')}>The plan in the Smart Router<Icon name="kpGo" size={12} /></button>}
              {s.id === 'route' && st.state === 'failed' && routingKeptOf(name)?.routed && <button type="button" class="lp-more lp-link" title="The Smart Router sends the plan back to the model with what was left, for a second round" onClick={() => showPanel('smartRouter')}>Plan again in the Smart Router<Icon name="kpGo" size={12} /></button>}
            </li>
          );
        })}
      </ol>}
      {run && !busy && run.next > 0 && <p class="small muted">{over ? 'The run is over. ' : ''}Each stage that changed the board is one step of Edit › Undo: the placing, then the routing with its rules and pours. {!over && run.stops ? 'Read the plan in its panel, change it there if you like (Plan Again), then Continue.' : ''}</p>}
    </section>
  );
}

/** A board's run, for tests and scripts of the page. */
export const boardRunOf = (name: string): Run | null => runs.value.get(name) ?? null;
