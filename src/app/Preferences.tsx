import { useMemo, useRef, useState, useEffect } from 'preact/hooks';
import { REPORT_ROWS, type ReportKind } from './pcbReports';
import { meshCacheSize, clearMeshCache } from '../render/gl3d/stepBodies';
import {
  DEFAULTS, exportSettings, importSettings, rgbToHex, settings, settingsChanged, updateSettings, type Settings,
  WHEEL_MODS, type WheelAction, type WheelMap, type WheelMod,
} from '../core/settings';
import { commands } from '../core/commands';
import { normaliseKey } from '../core/keymap';
import { L, defaultLayerColour, layerName, mechLayer, type LayerId } from '../model/layers';
import { GROUPS, PAGES, pageKeys, type Field } from './settingsSchema';
import { DEFAULT_SHORTCUTS } from './commands';
import { active, notify, prefsPage, showPrefs, units } from './state';
import {
  SCH_GROUPS, SCH_KINDS, capture, defaultHides, defaultItems, exportSchDefaults, hasSchDefault, importSchDefaults, resetSchDefaults, setSchDefault, type SchGroup, type SchKind,
} from '../model/schDefaults';
import type { SchDocument } from '../model/sch';
import type { PropertyBag } from '../formats/altium/props';
import { SchObjectDialog } from './dialogs/SchObjectProps';
import { newSheet } from './newSheet';
import { readPcbDoc } from '../formats/altium/pcbdoc';
import { newPcbDocBytes } from '../formats/altium/newBoard';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { pickTextFile, saveFileAs } from '../platform/fs';
import { editDefault } from './dialogs/pcbDefaultsDialogs';
import { exportDefaults, hasDefault, importDefaults, resetDefaults, type DefaultStorage } from '../model/pcbDefaults';
import { showDialog } from './dialogs';
import { DIMENSION_KINDS, BAG_KINDS, hasBagDefaults, resetBagDefaults, type BagKind } from '../model/bagDefaults';
import { BagDefaultsDialog } from './dialogs/BagDefaults';
import { Dialog } from './Dialog';
import { ColourIcon } from './icons';
import { installLibraries, installedKind, installedLibs, installedPcbLibs, installedRows, removeInstalled } from './dialogs/PlacePart';
import { sizeOf } from './dialogs/AvailableLibraries';
import { addDeviceFolder, deviceFolders, removeDeviceFolder } from './deviceSheets';
import { addModelFolder, allowModelFolder, modelFolders, removeModelFolder } from '../platform/modelFolders';
import { AiPreferences } from './AiPreferences';
import { VcsPreferences } from './VcsPreferences';
import { featureOn } from '../core/release';
import { NetworkConnections } from './NetworkPreferences';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Draft = Settings;
type SetDraft = (patch: Partial<Settings>) => void;

/**
 * Altium-style Preferences: a page tree on the left, changes staged until Apply or OK,
 * Cancel discards them. Set To Defaults resets the page (or everything), Save / Load move
 * preferences between browsers.
 */
export function Preferences() {
  if (!showPrefs.value) return null;
  return <PreferencesDialog />;
}

/** The page last open, so Preferences opens there again (as AD's does), kept in this browser. */
const LAST_PAGE = 'konium.prefsPage';
const lastPage = (): string | null => { try { return globalThis.localStorage?.getItem(LAST_PAGE) ?? null; } catch { return null; } };

