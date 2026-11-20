/**
 * Double-click a board object: AD17's dialog for it (Track, Arc, Fill, String, Via), its picture
 * with the values around it, the properties below, OK puts it all back in one undo step.
 * Mask expansions of tracks, arcs and fills live in ExtendedPrimitiveInformation (see primInfo).
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { DrillPairManagerDialog } from './BoardSets';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import type { PcbArc, PcbFill, PcbPrim, PcbText, PcbTrack, PcbVia } from '../../model/pcb';
import { L, isSignal, type LayerId } from '../../model/layers';
import { ARC, FILL, FLAG, NO_TOLERANCE, TEXT, TRACK, VIA, get, put, setViaDiameter } from '../../formats/altium/pcbLayouts';
import { layerFromName } from '../../formats/altium/pcbdoc';
import { binToBytes, toCp1252Lossy } from '../../formats/text';
import { longText, toV7 } from '../../formats/altium/pcbdoc';
import { RegionDialog } from './RegionDialog';
import { AngleInput, Check, CoordInput, LayerSelect, LenInput, MaskChooser, NetSelect, Row, lockedOf, unitTitle, useRecord, withLocked, type RecordTarget } from './pcbFields';
import { padExtrasOf, setPadExtras } from '../../formats/altium/primInfo';

const COPPER = '#f2c443', EDGE = '#a37b22', ARROW = '#3d8fc4', GUIDE = '#9aa3ab';

function Footer({ ok, extra }: { ok: () => void; extra?: preact.ComponentChildren }) {
  return <>{extra}<span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>;
}

/** Every layer a free track, arc or fill can be on: the copper stack, then the others in the layer bar. */
const drawLayers = (ed: PcbEditor): LayerId[] => [...new Set([...ed.doc.board.copperStack, ...ed.layers().filter((l) => l !== L.MULTI)])];

/* ─── Track ─────────────────────────────────────────────────────────────────────────── */

export function TrackDialog({ ed, prim, target }: { ed: PcbEditor; prim: PcbTrack; target?: RecordTarget }) {
  const r = useRecord(ed, prim, target);
  const s = r.at(0);
  const ok = () => { r.commit('Track properties', true); closeDialog(); };
  const keepout = s.bytes[2] === 2;
  return (
    <Dialog title={unitTitle(ed, 'Track')} width={560} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="pd" footer={<Footer ok={ok} />}>
      <div class="pd-figure">
        <div class="pd-fig-side">
          <Row label="Width" for="pd-width"><LenInput ed={ed} id="pd-width" value={s.get(TRACK.width)} min={1} onChange={(v) => s.set(TRACK.width, v)} /></Row>
          <Row label="Start X"><CoordInput ed={ed} axis="x" label="Start X" value={s.get(TRACK.x1)} onChange={(v) => s.set(TRACK.x1, v)} /></Row>
          <Row label="Y"><CoordInput ed={ed} axis="y" label="Start Y" value={s.get(TRACK.y1)} onChange={(v) => s.set(TRACK.y1, v)} /></Row>
        </div>
        <svg viewBox="0 0 240 160" class="pd-pic" aria-hidden="true">
          <line x1="20" y1="140" x2="220" y2="20" stroke={GUIDE} stroke-dasharray="3 3" />
          <line x1="50" y1="122" x2="190" y2="38" stroke={EDGE} stroke-width="22" stroke-linecap="round" />
          <line x1="50" y1="122" x2="190" y2="38" stroke={COPPER} stroke-width="20" stroke-linecap="round" />
          <path d="M150 22 L162 42" stroke={ARROW} marker-start="url(#pa)" marker-end="url(#pa)" />
          <circle cx="50" cy="122" r="3" fill={ARROW} /><circle cx="190" cy="38" r="3" fill={ARROW} />
          <defs><marker id="pa" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L6 3 L0 6z" fill={ARROW} /></marker></defs>
        </svg>
        <div class="pd-fig-side">
          <Row label="End X"><CoordInput ed={ed} axis="x" label="End X" value={s.get(TRACK.x2)} onChange={(v) => s.set(TRACK.x2, v)} /></Row>
          <Row label="Y"><CoordInput ed={ed} axis="y" label="End Y" value={s.get(TRACK.y2)} onChange={(v) => s.set(TRACK.y2, v)} /></Row>
        </div>
      </div>
      <fieldset class="pd-group"><legend>Properties</legend>
        <div class="pd-cols">
          <div>
            <Row label="Layer"><LayerSelect ed={ed} value={s.get(TRACK.layer)} layers={drawLayers(ed)} onChange={(l) => { s.set(TRACK.layer, l); if (s.bytes.length >= TRACK.layerV7.off + 4) put(s.bytes, TRACK.layerV7, toV7(l)); }} /></Row>
            <Row label="Net"><NetSelect ed={ed} value={s.get(TRACK.net)} onChange={(n) => s.set(TRACK.net, n)} /></Row>
          </div>
          <div>
            <Check label="Locked" checked={lockedOf(s.get(TRACK.flags1))} onChange={(v) => s.set(TRACK.flags1, withLocked(s.get(TRACK.flags1), v))} />
            <Check label="Keepout" checked={keepout} onChange={(v) => s.set(TRACK.flags2, v ? 2 : 0)} />
          </div>
        </div>
        <MaskChooser ed={ed} label="Solder Mask Expansion" value={r.masks.solder} onChange={(m) => r.setMasks({ ...r.masks, solder: m })} />
        <MaskChooser ed={ed} label="Paste Mask Expansion" value={r.masks.paste} onChange={(m) => r.setMasks({ ...r.masks, paste: m })} />
      </fieldset>
    </Dialog>
  );
}

