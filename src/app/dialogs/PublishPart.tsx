/**
 * Tools › Parts, Publish to the World Library (R21, step 2): a part of the shelf given to
 * everyone. The window says what goes and what does not, signs its author in (a link mailed to an
 * address; the window waits for it to be confirmed and carries on by itself), asks for the name
 * to show and for the agreement that the part is given to the public domain, and sends it. The
 * part is then in the library as Unverified, and the copy on the shelf carries the library's note.
 *
 * Nothing is sent before a press: opening the window asks the service only whether it is there.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { Icon } from '../icons';
import { notify } from '../state';
import { EmptyState } from '../panels/kv';
import { LibrarySignIn, SignOutTool } from './LibrarySignIn';
import { webLink } from '../../core/webLink';
import { OFFLINE_NOTE, mayConnect } from '../../platform/network';
import { LibraryError, libraryConfig, publishProblems, whoAmI, type LibraryConfig, type Published } from '../../platform/libraryService';
import { LICENCE_NAME, LICENCE_URL, STATUS_NAMES, cleanRecord, shownName } from '../../model/worldLibrary';
import type { PartPackage } from '../../model/partPackage';
import { librarySession, publishFromShelf, syncSession } from '../worldLibrary';

const size = (n: number) => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`);

export function PublishPartDialog({ part }: { part: PartPackage }) {
  const r = part.record;
  const session = librarySession.value;
  const [config, setConfig] = useState<LibraryConfig | null | 'asking'>('asking');
  const [name, setName] = useState(session?.user.name ?? '');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState<'' | 'publish'>('');
  const [error, setError] = useState<{ text: string; list: string[] } | null>(null);
  const [done, setDone] = useState<Published | null>(null);
  const alive = useRef(true);
  const problems = useMemo(() => publishProblems(part), [part]);
  // (what goes is the record as the library keeps it: without the library's own note, should this copy carry one)
  const recordSize = useMemo(() => new TextEncoder().encode(JSON.stringify(cleanRecord(r))).byteLength, [r]);
  const fail = (e: unknown) => { syncSession(); setError({ text: e instanceof Error ? e.message : String(e), list: e instanceof LibraryError ? e.problems : [] }); };

  const askConfig = (again = false) => {
    setConfig('asking');
    void libraryConfig(fetch, again).then((c) => { if (alive.current) setConfig(c); });
  };
  useEffect(() => {
    askConfig();
    // (a pass kept from an earlier day: the service says whether it still takes it, and under which name)
    if (session) void whoAmI().then((u) => { if (!alive.current) return; syncSession(); if (u?.name) setName((n) => n || u.name); }).catch(() => { /* asked again when publishing */ });
    return () => { alive.current = false; };
  }, []);

  const publish = async () => {
    setBusy('publish'); setError(null);
    try {
      const p = await publishFromShelf(part, { agreed, name: shownName(name) });
      if (!alive.current) return;
      setDone(p);
      notify(`${r.mpn} is in the world library`);
    } catch (e) { if (alive.current) fail(e); }
    if (alive.current) setBusy('');
  };

  const off = !mayConnect('library');
  const ready = config !== 'asking' && !!config?.ready;
  const can = ready && !!session && agreed && !problems.length && !busy;
  const why = !session ? 'Sign in first' : problems.length ? 'The part has something to put right first' : !agreed ? 'Tick the agreement first' : '';
  const repo = ready ? webLink(config.web) : '';

  return (
    <Dialog title="Publish to the World Library" width={540} onClose={closeDialog} class="pubpart"
      footer={done ? <><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></> : <>
        {repo && <a class="parts-link" href={repo} target="_blank" rel="noopener noreferrer">The library's repository<Icon name="partsLink" size={12} /></a>}
        <span class="spacer" />
        <button class="btn default kv-cta" disabled={!can} title={why} onClick={() => void publish()}><Icon name="partsPublish" />{busy === 'publish' ? 'Publishing...' : 'Publish'}</button>
        <button class="btn" disabled={busy === 'publish'} onClick={closeDialog}>Cancel</button>
      </>}>
      <div class="pub-part">
        <Icon name="part" size={22} />
        <span class="parts-row-text"><b>{r.mpn}</b><span>{[r.maker, r.package.name, r.package.pins ? `${r.package.pins} pins` : ''].filter(Boolean).join(' · ')}</span></span>
        {done && <span class="pub-status ps-unverified">{STATUS_NAMES[done.entry.status]}</span>}
      </div>

      {done ? (
        <div class="pub-done" role="status">
          <span class="parts-mark pm-note"><Icon name="partsOk" size={28} /></span>
          <b>{r.mpn} is in the world library{done.entry.revision > 1 ? `, revision ${done.entry.revision}` : ''}</b>
          <span>Anyone who looks its number up gets it from now on. It shows as {STATUS_NAMES[done.entry.status]} until others have checked it; your copy on the shelf carries the library's note.</span>
          {webLink(done.url) && <a class="parts-link" href={webLink(done.url)} target="_blank" rel="noopener noreferrer">See it in the library's repository<Icon name="partsLink" size={12} /></a>}
        </div>
      ) : off ? (
        <EmptyState icon="partsWorld" title="Network activity is off">{OFFLINE_NOTE}.</EmptyState>
      ) : config === 'asking' ? (
        <div class="pub-asking" role="status"><span class="pub-spin" />Asking the world library...</div>
      ) : !ready ? (
        <EmptyState icon="partsWorld" title={config ? 'The world library isn\'t open yet' : 'The world library can\'t be reached'}
          action={<button class="btn" onClick={() => askConfig(true)}><Icon name="partsWorld" />Try Again</button>}>
          {config ? 'The Konium service has not been given its library yet. Your part stays on your shelf, and goes out as a part file meanwhile.' : 'Either there is no connection, or the service is not there. Your part stays on your shelf, and goes out as a part file meanwhile.'}
        </EmptyState>
      ) : (<>
        <div class="kv-head"><h4>What goes</h4></div>
        <ul class="pub-goes">
          <li><Icon name="partsFileOut" /><span>Its record<small>the part number, maker, description, package and {r.pins.length} pins</small></span><em>{size(recordSize)}</em></li>
          <li><Icon name="partsSymbol" /><span>Its symbol<small>{r.symbol}</small></span><em>{size(part.schlib.byteLength)}</em></li>
          <li><Icon name="partsFootprint" /><span>Its footprint, with its 3D body<small>{r.package.footprint}</small></span><em>{size(part.pcblib.byteLength)}</em></li>
          <li><Icon name="partsLink" /><span>Its datasheet's link and fingerprint<small>{r.datasheet.url ? 'never the datasheet itself' : r.datasheet.sha256 ? 'the fingerprint only: the datasheet was a file given by hand' : 'this part names no datasheet'}</small></span><em /></li>
        </ul>
        <p class="kp-note"><Icon name="partsLocal" size={13} /><span>Nothing of your designs goes, and nothing else of this computer.</span></p>

        {problems.length > 0 && (<>
          <div class="kv-head"><h4>To put right first</h4></div>
          <ul class="parts-checks">{problems.map((t, i) => <li key={i} class="pm-error"><Icon name="warn" size={14} /><span>{t}</span></li>)}</ul>
        </>)}

        <div class="kv-head"><h4>Who publishes</h4>
          <span class="kv-tools"><SignOutTool disabled={!!busy} onOut={() => setError(null)} /></span>
        </div>
        <div class="pub-form">
          <LibrarySignIn canMail={config.signIn} onError={(e) => (e ? fail(e) : setError(null))} onSession={(u) => setName((n) => n || u.user.name)} />
          <label for="pub-name">Shown as</label>
          <input id="pub-name" type="text" value={name} maxLength={40} placeholder={session ? `your number, ${session.user.id}` : 'your contributor number'} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </div>
        <p class="kp-note"><Icon name="partsMail" size={13} /><span>{config.signIn
          ? 'No password: a link is mailed to you. The address is kept by the library to sign you in and to reach you about your parts, and is never published. Beside your parts stands the name above, or your number alone.'
          : 'The library can\'t mail sign-in links yet: publishing opens when it can.'}</span></p>

        <label class="pub-agree">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed((e.target as HTMLInputElement).checked)} />
          <span>I made this part, or may give it away, and I give it to the public domain under <a class="parts-link" href={LICENCE_URL} target="_blank" rel="noopener noreferrer">{LICENCE_NAME}<Icon name="partsLink" size={12} /></a>: anyone may use it, change it and pass it on, for any purpose, and that can't be taken back.</span>
        </label>
        {error && <div class="pub-error" role="alert"><p>{error.text}{/[.:!?]$/.test(error.text) ? '' : '.'}</p>{error.list.length > 0 && <ul>{error.list.map((t, i) => <li key={i}>{t}</li>)}</ul>}</div>}
      </>)}
    </Dialog>
  );
}
