/**
 * Tools › Parts (R21, the parts library's first step): the shelf of parts kept in this browser,
 * each one an exact part number with its symbol, footprint and what it was read from.
 *
 * The field at the top searches the shelf as it is typed in (Enter opens the first match). A
 * number that isn't on the shelf is offered to the Component Builder, which finds its datasheet
 * from the number and keeps the part from there. A part is placed in the schematic in front, goes
 * out as an integrated library or as a part file, and comes in as a part file. Everything stays
 * on this computer: sharing through the world library is the next step, and the panel says so.
 *
 * Made in the manner of the enclosure view's side panel: a head with its tools as icons, rows
 * with their state at the end, facts in one aligned column, checks with their marks.
 */
import { useMemo, useRef, useState } from 'preact/hooks';
import { active, notify } from '../state';
import { Icon } from '../icons';
import { showDialog } from '../dialogs';
import { AiBuilderDialog } from '../dialogs/AiBuilder';
import { SchEditor } from '../../editors/sch/SchEditor';
import { placePart } from '../placeCommands';
import { partRecords } from '../../model/schPlace';
import { readSchLib } from '../../formats/altium/schlib';
import { installedLibs } from '../dialogs/PlacePart';
import { saveFileAs } from '../../platform/fs';
import { APP_VERSION } from '../../platform/distribution';
import { PART_EXT, SHELF_SCH, partChecks, partFile, partIntLib, partKey, partName, readPartFile, type PartCheck, type PartPackage } from '../../model/partPackage';
import { EXAMPLE_PART, examplePart } from '../../model/partExample';
import { keepPart, removePart, shelf, shelfPart } from '../partShelf';
import { webLink } from '../../core/webLink';

const FROM: Record<PartPackage['record']['package']['from'], string> = { datasheet: 'the datasheet\'s land pattern', ipc: 'pads by IPC-7351B', drawn: 'drawn by hand' };
const pages = (n: number[]) => (n.length ? `page${n.length > 1 ? 's' : ''} ${n.join(', ')}` : '');

/** The shelf's library as placed from: the symbol of this part in My Parts.SchLib (its name there). */
function shelfSymbol(p: PartPackage) {
  const f = installedLibs.value.find((x) => x.name === SHELF_SCH);
  if (!f) return null;
  try {
    const lib = readSchLib(f.bytes, f.name);
    const want = partKey(p.record.mpn);
    const sym = lib.symbols.find((s) => s.bags.some((b) => (b.get('NAME') ?? '') === 'Manufacturer Part Number' && partKey(b.get('TEXT') ?? '') === want)) ?? lib.symbols.find((s) => partKey(s.libRef) === want);
    return sym ? { sym, lib } : null;
  } catch { return null; }
}

/** The example part put on the shelf (Tools › Parts, the flask). */
export function addExamplePart(): void {
  const p = examplePart(APP_VERSION);
  const had = keepPart(p);
  notify(had ? `${p.record.mpn} is on your shelf already: made again` : `${p.record.mpn} added to your shelf`);
}

/** The worst of a part's checks: what its row shows at its end. */
const worst = (c: PartCheck[]): PartCheck['level'] => (c.some((x) => x.level === 'error') ? 'error' : c.some((x) => x.level === 'warning') ? 'warning' : 'note');
const MARK: Record<PartCheck['level'], { icon: string; label: string }> = { note: { icon: 'partsOk', label: 'Its checks pass' }, warning: { icon: 'warn', label: 'Its checks have something to say' }, error: { icon: 'warn', label: 'Its checks find a fault' } };

