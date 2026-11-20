import { useMemo, useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { natural } from '../../model/compile';
import { docs, notify, type OpenDoc, type Project } from '../state';
import { openDocument } from '../actions';
import { printDocs } from '../print';
import { PageSetupDialog, PrintPreviewDialog } from './Print';

interface SchPart { sheet: string; index: number; designator: string; uid: string; comment: string }
interface PcbPart { index: number; designator: string; uid: string; pattern: string }
interface Link { pcb: number; uid: string; designator: string }

/**
 * Component Links: schematic parts and board components that belong together (the board's
 * SOURCEUNIQUEID is the part's UNIQUEID). Unmatched ones can be paired by designator or by hand;
 * a matched pair can be broken. Perform Update writes the board's links.
 */
export function ComponentLinksDialog({ sch, pcb, onOk }: { sch: SchPart[]; pcb: PcbPart[]; onOk: (links: Link[]) => void }) {
  // One row per package: the first part of each designator
  const parts = useMemo(() => { const seen = new Set<string>(); return sch.filter((p) => p.uid && !seen.has(p.designator) && (seen.add(p.designator), true)).sort((a, b) => natural(a.designator, b.designator)); }, [sch]);
  const [links, setLinks] = useState<Map<number, string>>(() => new Map(pcb.filter((c) => parts.some((p) => p.uid === c.uid)).map((c) => [c.index, c.uid])));
  const [selS, setSelS] = useState<number | null>(null), [selP, setSelP] = useState<number | null>(null), [selM, setSelM] = useState<number | null>(null);
  const linkedUids = new Set(links.values());
  const freeS = parts.filter((p) => !linkedUids.has(p.uid));
  const freeP = pcb.filter((c) => !links.has(c.index)).sort((a, b) => natural(a.designator, b.designator));
  const matched = pcb.filter((c) => links.has(c.index)).map((c) => ({ c, s: parts.find((p) => p.uid === links.get(c.index)) })).filter((m) => m.s).sort((a, b) => natural(a.c.designator, b.c.designator));
  const set = (m: Map<number, string>) => { setLinks(m); setSelS(null); setSelP(null); setSelM(null); };
  const byDesignator = () => { const m = new Map(links); for (const c of freeP) { const s = freeS.find((p) => p.designator === c.designator); if (s) m.set(c.index, s.uid); } set(m); };
  const pair = () => { const s = selS === null ? undefined : freeS[selS], c = selP === null ? undefined : freeP[selP]; if (!s || !c) return; const m = new Map(links); m.set(c.index, s.uid); set(m); };
  const unpair = () => { const r = selM === null ? undefined : matched[selM]; if (!r) return; const m = new Map(links); m.delete(r.c.index); set(m); };
  const ok = () => {
    closeDialog();
    onOk(pcb.map((c) => { const uid = links.get(c.index) ?? ''; return { pcb: c.index, uid, designator: parts.find((p) => p.uid === uid)?.designator ?? '' }; })
      .filter((l) => l.uid !== (pcb.find((c) => c.index === l.pcb)?.uid ?? '') && (l.uid || parts.some((p) => p.uid === pcb.find((c) => c.index === l.pcb)?.uid))));
  };
  return (
    <Dialog title="Edit Component Links" width={980} height={560} onClose={closeDialog} class="complinks"
      footer={<><button class="btn" onClick={byDesignator} disabled={!freeP.length || !freeS.length}>Add Pairs Matched By Designator</button><span class="spacer" />
        <button class="btn default" onClick={ok}>Perform Update</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="cl-cols">
        <fieldset><legend>Unmatched Schematic Components ({freeS.length})</legend>
          <Grid cols={[{ label: 'Designator', width: '90px', get: (p: SchPart) => p.designator }, { label: 'Comment', get: (p) => p.comment }, { label: 'Sheet', get: (p) => p.sheet }]} rows={freeS} sel={selS} onSel={setSelS} empty="None" />
        </fieldset>
        <fieldset><legend>Unmatched PCB Components ({freeP.length})</legend>
          <Grid cols={[{ label: 'Designator', width: '90px', get: (c: PcbPart) => c.designator }, { label: 'Footprint', get: (c) => c.pattern }]} rows={freeP} sel={selP} onSel={setSelP} empty="None" />
        </fieldset>
        <div class="cl-mid"><button class="btn" disabled={selS === null || selP === null} onClick={pair} title="Pair the selected components">&gt;</button><button class="btn" disabled={selM === null} onClick={unpair} title="Unpair">&lt;</button></div>
        <fieldset><legend>Matched Components ({matched.length})</legend>
          <Grid cols={[{ label: 'Schematic', width: '90px', get: (m: (typeof matched)[number]) => m.s!.designator }, { label: 'PCB', width: '90px', get: (m) => m.c.designator }, { label: 'Footprint', get: (m) => m.c.pattern }]} rows={matched} sel={selM} onSel={setSelM} empty="None" />
        </fieldset>
      </div>
    </Dialog>
  );
}

/** Board Level Annotate: without multi-channel rooms each part's physical designator is its logical one. */
export function PhysicalAnnotateDialog({ parts }: { parts: SchPart[] }) {
  const rows = useMemo(() => [...new Map(parts.map((p) => [p.designator, p])).values()].sort((a, b) => natural(a.designator, b.designator)), [parts]);
  return (
    <Dialog title="Board Level Annotate" width={560} height={460} onClose={closeDialog}
      footer={<><span class="muted small">No multi-channel rooms: nothing to annotate</span><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <Grid cols={[{ label: 'Logical Designator', get: (p: SchPart) => p.designator }, { label: 'Physical Designator', get: (p) => p.designator }, { label: 'Sheet', get: (p) => p.sheet }]} rows={rows} empty="No parts" />
    </Dialog>
  );
}

const printSel = new Map<string, Set<string>>();

/** Default Prints: which of the project's documents File › Print sends, ticked; Print / Preview them together. */
export function DefaultPrintsDialog({ project, names }: { project: Project | null; names: string[] }) {
  const key = project?.id ?? '';
  const [on, setOn] = useState<Set<string>>(() => new Set(printSel.get(key) ?? names));
  const open = (): OpenDoc[] => names.filter((n) => on.has(n)).map((n) => docs.value.find((d) => d.name.toLowerCase() === n.toLowerCase() && d.projectId === project?.id)
    ?? (project?.files.get(n.toLowerCase()) ? openDocument(project.files.get(n.toLowerCase())!, project.id, false) : null)).filter((d): d is OpenDoc => !!d?.editor);
  const keep = () => printSel.set(key, on);
  return (
    <Dialog title="Default Prints" width={520} height={420} onClose={closeDialog}
      footer={<>
        <button class="btn" onClick={() => { keep(); showDialog(PageSetupDialog, { docs: open() }); }}>Page Setup...</button>
        <button class="btn" onClick={() => { keep(); const l = open(); closeDialog(); if (l.length) showDialog(PrintPreviewDialog, { docs: l }); }}>Preview</button>
        <span class="spacer" />
        <button class="btn default" onClick={() => { keep(); const l = open(); closeDialog(); if (l.length) printDocs(l); else notify('Tick the documents to print', 'error'); }}>Print</button>
        <button class="btn" onClick={() => { keep(); closeDialog(); }}>Close</button>
      </>}>
      <Grid cols={[{ label: 'Print', width: '50px', align: 'center', get: (n: string) => <input type="checkbox" checked={on.has(n)} aria-label={`Print ${n}`} onChange={(e) => { const s = new Set(on); if ((e.target as HTMLInputElement).checked) s.add(n); else s.delete(n); setOn(s); }} /> },
        { label: 'Document', get: (n) => n }, { label: 'Kind', width: '110px', get: (n) => (/\.pcbdoc$/i.test(n) ? 'PCB Prints' : 'Schematic Prints') }]} rows={names} />
    </Dialog>
  );
}
