import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { GridManagerDialog, GuideManagerDialog } from './GridManager';
import { linkedExtent, sheetOf } from '../../model/sheet';
import { notify, units } from '../state';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { mechEnabled, setBoardProps } from '../../model/pcbBoard';
import { routeToolLayer } from '../../model/routeToolPath';
import { isMech, layerName, mechLayer } from '../../model/layers';
import { formatAltiumLength, formatCoord, mil, parseLength } from '../../core/units';

const len = (v: string, u: string) => parseLength(/^\s*-?[\d.]+\s*$/.test(v) ? `${v.trim()}${u}` : v);

/**
 * Design › Board Options: Measurement Unit, Designator Display, Snap Options and Sheet Position,
 * kept in the Board6 record (DISPLAYUNIT 0 metric / 1 imperial, DESIGNATORDISPLAYMODE,
 * ELECTRICALGRID…, GRIDSNAPENABLED, MGSNAPENABLED (linear guides), POINTGUIDEENABLED,
 * OGSNAPENABLED (object axis), EGSNAPTOARCCENTERS, SHEET…). Route Tool Path names the mechanical
 * layer the router follows (KONIUMROUTETOOLLAYER; 3D Layout Mode mills the board along it);
 * Auto-size to linked layers fits the sheet round the layers linked to it (KONIUMSHEETAUTOSIZE)
 * and the Axis Snap Range is KONIUMAXISSNAPRANGE [est: AD17's keys for these aren't known].
 * Grids... and Guides... open the Grid Manager and the Guide Manager.
 */
