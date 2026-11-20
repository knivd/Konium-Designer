/**
 * Clipboard (View › Panels › System): what was copied, newest first; a click makes an entry the
 * one Paste takes and pastes it into the document in front (text from another application as a
 * string on a board). Clear All empties the list.
 */
import { locale } from '../../core/locale';
import { clipHistory, clearHistory, useEntry, type ClipEntry } from '../clipHistory';
import { commands } from '../../core/commands';
import { active, activeScope, notify } from '../state';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { placeStringTool } from '../../editors/pcb/PcbPlaceTools';
import { settings } from '../../core/settings';

const fam = (k?: string) => (k === 'pcb' || k === 'pcblib' ? 'pcb' : k === 'sch' || k === 'schlib' ? 'sch' : k);

function paste(e: ClipEntry): void {
  const ed = active.value?.editor;
  if (e.text !== undefined) {
    if (!(ed instanceof PcbEditor)) { notify('Text from another application pastes onto a board', 'error'); return; }
    ed.stringTemplate.text = e.text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? e.text;
    ed.setTool(placeStringTool(ed));
    return;
  }
  if (!e.clip || fam(e.clip.kind) !== fam(activeScope.value)) { notify(`Paste it into a ${e.clip?.kind === 'pcb' ? 'board' : e.clip?.kind === 'sch' ? 'schematic' : 'CAM document'}`, 'error'); return; }
  useEntry(e);
  void commands.run('edit.paste', activeScope.value);
}

export function ClipboardPanel() {
  const list = clipHistory.value;
  return (
    <section class="panel docked clipboard" aria-label="Clipboard">
      <div class="nav-bar">
        <button class="btn" disabled={!list.length} onClick={clearHistory}>Clear All</button>
        <span class="muted small">{settings.clipboardAppOnly ? 'Copies made in Konium Designer' : 'Copies made in Konium Designer and text from other applications'}</span>
      </div>
      <div class="panel-body">
        {list.length ? (
          <ul class="clip-list">
            {list.map((e) => (
              <li key={e.id}>
                <button class="clip-entry" title="Paste it" onClick={() => paste(e)}>
                  <span class="clip-what">{e.what}</span>
                  <span class="clip-from muted small">{e.from}{e.from ? ' · ' : ''}{new Date(e.at).toLocaleTimeString(locale())}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p class="panel-empty">Nothing copied yet.</p>}
      </div>
    </section>
  );
}
