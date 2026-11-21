/**
 * Tools › Parts (R21, the parts library's first step): the shelf of parts kept in this browser,
 * each one an exact part number with its symbol, footprint and what it was read from.
 *
 * The field at the top searches the shelf as it is typed in (Enter opens the first match). A
 * number that isn't on the shelf is offered to the Component Builder, which finds its datasheet
 * from the number and keeps the part from there. A part is placed in the schematic in front, goes
 * out as an integrated library or as a part file, and comes in as a part file.
 *
 * The world library (step 2): a number that isn't on the shelf is looked up there at a press (the
 * number is all that goes); a part found is shown with the library's note about it (its state,
 * who published it) and what its checks say here, and is kept on the shelf at a second press. A
 * part of the shelf is published from its card. Nothing is asked of the library before a press.
 *
 * Made in the manner of the enclosure view's side panel: a head with its tools as icons, rows
 * with their state at the end, facts in one aligned column, checks with their marks.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
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
import { mayConnect } from '../../platform/network';
import { findInLibrary, type FoundPart } from '../../platform/libraryService';
import { CompanyLibraryDialog } from '../dialogs/CompanyLibrary';
import { ReviewPartDialog } from '../dialogs/ReviewPart';
import { LICENCE_NAME, STATUS_NAMES, standingText, type LibraryEntry } from '../../model/worldLibrary';
import { PublishPartDialog } from '../dialogs/PublishPart';
import { companyDomain, findAnywhere, keepFound, librarySession, refreshNote } from '../worldLibrary';

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

/** Who published a part, as the library shows it: the name chosen, or the contributor's number. */
const byOf = (e: LibraryEntry) => e.name || e.by || 'someone unnamed';
/** The library's note in a line: by whom, which revision, when. */
const noteOf = (e: LibraryEntry) => [`published by ${byOf(e)}`, e.revision > 1 ? `revision ${e.revision}` : '', e.published.slice(0, 10)].filter(Boolean).join(' · ');
/** Which library a part is in, in words. */
const whereOf = (e: LibraryEntry) => (e.org ? `In ${e.org}'s library` : 'In the world library');
/** What the three states mean, for the chip's tooltip. */
const STATUS_HINT: Record<LibraryEntry['status'], string> = {
  unverified: 'Unverified: as its author published it. Two others have yet to find it right, so check it against the datasheet yourself',
  confirmed: 'Confirmed: two others have compared it with its datasheet and found it right',
  proven: 'Proven: found right by two others, and built on a board that works',
};
export function StatusChip({ entry }: { entry: LibraryEntry }) {
  // A company's own part: its members' only, and its own to vouch for
  if (entry.org) return <span class="pub-status ps-company" title={`${entry.org}'s own: only its members can fetch it, and it is in no public repository`}>Company</span>;
  const disputed = entry.status === 'unverified' && (entry.problems?.length ?? 0) > 1;
  return <span class={`pub-status ps-${entry.status}`} title={disputed ? 'Unverified: people have found it wrong. It is for its author to publish it again, put right' : STATUS_HINT[entry.status]}>{STATUS_NAMES[entry.status]}</span>;
}
/** What has been found wrong with a part, as lines of its checks. */
const Problems = ({ entry }: { entry: LibraryEntry | null }) => <>{(entry?.problems ?? []).map((w) => <li key={`p${w.by}`} class="pm-warn"><Icon name="warn" size={14} /><span>Said to be wrong: {w.note} ({w.name || w.by})</span></li>)}</>;

/** A look in the world library for the number typed: under way, nothing there, found, or refused. */
type Look = { key: string } & ({ state: 'busy' } | { state: 'none' } | { state: 'found'; found: FoundPart } | { state: 'error'; text: string });

