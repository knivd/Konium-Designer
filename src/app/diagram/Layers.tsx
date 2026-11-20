/**
 * The Layers window: the page's layers, the front one first, each shown or hidden and locked or
 * not; the one picked takes new shapes. Add, rename (double-click), delete a layer, and move the
 * selection to another.
 */
import { useState } from 'preact/hooks';
import { addLayer, change, defaultLayer, layers, moveToLayer, removeCells, setLayer, type DiagramPage, type DrawioDocument } from '../../formats/drawio';

export function Layers({ d, page, sel, changed, onClose }: { d: DrawioDocument; page: DiagramPage; sel: Set<string>; changed: () => void; onClose: () => void }) {
  const [naming, setNaming] = useState<string | null>(null);
  const list = layers(page);
  const current = defaultLayer(page);
  const edit = (label: string, fn: () => void) => { change(d, label, fn, page); changed(); };
  return (
    <div class="dg-layers" role="dialog" aria-label="Layers">
      <div class="dg-layers-head"><span>Layers</span><button type="button" class="dg-x" aria-label="Close Layers" title="Close" onClick={onClose}>×</button></div>
      <ul class="dg-layer-list">
        {[...list].reverse().map((l) => (
          <li key={l.id} class={`dg-layer${l.id === current ? ' on' : ''}`} onClick={() => { page.current = l.id; changed(); }} aria-current={l.id === current || undefined}>
            <label title={l.visible ? 'Hide' : 'Show'} class="dg-eye"><input type="checkbox" aria-label={`${l.name} shown`} checked={l.visible} onClick={(e) => e.stopPropagation()} onChange={() => edit(l.visible ? 'Hide Layer' : 'Show Layer', () => setLayer(page, l.id, 'visible', !l.visible))} />Show</label>
            <label title={l.locked ? 'Unlock' : 'Lock'} class="dg-lock"><input type="checkbox" aria-label={`${l.name} locked`} checked={l.locked} onClick={(e) => e.stopPropagation()} onChange={() => edit(l.locked ? 'Unlock Layer' : 'Lock Layer', () => setLayer(page, l.id, 'locked', !l.locked))} />Lock</label>
            {naming === l.id
              ? <input class="dg-layer-name" aria-label="Layer name" value={l.name} ref={(el) => el?.focus()} onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setNaming(null); }}
                onBlur={(e) => { const v = (e.target as HTMLInputElement).value.trim(); setNaming(null); if (v && v !== l.name) edit('Rename Layer', () => setLayer(page, l.id, 'name', v)); }} />
              : <span class="dg-layer-name" title="Double-click to rename" onDblClick={() => setNaming(l.id)}>{l.name}</span>}
          </li>
        ))}
      </ul>
      <div class="dg-buttons">
        <button type="button" class="btn" onClick={() => { let id = ''; edit('Add Layer', () => { id = addLayer(page, `Layer ${list.length}`); }); page.current = id; changed(); }}>Add Layer</button>
        <button type="button" class="btn" disabled={list.length < 2} title="The layer picked, and everything on it" onClick={() => { edit('Delete Layer', () => removeCells(page, new Set([current]))); page.current = undefined; changed(); }}>Delete</button>
      </div>
      <label class="dg-num">Move selection to
        <select aria-label="Move selection to" disabled={!sel.size} value="" onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) edit('Move to Layer', () => moveToLayer(page, sel, v)); }}>
          <option value="">…</option>
          {list.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
    </div>
  );
}
