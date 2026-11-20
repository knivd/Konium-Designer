/**
 * Double-click a pad: AD17's Pad dialog. The pad drawn on the layer of the tab below it (copper
 * per layer, mask and paste grown by their expansions); Location, Hole Information (size,
 * tolerances, round / rect / slot, plated), Properties, Testpoint Settings, Size and Shape
 * (Simple, Top-Middle-Bottom, Full Stack; Round, Rectangular, Octagonal, Rounded Rectangle with
 * its corner radius), Offset From Hole Center, Paste and Solder Mask Expansions, tenting.
 * Pads6 subrecord 5 holds the pad; subrecord 6 (when the pad has one) the per-layer stack.
 * Pad Template takes another pad's stack (the board's pads, by AD's template names); Edit Full
 * Pad Layer Definition lists every copper layer's size and shape; the bottom solder mask
 * expansion can be unlinked from the top, and a through pad's opening measured from its hole
 * (kept as Konium's pad extras [est]).
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import type { PcbPad } from '../../model/pcb';
import { L, isSignal, type LayerId } from '../../model/layers';
import { FLAG, NO_TOLERANCE, PAD, PAD_STACK, get, put, type Field } from '../../formats/altium/pcbLayouts';
import { toV7 } from '../../formats/altium/pcbdoc';
import { binToBytes, bytesToBin, cp1252ToStr } from '../../formats/text';
import { AngleInput, Check, CoordInput, LenInput, NetSelect, Row, fmtLen, lockedOf, unitTitle, useRecord, withLocked, type RecordTarget } from './pcbFields';
import { Testpoints } from './PrimDialogs';
import { showDialog } from './index';
import { padTemplateName, padTemplates } from '../../model/padTemplates';
import { padExtrasOf, setPadExtras, type PadExtras } from '../../formats/altium/primInfo';
import { parseLength } from '../../core/units';

type Shape = 'round' | 'rect' | 'octagon' | 'roundrect';
const SHAPES: [Shape, string][] = [['round', 'Round'], ['rect', 'Rectangular'], ['octagon', 'Octagonal'], ['roundrect', 'Rounded Rectangle']];
const BASE: Record<Shape, number> = { round: 1, rect: 2, octagon: 3, roundrect: 1 };
const ALT: Record<Shape, number> = { round: 1, rect: 2, octagon: 3, roundrect: 9 };
const i32 = (off: number): Field => ({ off, t: 'i32' });

/** Where a copper layer's size lives: top, the 29 inner slots, bottom. */
type Slot = { kind: 'top' } | { kind: 'mid'; i: number } | { kind: 'bot' };
const slotOf = (l: LayerId): Slot => (l === L.TOP ? { kind: 'top' } : l === L.BOTTOM ? { kind: 'bot' } : { kind: 'mid', i: l - L.MID1 });
/** A layer's place in the per-layer arrays (V6 layer − 1): top 0, mid n → n, bottom 31. */
const v6 = (l: LayerId) => (l === L.BOTTOM ? 31 : l - 1);

