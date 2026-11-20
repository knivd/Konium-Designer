/**
 * The default of each kind of board object, edited in the object's own AD17 dialog: Tab while
 * placing (the next ones start from it; kept as the default unless Preferences › Defaults ›
 * Permanent), and Preferences › PCB Editor › Defaults › Edit Values.
 */
import { showDialog } from './index';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { mil } from '../../core/units';
import { L } from '../../model/layers';
import { decodePrim, encodeArc, encodeFill, encodePad, encodeRegion, encodeText, encodeTrack, encodeVia } from '../../formats/altium/pcbdoc';
import type { PcbRawRecord } from '../../formats/altium/framing';
import { PAD, TEXT, VIA, get, put, setViaDiameter } from '../../formats/altium/pcbLayouts';
import { viaSize } from '../../editors/pcb/PcbPlaceTools';
import { primDefault, setSavedDefault, setTabDefault, type DefaultStorage } from '../../model/pcbDefaults';
import { settings } from '../../core/settings';
import { ArcDialog, FillDialog, StringDialog, TrackDialog, ViaDialog } from './PrimDialogs';
import { PadDialog } from './PadDialog';
import { RegionDialog } from './RegionDialog';
import type { RecordTarget } from './pcbFields';

/** AD17's own defaults [est: sizes from its Preferences › Defaults as shipped]. */
export function factoryDefault(storage: DefaultStorage): PcbRawRecord {
  const o = { x: 0, y: 0 };
  switch (storage) {
    case 'Tracks6': return encodeTrack({ layer: L.TOP, a: o, b: { x: mil(100), y: 0 }, width: mil(10) });
    case 'Arcs6': return encodeArc({ layer: L.TOP, c: o, r: mil(50), start: 0, end: 90, width: mil(10) });
    case 'Vias6': return encodeVia({ at: o, diameter: mil(50), hole: mil(28) });
    case 'Pads6': return encodePad({ name: '1', layer: L.MULTI, at: o, w: mil(60), h: mil(60), shape: 'round', hole: mil(30) });
    case 'Texts6': return encodeText({ layer: L.TOP_OVERLAY, at: o, height: mil(60), text: 'String', strokeWidth: mil(10) });
    case 'Fills6': return encodeFill({ layer: L.TOP, a: o, b: { x: mil(100), y: mil(100) } });
    case 'Regions6': return encodeRegion({ layer: L.TOP, outline: [o, { x: mil(100), y: 0 }, { x: mil(100), y: mil(100) }, { x: 0, y: mil(100) }] });
  }
}

/** The record the next object of this kind starts from (the default, else AD17's). */
export const currentDefault = (storage: DefaultStorage): PcbRawRecord => primDefault(storage) ?? factoryDefault(storage);

const DIALOGS: Record<DefaultStorage, unknown> = {
  Arcs6: ArcDialog, Fills6: FillDialog, Pads6: PadDialog, Texts6: StringDialog, Tracks6: TrackDialog, Vias6: ViaDialog, Regions6: RegionDialog,
};

/** Open the kind's dialog on its default; OK keeps it (Tab: for this session at least; else saved) and calls `after`. */
export function editDefault(ed: PcbEditor, storage: DefaultStorage, how: 'tab' | 'saved', after?: (rec: PcbRawRecord) => void, prepare?: (rec: PcbRawRecord) => PcbRawRecord): void {
  const rec = prepare ? prepare(currentDefault(storage)) : currentDefault(storage);
  const prim = decodePrim(storage, rec, 0, new Map());
  if (!prim) return;
  const target: RecordTarget = {
    rec,
    apply: (r) => { if (how === 'tab') setTabDefault(storage, r, settings.pcbDefaultsPermanent); else setSavedDefault(storage, r); after?.(r); ed.invalidateOverlay(); },
  };
  showDialog(DIALOGS[storage] as never, { ed, prim, target });
}

/* What the placing tools take from a default record */
export const viaOf = (r: PcbRawRecord) => ({ diameter: get(r.subs[0]!, VIA.diameter) ?? mil(50), hole: get(r.subs[0]!, VIA.hole) ?? mil(28) });
export const textOf = (r: PcbRawRecord) => {
  const b = r.subs[1];
  const text = b && b.length ? String.fromCharCode(...b.subarray(1, 1 + Math.min(b[0]!, b.length - 1))) : 'String';
  return { text, height: get(r.subs[0]!, TEXT.height) ?? mil(60), width: get(r.subs[0]!, TEXT.strokeWidth) ?? mil(10), rotation: get(r.subs[0]!, TEXT.rotation) ?? 0 };
};
export const padOf = (r: PcbRawRecord) => {
  const s = r.subs[4]!;
  const n = r.subs[0];
  const sh = get(s, PAD.topShape);
  return {
    designator: n && n.length ? String.fromCharCode(...n.subarray(1, 1 + Math.min(n[0]!, n.length - 1))) : '1',
    layer: get(s, PAD.layer) ?? L.MULTI, w: get(s, PAD.topX) ?? mil(60), h: get(s, PAD.topY) ?? mil(60),
    shape: (sh === 2 ? 'rect' : sh === 3 ? 'octagon' : 'round') as 'round' | 'rect' | 'octagon', hole: get(s, PAD.hole) ?? 0, rotation: get(s, PAD.rotation) ?? 0,
  };
};

/**
 * Tab while placing on a board: the object's AD17 dialog on what the tool puts down next. OK and
 * the next ones start from it. Returns false when the tool has no such dialog.
 */
export function tabWhilePlacing(ed: PcbEditor, toolId: string): boolean {
  const id = toolId.replace(/^place-keepout-/, 'place-');
  const pascal = (t: string) => { const b = new Uint8Array(Math.min(t.length, 255) + 1); b[0] = b.length - 1; for (let i = 1; i < b.length; i++) b[i] = t.charCodeAt(i - 1) & 0xff; return b; };
  switch (id) {
    case 'place-via': {
      return open(ed, 'Vias6', (r) => { ed.viaTemplate = { ...viaOf(r), fromRule: false }; }, (r) => {
        const v = viaSize(ed, ed.cursor, 0xffff);
        if (get(r.subs[0]!, VIA.diameter) !== v.diameter) setViaDiameter(r.subs[0]!, v.diameter);
        put(r.subs[0]!, VIA.hole, v.hole);
        return r;
      });
    }
    case 'place-pad': return open(ed, 'Pads6', (r) => { Object.assign(ed.padTemplate, padOf(r)); }, (r) => { r.subs[0] = pascal(ed.padTemplate.designator); put(r.subs[4]!, PAD.rotation, ed.padTemplate.rotation); return r; });
    case 'place-string': return open(ed, 'Texts6', (r) => { Object.assign(ed.stringTemplate, textOf(r)); }, (r) => { r.subs[1] = pascal(ed.stringTemplate.text); put(r.subs[0]!, TEXT.rotation, ed.stringTemplate.rotation); return r; });
    case 'place-fill': return open(ed, 'Fills6');
    case 'place-arc-centre': case 'place-arc-edge': case 'place-arc-any': case 'place-circle': return open(ed, 'Arcs6');
    case 'place-region': return open(ed, 'Regions6');
    default: return false;
  }
}
function open(ed: PcbEditor, storage: DefaultStorage, after?: (r: PcbRawRecord) => void, prepare?: (r: PcbRawRecord) => PcbRawRecord): boolean {
  editDefault(ed, storage, 'tab', after, prepare);
  return true;
}
