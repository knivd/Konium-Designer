import { useMemo, useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { FootprintPreview } from './FootprintPreview';
import { Footprint3D } from './Footprint3D';
import { availablePcbLibraries, pathPcbLibs } from '../eco';
import { pickFileHandle } from '../../platform/fs';
import { unpackIntLib } from '../../formats/altium/intlib';
import { activeProject } from '../project';
import { notify } from '../state';
import type { Footprint } from '../../formats/altium/pcblib';
import { isModelLibrary } from '../../model/pcbEco';

export interface PcbModelValue {
  name: string;
  description: string;
  /** PCB Library › Use footprint from component library (USECOMPONENTLIBRARY=T). */
  useComponentLibrary: boolean;
  /** PCB Library › Library name or Library path (MODELDATAFILE0: a path when it holds a separator); '' Any. */
  library?: string;
}

type LibMode = 'any' | 'name' | 'path' | 'component';
const isPath = (f: string) => /[\\/]/.test(f);
const modeOf = (v: PcbModelValue): LibMode => (v.useComponentLibrary ? 'component' : !v.library ? 'any' : isPath(v.library) ? 'path' : 'name');

const ALL = '(All Libraries)';

/**
 * A footprint by name in the PCB libraries Konium can see (open, project, installed): the first
 * library wins; with `library` (a name or a path) only the library of that file name.
 */
export function findFootprint(name: string, library?: string): { library: string; footprint: Footprint } | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  for (const lib of availablePcbLibraries()) {
    if (library && !isModelLibrary(lib.name, library)) continue;
    const fp = lib.footprints.find((f) => f.name.toLowerCase() === n);
    if (fp) return { library: lib.name, footprint: fp };
  }
  return null;
}

/**
 * The PCB Model dialog (component Properties › Models › Add / Edit a footprint): Footprint
 * Model name and description, Browse... (the footprints of the libraries in reach), Pin Map...,
 * PCB Library (Any; a Library name or a Library path, kept as MODELDATAFILE0, the search then
 * limited to that library; or the component's integrated library), the Selected Footprint drawn,
 * and where it was found.
 */
