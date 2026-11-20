import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { formatCoord, parseLength, type DisplayUnit } from '../../core/units';
import { L, layerName, mechLayer, type LayerId } from '../../model/layers';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';

/**
 * Design › Board Shape › Create Primitives From Board Shape: the outline as tracks and arcs on
 * a layer (Altium's "Line/Arc Primitives From Board Shape").
 */
export function BoardPrimsDialog({ ed, units, onOk }: { ed: PcbEditor; units: DisplayUnit; onOk: (layer: LayerId, width: number) => void }) {
  const layers = [...new Set([...Array.from({ length: 16 }, (_, i) => mechLayer(i + 1)), L.KEEPOUT, L.TOP_OVERLAY, L.BOTTOM_OVERLAY, ...ed.layers()])];
  const [layer, setLayer] = useState<LayerId>(mechLayer(1));
  const [width, setWidth] = useState(formatCoord(50_000, units));
  const w = parseLength(/^\s*[-\d.]+\s*$/.test(width) ? `${width}${units}` : width);
  const ok = () => { if (w === undefined || w <= 0) return; closeDialog(); onOk(layer, w); };
  return (
    <Dialog title="Line/Arc Primitives From Board Shape" width={380} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="prompt"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok} disabled={w === undefined || w <= 0}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="prompt-body">
        <label>Width<input type="text" value={width} autofocus onInput={(e) => setWidth((e.target as HTMLInputElement).value)} /></label>
        <label>Layer
          <select value={layer} onChange={(e) => setLayer(Number((e.target as HTMLSelectElement).value))}>
            {layers.map((l) => <option key={l} value={l}>{ed.doc.board.layerNames.get(l) ?? layerName(l)}</option>)}
          </select>
        </label>
      </div>
    </Dialog>
  );
}
