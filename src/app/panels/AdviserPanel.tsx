import { webLink } from '../../core/webLink';
import { locale } from '../../core/locale';
import { AiOff } from './kv';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { active, activeId, docs, notify, prefsPage, showPrefs, tick } from '../state';
import { settings, updateSettings } from '../../core/settings';
import { activeProject, compileOptions, crossProbe, projectSheets, whenMounted } from '../project';
import { compileProject, natural, type ObjRef, type SheetInput } from '../../model/compile';
import type { SchDocument } from '../../model/sch';
import { ADVISE, ASK, BOARD, PART, SEVERITIES, type Advice, type Answered, type Finding, type PartChecked, type Picture, type Severity } from '../../ai/jobs';
import { adviceText, aroundOf, datasheetUrlOf, designDigest, findingRefs, mpnOf, wantsDatasheet, type DesignDigest, type PartInfo } from '../../ai/advise';
import { boardDigest, type BoardDigest } from '../../ai/boardAdvise';
import { NO_NET, copperNet, type PcbDocument } from '../../model/pcb';
import { PcbEditor, primKey } from '../../editors/pcb/PcbEditor';
import { canSearch, findSheet, keepSheet, keptSheet, matchFile, normMpn, pagesForCheck, type PartSheet } from '../../ai/partSheets';
import { TEXT_BUDGET, openDatasheet } from '../../ai/datasheet';
import { followSuccessors, shownId } from '../../ai/models';
import { allowanceNote, 
  AiError, NOT_YET, destination, estimateCost, estimateTokens, listModels, modelFor, money, runJob, serviceConfig, serviceRuns, withModel,
  type ModelInfo, type ServiceConfig, type Usage,
} from '../../ai/client';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from '../dialogs';

/**
 * Design Adviser (Tools › Design Adviser): the project, or the sheet in front, reviewed by the model
 * chosen as an experienced engineer would before layout. In depth (the default): each part worth
 * it (ICs, transistors, crystals, regulators …) checked against its own datasheet first — the
 * designer's file, the address its parameters give, else found on the web — pin by pin: what each
 * pin is joined to, the parts the datasheet asks for and their values, the rails against its
 * ratings; then the design as a whole with what the datasheets said. Only the design's parts, pins
 * and nets go (no drawings or positions), and what goes where, with its cost, is said first. Each
 * finding names its parts and nets (a click shows them on the sheet) and the datasheet pages it
 * rests on (a click shows the page); Dismiss keeps it out of later checks; Ask asks about the
 * design and the review. The last check stays while the panel is closed.
 */

type Scope = 'project' | 'sheet' | 'board';
/** A finding, with the datasheet it rests on (its part number) when a part's check found it. */
type Shown = Finding & { sheet?: string };
/** A part (or several of one part number) checked against its datasheet. */
interface PartRun {
  key: string; mpn: string; designators: string[]; info: PartInfo;
  state: 'waiting' | 'working' | 'done' | 'error' | 'skipped'; step?: string; error?: string;
  sheet?: { source: PartSheet['source']; where: string; pageCount: number }; checked?: PartChecked; sent?: number[];
}
interface Done { text: string; ms: number }
interface Run {
  key: string; name: string; at: number; projectId: string | null; deep: boolean; focus: string;
  /** A board's review: the board as written, and the document it is in. */
  board?: BoardDigest; boardDoc?: string;
  state: 'checking' | 'done' | 'error'; step: string; since: number; done: Done[]; error?: string;
  digest: DesignDigest; model: string; parts: PartRun[];
  advice?: Advice; findings: Shown[]; facts: string; usage: { in: number; out: number; cost: number }; asks: { q: string; a?: Answered; error?: string }[];
}
const lastRun = signal<Run | null>(null);
/** What the parts' datasheets said in a project's last check in depth (its board's review uses it). */
const factsBy = new Map<string, string>();
/** Datasheets the designer gave (by file), until matched to a part. */
const given = signal<{ name: string; bytes: Uint8Array }[]>([]);