/* ─── Arc ───────────────────────────────────────────────────────────────────────────── */

export function ArcDialog({ ed, prim, target }: { ed: PcbEditor; prim: PcbArc; target?: RecordTarget }) {
  const r = useRecord(ed, prim, target);
  const s = r.at(0);
  const ok = () => { r.commit('Arc properties', true); closeDialog(); };
  const at = (x: number, y: number) => ({ left: `${x}px`, top: `${y}px` });
  // AD17's picture: the arc about its centre, the angles measured anticlockwise from the right
  const C = { x: 262, y: 122 }, R = 46;
  const pt = (deg: number, rad: number) => `${C.x + rad * Math.cos((deg * Math.PI) / 180)} ${C.y - rad * Math.sin((deg * Math.PI) / 180)}`;
  const arc = (a0: number, a1: number, rad: number) => `M${pt(a0, rad)} A${rad} ${rad} 0 ${((a1 - a0 + 360) % 360) > 180 ? 1 : 0} 0 ${pt(a1, rad)}`;
  return (
    <Dialog title={unitTitle(ed, 'Arc')} width={640} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="pd pd-arc" footer={<Footer ok={ok} />}>
      <div class="pd-abs" style={{ height: '236px' }}>
        <svg viewBox="0 0 600 236" aria-hidden="true">
          <defs><marker id="aa" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L6 3 L0 6z" fill={ARROW} /></marker></defs>
          <line x1={C.x} y1="16" x2={C.x} y2="200" stroke={GUIDE} />
          <line x1="150" y1={C.y} x2="420" y2={C.y} stroke={GUIDE} />
          <line x1="130" y1="186" x2="400" y2="66" stroke={ARROW} />
          <path d={arc(0, 20, 72)} fill="none" stroke={ARROW} marker-end="url(#aa)" />
          <path d={arc(0, 212, 82)} fill="none" stroke={ARROW} marker-end="url(#aa)" />
          <path d={arc(20, 212, R)} fill="none" stroke={COPPER} stroke-width="16" stroke-linecap="round" />
          <path d={arc(20, 212, R)} fill="none" stroke={ARROW} stroke-dasharray="5 4" />
          <line x1={C.x} y1={C.y} x2={C.x + (R - 2) * Math.cos(2.1)} y2={C.y - (R - 2) * Math.sin(2.1)} stroke={ARROW} marker-end="url(#aa)" />
          <line x1={C.x} y1={C.y} x2={C.x + (R + 8) * Math.cos(1.2)} y2={C.y - (R + 8) * Math.sin(1.2)} stroke={ARROW} marker-end="url(#aa)" />
          <line x1="96" y1="90" x2={C.x - R - 6} y2={C.y - 18} stroke={GUIDE} marker-end="url(#aa)" />
          <line x1={C.x} y1={C.y} x2={C.x} y2="196" stroke={GUIDE} /><line x1={C.x} y1="196" x2="296" y2="196" stroke={GUIDE} />
        </svg>
        <label class="pd-at" style={at(70, 22)}><span class="pd-label">Radius</span><LenInput ed={ed} label="Radius" id="pd-radius" value={s.get(ARC.radius)} min={1} onChange={(v) => s.set(ARC.radius, v)} /></label>
        <label class="pd-at" style={at(10, 78)}><span class="pd-label">Width</span><LenInput ed={ed} label="Width" value={s.get(ARC.width)} min={1} onChange={(v) => s.set(ARC.width, v)} /></label>
        <label class="pd-at" style={at(0, 150)}><span class="pd-label">End Angle</span><AngleInput label="End Angle" value={s.get(ARC.end)} onChange={(a) => s.set(ARC.end, a)} /></label>
        <label class="pd-at" style={at(362, 100)}><span class="pd-label">Start Angle</span><AngleInput label="Start Angle" value={s.get(ARC.start)} onChange={(a) => s.set(ARC.start, a)} /></label>
        <span class="pd-at" style={at(300, 184)}><span class="pd-label">Centre</span>
          <span class="pd-xy"><label><span class="pd-label">X:</span><CoordInput ed={ed} axis="x" label="Centre X" value={s.get(ARC.cx)} onChange={(v) => s.set(ARC.cx, v)} /></label>
            <label><span class="pd-label">Y:</span><CoordInput ed={ed} axis="y" label="Centre Y" value={s.get(ARC.cy)} onChange={(v) => s.set(ARC.cy, v)} /></label></span></span>
      </div>
      <fieldset class="pd-group"><legend>Properties</legend>
        <div class="pd-cols">
          <div>
            <Row label="Layer"><LayerSelect ed={ed} value={s.get(ARC.layer)} layers={drawLayers(ed)} onChange={(l) => { if (s.bytes.length >= ARC.layerV7.off + 4) put(s.bytes, ARC.layerV7, toV7(l)); s.set(ARC.layer, l); }} /></Row>
            <Row label="Net"><NetSelect ed={ed} value={s.get(ARC.net)} onChange={(n) => s.set(ARC.net, n)} /></Row>
          </div>
          <div>
            <Check label="Locked" checked={lockedOf(s.get(ARC.flags1))} onChange={(v) => s.set(ARC.flags1, withLocked(s.get(ARC.flags1), v))} />
            {s.bytes[2] === 2 && <Check label="Keepout" checked onChange={(v) => s.set(ARC.flags2, v ? 2 : 0)} />}
          </div>
        </div>
        <MaskChooser ed={ed} label="Solder Mask Expansion" value={r.masks.solder} onChange={(m) => r.setMasks({ ...r.masks, solder: m })} />
        <MaskChooser ed={ed} label="Paste Mask Expansion" value={r.masks.paste} onChange={(m) => r.setMasks({ ...r.masks, paste: m })} />
      </fieldset>
    </Dialog>
  );
}

