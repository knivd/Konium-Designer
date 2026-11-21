/**
 * Tools › Parts, Review (R21, step 3): a contributor's word about a part of the world library
 * that is on the shelf. The window lays out what there is to compare with the datasheet (every
 * pin by number, name and kind; the package and where its pads came from; the datasheet's link
 * and the pages read), shows where the part stands and what has been said of it, and sends one
 * of three words: it is right, a board built with it works, or something is wrong with it (said
 * in a line). Two people's checks make a part Confirmed; a board that works then makes it
 * Proven; two people's problems send it back to Unverified for its author to put right.
 *
 * A word is published with its author's shown name or contributor's number, never an address.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { Icon } from '../icons';
import { notify } from '../state';
import { EmptyState } from '../panels/kv';
import { webLink } from '../../core/webLink';
import { OFFLINE_NOTE, mayConnect } from '../../platform/network';
import { LibraryError, libraryConfig, type LibraryConfig } from '../../platform/libraryService';
import { CHECKS_TO_CONFIRM, MAX_NOTE, MIN_NOTE, PROBLEMS_TO_DISPUTE, STATUS_NAMES, shownName, standingText, type LibraryEntry, type LibraryWord, type Verdict } from '../../model/worldLibrary';
import type { PartPackage } from '../../model/partPackage';
import { librarySession, reviewFromShelf, syncSession } from '../worldLibrary';
import { LibrarySignIn, SignOutTool } from './LibrarySignIn';

const who = (w: LibraryWord) => w.name || w.by;
const FROM: Record<string, string> = { datasheet: 'pads from the datasheet\'s land pattern', ipc: 'pads worked out by IPC-7351B', drawn: 'pads drawn by hand' };
const pagesOf = (list: number[]) => (list.length ? ` (page${list.length === 1 ? '' : 's'} ${list.slice(0, 8).join(', ')})` : '');

/** What each word means, and to whom it is not open (a reason, or '' when it is). */
function choices(entry: LibraryEntry, me: string): { verdict: Verdict; label: string; hint: string; closed: string }[] {
  const mine = !!me && entry.by === me;
  const said = (list?: LibraryWord[]) => !!me && !!list?.some((w) => w.by === me);
  return [
    { verdict: 'confirm', label: 'It is right', hint: 'I compared every pin\'s number and name, and the footprint\'s pads and size, with the datasheet.',
      closed: mine ? 'Your own part: a confirmation is somebody else\'s check' : said(entry.checked) ? 'You have said so already' : '' },
    { verdict: 'built', label: 'A board with it works', hint: 'I had a board made with this part as it is here, and the part does its work on it.',
      closed: said(entry.built) ? 'You have said so already' : '' },
    { verdict: 'problem', label: 'Something is wrong with it', hint: 'Say what, in a line: its author is told by the library\'s note, and so is everyone who looks the part up.',
      closed: mine ? 'Your own part: put the fault right and publish it again' : '' },
  ];
}

