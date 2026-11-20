/**
 * A BOM document (ActiveBOM) in its tab: the project's parts as compiled now, in lines grouped
 * and sorted as its columns say, for the variant chosen; each line's part choices (manufacturer
 * part, supplier, stock, price breaks) — added by hand, looked up at JLCPCB (LCSC numbers), or
 * taken from the parts' parameters — the cost of the production run, the BOM checks, line
 * numbers, and exports (the BOM, and JLCPCB's assembly BOM).
 */
import { webLink } from '../core/webLink';
import { locale } from '../core/locale';
import { PLANNED_NOTE, featureOn } from '../core/release';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { docs, notify, projects, tick, type OpenDoc, type Project } from './state';
import type { BomDocument } from '../formats/altium/bomdoc';
import type { PropertyBag } from '../formats/altium/props';
import type { DbLinkDocument } from '../formats/altium/dblink';
import type { DataTable } from '../formats/table';
import { compileProject } from '../model/compile';
import { bomColumns, bomItems, inBom, wireLinkBomItems } from '../model/bom';
import { boardOf } from './reqFacts';
import {
  SUPPLY_COLUMNS, addChoice, bomChecks, bomLines, bomTotals, choiceBag, choiceOf, designKeys, ensureItem, jlcBomCsv, lcscUrl, lineCells, lineChoices, lineCost, refreshChoice, supplierChoiceBag,
  searchFor, setLineNumbers, sortLines, unitPrice, type BomCheck, type BomLine, type Choice, type PriceBreak,
} from '../model/activeBom';
import { readVariants, variantComponents } from '../model/variants';
import { findRecord } from '../model/dbParams';
import { compileOptions, projectSheets } from './project';
import { bomFile } from './dialogs/Bom';
import { saveFileAs } from '../platform/fs';
import { linkTables, projectLinks } from './dbLink';
import { dbLibData, defaultsOf } from './dbLib';
import { partDbLib } from './dbLibActions';
import { searchJlc, type JlcPart } from '../platform/jlcSearch';
import { partsConfig, searchSupplier, type PartsConfig } from '../platform/supplierSearch';
import { SUPPLIER_NAMES, supplierIdOf, type SupplierId, type SupplierPart } from '../model/suppliers';
import { showDialog } from './dialogs';
import { BomAiFillDialog } from './dialogs/BomAiFill';

const projectOf = (od: OpenDoc): Project | null => (od.projectId ? projects.value.find((p) => p.id === od.projectId) ?? null : null);
type Format = 'xlsx' | 'csv' | 'txt' | 'html';
/** The supply and cost columns (Line # is AD's own, kept). */
const SUPPLY_ONLY = SUPPLY_COLUMNS.filter((c) => c !== 'Line #');
const SYM: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };
const money = (v: number | undefined, cur: string) => (v === undefined ? '—' : `${SYM[cur] ?? `${cur} `}${v < 1 ? v.toFixed(4) : v.toFixed(2)}`);
const lineKey = (l: BomLine) => `${l.uid}|${l.hash}|${l.designators[0] ?? ''}`;

