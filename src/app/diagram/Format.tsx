/**
 * The Format panel: with nothing selected the diagram's (grid, page view,
 * background, shadow, paper size, page); with shapes or connectors selected their Style, Text and
 * Arrange tabs. Each change is one undoable step.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  alignCells, attr, change, distributeCells, groupCells, labelText, orderCells, routeKind, setEdgePoints, ungroupCells, pageName, removePage, renamePage, resizeCell, setCellStyle, setLabel, setModelAttr, setSheet, setStyle, setStyles, Style,
  type Cell, type DiagramPage, type DrawioDocument,
} from '../../formats/drawio';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from '../dialogs';
import { hex, look, MARKERS, num } from './render';
import { clearDefaultStyle, copiedStyle, copyStyle, hasDefaultStyle, pageSize, PAPER, paperOf, setDefaultStyle } from './ops';

/* ─── Colours ─── */

/** The colour palette (a row of greys, then light to dark hues). */
const PALETTE: string[][] = [
  ['FFFFFF', 'E6E6E6', 'CCCCCC', 'B3B3B3', '999999', '808080', '666666', '4D4D4D', '333333', '1A1A1A', '000000'],
  ['FFCCCC', 'FFE6CC', 'FFFFCC', 'E6FFCC', 'CCFFCC', 'CCFFE6', 'CCFFFF', 'CCE5FF', 'CCCCFF', 'E5CCFF', 'FFCCFF'],
  ['FF9999', 'FFCC99', 'FFFF99', 'CCFF99', '99FF99', '99FFCC', '99FFFF', '99CCFF', '9999FF', 'CC99FF', 'FF99FF'],
  ['FF6666', 'FFB366', 'FFFF66', 'B3FF66', '66FF66', '66FFB3', '66FFFF', '66B2FF', '6666FF', 'B266FF', 'FF66FF'],
  ['FF0000', 'FF8000', 'FFFF00', '80FF00', '00FF00', '00FF80', '00FFFF', '007FFF', '0000FF', '7F00FF', 'FF00FF'],
  ['CC0000', 'CC6600', 'CCCC00', '66CC00', '00CC00', '00CC66', '00CCCC', '0066CC', '0000CC', '6600CC', 'CC00CC'],
  ['990000', '994C00', '999900', '4D9900', '009900', '00994D', '009999', '004C99', '000099', '4C0099', '990099'],
  ['660000', '663300', '666600', '336600', '006600', '006633', '006666', '003366', '000066', '330066', '660066'],
];

/** A colour's button: its swatch; the palette (and None, and any colour) when clicked. */
export function ColourButton({ label, value, def, onPick, none = true, icon, disabled }: { label: string; value: string | undefined; def: string; onPick: (c: string | null) => void; none?: boolean; icon?: preact.ComponentChildren; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const window = box.current?.ownerDocument.defaultView ?? globalThis.window;
    window.addEventListener('pointerdown', off, true);
    return () => window.removeEventListener('pointerdown', off, true);
  }, [open]);
  const shown = hex(value, def);
  const pick = (c: string | null) => { setOpen(false); onPick(c); };
  return (
    <span class="dg-colour" ref={box}>
      {icon
        ? <button type="button" class={`tbtn${open ? ' on' : ''}`} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>{icon}</button>
        : <button type="button" class="dg-swatch" aria-label={label} title={`${label}: ${shown === 'none' ? 'None' : shown}`} aria-haspopup="dialog" aria-expanded={open}
          style={{ background: shown === 'none' ? undefined : shown }} data-none={shown === 'none' ? '' : undefined} onClick={() => setOpen(!open)} />}
      {open && (
        <div class="dg-palette" role="dialog" aria-label={label}>
          {PALETTE.map((row, i) => <div key={i} class="dg-palette-row">{row.map((c) => <button key={c} type="button" class="dg-chip" style={{ background: `#${c}` }} title={`#${c}`} aria-label={`#${c}`} onClick={() => pick(`#${c}`)} />)}</div>)}
          <div class="dg-palette-foot">
            {none && <button type="button" class="btn" onClick={() => pick('none')}>None</button>}
            <label class="small">Other <input type="color" aria-label={`${label}: any colour`} value={/^#[0-9a-f]{6}$/i.test(shown) ? shown : def} onChange={(e) => pick((e.target as HTMLInputElement).value)} /></label>
            <button type="button" class="btn" onClick={() => pick(null)} title="The default colour">Default</button>
          </div>
        </div>
      )}
    </span>
  );
}

