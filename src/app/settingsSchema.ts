import type { Settings } from '../core/settings';
import { featureOn, type Feature } from '../core/release';
import { VIEW3D_PRESETS } from '../core/view3d';

/**
 * The Preferences window, page by page as Altium Designer 17's tree lays it out (System,
 * Data Management, Schematic, PCB Editor), with each page's group boxes and fields. A field with
 * a `key` is a Konium setting, read where it matters; a field without one is shown greyed with
 * Altium's default (`todo`), so the window reads as Altium's while saying plainly what isn't
 * built yet. Search and per-page reset work from this list.
 */
export type FieldType =
  | { kind: 'bool' }
  | { kind: 'enum'; options: [string, string][] }
  | { kind: 'radio'; options: [string, string][] }
  | { kind: 'range'; min: number; max: number; step: number; format: (v: number) => string }
  | { kind: 'number'; min: number; max: number; step: number; unit: string }
  | { kind: 'text' }
  | { kind: 'colour' }
  /** A button that runs a command (a dialog of its own). */
  | { kind: 'action'; command: string; button: string }
  /** Several of a list ticked (a list of strings). */
  | { kind: 'multi'; options: [string, string][] };

export interface Field {
  /** The setting it edits; absent = not in Konium yet, shown greyed with `todo` as its value. */
  key?: keyof Settings;
  label: string;
  help?: string;
  type: FieldType;
  todo?: string | number | boolean;
  /** A switch shown the other way round (ticked = the setting false). */
  invert?: boolean;
  /** Greyed while this holds for the settings being edited. */
  off?: (s: Settings) => boolean;
  /** Kept with the settings (and in the files that carry it) but not acted on yet: greyed, "Not available yet". */
  notYet?: boolean;
}
export interface Section { title: string; fields: Field[]; /** Spans both columns. */ wide?: boolean }
export type CustomPage = 'ai' | 'vcs' | 'network' | 'layers' | 'shortcuts' | 'wheel' | 'gridPresets' | 'fileTypes' | 'reports' | 'schPrimitives' | 'pcbPrimitives' | 'installedLibs' | 'deviceFolders' | 'modelFolders';
export interface Page { id: string; group: string; title: string; sections: Section[]; custom?: CustomPage; note?: string; feature?: Feature }

const pct = (v: number) => `${Math.round(v * 100)}%`;
const corner: [string, string][] = [['90', '90°'], ['45', '45°'], ['any', 'Any angle']];
const pcbCorner: [string, string][] = [['45', '45°'], ['45arc', '45° with arc'], ['90', '90°'], ['90arc', '90° with arc'], ['any', 'Any angle']];
const B = { kind: 'bool' } as const;
const T = { kind: 'text' } as const;
const C = { kind: 'colour' } as const;
const E = (...o: string[]): FieldType => ({ kind: 'enum', options: o.map((x) => [x, x]) });
const N = (unit: string, min = 0, max = 100_000, step = 1): FieldType => ({ kind: 'number', min, max, step, unit });
/** A switch Konium acts on. */
const sw = (key: keyof Settings, label: string, help?: string): Field => ({ key, label, help, type: B });
const en = (key: keyof Settings, label: string, options: [string, string][], help?: string): Field => ({ key, label, help, type: { kind: 'enum', options } });
const cursorType: Field = { key: 'cursor', label: 'Cursor Type', type: { kind: 'enum', options: [['small', 'Small Cursor 90'], ['large', 'Large Cursor 90']] } };
const VIEW_2D = ['Standard 2D', 'Transparent 2D'];
/** Shift Click To Select's kinds [est: AD's list]. */
const SHIFT_KINDS = ['Arc', 'Component', 'Dimension', 'Fill', 'Pad', 'Polygon', 'Region', 'Room', 'String', 'Track', 'Via', '3D Body'];
const VIEW_3D = VIEW3D_PRESETS.map((p) => p.config);
const showModes: [string, string][] = [['never', 'Never'], ['always', 'Always'], ['onWire', 'On Wire']];

