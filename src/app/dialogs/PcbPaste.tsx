import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { notify, units } from '../state';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { PcbPasteTool } from '../../editors/pcb/PcbPasteTool';
import { PickTool } from '../../editors/Editor';
import type { PcbClip } from '../../editors/clipboard';
import { arrayClip, onLayer } from '../../model/pcbTrackEdit';
import { formatCoord, mil, parseLength } from '../../core/units';
import type { Vec2 } from '../../core/geom';

const len = (v: string, u: string) => parseLength(/^\s*-?[\d.]+\s*$/.test(v) ? `${v.trim()}${u}` : v);

/**
 * Edit › Paste Special (PCB): Paste on current layer, Keep net name, and Paste Array…. OK
 * pastes as usual (the copy follows the cursor) with those applied.
 */
export function PasteSpecialDialog({ ed, clip }: { ed: PcbEditor; clip: PcbClip }) {
  const [current, setCurrent] = useState(false);
  const [keepNets, setKeepNets] = useState(true);
  const adjusted = (): PcbClip => ({
    ...clip,
    records: current ? clip.records.map((r) => ({ storage: r.storage, rec: onLayer(r.rec, ed.currentLayer) })) : clip.records,
    nets: keepNets ? clip.nets : new Map(),
  });
  const ok = () => { closeDialog(); ed.setTool(new PcbPasteTool(ed, adjusted())); };
  return (
    <Dialog title="Paste Special" width={360} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="pastespecial"
      footer={<><button class="btn" onClick={() => { closeDialog(); showDialog(PasteArrayDialog, { ed, clip: adjusted() }); }}>Paste Array...</button>
        <span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <fieldset><legend>Paste Attributes</legend>
        <label class="do-check"><input type="checkbox" checked={current} onChange={(e) => setCurrent((e.target as HTMLInputElement).checked)} />Paste on current layer</label>
        <label class="do-check"><input type="checkbox" checked={keepNets} onChange={(e) => setKeepNets((e.target as HTMLInputElement).checked)} />Keep net name</label>
      </fieldset>
    </Dialog>
  );
}

/**
 * Edit › Paste Array (PCB): Item Count, Text Increment (pad designators step on), Linear (X / Y
 * spacing: the array follows the cursor, click places it) or Circular (spacing in degrees,
 * Rotate Item to Match: click the array's centre, then where the first copy goes).
 */
export function PasteArrayDialog({ ed, clip }: { ed: PcbEditor; clip: PcbClip }) {
  const u = units.value;
  const f = (c: number) => formatCoord(c, u).replace(/[a-z]+$/, '');
  const [count, setCount] = useState('8');
  const [inc, setInc] = useState('1');
  const [kind, setKind] = useState<'linear' | 'circular'>('linear');
  const [dx, setDx] = useState(f(mil(100)));
  const [dy, setDy] = useState(f(0));
  const [angle, setAngle] = useState('45');
  const [rotate, setRotate] = useState(true);
  const ok = () => {
    const n = Math.max(1, Math.floor(Number(count) || 1)), step = Math.round(Number(inc) || 0);
    closeDialog();
    if (kind === 'linear') {
      const d = { x: Math.round(len(dx, u) ?? 0), y: Math.round(len(dy, u) ?? 0) };
      ed.setTool(new PcbPasteTool(ed, arrayClip(clip, { count: n, increment: step, d })));
      return;
    }
    const a = Number(angle) || 0;
    let centre: Vec2 | null = null;
    ed.setTool(new PickTool(ed, 'Paste Array: click the centre of the circular array', (p) => {
      if (!centre) { centre = ed.snap(p.raw); ed.status?.('Paste Array: click where the first copy goes'); return false; }
      const first = ed.snap(p.raw), d = { x: first.x - clip.ref.x, y: first.y - clip.ref.y };
      // The circle is about the clicked centre, in the copy's own coordinates
      const arr = arrayClip(clip, { count: n, increment: step, centre: { x: centre.x - d.x, y: centre.y - d.y }, angle: a, rotateItems: rotate });
      const t = new PcbPasteTool(ed, arr);
      ed.setTool(t);
      t.pointerDown({ world: first, raw: first, button: 0, shift: false, ctrl: false, alt: false });
      notify(`Paste Array: ${n} copies, ${a}° apart`);
      return false;
    }, true));
  };
  return (
    <Dialog title="Setup Paste Array" width={420} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="pastearray"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <fieldset><legend>Placement Variables</legend>
        <label class="do-row"><span>Item Count</span><input type="text" value={count} onInput={(e) => setCount((e.target as HTMLInputElement).value)} /></label>
        <label class="do-row"><span>Text Increment</span><input type="text" value={inc} onInput={(e) => setInc((e.target as HTMLInputElement).value)} /></label>
      </fieldset>
      <fieldset><legend>Array Type</legend>
        <label class="do-check"><input type="radio" name="pa-kind" checked={kind === 'circular'} onChange={() => setKind('circular')} />Circular</label>
        <label class="do-check"><input type="radio" name="pa-kind" checked={kind === 'linear'} onChange={() => setKind('linear')} />Linear</label>
      </fieldset>
      {kind === 'circular' ? <fieldset><legend>Circular Array</legend>
        <label class="do-check"><input type="checkbox" checked={rotate} onChange={(e) => setRotate((e.target as HTMLInputElement).checked)} />Rotate Item to Match</label>
        <label class="do-row"><span>Spacing (degrees)</span><input type="text" value={angle} onInput={(e) => setAngle((e.target as HTMLInputElement).value)} /></label>
      </fieldset> : <fieldset><legend>Linear Array</legend>
        <label class="do-row"><span>X-Spacing ({u})</span><input type="text" value={dx} onInput={(e) => setDx((e.target as HTMLInputElement).value)} /></label>
        <label class="do-row"><span>Y-Spacing ({u})</span><input type="text" value={dy} onInput={(e) => setDy((e.target as HTMLInputElement).value)} /></label>
      </fieldset>}
    </Dialog>
  );
}
