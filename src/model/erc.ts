/**
 * Project Options › Error Reporting and Connection Matrix, as Altium Designer 17 keeps them in
 * the .PrjPcb: [Electrical Rules Check] TypeN=0..3 (No Report, Warning, Error, Fatal Error) where
 * N is the violation's place in Altium's TErrorKind list (1-based), and [ERC Connection Matrix]
 * L1…L17, one row per connection code, a letter per column (N, W, E, F).
 */
import { iniSection, iniSetSection, type PrjPcb } from '../formats/altium/prjpcb';

export type ErcLevel = 0 | 1 | 2 | 3;
export const ERC_LEVELS = ['No Report', 'Warning', 'Error', 'Fatal Error'] as const;
export const LEVEL_LETTER = ['N', 'W', 'E', 'F'] as const;

export type ErcGroup = 'Buses' | 'Code Symbols' | 'Components' | 'Configuration Constraints' | 'Documents' | 'Harnesses' | 'Nets' | 'Others' | 'Parameters';

export interface ErcKind { n: number; key: string; label: string; group: ErcGroup; def: ErcLevel }

/** [key, label, group, default level] in TErrorKind order (Type1 … Type100). */
const KINDS: [string, string, ErcGroup, ErcLevel][] = [
  ['OffGridObject', 'Off grid object', 'Others', 1],
  ['OffDocumentObject', 'Object not completely within sheet boundaries', 'Others', 1],
  ['MissingChildDocument', 'Missing child sheet for sheet symbol', 'Documents', 2],
  ['MissingChildProject', 'Missing sub-Project sheet for component', 'Documents', 1],
  ['PortNotLinkedToSheetSymbol', 'Port not linked to parent sheet symbol', 'Documents', 2],
  ['SheetEntryNotLinkedToPort', 'Sheet Entry not linked to child sheet', 'Documents', 2],
  ['DuplicateDocumentNumbers', 'Duplicate sheet numbers', 'Documents', 1],
  ['UnconnectedWire', 'Unconnected wires', 'Nets', 1],
  ['UnconnectedNetItem', 'Unconnected objects in net', 'Nets', 1],
  ['NetWithNoDrivingSource', 'Nets with no driving source', 'Nets', 1],
  ['FloatingInputPinsOnNet', 'Nets containing floating input pins', 'Nets', 2],
  ['DifferentConnectionCodesOnNet', 'Nets with possible connection problems', 'Nets', 2],
  ['MultipleSameConnectionCodeOnNet', 'Nets containing multiple similar objects', 'Nets', 2],
  ['MultipleNamesForNet', 'Nets with multiple names', 'Nets', 1],
  ['AddingItemsFromHiddenNetToNet', 'Adding items from hidden net to net', 'Nets', 1],
  ['AddingHiddenNet', 'Adding hidden net to sheet', 'Nets', 1],
  ['PowerObjectScopeChange', 'Global Power-Object scope changes', 'Nets', 1],
  ['NetParameterInvalidName', 'Net Parameters with no name', 'Nets', 1],
  ['NetParameterInvalidValue', 'Net Parameters with no value', 'Nets', 1],
  ['MismatchedBusSectionOrdering', 'Mismatched Bus-Section index ordering', 'Buses', 1],
  ['MismatchedFirstGenericIndex', 'Mismatched Generics on bus (First Index)', 'Buses', 1],
  ['MismatchedSecondGenericIndex', 'Mismatched Generics on bus (Second Index)', 'Buses', 1],
  ['MismatchedIOTypeOnBus', 'Mismatched electrical types on bus', 'Buses', 1],
  ['BusIndexOutOfRange', 'Bus indices out of range', 'Buses', 1],
  ['RangeSyntaxError', 'Bus range syntax errors', 'Buses', 2],
  ['IllegalBusDefinition', 'Illegal bus definitions', 'Buses', 2],
  ['IllegalBusRangeValue', 'Illegal bus range values', 'Buses', 2],
  ['MismatchedBusWidths', 'Mismatched bus widths', 'Buses', 1],
  ['MismatchedBusLabelOrdering', 'Mismatched bus label ordering', 'Buses', 1],
  ['MixedGenericAndNumericBusLabels', 'Mixed generic and numeric bus labelling', 'Buses', 1],
  ['UnDesignatedPart', 'Un-Designated parts requiring annotation', 'Components', 1],
  ['DuplicateComponentDesignator', 'Duplicate Part Designators', 'Components', 2],
  ['DuplicateSheetSymbolDesignator', 'Duplicate Sheet Symbol Names', 'Documents', 2],
  ['DuplicateNets', 'Duplicate Nets', 'Nets', 2],
  ['DuplicatePinsInComponent', 'Components with duplicate pins', 'Components', 1],
  ['DuplicateSheetEntrysInSheetSymbol', 'Sheet Symbol with duplicate entries', 'Components', 2],
  ['DuplicatePortsInDocument', 'Sheets containing duplicate ports', 'Nets', 1],
  ['DuplicateSubParts', 'Components containing duplicate sub-parts', 'Components', 2],
  ['MismatchedHiddenPinConnections', 'Mismatched hidden pin connections', 'Components', 2],
  ['MismatchedPinVisibility', 'Mismatched pin visibility', 'Components', 2],
  ['SameParameterWithDifferentValues', 'Same parameter containing different values', 'Parameters', 0],
  ['SameParameterWithDifferentTypes', 'Same parameter containing different types', 'Parameters', 2],
  ['MissingModel', 'Missing Component Models', 'Components', 1],
  ['ModelInDifferentLocation', 'Models Found in Different Model Locations', 'Components', 1],
  ['MissingModelInFile', 'Missing Component Models in Model Files', 'Components', 2],
  ['DuplicateModelsFound', 'Duplicate Component Models', 'Components', 1],
  ['MissingModelParameter', 'Missing Component Model Parameters', 'Components', 2],
  ['ErrorInModelParameter', 'Errors in Component Model Parameters', 'Components', 2],
  ['DuplicatePinsInPortMap', 'Component Implementations with duplicate pins usage', 'Components', 1],
  ['MissingPinInPortMap', 'Component Implementations with invalid pin mappings', 'Components', 2],
  ['MissingPinsPortMapSequence', 'Component Implementations with missing pins in sequence', 'Components', 1],
  ['DuplicateImplementation', 'Components with duplicate Implementations', 'Components', 1],
  ['UnusedPartInComponent', 'Unused sub-part in component', 'Components', 1],
  ['ExtraPinInComponentDisplayMode', 'Extra pin found in component display mode', 'Components', 1],
  ['MissingPinInComponentDisplayMode', 'Missing pin found in component display mode', 'Components', 1],
  ['MismatchedBusAndWire', 'Mismatched Bus/Wire object on Wire/Bus', 'Buses', 2],
  ['FloatingNetLabel', 'Floating net labels', 'Nets', 1],
  ['FloatingPowerObject', 'Floating power objects', 'Nets', 1],
  ['SinglePinNet', 'Nets with only one pin', 'Nets', 2],
  ['SignalWithNoLoad', 'Signals with no load', 'Nets', 1],
  ['SignalWithNoDriver', 'Signals with no driver', 'Nets', 2],
  ['SignalWithMultipleDrivers', 'Signals with multiple drivers', 'Nets', 2],
  ['AutoAssignedPin', 'Auto-Assigned Ports To Device Pins', 'Nets', 1],
  ['NoError', 'No error', 'Others', 0],
  ['MultipleTopLevelDocuments', 'Multiple Top-Level Documents', 'Documents', 2],
  ['MultipleConfigurationTargets', 'Multiple Configuration Targets', 'Configuration Constraints', 3],
  ['ConflictingConstraints', 'Conflicting Constraints', 'Configuration Constraints', 2],
  ['MissingConfigurationTarget', 'Missing Configuration Target', 'Configuration Constraints', 2],
  ['DuplicateUniqueIDs', 'Unique Identifiers Errors', 'Documents', 1],
  ['DifferentialPairMissingPositiveNet', 'Missing Positive Net in Differential Pair', 'Nets', 2],
  ['DifferentialPairMissingNegativeNet', 'Missing Negative Net in Differential Pair', 'Nets', 2],
  ['DifferentialPairSameNetInMultiplePairs', 'Same Net used in Multiple Differential Pairs', 'Nets', 2],
  ['DifferentialPairMisConnected', 'Differential Pair Unproperly Connected to Device', 'Nets', 2],
  ['DifferentialPairInversedPolarity', 'Differential Pair Net Connection Polarity Inversed', 'Nets', 1],
  ['DifferentialPairUnconnectedNet', 'Differential Pair Net Unconnected To Differential Pair Pin', 'Nets', 2],
  ['ConstraintPortWithoutPin', 'Constraint Port Without Pin', 'Configuration Constraints', 1],
  ['ConstraintBoardNotFound', 'Constraint Board Not Found', 'Configuration Constraints', 1],
  ['ConstraintConnectorCreationFailed', 'Constraint Connector Creation Failed', 'Configuration Constraints', 1],
  ['ConstraintDuplicateBoardInstance', 'Constraint Duplicate Board Instance', 'Configuration Constraints', 2],
  ['MissingChildEntity', 'Missing child HDL entity for sheet symbol', 'Documents', 3],
  ['OpenBusLinkForbidden', 'OpenBus link not allowed', 'Others', 3],
  ['OpenBusLinkMismatchingPorts', 'OpenBus link with mismatched ports', 'Others', 3],
  ['HarnessDefinitionConflict', 'Conflicting Harness Definition', 'Harnesses', 3],
  ['HarnessNetMissingHarnessType', 'Missing Harness Type on Harness', 'Harnesses', 3],
  ['UnknownHarnessDefinitionName', 'Unknown Harness Type', 'Harnesses', 3],
  ['BusNetItemOnHarnessNet', 'Bus Object on a Harness', 'Nets', 2],
  ['HarnessItemOnWireNet', 'Harness Object on a Wire', 'Nets', 2],
  ['HarnessItemOnBusNet', 'Harness Object on a Bus', 'Nets', 2],
  ['HarnessConnectorNameSyntax', 'Harness Connector Type Syntax Error', 'Harnesses', 1],
  ['MultipleHarnessTypesOnHarnessNet', 'Multiple Harness Types on Harness', 'Harnesses', 1],
  ['OpenBusCascadedInterconnects', 'OpenBus cascaded interconnects', 'Others', 3],
  ['OpenBusArbiterLoop', 'OpenBus arbiter loop', 'Others', 3],
  ['CodeSymbolMissingExportedRoutine', 'Missing Exported Functions', 'Code Symbols', 2],
  ['CodeSymbolNoExportedRoutines', 'Code Symbol without exported functions', 'Code Symbols', 2],
  ['CodeSymbolDuplicateCodeEntryNames', 'Duplicate Code Entry names', 'Code Symbols', 2],
  ['CodeSymbolReservedNamesUsed', 'Reserved names used in Code Symbol', 'Code Symbols', 2],
  ['CodeSymbolIdentifierCaseMismatch', 'Mismatched identifier case in Code Symbol', 'Code Symbols', 1],
  ['HDLIdentifierRenamed', 'HDL identifier renamed', 'Others', 0],
  ['AmbiguousDeviceSheet', 'Ambiguous Device Sheet Path Resolution', 'Documents', 1],
  ['SheetNamesClash', 'Sheet Names Clash', 'Documents', 2],
];

