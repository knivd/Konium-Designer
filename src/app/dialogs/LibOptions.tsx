import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { ColourDialog } from './Pickers';
import { notify, units } from '../state';
import type { SchLibEditor } from '../../editors/sch/SchLibEditor';
import type { PropertyBag } from '../../formats/altium/props';
import { SCH_UNIT, formatCoord, parseLength } from '../../core/units';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { rederive, schCoord, setSchCoord } from '../../model/sch';
import { bgrOf, fmtCoord, hexOf, parseCoord } from '../../model/schProps';
import type { Change } from '../../core/undo';
import { SHEET_STYLES } from './DocOptions';

/**
 * Tools › Document Options in the schematic library editor: Altium's Schematic Library Options
 * — Library Editor Options (style, size, orientation, border, hidden pins, custom size,
 * colours, grids) and Units. The settings live in the library's header, which every symbol's
 * view follows; OK is one undo step.
 */
export function LibOptionsDialog({ ed }: { ed: SchLibEditor }) {
  const h = ed.lib.header;
  const u = units.value;
  const len = (k: string, def: number) => fmtCoord(h.has(k) ? schCoord(h, k) : def, u);
  const [tab, setTab] = useState<'options' | 'units'>('options');
  const [f, setF] = useState(() => ({
    style: h.int('SHEETSTYLE'), titleStyle: h.int('DOCUMENTBORDERSTYLE'), portrait: h.int('WORKSPACEORIENTATION') === 1, border: h.has('BORDERON') ? h.bool('BORDERON') : true, hiddenPins: ed.showHiddenPins,
    custom: h.bool('USECUSTOMSHEET'), cw: len('CUSTOMX', 2000 * SCH_UNIT), ch: len('CUSTOMY', 2000 * SCH_UNIT),
    borderColour: hexOf(h.int('COLOR', 0)), workspace: hexOf(h.int('AREACOLOR', 16317695)),
    snapOn: h.has('SNAPGRIDON') ? h.bool('SNAPGRIDON') : true, snap: len('SNAPGRIDSIZE', 10 * SCH_UNIT),
    visibleOn: h.has('VISIBLEGRIDON') ? h.bool('VISIBLEGRIDON') : true, visible: len('VISIBLEGRIDSIZE', 10 * SCH_UNIT),
    unit: u,
  }));
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });

  const ok = () => {
    const edits: ((b: PropertyBag) => void)[] = [];
    const flag = (k: string, on: boolean, defOn: boolean) => { if (on !== (h.has(k) ? h.bool(k) : defOn)) edits.push((b) => b.set(k, on ? 'T' : 'F')); };
    const int = (k: string, v: number, def: number) => { if (v !== h.int(k, def)) edits.push((b) => { if (v) b.set(k, String(v)); else b.delete(k); }); };
    const coord = (k: string, v: string, def: number) => { const c = parseCoord(v, u); if (c !== undefined && c > 0 && c !== (h.has(k) ? schCoord(h, k) : def)) edits.push((b) => setSchCoord(b, k, c)); };
    int('SHEETSTYLE', f.style, 0);
    int('DOCUMENTBORDERSTYLE', f.titleStyle, 0);
    int('WORKSPACEORIENTATION', f.portrait ? 1 : 0, 0);
    flag('BORDERON', f.border, true);
    if (f.custom !== h.bool('USECUSTOMSHEET')) edits.push((b) => { if (f.custom) b.set('USECUSTOMSHEET', 'T'); else b.delete('USECUSTOMSHEET'); });
    if (f.custom) { coord('CUSTOMX', f.cw, 2000 * SCH_UNIT); coord('CUSTOMY', f.ch, 2000 * SCH_UNIT); }
    const bc = bgrOf(f.borderColour), wc = bgrOf(f.workspace);
    if (bc !== undefined && bc !== h.int('COLOR', 0)) edits.push((b) => b.set('COLOR', String(bc)));
    if (wc !== undefined && wc !== h.int('AREACOLOR', 16317695)) edits.push((b) => b.set('AREACOLOR', String(wc)));
    flag('SNAPGRIDON', f.snapOn, true); coord('SNAPGRIDSIZE', f.snap, 10 * SCH_UNIT);
    flag('VISIBLEGRIDON', f.visibleOn, true); coord('VISIBLEGRIDSIZE', f.visible, 10 * SCH_UNIT);
    closeDialog();
    ed.showHiddenPins = f.hiddenPins;
    if (f.unit !== units.value) units.value = f.unit;
    if (edits.length) ed.undo.transact('Library options', (tx) => tx.add(headerChange(ed, (b) => { for (const e of edits) e(b); })));
    ed.gridIndex = Math.max(0, ed.gridSizes().indexOf(ed.doc.sheet.snapGrid));
    ed.invalidate();
  };

  const check = (label: string, key: 'portrait' | 'border' | 'hiddenPins' | 'custom' | 'snapOn' | 'visibleOn') => (
    <label class="do-check"><input type="checkbox" checked={f[key]} onChange={(e) => set({ [key]: (e.target as HTMLInputElement).checked })} />{label}</label>
  );
  const text = (key: 'cw' | 'ch' | 'snap' | 'visible', disabled = false) => (
    <input type="text" value={f[key]} disabled={disabled} onInput={(e) => set({ [key]: (e.target as HTMLInputElement).value })} />
  );
  const colour = (label: string, key: 'borderColour' | 'workspace') => (
    <label class="do-row"><span>{label}</span><button class="dlg-colour" aria-label={label} onClick={() => showDialog(ColourDialog, { value: f[key], onOk: (v: string) => set({ [key]: v }) })}><span class="swatch" style={{ background: f[key] }} /></button></label>
  );
  return (
    <Dialog title="Schematic Library Options" width={640} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="libopts"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="dlg-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'options'} onClick={() => setTab('options')}>Library Editor Options</button>
        <button role="tab" aria-selected={tab === 'units'} onClick={() => setTab('units')}>Units</button>
      </div>
      {tab === 'options' ? (
        <div class="lo-grid">
          <fieldset><legend>Options</legend>
            <label class="do-row"><span>Style</span><select value={String(f.titleStyle)} aria-label="Style" onChange={(e) => set({ titleStyle: Number((e.target as HTMLSelectElement).value) })}>
              <option value="0">Standard</option><option value="1">ANSI</option></select></label>
            <label class="do-row"><span>Size</span><select value={String(f.style)} onChange={(e) => set({ style: Number((e.target as HTMLSelectElement).value) })}>
              {SHEET_STYLES.map((n, i) => <option key={n} value={String(i)}>{n}</option>)}
            </select></label>
            <label class="do-row"><span>Orientation</span><select value={f.portrait ? '1' : '0'} onChange={(e) => set({ portrait: (e.target as HTMLSelectElement).value === '1' })}>
              <option value="0">Landscape</option><option value="1">Portrait</option>
            </select></label>
            {check('Show Border', 'border')}
            {check('Show Hidden Pins', 'hiddenPins')}
          </fieldset>
          <fieldset><legend>Custom Size</legend>
            {check('Use Custom Size', 'custom')}
            <label class="do-row"><span>X</span>{text('cw', !f.custom)}</label>
            <label class="do-row"><span>Y</span>{text('ch', !f.custom)}</label>
          </fieldset>
          <fieldset><legend>Colours</legend>
            {colour('Border', 'borderColour')}
            {colour('Workspace', 'workspace')}
          </fieldset>
          <fieldset><legend>Grids</legend>
            <div class="do-row">{check('Snap', 'snapOn')}{text('snap', !f.snapOn)}</div>
            <div class="do-row">{check('Visible', 'visibleOn')}{text('visible', !f.visibleOn)}</div>
          </fieldset>
        </div>
      ) : (
        <fieldset><legend>Unit System</legend>
          <label class="al-opt"><input type="radio" name="lo-unit" checked={f.unit === 'mil'} onChange={() => set({ unit: 'mil' })} />Use Imperial Unit System (mils)</label>
          <label class="al-opt"><input type="radio" name="lo-unit" checked={f.unit === 'mm'} onChange={() => set({ unit: 'mm' })} />Use Metric Unit System (mm)</label>
        </fieldset>
      )}
    </Dialog>
  );
}

