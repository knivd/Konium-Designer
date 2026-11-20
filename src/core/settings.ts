import { Emitter } from './events';
// Values kept under the app's earlier names carried over before the settings are read
import './storage';
import { FORMERS, formerValue } from './former';
import { VIEW3D_DEFAULT, view3dFrom, type View3D } from './view3d';

/**
 * User preferences. Persisted per browser profile; every field has a safe default and every
 * field is read somewhere — no decorative settings. The Preferences window is generated from
 * the schema in app/settingsSchema.ts.
 */
export interface Settings {
  /* General */
  theme: 'classic' | 'dark';
  toolbars: boolean;
  /** View › Toolbars: the toolbars switched off (by id). */
  hiddenToolbars: string[];
  /** View › Toolbars: those off until switched on (AD shows them only when asked: Simulation Sources). */
  shownToolbars: string[];
  /** View › Status Bar. */
  statusBar: boolean;
  /** View › Command Status: the status bar names the command running ("Idle state - ready for command" between commands). */
  commandStatus: boolean;
  /** System › General › Startup: Open Home Page if no documents open. */
  openHomePage: boolean;
  /** System › Network Activity: look on konium.app for a newer Konium and What's New (a plain request for each); off, an installed copy stays on its version. */
  checkUpdates: boolean;
  /** System › Network Activity, off (Offline): Konium makes no connections at all (the browser is told to refuse them). */
  offline: boolean;
  defaultUnits: 'mil' | 'mm';
  wheel: 'scroll' | 'zoom';
  /** Mouse Wheel Configuration: what the wheel does alone and with Ctrl, Shift or Alt held (one thing each). */
  wheelMap: WheelMap;
  zoomStep: number;
  /** Settings layout revision: lets a changed default reach users who never changed it. */
  settingsRev: number;
  cursor: 'small' | 'large';
  cursorColourSch: string;
  cursorColourPcb: string;
  selectionColour: string;
  accelPopups: boolean;
  autoShowMessages: boolean;
  showInfoMessages: boolean;

  /* Files */
  confirmClose: boolean;
  /** Data Management › Backup: copies of changed documents kept in the browser every so many minutes, offered back after a crash or a closed tab. */
  autoSave: boolean;
  autoSaveMinutes: number;
  /** How many auto-saved copies of each document are kept (the oldest reused, as AD's Name.~(n).Ext). */
  autoSaveVersions: number;
  /** Data Management › Local History: each save keeps the file it replaces (the project's History folder, or the browser); kept this many days. */
  historyDays: number;
  /** Auto-saved copies go into the history too. */
  historyAutosaves: boolean;
  /** Every project's history kept in the browser (AD's global repository) rather than its History folder. */
  historyGlobal: boolean;
  openProjectDocs: 'schpcb' | 'all' | 'none';

  /* Schematic */
  schTextScale: number;
  schDocumentFonts: boolean;
  schTextAnchor: 'cell' | 'baseline';
  schOverlines: boolean;
  schUseDocumentColours: boolean;
  schWorkspaceColour: string;
  schGridStyle: 'lines' | 'dots';
  schGridColour: string;
  schPinNameMargin: number;      // mil, body edge → pin name
  schPinNumberMargin: number;    // mil, body edge → pin designator
  schPinDirection: boolean;      // Altium's Pin Direction triangles
  /** Default Primitives › Pin › Length (mil): Place › Pin and the Component Builder's symbols start with it. */
  schPinLength: number;
  schAutoJunctions: boolean;
  schAutoJunctionSize: 'smallest' | 'small' | 'medium' | 'large';
  schWireCorner: '90' | '45' | 'any';
  /** Preferences › Schematic › Graphical Editing › Always Drag: plain mouse drags keep wires attached. */
  schAlwaysDrag: boolean;
  /** Graphical Editing › Reset Parts Designators On Paste: pasted parts come in as R?, C?, U? … */
  schResetDesignatorsOnPaste: boolean;
  /** Annotate dialog's Order of Processing (also used by Annotate Quietly / Force Annotate). */
  schAnnotateOrder: 'upThenAcross' | 'downThenAcross' | 'acrossThenUp' | 'acrossThenDown';
  /** Schematic › Break Wire: Cutting Length, Show Cutter Box, Show Extremity Markers. */
  schBreakCut: 'segment' | 'grid' | 'fixed';
  schBreakMultiple: number;
  schBreakFixed: number;           // mil
  schBreakCutterBox: 'never' | 'always' | 'onWire';
  schBreakMarkers: 'never' | 'always' | 'onWire';
  /** Graphical Editing › Net Color Override (F5 toggles it). */
  schNetColourOverride: boolean;
  /** Special strings with no value show their name ('=Title') instead of nothing. */
  schShowSpecialNames: boolean;
  /** Port Cross References: the other end named by sheet name or number, placed by zone or X,Y. */
  schPortRefSheet: 'name' | 'number';
  schPortRefLocation: 'zone' | 'xy';
  /** Cross Select Mode: selecting parts on a sheet selects them on the board, and the other way. */
  crossSelect: boolean;
  /* System › General, View, Navigation, Projects Panel; Data Management (26.101) */
  showStartupScreen: boolean;
  autosaveDesktop: boolean;
  /** Popup panels: before one slides out, before it slides back, and its slide. */
  popupDelay: number;
  popupHideDelay: number;
  popupAnimation: boolean;
  popupAnimationSpeed: number;
  /** The window's title: the document's name, or its path in the project. */
  titleFullPath: boolean;
  panelShadows: boolean;
  /** Floating panels hide while Konium's window isn't the one in use. */
  hideFloatsOnBlur: boolean;
  /** The Libraries panel previews the part picked. */
  autoPreviews: boolean;
  equalWidthTabs: boolean;
  middleClickCloses: boolean;
  /** Floating panels see-through while a tool is at work. */
  transparentFloats: boolean;
  /** Cross-probing a net or part (Navigator, Messages, compile errors): zoom to it, mask the rest, select it; power ports included. */
  navZoom: boolean;
  navMask: boolean;
  navSelect: boolean;
  navPowerParts: boolean;
  /** Projects panel. */
  projShowStatus: boolean;
  projShowPosition: boolean;
  projShowStructure: boolean;
  projSort: 'project' | 'alpha' | 'status';
  projAscending: boolean;
  projExpand: 'contracted' | 'one' | 'source' | 'full';
  projSingleClick: 'nothing' | 'activate' | 'open';
  /** Where Install Library's file selector starts. */
  libraryPath: 'project' | 'last';
  /* Schematic › General */
  schBreakAtAutoJunctions: boolean;
  schOptimizeWires: boolean;
  schComponentsCutWires: boolean;
  schInPlaceEditing: boolean;
  schConvertCrossJunctions: boolean;
  schDisplayCrossOvers: boolean;
  schSheetEntryDirection: boolean;
  schPortDirection: boolean;
  schUnconnectedLeftToRight: boolean;
  schDragOrthogonal: boolean;
  schClipNoErc: boolean;
  schClipParameterSets: boolean;
  schClipNotes: boolean;
  /** Part letters (U1A) or numbers (U1:1). */
  schSuffix: 'alpha' | 'numeric';
  schIncPrimary: number;
  schIncSecondary: number;
  schRemoveLeadingZeroes: boolean;
  schFilterScope: 'current' | 'open';
  schDefaultSheet: string;
  /* Schematic › Graphical Editing */
  schClipboardReference: boolean;
  schTemplateToClipboard: boolean;
  schGrabCentre: boolean;
  schGrabHotSpot: boolean;
  schAutoZoom: boolean;
  schSingleNegation: boolean;
  schDoubleClickInspector: boolean;
  schConfirmMemoryClear: boolean;
  schMarkManualParams: boolean;
  schClickClearsSelection: boolean;
  schShiftClickToSelect: boolean;
  schAutoSheetEntries: boolean;
  schProtectLocked: boolean;
  schHarnessColour: boolean;
  schAutoPan: 'off' | 'jump' | 'recenter';
  schAutoPanSpeed: number;
  schAutoPanStep: number;
  schAutoPanShiftStep: number;
  schUndoStack: number;
  schGroupUndo: boolean;
  /* Schematic › Compiler */
  schShowFatal: boolean;
  schShowErrors: boolean;
  schShowWarnings: boolean;
  schAutoJunctionsBuses: boolean;
  /** Auto-junction colours (wires, buses): AD17 draws its automatic junction records in these, not their own COLOR. */
  schAutoJunctionColour: string;
  schAutoJunctionBusColour: string;
  schManualJunctionStatus: boolean;
  schManualJunctionSize: 'smallest' | 'small' | 'medium' | 'large';
  /* Schematic › AutoFocus */
  schDimOnPlace: boolean; schDimOnMove: boolean; schDimOnEdit: boolean; schDimOnInPlace: boolean; schDimAll: boolean; schDimLevel: number;
  schThickenOnPlace: boolean; schThickenOnMove: boolean; schThickenOnEdit: boolean; schThickenOnInPlace: boolean; schThickenDelay: number;
  schZoomOnPlace: boolean; schZoomOnMove: boolean; schZoomOnEdit: boolean; schZoomOnInPlace: boolean; schZoomNonNetOnly: boolean;
  /* Schematic › Library AutoZoom, Default Units, Device Sheets, Parameter Sets */
  schLibZoom: 'keep' | 'remember' | 'centre';
  schImperialUnit: 'dxp' | 'mil' | 'in' | 'auto';
  schMetricUnit: 'mm' | 'cm' | 'm' | 'auto';
  schDeviceFolders: string[];
  schDeviceReadOnly: boolean;
  schParamSetStyle: 'large' | 'tiny';
  /** General › Default Power Object Names: what GND, signal ground and earth power ports are called. */
  schPowerGroundName: string;
  schSignalGroundName: string;
  schEarthName: string;

