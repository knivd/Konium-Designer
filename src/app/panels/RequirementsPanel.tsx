/**
 * The Requirements panel: every requirement of the project in front (all its requirements
 * documents), to find one, see it, set where its verification stands and link it to the design:
 * what is selected in the schematic or on the board (its parts and nets; nothing selected, the
 * sheet or the board itself). Each link followed back to the design with a click. Changes go into
 * the requirements document (opened in the background if it wasn't), one step to undo there.
 */
import { Attachments, RichView } from '../RichText';
import { Fragment } from 'preact';
import { signal } from '@preact/signals';
import { featureOn } from '../../core/release';
import { showPanel } from '../dock/store';
import { useState } from 'preact/hooks';
import { activeProject } from '../project';
import { active, tick } from '../state';
import { commands } from '../../core/commands';
import { changeReqs, projectReqs, reqSources, writable, type ReqSource } from '../requirementsData';
import { probe, selectionLinks } from '../requirementsLinks';
import { openProjectDocument } from '../actions';
import { designFacts } from '../reqFacts';
import { CheckResultLine } from '../ReqCheckEditor';
import {
  LINK_KINDS, METHODS, PRIORITIES, STATUSES, VERIFY_STATES, labelOf, matches, mergeLinks, resultOf, sameLink, stateOf, tally,
  type ReqLink, type Requirement, type VerifyState,
} from '../../model/requirements';
import { activeId, docs } from '../state';

type Show = 'all' | 'open' | 'failed' | 'must' | 'linked';
/** The requirement picked in the panel (by identifier): Properties' links pick one too. */
export const reqPick = signal<string | null>(null);

const SHOWS: [Show, string][] = [['all', 'All'], ['open', 'Not verified'], ['failed', 'Failed'], ['must', 'Must'], ['linked', 'Linked to the selection']];

