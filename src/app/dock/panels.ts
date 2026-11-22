/**
 * The workspace panels Konium has, in Altium Designer 17's categories (View › Workspace Panels
 * and the status-bar buttons): what each is called in each editor, when it can show (the SCH
 * Inspector only with a schematic active, SCH Library only in a schematic library …) and
 * where it goes the first time it opens. No UI here: views.tsx maps ids to components.
 */
import type { Scope } from '../../core/commands';
import { TOOLS_GROUP, type Arrangement, type Place } from './layout';
import { featureOn } from '../../core/release';

export type PanelCategory = 'Design Compiler' | 'SCH' | 'PCB' | 'System' | 'Mixed Sim' | 'CAM';

export interface PanelMeta {
  id: string;
  /** Caption in this editor. */
  title: (scope: Scope) => string;
  /** Menu category in this editor (null: not offered there). */
  category: (scope: Scope) => PanelCategory | null;
  /** Shown only while this is true (editor panels hide with no editor of their kind). */
  when?: (scope: Scope) => boolean;
  /** Where it opens the first time. */
  place: Place;
  /** Menu accelerator. */
  key: string;
}

const fam = (s: Scope) => (s === 'schlib' ? 'sch' : s === 'pcblib' ? 'pcb' : s);
const editorKind = (s: Scope) => (s === 'sch' ? 'SCH' : s === 'schlib' ? 'SCHLIB' : s === 'pcb' ? 'PCB' : s === 'pcblib' ? 'PCBLIB' : '');
const editorCat = (s: Scope): PanelCategory | null => (fam(s) === 'sch' ? 'SCH' : fam(s) === 'pcb' ? 'PCB' : null);
/** The default left group (Projects and its neighbours). */
export const MAIN_GROUP = 'g1';
const left: Place = { side: 'left', group: MAIN_GROUP };
/** Behind a tab on the right edge with the panels that are there at first (Libraries and its neighbours)… */
const edge: Place = { side: 'right', group: 'g2' };
/**
 * …and a tool's panel (an analysis, Live Simulation, the planner and the router, the adviser, scripts): behind a tab on
 * the right edge too, in a group the tools share, so that one pinned open does not bring Libraries and the rest with it.
 */
const tool: Place = { side: 'right', group: TOOLS_GROUP, autoHide: true };

