import { useMemo, useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog, showDialog } from './index';
import type { FoundFootprint } from '../../model/pcbEco';
import { FootprintPreview } from './FootprintPreview';
import { AvailableLibrariesDialog } from './AvailableLibraries';
import { Footprint3D } from './Footprint3D';
import { PromptDialog } from './Confirm';
import { SchBrowseLibrariesDialog } from './PlacePart';
import { symbolFootprint } from '../../model/schPlace';
import { SR } from '../../model/sch';
import { notify } from '../state';
import type { LibSymbol } from '../../formats/altium/schlib';

let last = { footprint: '', designator: 'Designator1', comment: 'Comment' };

/**
 * Place › Component on a board (P, C): AD17's Place Component dialog — Placement Type: Footprint
 * (by name or through "..." Browse Libraries), or Component (a schematic library's part, its Lib
 * Ref chosen through "...": its current footprint model, its designator and comment as the
 * library has them); the Designator and Comment. OK and the part follows the cursor.
 */
export function PlaceComponentDialog({ footprints, onPlace, initial }: { footprints: FoundFootprint[]; onPlace: (f: FoundFootprint, designator: string, comment: string) => void; initial?: string }) {
  const [name, setName] = useState(() => initial ?? (last.footprint || footprints[0]?.footprint.name || ''));
  const [designator, setDesignator] = useState(last.designator);
  const [comment, setComment] = useState(last.comment);
  const found = footprints.find((f) => f.footprint.name.toLowerCase() === name.trim().toLowerCase());
  const [type, setType] = useState<'footprint' | 'component'>('footprint');
  const [libRef, setLibRef] = useState('');
  // Component: a schematic part's footprint, designator and comment
  const chooseLibRef = () => showDialog(SchBrowseLibrariesDialog, { current: libRef ? { libRef, library: '' } : undefined, onOk: (sym: LibSymbol) => {
    setLibRef(sym.libRef);
    const fp = symbolFootprint(sym.bags);
    if (fp) setName(fp); else notify(`${sym.libRef} has no footprint model`, 'error');
    const text = (rec: number, nm?: string) => sym.bags.find((b) => b.int('RECORD', -1) === rec && (!nm || (b.get('NAME') ?? '').toLowerCase() === nm))?.get('TEXT');
    const des = text(SR.DESIGNATOR);
    if (des) setDesignator(des);
    setComment(text(SR.PARAMETER, 'comment') && !text(SR.PARAMETER, 'comment')!.startsWith('=') ? text(SR.PARAMETER, 'comment')! : sym.libRef);
  } });
  const ok = () => {
    if (!found || !designator.trim()) return;
    last = { footprint: found.footprint.name, designator: designator.trim(), comment };
    closeDialog();
    onPlace(found, designator.trim(), comment);
  };
  const browse = () => showDialog(BrowseLibrariesDialog, { footprints, current: found?.footprint.name ?? name, onOk: (f: FoundFootprint) => setName(f.footprint.name) });
  const keys = (e: KeyboardEvent) => e.stopPropagation();
  return (
    <Dialog title="Place Component" width={500} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="placecomp"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok} disabled={!found || !designator.trim()}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <fieldset class="pc-type"><legend>Placement Type</legend>
        <label><input type="radio" name="pc-type" checked={type === 'footprint'} onChange={() => setType('footprint')} /> Footprint</label>
        <label title="A schematic library's part: its footprint, designator and comment"><input type="radio" name="pc-type" checked={type === 'component'} onChange={() => setType('component')} /> Component</label>
      </fieldset>
      <fieldset class="pc-details"><legend>Component Details</legend>
        <label class={`pc-row${type === 'component' ? '' : ' muted'}`}><span>Lib Ref</span><input type="text" readOnly={type !== 'component'} value={libRef} aria-label="Lib Ref" onKeyDown={keys}
          onInput={(e) => setLibRef((e.target as HTMLInputElement).value)} /><button class="btn pc-more" disabled={type !== 'component'} aria-label="Choose Lib Ref" onClick={chooseLibRef}>...</button></label>
        <label class="pc-row"><span><u>F</u>ootprint</span>
          <input type="text" id="pc-footprint" autoFocus value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={keys} aria-invalid={!found} />
          <button class="btn pc-more" onClick={browse} aria-label="Browse Libraries" title="Browse Libraries">...</button>
        </label>
        <label class="pc-row"><span><u>D</u>esignator</span><input type="text" value={designator} onInput={(e) => setDesignator((e.target as HTMLInputElement).value)} onKeyDown={keys} /><span /></label>
        <label class="pc-row"><span><u>C</u>omment</span><input type="text" value={comment} onInput={(e) => setComment((e.target as HTMLInputElement).value)} onKeyDown={keys} /><span /></label>
        {!footprints.length ? <p class="error-text small">No footprints: the project has no PCB library (.PcbLib) Konium Designer can read, and none is installed.</p>
          : !found && name.trim() ? <p class="error-text small">No footprint "{name.trim()}" in the available libraries: "..." lists them.</p> : null}
      </fieldset>
    </Dialog>
  );
}

