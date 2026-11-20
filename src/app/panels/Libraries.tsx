import { useMemo, useState } from 'preact/hooks';
import { settings } from '../../core/settings';
import { signal } from '@preact/signals';
import { Grid } from '../Dialog';
import { active, notify, tick } from '../state';
import { availableLibraries, installLibraries, installedLibs, SymbolPreview } from '../dialogs/PlacePart';
import { placeComponent, placePart } from '../placeCommands';
import { SchEditor } from '../../editors/sch/SchEditor';
import { partLetter, SR } from '../../model/sch';
import { partRecords, symbolFootprint } from '../../model/schPlace';
import type { LibSymbol, SchLibrary } from '../../formats/altium/schlib';
import type { Footprint } from '../../formats/altium/pcblib';
import { availablePcbLibraries } from '../eco';
import { showDialog } from '../dialogs';
import { PlaceComponentDialog } from '../dialogs/PlaceComponent';
import { FootprintPreview } from '../dialogs/FootprintPreview';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../../editors/pcb/PcbLibEditor';
import { dbLibContexts, dbLibData, defaultsOf, recordFootprint, recordSymbol, tableOf, type DbLibCtx, type DbLibData } from '../dbLib';
import { dbPartRecords, recordKey, recordModels } from '../../model/dbLibParts';
import { chooseDbLibFolder } from '../dbLibActions';

/**
 * Libraries panel (System › Libraries), Altium's way to place parts: pick a library (or all of
 * them), filter with a mask, see the symbol and its models, Place (or double-click) puts it on
 * the schematic under the cursor. PCB libraries list their footprints (with a preview): Place
 * puts one on the board through Place Component. Libraries... adds .SchLib / .PcbLib / .IntLib
 * files for this session. A database library lists each of its tables (Library/Table), their
 * records as parts: the key, description and footprint, the symbol its record names previewed.
 */

const ALL = '(All Libraries)';
const libSel = signal<string>('');
const maskSel = signal('');

/** A component of a schematic library, a footprint of a PCB library, or a record of a database library's table. */
type DbRow = { kind: 'db'; name: string; lib: { name: string }; ctx: DbLibCtx; data: DbLibData; table: string; columns: string[]; row: Record<string, string>; description: string; footprint: string };
type Row = { kind: 'sym'; name: string; sym: LibSymbol; lib: SchLibrary } | { kind: 'fp'; name: string; fp: Footprint; lib: { name: string } } | DbRow;
/** A database library's table as the panel names it. */
const tableLabel = (lib: string, table: string) => `${lib}/${table}`;

/** Tools › Find Component: every library, the mask field focused (after the panel shows). */
export function focusLibrarySearch(): void {
  libSel.value = ALL;
  setTimeout(() => (document.getElementById('lib-mask') as HTMLInputElement | null)?.focus(), 60);
}

