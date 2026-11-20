import { useMemo, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { docs, type OpenDoc } from '../state';
import { PAPERS, documentPages, pageSetup, paperMm, printDocs, type PageSetup } from '../print';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../../editors/pcb/PcbLibEditor';
import { jobFor } from '../../model/printouts';
import { PcbPrintoutDialog } from './PcbPrints';
import { numIn } from './numIn';

/** File › Page Setup: paper, orientation, scaling and colours for printing, preview and Smart PDF. */
export function PageSetupDialog({ docs: list, title }: { docs: OpenDoc[]; title?: string }) {
  const [s, setS] = useState<PageSetup>({ ...pageSetup });
  // A board's Page Setup has Advanced…: its printouts (PCB Printout Properties)
  const ed0 = list.length === 1 ? list[0]!.editor : null;
  const board = ed0 instanceof PcbEditor && !(ed0 instanceof PcbLibEditor) ? ed0.doc : null;
  const keep = () => Object.assign(pageSetup, s);
  return (
    <Dialog title={title ?? `${list[0]?.name ?? ''} Properties`} width={560} onClose={closeDialog} onAccept={() => { keep(); }} class="pagesetup"
      footer={<>
        {list.length > 0 && <button class="btn" onClick={() => { keep(); closeDialog(); showDialog(PrintPreviewDialog, { docs: list }); }}>Preview</button>}
        {list.length > 0 && <button class="btn" onClick={() => { keep(); closeDialog(); printDocs(list); }}>Print</button>}
        {board && <button class="btn" onClick={() => { keep(); closeDialog(); showDialog(PcbPrintoutDialog, { doc: board, job: jobFor(board, 'pcb') }); }}>Advanced...</button>}
        <span class="spacer" /><button class="btn default" onClick={() => { keep(); closeDialog(); }}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button>
      </>}>
      <div class="ps-cols">
        <fieldset><legend>Printer Paper</legend>
          <label class="do-row"><span>Size</span><select value={s.paper} onChange={(e) => setS({ ...s, paper: (e.target as HTMLSelectElement).value })}>{Object.keys(PAPERS).map((p) => <option key={p}>{p}</option>)}</select></label>
          <label class="do-check"><input type="radio" name="orient" checked={s.orientation === 'portrait'} onChange={() => setS({ ...s, orientation: 'portrait' })} />Portrait</label>
          <label class="do-check"><input type="radio" name="orient" checked={s.orientation === 'landscape'} onChange={() => setS({ ...s, orientation: 'landscape' })} />Landscape</label>
        </fieldset>
        <fieldset><legend>Scaling</legend>
          <label class="do-row"><span>Scale Mode</span><select value={s.fit ? 'fit' : 'scaled'} onChange={(e) => setS({ ...s, fit: (e.target as HTMLSelectElement).value === 'fit' })}>
            <option value="fit">Fit Document On Page</option><option value="scaled">Scaled Print</option></select></label>
          <label class="do-row"><span>Scale</span><input type="number" step="0.1" min="0.1" value={String(s.scale)} disabled={s.fit} onInput={(e) => setS({ ...s, scale: Number((e.target as HTMLInputElement).value) || 1 })} /></label>
          <label class="do-row"><span>Margins (mm)</span><input type="number" min="0" value={String(s.margin)} onInput={(e) => setS({ ...s, margin: Math.max(0, numIn(e, s.margin)) })} /></label>
        </fieldset>
        <fieldset><legend>Colour Set</legend>
          {(['mono', 'colour', 'grey'] as const).map((c) => (
            <label key={c} class="do-check"><input type="radio" name="colours" checked={s.colours === c} onChange={() => setS({ ...s, colours: c })} />{c === 'mono' ? 'Mono' : c === 'colour' ? 'Colour' : 'Grey'}</label>
          ))}
        </fieldset>
      </div>
    </Dialog>
  );
}

/** File › Print Preview: the pages as they will print; Print sends them to the browser's print. */
export function PrintPreviewDialog({ docs: list }: { docs: OpenDoc[] }) {
  const [i, setI] = useState(0);
  const pages = useMemo(() => documentPages(list.filter((d) => d.editor).map((d) => ({ name: d.name, ed: d.editor! }))), [list]);
  const [pw, ph] = paperMm(pageSetup);
  const page = pages[i];
  return (
    <Dialog title={`Preview ${page?.name ?? ''}`} width={1000} height={760} onClose={closeDialog} class="printpreview"
      footer={<>
        <button class="btn" disabled={i <= 0} onClick={() => setI(i - 1)}>‹ Previous</button>
        <span class="muted small">Page {pages.length ? i + 1 : 0} of {pages.length}</span>
        <button class="btn" disabled={i >= pages.length - 1} onClick={() => setI(i + 1)}>Next ›</button>
        <button class="btn" onClick={() => { closeDialog(); showDialog(PageSetupDialog, { docs: list }); }}>Page Setup...</button>
        <span class="spacer" /><button class="btn default" onClick={() => { closeDialog(); printDocs(list); }}>Print...</button><button class="btn" onClick={closeDialog}>Close</button>
      </>}>
      <div class="pp-stage">
        {page && <div class="pp-paper" style={{ aspectRatio: `${pw} / ${ph}` }}><div class="pp-art" style={{ inset: `${(pageSetup.margin / ph) * 100}% ${(pageSetup.margin / pw) * 100}%` }} dangerouslySetInnerHTML={{ __html: page.svg }} /></div>}
      </div>
    </Dialog>
  );
}

/** File › Smart PDF: the current document or the project's documents, through the browser's Save as PDF. */
export function SmartPdfDialog({ current, project }: { current: OpenDoc | null; project: OpenDoc[] }) {
  const [which, setWhich] = useState<'current' | 'project'>(current ? 'current' : 'project');
  const list = which === 'current' && current ? [current] : project;
  return (
    <Dialog title="Smart PDF" width={520} onClose={closeDialog} onAccept={() => { closeDialog(); printDocs(list); return false; }}
      footer={<><span class="spacer" /><button class="btn default" disabled={!list.length} onClick={() => { closeDialog(); printDocs(list); }}>Finish</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <fieldset><legend>Choose Export Target</legend>
        <label class="do-check"><input type="radio" name="target" checked={which === 'project'} disabled={!project.length} onChange={() => setWhich('project')} />Export Entire Project ({project.length} open document{project.length === 1 ? '' : 's'})</label>
        <label class="do-check"><input type="radio" name="target" checked={which === 'current'} disabled={!current} onChange={() => setWhich('current')} />Export Current Document {current ? `(${current.name})` : ''}</label>
      </fieldset>
      <p class="muted small">The pages follow Page Setup. In the print dialog choose "Save as PDF" as the destination.</p>
    </Dialog>
  );
}

export const openDocsOf = (projectId: string | undefined) => docs.value.filter((d) => d.editor && d.projectId === projectId && /\.(schdoc|pcbdoc)$/i.test(d.name));
