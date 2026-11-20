import { useMemo, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { Dialog, Grid } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { PromptDialog } from './Confirm';
import { openMenuAt } from '../MenuBar';
import { readLocal, writeLocal } from '../../core/storage';
import { AvailableLibrariesDialog } from './AvailableLibraries';
import { FootprintPreview } from './FootprintPreview';
import { projectFootprints } from '../eco';
import { readSchLib, type LibSymbol, type SchLibrary } from '../../formats/altium/schlib';
import { currentSymbols } from '../../model/schLib';
import { partLetter, deriveObject, DIR_VECTORS, SR, type SchObject } from '../../model/sch';
import { partRecords, symbolFootprint } from '../../model/schPlace';
import { activeProject } from '../project';
import { settings } from '../../core/settings';
import { docs, notify } from '../state';
import { openFiles, type PickedFile } from '../../platform/fs';
import { unpackIntLib } from '../../formats/altium/intlib';
import type { PropertyBag } from '../../formats/altium/props';
import { installedDbLibs } from '../dbLib';
import { readDbLib } from '../../formats/altium/dblib';

/**
 * Place › Part (P, P): pick a symbol from the project's schematic libraries (or libraries added
 * for this session, Altium's Available Libraries), see it, set designator and comment, OK places
 * it. Multi-part packages place part by part (U?A, U?B …).
 */

/** Schematic libraries installed (Libraries… › Install): kept between sessions. */
export const installedLibs = signal<PickedFile[]>([]);
/** PCB libraries installed (directly, or from integrated libraries): their footprints place and update like the project's. */
export const installedPcbLibs = signal<PickedFile[]>([]);
/** The installed lists as one (the Installed tab, Preferences › Installed Libraries); a database library's size counts the files kept with it. */
export interface InstalledRow { kind: 'sch' | 'pcb' | 'db'; file: PickedFile; size: number }
export const installedRows = (): InstalledRow[] => [
  ...installedLibs.value.map((file) => ({ kind: 'sch' as const, file, size: file.bytes.length })), ...installedPcbLibs.value.map((file) => ({ kind: 'pcb' as const, file, size: file.bytes.length })),
  ...installedDbLibs.value.map((d) => ({ kind: 'db' as const, file: d as PickedFile, size: d.bytes.length + [...d.folder.files.values()].reduce((n, f) => n + f.bytes.length, 0) }))];
export const installedKind = (k: InstalledRow['kind']) => (k === 'sch' ? 'Schematic Library' : k === 'pcb' ? 'PCB Library' : 'Database Library');
const listOf = (k: 'sch' | 'pcb') => (k === 'sch' ? installedLibs : installedPcbLibs);
export function removeInstalled(r: InstalledRow): void {
  if (r.kind === 'db') { installedDbLibs.value = installedDbLibs.value.filter((d) => d !== (r.file as unknown)); return; }
  const l = listOf(r.kind); l.value = l.value.filter((f) => f !== r.file);
}
/** Move Up / Down: within its own kind (the order Place › Part and the Libraries panel list them in). */
export function moveInstalled(r: InstalledRow, d: -1 | 1): boolean {
  if (r.kind === 'db') {
    const l = installedDbLibs.value, i = l.indexOf(r.file as never), j = i + d;
    if (i < 0 || j < 0 || j >= l.length) return false;
    const n = [...l]; [n[i], n[j]] = [n[j]!, n[i]!]; installedDbLibs.value = n;
    return true;
  }
  const l = listOf(r.kind), i = l.value.indexOf(r.file), j = i + d;
  if (i < 0 || j < 0 || j >= l.value.length) return false;
  const n = [...l.value]; [n[i], n[j]] = [n[j]!, n[i]!]; l.value = n;
  return true;
}
const cache = new WeakMap<Uint8Array, SchLibrary | Error>();
function parse(f: PickedFile): SchLibrary | Error {
  let v = cache.get(f.bytes);
  if (!v) { try { v = readSchLib(f.bytes, f.name); } catch (e) { v = e as Error; } cache.set(f.bytes, v); }
  return v;
}

/** Every schematic library in reach: the active project's, open ones, then installed ones. */
export function availableLibraries(): SchLibrary[] {
  const files: PickedFile[] = [];
  const seen = new Set<string>();
  const add = (f: PickedFile) => { const k = f.name.toLowerCase(); if (!seen.has(k)) { seen.add(k); files.push(f); } };
  // Libraries open for editing: as they are now, unsaved changes included
  // Data Management › File-based Libraries: open ones, the project's and Installed Libraries; or the project's; or Installed Libraries only
  const where = settings.libSearch;
  const open: SchLibrary[] = [];
  if (where !== 'installed') for (const d of docs.value) if (d.doc.kind === 'SchLib') { seen.add(d.name.toLowerCase()); open.push({ name: d.name, header: d.doc.header, symbols: currentSymbols(d.doc) }); }
  const p = activeProject();
  if (p && where !== 'installed') for (const f of p.files.values()) if (/\.schlib$/i.test(f.name)) add(f);
  if (where !== 'installed') for (const d of docs.value) if (/\.schlib$/i.test(d.name)) add({ name: d.name, bytes: d.bytes });
  if (where !== 'project') for (const f of installedLibs.value) add(f);
  return [...open, ...files.map(parse).filter((x): x is SchLibrary => !(x instanceof Error))];
}

/** Libraries...: add .SchLib files for this session (Altium's Available Libraries › Install). Returns the first added. */
export async function installLibraries(): Promise<string | null> {
  // System › General › Library Path: start in the project's folder, or where it was last
  const dir = settings.libraryPath === 'project' ? activeProject()?.dir : undefined;
  const picked = await openFiles(dir ? { startIn: dir } : { id: 'libraries' });
  // Database libraries: kept with their folder's database and libraries once it is chosen (Libraries panel › Choose Folder)
  const dbs = picked.filter((f) => /\.(svn)?dblib$/i.test(f.name));
  if (dbs.length) {
    installedDbLibs.value = [...installedDbLibs.value.filter((x) => !dbs.some((g) => g.name.toLowerCase() === x.name.toLowerCase())),
      ...dbs.map((f) => ({ name: f.name, bytes: f.bytes, folder: { files: new Map<string, PickedFile>(), at: f.name.toLowerCase() } }))];
    notify(`${dbs.map((f) => f.name).join(', ')} installed: choose ${dbs.length === 1 ? 'its' : 'each one\'s'} folder (Libraries panel › Choose Folder...) so its database and libraries can be read`);
  }
  // PCB libraries: their footprints place and update like the project's
  const pcbPicked = picked.filter((f) => /\.pcblib$/i.test(f.name));
  if (pcbPicked.length) installedPcbLibs.value = [...installedPcbLibs.value.filter((x) => !pcbPicked.some((g) => g.name === x.name)), ...pcbPicked];
  // Integrated libraries: their schematic and PCB libraries, unpacked
  const got: PickedFile[] = picked.filter((f) => /\.schlib$/i.test(f.name));
  for (const f of picked.filter((x) => /\.intlib$/i.test(x.name))) {
    try {
      const libs = await unpackIntLib(f.bytes, f.name);
      got.push(...libs.filter((l) => /\.schlib$/i.test(l.name)));
      const pcb = libs.filter((l) => /\.pcblib$/i.test(l.name));
      if (pcb.length) installedPcbLibs.value = [...installedPcbLibs.value.filter((x) => !pcb.some((g) => g.name === x.name)), ...pcb];
      if (!libs.length) notify(`${f.name}: no libraries found inside`, 'error');
    } catch (e) { notify(`${f.name}: ${(e as Error).message}`, 'error'); }
  }
  if (!got.length) {
    if (pcbPicked[0]) return pcbPicked[0].name;
    // A database library: its first table, as the Libraries panel lists it
    const t = dbs[0] ? (() => { try { return readDbLib(dbs[0].bytes, dbs[0].name).tables.find((x) => x.enabled); } catch { return undefined; } })() : undefined;
    return dbs[0] && t ? `${dbs[0].name}/${t.name}` : null;
  }
  const bad = got.filter((f) => parse(f) instanceof Error);
  if (bad.length) notify(`${bad.map((f) => f.name).join(', ')}: not a schematic library Konium Designer can read`, 'error');
  installedLibs.value = [...installedLibs.value.filter((f) => !got.some((g) => g.name === f.name)), ...got.filter((f) => !bad.includes(f))];
  return got.find((f) => !bad.includes(f))?.name ?? null;
}

export interface PartChoice { items: { bag: PropertyBag; owner: number }[]; symbol: LibSymbol; library: string }

/** Parts placed lately (Place Part's history), most recent first; kept in this browser. */
const HISTORY_KEY = 'placePart.history';
function history(): { libRef: string; library: string }[] {
  try { return (JSON.parse(readLocal(HISTORY_KEY) ?? '[]') as { libRef: string; library: string }[]).slice(0, 20); } catch { return []; }
}
function remember(libRef: string, library: string): void {
  writeLocal(HISTORY_KEY, JSON.stringify([{ libRef, library }, ...history().filter((h) => !(h.libRef === libRef && h.library === library))].slice(0, 20)));
}

/** A symbol by its name: the library it was last taken from first, then every library in reach. */
function findSymbol(libs: SchLibrary[], libRef: string, prefer?: string): { sym: LibSymbol; lib: SchLibrary } | null {
  const want = libRef.trim().toLowerCase();
  if (!want) return null;
  for (const lib of [...libs.filter((l) => l.name === prefer), ...libs.filter((l) => l.name !== prefer)]) {
    const sym = lib.symbols.find((x) => x.libRef.toLowerCase() === want);
    if (sym) return { sym, lib };
  }
  return null;
}
const footprintModels = (bags: PropertyBag[]) => bags.filter((b) => b.int('RECORD', -1) === SR.IMPLEMENTATION && (b.get('MODELTYPE') ?? '').toUpperCase() === 'PCBLIB').map((b) => b.get('MODELNAME') ?? '').filter(Boolean);
const designatorOf = (sym: LibSymbol) => sym.bags.find((b) => b.int('RECORD') === SR.DESIGNATOR)?.get('TEXT') ?? 'U?';
const commentOf = (sym: LibSymbol) => sym.bags.find((b) => b.int('RECORD') === SR.PARAMETER && b.get('NAME')?.toLowerCase() === 'comment')?.get('TEXT') ?? sym.libRef;

/**
 * Place › Part (P, P): AD17's Place Part — the Physical Component by name (or from History, or
 * Choose… for Browse Libraries), its Logical Symbol, Designator, Comment, Footprint, Part ID and
 * Library; OK and the part follows the cursor. `choose`: Browse Libraries alone (a part's Choose…).
 */
export function PlacePartDialog({ onPlace, choose = false }: { onPlace: (c: PartChoice) => void; choose?: boolean }) {
  if (choose) return <SchBrowseLibrariesDialog onOk={(sym, lib) => onPlace({ items: partRecords(sym, lib.name, 1), symbol: sym, library: lib.name })} />;
  return <PlacePartSmall onPlace={onPlace} />;
}

function PlacePartSmall({ onPlace }: { onPlace: (c: PartChoice) => void }) {
  const [libs, setLibs] = useState(availableLibraries);
  const h0 = history()[0];
  const [name, setName] = useState(() => h0?.libRef ?? libs[0]?.symbols[0]?.libRef ?? '');
  const [prefer, setPrefer] = useState<string | undefined>(h0?.library);
  const found = findSymbol(libs, name, prefer);
  const sym = found?.sym;
  const [designator, setDesignator] = useState<string | null>(null);
  const [comment, setComment] = useState<string | null>(null);
  const [footprint, setFootprint] = useState<string | null>(null);
  const [part, setPart] = useState(1);
  const pick = (libRef: string, library?: string) => { setName(libRef); setPrefer(library); setDesignator(null); setComment(null); setFootprint(null); setPart(1); };
  const fps = sym ? footprintModels(sym.bags) : [];
  const fp = footprint ?? (sym ? symbolFootprint(sym.bags) : '');
  const ok = () => {
    if (!found) return;
    const { sym: s, lib } = found;
    const items = partRecords(s, lib.name, part);
    const d = items.find((it) => it.bag.int('RECORD') === SR.DESIGNATOR);
    if (d) d.bag.set('TEXT', designator ?? designatorOf(s));
    const c = items.find((it) => it.bag.int('RECORD') === SR.PARAMETER && it.bag.get('NAME')?.toLowerCase() === 'comment');
    if (c && comment !== null) c.bag.set('TEXT', comment);
    // The footprint chosen becomes the current one
    if (footprint !== null) for (const it of items) if (it.bag.int('RECORD', -1) === SR.IMPLEMENTATION && (it.bag.get('MODELTYPE') ?? '').toUpperCase() === 'PCBLIB') it.bag.set('ISCURRENT', it.bag.get('MODELNAME') === footprint ? 'T' : 'F');
    remember(s.libRef, lib.name);
    closeDialog();
    onPlace({ items, symbol: s, library: lib.name });
  };
  const historyMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const h = history();
    openMenuAt({ key: '', label: '', children: h.length ? h.map((x) => ({ key: '', label: `${x.libRef}   (${x.library})`, action: () => pick(x.libRef, x.library) })) : [{ key: '', label: 'No parts placed yet', disabled: true }] }, r.left, r.bottom + 1);
  };
  const browse = () => showDialog(SchBrowseLibrariesDialog, { current: found ? { libRef: found.sym.libRef, library: found.lib.name } : undefined,
    onOk: (s: LibSymbol, lib: SchLibrary) => { setLibs(availableLibraries()); pick(s.libRef, lib.name); } });
  const keys = (e: KeyboardEvent) => e.stopPropagation();
  return (
    <Dialog title="Place Part" width={560} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="placepart2"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok} disabled={!found}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <fieldset class="pp-details"><legend>Part Details</legend>
        <label class="pp-row"><span>Physical Component</span>
          <span class="pp-combo"><input type="text" id="pp-physical" autoFocus value={name} onInput={(e) => pick((e.target as HTMLInputElement).value)} onKeyDown={keys} aria-invalid={!found} />
            <button class="pp-drop" aria-label="Recent parts" onClick={historyMenu}>▾</button></span>
          <span class="pp-buttons"><button class="btn" onClick={historyMenu}><u>H</u>istory</button><button class="btn" id="pp-choose" onClick={browse}>Choose</button></span>
        </label>
        <label class="pp-row muted"><span>Logical Symbol</span><input type="text" disabled value={sym?.libRef ?? ''} aria-label="Logical Symbol" /></label>
        <label class="pp-row"><span><u>D</u>esignator</span><input type="text" value={designator ?? (sym ? designatorOf(sym) : '')} disabled={!sym} onInput={(e) => setDesignator((e.target as HTMLInputElement).value)} onKeyDown={keys} /></label>
        <label class="pp-row"><span><u>C</u>omment</span><input type="text" value={comment ?? (sym ? commentOf(sym) : '')} disabled={!sym} onInput={(e) => setComment((e.target as HTMLInputElement).value)} onKeyDown={keys} /></label>
        <label class="pp-row"><span><u>F</u>ootprint</span>
          <select aria-label="Footprint" value={fp} disabled={!fps.length} onChange={(e) => setFootprint((e.target as HTMLSelectElement).value)}>
            {fps.length ? fps.map((f) => <option key={f} value={f}>{f}</option>) : <option value="">None Available</option>}
          </select></label>
        <label class="pp-row"><span><u>P</u>art ID</span>
          <select aria-label="Part ID" value={String(part)} disabled={!sym || sym.parts < 2} onChange={(e) => setPart(Number((e.target as HTMLSelectElement).value))}>
            {Array.from({ length: Math.max(1, sym?.parts ?? 1) }, (_, i) => <option key={i} value={String(i + 1)}>{(sym?.parts ?? 1) > 1 ? partLetter(i + 1) : String(i + 1)}</option>)}
          </select></label>
        <label class="pp-row muted"><span>Library</span><input type="text" disabled value={found?.lib.name ?? ''} aria-label="Library" /></label>
        <label class="pp-row muted"><span>Database Table</span><input type="text" disabled value="" aria-label="Database Table" /></label>
        {!libs.length ? <p class="error-text small">No schematic libraries: add a .SchLib to the project, open one, or install one with Choose › "...".</p>
          : !found && name.trim() ? <p class="error-text small">No part "{name.trim()}" in the available libraries: Choose lists them.</p> : null}
      </fieldset>
    </Dialog>
  );
}

