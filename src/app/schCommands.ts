/**
 * Schematic editor commands for its dialogs: Design › Document Options (D, O) and the
 * right-click Options › Document Options / Document Parameters / Sheet; Edit › Find Text
 * (Ctrl+F), Replace Text (Ctrl+H), Find Next (F3).
 */
import type { Command, Scope } from '../core/commands';
import { active } from './state';
import { showDialog } from './dialogs';
import { DocOptionsDialog } from './dialogs/DocOptions';
import { FindTextDialog, findNext } from './dialogs/FindText';
import { SchEditor } from '../editors/sch/SchEditor';
import { SchLibEditor } from '../editors/sch/SchLibEditor';
import { LibOptionsDialog } from './dialogs/LibOptions';

const sheet = () => { const e = active.value?.editor; return e instanceof SchEditor && !e.libraryMode ? e : null; };
const SCH: Scope[] = ['sch'];
const anySch = () => active.value?.editor instanceof SchEditor;

export function schCommands(): Command[] {
  const open = (tab: 'sheet' | 'parameters') => () => {
    const l = active.value?.editor;
    if (l instanceof SchLibEditor) { showDialog(LibOptionsDialog, { ed: l }); return; }
    const e = sheet();
    if (e) showDialog(DocOptionsDialog, { ed: e, tab });
  };
  const has = () => !!sheet();
  const hasAny = () => !!sheet() || active.value?.editor instanceof SchLibEditor;
  return [
    { id: 'ad:Sch:DocumentPreferences', label: 'Document Options...', scopes: SCH, run: open('sheet'), enabled: has },
    { id: 'ad:WorkspaceManager:ConfigureOptionsActiveDocument', label: 'Document Options...', run: open('sheet'), enabled: hasAny },
    { id: 'ad:Sch:DocumentPreferencesSchDocumentOptions', label: 'Document Options...', scopes: SCH, run: open('sheet'), enabled: hasAny },
    { id: 'ad:Sch:DocumentPreferencesSchDocumentParameters', label: 'Document Parameters...', scopes: SCH, run: open('parameters'), enabled: has },
    { id: 'ad:Sch:DocumentPreferencesSchSheetOptions', label: 'Sheet...', scopes: SCH, run: open('sheet'), enabled: has },
    { id: 'ad:Sch:FindText', label: 'Find Text...', scopes: ['sch', 'schlib'], run: () => showDialog(FindTextDialog, { replace: false }), enabled: anySch },
    { id: 'ad:Sch:FindAndReplaceText', label: 'Replace Text...', scopes: ['sch', 'schlib'], run: () => showDialog(FindTextDialog, { replace: true }), enabled: anySch },
    { id: 'ad:Sch:FindNextText', label: 'Find Next', scopes: ['sch', 'schlib'], run: () => findNext(), enabled: anySch },
  ];
}
