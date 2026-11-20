/**
 * Double-click a free region: AD17's Region dialog. Graphical: its picture, then Locked, Kind
 * (Copper, Polygon Cutout, Board Cutout, Cavity Definition [est: AD17's list]), Layer, Net and the
 * mask expansions; Outline Vertices: each vertex, X and Y as typed (a rounded corner of a
 * shape-based region shown with its arc, moved only with it).
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import type { PcbRegion } from '../../model/pcb';
import { L, isSignal, type LayerId } from '../../model/layers';
import { REGION, get, put } from '../../formats/altium/pcbLayouts';
import { layerToName } from '../../formats/altium/pcbdoc';
import { readRegionParts, writeRegionParts, type RegionParts } from '../../formats/altium/regionRecord';
import { Check, CoordInput, LayerSelect, MaskChooser, NetSelect, Row, fmtLen, lockedOf, unitTitle, useRecord, withLocked, type RecordTarget } from './pcbFields';

type Kind = 'copper' | 'cutout' | 'board' | 'cavity';
const KINDS: [Kind, string][] = [['copper', 'Copper'], ['cutout', 'Polygon Cutout'], ['board', 'Board Cutout'], ['cavity', 'Cavity Definition']];
const kindOf = (p: RegionParts): Kind => (p.props.bool('ISBOARDCUTOUT') ? 'board' : p.props.int('KIND') === 1 ? 'cutout' : p.props.int('KIND') === 4 ? 'cavity' : 'copper');

export function RegionDialog({ ed, prim, target }: { ed: PcbEditor; prim: PcbRegion; target?: RecordTarget }) {
  const r = useRecord(ed, prim, target);
  const [parts] = useState(() => readRegionParts(prim.src.storage, r.subs[0]!));
  const [tab, setTab] = useState<'graphical' | 'vertices'>('graphical');
  const s = r.at(0);
  const kind = kindOf(parts);
  const setKind = (k: Kind) => {
    parts.props.set('KIND', String(k === 'cutout' ? 1 : k === 'cavity' ? 4 : 0));
    if (k === 'board') parts.props.set('ISBOARDCUTOUT', 'TRUE'); else if (parts.props.has('ISBOARDCUTOUT')) parts.props.set('ISBOARDCUTOUT', 'FALSE');
    if (k !== 'copper') put(s.bytes, REGION.net, 0xffff);
    r.bump();
  };
  const layer = (s.get(REGION.layer) || prim.layer) as LayerId;
  const setLayer = (l: LayerId) => { put(s.bytes, REGION.layer, l <= 82 ? l : 0); parts.props.set('V7_LAYER', layerToName(l)); r.bump(); };
  const layers = kind === 'board' ? [L.MULTI] : [...new Set([...ed.doc.board.copperStack.filter(isSignal), ...ed.layers().filter((l) => l !== L.MULTI)])];
  const ok = () => {
    r.commit('Region properties', !parts.shapeBased, (after) => { const head = after.subs[0]!.slice(0, REGION.propsAt); after.subs[0] = writeRegionParts({ ...parts, head }); });
    closeDialog();
  };
  const moveVertex = (i: number, axis: 'x' | 'y', v: number) => {
    const p = parts.verts[i]!;
    const d = v - p[axis];
    p[axis] = v;
    if (p.arc) { if (axis === 'x') p.arc.cx += d; else p.arc.cy += d; }
    r.bump();
  };
  return (
    <Dialog title={unitTitle(ed, 'Region')} width={540} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="pd regiondlg"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="pd-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'graphical'} class={tab === 'graphical' ? 'on' : ''} onClick={() => setTab('graphical')}>Graphical</button>
        <button role="tab" aria-selected={tab === 'vertices'} class={tab === 'vertices' ? 'on' : ''} onClick={() => setTab('vertices')}>Outline Vertices</button>
      </div>
      {tab === 'graphical' ? <div class="pd-region">
        <svg viewBox="0 0 400 240" class="pd-region-pic" aria-hidden="true">
          <path d="M70 30 H330 V230 H210 V160 H70 Z" transform="translate(0 -14)" fill="#f2c443" stroke="#a37b22" stroke-width="1.5" stroke-linejoin="round" />
        </svg>
        <fieldset class="pd-group"><legend>Properties</legend>
          <Check label="Locked" checked={lockedOf(s.get(REGION.flags1))} onChange={(v) => s.set(REGION.flags1, withLocked(s.get(REGION.flags1), v))} />
          <Row label="Kind"><select aria-label="Kind" value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value as Kind)}>
            {KINDS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
          </select></Row>
          <Row label="Layer"><LayerSelect ed={ed} value={kind === 'board' ? L.MULTI : layer} layers={layers} disabled={kind === 'board'} onChange={setLayer} /></Row>
          <Row label="Net"><NetSelect ed={ed} value={get(s.bytes, REGION.net) ?? 0xffff} disabled={kind !== 'copper'} onChange={(n) => s.set(REGION.net, n)} /></Row>
          {/* Shape-based regions' entries [est: not known how AD numbers them]: left as they are */}
          <MaskChooser ed={ed} label="Solder Mask Expansion" disabled={parts.shapeBased} value={r.masks.solder} onChange={(m) => r.setMasks({ ...r.masks, solder: m })} />
          <MaskChooser ed={ed} label="Paste Mask Expansion" disabled={parts.shapeBased} value={r.masks.paste} onChange={(m) => r.setMasks({ ...r.masks, paste: m })} />
        </fieldset>
      </div> : (
        <div class="grid poly-verts" style={{ '--cols': '40px 70px 1fr 1fr 1.4fr' } as Record<string, string>}>
          <div class="grid-row grid-head"><span>#</span><span>Kind</span><span>X</span><span>Y</span><span>Arc</span></div>
          <div class="grid-body">
            {parts.verts.map((v, i) => (
              <div key={i} class="grid-row">
                <span>{i}</span><span>{v.arc ? 'Arc' : 'Line'}</span>
                <span><CoordInput ed={ed} axis="x" label={`Vertex ${i} X`} value={Math.round(v.x)} onChange={(c) => moveVertex(i, 'x', c)} /></span>
                <span><CoordInput ed={ed} axis="y" label={`Vertex ${i} Y`} value={Math.round(v.y)} onChange={(c) => moveVertex(i, 'y', c)} /></span>
                <span class="muted">{v.arc ? `r ${fmtLen(ed, v.arc.r)}  ${+v.arc.a1.toFixed(3)}° – ${+v.arc.a2.toFixed(3)}°` : ''}</span>
              </div>
            ))}
            {parts.holes.length > 0 && <div class="grid-row muted"><span /><span>Holes</span><span>{parts.holes.length}</span><span /><span>kept as they are</span></div>}
          </div>
        </div>
      )}
    </Dialog>
  );
}