  /* PCB */
  pcbShowPours: boolean;
  pcbShowHiddenText: boolean;
  pcbShowHoles: boolean;
  /** View Configurations › View Options: pad numbers and nets on pads, nets on vias and along tracks. */
  pcbShowPadNumbers: boolean;
  pcbShowPadNets: boolean;
  pcbShowViaNets: boolean;
  pcbTrackNetNames: 'none' | 'single' | 'repeated';
  pcbShowOriginMarker: boolean;
  /** View Configurations › Show/Hide: object kinds hidden (track, arc, pad, via, fill, region, text, polygon). */
  pcbHiddenKinds: string[];
  /** View Configurations › Transparency (per cent): each kind of layer, and polygons, fills and regions, 3D bodies. */
  pcbTransparency: Record<string, number>;
  /** The 3D view configuration (View Configurations › Physical Materials). */
  pcb3d: View3D;
  pcbBackground: string;
  pcbBoardColour: string;
  pcbViaColour: string;
  pcbHoleColour: string;
  pcbGridStyle: 'lines' | 'dots';
  pcbGridColour: string;
  pcbSingleLayerModes: 'both' | 'hide' | 'grey';
  /** Shift+S also shows the other layers in one grey (Monochrome Other Layers). */
  pcbSingleMono: boolean;
  /* PCB Editor › Board Insight Display › Pad and Via Display Options; Display; DRC Violations Display (26.102) */
  /** Pad and via net names: in a colour that stands out against the pad's; their font, style, and the sizes on screen they are drawn between; none on objects smaller than this. */
  pcbNetSmartColour: boolean;
  pcbNetFont: string;
  pcbNetStyle: 'Regular' | 'Bold' | 'Italic' | 'Bold Italic';
  pcbNetMinPx: number;
  pcbNetMaxPx: number;
  pcbNetMinObjectPx: number;
  /** Masked objects see-through; off, drawn solid in a colour faded towards the background. */
  pcbMaskTransparent: boolean;
  /** A highlighted net's objects on hidden layers highlighted too. */
  pcbHighlightAllPrims: boolean;
  /** The mask and the highlight stay while a tool is at work. */
  pcbMaskWhileEditing: boolean;
  pcbHighlightWhileEditing: boolean;
  pcbViolationOverlay: boolean;
  pcbViolationDetails: boolean;
  pcbRepaintIndicator: boolean;
  /* PCB Editor › Board Insight Display › Live Highlighting; Board Insight Modes (26.103) */
  /** The net under the cursor lit as it passes (only with Shift held, if so set), fading in and out over these times, this strong. */
  pcbLive: boolean;
  pcbLiveShift: boolean;
  pcbLiveUp: number;
  pcbLiveDown: number;
  pcbLiveStrength: number;
  /** The heads-up display by the cursor (Shift+H), on a background, its delta origin reset by Insert and by a click; resting the cursor this long adds what lies under it. */
  pcbHud: boolean;
  pcbHudBackground: boolean;
  pcbHudInsertResets: boolean;
  pcbHudClickResets: boolean;
  pcbHudHoverDelay: number;
  pcbHudCursor: boolean;
  pcbHudDelta: boolean;
  pcbHudLayer: boolean;
  pcbHudGrid: boolean;
  pcbHudSummary: boolean;
  pcbHudShortcuts: boolean;
  pcbHudViolations: boolean;
  pcbHudNet: boolean;
  pcbHudComponent: boolean;
  pcbHudPrimitive: boolean;
  /* PCB Editor › Display; Board Insight Display › locked texture; Board Insight Colour Overrides; DRC Violations Display (26.104) */
  /** Strings drawn smoothed; off, hard-edged. */
  pcbAntialiasText: boolean;
  /** The area dragged out to select shaded see-through [est: what AD's Use Alpha Blending governs]. */
  pcbAlphaBlending: boolean;
  /** Selected objects filled in the selection colour; off, outlined in it. */
  pcbHighlightInFull: boolean;
  /** The view configuration a board and a footprint library open in (2D, 3D). */
  pcbDefault2d: string;
  pcbDefault3d: string;
  pcbLibDefault2d: string;
  pcbLibDefault3d: string;
  /** Draft thresholds: tracks narrower than this (mil) drawn as single lines; strings smaller than this on screen (pixels) as boxes. */
  pcbDraftTracks: number;
  pcbDraftStrings: number;
  /** A texture over locked objects: never, always, or only while live highlighting lights them. */
  pcbLockedTexture: 'never' | 'always' | 'live';
  /** A net's colour override drawn in this pattern over its layer colour, and, zoomed out, the pattern kept, the override colour or the layer colour. */
  pcbOverridePattern: 'Solid' | 'Checkerboard' | 'Stripe' | 'Large Checkerboard';
  pcbOverrideZoomOut: 'base' | 'override' | 'original';
  /** Objects in violation: drawn in this style, and another zoomed out. */
  pcbViolationStyle: 'None (Layer Colour)' | 'Solid (Override Colour)' | 'Style A' | 'Style B';
  pcbViolationStyleOut: 'None' | 'Solid' | 'Style A' | 'Style B';
  /* PCB Editor › General; Interactive Routing › Dragging; TrueType Fonts (26.104) */
  /** Outputs made without duplicate objects (the same object twice in one place). */
  pcbRemoveDuplicates: boolean;
  /** Ask before a change made to several objects at once (the PCB List). */
  pcbConfirmGlobalEdit: boolean;
  /** Objects of these kinds selected only with Shift+click. */
  pcbShiftClickSelect: boolean;
  pcbShiftClickKinds: string[];
  /** Connection lines from where a partly routed net's copper ends (track ends, vias), not only its pads. */
  pcbSmartTrackEnds: boolean;
  /** A click on overlapping objects lists them to choose from. */
  pcbSelectPopup: boolean;
  /** How the view follows the cursor past the window's edge while placing or moving, and how fast (mils a second). */
  pcbAutoPan: 'Disable' | 'Re-Centre' | 'Fixed Size Jump' | 'Shift Accelerate' | 'Shift Decelerate' | 'Ballistic' | 'Adaptive';
  pcbAutoPanSpeed: number;
  /** The File Format Change Report not shown for boards from older, or newer, versions. */
  pcbNoReportOlder: boolean;
  pcbNoReportNewer: boolean;
  /** What Paste takes from another application's copy: a drawing (as lines), or text (as a string). */
  pcbPasteFormat: 'Metafile' | 'Text';
  /** A component moved onto others: goes over them, stops short, or pushes them aside. */
  pcbCompPushing: 'Ignore' | 'Avoid' | 'Push';
  /** Fonts a board's strings use put in the file when it is saved. */
  pcbEmbedFonts: boolean;
  /* System › General, View, Transparency, Navigation (26.105) */
  /** At the start, the projects and documents open when Konium was last closed open again. */
  reopenWorkspace: boolean;
  /** The Clipboard panel lists only what was copied in Konium; off, text other applications copied too. */
  clipboardAppOnly: boolean;
  /** Where file selectors start: the folder last used, or Documents, Desktop or Downloads. */
  documentPath: 'last' | 'documents' | 'desktop' | 'downloads';
  /** Localisation › Text without Unicode: the Windows code page of older files' text ('auto': told from the text and this browser's language). */
  textCodePage: 'auto' | '1250' | '1251' | '1252' | '1253' | '1254' | '1255' | '1256' | '1257' | '1258';
  /** A project opened again opens the documents it had open when it closed. */
  restoreOpenDocs: boolean;
  /** Each kind of document keeps its own panel layout. */
  layoutPerKind: boolean;
  /** The documents bar: tabs of a kind grouped when they don't fit, hidden with one document, on several lines. */
  groupTabs: boolean;
  autoHideTabs: boolean;
  multilineTabs: boolean;
  /** Floating panels the more see-through the nearer the cursor (highest to lowest transparency, %, over the distance factor, px). */
  dynTransparency: boolean;
  dynHigh: number;
  dynLow: number;
  dynDistance: number;
  /** Cross-probing also dims everything else, or draws the net's connections as a graph. */
  navDim: boolean;
  navGraph: boolean;
  /** What the Navigator lists for a net. */
  navShowPins: boolean; navShowNetLabels: boolean; navShowPorts: boolean; navShowEntries: boolean; navShowConnectors: boolean; navShowLines: boolean;
  /** Cross Select Mode: the matching objects in the other document selected, zoomed to, or the rest masked. */
  crossSelectBehaviour: 'Select' | 'Zoom' | 'Mask';
  /* Projects Panel, Data Management, Text Editors, Orcad, schematic Defaults (26.106) */
  /** The Projects panel: a document's tooltip gives its full path; rows ruled; a schematic's sheet symbols and ports under it; documents grouped by class, by type, or not. */
  projFullPathHint: boolean;
  projGrid: boolean;
  projDocStructure: boolean;
  projGroup: 'none' | 'class' | 'type';
  /** Where parts are looked for: open libraries, the project's and Installed Libraries; or only the project's; or only Installed Libraries. */
  libSearch: 'all' | 'project' | 'installed';
  /** New schematics start from the template chosen (its name; the file is kept in the browser). */
  useTemplates: boolean;
  templateName: string;
  /** Auto save's copies also written to this folder (its name; '' none: the browser's storage only). */
  backupFolder: string;
  /** Text editors: Insert switches between inserting and overwriting. */
  textInsertKey: boolean;
  /** Orcad: the part field a footprint comes from; ports as wide as their names. */
  orcadFootprintField: string;
  orcadPorts: boolean;
  /** Schematic Defaults › Permanent: Tab's changes last only while placing; off, they become the defaults (kept from one session to the next). */
  schDefaultsPermanent: boolean;
  /* Compiled Names Expansion; PCB Reports; localised resources; version status (26.107) */
  /** A compiled sheet's tabs show each instance's names: designators, net labels, ports and sheet entries, power ports, document and sheet numbers. */
  schCompiledDesignators: boolean; schCompiledNetLabels: boolean; schCompiledPorts: boolean; schCompiledPower: boolean; schCompiledDocNumber: boolean; schCompiledSheetNumber: boolean;
  /** PCB Editor › Reports: after each, the report shown, generated (written with the project's outputs), and in which format. */
  pcbReports: Record<string, { show: boolean; generate: boolean; format: 'TXT' | 'HTML' }>;
  /** Dates, times and numbers written as this computer's language writes them; off, as in Britain. */
  localised: boolean;
  /** The Projects panel shows how many versions each document has in Local History (Konium's stand-in for version control status). */
  projHistoryStatus: boolean;
  /* View Configurations once greyed (26.108) */
  /** Board Layers And Colours › Mechanical › Single Layer: these mechanical layers stay shown beside the current layer in single layer mode. */
  pcbMechSingleLayer: number[];
  /** System Colours: DRC error / waiver markers (the objects) and detail markers (the crosses), the large grid, highlighting, the board's line, the sheet's line and area, the workspace's end (a gradient from its start), Measure Distance's first and second lines. */
  pcbDrcMarkerColour: string; pcbDrcDetailColour: string; pcbGridColourLarge: string; pcbHighlightColour: string; pcbBoardLineColour: string;
  pcbSheetLineColour: string; pcbSheetAreaColour: string; pcbWorkspaceEnd: string; pcbDimLine1: string; pcbDimLine2: string;
  /** Show/Hide: object kinds drawn as outlines (Draft). */
  pcbDraftKinds: string[];
  /** View Options: special strings shown converted; connection lines in their end layers' colours; components' reference points; testpoint marks; the object under the cursor in the status bar; every connection in single layer mode; planes outlined in the layer's colour or filled in their nets'; the colour a new net gets. */
  pcbConvertSpecial: boolean; pcbConnectionLayerColours: boolean; pcbShowRefPoint: boolean; pcbShowTestPoints: boolean; pcbShowStatusInfo: boolean;
  pcbAllConnectionsSingle: boolean; pcbPlaneDrawing: 'outlined' | 'solid'; pcbNewNetColour: string;
  pcbTrackWidth: number;         // mil
  pcbTrackCorner: '90' | '45' | 'any' | '45arc' | '90arc';
  pcbOnlineDrc: boolean;
  pcbShowConnections: boolean;
  pcbConnectionColour: string;
  /** Interactive Routing › Routing Conflict Resolution: the current mode (Shift+R cycles the ones ticked). */
  pcbRoutingMode: 'ignore' | 'push' | 'walkaround' | 'stop' | 'hug' | 'autoroute' | 'autorouteMulti';
  pcbModeIgnore: boolean;
  pcbModePush: boolean;
  pcbModeWalkaround: boolean;
  pcbModeStop: boolean;
  pcbModeHug: boolean;
  pcbModeAutoroute: boolean;
  pcbModeAutorouteMulti: boolean;
  /** Automatically Remove Loops: a re-route takes the old way out. */
  pcbRemoveLoops: boolean;
  /** Display Clearance Boundaries while routing (Ctrl+W), round the cursor only (Reduce Clearance Display Area). */
  pcbClearanceBoundaries: boolean;
  pcbReduceClearanceArea: boolean;
  /** Gloss Effort (Routed): Ctrl+Shift+G cycles it while routing. */
  pcbGlossRouted: 'off' | 'weak' | 'strong';
  /** Restrict To 90/45: Shift+Space leaves out any-angle corners. */
  pcbRestrict9045: boolean;
  /** Pickup Track Width From Existing Routes: a route started on a track takes its width. */
  pcbPickupWidth: boolean;
  /** Via Size Mode: where a route's vias take their size (4 cycles it while routing). */
  pcbViaSizeMode: 'user' | 'min' | 'pref' | 'max';
  /** Dragging: Preserve Angle When Dragging; what a drag does at obstacles; whether a press-drag on a via/track drags or moves it. */
  pcbPreserveAngle: boolean;
  pcbDragObstacles: 'ignore' | 'avoidSnap' | 'avoid';
  pcbDragUnselected: 'move' | 'drag';
  pcbDragSelected: 'move' | 'drag';
  /** Mouse wheel: how far one notch scrolls, in screen pixels. */
  wheelScrollPx: number;
  pcbTrackWidthMode: 'user' | 'min' | 'pref' | 'max';
  pcbAutoTerminate: boolean;
  /** Preferences › PCB Editor › Defaults › Permanent: Tab while placing changes the placing session only, not the defaults. */
  pcbDefaultsPermanent: boolean;
  /** Favourite Interactive Routing Widths (Shift+W while routing, the width list of Tab): each as typed, "10mil" or "0.25mm". */
  pcbFavouriteWidths: string[];
  /** Interactive Routing › Follow Mouse Trail, Allow Via Pushing, Remove Net Antennas (with Remove Loops), Apply width to all layers. */
  pcbFollowMouseTrail: boolean;
  pcbAllowViaPushing: boolean;
  /** Hugging Style: corners as routed (Mitered With Lines), each an arc (Mitered With Arcs), or arcs round round objects (Rounded). */
  pcbHugStyle: 'lines' | 'arcs' | 'rounded';
  /** How routes are shaped by the autorouter, the Smart Router and as they are placed: with corners, or free-flowing (any angle, each bend an arc round what it passes). */
  pcbRouteStyle: 'corners' | 'flowing';
  pcbRemoveNetAntennas: boolean;
  /** Pin Swapping › Preferred Subnet Jumper Length. */
  pcbSubnetJumperLength: string;
  /** Place › Wire Link: its round pads' size and the wire's diameter (mm). */
  pcbWireLinkPad: number;
  pcbWireLinkWidth: number;
  /** Interactive Length Tuning (Tab): the accordion's style, Max Amplitude, Space (gap between legs, mil), Miter (% of the leg pitch), the increments of 3/4 and ,/. */
  pcbTuneStyle: 'mitered' | 'arcs' | 'rounded';
  /** PCB ActiveRoute panel: the layers it routes on (layer ids; none ticked means every signal layer) and Meander (tune lengths after routing). */
  activeRouteLayers: number[];
  activeRouteMeander: boolean;
  /** ActiveRoute swaps the selected components' pins within their swap groups first. */
  activeRoutePinSwap: boolean;
  /** The route guide's width (internal units); 0: as wide as the connections need. */
  activeRouteGuideWidth: number;
  /** PCB ActiveRoute › Track-Track Space in Route Guide (centre to centre; 0: by the nets' width and clearance rules). */
  activeRouteGuideSpace: number;
  /** Design › Fab-House Profile: the house last chosen. */
  fabProfile: string;
  /**
   * Preferences › System › AI: off until switched on; the Konium service (its models, the
   * developer pays, a daily allowance), your own key (OpenRouter, or another endpoint that speaks
   * OpenAI's chat completions; the key is kept apart from these settings, in this browser only),
   * or a local model (Ollama, LM Studio, llama.cpp …). Models by mode and role
   * ("key:text", "local:vision" …); the shared cache of results others accepted.
   */
  aiMode: 'off' | 'konium' | 'key' | 'local';
  /** System › View: edges and lines smoothed (anti-aliased), or drawn hard on whole pixels. */
  smoothEdges: boolean;
  aiProvider: 'openrouter' | 'custom';
  aiCustomBase: string;
  aiLocalBase: string;
  aiModels: Record<string, string>;
  aiShareCache: boolean;
  /** Rounds of the model checking the footprint it made against the drawing (0: none). */
  aiReviewRounds: number;
  /**
   * Preferences › Data Management › Version Control: the name and email commits carry; where a
   * team's own Git server is reached through (Konium's relay at konium.app/api/git, none when the
   * server lets pages reach it, or another relay); how often an open project under version control
   * looks for others' changes and locks (minutes, 0: only when asked). Teams' keys and Git sign-ins
   * are kept apart from these settings, in this browser only.
   */
  vcsName: string;
  vcsEmail: string;
  vcsRelay: 'konium' | 'none' | 'custom';
  vcsRelayUrl: string;
  vcsCheckMinutes: number;
  /** Preferences › PCB Editor › Display › Layer Drawing Order: the kinds of layer, the first drawn on top. */
  pcbLayerDrawOrder: string[];
  pcbTuneAmplitude: number;
  pcbTuneSpace: number;
  pcbTuneMiter: number;
  pcbTuneAmplitudeInc: number;
  pcbTuneSpaceInc: number;
  /** The target: typed (Manual, mil), another net's length (From Net), or the Length / Matched Lengths rules (From Rules). */
  pcbTuneTarget: 'manual' | 'net' | 'rules';
  pcbTuneManual: number;
  pcbTuneFromNet: string;
  /** Teardrops dialog: Track or Arc style, and the scope ticks. */
  pcbTeardropStyle: 'track' | 'arc';
  /** Tools › Cross Select Mode: components selected in a schematic hang from the cursor in the PCB to be put down. */
  pcbCrossSelectReposition: boolean;
  /** Preferences › PCB Editor › General › Polygon Repour: repour a pour after it is edited (Always) or never. */
  pcbRepourAfterModification: boolean;
  /** Repour pours whose copper touches what was moved (Altium's "Repour dependent polygons after modification"). */
  pcbRepourDependent: boolean;
  /** PCB Editor › General › Other: Rotation Step (degrees) for Space while moving. */
  pcbRotationStep: number;
  /** PCB Editor › General › Editing Options › Snap To Center: a moved component hangs from its reference point. */
  pcbSnapToCenter: boolean;
  /* PCB Editor › General (26.101) */
  /** A component picked up by the cursor's nearest pad. */
  pcbSmartComponentSnap: boolean;
  /** A room picked up by its nearest corner. */
  pcbSnapRoomHotSpots: boolean;
  pcbProtectLocked: boolean;
  pcbConfirmMemoryClear: boolean;
  pcbClickClearsSelection: boolean;
  pcbDoubleClickInspector: boolean;
  pcbUndoStack: number;
  /** Edit › Drag on a component: its connected tracks go with it, or not. */
  pcbCompDrag: 'tracks' | 'none';
  /** The font for TrueType text whose font this computer doesn't have. */
  pcbSubstituteFont: string;
  /** Design Rule Checker › Create Report File (Rules To Check and the stop count are the board's own: model/drcOptions). */
  drcReportFile: boolean;
  /** Layer colour overrides, keyed by internal layer id. */
  layerColours: Record<string, string>;