export function PcbModelDialog({ value, componentLibrary, integrated, pins, onOk, title = 'PCB Model' }: {
  value: PcbModelValue; componentLibrary: string; integrated: boolean; pins: { designator: string; name: string }[]; onOk: (v: PcbModelValue) => void; title?: string;
}) {
  const [v, setV] = useState<PcbModelValue>(value);
  const [mode, setMode] = useState<LibMode>(() => modeOf(value));
  const [threeD, setThreeD] = useState(false);
  const [libName, setLibName] = useState(() => (modeOf(value) === 'name' ? value.library ?? '' : ''));
  const [libPath, setLibPath] = useState(() => (modeOf(value) === 'path' ? value.library ?? '' : ''));
  const library = mode === 'name' ? libName.trim() : mode === 'path' ? libPath.trim() : '';
  const found = useMemo(() => findFootprint(v.name, library || undefined), [v.name, library]);
  const result = (): PcbModelValue => ({ ...v, name: v.name.trim(), useComponentLibrary: mode === 'component', library });
  const ok = () => { if (!v.name.trim()) return false; closeDialog(); onOk(result()); return false; };
  const browse = () => showDialog(BrowseFootprintsDialog, { current: v.name, library: library || undefined, onOk: (f: { library: string; footprint: Footprint }) => setV({ ...v, name: f.footprint.name, description: f.footprint.description || v.description }) });
  // Choose...: the system's file selector; the library picked is read (so its footprints are found) and its path,
  // from the project's folder when it is inside it (a browser never sees further up), goes in the box
  const choose = async () => {
    let f;
    try { f = await pickFileHandle(['.PcbLib', '.IntLib'], 'PCB libraries', 'konium-pcblib'); } catch (e) { notify(`Couldn't open the library: ${(e as Error).message}`, 'error'); return; }
    if (!f) return;
    let libs = [f];
    if (/\.intlib$/i.test(f.name)) { try { libs = (await unpackIntLib(f.bytes, f.name)).filter((x) => /\.pcblib$/i.test(x.name)); } catch { notify(`${f.name} isn't an integrated library Konium Designer can read`, 'error'); return; } }
    pathPcbLibs.value = [...pathPcbLibs.value.filter((x) => !libs.some((g) => g.name.toLowerCase() === x.name.toLowerCase())), ...libs];
    const dir = activeProject()?.dir;
    const rel = dir && f.handle ? await dir.resolve(f.handle).catch(() => null) : null;
    setLibPath(rel?.length ? rel.join('\\') : f.name);
    setMode('path');
  };
  const where = mode === 'name' || mode === 'path' ? library || '(no library given)' : 'the PCB libraries Konium Designer can see (open, in the project or installed)';
  return (
    <Dialog title={title} width={760} onClose={closeDialog} onAccept={ok} class="pcbmodel"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok} disabled={!v.name.trim()}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <fieldset><legend>Footprint Model</legend>
        <div class="pm-row"><span>Name</span><input type="text" value={v.name} autofocus aria-label="Footprint name" onInput={(e) => setV({ ...v, name: (e.target as HTMLInputElement).value })} />
          <button class="btn" onClick={browse}>Browse...</button>
          <button class="btn" onClick={() => showDialog(PinMapDialog, { pins, footprint: found?.footprint ?? null })}>Pin Map...</button></div>
        <div class="pm-row"><span>Description</span><input type="text" value={v.description} aria-label="Footprint description" onInput={(e) => setV({ ...v, description: (e.target as HTMLInputElement).value })} /></div>
      </fieldset>
      <fieldset><legend>PCB Library</legend>
        <label class="pm-lib wide"><input type="radio" name="pm-lib" checked={mode === 'any'} onChange={() => setMode('any')} /><span>Any</span></label>
        <label class="pm-lib"><input type="radio" name="pm-lib" checked={mode === 'name'} onChange={() => setMode('name')} /><span>Library name</span>
          <input type="text" value={libName} disabled={mode !== 'name'} aria-label="Library name" onInput={(e) => setLibName((e.target as HTMLInputElement).value)} /></label>
        <label class="pm-lib"><input type="radio" name="pm-lib" checked={mode === 'path'} onChange={() => setMode('path')} /><span>Library path</span>
          <input type="text" value={libPath} disabled={mode !== 'path'} aria-label="Library path" placeholder={mode === 'path' ? 'Type a path or choose the file' : ''} onInput={(e) => setLibPath((e.target as HTMLInputElement).value)} />
          <button class="btn" disabled={mode !== 'path'} onClick={(e) => { e.preventDefault(); void choose(); }}>Choose...</button></label>
        <label class="pm-lib wide" title={integrated ? undefined : 'Only for parts from an integrated library'}><input type="radio" name="pm-lib" checked={mode === 'component'} disabled={!integrated && mode !== 'component'}
          onChange={() => setMode('component')} /><span>Use footprint from component library {componentLibrary || '*'}</span></label>
      </fieldset>
      <fieldset class="pm-selected"><legend>Selected Footprint</legend>
        <div class="pm-preview">
          {found ? (threeD ? <Footprint3D footprint={found.footprint} size={300} /> : <FootprintPreview prims={found.footprint.prims} size={300} />) : <span class="muted">{v.name.trim() ? 'Footprint not found' : 'No footprint named'}</span>}
          <button class="btn pm-3d" aria-pressed={threeD} disabled={!found} title="The footprint in 3D (drag to turn it)" onClick={(e) => { e.preventDefault(); setThreeD(!threeD); }}>{threeD ? '2D' : '3D'}</button>
        </div>
        <p class="pm-found">{found ? `Found in: ${found.library}` : v.name.trim() ? `${v.name.trim()} isn't in ${where}` : ''}</p>
      </fieldset>
    </Dialog>
  );
}

