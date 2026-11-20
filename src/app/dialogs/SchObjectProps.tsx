import { schUnitsOf } from '../newSheet';
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { ColourDialog, FontDialog } from './Pickers';
import { units } from '../state';
import type { SchEditor } from '../../editors/sch/SchEditor';
import type { Vec2 } from '../../core/geom';
import { PropertyBag } from '../../formats/altium/props';
import { SR, rederive, schCoord, type SchDocument } from '../../model/sch';
import { replaceBags } from '../../model/schEdit';
import { setWirePts } from '../../model/schDrag';
import { ensureFont, fmtCoord, fontOf, objectKind, parseCoord, sameFont, schProps, sheetFonts, type FontSpec, type SchCtx, type SchProp, type SchUnits } from '../../model/schProps';
import type { Change } from '../../core/undo';
import type { SchRawRecord } from '../../formats/altium/framing';

/**
 * Double-click on a schematic object (or Tab while placing one): its properties dialog, laid out
 * as Altium Designer 17's — the graphical settings on the left, the object's own properties on
 * the right, a Vertices tab for wires, buses and polylines. OK applies every change as one undo
 * step. Built from the same property definitions as the SCH Inspector, so both always agree.
 */

/** Altium's dialog titles. */
const TITLES: Record<string, string> = {
  'Net Label': 'Net Label', 'Power Object': 'Power Port', 'Off Sheet Connector': 'Off Sheet Connector', Port: 'Port Properties', Junction: 'Junction', 'No ERC': 'No ERC',
  'Text String': 'Annotation', 'Text Frame': 'Text Frame', Note: 'Note', Line: 'Line', Polyline: 'PolyLine', Polygon: 'Polygon', Rectangle: 'Rectangle',
  'Round Rectangle': 'Rounded Rectangle', Ellipse: 'Ellipse', Arc: 'Arc', 'Elliptical Arc': 'Elliptical Arc', Bezier: 'Bezier', 'Bus Entry': 'Bus Entry',
  Wire: 'Wire', Bus: 'Bus', 'Sheet Symbol': 'Sheet Symbol', 'Sheet Entry': 'Sheet Entry', Image: 'Image', Pin: 'Pin Properties', Parameter: 'Parameter Properties',
  Designator: 'Parameter Properties', 'Sheet Symbol Designator': 'Sheet Symbol Designator', 'Sheet Symbol File Name': 'Sheet Symbol File Name', 'IEEE Symbol': 'IEEE Symbol',
};

/** How the dialogs name what the Inspector calls X1, Area Color … */
function label(kind: string, name: string): string {
  const closed = ['Rectangle', 'Round Rectangle', 'Ellipse', 'Polygon', 'Sheet Symbol', 'Text Frame', 'Note', 'Port'].includes(kind);
  switch (name) {
    case 'X1': return 'Location X';
    case 'Y1': return 'Location Y';
    case 'X2': return kind === 'Bus Entry' || kind === 'Line' ? 'End X' : 'Corner X';
    case 'Y2': return kind === 'Bus Entry' || kind === 'Line' ? 'End Y' : 'Corner Y';
    case 'Area Colour': return 'Fill Colour';
    case 'Colour': return closed ? 'Border Colour' : 'Colour';
    case 'Line Width': return closed ? 'Border Width' : kind === 'Wire' || kind === 'Bus' ? `${kind} Width` : 'Line Width';
    case 'Text': return kind === 'Net Label' || kind === 'Power Object' || kind === 'Off Sheet Connector' ? 'Net' : 'Text';
    case 'Pin Designator': return 'Designator';
    case 'Sheet Symbol Designator': return kind === 'Sheet Symbol' ? 'Designator' : name;
    case 'Sheet Symbol File Name': return kind === 'Sheet Symbol' ? 'Filename' : name;
    case 'Show Hidden Fields': return 'Show Hidden Text Fields';
    case 'Unique ID': return 'Unique Id';
    case 'Name': return kind === 'Pin' ? 'Display Name' : 'Name';
    default: return name;
  }
}

/* ─── Fields ────────────────────────────────────────────────────────────────────────── */

