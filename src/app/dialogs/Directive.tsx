import { schUnitsOf } from '../newSheet';
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { ColourDialog } from './Pickers';
import { PromptDialog } from './Confirm';
import { AddRuleDialog } from './AddRule';
import { units } from '../state';
import type { SchEditor } from '../../editors/sch/SchEditor';
import { PropertyBag } from '../../formats/altium/props';
import { SR, bagOf, schCoord, setSchCoord } from '../../model/sch';
import { addRecords, removeObjects, replaceBags, setProps, uniqueId } from '../../model/schEdit';
import { transformBag, withChildren } from '../../model/schTransform';
import { bgrOf, fmtCoord, hexOf, parseCoord } from '../../model/schProps';
import type { Change } from '../../core/undo';

/**
 * Double-click on a directive (Differential Pair, Parameter Set, PCB Layout …): Altium
 * Designer 17's "Parameters" dialog — colour, style, location and orientation around a
 * picture of the directive, its name and lock, and its parameters (Visible, Name, Value,
 * Type) with Add, Remove and Edit. A PCB Layout directive's Rule shows its description.
 * OK applies everything as one undo step; moving or turning it carries its parameters along.
 */

interface Row { index?: number; name: string; value: string; visible: boolean; type: string; rule: boolean; /** A rule added here: its value (the rule's properties); `value` shows its summary. */ text?: string }
const ORIENT = ['0 Degrees', '90 Degrees', '180 Degrees', '270 Degrees'];

function Glyph({ diff, colour }: { diff: boolean; colour: string }) {
  return (
    <svg class="dir-glyph" viewBox="-80 -240 160 260" aria-hidden="true">
      {diff
        ? <g transform="translate(-100 0)" fill="none" stroke={colour} stroke-width={8}>
            <polyline points="0,0 40,-40 90,-40 110,-20 150,-20 170,-40 200,-40" />
            <polyline points="40,-70 90,-70 110,-90 150,-90 170,-70 200,-70" />
          </g>
        : <g fill="none" stroke={colour} stroke-width={14}>
            <line x1={0} y1={0} x2={0} y2={-60} />
            <circle cx={0} cy={-120} r={60} />
            <circle cx={0} cy={-150} r={7} fill={colour} stroke="none" />
            <polyline points="-10,-128 0,-130 0,-92" stroke-width={11} />
            <line x1={-12} y1={-92} x2={12} y2={-92} stroke-width={8} />
          </g>}
    </svg>
  );
}

