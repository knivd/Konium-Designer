/**
 * The Requirements Adviser (beneath a requirements document's table or graph): a conversation with
 * the AI model chosen in Preferences › System › AI about the document's requirements. Asked in
 * words, or with one of its starters (review them all, review or break down the one picked, build
 * the hierarchy, find what is missing, choose how each is verified), it answers and proposes:
 * changes to requirements (their wording, type, priority, verification, parent, status) and new
 * ones (under a parent, or in a section), each with its reason. The ones ticked are applied in one
 * step that can be undone; nothing changes until then. The conversation stays with the document
 * while it is open.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { settings } from '../core/settings';
import { prefsPage, showPrefs } from './state';
import { ADVISE_REQS, type AdviceAdd, type AdviceChange, type AdviceInput } from '../ai/jobs';
import { AiError, NOT_YET, allowanceNote, destination, listModels, modelFor, runJob, serviceConfig, serviceRuns, type ModelInfo, type ServiceConfig } from '../ai/client';
import { METHODS, PRIORITIES, REQ_TYPES, STATUSES, labelOf, type Requirement } from '../model/requirements';

interface Turn { ask: string; reply?: string; changes: AdviceChange[]; added: AdviceAdd[]; ticked: Set<string>; done?: string; error?: string; model?: string }
/** Each open document's conversation. */
const talks = new WeakMap<object, Turn[]>();

const STARTERS: [string, string, boolean][] = [
  ['Review them all', 'Review every requirement: which are vague, not verifiable, compound, duplicated or contradict another? Propose the fixes.', false],
  ['Review the picked one', 'Review the picked requirement and propose a better wording, with what it needs to be verifiable.', true],
  ['Break it down', 'Break the picked requirement down into child requirements, one thing to verify each.', true],
  ['Build the hierarchy', 'Put the requirements in a hierarchy: propose a parent for each one that details another, and new parent requirements where several share a broader need.', false],
  ['Find what is missing', 'What requirements is a product like this usually missing (power, protection, EMC, environment, mechanical, interfaces, compliance, manufacturing)? Propose them, with [value] where a figure is mine to give.', false],
  ['Verification', 'Propose how each requirement is best verified where its method doesn\'t fit it.', false],
];

const keyOf = (x: AdviceChange | AdviceAdd) => ('id' in x ? `c:${x.id}` : `a:${x.ref}`);

