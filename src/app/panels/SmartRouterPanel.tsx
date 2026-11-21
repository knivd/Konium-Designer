import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { count as plural } from '../../core/words';
import { signal } from '@preact/signals';
import { Icon } from '../icons';
import { AiOff, EmptyState } from './kv';
import { active, activeId, activeScope, docs, notify, prefsPage, showPrefs, tick } from '../state';
import { commands } from '../../core/commands';
import { settings } from '../../core/settings';
import { activeProject, compileOptions, projectSheets, whenMounted } from '../project';
import { compileProject } from '../../model/compile';
import { ROUTING, type RoutingPlan } from '../../ai/jobs';
import { designDigest, type DesignDigest } from '../../ai/advise';
import { routeBrief } from '../../ai/routeBrief';
import { TEXT_BUDGET } from '../../ai/datasheet';
import { shownId } from '../../ai/models';
import { AiError, NOT_YET, allowanceNote, destination, estimateCost, estimateTokens, listModels, modelFor, money, runJob, serviceConfig, serviceRuns, type ModelInfo, type ServiceConfig, type Usage } from '../../ai/client';
import type { PcbDocument } from '../../model/pcb';
import { applyRoutingPlan, mmText, routeByPlan, routeOutcome, routeResultText, routingOnBoard, routingText, type Commit, type RouteOutcome, type RouteRun } from '../../model/planRoute';
import type { RouteJob } from '../../model/autoroute';
import { kindLabel } from '../../formats/altium/rules';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { routeFlowing } from '../pcbAutoCommands';

/**
 * Smart Router (Tools › Smart Router, 26.193): how a placed board is to be routed, planned by the
 * model chosen before a track is drawn. The model is sent the board as text (its layers and rules,
 * each part with where it is, each net with its pins and what is left to route, with what the
 * project's schematic says of them) and what the designer writes, and answers with a plan: the
 * nets that are routed alike as classes, each with its width, clearance, layers, vias and place in
 * the order and its style (with corners or free-flowing); the via; the pours; the differential
 * pairs; each with its reason. It gives no
 * coordinates. Make the Rules writes the plan as the board's own net classes, rules, pairs and
 * pours; Route by the Plan has the autorouter carry it out (model/planRoute), in one undo step,
 * and the design rule check measures the result. Plan Again sends the plan back with what the
 * router made of it and what the designer wants changed. A board's plan stays while the panel
 * is closed.
 */

export interface RoutingKept {
  plan: RoutingPlan; brief: string; model: string; usage: Usage; ms: number;
  /** How many rounds made it (1: the first plan), and the board as it was sent for it. */
  round: number;
  board: string;
  /** What the router made of it, once it has been carried out: the run, what was measured after it, both as text, and the run's undo step. */
  routed?: { run: RouteRun; outcome: RouteOutcome; text: string; step: unknown };
  /** The undo step of the routing made by the plan before this one: taken back first when it is still the last thing done. */
  prior?: unknown;
}
/** Each board's plan, by the document's name (this session's). */
type Kept = RoutingKept;
const plans = signal<Map<string, Kept>>(new Map());
const keep = (name: string, k: Kept | null) => { const m = new Map(plans.value); if (k) m.set(name, k); else m.delete(name); plans.value = m; };
/** The plan a board has, for tests and scripts of the page. */
export const routingPlanOf = (name: string): RoutingPlan | null => plans.value.get(name)?.plan ?? null;
/** A board's plan with what came of it, kept or read from outside the panel (Plan, Place and Route). */
export const keepRouting = keep;
export const routingKeptOf = (name: string): RoutingKept | null => plans.value.get(name) ?? null;

/**
 * A routing plan carried out on the board an editor has in front. The run makes its changes as
 * they are ready (each read by what comes after), each a step of the editor's undo, and they are
 * made one step at the end; the board takes no other edits meanwhile. null: the board changed
 * under the run (an undo), which ended there.
 */