/* ─── Fill ──────────────────────────────────────────────────────────────────────────── */

export function FillDialog({ ed, prim, target }: { ed: PcbEditor; prim: PcbFill; target?: RecordTarget }) {
  const r = useRecord(ed, prim, target);
  const s = r.at(0);
  const ok = () => { r.commit('Fill properties', true); closeDialog(); };
  return (
    <Dialog title={unitTitle(ed, 'Fill')} width={560} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="pd" footer={<Footer ok={ok} />}>
      <div class="pd-figure">
        <div class="pd-fig-side pd-fig-bottom">
          <Row label="Corner 1 X"><CoordInput ed={ed} axis="x" label="Corner 1 X" value={s.get(FILL.x1)} onChange={(v) => s.set(FILL.x1, v)} /></Row>
          <Row label="Y"><CoordInput ed={ed} axis="y" label="Corner 1 Y" value={s.get(FILL.y1)} onChange={(v) => s.set(FILL.y1, v)} /></Row>
        </div>
        <svg viewBox="0 0 240 160" class="pd-pic" aria-hidden="true">
          <line x1="10" y1="140" x2="230" y2="80" stroke={GUIDE} />
          <line x1="70" y1="124" x2="200" y2="124" stroke={ARROW} />
          <g transform="rotate(-15 70 124)"><rect x="70" y="64" width="100" height="60" fill={COPPER} stroke={EDGE} /></g>
          <path d="M160 124 A90 90 0 0 0 157 101" fill="none" stroke={ARROW} />
          <circle cx="70" cy="124" r="3" fill={ARROW} /><circle cx="152" cy="40" r="3" fill={ARROW} />
        </svg>
        <div class="pd-fig-side">
          <Row label="Corner 2 X"><CoordInput ed={ed} axis="x" label="Corner 2 X" value={s.get(FILL.x2)} onChange={(v) => s.set(FILL.x2, v)} /></Row>
          <Row label="Y"><CoordInput ed={ed} axis="y" label="Corner 2 Y" value={s.get(FILL.y2)} onChange={(v) => s.set(FILL.y2, v)} /></Row>
          <Row label="Rotation"><AngleInput label="Rotation" value={s.get(FILL.rotation)} onChange={(a) => s.set(FILL.rotation, a)} /></Row>
        </div>
      </div>
      <fieldset class="pd-group"><legend>Properties</legend>
        <div class="pd-cols">
          <div>
            <Row label="Layer"><LayerSelect ed={ed} value={s.get(FILL.layer)} layers={drawLayers(ed)} onChange={(l) => { if (s.bytes.length >= FILL.layerV7.off + 4) put(s.bytes, FILL.layerV7, toV7(l)); s.set(FILL.layer, l); }} /></Row>
            <Row label="Net"><NetSelect ed={ed} value={s.get(FILL.net)} onChange={(n) => s.set(FILL.net, n)} /></Row>
          </div>
          <div><Check label="Locked" checked={lockedOf(s.get(FILL.flags1))} onChange={(v) => s.set(FILL.flags1, withLocked(s.get(FILL.flags1), v))} /></div>
        </div>
        <MaskChooser ed={ed} label="Solder Mask Expansion" value={r.masks.solder} onChange={(m) => r.setMasks({ ...r.masks, solder: m })} />
        <MaskChooser ed={ed} label="Paste Mask Expansion" value={r.masks.paste} onChange={(m) => r.setMasks({ ...r.masks, paste: m })} />
      </fieldset>
    </Dialog>
  );
}

/* ─── String (and a component's Designator / Comment) ──────────────────────────────── */