/** Change the library header, and every symbol view's sheet record with it. */
function headerChange(ed: SchLibEditor, edit: (b: PropertyBag) => void): Change {
  const lib = ed.lib;
  const before = lib.header.clone(), after = before.clone();
  edit(after);
  const views = [...lib.views.values()];
  const vb = views.map((v) => v.records[1]?.bag?.clone());
  const va = vb.map((b) => { if (!b) return b; const c = b.clone(); edit(c); return c; });
  const put = (h: PropertyBag, bags: (PropertyBag | undefined)[]) => {
    lib.header = h.clone();
    views.forEach((v, i) => { const r = v.records[1], b = bags[i]; if (r && b) { r.bag = b.clone(); rederive(v); } });
    ed.invalidate();
  };
  return { apply: () => put(after, va), revert: () => put(before, vb) };
}

/**
 * Tools › Library Options in the PCB library editor: Altium's Board Options — measurement unit,
 * snap grid and Snap To Grids, and a sheet (its place and size, shown or not, auto-sized round
 * the footprint), kept while the library is open [est]. A footprint has no designators to show
 * physical or logical, nor a route tool path, so those are left out.
 */
export function PcbLibOptionsDialog({ ed }: { ed: PcbEditor }) {
  const [unit, setUnit] = useState(units.value);
  const [grid, setGrid] = useState(() => formatCoord(ed.gridSize(), units.value));
  const [snapGrids, setSnapGrids] = useState(ed.snapGrids);
  const sh0 = ed.sheet();
  const [show, setShow] = useState(sh0.show), [auto, setAuto] = useState(sh0.auto), [lock, setLock] = useState(sh0.lock);
  const num = (c: number) => formatCoord(c, unit).replace(/[a-z]+$/, '');
  const [sx, setSx] = useState(num(sh0.rect.minX - ed.doc.board.origin.x)), [sy, setSy] = useState(num(sh0.rect.minY - ed.doc.board.origin.y));
  const [sw, setSw] = useState(num(sh0.rect.maxX - sh0.rect.minX)), [shh, setShh] = useState(num(sh0.rect.maxY - sh0.rect.minY));
  const len = (v: string) => parseLength(/^\s*-?[\d.]+\s*$/.test(v) ? `${v.trim()}${unit}` : v);
  const ok = () => {
    const g = len(grid), x = len(sx), y = len(sy), w = len(sw), h = len(shh);
    if (x === undefined || y === undefined || !w || !h || w <= 0 || h <= 0) { notify('Check the sheet\'s lengths: one of them isn\u2019t a length', 'error'); return; }
    closeDialog();
    if (unit !== units.value) units.value = unit;
    if (g && g > 0) ed.setGrid(g);
    ed.snapGrids = snapGrids;
    const o = ed.doc.board.origin;
    ed.sheetOverride = { show, auto, lock, rect: { minX: Math.round(x + o.x), minY: Math.round(y + o.y), maxX: Math.round(x + o.x + w), maxY: Math.round(y + o.y + h) } };
    ed.invalidate();
  };
  const row = (label: string, v: string, set: (s: string) => void) => (
    <label class="do-row"><span>{label}</span><input type="text" value={v} disabled={auto} aria-label={label} onInput={(e) => set((e.target as HTMLInputElement).value)} /></label>
  );
  return (
    <Dialog title={`Board Options [${unit}]`} width={560} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="libopts"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="lo-grid">
        <fieldset><legend>Measurement Unit</legend>
          <label class="do-row"><span>Unit</span><select value={unit} onChange={(e) => setUnit((e.target as HTMLSelectElement).value as typeof unit)}>
            <option value="mil">Imperial</option><option value="mm">Metric</option>
          </select></label>
        </fieldset>
        <fieldset><legend>Snap Options</legend>
          <label class="do-row"><span>Snap Grid</span><input type="text" value={grid} onInput={(e) => setGrid((e.target as HTMLInputElement).value)} /></label>
          <label class="do-check"><input type="checkbox" checked={snapGrids} onChange={() => setSnapGrids(!snapGrids)} />Snap To Grids</label>
        </fieldset>
        <fieldset><legend>Sheet Position</legend>
          {row(`X (${unit})`, sx, setSx)}{row(`Y (${unit})`, sy, setSy)}{row(`Width (${unit})`, sw, setSw)}{row(`Height (${unit})`, shh, setShh)}
          <label class="do-check"><input type="checkbox" checked={show} onChange={() => setShow(!show)} />Display Sheet</label>
          <label class="do-check" title="Round the footprint"><input type="checkbox" checked={auto} onChange={() => setAuto(!auto)} />Auto-size to linked layers</label>
          <label class="do-check"><input type="checkbox" checked={lock} onChange={() => setLock(!lock)} />Lock sheet primitives</label>
        </fieldset>
      </div>
    </Dialog>
  );
}