export const PAGES: Page[] = [
  /* ═══ System ═══════════════════════════════════════════════════════════════════════ */
  { id: 'sys-general', group: 'System', title: 'General', sections: [
    { title: 'Startup', fields: [sw('reopenWorkspace', 'Reopen Last Workspace', 'At the start, the projects and documents open when Konium Designer was last closed open again (those it may still reach: else the Home page offers them).'), sw('openHomePage', 'Open Home Page if no documents open', 'View › Home opens it any time.'), sw('showStartupScreen', 'Show startup screen', 'Konium Designer\'s name while it starts.')] },
    { title: 'General', fields: [
      sw('clipboardAppOnly', 'Monitor clipboard content within this application only', 'The Clipboard panel lists what was copied in Konium Designer; off, text other applications copied too (once the browser allows reading it).'),
      { key: 'theme', label: 'UI Theme', type: { kind: 'enum', options: [['classic', 'Classic Light Grey'], ['dark', 'Konium Dark']] } },
      { key: 'toolbars', label: 'Show toolbars', help: 'View › Toolbars.', type: B },
      { key: 'accelPopups', label: 'Show menus for letter shortcuts', help: 'Off: P then W still works, without the popup.', type: B },
    ] },
    { title: 'Default Locations', fields: [
      en('documentPath', 'Document Path', [['last', 'The folder last used'], ['documents', 'Documents'], ['desktop', 'Desktop'], ['downloads', 'Downloads']], 'Where the file selector starts for opening and saving (a saved document goes back where it came from).'),
      en('libraryPath', 'Library Path', [['project', 'The project folder'], ['last', 'The folder last used']], 'Where Install Library\'s file selector starts.'),
    ] },
    { title: 'Messages', fields: [
      { key: 'autoShowMessages', label: 'Open Messages when a file loads with warnings', type: B },
      { key: 'showInfoMessages', label: 'Include information messages', type: B },
    ] },
    { title: 'Localisation', fields: [sw('localised', 'Use localised resources', 'Dates, times and numbers written as this computer\'s language writes them; off, as in Britain. Konium Designer\'s own words stay in English.'),
      en('textCodePage', 'Text without Unicode', [['auto', 'Automatic (from the text and this browser\'s language)'], ['1252', 'Western European (1252)'], ['1250', 'Central European (1250)'], ['1251', 'Cyrillic (1251)'], ['1253', 'Greek (1253)'], ['1254', 'Turkish (1254)'], ['1255', 'Hebrew (1255)'], ['1256', 'Arabic (1256)'], ['1257', 'Baltic (1257)'], ['1258', 'Vietnamese (1258)']],
        'Older files keep their text in the Windows code page of the computer that wrote them (Cyrillic on a Bulgarian or Russian one). Automatic tells it from the text; documents opened from now on are read in it, and their text changed is written back in it.')] },
  ] },
  { id: 'sys-view', group: 'System', title: 'View', sections: [
    { title: 'Desktop', fields: [sw('autosaveDesktop', 'Autosave desktop', 'The panels\' layout is saved as it changes, for the next session; off, changes to it aren\'t saved and the next session starts with the layout saved last (the default layout if none was).'), sw('restoreOpenDocs', 'Restore open documents', 'A project opened again opens the documents it had open when it was closed.')], },
    { title: 'Popup Panels', fields: [
      { key: 'popupDelay', label: 'Popup delay', help: 'Before a pinned-away panel slides out when the cursor rests on its tab.', type: N('ms', 0, 2000, 10) },
      { key: 'popupHideDelay', label: 'Hide delay', help: 'Before it slides back once the cursor has left it.', type: N('ms', 0, 5000, 10) },
      sw('popupAnimation', 'Use animation', 'The panel slides out; off, it appears at once.'),
      { key: 'popupAnimationSpeed', label: 'Animation speed', help: '1 slow, 10 fast.', type: N('', 1, 10) },
    ] },
    { title: 'Drawing', fields: [sw('smoothEdges', 'Smooth edges (anti-aliasing)', 'Off: lines, edges and fills drawn hard on whole screen pixels — the sharpest a screen shows, with stepped diagonals; on: smoothed.')] },
    { title: 'General', fields: [sw('titleFullPath', 'Show full path in title bar', 'The window\'s title gives the document\'s path in its project; off, its name.'), sw('panelShadows', 'Display shadows around menus, toolbars and panels'), sw('hideFloatsOnBlur', 'Hide floating panels on focus change', 'They hide while another window is in use, and come back with Konium Designer\'s.'), sw('layoutPerKind', 'Remember window for each document kind', 'Each kind of document (schematic, board, library …) keeps its own panel layout, put back when one comes to the front.'), sw('autoPreviews', 'Auto show symbol and model previews', 'The Libraries panel draws the part picked; off, its Preview button does.')] },
    { title: 'Documents Bar', fields: [sw('groupTabs', 'Group documents if need', 'When the tabs don\'t fit, documents of a kind share one tab that lists them.'), sw('equalWidthTabs', 'Use equal-width buttons', 'Every tab as wide as the others; long names shortened.'), sw('autoHideTabs', 'Auto-hide the documents bar', 'Hidden while it would hold only one tab: one document, or the Home page or the help on its own.'), sw('multilineTabs', 'Multiline documents bar', 'Tabs that don\'t fit go on another line.'), sw('middleClickCloses', 'Middle click closes document tab')] },
  ] },
  { id: 'sys-transparency', group: 'System', title: 'Transparency', sections: [
    { title: 'Transparency', fields: [sw('transparentFloats', 'Transparent floating windows', 'Floating panels see-through while a tool is at work (placing, moving, routing), so the design under them shows.'), sw('dynTransparency', 'Dynamic transparency', 'The nearer the cursor, the more see-through a floating panel.'),
      { key: 'dynHigh', label: 'Highest transparency', help: 'With the cursor on it.', type: N('%', 0, 95), off: (d) => !d.dynTransparency },
      { key: 'dynLow', label: 'Lowest transparency', help: 'With the cursor the distance factor away, or further.', type: N('%', 0, 95), off: (d) => !d.dynTransparency },
      { key: 'dynDistance', label: 'Distance factor', type: N('px', 1, 2000), off: (d) => !d.dynTransparency }] },
  ] },
  { id: 'sys-nav', group: 'System', title: 'Navigation', sections: [
    { title: 'Highlight Methods', fields: [
      sw('navZoom', 'Zooming', 'Cross-probing a net or part (Navigator, Messages) zooms to it.'), sw('navDim', 'Dimming', 'Everything else dims, and can still be picked (Clear ends it).'), sw('navMask', 'Masking', 'Everything else is faded.'),
      sw('navSelect', 'Selecting', 'It is selected.'), sw('navGraph', 'Connection Graph', 'A net\'s objects on the sheet joined by lines (Clear ends it).'), sw('navPowerParts', 'Include Power Parts', 'A net\'s power ports too.'),
    ] },
    { title: 'Zoom Precision', fields: [
      { key: 'zoomStep', label: 'Zoom step', help: 'Per wheel notch and per PgUp / PgDn.', type: { kind: 'range', min: 1.02, max: 1.5, step: 0.01, format: (v) => `×${v.toFixed(2)}` } },
    ] },
    { title: 'Objects To Display', fields: [sw('navShowPins', 'Pins', 'What the Navigator lists for a net.'), sw('navShowNetLabels', 'Net Labels'), sw('navShowPorts', 'Ports'), sw('navShowEntries', 'Sheet Entries'),
      sw('navShowConnectors', 'Sheet Connectors'), sw('navShowLines', 'Graphical Lines', 'Its wires and buses.')] },
    { title: 'Cross Select Mode', fields: [sw('crossSelect', 'Cross Selection', 'Selecting parts on a sheet selects them on the board, and the other way (Tools › Cross Select Mode).'), { key: 'crossSelectBehaviour', label: 'Selection Behaviour', help: 'The matching objects in the other document are selected; or zoomed to (at once where it is in view, in a window of its own or a split pane; else when it is next shown); or everything else masked.', type: E('Select', 'Zoom', 'Mask') }] },
  ] },
  { id: 'sys-projects', group: 'System', title: 'Projects Panel', sections: [
    { title: 'Opening', fields: [
      { key: 'openProjectDocs', label: 'When a project opens', type: { kind: 'enum', options: [['schpcb', 'Open the first schematic and the board'], ['all', 'Open every document'], ['none', 'Open nothing; show the project tree']] } },
      { key: 'confirmClose', label: 'Ask before closing a document with unsaved changes', type: B },
    ] },
    { title: 'General', fields: [
      sw('projShowStatus', 'Show open/modified status', 'Open documents in bold, modified ones with a dot and *.'),
      sw('projHistoryStatus', 'Show VCS status', 'A project not under version control: how many versions each document has in Local History (⟲3). A project under version control always shows each document\'s state (✓ no change, ● changed, + new, ✕ deleted, ? not in version control, ↓ out of date, ! changed on both sides) and a padlock when it is locked (blue yours, amber someone else\'s).'),
      sw('projShowPosition', 'Show document position in project', 'Each document\'s number in the project.'),
      sw('projFullPathHint', 'Show full path information in hint', 'A document\'s tooltip gives its path from the project\'s folder; off, its name.'), sw('projGrid', 'Show Grid', 'The rows ruled.'),
    ] },
    { title: 'File View', fields: [sw('projShowStructure', 'Show Project Structure', 'Child sheets under their parents; off, every document in a plain list.'), sw('projDocStructure', 'Show Document Structure', 'A schematic\'s sheet symbols and ports under it (double-click one to go to it).')] },
    { title: 'Sorting', fields: [en('projSort', 'Sort by', [['project', 'Project order'], ['alpha', 'Alphabetically'], ['status', 'Open / modified status']]), sw('projAscending', 'Ascending')] },
    { title: 'Grouping', fields: [en('projGroup', 'Group', [['none', 'Do not group'], ['class', 'By class'], ['type', 'By document type']], 'By class: Source Documents, Libraries, Generated, Settings; by document type, libraries and settings in a folder per type; or one list.')] },
    { title: 'Default Expansion', fields: [en('projExpand', 'Expand', [['contracted', 'Fully contracted'], ['one', 'Expanded one level'], ['source', 'Source files expanded'], ['full', 'Fully expanded']], 'How a project\'s folders start; a click on one opens or closes it.')] },
    { title: 'Single Click', fields: [en('projSingleClick', 'Single click', [['nothing', 'Does nothing'], ['activate', 'Activates open documents'], ['open', 'Opens and shows documents']], 'A double-click always opens and shows.')] },
  ] },
  { id: 'sys-files', group: 'System', title: 'File Types', sections: [], custom: 'fileTypes', note: 'The files Konium Designer opens when the operating system hands them over (installed app: open with…, or drop on the window).' },
  { id: 'sys-wheel', group: 'System', title: 'Mouse Wheel Configuration', sections: [], custom: 'wheel' },
  // AD's System › Network Activity: the master switch, then each service; Konium lists every connection below them
  { id: 'sys-network', group: 'System', title: 'Network Activity', custom: 'network', sections: [
    { title: 'Network Activity', wide: true, fields: [
      { key: 'offline', invert: true, label: 'Allow Konium Designer to use network activity', type: B,
        help: 'Off (Offline): no connections at all (no updates, What\'s New, AI jobs, supplier data or reports), and the browser itself is told to refuse any the page could make. On again, connections come back when Konium Designer is next loaded. The Home page has the same switch.' },
      { key: 'checkUpdates', label: 'Check konium.app for updates and What\'s New', type: B, off: (s) => s.offline,
        help: 'Asks konium.app for its version number and What\'s New: nothing about you or your files is sent. Off, a copy installed from konium.app stays on the version it has.' },
    ] },
  ] },
  { id: 'sys-keys', group: 'System', title: 'Keyboard Shortcuts', sections: [], custom: 'shortcuts' },
  { id: 'sys-ai', group: 'System', title: 'AI', sections: [], custom: 'ai' },

  /* ═══ Data Management ══════════════════════════════════════════════════════════════ */
  { id: 'dm-libs', group: 'Data Management', title: 'Installed Libraries', sections: [], custom: 'installedLibs' },
  { id: 'dm-search', group: 'Data Management', title: 'File-based Libraries', sections: [
    { title: 'Search Path', fields: [en('libSearch', 'Libraries are found in', [['all', "Open libraries, the project's and Installed Libraries"], ['project', "The project's libraries (and those open) only"], ['installed', 'Installed Libraries only']], 'Where Place Part, Update From Libraries and Update PCB look for symbols and footprints.')] },
  ] },
  { id: 'dm-templates', group: 'Data Management', title: 'Templates', sections: [
    { title: 'Templates', fields: [
      { label: 'Template', help: 'The sheet template (.SchDot) new schematics start from, kept in this browser.', type: { kind: 'action', command: 'dm.chooseTemplate', button: 'Choose Template...' } },
      { key: 'templateName', label: 'Template chosen', help: 'Its name (choose another with the button above).', type: T, off: () => true },
      sw('useTemplates', 'Use templates for new documents', 'File › New › Schematic starts from the template chosen.')] },
  ] },
  { id: 'dm-backup', group: 'Data Management', title: 'Backup', sections: [
    { title: 'Auto save', fields: [
      sw('autoSave', 'Auto save every', 'Changed documents are copied into this browser\'s storage; after a crash or a closed tab, Konium Designer offers them back when it starts. Saving or closing a document clears its copies.'),
      { key: 'autoSaveMinutes', label: 'Minutes', type: N('min', 1, 120) },
      { key: 'autoSaveVersions', label: 'Number of versions to keep', help: 'The oldest copy is reused after this many (Name.~(1).SchDoc, Name.~(2).SchDoc …).', type: N('', 1, 10) },
      { label: 'Path', help: 'The copies stay in this browser; a folder chosen here gets them too (Name.~(1).SchDoc …), once the browser allows it.', type: { kind: 'action', command: 'dm.chooseBackupFolder', button: 'Choose Folder...' } },
      { key: 'backupFolder', label: 'Folder chosen', help: 'Empty: this browser\'s storage only. Clear it with the button below.', type: T, off: () => true },
      { label: 'Browser storage only', type: { kind: 'action', command: 'dm.clearBackupFolder', button: 'No Folder' } },
    ] },
  ] },
  { id: 'dm-vcs', group: 'Data Management', title: 'Version Control', custom: 'vcs', feature: 'versionControl',
    note: 'A project opened from its folder can be put under version control (Project › Version Control): every version kept in a Git repository in its folder, and kept with the team in Konium\'s store or on the team\'s own Git server.',
    sections: [
      { title: 'Your name in the history', fields: [
        { key: 'vcsName', label: 'Name', help: 'Each commit carries it, for the team to see who changed what.', type: T },
        { key: 'vcsEmail', label: 'Email', help: 'Carried with the name (Git\'s way of telling people apart); not checked or used for anything else.', type: T },
      ] },
      { title: 'Teams\' own Git servers', fields: [
        en('vcsRelay', 'Reached through', [['konium', 'Konium\'s relay (konium.app/api/git)'], ['none', 'Straight: the server lets pages reach it (CORS)'], ['custom', 'Another relay']],
          'Most Git servers (GitHub, GitLab, Bitbucket) don\'t let a page reach them: Konium\'s relay passes Git\'s requests on and keeps nothing. A server of your own with CORS on needs none.'),
        { key: 'vcsRelayUrl', label: 'Relay address', help: 'A relay that works as isomorphic-git\'s CORS proxy does (https://…, the server\'s address after it).', type: T, off: (d) => d.vcsRelay !== 'custom' },
      ] },
      { title: 'Others\' changes', fields: [
        { key: 'vcsCheckMinutes', label: 'Look for them every', help: 'An open project under version control looks for what the team pushed (↓ in the Projects panel); 0: only when you update.', type: N('min', 0, 120) },
      ] },
    ] },
  { id: 'dm-history', group: 'Data Management', title: 'Local History', sections: [
    { title: 'Local History', fields: [
      { key: 'historyDays', label: 'Number of days to keep documents in history', help: 'Each save keeps the file it replaces (Storage Manager › Local History); older versions go, labelled ones stay.', type: N('days', 1, 10) },
      sw('historyAutosaves', 'Add autosaved documents to history', 'Auto-saved copies show as Version n [AutoSave …] too.'),
      sw('historyGlobal', 'Use global repository', 'Off: a project opened from its folder keeps its history in a History folder beside the project file. On (and for projects opened without folder access): in this browser.'),
    ] },
  ] },

  /* ═══ Schematic ════════════════════════════════════════════════════════════════════ */
  { id: 'sch-general', group: 'Schematic', title: 'General', sections: [
    { title: 'Options', fields: [
      sw('schBreakAtAutoJunctions', 'Break Wires At Autojunctions', 'A wire ended part-way along another splits that wire there.'),
      sw('schOptimizeWires', 'Optimise Wires & Buses', 'A wire placed end-on to another in line becomes one wire.'),
      sw('schComponentsCutWires', 'Components Cut Wires', 'A part dropped onto a wire with two pins on it removes the wire between them.'),
      sw('schInPlaceEditing', 'Enable In-Place Editing', 'Click a selected text again to edit it where it is.'),
      sw('schConvertCrossJunctions', 'Convert Cross-Junctions', 'A wire placed into a junction that makes a crossing becomes two T-junctions.'),
      sw('schDisplayCrossOvers', 'Display Cross-Overs', 'Wires that cross without connecting hop over each other.'),
      { key: 'schPinDirection', label: 'Pin Direction', help: 'Triangles on input, output and bidirectional pins.', type: B },
      sw('schSheetEntryDirection', 'Sheet Entry Direction', 'Sheet entries point the way their I/O type says.'),
      sw('schPortDirection', 'Port Direction', 'Ports point the way their I/O type says, away from (output) or towards (input) what they connect to.'),
      sw('schUnconnectedLeftToRight', 'Unconnected Left To Right', 'Ports joined to nothing point left to right.'),
      { key: 'schOverlines', label: 'Render overlines', help: 'R\\S\\T\\ shows RST with a bar over it.', type: B },
      sw('schDragOrthogonal', 'Drag Orthogonal', 'Wires dragged with a part stay at right angles (off: they stretch straight).'),
    ] },
    { title: 'Include with Clipboard', fields: [sw('schClipNoErc', 'No-ERC Markers'), sw('schClipParameterSets', 'Parameter Sets'), sw('schClipNotes', 'Notes')] },
    { title: 'Alpha Numeric Suffix', fields: [{ key: 'schSuffix', label: 'Suffix', help: 'Parts of a package as U1A, U1B or U1:1, U1:2.', type: { kind: 'radio', options: [['alpha', 'Alpha'], ['numeric', 'Numeric']] } }] },
    { title: 'Pin Margin', fields: [
      { key: 'schPinNameMargin', label: 'Name', help: 'From the body edge, inside the body.', type: N('mil', 0, 300, 5) },
      { key: 'schPinNumberMargin', label: 'Number', help: 'From the body edge, along the pin.', type: N('mil', 0, 300, 5) },
    ] },
    { title: 'Auto-Increment During Placement', fields: [{ key: 'schIncPrimary', label: 'Primary', help: 'Designators, net labels and pin numbers step by this.', type: N('', -100, 100) },
      { key: 'schIncSecondary', label: 'Secondary', help: 'Pin names step by this.', type: N('', -100, 100) }, sw('schRemoveLeadingZeroes', 'Remove Leading Zeroes', 'D09 steps to D10; on: D9 → D10, and 01 → 2.')] },
    { title: 'Port Cross References', fields: [{ key: 'schPortRefSheet', label: 'Sheet Style', type: { kind: 'enum', options: [['name', 'Name'], ['number', 'Number']] } },
      { key: 'schPortRefLocation', label: 'Location Style', type: { kind: 'enum', options: [['zone', 'Zone'], ['xy', 'Location X,Y']] } }] },
    { title: 'Default Power Object Names', fields: [
      { key: 'schPowerGroundName', label: 'Power Ground', type: T },
      { key: 'schSignalGroundName', label: 'Signal Ground', type: T },
      { key: 'schEarthName', label: 'Earth', type: T },
    ] },
    { title: 'Document scope for filtering and selection', fields: [en('schFilterScope', 'Scope', [['current', 'Current Document'], ['open', 'Open Documents']], 'Where SCH Filter and Find Similar Objects look first.')] },
    { title: 'Default Blank Sheet Template or Size', fields: [en('schDefaultSheet', 'Sheet Size', [['A4', 'A4'], ['A3', 'A3'], ['A2', 'A2'], ['A', 'A'], ['B', 'B'], ['C', 'C'], ['Letter', 'Letter'], ['Tabloid', 'Tabloid']], 'File › New › Schematic starts on this.')] },
    { title: 'Text (display)', fields: [
      { key: 'schTextScale', label: 'Text size', help: '100% draws fonts at the sizes stored in the document.', type: { kind: 'range', min: 0.5, max: 2, step: 0.05, format: pct } },
      { key: 'schDocumentFonts', label: "Use the document's fonts", help: 'Times New Roman, Arial… as named in the file.', type: B },
      { key: 'schTextAnchor', label: 'Text anchor', help: 'Schematic files place text by the bottom of its character cell.', type: { kind: 'enum', options: [['cell', 'Character cell'], ['baseline', 'Baseline']] } },
    ] },
  ] },
  { id: 'sch-edit', group: 'Schematic', title: 'Graphical Editing', sections: [
    { title: 'Options', fields: [
      sw('schClipboardReference', 'Clipboard Reference', 'Copy and Cut ask for the point to paste by.'), sw('schTemplateToClipboard', 'Add Template to Clipboard', 'Copying everything takes the template graphics too.'), { key: 'schShowSpecialNames', label: 'Display Names of Special Strings that have No Value Set', help: "Off: a special string such as =Title with no value shows nothing.", type: B }, sw('schGrabCentre', 'Centre of Object', 'A dragged object hangs from its centre.'), sw('schGrabHotSpot', "Object's Electrical Hot Spot", 'A dragged object hangs from its nearest electrical hot spot.'),
      sw('schAutoZoom', 'Auto Zoom', 'Jumping to an object zooms to it (off: the view only pans).'), sw('schSingleNegation', "Single '\\' Negation", "\\RESET puts the bar over the whole name."),
      sw('schDoubleClickInspector', 'Double Click Runs Inspector', 'Double-click shows the SCH Inspector instead of the properties dialog.'), sw('schConfirmMemoryClear', 'Confirm Selection Memory Clear'),
      sw('schMarkManualParams', 'Mark Manual Parameters', 'A dot by parameters moved off their automatic place.'), sw('schClickClearsSelection', 'Click Clears Selection', 'A click on empty space deselects everything.'),
      sw('schShiftClickToSelect', 'Shift Click To Select', 'Objects select only with Shift held.'),
      { key: 'schAlwaysDrag', label: 'Always Drag', help: 'Dragging an object with the mouse keeps its wires attached. Off: Ctrl+drag does that, a plain drag moves.', type: B },
      sw('schAutoSheetEntries', 'Place Sheet Entries automatically', 'A wire ended on a sheet symbol\'s edge adds an entry there.'), sw('schProtectLocked', 'Protect Locked Objects', 'Locked objects don\'t move or go with Delete.'),
      sw('schHarnessColour', 'Sheet Entries and Ports use Harness Colour', 'Entries and ports carrying a harness take its colour.'),
      { key: 'schResetDesignatorsOnPaste', label: 'Reset Parts Designators On Paste', help: 'Pasted and duplicated parts come in unannotated (R?, C?, U?).', type: B },
      { key: 'schNetColourOverride', label: 'Net Colour Override', help: 'View › Set Net Colours draws nets in their colours; F5 toggles.', type: B },
    ] },
    { title: 'Auto Pan Options', fields: [en('schAutoPan', 'Style', [['off', 'Auto Pan Off'], ['jump', 'Auto Pan Fixed Jump'], ['recenter', 'Auto Pan ReCenter']], 'While placing or moving, the view follows the cursor past the edge.'),
      { key: 'schAutoPanSpeed', label: 'Speed', type: N('', 1, 10) }, { key: 'schAutoPanStep', label: 'Step Size', type: N('px', 1, 5000) }, { key: 'schAutoPanShiftStep', label: 'Shift Step Size', type: N('px', 1, 5000) }] },
    { title: 'Undo/Redo', fields: [{ key: 'schUndoStack', label: 'Stack Size', help: 'Steps kept for undo (0: unlimited).', type: N('', 0, 1000) }, sw('schGroupUndo', 'Group Undo', 'Several quick edits of one kind undo together.')] },
    { title: 'Colour Options', fields: [
      { key: 'selectionColour', label: 'Selections', type: C },
      { key: 'schUseDocumentColours', label: "Use the document's colours", help: "Off: draw with Konium Designer's schematic palette.", type: B },
      { key: 'schWorkspaceColour', label: 'Workspace', help: 'The area around the sheet.', type: C },
    ] },
    { title: 'Cursor', fields: [cursorType, { key: 'cursorColourSch', label: 'Cursor colour', type: C }] },
    { title: 'Placement', fields: [{ key: 'schWireCorner', label: 'Wire corner mode', help: 'Shift+Space cycles while placing.', type: { kind: 'enum', options: corner } }] },
  ] },
  { id: 'sch-wheel', group: 'Schematic', title: 'Mouse Wheel Configuration', sections: [], custom: 'wheel' },
  { id: 'sch-compiler', group: 'Schematic', title: 'Compiler', sections: [
    { title: 'Errors & Warnings', fields: [sw('schShowFatal', 'Display Fatal Error', 'After a compile, wavy underlines under objects with fatal errors.'), sw('schShowErrors', 'Display Error'), sw('schShowWarnings', 'Display Warning')] },
    { title: 'Auto-Junctions', fields: [
      { key: 'schAutoJunctions', label: 'Display On Wires', help: 'Dots where three or more connections meet: the junctions the schematic placed itself (records not locked), and any it should have.', type: B },
      { key: 'schAutoJunctionSize', label: 'Size', type: { kind: 'enum', options: [['smallest', 'Smallest'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] } },
      { key: 'schAutoJunctionColour', label: 'Colour', help: 'Automatic junctions (those not placed by hand) are drawn in this colour.', type: C },
      sw('schAutoJunctionsBuses', 'Display On Buses'),
      { key: 'schAutoJunctionBusColour', label: 'Bus Colour', type: C },
    ] },
    { title: 'Manual Junctions Connection Status', fields: [sw('schManualJunctionStatus', 'Display', 'A ring round each manual junction: green with three or more connections, red with fewer.'),
      en('schManualJunctionSize', 'Size', [['smallest', 'Smallest'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']])] },
    { title: 'Compiled Names Expansion', fields: [
      sw('schCompiledDesignators', 'Designators', 'After a compile, the tabs under a sheet (Compiled, or one per channel of a repeated sheet) show each instance\'s names: its parts\' designators.'),
      sw('schCompiledNetLabels', 'Net Labels', 'Its net labels as the nets they name in that instance.'),
      sw('schCompiledPorts', 'Ports and Sheet Entries', 'Its ports and sheet entries as their nets.'),
      sw('schCompiledPower', 'Power Ports', 'Its power ports as their nets.'),
      sw('schCompiledDocNumber', 'Document Number', '=DocumentNumber with the channel after it.'),
      sw('schCompiledSheetNumber', 'Sheet Number', '=SheetNumber and =SheetTotal counted over every instance of every sheet.')] },
  ] },
  { id: 'sch-autofocus', group: 'Schematic', title: 'AutoFocus', sections: [
    { title: 'Dim Unconnected Objects', fields: [sw('schDimOnPlace', 'On Place'), sw('schDimOnMove', 'On Move'), sw('schDimOnEdit', 'On Edit Graphically'), sw('schDimOnInPlace', 'On Edit In Place'),
      sw('schDimAll', 'All Objects', 'Dim everything not joined to what you work on, graphics included.'), { key: 'schDimLevel', label: 'Dim level', type: N('%') }] },
    { title: 'Thicken Connected Objects', fields: [sw('schThickenOnPlace', 'On Place'), sw('schThickenOnMove', 'On Move'), sw('schThickenOnEdit', 'On Edit Graphically'), sw('schThickenOnInPlace', 'On Edit In Place'),
      { key: 'schThickenDelay', label: 'Delay', help: 'How long the connected wires stay thick.', type: N('ms', 0, 5000, 10) }] },
    { title: 'Zoom Connected Objects', fields: [sw('schZoomOnPlace', 'On Place'), sw('schZoomOnMove', 'On Move'), sw('schZoomOnEdit', 'On Edit Graphically'), sw('schZoomOnInPlace', 'On Edit In Place'),
      sw('schZoomNonNetOnly', 'Restrict To Non-net Objects Only')] },
  ] },
  { id: 'sch-libzoom', group: 'Schematic', title: 'Library AutoZoom', sections: [
    { title: 'Zoom Options', fields: [{ key: 'schLibZoom', label: 'When switching components', type: { kind: 'radio', options: [['keep', 'Do not change zoom between components'], ['remember', 'Remember last zoom for each component'], ['centre', 'Centre each component in editor']] } }] },
  ] },
  { id: 'sch-grids', group: 'Schematic', title: 'Grids', sections: [
    { title: 'Grid Options', fields: [
      { key: 'schGridStyle', label: 'Visible Grid', type: { kind: 'enum', options: [['lines', 'Line Grid'], ['dots', 'Dot Grid']] } },
      { key: 'schGridColour', label: 'Grid Colour', type: C },
    ] },
  ], custom: 'gridPresets' },
  { id: 'sch-breakwire', group: 'Schematic', title: 'Break Wire', sections: [
    { title: 'Cutting Length', fields: [
      { key: 'schBreakCut', label: 'Cutting length', help: 'Space steps through these while breaking.', type: { kind: 'radio', options: [['segment', 'Snap To Segment'], ['grid', 'Snap Grid Size Multiple'], ['fixed', 'Fixed Length']] } },
      { key: 'schBreakMultiple', label: 'Snap Grid Size Multiple', type: N('× grid', 1, 50) },
      { key: 'schBreakFixed', label: 'Fixed Length', type: N('mil', 1, 10_000, 10) },
    ] },
    { title: 'Show Cutter Box', fields: [{ key: 'schBreakCutterBox', label: 'Cutter box', type: { kind: 'radio', options: showModes } }] },
    { title: 'Show Extremity Markers', fields: [{ key: 'schBreakMarkers', label: 'Extremity markers', type: { kind: 'radio', options: showModes } }] },
  ] },
  { id: 'sch-units', group: 'Schematic', title: 'Default Units', sections: [
    { title: 'Unit System', fields: [
      { key: 'defaultUnits', label: 'Units at start-up', help: 'Also the PCB editor\'s. Q toggles units in the PCB editors; a schematic sheet shows its own units (Document Options).', type: { kind: 'radio', options: [['mil', 'Use Imperial Unit System (mils)'], ['mm', 'Use Metric Unit System (mm)']] } },
      en('schImperialUnit', 'Imperial unit used', [['dxp', 'Dxp Defaults'], ['mil', 'Mils'], ['in', 'Inches'], ['auto', 'Auto-Imperial']], 'Dxp Defaults: 10 mil units, as the file stores them.'),
      en('schMetricUnit', 'Metric unit used', [['mm', 'Millimetres'], ['cm', 'Centimetres'], ['m', 'Metres'], ['auto', 'Auto-Metric']]),
    ] },
  ] },
  { id: 'sch-primitives', group: 'Schematic', title: 'Default Primitives', sections: [
    { title: 'Pin', fields: [{ key: 'schPinLength', label: 'Length', help: 'Place › Pin and the symbols the Component Builder makes start with this (the usual length is 300mil). The rest of a pin is its default in the list above.', type: N('mil', 0, 2000, 10) }] },
  ], custom: 'schPrimitives' },
  { id: 'sch-orcad', group: 'Schematic', title: 'Orcad (tm)', sections: [
    { title: 'Copy Footprint From/To', fields: [{ key: 'orcadFootprintField', label: 'Part Field', help: 'Importing an OrCAD design, a part\'s footprint comes from this field (when the part has it), else from its PCB Footprint.', type: E('Part Field 1', 'Part Field 2', 'Part Field 3', 'Part Field 4') }] },
    { title: 'Orcad Ports', fields: [sw('orcadPorts', 'Mode', 'A port is as wide as its name and goes down with one click, as OrCAD sizes them.')] },
  ] },
  { id: 'sch-devsheets', group: 'Schematic', title: 'Device Sheets', sections: [
    { title: 'Device Sheet Folders', fields: [sw('schDeviceReadOnly', 'Make Device Sheets Read-Only', 'Device sheets open for viewing; edits are refused.')] },
  ], custom: 'deviceFolders' },
  { id: 'sch-paramsets', group: 'Schematic', title: 'Parameter Sets', sections: [
    { title: 'Default Parameter Set', fields: [en('schParamSetStyle', 'Style', [['large', 'Large'], ['tiny', 'Tiny']], 'How newly placed parameter sets and directives are drawn.')] },
  ] },
  { id: 'sch-portrefs', group: 'Schematic', title: 'Port Cross References', sections: [
    { title: 'Port Cross References', fields: [{ key: 'schPortRefSheet', label: 'Sheet Style', type: { kind: 'enum', options: [['name', 'Name'], ['number', 'Number']] } },
      { key: 'schPortRefLocation', label: 'Location Style', type: { kind: 'enum', options: [['zone', 'Zone'], ['xy', 'Location X,Y']] } }] },
  ] },

  /* ═══ PCB Editor ═══════════════════════════════════════════════════════════════════ */
  { id: 'pcb-general', group: 'PCB Editor', title: 'General', sections: [
    { title: 'Editing Options', fields: [
      { key: 'pcbOnlineDrc', label: 'Online DRC', help: 'Check the rules ticked Online in Tools › Design Rule Check as you edit; violations show in green.', type: B },
      { key: 'pcbSnapToCenter', label: 'Snap To Centre', help: 'A component being moved jumps to the cursor by its reference point, and turns about it.', type: B },
      sw('pcbSmartComponentSnap', 'Smart Component Snap', 'A component picked up by a pad is held by that pad\'s centre, the nearest to the click.'),
      sw('pcbSnapRoomHotSpots', 'Snap To Room Hot Spots', 'A room picked up is held by its nearest corner.'),
      sw('pcbRemoveDuplicates', 'Remove Duplicates', 'Outputs (Gerber, NC drill, ODB++ …) made with an object that is the same as another, in the same place, only once.'),
      sw('pcbConfirmGlobalEdit', 'Confirm Global Edit', 'Ask before a change typed in the PCB List goes to every selected object.'),
      sw('pcbProtectLocked', 'Protect Locked Objects', 'Locked objects stay where they are when the selection moves, and don\'t go with Delete.'),
      sw('pcbConfirmMemoryClear', 'Confirm Selection Memory Clear', 'Ask before Clear empties a selection memory.'),
      sw('pcbClickClearsSelection', 'Click Clears Selection', 'A click on empty space deselects everything.'),
      sw('pcbDoubleClickInspector', 'Double Click Runs Inspector', 'Double-click shows the PCB Inspector instead of the properties dialog.'),
      sw('pcbShiftClickSelect', 'Shift Click To Select', 'Objects of the kinds ticked below are selected only with Shift+click (a plain click passes them by).'),
      { key: 'pcbShiftClickKinds', label: 'Primitives', off: (d) => !d.pcbShiftClickSelect, type: { kind: 'multi', options: SHIFT_KINDS.map((k): [string, string] => [k, k]) } },
      sw('pcbSmartTrackEnds', 'Smart Track Ends', 'Connection lines of a partly routed net run from where its copper ends nearest (a track\'s end, a via), not only from its pads.'),
      sw('pcbSelectPopup', 'Display popup selection dialog', 'A click on overlapping objects lists them to choose from.'),
    ] },
    { title: 'Other', fields: [
      { key: 'pcbUndoStack', label: 'Undo/Redo', help: 'Steps kept for undo (0: unlimited).', type: N('', 0, 1000) },
      { key: 'pcbRotationStep', label: 'Rotation Step', help: 'Space turns the objects being moved or placed by this angle counter-clockwise, Shift+Space clockwise.', type: N('°', 1, 180) },
      cursorType,
      { key: 'cursorColourPcb', label: 'Cursor colour', type: C },
      en('pcbCompDrag', 'Comp Drag', [['none', 'None'], ['tracks', 'Connected Tracks']], 'Edit › Drag on a component: its tracks stay joined to its pads, or stay where they are.'),
    ] },
    { title: 'Autopan Options', fields: [
      { key: 'pcbAutoPan', label: 'Style', help: 'Placing or moving past the window\'s edge: the view re-centres on the cursor, jumps, or moves at Speed (Shift faster or slower; Ballistic gathers speed; Adaptive the same at any zoom).', type: E('Disable', 'Re-Centre', 'Fixed Size Jump', 'Shift Accelerate', 'Shift Decelerate', 'Ballistic', 'Adaptive') },
      { key: 'pcbAutoPanSpeed', label: 'Speed', type: N('mils/sec', 1, 10_000), off: (d) => !['Shift Accelerate', 'Shift Decelerate', 'Ballistic', 'Adaptive'].includes(d.pcbAutoPan) }] },
    { title: 'Polygon Rebuild', fields: [
      { key: 'pcbRepourAfterModification', label: 'Repour Polygons After Modification', help: 'On: a pour is repoured as soon as it is edited or moved. Off: Tools › Polygon Pours › Repour does it.', type: B },
      { key: 'pcbRepourDependent', label: 'Repour all dependent polygons after modification', help: 'Also repour pours whose area contains objects that were moved or edited.', type: B },
    ] },
    { title: 'File Format Change Report', fields: [
      sw('pcbNoReportOlder', 'Disable opening the report from older versions', 'A board saved by an older version of the format opens without a report of what changed since.'),
      sw('pcbNoReportNewer', 'Disable opening the report from newer versions', 'A board saved by a newer version of the desktop tools opens without the report that version wrote of what an older one may not keep.')] },
    { title: 'Paste from other applications', fields: [{ key: 'pcbPasteFormat', label: 'Preferred Format', help: 'Paste with nothing copied in Konium Designer takes what another application copied: a drawing (SVG) as lines, or text as a string.', type: E('Metafile', 'Text') }] },
  ] },
  { id: 'pcb-display', group: 'PCB Editor', title: 'Display', sections: [
    { title: 'Display Options', fields: [sw('pcbAntialiasText', 'Antialiased Text', 'Strings drawn smoothed; off, hard-edged, each pixel in or out.'),
      sw('pcbAlphaBlending', 'Use Alpha Blending', 'The area dragged out to select shaded see-through; off, outlined only.'), sw('pcbRepaintIndicator', 'Show Repaint Indicator', 'A small square in the corner that changes colour each time the board is drawn again.'),
      { key: 'pcbShowPours', label: 'Show polygon pours', type: B },
      { key: 'pcbShowHiddenText', label: 'Show hidden designators and comments', type: B },
      { key: 'pcbShowHoles', label: 'Show pad and via holes', type: B },
      { key: 'pcbShowConnections', label: 'Show connection lines', help: 'Unrouted connections, shortest pad to pad.', type: B },
    ] },
    { title: 'Highlighting Options', fields: [sw('pcbHighlightInFull', 'Highlight In Full', 'Selected objects filled in the selection colour; off, outlined in it.'),
      sw('pcbMaskTransparent', 'Use Transparent Mode When Masking', 'Masked objects see-through; off, drawn solid, faded towards the background.'),
      sw('pcbHighlightAllPrims', 'Show All Primitives In Highlighted Nets', 'A highlighted net\'s objects on hidden layers are highlighted too.'),
      sw('pcbMaskWhileEditing', 'Apply Mask During Interactive Editing', 'The mask stays while a tool is at work; off, everything shows while placing, moving or routing.'),
      sw('pcbHighlightWhileEditing', 'Apply Highlight During Interactive Editing', 'The highlight stays while a tool is at work.'),
    ] },
    { title: 'Default PCB View Configurations', fields: [
      { key: 'pcbDefault2d', label: 'PCB 2D', help: 'A board opens in this 2D view configuration, unless the view has been made your own (Custom).', type: E(...VIEW_2D) },
      { key: 'pcbDefault3d', label: 'PCB 3D', help: 'A board opens in this 3D view configuration, unless the one shown has been changed.', type: E(...VIEW_3D) },
      { key: 'pcbLibDefault2d', label: 'PCB Library 2D', type: E(...VIEW_2D) }, { key: 'pcbLibDefault3d', label: 'PCB Library 3D', type: E(...VIEW_3D) }] },
    { title: 'Draft Thresholds', fields: [
      { key: 'pcbDraftTracks', label: 'Tracks', help: 'Tracks and arcs narrower than this are drawn as single lines.', type: N('mil', 0, 100, 0.5) },
      { key: 'pcbDraftStrings', label: 'Strings', help: 'Strings smaller than this on screen are drawn as boxes where they stand.', type: N('pixels', 0, 100) }] },
    { title: 'Other', fields: [{ label: 'Layer Drawing Order', help: 'Which kinds of layer draw over which: the first in the list on top (by default: multi-layer, the overlays, the connections, the current layer, the signal layers … the grid).', type: { kind: 'action', command: 'pcb.layerDrawingOrder', button: 'Layer Drawing Order...' } }] },
    { title: 'Grid', fields: [
      { key: 'pcbGridStyle', label: 'Grid', type: { kind: 'enum', options: [['dots', 'Dots'], ['lines', 'Lines']] } },
      { key: 'pcbGridColour', label: 'Grid colour', type: C },
    ] },
    { title: 'System Colours', fields: [
      { key: 'pcbBackground', label: 'Workspace', type: C },
      { key: 'pcbBoardColour', label: 'Board Area Colour', type: C },
      { key: 'pcbViaColour', label: 'Via Holes and Vias', type: C },
      { key: 'pcbHoleColour', label: 'Pad Holes', type: C },
      { key: 'pcbConnectionColour', label: 'Connection Lines', type: C },
    ] },
  ] },
  { id: 'pcb-insight', group: 'PCB Editor', title: 'Board Insight Display', sections: [
    { title: 'Pad and Via Display Options', fields: [
      sw('pcbNetSmartColour', 'Use Smart Display Colour', 'Pad and via names, and net names on tracks, in dark or light: whichever stands out against the colour of their layer.'),
      en('pcbNetFont', 'Font Name', [['Arial', 'Arial'], ['Tahoma', 'Tahoma'], ['Verdana', 'Verdana'], ['IBM Plex Sans Condensed', 'IBM Plex Sans Condensed']]),
      en('pcbNetStyle', 'Font Style', [['Regular', 'Regular'], ['Bold', 'Bold'], ['Italic', 'Italic'], ['Bold Italic', 'Bold Italic']]),
      { key: 'pcbNetMinPx', label: 'Minimum Font Size', help: 'Names smaller than this on screen aren\'t drawn.', type: N('pixels', 1, 100) },
      { key: 'pcbNetMaxPx', label: 'Maximum Font Size', help: 'Names grow no bigger than this however far you zoom in.', type: N('pixels', 1, 200) },
      { key: 'pcbNetMinObjectPx', label: 'Minimum Object Size', help: 'Pads and vias smaller than this on screen get no name.', type: N('pixels', 0, 100) },
      { key: 'pcbShowPadNumbers', label: 'Show pad numbers', help: 'The pad designator on each pad (when zoomed in far enough to read).', type: B },
      { key: 'pcbShowPadNets', label: 'Show pad nets', help: 'The net name on each pad.', type: B },
      { key: 'pcbShowViaNets', label: 'Show via nets', type: B },
      { key: 'pcbTrackNetNames', label: 'Net names on tracks', type: { kind: 'enum', options: [['none', 'Do Not Display'], ['single', 'Single and Centred'], ['repeated', 'Repeated']] } },
    ] },
    { title: 'Available Single Layer Modes', fields: [
      { key: 'pcbSingleLayerModes', label: 'Shift+S cycles through', type: { kind: 'enum', options: [['both', 'Hide Other Layers, then Grey Scale Other Layers'], ['hide', 'Hide Other Layers'], ['grey', 'Grey Scale Other Layers']] } },
      sw('pcbSingleMono', 'Monochrome Other Layers', 'Shift+S also shows the other layers in one grey.'),
    ] },
    { title: 'Live Highlighting', fields: [
      sw('pcbLive', 'Enabled', 'The net under the cursor lights up as it passes over.'),
      sw('pcbLiveShift', 'Live Highlighting only when Shift Key Down'),
      { key: 'pcbLiveUp', label: 'Ramp Up Time', help: 'How long it takes to light up.', type: N('ms', 0, 5000, 10) },
      { key: 'pcbLiveDown', label: 'Ramp Down Time', help: 'How long it takes to fade once the cursor has left.', type: N('ms', 0, 10_000, 10) },
      { key: 'pcbLiveStrength', label: 'Outline Strength', type: N('%', 0, 100) },
    ] },
    { title: 'Show Locked Texture on Objects', fields: [{ key: 'pcbLockedTexture', label: 'Show', help: 'Dark hatching over locked objects: never, always, or on those live highlighting lights.', type: { kind: 'radio', options: [['never', 'Never'], ['always', 'Always'], ['live', 'Only when Live Highlighting']] } }] },
    { title: 'Origin', fields: [{ key: 'pcbShowOriginMarker', label: 'Show origin marker', type: B }] },
  ] },
  { id: 'pcb-insightmodes', group: 'PCB Editor', title: 'Board Insight Modes', sections: [
    { title: 'Display', fields: [
      sw('pcbHud', 'Display Heads Up Information', 'Beside the cursor: where it is, how far from the last click, the layer and the grid (Shift+H shows and hides it).'),
      sw('pcbHudBackground', 'Use Background Colour', 'On a dark panel, so it reads over anything.'),
      sw('pcbHudInsertResets', 'Insert Key Resets Heads Up Delta Origin'),
      sw('pcbHudClickResets', 'Mouse Click Resets Heads Up Delta Origin'),
      { key: 'pcbHudHoverDelay', label: 'Hover Mode Delay', help: 'Rest the cursor this long and the display adds what lies under it: the objects, their nets, the component and the violations.', type: N('ms', 0, 10_000, 50) },
    ] },
    { title: 'Visible Display Modes', fields: [
      sw('pcbHudCursor', 'Cursor Location'), sw('pcbHudDelta', 'Last Click Delta'), sw('pcbHudLayer', 'Current Layer'), sw('pcbHudGrid', 'Snap Grid'),
      sw('pcbHudSummary', 'Summary', 'How many objects are under the cursor, and what they are.'), sw('pcbHudShortcuts', 'Heads Up Shortcuts'),
      sw('pcbHudViolations', 'Violation Details'), sw('pcbHudNet', 'Net Details'), sw('pcbHudComponent', 'Component Details'), sw('pcbHudPrimitive', 'Primitive Details'),
    ] },
  ] },
  { id: 'pcb-insightcolours', group: 'PCB Editor', title: 'Board Insight Colour Overrides', sections: [
    { title: 'Base Pattern', fields: [{ key: 'pcbOverridePattern', label: 'Pattern', help: "A net's colour override (Nets panel › Override Colour) drawn in this pattern over its layer's colour; Solid, the override colour alone.", type: E('Solid', 'Checkerboard', 'Stripe', 'Large Checkerboard') }] },
    { title: 'Zoom Out Behaviour', fields: [{ key: 'pcbOverrideZoomOut', label: 'Behaviour', help: 'Zoomed out until the pattern is too fine to see: the pattern grows to stay visible, the override colour is drawn solid, or the layer colour alone shows.', type: { kind: 'radio', options: [['base', 'Base Pattern Scales'], ['override', 'Override Colour Dominates'], ['original', 'Original Colour Dominates']] } }] },
  ] },
  { id: 'pcb-drcdisplay', group: 'PCB Editor', title: 'DRC Violations Display', sections: [
    { title: 'Violation Overlay Style', fields: [{ key: 'pcbViolationStyle', label: 'Style', help: 'Objects in violation: left in their layer colour, drawn in the violation colour, hatched (Style A) or cross-hatched (Style B).', type: E('None (Layer Colour)', 'Solid (Override Colour)', 'Style A', 'Style B') },
      { key: 'pcbViolationStyleOut', label: 'Overlay (Zoomed Out)', help: 'The same, once zoomed out until the hatching is too fine to see.', type: E('None', 'Solid', 'Style A', 'Style B') }] },
    { title: 'Display', fields: [
      sw('pcbViolationDetails', 'Show Violation Details', 'A cross where each violation is.'),
      sw('pcbViolationOverlay', 'Show Violation Overlay', 'The objects in violation drawn in the violation colour.'),
    ], },
  ], note: 'Violations show as error markers on the board; Tools › Reset Error Markers clears them.' },
  { id: 'pcb-routing', group: 'PCB Editor', title: 'Interactive Routing', sections: [
    // Laid out as AD17's page: these two side by side, then Options beside Width Sources, Gloss beside Favorites
    { title: 'Routing Conflict Resolution', fields: [
      sw('pcbModeIgnore', 'Ignore Obstacles', 'The route goes where the cursor is; what it breaks is marked.'),
      sw('pcbModePush', 'Push Obstacles', 'Free tracks of other nets move aside; the route stops at fixed objects.'),
      sw('pcbModeWalkaround', 'Walkaround Obstacles', 'The route goes round what is in its way, hugging it at clearance.'),
      sw('pcbModeStop', 'Stop At First Obstacle'),
      sw('pcbModeHug', 'Hug And Push Obstacles', 'Round fixed objects, pushing free tracks aside.'),
      sw('pcbModeAutoroute', 'AutoRoute On Current Layer', 'Walkaround over the whole board.'),
      sw('pcbModeAutorouteMulti', 'AutoRoute On Multiple Layers', 'Over the whole board on every signal layer, a via where it changes layer.'),
      { key: 'pcbRoutingMode', label: 'Current Mode', help: 'Shift+R while routing cycles the modes ticked above.', type: { kind: 'enum', options: [['ignore', 'Ignore Obstacles'], ['push', 'Push Obstacles'], ['walkaround', 'Walkaround Obstacles'], ['stop', 'Stop At First Obstacle'], ['hug', 'HugNPush Obstacles'], ['autoroute', 'AutoRoute On Current Layer'], ['autorouteMulti', 'AutoRoute On Multiple Layers']] } },
    ] },
    { title: 'Dragging', fields: [
      sw('pcbPreserveAngle', 'Preserve Angle When Dragging', 'A dragged segment slides across itself and its neighbours keep their directions.'),
      { key: 'pcbDragObstacles', label: 'When dragging', help: 'What a dragged track or via does at copper of other nets.', type: { kind: 'radio', options: [['ignore', 'Ignore Obstacles'], ['avoidSnap', 'Avoid Obstacles (Snap Grid)'], ['avoid', 'Avoid Obstacles']] } },
      { key: 'pcbDragUnselected', label: 'Unselected via/track', help: 'A press-drag on it: Drag keeps its connections, Move takes it alone.', type: { kind: 'enum', options: [['move', 'Move'], ['drag', 'Drag']] } },
      { key: 'pcbDragSelected', label: 'Selected via/track', type: { kind: 'enum', options: [['move', 'Move'], ['drag', 'Drag']] } },
      { key: 'pcbCompPushing', label: 'Component pushing', help: 'A component moved onto others on its side: goes over them, stops short of them, or pushes them aside along the way it moved.', type: E('Ignore', 'Avoid', 'Push') },
    ] },
    { title: 'Interactive Routing Options', fields: [
      sw('pcbRestrict9045', 'Restrict To 90/45', 'Shift+Space cycles 45° and 90° corners (with or without arcs) only: no any-angle corners.'),
      sw('pcbFollowMouseTrail', 'Follow Mouse Trail', 'Walkaround Obstacles and AutoRoute On Current Layer take the way the cursor went since the last click (round the side of an obstacle it went round), not the shortest way to where it is.'),
      { key: 'pcbAutoTerminate', label: 'Automatically Terminate Routing', help: 'Finish the route when it reaches a pad or via of its net.', type: B },
      sw('pcbRemoveLoops', 'Automatically Remove Loops', 'A route joining two places its net already joins takes the old way out.'),
      { ...sw('pcbRemoveNetAntennas', 'Remove Net Antennas', 'With Automatically Remove Loops: tracks the old way\'s removal leaves with a dead end go too.'), off: (d) => !d.pcbRemoveLoops },
      sw('pcbAllowViaPushing', 'Allow Via Pushing', 'Push and Hug And Push move free vias out of the way, the tracks ending on them coming along.'),
      { key: 'pcbHugStyle', label: 'Hugging Style', help: 'The corners of a route as it is placed: as routed, each an arc, or arcs round the round objects it hugs (vias, round pads).', type: { kind: 'enum', options: [['lines', 'Mitered With Lines'], ['arcs', 'Mitered With Arcs'], ['rounded', 'Rounded']] } },
      { key: 'pcbRouteStyle', label: 'Routing Style', help: 'The shape of the routes the autorouter and the Smart Router make, and of a route as it is placed: with corners (45° or 90°, as each tool sets them), or free-flowing: the direct way at any angle, each bend an arc round what it passes. Route › Make Free-Flowing reshapes routes that are there.', type: { kind: 'enum', options: [['corners', 'Corners'], ['flowing', 'Free-Flowing']] }, off: () => !featureOn('aiLayout') },
      sw('pcbClearanceBoundaries', 'Display Clearance Boundaries', 'Where the route may not go, shaded while routing (Ctrl+W).'),
      sw('pcbReduceClearanceArea', 'Reduce Clearance Display Area', 'Only round the cursor.'),
    ] },
    { title: 'Interactive Routing Width Sources', fields: [
      sw('pcbPickupWidth', 'Pickup Track Width From Existing Routes', 'A route started on a track takes its width.'),
      { key: 'pcbTrackWidthMode', label: 'Track Width Mode', help: '3 while routing cycles Min, Preferred and Max of the Width rule.', type: { kind: 'enum', options: [['user', 'User Choice'], ['min', 'Rule Minimum'], ['pref', 'Rule Preferred'], ['max', 'Rule Maximum']] } },
      { key: 'pcbViaSizeMode', label: 'Via Size Mode', help: '4 while routing cycles it.', type: { kind: 'enum', options: [['user', 'User Choice'], ['min', 'Rule Minimum'], ['pref', 'Rule Preferred'], ['max', 'Rule Maximum']] } },
      { key: 'pcbTrackWidth', label: 'Default track width (User Choice)', help: 'Tab while placing changes it for the current track.', type: N('mil', 1, 500, 0.5) },
      { key: 'pcbTrackCorner', label: 'Corner mode', help: 'Shift+Space while routing cycles it; in the arc modes , and . shrink and grow the arcs (Shift faster).', type: { kind: 'enum', options: pcbCorner } },
    ] },
    { title: 'Routing Gloss Effort', fields: [
      { key: 'pcbGlossRouted', label: 'Gloss Effort', help: 'Ctrl+Shift+G while routing. Weak pulls each new stretch tight against what it passes; Strong does the whole route when it finishes.', type: { kind: 'radio', options: [['off', 'Off'], ['weak', 'Weak'], ['strong', 'Strong']] } },
    ] },
    { title: 'Favourites', fields: [{ label: 'Favourite Interactive Routing Widths', help: 'Shift+W while routing lists them.', type: { kind: 'action', command: 'ad:PCB:ConfigurePreferredWidths', button: 'Favourite Interactive Routing Widths...' } }] },
    { title: 'Wire Links', fields: [
      { key: 'pcbWireLinkPad', label: 'Pad size', help: 'Place › Wire Link: the round pad the wire is soldered to at each end.', type: N('mm', 0.3, 5, 0.05) },
      { key: 'pcbWireLinkWidth', label: 'Wire diameter', help: 'Place › Wire Link: the insulated wire, on its mechanical layer and in 3D.', type: N('mm', 0.1, 3, 0.05) },
    ] },
  ] },
  { id: 'pcb-ttf', group: 'PCB Editor', title: 'True Type Fonts', sections: [
    { title: 'True Type Fonts', fields: [sw('pcbEmbedFonts', 'Embed TrueType fonts inside PCB documents', 'Saving a board puts the fonts its strings use in it (read from this computer, once the browser has been allowed to). Fonts a board carries are always used to draw it.'),
      { label: 'Installed fonts', help: 'The browser asks once whether Konium Designer may read the fonts installed on this computer, to embed them.', type: { kind: 'action', command: 'pcb.allowLocalFonts', button: 'Allow Reading Fonts...' } },
      en('pcbSubstituteFont', 'Substitution font', [['Arial', 'Arial'], ['Tahoma', 'Tahoma'], ['Verdana', 'Verdana'], ['Segoe UI', 'Segoe UI'], ['Times New Roman', 'Times New Roman'], ['Courier New', 'Courier New']], 'Drawn for TrueType text whose font this computer doesn\'t have.')] },
  ] },
  { id: 'pcb-wheel', group: 'PCB Editor', title: 'Mouse Wheel Configuration', sections: [
    { title: 'Scrolling', wide: true, fields: [{ key: 'wheelScrollPx', label: 'One wheel notch scrolls', help: 'Screen pixels per notch, in every editor. A trackpad scrolls as far as the fingers move.', type: N('px', 8, 200, 1) }] },
  ], custom: 'wheel' },
  { id: 'pcb-defaults', group: 'PCB Editor', title: 'Defaults', sections: [], custom: 'pcbPrimitives' },
  { id: 'pcb-reports', group: 'PCB Editor', title: 'Reports', sections: [], custom: 'reports' },
  { id: 'pcb-layers', group: 'PCB Editor', title: 'Layer Colours', sections: [], custom: 'layers' },
  { id: 'pcb-models', group: 'PCB Editor', title: 'Models', sections: [], custom: 'modelFolders' },

  // Text Editors: the netlist and model editor (Tools › Editor Preferences opens here)
  { id: 'text-general', group: 'Text Editors', title: 'General', sections: [
    { title: 'Editing Options', fields: [
      sw('textAutoIndent', 'Auto Indent', 'Enter starts the new line at the indent of the one above.'),
      sw('textUseTabs', 'Use Tab Character', 'Tab and Tools › Indent put a tab character in; off, spaces to the next tab stop.'),
      { key: 'textTabWidth', label: 'Tab Width', type: N('characters', 1, 16) },
      sw('textInsertKey', 'Insert Mode / Overwrite with Insert key', 'Insert switches between inserting and overwriting what follows the cursor (the status line says which).'),
    ] },
    { title: 'Word Wrap', fields: [en('textWordWrap', 'Word Wrap', [['none', 'None'], ['window', 'At Window'], ['margin', 'At Margin']], 'As Tools › Word Wrap sets it.')] },
  ] },
  { id: 'text-display', group: 'Text Editors', title: 'Display', sections: [
    { title: 'Display Options', fields: [
      sw('textLineNumbers', 'Show Line Numbers'),
      sw('textShowMargin', 'Show Right Margin'),
      { key: 'textMargin', label: 'Right Margin', help: 'The column the margin is drawn at, and Word Wrap › At Margin wraps at.', type: N('characters', 20, 400) },
    ] },
    { title: 'Font', fields: [
      { key: 'textFont', label: 'Font', help: 'A font on this computer (Consolas, Courier New …); empty: the monospaced font Konium Designer uses.', type: T },
      { key: 'textFontSize', label: 'Size', type: N('px', 8, 32) },
    ] },
  ] },
  { id: 'text-colours', group: 'Text Editors', title: 'Colours', sections: [
    { title: 'Colours', wide: true, fields: [
      { key: 'textColours', label: 'Colours', type: { kind: 'radio', options: [['theme', 'The theme’s (light or dark)'], ['custom', 'These']] } },
      { key: 'textBack', label: 'Background', type: C },
      { key: 'textPlain', label: 'Plain Text', type: C },
      { key: 'textComment', label: 'Comment', type: C },
      { key: 'textCard', label: 'Control Card (.TRAN, .MODEL …)', type: C },
      { key: 'textDevice', label: 'Device Name', type: C },
      { label: 'Import Editor Settings', help: 'A Visual Studio settings file (.vssettings): its text editor font and colours.', type: { kind: 'action', command: 'ad:TextEdit:ImportEditorSettingsFromVisualStudio', button: 'Visual Studio...' } },
    ] },
  ] },
];

export const GROUPS = ['System', 'Data Management', 'Schematic', 'PCB Editor', 'Text Editors'];

/** Settings a page edits (for its reset and its changed-dot). */
export const pageKeys = (p: Page): (keyof Settings)[] =>
  [...(p.custom === 'layers' ? ['layerColours' as const] : p.custom === 'shortcuts' ? ['shortcuts' as const] : p.custom === 'wheel' ? ['wheel' as const, 'wheelMap' as const] : []),
    ...p.sections.flatMap((s) => s.fields.flatMap((f) => (f.key ? [f.key] : [])))];
