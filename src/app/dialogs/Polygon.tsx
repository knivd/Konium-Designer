import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { formatAltiumLength, formatCoord, parseLength, type DisplayUnit } from '../../core/units';
import { isSignal, layerName } from '../../model/layers';
import { layerToName } from '../../formats/altium/pcbdoc';
import { PropertyBag } from '../../formats/altium/props';
import { islandAreaOf, newPolygonProps, polygonName, pourOverOf, setIslandArea, setPolygonName, setPourOver, type PourOver } from '../../formats/altium/polygonProps';
import type { PcbDocument } from '../../model/pcb';

/**
 * The Polygon Pour dialog (Place › Polygon Pour, or double-click a pour): Fill Mode (Solid /
 * Hatched / None), Properties (Name, Layer, Min Prim Length, Lock Primitives), Net Options
 * (Connect to Net, pour-over behaviour, Remove Dead Copper) and the fill mode's settings.
 */
export interface PolygonDialogProps {
  doc: PcbDocument;
  units: DisplayUnit;
  bag: PropertyBag;
  title?: string;
  onOk: (bag: PropertyBag) => void;
}

/** The automatic name of a new pour: net, layer and number ("GND_L2_P000"). */
export const autoPolygonName = (doc: PcbDocument, layer: number, net: number, n = doc.polygons.length) =>
  `${net === 0xffff ? 'NoNet' : doc.nets[net]?.name ?? 'NoNet'}_L${layer === 32 ? 2 : layer}_P${String(n).padStart(3, '0')}`;

export function newPolygonBag(doc: PcbDocument, layer: number, net: number): PropertyBag {
  const n = doc.polygons.length;
  return newPolygonProps(layerToName(layer), net, autoPolygonName(doc, layer, net, n), n, true);
}