export function ReviewPartDialog({ part }: { part: PartPackage }) {
  const r = part.record;
  const session = librarySession.value;
  const [entry, setEntry] = useState<LibraryEntry | null>(r.library ?? null);
  const [config, setConfig] = useState<LibraryConfig | null | 'asking'>('asking');
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [note, setNote] = useState('');
  const [name, setName] = useState(session?.user.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Verdict | null>(null);
  const alive = useRef(true);
  const askConfig = (again = false) => { setConfig('asking'); void libraryConfig(fetch, again).then((c) => { if (alive.current) setConfig(c); }); };
  useEffect(() => { askConfig(); return () => { alive.current = false; }; }, []);
  if (!entry) return null;

  const me = session?.user.id ?? '';
  const list = choices(entry, me);
  const picked = list.find((c) => c.verdict === verdict && !c.closed) ?? null;
  const line = note.trim();
  const fail = (e: unknown) => {
    syncSession();
    // (the library has moved on to another revision: its note as it is now is shown, and the word is not sent)
    if (e instanceof LibraryError && e.entry) setEntry(e.entry);
    setError(e instanceof Error ? e.message : String(e));
  };
  const send = async () => {
    if (!picked) return;
    setBusy(true); setError('');
    try {
      const next = await reviewFromShelf({ ...part, record: { ...r, library: entry } }, picked.verdict, { note: line, name: shownName(name) });
      if (!alive.current) return;
      setEntry(next); setDone(picked.verdict);
      notify(`${r.mpn}: ${STATUS_NAMES[next.status]} in the world library (${standingText(next)})`);
    } catch (e) { if (alive.current) fail(e); }
    if (alive.current) setBusy(false);
  };

  const off = !mayConnect('library');
  const ready = config !== 'asking' && !!config?.ready;
  const can = ready && !!session && !!picked && !busy && (picked.verdict !== 'problem' || line.length >= MIN_NOTE);
  const why = !session ? 'Sign in first' : !picked ? 'Choose what you have to say' : picked.verdict === 'problem' && line.length < MIN_NOTE ? 'Say what is wrong, in a line' : '';
  const sheet = webLink(r.datasheet.url);

  return (
    <Dialog title="Review a Part of the World Library" width={560} onClose={closeDialog} class="pubpart reviewpart"
      footer={done ? <><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></> : <>
        {sheet && <a class="parts-link" href={sheet} target="_blank" rel="noopener noreferrer">Open the datasheet<Icon name="partsLink" size={12} /></a>}
        <span class="spacer" />
        <button class="btn default kv-cta" disabled={!can} title={why} onClick={() => void send()}><Icon name="partsReview" />{busy ? 'Sending...' : 'Send'}</button>
        <button class="btn" disabled={busy} onClick={closeDialog}>Cancel</button>
      </>}>
      <div class="pub-part">
        <Icon name="part" size={22} />
        <span class="parts-row-text"><b>{r.mpn}</b><span>{[r.maker, r.package.name, `revision ${entry.revision}`, `published by ${entry.name || entry.by || 'someone unnamed'}`].filter(Boolean).join(' · ')}</span></span>
        <span class={`pub-status ps-${entry.status}`}>{STATUS_NAMES[entry.status]}</span>
      </div>

      {done ? (
        <div class="pub-done" role="status">
          <span class="parts-mark pm-note"><Icon name="partsOk" size={28} /></span>
          <b>{done === 'problem' ? 'The library has your note' : 'The library has your word'}: {r.mpn} is {STATUS_NAMES[entry.status]}</b>
          <span>{standingText(entry)}. {entry.status === 'unverified' && (entry.problems?.length ?? 0) >= PROBLEMS_TO_DISPUTE ? 'Two people have found it wrong: it is for its author to publish it again, put right.' : entry.status === 'unverified' ? `${CHECKS_TO_CONFIRM} checks by others than its author make it Confirmed.` : entry.status === 'confirmed' ? 'A board that works with it makes it Proven.' : 'It has been checked and built.'}</span>
        </div>
      ) : off ? (
        <EmptyState icon="partsWorld" title="Network activity is off">{OFFLINE_NOTE}.</EmptyState>
      ) : config === 'asking' ? (
        <div class="pub-asking" role="status"><span class="pub-spin" />Asking the world library...</div>
      ) : !ready ? (
        <EmptyState icon="partsWorld" title={config ? 'The world library isn\'t open yet' : 'The world library can\'t be reached'}
          action={<button class="btn" onClick={() => askConfig(true)}><Icon name="partsWorld" />Try Again</button>}>
          Either there is no connection, or the service is not there. The part on your shelf is as it was.
        </EmptyState>
      ) : (<>
        <div class="kv-head"><h4>What to compare with the datasheet</h4></div>
        <div class="rev-pins" role="table" aria-label="The part's pins">
          <div class="rev-pin rev-pin-head" role="row"><span role="columnheader">Pin</span><span role="columnheader">Name</span><span role="columnheader">Kind</span></div>
          {r.pins.map((p) => <div key={p.number} class="rev-pin" role="row"><span role="cell">{p.number}</span><span role="cell">{p.name || '(unnamed)'}</span><span role="cell">{p.type || 'passive'}</span></div>)}
        </div>
        <p class="kp-note"><Icon name="partsFootprint" size={13} /><span>{r.package.name}, {r.package.pins} pins: footprint {r.package.footprint}, its {FROM[r.package.from]}. {r.datasheet.url || r.datasheet.sha256
          ? `The pins were read from the datasheet${pagesOf(r.datasheet.pinPages)}, the package${pagesOf(r.datasheet.packagePages)}.` : 'The part names no datasheet: find its maker\'s own.'}</span></p>

        {(entry.checked?.length || entry.built?.length || entry.problems?.length) ? (<>
          <div class="kv-head"><h4>What has been said of it</h4></div>
          <ul class="parts-checks rev-said">
            {(entry.checked ?? []).map((w) => <li key={`c${w.by}`} class="pm-note"><Icon name="partsOk" size={14} /><span>Found right by {who(w)}<small>{w.at.slice(0, 10)}</small></span></li>)}
            {(entry.built ?? []).map((w) => <li key={`b${w.by}`} class="pm-note"><Icon name="partsOk" size={14} /><span>Built on a board that works by {who(w)}<small>{w.at.slice(0, 10)}</small></span></li>)}
            {(entry.problems ?? []).map((w) => <li key={`p${w.by}`} class="pm-warn"><Icon name="warn" size={14} /><span>{w.note}<small>{who(w)}, {w.at.slice(0, 10)}</small></span></li>)}
          </ul>
        </>) : null}

        <div class="kv-head"><h4>Your word</h4></div>
        <div class="rev-choices" role="radiogroup" aria-label="Your word">
          {list.map((c) => (
            <label key={c.verdict} class={`rev-choice${c.closed ? ' closed' : ''}${verdict === c.verdict && !c.closed ? ' on' : ''}`} title={c.closed || undefined}>
              <input type="radio" name="rev-verdict" disabled={!!c.closed || busy} checked={verdict === c.verdict && !c.closed} onChange={() => { setVerdict(c.verdict); setError(''); }} />
              <span><b>{c.label}</b><small>{c.closed || c.hint}</small></span>
            </label>
          ))}
        </div>
        {picked?.verdict === 'problem' && (
          <div class="pub-form">
            <label for="rev-note">What is wrong</label>
            <input id="rev-note" type="text" autofocus value={note} maxLength={MAX_NOTE} placeholder="pin 3 is VOUT in the datasheet, not GND" onInput={(e) => { setNote((e.target as HTMLInputElement).value); setError(''); }} />
          </div>
        )}

        <div class="kv-head"><h4>Who says so</h4><span class="kv-tools"><SignOutTool disabled={busy} onOut={() => setError('')} /></span></div>
        <div class="pub-form">
          <LibrarySignIn canMail={config.signIn} disabled={busy} onError={(e) => (e ? fail(e) : setError(''))} onSession={(u) => setName((n) => n || u.user.name)} />
          <label for="rev-name">Shown as</label>
          <input id="rev-name" type="text" value={name} maxLength={40} placeholder={session ? `your number, ${session.user.id}` : 'your contributor number'} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </div>
        <p class="kp-note"><Icon name="partsUser" size={13} /><span>Your word is published in the library with the name you show, or your contributor's number: never your address.</span></p>
        {error && <div class="pub-error" role="alert"><p>{error}{/[.:!?]$/.test(error) ? '' : '.'}</p></div>}
      </>)}
    </Dialog>
  );
}