export const ERC_KINDS: ErcKind[] = KINDS.map(([key, label, group, def], i) => ({ n: i + 1, key, label, group, def }));
export const ercKind = (key: string): ErcKind => ERC_KINDS.find((k) => k.key === key)!;
export const ERC_GROUPS: ErcGroup[] = ['Buses', 'Code Symbols', 'Components', 'Configuration Constraints', 'Documents', 'Harnesses', 'Nets', 'Others', 'Parameters'];

/** Connection codes (rows and columns of the matrix), in TConnectionCode order. */
export const CONNECTION_CODES = ['Input Pin', 'IO Pin', 'Output Pin', 'Open Collector Pin', 'Passive Pin', 'HiZ Pin', 'Open Emitter Pin', 'Power Pin',
  'Input Port', 'Output Port', 'Bidirectional Port', 'Unspecified Port', 'Input Sheet Entry', 'Output Sheet Entry', 'Bidirectional Sheet Entry', 'Unspecified Sheet Entry', 'Unconnected'] as const;
export const UNCONNECTED = 16;
/** Pin ELECTRICAL 0…7 → code; port / entry IOTYPE (0 unspecified, 1 output, 2 input, 3 bidirectional) → code. */
export const pinCode = (electrical: number) => Math.min(7, Math.max(0, electrical));
export const portCode = (io: number) => [11, 9, 8, 10][io & 3]!;
export const entryCode = (io: number) => [15, 13, 12, 14][io & 3]!;