const MODEL_TYPES: Record<string, string> = { PCBLIB: 'Footprint', SIM: 'Simulation', SI: 'Signal Integrity', PCB3DLIB: 'PCB3D' };

/**
 * Choose (and a part's Choose…): AD17's Browse Libraries for symbols — the libraries to look in, a
 * mask, Component Name / Description / Library, the models of the one chosen, it drawn large and
 * its footprint below when a PCB library in reach has it.
 */
export function SchBrowseLibrariesDialog({ current, onOk }: { current?: { libRef: string; library: string }; onOk: (sym: LibSymbol, lib: SchLibrary) => void }) {
  const [rev, setRev] = useState(0);
  const libs = useMemo(availableLibraries, [rev, installedLibs.value]);
  const [libName, setLibName] = useState(() => (libs.some((l) => l.name === current?.library) ? current!.library : libs[0]?.name ?? ''));
  const lib = libs.find((l) => l.name === libName);
  const [mask, setMask] = useState('');
  const list = useMemo(() => {
    const re = (() => { try { return new RegExp(`^${mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}`, 'i'); } catch { return /.*/; } })();
    const m = mask.includes('*') || mask.includes('?') ? re : null;
    return (lib?.symbols ?? []).filter((s) => !mask || (m ? m.test(s.libRef) : s.libRef.toLowerCase().startsWith(mask.toLowerCase())));
  }, [lib, mask]);
  // Find...: the components whose name or description has the words asked, in every library
  const [query, setQuery] = useState<string | null>(null);
  const rows = useMemo(() => {
    if (query === null) return list.map((s) => ({ s, lib: lib! }));
    const q = query.toLowerCase();
    return libs.flatMap((l) => l.symbols.filter((s) => s.libRef.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q)).map((s) => ({ s, lib: l })));
  }, [list, lib, libs, query]);
  const [ref, setRef] = useState(() => current?.libRef ?? '');
  const row = rows.find((r) => r.s.libRef === ref && (query === null || r.lib.name === libName)) ?? rows[0];
  const sym = row?.s;
  const find = () => showDialog(PromptDialog, { title: 'Libraries Search', fields: [{ label: 'Name or description contains', value: query ?? mask }],
    onOk: ([v]: string[]) => { const t = (v ?? '').trim(); setQuery(t || null); setRef(''); } });
  const models = sym ? sym.bags.filter((b) => b.int('RECORD', -1) === SR.IMPLEMENTATION) : [];
  const fpName = sym ? symbolFootprint(sym.bags) : '';
  const fp = fpName ? projectFootprints(activeProject()).find((f) => f.footprint.name.toLowerCase() === fpName.toLowerCase()) : undefined;
  const ok = () => { if (!row) return; closeDialog(); onOk(row.s, row.lib); };
  return (
    <Dialog title="Browse Libraries" width={1180} height={760} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="browselib schbrowse"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok} disabled={!sym}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="bl-top">
        <label class="bl-libs"><span><u>L</u>ibraries</span>
          <select value={libName} onChange={(e) => { setLibName((e.target as HTMLSelectElement).value); setRef(''); }}>
            {libs.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
          </select>
        </label>
        <button class="btn bl-more" title="Available Libraries" onClick={() => { showDialog(AvailableLibrariesDialog, {}); setRev((n) => n + 1); }}>...</button>
        <button class="btn" title="Search every library by name or description" onClick={find}>Find...</button>
        {query !== null && <button class="btn" onClick={() => { setQuery(null); setRef(''); }} title="Back to the library chosen">Clear Search</button>}
      </div>
      <div class="bl-main">
        <div class="bl-left">
          {query === null ? <label class="bl-mask"><span><u>M</u>ask</span><input type="search" value={mask} onInput={(e) => { setMask((e.target as HTMLInputElement).value); setRef(''); }} onKeyDown={(e) => e.stopPropagation()} /></label>
            : <p class="small">Search results for "{query}" in {libs.length} librar{libs.length === 1 ? 'y' : 'ies'}</p>}
          <Grid cols={[{ label: 'Component Name', width: 'minmax(110px, 1fr)', get: (r: { s: LibSymbol; lib: SchLibrary }) => r.s.libRef }, { label: 'Description', width: 'minmax(120px, 1.3fr)', get: (r) => r.s.description },
            { label: 'Library', width: 'minmax(80px, 0.8fr)', get: (r) => r.lib.name }]}
            rows={rows} sel={row ? rows.indexOf(row) : null} onSel={(i) => { const r = rows[i]; if (r) { setRef(r.s.libRef); if (query !== null) setLibName(r.lib.name); } }}
            onOpen={(i) => { const r = rows[i]; if (r) { closeDialog(); onOk(r.s, r.lib); } }} empty={libs.length ? 'No components match.' : 'No schematic libraries: "..." installs one.'} />
          <p class="small">{rows.length} components</p>
          <Grid cols={[{ label: 'Model Name', width: '1fr', get: (b: PropertyBag) => b.get('MODELNAME') ?? '' }, { label: 'Type', width: '1fr', get: (b) => MODEL_TYPES[(b.get('MODELTYPE') ?? '').toUpperCase()] ?? b.get('MODELTYPE') ?? '' }]}
            rows={models} sel={null} onSel={() => undefined} empty="" />
        </div>
        <div class="sbl-right">
          <div class="sbl-symbol">{sym ? <SymbolPreview bags={sym.bags} part={1} /> : null}</div>
          <div class="sbl-model">{fp ? <FootprintPreview prims={fp.footprint.prims} size={230} /> : <span>No Preview Available</span>}</div>
        </div>
      </div>
    </Dialog>
  );
}

