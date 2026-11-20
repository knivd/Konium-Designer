/**
 * A requirements document in its tab: its requirements in one table under their sections (a
 * section is a heading row), each under its parent as a tree, with its identifier, title, type,
 * priority, status and where its verification stands (the columns as wide as last dragged); or
 * the same as a connection graph, with what in the design each is met by. The one picked is shown
 * in full on the right, to edit (its text, its parent, how it is verified, and a note). New
 * requirements take the next identifier in the project: one beside the one picked, under the same
 * parent, or a child under it; a requirement given a parent goes under it. Rows move up and down
 * among those at their level, with what is under them, and every change can be undone.
 */
import { readLocal, writeLocal } from '../core/storage';
import { MAX_FILE, sizeWords, snapshot, unsnapshot, type ReqFile } from '../model/richText';
import { Attachments, Clip, RichTextEditor, attachmentOf } from './RichText';
import { useEffect, useRef, useState } from 'preact/hooks';
import { activeId, docKeys, tick, type OpenDoc } from './state';
import { ColourIcon, Icon } from './icons';
import type { ReqDocument } from '../formats/reqDoc';
import {
  LINK_KINDS, METHODS, PRIORITIES, REQ_TYPES, STATUSES, VERIFY_STATES, afterSubtree, blankReq, cleanPrefix, depthOf, inTreeOrder, isReq, labelOf, loops, matches, moveInTree, nextId, resultOf, sameLink, sectionsOf, stateOf, tally, treeRows,
  type Priority, type ReqRow, type ReqStatus, type ReqType, type Requirement, type Requirements, type VerifyMethod, type VerifyState,
} from '../model/requirements';
import { projectOf, projectReqs, reqHistory } from './requirementsData';
import { probe } from './requirementsLinks';
import { designFacts } from './reqFacts';
import { ReqCheckEditor } from './ReqCheckEditor';
import { showDialog } from './dialogs';
import { ReqImportDialog } from './dialogs/ReqImport';
import { ReqExportDialog } from './dialogs/ReqExport';
import { ReqAiSplitDialog } from './dialogs/ReqAiSplit';
import { openComplianceReport } from './reqTransfer';
import { reqSources } from './requirementsData';
import { ReqGraphView } from './ReqGraphView';
import { ReqAdviser } from './ReqAdviser';
import type { AdviceAdd, AdviceChange } from '../ai/jobs';

/** The width of the requirement picked (beside the table), as last dragged. */
const SIDE_KEY = 'reqSideWidth';
/** The table's columns' widths as last dragged, and whether the table or the graph is shown. */
const COLS_KEY = 'reqColumns', VIEW_KEY = 'reqView', ADV_KEY = 'reqAdviserHeight';
const COLUMNS: { key: string; label: string; cls?: string; w: number; min: number }[] = [
  { key: 'id', label: 'ID', cls: 'rq-id', w: 96, min: 50 }, { key: 'title', label: 'Title', w: 0, min: 80 }, { key: 'type', label: 'Type', cls: 'rq-type', w: 92, min: 50 },
  { key: 'pri', label: 'Priority', cls: 'rq-pri', w: 64, min: 46 }, { key: 'st', label: 'Status', cls: 'rq-st', w: 70, min: 46 }, { key: 'ver', label: 'Verification', cls: 'rq-ver', w: 150, min: 70 },
];
const readCols = (): Record<string, number> => { try { const o = JSON.parse(readLocal(COLS_KEY) ?? '{}') as Record<string, unknown>; return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'number' && v > 0)) as Record<string, number>; } catch { return {}; } };
const typing = () => { const a = document.activeElement as HTMLElement | null; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); };

