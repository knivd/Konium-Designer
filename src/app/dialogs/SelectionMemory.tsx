import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { memoryAction, memorySize, type MemoryAction } from '../selectionMemory';
import type { Editor } from '../../editors/Editor';

/**
 * Selection Memory (Ctrl+Q on a board): the eight memories, each with Store (STO), Store Plus,
 * Recall (RCL), Recall Plus, Apply (select and zoom) and Clear.
 */
export function SelectionMemoryDialog({ ed }: { ed: Editor }) {
  const [, setN] = useState(0);
  const act = (n: number, a: MemoryAction) => { memoryAction(ed, n, a); ed.invalidateOverlay(); setN((x) => x + 1); };
  const b = (n: number, a: MemoryAction, label: string, title: string, disabled = false) => <button class="btn" title={title} disabled={disabled} onClick={() => act(n, a)}>{label}</button>;
  return (
    <Dialog title="Selection Memory" width={560} onClose={closeDialog} class="selmem"
      footer={<><span class="muted small">{ed.selection.size} selected now</span><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <div class="sm-grid">
        {Array.from({ length: 8 }, (_, i) => {
          const n = i + 1, size = memorySize(ed, n), none = !ed.selection.size;
          return (
            <div class="sm-row" key={n}>
              <span class="sm-name">{n}</span><span class="sm-size">{size ? `${size} object${size === 1 ? '' : 's'}` : 'empty'}</span>
              {b(n, 'store', 'STO', 'Store the selection', none)}{b(n, 'storePlus', 'STO+', 'Add the selection', none)}
              {b(n, 'recall', 'RCL', 'Select what is stored', !size)}{b(n, 'recallPlus', 'RCL+', 'Add what is stored to the selection', !size)}
              {b(n, 'apply', 'Apply', 'Select what is stored and zoom to it', !size)}{b(n, 'clear', 'Clear', 'Empty this memory', !size)}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