  /* Text Editors (netlists and models): Preferences › Text Editors */
  /** General: a Tab's width in characters; Tab puts a tab character in (else spaces); Enter keeps the line's indent. */
  textTabWidth: number;
  textUseTabs: boolean;
  textAutoIndent: boolean;
  /** Tools › Word Wrap: none, at the window's edge or at the right margin. */
  textWordWrap: 'none' | 'window' | 'margin';
  /** Display: the right margin's column, drawn or not; line numbers in the gutter; the font. */
  textMargin: number;
  textShowMargin: boolean;
  textLineNumbers: boolean;
  textFont: string;
  textFontSize: number;
  /** Colors: the theme's, or these (Import Editor Settings from › Visual Studio sets them). */
  textColours: 'theme' | 'custom';
  textBack: string;
  textPlain: string;
  textComment: string;
  textCard: string;
  textDevice: string;

  /* Keyboard: command id → combo ('' removes the default). */
  shortcuts: Record<string, string>;
}

/** View Configurations › Transparency: [key, label] for each kind of layer, then the defaults by object kind. */
export const TRANSPARENCY_LAYERS: [string, string][] = [
  ['signal', 'Signal Layers'], ['plane', 'Internal Planes'], ['mech', 'Mechanical Layers'], ['overlay', 'Overlay'], ['paste', 'Paste'], ['solder', 'Solder'],
  ['drillGuide', 'Drill Guide'], ['keepout', 'Keep-Out Layer'], ['drillDrawing', 'Drill Drawing'], ['multi', 'Multi-Layer'],
];
export const TRANSPARENCY_KINDS: [string, string][] = [['polygons', 'Polygons'], ['fills', 'Fills, Regions'], ['bodies', '3D Bodies']];
/** Standard 2D: layers solid, a 3D body's fill see-through (as drawn before transparency could be set). */
export const TRANSPARENCY_STANDARD: Record<string, number> = { ...Object.fromEntries([...TRANSPARENCY_LAYERS, ...TRANSPARENCY_KINDS].map(([k]) => [k, 0])), bodies: 55 };
/** Transparent 2D [est: how see-through]: the layers, polygons and fills let what lies under them show. */
export const TRANSPARENCY_TRANSPARENT: Record<string, number> = { ...Object.fromEntries(TRANSPARENCY_LAYERS.map(([k]) => [k, 40])), polygons: 30, fills: 20, bodies: 55 };
export function transparencyFrom(v: unknown): Record<string, number> {
  const out = { ...TRANSPARENCY_STANDARD };
  if (v && typeof v === 'object') for (const k of Object.keys(out)) { const x = (v as Record<string, unknown>)[k]; if (typeof x === 'number' && Number.isFinite(x)) out[k] = Math.max(0, Math.min(90, Math.round(x))); }
  return out;
}

