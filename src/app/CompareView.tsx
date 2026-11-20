/**
 * The compare view: the older version on the left, the newer on the right, each with its title;
 * below them the differences (a row goes to it in both; Previous and Next step through them),
 * Keep Views Together, Find Again (after edits on the right), and Close Compare.
 */
import { useEffect, useRef } from 'preact/hooks';
import { activeId } from './state';
import { DIFF_COLOURS, closeCompare, compareView, refreshCompare, setTogether, showDiff, type CompareSide } from './compare';
import type { DiffKind } from '../model/versionDiff';

const GLYPH: Record<DiffKind, string> = { added: '+', removed: '−', changed: '~' };
const WORD: Record<DiffKind, string> = { added: 'Added', removed: 'Removed', changed: 'Changed' };
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
type View = { cx: number; cy: number; scale: number };
const same = (a: View, b: View) => Math.abs(a.cx - b.cx) < 1e-3 && Math.abs(a.cy - b.cy) < 1e-3 && Math.abs(a.scale - b.scale) <= 1e-9 * Math.max(a.scale, b.scale);
/** Where both sides were last put (a side that isn't there any more has moved). */
const shared: { view: View | null } = { view: null };

function Side({ s, other }: { s: CompareSide; other: CompareSide }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current, ed = s.od.editor;
    if (!el || !ed) return;
    ed.mount(el);
    const vp = ed.viewport;
    // Kept at the other's place and zoom: the side that moved since the two were last put together leads
    if (vp) vp.afterRender = () => {
      const c = compareView.value, o = other.od.editor?.viewport;
      if (!c?.together || !o) return;
      const v = vp.view;
      if (shared.view && same(v, shared.view)) return;
      shared.view = v;
      if (same(v, o.view)) return;
      Object.assign(o.cam, v);
      o.requestRender();
    };
    const t = setTimeout(() => { if (!vp) return; if (s === compareView.value?.newer) vp.fit(); }, 60);
    return () => { clearTimeout(t); if (vp) vp.afterRender = null; ed.unmount(); };
  }, [s.od.id]);
  return (
    <div class={`pane${activeId.value === s.od.id ? ' on' : ''}`} onMouseDownCapture={() => { if (s === compareView.value?.newer && activeId.value !== s.od.id) activeId.value = s.od.id; }}>
      <div class="pane-title" title={s.title}>{s.title}</div>
      <div class="pane-body"><div class="viewport-host" ref={ref} /></div>
    </div>
  );
}

export function CompareView() {
  const c = compareView.value;
  useEffect(() => { shared.view = null; }, [c?.older.od.id, c?.newer.od.id, c?.together]);
  if (!c) return null;
  const n = { added: 0, removed: 0, changed: 0 };
  for (const d of c.diffs) n[d.kind]++;
  const step = (by: number) => { const L = c.diffs.length; if (L) showDiff(c.at < 0 ? (by > 0 ? 0 : L - 1) : (c.at + by + L) % L); };
  return (
    <div class="cmp" aria-label="Compare">
      <div class="cmp-sides">
        <Side s={c.older} other={c.newer} />
        <Side s={c.newer} other={c.older} />
      </div>
      <div class="cmp-bar">
        <span class="cmp-count">{c.diffs.length ? `${c.diffs.length} difference${c.diffs.length === 1 ? '' : 's'}:` : 'No differences'}</span>
        {(['changed', 'added', 'removed'] as const).map((k) => n[k] > 0 && <span key={k} class="cmp-key"><i style={{ background: hex(DIFF_COLOURS[k]) }} />{n[k]} {WORD[k].toLowerCase()}</span>)}
        <span class="spacer" />
        <button class="btn" disabled={!c.diffs.length} onClick={() => step(-1)}>Previous</button>
        <button class="btn" disabled={!c.diffs.length} onClick={() => step(1)}>Next</button>
        <label class="cmp-check"><input type="checkbox" checked={c.together} onChange={() => setTogether(!c.together)} /> Keep Views Together</label>
        <button class="btn" title="Look for the differences again (after changing the newer one)" onClick={refreshCompare}>Find Again</button>
        <button class="btn" onClick={closeCompare}>Close Compare</button>
      </div>
      {c.diffs.length > 0 && (
        <div class="cmp-list">
          <table class="sd-table" aria-label="Differences">
            <tbody>{c.diffs.map((d, i) => (
              <tr key={i} class={i === c.at ? 'sel' : ''} onClick={() => showDiff(i)}>
                <td class="cmp-glyph" style={{ color: hex(DIFF_COLOURS[d.kind]) }} title={WORD[d.kind]}>{GLYPH[d.kind]}</td>
                <td>{d.what}</td><td class="muted">{d.detail}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
