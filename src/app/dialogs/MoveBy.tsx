import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { parseLength, type DisplayUnit } from '../../core/units';
import type { Vec2 } from '../../core/geom';

/** Edit › Move › Move Selection by X, Y (M, X): offsets in the current units (or with a unit). */
export function MoveByDialog({ units: u, onOk }: { units: DisplayUnit; onOk: (d: Vec2) => void }) {
  const [x, setX] = useState('0');
  const [y, setY] = useState('0');
  const parse = (t: string) => { const s = t.trim(); return parseLength(/^-?[0-9]*\.?[0-9]+$/.test(s) ? `${s}${u}` : s); };
  const dx = parse(x), dy = parse(y);
  const ok = () => { if (dx === undefined || dy === undefined) return false; closeDialog(); if (dx || dy) onOk({ x: dx, y: dy }); return true; };
  return (
    <Dialog title="Get X/Y Offsets" width={340} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok} disabled={dx === undefined || dy === undefined}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="fp-form">
        <label>X Offset<input type="text" value={x} autoFocus onInput={(e) => setX((e.target as HTMLInputElement).value)} /></label>
        <label>Y Offset<input type="text" value={y} onInput={(e) => setY((e.target as HTMLInputElement).value)} /></label>
        <p class="small muted">In {u} unless you type a unit (mil, mm, in).</p>
      </div>
    </Dialog>
  );
}
