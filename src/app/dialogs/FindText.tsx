import { useState } from 'preact/hooks';
import { readLocal, writeLocal } from '../../core/storage';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { active, activeId, docs, notify, tick, type OpenDoc } from '../state';
import { SchEditor } from '../../editors/sch/SchEditor';
import { setProps } from '../../model/schEdit';
import { findText, replaceIn, type FindOptions, type Identifiers, type TextHit } from '../../model/schFind';

/**
 * Edit › Find Text (Ctrl+F) and Find and Replace Text (Ctrl+H), Altium Designer 17's: text to
 * find (and replace with), sheet scope (current / project / open documents), selection (all,
 * selected, deselected objects), identifiers (all, nets only, designators only), case and whole
 * word options. Find jumps to the first match; F3 (Find Next) to each one after it. Replace asks
 * at every match (Yes, No, All, Cancel) unless Prompt On Replace is off.
 */

type Scope = 'current' | 'project' | 'open';
type Sel = 'all' | 'selected' | 'deselected';
interface FindState extends FindOptions { scope: Scope; sel: Sel; jump: boolean; replace: string; prompt: boolean }

const RECENT_KEY = 'findText.recent';
const recent = (): string[] => { try { const v = JSON.parse(readLocal(RECENT_KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
let last: FindState = { text: '', caseSensitive: false, wholeWords: false, identifiers: 'all', scope: 'current', sel: 'all', jump: true, replace: '', prompt: true };
/** The matches of the last Find, for F3, and the sheets as they were then (an edit or a close makes them stale). */
let found: { doc: OpenDoc; hit: TextHit }[] = [];
let pos = -1;
let foundAt = new Map<OpenDoc, number>();
const searched = (list: { doc: OpenDoc; hit: TextHit }[]) => {
  found = list;
  foundAt = new Map(scopeDocs(last.scope).map((d) => [d, (d.editor as SchEditor).undo.revision]));
  return list;
};
const stale = () => [...foundAt].some(([d, rev]) => !docs.value.includes(d) || (d.editor as SchEditor).undo.revision !== rev);

function scopeDocs(scope: Scope): OpenDoc[] {
  const cur = active.value;
  const sch = docs.value.filter((d) => d.editor instanceof SchEditor && !(d.editor as SchEditor).libraryMode);
  if (scope === 'open') return sch;
  if (scope === 'project') return sch.filter((d) => d.projectId && d.projectId === cur?.projectId);
  return cur && cur.editor instanceof SchEditor ? [cur] : [];
}

function search(st: FindState): { doc: OpenDoc; hit: TextHit }[] {
  const out: { doc: OpenDoc; hit: TextHit }[] = [];
  for (const d of scopeDocs(st.scope)) {
    const ed = d.editor as SchEditor;
    const sel = new Set(ed.selectedIndices());
    // A selected part counts its designator and parameters as selected too
    for (const i of [...sel]) for (const o of ed.doc.objects) if (o.owner === i) sel.add(o.index);
    const only = st.sel === 'all' ? undefined : new Set(ed.doc.objects.map((o) => o.index).filter((i) => sel.has(i) === (st.sel === 'selected')));
    for (const hit of findText(ed.doc, st, only)) out.push({ doc: d, hit });
  }
  return out;
}

function show(f: { doc: OpenDoc; hit: TextHit }): void {
  if (activeId.value !== f.doc.id) activeId.value = f.doc.id;
  const ed = f.doc.editor as SchEditor;
  setTimeout(() => { ed.select([`o${f.hit.index}`]); ed.jumpToSelection(15_000_000); tick.value++; }, 0);
}

/** F3: the next match of the last Find Text. */
export function findNext(): void {
  // The sheets changed since: search again, carrying on from about where it was
  if (found.length && stale()) { searched(search(last)); pos = Math.min(pos, found.length - 1) - 1; }
  if (!found.length) { if (last.text) { searched(search(last)); pos = -1; } }
  if (!found.length) { notify(last.text ? `"${last.text}" not found` : 'Nothing to find: Edit › Find Text first', 'error'); return; }
  pos = (pos + 1) % found.length;
  show(found[pos]!);
  notify(`Match ${pos + 1} of ${found.length}: ${found[pos]!.hit.value}`);
}

function remember(text: string): void {
  writeLocal(RECENT_KEY, JSON.stringify([text, ...recent().filter((r) => r !== text)].slice(0, 12)));
}

export function FindTextDialog({ replace = false }: { replace?: boolean }) {
  const [st, setSt] = useState<FindState>(() => {
    // Preload with the selected text, as Altium does
    const ed = active.value?.editor;
    const i = ed instanceof SchEditor ? ed.selectedIndices()[0] : undefined;
    const b = ed instanceof SchEditor && i !== undefined ? ed.doc.records[i + 1]?.bag : undefined;
    const t = b?.get('TEXT') ?? b?.get('NAME');
    return { ...last, text: t && !last.text ? t : last.text };
  });
  const set = (p: Partial<FindState>) => setSt({ ...st, ...p });
  const ok = () => {
    if (!st.text) return;
    closeDialog();
    last = st;
    remember(st.text);
    searched(search(st));
    pos = -1;
    if (!found.length) { notify(`"${st.text}" not found`, 'error'); return; }
    if (!replace) {
      notify(`${found.length} match${found.length === 1 ? '' : 'es'} — F3 for the next`);
      if (st.jump) findNext();
      return;
    }
    if (!st.prompt) { replaceAll(found, st); return; }
    askNext(found, 0, st, 0);
  };
  const sel = (label: string, value: string, opts: [string, string][], on: (v: string) => void) => (
    <label class="ft-row"><span>{label}</span><select value={value} onChange={(e) => on((e.target as HTMLSelectElement).value)}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
  );
  return (
    <Dialog title={replace ? 'Find And Replace Text' : 'Find Text'} width={440} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="findtext"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <fieldset><legend>Text</legend>
        <label class="ft-row"><span>Text To Find</span><input type="text" list="ft-recent" value={st.text} autofocus onInput={(e) => set({ text: (e.target as HTMLInputElement).value })} /></label>
        <datalist id="ft-recent">{recent().map((r) => <option key={r} value={r} />)}</datalist>
        {replace && <label class="ft-row"><span>Replace With</span><input type="text" value={st.replace} onInput={(e) => set({ replace: (e.target as HTMLInputElement).value })} /></label>}
      </fieldset>
      <fieldset><legend>Scope</legend>
        {sel('Sheet Scope', st.scope, [['current', 'Current Document'], ['project', 'Project Documents'], ['open', 'Open Documents']], (v) => set({ scope: v as Scope }))}
        {sel('Selection', st.sel, [['all', 'All Objects'], ['selected', 'Selected Objects'], ['deselected', 'Deselected Objects']], (v) => set({ sel: v as Sel }))}
        {sel('Identifiers', st.identifiers, [['all', 'All Identifiers'], ['nets', 'Net Identifiers Only'], ['designators', 'Designators Only']], (v) => set({ identifiers: v as Identifiers }))}
      </fieldset>
      <fieldset class="ft-opts"><legend>Options</legend>
        <label><input type="checkbox" checked={st.caseSensitive} onChange={(e) => set({ caseSensitive: (e.target as HTMLInputElement).checked })} />Case sensitive</label>
        <label><input type="checkbox" checked={st.wholeWords} onChange={(e) => set({ wholeWords: (e.target as HTMLInputElement).checked })} />Whole Words Only</label>
        {replace
          ? <label><input type="checkbox" checked={st.prompt} onChange={(e) => set({ prompt: (e.target as HTMLInputElement).checked })} />Prompt On Replace</label>
          : <label><input type="checkbox" checked={st.jump} onChange={(e) => set({ jump: (e.target as HTMLInputElement).checked })} />Jump to Results</label>}
      </fieldset>
    </Dialog>
  );
}

function replaceOne(f: { doc: OpenDoc; hit: TextHit }, st: FindState): boolean {
  const ed = f.doc.editor as SchEditor;
  const b = ed.doc.records[f.hit.index + 1]?.bag;
  const now = b?.get(f.hit.key);
  if (now === undefined) return false;
  const frame = f.hit.key === 'TEXT' && /~1/.test(now);
  const next = replaceIn(frame ? now.replace(/~1/g, '\n') : now, st, st.replace);
  if (next === (frame ? now.replace(/~1/g, '\n') : now)) return false;
  ed.undo.transact(`Replace text`, (tx) => tx.add(setProps(ed.doc, f.hit.index, { [f.hit.key]: frame ? next.replace(/\n/g, '~1') : next })));
  ed.invalidate();
  return true;
}

function replaceAll(list: { doc: OpenDoc; hit: TextHit }[], st: FindState): void {
  const byDoc = new Map<OpenDoc, TextHit[]>();
  for (const f of list) byDoc.set(f.doc, [...(byDoc.get(f.doc) ?? []), f.hit]);
  let n = 0;
  for (const [d, hits] of byDoc) {
    const ed = d.editor as SchEditor;
    ed.undo.transact(`Replace "${st.text}" with "${st.replace}"`, (tx) => {
      for (const h of hits) {
        const now = ed.doc.records[h.index + 1]?.bag?.get(h.key);
        if (now === undefined) continue;
        // A text frame's or note's line breaks (~1) as lines, as Find saw them
        const frame = h.key === 'TEXT' && /~1/.test(now), was = frame ? now.replace(/~1/g, '\n') : now;
        const next = replaceIn(was, st, st.replace);
        if (next !== was) { tx.add(setProps(ed.doc, h.index, { [h.key]: frame ? next.replace(/\n/g, '~1') : next })); n++; }
      }
    });
    ed.invalidate();
  }
  tick.value++;
  notify(`${n} occurrence${n === 1 ? '' : 's'} replaced`);
}

/** Prompt On Replace: one match at a time, shown in place. */
function askNext(list: { doc: OpenDoc; hit: TextHit }[], i: number, st: FindState, done: number): void {
  if (i >= list.length) { notify(`${done} occurrence${done === 1 ? '' : 's'} replaced`); return; }
  const f = list[i]!;
  show(f);
  showDialog(ReplacePrompt, {
    text: f.hit.value, by: replaceIn(f.hit.value, st, st.replace),
    onAnswer: (a: 'yes' | 'no' | 'all' | 'cancel') => {
      if (a === 'cancel') { notify(`${done} occurrence${done === 1 ? '' : 's'} replaced`); return; }
      if (a === 'all') { replaceAll(list.slice(i), st); return; }
      const n = a === 'yes' && replaceOne(f, st) ? 1 : 0;
      askNext(list, i + 1, st, done + n);
    },
  });
}

function ReplacePrompt({ text, by, onAnswer }: { text: string; by: string; onAnswer: (a: 'yes' | 'no' | 'all' | 'cancel') => void }) {
  const say = (a: 'yes' | 'no' | 'all' | 'cancel') => () => { closeDialog(); setTimeout(() => onAnswer(a), 0); };
  return (
    <Dialog title="Confirm" width={420} onClose={say('cancel')} onAccept={() => { say('yes')(); return false; }} class="confirm"
      footer={<><span class="spacer" /><button class="btn default" onClick={say('yes')}>Yes</button><button class="btn" onClick={say('no')}>No</button>
        <button class="btn" onClick={say('all')}>All</button><button class="btn" onClick={say('cancel')}>Cancel</button></>}>
      <div class="confirm-body"><span class="confirm-icon" aria-hidden="true">?</span>
        <div><p>Replace "{text}" with "{by}"?</p></div></div>
    </Dialog>
  );
}