export function Field({ p, x, value, onChange, autofocus }: { p: SchProp; x: SchCtx; value: string; onChange: (v: string) => void; autofocus?: boolean }) {
  const ro = !p.set;
  const id = `f-${p.cat}-${p.name}`.replace(/\W+/g, '-');
  switch (p.type) {
    case 'bool':
      return <input id={id} type="checkbox" checked={value === 'true'} disabled={ro} onChange={(e) => onChange(String((e.target as HTMLInputElement).checked))} />;
    case 'enum': {
      const opts = p.optionsFor ? p.optionsFor(x) : p.options ?? [];
      return <select id={id} value={value} disabled={ro || opts.length < 2} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        {(opts.includes(value) ? opts : [value, ...opts]).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>;
    }
    case 'colour':
      return <button id={id} class="dlg-colour" disabled={ro} onClick={() => showDialog(ColourDialog, { value, onOk: onChange })} aria-label={`${p.name} ${value}`}><span class="swatch" style={{ background: value }} /></button>;
    case 'font': {
      const spec = (() => { try { const f = JSON.parse(value) as FontSpec; if (f?.name) return f; } catch { /* a label, not a spec */ } return undefined; })();
      const shown = spec ? `${spec.name}, ${spec.size}${spec.bold ? ', Bold' : ''}${spec.italic ? ', Italic' : ''}` : value;
      // The font is its own button (its whole name shows; beside a Change button it was cut short)
      return <button id={id} class="btn dlg-font" disabled={ro} title="Change the font" onClick={() => showDialog(FontDialog, {
        value: spec ?? fontOf(x.doc, x.doc.objects[x.index]!, objectKind(x.doc, x.doc.objects[x.index]!) === 'Port' || objectKind(x.doc, x.doc.objects[x.index]!) === 'Sheet Entry' ? 'TEXTFONTID' : 'FONTID'),
        onOk: (f: FontSpec) => onChange(JSON.stringify(f)) })}>{shown}</button>;
    }
    case 'multiline':
      return <textarea id={id} rows={5} value={value} readOnly={ro} autofocus={autofocus} onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)} onKeyDown={(e) => e.stopPropagation()} />;
    default:
      return <input id={id} type="text" value={value} readOnly={ro} autofocus={autofocus} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />;
  }
}

/* ─── Vertices ──────────────────────────────────────────────────────────────────────── */

function readPts(bag: PropertyBag): Vec2[] {
  const n = bag.int('LOCATIONCOUNT'), out: Vec2[] = [];
  for (let i = 1; i <= n; i++) out.push({ x: schCoord(bag, `X${i}`), y: schCoord(bag, `Y${i}`) });
  return out;
}

function Vertices({ pts, onChange }: { pts: string[][]; onChange: (p: string[][]) => void }) {
  const [sel, setSel] = useState(0);
  const u = units.value;
  return (
    <div class="vertices">
      <div class="vert-grid" role="grid">
        <div class="vert-row vert-head" role="row"><span>Index</span><span>X ({u})</span><span>Y ({u})</span></div>
        {pts.map((p, i) => (
          <div key={i} class={`vert-row${sel === i ? ' on' : ''}`} role="row" onMouseDown={() => setSel(i)}>
            <span>{i + 1}</span>
            {[0, 1].map((k) => <input key={k} type="text" value={p[k]} aria-label={`${k ? 'Y' : 'X'} ${i + 1}`}
              onInput={(e) => onChange(pts.map((q, j) => (j === i ? q.map((v, m) => (m === k ? (e.target as HTMLInputElement).value : v)) : q)))} />)}
          </div>
        ))}
      </div>
      <div class="vert-buttons">
        <button class="btn" onClick={() => { const at = pts[sel] ?? pts.at(-1) ?? ['0', '0']; const n = [...pts]; n.splice(sel + 1, 0, [...at]); onChange(n); setSel(sel + 1); }}>Add...</button>
        <button class="btn" disabled={pts.length <= 2} onClick={() => { onChange(pts.filter((_, j) => j !== sel)); setSel(Math.max(0, sel - 1)); }}>Delete</button>
      </div>
    </div>
  );
}