export function PartsPanel() {
  const parts = shelf.value;
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const checksOf = useMemo(() => new Map(parts.map((p) => [p, partChecks(p)])), [parts]);
  const picked = (open && shelfPart(open)) || null;
  const sch = active.value?.editor instanceof SchEditor;
  const [look, setLook] = useState<Look | null>(null);
  /** A later revision the library has of a part of the shelf, fetched and offered. */
  const [later, setLater] = useState<FoundPart | null>(null);
  const [asking, setAsking] = useState(false);
  const me = librarySession.value?.user.id ?? '';
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // The shelf as the field narrows it: by part number first, then by maker, package and description
  const key = partKey(typed), words = typed.trim().toLowerCase();
  const shown = !words ? parts : parts.filter((p) => (key && partKey(p.record.mpn).includes(key)) || `${p.record.maker} ${p.record.package.name} ${p.record.description} ${p.record.device}`.toLowerCase().includes(words));
  /** A number typed that no part on the shelf has: one to build. */
  const missing = key.length >= 3 && !parts.some((p) => partKey(p.record.mpn).includes(key)) ? typed.trim() : '';
  /** The part open below the list: not one the field has narrowed away. */
  const sel = picked && shown.includes(picked) ? picked : null;

  /** What the world library said of the number typed (nothing yet when another number was asked about). */
  const seen = missing && look && look.key === key ? look : null;
  const canLook = mayConnect('library');
  const lookUp = async () => {
    if (!missing) return;
    const asked = key;
    setLook({ key: asked, state: 'busy' });
    let next: Look;
    try { const { found } = await findAnywhere(missing); next = found ? { key: asked, state: 'found', found } : { key: asked, state: 'none' }; } catch (e) { next = { key: asked, state: 'error', text: (e as Error).message }; }
    if (alive.current) setLook((now) => (now && now.key === asked ? next : now));
  };
  const keep = () => {
    if (!found) return;
    const p = found.part;
    const had = keepFound(found);
    setLook(null); setLater(null); setTyped(''); setOpen(p.record.mpn);
    const from = p.record.library?.org ? `${p.record.library.org}'s library` : 'the world library';
    notify(had ? `${p.record.mpn} was on your shelf: replaced by the one from ${from}` : `${p.record.mpn} added to your shelf from ${from}`);
  };
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
  const lib = r?.library ?? null;
  /** A part of one's own may be published, and published again while nobody has confirmed it; another's is theirs to change. */
  const mayPublish = !lib || !!lib.org || (lib.status === 'unverified' && (!me || !lib.by || lib.by === me));
  const company = librarySession.value ? companyDomain.value : '';
  const found = seen?.state === 'found' ? seen.found : !missing && later && later.entry.key === lib?.key ? later : null;
  /** Where the part selected stands in the library now; a later revision there is fetched and offered. */
  const refresh = async () => {
    if (!sel) return;
    const mpn = sel.record.mpn;
    setAsking(true);
    try {
      const got = await refreshNote(sel);
      if (got.newer) { const f = await findInLibrary(mpn); if (alive.current && f) setLater(f); }
      notify(!got.entry ? `${mpn} is not in the world library any more` : got.newer ? `The world library has revision ${got.entry.revision} of ${mpn}` : `${mpn}: ${got.changed ? 'now ' : 'still '}${STATUS_NAMES[got.entry.status]} in the world library (${standingText(got.entry)})`);
    } catch (e) { notify((e as Error).message, 'error'); }
    if (alive.current) setAsking(false);
  };
  const faulty = !!found && found.checks.some((c) => c.level === 'error');

  return (
    <section class="panel docked parts-panel" aria-label="Parts">
      <div class="parts-search">
        <Icon name="partsSearch" />
        <input ref={field} type="text" aria-label="Part number" placeholder="Exact part number" value={typed} spellcheck={false} autocomplete="off"
          onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && shown[0] && words) setOpen(shown[0].record.mpn); if (e.key === 'Escape' && typed) { e.stopPropagation(); setTyped(''); } }} />
        {typed && <button type="button" class="ex-icon-btn" aria-label="Clear" title="Clear" onClick={() => { setTyped(''); field.current?.focus(); }}><Icon name="close" size={12} /></button>}
      </div>

      {missing && !found && (
        <div class="parts-callout" role="status">
          <div class="parts-callout-head">
            <p><b>{missing}</b> {seen?.state === 'none' ? 'is not in the world library yet.' : 'is not on your shelf.'}</p>
            {canLook && seen?.state !== 'none' && <button type="button" class="ex-icon-btn" aria-label="Build It" title="Build it yourself: the Component Builder finds its datasheet from the number, reads it, and makes its footprint and symbol for you to check" onClick={build}><Icon name="partsBuild" /></button>}
          </div>
          {seen?.state === 'error' && <p class="parts-callout-error" role="alert">{seen.text}{/[.:!?]$/.test(seen.text) ? '' : '.'}</p>}
          {canLook && seen?.state !== 'none' ? (<>
            <span class="parts-callout-sub">Somebody may have made it already. Looking sends this part number to {company ? `${company}'s library and the world library` : 'the world library'} at konium.app, and nothing else.</span>
            <button type="button" class="btn default parts-cta" disabled={seen?.state === 'busy'} onClick={() => void lookUp()}><Icon name="partsWorld" />{seen?.state === 'busy' ? 'Looking...' : seen?.state === 'error' ? 'Look Again' : 'Look in the World Library'}</button>
          </>) : (<>
            <span class="parts-callout-sub">The Component Builder finds its datasheet from the number, reads it, and makes its footprint and symbol for you to check.{seen?.state === 'none' ? ' Publish it afterwards, and it is there for everyone.' : ''}</span>
            <button type="button" class="btn default parts-cta" onClick={build}><Icon name="partsBuild" />Build It</button>
          </>)}
        </div>
      )}

      {found && (
        <div class="parts-card parts-found" role="status">
          <div class="parts-card-head">
            <Icon name="partsWorld" />
            <b title={found.part.record.mpn}>{found.part.record.mpn}</b>
            <StatusChip entry={found.entry} />
          </div>
          {(found.part.record.description || found.part.record.device) && <p class="parts-desc">{found.part.record.description || found.part.record.device}</p>}
          <dl class="parts-facts">
            <dt>Maker</dt><dd>{found.part.record.maker || 'not said'}</dd>
            <dt>Package</dt><dd>{found.part.record.package.name}<span class="parts-sub">{found.part.record.pins.length} pins · {FROM[found.part.record.package.from]}</span></dd>
            <dt>Library</dt><dd>{later === found ? `Revision ${found.entry.revision}, later than yours` : whereOf(found.entry)}<span class="parts-sub">{noteOf(found.entry)}{found.entry.org ? '' : ` · ${standingText(found.entry)}`}</span></dd>
          </dl>
          <ul class="parts-checks">
            {found.checks.map((c, i) => <li key={i} class={`pm-${c.level}`}><Icon name={c.level === 'note' ? 'partsOk' : 'warn'} size={14} /><span>{c.text}</span></li>)}
            <Problems entry={found.entry} />
          </ul>
          <button type="button" class="btn default parts-cta parts-place" disabled={faulty} title={faulty ? 'Its checks find a fault: not a part to keep as it is' : 'Its symbol and footprint join My Parts, to place like any other'} onClick={keep}><Icon name="partsKeep" />{later === found ? `Take Revision ${found.entry.revision}` : 'Keep on My Shelf'}</button>
        </div>
      )}

      <div class="parts-head">
        <span class="parts-head-title">My shelf</span>
        {parts.length > 0 && <span class="parts-count" title={`Placed from the library ${SHELF_SCH}`}>{words && shown.length !== parts.length ? `${shown.length} of ${parts.length}` : parts.length}</span>}
        {parts.length > 0 && (
          <span class="parts-tools">
            <button type="button" class="ex-icon-btn" aria-label="Company Library" title="Company library: your company's own parts, its members' only…" onClick={() => showDialog(CompanyLibraryDialog, {})}><Icon name="partsCompany" /></button>
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
                <span class="parts-marks">
                  {p.record.library && <span class="parts-mark pm-world" title={p.record.library.org ? whereOf(p.record.library) : `In the world library: ${STATUS_NAMES[p.record.library.status]}`} aria-label={p.record.library.org ? whereOf(p.record.library) : `In the world library: ${STATUS_NAMES[p.record.library.status]}`}><Icon name={p.record.library.org ? 'partsCompany' : 'partsWorld'} size={14} /></span>}
                  <span class={`parts-mark pm-${level}`} title={MARK[level].label} aria-label={MARK[level].label}><Icon name={MARK[level].icon} size={14} /></span>
                </span>
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
              {lib && !lib.org && <button type="button" class="ex-icon-btn" aria-label="Check the World Library" disabled={!canLook || asking} title="Ask the world library where this part stands now: its standing, who has checked it, a later revision. Its number is all that goes"
                onClick={() => void refresh()}><Icon name="partsRefresh" /></button>}
              {lib && !lib.org && <button type="button" class="ex-icon-btn" aria-label="Review" title="Review it: say that it is right, that a board with it works, or what is wrong with it…"
                onClick={() => showDialog(ReviewPartDialog, { part: sel })}><Icon name="partsReview" /></button>}
              <button type="button" class="ex-icon-btn" aria-label={lib ? 'Publish Again' : 'Publish to the World Library'} disabled={!mayPublish}
                title={lib?.org ? `Publish this copy again, to ${lib.org}'s library or to the world's…` : !mayPublish ? (lib!.status !== 'unverified' ? `In the world library as ${STATUS_NAMES[lib!.status]}: no longer changed by publishing again` : `In the world library, published by ${byOf(lib!)}: theirs to change`) : lib ? 'Publish this copy to the world library again, as its next revision…' : 'Publish to the world library, for everyone…'}
                onClick={() => showDialog(PublishPartDialog, { part: sel })}><Icon name="partsPublish" /></button>
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
            <dt>Library</dt>
            <dd>{lib ? <span class="parts-inline">{whereOf(lib)}<StatusChip entry={lib} /></span> : 'On your shelf only'}
              <span class="parts-sub">{lib ? `${noteOf(lib)}${lib.org ? '' : ` · ${standingText(lib)}`}` : 'not published'}</span>
              {lib && <span class="parts-sub">{lib.org ? 'its members\' only: given to nobody else' : `given to the public domain (${LICENCE_NAME})`}</span>}</dd>
          </dl>
          <ul class="parts-checks">
            {(checksOf.get(sel) ?? []).map((c, i) => <li key={i} class={`pm-${c.level}`}><Icon name={c.level === 'note' ? 'partsOk' : 'warn'} size={14} /><span>{c.text}</span></li>)}
            <Problems entry={lib} />
          </ul>
          <button type="button" class="btn default parts-cta parts-place" disabled={!sch} title={sch ? 'The part follows the cursor in the schematic in front' : 'Bring a schematic in front to place it'} onClick={place}><Icon name="partsPlace" />Place</button>
        </div>
      )}

      <p class="parts-note"><Icon name="partsLocal" size={13} /><span>Your shelf is kept in this browser only. A part goes to the world library when you publish it, and comes from it when you look its number up.</span></p>
    </section>
  );
}