/** Altium Designer 17's matrix for a new project. */
export const DEFAULT_MATRIX = [
  'NNNNNNNNNNNWNNNWW', 'NNWNNNNNNNNWNWNWN', 'NWEENEEEENEWNEEWN', 'NNENNNWEENNWNENWN', 'NNNNNNNNNNNNNNNNN', 'NNENNNNEENNWNENWN', 'NNEWNNWEENNWNENWN',
  'NNEENEENEEENNEENN', 'NNEENEEEENEWNEEWW', 'NNNNNNNENNEWNNEWN', 'NNENNNNEEENWNENWN', 'WWWWNWWNWWWNWWWNN', 'NNNNNNNNNNNWNNNWW', 'NWEENEEEENEWNEEWW',
  'NNENNNNEEENWNENWW', 'WWWWNWWNWWWNWWWNW', 'WNNNNNNNWNNNWWWWN',
].map((r) => [...r].map((c) => Math.max(0, LEVEL_LETTER.indexOf(c as never)) as ErcLevel));

export interface ErcSettings {
  /** Level per TErrorKind number (1-based; index 0 unused). Kinds Konium doesn't know are kept as read. */
  levels: Map<number, ErcLevel>;
  /** Raw entries of [Electrical Rules Check] that aren't TypeN (MultiChannelAlternate …), kept. */
  extra: [string, string][];
  matrix: ErcLevel[][];
}