const STROKE_FONTS: [number, string][] = [[1, 'Default'], [2, 'Sans Serif'], [3, 'Serif']];
const TRUETYPE = ['Arial', 'Arial Black', 'Calibri', 'Consolas', 'Courier New', 'Georgia', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Verdana'];
const pascal = (s: string) => { const b = binToBytes(toCp1252Lossy(s).slice(0, 255)); const o = new Uint8Array(b.length + 1); o[0] = b.length; o.set(b, 1); return o; };
const utf16 = (b: Uint8Array, at: number, n: number) => { let s = ''; for (let i = at; i + 1 < at + n; i += 2) { const c = b[i]! | (b[i + 1]! << 8); if (!c) break; s += String.fromCharCode(c); } return s; };
const putUtf16 = (b: Uint8Array, at: number, n: number, s: string) => { b.fill(0, at, at + n); for (let i = 0; i < s.length && 2 * i + 1 < n - 1; i++) { const c = s.charCodeAt(i); b[at + 2 * i] = c & 0xff; b[at + 2 * i + 1] = c >> 8; } };

export function StringDialog({ ed, prim, target }: { ed: PcbEditor; prim: PcbText; target?: RecordTarget }) {
  const r = useRecord(ed, prim, target);
  const s = r.at(0);
  const role = prim.isDesignator ? 'Designator' : prim.isComment ? 'Comment' : 'String';
  // The words as shown (its WideStrings6 entry: Unicode the 8-bit string may not hold)
  const [text, setText] = useState(() => prim.text);
  const ext = s.bytes.length >= TEXT.extendedLen;
  const type = s.bytes.length >= TEXT.barcodeLen ? s.bytes[TEXT.kind.off]! : ext ? s.bytes[TEXT.fontType.off]! : 0;
  const ttName = ext ? utf16(s.bytes, TEXT.fontName, 64) : '';
  /** The kind (stroke, TrueType, barcode): AD17's longer records keep it twice. */
  const setKind = (k: number) => { s.bytes[TEXT.fontType.off] = k === 2 ? 0 : k; if (s.bytes.length >= TEXT.barcodeLen) s.bytes[TEXT.kind.off] = k; };
  /** BarCode: the record made long enough for its settings, AD17's defaults where it has none. */
  const toBarcode = () => {
    if (s.bytes.length < TEXT.barcodeLen) { r.subs[0] = longText(s.bytes) as Uint8Array<ArrayBuffer>; }
    const b = r.at(0).bytes;
    // As AD17 writes a barcode: the kind at 160, the TrueType flag at 43 left off
    b[TEXT.fontType.off] = 0; b[TEXT.kind.off] = 2;
    put(b, TEXT.bcInverted, 0);
    if (!get(b, TEXT.bcMinWidth)) put(b, TEXT.bcMinWidth, 100_000);
    r.bump();
  };
  const ok = () => {
    const changed = text !== prim.text && !prim.isDesignator;
    r.commit(`${role} properties`, false, (after) => {
      if (!changed) return;
      after.subs[1] = pascal(text.replace(/\r?\n/g, '\r\n'));
      // A new string: no WideStrings6 entry (the old one would show the old words); saving makes one
      if (after.subs[0]!.length >= TEXT.wideIndex.off + 4) put(after.subs[0]!, TEXT.wideIndex, 0xffffffff);
      after.wide = text.replace(/\r?\n/g, '\r\n');
    });
    closeDialog();
  };
  const layers = [...new Set([...ed.layers().filter((l) => l !== L.MULTI), ...ed.doc.board.copperStack])];
  return (
    <Dialog title={unitTitle(ed, role)} width={600} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="pd" footer={<Footer ok={ok} />}>
      <div class="pd-figure">
        <div class="pd-fig-side">
          <Row label="Width"><LenInput ed={ed} label="Width" value={s.get(TEXT.strokeWidth)} min={1} disabled={type !== 0} onChange={(v) => s.set(TEXT.strokeWidth, v)} /></Row>
          <Row label="Location X"><CoordInput ed={ed} axis="x" label="Location X" value={s.get(TEXT.x)} onChange={(v) => s.set(TEXT.x, v)} /></Row>
          <Row label="Y"><CoordInput ed={ed} axis="y" label="Location Y" value={s.get(TEXT.y)} onChange={(v) => s.set(TEXT.y, v)} /></Row>
        </div>
        <svg viewBox="0 0 240 150" class="pd-pic" aria-hidden="true">
          <g transform="rotate(-14 40 120)">
            <line x1="20" y1="120" x2="230" y2="120" stroke={GUIDE} />
            <text x="40" y="118" font-size="62" font-family="Arial, sans-serif" font-weight="700" fill="#1b9a72">T</text>
            <text x="80" y="118" font-size="62" font-family="Arial, sans-serif" fill="none" stroke="#1b9a72" stroke-width="1.2">ext</text>
            <path d="M205 120 L205 72" stroke={ARROW} marker-start="url(#sa)" marker-end="url(#sa)" />
          </g>
          <line x1="40" y1="120" x2="200" y2="120" stroke={ARROW} />
          <path d="M175 120 A135 135 0 0 0 172 87" fill="none" stroke={ARROW} />
          <defs><marker id="sa" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L6 3 L0 6z" fill={ARROW} /></marker></defs>
        </svg>
        <div class="pd-fig-side">
          <Row label="Height"><LenInput ed={ed} label="Height" value={s.get(TEXT.height)} min={1} onChange={(v) => s.set(TEXT.height, v)} /></Row>
          <Row label="Rotation"><AngleInput label="Rotation" value={s.get(TEXT.rotation)} onChange={(a) => s.set(TEXT.rotation, a)} /></Row>
        </div>
      </div>
      <fieldset class="pd-group"><legend>Properties</legend>
        <textarea class="pd-text" aria-label="Text" rows={4} value={text} disabled={prim.isDesignator} title={prim.isDesignator ? 'The component\'s designator' : undefined}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ok(); } }} />
        <p class="muted small">Note: Use Shift+Enter to add new line.</p>
        <div class="pd-cols">
          <div>
            <Row label="Layer"><LayerSelect ed={ed} value={s.get(TEXT.layer)} layers={layers} onChange={(l) => { if (s.bytes.length >= TEXT.barcodeLen) put(s.bytes, TEXT.layerV7, toV7(l)); s.set(TEXT.layer, l); }} /></Row>
            <div class="pd-row"><span class="pd-label">Font</span>
              <div class="pd-radios pd-col pd-tight">
                <label><input type="radio" name="pd-font" checked={type === 1} disabled={!ext} onChange={() => { setKind(1); if (!ttName) putUtf16(s.bytes, TEXT.fontName, 64, 'Arial'); r.bump(); }} /> TrueType</label>
                <label><input type="radio" name="pd-font" checked={type === 0} onChange={() => { if (ext) setKind(0); r.bump(); }} /> Stroke</label>
                <label><input type="radio" name="pd-font" checked={type === 2} onChange={() => toBarcode()} /> BarCode</label>
              </div>
            </div>
          </div>
          <div>
            <Check label="Locked" checked={lockedOf(s.bytes[1]!)} onChange={(v) => { s.bytes[1] = withLocked(s.bytes[1]!, v); r.bump(); }} />
            <Check label="Mirror" checked={s.get(TEXT.mirrored) !== 0} onChange={(v) => s.set(TEXT.mirrored, v ? 1 : 0)} />
          </div>
        </div>
      </fieldset>
      {type === 0 ? (
        <fieldset class="pd-group"><legend>Select Stroke Font</legend>
          <Row label="Font Name"><select aria-label="Font Name" value={String(s.get(TEXT.font) || 1)} onChange={(e) => s.set(TEXT.font, Number((e.target as HTMLSelectElement).value))}>
            {STROKE_FONTS.map(([v, n]) => <option key={v} value={String(v)}>{n}</option>)}
          </select></Row>
        </fieldset>
      ) : type === 1 ? (
        <fieldset class="pd-group"><legend>Select TrueType Font</legend>
          <Row label="Font Name"><select aria-label="Font Name" value={ttName || 'Arial'} onChange={(e) => { putUtf16(s.bytes, TEXT.fontName, 64, (e.target as HTMLSelectElement).value); r.bump(); }}>
            {[...new Set([ttName || 'Arial', ...TRUETYPE])].map((f) => <option key={f}>{f}</option>)}
          </select></Row>
          <div class="pd-cols">
            <Check label="Bold" checked={s.get(TEXT.bold) !== 0} onChange={(v) => s.set(TEXT.bold, v ? 1 : 0)} />
            <Check label="Italic" checked={s.get(TEXT.italic) !== 0} onChange={(v) => s.set(TEXT.italic, v ? 1 : 0)} />
            <Check label="Inverted" checked={s.get(TEXT.inverted) !== 0} onChange={(v) => s.set(TEXT.inverted, v ? 1 : 0)} />
          </div>
        </fieldset>
      ) : type === 2 ? <BarcodeFields ed={ed} s={s} bump={r.bump} /> : null}
    </Dialog>
  );
}