/** The quick styles: fill, line (and gradient, text) together. The first takes them all back to the defaults. */
const SWATCHES: { fill: string | null; stroke: string | null; gradient?: string; font?: string }[] = [
  { fill: null, stroke: null }, { fill: '#f5f5f5', stroke: '#666666', font: '#333333' }, { fill: '#dae8fc', stroke: '#6c8ebf' }, { fill: '#d5e8d4', stroke: '#82b366' },
  { fill: '#ffe6cc', stroke: '#d79b00' }, { fill: '#fff2cc', stroke: '#d6b656' }, { fill: '#f8cecc', stroke: '#b85450' }, { fill: '#e1d5e7', stroke: '#9673a6' },
  { fill: '#f5f5f5', stroke: '#666666', gradient: '#b3b3b3' }, { fill: '#dae8fc', stroke: '#6c8ebf', gradient: '#7ea6e0' }, { fill: '#d5e8d4', stroke: '#82b366', gradient: '#97d077' },
  { fill: '#ffcd28', stroke: '#d79b00', gradient: '#ffa500' }, { fill: '#fff2cc', stroke: '#d6b656', gradient: '#ffd966' }, { fill: '#f8cecc', stroke: '#b85450', gradient: '#ea6b66' },
  { fill: '#e6d0de', stroke: '#996185', gradient: '#d5739d' }, { fill: '#eeeeee', stroke: '#36393d' }, { fill: '#f9f7ed', stroke: '#36393d' }, { fill: '#ffcc99', stroke: '#36393d' },
  { fill: '#cce5ff', stroke: '#36393d' }, { fill: '#ffff88', stroke: '#36393d' }, { fill: '#cdeb8b', stroke: '#36393d' },
];

const PATTERNS: { id: string; label: string; dashed: string | null; pattern: string | null }[] = [
  { id: 'solid', label: 'Solid', dashed: null, pattern: null },
  { id: 'dashed', label: 'Dashed', dashed: '1', pattern: null },
  { id: 'dotted', label: 'Dotted (1 1)', dashed: '1', pattern: '1 1' },
  { id: 'dotted2', label: 'Dotted (1 2)', dashed: '1', pattern: '1 2' },
  { id: 'dotted4', label: 'Dotted (1 4)', dashed: '1', pattern: '1 4' },
];
const patternOf = (s: Style) => (look(s, 'dashed') !== '1' ? 'solid' : PATTERNS.find((p) => p.pattern === (s.get('dashPattern') ?? null))?.id ?? 'dashed');
const FONTS = ['Helvetica', 'Verdana', 'Times New Roman', 'Garamond', 'Comic Sans MS', 'Courier New', 'Georgia', 'Lucida Console', 'Tahoma'];
/** The label positions: where the label's box goes, and how the text sits in it. */
const POSITIONS: { id: string; label: string; lp: string | null; vlp: string | null; align: string | null; va: string | null }[] = [
  { id: 'topLeft', label: 'Top Left', lp: 'left', vlp: 'top', align: 'right', va: 'bottom' },
  { id: 'top', label: 'Top', lp: null, vlp: 'top', align: null, va: 'bottom' },
  { id: 'topRight', label: 'Top Right', lp: 'right', vlp: 'top', align: 'left', va: 'bottom' },
  { id: 'left', label: 'Left', lp: 'left', vlp: null, align: 'right', va: null },
  { id: 'center', label: 'Centre', lp: null, vlp: null, align: null, va: null },
  { id: 'right', label: 'Right', lp: 'right', vlp: null, align: 'left', va: null },
  { id: 'bottomLeft', label: 'Bottom Left', lp: 'left', vlp: 'bottom', align: 'right', va: 'top' },
  { id: 'bottom', label: 'Bottom', lp: null, vlp: 'bottom', align: null, va: 'top' },
  { id: 'bottomRight', label: 'Bottom Right', lp: 'right', vlp: 'bottom', align: 'left', va: 'top' },
];
const positionOf = (s: Style) => POSITIONS.find((p) => (p.lp ?? 'center') === (s.get('labelPosition') ?? 'center') && (p.vlp ?? 'middle') === (s.get('verticalLabelPosition') ?? 'middle'))?.id ?? 'center';
/** The ways a connector can go (its edgeStyle). */
export const WAYPOINTS = [{ id: 'straight', label: 'Straight' }, { id: 'orthogonal', label: 'Orthogonal' }, { id: 'elbow', label: 'Simple' }, { id: 'elbowVertical', label: 'Simple Vertical' },
  { id: 'isometric', label: 'Isometric' }, { id: 'curved', label: 'Curved' }, { id: 'entityRelation', label: 'Entity Relation' }];