export const PANELS: PanelMeta[] = [
  { id: 'projects', title: () => 'Projects', category: () => 'System', place: left, key: 'P' },
  { id: 'messages', title: () => 'Messages', category: () => 'System', place: { side: 'bottom' }, key: 'M' },
  { id: 'libraries', title: () => 'Libraries', category: () => 'System', place: edge, key: 'L' },
  { id: 'fileInspector', title: () => 'File Inspector', category: () => 'System', place: left, key: 'I' },
  { id: 'storage', title: () => 'Storage Manager', category: () => 'System', place: left, key: 'S' },
  { id: 'clipboard', title: () => 'Clipboard', category: () => 'System', place: edge, key: 'C' },
  // Konium's: the everyday sums and the board's (Tools › Calculators), with any document in front or none
  { id: 'calculators', title: () => 'Calculators', category: () => 'System', place: edge, key: 'U' },
  // Konium's (R21): the parts kept in this browser, each an exact part number with its symbol and footprint (Tools › Parts)
  { id: 'parts', title: () => 'Parts', category: () => 'System', place: edge, key: 'K' },
  { id: 'navigator', title: () => 'Navigator', category: () => 'Design Compiler', place: left, key: 'N' },
  // Konium's: the AI design review of the project or sheet in front (Tools › Design Adviser)
  { id: 'adviser', title: () => 'Design Adviser', category: (s) => (s === 'sch' ? 'SCH' : s === 'pcb' ? 'PCB' : null), when: (s) => s === 'sch' || s === 'pcb', place: tool, key: 'D' },
  // Konium's (R20): the board's layout planned by the model chosen (Tools › Layout Planner)
  { id: 'layoutPlanner', title: () => 'Layout Planner', category: (s) => (s === 'pcb' ? 'PCB' : null), when: (s) => s === 'pcb', place: tool, key: 'Y' },
  // …and its routing planned the same way, carried out by the autorouter (Tools › Smart Router)
  { id: 'smartRouter', title: () => 'Smart Router', category: (s) => (s === 'pcb' ? 'PCB' : null), when: (s) => s === 'pcb', place: tool, key: 'S' },
  // …and the two as one run, with the design rule check at its end (Tools › Plan, Place and Route)
  { id: 'boardRun', title: () => 'Plan, Place and Route', category: (s) => (s === 'pcb' ? 'PCB' : null), when: (s) => s === 'pcb', place: tool, key: 'O' },
  // Tools › Signal Integrity: every net screened, reflections and crosstalk
  { id: 'signalIntegrity', title: () => 'Signal Integrity', category: (s) => (s === 'sch' ? 'SCH' : s === 'pcb' ? 'PCB' : null), when: (s) => s === 'sch' || s === 'pcb', place: { side: 'bottom' }, key: 'G' },
  // Konium's: a supply net at DC, its voltage drop, current density and via currents (Tools › Power Analysis)
  { id: 'powerAnalysis', title: () => 'Power Analysis', category: (s) => (s === 'pcb' ? 'PCB' : null), when: (s) => s === 'pcb', place: tool, key: 'W' },
  // Konium's: the board's temperature from its parts' heat and its copper's (Tools › Thermal Analysis)
  { id: 'thermalAnalysis', title: () => 'Thermal Analysis', category: (s) => (s === 'pcb' ? 'PCB' : null), when: (s) => s === 'pcb', place: tool, key: 'H' },
  // Konium's: the layout checked for broken return paths, decoupling and stitching (Tools › EMC Check)
  { id: 'emcCheck', title: () => 'EMC Check', category: (s) => (s === 'pcb' ? 'PCB' : null), when: (s) => s === 'pcb', place: tool, key: 'E' },
  // Konium's: a supply's impedance against frequency, its planes' resonances, conducted emission (Tools › Supply Impedance)
  { id: 'supplyImpedance', title: () => 'Supply Impedance', category: (s) => (s === 'pcb' ? 'PCB' : null), when: (s) => s === 'pcb', place: tool, key: 'Z' },
  // Konium's: a track's impedance from its cross-section, solved (Tools › Field Solver)
  { id: 'fieldSolver', title: () => 'Field Solver', category: (s) => (s === 'pcb' ? 'PCB' : null), when: (s) => s === 'pcb', place: tool, key: 'V' },
  // Konium's: an antenna in the board's copper (Tools › Antenna Analysis)
  { id: 'antennaAnalysis', title: () => 'Antenna Analysis', category: (s) => (s === 'pcb' ? 'PCB' : null), when: (s) => s === 'pcb', place: tool, key: 'T' },
  // Konium's: the sheet in front run as a circuit while it is drawn (Design › Simulate › Live Simulation)
  { id: 'liveSim', title: () => 'Live Simulation', category: (s) => (s === 'sch' ? 'SCH' : null), when: (s) => s === 'sch', place: tool, key: 'V' },
  // …and its scope: what the probes on the running sheet read, drawn as it goes
  { id: 'liveScope', title: () => 'Live Scope', category: (s) => (s === 'sch' ? 'SCH' : null), when: (s) => s === 'sch', place: { side: 'bottom' }, key: 'O' },
  // Konium's: the project's requirements, to see, verify and link to the design (any document in front)
  { id: 'requirements', title: () => 'Requirements', category: () => 'Design Compiler', place: edge, key: 'Q' },
  // Konium's: scripts run on the board or footprint in front (Tools › Scripts)
  { id: 'scripts', title: () => 'Scripts', category: () => 'System', place: tool, key: 'R' },
  { id: 'library', title: (s) => (s === 'pcblib' ? 'PCB Library' : 'SCH Library'), category: (s) => (s === 'schlib' ? 'SCH' : s === 'pcblib' ? 'PCB' : null),
    when: (s) => s === 'schlib' || s === 'pcblib', place: left, key: 'L' },
  { id: 'filter', title: (s) => `${editorKind(s) || 'SCH'} Filter`, category: editorCat, when: (s) => fam(s) === 'sch' || fam(s) === 'pcb', place: left, key: 'F' },
  { id: 'inspector', title: (s) => `${editorKind(s) || 'SCH'} Inspector`, category: editorCat, when: (s) => fam(s) === 'sch' || fam(s) === 'pcb', place: left, key: 'I' },
  { id: 'list', title: (s) => `${editorKind(s) || 'SCH'} List`, category: editorCat, when: (s) => fam(s) === 'sch' || fam(s) === 'pcb', place: { side: 'bottom' }, key: 'L' },
  // The board's own: the PCB panel (nets, components, pours, hole sizes, 3D models) and its rules and violations
  { id: 'pcb', title: () => 'PCB', category: (s) => (s === 'pcb' ? 'PCB' : null), when: (s) => s === 'pcb', place: left, key: 'P' },
  { id: 'rules', title: () => 'PCB Rules And Violations', category: (s) => (s === 'pcb' ? 'PCB' : null), when: (s) => s === 'pcb', place: left, key: 'R' },
  { id: 'activeRoute', title: () => 'PCB ActiveRoute', category: (s) => (s === 'pcb' ? 'PCB' : null), when: (s) => s === 'pcb', place: tool, key: 'A' },
  // SimView's own: the chart's source data, the cursors' and the selected wave's measurements
  { id: 'cam', title: () => 'CAM', category: (s) => (s === 'cam' ? 'CAM' : null), when: (s) => s === 'cam', place: left, key: 'C' },
  { id: 'simdata', title: () => 'Sim Data', category: (s) => (s === 'simview' ? 'Mixed Sim' : null), when: (s) => s === 'simview', place: { side: 'right', group: 'g3' }, key: 'S' },
];

export const panelMeta = (id: string) => PANELS.find((p) => p.id === id);
export const panelTitle = (id: string, scope: Scope) => panelMeta(id)?.title(scope) ?? id;
export const panelAvailable = (id: string, scope: Scope) => { const m = panelMeta(id); return !!m && (!m.when || m.when(scope)); };
export const KNOWN_PANELS = new Set(PANELS.map((p) => p.id));

/**
 * The first arrangement (26.209). Docked on the left, as tabs: Projects, the Storage Manager and the
 * Inspector. Behind tabs on the right edge: Libraries, Parts (once the parts library is switched on),
 * Requirements, Calculators and the Clipboard. Every other panel opens when it is asked for (a
 * library's own panel when a library is opened).
 */
export const DEFAULT_LEFT = ['projects', 'storage', 'inspector'];
export const defaultRight = (parts = featureOn('partsLibrary')): string[] => ['libraries', ...(parts ? ['parts'] : []), 'requirements', 'calculators', 'clipboard'];
/** The arrangement, with the tabs the one before it had beside Projects (Navigator, a library's panel, the Filter). */
export const arrangement = (): Arrangement => ({ main: 'projects', left: DEFAULT_LEFT, right: defaultRight(), gone: ['navigator', 'library', 'filter'] });