export function BomDocView({ od }: { od: OpenDoc }) {
  void tick.value;
  const bd = od.doc as BomDocument;
  const [, redraw] = useState(0);
  const [format, setFormat] = useState<Format>('xlsx');
  const [db, setDb] = useState<{ link: DbLinkDocument; tables: DataTable[] }[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const changed = () => { bd.dirty = true; tick.value++; redraw((x) => x + 1); };
  const p = projectOf(od);
  const variants = p ? readVariants(p.prj) : [];
  const v = variants.find((x) => x.name === bd.variant) ?? null;
  // Compiled again when the design changes (an open sheet edited, the project's files), not for a ticked column
  const design = `${docs.value.filter((d) => d.projectId === p?.id).map((d) => `${d.id}:${d.editor?.undo.revision ?? 0}`).join(',')}|${p?.files.size ?? 0}|${p?.prj.lines.join('\u0001') ?? ''}`;
  const compiled = useMemo(() => { const s = projectSheets(p); return s.length ? compileProject(s, compileOptions(p)) : null; }, [p, design]);
  // Include Parameters From Database: the project's links, their data read once
  useEffect(() => {
    if (!bd.includeDb || !p) { setDb([]); return; }
    let live = true;
    void Promise.all(projectLinks(p).map(async ({ path, link }) => ({ link, tables: await linkTables(p, path, link) }))).then((r) => {
      if (live) setDb(r.filter((x): x is { link: DbLinkDocument; tables: DataTable[] } => !!x.tables));
    });
    return () => { live = false; };
  }, [p, bd.includeDb]);
  // The board's wire links (Place › Wire Link), which no sheet has
  const wires = useMemo(() => { const b = p ? boardOf(p) : null; return b ? wireLinkBomItems(b.doc) : []; }, [p, design]);
  const items = useMemo(() => {
    const comps = compiled ? variantComponents(compiled.components, v, bd.showNotFitted).filter(inBom) : [];
    const own = wires.map((it): Record<string, string> => ({ ...it, ...(v ? { Fitted: 'Fitted' } : {}) }));
    return [...bomItems(comps).map((it, i) => {
      const c = comps[i]!;
      const out: Record<string, string> = { ...it, ...(v ? { Fitted: c.fitted ? 'Fitted' : 'Not Fitted' } : {}) };
      designKeys.set(out, { library: c.sourceLibrary ?? c.library ?? '', libRef: c.libRef });
      const part = { sheet: c.sheet, index: 0, designator: c.designator, params: new Map(Object.entries(c.params).map(([k, val]) => [k.toUpperCase(), { name: k, value: val }])) };
      // A part from a database library: its record in its own library's table
      const lib = bd.includeDb && c.table ? partDbLib(c.library) : undefined;
      const libData = lib ? dbLibData(lib) : null;
      if (lib && libData && libData !== 'loading') {
        const hit = findRecord({ tables: lib.doc().tables, defaults: defaultsOf(lib.doc()) }, libData.tables, part, c.table);
        if (hit) for (const [k, val] of Object.entries(hit.row)) if (!(k in out)) out[k] = val;
      }
      for (const { link, tables } of db) {
        const hit = findRecord(link, tables, part);
        if (hit) for (const [k, val] of Object.entries(hit.row)) if (!(k in out)) out[k] = val;
      }
      return out;
    }), ...own];
  }, [compiled, wires, v, bd.showNotFitted, db, bd.includeDb, tick.value]);
  const all = useMemo(() => { const c = bomColumns(items); return [...c.slice(0, 6), ...SUPPLY_COLUMNS, ...c.slice(6)]; }, [items]);
  const s = bd.setup;
  // Supply, cost and checks: shown as planned until their release (AD's supply columns kept, not shown)
  const supply = featureOn('bomSupply');
  const shownCols = supply ? s.columns : s.columns.filter((c) => !SUPPLY_ONLY.includes(c));
  const lines = useMemo(() => sortLines(bomLines(items, s, bd), s, bd.production), [items, s.group.join('|'), s.sort?.column, s.sort?.descending, bd.production, tick.value]);
  const rows = lines.map((l) => lineCells(l, shownCols, bd.production));
  const checks = useMemo(() => bomChecks(bd, lines, bd.production), [lines, bd.production, tick.value]);
  const totals = bomTotals(lines, bd.production);
  const status = new Map<BomLine, BomCheck['level']>();
  for (const c of checks) if (c.line && status.get(c.line) !== 'error') status.set(c.line, c.level);
  const line = lines.find((l) => lineKey(l) === sel) ?? null;

  const order = (c: string) => { const i = all.indexOf(c); return i < 0 ? 999 : i; };
  const set = (p2: Partial<typeof s>) => { bd.setup = { ...s, ...p2 }; changed(); };
  const toggleShow = (c: string) => set({ columns: s.columns.includes(c) ? s.columns.filter((x) => x !== c) : [...s.columns, c].sort((a, b) => order(a) - order(b)) });
  const toggleGroup = (c: string) => set({ group: s.group.includes(c) ? s.group.filter((x) => x !== c) : [...s.group, c] });
  const sortBy = (c: string) => set({ sort: { column: c, descending: s.sort?.column === c ? !s.sort.descending : false } });
  const base = (p?.name ?? od.name).replace(/\.[^.]+$/, '');
  const save = async (name: string, bytes: Uint8Array, what: string) => {
    try { const h = await saveFileAs(name, bytes); if (h !== null) notify(`${what} saved as ${name}`); } catch (e) { notify(`Couldn't save: ${(e as Error).message}`, 'error'); }
  };
  const exportFile = async () => {
    const f = bomFile(`Bill of Materials For ${p?.name ?? od.name}${bd.variant ? ` (${bd.variant})` : ''}`, base, format, shownCols, rows);
    await save(f.name, f.bytes ?? new TextEncoder().encode(f.text), 'Bill of Materials');
  };
  // Every LCSC part choice (and every line whose parts name an LCSC number) looked up again at JLCPCB's parts
  // list, and every Digi-Key and Mouser choice through Konium's parts service: stock, prices (lifecycle)
  const updateSupply = async () => {
    type Todo = { l: BomLine; b: PropertyBag | null; c: string; at: SupplierId | 'jlc' };
    const todo = lines.flatMap((l): Todo[] => {
      const own = l.item?.choices.flatMap((b): Todo[] => {
        const spn = b.get('SUPPLIERPARTNO') ?? '', sup = b.get('SUPPLIER') ?? '';
        if (/lcsc|jlc/i.test(sup) && /^C\d+$/i.test(spn)) return [{ l, b, c: spn, at: 'jlc' }];
        const id = supplierIdOf(sup);
        return id && spn ? [{ l, b, c: spn, at: id }] : [];
      }) ?? [];
      if (own.length) return own;
      const c = lineChoices(l)[0];
      return c?.from === 'parameters' && /^C\d+$/i.test(c.spn) ? [{ l, b: null, c: c.spn, at: 'jlc' }] : [];
    });
    if (!todo.length) { notify('No supplier part numbers to look up: search for a line\'s part first', 'error'); return; }
    let done = 0;
    const missing: string[] = [], failed: string[] = [];
    for (const t of todo) {
      setBusy(`Updating ${done + missing.length + failed.length + 1} of ${todo.length}…`);
      try {
        if (t.at === 'jlc') {
          const hit = (await searchJlc(t.c))[0];
          if (!hit) { missing.push(t.c); continue; }
          if (t.b) refreshChoice(t.b, { stock: hit.stock, prices: hit.prices, currency: 'USD', library: hit.library });
          else ensureItem(bd, t.l).choices.unshift(jlcChoice(hit, lineChoices(t.l)[0]?.manufacturer ?? ''));
        } else {
          const hit = (await searchSupplier(t.at, t.c, true)).parts.find((p) => p.spn.toLowerCase() === t.c.toLowerCase());
          if (!hit) { missing.push(t.c); continue; }
          refreshChoice(t.b!, { stock: hit.stock, prices: hit.prices, currency: hit.currency, library: undefined, lifecycle: hit.lifecycle });
        }
        done++;
      } catch (e) {
        // One supplier failing (not set up, its limit for the day) leaves the others to finish
        failed.push(`${t.c} (${(e as Error).message})`);
        if (t.at === 'jlc' && failed.length === 1 && !done) { setBusy(''); notify(`JLCPCB parts search: ${(e as Error).message}`, 'error'); changed(); return; }
      }
    }
    setBusy('');
    changed();
    notify(`Supplier data updated: ${done} part${done === 1 ? '' : 's'}${missing.length ? `; not found: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}` : ''}${failed.length ? `; not looked up: ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? '…' : ''}` : ''}`, failed.length && !done ? 'error' : undefined);
  };
  const jlcExport = async () => {
    const missing = lines.filter((l) => !lineChoices(l).some((c) => /lcsc|jlc/i.test(c.supplier)) && !/^C\d+/i.test(lineCells(l, ['Supplier Part Number 1'], 1)[0]!)).length;
    await save(`${base}_JLCPCB_BOM.csv`, new TextEncoder().encode(jlcBomCsv(lines)), 'JLCPCB BOM');
    if (missing) notify(`${missing} line${missing === 1 ? ' has' : 's have'} no LCSC part number: JLCPCB will ask for ${missing === 1 ? 'it' : 'them'}`);
  };

  return (
    <div class="bomdoc" aria-label={`BOM document ${od.name}`}>
      <div class="bom-top">
        {!supply && <span class="planned-feature" title={PLANNED_NOTE}>Supply and cost<span class="planned-tag">Planned</span></span>}
        <label class={supply ? '' : 'planned-feature'} title={supply ? undefined : PLANNED_NOTE}>Production Quantity <input type="number" min={1} step={1} aria-label="Production Quantity" value={bd.production} disabled={!supply}
          onChange={(e) => { const n = Math.max(1, Math.round(Number((e.target as HTMLInputElement).value) || 1)); bd.production = n; changed(); }} /></label>
        {supply && <span class="bom-total" aria-label="Cost">
          Per board <b>{totals.byCurrency.length ? totals.byCurrency.map((t) => money(t.perBoard, t.currency)).join(' + ') : money(undefined, '')}</b> · for {bd.production} <b>{totals.byCurrency.length ? totals.byCurrency.map((t) => money(t.run, t.currency)).join(' + ') : money(undefined, '')}</b>
          <span class="muted"> ({totals.priced} of {totals.lines} lines priced{totals.mixed ? '; each currency added up on its own' : ''})</span>
        </span>}
        <span class="spacer" />
        {busy && <span class="muted">{busy}</span>}
        <button class="btn" disabled={!lines.length || !supply} onClick={() => showDialog(BomAiFillDialog, { lines, production: bd.production, add: (l: BomLine, b: PropertyBag) => { addChoice(bd, l, b); changed(); } })}
          title={supply ? 'A manufacturer part for each line, suggested by the AI model chosen in Preferences and looked up at JLCPCB' : PLANNED_NOTE}>Fill Part Numbers With AI...</button>
        <button class="btn" disabled={!lines.length} onClick={() => { setLineNumbers(bd, lines); changed(); }}>Set Line Numbers</button>
        <button class="btn" disabled={!lines.length || !!busy || !supply} onClick={() => void updateSupply()} title={supply ? 'Stock and prices again: LCSC parts from JLCPCB\'s parts list, Digi-Key and Mouser parts through Konium\'s parts service' : PLANNED_NOTE}>Update Supplier Data</button>
      </div>
      <div class="bom-body bom-body3">
        <div class="bom-side">
          <fieldset><legend>Variant</legend>
            <select aria-label="Variant" value={bd.variant} onChange={(e) => { bd.variant = (e.target as HTMLSelectElement).value; changed(); }}>
              <option value="">[No Variations]</option>{variants.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select>
            <label class="out-check"><input type="checkbox" checked={bd.showNotFitted} disabled={!v} onChange={() => { bd.showNotFitted = !bd.showNotFitted; changed(); }} />Show Not Fitted</label>
            <label class="out-check"><input type="checkbox" checked={bd.includeDb} disabled={!p || (!projectLinks(p).length && !compiled?.components.some((c) => c.table))} onChange={() => { bd.includeDb = !bd.includeDb; changed(); }} />Include Parameters From Database</label>
          </fieldset>
          <fieldset><legend>Grouped Columns</legend>
            {s.group.length ? s.group.map((g) => <div key={g} class="bom-chip">{g}<button aria-label={`Ungroup ${g}`} onClick={() => toggleGroup(g)}>×</button></div>) : <p class="muted small">None: a line per design item, grouped by library reference, comment and description</p>}
          </fieldset>
          <fieldset class="bom-cols"><legend>All Columns</legend>
            <div class="bom-col bom-col-head"><span>Column</span><span>Show</span><span>Group</span></div>
            {all.map((c) => {
              const later = !supply && SUPPLY_ONLY.includes(c);
              return (
              <div key={c} class={`bom-col${later ? ' planned-feature' : ''}`} title={later ? PLANNED_NOTE : undefined}><span title={later ? PLANNED_NOTE : c}>{c}</span>
                <input type="checkbox" checked={!later && s.columns.includes(c)} disabled={later} onChange={() => toggleShow(c)} aria-label={`Show ${c}`} />
                <input type="checkbox" checked={s.group.includes(c)} disabled={c === 'Quantity' || c === 'Designator' || SUPPLY_COLUMNS.includes(c)} onChange={() => toggleGroup(c)} aria-label={`Group by ${c}`} /></div>
              );
            })}
          </fieldset>
        </div>
        <div class="bom-table">
          <div class="bom-scroll">
            {!compiled ? <p class="muted">{p ? `${p.name} has no schematics to take parts from` : 'A BOM document takes its parts from its project: add it to a project with schematics'}</p> : (
              <table>
                <thead><tr>{supply && <th class="bom-st" title="BOM Status" />} {shownCols.map((c) => <th key={c} onClick={() => sortBy(c)} class={s.sort?.column === c ? 'sorted' : ''}>{c}{s.sort?.column === c ? (s.sort.descending ? ' ▾' : ' ▴') : ''}</th>)}</tr></thead>
                <tbody>{lines.map((l, i) => {
                  const st = status.get(l);
                  const nf = v && shownCols.includes('Fitted') && rows[i]![shownCols.indexOf('Fitted')] === 'Not Fitted';
                  return (
                    <tr key={lineKey(l)} class={`${nf ? 'nf' : ''}${sel === lineKey(l) ? ' on' : ''}`} onClick={() => setSel(lineKey(l))}>
                      {supply && <td class="bom-st">{st && <span class={`bom-status ${st}`} title={checks.filter((c) => c.line === l).map((c) => c.message).join('\n')}>{st === 'error' ? '✖' : '!'}</span>}</td>}
                      {rows[i]!.map((x, j) => <td key={j} class={/Price|Subtotal|Stock/.test(shownCols[j]!) ? 'num' : ''}>{x}</td>)}
                    </tr>
                  );
                })}</tbody>
              </table>
            )}
          </div>
          <div class="bomdoc-foot">
            <span class="muted small">{lines.length} line{lines.length === 1 ? '' : 's'}, {items.length} part{items.length === 1 ? '' : 's'}{bd.variant ? ` · variant ${bd.variant}` : ''}</span>
            <span class="spacer" />
            <select aria-label="Export format" value={format} onChange={(e) => setFormat((e.target as HTMLSelectElement).value as Format)}>
              <option value="xlsx">Excel (*.xlsx)</option><option value="csv">CSV (*.csv)</option><option value="txt">Tab Delimited (*.txt)</option><option value="html">Web Page (*.html)</option></select>
            <button class="btn" disabled={!rows.length} onClick={() => void exportFile()}>Export...</button>
            <button class="btn" disabled={!rows.length || !supply} onClick={() => void jlcExport()} title={supply ? 'Comment, Designator, Footprint and LCSC Part # for JLCPCB\'s assembly service' : PLANNED_NOTE}>Export For JLCPCB...</button>
          </div>
        </div>
        {!supply ? (
          <div class="bom-right planned-feature" title={PLANNED_NOTE}>
            <fieldset><legend>BOM Checks<span class="planned-tag">Planned</span></legend><p class="muted small">{PLANNED_NOTE}.</p></fieldset>
            <fieldset><legend>Solutions<span class="planned-tag">Planned</span></legend><p class="muted small">Each line's manufacturer parts and suppliers, JLCPCB stock and prices, and the cost of a production run.</p></fieldset>
          </div>
        ) : <div class="bom-right">
          <fieldset class="bom-checks"><legend>BOM Checks ({checks.length})</legend>
            {!checks.length ? <p class="muted small">No issues</p> : (
              <div class="bom-check-list">{summarise(checks).map(([name, list]) => (
                <details key={name}><summary><span class={`bom-status ${list[0]!.level}`}>{list[0]!.level === 'error' ? '✖' : '!'}</span> {name} ({list.length})</summary>
                  {list.map((c, i) => <div key={i} class="link small" onClick={() => c.line && setSel(lineKey(c.line))}>{c.message}</div>)}</details>
              ))}</div>
            )}
          </fieldset>
          <Solutions bd={bd} line={line} changed={changed} />
        </div>}
      </div>
    </div>
  );
}