/** Font BarCode: Code 39 or 128, rendered by full width or min width, its size, margins, the words shown or not, inverted. */
function BarcodeFields({ ed, s, bump }: { ed: PcbEditor; s: ReturnType<ReturnType<typeof useRecord>['at']>; bump: () => void }) {
  const full = s.get(TEXT.bcRender) !== 0;
  const font = utf16(s.bytes, TEXT.bcFont, 64) || 'Arial';
  return (
    <fieldset class="pd-group"><legend>Barcode Text</legend>
      <div class="pd-cols">
        <div>
          <Row label="Type"><select aria-label="Barcode type" value={String(s.get(TEXT.bcType))} onChange={(e) => s.set(TEXT.bcType, Number((e.target as HTMLSelectElement).value))}>
            <option value="0">Code 39</option><option value="1">Code 128</option></select></Row>
          <Row label="Render Mode"><select aria-label="Render mode" value={full ? '1' : '0'} onChange={(e) => s.set(TEXT.bcRender, Number((e.target as HTMLSelectElement).value))}>
            <option value="1">By Full Width</option><option value="0">By Min Width</option></select></Row>
          <Row label="Full Width"><LenInput ed={ed} label="Full Width" value={s.get(TEXT.bcFullWidth)} min={1} disabled={!full} onChange={(v) => s.set(TEXT.bcFullWidth, v)} /></Row>
          <Row label="Height"><LenInput ed={ed} label="Barcode height" value={s.get(TEXT.bcHeight)} min={1} onChange={(v) => s.set(TEXT.bcHeight, v)} /></Row>
          <Row label="Min Width"><LenInput ed={ed} label="Min Width" value={s.get(TEXT.bcMinWidth)} min={1} disabled={full} onChange={(v) => s.set(TEXT.bcMinWidth, v)} /></Row>
        </div>
        <div>
          <Row label="X Margin"><LenInput ed={ed} label="X Margin" value={s.get(TEXT.bcMarginX)} min={0} onChange={(v) => s.set(TEXT.bcMarginX, v)} /></Row>
          <Row label="Y Margin"><LenInput ed={ed} label="Y Margin" value={s.get(TEXT.bcMarginY)} min={0} onChange={(v) => s.set(TEXT.bcMarginY, v)} /></Row>
          <Row label="Font Name"><select aria-label="Barcode font" value={font} onChange={(e) => { putUtf16(s.bytes, TEXT.bcFont, 64, (e.target as HTMLSelectElement).value); bump(); }}>
            {[...new Set([font, ...TRUETYPE])].map((f) => <option key={f}>{f}</option>)}
          </select></Row>
          <Check label="Show Text" checked={s.get(TEXT.bcShowText) !== 0} onChange={(v) => s.set(TEXT.bcShowText, v ? 1 : 0)} />
          <Check label="Inverted" checked={s.get(TEXT.bcInverted) !== 0} onChange={(v) => s.set(TEXT.bcInverted, v ? 1 : 0)} />
        </div>
      </div>
      <p class="muted small">Code 39 (Full ASCII: lower case and punctuation as two symbols) and Code 128 show any printable character.</p>
    </fieldset>
  );
}

