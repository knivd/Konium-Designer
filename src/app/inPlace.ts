/**
 * Edit › Edit In-Place (F2): the selected text's own words edited where they are drawn — net
 * labels, text strings, parameters, designators, power port and port names, sheet entries,
 * sheet symbol names. Enter keeps the change (one undo step), Esc or clicking away drops it.
 */
import type { SchEditor } from '../editors/sch/SchEditor';
import { setProps } from '../model/schEdit';
import type { SchObject } from '../model/sch';
import { notify } from './state';

/** Which property holds an object's editable text. */
export function inPlaceKey(o: SchObject | undefined): 'TEXT' | 'NAME' | null {
  if (!o) return null;
  if (o.kind === 'text' || o.kind === 'power') return 'TEXT';
  if (o.kind === 'port' || o.kind === 'sheetentry' || o.kind === 'pin') return 'NAME';
  return null;
}

export function editInPlace(ed: SchEditor, key = [...ed.selection][0]): boolean {
  const o = key ? ed.doc.objects[parseInt(key.slice(1), 10)] : undefined;
  const prop = inPlaceKey(o);
  const vp = ed.viewport;
  if (!o || !prop || !vp) { notify('Select a text, net label, port or power port to edit in place', 'error'); return false; }
  const bag = ed.doc.records[o.index + 1]?.bag;
  if (!bag) return false;
  const box = ed.boundsOf([key!]);
  const host = vp.host.getBoundingClientRect();
  const a = vp.cam.toScreen({ x: box.minX, y: box.maxY }), b = vp.cam.toScreen({ x: box.maxX, y: box.minY });
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inplace-edit';
  input.value = bag.get(prop) ?? '';
  input.setAttribute('aria-label', 'Edit in place');
  const h = Math.max(18, Math.abs(b.y - a.y) + 6);
  Object.assign(input.style, { left: `${host.left + Math.min(a.x, b.x) - 3}px`, top: `${host.top + Math.min(a.y, b.y) - 3}px`, width: `${Math.max(80, Math.abs(b.x - a.x) + 40)}px`, height: `${h}px`, fontSize: `${Math.max(11, Math.min(28, h - 8))}px` });
  document.body.appendChild(input);
  input.focus(); input.select();
  ed.startFocus([o.index], 'InPlace');
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    ed.endFocus();
    const v = input.value;
    input.remove();
    if (keep && v !== (bag.get(prop) ?? '')) {
      ed.undo.transact('Edit in place', (tx) => tx.add(setProps(ed.doc, o.index, { [prop]: v })));
      ed.invalidate();
    }
    vp.host.focus?.();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(false));
  return true;
}