function PreferencesDialog() {
  const [pageId, setPageState] = useState(() => { const want = prefsPage.value === 'shortcuts' ? 'sys-keys' : prefsPage.value ?? lastPage(); prefsPage.value = null; return PAGES.find((p) => p.id === want)?.id ?? PAGES[0]!.id; });
  const setPage = (id: string) => { setPageState(id); try { globalThis.localStorage?.setItem(LAST_PAGE, id); } catch { /* storage blocked */ } };
  // The page's entry in the tree in view when the window opens
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => { treeRef.current?.querySelector('.prefs-page.on')?.scrollIntoView({ block: 'nearest' }); }, []);
  const [query, setQuery] = useState('');
  const [draft, setDraftState] = useState<Draft>(() => structuredClone(settings));
  const [defaultsMenu, setDefaultsMenu] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const setDraft: SetDraft = (patch) => setDraftState((d) => ({ ...d, ...structuredClone(patch) }));
  // Settings changed while the window is open (a template or folder chosen from it, the Home page's switches): the draft takes them
  useEffect(() => settingsChanged.on((patch) => setDraftState((d) => ({ ...d, ...structuredClone(patch) }))), []);
  const changed = (Object.keys(draft) as (keyof Settings)[]).filter((k) => !same(draft[k], settings[k]));
  const apply = () => {
    if (!changed.length) return;
    const patch: Partial<Settings> = {};
    for (const k of changed) (patch as Record<string, unknown>)[k] = draft[k];
    updateSettings(patch);
  };
  const close = () => { showPrefs.value = false; };
  const page = PAGES.find((p) => p.id === pageId)!;
  const q = query.trim().toLowerCase();
  const hits = q ? PAGES.flatMap((p) => p.sections.flatMap((s) => s.fields.filter((f) =>
    `${f.label} ${f.help ?? ''} ${s.title} ${p.title} ${p.group}`.toLowerCase().includes(q)).map((f) => ({ p, s, f })))) : [];
  const resetKeys = (keys: (keyof Settings)[]) => { const patch: Partial<Settings> = {}; for (const k of keys) (patch as Record<string, unknown>)[k] = DEFAULTS[k]; setDraft(patch); setDefaultsMenu(false); };
  return (
    <Dialog title="Preferences" class="prefs" width={1030} height={680} onClose={close} onAccept={() => { apply(); }}
      footer={<>
        <span class="dropdown">
          <button class="btn" onClick={() => setDefaultsMenu(!defaultsMenu)}>Set To Defaults ▾</button>
          {defaultsMenu && (
            <span class="dropdown-menu">
              <button onClick={() => resetKeys(pageKeys(page))}>{`${page.group} › ${page.title}`}</button>
              <button onClick={() => resetKeys(PAGES.filter((p) => p.group === page.group).flatMap(pageKeys))}>{page.group}</button>
              <button onClick={() => resetKeys(Object.keys(DEFAULTS) as (keyof Settings)[])}>All</button>
            </span>
          )}
        </span>
        <button class="btn" onClick={() => void saveFileAs('konium-preferences.json', new TextEncoder().encode(exportSettings()))}>Save...</button>
        <button class="btn" onClick={() => fileRef.current?.click()}>Load...</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={async (e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (!f) return;
          try { importSettings(await f.text()); setDraftState(structuredClone(settings)); notify(`Loaded preferences from ${f.name}`); } catch (err) { notify(`Couldn't load ${f.name}: ${(err as Error).message}`, 'error'); }
          (e.target as HTMLInputElement).value = '';
        }} />
        <span class="spacer" />
        <button class="btn default" onClick={() => { apply(); close(); }}>OK</button>
        <button class="btn" onClick={close}>Cancel</button>
        <button class="btn" disabled={!changed.length} onClick={apply}>Apply</button>
      </>}>
      <div class="prefs-layout">
        <nav class="prefs-tree">
          <input class="prefs-search" type="search" placeholder="Search preferences..." value={query} autoFocus
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)} aria-label="Search preferences" />
          <div class="prefs-tree-list" ref={treeRef}>
            {GROUPS.map((g) => (
              <div key={g} class="prefs-group">
                <div class="prefs-group-head"><span class="tree-twisty">▾</span><ColourIcon name="folderOpen" />{g}</div>
                {PAGES.filter((p) => p.group === g && (!p.feature || featureOn(p.feature))).map((p) => (
                  <button key={p.id} class={`prefs-page${!q && p.id === pageId ? ' on' : ''}`} onClick={() => { setQuery(''); setPage(p.id); }}>
                    <ColourIcon name="file" />{p.title}
                    {pageKeys(p).some((k) => !same(draft[k], settings[k])) && <span class="changed-dot" title="Changed, not applied yet" />}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </nav>
        <div class="prefs-page-body">
          {q ? (
            <>
              <h3 class="prefs-page-title">Search results for “{query}”</h3>
              {!hits.length && <p class="pref-help">No preferences match. Try “grid”, “colour”, “text” or “routing”.</p>}
              {hits.map(({ p, s, f }) => <FieldRow key={`${p.id}:${s.title}:${f.label}`} field={f} draft={draft} set={setDraft} context={`${p.group} › ${p.title} › ${s.title}`} />)}
            </>
          ) : (
            <>
              <h3 class="prefs-page-title">{page.group} – {page.title}</h3>
              {page.note && <p class="pref-help prefs-note">{page.note}</p>}
              <div class={`prefs-sections${page.custom === 'layers' || page.custom === 'shortcuts' ? ' one' : ''}`}>
                {/* Default Primitives: the list first, as the page is named for it; the pin's length under it */}
                {page.custom === 'schPrimitives' && <SchDefaults draft={draft} set={setDraft} />}
                {page.sections.map((s) => (
                  <fieldset key={s.title} class={`pref-section${s.wide ? ' wide' : ''}`}>
                    <legend>{s.title}</legend>
                    {s.fields.map((f) => <FieldRow key={`${f.key ?? ''}:${f.label}`} field={f} draft={draft} set={setDraft} />)}
                  </fieldset>
                ))}
                {page.custom === 'layers' && <LayerColours draft={draft} set={setDraft} />}
                {page.custom === 'shortcuts' && <Shortcuts draft={draft} set={setDraft} />}
                {page.custom === 'wheel' && <WheelTable draft={draft} set={setDraft} />}
                {page.custom === 'gridPresets' && <GridPresets />}
                {page.custom === 'fileTypes' && <FileTypes />}
                {page.custom === 'reports' && <ReportsTable draft={draft} set={setDraft} />}
                {page.custom === 'pcbPrimitives' && <PcbDefaults draft={draft} set={setDraft} />}
                {page.custom === 'installedLibs' && <InstalledLibraries />}
                {page.custom === 'deviceFolders' && <DeviceFolders />}
                {page.custom === 'modelFolders' && <ModelFolders />}
                {page.custom === 'ai' && <AiPreferences draft={draft} set={setDraft} />}
                {page.custom === 'vcs' && <VcsPreferences />}
                {page.custom === 'network' && <NetworkConnections draft={draft} />}
              </div>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function FieldRow({ field: f, draft, set, context }: { field: Field; draft: Draft; set: SetDraft; context?: string }) {
  const later = !f.key && f.type.kind !== 'action', off = !!f.off?.(draft), notYet = !!f.notYet;
  const todo = later || off || notYet;
  const v = (f.key ? draft[f.key] : f.todo) as unknown;
  const put = (val: unknown) => { if (f.key) set({ [f.key]: val } as Partial<Settings>); };
  const changed = !!f.key && !same(v, DEFAULTS[f.key]);
  const id = `pref-${f.key ?? f.label.replace(/\W+/g, '-')}${context ? '-s' : ''}`;
  let control: preact.ComponentChildren = null;
  switch (f.type.kind) {
    case 'bool':
      control = <input id={id} type="checkbox" checked={f.invert ? !v : v as boolean} disabled={todo} onChange={(e) => put(f.invert ? !(e.target as HTMLInputElement).checked : (e.target as HTMLInputElement).checked)} />;
      break;
    case 'enum':
      control = (
        <select id={id} value={String(v)} disabled={todo} onChange={(e) => put((e.target as HTMLSelectElement).value)}>
          {f.type.options.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
        </select>
      );
      break;
    case 'radio':
      control = (
        <span class="pref-radios" role="radiogroup" aria-label={f.label}>
          {f.type.options.map(([val, label]) => (
            <label key={val}><input type="radio" name={id} checked={v === val} disabled={todo} onChange={() => put(val)} />{label}</label>
          ))}
        </span>
      );
      break;
    case 'range': {
      const t = f.type;
      control = (
        <span class="pref-range">
          <input id={id} type="range" min={t.min} max={t.max} step={t.step} value={v as number} disabled={todo}
            onInput={(e) => put(parseFloat((e.target as HTMLInputElement).value))} />
          <output for={id}>{t.format(v as number)}</output>
        </span>
      );
      break;
    }
    case 'number': {
      const t = f.type;
      control = (
        <span class="pref-number">
          <input id={id} type="number" min={t.min} max={t.max} step={t.step} value={v as number} disabled={todo}
            onChange={(e) => { const n = parseFloat((e.target as HTMLInputElement).value); if (Number.isFinite(n)) put(Math.min(t.max, Math.max(t.min, n))); }} />
          <span class="unit">{t.unit}</span>
        </span>
      );
      break;
    }
    case 'text':
      control = <input id={id} type="text" value={String(v ?? '')} disabled={todo} onInput={(e) => put((e.target as HTMLInputElement).value)} />;
      break;
    case 'colour':
      control = <input id={id} type="color" value={v as string} disabled={todo} onInput={(e) => put((e.target as HTMLInputElement).value)} />;
      break;
    case 'multi': {
      const on = new Set((v as string[] | undefined) ?? []);
      control = (
        <span class="pref-multi" role="group" aria-label={f.label}>
          {f.type.options.map(([val, label]) => (
            <label key={val}><input type="checkbox" checked={on.has(val)} disabled={todo} onChange={(e) => { const n = new Set(on); if ((e.target as HTMLInputElement).checked) n.add(val); else n.delete(val); put([...n]); }} />{label}</label>
          ))}
        </span>
      );
      break;
    }
    case 'action': {
      const cmd = f.type.command;
      control = <button id={id} class="btn" onClick={() => void commands.get(cmd)?.run()}>{f.type.button}</button>;
      break;
    }
  }
  const radio = f.type.kind === 'radio';
  return (
    <div class={`pref-row${f.type.kind === 'bool' ? ' is-check' : ''}${radio ? ' is-radio' : ''}${f.type.kind === 'multi' ? ' is-multi' : ''}${todo ? ' pref-todo' : ''}`} title={notYet ? 'Not available yet' : later ? 'Not in Konium Designer yet' : off ? 'Not with the switch above as it is' : undefined}>
      {f.type.kind === 'bool' ? control : null}
      <label for={radio ? undefined : id} class="pref-label" title={f.help}>
        {f.label}
        {context && <span class="pref-context">{context}</span>}
        {f.help && <span class="pref-help">{f.help}</span>}
      </label>
      {f.type.kind !== 'bool' ? control : <span />}
      {todo || !f.key ? <span /> : <button class="pref-reset" title="Default" aria-label={`Default for ${f.label}`} disabled={!changed}
        onClick={() => put(structuredClone(DEFAULTS[f.key!]))}>↺</button>}
    </div>
  );
}

/* ─── Mouse Wheel Configuration ──────────────────────────────────────────────────────── */

/**
 * The grid of wheel actions by modifier: each column (the wheel alone, with Ctrl, Shift or Alt)
 * does one thing at most, ticked in its row; unticking leaves that column doing nothing. Change
 * Channel and Zoom Help Inset have nothing to act on here.
 */
function WheelTable({ draft, set }: { draft: Draft; set: SetDraft }) {
  const map = draft.wheelMap;
  const rows: [string, WheelAction | null][] = [['Zoom Main Window', 'zoom'], ['Vertical Scroll', 'vscroll'], ['Horizontal Scroll', 'hscroll'], ['Change Channel', null], ['Zoom Help Inset', null]];
  const tick = (mod: WheelMod, act: WheelAction) => {
    const next: WheelMap = { ...map, [mod]: map[mod] === act ? 'none' : act };
    set({ wheelMap: next, wheel: next.Wheel === 'zoom' ? 'zoom' : 'scroll' });
  };
  return (
    <fieldset class="pref-section wide">
      <legend>Mouse Wheel Configuration</legend>
      <p class="pref-help">Tick what the wheel does on its own (Wheel) and with Ctrl, Shift or Alt held: one action for each. Untick a column's tick and that wheel does nothing. Change Channel and Zoom Help Inset have nothing to act on in Konium Designer. Zoom precision: System › Navigation.</p>
      <table class="wheel-table">
        <thead><tr><th>Action</th>{WHEEL_MODS.map((m) => <th key={m}>{m}</th>)}</tr></thead>
        <tbody>{rows.map(([row, act]) => (
          <tr key={row} class={act ? '' : 'muted'}><td>{row}</td>{WHEEL_MODS.map((m) => (
            <td key={m} class="al-center">
              <input type="checkbox" checked={!!act && map[m] === act} disabled={!act} aria-label={`${row} ${m}`} onChange={() => { if (act) tick(m, act); }} />
            </td>
          ))}</tr>
        ))}</tbody>
      </table>
    </fieldset>
  );
}

/* ─── Read-only tables: grid presets, file types, reports, default primitives ─────────── */

function GridPresets() {
  const table = (title: string, rows: [string, string, string][]) => (
    <fieldset class="pref-section">
      <legend>{title}</legend>
      <table class="wheel-table">
        <thead><tr><th>Snap Grid</th><th>Electrical Grid</th><th>Visible Grid</th></tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, k) => <td key={k}>{c}</td>)}</tr>)}</tbody>
      </table>
      <p class="pref-help">G cycles the snap grid through these; a document's own grids are in Design › Document Options.</p>
    </fieldset>
  );
  return <>{table('Imperial Grid Presets', [['10mil', '40mil', '100mil'], ['50mil', '40mil', '100mil'], ['100mil', '40mil', '100mil'], ['200mil', '40mil', '100mil']])}
    {table('Metric Grid Presets', [['0.25mm', '1mm', '2.5mm'], ['1.25mm', '1mm', '2.5mm'], ['2.5mm', '1mm', '2.5mm'], ['5mm', '1mm', '2.5mm']])}</>;
}

const FILE_TYPES: [string, string, string][] = [
  ['.PrjPcb', 'PCB project', 'Opens, compiles, updates'], ['.SchDoc', 'Schematic document', 'Edits, saves'], ['.PcbDoc', 'PCB document', 'Edits, saves'],
  ['.SchLib', 'Schematic library', 'Edits, saves'], ['.PcbLib', 'PCB library', 'Edits, saves'], ['.IntLib', 'Integrated library', 'Install (parts, footprints), make'],
  ['.PcbLib / .SchLib in a project', 'Project libraries', 'Feed Place › Part and footprints'],
  ['.step / .stp', '3D model', 'Opens in the 3D model editor; a component body on a board'],
];
function FileTypes() {
  return (
    <fieldset class="pref-section wide">
      <legend>File Types</legend>
      <table class="wheel-table"><thead><tr><th>Extension</th><th>Description</th><th>Konium Designer</th></tr></thead>
        <tbody>{FILE_TYPES.map(([e, d, j]) => <tr key={e}><td>{e}</td><td>{d}</td><td>{j}</td></tr>)}</tbody></table>
    </fieldset>
  );
}

function ReportsTable({ draft, set }: { draft: Draft; set: SetDraft }) {
  // Design Rule Check's own (Tools › Design Rule Check › Create Report File); the rest: shown, generated with the project's outputs, as text or HTML
  const put = (k: ReportKind, patch: Partial<{ show: boolean; generate: boolean; format: 'TXT' | 'HTML' }>) =>
    set({ pcbReports: { ...draft.pcbReports, [k]: { ...(draft.pcbReports[k] ?? { show: true, generate: false, format: 'TXT' }), ...patch } } });
  return (
    <fieldset class="pref-section wide">
      <legend>Reports</legend>
      <table class="wheel-table">
        <thead><tr><th>Report</th><th>Show</th><th>Generate</th><th>Format</th></tr></thead>
        <tbody>
          <tr><td>Design Rule Check</td>
            <td class="al-center"><input type="checkbox" checked={draft.drcReportFile} onChange={(e) => set({ drcReportFile: (e.target as HTMLInputElement).checked })} aria-label="Show Design Rule Check" /></td>
            <td class="al-center"><input type="checkbox" checked={draft.drcReportFile} disabled title="Made and shown together: the Design Rule Check's Create Report File" aria-label="Generate Design Rule Check" /></td>
            <td>HTML</td></tr>
          {REPORT_ROWS.map(([k, r]) => {
            const v = draft.pcbReports[k] ?? { show: true, generate: false, format: 'TXT' as const };
            return (
              <tr key={k}><td>{r}</td>
                <td class="al-center"><input type="checkbox" checked={v.show} onChange={(e) => put(k, { show: (e.target as HTMLInputElement).checked })} aria-label={`Show ${r}`} /></td>
                <td class="al-center"><input type="checkbox" checked={v.generate} onChange={(e) => put(k, { generate: (e.target as HTMLInputElement).checked })} aria-label={`Generate ${r}`} /></td>
                <td><select value={v.format} onChange={(e) => put(k, { format: (e.target as HTMLSelectElement).value as 'TXT' | 'HTML' })} aria-label={`Format of ${r}`}><option value="TXT">TXT</option><option value="HTML">HTML</option></select></td></tr>
            );
          })}
        </tbody>
      </table>
      <p class="pref-help">Show: the report opens when it is made. Generate: it is written with the project's outputs (Project Outputs for …), or downloaded when the project has no folder.</p>
    </fieldset>
  );
}

/* ─── Default primitives: the schematic's, the board's ───────────────────────────────── */

/** The page as the desktop software lays it out: the list with Edit Values and Reset under it; what it is for, Save As, Load, Reset All and Permanent beside it. */
function DefaultsPage({ left, info, file, permanent }: { left: preact.ComponentChildren; info: string[]; file: preact.ComponentChildren; permanent: preact.ComponentChildren }) {
  return (
    <fieldset class="pref-section wide">
      <legend>Default Primitives</legend>
      <div class="pdef">
        <div class="pdef-left">{left}</div>
        <div class="pdef-info">
          <b>Information</b>
          {info.map((t) => <p key={t}>{t}</p>)}
          <div class="pdef-file">{file}</div>
          {permanent}
        </div>
      </div>
    </fieldset>
  );
}
const DEFAULTS_INFO = [
  'Pick a primitive and press Edit Values to set what the next one placed starts from. Double-clicking it does the same.',
  'Tab while placing opens the same properties: the one being placed takes them, and they become the default.',
  'With Permanent on, Tab\'s changes go to the one being placed and no further: the defaults stay as they are here.',
];

/**
 * Schematic › Default Primitives: the kinds of object by group, each edited in its own
 * properties dialog (in mils or millimetres), Reset, Save As / Load, Permanent.
 */
function SchDefaults({ draft, set }: { draft: Draft; set: SetDraft }) {
  const [group, setGroup] = useState<'All' | SchGroup>('All');
  const [sel, setSel] = useState('Arc');
  const [unit, setUnit] = useState<'mil' | 'mm'>(settings.defaultUnits === 'mm' ? 'mm' : 'mil');
  const [, setRev] = useState(0);
  const again = () => setRev((k) => k + 1);
  const kinds = SCH_KINDS.filter((k) => group === 'All' || k.group === group);
  const kind = kinds.find((k) => k.name === sel) ?? kinds[0]!;
  const edit = (k: SchKind) => {
    // A sheet to stand for the one it will be placed on: the default's fonts are found in it, and the dialog reads them from it
    const doc = newSheet('Defaults.SchDoc'), items = defaultItems(doc, k);
    const done = (bags: PropertyBag[], d: SchDocument) => { setSchDefault(k.name, capture(d, k, bags)); again(); };
    const base = { doc, units: unit }, hide = defaultHides(k);
    if (items.length > 1) showDialog(SchObjectDialog, { base, hide, templateItems: { items, onOk: (its: { bag: PropertyBag }[], d: SchDocument) => done(its.map((it) => it.bag), d) } });
    else showDialog(SchObjectDialog, { base, hide, template: { bag: items[0]!.bag, onOk: (b: PropertyBag, d: SchDocument) => done([b], d) } });
  };
  const saveAs = async () => { await saveFileAs('Konium.SchDefaults.json', new TextEncoder().encode(exportSchDefaults())); };
  const load = async () => {
    const f = await pickTextFile('.json');
    if (!f) return;
    try { notify(`${importSchDefaults(f.text)} defaults loaded from ${f.name}`); again(); } catch (e) { notify(`${f.name}: ${(e as Error).message}`, 'error'); }
  };
  return (
    <DefaultsPage
      left={<>
        <label class="pdef-pick"><span>Primitive List</span>
          <select value={group} onChange={(e) => setGroup((e.target as HTMLSelectElement).value as 'All' | SchGroup)}>
            <option value="All">All</option>{SCH_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
          </select></label>
        <span>Primitives</span>
        <div class="pdef-list" role="listbox" aria-label="Primitives">
          {kinds.map((k) => (
            <div key={k.name} role="option" aria-selected={kind.name === k.name} class={`pdef-row${kind.name === k.name ? ' on' : ''}`} onMouseDown={() => setSel(k.name)} onDblClick={() => edit(k)}>
              {k.name}{hasSchDefault(k.name) ? ' *' : ''}
            </div>
          ))}
        </div>
        <div class="dlg-tabs inline" role="tablist" aria-label="Units the values are edited in">
          <button role="tab" aria-selected={unit === 'mil'} onClick={() => setUnit('mil')}>Mils</button>
          <button role="tab" aria-selected={unit === 'mm'} onClick={() => setUnit('mm')}>MMs</button>
        </div>
        <div class="pdef-buttons">
          <button class="btn" title={`The ${kind.name.toLowerCase()} the next one placed starts from`} onClick={() => edit(kind)}>Edit Values...</button>
          <button class="btn" disabled={!hasSchDefault(kind.name)} title="Back to how it is first made" onClick={() => { resetSchDefaults(kind.name); again(); }}>Reset</button>
        </div>
      </>}
      info={[...DEFAULTS_INFO, '* marks a primitive whose default has been changed. The defaults are kept in this browser; Save As writes them to a file, and Load reads one back.']}
      file={<>
        <button class="btn" onClick={() => void saveAs()}>Save As...</button>
        <button class="btn" onClick={() => void load()}>Load...</button>
        <button class="btn" onClick={() => { resetSchDefaults(); again(); notify('Schematic defaults back to how the objects are first made'); }}>Reset All</button>
      </>}
      permanent={<label class="pref-row is-check"><input type="checkbox" checked={draft.schDefaultsPermanent} onChange={(e) => set({ schDefaultsPermanent: (e.target as HTMLInputElement).checked })} />
        <span class="pref-label">Permanent</span></label>}
    />
  );
}

/** Each kind's defaults: a record (pcbDefaults) or a set of properties (bagDefaults: Component, Coordinate, the dimensions, Polygon, and from 26.185 a 3D body, the tables and the keepouts' lines). */
const PCB_KINDS: [string, DefaultStorage | BagKind][] = ([['Arc', 'Arcs6'], ['Component', 'Component'], ['Coordinate', 'Coordinate'], ['Dimension', 'Dimension'], ['Fill', 'Fills6'], ['Pad', 'Pads6'],
  ['Polygon', 'Polygon'], ['Region', 'Regions6'], ['String', 'Texts6'], ['Track', 'Tracks6'], ['Via', 'Vias6'],
  ...DIMENSION_KINDS.map((k) => [k, k] as [string, BagKind]), ['Component Body', 'Component Body'], ['Drill Table', 'Drill Table'], ['Layer Stack Table', 'Layer Stack Table'], ['Keepout Arc', 'Keepout Arc'], ['Keepout Track', 'Keepout Track'],
] as [string, DefaultStorage | BagKind][]).sort((a, b) => a[0].localeCompare(b[0]));
const isBag = (k: string): k is BagKind => (BAG_KINDS as string[]).includes(k);
/** With no board in front, a new one to stand for it: the dialogs take their layers and units from a board. */
let standIn: PcbEditor | null = null;
function boardFor(): PcbEditor {
  const ed = active.value?.editor;
  if (ed instanceof PcbEditor) return ed;
  if (!standIn) { standIn = new PcbEditor(readPcbDoc(newPcbDocBytes('Defaults.PcbDoc'), 'Defaults.PcbDoc')); standIn.units = () => units.value; }
  return standIn;
}
/** PCB Editor › Defaults: the primitive list, Edit Values (the object's own dialog), Reset, Save As / Load, Permanent. */
function PcbDefaults({ draft, set }: { draft: Draft; set: SetDraft }) {
  const [sel, setSel] = useState(0);
  const [, setRev] = useState(0);
  const again = () => setRev((k) => k + 1);
  const [name, storage] = PCB_KINDS[sel]!;
  const edit = (st: DefaultStorage | BagKind) => {
    if (isBag(st)) showDialog(BagDefaultsDialog, { kind: st, onDone: again });
    else editDefault(boardFor(), st, 'saved', again);
  };
  const saveAs = async () => { await saveFileAs('Konium.PcbDefaults.json', new TextEncoder().encode(exportDefaults())); };
  const load = async () => {
    const f = await pickTextFile('.json');
    if (!f) return;
    try { notify(`${importDefaults(f.text)} defaults loaded from ${f.name}`); again(); } catch (e) { notify(`${f.name}: ${(e as Error).message}`, 'error'); }
  };
  const changed = (st: DefaultStorage | BagKind) => (isBag(st) ? hasBagDefaults(st) : hasDefault(st));
  return (
    <DefaultsPage
      left={<>
        <span>Primitive Type</span>
        <div class="pdef-list" role="listbox" aria-label="Primitive Type">
          {PCB_KINDS.map(([n, st], i) => (
            <div key={n} role="option" aria-selected={sel === i} class={`pdef-row${sel === i ? ' on' : ''}`} onMouseDown={() => setSel(i)} onDblClick={() => edit(st)}>
              {n}{changed(st) ? ' *' : ''}
            </div>
          ))}
        </div>
        <div class="pdef-buttons">
          <button class="btn" title={`The ${name.toLowerCase()} the next one placed starts from`} onClick={() => edit(storage)}>Edit Values...</button>
          <button class="btn" disabled={!changed(storage)} title="Back to the usual one" onClick={() => { if (isBag(storage)) resetBagDefaults(storage); else resetDefaults(storage); again(); }}>Reset</button>
        </div>
      </>}
      info={[...DEFAULTS_INFO, '* marks a primitive whose default has been changed. The values are edited in the units and layers of the board in front, or of a new board when none is. The defaults are kept in this browser; Save As writes them to a file, and Load reads one back.', 'Each kind of dimension starts from what Dimension has and keeps what it has otherwise. A keepout fill or region has nothing of its own to set; a keepout track or arc has its line\'s width.']}
      file={<>
        <button class="btn" onClick={() => void saveAs()}>Save As...</button>
        <button class="btn" onClick={() => void load()}>Load...</button>
        <button class="btn" onClick={() => { resetDefaults(); resetBagDefaults(); again(); }}>Reset All</button>
      </>}
      permanent={<label class="pref-row is-check"><input type="checkbox" checked={draft.pcbDefaultsPermanent} onChange={(e) => set({ pcbDefaultsPermanent: (e.target as HTMLInputElement).checked })} />
        <span class="pref-label">Permanent</span></label>}
    />
  );
}

/* ─── Installed libraries (Available Libraries › Install) ───────────────────────────── */

function InstalledLibraries() {
  void installedLibs.value; void installedPcbLibs.value;
  const libs = installedRows();
  const [sel, setSel] = useState<number | null>(libs.length ? 0 : null);
  const cur = sel !== null ? libs[sel] : undefined;
  return (
    <fieldset class="pref-section wide">
      <legend>Installed Libraries</legend>
      <p class="pref-help">Kept between sessions: their parts and footprints appear in Place › Part, Place › Component, Libraries and Update From Libraries alongside the project's own.</p>
      <table class="wheel-table">
        <thead><tr><th>Library</th><th>Type</th><th>Size</th></tr></thead>
        <tbody>{libs.map((r, i) => <tr key={`${r.kind}:${r.file.name}`} class={sel === i ? 'on' : ''} onMouseDown={() => setSel(i)}><td>{r.file.name}</td><td>{installedKind(r.kind)}</td><td>{sizeOf(r.size)}</td></tr>)}
          {!libs.length && <tr><td colSpan={3} class="muted">None</td></tr>}</tbody>
      </table>
      <div class="sync-buttons">
        <button class="btn" onClick={() => void installLibraries()}>Install...</button>
        <button class="btn" disabled={!cur} onClick={() => { if (cur) removeInstalled(cur); setSel(null); }}>Remove</button>
      </div>
    </fieldset>
  );
}

/* ─── Device sheet folders ───────────────────────────────────────────────────────────── */

function DeviceFolders() {
  const loaded = deviceFolders.value;
  const names = [...new Set([...settings.schDeviceFolders, ...loaded.map((f) => f.name)])];
  const [sel, setSel] = useState<number | null>(names.length ? 0 : null);
  return (
    <fieldset class="pref-section wide">
      <legend>Device Sheet Folders</legend>
      <p class="pref-help">Folders whose sheets Place › Device Sheet Symbol offers. A folder from an earlier session needs adding again to read its sheets.</p>
      <table class="wheel-table">
        <thead><tr><th>Folder</th><th>Sheets</th></tr></thead>
        <tbody>{names.map((n, i) => { const f = loaded.find((x) => x.name === n); return <tr key={n} class={sel === i ? 'on' : ''} onMouseDown={() => setSel(i)}><td>{n}</td><td>{f ? f.files.length : <span class="muted">add again to read</span>}</td></tr>; })}
          {!names.length && <tr><td colSpan={2} class="muted">None</td></tr>}</tbody>
      </table>
      <div class="sync-buttons">
        <button class="btn" onClick={() => void addDeviceFolder()}>Add...</button>
        <button class="btn" disabled={sel === null || !names[sel]} onClick={() => { removeDeviceFolder(names[sel!]!); setSel(null); }}>Remove</button>
      </div>
    </fieldset>
  );
}

/**
 * Preferences › PCB Editor › Models: the folders linked STEP models are looked for in (after the
 * board's project folder), remembered in this browser; the mesh data is kept in memory.
 */
function ModelFolders() {
  const list = modelFolders.value;
  const [sel, setSel] = useState<number | null>(list.length ? 0 : null);
  const picked = sel !== null ? list[sel] : undefined;
  return (
    <>
      <fieldset class="pref-section wide">
        <legend>Model Search Path</legend>
        <p class="pref-help">Folders of STEP models. A 3D body that links its model (not embedded in the board or library) shows the first file of that name found in the board's project folder, then in these.</p>
        <table class="wheel-table">
          <thead><tr><th>Folder</th><th>STEP Models</th></tr></thead>
          <tbody>{list.map((f, i) => (
            <tr key={f.name} class={sel === i ? 'on' : ''} onMouseDown={() => setSel(i)}>
              <td>{f.name}</td>
              <td>{f.state === 'ready' ? f.files.size : f.state === 'reading' ? <span class="muted">reading...</span> : <span class="muted">Allow to read again</span>}</td>
            </tr>))}
            {!list.length && <tr><td colSpan={2} class="muted">None</td></tr>}</tbody>
        </table>
        <div class="sync-buttons">
          <button class="btn" onClick={() => void addModelFolder().then((n) => { if (n) setSel(modelFolders.value.findIndex((f) => f.name === n)); })}>Add...</button>
          <button class="btn" disabled={picked?.state !== 'ask'} onClick={() => { if (picked) void allowModelFolder(picked.name); }}>Allow</button>
          <button class="btn" disabled={!picked} onClick={() => { if (picked) { void removeModelFolder(picked.name); setSel(null); } }}>Remove</button>
        </div>
      </fieldset>
      <MeshData />
    </>
  );
}

/** Models › Temporary Mesh Data: a model's triangles, worked out once, kept while Konium is open; Clear lets them go. */
function MeshData() {
  const [n, setN] = useState(meshCacheSize());
  return (
    <fieldset class="pref-section wide">
      <legend>Temporary Mesh Data</legend>
      <p class="pref-help">A model's triangles are worked out once and kept while Konium Designer is open: {n} model{n === 1 ? '' : 's'} now. Clear lets them go (they are worked out again when next shown).</p>
      <div class="sync-buttons"><button class="btn" disabled={!n} onClick={() => { clearMeshCache(); setN(meshCacheSize()); }}>Clear</button></div>
    </fieldset>
  );
}

/* ─── Layer colours ──────────────────────────────────────────────────────────────────── */

const LAYER_GROUPS: [string, LayerId[]][] = [
  ['Signal Layers', [L.TOP, ...Array.from({ length: 14 }, (_, i) => i + 2), L.BOTTOM]],
  ['Internal Planes', [L.PLANE1, L.PLANE1 + 1, L.PLANE1 + 2, L.PLANE1 + 3]],
  ['Silkscreen, Mask and Paste', [L.TOP_OVERLAY, L.BOTTOM_OVERLAY, L.TOP_SOLDER, L.BOTTOM_SOLDER, L.TOP_PASTE, L.BOTTOM_PASTE]],
  ['Mechanical Layers', Array.from({ length: 16 }, (_, i) => mechLayer(i + 1))],
  ['Other Layers', [L.MULTI, L.KEEPOUT, L.DRILL_GUIDE, L.DRILL_DRAWING]],
];

function LayerColours({ draft, set }: { draft: Draft; set: SetDraft }) {
  const ed = active.value?.editor;
  const pcb = ed instanceof PcbEditor ? ed : null;
  const colour = (l: LayerId) => draft.layerColours[String(l)] ?? rgbToHex(defaultLayerColour(l));
  const put = (l: LayerId, hex: string | null) => {
    const next = { ...draft.layerColours };
    if (hex === null || hex === rgbToHex(defaultLayerColour(l))) delete next[String(l)];
    else next[String(l)] = hex;
    set({ layerColours: next });
  };
  const extra = pcb ? pcb.layers().filter((l) => !LAYER_GROUPS.some(([, ls]) => ls.includes(l))) : [];
  const groups: [string, LayerId[]][] = extra.length ? [...LAYER_GROUPS, ['In This Board', extra]] : LAYER_GROUPS;
  return (
    <>
      {groups.map(([title, ls]) => (
        <fieldset key={title} class="pref-section">
          <legend>{title}</legend>
          <div class="layer-grid">
            {ls.map((l) => (
              <label key={l} class="layer-colour">
                <input type="color" value={colour(l)} onInput={(e) => put(l, (e.target as HTMLInputElement).value)} />
                <span>{pcb?.doc.board.layerNames.get(l) ?? layerName(l)}</span>
                <button class="pref-reset" disabled={!(String(l) in draft.layerColours)} title="Default" onClick={(e) => { e.preventDefault(); put(l, null); }}>↺</button>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </>
  );
}

/* ─── Keyboard ───────────────────────────────────────────────────────────────────────── */

function Shortcuts({ draft, set }: { draft: Draft; set: SetDraft }) {
  const [filter, setFilter] = useState('');
  const [capturing, setCapturing] = useState<string | null>(null);
  const ov = draft.shortcuts;
  // Twins (a menu's command and the right-click menu's, same name, same editors) listed once: the one with keys, else the menu's
  const list = useMemo(() => {
    type Cmd = ReturnType<typeof commands.all>[number];
    const rank = (c: Cmd) => (c.id in ov || DEFAULT_SHORTCUTS.some((s) => s.command === c.id) ? 0 : 1) + (/:Popup/i.test(c.id) ? 2 : 0);
    const keep = new Map<string, Cmd>();
    for (const c of commands.all()) {
      if (c.planned) continue;
      const k = `${c.label}|${(c.scopes ?? []).join()}`;
      const o = keep.get(k);
      if (!o || rank(c) < rank(o)) keep.set(k, c);
    }
    return [...keep.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, []);
  const eff = [...DEFAULT_SHORTCUTS.filter((s) => !(s.command in ov)), ...Object.entries(ov).filter(([, c]) => c).map(([command, combo]) => ({ combo, command }))];
  const comboOf = (id: string) => eff.filter((s) => s.command === id).map((s) => s.combo);
  const defaultOf = (id: string) => DEFAULT_SHORTCUTS.filter((s) => s.command === id).map((s) => s.combo);
  const assign = (id: string, combo: string) => {
    const next = { ...ov };
    for (const s of eff) {
      if (s.command !== id && s.combo === combo) {
        next[s.command] = '';
        notify(`${combo} moved from “${commands.get(s.command)?.label}” to “${commands.get(id)?.label}”`);
      }
    }
    next[id] = combo;
    if (same(defaultOf(id), [combo])) delete next[id];
    set({ shortcuts: next });
  };
  const reset = (id: string) => { const next = { ...ov }; delete next[id]; set({ shortcuts: next }); };
  const f = filter.trim().toLowerCase();
  return (
    <fieldset class="pref-section">
      <legend>Shortcuts</legend>
      <p class="pref-help">Letter chains (P then W …) follow the menus. Here you set direct shortcuts. Click a shortcut, then press the new keys; Backspace clears it, Esc cancels.</p>
      <input class="prefs-search" type="search" placeholder="Filter commands" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
      <table class="shortcut-table">
        <tbody>
          {list.filter((c) => !f || c.label.toLowerCase().includes(f) || comboOf(c.id).join(' ').toLowerCase().includes(f)).map((c) => {
            const combos = comboOf(c.id);
            const overridden = c.id in ov;
            return (
              <tr key={c.id}>
                <td>{c.label}{c.scopes && <span class="pref-context">{c.scopes.filter((s) => s !== 'global').join(', ')}</span>}</td>
                <td>
                  {capturing === c.id ? (
                    <CaptureInput
                      onKeyDown={(e) => {
                        e.preventDefault(); e.stopPropagation();
                        const combo = normaliseKey(e);
                        if (['Control', 'Shift', 'Alt', 'Meta'].includes(combo)) return;
                        if (combo === 'Escape') { setCapturing(null); return; }
                        if (combo === 'Backspace' || combo === 'Delete') { set({ shortcuts: { ...ov, [c.id]: '' } }); setCapturing(null); return; }
                        assign(c.id, combo);
                        setCapturing(null);
                      }}
                      onBlur={() => setCapturing(null)} />
                  ) : (
                    <button class="combo" onClick={() => setCapturing(c.id)} title="Change shortcut">
                      {combos.length ? combos.map((k) => <kbd key={k}>{k}</kbd>) : <span class="muted">none</span>}
                    </button>
                  )}
                </td>
                <td><button class="pref-reset" disabled={!overridden} title="Default" onClick={() => reset(c.id)}>↺</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </fieldset>
  );
}

/** Read-only input that grabs focus on mount so the next key press is captured. */
function CaptureInput(props: { onKeyDown: (e: KeyboardEvent) => void; onBlur: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <input ref={ref} class="capture" readOnly value="Press keys…" onKeyDown={props.onKeyDown} onBlur={props.onBlur} aria-label="Press the new shortcut" />;
}