/* ─── Via ───────────────────────────────────────────────────────────────────────────── */

/** The board's drill pairs (Board6 LAYERPAIRn), as "Top Layer - Bottom Layer". */
function drillPairs(ed: PcbEditor): [LayerId, LayerId][] {
  const b = ed.doc.board.bag;
  const out: [LayerId, LayerId][] = [];
  for (let i = 0; b?.has(`LAYERPAIR${i}LOW`); i++) {
    const lo = layerFromName(b.get(`LAYERPAIR${i}LOW`) ?? ''), hi = layerFromName(b.get(`LAYERPAIR${i}HIGH`) ?? '');
    if (lo && hi) out.push([lo, hi]);
  }
  return out.length ? out : [[L.TOP, L.BOTTOM]];
}
/** A copper layer's slot in a via's 32 per-layer diameters: top 0, mid layers 1–30, bottom 31. */
const slotOf = (l: LayerId) => (l === L.BOTTOM ? 31 : l - 1);

export function ViaDialog({ ed, prim, target }: { ed: PcbEditor; prim: PcbVia; target?: RecordTarget }) {
  const r = useRecord(ed, prim, target);
  const s = r.at(0);
  const full = s.bytes.length >= VIA.layerDiameters + 128;
  const long = s.bytes.length >= 246, tol = s.bytes.length >= 299;
  const mode = full ? s.get(VIA.mode) : 0;
  const layerDia = (slot: number) => s.get({ off: VIA.layerDiameters + 4 * slot, t: 'i32' }) || s.get(VIA.diameter);
  const setLayerDia = (slots: number[], v: number) => { for (const k of slots) put(s.bytes, { off: VIA.layerDiameters + 4 * k, t: 'i32' }, v); if (slots.includes(0)) put(s.bytes, VIA.diameter, v); r.bump(); };
  const copper = ed.doc.board.copperStack.filter(isSignal);
  const mids = Array.from({ length: 30 }, (_, i) => i + 1);
  const pairs = drillPairs(ed);
  const span = `${s.get(VIA.layerStart)}-${s.get(VIA.layerEnd)}`;
  const f1 = s.get(VIA.flags1), f2 = s.get(VIA.flags2);
  const manual = full && s.get(VIA.maskMode) === 2;
  const linked = !long || s.get(VIA.maskLinked) !== 0 || s.get(VIA.maskBottom) === s.get(VIA.maskTop);
  const [link, setLink] = useState(linked);
  // Solder Mask From The Hole Edge (Konium's extras [est])
  const [fromHole, setFromHole] = useState(() => { const rec = ed.doc.streams.get(prim.src.storage)?.records[prim.src.index]; return !!rec && !!padExtrasOf(rec).fromHoleEdge; });
  const ok = () => {
    r.commit('Via properties', false, (after) => {
      const a = after.subs[0]!;
      if (long && link) { put(a, VIA.maskBottom, r.at(0).get(VIA.maskTop)); }
      setPadExtras(after, fromHole ? { fromHoleEdge: true } : {}, 'Via');
    });
    closeDialog();
  };
  const tolText = (v: number) => (v === NO_TOLERANCE ? 'N/A' : undefined);
  return (
    <Dialog title={unitTitle(ed, 'Via')} width={620} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="pd"
      footer={<Footer ok={ok} extra={<button class="btn" disabled={!!target} onClick={() => showDialog(DrillPairManagerDialog, { ed })}>Drill Pairs</button>} />}>
      <div class="pd-figure">
        <div class="pd-fig-side">
          <Row label="Hole Size" for="pd-hole"><LenInput ed={ed} id="pd-hole" value={s.get(VIA.hole)} min={1} onChange={(v) => { if (v < s.get(VIA.diameter)) s.set(VIA.hole, v); }} /></Row>
          <Row label="Tolerance +">{tol && tolText(s.get(VIA.tolPlus)) ? <span class="pd-val pd-na">N/A</span> : tol ? <LenInput ed={ed} label="Tolerance +" value={s.get(VIA.tolPlus)} onChange={(v) => s.set(VIA.tolPlus, v)} /> : <span class="pd-val pd-na">N/A</span>}</Row>
          <Row label="−">{tol && !tolText(s.get(VIA.tolMinus)) ? <LenInput ed={ed} label="Tolerance −" value={s.get(VIA.tolMinus)} onChange={(v) => s.set(VIA.tolMinus, v)} /> : <span class="pd-val pd-na">N/A</span>}</Row>
        </div>
        <svg viewBox="0 0 200 160" class="pd-pic" aria-hidden="true">
          <line x1="100" y1="0" x2="100" y2="160" stroke={GUIDE} /><line x1="10" y1="80" x2="190" y2="80" stroke={GUIDE} />
          <circle cx="100" cy="80" r="38" fill={COPPER} stroke={EDGE} />
          <circle cx="100" cy="80" r="15" fill="#fff" stroke={EDGE} />
          <path d="M58 40 L78 20" stroke={ARROW} /><path d="M120 120 L140 140" stroke={ARROW} />
          <line x1="85" y1="80" x2="115" y2="80" stroke={ARROW} marker-start="url(#va)" marker-end="url(#va)" />
          <defs><marker id="va" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L6 3 L0 6z" fill={ARROW} /></marker></defs>
        </svg>
        <div class="pd-fig-side">
          <Row label="Diameter" for="pd-dia"><LenInput ed={ed} id="pd-dia" value={s.get(VIA.diameter)} min={1}
            onChange={(v) => { if (v > s.get(VIA.hole)) { setViaDiameter(s.bytes, v); r.bump(); } }} /></Row>
          <Row label="Location X"><CoordInput ed={ed} axis="x" label="Location X" value={s.get(VIA.x)} onChange={(v) => s.set(VIA.x, v)} /></Row>
          <Row label="Y"><CoordInput ed={ed} axis="y" label="Location Y" value={s.get(VIA.y)} onChange={(v) => s.set(VIA.y, v)} /></Row>
        </div>
      </div>
      <fieldset class="pd-group"><legend>Via Template</legend>
        <div class="pd-cols"><Row label="Template"><select disabled aria-label="Template"><option /></select></Row><span class="muted">Library</span><span class="muted pd-right">Unlink</span></div>
      </fieldset>
      <fieldset class="pd-group"><legend>Diameters</legend>
        <div class="pd-radios pd-spread">
          {([[0, 'Simple'], [1, 'Top-Middle-Bottom'], [2, 'Full Stack']] as const).map(([m, n]) => (
            <label key={m}><input type="radio" name="pd-viamode" checked={mode === m} disabled={!full && m !== 0} onChange={() => { if (m === 0) setViaDiameter(s.bytes, s.get(VIA.diameter)); s.set(VIA.mode, m); }} /> {n}</label>
          ))}
        </div>
        {mode === 1 && <div class="pd-stack">
          <Row label="Top"><LenInput ed={ed} label="Top diameter" value={layerDia(0)} min={1} onChange={(v) => setLayerDia([0], v)} /></Row>
          <Row label="Middle"><LenInput ed={ed} label="Middle diameter" value={layerDia(1)} min={1} onChange={(v) => setLayerDia(mids, v)} /></Row>
          <Row label="Bottom"><LenInput ed={ed} label="Bottom diameter" value={layerDia(31)} min={1} onChange={(v) => setLayerDia([31], v)} /></Row>
        </div>}
        {mode === 2 && <div class="pd-stack">
          {copper.map((l) => <Row key={l} label={ed.layerLabel(l)}><LenInput ed={ed} label={`${ed.layerLabel(l)} diameter`} value={layerDia(slotOf(l))} min={1} onChange={(v) => setLayerDia([slotOf(l)], v)} /></Row>)}
        </div>}
      </fieldset>
      <div class="pd-two">
        <div>
          <fieldset class="pd-group"><legend>Properties</legend>
            <Row label="Drill Pair"><select aria-label="Drill Pair" value={span} onChange={(e) => { const [a, b] = (e.target as HTMLSelectElement).value.split('-').map(Number); s.set(VIA.layerStart, a!); s.set(VIA.layerEnd, b!); }}>
              {[...new Set([span, ...pairs.map(([a, b]) => `${a}-${b}`)])].map((k) => { const [a, b] = k.split('-').map(Number); return <option key={k} value={k}>{ed.layerLabel(a!)} - {ed.layerLabel(b!)}</option>; })}
            </select></Row>
            <Row label="Net"><NetSelect ed={ed} value={s.get(VIA.net)} onChange={(n) => s.set(VIA.net, n)} /></Row>
            <Check label="Locked" checked={lockedOf(f1)} onChange={(v) => s.set(VIA.flags1, withLocked(f1, v))} />
          </fieldset>
          <Testpoints top={(f1 & FLAG.fabTop) !== 0} bottom={(f2 & FLAG.fabBottom) !== 0}
            onTop={(v) => s.set(VIA.flags1, v ? f1 | FLAG.fabTop : f1 & ~FLAG.fabTop)} onBottom={(v) => s.set(VIA.flags2, v ? f2 | FLAG.fabBottom : f2 & ~FLAG.fabBottom)}
            asm={long ? { top: (s.bytes[207]! & 1) !== 0, bottom: (s.bytes[208]! & 1) !== 0, set: (side, v) => { const k = side === 'top' ? 207 : 208; s.bytes[k] = v ? s.bytes[k]! | 1 : s.bytes[k]! & ~1; r.bump(); } } : undefined} />
        </div>
        <fieldset class="pd-group"><legend>Solder Mask Expansions</legend>
          <label class="pd-radio"><input type="radio" name="pd-vmask" checked={!manual} disabled={!full} onChange={() => s.set(VIA.maskMode, 1)} /> Expansion value from rules</label>
          <label class="pd-radio"><input type="radio" name="pd-vmask" checked={manual} disabled={!full} onChange={() => s.set(VIA.maskMode, 2)} /> Specify expansion value</label>
          <div class="pd-linked">
            <div>
              <Row label="Top :"><LenInput ed={ed} label="Top expansion" disabled={!manual} value={s.get(VIA.maskTop)} onChange={(v) => s.set(VIA.maskTop, v)} /></Row>
              <Row label="Bottom :"><LenInput ed={ed} label="Bottom expansion" disabled={!manual || link || !long} value={link ? s.get(VIA.maskTop) : s.get(VIA.maskBottom)} onChange={(v) => s.set(VIA.maskBottom, v)} /></Row>
            </div>
            <button class={`pd-link${link ? ' on' : ''}`} disabled={!manual || !long} title={link ? 'Top and bottom the same: click to set them apart' : 'Make the bottom the same as the top'} aria-pressed={link} onClick={() => setLink(!link)}>⛓</button>
          </div>
          <Check label="Solder Mask From The Hole Edge" checked={fromHole} disabled={!manual} title="The opening the hole grown by the expansion (manual expansion)" onChange={setFromHole} />
          <Check label="Force complete tenting on top" checked={(f1 & FLAG.tentTop) !== 0} onChange={(v) => s.set(VIA.flags1, v ? f1 | FLAG.tentTop : f1 & ~FLAG.tentTop)} />
          <Check label="Force complete tenting on bottom" checked={(f1 & FLAG.tentBottom) !== 0} onChange={(v) => s.set(VIA.flags1, v ? f1 | FLAG.tentBottom : f1 & ~FLAG.tentBottom)} />
        </fieldset>
      </div>
    </Dialog>
  );
}

