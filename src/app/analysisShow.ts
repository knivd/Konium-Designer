/** Which analysis has its picture on which board: one at a time, the latest shown. */
import { signal } from '@preact/signals';
import type { PcbEditor } from '../editors/pcb/PcbEditor';

export const shownBy = signal<{ ed: PcbEditor; by: 'power' | 'thermal' | 'antenna' } | null>(null);

/** An analysis takes its picture off its board (if it is the one shown there). */
export function takeOff(ed: PcbEditor, by: 'power' | 'thermal' | 'antenna'): void {
  if (shownBy.value?.ed === ed && shownBy.value.by === by) { ed.setAnalysis(null); shownBy.value = null; }
}