export function DirectiveDialog({ ed, index }: { ed: SchEditor; index: number }) {
  const doc = ed.doc;
  const b = bagOf(doc, doc.objects[index]!)!;
  const u = schUnitsOf(ed, units.value);
  const diff = (b.get('NAME') ?? '').toUpperCase() === 'DIFFPAIR';
  const at0 = { x: schCoord(b, 'LOCATION.X'), y: schCoord(b, 'LOCATION.Y') };
  const kids = doc.objects.filter((o) => o.owner === index && o.record === SR.PARAMETER);
  const rows0: Row[] = kids.map((o) => {
    const p = bagOf(doc, o)!;
    const rule = (p.get('NAME') ?? '').toLowerCase() === 'rule' && p.has('DESCRIPTION');
    return { index: o.index, name: p.get('NAME') ?? '', value: rule ? p.get('DESCRIPTION') ?? '' : p.get('TEXT') ?? '', visible: !p.bool('ISHIDDEN'), type: p.get('PARAMTYPE') ?? 'STRING', rule };
  });
  const [f, setF] = useState(() => ({
    colour: hexOf(b.int('COLOR', 255)), x: fmtCoord(at0.x, u), y: fmtCoord(at0.y, u), orient: b.int('ORIENTATION') & 3,
    name: b.get('NAME') ?? '', locked: b.bool('GRAPHICALLYLOCKED'), tiny: b.int('STYLE') === 1,
  }));
  const [rows, setRows] = useState<Row[]>(rows0);
  const [sel, setSel] = useState<number | null>(rows0.length ? 0 : null);
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const upd = (i: number, p: Partial<Row>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...p } : r)));

  const ok = () => {
    const ch: (() => Change | null)[] = [];
    const patch: Record<string, string | null> = {};
    const colour = bgrOf(f.colour);
    if (colour !== undefined && colour !== b.int('COLOR', 255)) patch.COLOR = String(colour);
    if (f.name.trim() && f.name !== (b.get('NAME') ?? '')) patch.NAME = f.name.trim();
    if (f.locked !== b.bool('GRAPHICALLYLOCKED')) patch.GRAPHICALLYLOCKED = f.locked ? 'T' : null;
    // STYLE: absent Large, 1 Tiny
    if (f.tiny !== (b.int('STYLE') === 1)) patch.STYLE = f.tiny ? '1' : null;
    if (Object.keys(patch).length) ch.push(() => setProps(doc, index, patch));
    // Location and orientation: the directive and its parameters move and turn together
    const x = parseCoord(f.x, u), y = parseCoord(f.y, u);
    const quarter = (f.orient - (b.int('ORIENTATION') & 3) + 4) % 4;
    if (x !== undefined && y !== undefined && (x !== at0.x || y !== at0.y || quarter)) {
      ch.push(() => {
        const xf = { pivot: at0, quarter, mirrorX: false, mirrorY: false, d: { x: x - at0.x, y: y - at0.y } };
        return replaceBags(doc, withChildren(doc, [index]).map((i) => { const bb = doc.records[i + 1]!.bag!; return { index: i, before: bb.clone(), after: transformBag(bb, xf) }; }));
      });
    }
    for (const r of rows) {
      const o = r.index !== undefined ? doc.objects[r.index] : undefined;
      if (o) {
        const p = bagOf(doc, o)!, q: Record<string, string | null> = {};
        if (r.name !== (p.get('NAME') ?? '')) q.NAME = r.name;
        if (!r.rule && r.value !== (p.get('TEXT') ?? '')) q.TEXT = r.value;
        if (r.visible === p.bool('ISHIDDEN')) q.ISHIDDEN = r.visible ? null : 'T';
        if (Object.keys(q).length) ch.push(() => setProps(doc, o.index, q));
      } else if (r.name.trim()) {
        ch.push(() => {
          const d = bagOf(doc, doc.objects[index]!)!;
          const nb = PropertyBag.from({ RECORD: SR.PARAMETER, OWNERINDEX: index, OWNERPARTID: -1, COLOR: 8388608, FONTID: 1, TEXT: r.text ?? r.value, NAME: r.name.trim(), SHOWNAME: 'T', UNIQUEID: uniqueId() });
          if (r.text) nb.set('DESCRIPTION', r.value);
          if (!r.visible) nb.set('ISHIDDEN', 'T');
          setSchCoord(nb, 'LOCATION.X', schCoord(d, 'LOCATION.X')); setSchCoord(nb, 'LOCATION.Y', schCoord(d, 'LOCATION.Y'));
          return addRecords(doc, [nb]);
        });
      }
    }
    // Removals last: they renumber what follows
    const gone = rows0.filter((r) => !rows.some((q) => q.index === r.index)).map((r) => r.index!);
    if (gone.length) ch.push(() => removeObjects(doc, gone));
    closeDialog();
    if (ch.length) {
      ed.undo.transact(`Properties of ${diff ? 'Differential Pair' : f.name || 'Parameter Set'}`, (tx) => { for (const c of ch) { const v = c(); if (v) tx.add(v); } });
      ed.invalidate();
    }
  };

  const add = () => showDialog(PromptDialog, { title: 'Parameter Properties', fields: [{ label: 'Name', value: `Parameter${rows.length + 1}` }, { label: 'Value', value: '' }],
    onOk: ([n, v]: string[]) => { if (!n?.trim()) return; setRows([...rows, { name: n.trim(), value: v ?? '', visible: false, type: 'STRING', rule: false }]); setSel(rows.length); } });

  return (
    <Dialog title="Parameters" width={640} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="directive"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="dir-top">
        <div class="dir-left">
          <span class="dlg-label">Colour</span>
          <button class="dlg-colour" aria-label="Directive colour" onClick={() => showDialog(ColourDialog, { value: f.colour, onOk: (v: string) => set({ colour: v }) })}><span class="swatch" style={{ background: f.colour }} /></button>
        </div>
        <Glyph diff={diff} colour={f.colour} />
        <div class="dir-right">
          <label class="dir-field"><span class="dlg-label">Style</span>
            <select value={f.tiny ? 'tiny' : 'large'} onChange={(e) => set({ tiny: (e.target as HTMLSelectElement).value === 'tiny' })}><option value="large">Large</option><option value="tiny">Tiny</option></select></label>
          <label class="dir-field"><span class="dlg-label">Location X</span><input type="text" value={f.x} onInput={(e) => set({ x: (e.target as HTMLInputElement).value })} /></label>
          <label class="dir-field"><span class="dlg-label">Y</span><input type="text" value={f.y} onInput={(e) => set({ y: (e.target as HTMLInputElement).value })} /></label>
          <label class="dir-field"><span class="dlg-label">Orientation</span>
            <select value={String(f.orient)} onChange={(e) => set({ orient: Number((e.target as HTMLSelectElement).value) })}>{ORIENT.map((o, i) => <option key={o} value={String(i)}>{o}</option>)}</select></label>
        </div>
      </div>
      <fieldset class="dir-props"><legend>Properties</legend>
        <label class="dir-name"><span class="dlg-label">Name</span><input type="text" value={f.name} autofocus onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} /></label>
        <label class="cp-check"><input type="checkbox" checked={f.locked} onChange={(e) => set({ locked: (e.target as HTMLInputElement).checked })} />Locked</label>
      </fieldset>
      <div class="cp-params dir-params">
        <div class="cp-grid" role="grid">
          <div class="cp-grow cp-ghead" role="row"><span>Visible</span><span>Name</span><span>Value</span><span>Type</span></div>
          {rows.map((r, i) => (
            <div key={i} class={`cp-grow${sel === i ? ' on' : ''}`} role="row" onMouseDown={() => setSel(i)}>
              <span><input type="checkbox" checked={r.visible} aria-label={`${r.name} visible`} onChange={(e) => upd(i, { visible: (e.target as HTMLInputElement).checked })} /></span>
              <input type="text" value={r.name} aria-label="Parameter name" onInput={(e) => upd(i, { name: (e.target as HTMLInputElement).value })} />
              <input type="text" value={r.value} aria-label={`${r.name} value`} readOnly={r.rule} title={r.rule ? 'A design rule: remove it and Add as Rule... again to change it' : undefined}
                onInput={(e) => upd(i, { value: (e.target as HTMLInputElement).value })} />
              <span>{r.type}</span>
            </div>
          ))}
        </div>
        <div class="cp-buttons">
          <button class="btn" onClick={add}>Add...</button>
          <button class="btn" disabled={sel === null || !rows[sel]} onClick={() => { setRows(rows.filter((_, k) => k !== sel)); setSel(null); }}>Remove...</button>
          <button class="btn" disabled={sel === null || !rows[sel]} onClick={() => (document.querySelector('.dir-params .cp-grow.on input[type=text]:nth-of-type(2)') as HTMLInputElement | null)?.focus()}>Edit...</button>
          <button class="btn" title="A design rule for the net this sits on, added to the board by Update PCB Document"
            onClick={() => showDialog(AddRuleDialog, { onOk: (text: string, description: string) => { setRows([...rows, { name: 'Rule', value: description, text, visible: true, type: 'STRING', rule: true }]); setSel(rows.length); } })}>Add as Rule...</button>
        </div>
      </div>
    </Dialog>
  );
}