export function PolygonDialog({ doc, units: u, bag: src, onOk }: PolygonDialogProps) {
  const [b] = useState(() => src.clone());
  const [, setRev] = useState(0);
  const [tab, setTab] = useState<'graphical' | 'vertices'>('graphical');
  const bump = () => setRev((n) => n + 1);
  const set = (k: string, v: string) => { b.set(k, v); bump(); };
  const tf = (v: boolean) => (v ? 'TRUE' : 'FALSE');
  const hatch = (b.get('HATCHSTYLE') ?? 'Solid');
  const mode = hatch === 'Solid' ? 'solid' : hatch === 'None' ? 'none' : 'hatched';
  const lenField = (key: string, def: string, label: string, disabled = false) => {
    const v = parseLength(b.get(key)) ?? parseLength(def)!;
    return (
      <input type="text" class="pd-val" aria-label={label} disabled={disabled} value={formatCoord(v, u, u === 'mil' ? 3 : 4)}
        onChange={(e) => { const t = (e.target as HTMLInputElement).value.trim(); const c = parseLength(/^-?[0-9.]+$/.test(t) ? `${t}${u}` : t); if (c !== undefined) set(key, formatAltiumLength(c)); }}
        onKeyDown={(e) => e.stopPropagation()} />
    );
  };
  const layers = doc.board.copperStack.filter(isSignal);
  const nets = [...doc.nets].sort((a, c) => a.name.localeCompare(c.name, undefined, { numeric: true }));
  const layerId = layers.find((l) => layerToName(l) === (b.get('LAYER') ?? 'TOP')) ?? layers[0]!;
  const net = Number(b.get('NET') ?? 65535);
  const auto = autoPolygonName(doc, layerId, net, Number(b.get('POURINDEX') ?? doc.polygons.length));
  const isAuto = polygonName(b) === auto;
  // Island area: sq. mils in the file, sq. mms when working in millimetres
  const sqmm = u === 'mm';
  const area = islandAreaOf(b) * (sqmm ? 0.00064516 : 1);
  const ok = () => { onOk(b); closeDialog(); };
  return (
    <Dialog title={`Polygon Pour [${u}]`} width={760} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="polydlg pd"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="pd-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'graphical'} class={tab === 'graphical' ? 'on' : ''} onClick={() => setTab('graphical')}>Graphical</button>
        <button role="tab" aria-selected={tab === 'vertices'} class={tab === 'vertices' ? 'on' : ''} onClick={() => setTab('vertices')}>Outline Vertices</button>
      </div>
      {tab === 'vertices' ? <OutlineVertices b={b} u={u} bump={bump} /> : <>
        <fieldset class="poly-mode"><legend>Fill Mode</legend>
          {([['solid', 'Solid (Copper Regions)'], ['hatched', 'Hatched (Tracks/Arcs)'], ['none', 'None (Outlines Only)']] as const).map(([m, l]) => (
            <label key={m}><input type="radio" name="pm" checked={mode === m} onChange={() => set('HATCHSTYLE', m === 'solid' ? 'Solid' : m === 'none' ? 'None' : '90Degree')} />{l}</label>
          ))}
        </fieldset>
        <div class="poly-figure">
          <PourPicture mode={mode} />
          <div class="poly-callouts">
            {mode === 'solid' && <>
              <div><b>Remove Islands Less Than</b>
                <span class="poly-inline"><input type="text" class="pd-val" aria-label="Island area" value={String(+area.toFixed(3))} onKeyDown={(e) => e.stopPropagation()}
                  onChange={(e) => { const v = Number((e.target as HTMLInputElement).value); if (v >= 0) { setIslandArea(b, sqmm ? v / 0.00064516 : v); bump(); } }} /> ({sqmm ? 'sq. mms' : 'sq. mils'}) In Area
                  <input type="checkbox" aria-label="Remove islands" checked={b.bool('REMOVEISLANDSBYAREA')} onChange={(e) => set('REMOVEISLANDSBYAREA', tf((e.target as HTMLInputElement).checked))} /></span></div>
              <div><b>Arc Approximation</b><span class="muted">Maximum Deviation From Perfect Arc</span> {lenField('ARCRESOLUTION', '0.5mil', 'Arc approximation')}</div>
              <div><b>Remove Necks When Copper Width Less Than</b>
                <span class="poly-inline">{lenField('NECKWIDTHTHRESHOLD', '5mil', 'Neck width')}<input type="checkbox" aria-label="Remove necks" checked={b.bool('REMOVENECKS')} onChange={(e) => set('REMOVENECKS', tf((e.target as HTMLInputElement).checked))} /></span></div>
            </>}
            {mode !== 'solid' && <>
              <div><b>Track Width</b> {lenField('TRACKWIDTH', '8mil', 'Track width')}</div>
              {mode === 'hatched' && <div><b>Grid Size</b> {lenField('GRIDSIZE', '20mil', 'Grid size')}</div>}
              <div><b>Surround Pads With</b>
                <span class="poly-inline">{([['arc', 'Arcs'], ['oct', 'Octagons']] as const).map(([k, n]) => (
                  <label key={k}><input type="radio" name="poly-surround" checked={(b.bool('USEOCTAGONS') ? 'oct' : 'arc') === k} onChange={() => set('USEOCTAGONS', tf(k === 'oct'))} /> {n}</label>))}</span></div>
              {mode === 'hatched' && <div><b>Hatch Mode</b>
                <span class="poly-inline">{([['90Degree', '90 Degree'], ['45Degree', '45 Degree'], ['Horizontal', 'Horizontal'], ['Vertical', 'Vertical']] as const).map(([k, n]) => (
                  <label key={k}><input type="radio" name="poly-hatch" checked={hatch === k} onChange={() => set('HATCHSTYLE', k)} /> {n}</label>))}</span></div>}
            </>}
          </div>
        </div>
        <div class="pd-two">
          <fieldset class="pd-group"><legend>Properties</legend>
            <div class="pd-row"><label class="pd-label" for="poly-name">Name</label><div class="pd-field">
              <input type="text" id="poly-name" value={polygonName(b)} disabled={isAuto} onChange={(e) => { setPolygonName(b, (e.target as HTMLInputElement).value); bump(); }} onKeyDown={(e) => e.stopPropagation()} /></div></div>
            <label class="pd-check poly-auto"><input type="checkbox" checked={isAuto} onChange={(e) => { if ((e.target as HTMLInputElement).checked) { setPolygonName(b, auto); bump(); } else { setPolygonName(b, polygonName(b) === auto ? `${auto}_1` : polygonName(b)); bump(); } }} /><span>Auto Naming</span></label>
            <div class="pd-row"><span class="pd-label">Layer</span><div class="pd-field">
              <select aria-label="Layer" value={b.get('LAYER') ?? 'TOP'} onChange={(e) => { const wasAuto = isAuto; set('LAYER', (e.target as HTMLSelectElement).value); if (wasAuto) { const l = layers.find((x) => layerToName(x) === b.get('LAYER')) ?? layerId; setPolygonName(b, autoPolygonName(doc, l, net, Number(b.get('POURINDEX') ?? doc.polygons.length))); bump(); } }}>
                {layers.map((l) => <option key={l} value={layerToName(l)}>{doc.board.layerNames.get(l) ?? layerName(l)}</option>)}
              </select></div></div>
            <div class="pd-row"><span class="pd-label">Min Prim Length</span><div class="pd-field">{lenField('MINPRIMLENGTH', '3mil', 'Min Prim Length', mode === 'solid')}</div></div>
            <label class="pd-check"><span>Lock Primitives</span><input type="checkbox" checked={b.bool('PRIMITIVELOCK')} onChange={(e) => set('PRIMITIVELOCK', tf((e.target as HTMLInputElement).checked))} /></label>
            <label class="pd-check"><span>Locked</span><input type="checkbox" checked={b.bool('LOCKED')} onChange={(e) => set('LOCKED', tf((e.target as HTMLInputElement).checked))} /></label>
            <label class="pd-check"><span>Ignore On-Line Violations</span><input type="checkbox" checked={b.bool('IGNOREVIOLATIONS')} onChange={(e) => set('IGNOREVIOLATIONS', tf((e.target as HTMLInputElement).checked))} /></label>
          </fieldset>
          <fieldset class="pd-group"><legend>Net Options</legend>
            <div class="pd-row"><span class="pd-label">Connect to Net</span><div class="pd-field">
              <select aria-label="Connect to Net" value={b.get('NET') ?? '65535'} onChange={(e) => { const wasAuto = isAuto; set('NET', (e.target as HTMLSelectElement).value); if (wasAuto) { setPolygonName(b, autoPolygonName(doc, layerId, Number(b.get('NET')), Number(b.get('POURINDEX') ?? doc.polygons.length))); bump(); } }}>
                <option value="65535">No Net</option>
                {nets.map((n) => <option key={n.index} value={String(n.index)}>{n.name}</option>)}
              </select></div></div>
            <select aria-label="Pour over" value={pourOverOf(b)} onChange={(e) => { setPourOver(b, (e.target as HTMLSelectElement).value as PourOver); bump(); }}>
              <option value="SameNetPolygon">Pour Over Same Net Polygons Only</option>
              <option value="SameNet">Pour Over All Same Net Objects</option>
              <option value="None">Don't Pour Over Same Net Objects</option>
            </select>
            <label class="pd-check"><span>Remove Dead Copper</span><input type="checkbox" checked={b.has('REMOVEDEAD') ? b.bool('REMOVEDEAD') : true} onChange={(e) => set('REMOVEDEAD', tf((e.target as HTMLInputElement).checked))} /></label>
          </fieldset>
        </div>
      </>}
    </Dialog>
  );
}