export function PadDialog({ ed, prim, target }: { ed: PcbEditor; prim: PcbPad; target?: RecordTarget }) {
  const r = useRecord(ed, prim, target);
  const s = r.at(4);
  const st = r.subs[5] && r.subs[5].length >= PAD_STACK.minLen ? r.subs[5] : null;
  const sg = (f: Field) => (st ? get(st, f) ?? 0 : 0);
  const sp = (f: Field, v: number) => { if (st) { put(st, f, v); r.bump(); } };
  const [name, setName] = useState(() => { const b = r.subs[0]!; return b.length ? cp1252ToStr(bytesToBin(b.subarray(1, 1 + Math.min(b[0]!, b.length - 1)))) : ''; });
  const layer = s.get(PAD.layer);
  const multi = layer === L.MULTI;
  const mode = s.get(PAD.padMode);
  const copper = multi ? ed.doc.board.copperStack.filter(isSignal) : [layer];
  const tabs: [string, LayerId][] = multi
    ? [[ed.layerLabel(L.TOP), L.TOP], ...(mode !== 0 ? copper.filter((l) => l !== L.TOP && l !== L.BOTTOM).map((l): [string, LayerId] => [ed.layerLabel(l), l]) : []), [ed.layerLabel(L.BOTTOM), L.BOTTOM],
      ['Top Paste', L.TOP_PASTE], ['Top Solder', L.TOP_SOLDER], ['Bottom Solder', L.BOTTOM_SOLDER], ['Bottom Paste', L.BOTTOM_PASTE], ['Multi-Layer', L.MULTI]]
    : layer === L.BOTTOM ? [[ed.layerLabel(L.BOTTOM), L.BOTTOM], ['Bottom Paste', L.BOTTOM_PASTE], ['Bottom Solder', L.BOTTOM_SOLDER]]
    : [[ed.layerLabel(L.TOP), L.TOP], ['Top Paste', L.TOP_PASTE], ['Top Solder', L.TOP_SOLDER]];
  const [tab, setTab] = useState<LayerId>(multi ? L.MULTI : layer);

  /* sizes and shapes per copper layer */
  const size = (l: LayerId) => {
    const sl = slotOf(l);
    const [w, h, sh] = sl.kind === 'top' ? [s.get(PAD.topX), s.get(PAD.topY), s.get(PAD.topShape)]
      : sl.kind === 'bot' ? [s.get(PAD.botX), s.get(PAD.botY), s.get(PAD.botShape)]
      : st && mode === 2 ? [sg(i32(PAD_STACK.innerX + 4 * sl.i)), sg(i32(PAD_STACK.innerY + 4 * sl.i)), st[PAD_STACK.innerShape + sl.i]!] : [s.get(PAD.midX), s.get(PAD.midY), s.get(PAD.midShape)];
    const alt = st?.[PAD_STACK.altShape + v6(l)];
    const shape: Shape = alt === 9 ? 'roundrect' : sh === 2 ? 'rect' : sh === 3 ? 'octagon' : 'round';
    return { w, h, shape, corner: st?.[PAD_STACK.cornerRadius + v6(l)] ?? 50 };
  };
  const setSize = (ls: LayerId[], p: Partial<{ w: number; h: number; shape: Shape; corner: number }>) => {
    for (const l of ls) {
      const sl = slotOf(l);
      const fx = sl.kind === 'top' ? PAD.topX : sl.kind === 'bot' ? PAD.botX : PAD.midX;
      const fy = sl.kind === 'top' ? PAD.topY : sl.kind === 'bot' ? PAD.botY : PAD.midY;
      const fs = sl.kind === 'top' ? PAD.topShape : sl.kind === 'bot' ? PAD.botShape : PAD.midShape;
      if (p.w !== undefined) put(s.bytes, fx, p.w);
      if (p.h !== undefined) put(s.bytes, fy, p.h);
      if (p.shape) put(s.bytes, fs, BASE[p.shape]);
      if (st && sl.kind === 'mid') {
        if (p.w !== undefined) put(st, i32(PAD_STACK.innerX + 4 * sl.i), p.w);
        if (p.h !== undefined) put(st, i32(PAD_STACK.innerY + 4 * sl.i), p.h);
        if (p.shape) st[PAD_STACK.innerShape + sl.i] = BASE[p.shape];
      }
      if (st && p.shape) st[PAD_STACK.altShape + v6(l)] = ALT[p.shape];
      if (st && p.corner !== undefined) st[PAD_STACK.cornerRadius + v6(l)] = Math.max(0, Math.min(100, Math.round(p.corner)));
    }
    r.bump();
  };
  /** Simple: one size for all copper layers; Top-Middle-Bottom: top, every inner layer, bottom. */
  const allCopper: LayerId[] = multi ? [L.TOP, ...Array.from({ length: 30 }, (_, i) => L.MID1 + i), L.BOTTOM] : [layer];
  const midLayers: LayerId[] = Array.from({ length: 30 }, (_, i) => L.MID1 + i);
  /** Every copper layer of the board, top to bottom (Edit Full Pad Layer Definition). */
  const copperAll: LayerId[] = ed.doc.board.copperStack.filter(isSignal);

  /* hole */
  const holeShape = st ? st[PAD_STACK.holeShape]! : 0;
  const tolOk = s.bytes.length >= 170, lenOk = s.bytes.length >= 202;
  /* masks */
  const pasteMode = s.get(PAD.pasteMode), solderMode = s.get(PAD.solderMode);
  const f1 = s.get(PAD.flags1), f2 = s.get(PAD.flags2);
  const offX = st ? sg(i32(PAD_STACK.offsetX)) : 0, offY = st ? sg(i32(PAD_STACK.offsetY)) : 0;
  const setOffset = (x: number | undefined, y: number | undefined) => {
    if (!st) return;
    for (let k = 0; k < 32; k++) { if (x !== undefined) put(st, i32(PAD_STACK.offsetX + 4 * k), x); if (y !== undefined) put(st, i32(PAD_STACK.offsetY + 4 * k), y); }
    r.bump();
  };

  /* Konium's pad extras: the bottom solder mask expansion unlinked, the opening from the hole's edge */
  const [extras, setExtras] = useState<PadExtras>(() => { const rec = ed.doc.streams.get(prim.src.storage)?.records[prim.src.index]; return rec ? padExtrasOf(rec) : {}; });
  const linked = extras.bottom === undefined;
  const bottomVal = linked ? s.get(PAD.solderManual) : Math.round(parseLength(extras.bottom!) ?? s.get(PAD.solderManual));
  const fmtMil = (v: number) => `${+(v / 10_000).toFixed(4)}mil`;
  /* Pad Template: another of the board's pads' stack */
  const templates = padTemplates(ed.doc);
  const own = padTemplateName(prim);
  const [template, setTemplate] = useState(own);
  const takeTemplate = (n: string) => {
    const tp = templates.get(n);
    const rec = tp ? ed.doc.streams.get(tp.src.storage)?.records[tp.src.index] : undefined;
    if (!tp || !rec) return;
    const from = rec.subs[4]!;
    for (const fl of [PAD.topX, PAD.topY, PAD.midX, PAD.midY, PAD.botX, PAD.botY, PAD.topShape, PAD.midShape, PAD.botShape, PAD.hole, PAD.padMode]) { const v = get(from, fl); if (v !== undefined) put(s.bytes, fl, v); }
    const fst = rec.subs[5];
    // The stack's sizes, shapes, hole shape and slot; its shapes' kinds and corner radii (not the hole offsets)
    if (st && fst && fst.length >= PAD_STACK.minLen) { st.set(fst.subarray(0, PAD_STACK.offsetX)); st.set(fst.subarray(PAD_STACK.altShape, PAD_STACK.minLen), PAD_STACK.altShape); }
    setTemplate(n);
    r.bump();
  };

  const ok = () => {
    r.commit('Pad properties', false, (after) => {
      const b = binToBytes(name.slice(0, 255)); const o = new Uint8Array(b.length + 1); o[0] = b.length; o.set(b, 1);
      after.subs[0] = o;
      setPadExtras(after, { ...(extras.bottom !== undefined ? { bottom: extras.bottom } : {}), ...(extras.fromHoleEdge && multi ? { fromHoleEdge: true } : {}) });
    });
    closeDialog();
  };

  const ShapeRow = ({ label, ls, key }: { label?: string; ls: LayerId[]; key?: number }) => {
    const z = size(ls[0]!);
    return (
      <div class="pd-shape-row" key={key}>
        {label !== undefined && <span class="pd-label">{label}</span>}
        <LenInput ed={ed} label={`${label ?? ''} X-Size`.trim()} class="pd-box" value={z.w} min={1} onChange={(v) => setSize(ls, { w: v })} />
        <LenInput ed={ed} label={`${label ?? ''} Y-Size`.trim()} class="pd-box" value={z.h} min={1} onChange={(v) => setSize(ls, { h: v })} />
        <select aria-label={`${label ?? ''} Shape`.trim()} value={z.shape} onChange={(e) => setSize(ls, { shape: (e.target as HTMLSelectElement).value as Shape })}>
          {SHAPES.map(([k, n]) => <option key={k} value={k} disabled={k === 'roundrect' && !st}>{n}</option>)}
        </select>
        <input type="text" class="pd-box" aria-label={`${label ?? ''} Corner Radius`.trim()} disabled={z.shape !== 'roundrect'} value={`${z.corner}%`}
          onChange={(e) => { const n = parseFloat((e.target as HTMLInputElement).value); if (Number.isFinite(n)) setSize(ls, { corner: n }); }} onKeyDown={(e) => e.stopPropagation()} />
      </div>
    );
  };

  return (
    <Dialog title={unitTitle(ed, 'Pad')} width={900} height={760} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="pd padd"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <PadPreview ed={ed} tab={tab} name={name} shape={size(tab === L.MULTI || !isSignal(tab) ? (multi ? L.TOP : layer) : tab)} hole={multi ? s.get(PAD.hole) : 0}
        holeShape={holeShape} slot={st ? sg(i32(PAD_STACK.slotLength)) : 0} rotation={s.get(PAD.rotation)}
        expansion={tab === L.TOP_SOLDER || tab === L.BOTTOM_SOLDER ? (solderMode === 2 ? s.get(PAD.solderManual) : 40000) : tab === L.TOP_PASTE || tab === L.BOTTOM_PASTE ? (pasteMode === 2 ? s.get(PAD.pasteManual) : 0) : 0} />
      <div class="pd-tabs" role="tablist">
        {tabs.map(([n, l]) => <button key={n} role="tab" aria-selected={tab === l} class={tab === l ? 'on' : ''} onClick={() => setTab(l)}>{n}</button>)}
      </div>
      <fieldset class="pd-group"><legend>Pad Template</legend>
        <div class="pd-cols"><Row label="Template"><select aria-label="Template" value={template} title="Take the size, shape and hole of another of the board's pads"
          onChange={(e) => takeTemplate((e.target as HTMLSelectElement).value)}>
          {!templates.has(own) && <option value={own}>{own}</option>}
          {[...templates.keys()].map((n) => <option key={n} value={n}>{n}</option>)}</select></Row><span>Library</span><span class="pd-right">{ed.doc.name}</span></div>
      </fieldset>
      <div class="pd-two">
        <div>
          <fieldset class="pd-group"><legend>Location</legend>
            <Row label="X"><CoordInput ed={ed} axis="x" label="X" value={s.get(PAD.x)} onChange={(v) => s.set(PAD.x, v)} /></Row>
            <Row label="Y"><CoordInput ed={ed} axis="y" label="Y" value={s.get(PAD.y)} onChange={(v) => s.set(PAD.y, v)} /></Row>
            <Row label="Rotation"><AngleInput label="Rotation" value={s.get(PAD.rotation)} onChange={(a) => s.set(PAD.rotation, a)} /></Row>
          </fieldset>
          <fieldset class="pd-group" disabled={!multi}><legend>Hole Information</legend>
            <Row label="Hole Size" for="pd-hole"><LenInput ed={ed} id="pd-hole" value={s.get(PAD.hole)} min={0} onChange={(v) => s.set(PAD.hole, v)} /></Row>
            <div class="pd-row"><span class="pd-label">Tolerance</span><div class="pd-field pd-tol">
              + {tolOk && s.get(PAD.tolPlus) !== NO_TOLERANCE ? <LenInput ed={ed} label="Tolerance +" class="pd-box" value={s.get(PAD.tolPlus)} onChange={(v) => s.set(PAD.tolPlus, v)} /> : <span class="pd-box pd-na">N/A</span>}
              − {tolOk && s.get(PAD.tolMinus) !== NO_TOLERANCE ? <LenInput ed={ed} label="Tolerance −" class="pd-box" value={s.get(PAD.tolMinus)} onChange={(v) => s.set(PAD.tolMinus, v)} /> : <span class="pd-box pd-na">N/A</span>}
            </div></div>
            <div class="pd-radios pd-col">
              {([[0, 'Round'], [1, 'Rect'], [2, 'Slot']] as const).map(([k, n]) => (
                <label key={k}><input type="radio" name="pd-hs" checked={holeShape === k} disabled={!st && k !== 0} onChange={() => { if (st) { st[PAD_STACK.holeShape] = k; r.bump(); } }} /> {n}</label>
              ))}
            </div>
            {holeShape === 2 && <>
              <Row label="Length"><LenInput ed={ed} label="Slot length" value={sg(i32(PAD_STACK.slotLength))} min={0} onChange={(v) => sp(i32(PAD_STACK.slotLength), v)} /></Row>
              <Row label="Rotation"><AngleInput label="Slot rotation" value={st ? get(st, { off: PAD_STACK.slotRotation, t: 'f64' }) ?? 0 : 0} onChange={(a) => sp({ off: PAD_STACK.slotRotation, t: 'f64' }, a)} /></Row>
            </>}
            <Check label="Plated" checked={s.get(PAD.plated) !== 0} onChange={(v) => s.set(PAD.plated, v ? 1 : 0)} />
          </fieldset>
          <fieldset class="pd-group"><legend>Properties</legend>
            <Row label="Designator" for="pd-name"><input type="text" id="pd-name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /></Row>
            <Row label="Layer"><select aria-label="Layer" value={String(layer)} onChange={(e) => { const l = Number((e.target as HTMLSelectElement).value); if (s.bytes.length >= PAD.layerV7.off + 4) put(s.bytes, PAD.layerV7, toV7(l)); s.set(PAD.layer, l); }}>
              {[L.TOP, L.BOTTOM, L.MULTI].map((l) => <option key={l} value={String(l)}>{l === L.MULTI ? 'Multi-Layer' : ed.layerLabel(l)}</option>)}
            </select></Row>
            <Row label="Net"><NetSelect ed={ed} value={s.get(PAD.net)} onChange={(n) => s.set(PAD.net, n)} /></Row>
            <Row label="Electrical Type"><select aria-label="Electrical Type" value={String(s.bytes.length > PAD.electrical.off ? s.get(PAD.electrical) : 0)} title="Load, Terminator or Source (for Signal Integrity and From-To routing)"
              onChange={(e) => s.set(PAD.electrical, Number((e.target as HTMLSelectElement).value))}>
              <option value="0">Load</option><option value="1">Terminator</option><option value="2">Source</option></select></Row>
            <Row label="Pin/Pkg Length">{lenOk ? <LenInput ed={ed} label="Pin/Pkg Length" value={s.get(PAD.pinLength)} min={0} onChange={(v) => s.set(PAD.pinLength, v)} /> : <span class="pd-val">{fmtLen(ed, 0)}</span>}</Row>
            <div class="pd-row"><span class="pd-label">Jumper ID</span><div class="pd-field pd-jumper">
              <input type="number" class="pd-box" min={0} max={32767} value={s.get(PAD.jumperId)} aria-label="Jumper ID" disabled={s.bytes.length < PAD.jumperId.off + 2}
                title="Pads of the component with the same Jumper ID are joined inside it (0: none)"
                onChange={(e) => { const v = Math.round(Number((e.target as HTMLInputElement).value)); if (v >= 0 && v <= 32767) s.set(PAD.jumperId, v); }} onKeyDown={(e) => e.stopPropagation()} />
              <Check label="Locked" checked={lockedOf(f1)} onChange={(v) => s.set(PAD.flags1, withLocked(f1, v))} />
            </div></div>
          </fieldset>
          <Testpoints top={(f1 & FLAG.fabTop) !== 0} bottom={(f2 & FLAG.fabBottom) !== 0}
            onTop={(v) => s.set(PAD.flags1, v ? f1 | FLAG.fabTop : f1 & ~FLAG.fabTop)} onBottom={(v) => s.set(PAD.flags2, v ? f2 | FLAG.fabBottom : f2 & ~FLAG.fabBottom)}
            asm={s.bytes.length > 119 ? { top: (s.bytes[118]! & 1) !== 0, bottom: (s.bytes[119]! & 1) !== 0, set: (side, v) => { const k = side === 'top' ? 118 : 119; s.bytes[k] = v ? s.bytes[k]! | 1 : s.bytes[k]! & ~1; r.bump(); } } : undefined} />
        </div>
        <div>
          <fieldset class="pd-group"><legend>Size and Shape</legend>
            <div class="pd-radios pd-spread">
              {([[0, 'Simple'], [1, 'Top-Middle-Bottom'], [2, 'Full Stack']] as const).map(([m, n]) => (
                <label key={m}><input type="radio" name="pd-padmode" checked={mode === m} disabled={(!multi && m !== 0) || (m === 2 && !st)} onChange={() => s.set(PAD.padMode, m)} /> {n}</label>
              ))}
            </div>
            <div class="pd-shape-row pd-shape-head">{mode !== 0 && <span />}<span>X-Size</span><span>Y-Size</span><span>Shape</span><span>Corner Radius</span></div>
            {mode === 0 && ShapeRow({ ls: allCopper })}
            {mode === 1 && <>
              {ShapeRow({ label: 'Top', ls: [L.TOP] })}
              {ShapeRow({ label: 'Middle', ls: midLayers })}
              {ShapeRow({ label: 'Bottom', ls: [L.BOTTOM] })}
            </>}
            {mode === 2 && copper.map((l) => ShapeRow({ label: ed.layerLabel(l), ls: [l], key: l }))}
            <button class="btn pd-full" disabled={!multi || !st} title={multi && st ? 'Every copper layer\'s size and shape' : 'For a through pad with a full stack'}
              onClick={() => { s.set(PAD.padMode, 2); showDialog(PadLayersDialog, { layers: copperAll, row: (l: LayerId) => ShapeRow({ label: ed.layerLabel(l), ls: [l], key: l }) }); }}>Edit Full Pad Layer Definition...</button>
            <div class="pd-row"><span class="pd-label">Offset From Hole Centre (X/Y)</span><div class="pd-field pd-tol">
              <LenInput ed={ed} label="Offset X" class="pd-box" disabled={!st} value={offX} onChange={(v) => setOffset(v, undefined)} />
              <LenInput ed={ed} label="Offset Y" class="pd-box" disabled={!st} value={offY} onChange={(v) => setOffset(undefined, v)} />
            </div></div>
          </fieldset>
          <fieldset class="pd-group"><legend>Paste Mask Expansion</legend>
            <label class="pd-radio"><input type="radio" name="pd-pm" checked={pasteMode !== 2} onChange={() => s.set(PAD.pasteMode, 1)} /> Expansion value from rules</label>
            <div class="pd-radio-val"><label class="pd-radio"><input type="radio" name="pd-pm" checked={pasteMode === 2} onChange={() => s.set(PAD.pasteMode, 2)} /> Specify expansion value</label>
              <LenInput ed={ed} label="Paste expansion" class="pd-box" disabled={pasteMode !== 2} value={s.get(PAD.pasteManual)} onChange={(v) => s.set(PAD.pasteManual, v)} /></div>
          </fieldset>
          <fieldset class="pd-group"><legend>Solder Mask Expansions</legend>
            <label class="pd-radio"><input type="radio" name="pd-sm" checked={solderMode !== 2} onChange={() => s.set(PAD.solderMode, 1)} /> Expansion value from rules</label>
            <label class="pd-radio"><input type="radio" name="pd-sm" checked={solderMode === 2} onChange={() => s.set(PAD.solderMode, 2)} /> Specify expansion values:</label>
            <div class="pd-linked">
              <div>
                <Row label="Top :"><LenInput ed={ed} label="Top solder expansion" disabled={solderMode !== 2} value={s.get(PAD.solderManual)} onChange={(v) => s.set(PAD.solderManual, v)} /></Row>
                <Row label="Bottom :"><LenInput ed={ed} label="Bottom solder expansion" disabled={solderMode !== 2 || linked} value={bottomVal} onChange={(v) => setExtras({ ...extras, bottom: fmtMil(v) })} /></Row>
              </div>
              <button class={`pd-link${linked ? ' on' : ''}`} disabled={solderMode !== 2} aria-pressed={linked} title={linked ? 'Top and bottom the same: click to give the bottom its own' : 'The bottom its own: click to make it the top\'s'}
                onClick={() => setExtras(linked ? { ...extras, bottom: fmtMil(s.get(PAD.solderManual)) } : { fromHoleEdge: extras.fromHoleEdge })}>⛓</button>
            </div>
            <Check label="Solder Mask From The Hole Edge" checked={!!extras.fromHoleEdge && multi} disabled={!multi || solderMode !== 2 || (f1 & (FLAG.tentTop | FLAG.tentBottom)) !== 0}
              title="A through pad's opening the hole's shape grown by the expansion (manual expansion, not tented)" onChange={(v) => setExtras({ ...extras, fromHoleEdge: v || undefined })} />
            <Check label="Force complete tenting on top" checked={(f1 & FLAG.tentTop) !== 0} onChange={(v) => s.set(PAD.flags1, v ? f1 | FLAG.tentTop : f1 & ~FLAG.tentTop)} />
            <Check label="Force complete tenting on bottom" checked={(f1 & FLAG.tentBottom) !== 0} onChange={(v) => s.set(PAD.flags1, v ? f1 | FLAG.tentBottom : f1 & ~FLAG.tentBottom)} />
          </fieldset>
        </div>
      </div>
    </Dialog>
  );
}

