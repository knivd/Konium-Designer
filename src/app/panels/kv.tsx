/**
 * The pieces Konium's own panels share (the planning panels, Tools › Parts, the analysis panels
 * and the calculators), so that they look and work alike: a section's head with its tools as
 * icons at its right, and a tool as an icon whose name is its tooltip. docs/ARCHITECTURE.md,
 * "Interface standards", has the rules these follow.
 */
import type { ComponentChildren } from 'preact';
import { Icon } from '../icons';

/** A section's head: its name and, at its right, its tools. */
export function SectionHead({ title, children }: { title: string; children?: ComponentChildren }) {
  return <div class="kv-head"><h4>{title}</h4><span class="kv-tools">{children}</span></div>;
}

/** A tool as an icon: `label` is what it is called (its tooltip unless `title` says more, and its name to a screen reader). */
export function Tool({ icon, label, title, disabled, onClick }: { icon: string; label: string; title?: string; disabled?: boolean; onClick: () => void }) {
  return <button class="ex-icon-btn" title={title ?? label} aria-label={label} disabled={disabled} onClick={onClick}><Icon name={icon} /></button>;
}

/** A panel with nothing to show yet: what is missing, why, and the way in (a button or two). */
export function EmptyState({ icon, title, children, action }: { icon: string; title: string; children?: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class="parts-empty kv-empty">
      <Icon name={icon} size={22} />
      <b>{title}</b>
      <span>{children}</span>
      {action && <div class="parts-empty-actions">{action}</div>}
    </div>
  );
}

/** The same for a panel that needs a model while AI is off: `sends` says when anything is first sent. */
export function AiOff({ sends, onOpen }: { sends: string; onOpen: () => void }) {
  return (
    <EmptyState icon="kvAiOff" title="AI is off" action={<button class="btn" onClick={onOpen}><Icon name="kvPrefs" />Open Preferences...</button>}>
      Choose how Konium Designer reaches a model (the Konium service, your own key, or a model on your computer) in Preferences › System › AI. {sends}
    </EmptyState>
  );
}

