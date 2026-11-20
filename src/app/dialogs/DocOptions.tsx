import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { ColourDialog, FontDialog } from './Pickers';
import type { SchEditor } from '../../editors/sch/SchEditor';
import { PropertyBag } from '../../formats/altium/props';
import { SCH_UNIT, SCH_UNIT_CODES, isMetricUnit } from '../../core/units';
import { schUnitCode, sheetUnit } from '../newSheet';
import { SR, bagOf, schCoord, setSchCoord } from '../../model/sch';
import { addRecords, removeObjects, replaceBags, setProps, uniqueId } from '../../model/schEdit';
import { bgrOf, ensureFont, fmtCoord, hexOf, parseCoord, sheetFonts, type FontSpec } from '../../model/schProps';
import type { Change } from '../../core/undo';

/**
 * Design › Document Options (D, O): the sheet's own settings as Altium Designer 17 lays them
 * out — Sheet Options (orientation, title block, reference zones, border, colours, snap /
 * visible / electrical grids, system font, standard or custom size) and Parameters (the
 * document's parameters, which title blocks show). One undo step on OK.
 */

export const SHEET_STYLES = ['A4', 'A3', 'A2', 'A1', 'A0', 'A', 'B', 'C', 'D', 'E', 'Letter', 'Legal', 'Tabloid', 'OrCAD A', 'OrCAD B', 'OrCAD C', 'OrCAD D', 'OrCAD E'] as const;
const TITLE_STYLES = ['Standard', 'ANSI'] as const;

interface DocParam { index?: number; name: string; value: string }

const IMPERIAL: [number, string][] = [[SCH_UNIT_CODES.mil, 'Mils'], [SCH_UNIT_CODES.in, 'Inches'], [SCH_UNIT_CODES.dxp, 'Dxp Defaults'], [SCH_UNIT_CODES.autoImperial, 'Auto-Imperial']];
const METRIC: [number, string][] = [[SCH_UNIT_CODES.mm, 'Millimetres'], [SCH_UNIT_CODES.cm, 'Centimetres'], [SCH_UNIT_CODES.m, 'Metres'], [SCH_UNIT_CODES.autoMetric, 'Auto-Metric']];

