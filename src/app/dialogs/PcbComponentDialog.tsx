/**
 * Double-click a component on a board: AD17's Component dialog [est: laid out from AD17's help,
 * no screenshot yet]. Component Properties (layer, rotation, location, type, height, the locks,
 * jumpers, swapping), Designator and Comment (text, size, layer, rotation, location, hide,
 * mirror, autoposition, font), Footprint and Schematic Reference Information. OK is one undo step:
 * a change of side or place moves the whole component, then the text settings typed apply.
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { commitMove } from '../../editors/pcb/PcbMoveTool';
import { placement } from '../../formats/altium/pcbTransform';
import { L, type LayerId } from '../../model/layers';
import type { PcbText } from '../../model/pcb';
import { TEXT, get, put } from '../../formats/altium/pcbLayouts';
import { replaceRecords, setComponentProps } from '../../model/pcbEdit';
import { componentTextChange } from '../../model/pcbEco';
import { formatAltiumLength, parseLength } from '../../core/units';
import type { Change } from '../../core/undo';
import { AngleInput, Check, CoordInput, LayerSelect, LenInput, Row, unitTitle } from './pcbFields';

const TYPES: [number, string][] = [[0, 'Standard'], [1, 'Mechanical'], [2, 'Graphical'], [3, 'Net Tie (In BOM)'], [4, 'Net Tie'], [5, 'Standard (No BOM)'], [6, 'Jumper']];
const AUTOPOS: [number, string][] = [[0, 'Manual'], [1, 'Left-Above'], [2, 'Left-Centre'], [3, 'Left-Below'], [4, 'Centre-Above'], [5, 'Centre'], [6, 'Centre-Below'], [7, 'Right-Above'], [8, 'Right-Centre'], [9, 'Right-Below']];
const STROKE_FONTS: [number, string][] = [[1, 'Default'], [2, 'Sans Serif'], [3, 'Serif']];
const tf = (v: boolean) => (v ? 'TRUE' : 'FALSE');

interface TextState { prim?: PcbText; text: string; s0: Uint8Array | null; touched: Set<string> }

export function PcbComponentDialog({ ed, index }: { ed: PcbEditor; index: number }) {
  const c = ed.doc.components[index]!;
  const [bag] = useState(() => c.bag.clone());
  const [, setRev] = useState(0);
  const bump = () => setRev((n) => n + 1);
  const set = (k: string, v: string) => { bag.set(k, v); bump(); };
  const [side, setSide] = useState<LayerId>(c.layer);
  const [rot, setRot] = useState(c.rotation);
  const [at, setAt] = useState(c.at);
  const textOf = (which: 'isDesignator' | 'isComment'): TextState => {
    const prim = ed.doc.prims.find((q): q is PcbText => q.kind === 'text' && q.component === index && q[which]);
    const rec = prim && ed.doc.streams.get(prim.src.storage)!.records[prim.src.index]!;
    return { prim, text: which === 'isDesignator' ? c.designator : prim?.text ?? '', s0: rec ? rec.subs[0]!.slice() : null, touched: new Set() };
  };
  const [des] = useState(() => textOf('isDesignator'));
  const [com] = useState(() => textOf('isComment'));

  const ok = () => {
    const flip = side !== c.layer, d = { x: at.x - c.at.x, y: at.y - c.at.y }, turned = rot !== c.rotation;
    ed.undo.transact(`Component ${c.designator} properties`, (tx) => {
      // Side, place and turn: the whole component, as Move does (L flips it to the other side)
      if (flip || d.x || d.y || turned) {
        const set1 = { components: [index], polygons: [], prims: [] };
        if (flip) commitMove(ed, set1, placement(c.at, 0, { x: 0, y: 0 }, true), 0, 'move', 'Flip component', { mirror: true, flip: true });
        const now = ed.doc.components[index]!;
        const t2 = turned ? ((rot - now.rotation) % 360 + 360) % 360 : 0;
        if (d.x || d.y || t2) commitMove(ed, set1, placement(now.at, t2, d), t2, 'move', 'Move component');
      }
      // Designator and comment: their words, then whatever was typed into their settings
      if (des.text !== c.designator && des.text.trim()) {
        tx.add(componentTextChange(ed.doc, index, (q) => q.isDesignator, des.text.trim()));
        bag.set('SOURCEDESIGNATOR', des.text.trim());
      }
      if (com.prim && com.text !== com.prim.text) tx.add(componentTextChange(ed.doc, index, (q) => q.isComment, com.text));
      const edits: { storage: string; index: number; after: { tag: number; subs: Uint8Array[] } }[] = [];
      for (const t of [des, com]) {
        if (!t.prim || !t.s0 || !t.touched.size) continue;
        const cur = ed.doc.prims.find((q): q is PcbText => q.kind === 'text' && q.component === index && (t === des ? q.isDesignator : q.isComment));
        if (!cur) continue;
        const rec = ed.doc.streams.get(cur.src.storage)!.records[cur.src.index]!;
        const s = rec.subs[0]!.slice();
        for (const k of t.touched) { const f = (TEXT as Record<string, unknown>)[k]; if (f && typeof f === 'object') put(s, f as never, get(t.s0, f as never) ?? 0); }
        edits.push({ storage: cur.src.storage, index: cur.src.index, after: { tag: rec.tag, subs: [s, ...rec.subs.slice(1)] } });
      }
      if (edits.length) tx.add(replaceRecords(ed.doc, edits));
      // The component's own keys (side, place and turn are the move's)
      const now = ed.doc.components[index]!.bag;
      const kv: Record<string, string> = {};
      for (const [k, v] of Object.entries(bag.toObject())) if (!['X', 'Y', 'ROTATION', 'LAYER'].includes(k) && now.get(k) !== v) kv[k] = v;
      if (Object.keys(kv).length) tx.add(setComponentProps(ed.doc, index, kv) as Change);
    });
    ed.invalidate();
    closeDialog();
  };

  // Called as a function, not a component: a component made afresh each render would lose focus
  const textGroup = ({ t, title, onKey, posKey }: { t: TextState; title: string; onKey: string; posKey: string }) => {
    const s = t.s0;
    const g = (k: keyof typeof TEXT) => (s ? get(s, TEXT[k] as never) ?? 0 : 0);
    const p = (k: keyof typeof TEXT, v: number) => { if (!s) return; put(s, TEXT[k] as never, v); t.touched.add(k); bump(); };
    const ftype = s && s.length >= TEXT.barcodeLen ? s[TEXT.kind.off]! : s && s.length >= TEXT.extendedLen ? s[TEXT.fontType.off]! : 0;
    /** Stroke or TrueType: AD17's longer texts keep the kind again at 160 (what it reads). */
    const setFont = (k: number) => { if (!s) return; s[TEXT.fontType.off] = k; t.touched.add('fontType'); if (s.length >= TEXT.barcodeLen) { s[TEXT.kind.off] = k; t.touched.add('kind'); } bump(); };
    const layers = [L.TOP_OVERLAY, L.BOTTOM_OVERLAY, L.TOP, L.BOTTOM, ...ed.layers().filter((l) => l >= L.MECH1 && l <= L.MECH16)];
    return (
      <fieldset class="pd-group pc-text"><legend>{title}</legend>
        <Row label="Text"><input type="text" aria-label={`${title} text`} value={t.text} onInput={(e) => { t.text = (e.target as HTMLInputElement).value; bump(); }} onKeyDown={(e) => e.stopPropagation()} /></Row>
        {s ? <>
          <Row label="Height"><LenInput ed={ed} label={`${title} height`} value={g('height')} min={1} onChange={(v) => p('height', v)} /></Row>
          <Row label="Width"><LenInput ed={ed} label={`${title} width`} value={g('strokeWidth')} min={1} disabled={ftype !== 0} onChange={(v) => p('strokeWidth', v)} /></Row>
          <Row label="Layer"><LayerSelect ed={ed} value={g('layer')} layers={layers} onChange={(l) => p('layer', l)} /></Row>
          <Row label="Rotation"><AngleInput label={`${title} rotation`} value={g('rotation')} onChange={(a) => p('rotation', a)} /></Row>
          <Row label="X - Location"><CoordInput ed={ed} axis="x" label={`${title} X`} value={g('x')} onChange={(v) => p('x', v)} /></Row>
          <Row label="Y - Location"><CoordInput ed={ed} axis="y" label={`${title} Y`} value={g('y')} onChange={(v) => p('y', v)} /></Row>
          <div class="pd-cols">
            <Check label="Hide" checked={!bag.bool(onKey) && (onKey !== 'NAMEON' || bag.has(onKey))} onChange={(v) => set(onKey, tf(!v))} />
            <Check label="Mirror" checked={g('mirrored') !== 0} onChange={(v) => p('mirrored', v ? 1 : 0)} />
          </div>
          <Row label="Autoposition"><select aria-label={`${title} autoposition`} value={String(bag.int(posKey))} onChange={(e) => set(posKey, (e.target as HTMLSelectElement).value)}>
            {AUTOPOS.map(([k, n]) => <option key={k} value={String(k)}>{n}</option>)}
          </select></Row>
          <Row label="Font"><span class="pd-radios">
            <label><input type="radio" checked={ftype === 1} disabled={s.length < TEXT.extendedLen} name={`${posKey}-font`} onChange={() => setFont(1)} /> TrueType</label>
            <label><input type="radio" checked={ftype === 0} name={`${posKey}-font`} onChange={() => { if (s.length >= TEXT.extendedLen) setFont(0); else bump(); }} /> Stroke</label>
          </span></Row>
          {ftype === 0 && <Row label="Font Name"><select aria-label={`${title} font`} value={String(g('font') || 1)} onChange={(e) => p('font', Number((e.target as HTMLSelectElement).value))}>
            {STROKE_FONTS.map(([v, n]) => <option key={v} value={String(v)}>{n}</option>)}</select></Row>}
        </> : <p class="muted small">The component has no {title.toLowerCase()} text.</p>}
      </fieldset>
    );
  };
  const kind = bag.has('COMPONENTKIND') ? bag.int('COMPONENTKIND') : 0;
  const ro = (label: string, key: string) => <Row label={label}><input type="text" aria-label={label} readOnly value={bag.get(key) ?? ''} /></Row>;
  return (
    <Dialog title={unitTitle(ed, `Component ${c.designator}`)} width={860} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="pd pcbcomp"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="pd-two">
        <div>
          <fieldset class="pd-group"><legend>Component Properties</legend>
            <Row label="Layer"><select aria-label="Component layer" value={String(side)} onChange={(e) => setSide(Number((e.target as HTMLSelectElement).value))}>
              <option value={String(L.TOP)}>{ed.layerLabel(L.TOP)}</option><option value={String(L.BOTTOM)}>{ed.layerLabel(L.BOTTOM)}</option></select></Row>
            <Row label="Rotation"><AngleInput label="Component rotation" value={rot} onChange={(a) => setRot(((a % 360) + 360) % 360)} /></Row>
            <Row label="X - Location"><CoordInput ed={ed} axis="x" label="Component X" value={at.x} onChange={(v) => setAt({ ...at, x: v })} /></Row>
            <Row label="Y - Location"><CoordInput ed={ed} axis="y" label="Component Y" value={at.y} onChange={(v) => setAt({ ...at, y: v })} /></Row>
            <Row label="Type"><select aria-label="Type" value={String(kind)} onChange={(e) => set('COMPONENTKIND', (e.target as HTMLSelectElement).value)}>
              {TYPES.map(([k, n]) => <option key={k} value={String(k)}>{n}</option>)}</select></Row>
            <Row label="Height"><LenInput ed={ed} label="Height" value={parseLength(bag.get('HEIGHT')) ?? 0} onChange={(v) => set('HEIGHT', formatAltiumLength(v))} /></Row>
            <div class="pd-cols">
              <Check label="Lock Primitives" checked={bag.has('PRIMITIVELOCK') ? bag.bool('PRIMITIVELOCK') : true} onChange={(v) => set('PRIMITIVELOCK', tf(v))} />
              <Check label="Lock Strings" checked={bag.bool('LOCKSTRINGS')} onChange={(v) => set('LOCKSTRINGS', tf(v))} />
              <Check label="Locked" checked={bag.bool('LOCKED')} onChange={(v) => set('LOCKED', tf(v))} />
              <Check label="Hide Jumpers" checked={bag.has('JUMPERSVISIBLE') && !bag.bool('JUMPERSVISIBLE')} onChange={(v) => set('JUMPERSVISIBLE', tf(!v))} />
            </div>
            <fieldset class="pd-group"><legend>Swapping Options</legend>
              <div class="pd-cols">
                <Check label="Enable Pin Swaps" checked={bag.bool('ENABLEPINSWAPPING')} onChange={(v) => set('ENABLEPINSWAPPING', tf(v))} />
                <Check label="Enable Part Swaps" checked={bag.bool('ENABLEPARTSWAPPING')} onChange={(v) => set('ENABLEPARTSWAPPING', tf(v))} />
              </div>
            </fieldset>
          </fieldset>
          <fieldset class="pd-group"><legend>Footprint</legend>
            {ro('Name', 'PATTERN')}{ro('Library', 'SOURCEFOOTPRINTLIBRARY')}{ro('Description', 'FOOTPRINTDESCRIPTION')}{ro('Default 3D Model', 'DEFAULTPCB3DMODEL')}
          </fieldset>
          <fieldset class="pd-group"><legend>Schematic Reference Information</legend>
            {ro('Unique Id', 'SOURCEUNIQUEID')}{ro('Designator', 'SOURCEDESIGNATOR')}{ro('Hierarchical Path', 'SOURCEHIERARCHICALPATH')}
            {ro('Description', 'SOURCEDESCRIPTION')}{ro('Library', 'SOURCECOMPONENTLIBRARY')}{ro('Library Reference', 'SOURCELIBREFERENCE')}{ro('Channel Offset', 'CHANNELOFFSET')}
          </fieldset>
        </div>
        <div>
          {textGroup({ t: des, title: 'Designator', onKey: 'NAMEON', posKey: 'NAMEAUTOPOSITION' })}
          {textGroup({ t: com, title: 'Comment', onKey: 'COMMENTON', posKey: 'COMMENTAUTOPOSITION' })}
        </div>
      </div>
    </Dialog>
  );
}
