/**
 * The board's right-click Options and the dialogs behind them: Defaults, Display, Routing
 * Options, Favourite Routing Widths, Sheet, and the rest as they come.
 */
import type { Command, Scope } from '../core/commands';
import { commands } from '../core/commands';
import { active, notify, prefsPage, showPrefs } from './state';
import { settings } from '../core/settings';
import { showDialog } from './dialogs';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { FavouriteWidthsDialog, InteractiveRoutingDialog } from './dialogs/RoutingDialog';
import { LayerDrawingOrderDialog } from './dialogs/LayerDrawingOrder';
import { DrillPairManagerDialog, DrillSymbolsDialog, LayerSetsDialog, applyLayerSet } from './dialogs/BoardSets';
import { readLayerSets, setLabel } from '../model/layerSets';
import type { AccelNode } from '../core/keymap';

const PCB: Scope[] = ['pcb'];
const BOTH: Scope[] = ['pcb', 'pcblib'];
const anyPcb = () => { const e = active.value?.editor; return e instanceof PcbEditor ? e : null; };
const board = () => { const e = anyPcb(); return e && !(e instanceof PcbLibEditor) ? e : null; };
const prefs = (page: string) => () => { prefsPage.value = page; showPrefs.value = true; };

export function pcbOptionsCommands(): Command[] {
  return [
    { id: 'ad:PCB:ConfigurePreferredWidths', label: 'Favourite Routing Widths...', scopes: BOTH, run: () => showDialog(FavouriteWidthsDialog, {}) },
    { id: 'pcb.layerDrawingOrder', label: 'Layer Drawing Order...', scopes: BOTH, run: () => showDialog(LayerDrawingOrderDialog, {}) },
    { id: 'ad:PCB:PopupOptionsDefaults', label: 'Defaults...', scopes: BOTH, run: prefs('pcb-defaults') },
    { id: 'ad:PCB:PopupOptionDisplay', label: 'Display...', scopes: BOTH, run: prefs('pcb-display') },
    { id: 'ad:PCB:PopupOptionsTrueTypeFonts', label: 'TrueType Fonts Options...', scopes: PCB, run: prefs('pcb-ttf') },
    { id: 'ad:PCB:PopupOptionsRoutingOptions', label: 'Routing Options...', scopes: PCB, enabled: () => !!board(), run: () => { const e = board(); if (e) showDialog(InteractiveRoutingDialog, { ed: e }); } },
    // Options › Sheet: the sheet's place and size, in Board Options [est: AD17 opens Board Options there]
    { id: 'ad:PCB:PopupOptionsSheet', label: 'Sheet...', scopes: PCB, enabled: () => !!board(), run: () => commands.get('ad:PCB:PopupOptionsBoardOptions')?.run() },
    // F5: nets drawn in their own colours, or not
    { id: 'ad:PCB:ToggleColorOverride', label: 'Net Colour Override', scopes: PCB, run: () => {
      PcbEditor.showNetColours = !PcbEditor.showNetColours;
      board()?.invalidate();
      notify(`Net colour override ${PcbEditor.showNetColours ? 'shown' : 'hidden'}`);
    }, checked: () => PcbEditor.showNetColours },
    { id: 'ad:PCB:PopupOptionsDrillPair', label: 'Drill Pairs...', scopes: PCB, enabled: () => !!board(), run: () => { const e = board(); if (e) showDialog(DrillPairManagerDialog, { ed: e }); } },
    { id: 'ad:PCB:PopupOptionsDrillSymbols', label: 'Drill Symbols...', scopes: PCB, enabled: () => !!board(), run: () => { const e = board(); if (e) showDialog(DrillSymbolsDialog, { ed: e }); } },
    { id: 'ad:PCB:ManageLayerSets', label: 'Board Layer Sets...', scopes: BOTH, enabled: () => !!anyPcb()?.doc.board.bag, run: () => { const e = anyPcb(); if (e) showDialog(LayerSetsDialog, { ed: e }); } },
    // Tools › Cross Select Mode on a board: the same switch as on the sheets
    { id: 'ad:PCB:ToggleFastCrossSelect', label: 'Cross Select Mode', scopes: PCB, run: () => void commands.get('ad:SCH:ToggleFastCrossSelect')?.run(), checked: () => settings.crossSelect },
  ];
}

/** Design › Manage Layer Sets and the LS button: the board's layer sets, the one chosen made current. */
export function layerSetItems(): AccelNode[] {
  const e = anyPcb();
  if (!e) return [];
  const sets = readLayerSets(e.doc.board.bag);
  return sets.map((st) => ({ key: '', label: setLabel(st), action: () => applyLayerSet(e, st) }));
}
