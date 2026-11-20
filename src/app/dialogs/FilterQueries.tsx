import { useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import { applyFilter, filterFavorites, filterHistory, filterQuery, setFilterFavorites, setFilterHistory, EXAMPLES } from '../panels/SchFilter';
import { notify } from '../state';

type Kind = 'favorites' | 'history' | 'examples';
interface Row { name: string; query: string }

/**
 * The SCH Filter's lists as dialogs (right-click › Filter): Organize Favorites (apply, rename,
 * delete, reorder), History › More (apply, add to favorites, clear), Examples (apply).
 */
export function FilterQueriesDialog({ kind }: { kind: Kind }) {
  const read = (): Row[] => kind === 'examples' ? EXAMPLES.map(([name, query]) => ({ name, query }))
    : (kind === 'favorites' ? filterFavorites() : filterHistory()).map((q) => ({ name: q, query: q }));
  const [rows, setRows] = useState<Row[]>(read);
  const [sel, setSel] = useState<number | null>(rows.length ? 0 : null);
  const store = (r: Row[]) => { setRows(r); if (kind === 'favorites') setFilterFavorites(r.map((x) => x.query)); if (kind === 'history') setFilterHistory(r.map((x) => x.query)); };
  const apply = (i = sel) => { const r = i === null ? undefined : rows[i]; if (!r) return; closeDialog(); filterQuery.value = r.query; applyFilter(r.query); };
  const move = (d: -1 | 1) => { if (sel === null) return; const j = sel + d; if (j < 0 || j >= rows.length) return; const n = [...rows]; [n[sel], n[j]] = [n[j]!, n[sel]!]; store(n); setSel(j); };
  const title = kind === 'favorites' ? 'Organise Favourites' : kind === 'history' ? 'Filter History' : 'Filter Examples';
  return (
    <Dialog title={title} width={640} height={420} onClose={closeDialog} onAccept={() => { apply(); return false; }}
      footer={<>
        {kind === 'favorites' && <>
          <button class="btn" disabled={sel === null} onClick={() => { store(rows.filter((_, i) => i !== sel)); setSel(null); }}>Delete</button>
          <button class="btn" disabled={!sel} onClick={() => move(-1)}>Move Up</button>
          <button class="btn" disabled={sel === null || sel >= rows.length - 1} onClick={() => move(1)}>Move Down</button>
        </>}
        {kind === 'history' && <>
          <button class="btn" disabled={sel === null} onClick={() => { const q = rows[sel!]!.query; setFilterFavorites([q, ...filterFavorites().filter((x) => x !== q)].slice(0, 20)); notify('Added to favourites'); }}>Add To Favourites</button>
          <button class="btn" disabled={!rows.length} onClick={() => { store([]); setSel(null); }}>Clear</button>
        </>}
        <span class="spacer" /><button class="btn default" disabled={sel === null} onClick={() => apply()}>Apply</button><button class="btn" onClick={closeDialog}>Close</button>
      </>}>
      <Grid cols={kind === 'examples' ? [{ label: 'Example', width: '240px', get: (r: Row) => r.name }, { label: 'Query', get: (r) => r.query }] : [{ label: 'Query', get: (r: Row) => r.query }]}
        rows={rows} sel={sel} onSel={setSel} onOpen={apply} empty={kind === 'favorites' ? 'No favourites: SCH Filter › Favourites › Add To Favourites' : 'No queries yet'} />
    </Dialog>
  );
}