/* ─── The dialog ────────────────────────────────────────────────────────────────────── */

/**
 * A stand-alone document holding the object being placed (and what it owns: a sheet symbol's
 * designator and file name), so the same properties apply to it. Items own by position.
 */
function templateDoc(base: SchDocument, items: { bag: PropertyBag; owner: number }[]): SchDocument {
  const sheet = base.records.find((r) => r.bag?.int('RECORD', -1) === SR.SHEET)?.bag?.clone() ?? PropertyBag.from({ RECORD: SR.SHEET });
  const rec = (b: PropertyBag): SchRawRecord => ({ kind: 0, data: b.toBytes(), bag: b });
  const own = items.map((it) => { const b = it.bag.clone(); if (it.owner >= 0) b.setRaw('OWNERINDEX', String(1 + it.owner)); else b.delete('OWNERINDEX'); return b; });
  const doc: SchDocument = { kind: 'SchDoc', name: base.name, cfb: null, asciiEol: null, records: [rec(PropertyBag.from({ HEADER: 'Template' })), rec(sheet), ...own.map(rec)], objects: [], sheet: base.sheet, diags: base.diags };
  rederive(doc);
  return doc;
}

export interface SchObjectDialogProps {
  /** The editor the object is in or is being placed in … */
  ed?: SchEditor;
  /** … or, with no sheet in front (Preferences › Default Primitives › Edit Values), a sheet to stand for one and the units to show. */
  base?: { doc: SchDocument; units: SchUnits };
  /** The object in the document … */
  index?: number;
  /**
   * … or a record being placed (Tab) or a default being edited: OK hands back the changed record, and the sheet its font
   * numbers are of (the editor's own while placing; the stand-in's otherwise).
   */
  template?: { bag: PropertyBag; onOk: (b: PropertyBag, doc: SchDocument) => void };
  /** … or an object with what it owns (a sheet symbol with its texts): OK hands back them all. */
  templateItems?: { items: { bag: PropertyBag; owner: number }[]; onOk: (items: { bag: PropertyBag; owner: number }[], doc: SchDocument) => void };
  /** Properties left out (a default's: what the clicks decide). */
  hide?: (name: string) => boolean;
  /** The dialog's title, in place of the object's own. */
  title?: string;
}