/* Findings dismissed, per design (this browser's own: a convenience, not a record) */
const DISMISSED = 'konium.adviser.dismissed:';
function loadDismissed(key: string): string[] {
  try { const v = JSON.parse(globalThis.localStorage?.getItem(DISMISSED + key) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}
function saveDismissed(key: string, list: string[]): void {
  try { globalThis.localStorage?.setItem(DISMISSED + key, JSON.stringify(list.slice(-200))); } catch { /* kept for this session only */ }
}
const dismissedTick = signal(0);

const ICON: Record<Severity, string> = { error: '✖', warning: '⚠', suggestion: 'ℹ' };
const WORD: Record<Severity, [string, string]> = { error: ['error', 'errors'], warning: ['warning', 'warnings'], suggestion: ['suggestion', 'suggestions'] };
const took = (ms: number) => { const t = Math.max(0, Math.round(ms / 1000)); return t < 60 ? `${t} s` : `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, '0')} s`; };
/** What a check's answers usually come to (tokens), the design's and each part's [est]. */
const TYPICAL_OUT = 6000, PART_OUT = 3000;
/** A part's datasheet pages sent (characters), by where the model is; parts checked at once. */
const PART_BUDGET = { konium: 36_000, key: 36_000, local: 10_000 } as const;
const AT_ONCE = 3;
/** A picture of a datasheet page for a model (its longer side, px). */
const PAGE_PX = 1400;

/** The models to choose from, with their prices (own key: OpenRouter's; the service: its own; a local server's). */
function useModels(mode: typeof settings.aiMode) {
  const [models, setModels] = useState<{ list: ModelInfo[]; defaults: ServiceConfig['defaults']; jobs?: ServiceConfig['jobs']; allowance?: ServiceConfig['allowance']; loaded?: boolean }>({ list: [], defaults: {} });
  useEffect(() => {
    if (mode === 'off') return;
    let live = true;
    (mode === 'konium' ? serviceConfig().then((c) => ({ list: c.models, defaults: c.defaults, jobs: c.jobs, allowance: c.allowance, loaded: true })) : listModels(mode).then((list) => ({ list, defaults: {} })))
      .then((m) => {
        if (!live) return;
        setModels(m);
        const moved = followSuccessors(settings.aiModels, mode, m.list, mode === 'konium');
        if (moved) updateSettings({ aiModels: moved });
      }).catch(() => { /* no estimate */ });
    return () => { live = false; };
  }, [mode]);
  return [models, setModels] as const;
}

/** What is checked: the board in front; else the project in front (every sheet), or the sheet in front alone. */
function targetOf(scope: Scope) {
  const p = activeProject();
  const d = active.value;
  if (d?.doc.kind === 'PcbDoc') return { key: `b:${d.name}`, name: d.name, project: p, sheets: (): SheetInput[] => projectSheets(p).filter((x) => /\.schdoc$/i.test(x.name)), scope: 'board' as Scope, board: d.doc as PcbDocument };
  const sheet = d?.doc.kind === 'SchDoc' ? { name: d.name, doc: d.doc as SchDocument } : null;
  if (scope === 'project' && p) return { key: `p:${p.name}`, name: p.name, project: p, sheets: (): SheetInput[] => projectSheets(p), scope };
  if (sheet) return { key: `s:${sheet.name}`, name: sheet.name, project: p, sheets: (): SheetInput[] => [sheet], scope: 'sheet' as Scope };
  return null;
}
function digestOf(t: NonNullable<ReturnType<typeof targetOf>>): DesignDigest | null {
  const sheets = t.project || t.scope !== 'board' ? t.sheets() : [];
  if (!sheets.length) return null;
  return designDigest(t.scope === 'board' && t.project ? t.project.name : t.name, sheets, compileProject(sheets, compileOptions(t.project)), t.scope === 'sheet' && !!t.project ? 'sheet' : 'project');
}
/** A board as written, its supply pins told by its schematic's pin types when the project has one. */
function boardOf(doc: PcbDocument, d: DesignDigest | null): BoardDigest {
  const pinTypes = new Map<string, number>();
  for (const p of d?.list ?? []) for (const pin of p.pins) pinTypes.set(`${p.designator}-${pin.number}`.toUpperCase(), pin.electrical);
  return boardDigest(doc, pinTypes.size ? { pinTypes } : {});
}

const sheetless = { roots: [] } as unknown as import('../../model/schHierarchy').Hierarchy;
const mmUnits = (v: number) => Math.round(v * 393_700.787);

/** The parts worth their datasheets, one entry for each part number (its designators together). */
function partsToCheck(d: DesignDigest): PartRun[] {
  const by = new Map<string, PartRun>();
  for (const p of d.list) {
    if (!wantsDatasheet(p)) continue;
    const mpn = mpnOf(p);
    const key = mpn ? normMpn(mpn) : `#${p.designator}`;
    const had = by.get(key);
    if (had) had.designators.push(p.designator);
    else by.set(key, { key, mpn, designators: [p.designator], info: p, state: mpn ? 'waiting' : 'skipped', ...(mpn ? {} : { error: 'No part number: give it a Manufacturer Part Number parameter, or add its datasheet' }) });
  }
  return [...by.values()].sort((a, b) => natural(a.designators[0]!, b.designators[0]!));
}

/** A datasheet page, shown as the model saw it. */
function PageDialog({ mpn, page }: { mpn: string; page: number }) {
  const [url, setUrl] = useState('');
  const ps = keptSheet(mpn);
  useEffect(() => { if (ps) void ps.sheet.picture(page, 1500).then(setUrl).catch(() => setUrl('')); }, [mpn, page]);
  return (
    <Dialog title={`${mpn}: datasheet page ${page}`} width={760} height={900} onClose={closeDialog} class="adv-page"
      footer={<><span class="small muted">{ps ? `${ps.source === 'file' ? 'Your file' : ps.where} · ${ps.sheet.pageCount} pages` : ''}</span><span class="spacer" />
        <button class="btn" disabled={!ps || page <= 1} onClick={() => { closeDialog(); showDialog(PageDialog, { mpn, page: page - 1 }); }}>Previous</button>
        <button class="btn" disabled={!ps || page >= (ps?.sheet.pageCount ?? 0)} onClick={() => { closeDialog(); showDialog(PageDialog, { mpn, page: page + 1 }); }}>Next</button>
        <button class="btn" onClick={closeDialog}>Close</button></>}>
      {ps ? url ? <img class="adv-page-img" src={url} alt={`${mpn} datasheet page ${page}`} /> : <p class="muted">Drawing the page…</p> : <p class="muted">The datasheet is no longer open: check the design again.</p>}
    </Dialog>
  );
}

export function AdviserPanel() {
  const mode = settings.aiMode;
  const [scope, setScope] = useState<Scope>('project');
  const [focus, setFocus] = useState('');
  const [deep, setDeep] = useState(true);
  const [hidden, setHidden] = useState<Set<Severity>>(new Set());
  const [showDismissed, setShowDismissed] = useState(false);
  const [question, setQuestion] = useState('');
  const [chosen, setChosen] = useState(() => modelFor(mode));
  const [models, setModels] = useModels(mode);
  const [, setTick] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const rowFile = useRef<{ key: string } | null>(null);
  const run = lastRun.value;
  const checking = run?.state === 'checking' || !!run?.parts.some((p) => p.state === 'working') || !!run?.asks.some((a) => !a.a && !a.error);
  useEffect(() => {
    if (!checking) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [checking]);
  void dismissedTick.value; void given.value;
  const t = targetOf(scope);
  const p = activeProject();
  // The design's text for the estimate (written again for each check)
  const digest = useMemo(() => (t && mode !== 'off' ? digestOf(t) : null), [t?.key, run?.at, mode]);
  const board = useMemo(() => (t?.board && mode !== 'off' ? boardOf(t.board, digest) : null), [t?.key, run?.at, mode, digest]);
  const planned = useMemo(() => (digest && !board ? partsToCheck(digest) : []), [digest, board]);

  if (mode === 'off') {
    return (
      <section class="panel docked adviser" aria-label="Design Adviser">
        <AiOff sends="Nothing is sent anywhere until you start a check, and the panel says what it will send first." onOpen={() => { prefsPage.value = 'sys-ai'; showPrefs.value = true; }} />
      </section>
    );
  }

  const defaultId = models.defaults.model || models.defaults.vision;
  const nameOf = (id: string | undefined) => (id ? models.list.find((m) => m.id === id)?.name ?? shownId(id) : '');
  const info = models.list.find((m) => m.id === (chosen || defaultId));
  const runs = mode !== 'konium' || !models.loaded || serviceRuns(models, t?.scope === 'board' ? 'board' : 'advise');
  const deepRuns = mode !== 'konium' || !models.loaded || (serviceRuns(models, 'part') && serviceRuns(models, 'datasheet'));
  const inDepth = deep && deepRuns && !board;
  // A board: what its schematic's check in depth learnt from the datasheets, and its schematic when there's room
  const factsKey = p?.id ?? t?.key ?? '';
  const boardFacts = board ? factsBy.get(factsKey) ?? '' : '';
  const withDesign = board && digest && board.text.length + digest.text.length + boardFacts.length <= TEXT_BUDGET[mode] ? digest : null;
  const sees = mode !== 'local' && info?.vision !== false;
  const budget = TEXT_BUDGET[mode];
  const tokens = board ? estimateTokens(BOARD.messages({ board: board.text, design: withDesign?.text ?? '', facts: boardFacts, focus, dismissed: [] }))
    : digest ? estimateTokens(ADVISE.messages({ design: digest.text, focus, dismissed: [] })) : 0;
  const checkable = planned.filter((x) => x.mpn);
  const perPart = Math.round(PART_BUDGET[mode] / 4) + 2500 + (sees ? 3000 : 0);
  const partTokens = inDepth ? checkable.length * perPart : 0;
  const searches = inDepth ? checkable.filter((x) => !keptSheet(x.mpn) && !datasheetUrlOf(x.info)).length : 0;
  const tooBig = board ? board.text.length > budget : !!digest && digest.text.length > budget;
  const cost = () => {
    if (mode === 'local') return 'Free: it runs on your model.';
    if (mode !== 'konium') {
      const c = estimateCost(tokens + partTokens, TYPICAL_OUT + (inDepth ? checkable.length * PART_OUT : 0), info);
      return `Estimated cost: ${money(c === null ? null : c + searches * 0.007)}${searches ? ` (with ${searches} web search${searches === 1 ? '' : 'es'} at about $0.007 each)` : ''}.`;
    }
    return `${allowanceNote(models.allowance, info)}${inDepth && checkable.length ? `, and up to ${checkable.length * 2} small ones (finding each datasheet and checking each part), five times as many allowed` : ''}.`;
  };

  const set = (patch: Partial<Run>) => { if (lastRun.value) lastRun.value = { ...lastRun.value, ...patch }; };
  const setPart = (key: string, patch: Partial<PartRun>) => { const r = lastRun.value; if (r) lastRun.value = { ...r, parts: r.parts.map((x) => (x.key === key ? { ...x, ...patch } : x)) }; };
  const addUsage = (u: Usage) => { const r = lastRun.value; if (r) lastRun.value = { ...r, usage: { in: r.usage.in + u.in, out: r.usage.out + u.out, cost: r.usage.cost + (u.cost ?? 0) } }; };

  /** The datasheets given as files: each matched to its part number (by its name, else its first page). */
  const matchGiven = async (parts: PartRun[]) => {
    const mpns = parts.filter((x) => x.mpn).map((x) => x.mpn);
    const left: typeof given.value = [];
    for (const f of given.value) {
      try {
        const d = await openDatasheet(f.bytes, f.name);
        const first = `${await d.text(1)} ${d.pageCount > 1 ? await d.text(2) : ''}`;
        d.close();
        const m = matchFile(f.name, first, mpns);
        if (m) await keepSheet(f.bytes, f.name, m, 'file', f.name); else left.push(f);
      } catch { left.push(f); }
    }
    given.value = left;
  };

  /** A part checked against its datasheet (found first). */
  const checkPart = async (pr: PartRun, digestNow: DesignDigest, focusNow: string) => {
    const step = (s: string) => setPart(pr.key, { state: 'working', step: s });
    try {
      const ps = await findSheet(pr.mpn, { url: datasheetUrlOf(pr.info), maker: pr.info.params.Manufacturer ?? '', description: pr.info.description || pr.info.value, onStep: step });
      setPart(pr.key, { sheet: { source: ps.source, where: ps.where, pageCount: ps.sheet.pageCount } });
      const pick = pagesForCheck(ps.pages, PART_BUDGET[mode]);
      const pictures: Picture[] = [];
      if (sees) for (const n of pick.circuit) { try { pictures.push({ page: n, url: await ps.sheet.picture(n, PAGE_PX, 'image/jpeg'), label: 'the datasheet\'s application circuit' }); } catch { /* text only */ } }
      step(`checking ${pr.designators.join(', ')} against pages ${pick.pages.map((x) => x.page).join(', ')}`);
      const others = pr.designators.slice(1, 6).map((d) => digestNow.list.find((x) => x.designator === d)).filter((x): x is PartInfo => !!x);
      const part = [pr.info.block, ...others.map((o) => o.block)].join('\n') + (pr.designators.length > 1 ? `\n(${pr.designators.join(', ')}: the same part; check each)` : '');
      const around = [pr.info, ...others].map((x) => `${x.designator}:\n${aroundOf(x, digestNow)}`).join('\n\n');
      const r = await runJob(PART, { part, around, datasheet: { source: ps.where, pageCount: ps.sheet.pageCount, pages: pick.pages }, pictures, focus: focusNow });
      addUsage(r.usage);
      setPart(pr.key, { state: 'done', step: undefined, checked: r.value, sent: pick.pages.map((x) => x.page) });
      return r.value;
    } catch (e) {
      setPart(pr.key, { state: 'error', step: undefined, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };

  /** What the parts' checks found, and what their datasheets ask, for the design-wide check. */
  const partFindings = (r: Run): Shown[] => r.parts.flatMap((x) => (x.checked?.findings ?? []).map((f) => ({ ...f, sheet: x.mpn })));
  const factsOf = (r: Run) => r.parts.filter((x) => x.checked?.facts).map((x) => `${x.designators.join(', ')} (${x.mpn}${x.sheet ? `; datasheet ${x.sheet.source === 'file' ? 'given by the designer' : x.sheet.where}` : ''}): ${x.checked!.facts}`).join('\n');
  const merge = (r: Run, design: Finding[]): Shown[] => [...partFindings(r), ...design].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));

  /** A board's review: its layout and measurements, its schematic when there's room, what the datasheets said. */
  const checkBoard = async (bt: NonNullable<typeof t> & { board: PcbDocument }) => {
    const d = digestOf(bt);
    const bd = boardOf(bt.board, d);
    const facts = factsBy.get(factsKey) ?? '';
    const design = d && bd.text.length + d.text.length + facts.length <= TEXT_BUDGET[mode] ? d.text : '';
    const who = nameOf(chosen || defaultId);
    lastRun.value = { key: bt.key, name: bt.name, at: Date.now(), projectId: p?.id ?? null, deep: false, focus: focus.trim(), state: 'checking', step: `Checking ${bt.name}${who ? ` with ${who}` : ''}…`, since: Date.now(), done: [],
      digest: d ?? designDigest(bt.name, [], { components: [], nets: [], messages: [], scope: 'flat', hierarchy: sheetless }), board: bd, boardDoc: bt.name, model: who, parts: [], findings: [], facts, usage: { in: 0, out: 0, cost: 0 }, asks: [] };
    try {
      const res = await runJob(BOARD, { board: bd.text, design, facts, focus: focus.trim(), dismissed: loadDismissed(bt.key) });
      addUsage(res.usage);
      const r = lastRun.value!;
      set({ state: 'done', step: '', advice: res.value, findings: res.value.findings, model: nameOf(res.model) || who,
        done: [...r.done, { text: `Checked the board${design ? ' with its schematic' : ''}${facts ? ' and what its parts\' datasheets say' : ''}: ${res.value.findings.length} finding${res.value.findings.length === 1 ? '' : 's'}`, ms: Date.now() - r.since }] });
      if (mode === 'konium') void serviceConfig().then((c) => setModels((m) => ({ ...m, allowance: c.allowance }))).catch(() => { /* as it was */ });
    } catch (e) {
      set({ state: 'error', step: '', error: e instanceof AiError || e instanceof Error ? e.message : String(e) });
    }
  };

  const check = async () => {
    if (!t) return;
    if (t.board) { await checkBoard(t as NonNullable<typeof t> & { board: PcbDocument }); return; }
    const d = digestOf(t);
    if (!d) { notify('Nothing to check: open a schematic', 'error'); return; }
    const who = nameOf(chosen || defaultId);
    const focusNow = focus.trim();
    const parts = inDepth ? partsToCheck(d) : [];
    lastRun.value = { key: t.key, name: t.name, at: Date.now(), projectId: p?.id ?? null, deep: inDepth, focus: focusNow, state: 'checking', step: '', since: Date.now(), done: [],
      digest: d, model: who, parts, findings: [], facts: '', usage: { in: 0, out: 0, cost: 0 }, asks: [] };
    const step = (text: string) => set({ step: text, since: Date.now() });
    const finish = (text: string) => { const r = lastRun.value; if (r) set({ done: [...r.done, { text, ms: Date.now() - r.since }] }); };
    try {
      const queue = parts.filter((x) => x.mpn);
      if (queue.length) {
        if (given.value.length) await matchGiven(parts);
        step(`Checking ${queue.length} part${queue.length === 1 ? '' : 's'} against ${queue.length === 1 ? 'its datasheet' : 'their datasheets'}${who ? ` with ${who}` : ''}…`);
        // A few at a time
        await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, async () => { for (let x = queue.shift(); x; x = queue.shift()) await checkPart(x, d, focusNow); }));
        const r = lastRun.value!;
        const ok = r.parts.filter((x) => x.state === 'done');
        const n = partFindings(r).length;
        finish(`Checked ${ok.length} of ${r.parts.length} part${r.parts.length === 1 ? '' : 's'} against ${r.parts.length === 1 ? 'its datasheet' : 'their datasheets'}: ${n} finding${n === 1 ? '' : 's'}${r.parts.length > ok.length ? `; ${r.parts.length - ok.length} without one (Add PDF… below)` : ''}`);
      }
      step(`Checking the design as a whole${who ? ` with ${who}` : ''}…`);
      const r0 = lastRun.value!;
      const facts = factsOf(r0);
      const res = await runJob(ADVISE, { design: d.text, focus: focusNow, dismissed: loadDismissed(t.key), facts, known: partFindings(r0).map((f) => f.title) });
      addUsage(res.usage);
      finish(`Checked the design as a whole: ${res.value.findings.length} finding${res.value.findings.length === 1 ? '' : 's'}`);
      const r1 = lastRun.value!;
      set({ state: 'done', step: '', advice: res.value, findings: merge(r1, res.value.findings), facts, model: nameOf(res.model) || who });
      if (facts) factsBy.set(p?.id ?? t.key, facts);
      if (mode === 'konium') void serviceConfig().then((c) => setModels((m) => ({ ...m, allowance: c.allowance }))).catch(() => { /* as it was */ });
    } catch (e) {
      set({ state: 'error', step: '', error: e instanceof AiError || e instanceof Error ? e.message : String(e) });
    }
  };

  /** One part again (a datasheet added for it): its findings replaced. */
  const recheckPart = async (key: string) => {
    const r = lastRun.value;
    const pr = r?.parts.find((x) => x.key === key);
    if (!r || !pr) return;
    setPart(key, { state: 'working', error: undefined, checked: undefined });
    const since = Date.now();
    const got = await checkPart({ ...pr, mpn: pr.mpn || pr.designators[0]! }, r.digest, r.focus);
    const r2 = lastRun.value!;
    const text = got ? `Checked ${pr.designators.join(', ')} against ${keptSheet(pr.mpn || pr.designators[0]!)?.source === 'file' ? 'the datasheet you added' : 'its datasheet'}: ${got.findings.length} finding${got.findings.length === 1 ? '' : 's'}`
      : `${pr.designators.join(', ')} couldn't be checked`;
    set({ done: [...r2.done, { text, ms: Date.now() - since }], ...(r2.advice ? { findings: merge(r2, r2.advice.findings), facts: factsOf(r2) } : {}) });
    if (factsOf(r2)) factsBy.set(r2.projectId ?? r2.key, factsOf(r2));
  };
  const addFiles = async (files: FileList | null, forKey?: string) => {
    if (!files?.length) return;
    const list = await Promise.all([...files].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    const pr = forKey ? lastRun.value?.parts.find((x) => x.key === forKey) : undefined;
    if (pr) {
      const mpn = pr.mpn || pr.designators[0]!;
      try { await keepSheet(list[0]!.bytes, list[0]!.name, mpn, 'file', list[0]!.name); } catch (e) { notify((e as Error).message, 'error'); return; }
      if (!pr.mpn) setPart(pr.key, { mpn });
      void recheckPart(pr.key);
      return;
    }
    given.value = [...given.value, ...list];
    notify(`${list.length} datasheet${list.length === 1 ? '' : 's'} added: used for the parts they name at the next check`);
  };

  const ask = async () => {
    const r = lastRun.value;
    const q = question.trim();
    if (!r || !q || !r.advice) return;
    setQuestion('');
    const at = r.asks.length;
    set({ asks: [...r.asks, { q }] });
    const put = (patch: { a?: Answered; error?: string }) => { const x = lastRun.value; if (x) lastRun.value = { ...x, asks: x.asks.map((y, i) => (i === at ? { ...y, ...patch } : y)) }; };
    try {
      const res = await runJob(ASK, { design: r.board ? `${r.board.text}${r.digest.list.length ? `\n\nIts schematic:\n${r.digest.text}` : ''}` : r.digest.text, facts: r.facts, review: adviceText(r.name, { summary: r.advice.summary, findings: r.findings }), history: r.asks.filter((y) => y.a).map((y) => ({ q: y.q, a: y.a!.answer })), question: q });
      addUsage(res.usage);
      put({ a: res.value });
    } catch (e) { put({ error: e instanceof Error ? e.message : String(e) }); }
  };

  const choose = (id: string) => { updateSettings({ aiModels: withModel(settings.aiModels, mode, id) }); setChosen(id); };
  const per = (n: number) => (n < 0.1 ? n.toFixed(3) : n < 10 ? n.toFixed(2) : n.toFixed(0));
  const priced = (m: ModelInfo) => `${m.name}${m.priceIn !== undefined && m.priceOut !== undefined ? ` — $${per(m.priceIn)} / $${per(m.priceOut)}` : ''}`;

  const done = run?.state === 'done' ? run : null;
  const dismissed = run ? loadDismissed(run.key).map((x) => x.toLowerCase()) : [];
  const isGone = (f: Finding) => dismissed.includes(f.title.toLowerCase());
  const shown = done ? done.findings.filter((f) => !hidden.has(f.severity) && (showDismissed || !isGone(f))) : [];
  const counts = (s: Severity) => done?.findings.filter((f) => f.severity === s && !isGone(f)).length ?? 0;
  const gone = done?.findings.filter(isGone).length ?? 0;
  const project = run?.projectId ? activeProject() : null;
  const probe = (refs: ObjRef[]) => { if (refs.length) crossProbe(refs, project); else notify('Not found in the design', 'error'); };
  /** A board's components and nets, selected and shown on it. */
  const probeBoard = (r: Run, parts: string[], nets: string[]) => {
    const od = docs.value.find((d) => d.name === r.boardDoc && d.editor instanceof PcbEditor);
    if (!od || !r.board) { notify(`${r.boardDoc ?? 'The board'} isn't open`, 'error'); return; }
    const ed = od.editor as PcbEditor;
    const keys = new Set<string>();
    for (const d of parts) { const i = r.board.compIndex.get(d.toUpperCase()); if (i !== undefined) for (const k of ed.componentKeys(i)) keys.add(k); }
    const want = new Set(nets.map((n) => r.board!.netIndex.get(n.toUpperCase())).filter((n): n is number => n !== undefined));
    if (want.size) for (const q of ed.doc.prims) { const n = copperNet(ed.doc, q); if (n !== NO_NET && want.has(n)) keys.add(primKey(q)); }
    if (!keys.size) { notify('Not found on the board', 'error'); return; }
    activeId.value = od.id;
    whenMounted(ed, () => { ed.selection = keys; ed.invalidateOverlay(); ed.jumpToSelection(mmUnits(6)); tick.value++; });
  };
  /** Whether a part or a net is in what was checked (the board's, or the design's). */
  const known = (r: Run, label: string, net: boolean) => (r.board ? (net ? r.board.netIndex : r.board.compIndex).has(label.toUpperCase()) : ((net ? r.digest.netRefs : r.digest.partRefs).get(label.toUpperCase()) ?? []).length > 0);
  const show = (parts: string[], nets: string[]) => {
    if (!run) return;
    if (run.board) probeBoard(run, parts, nets);
    else probe(findingRefs({ parts, nets }, run.digest));
  };
  const dismiss = (f: Finding, back = false) => {
    if (!run) return;
    const list = loadDismissed(run.key).filter((x) => x.toLowerCase() !== f.title.toLowerCase());
    saveDismissed(run.key, back ? list : [...list, f.title]);
    dismissedTick.value++;
  };
  const copy = async () => {
    if (!done?.advice) return;
    try { await navigator.clipboard.writeText(adviceText(done.name, { summary: done.advice.summary, findings: done.findings })); notify('The review copied'); } catch { notify('Couldn\'t copy: the browser didn\'t allow it', 'error'); }
  };
  const chips = (parts: string[], nets: string[]) => {
    if (!run || (!parts.length && !nets.length)) return null;
    const ref = (label: string, net: boolean) => (known(run, label, net)
      ? <a key={label} href="#" onClick={(e) => { e.preventDefault(); show(net ? [] : [label], net ? [label] : []); }}>{label}</a>
      : <span key={label} class="muted" title={run.board ? 'Not on the board' : 'Not in the design'}>{label}</span>);
    return <div class="adv-refs small">{parts.map((d) => ref(d, false))}{nets.map((n) => ref(n, true))}</div>;
  };
  const pageLinks = (f: Shown) => (f.sheet && f.pages?.length && keptSheet(f.sheet)
    ? <span class="small">Datasheet {f.pages.map((n, i) => <span key={n}>{i ? ', ' : ''}<a href="#" onClick={(e) => { e.preventDefault(); showDialog(PageDialog, { mpn: f.sheet!, page: n }); }}>p. {n}</a></span>)}</span> : null);
  const partState = (x: PartRun) => {
    if (x.state === 'working') return <span class="muted">{x.step ?? 'working'}…</span>;
    if (x.state === 'waiting') return <span class="muted">waiting</span>;
    if (x.state === 'done') return <span>{x.checked!.findings.length} finding{x.checked!.findings.length === 1 ? '' : 's'}</span>;
    return <span class={x.state === 'error' ? 'ai-error' : 'muted'}>{x.error}</span>;
  };

  return (
    <section class="panel docked adviser" aria-label="Design Adviser"
      onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void addFiles(e.dataTransfer?.files ?? null); }}>
      <div class="adv-form">
        <label for="adv-scope">Check</label>
        <select id="adv-scope" aria-label="What to check" value={t?.scope ?? scope} disabled={checking} onChange={(e) => setScope((e.target as HTMLSelectElement).value as Scope)}>
          {t?.scope === 'board' && <option value="board">This board: {t.name}</option>}
          {p && t?.scope !== 'board' && <option value="project">The project: {p.name}</option>}
          {active.value?.doc.kind === 'SchDoc' && <option value="sheet">This sheet: {active.value.name}</option>}
        </select>
        <label for="adv-model">Model</label>
        <select id="adv-model" aria-label="Model" value={chosen} disabled={checking} title={checking ? 'Locked while a check is under way' : undefined} onChange={(e) => choose((e.target as HTMLSelectElement).value)}>
          <option value="">{mode === 'konium' ? `Default${defaultId ? ` (${nameOf(defaultId)})` : ''}` : '(choose one)'}</option>
          {chosen && !models.list.some((m) => m.id === chosen) && <option value={chosen}>{nameOf(chosen)}</option>}
          {models.list.map((m) => <option key={m.id} value={m.id}>{priced(m)}</option>)}
        </select>
        <label for="adv-focus">Look at</label>
        <input id="adv-focus" type="text" placeholder="anything in particular? (optional)" value={focus} disabled={checking} onInput={(e) => setFocus((e.target as HTMLInputElement).value)} />
      </div>
      {!board && <label class="small do-check" title={deepRuns ? 'Each IC, transistor, crystal … checked against its own datasheet first, pin by pin' : NOT_YET}>
        <input type="checkbox" checked={inDepth} disabled={checking || !deepRuns} onChange={(e) => setDeep((e.target as HTMLInputElement).checked)} />In depth: check each part against its datasheet
      </label>}
      {board && t && (
        <div class="adv-send">
          <p class="small">Sends the board's {board.parts} components (footprint, side, place), its nets' routing and what was measured here — decoupling distances, crystals, unrouted connections, pairs, parts by the edge, exposed pads — as text{withDesign ? `, with its schematic's ${withDesign.parts} parts and their nets` : ''}{boardFacts ? ', and what its parts\' datasheets said in the last check in depth' : ''} (no copper shapes), about {tokens.toLocaleString(locale())} tokens, to {destination()}{mode === 'konium' ? ', which passes it to the model and keeps nothing' : ''}.</p>
          {!boardFacts && digest && <p class="small muted">Check its schematic in depth first and the board's review uses what the parts' datasheets say about layout.</p>}
          <p class="small muted">{cost()}</p>
          {tooBig && <p class="small ai-error">Too large to send in one go.</p>}
          <div class="adv-go">
            {runs ? <button class="btn default" disabled={checking || tooBig || (mode !== 'konium' && !modelFor(mode))} onClick={() => void check()}>Check Board</button> : <p class="small ai-error">{NOT_YET}.</p>}
            {mode !== 'konium' && !modelFor(mode) && <span class="small ai-error">Choose a model first.</span>}
          </div>
        </div>
      )}
      {board ? null : !t || !digest ? <p class="small muted">Open a schematic (or a project with schematics) to check it.</p> : (
        <div class="adv-send">
          <p class="small">Sends the design's {digest.parts} parts, their {digest.pins} pins and {digest.nets} nets as text — no drawings, no positions — about {tokens.toLocaleString(locale())} tokens, to {destination()}{mode === 'konium' ? ', which passes it to the model and keeps nothing' : ''}.</p>
          {inDepth && (checkable.length
            ? <p class="small">First checks {checkable.length === 1 ? 'its part' : `each of its ${checkable.length} parts`} with a part number ({checkable.slice(0, 8).map((x) => x.designators[0]).join(', ')}{checkable.length > 8 ? ' …' : ''}) against its datasheet, read here: a file you add, the link in its parameters, else found on the web{canSearch() ? '' : ' (not with this model: add the files)'}; datasheets are fetched through konium.app. About {partTokens.toLocaleString(locale())} tokens more.</p>
            : <p class="small muted">No parts with part numbers to check against datasheets.</p>)}
          <p class="small muted">{cost()}</p>
          {tooBig && <p class="small ai-error">Too large to send in one go ({digest.text.length.toLocaleString(locale())} characters, {budget.toLocaleString(locale())} at most): check one sheet at a time.</p>}
          <div class="adv-go">
            {runs ? <button class="btn default" disabled={checking || tooBig || (mode !== 'konium' && !modelFor(mode))} onClick={() => void check()}>Check Design</button> : <p class="small ai-error">{NOT_YET}.</p>}
            {inDepth && <button class="btn" disabled={checking} title="Datasheets (PDF) of the parts: each used for the part it names" onClick={() => { rowFile.current = null; fileRef.current?.click(); }}>Add Datasheets...</button>}
            {given.value.length > 0 && <span class="small muted">{given.value.length} added</span>}
            {mode !== 'konium' && !modelFor(mode) && <span class="small ai-error">Choose a model first.</span>}
          </div>
          <input ref={fileRef} type="file" accept=".pdf,application/pdf" multiple style={{ display: 'none' }}
            onChange={(e) => { const el = e.target as HTMLInputElement; void addFiles(el.files, rowFile.current?.key); el.value = ''; }} />
        </div>
      )}
      {run && (
        <div class="adv-result">
          {run.done.length > 0 && <ol class="ai-steps small">{run.done.map((x, i) => <li key={i}>✓ {x.text} <span class="muted">{took(x.ms)}</span></li>)}</ol>}
          {run.state === 'checking' && <p class="ai-busy small">{run.step || `Checking ${run.name}…`} <span class="muted">{took(Date.now() - run.since)}</span></p>}
          {run.state === 'error' && <p class="ai-error small">{run.error}</p>}
          {run.parts.length > 0 && (
            <details class="adv-parts small" open={run.state === 'checking' || run.parts.some((x) => x.state === 'error' || x.state === 'skipped' || x.state === 'working')}>
              <summary>Parts against their datasheets ({run.parts.filter((x) => x.state === 'done').length} of {run.parts.length})</summary>
              <table class="ai-variants">
                <thead><tr><th>Part</th><th>Datasheet</th><th>Found</th></tr></thead>
                <tbody>{run.parts.map((x) => (
                  <tr key={x.key}>
                    <td>{x.designators.join(', ')}{x.mpn && <div class="muted adv-mpn">{x.mpn}</div>}</td>
                    <td>{x.sheet ? (x.sheet.source === 'file' ? 'your file' : webLink(x.sheet.where) ? <a href={webLink(x.sheet.where)} target="_blank" rel="noopener noreferrer">{(() => { try { return new URL(x.sheet.where).host; } catch { return x.sheet.where; } })()}</a> : x.sheet.where) : <span class="muted">—</span>}
                      {x.sent && x.mpn && keptSheet(x.mpn) ? <> · <a href="#" title={`Pages read: ${x.sent.join(', ')}`} onClick={(e) => { e.preventDefault(); showDialog(PageDialog, { mpn: x.mpn, page: x.sent![0]! }); }}>{x.sent.length} pages</a></> : null}</td>
                    <td>{partState(x)}{run.state !== 'checking' && x.state !== 'working' && <div><button class="btn" title="Its datasheet as a PDF file: the part checked again with it" onClick={() => { rowFile.current = { key: x.key }; fileRef.current?.click(); }}>Add PDF...</button></div>}</td>
                  </tr>))}</tbody>
              </table>
            </details>
          )}
          {done?.advice && (
            <>
              <p class="small muted">{done.name}, checked at {new Date(done.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })} by {done.model || 'the model'}{done.key !== t?.key ? ' (another design than the one in front)' : ''}.</p>
              {done.advice.summary && <p class="adv-summary">{done.advice.summary}</p>}
              <div class="adv-filters">
                {SEVERITIES.map((s) => (
                  <label key={s} class={`adv-chip ${s}`}><input type="checkbox" checked={!hidden.has(s)} onChange={() => { const n = new Set(hidden); if (n.has(s)) n.delete(s); else n.add(s); setHidden(n); }} />{ICON[s]} {counts(s)} {WORD[s][counts(s) === 1 ? 0 : 1]}</label>
                ))}
                <span class="spacer" />
                <button class="btn" disabled={!done.findings.length} onClick={() => void copy()}>Copy</button>
              </div>
              {!done.findings.length && <p class="small">Nothing found to change.</p>}
              <ol class="adv-list">
                {shown.map((f) => {
                  const gone1 = isGone(f);
                  const any = f.parts.some((x) => known(done, x, false)) || f.nets.some((x) => known(done, x, true));
                  return (
                    <li key={`${f.sheet ?? ''}:${f.title}`} class={`adv-finding ${f.severity}${gone1 ? ' gone' : ''}`}>
                      <div class="adv-head">
                        <span class="adv-sev" title={WORD[f.severity][0]}>{ICON[f.severity]}</span>
                        <a href="#" class="adv-title" onClick={(e) => { e.preventDefault(); show(f.parts, f.nets); }}>{f.title}</a>
                      </div>
                      {chips(f.parts, f.nets)}
                      {f.detail && <p class="small">{f.detail}</p>}
                      {f.fix && <p class="small"><b>Fix:</b> {f.fix}</p>}
                      <div class="adv-actions">
                        {pageLinks(f)}
                        <span class="spacer" />
                        <button class="btn" disabled={!any} onClick={() => show(f.parts, f.nets)}>Show</button>
                        <button class="btn" title={gone1 ? 'Report it again' : 'Not a problem, or known: not reported again for this design'} onClick={() => dismiss(f, gone1)}>{gone1 ? 'Restore' : 'Dismiss'}</button>
                      </div>
                    </li>
                  );
                })}
              </ol>
              {gone > 0 && <label class="small do-check"><input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed((e.target as HTMLInputElement).checked)} />Show the {gone} dismissed</label>}
              <div class="adv-ask">
                {done.asks.map((x, i) => (
                  <div key={i} class="adv-qa small">
                    <p class="adv-q"><b>{x.q}</b></p>
                    {x.a ? <><p class="adv-a">{x.a.answer}</p>{chips(x.a.parts, x.a.nets)}</> : x.error ? <p class="ai-error">{x.error}</p> : <p class="ai-busy">Thinking…</p>}
                  </div>
                ))}
                <textarea aria-label="Ask about the design" rows={2} placeholder="Ask about the design or the review: why, what value, what else…" value={question} disabled={checking}
                  onInput={(e) => setQuestion((e.target as HTMLTextAreaElement).value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void ask(); }} />
                <div class="adv-go"><span class="spacer" /><button class="btn" disabled={checking || !question.trim() || (mode === 'konium' && models.loaded && !serviceRuns(models, 'ask'))} onClick={() => void ask()}>Ask</button></div>
              </div>
              {done.usage.in > 0 && <p class="small muted">{done.usage.in.toLocaleString(locale())} tokens in, {done.usage.out.toLocaleString(locale())} out{done.usage.cost ? ` · ${money(done.usage.cost)}${mode === 'konium' ? ' (paid by the Konium service, not by you)' : ''}` : ''}. Check what it says against the datasheets.</p>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
