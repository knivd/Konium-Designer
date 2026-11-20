import { useState } from 'preact/hooks';
import { readLocal, writeLocal } from '../../core/storage';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { docs, notify, tick, units } from '../state';
import { showPanel } from '../dock/store';
import { filterQuery } from '../panels/SchFilter';
import { SchEditor } from '../../editors/sch/SchEditor';
import { SR } from '../../model/sch';
import { CATEGORIES, objectKind, schProps, type SchCtx } from '../../model/schProps';
import { expressionFor } from '../../model/schQuery';

type Match = 'Any' | 'Same' | 'Different';

/**
 * Find Similar Objects on a schematic (Shift+F, or right-click › Find Similar Objects): every
 * Inspector property of the clicked object, grouped Kind / Design / Graphical / Object Specific,
 * each set to Any, Same or Different. Then, as in Altium: Zoom Matching, Select Matching, Clear
 * Existing, Mask Matching (the rest fade), Run Inspector, Create Expression (into the SCH Filter),
 * over the current document or every open schematic.
 */

const OPTS_KEY = 'findSimilar';
const loadOpts = () => {
  const def = { zoom: true, select: true, clear: true, mask: true, inspector: true, expression: false, open: false };
  try { return { ...def, ...(JSON.parse(readLocal(OPTS_KEY) ?? '{}') as Partial<typeof def>) }; } catch { return def; }
};

function ctxOf(ed: SchEditor, index: number): SchCtx {
  return { doc: ed.doc, index, units: units.value, docName: docs.value.find((d) => d.editor === ed)?.name ?? ed.doc.name, libraryMode: ed.libraryMode };
}

/** What a find over a sheet looks at: everything but a part's own graphics. */
function candidates(ed: SchEditor): number[] {
  return ed.doc.objects.filter((o) => {
    if (o.kind === 'meta' || o.record === SR.SHEET) return false;
    const ow = o.owner >= 0 ? ed.doc.objects[o.owner] : undefined;
    return !(ow?.kind === 'component' && !ed.libraryMode && o.kind !== 'pin' && o.kind !== 'text');
  }).map((o) => o.index);
}

const keyFor = (ed: SchEditor, i: number) => { const o = ed.doc.objects[i]!, ow = o.owner >= 0 ? ed.doc.objects[o.owner] : undefined; return ow?.kind === 'component' && o.kind !== 'text' && !ed.libraryMode ? `o${ow.index}` : `o${i}`; };

export function SchFindSimilarDialog({ ed, index }: { ed: SchEditor; index: number }) {
  const x = ctxOf(ed, index);
  const o = ed.doc.objects[index]!;
  const props = schProps(ed.doc, o, ed.libraryMode);
  const [match, setMatch] = useState<Record<string, Match>>(() => Object.fromEntries(props.map((p) => [`${p.cat}:${p.name}`, p.name === 'Object Kind' ? 'Same' : 'Any'])));
  const [opts, setOpts] = useState(loadOpts);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const set = (p: Partial<typeof opts>) => { const n = { ...opts, ...p }; setOpts(n); writeLocal(OPTS_KEY, JSON.stringify(n)); };

  const apply = (): number => {
    const want = props.filter((p) => match[`${p.cat}:${p.name}`] !== 'Any').map((p) => ({ p, m: match[`${p.cat}:${p.name}`]!, v: p.get(x) }));
    const eds = opts.open ? docs.value.map((d) => d.editor).filter((e): e is SchEditor => e instanceof SchEditor) : [ed];
    let total = 0;
    for (const e of eds) {
      const hits = candidates(e).filter((i) => {
        const oo = e.doc.objects[i]!, cx = ctxOf(e, i), list = schProps(e.doc, oo, e.libraryMode);
        return want.every(({ p, m, v }) => { const q = list.find((r) => r.cat === p.cat && r.name === p.name); if (!q) return false; return (q.get(cx) === v) === (m === 'Same'); });
      });
      total += hits.length;
      const keys = hits.map((i) => keyFor(e, i));
      if (opts.select) { if (opts.clear) e.select(keys); else e.select([...e.selection, ...keys]); }
      else if (opts.clear) e.clearSelection();
      e.setMask(opts.mask ? hits : null);
      if (opts.zoom && e === ed && hits.length) e.zoomToBox(e.boundsOf(keys), 2_000_000);
    }
    if (opts.inspector) showPanel('inspector');
    if (opts.expression) { filterQuery.value = expressionFor(want.map(({ p, m, v }) => ({ name: p.name, value: v, same: m === 'Same' }))); showPanel('filter'); }
    tick.value++;
    notify(`${total} matching object${total === 1 ? '' : 's'}`);
    return total;
  };
  const ok = () => { apply(); closeDialog(); };
  const toggle = (c: string) => { const n = new Set(closed); if (n.has(c)) n.delete(c); else n.add(c); setClosed(n); };
  const cell = (v: string, type: string) => (type === 'colour' ? <span class="swatch" style={{ background: v }} /> : type === 'bool' ? <input type="checkbox" checked={v === 'true'} disabled /> : v);

  return (
    <Dialog title="Find Similar Objects" width={560} height={640} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="findsim"
      footer={<><span class="spacer" /><button class="btn" onClick={() => apply()}>Apply</button><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="fs-grid" role="treegrid" aria-label={`Similar to ${objectKind(ed.doc, o)}`}>
        {CATEGORIES.map((c) => {
          const rows = props.filter((p) => p.cat === c);
          if (!rows.length) return null;
          const open = !closed.has(c);
          return (
            <div key={c} role="rowgroup">
              <div class="insp-cat-row" role="row" onDblClick={() => toggle(c)}><button class="insp-twisty" onClick={() => toggle(c)}>{open ? '⊟' : '⊞'}</button><span>{c}</span></div>
              {open && rows.map((p) => {
                const k = `${p.cat}:${p.name}`;
                return (
                  <div key={k} class="fs-row" role="row">
                    <span class="insp-name">{p.name}</span>
                    <span class="fs-value">{cell(p.get(x), p.type)}</span>
                    <select value={match[k]} aria-label={`${p.name} match`} onChange={(e) => setMatch({ ...match, [k]: (e.target as HTMLSelectElement).value as Match })}>
                      <option value="Any">Any</option><option value="Same">Same</option><option value="Different">Different</option>
                    </select>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div class="fs-opts">
        <label><input type="checkbox" checked={opts.zoom} onChange={(e) => set({ zoom: (e.target as HTMLInputElement).checked })} />Zoom Matching</label>
        <label><input type="checkbox" checked={opts.select} onChange={(e) => set({ select: (e.target as HTMLInputElement).checked })} />Select Matching</label>
        <label><input type="checkbox" checked={opts.clear} onChange={(e) => set({ clear: (e.target as HTMLInputElement).checked })} />Clear Existing</label>
        <label><input type="checkbox" checked={opts.mask} onChange={(e) => set({ mask: (e.target as HTMLInputElement).checked })} />Mask Matching</label>
        <label><input type="checkbox" checked={opts.inspector} onChange={(e) => set({ inspector: (e.target as HTMLInputElement).checked })} />Run Inspector</label>
        <label><input type="checkbox" checked={opts.expression} onChange={(e) => set({ expression: (e.target as HTMLInputElement).checked })} />Create Expression</label>
        <select value={opts.open ? 'open' : 'current'} onChange={(e) => set({ open: (e.target as HTMLSelectElement).value === 'open' })}>
          <option value="current">Current Document</option><option value="open">Open Documents</option>
        </select>
      </div>
    </Dialog>
  );
}