export const DEFAULTS: Settings = {
  theme: 'classic',
  toolbars: true,
  hiddenToolbars: [],
  shownToolbars: [],
  statusBar: true,
  commandStatus: false,
  openHomePage: true,
  checkUpdates: true,
  offline: false,
  defaultUnits: 'mil',
  wheel: 'scroll',
  wheelMap: { Wheel: 'vscroll', Ctrl: 'zoom', Shift: 'hscroll', Alt: 'none' },
  zoomStep: 1.12,
  settingsRev: 5,
  cursor: 'small',
  cursorColourSch: '#b8860b',
  cursorColourPcb: '#e6eae3',
  selectionColour: '#d2b04c',
  accelPopups: true,
  autoShowMessages: false,
  showInfoMessages: false,

  confirmClose: true,
  // (on in Konium, every ten minutes [est: AD's own defaults]: a browser tab can close with work unsaved)
  autoSave: true,
  autoSaveMinutes: 10,
  autoSaveVersions: 5,
  historyDays: 7,
  historyAutosaves: false,
  historyGlobal: false,
  openProjectDocs: 'schpcb',

  schTextScale: 1,
  schDocumentFonts: true,
  schTextAnchor: 'cell',
  schOverlines: true,
  schUseDocumentColours: true,
  schWorkspaceColour: '#bcbcbc',
  schGridStyle: 'lines',
  schGridColour: '#aeb6c0',
  schPinNameMargin: 50,
  schPinNumberMargin: 80,
  schPinDirection: true,
  schPinLength: 300,
  schAutoJunctions: true,
  schAutoJunctionSize: 'smallest',
  schWireCorner: '90',
  schAlwaysDrag: false,
  schResetDesignatorsOnPaste: true,
  schAnnotateOrder: 'upThenAcross',
  schBreakCut: 'grid',
  schBreakMultiple: 2,
  schBreakFixed: 100,
  schBreakCutterBox: 'onWire',
  schBreakMarkers: 'onWire',
  schNetColourOverride: true,
  schShowSpecialNames: false,
  schPortRefSheet: 'name',
  schPortRefLocation: 'zone',
  crossSelect: false,
  showStartupScreen: true, autosaveDesktop: true, popupDelay: 220, popupHideDelay: 600, popupAnimation: true, popupAnimationSpeed: 5,
  titleFullPath: false, panelShadows: true, hideFloatsOnBlur: false, autoPreviews: true, equalWidthTabs: true, middleClickCloses: true, transparentFloats: false,
  navZoom: true, navMask: false, navSelect: true, navPowerParts: false,
  projShowStatus: true, projShowPosition: false, projShowStructure: true, projSort: 'project', projAscending: true, projExpand: 'source', projSingleClick: 'activate',
  libraryPath: 'project',
  schBreakAtAutoJunctions: true, schOptimizeWires: true, schComponentsCutWires: false, schInPlaceEditing: true, schConvertCrossJunctions: true,
  schDisplayCrossOvers: false, schSheetEntryDirection: true, schPortDirection: true, schUnconnectedLeftToRight: false, schDragOrthogonal: false,
  schClipNoErc: true, schClipParameterSets: true, schClipNotes: true, schSuffix: 'alpha', schIncPrimary: 1, schIncSecondary: 1, schRemoveLeadingZeroes: false,
  schFilterScope: 'current', schDefaultSheet: 'A4',
  schClipboardReference: true, schTemplateToClipboard: false, schGrabCentre: false, schGrabHotSpot: true, schAutoZoom: true, schSingleNegation: false,
  schDoubleClickInspector: false, schConfirmMemoryClear: true, schMarkManualParams: true, schClickClearsSelection: true, schShiftClickToSelect: false,
  schAutoSheetEntries: true, schProtectLocked: true, schHarnessColour: false, schAutoPan: 'jump', schAutoPanSpeed: 5, schAutoPanStep: 30, schAutoPanShiftStep: 100,
  schUndoStack: 50, schGroupUndo: true,
  schShowFatal: true, schShowErrors: true, schShowWarnings: true, schAutoJunctionsBuses: false, schAutoJunctionColour: '#000080', schAutoJunctionBusColour: '#000080', schManualJunctionStatus: false, schManualJunctionSize: 'smallest',
  schDimOnPlace: false, schDimOnMove: false, schDimOnEdit: false, schDimOnInPlace: false, schDimAll: false, schDimLevel: 50,
  schThickenOnPlace: false, schThickenOnMove: false, schThickenOnEdit: false, schThickenOnInPlace: false, schThickenDelay: 1000,
  schZoomOnPlace: false, schZoomOnMove: false, schZoomOnEdit: false, schZoomOnInPlace: false, schZoomNonNetOnly: false,
  schLibZoom: 'centre', schImperialUnit: 'dxp', schMetricUnit: 'mm', schDeviceFolders: [], schDeviceReadOnly: false, schParamSetStyle: 'large',
  schPowerGroundName: 'GND',
  schSignalGroundName: 'SGND',
  schEarthName: 'EARTH',

  pcbShowPours: true,
  pcbShowHiddenText: false,
  pcbShowHoles: true,
  pcbShowPadNumbers: true,
  pcbShowPadNets: true,
  pcbShowViaNets: true,
  pcbTrackNetNames: 'single',
  pcbShowOriginMarker: true,
  pcbHiddenKinds: [],
  pcbTransparency: { ...TRANSPARENCY_STANDARD },
  pcb3d: { ...VIEW3D_DEFAULT },
  pcbBackground: '#0f1513',
  pcbBoardColour: '#18231f',
  pcbViaColour: '#a9b2ae',
  pcbHoleColour: '#2b3330',
  pcbGridStyle: 'dots',
  pcbGridColour: '#8a9a93',
  pcbSingleLayerModes: 'both',
  pcbSingleMono: false,
  pcbNetSmartColour: true, pcbNetFont: 'Arial', pcbNetStyle: 'Bold', pcbNetMinPx: 8, pcbNetMaxPx: 14, pcbNetMinObjectPx: 3,
  pcbMaskTransparent: true, pcbHighlightAllPrims: true, pcbMaskWhileEditing: true, pcbHighlightWhileEditing: true,
  pcbViolationOverlay: true, pcbViolationDetails: true, pcbRepaintIndicator: false,
  pcbLive: true, pcbLiveShift: false, pcbLiveUp: 250, pcbLiveDown: 1000, pcbLiveStrength: 60,
  pcbHud: false, pcbHudBackground: true, pcbHudInsertResets: true, pcbHudClickResets: true, pcbHudHoverDelay: 1000,
  pcbHudCursor: true, pcbHudDelta: true, pcbHudLayer: true, pcbHudGrid: true, pcbHudSummary: false, pcbHudShortcuts: false,
  pcbHudViolations: false, pcbHudNet: false, pcbHudComponent: false, pcbHudPrimitive: false,
  pcbAntialiasText: true, pcbAlphaBlending: true, pcbHighlightInFull: false,
  pcbDefault2d: 'Standard 2D', pcbDefault3d: '3D Dk Green', pcbLibDefault2d: 'Standard 2D', pcbLibDefault3d: '3D Dk Green',
  pcbDraftTracks: 2, pcbDraftStrings: 11, pcbLockedTexture: 'live',
  pcbOverridePattern: 'Checkerboard', pcbOverrideZoomOut: 'base', pcbViolationStyle: 'Style B', pcbViolationStyleOut: 'Solid',
  pcbRemoveDuplicates: true, pcbConfirmGlobalEdit: true, pcbShiftClickSelect: false, pcbShiftClickKinds: ['Polygon'], pcbSmartTrackEnds: true, pcbSelectPopup: true,
  pcbAutoPan: 'Adaptive', pcbAutoPanSpeed: 1200, pcbNoReportOlder: false, pcbNoReportNewer: false, pcbPasteFormat: 'Metafile', pcbCompPushing: 'Ignore', pcbEmbedFonts: false,
  reopenWorkspace: true, clipboardAppOnly: true, documentPath: 'last', textCodePage: 'auto', restoreOpenDocs: false, layoutPerKind: true, groupTabs: true, autoHideTabs: false, multilineTabs: false,
  dynTransparency: false, dynHigh: 50, dynLow: 10, dynDistance: 100, navDim: false, navGraph: false,
  navShowPins: true, navShowNetLabels: true, navShowPorts: true, navShowEntries: true, navShowConnectors: true, navShowLines: false, crossSelectBehaviour: 'Select',
  projFullPathHint: true, projGrid: false, projDocStructure: false, projGroup: 'type', libSearch: 'all', useTemplates: false, templateName: '', backupFolder: '',
  textInsertKey: false, orcadFootprintField: 'Part Field 1', orcadPorts: false, schDefaultsPermanent: false,
  schCompiledDesignators: true, schCompiledNetLabels: true, schCompiledPorts: true, schCompiledPower: true, schCompiledDocNumber: true, schCompiledSheetNumber: true,
  pcbReports: Object.fromEntries(['netStatus', 'boardInfo', 'bgaEscape', 'originToGrid', 'stackup'].map((k) => [k, { show: true, generate: false, format: 'TXT' as const }])),
  localised: false, projHistoryStatus: false,
  pcbMechSingleLayer: [],
  pcbDrcMarkerColour: '#00ff00', pcbDrcDetailColour: '#00ff00', pcbGridColourLarge: '#8a9a93', pcbHighlightColour: '#ffffff', pcbBoardLineColour: '#5c6b65',
  pcbSheetLineColour: '#000000', pcbSheetAreaColour: '#ffffff', pcbWorkspaceEnd: '#0f1513', pcbDimLine1: '#d2b04c', pcbDimLine2: '#d2b04c',
  pcbDraftKinds: [],
  pcbConvertSpecial: true, pcbConnectionLayerColours: false, pcbShowRefPoint: false, pcbShowTestPoints: false, pcbShowStatusInfo: true,
  pcbAllConnectionsSingle: false, pcbPlaneDrawing: 'outlined', pcbNewNetColour: '#9ea175',
  pcbTrackWidth: 10,
  pcbTrackCorner: '45',
  pcbOnlineDrc: true,
  pcbShowConnections: true,
  pcbConnectionColour: '#c0c0c0',
  pcbRoutingMode: 'hug',
  pcbModeIgnore: true,
  pcbModePush: true,
  pcbModeWalkaround: true,
  pcbModeStop: true,
  pcbModeHug: true,
  pcbModeAutoroute: true,
  pcbModeAutorouteMulti: true,
  pcbRemoveLoops: false,
  pcbClearanceBoundaries: true,
  pcbReduceClearanceArea: true,
  pcbGlossRouted: 'weak',
  // Off: Shift+Space reaches any angle in Interactive Routing as on lines [est: AD's default] (26.087, forum)
  pcbRestrict9045: false,
  pcbPickupWidth: true,
  pcbViaSizeMode: 'pref',
  pcbPreserveAngle: true,
  pcbDragObstacles: 'avoidSnap',
  pcbDragUnselected: 'drag',
  pcbDragSelected: 'drag',
  wheelScrollPx: 32,
  pcbTrackWidthMode: 'user',
  pcbAutoTerminate: true,
  pcbDefaultsPermanent: false,
  // AD17's list as shipped [est]
  pcbFavouriteWidths: ['5mil', '6mil', '8mil', '10mil', '12mil', '20mil', '25mil', '50mil', '100mil', '0.1mm', '0.2mm', '0.25mm', '0.3mm', '0.4mm', '0.5mm', '0.75mm', '1mm', '1.5mm', '2mm'],
  pcbFollowMouseTrail: false,
  pcbAllowViaPushing: true,
  pcbHugStyle: 'lines',
  pcbRouteStyle: 'corners',
  pcbRemoveNetAntennas: true,
  pcbSubnetJumperLength: '20mil',
  pcbWireLinkPad: 1,
  pcbWireLinkWidth: 0.6,
  // AD17's defaults [est]
  pcbTuneStyle: 'mitered',
  activeRouteLayers: [],
  activeRouteMeander: false,
  activeRoutePinSwap: false,
  activeRouteGuideWidth: 0,
  activeRouteGuideSpace: 0,
  fabProfile: 'jlcpcb-2',
  aiMode: 'off',
  smoothEdges: true,
  aiProvider: 'openrouter',
  aiCustomBase: '',
  aiLocalBase: 'http://localhost:11434/v1',
  aiModels: {},
  aiShareCache: true,
  aiReviewRounds: 3,
  vcsName: '',
  vcsEmail: '',
  vcsRelay: 'konium',
  vcsRelayUrl: '',
  vcsCheckMinutes: 5,
  pcbLayerDrawOrder: ['multi', 'topOverlay', 'bottomOverlay', 'connect', 'current', 'signal', 'topPaste', 'bottomPaste', 'topSolder', 'bottomSolder', 'plane', 'drillGuide', 'keepout', 'mech', 'drillDrawing', 'grid'],
  pcbTuneAmplitude: 100,
  pcbTuneSpace: 20,
  pcbTuneMiter: 50,
  pcbTuneAmplitudeInc: 10,
  pcbTuneSpaceInc: 5,
  pcbTuneTarget: 'rules',
  pcbTuneManual: 1000,
  pcbTuneFromNet: '',
  pcbTeardropStyle: 'arc',
  pcbCrossSelectReposition: false,
  pcbRepourAfterModification: true,
  pcbRepourDependent: false,
  pcbRotationStep: 90,
  pcbSnapToCenter: true,
  pcbSmartComponentSnap: true, pcbSnapRoomHotSpots: true, pcbProtectLocked: true, pcbConfirmMemoryClear: true, pcbClickClearsSelection: true, pcbDoubleClickInspector: false,
  pcbUndoStack: 30, pcbCompDrag: 'tracks', pcbSubstituteFont: 'Arial',
  drcReportFile: true,
  layerColours: {},

  textTabWidth: 8,
  textUseTabs: true,
  textAutoIndent: true,
  textWordWrap: 'none',
  textMargin: 80,
  textShowMargin: true,
  textLineNumbers: true,
  textFont: '',
  textFontSize: 12,
  textColours: 'theme',
  textBack: '#ffffff',
  textPlain: '#1e1e1e',
  textComment: '#3d8a4a',
  textCard: '#1a6cc4',
  textDevice: '#8a3d9e',

  shortcuts: {},
};

