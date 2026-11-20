import { useMemo, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { notify, units } from '../state';
import { pageSetup, paperMm, printPages } from '../print';
import { PageSetupDialog } from './Print';
import { printJobPages } from '../../render/pcbPrint';
import { JOB_TITLES, printout, setJob, usedLayers, type PrintJob, type Printout } from '../../model/printouts';
import { L, layerName, type LayerId } from '../../model/layers';
import { formatCoord, parseLengthIn } from '../../core/units';
import type { PcbDocument } from '../../model/pcb';
import type { DrillSymbolKind } from '../../formats/gerber/drillDrawing';

/** Every layer a printout can take, in AD's list order. */
function allLayers(doc: PcbDocument): LayerId[] {
  const s = doc.board.copperStack;
  return [...s, L.TOP_OVERLAY, L.BOTTOM_OVERLAY, L.TOP_PASTE, L.BOTTOM_PASTE, L.TOP_SOLDER, L.BOTTOM_SOLDER, L.DRILL_GUIDE, L.KEEPOUT,
    ...Array.from({ length: 16 }, (_, i) => L.MECH1 + i), L.DRILL_DRAWING, L.MULTI];
}
const nameOf = (doc: PcbDocument, l: LayerId) => doc.board.layerNames.get(l) ?? layerName(l);

/**
 * PCB Printout Properties, as AD17 lays it out: the printouts in bold with their layers under
 * them; Insert Printout, Insert Layer, Delete, Move Up / Down; the selected printout's options
 * (components of each side, mirror, holes, pad numbers and nets) and the drill symbols. OK keeps
 * the job for the board (an Output Job keeps its own).
 */
export function PcbPrintoutDialog({ doc, job, onOk, keep = true }: { doc: PcbDocument; job: PrintJob; onOk?: (j: PrintJob) => void; keep?: boolean }) {
  const [j, setJ] = useState<PrintJob>(() => structuredClone(job));
  const [sel, setSel] = useState<{ po: number; layer: number | null }>({ po: 0, layer: null });
  const [addLayer, setAddLayer] = useState<LayerId>(L.TOP_OVERLAY);
  const po = j.printouts[sel.po];
  const setPo = (i: number, patch: Partial<Printout>) => setJ({ ...j, printouts: j.printouts.map((p, k) => (k === i ? { ...p, ...patch } : p)) });
  const insertPrintout = () => {
    const n = j.printouts.length + 1;
    const list = [...j.printouts]; list.splice(sel.po + 1, 0, printout(`New PrintOut ${n}`, [L.TOP_OVERLAY, L.TOP, L.KEEPOUT, L.MECH1]));
    setJ({ ...j, printouts: list }); setSel({ po: sel.po + 1, layer: null });
  };
  const insertLayer = () => {
    if (!po) return;
    if (po.layers.includes(addLayer)) { notify(`${nameOf(doc, addLayer)} is already in ${po.name}`, 'error'); return; }
    const at = sel.layer === null ? po.layers.length : sel.layer + 1;
    const layers = [...po.layers]; layers.splice(at, 0, addLayer);
    setPo(sel.po, { layers }); setSel({ po: sel.po, layer: at });
  };
  const del = () => {
    if (!po) return;
    if (sel.layer !== null) { setPo(sel.po, { layers: po.layers.filter((_, k) => k !== sel.layer) }); setSel({ po: sel.po, layer: null }); return; }
    if (j.printouts.length < 2) { notify('A job keeps at least one printout', 'error'); return; }
    setJ({ ...j, printouts: j.printouts.filter((_, k) => k !== sel.po) }); setSel({ po: Math.max(0, sel.po - 1), layer: null });
  };
  const move = (d: -1 | 1) => {
    if (!po) return;
    if (sel.layer !== null) {
      const t = sel.layer + d;
      if (t < 0 || t >= po.layers.length) return;
      const layers = [...po.layers]; [layers[sel.layer], layers[t]] = [layers[t]!, layers[sel.layer]!];
      setPo(sel.po, { layers }); setSel({ po: sel.po, layer: t }); return;
    }
    const t = sel.po + d;
    if (t < 0 || t >= j.printouts.length) return;
    const list = [...j.printouts]; [list[sel.po], list[t]] = [list[t]!, list[sel.po]!];
    setJ({ ...j, printouts: list }); setSel({ po: t, layer: null });
  };
  const ok = () => { if (keep) setJob(doc, j); onOk?.(j); closeDialog(); return false; };
  const used = new Set(usedLayers(doc));
  return (
    <Dialog title="PCB Printout Properties" width={860} height={600} onClose={closeDialog} onAccept={ok} class="pcbprintout"
      footer={<>
        <button class="btn" onClick={() => { if (keep) setJob(doc, j); onOk?.(j); closeDialog(); showDialog(PrintJobPreviewDialog, { doc, job: j, onOk, keep }); }}>Preview</button>
        <span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button>
      </>}>
      <div class="pp-props">
        <div class="pp-tree" role="tree" aria-label="Printouts and layers">
          <div class="pp-tree-head"><span>Printouts &amp; Layers</span><span>Include Components</span><span>Printout Options</span></div>
          {j.printouts.map((p, i) => (
            <div key={i} role="group">
              <div role="treeitem" class={`pp-po${sel.po === i && sel.layer === null ? ' on' : ''}`} onMouseDown={() => setSel({ po: i, layer: null })}>
                <b>{p.name}</b>
                <span class="pp-flags">{[p.top && 'Top', p.bottom && 'Bottom', p.multi && 'Double Sided'].filter(Boolean).join(', ')}</span>
                <span class="pp-flags">{[p.holes && 'Holes', p.mirror && 'Mirror', p.padNumbers && 'Pad Numbers', p.padNets && 'Pad Nets'].filter(Boolean).join(', ')}</span>
              </div>
              {p.layers.map((l, k) => (
                <div key={`${i}:${k}`} role="treeitem" class={`pp-layer${sel.po === i && sel.layer === k ? ' on' : ''}${used.has(l) ? '' : ' muted'}`} onMouseDown={() => setSel({ po: i, layer: k })}>{nameOf(doc, l)}</div>
              ))}
            </div>
          ))}
        </div>
        <div class="pp-side">
          <div class="pp-buttons">
            <button class="btn" onClick={insertPrintout}>Insert Printout</button>
            <div class="pp-addlayer">
              <select aria-label="Layer to insert" value={String(addLayer)} onChange={(e) => setAddLayer(Number((e.target as HTMLSelectElement).value))}>
                {allLayers(doc).map((l) => <option key={l} value={String(l)}>{nameOf(doc, l)}</option>)}
              </select>
              <button class="btn" onClick={insertLayer} disabled={!po}>Insert Layer</button>
            </div>
            <button class="btn" onClick={del}>Delete</button>
            <button class="btn" onClick={() => move(-1)}>Move Up</button>
            <button class="btn" onClick={() => move(1)}>Move Down</button>
          </div>
          {po && <fieldset><legend>Printout Properties</legend>
            <label class="do-row"><span>Printout Name</span><input type="text" value={po.name} onInput={(e) => setPo(sel.po, { name: (e.target as HTMLInputElement).value })} /></label>
            <div class="pp-sub">Components</div>
            <label class="out-check"><input type="checkbox" checked={po.top} onChange={() => setPo(sel.po, { top: !po.top })} />Include Top-Side</label>
            <label class="out-check"><input type="checkbox" checked={po.bottom} onChange={() => setPo(sel.po, { bottom: !po.bottom })} />Include Bottom-Side</label>
            <label class="out-check"><input type="checkbox" checked={po.multi} onChange={() => setPo(sel.po, { multi: !po.multi })} />Include Double-Sided</label>
            <div class="pp-sub">Options</div>
            <label class="out-check"><input type="checkbox" checked={po.holes} onChange={() => setPo(sel.po, { holes: !po.holes })} />Show Holes</label>
            <label class="out-check"><input type="checkbox" checked={po.mirror} onChange={() => setPo(sel.po, { mirror: !po.mirror })} />Mirror Layers</label>
            <label class="out-check"><input type="checkbox" checked={po.padNumbers} onChange={() => setPo(sel.po, { padNumbers: !po.padNumbers })} />Show Pad Numbers</label>
            <label class="out-check"><input type="checkbox" checked={po.padNets} onChange={() => setPo(sel.po, { padNets: !po.padNets })} />Show Pad Nets</label>
          </fieldset>}
          <fieldset><legend>Print Area</legend>
            <label class="out-check"><input type="radio" name="pparea" checked={j.area === 'extent'} onChange={() => setJ({ ...j, area: 'extent' })} />Design Extent</label>
            <label class="out-check"><input type="radio" name="pparea" checked={j.area === 'sheet'} onChange={() => setJ({ ...j, area: 'sheet' })} />Entire Sheet</label>
          </fieldset>
          <fieldset><legend>Drill Drawing Symbols</legend>
            <select aria-label="Symbol kind" value={j.symbols.kind} onChange={(e) => setJ({ ...j, symbols: { ...j.symbols, kind: (e.target as HTMLSelectElement).value as DrillSymbolKind } })}>
              <option value="graphic">Graphic symbols</option><option value="characters">Characters</option><option value="size">Size of hole string</option>
            </select>
            <label class="do-row"><span>Symbol Size</span><input type="text" value={formatCoord(j.symbols.size, units.value)}
              onChange={(e) => { const v = parseLengthIn((e.target as HTMLInputElement).value, units.value); if (v && v > 0) setJ({ ...j, symbols: { ...j.symbols, size: Math.round(v) } }); }} /></label>
          </fieldset>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The preview AD opens for a print output (Final Artwork Prints, Drill Drawings, Assembly
 * Drawings …): every printout a page, Configuration… opening the printout properties, Page
 * Setup…, and Print / Export to PDF through the browser.
 */
export function PrintJobPreviewDialog({ doc, job, onOk, keep = true }: { doc: PcbDocument; job: PrintJob; onOk?: (j: PrintJob) => void; keep?: boolean }) {
  const [i, setI] = useState(0);
  const pages = useMemo(() => printJobPages(doc, job, pageSetup.colours), [doc, job]);
  const [pw, ph] = paperMm(pageSetup);
  const page = pages[i];
  return (
    <Dialog title={`Preview ${job.title || JOB_TITLES[job.kind]} of [${doc.name}]`} width={1000} height={760} onClose={closeDialog} class="printpreview"
      footer={<>
        <button class="btn" disabled={i <= 0} onClick={() => setI(i - 1)}>‹ Previous</button>
        <span class="muted small">{page?.name ?? ''} — page {pages.length ? i + 1 : 0} of {pages.length}</span>
        <button class="btn" disabled={i >= pages.length - 1} onClick={() => setI(i + 1)}>Next ›</button>
        {/* Configuration… goes back to where the job came from (an Output Job keeps its own) */}
        <button class="btn" onClick={() => { closeDialog(); showDialog(PcbPrintoutDialog, { doc, job, onOk, keep }); }}>Configuration...</button>
        <button class="btn" onClick={() => { closeDialog(); showDialog(PageSetupDialog, { docs: [], title: `${job.title} Properties` }); }}>Page Setup...</button>
        <span class="spacer" />
        <button class="btn default" onClick={() => { closeDialog(); printPages(pages); }}>Print...</button>
        <button class="btn" onClick={() => { closeDialog(); printPages(pages); notify('In the print dialog choose “Save as PDF” as the destination'); }}>Export to PDF</button>
        <button class="btn" onClick={closeDialog}>Close</button>
      </>}>
      <div class="pp-stage">
        {page ? <div class="pp-paper" style={{ aspectRatio: `${pw} / ${ph}` }}><div class="pp-art" style={{ inset: `${(pageSetup.margin / ph) * 100}% ${(pageSetup.margin / pw) * 100}%` }} dangerouslySetInnerHTML={{ __html: page.svg }} /></div>
          : <p class="muted">This output has no printouts for {doc.name}.</p>}
      </div>
    </Dialog>
  );
}