function summarise(checks: BomCheck[]): [string, BomCheck[]][] {
  const m = new Map<string, BomCheck[]>();
  for (const c of checks) m.set(c.check, [...(m.get(c.check) ?? []), c]);
  return [...m].sort((a, b) => Number(b[1][0]!.level === 'error') - Number(a[1][0]!.level === 'error'));
}

/** A part found at JLCPCB as a part choice (LCSC as the supplier). */
export function jlcChoice(h: JlcPart, manufacturer = '') {
  return choiceBag({ manufacturer, mpn: h.mpn, supplier: 'LCSC', spn: h.lcsc, stock: h.stock, prices: h.prices, currency: 'USD', lifecycle: '', url: lcscUrl(h.lcsc), description: h.description, library: h.library }, 'JLCPCB');
}

/** A search result from any source, as the Solutions panel lists it. */
interface Hit { spn: string; url: string; mpn: string; manufacturer: string; detail: string; library?: string; stock?: number; prices: PriceBreak[]; currency: string; description: string; make: () => PropertyBag }
type Source = 'jlc' | SupplierId;
const SOURCE_NAMES: Record<Source, string> = { jlc: 'JLCPCB\'s parts list', ...SUPPLIER_NAMES };
let lastSource: Source = 'jlc';

/** The selected line's part choices: best first, moved, removed, added by hand, or found in JLCPCB's parts list, at Digi-Key or at Mouser. */
function Solutions({ bd, line, changed }: { bd: BomDocument; line: BomLine | null; changed: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [state, setState] = useState('');
  const [source, setSourceState] = useState<Source>(lastSource);
  const [cfg, setCfg] = useState<PartsConfig | null | undefined>(undefined);
  const [left, setLeft] = useState<number | undefined>(undefined);
  // The parts service is asked what it searches only once Digi-Key or Mouser is chosen
  useEffect(() => { if (source !== 'jlc' && cfg === undefined) void partsConfig().then((c) => { setCfg(c); setLeft(c?.left); }); }, [source]);
  const setSource = (s: Source) => { lastSource = s; setSourceState(s); setHits(null); setState(''); };
  const [manual, setManual] = useState<null | { manufacturer: string; mpn: string; supplier: string; spn: string; price: string; stock: string }>(null);
  const key = line ? lineKey(line) : '';
  useEffect(() => { setQ(line ? searchFor(line) : ''); setHits(null); setState(''); setManual(null); }, [key]);
  if (!line) return <fieldset class="bom-solutions"><legend>Solutions</legend><p class="muted small">Pick a line to see its part choices, add one, or search for it in JLCPCB's parts list, at Digi-Key or at Mouser</p></fieldset>;
  const choices = lineChoices(line);
  const units = line.quantity * bd.production;
  const cost = lineCost(line, bd.production);
  const manufacturerOf = (mpn: string) => choices.find((c) => c.mpn.toLowerCase() === mpn.toLowerCase())?.manufacturer ?? '';
  const search = async () => {
    const name = SOURCE_NAMES[source];
    setState(`Searching ${name}…`); setHits(null);
    try {
      if (source === 'jlc') {
        const r = await searchJlc(q);
        setHits(r.slice(0, 30).map((h: JlcPart): Hit => ({ spn: h.lcsc, url: lcscUrl(h.lcsc), mpn: h.mpn, manufacturer: '', detail: h.package, library: h.library, stock: h.stock, prices: h.prices, currency: 'USD', description: `${h.description}${h.category ? `\n${h.category}` : ''}`, make: () => jlcChoice(h, manufacturerOf(h.mpn)) })));
        setState(r.length ? '' : `Nothing found in ${name}`);
      } else {
        const a = await searchSupplier(source, q);
        setLeft(a.left);
        setHits(a.parts.slice(0, 30).map((p: SupplierPart): Hit => ({ spn: p.spn, url: p.url, mpn: p.mpn, manufacturer: p.manufacturer, detail: [p.packaging, p.moq && p.moq > 1 ? `min ${p.moq.toLocaleString(locale())}` : '', p.lifecycle && !/^active$/i.test(p.lifecycle) ? p.lifecycle : ''].filter(Boolean).join(' · '), stock: p.stock, prices: p.prices, currency: p.currency, description: p.description, make: () => supplierChoiceBag(p) })));
        setState(a.parts.length ? (a.cached ? `As found at ${name} ${new Date(a.at).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' })}, kept by the service` : '') : `Nothing found at ${name}`);
      }
    } catch (e) { setState(`Couldn't search: ${(e as Error).message}`); }
  };
  const notReady = source !== 'jlc' && cfg ? !cfg.sources.find((s) => s.id === source)?.ready : false;
  const add = (b: ReturnType<typeof choiceBag>) => {
    addChoice(bd, line, b);
    changed();
  };
  const move = (i: number) => { const it = line.item; if (!it || i <= 0) return; const [b] = it.choices.splice(i, 1); it.choices.unshift(b!); changed(); };
  const remove = (i: number) => { const it = line.item; if (!it) return; it.choices.splice(i, 1); changed(); };
  return (
    <fieldset class="bom-solutions"><legend>Solutions: {line.designators.slice(0, 4).join(', ')}{line.designators.length > 4 ? '…' : ''}</legend>
      <p class="small muted">{line.quantity} per board · {units} for {bd.production} board{bd.production === 1 ? '' : 's'} · {cost.unit === undefined ? 'no price' : `${money(cost.unit, cost.currency)} each, ${money(cost.subtotal, cost.currency)}`}</p>
      {!choices.length && <p class="small muted">No part choices yet</p>}
      {choices.map((c: Choice, i) => (
        <div key={i} class={`bom-choice${i === 0 ? ' top' : ''}`}>
          <div class="bom-choice-head"><b>{c.mpn || '(no part number)'}</b>{c.manufacturer && <span> · {c.manufacturer}</span>}
            {c.from === 'parameters' && <span class="muted small"> · from the parts' parameters</span>}</div>
          <div class="small">{c.supplier || 'No supplier'}{c.spn && <> {webLink(c.url) ? <a href={webLink(c.url)} target="_blank" rel="noopener noreferrer">{c.spn}</a> : c.spn}</>}
            {c.library && <span class={`bom-lib ${c.library.toLowerCase()}`}>{c.library}</span>}
            {c.stock !== undefined && <span> · stock {c.stock.toLocaleString(locale())}</span>}
            {c.prices.length > 0 && <span> · {money(unitPrice(c, units), c.currency)} at {units}</span>}
            {c.lifecycle && <span> · {c.lifecycle}</span>}</div>
          {c.description && <div class="small muted">{c.description}</div>}
          {c.from === 'choice' && <div class="bom-choice-acts">
            {i > 0 && <button class="link" onClick={() => move(i)}>Make First</button>}
            <button class="link" onClick={() => remove(i)}>Remove</button></div>}
        </div>
      ))}
      <div class="bom-add">
        <div class="bom-search">
          <select aria-label="Search at" value={source} onChange={(e) => setSource((e.target as HTMLSelectElement).value as Source)}>
            {(Object.keys(SOURCE_NAMES) as Source[]).map((k) => <option key={k} value={k}>{SOURCE_NAMES[k]}</option>)}
          </select>
          <input aria-label={`Search ${SOURCE_NAMES[source]}`} value={q} placeholder={source === 'jlc' ? 'LCSC number, part number, or value and package' : 'Part number, or value and package'} onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !notReady) void search(); }} /><button class="btn" disabled={!q.trim() || notReady} onClick={() => void search()}>Search</button></div>
        <p class="small muted">{source === 'jlc'
          ? 'Looks the part up at jlcsearch.tscircuit.com (a public copy of JLCPCB\'s parts list): only what is in the box is sent.'
          : notReady ? `${SOURCE_NAMES[source]} searches aren't set up on Konium's parts service yet.`
          : `Searches ${SOURCE_NAMES[source]} through Konium's parts service (konium.app), which holds Konium Designer's key: only what is in the box is sent. A search is kept by the service for ${cfg?.cacheHours ?? 24} hours${left !== undefined ? `; ${left} new search${left === 1 ? '' : 'es'} left for you today` : ''}.`}</p>
        {state && <p class="small">{state}</p>}
        {hits && hits.length > 0 && (
          <div class="bom-hits-wrap"><table class="sd-table bom-hits" aria-label={`Parts found: ${SOURCE_NAMES[source]}`}><thead><tr><th>{source === 'jlc' ? 'LCSC' : SOURCE_NAMES[source]}</th><th>Part</th><th>Stock</th><th>Price</th><th /></tr></thead>
            <tbody>{hits.map((h) => (
              <tr key={h.spn} title={h.description}>
                <td>{webLink(h.url) ? <a href={webLink(h.url)} target="_blank" rel="noopener noreferrer">{h.spn}</a> : h.spn}</td>
                <td>{h.mpn}{h.manufacturer && <span class="muted"> · {h.manufacturer}</span>}<div class="muted">{h.detail}{h.library && <span class={`bom-lib ${h.library.toLowerCase()}`}>{h.library}</span>}</div></td>
                <td class="num" title={h.stock === undefined ? 'The stock isn\'t given' : undefined}>{h.stock === undefined ? '?' : h.stock.toLocaleString(locale())}</td>
                <td class="num">{h.prices.length ? money(unitPrice({ prices: h.prices } as Choice, units), h.currency) : ''}</td>
                <td><button class="link" onClick={() => add(h.make())}>Add</button></td>
              </tr>
            ))}</tbody></table></div>
        )}
        {manual ? (
          <div class="bom-manual">
            {([['manufacturer', 'Manufacturer'], ['mpn', 'Part Number'], ['supplier', 'Supplier'], ['spn', 'Supplier Part Number'], ['price', 'Unit Price'], ['stock', 'Stock']] as const).map(([k, label]) => (
              <label key={k}>{label}<input aria-label={label} value={manual[k]} onInput={(e) => setManual({ ...manual, [k]: (e.target as HTMLInputElement).value })} /></label>
            ))}
            <div><button class="btn" disabled={!manual.mpn.trim() && !manual.spn.trim()} onClick={() => {
              const price = Number(manual.price), stock = manual.stock.trim() === '' ? undefined : Number(manual.stock);
              add(choiceBag({ manufacturer: manual.manufacturer.trim(), mpn: manual.mpn.trim(), supplier: manual.supplier.trim(), spn: manual.spn.trim(), stock: Number.isFinite(stock) ? stock : undefined,
                prices: manual.price.trim() && Number.isFinite(price) ? [{ qty: 1, price }] : [], currency: bd.currency, lifecycle: '', url: '', description: '' }));
              setManual(null);
            }}>Add</button> <button class="btn" onClick={() => setManual(null)}>Cancel</button></div>
          </div>
        ) : <button class="btn" onClick={() => setManual({ manufacturer: choices[0]?.manufacturer ?? '', mpn: '', supplier: '', spn: '', price: '', stock: '' })}>Add Solution By Hand...</button>}
      </div>
      {line.item?.choices.length ? <p class="small muted">Kept in the BOM document as part choices ({line.item.choices.map((b) => choiceOf(b).supplier || '?').join(', ')})</p> : null}
    </fieldset>
  );
}