export const waypointsOf = (s: Style) => (s.get('curved') === '1' ? 'curved' : routeKind(s));
const EDGE_STYLES: Record<string, string> = { orthogonal: 'orthogonalEdgeStyle', elbow: 'elbowEdgeStyle', elbowVertical: 'elbowEdgeStyle', isometric: 'isometricEdgeStyle', entityRelation: 'entityRelationEdgeStyle' };
export const waypointKeys = (k: string): Record<string, string | null> => ({ edgeStyle: EDGE_STYLES[k] ?? null, elbow: k === 'elbowVertical' ? 'vertical' : null, curved: k === 'curved' ? '1' : null });
const JUMPS = [['none', 'None'], ['arc', 'Arc'], ['gap', 'Gap'], ['sharp', 'Sharp'], ['line', 'Line']] as const;

/* ─── Edit Style ─── */

export function EditStyleDialog({ style, apply }: { style: string; apply: (s: string) => void }) {
  const [text, setText] = useState(style.replace(/;/g, ';\n').trim());
  const ok = () => { apply(text.replace(/\s*\n\s*/g, '').trim()); closeDialog(); };
  return (
    <Dialog title="Edit Style" onClose={closeDialog} onAccept={ok} width={420}
      footer={<><button class="btn" onClick={closeDialog}>Cancel</button><button class="btn default" onClick={ok}>Apply</button></>}>
      <p class="small muted">The style as <code>key=value;</code>, one to a line.</p>
      <textarea class="dg-style-text" aria-label="Style" value={text} rows={12} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
    </Dialog>
  );
}

/* ─── The panel ─── */

type Tab = 'style' | 'text' | 'arrange';
interface Props { d: DrawioDocument; page: DiagramPage; list: Cell[]; sel: Set<string>; sheets: string[]; changed: () => void; openSheet: (c: Cell) => boolean; select: (ids: Set<string>) => void }

