/**
 * The schematic library editor's commands: Place › Pin, Tools › New / Remove / Rename / Copy
 * Component, New / Remove Part, Goto (parts and components), Component Properties.
 */
import type { Command, Scope } from '../core/commands';
import { active, notify } from './state';
import { showDialog } from './dialogs';
import { PromptDialog } from './dialogs/Confirm';
import { LibComponentDialog } from './dialogs/LibComponent';
import { SchLibEditor } from '../editors/sch/SchLibEditor';
import { SchPasteTool } from '../editors/sch/SchPasteTool';
import { PropertyBag } from '../formats/altium/props';
import { IEEE_SYMBOLS, ieeeBag, pinFactory } from '../model/schPlace';
import { capture, kindOfBag, onSchDefaults, setSchDefault, withDefault } from '../model/schDefaults';
import type { SchDocument } from '../model/sch';
import { ieeeCommandId } from '../editors/sch/ieee';
import { autoNext } from './increment';
import { settings } from '../core/settings';

const lib = () => { const e = active.value?.editor; return e instanceof SchLibEditor ? e : null; };
const SCHLIB: Scope[] = ['schlib'];

/** The pin Place › Pin starts with: the one placed last this session, else Default Primitives' pin (Preferences' length; the usual one is 300 mil), its hot end at the cursor. */
let lastPin: PropertyBag | null = null;
const pinBag = (doc: SchDocument): PropertyBag => (lastPin ? lastPin.clone() : withDefault(doc, pinFactory()));
/** What each IEEE symbol command placed last (size, turn, colour), for the next time. */
const lastIeee = new Map<string, PropertyBag>();
// Preferences › Default Primitives › Edit Values or Reset: the next pin or symbol starts from the default again
onSchDefaults((name) => { if (!name || name === 'Pin') lastPin = null; if (!name || name === 'IEEE Symbol') lastIeee.clear(); });
/** Tab changed it: unless Permanent is on, it is its kind's default from now on. */
const keepDefault = (doc: SchDocument, b: PropertyBag) => { const k = kindOfBag(b); if (k && !settings.schDefaultsPermanent) setSchDefault(k.name, capture(doc, k, [b]), true); };
/** Pins step on: 1 → 2, A0 → A1, for designator and name alike. */
const nextPin = (b: PropertyBag) => { const n = b.clone(); n.set('DESIGNATOR', autoNext(b.get('DESIGNATOR') ?? '')); n.set('NAME', autoNext(b.get('NAME') ?? '', true)); return n; };