export function LibrariesPanel() {
  void tick.value;
  void installedLibs.value;
  const libs = availableLibraries();
  const pcbLibs = availablePcbLibraries();
  const dbLibs = dbLibContexts();
  const dbTables = dbLibs.flatMap((ctx) => ctx.doc().tables.filter((t) => t.enabled).map((t) => ({ ctx, table: t.name, label: tableLabel(ctx.name, t.name) })));
  const names = [...libs.map((l) => l.name), ...pcbLibs.map((l) => l.name), ...dbTables.map((t) => t.label)];
  const name = libSel.value && (libSel.value === ALL || names.includes(libSel.value)) ? libSel.value : names[0] ?? '';
  const [ref, setRef] = useState('');
  // System › View › Auto show symbol and model previews off: drawn only on asking
  const [peek, setPeek] = useState<string | null>(null);
  const [part, setPart] = useState(1);
  const rows = useMemo<Row[]>(() => {
    const re = (() => { try { return new RegExp(maskSel.value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i'); } catch { return /.*/; } })();
    const hit = (a: string, b: string) => !maskSel.value || re.test(a) || re.test(b);
    const sym = (name === ALL ? libs : libs.filter((l) => l.name === name))
      .flatMap((lib) => lib.symbols.filter((s) => hit(s.libRef, s.description)).map((s): Row => ({ kind: 'sym', name: s.libRef, sym: s, lib })));
    const fps = (name === ALL ? pcbLibs : pcbLibs.filter((l) => l.name === name))
      .flatMap((lib) => lib.footprints.filter((f) => hit(f.name, f.description)).map((fp): Row => ({ kind: 'fp', name: fp.name, fp, lib })));
    const recs: Row[] = [];
    for (const t of name === ALL ? dbTables : dbTables.filter((x) => x.label === name)) {
      const data = dbLibData(t.ctx);
      const def = tableOf(t.ctx.doc(), t.table);
      const table = data === 'loading' || !def ? undefined : data.tables.find((d) => d.name.toLowerCase() === t.table.toLowerCase());
      if (data === 'loading' || !def || !table) continue;
      for (const r of table.rows) {
        const key = recordKey(def, table.columns, r);
        const m = recordModels(def, table.columns, r);
        if (!key || !hit(key, m.description)) continue;
        recs.push({ kind: 'db', name: key, lib: { name: t.label }, ctx: t.ctx, data, table: def.name, columns: table.columns, row: r, description: m.description, footprint: m.footprints[0]?.ref ?? '' });
      }
    }
    return [...sym, ...fps, ...recs];
  }, [libs.map((l) => `${l.name}:${l.symbols.length}`).join('|'), pcbLibs.map((l) => `${l.name}:${l.footprints.length}`).join('|'), dbTables.map((t) => t.label).join('|'), name, maskSel.value, tick.value]);
  const dbSel = dbTables.find((t) => t.label === name);
  const dbState = dbSel ? dbLibData(dbSel.ctx) : null;
  const dbNote = dbState === 'loading' ? `Reading ${dbSel!.ctx.name}'s database...` : dbState && dbState.error ? `${dbSel!.ctx.name}: ${dbState.error}` : dbState && !dbState.tables.some((d) => d.name.toLowerCase() === dbSel!.table.toLowerCase()) ? `${dbSel!.ctx.name}: its database has no table ${dbSel!.table}` : '';
  const sel = rows.find((r) => `${r.kind}:${r.lib.name}:${r.name}` === ref) ?? rows[0];
  const fpOnly = name !== ALL && pcbLibs.some((l) => l.name === name);
  const keyOf = (r: Row) => `${r.kind}:${r.lib.name}:${r.name}`;
  const dbRec = sel?.kind === 'db' ? (() => { const def = tableOf(sel.ctx.doc(), sel.table)!; const m = recordModels(def, sel.columns, sel.row); return { def, m, symbol: m.libRef ? recordSymbol(sel.data, m.libPath, m.libRef, libs) : null }; })() : null;
  const models = sel?.kind === 'db' ? [{ name: dbRec!.m.libRef || '(no symbol)', type: dbRec!.symbol ? 'Symbol' : 'Symbol (not found)' },
    ...dbRec!.m.footprints.map((f) => ({ name: f.ref, type: recordFootprint(sel.data, f.path, f.ref) ? 'Footprint' : 'Footprint (not found)' }))]
    : sel?.kind === 'sym' ? sel.sym.bags.filter((b) => b.int('RECORD') === SR.IMPLEMENTATION).map((b) => ({ name: b.get('MODELNAME') ?? '', type: (b.get('MODELTYPE') ?? '').toUpperCase() === 'PCBLIB' ? 'Footprint' : b.get('MODELTYPE') ?? '' }))
    : sel ? [{ name: sel.fp.name, type: 'Footprint' }, ...sel.fp.prims.filter((p) => p.kind === 'body').map((p) => ({ name: (p as { modelName: string }).modelName || (p as { identifier: string }).identifier || '3D body', type: '3D Model' }))] : [];
  const place = (r = sel) => {
    if (!r) return;
    const ed = active.value?.editor;
    if (r.kind === 'fp') {
      // A footprint goes onto a board, through Place Component with it chosen
      if (!(ed instanceof PcbEditor) || ed instanceof PcbLibEditor) { notify('Open a PCB document to place footprints on', 'error'); return; }
      showDialog(PlaceComponentDialog, { footprints: [{ library: r.lib.name, footprint: r.fp }], initial: r.fp.name, onPlace: placeComponent });
      return;
    }
    if (!(ed instanceof SchEditor) || ed.libraryMode) { notify('Open a schematic sheet to place parts on', 'error'); return; }
    if (r.kind === 'db') {
      const def = tableOf(r.ctx.doc(), r.table);
      const m = def ? recordModels(def, r.columns, r.row) : null;
      const found = m?.libRef ? recordSymbol(r.data, m.libPath, m.libRef, libs) : null;
      if (!def || !found) { notify(`${r.name}: its symbol ${m?.libRef || '(none named)'}${m?.libPath ? ` in ${m.libPath}` : ''} wasn't found`, 'error'); return; }
      placePart({ items: dbPartRecords(found.sym, r.ctx.name, def, r.columns, r.row, defaultsOf(r.ctx.doc()), Math.min(part, found.sym.parts)), symbol: found.sym, library: r.ctx.name });
      (document.querySelector('.viewport') as HTMLElement | null)?.focus();
      return;
    }
    placePart({ items: partRecords(r.sym, r.lib.name, Math.min(part, r.sym.parts)), symbol: r.sym, library: r.lib.name });
    (document.querySelector('.viewport') as HTMLElement | null)?.focus();
  };
  return (
    <section class="panel libraries" aria-label="Libraries">
      <div class="lib-buttons">
        <button class="btn" onClick={async () => { const n = await installLibraries(); if (n) libSel.value = n; }}>Libraries...</button>
        <button class="btn" onClick={() => { libSel.value = ALL; (document.getElementById('lib-mask') as HTMLInputElement | null)?.focus(); }}>Search...</button>
        <button class="btn default" disabled={!sel} onClick={() => place()} title={sel ? `Place ${sel.name}` : ''}>Place {sel ? sel.name : ''}</button>
      </div>
      <div class="lib-pick">
        <select value={name} aria-label="Library" onChange={(e) => { libSel.value = (e.target as HTMLSelectElement).value; setRef(''); setPart(1); }}>
          {names.map((n) => <option key={n} value={n}>{n}</option>)}
          {names.length > 1 && <option value={ALL}>{ALL}</option>}
        </select>
      </div>
      <input id="lib-mask" class="lib-mask" type="search" placeholder="*" value={maskSel.value} aria-label="Mask" onInput={(e) => { maskSel.value = (e.target as HTMLInputElement).value; }} onKeyDown={(e) => e.stopPropagation()} />
      <div class="lib-list">
        <Grid
          cols={[
            { label: fpOnly ? 'Footprint Name' : 'Component Name', width: 'minmax(110px, 1fr)', get: (r: Row) => r.name },
            ...(name === ALL ? [{ label: 'Library', width: 'minmax(80px, 0.8fr)', get: (r: Row) => r.lib.name }] : []),
            { label: 'Description', width: 'minmax(100px, 1.3fr)', get: (r: Row) => (r.kind === 'sym' ? r.sym.description : r.kind === 'db' ? r.description : r.fp.description) },
            fpOnly ? { label: 'Pads', width: '48px', align: 'right' as const, get: (r: Row) => (r.kind === 'fp' ? r.fp.prims.filter((p) => p.kind === 'pad').length : '') }
              : { label: 'Footprint', width: 'minmax(70px, 0.7fr)', get: (r: Row) => (r.kind === 'sym' ? symbolFootprint(r.sym.bags) : r.kind === 'db' ? r.footprint : r.name) },
          ]}
          rows={rows} sel={sel ? rows.indexOf(sel) : null}
          onSel={(i) => { const r = rows[i]; if (r) { setRef(keyOf(r)); setPart(1); } }}
          onOpen={(i) => { const r = rows[i]; if (r) { setRef(keyOf(r)); place(r); } }}
          empty={dbNote || (names.length ? 'No components match.' : 'No libraries: add a .SchLib, .PcbLib or .DbLib with Libraries...')} />
      </div>
      {dbSel && dbState !== 'loading' && dbState?.error && (!dbSel.ctx.project || !dbSel.ctx.project.dir) && <div class="lib-buttons"><button class="btn" onClick={() => void chooseDbLibFolder(dbSel.ctx)}>Choose Folder...</button></div>}
      <p class="lib-count muted small">{rows.length} {fpOnly ? 'footprint' : 'component'}{rows.length === 1 ? '' : 's'}</p>
      <div class="lib-preview">{sel && !settings.autoPreviews && peek !== keyOf(sel) ? <button class="btn" onClick={() => setPeek(keyOf(sel))}>Preview</button> : sel?.kind === 'sym' ? <SymbolPreview bags={sel.sym.bags} part={Math.min(part, sel.sym.parts)} />
        : sel?.kind === 'db' ? (dbRec?.symbol ? <SymbolPreview bags={dbRec.symbol.sym.bags} part={Math.min(part, dbRec.symbol.sym.parts)} /> : <p class="muted small">Symbol {dbRec?.m.libRef || '(none named)'} not found</p>)
        : sel ? <FootprintPreview prims={sel.fp.prims} size={180} /> : null}</div>
      {(() => { const parts = sel?.kind === 'sym' ? sel.sym.parts : sel?.kind === 'db' ? dbRec?.symbol?.sym.parts ?? 1 : 1; return parts > 1 && (
        <div class="lib-parts">{Array.from({ length: parts }, (_, i) => <button key={i} class={`btn${part === i + 1 ? ' on' : ''}`} onClick={() => setPart(i + 1)}>Part {partLetter(i + 1)}</button>)}</div>
      ); })()}
      <div class="lib-models">
        <Grid cols={[{ label: 'Model Name', get: (m: { name: string; type: string }) => m.name }, { label: 'Model Type', width: '90px', get: (m) => m.type }]} rows={models} empty="No models." />
      </div>
    </section>
  );
}