export async function routeOnEditor(e: PcbEditor, plan: RoutingPlan, job: RouteJob, say: (text: string) => void): Promise<NonNullable<RoutingKept['routed']> | null> {
  const doc = e.doc as PcbDocument;
  const guard = e.undo.guard, at = e.undo.checkpoint();
  const block = () => 'The Smart Router is routing (stop it first)';
  let rev = e.undo.revision;
  const commit: Commit = (fn) => {
    if (e.undo.revision !== rev) return false;
    e.undo.guard = guard;
    try { e.undo.transact(RUN_LABEL, (tx) => fn((c) => tx.add(c))); } finally { e.undo.guard = block; }
    rev = e.undo.revision;
    e.invalidate();
    return true;
  };
  e.undo.guard = block;
  try {
    const r = await routeByPlan(doc, plan, { commit, job, flowing: routeFlowing(), progress: say });
    e.undo.guard = guard;
    if (!r) return null;
    e.undo.mergeSince(at, RUN_LABEL);
    const outcome = routeOutcome(doc, plan, r.drcBefore);
    return { run: r, outcome, text: routeResultText(doc, plan, r, outcome), step: e.undo.checkpoint() === at ? undefined : e.undo.checkpoint() };
  } finally {
    e.undo.guard = guard;
    e.selection = new Set(); e.invalidate(); tick.value++;
  }
}

const took = (ms: number) => { const t = Math.max(0, Math.round(ms / 1000)); return t < 60 ? `${t} s` : `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, '0')} s`; };
const VIA_WORDS = { free: 'vias as needed', few: 'few vias', none: 'no vias' } as const;
/** What a plan's answer usually comes to (tokens, with the model's thinking) [est]. */
const TYPICAL_OUT = 7000;
const RUN_LABEL = 'Route by the routing plan';

/** The project's schematic as the adviser reads it, when the board in front has one. */
function designOf(): DesignDigest | null {
  const p = activeProject();
  const sheets = p ? projectSheets(p).filter((x) => /\.schdoc$/i.test(x.name)) : [];
  if (!p || !sheets.length) return null;
  try { return designDigest(p.name, sheets, compileProject(sheets, compileOptions(p))); } catch { return null; }
}

