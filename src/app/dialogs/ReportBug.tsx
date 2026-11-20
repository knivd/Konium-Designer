/**
 * Help › Report a Bug (and the Home page): what happened, who to answer (optional), files to
 * show it (optional: the open document with one tick) and the diagnostics, sent to Konium's
 * developer through konium.app. Without a connection the report waits and goes later.
 */
import { useRef, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { ColourIcon } from '../icons';
import { active, docs, isDocDirty, messages, notify } from '../state';
import { canSave, save } from '../../formats/registry';
import { APP_VERSION, online } from '../../platform/distribution';
import { MAX_ATTACH, MAX_BULK, MAX_PLAIN, keepReport, packFiles, sendReport, type Report, type ReportFile } from '../../platform/report';
import { mayConnect } from '../../platform/network';
import { diagnosticsText } from '../diagnostics';
import { readLocal, writeLocal } from '../../core/storage';

const WHO = 'reportBug.who';
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`);

/** The active document as it is now (edits included), to attach. */
function activeFile(): ReportFile | null {
  const od = active.value;
  if (!od) return null;
  let bytes = od.bytes;
  if (canSave(od.doc)) { try { bytes = od.editor ? od.editor.withToolSuspended(() => save(od.doc)) : save(od.doc); } catch { /* as opened */ } }
  return bytes ? { name: od.name, type: 'application/octet-stream', bytes } : null;
}

export function ReportBugDialog() {
  const remembered = (() => { try { return JSON.parse(readLocal(WHO) ?? '{}') as { name?: string; email?: string }; } catch { return {}; } })();
  const [name, setName] = useState(remembered.name ?? '');
  const [email, setEmail] = useState(remembered.email ?? '');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<ReportFile[]>([]);
  const od = active.value;
  const [withDoc, setWithDoc] = useState(false);
  const [withDiag, setWithDiag] = useState(true);
  const [showDiag, setShowDiag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const diag = () => diagnosticsText({
    docs: docs.value.map((d) => ({ name: d.name, kind: d.doc.kind, dirty: isDocDirty(d) })),
    messages: messages.value.map((m) => ({ level: m.level, doc: m.doc, message: m.message })),
  });
  const docFile = withDoc ? activeFile() : null;
  const all = docFile ? [docFile, ...files] : files;
  const total = all.reduce((n, f) => n + f.bytes.length, 0);
  const tooBig = total > MAX_ATTACH;

  const add = async (list: FileList | null) => {
    if (!list) return;
    const more = await Promise.all([...list].map(async (f) => ({ name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })));
    setFiles([...files, ...more]);
  };

  const send = async () => {
    if (!text.trim()) { setError('Say what happened first.'); return false; }
    if (tooBig) { setError(`The attachments come to ${kb(total)}: ${kb(MAX_ATTACH)} together at most.`); return false; }
    try { writeLocal(WHO, JSON.stringify({ name, email })); } catch { /* not kept */ }
    let r: Report = { name: name.trim(), email: email.trim(), text: text.trim(), version: APP_VERSION, diagnostics: withDiag ? diag() : '', files: all };
    setBusy(true); setError(''); setStep('');
    // Large attachments go zipped, in parts after the report itself
    if (total > MAX_PLAIN) {
      setStep('Compressing the attachments...');
      try {
        const bulk = await packFiles(all);
        if (bulk.bytes.length > MAX_BULK) { setBusy(false); setError(`The attachments come to ${kb(bulk.bytes.length)} zipped: ${kb(MAX_BULK)} at most. Leave one out, or say in the text where they can be had.`); return false; }
        r = { ...r, files: [], bulk };
      } catch (e) { setBusy(false); setError(`The attachments couldn't be compressed (${(e as Error).message}).`); return false; }
      setStep('Sending the report...');
    }
    if (!mayConnect('report')) {
      try { await keepReport(r); closeDialog(); notify('Offline is on: the report is kept, and goes once Offline is switched off'); } catch { setError('Offline is on, and this browser won\'t keep the report: switch Offline off to send it.'); }
      setBusy(false);
      return false;
    }
    if (!online.value) {
      try { await keepReport(r); closeDialog(); notify('No connection: the report is kept and goes when you\'re online'); } catch { setError('No connection, and this browser won\'t keep the report: try again when you\'re online.'); }
      setBusy(false);
      return false;
    }
    const res = await sendReport(r, undefined, setStep);
    setBusy(false);
    if (res.ok) {
      closeDialog();
      if (res.note) notify(`${res.note[0]!.toUpperCase()}${res.note.slice(1)}.`, 'error', 15000); else notify('Report sent. Thank you!');
      return false;
    }
    if (res.retry) {
      try { await keepReport(r); closeDialog(); notify(`${res.error[0]!.toUpperCase()}${res.error.slice(1)}: the report is kept and goes later`); return false; } catch { /* below */ }
    }
    setError(`Not sent: ${res.error}.`);
    return false;
  };

  return (
    <Dialog title="Report a Bug" width={560} onClose={closeDialog} class="reportbug"
      footer={<>
        <span class="small muted">{busy && step ? step : all.length ? `${all.length} file${all.length > 1 ? 's' : ''}, ${kb(total)}${total > MAX_PLAIN ? ': zipped before they go' : ''}` : ''}</span>
        <span class="spacer" />
        <button class="btn default" disabled={busy} onClick={() => void send()}>{busy ? 'Sending...' : 'Send'}</button>
        <button class="btn" disabled={busy} onClick={closeDialog}>Cancel</button>
      </>}>
      <div class="rb-intro">
        <ColourIcon name="bug" size={32} />
        <p>Tell Konium Designer's developer what went wrong. The report goes through konium.app to the developer and to the AI assistant that helps build Konium Designer (Claude); your name and address are optional and only used to answer you.</p>
      </div>
      <div class="rb-row"><label for="rb-name">Your name</label><input id="rb-name" type="text" value={name} maxLength={100} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="optional" /></div>
      <div class="rb-row"><label for="rb-email">Your email</label><input id="rb-email" type="email" value={email} maxLength={254} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} placeholder="optional, to hear back" /></div>
      <label class="rb-label" for="rb-text">What happened, and what you expected</label>
      <textarea id="rb-text" autofocus rows={7} value={text} maxLength={20000} onInput={(e) => { setText((e.target as HTMLTextAreaElement).value); if (error) setError(''); }}
        placeholder="The steps that lead to it help most: open …, click …, then …" />
      <input type="text" name="website" class="rb-trap" tabIndex={-1} autocomplete="off" aria-hidden="true" />
      <div class="rb-files"
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); void add(e.dataTransfer?.files ?? null); }}>
        <div class="rb-files-head">
          <span>Attachments</span>
          <button class="btn" onClick={() => picker.current?.click()}>Add files...</button>
          <input ref={picker} type="file" multiple hidden onChange={(e) => { void add((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ''; }} />
        </div>
        {od && <label class="rb-check"><input type="checkbox" checked={withDoc} onChange={(e) => setWithDoc((e.target as HTMLInputElement).checked)} /> Attach the active document, {od.name}, as it is now</label>}
        {files.length ? (
          <ul class="rb-list">
            {files.map((f, i) => (
              <li key={`${f.name}${i}`}><span>{f.name}</span><span class="muted">{kb(f.bytes.length)}</span>
                <button class="home-forget" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => setFiles(files.filter((_, k) => k !== i))}>×</button></li>
            ))}
          </ul>
        ) : <p class="small muted">Screenshots or files that show it: drop them here. Over 8 MB together they are zipped before they go (40 MB zipped at most; board files come to a quarter of their size or less). Attached files leave your computer, for this report only.</p>}
      </div>
      <label class="rb-check"><input type="checkbox" checked={withDiag} onChange={(e) => setWithDiag((e.target as HTMLInputElement).checked)} /> Include diagnostics (version, browser, open documents' names, recent errors, saves and messages)</label>
      {withDiag && <button class="link small" onClick={() => setShowDiag(!showDiag)}>{showDiag ? 'Hide what they say' : 'Show what they say'}</button>}
      {withDiag && showDiag && <pre class="rb-diag">{diag()}</pre>}
      {tooBig && <p class="rb-error">The attachments come to {kb(total)}: {kb(MAX_ATTACH)} together at most.</p>}
      {error && <p class="rb-error" role="alert">{error}</p>}
    </Dialog>
  );
}