const KEY = 'konium.settings.v2';
/** Saved under the earlier names: read once, then saved under KEY. */
const KEYS_OLD = [...FORMERS.map((f) => `${f}.settings.v2`), 'vibium.settings.v2', 'designerium.settings.v2'];
const KEY_V1 = 'designerium.settings.v1';
/** v1 defaults that changed with the AD17 look: carried over only when the user had changed them. */
const V1_DEFAULTS: Record<string, unknown> = { schWorkspaceColour: '#56605b', schGridColour: '#9aa6a0' };

function load(): Settings {
  try {
    const ls = globalThis.localStorage;
    const raw = ls?.getItem(KEY) ?? KEYS_OLD.map((k) => ls?.getItem(k)).find((v) => v != null) ?? null;
    if (raw) return fromStored(JSON.parse(raw));
    const old = globalThis.localStorage?.getItem(KEY_V1);
    if (old) {
      const v1 = JSON.parse(old) as Record<string, unknown>;
      for (const [k, d] of Object.entries(V1_DEFAULTS)) if (v1[k] === d) delete v1[k];
      return sanitise(v1);
    }
    return structuredClone(DEFAULTS);
  } catch {
    return structuredClone(DEFAULTS);
  }
}

/** Settings as saved by this or an earlier build, brought up to date. */
/** The AI service as saved under the app's earlier name, and the models chosen for it, under the present one. */
function adoptFormerAi(out: Settings): Settings {
  if (FORMERS.includes(out.aiMode as string)) out.aiMode = 'konium';
  // The models chosen for the service under its earlier names: the present name's kept, then the most recent name's
  const of = (k: string) => FORMERS.find((f) => k.startsWith(`${f}:`));
  if (Object.keys(out.aiModels).some(of)) {
    const all = Object.entries(out.aiModels), now = Object.fromEntries(all.filter(([k]) => !of(k)));
    for (const f of FORMERS) for (const [k, v] of all) if (of(k) === f) now[`konium:${k.slice(f.length + 1)}`] ??= v;
    out.aiModels = now;
  }
  return out;
}