const glob = (mask: string) => { try { return new RegExp(`^${mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}`, 'i'); } catch { return /.*/; } };

/**
 * "..." beside Footprint: AD17's Browse Libraries — the libraries to look in (all of them, or
 * one), a mask, the footprints with their library and description, the one chosen drawn large.
 */
export function BrowseLibrariesDialog({ footprints, current, onOk }: { footprints: FoundFootprint[]; current: string; onOk: (f: FoundFootprint) => void }) {
  const libs = [...new Set(footprints.map((f) => f.library))];
  const [lib, setLib] = useState(() => footprints.find((f) => f.footprint.name === current)?.library ?? libs[0] ?? '');
  const [mask, setMask] = useState('');
  // Find...: footprints whose name or description has the words asked, in every library
  const [query, setQuery] = useState<string | null>(null);
  const list = useMemo(() => {
    if (query !== null) { const q = query.toLowerCase(); return footprints.filter((f) => f.footprint.name.toLowerCase().includes(q) || f.footprint.description.toLowerCase().includes(q)); }
    const re = glob(mask.includes('*') || mask.includes('?') ? mask : `${mask}*`);
    return footprints.filter((f) => (!lib || f.library === lib) && (!mask || re.test(f.footprint.name)));
  }, [footprints, lib, mask, query]);
  const find = () => showDialog(PromptDialog, { title: 'Libraries Search', fields: [{ label: 'Name or description contains', value: query ?? mask }],
    onOk: ([v]: string[]) => { const t = (v ?? '').trim(); setQuery(t || null); setSel(0); } });
  const [sel, setSel] = useState(() => Math.max(0, list.findIndex((f) => f.footprint.name === current)));
  const [threeD, setThreeD] = useState(false);
  const chosen = list[Math.min(sel, list.length - 1)];
  const ok = () => { if (!chosen) return; closeDialog(); onOk(chosen); };
  return (
    <Dialog title="Browse Libraries" width={1100} height={680} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="browselib"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok} disabled={!chosen}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="bl-top">
        <label class="bl-libs"><span>Libraries</span>
          <select value={lib} onChange={(e) => { setLib((e.target as HTMLSelectElement).value); setSel(0); }}>
            {libs.map((l) => <option key={l} value={l}>{l}</option>)}
            {libs.length > 1 && <option value="">All libraries</option>}
          </select>
        </label>
        <button class="btn bl-more" onClick={() => showDialog(AvailableLibrariesDialog, {})} title="Available Libraries">...</button>
        <button class="btn" title="Search every library by name or description" onClick={find}>Find...</button>
        {query !== null && <button class="btn" onClick={() => { setQuery(null); setSel(0); }} title="Back to the library chosen">Clear Search</button>}
      </div>
      <div class="bl-main">
        <div class="bl-left">
          <label class="bl-mask"><span><u>M</u>ask</span><input type="search" value={mask} onInput={(e) => { setMask((e.target as HTMLInputElement).value); setSel(0); }} onKeyDown={(e) => e.stopPropagation()} /></label>
          <Grid cols={[{ label: 'Name', width: 'minmax(110px, 1.2fr)', get: (f: FoundFootprint) => f.footprint.name }, { label: 'Library', width: 'minmax(100px, 1fr)', get: (f) => f.library },
            { label: 'Description', width: 'minmax(120px, 1.4fr)', get: (f) => f.footprint.description }]}
            rows={list} sel={chosen ? list.indexOf(chosen) : null} onSel={setSel} onOpen={(i) => { const f = list[i]; if (f) { closeDialog(); onOk(f); } }} empty="No footprints match." />
          <p class="muted small">{list.length} items</p>
        </div>
        <div class="bl-preview">
          {chosen && (threeD ? <Footprint3D footprint={chosen.footprint} size={560} /> : <FootprintPreview prims={chosen.footprint.prims} size={560} />)}
          <button class="btn bl-3d" aria-pressed={threeD} disabled={!chosen} title="The footprint in 3D (drag to turn it)" onClick={() => setThreeD(!threeD)}>{threeD ? '2D' : '3D'}</button>
        </div>
      </div>
    </Dialog>
  );
}
