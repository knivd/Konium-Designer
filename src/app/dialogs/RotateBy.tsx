import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';

/** Edit › Move › Rotate Selection (PCB): rotation angle in degrees, anticlockwise. */
export function RotateByDialog({ step, onOk }: { step: number; onOk: (deg: number) => void }) {
  const [v, setV] = useState(String(step));
  const deg = /^\s*-?[0-9]*\.?[0-9]+\s*$/.test(v) ? Number(v) : undefined;
  const ok = () => { if (deg === undefined) return; closeDialog(); if (deg % 360) onOk(deg); };
  return (
    <Dialog title="Rotation Angle (Degrees)" width={300} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok} disabled={deg === undefined}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="fp-form">
        <label>Angle<input type="text" value={v} autoFocus onInput={(e) => setV((e.target as HTMLInputElement).value)} /></label>
      </div>
    </Dialog>
  );
}