/**
 * Testpoint Settings: Fabrication top / bottom (the flags bytes), Assembly top / bottom (a pad's
 * bytes 118 / 119, a long via record's 207 / 208, bit 0 [est: as the DRC reads them]).
 */
export function Testpoints({ top, bottom, onTop, onBottom, asm }: { top: boolean; bottom: boolean; onTop: (v: boolean) => void; onBottom: (v: boolean) => void;
  asm?: { top: boolean; bottom: boolean; set: (side: 'top' | 'bottom', v: boolean) => void } }) {
  return (
    <fieldset class="pd-group pd-tp"><legend>Testpoint Settings</legend>
      <span /><span class="pd-tp-h">Top</span><span class="pd-tp-h">Bottom</span>
      <span class="pd-label">Fabrication</span>
      <input type="checkbox" aria-label="Fabrication testpoint top" checked={top} onChange={(e) => onTop((e.target as HTMLInputElement).checked)} />
      <input type="checkbox" aria-label="Fabrication testpoint bottom" checked={bottom} onChange={(e) => onBottom((e.target as HTMLInputElement).checked)} />
      <span class="pd-label">Assembly</span>
      <input type="checkbox" aria-label="Assembly testpoint top" checked={!!asm?.top} disabled={!asm} title={asm ? undefined : 'This record is too short to hold it'} onChange={(e) => asm?.set('top', (e.target as HTMLInputElement).checked)} />
      <input type="checkbox" aria-label="Assembly testpoint bottom" checked={!!asm?.bottom} disabled={!asm} title={asm ? undefined : 'This record is too short to hold it'} onChange={(e) => asm?.set('bottom', (e.target as HTMLInputElement).checked)} />
    </fieldset>
  );
}

/** The dialog for a primitive, when it has one. */
export function primDialog(p: PcbPrim): ((props: { ed: PcbEditor; prim: never }) => preact.JSX.Element) | null {
  switch (p.kind) {
    case 'track': return TrackDialog as never;
    case 'arc': return ArcDialog as never;
    case 'fill': return FillDialog as never;
    case 'text': return StringDialog as never;
    case 'via': return ViaDialog as never;
    case 'region': return p.polygon === 0xffff ? RegionDialog as never : null;
    default: return null;
  }
}