export function defaultErc(): ErcSettings {
  return { levels: new Map(ERC_KINDS.map((k) => [k.n, k.def])), extra: [['MultiChannelAlternate', '2']], matrix: DEFAULT_MATRIX.map((r) => [...r]) };
}

export function readErc(p: PrjPcb | null): ErcSettings {
  const s = defaultErc();
  if (!p) return s;
  const ec = iniSection(p, 'Electrical Rules Check');
  if (ec) {
    s.extra = [];
    for (const [k, v] of ec.entries) {
      const m = /^Type(\d+)$/i.exec(k);
      if (m) s.levels.set(Number(m[1]), Math.min(3, Math.max(0, Number(v) || 0)) as ErcLevel);
      else s.extra.push([k, v]);
    }
  }
  const cm = iniSection(p, 'ERC Connection Matrix');
  if (cm) {
    for (const [k, v] of cm.entries) {
      const m = /^L(\d+)$/i.exec(k);
      const row = m ? Number(m[1]) - 1 : -1;
      if (row < 0 || row >= CONNECTION_CODES.length) continue;
      [...v].slice(0, CONNECTION_CODES.length).forEach((c, col) => { const l = LEVEL_LETTER.indexOf(c.toUpperCase() as never); if (l >= 0) s.matrix[row]![col] = l as ErcLevel; });
    }
  }
  return s;
}

export function writeErc(p: PrjPcb, s: ErcSettings): void {
  const n = Math.max(...s.levels.keys(), ERC_KINDS.length);
  const types: [string, string][] = [];
  for (let i = 1; i <= n; i++) types.push([`Type${i}`, String(s.levels.get(i) ?? 0)]);
  iniSetSection(p, 'Electrical Rules Check', [...types, ...s.extra]);
  iniSetSection(p, 'ERC Connection Matrix', s.matrix.map((r, i) => [`L${i + 1}`, r.map((l) => LEVEL_LETTER[l]).join('')]));
}

/** Project Options › Options: the [Design] keys that shape the netlist. */
export interface NetlistOptions {
  /** HierarchyMode: 0 Automatic, 1 Flat, 2 Hierarchical, 3 Global (Net Identifier Scope). */
  scope: number;
  allowPortNetNames: boolean;
  allowSheetEntryNetNames: boolean;
  appendSheetNumberToLocalNets: boolean;
  nameNetsHierarchically: boolean;
  powerPortNamesTakePriority: boolean;
  netlistSinglePinNets: boolean;
  outputPath: string;
}
export const NET_SCOPES = ['Automatic (Based on project contents)', 'Flat (Only ports global)', 'Hierarchical (Sheet entry <-> port connections, power ports global)', 'Global (Netlabels and ports global)'] as const;