export function PartsPanel() {
  const parts = shelf.value;
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const checksOf = useMemo(() => new Map(parts.map((p) => [p, partChecks(p)])), [parts]);
  const picked = (open && shelfPart(open)) || null;
  const sch = active.value?.editor instanceof SchEditor;

  // The shelf as the field narrows it: by part number first, then by maker, package and description
  const key = partKey(typed), words = typed.trim().toLowerCase();
  const shown = !words ? parts : parts.filter((p) => (key && partKey(p.record.mpn).includes(key)) || `${p.record.maker} ${p.record.package.name} ${p.record.description} ${p.record.device}`.toLowerCase().includes(words));
  /** A number typed that no part on the shelf has: one to build. */
  const missing = key.length >= 3 && !parts.some((p) => partKey(p.record.mpn).includes(key)) ? typed.trim() : '';
  /** The part open below the list: not one the field has narrowed away. */
  const sel = picked && shown.includes(picked) ? picked : null;

  const build = () => showDialog(AiBuilderDialog, { part: missing });
  const place = () => {
    if (!sel) return;
    const s = shelfSymbol(sel);
    if (!s) { notify(`${sel.record.mpn}'s symbol couldn't be read from the shelf`, 'error'); return; }
    placePart({ items: partRecords(s.sym, s.lib.name, 1), symbol: s.sym, library: s.lib.name });
  };
  const exportIntLib = async () => {
    if (!sel) return;
    try { const h = await saveFileAs(`${partName(sel.record.mpn)}.IntLib`, await partIntLib(sel)); if (h !== null) notify(`${sel.record.mpn} saved as an integrated library`); } catch (e) { notify(`Not saved: ${(e as Error).message}`, 'error'); }
  };
  const exportFile = async () => {
    if (!sel) return;
    try { const h = await saveFileAs(`${partName(sel.record.mpn)}${PART_EXT}`, partFile(sel)); if (h !== null) notify(`${sel.record.mpn} saved as a part file`); } catch (e) { notify(`Not saved: ${(e as Error).message}`, 'error'); }
  };
  const bring = async (list: FileList | null) => {
    for (const f of [...(list ?? [])]) {
      try {
        const p = readPartFile(new Uint8Array(await f.arrayBuffer()));
        const had = keepPart(p);
        setTyped(''); setOpen(p.record.mpn);
        notify(had ? `${p.record.mpn} was on your shelf: replaced by ${f.name}` : `${p.record.mpn} added to your shelf`);
      } catch (e) { notify(`${f.name}: ${(e as Error).message}`, 'error'); }
    }
  };
  const example = () => { addExamplePart(); setTyped(''); setOpen(EXAMPLE_PART.mpn); };
  const addFile = () => picker.current?.click();
  const r = sel?.record;

  return (
    <section class="panel docked parts-panel" aria-label="Parts">
      <div class="parts-search">
        <Icon name="partsSearch" />
        <input ref={field} type="text" aria-label="Part number" placeholder="Exact part number" value={typed} spellcheck={false} autocomplete="off"
          onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && shown[0] && words) setOpen(shown[0].record.mpn); if (e.key === 'Escape' && typed) { e.stopPropagation(); setTyped(''); } }} />
        {typed && <button type="button" class="ex-icon-btn" aria-label="Clear" title="Clear" onClick={() => { setTyped(''); field.current?.focus(); }}><Icon name="close" size={12} /></button>}
      </div>

      {missing && (
        <div class="parts-callout" role="status">
          <div class="parts-callout-text">
            <p><b>{missing}</b> is not on your shelf.</p>
            <span>The Component Builder finds its datasheet from the number, reads it, and makes its footprint and symbol for you to check.</span>
          </div>
          <button type="button" class="btn default parts-cta" onClick={build}><Icon name="partsBuild" />Build It</button>
        </div>
      )}

      <div class="parts-head">
        <span class="parts-head-title">My shelf</span>
        {parts.length > 0 && <span class="parts-count" title={`Placed from the library ${SHELF_SCH}`}>{words && shown.length !== parts.length ? `${shown.length} of ${parts.length}` : parts.length}</span>}
        {parts.length > 0 && (
          <span class="parts-tools">
            <button type="button" class="ex-icon-btn" aria-label="Add a Part File" title="Add a part file…" onClick={addFile}><Icon name="partsFileIn" /></button>
            <button type="button" class="ex-icon-btn" aria-label="Add the Example Part" title="Add the example part: a made-up regulator of Konium Designer's own, to try the shelf with" onClick={example}><Icon name="partsExample" /></button>
          </span>
        )}
      </div>
      <input ref={picker} type="file" accept={PART_EXT} multiple hidden onChange={(e) => { void bring((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ''; }} />

      {parts.length === 0 ? (
        <div class="parts-empty">
          <Icon name="part" size={28} />
          <b>Your shelf is empty</b>
          <span>A part is one exact part number with its symbol, its footprint with its 3D body, and the datasheet pages it was read from. Type a part number above to build one.</span>
          <div class="parts-empty-actions">
            <button type="button" class="btn" title="A made-up regulator of Konium Designer's own, to try the shelf with" onClick={example}><Icon name="partsExample" />Add the Example Part</button>
            <button type="button" class="btn" onClick={addFile}><Icon name="partsFileIn" />Add a Part File…</button>
          </div>
        </div>
      ) : (
        <ul class="parts-list" role="listbox" aria-label="Parts on the shelf">
          {shown.map((p) => {
            const level = worst(checksOf.get(p) ?? []);
            return (
              <li key={p.record.mpn} role="option" aria-selected={sel === p} class={`parts-row${sel === p ? ' sel' : ''}`} onClick={() => setOpen(p.record.mpn)} onDblClick={() => { setOpen(p.record.mpn); if (sch) queueMicrotask(place); }}>
                <Icon name="part" />
                <span class="parts-row-text"><b>{p.record.mpn}</b><span>{[p.record.maker, p.record.package.name, p.record.package.pins ? `${p.record.package.pins} pins` : ''].filter(Boolean).join(' · ')}</span></span>
                <span class={`parts-mark pm-${level}`} title={MARK[level].label} aria-label={MARK[level].label}><Icon name={MARK[level].icon} size={14} /></span>
              </li>
            );
          })}
          {shown.length === 0 && <li class="parts-none">Nothing on your shelf matches.</li>}
        </ul>
      )}

      {sel && r && (
        <div class="parts-card">
          <div class="parts-card-head">
            <b title={r.mpn}>{r.mpn}</b>
            <span class="parts-tools">
              <button type="button" class="ex-icon-btn" aria-label="Save as Integrated Library" title="Save as an integrated library, as the desktop software opens it…" onClick={() => void exportIntLib()}><Icon name="partsIntLib" /></button>
              <button type="button" class="ex-icon-btn" aria-label="Save as Part File" title="Save as a part file, for another Konium Designer to take in…" onClick={() => void exportFile()}><Icon name="partsFileOut" /></button>
              <button type="button" class="ex-icon-btn parts-del" aria-label="Remove" title="Take it off your shelf" onClick={() => { removePart(r.mpn); setOpen(null); notify(`${r.mpn} taken off your shelf`); }}><Icon name="partsRemove" /></button>
            </span>
          </div>
          {(r.description || r.device) && <p class="parts-desc">{r.description || r.device}</p>}
          <dl class="parts-facts">
            <dt>Maker</dt><dd>{r.maker || 'not said'}</dd>
            <dt>Symbol</dt><dd>{r.symbol}<span class="parts-sub">{r.pins.length} pins</span></dd>
            <dt>Footprint</dt><dd>{r.package.footprint}<span class="parts-sub">{FROM[r.package.from]}</span></dd>
            <dt>Datasheet</dt>
            <dd>{webLink(r.datasheet.url) ? <a class="parts-link" href={webLink(r.datasheet.url)} target="_blank" rel="noopener noreferrer">{r.datasheet.title || r.datasheet.url}<Icon name="partsLink" size={12} /></a> : r.datasheet.sha256 ? 'A file given by hand (no link)' : 'None'}
              {(r.datasheet.pinPages.length > 0 || r.datasheet.packagePages.length > 0) && <span class="parts-sub">{[r.datasheet.pinPages.length ? `pins on ${pages(r.datasheet.pinPages)}` : '', r.datasheet.packagePages.length ? `package on ${pages(r.datasheet.packagePages)}` : ''].filter(Boolean).join(' · ')}</span>}</dd>
            <dt>Made</dt><dd>{r.made.at.slice(0, 10)}<span class="parts-sub">by {r.made.by || 'hand'}{r.made.app ? `, Konium Designer ${r.made.app}` : ''}</span></dd>
          </dl>
          <ul class="parts-checks">
            {(checksOf.get(sel) ?? []).map((c, i) => <li key={i} class={`pm-${c.level}`}><Icon name={c.level === 'note' ? 'partsOk' : 'warn'} size={14} /><span>{c.text}</span></li>)}
          </ul>
          <button type="button" class="btn default parts-cta parts-place" disabled={!sch} title={sch ? 'The part follows the cursor in the schematic in front' : 'Bring a schematic in front to place it'} onClick={place}><Icon name="partsPlace" />Place</button>
        </div>
      )}

      <p class="parts-note"><Icon name="partsLocal" size={13} /><span>Kept in this browser only. The world library, where a part made once is there for everyone and is checked by others, comes in a later step.</span></p>
    </section>
  );
}
