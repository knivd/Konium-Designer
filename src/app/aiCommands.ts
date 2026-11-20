import type { Command } from '../core/commands';
import { showDialog } from './dialogs';
import { AiBuilderDialog } from './dialogs/AiBuilder';
import { addExamplePart } from './panels/PartsPanel';
import { showPanel, slideOut } from './dock/store';
import { active, activeScope, openHelp } from './state';
import { contextSection } from '../help/context';
import { analyseDesign, siRun, siTarget } from './siRun';
import { registerSiProvider } from './siProject';
import { openDocument } from './actions';
import { ANTENNA_SAMPLE, antennaSampleBytes } from '../formats/synthetic/antennaSample';
import { LAYOUT_SAMPLE, layoutSampleBytes } from '../formats/synthetic/layoutSample';
import { ROUTING_SAMPLE, routingSampleBytes } from '../formats/synthetic/routingSample';

registerSiProvider();

/** Konium's AI tools (Preferences › System › AI): started by hand only; Signal Integrity's panel; the Scripts panel. */
export function aiCommands(): Command[] {
  return [
    { id: 'ai.componentBuilder', label: 'Component Builder...', scopes: ['schlib', 'pcblib'], run: () => showDialog(AiBuilderDialog, { part: '' }) },
    { id: 'ai.adviser', label: 'Design Adviser...', scopes: ['sch', 'pcb'], run: () => showPanel('adviser') },
    // Konium's (R20): where the board's parts go, planned by the model chosen before any is placed
    { id: 'ai.layoutPlanner', label: 'Layout Planner...', scopes: ['pcb'], run: () => showPanel('layoutPlanner') },
    // …and a board of Konium's own to try it on: a small USB sensor node, its parts still beside the outline
    { id: 'ai.layoutExample', label: 'Open the Layout Planner Example', run: () => { if (openDocument({ name: LAYOUT_SAMPLE.name, bytes: layoutSampleBytes() })) showPanel('layoutPlanner'); } },
    // Konium's (R20): how the placed board is to be routed, planned by the model chosen and carried out by the autorouter
    { id: 'ai.smartRouter', label: 'Smart Router...', scopes: ['pcb'], run: () => showPanel('smartRouter') },
    // …and the planner's example board with its parts placed, to try it on
    { id: 'ai.routeExample', label: 'Open the Smart Router Example', run: () => { void routingSampleBytes().then((bytes) => { if (openDocument({ name: ROUTING_SAMPLE.name, bytes })) showPanel('smartRouter'); }); } },
    // …and the planner and the router as one run with a stop at each stage
    { id: 'ai.boardRun', label: 'Plan, Place and Route...', scopes: ['pcb'], run: () => showPanel('boardRun') },
    // Konium's (R21): the shelf of parts, each an exact part number with its symbol, footprint and datasheet pages
    { id: 'parts.panel', label: 'Parts...', run: () => showPanel('parts') },
    // …and a made-up part of Konium's own to try it with
    { id: 'parts.example', label: 'Add the Example Part', run: () => { addExamplePart(); showPanel('parts'); } },
    // Tools › Signal Integrity: the panel, the design screened the first time
    // Tools › Scripts (R8): the Scripts panel
    { id: 'tools.scripts', label: 'Scripts...', scopes: ['pcb', 'pcblib'], run: () => showPanel('scripts') },
    { id: 'help.scripting', label: 'Scripting Reference', run: () => openHelp('scripting') },
    // F1: the User Guide at the section for the panel in use (the one with the focus, else the one last clicked in: a click
    // on a panel's text or a table's row leaves the focus on the page), else the editor in front
    { id: 'help.guide', label: 'User Guide', run: () => {
      const group = document.activeElement?.closest('[data-dock-group]') ?? document.querySelector('.dock-group.focused[data-dock-group]');
      const panel = group?.querySelector<HTMLElement>('[data-dock-head]')?.dataset.panelId ?? null;
      // An auto-hide panel tucks away, as it does on a press anywhere else: the guide is to be read
      if (group?.getAttribute('data-dock-mode') === 'slide') slideOut.value = null;
      openHelp('guide', contextSection(panel, activeScope.value, active.value?.doc.kind) ?? undefined);
    } },
    { id: 'si.panel', label: 'Signal Integrity...', scopes: ['sch', 'pcb'], run: () => { showPanel('signalIntegrity'); if (siRun.value?.key !== siTarget()?.key) void analyseDesign(); } },
    // Konium's: a supply net at DC (its panel sets it up and runs it)
    { id: 'power.panel', label: 'Power Analysis...', scopes: ['pcb'], run: () => showPanel('powerAnalysis') },
    { id: 'thermal.panel', label: 'Thermal Analysis...', scopes: ['pcb'], run: () => showPanel('thermalAnalysis') },
    { id: 'emc.panel', label: 'EMC Check...', scopes: ['pcb'], run: () => showPanel('emcCheck') },
    { id: 'pdn.panel', label: 'Supply Impedance...', scopes: ['pcb'], run: () => showPanel('supplyImpedance') },
    { id: 'field.panel', label: 'Field Solver...', scopes: ['pcb'], run: () => showPanel('fieldSolver') },
    // Konium's: the everyday sums and the board's, kept beside the work (any editor, or none)
    { id: 'tools.calculators', label: 'Calculators...', run: () => showPanel('calculators') },
    // Konium's: an antenna in the board's copper, by FDTD (its panel sets it up and runs it)
    { id: 'antenna.panel', label: 'Antenna Analysis...', scopes: ['pcb'], run: () => showPanel('antennaAnalysis') },
    // …and a board of Konium's own to try it on: an inverted F for 2.45 GHz
    { id: 'antenna.example', label: 'Open the Antenna Example', run: () => { if (openDocument({ name: ANTENNA_SAMPLE.name, bytes: antennaSampleBytes() })) showPanel('antennaAnalysis'); } },
  ];
}