export function SchObjectDialog({ ed, base, index, template: one, templateItems, hide, title }: SchObjectDialogProps) {
  const template = one ? { items: [{ bag: one.bag, owner: -1 }], onOk: (items: { bag: PropertyBag; owner: number }[], doc: SchDocument) => one.onOk(items[0]!.bag, doc) } : templateItems;
  const home = ed ? { doc: ed.doc, units: schUnitsOf(ed, units.value) } : base!;
  const [ctx] = useState<SchCtx>(() => template
    ? { doc: templateDoc(home.doc, template.items), index: 1, units: home.units, docName: home.doc.name, libraryMode: !!one }
    : { doc: home.doc, index: index!, units: home.units, docName: home.doc.name, libraryMode: !!ed?.libraryMode });
  const o = ctx.doc.objects[ctx.index]!;
  const kind = objectKind(ctx.doc, o);
  // While placing, the cursor decides where it goes: no location fields
  const props = schProps(ctx.doc, o, ctx.libraryMode).filter((p) => (p.cat === 'Graphical' || p.cat === 'Object Specific') && !(template && (/^[XY][12]$/.test(p.name) || p.name === 'Side' || p.name === 'Distance From Top'))
    && !hide?.(p.name));
  const focus = props.find((p) => p.cat === 'Object Specific' && p.set && (p.type === 'text' || p.type === 'multiline'));
  const [draft, setDraft] = useState<Record<string, string>>({});
  const bag0 = ctx.doc.records[ctx.index + 1]!.bag!;
  // Its corners are the clicks' while it is being placed: no Vertices tab then
  const hasPts = !template && [SR.WIRE, SR.BUS, SR.POLYLINE, SR.POLYGON, SR.BEZIER].includes(o.record as never);
  const [pts, setPts] = useState<string[][] | null>(null);
  const [tab, setTab] = useState<'graphical' | 'vertices'>('graphical');
  const value = (p: SchProp) => draft[`${p.cat}:${p.name}`] ?? p.get(ctx);
  const set = (p: SchProp, v: string) => setDraft({ ...draft, [`${p.cat}:${p.name}`]: v });
  const shownPts = pts ?? readPts(bag0).map((p) => [fmtCoord(p.x, ctx.units), fmtCoord(p.y, ctx.units)]);

  const ok = () => {
    const changes: (() => Change | null)[] = [];
    for (const p of props) {
      const k = `${p.cat}:${p.name}`;
      if (!(k in draft) || draft[k] === p.get(ctx) || !p.set) continue;
      changes.push(() => p.set!(ctx, draft[k]!));
    }
    if (pts) {
      const parsed = pts.map(([a, b]) => ({ x: parseCoord(a!, ctx.units), y: parseCoord(b!, ctx.units) }));
      if (parsed.every((p) => p.x !== undefined && p.y !== undefined)) {
        changes.push(() => {
          const before = ctx.doc.records[ctx.index + 1]!.bag!;
          const after = before.clone();
          setWirePts(after, parsed as Vec2[]);
          return replaceBags(ctx.doc, [{ index: ctx.index, before: before.clone(), after }]);
        });
      }
    }
    closeDialog();
    if (template) {
      for (const c of changes) c()?.apply();
      const fonts = sheetFonts(ctx.doc);
      template.onOk(ctx.doc.records.slice(2).map((r, k) => {
        const b = r.bag!.clone(), owner = b.has('OWNERINDEX') ? b.int('OWNERINDEX') - 1 : -1;
        b.delete('OWNERINDEX');
        // A font chosen here was added to this dialog's own copy of the sheet's fonts: the sheet it is placed on gets it, under its own number
        if (ed) for (const key of ['FONTID', 'TEXTFONTID']) {
          const was = b.int(key, 0), f = was ? fonts[was - 1] : undefined, real = sheetFonts(ed.doc);
          if (!f || (real[was - 1] && sameFont(real[was - 1]!, f))) continue;   // the sheet has it under this number already
          const { id, change } = ensureFont(ed.doc, f);
          const there = sheetFonts(ed.doc)[id - 1];
          if (!change && !(there && sameFont(there, f))) continue;   // nowhere to add it (a library's symbol): as it was
          change?.apply();
          b.set(key, String(id));
        }
        return { bag: b, owner: k === 0 ? -1 : owner };
      }), ed ? ed.doc : ctx.doc);
      return;
    }
    if (!ed) return;
    if (changes.length) ed.undo.transact(`Properties of ${kind}`, (tx) => { for (const c of changes) { const ch = c(); if (ch) tx.add(ch); } });
    ed.invalidate();
  };

  const col = (cat: 'Graphical' | 'Object Specific') => props.filter((p) => p.cat === cat);
  const rows = (list: SchProp[]) => list.map((p) => (
    <label key={p.name} class={`dlg-field ft-${p.type}`}>
      <span class="dlg-label">{label(kind, p.name)}</span>
      <Field p={p} x={ctx} value={value(p)} onChange={(v) => set(p, v)} autofocus={p === focus} />
    </label>
  ));
  const graphical = col('Graphical'), specific = col('Object Specific');
  return (
    <Dialog title={title ?? TITLES[kind] ?? kind} width={specific.length && graphical.length ? 700 : 400} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="schprops"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      {hasPts && (
        <div class="dlg-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'graphical'} onClick={() => setTab('graphical')}>Graphical</button>
          <button role="tab" aria-selected={tab === 'vertices'} onClick={() => setTab('vertices')}>Vertices</button>
        </div>
      )}
      {tab === 'vertices' ? <Vertices pts={shownPts} onChange={setPts} /> : (
        <div class={`schprops-cols${specific.length && graphical.length ? '' : ' one'}`}>
          {graphical.length > 0 && <fieldset><legend>Graphical</legend>{rows(graphical)}</fieldset>}
          {specific.length > 0 && <fieldset><legend>Properties</legend>{rows(specific)}</fieldset>}
        </div>
      )}
    </Dialog>
  );
}
