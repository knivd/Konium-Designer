/**
 * Tools › Parts, Company Library (R21, step 4): a company's own parts library, its members' only.
 *
 * Whoever is signed in names the company's domain. A library that is not there yet is set up by
 * somebody with an address at that domain: the window gives the record to put in the domain's
 * DNS and checks for it; whoever passes that check runs the library (and whoever holds the
 * domain can do so again, which is how a library is taken back). An administrator lets members
 * in by their addresses and puts them out; members see the parts and keep them on their shelves;
 * administrators also read the log of who fetched what.
 *
 * Nothing is asked of the service until somebody is signed in and presses Show.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { Icon } from '../icons';
import { notify } from '../state';
import { EmptyState, Tool } from '../panels/kv';
import { OFFLINE_NOTE, mayConnect } from '../../platform/network';
import { libraryConfig, type LibraryConfig } from '../../platform/libraryService';
import { orgAudit, orgClaim, orgDrop, orgFind, orgMember, orgParts, orgStatus } from '../../platform/orgService';
import { orgDomain, type OrgEvent, type OrgPart, type OrgRole, type OrgStatus } from '../../model/worldLibrary';
import { companyDomain, keepFound, librarySession, syncSession, useCompany } from '../worldLibrary';
import { LibrarySignIn, SignOutTool } from './LibrarySignIn';

const day = (iso: string) => iso.slice(0, 10);
const minute = (iso: string) => iso.slice(0, 16).replace('T', ' ');
const ROLES: Record<OrgRole, string> = { admin: 'Administrator', member: 'Member' };

export function CompanyLibraryDialog() {
  const session = librarySession.value;
  const [config, setConfig] = useState<LibraryConfig | null | 'asking'>('asking');
  const [domain, setDomain] = useState(companyDomain.value || (session?.user.email.split('@')[1] ?? ''));
  const [status, setStatus] = useState<OrgStatus | null>(null);
  const [parts, setParts] = useState<OrgPart[]>([]);
  const [events, setEvents] = useState<OrgEvent[]>([]);
  const [who, setWho] = useState('');
  const [as, setAs] = useState<OrgRole>('member');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const alive = useRef(true);
  const fail = (e: unknown) => { syncSession(); setError(e instanceof Error ? e.message : String(e)); };

  /** The library as it stands for whoever is signed in: its state, and for a member its parts (for an administrator its log too). */
  const show = async (of = domain) => {
    const d = orgDomain(of);
    if (!d) { setError('Name the company\'s domain, as in example.com.'); return; }
    setBusy('show'); setError('');
    try {
      const st = await orgStatus(d);
      const [list, log] = st.role ? await Promise.all([orgParts(d), st.role === 'admin' ? orgAudit(d) : Promise.resolve([])]) : [[], []];
      if (!alive.current) return;
      setStatus(st); setParts(list); setEvents(log); setDomain(d);
      // (the library this browser works with from here on: looked in first, and offered when a part is published)
      if (st.role) useCompany(d, st.role); else if (companyDomain.value === d) useCompany(d, null);
    } catch (e) { if (alive.current) { setStatus(null); fail(e); } }
    if (alive.current) setBusy('');
  };
  useEffect(() => {
    void libraryConfig().then((c) => { if (alive.current) setConfig(c); });
    if (session && orgDomain(domain)) void show();
    return () => { alive.current = false; };
  }, []);

  const act = async (what: string, run: () => Promise<string | void>) => {
    setBusy(what); setError('');
    try { const said = await run(); if (!alive.current) return; if (said) notify(said); await show(); } catch (e) { if (alive.current) fail(e); }
    if (alive.current) setBusy('');
  };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); notify('Copied'); } catch { notify('The browser refused the clipboard: select the text and copy it', 'error'); } };
  const d = status?.domain ?? '';
  const admin = status?.role === 'admin';
  const off = !mayConnect('library');
  const ready = config !== 'asking' && !!config?.ready;

  return (
    <Dialog title="Company Library" width={600} onClose={closeDialog} class="pubpart orgpart" footer={<><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <div class="pub-part">
        <Icon name="partsCompany" size={22} />
        <span class="parts-row-text"><b>{d ? `${d}'s library` : 'A library of your company\'s own'}</b>
          <span>{status?.role ? `${status.parts} of ${status.allowance} parts · its members' only, in no public repository` : 'Parts that only your company\'s people can fetch'}</span></span>
        {status && <span class={`pub-status ${status.role ? 'ps-company' : ''}`}>{status.role ? ROLES[status.role] : 'Not a member'}</span>}
      </div>

      {off ? <EmptyState icon="partsWorld" title="Network activity is off">{OFFLINE_NOTE}.</EmptyState>
        : config === 'asking' ? <div class="pub-asking" role="status"><span class="pub-spin" />Asking the library service...</div>
        : !ready ? <EmptyState icon="partsWorld" title={config ? 'The library service isn\'t open yet' : 'The library service can\'t be reached'}>Company libraries are kept by the same service as the world library.</EmptyState>
        : (<>
          <div class="kv-head"><h4>Who you are, and which company</h4><span class="kv-tools"><SignOutTool disabled={!!busy} onOut={() => { setStatus(null); setError(''); }} /></span></div>
          <div class="pub-form">
            <LibrarySignIn canMail={config.signIn} disabled={!!busy} onError={(e) => (e ? fail(e) : setError(''))} onSession={(s) => { const at = s.user.email.split('@')[1] ?? ''; const of = orgDomain(domain) || at; setDomain(of); void show(of); }} />
            <label for="org-domain">Company</label>
            <div class="pub-mail">
              <input id="org-domain" type="text" value={domain} maxLength={253} placeholder="its domain, as in example.com" spellcheck={false} disabled={!!busy}
                onInput={(e) => { setDomain((e.target as HTMLInputElement).value); setError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (session) void show(); } }} />
              <button type="button" class="btn" disabled={!session || !!busy || !domain.trim()} title={session ? '' : 'Sign in first'} onClick={() => void show()}><Icon name="partsCompany" />{busy === 'show' ? 'Asking...' : 'Show'}</button>
            </div>
          </div>
          {!session && <p class="kp-note"><Icon name="partsMail" size={13} /><span>Sign in with your address at the company: a company's library goes by its people's addresses, and asks for a new sign-in every 30 days.</span></p>}

          {status && !status.open && (
            <EmptyState icon="partsCompany" title={`No library is open for ${d}`}>Company libraries are opened one company at a time by Konium Designer's author: write through Help › Contact the Author, naming the domain.</EmptyState>
          )}

          {status?.open && !status.role && (status.record ? (<>
            <div class="kv-head"><h4>{status.exists ? `Take ${d}'s library over` : `Open ${d}'s library`}</h4></div>
            <p class="org-step">1. Add this record to {d}'s DNS (whoever looks after the domain can):</p>
            <dl class="org-record">
              <dt>Type</dt><dd><code>TXT</code></dd>
              <dt>Name</dt><dd><code>{status.record.name}</code><Tool icon="partsCopy" label="Copy the Name" onClick={() => void copy(status.record!.name)} /></dd>
              <dt>Text</dt><dd><code>{status.record.value}</code><Tool icon="partsCopy" label="Copy the Text" onClick={() => void copy(status.record!.value)} /></dd>
            </dl>
            <p class="org-step">2. Then have it checked. Whoever passes the check runs the library and lets its members in.</p>
            <button type="button" class="btn default kv-cta org-cta" disabled={!!busy} onClick={() => void act('claim', async () => { const how = await orgClaim(d); return how === 'claimed' ? `You run ${d}'s library now` : `${d}'s library is open, and you run it`; })}>
              <Icon name="partsRefresh" />{busy === 'claim' ? 'Checking...' : 'Check the Record'}</button>
            <p class="kp-note"><Icon name="partsLocal" size={13} /><span>The record is the same for whoever asks from {d}: it proves the domain, not the person. Whoever holds the domain can pass the check again at any time, and so take the library back; leave the record in place or take it out, as you like.</span></p>
          </>) : (
            <EmptyState icon="partsCompany" title={`You are not a member of ${d}'s library`}>If {d} has a library, one of its administrators lets you in by this address ({session?.user.email}). A library for {d} is opened by somebody with an address at {d}.</EmptyState>
          ))}

          {status?.role && (<>
            <div class="kv-head"><h4>Parts</h4><span class="parts-count">{parts.length}</span></div>
            {parts.length ? (
              <ul class="org-list" aria-label="The library's parts">
                {parts.map((p) => (
                  <li key={p.key}>
                    <Icon name="part" />
                    <span class="parts-row-text"><b>{p.mpn}</b><span>{[p.maker, p.package, p.pins ? `${p.pins} pins` : '', `revision ${p.revision}`, `${p.name || p.by} ${day(p.published)}`].filter(Boolean).join(' · ')}</span></span>
                    <span class="kv-tools">
                      <Tool icon="partsKeep" label={`Keep ${p.mpn} on My Shelf`} disabled={!!busy} onClick={() => void act('keep', async () => { const f = await orgFind(d, p.mpn); if (!f) return `${p.mpn} is no longer in the library`; keepFound(f); return `${p.mpn} is on your shelf`; })} />
                      {(admin || p.by === session?.user.id) && <Tool icon="partsRemove" label={`Take ${p.mpn} Out of the Library`} disabled={!!busy} onClick={() => void act('drop', async () => { await orgDrop(d, p.key); return `${p.mpn} taken out of ${d}'s library`; })} />}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p class="kp-note"><Icon name="partsPublish" size={13} /><span>No parts yet. Publish one from your shelf: its card's Publish tool offers {d}'s library beside the world's.</span></p>}

            {admin && (<>
              <div class="kv-head"><h4>Members</h4><span class="parts-count">{status.members?.length ?? 0}</span></div>
              <ul class="org-list" aria-label="The library's members">
                {(status.members ?? []).map((m) => (
                  <li key={m.email}>
                    <Icon name="partsUser" />
                    <span class="parts-row-text"><b>{m.email}</b><span>{m.seen ? `seen ${day(m.seen)}` : 'not signed in yet'} · let in by {m.by} {day(m.since)}</span></span>
                    <span class="kv-tools">
                      <select aria-label={`${m.email}'s part in the library`} value={m.role} disabled={!!busy} onChange={(e) => void act('role', async () => { await orgMember(d, m.email, { role: (e.target as HTMLSelectElement).value as OrgRole }); })}>
                        <option value="member">Member</option><option value="admin">Administrator</option>
                      </select>
                      <Tool icon="partsRemove" label={`Put ${m.email} Out`} title="Put out: nothing of the library from this moment" disabled={!!busy} onClick={() => void act('remove', async () => { await orgMember(d, m.email, { remove: true }); return `${m.email} is out of ${d}'s library`; })} />
                    </span>
                  </li>
                ))}
              </ul>
              <div class="pub-form">
                <label for="org-who">Let in</label>
                <div class="org-invite">
                  <input id="org-who" type="email" value={who} maxLength={254} placeholder="an address" disabled={!!busy} onInput={(e) => { setWho((e.target as HTMLInputElement).value); setError(''); }} />
                  <select aria-label="As" value={as} disabled={!!busy} onChange={(e) => setAs((e.target as HTMLSelectElement).value as OrgRole)}><option value="member">Member</option><option value="admin">Administrator</option></select>
                  <button type="button" class="btn" disabled={!!busy || !who.trim()} onClick={() => void act('invite', async () => { const r = await orgMember(d, who, { role: as }); setWho(''); return r.added ? `${who.trim()} let in${r.mailed ? ', and told by mail' : ''}` : undefined; })}><Icon name="partsUser" />Let In</button>
                </div>
              </div>

              <div class="kv-head"><h4>What happened</h4><span class="parts-count">{events.length}</span></div>
              <ul class="org-log" aria-label="The library's log">
                {events.slice(0, 60).map((e, i) => <li key={i}><time>{minute(e.at)}</time><span><b>{e.who}</b> {e.what}{e.about ? ` ${e.about}` : ''}</span></li>)}
              </ul>
            </>)}
            <p class="kp-note"><Icon name="partsLocal" size={13} /><span>A part fetched and placed in a design stays in that design: putting a member out ends what they can fetch, not what they have fetched.</span></p>
          </>)}
          {error && <div class="pub-error" role="alert"><p>{error}{/[.:!?]$/.test(error) ? '' : '.'}</p></div>}
        </>)}
    </Dialog>
  );
}