export function ReqAdviser({ doc, input, picked, current, onApply, onPick }: {
  doc: object;
  input: () => Omit<AdviceInput, 'ask' | 'history'>;
  picked: Requirement | null;
  current: (id: string) => Requirement | undefined;
  onApply: (changes: AdviceChange[], added: AdviceAdd[]) => string;
  onPick: (id: string) => void;
}) {
  const mode = settings.aiMode;
  const [turns, setTurns] = useState<Turn[]>(() => talks.get(doc) ?? []);
  const [ask, setAsk] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<{ model?: ModelInfo; runs: boolean; allowance?: ServiceConfig['allowance'] }>({ runs: true });
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { talks.set(doc, turns); end.current?.scrollIntoView({ block: 'nearest' }); }, [turns]);
  useEffect(() => {
    if (mode === 'off') return;
    let live = true;
    if (mode === 'konium') void serviceConfig().then((c) => { if (live) setInfo({ runs: serviceRuns(c, 'reqadvise'), allowance: c.allowance, model: c.models.find((m) => m.id === (modelFor(mode) || c.defaults.model)) }); }).catch(() => undefined);
    else void listModels(mode).then((ms) => { if (live) setInfo({ runs: true, model: ms.find((m) => m.id === modelFor(mode)) }); }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const before = turns;
    const t: Turn = { ask: q, changes: [], added: [], ticked: new Set() };
    setTurns([...before, t]); setAsk(''); setBusy(true);
    try {
      const history = before.filter((x) => x.reply).map((x) => ({ ask: x.ask, reply: x.reply! }));
      const r = await runJob(ADVISE_REQS, { ...input(), history, ask: q });
      const v = r.value;
      setTurns([...before, { ...t, reply: v.reply, changes: v.changes, added: v.added, ticked: new Set([...v.changes, ...v.added].map(keyOf)), model: r.model }]);
    } catch (e) { setTurns([...before, { ...t, error: e instanceof AiError || e instanceof Error ? e.message : String(e) }]); }
    setBusy(false);
  };
  const update = (k: number, f: (t: Turn) => Turn) => setTurns((ts) => ts.map((t, i) => (i === k ? f(t) : t)));
  const apply = (k: number) => {
    const t = turns[k]!;
    const done = onApply(t.changes.filter((c) => t.ticked.has(keyOf(c))), t.added.filter((a) => t.ticked.has(keyOf(a))));
    update(k, (x) => ({ ...x, done }));
  };
  const idLink = (id: string) => (current(id) ? <button class="link" onClick={() => onPick(id)}>{id}</button> : <b>{id}</b>);

  if (mode === 'off') {
    return (
      <div class="rqa" aria-label="Requirements Adviser">
        <p class="small">AI is off. Choose how Konium Designer reaches a model (the Konium service, your own key, or a model on your computer) in Preferences › System › AI. <button class="link" onClick={() => { prefsPage.value = 'sys-ai'; showPrefs.value = true; }}>Open Preferences</button></p>
      </div>
    );
  }
  return (
    <div class="rqa" aria-label="Requirements Adviser">
      <div class="rqa-talk" role="log" aria-live="polite">
        {!turns.length && <p class="small muted">Ask about the requirements, or start with one of these. It proposes changes and new requirements with its reasons; nothing changes until you apply the ones you tick (one step to undo). It reads this document's requirements (not the rest of the design) and sends them to {destination()}{mode === 'konium' && info.allowance ? `: ${allowanceNote(info.allowance, info.model)}` : ''}.</p>}
        {turns.map((t, k) => (
          <div key={k} class="rqa-turn">
            <div class="rqa-ask">{t.ask}</div>
            {t.error && <p class="small ai-error">{t.error}</p>}
            {!t.reply && !t.error && <p class="small muted">Thinking…</p>}
            {t.reply && <div class="rqa-reply">{t.reply}{t.model && <span class="muted small"> ({t.model})</span>}</div>}
            {(t.changes.length > 0 || t.added.length > 0) && (
              <div class="rqa-props">
                {t.changes.map((c) => {
                  const r = current(c.id), kk = keyOf(c);
                  const field = (name: string, was: string | undefined, now: string | undefined) => (now === undefined ? null : <div class="rqa-field"><span class="muted">{name}</span> {was ? <del>{was}</del> : null}{was ? ' → ' : ''}<ins>{now || 'none'}</ins></div>);
                  return (
                    <label key={kk} class={`rqa-prop${t.done ? ' off' : ''}`}>
                      <input type="checkbox" disabled={!!t.done} checked={t.ticked.has(kk)} onChange={() => update(k, (x) => { const s = new Set(x.ticked); if (s.has(kk)) s.delete(kk); else s.add(kk); return { ...x, ticked: s }; })} />
                      <div>
                        <div>Change {idLink(c.id)}{r?.title ? <span class="muted">: {r.title}</span> : null}</div>
                        {field('Title', r?.title, c.title)}
                        {field('Text', r?.text, c.text)}
                        {field('Type', r && labelOf(REQ_TYPES, r.type), c.type && labelOf(REQ_TYPES, c.type))}
                        {field('Priority', r && labelOf(PRIORITIES, r.priority), c.priority && labelOf(PRIORITIES, c.priority))}
                        {field('Verified by', r && labelOf(METHODS, r.verify.method), c.method && labelOf(METHODS, c.method))}
                        {field('Status', r && labelOf(STATUSES, r.status), c.status && labelOf(STATUSES, c.status))}
                        {field('Parent', r?.parent ?? 'none', c.parent)}
                        {c.why && <div class="small muted">{c.why}</div>}
                      </div>
                    </label>
                  );
                })}
                {t.added.map((a) => {
                  const kk = keyOf(a);
                  return (
                    <label key={kk} class={`rqa-prop${t.done ? ' off' : ''}`}>
                      <input type="checkbox" disabled={!!t.done} checked={t.ticked.has(kk)} onChange={() => update(k, (x) => { const s = new Set(x.ticked); if (s.has(kk)) s.delete(kk); else s.add(kk); return { ...x, ticked: s }; })} />
                      <div>
                        <div>New {a.parent ? <>under {current(a.parent) ? idLink(a.parent) : <b>{a.parent}</b>}</> : a.section ? <>in {a.section}</> : null}: <b>{a.title}</b> <span class="muted small">({labelOf(REQ_TYPES, a.type)}, {labelOf(PRIORITIES, a.priority)}, {labelOf(METHODS, a.method)})</span></div>
                        <div class="rqa-field"><ins>{a.text}</ins></div>
                        {a.why && <div class="small muted">{a.why}</div>}
                      </div>
                    </label>
                  );
                })}
                <div class="rqa-actions">
                  {t.done ? <span class="small">{t.done}</span> : <>
                    <button class="btn default" disabled={!t.ticked.size} onClick={() => apply(k)}>Apply Ticked ({t.ticked.size})</button>
                    <button class="link small" onClick={() => update(k, (x) => ({ ...x, ticked: x.ticked.size ? new Set() : new Set([...x.changes, ...x.added].map(keyOf)) }))}>{t.ticked.size ? 'Untick all' : 'Tick all'}</button>
                  </>}
                </div>
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      {!info.runs && <p class="small ai-error">{NOT_YET}.</p>}
      <div class="rqa-starters">
        {STARTERS.map(([label, text, needsPick]) => <button key={label} class="btn small" disabled={busy || (needsPick && !picked) || !info.runs} title={needsPick && !picked ? 'Pick a requirement first' : text} onClick={() => void send(text)}>{label}</button>)}
        {turns.length > 0 && <button class="link small" disabled={busy} onClick={() => setTurns([])}>New conversation</button>}
      </div>
      <form class="rqa-input" onSubmit={(e) => { e.preventDefault(); void send(ask); }}>
        <textarea aria-label="Ask the Requirements Adviser" rows={2} placeholder={picked ? `Ask about the requirements, or about ${picked.id} (this one)` : 'Ask about the requirements'} value={ask} disabled={busy}
          onInput={(e) => setAsk((e.target as HTMLTextAreaElement).value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(ask); } }} />
        <button class="btn default" type="submit" disabled={busy || !ask.trim() || !info.runs}>{busy ? 'Asking…' : 'Ask'}</button>
      </form>
    </div>
  );
}
