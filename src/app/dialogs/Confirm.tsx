import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';

/** A Yes / No question, as Altium's Confirm and Information boxes ask before batch edits. */
export function ConfirmDialog({ title = 'Confirm', message, detail, onYes, yes: yesLabel = 'Yes', no: noLabel = 'No' }: { title?: string; message: string; detail?: string; onYes: () => void; yes?: string; no?: string }) {
  const yes = () => { closeDialog(); onYes(); };
  return (
    <Dialog title={title} width={420} onClose={closeDialog} onAccept={() => { yes(); return false; }} class="confirm"
      footer={<><span class="spacer" /><button class="btn default" onClick={yes}>{yesLabel}</button><button class="btn" onClick={closeDialog}>{noLabel}</button></>}>
      <div class="confirm-body">
        <span class="confirm-icon" aria-hidden="true">?</span>
        <div><p>{message}</p>{detail && <p class="muted small">{detail}</p>}</div>
      </div>
    </Dialog>
  );
}

/** Altium's Information box: lines of text and OK (Measure Distance reports this way). */
export function InfoDialog({ title = 'Information', lines }: { title?: string; lines: string[] }) {
  return (
    <Dialog title={title} width={380} onClose={closeDialog} onAccept={() => { closeDialog(); return false; }} class="confirm"
      footer={<><span class="spacer" /><button class="btn default" onClick={closeDialog}>OK</button></>}>
      <div class="confirm-body">
        <span class="confirm-icon info" aria-hidden="true">i</span>
        <div class="info-lines">{lines.map((l, i) => <p key={i}>{l}</p>)}</div>
      </div>
    </Dialog>
  );
}

/** A few named fields and OK (Jump › Component, New Location …), as Altium's small input boxes. */
export function PromptDialog({ title, fields, onOk }: { title: string; fields: { label: string; value?: string }[]; onOk: (values: string[]) => void }) {
  const [vals, setVals] = useState(() => fields.map((f) => f.value ?? ''));
  const ok = () => { closeDialog(); onOk(vals); };
  return (
    <Dialog title={title} width={340} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="prompt"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="prompt-body">
        {fields.map((f, i) => (
          <label key={f.label}>{f.label}
            <input type="text" value={vals[i]} autofocus={i === 0} onInput={(e) => { const v = vals.slice(); v[i] = (e.target as HTMLInputElement).value; setVals(v); }} />
          </label>
        ))}
      </div>
    </Dialog>
  );
}

/** Save changes to X? — Yes saves, No discards, Cancel (or Escape) keeps the document open. */
export function SaveChangesDialog({ name, onAnswer }: { name: string; onAnswer: (a: 'yes' | 'no' | 'cancel') => void }) {
  const done = (a: 'yes' | 'no' | 'cancel') => { closeDialog(); onAnswer(a); };
  return (
    <Dialog title="Confirm" width={420} onClose={() => done('cancel')} onAccept={() => { done('yes'); return false; }} class="confirm savechanges"
      footer={<><span class="spacer" /><button class="btn default" onClick={() => done('yes')}>Yes</button><button class="btn" onClick={() => done('no')}>No</button><button class="btn" onClick={() => done('cancel')}>Cancel</button></>}>
      <div class="confirm-body">
        <span class="confirm-icon" aria-hidden="true">?</span>
        <div><p>Save changes to {name}?</p></div>
      </div>
    </Dialog>
  );
}
