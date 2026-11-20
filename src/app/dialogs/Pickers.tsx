import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import type { FontSpec } from '../../model/schProps';
import { numIn } from './numIn';

/**
 * Choose Color and Font, the two pickers Altium's properties open: a colour as #rrggbb from
 * the Basic palette or as Custom red/green/blue; a font by name, style, size and effects.
 */

/** Altium-style basic palette: greys, then hues from dark to light (16 × 15). */
const BASIC: string[] = (() => {
  const out: string[] = [];
  const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
  for (let i = 0; i < 16; i++) { const v = (i * 255) / 15; out.push(hex(v, v, v)); }
  const hsl = (h: number, s: number, l: number) => {
    const a = s * Math.min(l, 1 - l), f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return hex(f(0) * 255, f(8) * 255, f(4) * 255);
  };
  const lights = [0.18, 0.28, 0.38, 0.48, 0.58, 0.68, 0.78, 0.88];
  for (const l of lights) for (let h = 0; h < 360; h += 360 / 16) out.push(hsl(h, l > 0.8 ? 0.7 : 0.85, l));
  // Altium's familiar defaults sit in the first custom row
  out.push('#000080', '#800000', '#0000ff', '#ff0000', '#ffffb0', '#80ffff', '#ffff80', '#008000', '#ffffff', '#c0c0c0', '#808080', '#000000', '#2b8a57', '#dcbc8c', '#f8fcff', '#b0e0ff');
  return out;
})();

export function ColourDialog({ value, onOk }: { value: string; onOk: (hex: string) => void }) {
  const [tab, setTab] = useState<'basic' | 'custom'>('basic');
  const [v, setV] = useState(/^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : '#000000');
  const rgb = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
  const setRgb = (k: number, n: number) => { const c = [...rgb]; c[k] = Math.min(255, Math.max(0, n | 0)); setV(`#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`); };
  const ok = () => { closeDialog(); onOk(v); };
  return (
    <Dialog title="Choose Colour" width={420} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="colour-dlg"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="dlg-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'basic'} onClick={() => setTab('basic')}>Basic</button>
        <button role="tab" aria-selected={tab === 'custom'} onClick={() => setTab('custom')}>Custom</button>
      </div>
      <div class="colour-body">
        {tab === 'basic' ? (
          <div class="colour-grid" role="listbox" aria-label="Colours">
            {BASIC.map((c) => <button key={c} role="option" aria-selected={c === v} class={c === v ? 'on' : ''} style={{ background: c }} title={c} onClick={() => setV(c)} onDblClick={() => { setV(c); closeDialog(); onOk(c); }} />)}
          </div>
        ) : (
          <div class="colour-custom">
            {['Red', 'Green', 'Blue'].map((n, k) => (
              <label key={n}>{n}<input type="range" min={0} max={255} value={rgb[k]} onInput={(e) => setRgb(k, Number((e.target as HTMLInputElement).value))} />
                <input type="number" min={0} max={255} value={rgb[k]} onInput={(e) => setRgb(k, Number((e.target as HTMLInputElement).value))} /></label>
            ))}
            <label>Hex<input type="text" value={v} onInput={(e) => { const t = (e.target as HTMLInputElement).value.trim(); if (/^#?[0-9a-f]{6}$/i.test(t)) setV(`#${t.replace('#', '').toLowerCase()}`); }} /></label>
            <label>Pick<input type="color" value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} /></label>
          </div>
        )}
        <div class="colour-compare">
          <span>New</span><span class="swatch big" style={{ background: v }} aria-label="New colour" />
          <span>Current</span><span class="swatch big" style={{ background: value }} aria-label="Current colour" />
        </div>
      </div>
    </Dialog>
  );
}

const FONTS = ['Arial', 'Arial Black', 'Arial Narrow', 'Calibri', 'Cambria', 'Consolas', 'Courier New', 'Georgia', 'Lucida Console', 'Microsoft Sans Serif',
  'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
const STYLES = ['Regular', 'Italic', 'Bold', 'Bold Italic'];

export function FontDialog({ value, onOk }: { value?: FontSpec; onOk: (f: FontSpec) => void }) {
  const [f, setF] = useState<FontSpec>(() => value ?? { name: 'Times New Roman', size: 10, bold: false, italic: false, underline: false, strikeout: false });
  const style = STYLES[(f.bold ? 2 : 0) + (f.italic ? 1 : 0)]!;
  const set = (p: Partial<FontSpec>) => setF({ ...f, ...p });
  const names = FONTS.includes(f.name) ? FONTS : [f.name, ...FONTS];
  const ok = () => { if (!f.name.trim() || !(f.size > 0)) return; closeDialog(); onOk({ ...f, name: f.name.trim() }); };
  return (
    <Dialog title="Font" width={470} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="font-dlg"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="font-cols">
        <label class="font-col">Font:
          <input type="text" value={f.name} onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
          <select size={7} value={f.name} onChange={(e) => set({ name: (e.target as HTMLSelectElement).value })}>{names.map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
        <label class="font-col">Font style:
          <input type="text" value={style} readOnly />
          <select size={7} value={style} onChange={(e) => { const i = STYLES.indexOf((e.target as HTMLSelectElement).value); set({ bold: i >= 2, italic: i % 2 === 1 }); }}>{STYLES.map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
        <label class="font-col narrow">Size:
          <input type="number" min={1} max={200} value={f.size} onInput={(e) => set({ size: numIn(e, f.size) })} />
          <select size={7} value={String(f.size)} onChange={(e) => set({ size: Number((e.target as HTMLSelectElement).value) })}>{SIZES.map((n) => <option key={n} value={String(n)}>{n}</option>)}</select>
        </label>
      </div>
      <div class="font-bottom">
        <fieldset><legend>Effects</legend>
          <label><input type="checkbox" checked={f.strikeout} onChange={(e) => set({ strikeout: (e.target as HTMLInputElement).checked })} />Strikeout</label>
          <label><input type="checkbox" checked={f.underline} onChange={(e) => set({ underline: (e.target as HTMLInputElement).checked })} />Underline</label>
        </fieldset>
        <fieldset class="font-sample"><legend>Sample</legend>
          <span style={{ fontFamily: f.name, fontSize: `${Math.min(28, f.size * 1.4)}px`, fontWeight: f.bold ? 700 : 400, fontStyle: f.italic ? 'italic' : 'normal',
            textDecoration: [f.underline ? 'underline' : '', f.strikeout ? 'line-through' : ''].join(' ').trim() || 'none' }}>AaBbYyZz</span>
        </fieldset>
      </div>
    </Dialog>
  );
}