export function RequirementsView({ od }: { od: OpenDoc }) {
  void tick.value;
  const d = od.doc as ReqDocument;
  const R = d.reqs;
  const [, setRev] = useState(0);
  const [sel, setSel] = useState<number>(() => R.rows.findIndex(isReq));
  const [q, setQ] = useState('');
  const tableRef = useRef<HTMLDivElement>(null);
  /** A row just put in: its title (or heading) to type into, once it's drawn. */
  const focusRow = useRef<number | null>(null);
  const hist = reqHistory(d);
  const begin = () => { hist.undo.push(snapshot(R)); if (hist.undo.length > 300) hist.undo.shift(); hist.redo = []; };
  const changed = () => { d.dirty = true; setRev((r) => r + 1); tick.value++; };
  const restore = (from: string[], to: string[]) => {
    const was = from.pop();
    if (!was) return;
    to.push(snapshot(R));
    const o = unsnapshot<Requirements>(was);
    R.prefix = o.prefix; R.rows = o.rows;
    setSel((s) => Math.min(s, R.rows.length - 1));
    changed();
  };
  /** Every requirement in the project (this document as it is now among them). */
  const all = (): Requirement[] => {
    const others = projectReqs(projectOf(od)).filter((x) => x.source.doc !== d).map((x) => x.req);
    return [...others, ...R.rows.filter(isReq)];
  };
  const byId = new Map(all().map((r) => [r.id, r]));
  const facts = designFacts(projectOf(od));
  const row = R.rows[sel];
  const cur = row && isReq(row) ? row : null;

  /** A row put in where `where` says (in the rows as the tree shows them, which the document takes), and picked. */
  const insert = (r: ReqRow, where: () => number) => {
    begin();
    R.rows = inTreeOrder(R.rows);
    const at = Math.max(0, Math.min(R.rows.length, where()));
    R.rows.splice(at, 0, r);
    focusRow.current = at;
    setSel(at); changed();
  };
  useEffect(() => {
    if (focusRow.current === null) return;
    const el = tableRef.current?.querySelector(`[data-row="${focusRow.current}"] input`) as HTMLInputElement | null;
    focusRow.current = null;
    if (el) { el.focus(); el.select(); }
  });
  /** A requirement beside the one picked (under the same parent, after it and what is under it); after a section picked, its first. */
  const addReq = () => {
    const at = row;
    insert(blankReq(nextId(R.prefix, all()), cur?.parent), () => (cur ? afterSubtree(R.rows, cur) : at ? R.rows.indexOf(at) + 1 : R.rows.length));
  };
  /** A child of the one picked: after it and the children it has already. */
  const addChild = () => {
    if (!cur) return;
    const c = cur;
    insert(blankReq(nextId(R.prefix, all()), c.id), () => afterSubtree(R.rows, c));
  };
  const addSection = () => { const at = row; insert({ kind: 'section', title: 'New section' }, () => (at ? afterSubtree(R.rows, at) : R.rows.length)); };
  /** Rows added by an import or the AI: the first of them picked. */
  const added = (first: number) => { setSel(Math.min(first, R.rows.length - 1)); setRev((r) => r + 1); };
  const remove = () => {
    if (!row) return;
    begin();
    // Its children keep their place, their parent now the one above it (or none)
    if (isReq(row)) for (const x of R.rows) if (isReq(x) && x.parent === row.id) { if (row.parent) x.parent = row.parent; else delete x.parent; }
    R.rows.splice(sel, 1);
    setSel(Math.min(sel, R.rows.length - 1)); changed();
  };
  /** The row picked moved past the one before or after it at its level, with what is under it. */
  const move = (by: -1 | 1) => {
    if (!row) return;
    const m = moveInTree(R.rows, row, by);
    if (!m) return;
    begin();
    R.rows = m;
    setSel(R.rows.indexOf(row)); changed();
  };
  /** A requirement's parent set: the requirement (with what is under it) goes under the parent, after its other children; with none, it stays where it is. */
  const setParent = (r: Requirement, parent: string) => {
    begin();
    if (parent) {
      r.parent = parent;
      R.rows.splice(R.rows.indexOf(r), 1); R.rows.push(r);
    } else delete r.parent;
    R.rows = inTreeOrder(R.rows);
    setSel(R.rows.indexOf(r)); changed();
  };
  /** A requirement's fields changed (one step to undo). */
  const edit = (r: Requirement, patch: Partial<Requirement>) => { begin(); Object.assign(r, patch); changed(); };
  const editVerify = (r: Requirement, patch: Partial<Requirement['verify']>) => { begin(); r.verify = { ...r.verify, ...patch }; changed(); };
  const [fileNote, setFileNote] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState(() => Math.max(280, Number(readLocal(SIDE_KEY)) || 400));
  /** Files attached to a requirement (each kept in the document; too large ones refused). */
  const attach = async (r: Requirement, fs: File[]) => {
    const add: ReqFile[] = [], big: string[] = [];
    for (const f of fs) { const a = await attachmentOf(f, [...(r.files ?? []), ...add].map((x) => x.id)); if (a) add.push(a); else big.push(f.name); }
    setFileNote(big.length ? `Not attached (over ${sizeWords(MAX_FILE)}): ${big.join(', ')}` : '');
    if (!add.length) return;
    begin(); r.files = [...(r.files ?? []), ...add]; changed();
  };

  useEffect(() => {
    docKeys.set(od.id, (key) => {
      if (activeId.value !== od.id) return false;
      if (key === 'Ctrl+Z') { if (typing()) return false; restore(hist.undo, hist.redo); return true; }
      if (key === 'Ctrl+Y' || key === 'Ctrl+Shift+Z') { if (typing()) return false; restore(hist.redo, hist.undo); return true; }
      if (typing()) return false;
      if (key === 'Delete') { remove(); return true; }
      if (key === 'Alt+ArrowUp') { move(-1); return true; }
      if (key === 'Alt+ArrowDown') { move(1); return true; }
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        const order = treeRows(R.rows).map((t) => t.i), k = order.indexOf(sel);
        const to = order[Math.max(0, Math.min(order.length - 1, k + (key === 'ArrowUp' ? -1 : 1)))];
        if (to !== undefined) setSel(to);
        return true;
      }
      if (key === 'Insert') { addReq(); return true; }
      return false;
    });
    return () => docKeys.delete(od.id);
  });

  // The rows as the tree shows them; with a search, those that match, the ones above them and the sections they're in
  const tree = treeRows(R.rows);
  const visible = new Set<number>();
  if (q) {
    const chain: number[] = [];
    let section = -1;
    for (const t of tree) {
      const r = R.rows[t.i]!;
      if (!isReq(r)) { section = t.i; chain.length = 0; continue; }
      chain.length = t.depth; chain.push(t.i);
      if (matches(r, q)) { for (const c of chain) visible.add(c); if (section >= 0) visible.add(section); }
    }
  }
  const shown = (i: number) => !q || visible.has(i);
  // The identifiers' column wide enough for the deepest (unless dragged)
  const [cols, setCols] = useState<Record<string, number>>(readCols);
  const deepest = tree.reduce((m, t) => Math.max(m, t.depth), 0);
  const widthOf = (c: typeof COLUMNS[number]) => cols[c.key] ?? (c.key === 'id' ? Math.min(320, c.w + deepest * 14) : c.w);
  const titleFixed = cols.title !== undefined;
  const [graph, setGraph] = useState(() => readLocal(VIEW_KEY) === 'graph');
  const [adviser, setAdviser] = useState(false);
  const [advH, setAdvH] = useState(() => Math.max(140, Number(readLocal(ADV_KEY)) || 300));
  /** The adviser's proposals ticked, applied in one step: the changes to requirements here, the new ones under their parents (or at the end of their section). */
  const applyAdvice = (changes: AdviceChange[], added: AdviceAdd[]): string => {
    begin();
    const here = new Map(R.rows.filter(isReq).map((r) => [r.id, r]));
    const known = () => [...all()];
    let nc = 0;
    for (const c of changes) {
      const r = here.get(c.id);
      if (!r) continue;
      if (c.title !== undefined) r.title = c.title;
      if (c.text !== undefined) { r.text = c.text; delete r.html; }
      if (c.type) r.type = c.type;
      if (c.priority) r.priority = c.priority;
      if (c.status) r.status = c.status;
      if (c.method) r.verify = { ...r.verify, method: c.method };
      if (c.parent === '') delete r.parent;
      // (given a parent: under it, after its other children)
      else if (c.parent && c.parent !== r.parent && known().some((x) => x.id === c.parent) && !loops(known(), r.id, c.parent)) { r.parent = c.parent; R.rows.splice(R.rows.indexOf(r), 1); R.rows.push(r); }
      nc++;
    }
    const made: Requirement[] = [], ids = new Map<string, string>();
    for (const a of added) {
      const id = nextId(R.prefix, [...known(), ...made]);
      ids.set(a.ref, id);
      made.push({ ...blankReq(id), title: a.title, text: a.text, type: a.type, priority: a.priority, verify: { method: a.method, state: 'open', note: '' } });
    }
    added.forEach((a, k) => {
      const r = made[k]!, p = a.parent ? ids.get(a.parent) ?? a.parent : undefined;
      if (p && [...known(), ...made].some((x) => x.id === p) && !loops([...known(), ...made], r.id, p)) r.parent = p;
    });
    R.rows = inTreeOrder(R.rows);
    for (const [k, r] of made.entries()) {
      // Under its parent (the tree puts it there), else at the end of its section, else after the one picked
      const sec = added[k]!.section?.trim().toLowerCase();
      const at = r.parent ? R.rows.length : (() => {
        const s = sec ? R.rows.findIndex((x) => x.kind === 'section' && x.title.trim().toLowerCase() === sec) : -1;
        if (s < 0) return row ? afterSubtree(R.rows, row) : R.rows.length;
        let e = s + 1;
        while (e < R.rows.length && R.rows[e]!.kind !== 'section') e++;
        return e;
      })();
      R.rows.splice(Math.min(at, R.rows.length), 0, r);
    }
    R.rows = inTreeOrder(R.rows);
    if (cur) setSel(R.rows.indexOf(cur));
    changed();
    const words = [nc ? `${nc} requirement${nc === 1 ? '' : 's'} changed` : '', made.length ? `${made.length} added (${made.length === 1 ? made[0]!.id : `${made[0]!.id} to ${made[made.length - 1]!.id}`})` : ''].filter(Boolean);
    return words.length ? `Applied: ${words.join(', ')}. Ctrl+Z undoes it.` : 'Nothing applied: the requirements it named are no longer here.';
  };
  /** A column's edge dragged: its width (kept for next time); double-click: as it was. */
  const grip = (c: typeof COLUMNS[number]) => (
    <span class="rq-colgrip" role="separator" aria-orientation="vertical" aria-label={`Width of ${c.label}`} title="Drag to widen or narrow; double-click for the width it had"
      onClick={(e) => e.stopPropagation()}
      onDblClick={(e) => { e.stopPropagation(); setCols((o) => { const n = { ...o }; delete n[c.key]; writeLocal(COLS_KEY, JSON.stringify(n)); return n; }); }}
      onPointerDown={(e) => {
        e.preventDefault(); e.stopPropagation();
        const el = e.currentTarget as HTMLElement, th = el.parentElement as HTMLElement;
        const x0 = e.clientX, w0 = th.getBoundingClientRect().width;
        el.setPointerCapture(e.pointerId);
        const mv = (ev: PointerEvent) => setCols((o) => ({ ...o, [c.key]: Math.round(Math.max(c.min, w0 + ev.clientX - x0)) }));
        const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); setCols((o) => { writeLocal(COLS_KEY, JSON.stringify(o)); return o; }); };
        el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
      }} />
  );
  const t = tally(R.rows.filter(isReq), (r) => stateOf(r, facts));
  const tb = (icon: string, title: string, run: () => void, disabled = false) => (
    <button type="button" class="tbtn" title={title} aria-label={title.replace(/ \(.*\)$/, '')} disabled={disabled} onClick={run}>{/^(req|row)/.test(icon) ? <ColourIcon name={icon} /> : <Icon name={icon} />}</button>
  );
  const sel3 = <T extends string>(label: string, list: [T, string][], v: T, on: (v: T) => void) => (
    <select aria-label={label} value={v} onChange={(e) => on((e.target as HTMLSelectElement).value as T)}>{list.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
  );
  const parents = cur ? all().filter((r) => r.id !== cur.id && !loops(all(), cur.id, r.id)) : [];
  const children = cur ? all().filter((r) => r.parent === cur.id) : [];
  const pickId = (id: string) => { const i = R.rows.findIndex((x) => isReq(x) && x.id === id); if (i >= 0) setSel(i); };

  return (
    <div class="reqdoc" aria-label={`Requirements: ${od.name}`}>
      <div class="dd-bar reqdoc-bar" role="toolbar" aria-label="Requirements">
        {tb('reqNew', 'New requirement (Insert)', addReq)}
        {tb('reqChild', 'New requirement under the one picked', addChild, !cur)}
        {tb('reqSection', 'New section', addSection)}
        {tb('reqRemove', 'Delete the row (Delete)', remove, !row)}
        <span class="ex-tsep" />
        {tb('rowUp', 'Move up among those at its level (Alt+Up)', () => move(-1), !row || !moveInTree(R.rows, row, -1))}
        {tb('rowDown', 'Move down among those at its level (Alt+Down)', () => move(1), !row || !moveInTree(R.rows, row, 1))}
        <span class="ex-tsep" />
        {tb('undo', 'Undo (Ctrl+Z)', () => restore(hist.undo, hist.redo), !hist.undo.length)}
        {tb('redo', 'Redo (Ctrl+Y)', () => restore(hist.redo, hist.undo), !hist.redo.length)}
        <span class="ex-tsep" />
        {tb('reqImport', 'Import requirements from Excel or CSV', () => showDialog(ReqImportDialog, { doc: d, existing: all, onDone: added }))}
        {tb('reqAi', 'Split a specification into requirements with AI', () => showDialog(ReqAiSplitDialog, { doc: d, existing: all, onDone: added }))}
        {tb('reqExport', 'Export requirements to Excel, CSV or the compliance report', () => showDialog(ReqExportDialog, { project: projectOf(od), sources: reqSources(projectOf(od)), here: od.name }))}
        {tb('reqReport', 'Compliance report: open it in a new tab', () => openComplianceReport(projectOf(od)), !all().length)}
        <span class="ex-tsep" />
        <button type="button" class={`tbtn${graph ? ' on' : ''}`} aria-pressed={graph} title={graph ? 'Show the table' : 'Connection graph: the requirements under their parents, and what in the design each is met by'} aria-label="Connection graph" onClick={() => setGraph((v) => { writeLocal(VIEW_KEY, v ? 'table' : 'graph'); return !v; })}><ColourIcon name="reqGraph" /></button>
        <button type="button" class={`tbtn${adviser ? ' on' : ''}`} aria-pressed={adviser} title="Requirements Adviser: AI that reviews, rewrites, breaks down and links the requirements with you" aria-label="Requirements Adviser" onClick={() => setAdviser((v) => !v)}><ColourIcon name="reqAdviser" /></button>
        <span class="spacer" />
        <input type="search" class="reqdoc-search" placeholder="Search requirements" aria-label="Search requirements" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      <div class="reqdoc-body" ref={bodyRef} style={{ gridTemplateColumns: `minmax(0, 1fr) 5px ${side}px` }}>
        <div class="reqdoc-main">
        {graph ? (
          <ReqGraphView rows={R.rows} picked={cur?.id ?? null} state={(r) => stateOf(r, facts)} onPick={(i) => setSel(i)} onShow={(l) => probe(l, projectOf(od))} />
        ) : (
        <div class="reqdoc-table" ref={tableRef}>
          <table style={titleFixed ? { width: `${COLUMNS.reduce((n, c) => n + widthOf(c), 0)}px` } : { minWidth: `${COLUMNS.reduce((n, c) => n + (c.key === 'title' ? 120 : widthOf(c)), 0)}px` }}>
            <colgroup>{COLUMNS.map((c) => <col key={c.key} style={c.key === 'title' && !titleFixed ? undefined : { width: `${widthOf(c)}px` }} />)}</colgroup>
            <thead><tr>{COLUMNS.map((c) => <th key={c.key} class={c.cls}>{c.label}{grip(c)}</th>)}</tr></thead>
            <tbody>
              {tree.map(({ i, depth: d }) => {
                const r = R.rows[i]!;
                if (!shown(i)) return null;
                const on = i === sel ? ' on' : '';
                if (r.kind === 'section') {
                  return (
                    <tr key={i} data-row={i} class={`rq-section${on}`} onClick={() => setSel(i)}>
                      <td colSpan={6}><input class="rq-section-title" aria-label="Section title" value={r.title} onFocus={() => setSel(i)} onChange={(e) => { begin(); r.title = (e.target as HTMLInputElement).value; changed(); }} /></td>
                    </tr>
                  );
                }
                // (under a parent in another document: as deep as it is there)
                const depth = d + (d === 0 && r.parent ? depthOf(byId, r) : 0);
                return (
                  <tr key={i} data-row={i} class={`rq-row${on}${r.status === 'obsolete' ? ' obsolete' : ''}`} onClick={() => setSel(i)}>
                    <td class="rq-id" style={{ paddingLeft: `${6 + depth * 12}px` }}>{depth ? <span class="rq-sub" aria-hidden="true">↳</span> : null}{r.id}{r.files?.length ? <Clip files={r.files} /> : null}</td>
                    <td><input class="rq-title" aria-label={`${r.id} title`} placeholder="What is required" value={r.title} onFocus={() => setSel(i)} onChange={(e) => edit(r, { title: (e.target as HTMLInputElement).value })} /></td>
                    <td class="rq-type">{labelOf(REQ_TYPES, r.type)}</td>
                    <td class="rq-pri"><span class={`rq-pill pri-${r.priority}`}>{labelOf(PRIORITIES, r.priority)}</span></td>
                    <td class="rq-st">{labelOf(STATUSES, r.status)}</td>
                    <td class="rq-ver"><span class={`rq-pill ver-${stateOf(r, facts)}`}>{labelOf(VERIFY_STATES, stateOf(r, facts))}</span> {r.check ? <span class={`rq-chk st-${resultOf(r, facts)!.status}`} title={`Checked against the design: ${resultOf(r, facts)!.measured || resultOf(r, facts)!.detail || ''}`}>{resultOf(r, facts)!.status === 'pass' ? '✓' : resultOf(r, facts)!.status === 'fail' ? '✗' : '?'} check</span> : <span class="muted small">{labelOf(METHODS, r.verify.method)}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!R.rows.some(isReq) && <p class="muted reqdoc-empty">No requirements yet: <button class="link" onClick={addReq}>add the first one</button>, or a section to put them under.</p>}
        </div>
        )}
        {adviser && <>
          <div class="reqdoc-hsplit" role="separator" aria-orientation="horizontal" aria-label="Height of the Requirements Adviser" title="Drag to make it taller or shorter"
            onPointerDown={(e) => {
              const el = e.currentTarget as HTMLElement, box = el.parentElement;
              if (!box) return;
              el.setPointerCapture(e.pointerId);
              const mv = (ev: PointerEvent) => { const r = box.getBoundingClientRect(); setAdvH(Math.round(Math.max(140, Math.min(r.height - 120, r.bottom - ev.clientY)))); };
              const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); setAdvH((h) => { writeLocal(ADV_KEY, String(h)); return h; }); };
              el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
            }} />
          <div class="reqdoc-adviser" style={{ height: `${advH}px` }}>
            <ReqAdviser doc={d} picked={cur} current={(id) => byId.get(id)} onPick={pickId} onApply={applyAdvice}
              input={() => {
                const secs = sectionsOf(inTreeOrder(R.rows));
                const ordered = inTreeOrder(R.rows);
                const t = facts.design ? `${facts.design.parts} parts in the schematics` : '';
                const b = facts.board ? `a ${facts.board.layers}-layer board ${Math.round(facts.board.w)} × ${Math.round(facts.board.h)} mm` : '';
                return {
                  reqs: ordered.flatMap((r, k) => (isReq(r) ? [{ id: r.id, ...(r.parent ? { parent: r.parent } : {}), section: secs[k] ?? '', title: r.title, text: r.text, type: r.type, priority: r.priority, status: r.status, method: r.verify.method, ...(r.source ? { source: r.source } : {}) }] : [])),
                  ...(cur ? { picked: cur.id } : {}),
                  ...([t, b].filter(Boolean).length ? { design: `${projectOf(od)?.name ?? od.name}: ${[t, b].filter(Boolean).join(', ')}` } : {}),
                };
              }} />
          </div>
        </>}
        </div>
        <div class="reqdoc-split" role="separator" aria-orientation="vertical" aria-label="Width of the requirement picked" title="Drag to widen or narrow"
          onPointerDown={(e) => {
            const el = e.currentTarget as HTMLElement, body = bodyRef.current;
            if (!body) return;
            el.setPointerCapture(e.pointerId);
            const move = (ev: PointerEvent) => { const r = body.getBoundingClientRect(); setSide(Math.round(Math.max(280, Math.min(r.width - 320, r.right - ev.clientX)))); };
            const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); setSide((w) => { writeLocal(SIDE_KEY, String(w)); return w; }); };
            el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
          }} />
        <aside class="reqdoc-side" aria-label="The requirement picked">
          {cur ? (
            <>
              <div class="rq-head"><span class="rq-head-id">{cur.id}</span>{cur.parent && <span class="muted small"> under <button class="link" onClick={() => pickId(cur.parent!)}>{cur.parent}</button></span>}</div>
              <label class="rq-field">Title<input aria-label="Title" value={cur.title} onChange={(e) => edit(cur, { title: (e.target as HTMLInputElement).value })} /></label>
              <div class="rq-field"><span>Requirement</span>
                <RichTextEditor id={cur.id} text={cur.text} html={cur.html} files={cur.files ?? []} label="Requirement text" placeholder="The requirement in full: what, how much, under what conditions. Paste or drop pictures and tables."
                  onCommit={(v) => { begin(); cur.text = v.text; if (v.html) cur.html = v.html; else delete cur.html; if (v.files.length) cur.files = v.files; else delete cur.files; changed(); }}
                  onFiles={(fs) => void attach(cur, fs)} />
              </div>
              <label class="rq-field">Source<input aria-label="Source" placeholder="Where it comes from: the specification and its clause" value={cur.source ?? ''} onChange={(e) => { const v = (e.target as HTMLInputElement).value.trim(); begin(); if (v) cur.source = v; else delete cur.source; changed(); }} /></label>
              <Attachments files={cur.files ?? []} onAttach={(fs) => void attach(cur, fs)} onRemove={(id) => { begin(); const left = (cur.files ?? []).filter((f) => f.id !== id); if (left.length) cur.files = left; else delete cur.files; changed(); }} />
              {fileNote && <p class="small ai-error">{fileNote}</p>}
              <div class="rq-grid">
                <label>Type{sel3('Type', REQ_TYPES, cur.type, (v: ReqType) => edit(cur, { type: v }))}</label>
                <label>Priority{sel3('Priority', PRIORITIES, cur.priority, (v: Priority) => edit(cur, { priority: v }))}</label>
                <label>Status{sel3('Status', STATUSES, cur.status, (v: ReqStatus) => edit(cur, { status: v }))}</label>
                <label>Parent<select aria-label="Parent" value={cur.parent ?? ''} onChange={(e) => setParent(cur, (e.target as HTMLSelectElement).value)}>
                  <option value="">None</option>
                  {parents.map((r) => <option key={r.id} value={r.id}>{r.id}{r.title ? `: ${r.title.slice(0, 40)}` : ''}</option>)}
                </select></label>
              </div>
              <fieldset class="rq-verify">
                <legend>Verification</legend>
                <div class="rq-grid">
                  <label>Method{sel3('Verification method', METHODS, cur.verify.method, (v: VerifyMethod) => editVerify(cur, { method: v }))}</label>
                  <label>State{cur.check?.follow && resultOf(cur, facts)!.status !== 'unknown'
                    ? <select aria-label="Verification state" disabled title="Set by its check (untick The verification follows the check to set it by hand)" value={stateOf(cur, facts)}>{VERIFY_STATES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
                    : sel3('Verification state', VERIFY_STATES, cur.verify.state, (v: VerifyState) => editVerify(cur, { state: v }))}</label>
                </div>
                <label class="rq-field">Note<textarea aria-label="Verification note" rows={3} placeholder="How it was verified: the test, its result, the report" value={cur.verify.note} onChange={(e) => editVerify(cur, { note: (e.target as HTMLTextAreaElement).value })} /></label>
              </fieldset>
              <ReqCheckEditor check={cur.check} result={resultOf(cur, facts)} project={projectOf(od)} onChange={(c) => { begin(); if (c) cur.check = c; else delete cur.check; changed(); }} />
              <div class="rq-links">
                <span class="muted small">Linked to</span>
                {cur.links.length ? cur.links.map((l) => (
                  <span key={`${l.kind}:${l.ref}`} class="rq-link"><span class="muted small">{labelOf(LINK_KINDS, l.kind)}</span>
                    <button class="link" title="Show it in the design" onClick={() => probe(l, projectOf(od))}>{l.ref}</button>
                    <button class="reqp-unlink" title={`Unlink ${l.ref}`} aria-label={`Unlink ${l.ref}`} onClick={() => edit(cur, { links: cur.links.filter((x) => !sameLink(x, l)) })}>×</button></span>
                )) : <span class="muted small">Nothing yet: link it from the Requirements panel, with the parts, nets, sheet or board selected.</span>}
              </div>
              {children.length > 0 && <div class="rq-children"><span class="muted small">Broken down into</span>{children.map((c) => <button key={c.id} class="link small" onClick={() => pickId(c.id)}>{c.id}{c.title ? `: ${c.title}` : ''}</button>)}</div>}
            </>
          ) : row?.kind === 'section' ? <p class="muted small">A section: the requirements under it, up to the next one, are in it.</p> : <p class="muted small">Pick a requirement to see it in full.</p>}
        </aside>
      </div>
      <div class="reqdoc-foot small">
        <span>{t.all} requirement{t.all === 1 ? '' : 's'}</span><span>{t.approved} approved</span><span>{t.verified} verified</span>{t.failed > 0 && <span class="rq-fail">{t.failed} failed</span>}<span>{t.open} not verified</span>
        <span class="spacer" />
        <label class="muted">New identifiers start<input class="rq-prefix" aria-label="Identifier prefix" value={R.prefix} onChange={(e) => { begin(); R.prefix = cleanPrefix((e.target as HTMLInputElement).value); changed(); }} /></label>
      </div>
    </div>
  );
}
