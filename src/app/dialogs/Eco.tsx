import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { saveFileAs } from '../../platform/fs';

/**
 * Engineering Change Order, as Altium runs every cross-document change (annotation, Update PCB,
 * Update Schematics): a list of modifications, Validate Changes checks each, Execute Changes
 * applies the valid ones, the Status columns record what happened.
 */
export interface EcoChange {
  group: string;                       // "Annotate Component", "Add Components", "Add Nets" …
  action: string;                      // "Modify", "Add", "Remove"
  object: string;                      // "C? -> C1"
  doc: string;                         // affected document
  enabled: boolean;
  validate(): string | null;           // null = ok, else the reason it can't be done
  execute(): void;
}

interface Status { check?: boolean; done?: boolean; message?: string }

/** `transact` wraps the whole execution, so a board update is one undo step there. */
export function EcoDialog({ title = 'Engineering Change Order', changes, onExecuted, transact }: {
  title?: string; changes: EcoChange[]; onExecuted?: () => void; transact?: (run: () => void) => void;
}) {
  const [rows, setRows] = useState(() => changes.map((c) => ({ c, enabled: c.enabled, st: {} as Status })));
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [executed, setExecuted] = useState(false);
  const validate = () => setRows((rs) => rs.map((r) => {
    if (!r.enabled) return { ...r, st: {} };
    const why = r.c.validate();
    return { ...r, st: { check: !why, message: why ?? undefined } };
  }));
  const execute = () => {
    let next = rows;
    const run = () => {
      next = rows.map((r) => {
        if (!r.enabled || r.st.done) return r;
        const why = r.c.validate();
        if (why) return { ...r, st: { check: false, done: false, message: why } };
        try { r.c.execute(); return { ...r, st: { check: true, done: true } }; } catch (e) { return { ...r, st: { check: true, done: false, message: (e as Error).message } }; }
      });
    };
    if (transact) transact(run); else run();
    setRows(next);
    setExecuted(true);
    onExecuted?.();
  };
  const report = () => {
    const lines = [`${title}`, '', 'Enable\tAction\tAffected Object\tAffected Document\tCheck\tDone\tMessage'];
    for (const r of rows) lines.push([r.enabled ? 'Y' : '', `${r.c.group}: ${r.c.action}`, r.c.object, r.c.doc, r.st.check === undefined ? '' : r.st.check ? 'OK' : 'Error', r.st.done ? 'Done' : '', r.st.message ?? ''].join('\t'));
    void saveFileAs('ECO Report.txt', new TextEncoder().encode(lines.join('\r\n') + '\r\n'));
  };
  const groups = [...new Set(rows.map((r) => r.c.group))];
  const shown = rows.filter((r) => !errorsOnly || r.st.check === false || (r.st.done === false && r.st.message));
  const icon = (st: Status, key: 'check' | 'done') => {
    const v = st[key];
    if (v === undefined) return null;
    return v ? <span class="eco-ok" title="OK">✓</span> : <span class="eco-err" title={st.message}>✗</span>;
  };
  return (
    <Dialog title={title} width={1000} height={600} onClose={closeDialog} class="eco"
      footer={<>
        <button class="btn" onClick={validate}>Validate Changes</button>
        <button class="btn default" onClick={execute} disabled={!rows.some((r) => r.enabled && !r.st.done)}>Execute Changes</button>
        <button class="btn" onClick={report}>Report Changes...</button>
        <label class="eco-only"><input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly((e.target as HTMLInputElement).checked)} />Only Show Errors</label>
        <span class="spacer" />
        <button class="btn" onClick={closeDialog}>Close</button>
      </>}>
      <div class="eco-head">
        <span>Modifications</span><span>Status</span>
      </div>
      <div class="grid eco-grid" style={{ '--cols': '52px 84px minmax(160px, 1.4fr) 28px minmax(120px, 1fr) 46px 46px minmax(140px, 1fr)' } as Record<string, string>}>
        <div class="grid-row grid-head"><span>Enable</span><span>Action</span><span>Affected Object</span><span /><span>Affected Document</span><span>Check</span><span>Done</span><span>Message</span></div>
        <div class="grid-body">
          {!rows.length && <p class="grid-empty">No changes. The documents already agree.</p>}
          {groups.map((g) => {
            const list = shown.filter((r) => r.c.group === g);
            if (!list.length) return null;
            const all = rows.filter((r) => r.c.group === g);
            const on = all.every((r) => r.enabled);
            return (
              <div key={g}>
                <div class="grid-row eco-group">
                  <span><input type="checkbox" checked={on} onChange={() => setRows((rs) => rs.map((r) => (r.c.group === g ? { ...r, enabled: !on } : r)))} /></span>
                  <span class="eco-group-name">{g}({all.length})</span>
                </div>
                {list.map((r) => {
                  const i = rows.indexOf(r);
                  return (
                    <div key={i} class={`grid-row${r.st.check === false ? ' eco-bad' : ''}`}>
                      <span><input type="checkbox" checked={r.enabled} disabled={!!r.st.done} onChange={() => setRows((rs) => rs.map((x, k) => (k === i ? { ...x, enabled: !x.enabled } : x)))} /></span>
                      <span>{r.c.action}</span>
                      <span title={r.c.object}>{r.c.object}</span>
                      <span class="muted">To</span>
                      <span>{r.c.doc}</span>
                      <span class="al-center">{icon(r.st, 'check')}</span>
                      <span class="al-center">{icon(r.st, 'done')}</span>
                      <span title={r.st.message}>{r.st.message ?? ''}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {executed && <p class="muted small">{transact ? 'Executed. Ctrl+Z in the affected document undoes the whole change order.' : 'Executed. Undo works per document (Ctrl+Z in each affected document).'}</p>}
    </Dialog>
  );
}