export function schlibCommands(): Command[] {
  const has = () => !!lib();
  return [
    { id: 'place.pin', label: 'Pin', scopes: SCHLIB, run: () => {
      const e = lib();
      if (!e) return;
      e.setTool(new SchPasteTool(e, { kind: 'sch', ref: { x: 0, y: 0 }, items: [{ bag: pinBag(e.doc), owner: -1 }] }, true, {
        // remember gets the pin to place next (the tool has already stepped it after a click) or, with Tab, the one being edited: kept as it is
        id: 'place.pin', what: 'pin', next: nextPin, remember: (b) => { lastPin = b.clone(); lastPin.delete('OWNERINDEX'); lastPin.delete('OWNERPARTID'); }, edited: (b) => keepDefault(e.doc, b),
        // AD (newer releases): the cursor steps a grid down after each pin; a pin on the top or bottom steps right [est]
        step: (landed) => (landed.int('PINCONGLOMERATE') & 1 ? { x: 1, y: 0 } : { x: 0, y: -1 }),
      }));
    }, enabled: has },
    { id: 'schlib.newComponent', label: 'New Component', scopes: SCHLIB, run: () => {
      const e = lib();
      if (e) showDialog(PromptDialog, { title: 'New Component Name', fields: [{ label: 'Name', value: e.uniqueName('Component_1') }], onOk: ([n]: string[]) => e.newComponent(n ?? '') });
    }, enabled: has },
    { id: 'schlib.removeComponent', label: 'Remove Component', scopes: SCHLIB, run: () => { const e = lib(); if (e && !e.removeComponent()) notify('A library keeps at least one component', 'error'); },
      enabled: () => (lib()?.lib.symbols.length ?? 0) > 1 },
    { id: 'schlib.renameComponent', label: 'Rename Component...', scopes: SCHLIB, run: () => {
      const e = lib();
      if (e?.symbol) showDialog(PromptDialog, { title: 'Rename Component', fields: [{ label: 'New Component Name', value: e.symbol.libRef }],
        onOk: ([n]: string[]) => { if (!e.renameComponent(n ?? '')) notify(`Can't rename to "${n}": empty or already in the library`, 'error'); } });
    }, enabled: has },
    { id: 'schlib.copyComponent', label: 'Duplicate Component', scopes: SCHLIB, run: () => lib()?.duplicateComponent(), enabled: has },
    { id: 'schlib.newPart', label: 'New Part', scopes: SCHLIB, run: () => lib()?.newPart(), enabled: has },
    { id: 'schlib.removePart', label: 'Remove Part', scopes: SCHLIB, run: () => { lib()?.removePart(); }, enabled: () => (lib()?.partCount ?? 1) > 1 },
    { id: 'schlib.nextPart', label: 'Next Part', scopes: SCHLIB, run: () => { const e = lib(); e?.showPart(e.part + 1); }, enabled: () => { const e = lib(); return !!e && e.part < e.partCount; } },
    { id: 'schlib.prevPart', label: 'Previous Part', scopes: SCHLIB, run: () => { const e = lib(); e?.showPart(e.part - 1); }, enabled: () => (lib()?.part ?? 1) > 1 },
    { id: 'schlib.first', label: 'First Component', scopes: SCHLIB, run: () => lib()?.showSymbol(0), enabled: has },
    { id: 'schlib.next', label: 'Next Component', scopes: SCHLIB, run: () => { const e = lib(); e?.showSymbol(e.current + 1); }, enabled: () => { const e = lib(); return !!e && e.current < e.lib.symbols.length - 1; } },
    { id: 'schlib.prev', label: 'Previous Component', scopes: SCHLIB, run: () => { const e = lib(); e?.showSymbol(e.current - 1); }, enabled: () => (lib()?.current ?? 0) > 0 },
    { id: 'schlib.last', label: 'Last Component', scopes: SCHLIB, run: () => { const e = lib(); e?.showSymbol(e.lib.symbols.length - 1); }, enabled: has },
    // Place › IEEE Symbols: each follows the cursor; Space turns it, X / Y flip, Tab edits it
    ...IEEE_SYMBOLS.slice(1).map((name, i): Command => ({ id: ieeeCommandId(i + 1), label: name, scopes: SCHLIB, enabled: has, run: () => {
      const e = lib();
      if (!e) return;
      const id = ieeeCommandId(i + 1);
      e.setTool(new SchPasteTool(e, { kind: 'sch', ref: { x: 0, y: 0 }, items: [{ bag: lastIeee.get(id)?.clone() ?? withDefault(e.doc, ieeeBag(i + 1), ['SYMBOL']), owner: -1 }] }, true, {
        id, what: `IEEE symbol ${name}`, remember: (b) => { const k = b.clone(); k.delete('OWNERINDEX'); k.delete('OWNERPARTID'); k.delete('OWNERPARTDISPLAYMODE'); lastIeee.set(id, k); }, edited: (b) => keepDefault(e.doc, b),
      }));
    } })),
    // Tools › Mode: Normal and its alternates
    { id: 'ad:Sch:ToggleComponentMode0', label: 'Normal', scopes: SCHLIB, run: () => lib()?.showMode(0), enabled: () => (lib()?.modeCount ?? 1) > 1, checked: () => lib()?.mode === 0 },
    { id: 'ad:Sch:ToggleComponentAddMode', label: 'Add', scopes: SCHLIB, run: () => lib()?.addMode(), enabled: has },
    { id: 'ad:Sch:ToggleComponentRemoveMode', label: 'Remove', scopes: SCHLIB, run: () => { const e = lib(); if (e && !e.removeMode()) notify('Normal mode stays: show an alternate to remove it', 'error'); },
      enabled: () => (lib()?.mode ?? 0) > 0 },
    { id: 'ad:Sch:ToggleComponentPreviousMode', label: 'Previous', scopes: SCHLIB, run: () => { const e = lib(); e?.showMode(e.mode - 1); }, enabled: () => (lib()?.mode ?? 0) > 0 },
    { id: 'ad:Sch:ToggleComponentNextMode', label: 'Next', scopes: SCHLIB, run: () => { const e = lib(); e?.showMode(e.mode + 1); }, enabled: () => { const e = lib(); return !!e && e.mode < e.modeCount - 1; } },
    { id: 'ad:Sch:ToggleHiddenPins', label: 'Show Hidden Pins', scopes: SCHLIB, run: () => { const e = lib(); if (e) { e.showHiddenPins = !e.showHiddenPins; e.invalidate(); } }, enabled: has, checked: () => !!lib()?.showHiddenPins },
    { id: 'schlib.componentProperties', label: 'Component Properties...', scopes: SCHLIB, run: () => { const e = lib(); if (e?.component) showDialog(LibComponentDialog, { ed: e }); }, enabled: has },
  ];
}