export function fromStored(parsed: Record<string, unknown>): Settings {
  const out = adoptFormerAi(sanitise(parsed));
  // 26.014: zoom steps half as big (×1.25 → ×1.12 a notch) unless the user had set their own
  if (!(Number(parsed.settingsRev) >= 2) && parsed.zoomStep === 1.25) out.zoomStep = DEFAULTS.zoomStep;
  // 26.031: AD17's Interactive Routing settings (HugNPush, loops kept) replace earlier builds' defaults
  if (!(Number(parsed.settingsRev) >= 3)) {
    if (parsed.pcbRoutingMode === 'stop' || parsed.pcbRoutingMode === 'walkaround') out.pcbRoutingMode = DEFAULTS.pcbRoutingMode;
    if (parsed.pcbRemoveLoops === true) out.pcbRemoveLoops = DEFAULTS.pcbRemoveLoops;
  }
  // 26.033: Track Width Mode defaults to User Choice
  if (!(Number(parsed.settingsRev) >= 4) && parsed.pcbTrackWidthMode === 'pref') out.pcbTrackWidthMode = DEFAULTS.pcbTrackWidthMode;
  // 26.087: Restrict To 90/45 off unless chosen since (earlier builds had it on, leaving any angle out of Interactive Routing)
  if (!(Number(parsed.settingsRev) >= 5) && parsed.pcbRestrict9045 === true) out.pcbRestrict9045 = DEFAULTS.pcbRestrict9045;
  out.settingsRev = DEFAULTS.settingsRev;
  return out;
}

