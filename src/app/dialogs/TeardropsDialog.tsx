/**
 * Tools › Teardrops: what to do (add or remove), to which objects, how the teardrops are made,
 * and each kind of joint with its sizes. Each kind's drawing is made by the geometry that makes
 * the teardrops themselves, so it shows the sizes as typed.
 */
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { settings, updateSettings } from '../../core/settings';
import {
  cleanTeardropSettings, edgeTeardrop, roundTeardrop, stepTeardrop, teeTeardrop, type TeardropSettings, type V2,
} from '../../model/teardropRegions';

export interface TeardropChoice { add: boolean; selectedOnly: boolean; settings: TeardropSettings }

type Shape = { plus: V2[]; minus: V2[] } | null;
/** A drawing's size, and a teardrop's outline as a path in it (`x`, `y`: where a point of the track's frame falls). */
const VW = 150, VH = 92;
const pathOf = (m: Shape, x: (p: V2) => number, y: (p: V2) => number): string =>
  (m ? `${[...m.plus, ...[...m.minus].reverse()].map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(2)} ${y(p).toFixed(2)}`).join(' ')} Z` : '');

/** A measure drawn beside the copper: a thin line with an end tick each side and its letter. */
function Measure({ x1, y1, x2, y2, label, at = 'end' }: { x1: number; y1: number; x2: number; y2: number; label: string; at?: 'end' | 'mid' }) {
  const upright = Math.abs(x2 - x1) < 0.01, t = 2.5;
  const tick = (x: number, y: number) => (upright ? <line x1={x - t} y1={y} x2={x + t} y2={y} /> : <line x1={x} y1={y - t} x2={x} y2={y + t} />);
  const lx = upright ? x1 + (at === 'mid' ? -7 : 0) : (x1 + x2) / 2, ly = upright ? (at === 'mid' ? (y1 + y2) / 2 + 3 : Math.min(y1, y2) - 4) : y1 + 10;
  return <g class="td-measure"><line x1={x1} y1={y1} x2={x2} y2={y2} />{tick(x1, y1)}{tick(x2, y2)}<text x={lx} y={ly} text-anchor="middle">{label}</text></g>;
}

/** Via or through-hole pad: a round pad of diameter d, the track leaving it to the right. */
function ViaPicture({ s }: { s: TeardropSettings }) {
  const cx = 44, cy = 44, r = 25, w = 9;
  const m = roundTeardrop(r, w, 0, s.viaPad.width, s.viaPad.length, s.style);
  const wide = m ? m.plus[m.plus.length - 1]! : null, far = m ? m.plus[0]! : null;
  return (
    <svg class="td-pic" viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label="A teardrop where a track leaves a via or a through-hole pad">
      <rect class="td-copper" x={cx} y={cy - w / 2} width={VW - cx} height={w} />
      <path class="td-drop" d={pathOf(m, (p) => cx + p.u, (p) => cy - p.v)} />
      <circle class="td-copper" cx={cx} cy={cy} r={r} /><circle class="td-hole" cx={cx} cy={cy} r={r * 0.42} />
      <Measure x1={cx - r - 8} y1={cy - r} x2={cx - r - 8} y2={cy + r} label="d" at="mid" />
      {wide && far && <>
        <Measure x1={cx + wide.u} y1={cy - wide.v} x2={cx + wide.u} y2={cy + wide.v} label="W" />
        <Measure x1={cx + Math.sqrt(r * r - (w * w) / 4)} y1={cy + r + 6} x2={cx + far.u} y2={cy + r + 6} label="L" />
      </>}
    </svg>
  );
}

/** SMD pad: a rectangular pad, the track of width w leaving its side. */
function SmdPicture({ s }: { s: TeardropSettings }) {
  const cx = 30, cy = 44, pw = 30, ph = 62, w = 11;
  const pts: V2[] = [{ u: pw / 2, v: ph / 2 }, { u: -pw / 2, v: ph / 2 }, { u: -pw / 2, v: -ph / 2 }, { u: pw / 2, v: -ph / 2 }];
  const m = edgeTeardrop(pts, w, 0, (s.smd.width / 100) * w, (s.smd.length / 100) * w, s.style, 0.3);
  const wide = m ? m.plus[m.plus.length - 1]! : null, far = m ? m.plus[0]! : null;
  return (
    <svg class="td-pic" viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label="A teardrop where a track leaves a surface-mount pad">
      <rect class="td-copper" x={cx} y={cy - w / 2} width={VW - cx} height={w} />
      <path class="td-drop" d={pathOf(m, (p) => cx + p.u, (p) => cy - p.v)} />
      <rect class="td-copper" x={cx - pw / 2} y={cy - ph / 2} width={pw} height={ph} rx="2" />
      <Measure x1={VW - 12} y1={cy - w / 2} x2={VW - 12} y2={cy + w / 2} label="w" />
      {wide && far && <>
        <Measure x1={cx + pw / 2 - 5} y1={cy - wide.v} x2={cx + pw / 2 - 5} y2={cy + wide.v} label="W" at="mid" />
        <Measure x1={cx + pw / 2} y1={cy + Math.max(wide.v, w / 2) + 7} x2={cx + far.u} y2={cy + Math.max(wide.v, w / 2) + 7} label="L" />
      </>}
    </svg>
  );
}

/** Tracks: a track of width w running on into a narrower one. */
function TracksPicture({ s }: { s: TeardropSettings }) {
  const x0 = 52, cy = 44, wide = 26, w = 9;
  const m = stepTeardrop(w, wide, (s.tracks.length / 100) * wide, s.style);
  return (
    <svg class="td-pic" viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label="A teardrop where a track changes width">
      <rect class="td-copper" x={x0} y={cy - w / 2} width={VW - x0} height={w} />
      <path class="td-drop" d={pathOf(m, (p) => x0 + p.u, (p) => cy - p.v)} />
      <rect class="td-copper" x={0} y={cy - wide / 2} width={x0} height={wide} />
      <Measure x1={14} y1={cy - wide / 2} x2={14} y2={cy + wide / 2} label="w" at="mid" />
      <Measure x1={x0} y1={cy + wide / 2 + 7} x2={x0 + m.reach} y2={cy + wide / 2 + 7} label="L" />
    </svg>
  );
}

/** T-junction: a track ending square on another of width w. */
function TeePicture({ s }: { s: TeardropSettings }) {
  const cx = 75, cy = 62, w = 11;
  const half = ((s.tJunction.span / 100) * w) / 2, H = (s.tJunction.height / 100) * w;
  const m = teeTeardrop(w, w, half, H, s.style, 0.3);
  return (
    <svg class="td-pic" viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label="A teardrop where a track ends on another">
      <path class="td-drop" d={pathOf(m, (p) => cx + p.u, (p) => cy - p.v)} />
      <rect class="td-copper" x={0} y={cy - w / 2} width={VW} height={w} />
      <rect class="td-copper" x={cx - w / 2} y={0} width={w} height={cy} />
      <Measure x1={14} y1={cy - w / 2} x2={14} y2={cy + w / 2} label="w" />
      {m && <>
        <Measure x1={cx - half} y1={cy + w / 2 + 7} x2={cx + half} y2={cy + w / 2 + 7} label="W" />
        <Measure x1={cx + half + 8} y1={cy - w / 2 - H} x2={cx + half + 8} y2={cy - w / 2} label="L" />
      </>}
    </svg>
  );
}

/** One per cent of a scope: its name, the number, and what it is a per cent of. */
function Pct({ label, of, value, min, max, disabled, onChange }: { label: string; of: string; value: number; min: number; max: number; disabled: boolean; onChange: (n: number) => void }) {
  return (
    <label class="td-pct"><span>{label}</span>
      <input type="number" min={min} max={max} step="1" value={value} disabled={disabled} aria-label={`${label}, per cent of ${of}`}
        onInput={(e) => { const n = Number((e.target as HTMLInputElement).value); if ((e.target as HTMLInputElement).value.trim() !== '' && Number.isFinite(n)) onChange(n); }} />
      <span class="td-of">% of {of}</span>
    </label>
  );
}

function Scope({ title, on, off, onToggle, picture, children }: { title: string; on: boolean; off: boolean; onToggle: (v: boolean) => void; picture: ComponentChildren; children: ComponentChildren }) {
  return (
    <div class={`td-scope${on && !off ? '' : ' off'}`}>
      <label class="td-scope-head"><input type="checkbox" checked={on} disabled={off} onChange={(e) => onToggle((e.target as HTMLInputElement).checked)} /><span>{title}</span></label>
      {picture}
      <div class="td-fields">{children}</div>
    </div>
  );
}

export function TeardropsDialog({ selected, onOk }: { selected: number; onOk: (c: TeardropChoice) => void }) {
  const [add, setAdd] = useState(true);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [s, setS] = useState<TeardropSettings>(() => structuredClone(settings.pcbTeardrops));
  // (the drawings follow the typing; what is used and kept is brought within each size's limits)
  const ok = () => { const clean = cleanTeardropSettings(s); updateSettings({ pcbTeardrops: clean }); closeDialog(); onOk({ add, selectedOnly, settings: clean }); };
  const off = !add;
  const none = add && !s.viaPad.on && !s.smd.on && !s.tracks.on && !s.tJunction.on;
  const radio = (name: string, label: string, checked: boolean, pick: () => void, disabled = false, title?: string) =>
    <label class="td-radio" title={title}><input type="radio" name={name} checked={checked} disabled={disabled} onChange={pick} /><span>{label}</span></label>;
  const option = (label: string, k: 'force' | 'adjust' | 'report', says: string) => (
    <label class="td-option"><input type="checkbox" checked={s[k]} disabled={off} onChange={(e) => setS({ ...s, [k]: (e.target as HTMLInputElement).checked })} />
      <span><b>{label}</b><small>{says}</small></span></label>
  );
  return (
    <Dialog title="Teardrops" width={724} onClose={closeDialog} onAccept={() => { if (!none) ok(); return false; }} class="teardropsdlg"
      footer={<><span class="spacer" /><button class="btn default" disabled={none} onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="td-top">
        <div class="td-what">
          <fieldset class="pd-group"><legend>Working Mode</legend>
            <div class="td-radios">{radio('tdm', 'Add', add, () => setAdd(true))}{radio('tdm', 'Remove', !add, () => setAdd(false))}</div>
          </fieldset>
          <fieldset class="pd-group"><legend>Objects</legend>
            <div class="td-radios">{radio('tdo', 'All', !selectedOnly, () => setSelectedOnly(false))}
              {radio('tdo', 'Selected only', selectedOnly, () => setSelectedOnly(true), !selected, selected ? undefined : 'Nothing is selected on the board')}</div>
          </fieldset>
        </div>
        <fieldset class={`pd-group td-options${off ? ' off' : ''}`}><legend>Options</legend>
          <label class="td-style"><span>Teardrop style</span>
            <select value={s.style} disabled={off} onChange={(e) => setS({ ...s, style: (e.target as HTMLSelectElement).value === 'line' ? 'line' : 'curved' })}>
              <option value="curved">Curved</option><option value="line">Line</option></select></label>
          {option('Force teardrops', 'force', 'Made at every pad and via, even where one comes closer to other copper than the rules allow.')}
          {option('Adjust teardrop size', 'adjust', 'Made smaller where one of the size set has no room, or would come too close to other copper.')}
          {option('Generate report', 'report', 'A list of the teardrops made and of those that could not be.')}
        </fieldset>
      </div>
      <fieldset class="pd-group td-scopes-box"><legend>Scope</legend>
        <div class="td-scopes">
          <Scope title="Via/TH Pad" on={s.viaPad.on} off={off} onToggle={(v) => setS({ ...s, viaPad: { ...s.viaPad, on: v } })} picture={<ViaPicture s={s} />}>
            <Pct label="Length" of="d" value={s.viaPad.length} min={1} max={300} disabled={off || !s.viaPad.on} onChange={(n) => setS({ ...s, viaPad: { ...s.viaPad, length: n } })} />
            <Pct label="Width" of="d" value={s.viaPad.width} min={1} max={99} disabled={off || !s.viaPad.on} onChange={(n) => setS({ ...s, viaPad: { ...s.viaPad, width: n } })} />
          </Scope>
          <Scope title="SMD Pad" on={s.smd.on} off={off} onToggle={(v) => setS({ ...s, smd: { ...s.smd, on: v } })} picture={<SmdPicture s={s} />}>
            <Pct label="Length" of="w" value={s.smd.length} min={1} max={1000} disabled={off || !s.smd.on} onChange={(n) => setS({ ...s, smd: { ...s.smd, length: n } })} />
            <Pct label="Width" of="w" value={s.smd.width} min={101} max={1000} disabled={off || !s.smd.on} onChange={(n) => setS({ ...s, smd: { ...s.smd, width: n } })} />
          </Scope>
          <Scope title="Tracks" on={s.tracks.on} off={off} onToggle={(v) => setS({ ...s, tracks: { ...s.tracks, on: v } })} picture={<TracksPicture s={s} />}>
            <Pct label="Length" of="w" value={s.tracks.length} min={1} max={1000} disabled={off || !s.tracks.on} onChange={(n) => setS({ ...s, tracks: { ...s.tracks, length: n } })} />
          </Scope>
          <Scope title="T-Junction" on={s.tJunction.on} off={off} onToggle={(v) => setS({ ...s, tJunction: { ...s.tJunction, on: v } })} picture={<TeePicture s={s} />}>
            <Pct label="Length" of="w" value={s.tJunction.height} min={1} max={1000} disabled={off || !s.tJunction.on} onChange={(n) => setS({ ...s, tJunction: { ...s.tJunction, height: n } })} />
            <Pct label="Width" of="w" value={s.tJunction.span} min={101} max={2000} disabled={off || !s.tJunction.on} onChange={(n) => setS({ ...s, tJunction: { ...s.tJunction, span: n } })} />
          </Scope>
        </div>
      </fieldset>
    </Dialog>
  );
}
