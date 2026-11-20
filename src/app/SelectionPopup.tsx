/**
 * Preferences › PCB Editor › General › Display popup selection dialog: after a click on
 * overlapping objects, a small list of them by the cursor; a click on one selects it. A key or a
 * click elsewhere closes it and goes on as it would have (it takes no keys of its own).
 *
 * The wheel does not close it (26.190): a wheel that is still turning after a zoom, as a
 * free-spinning wheel or a touchpad's glide is for a second or so, closed the list the moment
 * it came, so that for a click made straight after zooming it was never seen. What it lists is
 * the objects themselves, whatever the view does under it. Nor does a modifier key on its own.
 */
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { ownerOf, uiWin, useWin } from './docWindows';

export const selectionPopup = signal<{ items: { label: string; pick: () => void }[]; x: number; y: number } | null>(null);
/** The window it shows in: the one the click was in. */
let popupWin: Window | null = null;
selectionPopup.subscribe((v) => { popupWin = v ? uiWin.peek() : null; });

export function SelectionPopup() {
  const st = selectionPopup.value;
  const window = useWin();
  const mine = !!st && ownerOf(popupWin) === window;
  useEffect(() => {
    if (!mine) return;
    if (!st) return;
    const close = () => { selectionPopup.value = null; };
    const down = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.selpopup')) close(); };
    const key = (e: KeyboardEvent) => { if (!['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock'].includes(e.key)) close(); };
    window.addEventListener('keydown', key, true);
    window.addEventListener('mousedown', down, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('mousedown', down, true); };
  }, [st, mine]);
  if (!st || !mine) return null;
  const x = Math.min(st.x, window.innerWidth - 260), y = Math.min(st.y, window.innerHeight - 24 * st.items.length - 8);
  return (
    <div class="menu-popup selpopup" role="menu" aria-label="Choose an object" style={{ left: `${Math.max(4, x)}px`, top: `${Math.max(4, y)}px` }}>
      {st.items.map((it, i) => (
        <button key={i} type="button" role="menuitem" class="menu-item" onClick={() => { selectionPopup.value = null; it.pick(); }}>
          <span class="menu-gutter" /><span class="menu-label">{it.label}</span><span />
        </button>
      ))}
    </div>
  );
}