export type WheelMod = 'Wheel' | 'Ctrl' | 'Shift' | 'Alt';
export type WheelAction = 'zoom' | 'vscroll' | 'hscroll' | 'none';
export type WheelMap = Record<WheelMod, WheelAction>;
export const WHEEL_MODS: WheelMod[] = ['Wheel', 'Ctrl', 'Shift', 'Alt'];
const ACTIONS: WheelAction[] = ['zoom', 'vscroll', 'hscroll', 'none'];
/** The grid as saved (each modifier checked), else as the scheme gave it: zoom (the wheel zooms, Shift scrolls across) or scroll (Ctrl zooms). */
export function wheelMapFrom(v: unknown, scheme: 'scroll' | 'zoom'): WheelMap {
  const base: WheelMap = scheme === 'zoom' ? { Wheel: 'zoom', Ctrl: 'zoom', Shift: 'hscroll', Alt: 'none' } : { Wheel: 'vscroll', Ctrl: 'zoom', Shift: 'hscroll', Alt: 'none' };
  if (!v || typeof v !== 'object') return base;
  const out = { ...base };
  for (const m of WHEEL_MODS) { const a = (v as Record<string, unknown>)[m]; if (ACTIONS.includes(a as WheelAction)) out[m] = a as WheelAction; }
  return out;
}
/** What a wheel event does: by its modifier (Ctrl or Cmd, then Shift, then Alt, else the wheel alone). */
export function wheelAction(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): WheelAction {
  const m: WheelMod = e.ctrlKey || e.metaKey ? 'Ctrl' : e.shiftKey ? 'Shift' : e.altKey ? 'Alt' : 'Wheel';
  return settings.wheelMap[m];
}

