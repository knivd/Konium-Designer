import { locale } from '../../core/locale';
import { useState } from 'preact/hooks';
import { pourOverOf } from '../../formats/altium/polygonProps';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { PolygonDialog } from './Polygon';
import { tick, units } from '../state';
import { netName } from '../../model/pcb';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import type { PropertyBag } from '../../formats/altium/props';

/**
 * Tools › Polygon Pours › Polygon Manager: every pour on the board with its layer, net, fill
 * mode and state; repour, shelve, restore, edit or delete the selected ones, or zoom to them.
 */
export function PolygonManagerDialog({ ed }: { ed: PcbEditor }) {
  void tick.value;
  const [sel, setSel] = useState<Set<number>>(() => new Set(ed.selectedPolygons()));
  const [, setRev] = useState(0);
  const refresh = () => { setRev((n) => n + 1); tick.value++; };
  const polys = ed.doc.polygons;
  const chosen = [...sel].filter((i) => polys[i]);
  const u = units.value;
  const area = (i: number) => {
    const o = polys[i]!.outline;
    const a = Math.abs(o.reduce((s, v, k) => { const n = o[(k + 1) % o.length]!; return s + v.x * n.y - n.x * v.y; }, 0) / 2);
    return u === 'mil' ? `${Math.round(a / 1e8).toLocaleString(locale())} sq mil` : `${(a / 1e8 * 0.00064516).toFixed(2)} sq mm`;
  };
  const copper = new Map<number, number>();
  for (const p of ed.doc.prims) if ('polygon' in p && p.polygon !== 0xffff) copper.set(p.polygon, (copper.get(p.polygon) ?? 0) + 1);
  const mode = (b: PropertyBag) => { const h = b.get('HATCHSTYLE') ?? 'Solid'; return h === 'Solid' ? 'Solid' : h === 'None' ? 'None' : `Hatched (${h.replace('Degree', '°')})`; };
  const pick = (i: number, e: MouseEvent) => {
    const n = new Set(e.ctrlKey || e.metaKey ? sel : []);
    if ((e.ctrlKey || e.metaKey) && n.has(i)) n.delete(i); else n.add(i);
    setSel(n);
    ed.select([...n].map((k) => `poly:${k}`));
  };
  const zoom = () => { ed.select(chosen.map((k) => `poly:${k}`)); ed.fitSelection(); };
  const edit = (i: number) => {
    const p = polys[i]!;
    showDialog(PolygonDialog, { doc: ed.doc, units: u, bag: p.bag, title: `Polygon Pour [${p.name}]`, onOk: (b: PropertyBag) => { ed.updatePolygon(i, b); refresh(); } });
  };
  const del = () => {
    ed.select(chosen.map((k) => `poly:${k}`));
    ed.deleteSelection();
    setSel(new Set());
    refresh();
  };
  return (
    <Dialog title="Polygon Pour Manager" width={900} height={460} onClose={closeDialog} class="polymgr"
      footer={<>
        <button class="btn" disabled={!chosen.length} onClick={() => { ed.repourPolygons(chosen); refresh(); }}>Repour Selected</button>
        <button class="btn" disabled={!polys.length} onClick={() => { ed.repourPolygons(); refresh(); }}>Repour All</button>
        <button class="btn" disabled={!chosen.length} onClick={() => { ed.shelvePolygons(chosen, true); refresh(); }}>Shelve</button>
        <button class="btn" disabled={!chosen.length} onClick={() => { ed.shelvePolygons(chosen, false); refresh(); }}>Restore</button>
        <button class="btn" disabled={chosen.length !== 1} onClick={() => edit(chosen[0]!)}>Properties...</button>
        <button class="btn" disabled={!chosen.length} onClick={del}>Delete</button>
        <button class="btn" disabled={!chosen.length} onClick={zoom}>Zoom Selected</button>
        <span class="spacer" />
        <button class="btn default" onClick={closeDialog}>Close</button>
      </>}>
      <div class="grid" style={{ '--cols': '28px minmax(140px, 1.3fr) 110px 100px 130px 150px 70px 110px 70px' } as Record<string, string>}>
        <div class="grid-row grid-head"><span>#</span><span>Name</span><span>Layer</span><span>Net</span><span>Fill Mode</span><span>Pour Over</span><span>State</span><span>Area</span><span>Copper</span></div>
        <div class="grid-body">
          {!polys.length && <p class="grid-empty">No polygon pours. Place › Polygon Pour (P, G) adds one.</p>}
          {polys.map((p) => (
            <div key={p.index} class={`grid-row${sel.has(p.index) ? ' on' : ''}`} onClick={(e) => pick(p.index, e as unknown as MouseEvent)} onDblClick={() => edit(p.index)}>
              <span>{p.index}</span>
              <span>{p.name}</span>
              <span>{ed.layerLabel(p.layer)}</span>
              <span>{netName(ed.doc, p.net)}</span>
              <span>{mode(p.bag)}</span>
              <span>{({ SameNet: 'All same-net objects', SameNetPolygon: 'Same-net polygons', None: "Don't pour over" } as Record<string, string>)[pourOverOf(p.bag)]}</span>
              <span>{p.bag.bool('SHELVED') ? 'Shelved' : p.bag.bool('LOCKED') ? 'Locked' : 'Poured'}</span>
              <span>{area(p.index)}</span>
              <span>{copper.get(p.index) ?? 0}</span>
            </div>
          ))}
        </div>
      </div>
      <p class="small muted">Click selects (Ctrl+click adds); double-click opens the pour's properties. Shelved pours keep their outline and no copper until restored.</p>
    </Dialog>
  );
}