/** The pad on one layer: copper in the layer's colour, mask and paste grown by their expansion, the hole, the designator. */
function PadPreview({ ed, tab, name, shape, hole, holeShape, slot, rotation, expansion }: {
  ed: PcbEditor; tab: LayerId; name: string; shape: { w: number; h: number; shape: Shape; corner: number }; hole: number; holeShape: number; slot: number; rotation: number; expansion: number;
}) {
  const colours: Record<number, string> = { [L.TOP]: '#e8211d', [L.BOTTOM]: '#3a6cff', [L.TOP_SOLDER]: '#8a2be2', [L.BOTTOM_SOLDER]: '#c040c0', [L.TOP_PASTE]: '#808080', [L.BOTTOM_PASTE]: '#a0a0a0', [L.MULTI]: '#c0c0c0' };
  const colour = colours[tab] ?? (isSignal(tab) ? '#d8a020' : '#c0c0c0');
  // In mils: browsers won't draw text as large as the file's units
  const k = 1e-4;
  hole *= k; slot *= k;
  const w = (shape.w + 2 * expansion) * k, h = (shape.h + 2 * expansion) * k;
  const span = Math.max(w, h, hole + slot, 1) * 1.6;
  const rr = shape.shape === 'round' ? Math.min(w, h) / 2 : shape.shape === 'roundrect' ? (Math.min(w, h) / 2) * (shape.corner / 100) : 0;
  const oct = Math.min(w, h) / 4;
  const body = shape.shape === 'octagon'
    ? <polygon points={[[-w / 2 + oct, -h / 2], [w / 2 - oct, -h / 2], [w / 2, -h / 2 + oct], [w / 2, h / 2 - oct], [w / 2 - oct, h / 2], [-w / 2 + oct, h / 2], [-w / 2, h / 2 - oct], [-w / 2, -h / 2 + oct]].map((p) => p.join(',')).join(' ')} fill={colour} />
    : <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={rr} ry={rr} fill={colour} />;
  const holeEl = hole > 0 && (holeShape === 2
    ? <rect x={-(slot || hole) / 2} y={-hole / 2} width={slot || hole} height={hole} rx={hole / 2} fill="#14706f" />
    : holeShape === 1 ? <rect x={-hole / 2} y={-hole / 2} width={hole} height={hole} fill="#14706f" /> : <circle r={hole / 2} fill="#14706f" />);
  void ed;
  return (
    <svg class="pd-padview" viewBox={`${-span} ${-span / 2} ${2 * span} ${span}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Pad ${name}`}>
      <rect x={-span} y={-span / 2} width={2 * span} height={span} fill="#000" />
      <g transform={`rotate(${-rotation})`}>{body}{holeEl}</g>
      <text x="0" y="0" text-anchor="middle" dominant-baseline="central" font-size={Math.min(w, h) * 0.4} fill="#fff" font-family="Arial, sans-serif">{name}</text>
    </svg>
  );
}

/** Edit Full Pad Layer Definition: each copper layer's X and Y size, shape and corner radius. */
function PadLayersDialog({ layers, row }: { layers: LayerId[]; row: (l: LayerId) => preact.JSX.Element }) {
  const [, setRev] = useState(0);
  return (
    <Dialog title="Pad Layer Editor" width={620} height={560} onClose={closeDialog} class="pd padlayers"
      footer={<><span class="spacer" /><button class="btn default" onClick={() => closeDialog()}>Close</button></>}>
      <div class="pd-shape-row pd-shape-head"><span>Layer</span><span>X-Size</span><span>Y-Size</span><span>Shape</span><span>Corner Radius</span></div>
      <div onInput={() => setRev((n) => n + 1)} onChange={() => setRev((n) => n + 1)}>{layers.map((l) => row(l))}</div>
    </Dialog>
  );
}