/** Keep only known keys with the right type; anything else falls back to the default. */
export function sanitise(input: unknown): Settings {
  const out = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const d = (DEFAULTS as unknown as Record<string, unknown>)[k];
      if (d === undefined) continue;
      if (Array.isArray(d)) { if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v; continue; }
      if (k === 'pcb3d') { out[k] = view3dFrom(v); continue; }
      if (k === 'pcbTransparency') { out[k] = transparencyFrom(v); continue; }
      if (typeof d === typeof v && (typeof d !== 'object' || (v && !Array.isArray(v)))) out[k] = v;
    }
  }
  // Values saved by earlier builds under their old names
  if (out.theme === 'ad17') out.theme = 'classic';
  if (out.wheel === 'altium') out.wheel = 'scroll';
  if (out.theme !== 'classic' && out.theme !== 'dark') out.theme = DEFAULTS.theme;
  if (out.wheel !== 'scroll' && out.wheel !== 'zoom') out.wheel = DEFAULTS.wheel;
  // The wheel's grid: each modifier one of the actions; saved before the grid (26.147), from the scheme chosen then
  const had = input && typeof input === 'object' ? (input as Record<string, unknown>).wheelMap : undefined;
  out.wheelMap = wheelMapFrom(had, out.wheel as Settings['wheel']);
  if (out.schParamSetStyle === 'small') out.schParamSetStyle = 'tiny'; // earlier builds offered a Small that does not exist
  if (!['none', 'window', 'margin'].includes(out.textWordWrap as string)) out.textWordWrap = DEFAULTS.textWordWrap;
  if (out.textColours !== 'theme' && out.textColours !== 'custom') out.textColours = DEFAULTS.textColours;
  const clampInt = (k: string, lo: number, hi: number) => { const v = Math.round(Number(out[k])); out[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : (DEFAULTS as unknown as Record<string, unknown>)[k]; };
  clampInt('autoSaveMinutes', 1, 120); clampInt('autoSaveVersions', 1, 10); clampInt('historyDays', 1, 10); clampInt('aiReviewRounds', 0, 5); clampInt('schPinLength', 0, 2000);
  out.schPinLength = Math.round((out.schPinLength as number) / 10) * 10;
  return out as unknown as Settings;
}

export const settings: Settings = load();
export const settingsChanged = new Emitter<Partial<Settings>>();

function persist(): void {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode etc. */ }
}

export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(settings, patch);
  persist();
  settingsChanged.emit(patch);
}

/** Reset preferences (the panel layout lives apart: View › Desktop Layouts). */
export function resetSettings(keys?: (keyof Settings)[]): void {
  const patch: Partial<Settings> = {};
  const all = keys ?? (Object.keys(DEFAULTS) as (keyof Settings)[]);
  for (const k of all) (patch as Record<string, unknown>)[k] = structuredClone(DEFAULTS[k]);
  updateSettings(patch);
}

export function exportSettings(): string {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) o[k] = v;
  return JSON.stringify({ konium: 'settings', version: 1, settings: o }, null, 2);
}

export function importSettings(json: string): void {
  const parsed = JSON.parse(json) as { konium?: string; vibium?: string; designerium?: string; settings?: unknown } & Record<string, unknown>;
  // Files saved before the renames say so under the earlier names
  if ((parsed.konium ?? formerValue(parsed) ?? parsed.vibium ?? parsed.designerium) !== 'settings' || !parsed.settings) throw new Error('not a Konium Designer settings file');
  const clean = adoptFormerAi(sanitise({ ...settings, ...(parsed.settings as object) }));
  updateSettings(clean);
}

/** '#rrggbb' → 0xRRGGBB */
export const hexToRgb = (h: string): number => parseInt(h.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
export const rgbToHex = (n: number): string => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