export function Format({ d, page, list, sel, sheets, changed, openSheet, select }: Props) {
  const [tab, setTab] = useState<Tab>('style');
  const picked = list.filter((c) => sel.has(c.id));
  const edit = (label: string, fn: () => void) => { change(d, label, fn, page); changed(); };
  if (!picked.length) return <DiagramTab d={d} page={page} list={list} edit={edit} changed={changed} />;
  const one = picked.length === 1 ? picked[0]! : undefined;
  const edges = picked.every((c) => c.edge);
  const first = picked[0]!;
  const s = first.style;
  const ids = picked.map((c) => c.id);
  const key = (label: string, k: string, v: string | null) => edit(label, () => setStyle(page, ids, k, v));
  const keys = (label: string, kv: Record<string, string | null>) => edit(label, () => setStyles(page, ids, kv));
  const check = (label: string, k: string, onV = '1', offV: string | null = null, def = false) => {
    const isOn = (look(s, k) ?? (def ? onV : undefined)) === onV;
    return <label class="dg-check"><input type="checkbox" checked={isOn} onChange={() => key(label, k, isOn ? offV : onV)} />{label}</label>;
  };
  const numIn = (label: string, k: string, def: number, min?: number, max?: number, unit = '') => (
    <label class="dg-num">{label}<input type="number" aria-label={label} min={min} max={max} value={String(num(s, k, def))} onChange={(e) => { const v = (e.target as HTMLInputElement).value; if (v !== '' && Number.isFinite(Number(v))) key(label, k, v); }} />{unit && <span class="muted">{unit}</span>}</label>
  );
  /** A colour with its tick (off: none); `unset`: what no value means (a label's background and border: none). */
  const colourRow = (label: string, k: string, def: string, toggle = true, unset = def) => {
    const v = look(s, k), isNone = hex(v, unset) === 'none';
    return (
      <div class="dg-row">
        {toggle ? <label class="dg-check"><input type="checkbox" checked={!isNone} onChange={() => key(label, k, isNone ? def : 'none')} />{label}</label> : <span>{label}</span>}
        {(!isNone || !toggle) && <ColourButton label={label} value={v ?? (unset === 'none' ? def : undefined)} def={def} onPick={(c) => key(label, k, c)} />}
      </div>
    );
  };
  const lineRow = (
    <>
      {colourRow('Line', 'strokeColor', '#000000', !edges)}
      {hex(look(s, 'strokeColor'), '#000000') !== 'none' && <div class="dg-row dg-indent">
        <select aria-label="Pattern" value={patternOf(s)} onChange={(e) => { const p = PATTERNS.find((x) => x.id === (e.target as HTMLSelectElement).value)!; keys('Pattern', { dashed: p.dashed, dashPattern: p.pattern }); }}>
          {PATTERNS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {numIn('Width', 'strokeWidth', 1, 0, 999, 'pt')}
      </div>}
    </>
  );
  const styleTools = (
    <div class="dg-buttons">
      <button class="btn" onClick={() => showDialog(EditStyleDialog, { style: first.style.toString(), apply: (t: string) => edit('Edit Style', () => setCellStyle(page, ids, t)) })}>Edit Style</button>
      <button class="btn" onClick={() => copyStyle(first.style)}>Copy Style</button>
      <button class="btn" disabled={!copiedStyle()} onClick={() => { const c = copiedStyle(); if (c) edit('Paste Style', () => setCellStyle(page, ids, c)); }}>Paste Style</button>
      <button class="btn" onClick={() => { setDefaultStyle(edges ? 'edge' : 'vertex', first.style); changed(); }} title={edges ? 'New connectors take this one\'s line, arrows and font' : 'New shapes take this one\'s colours, line and font'}>Set as Default Style</button>
    </div>
  );
  const swatches = (
    <div class="dg-swatches" role="group" aria-label="Quick styles">
      {SWATCHES.map((w, i) => (
        <button key={i} type="button" class="dg-quick" title={i ? `Fill ${w.fill}, line ${w.stroke}${w.gradient ? `, gradient ${w.gradient}` : ''}` : 'Default colours'} aria-label={i ? `Quick style ${i}` : 'Default colours'}
          style={{ background: edges ? '#ffffff' : w.gradient ? `linear-gradient(${w.fill}, ${w.gradient})` : w.fill ?? '#ffffff', borderColor: w.stroke ?? '#000000' }}
          onClick={() => keys('Quick Style', edges ? { strokeColor: w.stroke, fontColor: w.font ?? null } : { fillColor: w.fill, strokeColor: w.stroke, gradientColor: w.gradient ?? null, fontColor: w.font ?? null })}>
          {edges && <span style={{ background: w.stroke ?? '#000000' }} />}
        </button>
      ))}
    </div>
  );

  let body;
  if (tab === 'style') {
    body = edges ? (
      <>
        {swatches}
        <Section title="Line">{lineRow}</Section>
        <Section title="Waypoints">
          <select aria-label="Waypoints" value={waypointsOf(s)} onChange={(e) => keys('Waypoints', waypointKeys((e.target as HTMLSelectElement).value))}>
            {WAYPOINTS.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
          <div class="dg-row">{check('Rounded', 'rounded')}{check('Shadow', 'shadow')}</div>
          <button class="btn" disabled={!picked.some((c) => c.points.length)} onClick={() => edit('Clear Waypoints', () => { for (const c of picked) setEdgePoints(page, c.id, []); })}>Clear Waypoints</button>
        </Section>
        <Section title="Line Jumps">
          <div class="dg-row">
            <select aria-label="Line jumps" value={look(s, 'jumpStyle') ?? 'none'} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; key('Line Jumps', 'jumpStyle', v === 'none' ? null : v); }}>
              {JUMPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {(look(s, 'jumpStyle') ?? 'none') !== 'none' && numIn('Size', 'jumpSize', 6, 1, 100)}
          </div>
        </Section>
        {(['start', 'end'] as const).map((end) => (
          <Section key={end} title={end === 'start' ? 'Line Start' : 'Line End'}>
            <div class="dg-row">
              <select aria-label={end === 'start' ? 'Line start' : 'Line end'} value={look(s, `${end}Arrow`) ?? (end === 'end' ? 'classic' : 'none')} onChange={(e) => key(end === 'start' ? 'Line Start' : 'Line End', `${end}Arrow`, (e.target as HTMLSelectElement).value)}>
                {MARKERS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              {check('Filled', `${end}Fill`, '1', '0', true)}
              {numIn('Size', `${end}Size`, 6, 1, 100)}
            </div>
          </Section>
        ))}
        <Section title="Opacity">{numIn('Opacity', 'opacity', 100, 0, 100, '%')}</Section>
        {styleTools}
      </>
    ) : (
      <>
        {swatches}
        <Section title="Fill">
          {colourRow('Fill', 'fillColor', '#ffffff')}
          {hex(look(s, 'fillColor'), '#ffffff') !== 'none' && <>
            {colourRow('Gradient', 'gradientColor', '#7ea6e0', true, 'none')}
            {hex(look(s, 'gradientColor'), 'none') !== 'none' && <div class="dg-row dg-indent">
              <select aria-label="Gradient direction" value={look(s, 'gradientDirection') ?? 'south'} onChange={(e) => key('Gradient Direction', 'gradientDirection', (e.target as HTMLSelectElement).value)}>
                {[['south', 'South'], ['north', 'North'], ['east', 'East'], ['west', 'West'], ['radial', 'Radial']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>}
          </>}
        </Section>
        <Section title="Line">{lineRow}</Section>
        <Section title="Look">
          <div class="dg-row">{check('Rounded', 'rounded')}{check('Shadow', 'shadow')}</div>
          {numIn('Opacity', 'opacity', 100, 0, 100, '%')}
        </Section>
        {styleTools}
        {one?.vertex && (
          <fieldset class="dg-sheet"><legend>Linked Sheet</legend>
            <select aria-label="Linked sheet" value={one.sheet} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; edit('Link Sheet', () => setSheet(page, one.id, v)); }}>
              <option value="">(none)</option>
              {[...new Set([...sheets, ...(one.sheet ? [one.sheet] : [])])].map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <button class="btn" disabled={!one.sheet} onClick={() => openSheet(one)}>Open Sheet</button>
            {!sheets.length && <p class="small muted">Add the diagram to a project with schematics to link its blocks to them.</p>}
          </fieldset>
        )}
      </>
    );
  } else if (tab === 'text') {
    const fs = num(s, 'fontStyle', 0);
    const bit = (b: number, label: string, glyph: string) => (
      <button type="button" class={`btn dg-tog${fs & b ? ' on' : ''}`} aria-pressed={(fs & b) !== 0} aria-label={label} title={label} onClick={() => key(label, 'fontStyle', String(fs ^ b))}>{glyph}</button>
    );
    const html = look(s, 'html') === '1';
    body = (
      <>
        {one && (html && /<[a-z]/i.test(one.value)
          ? <p class="small muted">A formatted label: double-click {one.edge ? 'the connector' : 'the shape'} to type in it, with its formatting bar.</p>
          : <label class="dg-label">Label<textarea aria-label="Label text" value={labelText({ value: one.value, style: one.style })} onChange={(e) => edit('Edit Label', () => setLabel(page, one.id, (e.target as HTMLTextAreaElement).value))} /></label>)}
        <Section title="Font">
          <select aria-label="Font" value={look(s, 'fontFamily') ?? 'Helvetica'} onChange={(e) => key('Font', 'fontFamily', (e.target as HTMLSelectElement).value)}>
            {[...new Set([...FONTS, look(s, 'fontFamily') ?? 'Helvetica'])].map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <div class="dg-row">
            {bit(1, 'Bold', 'B')}{bit(2, 'Italic', 'I')}{bit(4, 'Underline', 'U')}{bit(8, 'Strikethrough', 'S')}
            {numIn('Size', 'fontSize', edges ? 11 : 12, 1, 999, 'pt')}
          </div>
          <div class="dg-row" role="group" aria-label="Alignment">
            {([['left', 'Align Left'], ['center', 'Centre'], ['right', 'Align Right']] as const).map(([v, l]) => (
              <button key={v} type="button" class={`btn dg-tog${(look(s, 'align') ?? 'center') === v ? ' on' : ''}`} aria-label={l} title={l} aria-pressed={(look(s, 'align') ?? 'center') === v} onClick={() => key(l, 'align', v === 'center' ? null : v)}><AlignGlyph h={v} /></button>
            ))}
            <span class="dd-sep" />
            {([['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']] as const).map(([v, l]) => (
              <button key={v} type="button" class={`btn dg-tog${(look(s, 'verticalAlign') ?? 'middle') === v ? ' on' : ''}`} aria-label={l} title={l} aria-pressed={(look(s, 'verticalAlign') ?? 'middle') === v} onClick={() => key(l, 'verticalAlign', v === 'middle' ? null : v)}><AlignGlyph v={v} /></button>
            ))}
          </div>
        </Section>
        {!edges && <Section title="Position">
          <select aria-label="Position" value={positionOf(s)} onChange={(e) => { const p = POSITIONS.find((x) => x.id === (e.target as HTMLSelectElement).value)!; keys('Position', { labelPosition: p.lp, verticalLabelPosition: p.vlp, align: p.align, verticalAlign: p.va }); }}>
            {POSITIONS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </Section>}
        <Section title="Colours">
          {colourRow('Font Colour', 'fontColor', '#000000', false)}
          {colourRow('Background Colour', 'labelBackgroundColor', '#ffffff', true, edges ? '#ffffff' : 'none')}
          {colourRow('Border Colour', 'labelBorderColor', '#000000', true, 'none')}
        </Section>
        <Section title="Options">
          <div class="dg-row">{check('Word Wrap', 'whiteSpace', 'wrap')}
            <label class="dg-check"><input type="checkbox" checked={html} onChange={() => edit('Formatted Text', () => {
              // The label kept as its text: as HTML, or plain
              for (const c of picked) { const t = labelText({ value: c.value, style: c.style }); setStyle(page, [c.id], 'html', html ? null : '1'); setLabel(page, c.id, t); }
            })} />Formatted Text</label>
            {!edges && check('Vertical', 'horizontal', '0')}
          </div>
        </Section>
        <Section title="Spacing">
          <div class="dg-spacing">
            {numIn('Top', 'spacingTop', 0)}{numIn('Left', 'spacingLeft', 0)}{numIn('Bottom', 'spacingBottom', 0)}{numIn('Right', 'spacingRight', 0)}{numIn('Global', 'spacing', 2)}
          </div>
        </Section>
        <Section title="Opacity">{numIn('Text Opacity', 'textOpacity', 100, 0, 100, '%')}</Section>
      </>
    );
  } else {
    const order = (how: 'front' | 'back' | 'forward' | 'backward', label: string) => <button class="btn" onClick={() => edit(label, () => orderCells(page, new Set(ids), how))}>{label}</button>;
    const r = one?.rect;
    const geo = (k: 'x' | 'y' | 'w' | 'h', val: string) => {
      const n = Number(val);
      if (!one || !r || !Number.isFinite(n)) return;
      let next = { ...r, [k]: n };
      // Constrain Proportions: the other side follows
      if (look(one.style, 'aspect') === 'fixed' && r.w && r.h) next = k === 'w' ? { ...next, h: Math.round((n * r.h) / r.w) } : k === 'h' ? { ...next, w: Math.round((n * r.w) / r.h) } : next;
      edit(k === 'x' || k === 'y' ? 'Move' : 'Resize', () => resizeCell(page, one.id, next));
    };
    body = (
      <>
        <Section title="Order"><div class="dg-buttons">{order('front', 'To Front')}{order('back', 'To Back')}{order('forward', 'Bring Forward')}{order('backward', 'Send Backward')}</div></Section>
        <Section title="Group">
          <div class="dg-buttons">
            <button class="btn" title="Ctrl+G" onClick={() => { let g = ''; edit('Group', () => { g = groupCells(page, new Set(ids)); }); if (g) select(new Set([g])); }}>Group</button>
            <button class="btn" title="Ctrl+Shift+U" disabled={!picked.some((c) => list.some((k) => k.parent === c.id))} onClick={() => { let f: string[] = []; edit('Ungroup', () => { f = ungroupCells(page, new Set(ids)); }); select(new Set(f)); }}>Ungroup</button>
          </div>
        </Section>
        {picked.filter((c) => c.vertex && !c.relative).length >= 2 && <Section title="Align">
          <div class="dg-buttons">
            {([['left', 'Left'], ['center', 'Centre'], ['right', 'Right'], ['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']] as const).map(([h, l]) => (
              <button key={h} class="btn" onClick={() => edit(`Align ${l}`, () => alignCells(page, new Set(ids), h))}>{l}</button>
            ))}
          </div>
          {picked.filter((c) => c.vertex && !c.relative).length >= 3 && <div class="dg-buttons">
            <button class="btn" onClick={() => edit('Distribute Horizontally', () => distributeCells(page, new Set(ids), true))}>Distribute Horizontally</button>
            <button class="btn" onClick={() => edit('Distribute Vertically', () => distributeCells(page, new Set(ids), false))}>Distribute Vertically</button>
          </div>}
        </Section>}
        {one?.vertex && r && !one.relative && <>
          <Section title="Size">
            <div class="dg-row">
              <label class="dg-num">Width<input type="number" aria-label="Width" value={String(r.w)} onChange={(e) => geo('w', (e.target as HTMLInputElement).value)} /></label>
              <label class="dg-num">Height<input type="number" aria-label="Height" value={String(r.h)} onChange={(e) => geo('h', (e.target as HTMLInputElement).value)} /></label>
            </div>
            {check('Constrain Proportions', 'aspect', 'fixed')}
          </Section>
          <Section title="Position">
            <div class="dg-row">
              <label class="dg-num">Left<input type="number" aria-label="Left" value={String(r.x)} onChange={(e) => geo('x', (e.target as HTMLInputElement).value)} /></label>
              <label class="dg-num">Top<input type="number" aria-label="Top" value={String(r.y)} onChange={(e) => geo('y', (e.target as HTMLInputElement).value)} /></label>
            </div>
          </Section>
        </>}
        {!edges && <>
          <Section title="Rotation">
            <div class="dg-row">
              {numIn('Angle', 'rotation', 0, 0, 360, '°')}
              <button class="btn" onClick={() => key('Rotate', 'rotation', String((num(s, 'rotation', 0) + 90) % 360))}>Rotate 90°</button>
            </div>
            <div class="dg-row">
              <label class="dg-num">Direction<select aria-label="Direction" value={look(s, 'direction') ?? 'east'} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; key('Direction', 'direction', v === 'east' ? null : v); }}>
                {[['east', 'East'], ['south', 'South'], ['west', 'West'], ['north', 'North']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select></label>
            </div>
          </Section>
          <Section title="Flip">
            <div class="dg-buttons">
              <button class="btn" aria-pressed={look(s, 'flipH') === '1'} onClick={() => key('Flip Horizontal', 'flipH', look(s, 'flipH') === '1' ? null : '1')}>Horizontal</button>
              <button class="btn" aria-pressed={look(s, 'flipV') === '1'} onClick={() => key('Flip Vertical', 'flipV', look(s, 'flipV') === '1' ? null : '1')}>Vertical</button>
            </div>
          </Section>
        </>}
      </>
    );
  }
  return (
    <div class="dg-format">
      <div class="dg-tabs" role="tablist" aria-label="Format">
        {([['style', 'Style'], ['text', 'Text'], ['arrange', 'Arrange']] as const).map(([t, l]) => (
          <button key={t} role="tab" class={`dg-tab${tab === t ? ' on' : ''}`} aria-selected={tab === t} onClick={() => setTab(t)}>{l}</button>
        ))}
      </div>
      <div class="dg-tabbody">
        <p class="dg-what muted small">{picked.length === 1 ? (one!.edge ? 'Connector' : one!.style.shape() === 'text' ? 'Text' : 'Shape') : `${picked.length} selected`}</p>
        {body}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return <section class="dg-sec" aria-label={title}><h4>{title}</h4>{children}</section>;
}

/** Text alignment's glyphs: lines set left, centred or right; a box with a line at its top, middle or bottom. */
function AlignGlyph({ h, v }: { h?: string; v?: string }) {
  if (h) {
    const x = (w: number) => (h === 'left' ? 2 : h === 'right' ? 14 - w : 8 - w / 2);
    return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d={`M${x(12)} 4h12M${x(8)} 7h8M${x(12)} 10h12M${x(6)} 13h6`} stroke="currentColor" stroke-width="1.4" fill="none" /></svg>;
  }
  const y = v === 'top' ? 4.5 : v === 'bottom' ? 11.5 : 8;
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" stroke="currentColor" fill="none" /><path d={`M5 ${y}h6`} stroke="currentColor" stroke-width="1.8" /></svg>;
}

/** Nothing selected: the diagram's view, options, paper and page. */
function DiagramTab({ d, page, list, edit, changed }: { d: DrawioDocument; page: DiagramPage; list: Cell[]; edit: (label: string, fn: () => void) => void; changed: () => void }) {
  const m = page.model;
  const flag = (label: string, k: string, def: boolean) => {
    const isOn = (attr(m, k) ?? (def ? '1' : '0')) !== '0';
    return <label class="dg-check"><input type="checkbox" checked={isOn} onChange={() => edit(label, () => setModelAttr(page, k, isOn ? '0' : '1'))} />{label}</label>;
  };
  const size = pageSize(m);
  const paper = paperOf(Number(attr(m, 'pageWidth') ?? 1169), Number(attr(m, 'pageHeight') ?? 827));
  const setPaper = (w: number, h: number) => edit('Paper Size', () => { setModelAttr(page, 'pageWidth', String(Math.round(w))); setModelAttr(page, 'pageHeight', String(Math.round(h))); });
  const i = d.pages.indexOf(page);
  const linked = list.filter((c) => c.sheet).length;
  const bg = attr(m, 'background');
  return (
    <div class="dg-format">
      <div class="dg-tabs" role="tablist" aria-label="Format"><button role="tab" class="dg-tab on" aria-selected>Diagram</button></div>
      <div class="dg-tabbody">
        <Section title="View">
          <div class="dg-row">{flag('Grid', 'grid', true)}
            <label class="dg-num">Size<input type="number" aria-label="Grid size" min={1} max={100} value={attr(m, 'gridSize') ?? '10'} onChange={(e) => { const v = Number((e.target as HTMLInputElement).value); if (v >= 1) edit('Grid Size', () => setModelAttr(page, 'gridSize', String(v))); }} /><span class="muted">pt</span></label>
          </div>
          {flag('Page View', 'page', true)}
          <div class="dg-row"><span>Background</span><ColourButton label="Background" value={bg && bg !== 'none' ? bg : 'none'} def="#ffffff" onPick={(c) => edit('Background', () => setModelAttr(page, 'background', c && c !== 'none' ? c : null))} /></div>
          {flag('Shadow', 'shadow', false)}
        </Section>
        <Section title="Options">{flag('Connection Arrows', 'arrows', true)}{flag('Connection Points', 'connect', true)}{flag('Guides', 'guides', true)}</Section>
        <Section title="Paper Size">
          <select aria-label="Paper size" value={paper.id} onChange={(e) => {
            const p = PAPER.find((x) => x.id === (e.target as HTMLSelectElement).value);
            if (p) setPaper(paper.landscape ? Math.max(p.w, p.h) : Math.min(p.w, p.h), paper.landscape ? Math.min(p.w, p.h) : Math.max(p.w, p.h));
          }}>
            {PAPER.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            <option value="custom">Custom</option>
          </select>
          <div class="dg-row" role="radiogroup" aria-label="Orientation">
            <label class="dg-check"><input type="radio" name={`orient-${i}`} checked={!paper.landscape} onChange={() => setPaper(Math.min(size.w, size.h), Math.max(size.w, size.h))} />Portrait</label>
            <label class="dg-check"><input type="radio" name={`orient-${i}`} checked={paper.landscape} onChange={() => setPaper(Math.max(size.w, size.h), Math.min(size.w, size.h))} />Landscape</label>
          </div>
          {paper.id === 'custom' && <div class="dg-row">
            <label class="dg-num">Width<input type="number" aria-label="Page width" value={attr(m, 'pageWidth') ?? '1169'} onChange={(e) => { const v = Number((e.target as HTMLInputElement).value); if (v > 0) setPaper(v, Number(attr(m, 'pageHeight') ?? 827)); }} /></label>
            <label class="dg-num">Height<input type="number" aria-label="Page height" value={attr(m, 'pageHeight') ?? '827'} onChange={(e) => { const v = Number((e.target as HTMLInputElement).value); if (v > 0) setPaper(Number(attr(m, 'pageWidth') ?? 1169), v); }} /></label>
          </div>}
        </Section>
        <Section title="Page">
          <label class="dg-num">Name<input aria-label="Page name" value={pageName(page, i)} onChange={(e) => { const n = (e.target as HTMLInputElement).value.trim(); if (n) edit('Rename Page', () => renamePage(d, page, n)); }} /></label>
          <button class="btn" disabled={d.pages.length < 2} onClick={() => { change(d, 'Delete Page', () => removePage(d, page)); changed(); }}>Delete Page</button>
        </Section>
        {hasDefaultStyle() && <button class="btn" onClick={() => { clearDefaultStyle(); changed(); }} title="New shapes and connectors take the standard style again">Clear Default Style</button>}
        <p class="small muted">Drag a shape from the Shapes panel onto the page, or click it to add it. Drag one of a selected shape's blue arrows to another shape to connect them (click an arrow for a joined copy); double-click to type a label.</p>
        <p class="small muted">{linked} block{linked === 1 ? '' : 's'} linked to sheets.</p>
      </div>
    </div>
  );
}
