/**
 * The world library's sign-in as two cells of a form (a label and what stands beside it), shared
 * by the windows that need one (Publish, Review): the address asked for and a link mailed to it,
 * the wait while the link is out (the window asks every few seconds whether it has been confirmed,
 * and carries on by itself), and who is signed in. No password anywhere.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../icons';
import { Tool } from '../panels/kv';
import { LibraryError, askSignIn, sessionFor, type LibrarySession } from '../../platform/libraryService';
import { mailAddress } from '../../model/worldLibrary';
import { leaveLibrary, librarySession, syncSession } from '../worldLibrary';

/** How often a window asks whether the mailed link has been confirmed. */
export const WAIT_MS = 3000;

export function LibrarySignIn({ canMail, disabled, onError, onSession }: {
  /** The service can mail links. */
  canMail: boolean;
  disabled?: boolean;
  /** Something to say (null: nothing any more). */
  onError: (e: unknown | null) => void;
  onSession?: (s: LibrarySession) => void;
}) {
  const session = librarySession.value;
  const [email, setEmail] = useState('');
  const [waiting, setWaiting] = useState<{ ticket: string; to: string; minutes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // While a link is out: ask every few seconds whether it has been confirmed, until it has, it runs out, or the window closes
  useEffect(() => {
    if (!waiting) return undefined;
    const until = Date.now() + waiting.minutes * 60_000;
    let timer = 0;
    const look = async () => {
      if (!alive.current) return;
      try {
        const s = await sessionFor(waiting.ticket);
        if (!alive.current) return;
        if (s !== 'pending') { syncSession(); setWaiting(null); onError(null); onSession?.(s); return; }
        if (Date.now() > until) { setWaiting(null); onError(new Error('That sign-in link ran out: ask for a new one')); return; }
      } catch (e) {
        if (!alive.current) return;
        // (a moment without a connection is waited through; the service's own refusal ends the wait)
        if (e instanceof LibraryError && e.status >= 400 && e.status < 500) { setWaiting(null); syncSession(); onError(e); return; }
      }
      timer = window.setTimeout(() => void look(), WAIT_MS);
    };
    timer = window.setTimeout(() => void look(), WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  const sendLink = async () => {
    const to = mailAddress(email);
    if (!to) { onError(new Error('Your email address is needed, to send you the sign-in link.')); return; }
    setBusy(true); onError(null);
    try { const t = await askSignIn(to); if (alive.current) setWaiting({ ticket: t.ticket, to, minutes: t.minutes }); } catch (e) { if (alive.current) { syncSession(); onError(e); } }
    if (alive.current) setBusy(false);
  };

  if (session) return (<>
    <label>Signed in</label>
    <div class="pub-who"><Icon name="partsUser" /><span class="parts-row-text"><b>{session.user.email || session.user.id}</b><span>contributor {session.user.id}</span></span></div>
  </>);
  if (waiting) return (<>
    <label>Sign in</label>
    <div class="pub-wait" role="status">
      <span class="pub-spin" />
      <span>A link is on its way to <b>{waiting.to}</b>. Open it and confirm within {waiting.minutes} minutes: this window carries on by itself.</span>
      <Tool icon="close" label="Use Another Address" onClick={() => setWaiting(null)} />
    </div>
  </>);
  return (<>
    <label for="pub-email">Your email</label>
    <div class="pub-mail">
      <input id="pub-email" type="email" autofocus value={email} maxLength={254} placeholder="for the sign-in link" disabled={!canMail || busy || disabled}
        onInput={(e) => { setEmail((e.target as HTMLInputElement).value); onError(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void sendLink(); } }} />
      <button type="button" class="btn" disabled={!canMail || busy || disabled || !email.trim()} onClick={() => void sendLink()}><Icon name="partsMail" />{busy ? 'Sending...' : 'Send the Link'}</button>
    </div>
  </>);
}

/** Sign Out, for a section's head: this browser forgets the sign-in. */
export function SignOutTool({ disabled, onOut }: { disabled?: boolean; onOut?: () => void }) {
  return librarySession.value ? <Tool icon="partsSignOut" label="Sign Out" title="Sign out: this browser forgets the sign-in" disabled={disabled} onClick={() => { leaveLibrary(); onOut?.(); }} /> : null;
}