const hex = (bgr: number) => `#${(bgr & 0xffffff).toString(16).padStart(6, '0')}`;

/** The symbol drawn as SVG (one part, normal display mode): body graphics, pins and their numbers. */
export function SymbolPreview({ bags, part }: { bags: PropertyBag[]; part: number }) {
  const objs = bags.map((b, i) => deriveObject(b, i)).filter((o, i) => i > 0 && (o.ownerPartId <= 0 || o.ownerPartId === part) && o.ownerDisplayMode === 0);
  const pts: [number, number][] = [];
  const grow = (x: number, y: number) => pts.push([x, y]);
  const els: preact.JSX.Element[] = [];
  const S = 1 / 10_000; // mil
  // Altium's Transparent fill darkens what is beneath rather than covering it
  const darken = (o: { solid: boolean; transparent: boolean }) => (o.solid && o.transparent ? 'mix-blend-mode:darken' : undefined);
  objs.forEach((o: SchObject, i) => {
    switch (o.kind) {
      case 'rect': grow(o.a.x, o.a.y); grow(o.b.x, o.b.y);
        els.push(<rect key={i} x={Math.min(o.a.x, o.b.x) * S} y={-Math.max(o.a.y, o.b.y) * S} width={Math.abs(o.b.x - o.a.x) * S} height={Math.abs(o.b.y - o.a.y) * S} rx={o.r * S}
          fill={o.solid ? hex(o.fill) : 'none'} stroke={hex(o.color)} stroke-width={6} style={darken(o)} />); break;
      case 'polyline': case 'wire': case 'bezier':
        o.pts.forEach((p) => grow(p.x, p.y));
        els.push(<polyline key={i} points={o.pts.map((p) => `${p.x * S},${-p.y * S}`).join(' ')} fill="none" stroke={hex(o.color)} stroke-width={Math.max(6, o.width * S)} />); break;
      case 'polygon':
        o.pts.forEach((p) => grow(p.x, p.y));
        els.push(<polygon key={i} points={o.pts.map((p) => `${p.x * S},${-p.y * S}`).join(' ')} fill={o.solid ? hex(o.fill) : 'none'} stroke={hex(o.color)} stroke-width={6} style={darken(o)} />); break;
      case 'ellipse': grow(o.c.x - o.rx, o.c.y - o.ry); grow(o.c.x + o.rx, o.c.y + o.ry);
        els.push(<ellipse key={i} cx={o.c.x * S} cy={-o.c.y * S} rx={o.rx * S} ry={o.ry * S} fill={o.solid ? hex(o.fill) : 'none'} stroke={hex(o.color)} stroke-width={6} style={darken(o)} />); break;
      case 'arc': {
        grow(o.c.x - o.rx, o.c.y - o.ry); grow(o.c.x + o.rx, o.c.y + o.ry);
        const a0 = (o.start * Math.PI) / 180, a1 = (o.end * Math.PI) / 180, sweep = ((o.end - o.start) % 360 + 360) % 360 || 360;
        if (sweep >= 359.9) els.push(<ellipse key={i} cx={o.c.x * S} cy={-o.c.y * S} rx={o.rx * S} ry={o.ry * S} fill="none" stroke={hex(o.color)} stroke-width={6} />);
        else {
          const p0 = [(o.c.x + o.rx * Math.cos(a0)) * S, -(o.c.y + o.ry * Math.sin(a0)) * S], p1 = [(o.c.x + o.rx * Math.cos(a1)) * S, -(o.c.y + o.ry * Math.sin(a1)) * S];
          els.push(<path key={i} d={`M${p0[0]},${p0[1]} A${o.rx * S},${o.ry * S} 0 ${sweep > 180 ? 1 : 0} 0 ${p1[0]},${p1[1]}`} fill="none" stroke={hex(o.color)} stroke-width={6} />);
        }
        break;
      }
      case 'pin': {
        const d = DIR_VECTORS[o.orient & 3]!;
        const end = { x: o.at.x + d.x * o.length, y: o.at.y + d.y * o.length };
        grow(o.at.x, o.at.y); grow(end.x, end.y);
        els.push(<line key={i} x1={o.at.x * S} y1={-o.at.y * S} x2={end.x * S} y2={-end.y * S} stroke="#22252a" stroke-width={6} />);
        const mid = { x: (o.at.x + end.x) / 2, y: (o.at.y + end.y) / 2 };
        if (o.showDesignator) {
          // Beside the pin, turned with it when it goes up or down
          if (d.x === 0) els.push(<text key={`d${i}`} x={mid.x * S - 8} y={-mid.y * S} transform={`rotate(-90 ${mid.x * S - 8} ${-mid.y * S})`} font-size={50} text-anchor="middle" fill="#1d3557">{o.designator}</text>);
          else els.push(<text key={`d${i}`} x={mid.x * S} y={-mid.y * S - 8} font-size={50} text-anchor="middle" fill="#1d3557">{o.designator}</text>);
        }
        if (o.showName && o.name) {
          // An overbar (a backslash after each letter) drawn as one; a pin going up or down has its name turned, as AD draws it
          const bar = o.name.includes('\\'), name = o.name.replace(/\\/g, '');
          const deco = bar ? 'overline' : undefined;
          if (d.x === 0) {
            const nx = o.at.x * S + 16, ny = -(o.at.y - d.y * 60_000) * S;
            els.push(<text key={`n${i}`} x={nx} y={ny} transform={`rotate(-90 ${nx} ${ny})`} font-size={50} text-anchor={d.y > 0 ? 'end' : 'start'} text-decoration={deco} fill="#22252a">{name}</text>);
          } else {
            const nx = (o.at.x - d.x * 60_000) * S, ny = -(o.at.y - d.y * 60_000) * S + 16;
            els.push(<text key={`n${i}`} x={nx} y={ny} font-size={50} text-anchor={d.x > 0 ? 'end' : 'start'} text-decoration={deco} fill="#22252a">{name}</text>);
          }
        }
        break;
      }
      default: break;
    }
  });
  if (!pts.length) return <p class="muted small">No graphics for this part.</p>;
  const xs = pts.map((p) => p[0] * S), ys = pts.map((p) => -p[1] * S);
  const pad = 80;
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad, w = Math.max(...xs) - Math.min(...xs) + 2 * pad, h = Math.max(...ys) - Math.min(...ys) + 2 * pad;
  return <svg class="symbol-preview" style="isolation:isolate" viewBox={`${x0} ${y0} ${w} ${h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Symbol preview">{els}</svg>;
}