export function DocOptionsDialog({ ed, tab: tab0 = 'sheet' }: { ed: SchEditor; tab?: 'sheet' | 'parameters' | 'units' }) {
  const doc = ed.doc;
  const sheetObj = doc.objects.find((o) => o.record === SR.SHEET);
  const sb = sheetObj ? bagOf(doc, sheetObj)! : PropertyBag.from({ RECORD: SR.SHEET });
  // Lengths in the sheet's own unit (Units tab: Dxp Defaults are plain 10 mil units, as in AD), converted when it changes
  const len = (k: string, def: number) => fmtCoord(sb.has(k) ? schCoord(sb, k) : def, sheetUnit(doc));
  const fonts = sheetFonts(doc);
  const [tab, setTab] = useState(tab0);
  const [f, setF] = useState(() => ({
    portrait: sb.int('WORKSPACEORIENTATION') === 1,
    titleBlock: sb.bool('TITLEBLOCKON'), titleStyle: sb.int('DOCUMENTBORDERSTYLE'),
    sheetNumberSpaces: String(sb.int('SHEETNUMBERSPACESIZE', 4)), zones: sb.has('REFERENCEZONESON') ? sb.bool('REFERENCEZONESON') : true,
    border: sb.bool('BORDERON'), templateGraphics: sb.bool('SHOWTEMPLATEGRAPHICS'),
    borderColour: hexOf(sb.int('COLOR', 0)), sheetColour: hexOf(sb.int('AREACOLOR', 16317695)),
    snapOn: sb.has('SNAPGRIDON') ? sb.bool('SNAPGRIDON') : true, snap: len('SNAPGRIDSIZE', 10 * SCH_UNIT),
    visibleOn: sb.has('VISIBLEGRIDON') ? sb.bool('VISIBLEGRIDON') : true, visible: len('VISIBLEGRIDSIZE', 10 * SCH_UNIT),
    electricalOn: sb.has('HOTSPOTGRIDON') ? sb.bool('HOTSPOTGRIDON') : true, electrical: len('HOTSPOTGRIDSIZE', 4 * SCH_UNIT),
    style: sb.int('SHEETSTYLE'), custom: sb.bool('USECUSTOMSHEET'),
    cw: len('CUSTOMX', 1500 * SCH_UNIT), ch: len('CUSTOMY', 950 * SCH_UNIT), xz: String(sb.int('CUSTOMXZONES', 6)), yz: String(sb.int('CUSTOMYZONES', 4)),
    margin: len('CUSTOMMARGINWIDTH', 20 * SCH_UNIT),
    systemFont: null as FontSpec | null,
    // Units: the system and the unit each one uses (the other's from Preferences › Schematic › Defaults)
    metric: isMetricUnit(sheetUnit(doc)),
    imperialUnit: isMetricUnit(sheetUnit(doc)) ? schUnitCode(false) : sheetUnit(doc),
    metricUnit: isMetricUnit(sheetUnit(doc)) ? sheetUnit(doc) : schUnitCode(true),
  }));
  const params0: DocParam[] = doc.objects.filter((o) => o.record === SR.PARAMETER && o.owner < 0).map((o) => ({ index: o.index, name: bagOf(doc, o)?.get('NAME') ?? '', value: bagOf(doc, o)?.get('TEXT') ?? '' }));
  const [params, setParams] = useState(params0);
  const [pSel, setPSel] = useState<number | null>(null);
  const codeOf = (x: typeof f) => (x.metric ? x.metricUnit : x.imperialUnit);
  const set = (p: Partial<typeof f>) => {
    const next = { ...f, ...p };
    const a = codeOf(f), b = codeOf(next);
    if (a !== b) for (const k of ['snap', 'visible', 'electrical', 'cw', 'ch', 'margin'] as const) { const c = parseCoord(next[k], a); if (c !== undefined) next[k] = fmtCoord(c, b); }
    setF(next);
  };
  const sysFont = f.systemFont ?? fonts[(sb.int('SYSTEMFONT', 1) || 1) - 1];

  const ok = () => {
    const after = sb.clone();
    // Booleans are written only when true; a key that defaults to on (absent = on) is written F to turn it off
    const flag = (k: string, on: boolean, defOn: boolean) => {
      if (on === (sb.has(k) ? sb.bool(k) : defOn)) return;
      if (on) after.set(k, 'T'); else if (defOn) after.set(k, 'F'); else after.delete(k);
    };
    const int = (k: string, v: number, def: number) => { if (v !== sb.int(k, def)) { if (v) after.set(k, String(v)); else after.delete(k); } };
    const coord = (k: string, v: string, def: number) => { const c = parseCoord(v, codeOf(f)); if (c !== undefined && c > 0 && c !== (sb.has(k) ? schCoord(sb, k) : def)) setSchCoord(after, k, c); };
    int('WORKSPACEORIENTATION', f.portrait ? 1 : 0, 0);
    flag('TITLEBLOCKON', f.titleBlock, false);
    int('DOCUMENTBORDERSTYLE', f.titleStyle, 0);
    int('SHEETNUMBERSPACESIZE', Number(f.sheetNumberSpaces) || 4, 4);
    flag('REFERENCEZONESON', f.zones, true);
    flag('BORDERON', f.border, false);
    flag('SHOWTEMPLATEGRAPHICS', f.templateGraphics, false);
    const bc = bgrOf(f.borderColour), sc = bgrOf(f.sheetColour);
    if (bc !== undefined && bc !== sb.int('COLOR', 0)) after.set('COLOR', String(bc));
    if (sc !== undefined && sc !== sb.int('AREACOLOR', 16317695)) after.set('AREACOLOR', String(sc));
    flag('SNAPGRIDON', f.snapOn, true); coord('SNAPGRIDSIZE', f.snap, 10 * SCH_UNIT);
    flag('VISIBLEGRIDON', f.visibleOn, true); coord('VISIBLEGRIDSIZE', f.visible, 10 * SCH_UNIT);
    flag('HOTSPOTGRIDON', f.electricalOn, true); coord('HOTSPOTGRIDSIZE', f.electrical, 4 * SCH_UNIT);
    int('SHEETSTYLE', f.style, 0);
    if (f.custom !== sb.bool('USECUSTOMSHEET')) { if (f.custom) after.set('USECUSTOMSHEET', 'T'); else after.delete('USECUSTOMSHEET'); }
    if (f.custom) {
      coord('CUSTOMX', f.cw, 1500 * SCH_UNIT); coord('CUSTOMY', f.ch, 950 * SCH_UNIT);
      int('CUSTOMXZONES', Number(f.xz) || 6, 6); int('CUSTOMYZONES', Number(f.yz) || 4, 4); coord('CUSTOMMARGINWIDTH', f.margin, 20 * SCH_UNIT);
    }
    const unit = f.metric ? f.metricUnit : f.imperialUnit;
    if (unit !== sheetUnit(doc)) after.set('DISPLAY_UNIT', String(unit));
    const ch: (() => Change | null)[] = [];
    if (sheetObj && after.toBytes().join() !== sb.toBytes().join()) ch.push(() => replaceBags(doc, [{ index: sheetObj.index, before: sb.clone(), after }]));
    if (f.systemFont) ch.push(() => {
      const { id, change } = ensureFont(doc, f.systemFont!);
      const sheetI = doc.objects.find((o) => o.record === SR.SHEET)!.index;
      const apply: Change = { apply: () => {}, revert: () => {} };
      let inner: Change | null = null;
      apply.apply = () => { inner ??= setProps(doc, sheetI, { SYSTEMFONT: String(id) }); inner.apply(); };
      apply.revert = () => inner?.revert();
      return change ? { apply: () => { change.apply(); apply.apply(); }, revert: () => { apply.revert(); change.revert(); } } : apply;
    });
    for (const p of params) {
      const o = p.index !== undefined ? doc.objects[p.index] : undefined;
      if (o) {
        const b = bagOf(doc, o)!, q: Record<string, string | null> = {};
        if (p.name !== (b.get('NAME') ?? '')) q.NAME = p.name;
        if (p.value !== (b.get('TEXT') ?? '')) q.TEXT = p.value;
        if (Object.keys(q).length) ch.push(() => setProps(doc, o.index, q));
      } else if (p.name.trim()) {
        ch.push(() => addRecords(doc, [PropertyBag.from({ RECORD: SR.PARAMETER, OWNERPARTID: -1, ISHIDDEN: 'T', COLOR: 8388608, FONTID: 1, NAME: p.name.trim(), TEXT: p.value, UNIQUEID: uniqueId() })]));
      }
    }
    const gone = params0.filter((p) => !params.some((q) => q.index === p.index)).map((p) => p.index!);
    if (gone.length) ch.push(() => removeObjects(doc, gone));
    closeDialog();
    if (!ch.length) return;
    ed.undo.transact('Document options', (tx) => { for (const c of ch) { const v = c(); if (v) tx.add(v); } });
    ed.gridIndex = Math.max(0, ed.gridSizes().indexOf(doc.sheet.snapGrid));
    ed.invalidate();
  };

  const check = (label: string, key: keyof typeof f) => (
    <label class="do-check"><input type="checkbox" checked={!!f[key]} onChange={(e) => set({ [key]: (e.target as HTMLInputElement).checked } as Partial<typeof f>)} />{label}</label>
  );
  const text = (key: keyof typeof f, disabled = false) => (
    <input type="text" value={String(f[key])} disabled={disabled} onInput={(e) => set({ [key]: (e.target as HTMLInputElement).value } as Partial<typeof f>)} />
  );
  const colour = (label: string, key: 'borderColour' | 'sheetColour') => (
    <label class="do-row"><span>{label}</span><button class="dlg-colour" aria-label={label} onClick={() => showDialog(ColourDialog, { value: f[key], onOk: (v: string) => set({ [key]: v }) })}><span class="swatch" style={{ background: f[key] }} /></button></label>
  );

  return (
    <Dialog title="Document Options" width={784} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="docopts"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="dlg-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'sheet'} onClick={() => setTab('sheet')}>Sheet Options</button>
        <button role="tab" aria-selected={tab === 'parameters'} onClick={() => setTab('parameters')}>Parameters</button>
        <button role="tab" aria-selected={tab === 'units'} onClick={() => setTab('units')}>Units</button>
      </div>
      {tab === 'units' ? (
        <div class="do-units">
          <fieldset><legend>Imperial Unit System</legend>
            <label class="do-check"><input type="radio" name="do-sys" checked={!f.metric} onChange={() => set({ metric: false })} />Use Imperial Unit System</label>
            <label class="do-row"><span>Imperial unit used</span><select value={String(f.imperialUnit)} disabled={f.metric} onChange={(e) => set({ imperialUnit: Number((e.target as HTMLSelectElement).value) })}>{IMPERIAL.map(([v, t]) => <option key={v} value={String(v)}>{t}</option>)}</select></label>
          </fieldset>
          <fieldset><legend>Metric Unit System</legend>
            <label class="do-check"><input type="radio" name="do-sys" checked={f.metric} onChange={() => set({ metric: true })} />Use Metric Unit System</label>
            <label class="do-row"><span>Metric unit used</span><select value={String(f.metricUnit)} disabled={!f.metric} onChange={(e) => set({ metricUnit: Number((e.target as HTMLSelectElement).value) })}>{METRIC.map(([v, t]) => <option key={v} value={String(v)}>{t}</option>)}</select></label>
          </fieldset>
          <p class="muted small">The status bar shows lengths on this sheet in {(f.metric ? METRIC : IMPERIAL).find(([v]) => v === (f.metric ? f.metricUnit : f.imperialUnit))?.[1] ?? ''}.</p>
        </div>
      ) : tab === 'sheet' ? (
        <div class="do-cols">
          <fieldset><legend>Options</legend>
            <label class="do-row"><span>Orientation</span><select value={f.portrait ? '1' : '0'} onChange={(e) => set({ portrait: (e.target as HTMLSelectElement).value === '1' })}><option value="0">Landscape</option><option value="1">Portrait</option></select></label>
            <div class="do-row">{check('Title Block', 'titleBlock')}<select value={String(f.titleStyle)} disabled={!f.titleBlock} onChange={(e) => set({ titleStyle: Number((e.target as HTMLSelectElement).value) })}>{TITLE_STYLES.map((t, i) => <option key={t} value={String(i)}>{t}</option>)}</select></div>
            <label class="do-row"><span>Sheet Number Spaces</span>{text('sheetNumberSpaces')}</label>
            {check('Show Reference Zones', 'zones')}
            {check('Show Border', 'border')}
            {check('Show Template Graphics', 'templateGraphics')}
            {colour('Border Colour', 'borderColour')}
            {colour('Sheet Colour', 'sheetColour')}
          </fieldset>
          <div class="do-mid">
            <fieldset><legend>Grids</legend>
              <div class="do-row">{check('Snap', 'snapOn')}{text('snap', !f.snapOn)}</div>
              <div class="do-row">{check('Visible', 'visibleOn')}{text('visible', !f.visibleOn)}</div>
            </fieldset>
            <fieldset><legend>Electrical Grid</legend>
              {check('Enable', 'electricalOn')}
              <label class="do-row"><span>Grid Range</span>{text('electrical', !f.electricalOn)}</label>
            </fieldset>
            <button class="btn" onClick={() => showDialog(FontDialog, { value: sysFont ? { ...sysFont } : undefined, onOk: (v: FontSpec) => set({ systemFont: v }) })}>Change System Font</button>
            <p class="muted small">{sysFont ? `${sysFont.name}, ${sysFont.size}` : ''}</p>
          </div>
          <div class="do-right">
            <fieldset><legend>Standard Style</legend>
              <label class="do-row"><span>Standard styles</span><select value={String(f.style)} disabled={f.custom} onChange={(e) => set({ style: Number((e.target as HTMLSelectElement).value) })}>{SHEET_STYLES.map((t, i) => <option key={t} value={String(i)}>{t}</option>)}</select></label>
            </fieldset>
            <fieldset><legend>Custom Style</legend>
              {check('Use Custom style', 'custom')}
              <label class="do-row"><span>Custom Width</span>{text('cw', !f.custom)}</label>
              <label class="do-row"><span>Custom Height</span>{text('ch', !f.custom)}</label>
              <label class="do-row"><span>X Region Count</span>{text('xz', !f.custom)}</label>
              <label class="do-row"><span>Y Region Count</span>{text('yz', !f.custom)}</label>
              <label class="do-row"><span>Margin Width</span>{text('margin', !f.custom)}</label>
            </fieldset>
          </div>
        </div>
      ) : (
        <div class="do-params">
          <div class="cp-grid" role="grid">
            <div class="do-prow cp-ghead" role="row"><span>Name</span><span>Value</span></div>
            {params.map((p, i) => (
              <div key={i} class={`do-prow${pSel === i ? ' on' : ''}`} role="row" onMouseDown={() => setPSel(i)}>
                <input type="text" value={p.name} aria-label="Parameter name" onInput={(e) => setParams(params.map((q, k) => (k === i ? { ...q, name: (e.target as HTMLInputElement).value } : q)))} />
                <input type="text" value={p.value} aria-label={`${p.name} value`} onInput={(e) => setParams(params.map((q, k) => (k === i ? { ...q, value: (e.target as HTMLInputElement).value } : q)))} />
              </div>
            ))}
          </div>
          <div class="cp-buttons">
            <button class="btn" onClick={() => { setParams([...params, { name: `Parameter${params.length + 1}`, value: '*' }]); setPSel(params.length); }}>Add...</button>
            <button class="btn" disabled={pSel === null || !params[pSel]} onClick={() => { setParams(params.filter((_, k) => k !== pSel)); setPSel(null); }}>Remove...</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
