/**
 * Help › Contact the Author (and About): a message to Konium's author — a question, or a request
 * to report a security problem privately — sent through konium.app, which mails it on. The author's address
 * isn't in Konium: it is kept by the service. Messages go to the author only, not with the bug
 * reports. Nothing is sent until Send; nothing is kept for later.
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { ColourIcon } from '../icons';
import { notify } from '../state';
import { APP_VERSION, online } from '../../platform/distribution';
import { sendReport } from '../../platform/report';
import { OFFLINE_NOTE, mayConnect } from '../../platform/network';
import { readLocal, writeLocal } from '../../core/storage';

const WHO = 'reportBug.who';
export const TOPICS = ['A question or a comment', 'A security problem, reported privately', 'Something else'] as const;
const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

export function ContactDialog({ topic: first }: { topic?: string }) {
  const remembered = (() => { try { return JSON.parse(readLocal(WHO) ?? '{}') as { name?: string; email?: string }; } catch { return {}; } })();
  const [name, setName] = useState(remembered.name ?? '');
  const [email, setEmail] = useState(remembered.email ?? '');
  const [topic, setTopic] = useState<string>(first ?? TOPICS[0]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const send = async () => {
    if (!validEmail(email)) { setError('Your email address is needed, to answer you.'); return false; }
    if (!text.trim()) { setError('Write your message first.'); return false; }
    if (!mayConnect('report')) { setError(`${OFFLINE_NOTE}.`); return false; }
    if (!online.value) { setError('No connection: send it when you\'re online.'); return false; }
    try { writeLocal(WHO, JSON.stringify({ name, email })); } catch { /* not kept */ }
    setBusy(true); setError('');
    const res = await sendReport({ kind: 'contact', topic, name: name.trim(), email: email.trim(), text: text.trim(), version: APP_VERSION, diagnostics: '', files: [] });
    setBusy(false);
    if (res.ok) { closeDialog(); notify('Message sent. Thank you!'); return false; }
    setError(`Not sent: ${res.error}.`);
    return false;
  };

  return (
    <Dialog title="Contact the Author" width={520} onClose={closeDialog} class="reportbug contact"
      footer={<>
        <span class="spacer" />
        <button class="btn default" disabled={busy} onClick={() => void send()}>{busy ? 'Sending...' : 'Send'}</button>
        <button class="btn" disabled={busy} onClick={closeDialog}>Cancel</button>
      </>}>
      <div class="rb-intro">
        <ColourIcon name="contactAuthor" size={32} />
        <p>A message to Konium Designer's author: a question, a comment, or a security problem you would rather report privately than in public. It goes through konium.app to the author only, and your address is used only to answer you.</p>
      </div>
      <div class="rb-row"><label for="ct-name">Your name</label><input id="ct-name" type="text" value={name} maxLength={100} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="optional" /></div>
      <div class="rb-row"><label for="ct-email">Your email</label><input id="ct-email" type="email" value={email} maxLength={254} onInput={(e) => { setEmail((e.target as HTMLInputElement).value); if (error) setError(''); }} placeholder="to answer you" /></div>
      <div class="rb-row"><label for="ct-topic">About</label>
        <select id="ct-topic" value={topic} onChange={(e) => setTopic((e.target as HTMLSelectElement).value)}>{TOPICS.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
      <label class="rb-label" for="ct-text">Your message</label>
      <textarea id="ct-text" autofocus rows={8} value={text} maxLength={20000} onInput={(e) => { setText((e.target as HTMLTextAreaElement).value); if (error) setError(''); }}
        placeholder={topic === TOPICS[1] ? 'What you found, where (a file, a service, an address), and how to see it happen' : ''} />
      <input type="text" name="website" class="rb-trap" tabIndex={-1} autocomplete="off" aria-hidden="true" />
      {error && <p class="rb-error" role="alert">{error}</p>}
    </Dialog>
  );
}
