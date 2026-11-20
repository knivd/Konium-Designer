import { activeId, docs, notify } from '../state';
import { placePart } from '../placeCommands';
import { whenMounted } from '../project';
import { partRecords } from '../../model/schPlace';
import type { SchLibEditor } from '../../editors/sch/SchLibEditor';
import type { LibSymbol } from '../../formats/altium/schlib';

/**
 * SCH Library panel › Place: the shown component onto a schematic — the project's open sheet
 * (or any open sheet) comes forward with the part on the cursor.
 */
export function PlacePartFromLibrary({ ed, symbols }: { ed: SchLibEditor; symbols: () => LibSymbol[] }) {
  const place = () => {
    const self = docs.value.find((d) => d.editor === ed);
    const sheets = docs.value.filter((d) => d.doc.kind === 'SchDoc' && d.editor);
    const target = sheets.find((d) => self && d.projectId === self.projectId) ?? sheets[0];
    if (!target?.editor) { notify('Open a schematic sheet to place the part on', 'error'); return; }
    const sym = symbols()[ed.current];
    if (!sym) return;
    activeId.value = target.id;
    whenMounted(target.editor, () => placePart({ items: partRecords(sym, ed.lib.name), symbol: sym, library: ed.lib.name }));
  };
  return <button class="btn" onClick={place}>Place</button>;
}