/** Browse Libraries for a footprint: the library (or all), a mask, the list, the footprint drawn. */
export function BrowseFootprintsDialog({ current, library, onOk }: { current: string; library?: string; onOk: (f: { library: string; footprint: Footprint }) => void }) {
  const libs = useMemo(() => availablePcbLibraries().filter((l) => !library || isModelLibrary(l.name, library)), [library]);
  const [lib, setLib] = useState(() => libs.find((l) => l.footprints.some((f) => f.name.toLowerCase() === current.trim().toLowerCase()))?.name ?? (libs.length > 1 ? ALL : libs[0]?.name ?? ''));
  const [mask, setMask] = useState('');
  const rows = useMemo(() => {
    const re = (() => { try { return new RegExp(mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i'); } catch { return /.*/; } })();
    return libs.filter((l) => lib === ALL || l.name === lib).flatMap((l) => l.footprints.filter((f) => !mask || re.test(f.name) || re.test(f.description)).map((footprint) => ({ library: l.name, footprint })));
  }, [libs, lib, mask]);
  const [sel, setSel] = useState(() => Math.max(0, rows.findIndex((r) => r.footprint.name.toLowerCase() === current.trim().toLowerCase())));
  const pick = rows[sel] ?? rows[0];
  const ok = () => { if (!pick) return false; closeDialog(); onOk(pick); return false; };
  return (
    <Dialog title="Browse Libraries" width={820} height={560} onClose={closeDialog} onAccept={ok} class="browsefp"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok} disabled={!pick}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      {!libs.length ? <p>No PCB libraries: open one, add it to the project, or install it (Design › Add/Remove Library).</p> : (
        <div class="bf-cols">
          <div class="bf-left">
            <label class="do-row"><span>Libraries</span><select value={lib} onChange={(e) => { setLib((e.target as HTMLSelectElement).value); setSel(0); }}>
              {libs.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}{libs.length > 1 && <option value={ALL}>{ALL}</option>}</select></label>
            <label class="do-row"><span>Mask</span><input type="search" value={mask} placeholder="*" onInput={(e) => { setMask((e.target as HTMLInputElement).value); setSel(0); }} /></label>
            <div class="bf-list">
              <Grid rows={rows} sel={pick ? rows.indexOf(pick) : null} onSel={setSel} onOpen={(i) => { setSel(i); const r = rows[i]; if (r) { closeDialog(); onOk(r); } }} empty="No footprints match."
                cols={[{ label: 'Name', width: 'minmax(140px, 1fr)', get: (r: { library: string; footprint: Footprint }) => r.footprint.name },
                  { label: 'Library', width: 'minmax(100px, 0.8fr)', get: (r) => r.library },
                  { label: 'Description', width: 'minmax(140px, 1.4fr)', get: (r) => r.footprint.description }]} />
            </div>
            <p class="muted small">{rows.length} footprint{rows.length === 1 ? '' : 's'}</p>
          </div>
          <div class="bf-preview">{pick ? <FootprintPreview prims={pick.footprint.prims} size={260} /> : null}</div>
        </div>
      )}
    </Dialog>
  );
}

/**
 * Pin Map: each schematic pin and the footprint pad it lands on. Konium maps them one to one
 * by designator, as the default map does [est: a stored map isn't read yet]; pins without a pad
 * of that name are marked.
 */
export function PinMapDialog({ pins, footprint }: { pins: { designator: string; name: string }[]; footprint: Footprint | null }) {
  const pads = new Set(footprint ? footprint.prims.filter((p) => p.kind === 'pad').map((p) => (p as { name: string }).name) : []);
  const rows = [...pins].sort((a, b) => a.designator.localeCompare(b.designator, undefined, { numeric: true }));
  return (
    <Dialog title="Model Map" width={520} height={480} onClose={closeDialog} class="pinmap"
      footer={<><span class="spacer" /><button class="btn default" onClick={closeDialog}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <Grid rows={rows} empty="The part has no pins."
        cols={[{ label: 'Schematic Pin', width: 'minmax(90px, 0.6fr)', get: (p: { designator: string; name: string }) => p.designator },
          { label: 'Pin Name', width: 'minmax(100px, 1fr)', get: (p) => p.name },
          { label: 'Model Pin Designator', width: 'minmax(110px, 0.8fr)', get: (p) => (footprint && !pads.has(p.designator) ? <span class="pm-missing">{p.designator} (no pad)</span> : p.designator) }]} />
    </Dialog>
  );
}