/** Outline Vertices: each vertex of the pour's outline (an arc's centre and angles shown as they are). */
function OutlineVertices({ b, u, bump }: { b: PropertyBag; u: DisplayUnit; bump: () => void }) {
  const rows: number[] = [];
  for (let i = 0; b.has(`VX${i}`); i++) rows.push(i);
  const fmt = (k: string) => formatCoord(parseLength(b.get(k)) ?? 0, u, u === 'mil' ? 3 : 4);
  const edit = (i: number, axis: 'X' | 'Y', t: string) => {
    const c = parseLength(/^-?[0-9.]+$/.test(t.trim()) ? `${t.trim()}${u}` : t.trim());
    if (c === undefined) return;
    const last = rows.at(-1)!;
    // The closing vertex repeats the first: it moves with it
    const closes = i === 0 && last > 0 && b.get(`VX${last}`) === b.get('VX0') && b.get(`VY${last}`) === b.get('VY0');
    b.set(`V${axis}${i}`, formatAltiumLength(c));
    if (closes) b.set(`V${axis}${last}`, formatAltiumLength(c));
    bump();
  };
  return (
    <div class="grid poly-verts" style={{ '--cols': '40px 70px 1fr 1fr 1fr' } as Record<string, string>}>
      <div class="grid-row grid-head"><span>#</span><span>Kind</span><span>X</span><span>Y</span><span>Arc</span></div>
      <div class="grid-body">
        {rows.map((i) => {
          const arc = b.get(`KIND${i}`) === '1';
          return (
            <div key={i} class="grid-row">
              <span>{i}</span><span>{arc ? 'Arc' : 'Line'}</span>
              <span><input type="text" aria-label={`Vertex ${i} X`} value={fmt(`VX${i}`)} onChange={(e) => edit(i, 'X', (e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /></span>
              <span><input type="text" aria-label={`Vertex ${i} Y`} value={fmt(`VY${i}`)} onChange={(e) => edit(i, 'Y', (e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /></span>
              <span class="muted">{arc ? `centre ${fmt(`CX${i}`)}, ${fmt(`CY${i}`)}  r ${fmt(`R${i}`)}  ${b.get(`SA${i}`)}° – ${b.get(`EA${i}`)}°` : ''}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A pour drawn small, the way each fill mode makes its copper (Konium's drawing). */
function PourPicture({ mode }: { mode: 'solid' | 'hatched' | 'none' }) {
  const copper = '#f2c443', edge = '#a37b22', call = '#3d8fc4';
  return (
    <svg viewBox="0 0 320 180" class="poly-pic" aria-hidden="true">
      <defs><pattern id="ph" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M0 0 H10 M0 0 V10" stroke={copper} stroke-width="3" /></pattern></defs>
      {mode !== 'none' && <rect x="10" y="10" width="300" height="120" rx="6" fill={mode === 'solid' ? copper : 'url(#ph)'} stroke={edge} />}
      {mode === 'none' && <rect x="10" y="10" width="300" height="120" rx="6" fill="none" stroke={copper} stroke-width="3" />}
      <rect x="40" y="40" width="26" height="70" rx="4" fill="#fff" stroke={edge} />
      <rect x="44" y="44" width="18" height="62" rx="3" fill={copper} />
      <circle cx="150" cy="70" r="24" fill="#fff" stroke={edge} /><circle cx="150" cy="70" r="15" fill={copper} stroke={edge} /><circle cx="150" cy="70" r="6" fill="#fff" />
      <circle cx="240" cy="70" r="24" fill="#fff" stroke={edge} />
      {[0, 90, 180, 270].map((a) => <rect key={a} x="236" y="44" width="8" height="12" fill={copper} transform={`rotate(${a} 240 70)`} />)}
      <circle cx="240" cy="70" r="13" fill={copper} stroke={edge} /><circle cx="240" cy="70" r="5" fill="#fff" />
      {Array.from({ length: 7 }, (_, i) => <rect key={i} x={30 + i * 40} y="140" width="18" height="34" rx="3" fill={copper} stroke={edge} />)}
      <circle cx="80" cy="25" r="10" fill="none" stroke={call} stroke-dasharray="2 2" />
      <line x1="130" y1="70" x2="175" y2="70" stroke={call} />
      <rect x="20" y="128" width="280" height="10" fill="none" stroke={call} stroke-dasharray="2 2" />
    </svg>
  );
}