export function RequirementsPanel() {
  void tick.value;
  const p = activeProject();
  const [q, setQ] = useState('');
  const [show, setShow] = useState<Show>('all');
  const pick = reqPick.value, setPick = (id: string | null) => { reqPick.value = id; };
  const sources = reqSources(p);
  const all = projectReqs(p);
  const facts = designFacts(p);
  const st = (r: Requirement) => stateOf(r, facts);
  const sel = selectionLinks();
  const selParts = sel.filter((l) => l.kind === 'part' || l.kind === 'net');
  const keep = ({ req: r }: { req: Requirement }) => {
    if (!matches(r, q)) return false;
    switch (show) {
      case 'open': return r.status !== 'obsolete' && st(r) === 'open';
      case 'failed': return st(r) === 'failed';
      case 'must': return r.priority === 'must' && r.status !== 'obsolete';
      case 'linked': return r.links.some((l) => sel.some((s) => sameLink(s, l)));
      default: return true;
    }
  };
  const rows = all.filter(keep);
  const cur = all.find((x) => x.req.id === pick) ?? null;
  const t = tally(all.map((x) => x.req), st);
  /** A change to the picked requirement, in its document (opened in the background if need be). */
  const change = (s: ReqSource, id: string, fn: (r: Requirement) => void) => {
    const d = writable(p, s);
    const r = d?.reqs.rows.find((x): x is Requirement => x.kind === 'req' && x.id === id);
    if (d && r) changeReqs(d, () => fn(r));
  };
  const openIn = (s: ReqSource, id: string) => {
    const od = s.od ?? docs.value.find((d) => d.doc === s.doc);
    if (od) activeId.value = od.id; else if (p) openProjectDocument(p, s.name);
    setPick(id);
  };

  if (!sources.length) {
    return (
      <section class="panel docked reqp" aria-label="Requirements">
        <p class="panel-empty">No requirements in {p ? p.name : 'the documents open'} yet.<br />
          <button class="link" onClick={() => commands.run('file.newRequirements', 'global')}>New requirements document</button></p>
      </section>
    );
  }
  return (
    <section class="panel docked reqp" aria-label="Requirements">
      <div class="reqp-bar">
        <input type="search" placeholder="Search" aria-label="Search requirements" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <select aria-label="Show" value={show} onChange={(e) => setShow((e.target as HTMLSelectElement).value as Show)}>{SHOWS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
      </div>
      <div class="reqp-tally small muted">{t.all} requirement{t.all === 1 ? '' : 's'} · {t.verified} verified{t.failed ? <> · <span class="rq-fail">{t.failed} failed</span></> : null} · {t.open} not verified</div>
      <div class="reqp-list" role="listbox" aria-label="Requirements">
        {rows.map(({ req: r, source }, i) => (
          <Fragment key={`${source.name}:${r.id}`}>
            {sources.length > 1 && (i === 0 || rows[i - 1]!.source !== source) && <div class="reqp-doc small muted">{source.name}</div>}
            <div role="option" aria-selected={r.id === pick} class={`reqp-row${r.id === pick ? ' on' : ''}${r.status === 'obsolete' ? ' obsolete' : ''}`}
              onClick={() => setPick(r.id)} onDblClick={() => openIn(source, r.id)} title={r.text || r.title}>
              <span class="reqp-id">{r.id}</span>
              <span class="reqp-title">{r.title || <span class="muted">(no title)</span>}</span>
              {r.links.length > 0 && <span class="reqp-links small muted" title={`${r.links.length} link${r.links.length === 1 ? '' : 's'} to the design`}>⛓{r.links.length}</span>}
              <span class={`rq-pill ver-${st(r)}`}>{labelOf(VERIFY_STATES, st(r))}</span>
            </div>
          </Fragment>
        ))}
        {!rows.length && <p class="panel-empty small">Nothing matches.</p>}
      </div>
      {cur && (
        <div class="reqp-detail" aria-label={`Requirement ${cur.req.id}`}>
          <div class="reqp-head"><b>{cur.req.id}</b> {cur.req.title}</div>
          <RichView class="reqp-text" text={cur.req.text} html={cur.req.html} files={cur.req.files} />
          {cur.req.files?.some((f) => !f.inline) && <Attachments files={cur.req.files} />}
          <div class="small muted">{labelOf(PRIORITIES, cur.req.priority)} · {labelOf(STATUSES, cur.req.status)} · verified by {labelOf(METHODS, cur.req.verify.method).toLowerCase()}{cur.req.parent ? ` · under ${cur.req.parent}` : ''}</div>
          {cur.req.check && <CheckResultLine result={resultOf(cur.req, facts)!} check={cur.req.check} />}
          <label class="reqp-verify">Verification
            <select aria-label="Verification state" value={st(cur.req)} disabled={!!cur.req.check?.follow && resultOf(cur.req, facts)!.status !== 'unknown'} title={cur.req.check?.follow ? 'Set by its check while it can be told' : undefined} onChange={(e) => { const v = (e.target as HTMLSelectElement).value as VerifyState; change(cur.source, cur.req.id, (r) => { r.verify = { ...r.verify, state: v }; }); }}>
              {VERIFY_STATES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
            </select>
          </label>
          <div class="reqp-linkhead"><span>Linked to</span>
            <button class="btn" disabled={!sel.length} title={sel.length ? `Link ${linkWords(sel)}` : 'Select parts or nets in the schematic or on the board (or nothing, for the document itself)'}
              onClick={() => change(cur.source, cur.req.id, (r) => { r.links = mergeLinks(r.links, sel); })}>Link the selection</button>
          </div>
          {cur.req.links.length ? (
            <ul class="reqp-linklist">
              {cur.req.links.map((l) => (
                <li key={`${l.kind}:${l.ref}`}>
                  <span class="muted small">{labelOf(LINK_KINDS, l.kind)}</span>
                  <button class="link" title="Show it in the design" onClick={() => probe(l, p)}>{l.ref}</button>
                  <button class="reqp-unlink" title={`Unlink ${l.ref}`} aria-label={`Unlink ${l.ref}`} onClick={() => change(cur.source, cur.req.id, (r) => { r.links = r.links.filter((x) => !sameLink(x, l)); })}>×</button>
                </li>
              ))}
            </ul>
          ) : <p class="small muted">Not linked yet{selParts.length || sel.length ? '' : ': select parts or nets in the schematic or on the board, or nothing for the document itself'}.</p>}
          <button class="link small" onClick={() => openIn(cur.source, cur.req.id)}>Open in {cur.source.name}</button>
        </div>
      )}
    </section>
  );
}

/** The selection in words: "R1, R2 and net VCC", "the board PCB1.PcbDoc". */
function linkWords(ls: ReqLink[]): string {
  const parts = ls.filter((l) => l.kind === 'part').map((l) => l.ref), nets = ls.filter((l) => l.kind === 'net').map((l) => l.ref);
  const docsOf = ls.filter((l) => l.kind === 'sheet' || l.kind === 'board').map((l) => `${l.kind === 'board' ? 'the board' : 'the sheet'} ${l.ref}`);
  const list = (xs: string[]) => (xs.length > 4 ? `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more` : xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] ?? '');
  return [parts.length ? list(parts) : '', nets.length ? `net${nets.length > 1 ? 's' : ''} ${list(nets)}` : '', ...docsOf].filter(Boolean).join(', ');
}

/**
 * Properties (the Inspector): the requirements the selected parts and nets are linked to, each
 * opening in the Requirements panel.
 */
export function LinkedReqs() {
  void tick.value; void active.value;
  if (!featureOn('requirements')) return null;
  const sel = selectionLinks().filter((l) => l.kind === 'part' || l.kind === 'net');
  if (!sel.length) return null;
  const reqs = projectReqs(activeProject()).map((x) => x.req).filter((r) => r.status !== 'obsolete' && r.links.some((l) => sel.some((s) => sameLink(s, l))));
  if (!reqs.length) return null;
  return (
    <div class="insp-reqs" aria-label="Requirements of the selection">
      <span class="muted small">Requirements</span>
      {reqs.map((r) => <button key={r.id} class="link small" title={r.text || r.title} onClick={() => { reqPick.value = r.id; showPanel('requirements'); }}>{r.id}{r.title ? `: ${r.title}` : ''}</button>)}
    </div>
  );
}