export function SmartRouterPanel() {
  const mode = settings.aiMode;
  const d = active.value;
  const ed = d?.editor instanceof PcbEditor ? d.editor : null;
  const doc = ed ? ed.doc as PcbDocument : null;
  const name = d?.name ?? '';
  const kept = plans.value.get(name) ?? null;
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

  // Another board in front: its own brief
  useEffect(() => { setBrief(kept?.brief ?? ''); setRemarks(''); setError(''); setOpen(new Set()); }, [name]);
  useEffect(() => {
    if (mode === 'off') return;
    let live = true;
    if (mode === 'konium') void serviceConfig().then((c) => { if (live) setInfo({ runs: serviceRuns(c, 'routing'), allowance: c.allowance, model: c.models.find((m) => m.id === (modelFor(mode) || c.defaults.model)) }); }).catch(() => undefined);
    else void listModels(mode).then((ms) => { if (live) setInfo({ runs: true, model: ms.find((m) => m.id === modelFor(mode)) }); }).catch(() => undefined);
    return () => { live = false; };
  }, [mode]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setBeat((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [!!busy]);

  // The board as it will be sent (written again when the board in front or the board itself changes)
  const design = useMemo(() => (doc && mode !== 'off' ? designOf() : null), [name, mode, kept?.round]);
  const sent = useMemo(() => (doc && mode !== 'off' ? routeBrief(doc, { design }) : null), [name, mode, design, tick.value]);
  const on = useMemo(() => (doc && kept ? routingOnBoard(doc, kept.plan) : null), [name, kept, tick.value]);

  if (mode === 'off') {
    return (
      <section class="panel docked layout-planner smart-router" aria-label="Smart Router">
        <AiOff sends="Nothing is sent anywhere until you ask for a plan, and the panel says what it will send first." onOpen={() => { prefsPage.value = 'sys-ai'; showPrefs.value = true; }} />
      </section>
    );
  }
  if (!ed || !doc) {
    return (
      <section class="panel docked layout-planner smart-router" aria-label="Smart Router">
        <EmptyState icon="kpBoard" title="No board in front" action={<button class="btn" title="A small board of Konium Designer's own, its parts placed and nothing routed" onClick={() => void commands.run('ai.routeExample', activeScope.value)}><Icon name="partsExample" />Open the Example Board</button>}>
          Bring a placed board in front to plan its routing.
        </EmptyState>
      </section>
    );
  }
  if (!sent) return <section class="panel docked layout-planner smart-router" aria-label="Smart Router"><EmptyState icon="kpBoard" title="No board outline yet">Draw the board's shape first (Design › Board Shape).</EmptyState></section>;

  const input = (board: string, previous: string, change: string, result = '') => ({ board, brief: brief.trim(), nets: sent.nets, layers: sent.layers, previous, result, remarks: change });
  const tooBig = sent.text.length > TEXT_BUDGET[mode];
  const cost = mode === 'local' ? 'Free: it runs on your model.' : mode === 'konium' ? `${allowanceNote(info.allowance, info.model)}.`
    : `Estimated cost: ${money(estimateCost(estimateTokens(ROUTING.messages(input(sent.text, '', ''))), TYPICAL_OUT, info.model))}.`;
  const who = info.model?.name ?? shownId(modelFor(mode));
  /** The run of the plan in hand is still the last thing done on the board (so Undo, or the next run, takes it back whole). */
  const lastDone = (step: unknown) => step !== undefined && step !== null && ed.undo.checkpoint() === step;

  const run = async (again: boolean) => {
    const p = kept?.plan;
    const previous = again && p ? JSON.stringify({ summary: p.summary, classes: p.classes, via: p.via, pours: p.pours, pairs: p.pairs, notes: p.notes }) : '';
    const since = Date.now(), board = name;
    stop.current = new AbortController();
    setError(''); setBusy({ since, what: again ? 'Planning again' : 'Planning the routing' });
    try {
      // A plan whose routing is still the last thing done is taken back by the next run: the model plans for the board as it was sent then
      const back = kept?.routed && lastDone(kept.routed.step) ? kept.routed.step : kept?.prior && lastDone(kept.prior) ? kept.prior : undefined;
      const text = back !== undefined && kept ? kept.board : sent.text;
      const r = await runJob(ROUTING, input(text, previous, again ? remarks.trim() : '', again ? kept?.routed?.text ?? '' : ''), { signal: stop.current.signal });
      keep(board, { plan: r.value, brief: brief.trim(), model: info.model && r.model === info.model.id ? info.model.name : shownId(r.model), usage: r.usage, ms: Date.now() - since, round: (again && kept ? kept.round : 0) + 1, board: text, prior: back });
      setRemarks(''); setOpen(new Set());
      if (mode === 'konium') void serviceConfig().then((c) => setInfo((i) => ({ ...i, allowance: c.allowance }))).catch(() => undefined);
    } catch (e) {
      if (!stop.current?.signal.aborted) setError(e instanceof AiError || e instanceof Error ? e.message : String(e));
    }
    stop.current = null; setBusy(null);
  };

  /** A class's nets selected on the board. */
  const showNets = (nets: number[]) => {
    const od = docs.value.find((x) => x.name === name && x.editor instanceof PcbEditor);
    if (!od || !nets.length) return;
    const e = od.editor as PcbEditor;
    activeId.value = od.id;
    whenMounted(e, () => { nets.forEach((n, k) => e.selectNet(n, k > 0)); e.invalidateOverlay(); tick.value++; });
  };
  const netButton = (n: string) => { const i = doc.nets.findIndex((x) => x.name === n); return <button class="lp-part" title={`Select ${n} on the board`} onClick={() => showNets(i >= 0 ? [i] : [])}>{n}</button>; };

  /** The plan as the board's own classes, rules, pairs and pours: one undo step. */
  const makeRules = () => {
    if (!kept) return;
    // The routing a plan before made, when it is still the last thing done, goes first
    if (kept.prior !== undefined && lastDone(kept.prior)) { ed.undo.undo(); keep(name, { ...kept, prior: undefined }); }
    let made = { classes: 0, rules: 0, pairs: 0, pours: 0, changed: false, skipped: [] as string[] };
    ed.undo.transact('Rules from the routing plan', (tx) => { made = applyRoutingPlan(doc, kept.plan, (c) => tx.add(c)); });
    ed.invalidate(); tick.value++;
    notify(made.changed ? `From the plan: ${plural(made.classes, 'net class', 'net classes')}, ${plural(made.rules, 'rule')}${made.pairs ? `, ${plural(made.pairs, 'differential pair')}` : ''}${made.pours ? `, ${plural(made.pours, 'pour')}` : ''}. Design › Rules and Design › Classes show them` : 'The board has the plan\'s classes, rules and pours already');
  };

  /** The plan carried out: its rules made, the pours joined, every connection left routed in the plan's order; one undo step. */
  const route = async () => {
    if (!kept) return;
    const why = ed.undo.guard?.();
    if (why) { notify(why, 'error'); return; }
    const board = name, e = ed, plan = kept.plan;
    // The routing a plan before made, when it is still the last thing done, goes first
    if (kept.prior !== undefined && lastDone(kept.prior)) e.undo.undo();
    else if (kept.routed && lastDone(kept.routed.step)) e.undo.undo();
    job.current = { cancelled: false, paused: false };
    setError(''); setBusy({ since: Date.now(), what: 'Routing' });
    try {
      const done = await routeOnEditor(e, plan, job.current, (t) => e.status?.(`Smart Router: ${t}`));
      if (!done) notify('Smart Router: the board changed meanwhile, so the run ended there', 'error');
      else {
        keep(board, { ...kept, prior: undefined, routed: done });
        e.status?.(`Smart Router: ${plural(done.run.routed, 'connection')} routed${done.run.left ? `, ${done.run.left} left` : ''}`);
      }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    job.current = null; setBusy(null);
  };
  const copy = () => { if (kept) void navigator.clipboard?.writeText(routingText(kept.plan)).then(() => notify('The plan is on the clipboard'), () => notify('The browser would not let the plan onto the clipboard', 'error')); };

  const plan = kept?.plan;
  const routed = kept?.routed;
  const usage = kept ? [kept.usage.in || kept.usage.out ? `${kept.usage.in.toLocaleString('en-GB')} tokens in, ${kept.usage.out.toLocaleString('en-GB')} out` : '', kept.usage.cost ? money(kept.usage.cost) : ''].filter(Boolean).join(', ') : '';
  const takesBack = !!kept && ((kept.prior !== undefined && lastDone(kept.prior)) || (!!routed && lastDone(routed.step)));
  const canPlan = !busy && info.runs && !tooBig && !sent.unplaced && sent.nets.length > 0;
  return (
    <section class="panel docked layout-planner smart-router" aria-label="Smart Router">
      <div class="kp-board"><Icon name="kpBoard" /><div><b>{name}</b><span>{sent.toRoute ? `${plural(sent.toRoute, 'connection')} to route (${Math.round(sent.length)} mm as the crow flies)` : 'nothing left to route'}, {plural(sent.nets.length, 'net')}, {plural(sent.layers.length, 'copper layer')}.</span></div></div>
      {sent.unplaced > 0 && <p class="small ai-error">{plural(sent.unplaced, 'part')} {sent.unplaced === 1 ? 'is' : 'are'} not on the board yet. A board is routed once its parts are placed (Tools › Layout Planner places them by a plan).</p>}
      <textarea class="lp-brief" aria-label="What the routing must do" placeholder="What must the routing do? (e.g. the 5 V rail carries 2 A; keep the bottom layer for ground; the fabricator makes 0.15 mm tracks and gaps)" value={brief} disabled={!!busy}
        onInput={(e) => setBrief((e.currentTarget as HTMLTextAreaElement).value)} onKeyDown={(e) => e.stopPropagation()} />
      <p class="kp-note"><Icon name="kpSend" size={13} /><span>Sends the board's layers and rules, its parts (designators, values, footprints, where each is) and its nets with their pins{design ? ', with the schematic\'s descriptions and pin names,' : ''} and what you write here to {destination()}. No drawing goes. {cost}</span></p>
      {!info.runs && <p class="small ai-error">{NOT_YET}.</p>}
      {tooBig && <p class="small ai-error">This board is too large to send in one piece ({Math.round(sent.text.length / 1000)} thousand characters, {Math.round(TEXT_BUDGET[mode] / 1000)} at most{mode === 'local' ? ' for a local model' : ''}).</p>}
      <div class="lp-run">
        <button class="btn default" disabled={!canPlan} onClick={() => void run(false)}><Icon name="kpPlanRouting" />{plan ? 'Plan Anew' : 'Plan the Routing'}</button>
        {busy && <button type="button" class="ex-icon-btn" aria-label="Stop" title="Stop" onClick={() => { stop.current?.abort(); if (job.current) job.current.cancelled = true; }}><Icon name="kpStop" /></button>}
        {busy && <span class="lp-busy" role="status">{busy.what}{who && !job.current ? ` with ${who}` : ''}… {took(Date.now() - busy.since)}</span>}
      </div>
      {error && <p class="small ai-error" role="alert">{error}</p>}

      {plan && kept && on && <div class="lp-plan">
        <div class="lp-card">
        <div class="lp-card-head"><h4>The plan</h4>
          <span class="lp-tools">
            <button type="button" class="ex-icon-btn" aria-label="Copy the Plan" title="Copy the plan as text, onto the clipboard" onClick={copy}><Icon name="kpCopy" /></button>
          </span></div>
        {plan.summary && <p class="small">{plan.summary}</p>}
        <p class="lp-meta">{kept.round > 1 ? `Round ${kept.round}, by` : 'By'} {kept.model || 'the model'} in {took(kept.ms)}{usage ? ` (${usage})` : ''}: {plural(plan.classes.length, 'class', 'classes')}{plan.pours.length ? `, ${plural(plan.pours.length, 'pour')}` : ''}{plan.pairs.length ? `, ${plural(plan.pairs.length, 'differential pair')}` : ''}.</p>
        {plan.unknown.length > 0 && <p class="small ai-error">Left out, not on the board: {plan.unknown.join(', ')}.</p>}
        {plan.unclassed.length > 0 && <p class="small ai-error">In no class ({plan.unclassed.length}), so routed last at the board's own rules: {plan.unclassed.slice(0, 40).join(', ')}{plan.unclassed.length > 40 ? ' …' : ''}.</p>}
        {on.skipped.map((s) => <p class="small ai-error" key={s}>{s}.</p>)}
        <div class="lp-run">
          <button class="btn default" disabled={!!busy || !!sent.unplaced} title="Makes the plan's rules, joins the pads of poured and plane nets to their copper by a via, and has the autorouter route every connection left in the plan's order, each class at its width, on its layers (one undo step)" onClick={() => void route()}><Icon name="kpRoute" />Route by the Plan</button>
          <button class="btn" disabled={!!busy || on.applied} title="The plan as the board's own net classes, width and clearance rules, via rule, differential pairs with their rules, and pours (one undo step): look them over in Design › Rules and Design › Classes before routing" onClick={makeRules}><Icon name="kpRules" />Make the Rules</button>
        </div>
        {takesBack && !routed && <p class="small muted">The routing made by the plan before is the last thing done on the board: carrying this plan out takes it back first.</p>}
        </div>

        {routed && <div class="lp-result" role="status">
          <p class="small"><b>Routed:</b> {plural(routed.run.routed, 'connection')} in {took(routed.run.ms)}{routed.run.stopped ? ' (stopped)' : ''}{routed.run.fanned ? `, and ${plural(routed.run.fanned, 'pad')} joined to ${routed.run.fanned === 1 ? 'its' : 'their'} pour or plane by a via` : ''}. {plural(routed.run.vias, 'via')} and {Math.round(routed.run.length)} mm of track added. {on.left ? `${plural(on.left, 'connection')} of ${routed.run.before} ${on.left === 1 ? 'is' : 'are'} left.` : `None of the ${plural(routed.run.before, 'connection')} is left.`}</p>
          {routed.run.fanFailed > 0 && <p class="small ai-error">{plural(routed.run.fanFailed, 'pad')} had no room for a via into {routed.run.fanFailed === 1 ? 'its' : 'their'} pour or plane.</p>}
          {routed.run.pairs > 0 && <p class={`small${routed.run.coupled < routed.run.pairs ? ' ai-error' : ''}`}>{routed.run.coupled} of {plural(routed.run.pairs, 'differential pair')} laid side by side at {routed.run.pairs === 1 ? 'its' : 'their'} gap.</p>}
          {routed.run.flowed > 0 && <p class="small">{plural(routed.run.flowed, 'route')} made free-flowing, with {plural(routed.run.arcs, 'arc')}.</p>}
          {routed.run.necked > 0 && <p class="small">{plural(routed.run.necked, 'connection')} {routed.run.necked === 1 ? 'is' : 'are'} necked down at a pad narrower than the track.</p>}
          {routed.run.narrowed.length > 0 && <p class="small ai-error">Routed narrower than their class's width, where that could not get through: {routed.run.narrowed.join(', ')}.</p>}
          <p class={`small${routed.outcome.violations ? ' ai-error' : ''}`}>{routed.outcome.violations ? `The design rule check found ${plural(routed.outcome.violations, 'violation')} of the copper, hole and pair rules that ${routed.outcome.violations === 1 ? 'was' : 'were'} not there before the run (${routed.outcome.drc.map((x) => `${kindLabel(x.kind)} ${x.n}`).join(', ')}): they are marked on the board.` : 'The design rule check found no violation of the copper, hole and pair rules that was not there before the run.'}{routed.outcome.standing ? ` ${routed.outcome.standing} ${routed.outcome.standing === 1 ? 'was' : 'were'} there before.` : ''}</p>
          <p class="small muted">{lastDone(routed.step) ? 'Edit › Undo takes the whole run back in one step: the tracks, the vias, the pours and the rules.' : 'The board has changed since the run.'} What is left is counted below as the board stands.</p>
        </div>}

        <h4>Classes, in the order they are routed</h4>
        {[...on.classes].sort((a, b) => a.cls.order - b.cls.order).map((c) => {
          const k = plan.classes.indexOf(c.cls), shown = open.has(k), cl = c.cls;
          return (
            <div class="lp-group" key={cl.name}>
              <div class="lp-head">
                <span class="sr-order small">{cl.order}</span>
                <button class="lp-name" title="Select the class's nets on the board" onClick={() => showNets(c.nets)}>{cl.name}</button>
                <button type="button" class="lp-more" aria-expanded={shown} aria-label={`${cl.name}: its nets`} title={shown ? 'Hide its nets' : 'Show its nets'} onClick={() => { const n = new Set(open); if (shown) n.delete(k); else n.add(k); setOpen(n); }}><Icon name="kpMore" size={14} /></button>
              </div>
              <p class="small muted">{plural(cl.nets.length, 'net')}; {cl.width ? `${cl.width} mm wide` : `the board's width (${mmText(on.base.width)})`}{cl.clearance ? `; ${cl.clearance} mm clear` : ''}; {cl.layers.length ? `on ${cl.layers.join(', ')}` : 'any layer'}; {VIA_WORDS[cl.vias]}{cl.style === 'flowing' ? '; free-flowing' : cl.style === 'corners' ? '; with corners' : ''}
                {c.left ? <span class="lp-far">; {c.left} to route ({Math.round(c.length)} mm)</span> : <span class="lp-ok">; routed</span>}</p>
              {c.narrow && <p class="small ai-error">Narrower than the board's rule allowed ({mmText(on.base.min)}): see that your fabricator makes it.</p>}
              {c.tight && <p class="small ai-error">Closer than the board's rule allowed ({mmText(on.base.gap)}): see that your fabricator makes it.</p>}
              {cl.why && <p class="small">{cl.why}</p>}
              {shown && <p class="small lp-parts">{cl.nets.map((n) => <>{netButton(n)} </>)}</p>}
            </div>
          );
        })}
        {on.unclassed > 0 && <p class="small muted">{plural(on.unclassed, 'connection')} of nets in no class {on.unclassed === 1 ? 'is' : 'are'} left to route.</p>}

        {plan.via && <><h4>Via</h4>
          <p class="small">{plan.via.diameter} mm across with a {plan.via.hole} mm hole (the board's rule: {mmText(on.base.via.diameter)} with {mmText(on.base.via.hole)}){plan.via.why ? `. ${plan.via.why}` : ''}</p></>}
        {plan.pours.length > 0 && <><h4>Pours</h4>
          <ul class="lp-list">{plan.pours.map((p, i) => {
            const m = on.pours.find((x) => x.pour === p);
            return <li key={`${p.net}-${p.layer}-${i}`} class="small">{netButton(p.net)} over {p.layer}{m && m.index >= 0 ? <span class="lp-ok"> (there)</span> : ''}{p.why ? `. ${p.why}` : ''}</li>;
          })}</ul></>}
        {plan.pairs.length > 0 && <><h4>Differential pairs</h4>
          <ul class="lp-list">{plan.pairs.map((p, i) => {
            const m = on.pairs.find((x) => x.pair === p);
            return <li key={`${p.name}-${i}`} class="small">{p.name}: {netButton(p.p)} and {netButton(p.n)}{p.gap ? `, ${p.gap} mm apart` : ''}{m?.there ? <span class="lp-ok"> (there)</span> : ''}{p.why ? `. ${p.why}` : ''}</li>;
          })}</ul>
          <p class="small muted">Each pair is recorded on the board with a Differential Pairs Routing rule of its class's width and its gap, and laid side by side at that gap on one layer where that can be done. A pair that cannot is routed one net at a time and the design rule check says so: route it with Route › Interactive Differential Pair Routing.</p></>}
        {plan.notes.length > 0 && <><h4>Notes</h4>
          <ul class="lp-list">{plan.notes.map((n, i) => <li key={i} class="small">{n}</li>)}</ul></>}

        <h4>Change the plan</h4>
        <textarea class="lp-brief" aria-label="What to change in the plan" placeholder="What should change? (e.g. the 3.3 V rail wider; the clock on the top layer only; no pour on the top)" value={remarks} disabled={!!busy}
          onInput={(e) => setRemarks((e.currentTarget as HTMLTextAreaElement).value)} onKeyDown={(e) => e.stopPropagation()} />
        {routed && <p class="small muted">The plan goes back with what the router made of it: what was left unrouted, what was routed narrower, and what the design rule check found.{lastDone(routed.step) ? ' Routing by the new plan takes this run back first.' : ''}</p>}
        <div class="lp-run"><button class="btn" disabled={!!busy || !(remarks.trim() || (routed && (on.left > 0 || routed.outcome.violations > 0 || routed.run.narrowed.length > 0))) || !info.runs || tooBig} title="Sends the plan back with what you want changed" onClick={() => void run(true)}><Icon name="kpAgain" />Plan Again</button></div>
      </div>}
    </section>
  );
}
