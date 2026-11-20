/**
 * Outputs of 26.028: File › Fabrication Outputs › Composite Drill Guide, Drill Drawings, Final,
 * Mask Set, Power-Plane Set, Test Point Report; File › Assembly Outputs › Assembly Drawings (each
 * print output opens its preview, as AD does); Design › Netlist For Project / Document › Protel.
 */
import type { Command } from '../core/commands';
import { active, notify } from './state';
import { addNewDocument, freshName } from './actions';
import { newDocTarget } from './workspace';
import { newOutJob, writeOutJob } from '../formats/altium/outjob';
import { showDialog } from './dialogs';
import { PrintJobPreviewDialog } from './dialogs/PcbPrints';
import { TestPointSetupDialog, deliverOutputs } from './dialogs/Outputs';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { SchEditor } from '../editors/sch/SchEditor';
import { jobFor, type PrintJobKind } from '../model/printouts';
import { activeProject, cmdCompile } from './project';
import { protelNetlist } from '../formats/netlist';

const board = () => { const e = active.value?.editor; return e instanceof PcbEditor && !(e instanceof PcbLibEditor) ? e : null; };
const sheet = () => { const e = active.value?.editor; return e instanceof SchEditor && !e.libraryMode ? e : null; };

function printOutput(kind: PrintJobKind): () => void {
  return () => {
    const e = board();
    if (!e) return;
    const job = jobFor(e.doc, kind);
    if (!job.printouts.length) { notify(kind === 'plane' ? `${e.doc.name} has no internal planes` : `Nothing to print for ${job.title}`, 'error'); return; }
    showDialog(PrintJobPreviewDialog, { doc: e.doc, job });
  };
}

/** Design › Netlist For Project / Document › Netlist (.NET): the compiled design as <name>.NET in Project Outputs. */
function netlist(document: boolean): () => void {
  return () => {
    const p = activeProject();
    const s = sheet();
    const od = active.value;
    if (document && (!s || !od)) { notify('Open a schematic sheet first', 'error'); return; }
    const res = document && s && od ? cmdCompile(p, [{ name: od.name, doc: s.doc }]) : cmdCompile(p);
    if (!res) return;
    if (res.result.messages.some((m) => m.fatal)) { notify('The compile halted on a fatal error: no netlist written', 'error'); return; }
    const name = `${(document ? od!.name : p?.name ?? res.name).replace(/\.(prjpcb|schdoc)$/i, '')}.NET`;
    void deliverOutputs(p, res.name, 'Netlist', [{ name, text: protelNetlist(res.result) }]);
  };
}

export function outputCommands(): Command[] {
  const has = () => !!board();
  const out = (id: string, label: string, kind: PrintJobKind): Command => ({ id, label, scopes: ['pcb'], enabled: has, run: printOutput(kind) });
  return [
    out('output.compositeDrill', 'Composite Drill Guide', 'composite'),
    out('output.drillDrawings', 'Drill Drawings', 'drill'),
    out('output.final', 'Final', 'final'),
    out('output.maskSet', 'Mask Set', 'mask'),
    out('output.powerPlane', 'Power-Plane Set', 'plane'),
    out('output.assemblyDrawings', 'Assembly Drawings', 'assembly'),
    { id: 'output.testPoint', label: 'Test Point Report', scopes: ['pcb'], enabled: has, run: () => { const e = board(); if (e) showDialog(TestPointSetupDialog, { ed: e }); } },
    // File › New › Output Job File: Job1.OutJob in the focused project, open in its tab
    { id: 'ad:WorkspaceManager:NewJob', label: 'Output Job File', run: () => {
      const name = freshName('Job', 'OutJob');
      addNewDocument(name, writeOutJob(newOutJob(name)), newDocTarget());
    } },
    { id: 'netlist.project.net', label: 'Netlist (.NET)', scopes: ['sch', 'pcb'], run: netlist(false) },
    { id: 'netlist.document.net', label: 'Netlist (.NET)', scopes: ['sch'], enabled: () => !!sheet(), run: netlist(true) },
  ];
}