export function BoardOptionsDialog({ ed }: { ed: PcbEditor }) {
  const b = ed.doc.board.bag;
  const raw = (k: string, d: number) => { const v = parseLength(b?.getRaw(k)); return v === undefined ? d : Math.round(v); };
  // The dialog shows its lengths in the unit chosen in it (the board's Measurement Unit), converting them when it changes
  const [unit, setUnitState] = useState<'mil' | 'mm'>(b?.has('DISPLAYUNIT') ? (b.int('DISPLAYUNIT') === 0 ? 'mm' : 'mil') : units.value === 'mm' ? 'mm' : 'mil');
  const u = unit;
  const f = (c: number, to: 'mil' | 'mm' = unit) => formatCoord(c, to).replace(/[a-z]+$/, '');
  const [logical, setLogical] = useState(b?.int('DESIGNATORDISPLAYMODE') === 1);
  const [hot, setHot] = useState(ed.hotspotSnap);
  const [allLayers, setAllLayers] = useState(ed.hotspotAllLayers);
  const [outline, setOutline] = useState(ed.hotspotBoardOutline);
  const [range, setRange] = useState(f(ed.hotspotRange));
  const [sx, setSx] = useState(f(raw('SHEETX', mil(1000)) - ed.doc.board.origin.x));
  const [sy, setSy] = useState(f(raw('SHEETY', mil(1000)) - ed.doc.board.origin.y));
  const [sw, setSw] = useState(f(raw('SHEETWIDTH', mil(10000))));
  const [sh, setSh] = useState(f(raw('SHEETHEIGHT', mil(8000))));
  const [show, setShow] = useState(b?.bool('SHOWSHEET') ?? false);
  const [lock, setLock] = useState(b?.bool('LOCKSHEET') ?? false);
  const [route, setRoute] = useState(String(routeToolLayer(ed.doc) ?? 0));
  const [auto, setAuto] = useState(sheetOf(ed.doc).auto);
  const [grids, setGrids] = useState(ed.snapGrids);
  const [linear, setLinear] = useState(ed.snapLinearGuides);
  const [points, setPoints] = useState(ed.snapPointGuides);
  const [axis, setAxis] = useState(ed.snapObjectAxis);
  const [arcs, setArcs] = useState(ed.hotspotArcCentres);
  const [axisRange, setAxisRange] = useState(f(ed.axisRange));
  // Auto-size: the sheet is what the linked layers cover (as long as they cover something)
  const extent = auto ? linkedExtent(ed.doc) : null;
  // The mechanical layers to choose from: those enabled, those in use, and the one chosen
  const usedMech = new Set<number>();
  for (const p of ed.doc.prims) if ('layer' in p && isMech(p.layer)) usedMech.add(p.layer);
  const mechs = Array.from({ length: 32 }, (_, i) => mechLayer(i + 1)).filter((l) => (mechEnabled(ed.doc)?.has(l) ?? false) || usedMech.has(l) || String(l) === route);
  const setUnit = (to: 'mil' | 'mm') => {
    if (to === unit) return;
    const conv = (v: string) => { const c = len(v, unit); return c === undefined ? v : f(Math.round(c), to); };
    setRange(conv(range)); setSx(conv(sx)); setSy(conv(sy)); setSw(conv(sw)); setSh(conv(sh)); setAxisRange(conv(axisRange));
    setUnitState(to);
  };
  const ok = () => {
    const r = len(range, u), x = len(sx, u), y = len(sy, u), w = len(sw, u), h = len(sh, u), ar = len(axisRange, u);
    if (r === undefined || r < 0 || ar === undefined || ar < 0 || x === undefined || y === undefined || !w || !h || w <= 0 || h <= 0) { notify('Check the lengths: one of them isn’t a length', 'error'); return false; }
    const tf = (v: boolean) => (v ? 'TRUE' : 'FALSE');
    const o = ed.doc.board.origin;
    if (b) ed.undo.transact('Board Options', (tx) => tx.add(setBoardProps(ed.doc, {
      DISPLAYUNIT: unit === 'mm' ? '0' : '1', DESIGNATORDISPLAYMODE: logical ? '1' : '0',
      ELECTRICALGRIDENABLED: tf(hot), ELECTRICALGRIDRANGE: formatAltiumLength(Math.round(r)), ELECTRICALGRIDUSEALLLAYERS: tf(allLayers), ELECTRICALGRIDSNAPTOBO: tf(outline),
      SHEETX: formatAltiumLength(Math.round(x + o.x)), SHEETY: formatAltiumLength(Math.round(y + o.y)), SHEETWIDTH: formatAltiumLength(Math.round(w)), SHEETHEIGHT: formatAltiumLength(Math.round(h)),
      SHOWSHEET: tf(show), LOCKSHEET: tf(lock), KONIUMROUTETOOLLAYER: route === '0' ? '' : route, KONIUMSHEETAUTOSIZE: tf(auto),
      GRIDSNAPENABLED: tf(grids), MGSNAPENABLED: tf(linear), POINTGUIDEENABLED: tf(points), OGSNAPENABLED: tf(axis), EGSNAPTOARCCENTERS: tf(arcs), KONIUMAXISSNAPRANGE: formatAltiumLength(Math.round(ar)),
    })));
    ed.readSnapOptions();
    if (!b) {
      ed.hotspotSnap = hot; ed.hotspotRange = Math.round(r); ed.hotspotAllLayers = allLayers; ed.hotspotBoardOutline = outline;
      ed.snapGrids = grids; ed.snapLinearGuides = linear; ed.snapPointGuides = points; ed.snapObjectAxis = axis; ed.hotspotArcCentres = arcs; ed.axisRange = Math.round(ar);
    }
    units.value = unit;
    ed.invalidate();
    closeDialog();
    return false;
  };
  const row = (label: string, v: string, set: (s: string) => void, dis = false) => (
    <label class="do-row"><span>{label}</span><input type="text" value={v} disabled={dis} onInput={(e) => set((e.target as HTMLInputElement).value)} /></label>
  );
  const check = (label: string, v: boolean, set: ((b: boolean) => void) | null, title?: string) => (
    <label class="do-check" title={title}><input type="checkbox" checked={v} disabled={!set} onChange={(e) => set?.((e.target as HTMLInputElement).checked)} />{label}</label>
  );
  return (
    <Dialog title={`Board Options [${u}]`} width={640} onClose={closeDialog} onAccept={ok} class="boardoptions"
      footer={<><button class="btn" onClick={() => showDialog(GridManagerDialog, { ed })}>Grids...</button><button class="btn" onClick={() => showDialog(GuideManagerDialog, { ed })}>Guides...</button>
        <span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="bo-cols">
        <div>
          <fieldset><legend>Measurement Unit</legend>
            <label class="do-row"><span>Unit</span><select value={unit} onChange={(e) => setUnit((e.target as HTMLSelectElement).value as 'mil' | 'mm')}>
              <option value="mil">Imperial</option><option value="mm">Metric</option></select></label>
          </fieldset>
          <fieldset><legend>Designator Display</legend>
            <select value={logical ? '1' : '0'} aria-label="Designator Display" onChange={(e) => setLogical((e.target as HTMLSelectElement).value === '1')}>
              <option value="0">Display Physical Designators</option><option value="1">Display Logical Designators</option></select>
          </fieldset>
          <fieldset><legend>Route Tool Path</legend>
            <label class="do-row"><span>Layer</span><select value={route} onChange={(e) => setRoute((e.target as HTMLSelectElement).value)}>
              <option value="0">Do not use</option>{mechs.map((l) => <option key={l} value={String(l)}>{ed.doc.board.layerNames.get(l) ?? layerName(l)}</option>)}</select></label>
          </fieldset>
          <fieldset><legend>Sheet Position</legend>
            {extent ? <>{row(`X (${u})`, f(extent.minX - ed.doc.board.origin.x), () => {}, true)}{row(`Y (${u})`, f(extent.minY - ed.doc.board.origin.y), () => {}, true)}
                {row(`Width (${u})`, f(extent.maxX - extent.minX), () => {}, true)}{row(`Height (${u})`, f(extent.maxY - extent.minY), () => {}, true)}</>
              : <>{row(`X (${u})`, sx, setSx)}{row(`Y (${u})`, sy, setSy)}{row(`Width (${u})`, sw, setSw)}{row(`Height (${u})`, sh, setSh)}</>}
            {check('Display Sheet', show, setShow)}
            {check('Auto-size to linked layers', auto, setAuto, 'The sheet round what lies on the mechanical layers linked to it (View Configurations › Linked To Sheet)')}
            {check('Lock sheet primitives', lock, setLock)}
          </fieldset>
        </div>
        <div>
          <fieldset><legend>Snap Options</legend>
            {check('Snap To Grids', grids, setGrids)}
            {check('Snap To Linear Guides', linear, setLinear)}
            {check('Snap To Point Guides', points, setPoints)}
            {check('Snap To Object Axis', axis, setAxis, 'Placing lines up with nearby objects\' hot spots across and down')}
            {check('Snap To Object Hotspots', hot, setHot)}
            {check('Snap On All Layers', allLayers, setAllLayers)}
            {check('Snap To Board Outline', outline, setOutline)}
            {check('Snap To Arc Centres', arcs, setArcs)}
            {row(`Snap Distance (${u})`, range, setRange)}
            {row(`Axis Snap Range (${u})`, axisRange, setAxisRange)}
          </fieldset>
        </div>
      </div>
    </Dialog>
  );
}
