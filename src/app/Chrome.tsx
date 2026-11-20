import { BOOK_TITLES } from '../help/titles';
import { useEffect, useRef, useState } from 'preact/hooks';
import { compiled } from './compiled';
import { compiledLook, compiledInstances } from '../model/compiledView';
import { isDocDirty, activeId, active, activeScope, closeHelp, closeHome, docs, HELP, helpOpen, HOME, homeOpen, messages, tick, cursorTick, units, toast, showShortcuts, type OpenDoc } from './state';
import { togglePanel } from './dock/store';
import { ColourIcon, Icon, docIcon } from './icons';
import { openMenuAt } from './MenuBar';
import { cmdClose } from './actions';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { SchEditor } from '../editors/sch/SchEditor';
import { formatCoord, formatSchLength } from '../core/units';
import { sheetUnit } from './newSheet';
import { layerColour, tabOrder } from '../model/layers';
import { MENUS, panelButtons, effectiveShortcuts } from './commands';
import { layerSetItems } from './pcbOptionsCommands';
import { commands } from '../core/commands';
import type { AccelNode } from '../core/keymap';
import { Dialog } from './Dialog';
import { settings, WHEEL_MODS } from '../core/settings';

import { commandStatus } from './windows';
import { docWins, docsIn, idOfWin, moveDoc, openDocWindow, ownerOf, shownIn, toastWin, trackOwner, shownHere, useWin } from './docWindows';

/** What the mouse wheel does (Preferences › Mouse Wheel Configuration), in the Shortcut Keys sheet. */
const WHEEL_WORDS = { zoom: 'Zoom at cursor', vscroll: 'Scroll up and down', hscroll: 'Scroll left and right', none: '' } as const;

/** Move a document tab before another (or to the end): the tab strip's order is the documents' order. */
export function moveDocTab(id: string, before: string | null): void {
  const list = docs.value.slice();
  const i = list.findIndex((d) => d.id === id);
  if (i < 0 || id === before) return;
  const [d] = list.splice(i, 1);
  const j = before ? list.findIndex((x) => x.id === before) : -1;
  list.splice(j < 0 ? list.length : j, 0, d!);
  if (list.some((x, k) => x !== docs.value[k])) docs.value = list;
}

/** The page's own title, shown with no document active. */
const firstTitle = typeof document !== 'undefined' ? document.title : 'Konium Designer';

/** What a group of tabs is called (System › View › Group documents if need). */
const KIND_NAMES: Record<string, string> = { SchDoc: 'schematics', PcbDoc: 'PCBs', SchLib: 'schematic libraries', PcbLib: 'PCB libraries', OutJob: 'output jobs', BomDoc: 'BOMs', Draftsman: 'drawings', CamDoc: 'CAM documents' };

/** The tab strip of a window ('' the main one): its documents (with Home and help in the main one). */
export function DocTabs({ win = '' }: { win?: string } = {}) {
  void tick.value;
  const here = useWin();
  const shownId = shownIn(win);
  const [dragging, setDragging] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  // The strip's width, to know when the tabs don't fit (Group documents if need)
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = strip.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // Drag a tab along the strip to reorder it, as in Altium (it moves once the pointer passes a neighbour's middle);
  // out of the window, to a window of its own (or into another Konium window it is let go over)
  const press = (e: PointerEvent, id: string) => {
    const x0 = e.clientX;
    let moved = false, out = false;
    const tab = e.currentTarget as HTMLElement;
    try { tab.setPointerCapture(e.pointerId); } catch { /* the pointer went */ }
    const outside = (ev: PointerEvent) => ev.clientX < -8 || ev.clientY < -8 || ev.clientX > here.innerWidth + 8 || ev.clientY > here.innerHeight + 8;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 6) return;
      if (!moved) { moved = true; setDragging(id); }
      out = outside(ev);
      tab.classList.toggle('leaving', out);
      if (out) return;
      const tabs = [...(strip.current?.querySelectorAll<HTMLElement>('.doctab') ?? [])].filter((t) => t.dataset.doc !== id && t.dataset.doc !== HOME && t.dataset.doc !== HELP);
      const next = tabs.find((t) => { const r = t.getBoundingClientRect(); return ev.clientX < r.left + r.width / 2; });
      moveDocTab(id, next?.dataset.doc ?? null);
    };
    const up = (ev: PointerEvent) => {
      tab.removeEventListener('pointermove', move); tab.removeEventListener('pointerup', up); tab.removeEventListener('pointercancel', up);
      tab.classList.remove('leaving');
      setDragging(null);
      const od = docs.value.find((d) => d.id === id);
      if (!moved || !out || !od || ev.type === 'pointercancel') return;
      // Let go over another Konium window: it goes there; elsewhere, to a window of its own
      const over = [window, ...docWins.value.map((w) => w.win)].find((w) => { try { return w !== here && !w.closed && ev.screenX >= w.screenX && ev.screenX < w.screenX + w.outerWidth && ev.screenY >= w.screenY && ev.screenY < w.screenY + w.outerHeight; } catch { return false; } });
      if (over) moveDoc(od, idOfWin(over));
      else if (win === '' || docsIn(win).length > 1) openDocWindow(od, { x: ev.screenX, y: ev.screenY });
    };
    tab.addEventListener('pointermove', move);
    tab.addEventListener('pointerup', up);
    tab.addEventListener('pointercancel', up);
  };
  // The window's title: its document's name, or its path in its project (System › View)
  const titled = docs.value.find((d) => d.id === shownId);
  const title = titled ? `${settings.titleFullPath ? titled.path ?? titled.name : titled.name}${isDocDirty(titled) ? ' *' : ''} — Konium Designer` : firstTitle;
  if (here.document.title !== title) here.document.title = title;
  // System › View › Documents Bar: hidden with only one tab; on several lines; tabs of a kind grouped when they don't all fit
  const main = win === '';
  const shown = docsIn(win).filter((d) => !d.hidden && !d.forCompare);
  const hide = settings.autoHideTabs && shown.length + (main && homeOpen.value ? 1 : 0) + (main && helpOpen.value ? 1 : 0) <= 1;
  const est = (d: OpenDoc) => (settings.equalWidthTabs ? 161 : Math.min(400, (d.name.length + 2) * 6.3 + 52));
  const need = shown.reduce((n, d) => n + est(d), (main && homeOpen.value ? 72 : 0) + (main && helpOpen.value ? 160 : 0));
  const grouping = settings.groupTabs && !settings.multilineTabs && width > 0 && need > width;
  const groups = new Map<string, OpenDoc[]>();
  if (grouping) for (const d of shown) { const g = groups.get(d.doc.kind) ?? []; g.push(d); groups.set(d.doc.kind, g); }
  const seen = new Set<string>();
  const items: ({ d: OpenDoc } | { kind: string; list: OpenDoc[] })[] = [];
  for (const d of shown) {
    const g = groups.get(d.doc.kind);
    if (!g || g.length < 2) { items.push({ d }); continue; }
    if (seen.has(d.doc.kind)) continue;
    seen.add(d.doc.kind);
    items.push({ kind: d.doc.kind, list: g });
  }
  const groupTab = (kind: string, list: OpenDoc[]) => {
    const cur = list.find((d) => d.id === shownId);
    const menu = (e: MouseEvent) => {
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      openMenuAt({ key: '', label: '', children: list.map((d) => ({ key: '', label: `${d.name}${isDocDirty(d) ? ' *' : ''}`, checked: d.id === shownId, action: () => { activeId.value = d.id; } })) }, r.left, r.bottom + 1);
    };
    return (
      <div key={`g:${kind}`} role="tab" aria-selected={!!cur} aria-haspopup="menu" class={`doctab doctab-group kind-${kind.toLowerCase()}${cur ? ' on' : ''}`} data-doc-group={kind}
        onMouseDown={(e) => { if (e.button === 0) menu(e as unknown as MouseEvent); }} title={list.map((d) => d.name).join('\n')}>
        <ColourIcon name={docIcon((cur ?? list[0]!).name)} size={14} />
        <span class="doctab-name">{cur ? `${cur.name}${isDocDirty(cur) ? ' *' : ''}` : `${list.length} ${KIND_NAMES[kind] ?? kind}`}</span>
        <span class="doctab-count">{list.length} ▾</span>
      </div>
    );
  };
  return (
    <div class={`doctabs${settings.equalWidthTabs ? ' equal' : ''}${settings.multilineTabs ? ' multi' : ''}${hide ? ' autohide' : ''}`} role="tablist" ref={strip}>
      {main && homeOpen.value && (
        <div role="tab" aria-selected={shownId === HOME} class={`doctab kind-home${shownId === HOME ? ' on' : ''}`} data-doc={HOME}
          onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); if (settings.middleClickCloses) closeHome(); } else if (e.button === 0) activeId.value = HOME; }} title="Home">
          <ColourIcon name="home" size={14} />
          <span class="doctab-name">Home</span>
          <button class="doctab-close" aria-label="Close Home" onMouseDown={(e) => { e.stopPropagation(); closeHome(); }}>×</button>
        </div>
      )}
      {main && helpOpen.value && (
        <div role="tab" aria-selected={shownId === HELP} class={`doctab kind-help${shownId === HELP ? ' on' : ''}`} data-doc={HELP}
          onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); if (settings.middleClickCloses) closeHelp(); } else if (e.button === 0) activeId.value = HELP; }} title={BOOK_TITLES[helpOpen.value.topic]}>
          <ColourIcon name={helpOpen.value.topic === 'guide' ? 'userGuide' : 'scriptRef'} size={14} />
          <span class="doctab-name">{BOOK_TITLES[helpOpen.value.topic]}</span>
          <button class="doctab-close" aria-label={`Close ${BOOK_TITLES[helpOpen.value.topic]}`} onMouseDown={(e) => { e.stopPropagation(); closeHelp(); }}>×</button>
        </div>
      )}
      {items.map((it) => {
        if (!('d' in it)) return groupTab(it.kind, it.list);
        const d = it.d;
        const dirty = isDocDirty(d);
        const on = d.id === shownId;
        return (
          <div key={d.id} role="tab" aria-selected={on} class={`doctab kind-${d.doc.kind.toLowerCase()}${on ? ' on' : ''}${dragging === d.id ? ' dragging' : ''}`} data-ctx="doctab" data-doc={d.id}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); if (settings.middleClickCloses) cmdClose(d); } else if (e.button === 0) activeId.value = d.id; }}
            onPointerDown={(e) => { if (e.button === 0 && !(e.target as HTMLElement).closest('.doctab-close')) press(e as unknown as PointerEvent, d.id); }}
            title={d.path ?? d.name}>
            <ColourIcon name={docIcon(d.name)} size={14} />
            <span class="doctab-name">{d.name}{dirty ? ' *' : ''}</span>
            <button class="doctab-close" aria-label={`Close ${d.name}`} onMouseDown={(e) => { e.stopPropagation(); cmdClose(d); }}>×</button>
          </div>
        );
      })}
    </div>
  );
}

/** Mounts a window's document's editor view into a stable host element. */
export function ViewportHost({ od }: { od: OpenDoc | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const ed = od?.editor;
    if (!el || !ed) return;
    ed.mount(el);
    ed.viewport?.host.focus({ preventScroll: true });
    return () => ed.unmount(el);
  }, [od?.id]);
  return <div class="viewport-host" ref={ref} />;
}

/**
 * Window › Tile, Tile Horizontally, Tile Vertically: every open document with an editor in its
 * own pane; a click in a pane makes it the active document (its menus, panels and keys).
 */
export function TiledHost({ mode }: { mode: 'grid' | 'h' | 'v' }) {
  const list = docsIn('').filter((d) => d.editor && !d.hidden && !d.forCompare);
  const n = list.length;
  const cols = mode === 'v' ? n : mode === 'h' ? 1 : Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return (
    <div class="tiled" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
      {list.map((d) => <Pane key={d.id} od={d} on={d.id === activeId.value} />)}
    </div>
  );
}
function Pane({ od, on }: { od: OpenDoc; on: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current, ed = od.editor;
    if (!el || !ed) return;
    ed.mount(el);
    // Each pane starts with its whole document in view
    const t = setTimeout(() => ed.viewport?.fit(), 60);
    return () => { clearTimeout(t); ed.unmount(el); };
  }, [od.id]);
  return (
    <div class={`pane${on ? ' on' : ''}`} onMouseDownCapture={() => { if (activeId.value !== od.id) activeId.value = od.id; }}>
      <div class="pane-title">{od.name}</div>
      <div class="pane-body"><div class="viewport-host" ref={ref} /></div>
    </div>
  );
}

/** Layer tabs under the PCB: LS button, one tab per layer (Altium names and order), Clear. */
/** Mask Level: how faded masked (filtered-out) objects are drawn. */
function MaskLevel() {
  const [open, setOpen] = useState(false);
  const [dim, setDim] = useState(Math.round(SchEditor.maskDim * 100));
  return (
    <span class="masklevel">
      <button class="layer-cmd" title="How faded masked objects are" onMouseDown={(e) => { e.preventDefault(); setOpen(!open); }}>Mask Level</button>
      {open && (
        <span class="masklevel-pop" role="dialog" aria-label="Mask Level" onMouseLeave={() => setOpen(false)}>
          <label>Dim <input type="range" min={0} max={95} value={dim} onInput={(e) => {
            const v = Number((e.target as HTMLInputElement).value); setDim(v); SchEditor.maskDim = v / 100;
            for (const d of docs.value) d.editor?.invalidate();
          }} /><span>{dim}%</span></label>
        </span>
      )}
    </span>
  );
}

/**
 * Under a compiled sheet, as AD: the Editor tab, then Compiled (or one tab per channel of a
 * repeated sheet) showing the names the compile gave (Preferences › Schematic › Compiler ›
 * Compiled Names Expansion), read-only.
 */
function CompiledTabs({ ed }: { ed: SchEditor }) {
  const od = active.value, res = compiled.value;
  const name = od?.name ?? '';
  const mine = !!res && !!od && !ed.libraryMode && (res.projectId ?? null) === (od.projectId ?? null) && res.sheets.some((x) => x.name.toLowerCase() === name.toLowerCase());
  const insts = mine ? compiledInstances(res!.result, name) : [];
  const what = { designators: settings.schCompiledDesignators, netLabels: settings.schCompiledNetLabels, ports: settings.schCompiledPorts, power: settings.schCompiledPower,
    documentNumber: settings.schCompiledDocNumber, sheetNumber: settings.schCompiledSheetNumber };
  const look = (inst: string) => compiledLook(res!.result, ed.doc, name, inst, what, res!.sheets.map((x) => x.name));
  const [, redraw] = useState(0);
  const show = (v: ReturnType<typeof look> | null) => { ed.setCompiledView(v); redraw((n) => n + 1); tick.value++; };
  // A compile since (or the sheet no longer in it): the view follows, or goes back to the editor
  useEffect(() => {
    const cv = ed.compiledView;
    if (!cv) return;
    if (!mine || !insts.includes(cv.inst)) ed.setCompiledView(null);
    else ed.setCompiledView(look(cv.inst));
  }, [res?.at]);
  if (!insts.length) return null;
  const cur = ed.compiledView?.inst ?? null;
  return (
    <span class="sheet-tabs" role="tablist" aria-label="Sheet views">
      <button role="tab" aria-selected={cur === null} class={`sheet-tab${cur === null ? ' on' : ''}`} onMouseDown={(e) => { e.preventDefault(); show(null); }}>Editor</button>
      {insts.map((i) => (
        <button key={i} role="tab" aria-selected={cur === i} class={`sheet-tab${cur === i ? ' on' : ''}`} title="The sheet as compiled: read-only"
          onMouseDown={(e) => { e.preventDefault(); show(look(i)); }}>{insts.length === 1 ? 'Compiled' : i}</button>
      ))}
    </span>
  );
}

/** The schematic editor's bottom strip: the sheet's views, Mask Level and Clear (Shift+C), as Altium's. */
function SchFootBar({ ed }: { ed: SchEditor }) {
  return (
    <div class="layerbar schfoot" role="toolbar" aria-label="Filter">
      <CompiledTabs ed={ed} />
      <span class="layerbar-right">
        {ed.mask && <span class="layerbar-mode">Filter applied: {ed.mask.size} object{ed.mask.size === 1 ? '' : 's'}</span>}
        <MaskLevel />
        <button class="layer-cmd" title="Clear the filter (Shift+C)" onMouseDown={(e) => { e.preventDefault(); commands.run('pcb.clearHighlight', ed.scope); }}>Clear</button>
      </span>
    </div>
  );
}

/** The layer tabs (or a sheet's bar) under a window's document. */
export function LayerBar({ od }: { od?: OpenDoc | null } = {}) {
  void tick.value;
  const tabsRef = useRef<HTMLDivElement>(null);
  const ed = (od === undefined ? active.value : od)?.editor;
  if (ed instanceof SchEditor) return <SchFootBar ed={ed} />;
  if (!(ed instanceof PcbEditor)) return null;
  const hex = (l: number) => `#${layerColour(l).toString(16).padStart(6, '0')}`;
  // The layers shown (as AD: a layer turned off leaves the bar; the current one stays)
  const layers = ed.layers().filter((l) => !ed.hidden.has(l) || l === ed.currentLayer).sort((a, b) => tabOrder(a) - tabOrder(b));
  return (
    <div class="layerbar" role="toolbar" aria-label="Layers">
      <button class="layer-ls" title={`Layer sets — current layer: ${ed.layerLabel(ed.currentLayer)} (Shift+S single layer mode)`}
        onMouseDown={(e) => {
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenuAt({ key: '', label: '', children: [...layerSetItems(), { key: 'T', label: 'Board Layer Sets...', accelAt: 12, separatorBefore: true, command: 'ad:PCB:ManageLayerSets' },
            { key: 'S', label: 'Single Layer Mode', accelAt: 0, command: 'pcb.singleLayer' }] }, r.left, r.top - 8 - 22 * 8);
        }}>
        <span class="swatch" style={{ background: hex(ed.currentLayer) }} />LS
      </button>
      <div class="layer-tabs" ref={tabsRef} onWheel={(e) => { const el = e.currentTarget as HTMLElement; el.scrollLeft += (e.deltaY || e.deltaX); e.preventDefault(); }}>
        {layers.map((l) => {
          const on = l === ed.currentLayer, hidden = ed.hidden.has(l);
          return (
            <button key={l} class={`layer${on ? ' on' : ''}${hidden ? ' hidden' : ''}`} title={`${ed.layerLabel(l)} — click to make current, Ctrl+click to hide (View Configurations (L) shows it again)`}
              onMouseDown={(e) => { e.preventDefault(); if (e.ctrlKey || e.metaKey) ed.toggleLayer(l); else ed.setCurrentLayer(l); }}>
              <span class="swatch" style={{ background: hex(l) }} />
              {ed.layerLabel(l)}
            </button>
          );
        })}
      </div>
      <span class="layer-scroll" aria-hidden="true">
        <button title="Scroll layer tabs left" onMouseDown={(e) => { e.preventDefault(); tabsRef.current?.scrollBy({ left: -160 }); }}>◂</button>
        <button title="Scroll layer tabs right" onMouseDown={(e) => { e.preventDefault(); tabsRef.current?.scrollBy({ left: 160 }); }}>▸</button>
      </span>
      <span class="layerbar-right">
        {ed.singleLayer !== 'off' && <span class="layerbar-mode">Single layer: {ed.singleLayer}</span>}
        <MaskLevel />
        <button class="layer-cmd" title="Clear net highlighting and masks (Shift+C)" onMouseDown={(e) => { e.preventDefault(); commands.run('pcb.clearHighlight', 'pcb'); }}>Clear</button>
      </span>
    </div>
  );
}

/** A window's status bar: its document's position, grid and hint (the active document's by default). */
export function StatusBar({ od: own }: { od?: OpenDoc | null } = {}) {
  void tick.value;
  void cursorTick.value; // the position and the tool's hint follow the cursor
  const od = own === undefined ? active.value : own;
  const ed = od?.editor;
  const u = units.value;
  const right = <StatusRight />;
  if (!ed) return <footer class="statusbar">{settings.commandStatus && <span class="cmd-status">{commandStatus(null)}</span>}<span class="hint">{od ? (od.doc.kind === 'OutJob' ? `${od.name}: Output Job — select a container, tick the outputs it takes, then Generate content` : od.doc.kind === 'BomDoc' ? `${od.name}: BOM document — the project's parts as compiled now; choose columns, grouping and variant` : od.doc.kind === 'DbLink' ? `${od.name}: database link — the data file, its tables, the key and the field mappings` : od.doc.kind === 'DbLib' ? `${od.name}: database library — its database, tables, field mappings and search paths; its records are parts in the Libraries panel` : od.doc.kind === 'StepDoc' ? `${od.name}: 3D model — drag to turn it, right-drag to pan, wheel to zoom; click a part to select it` : od.doc.kind === 'ReqDoc' ? `${od.name}: requirements: Insert adds one, Delete removes the row, Alt+Up and Alt+Down move it` : od.doc.kind === 'MbsDoc' ? `${od.name}: multi-board schematic — drag a module to move it; the side lists the pins the boards share` : od.doc.kind === 'Diagram' ? `${od.name}: diagram — drag a shape from the Shapes panel onto the page, or click it; drag a selected shape's blue arrows to another to connect; double-click to label` : od.doc.kind === 'Enclosure' ? `${od.name}: enclosure — the board's box; pick a tool on the left and click a face to add a hole, cut-out, boss or text; pick a feature to change it on the right; Export to print` : od.doc.kind === 'MbaDoc' ? `${od.name}: multi-board assembly — drag to turn the view, pick a part to move or turn it` : od.doc.kind === 'Draftsman' ? `${od.name}: Draftsman document — click an item to pick it, drag to move it; Delete removes it; the bar places views and tables` : od.doc.kind === 'SimData' ? `${od.name}: simulation results — wheel to zoom, drag to pan, double-click to fit; the tabs below are the analyses` : od.doc.kind === 'SimText' ? `${od.name}: ${/\.(mdl|ckt)$/i.test(od.name) ? 'simulation model' : 'simulation netlist — Simulate › Run Simulation runs it'}` : `${od.name}: inspection only`) : ''}</span>{right}</footer>;
  const o = ed.origin();
  const c = ed.snap(ed.cursor);
  // A schematic in its own unit (Document Options › Units); a board in the chosen one
  const sch = ed instanceof SchEditor && !ed.libraryMode ? sheetUnit(ed.doc) : null;
  const fmt = (v: number) => (sch !== null ? formatSchLength(v, sch) : formatCoord(v, ed instanceof SchEditor ? 'mil' : u));
  return (
    <footer class="statusbar">
      <span class="coord">X:{fmt(c.x - o.x)} Y:{fmt(c.y - o.y)}</span>
      <span class="grid-size">Grid:{fmt(ed.gridSize())}</span>
      {ed instanceof PcbEditor && <span class="status-layer"><span class="swatch" style={{ background: `#${layerColour(ed.currentLayer).toString(16).padStart(6, '0')}` }} />{ed.layerLabel(ed.currentLayer)}</span>}
      {ed.selection.size > 0 && <span>{ed.selection.size} selected</span>}
      {ed instanceof PcbEditor && (() => { const info = ed.statusInfo(); return info ? <span class="status-obj">{info}</span> : null; })()}
      <span class="hint">{ed.hint()}</span>
      {settings.commandStatus && <span class="cmd-status">{commandStatus(ed)}</span>}
      {right}
    </footer>
  );
}

/** Right end of the status bar: message count, then Altium's panel buttons (System, Design Compiler, SCH / PCB). */
function StatusRight() {
  const list = messages.value;
  const warn = list.filter((m) => m.level === 'warn').length, err = list.filter((m) => m.level === 'error').length;
  const scope = activeScope.value;
  const groups = panelButtons(scope);
  const open = (node: AccelNode, e: MouseEvent) => {
    e.preventDefault();
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenuAt(node, b.left, b.top - 8 - (node.children?.length ?? 0) * 23);
  };
  return (
    <span class="status-right">
      {(warn > 0 || err > 0) && (
        <button class={`status-msgs${err ? ' err' : ''}`} onClick={() => togglePanel('messages', scope)} title="Show Messages">
          <Icon name="warn" size={13} />{err ? `${err} error${err > 1 ? 's' : ''}` : ''}{err && warn ? ', ' : ''}{warn ? `${warn} warning${warn > 1 ? 's' : ''}` : ''}
        </button>
      )}
      {groups.map((g) => <button key={g.label} class="status-panel-btn" onMouseDown={(e) => open(g, e)}>{g.label}</button>)}
      <button class="status-panel-btn" onMouseDown={(e) => { e.preventDefault(); showShortcuts.value = true; }}>Shortcuts</button>
    </span>
  );
}

export function Toast() {
  const t = toast.value;
  if (!t || ownerOf(toastWin.value) !== useWin()) return null;
  return <div class={`toast ${t.kind}`} role="status">{t.text}</div>;
}

trackOwner('shortcuts', () => showShortcuts.value);
export function ShortcutSheet() {
  if (!showShortcuts.value || !shownHere('shortcuts', useWin())) return null;
  const rows: [string, string][] = [];
  const scope = activeScope.value;
  const walk = (n: AccelNode, prefix: string, d: number) => {
    for (const c of n.children ?? []) {
      if (!c.key) continue;
      const seq = `${prefix}, ${c.key}`;
      if (c.children) { if (d < 4) walk(c, seq, d + 1); }
      else if (c.command && commands.isLive(c.command, scope)) rows.push([seq, `${n.label} › ${c.label}`]);
    }
  };
  for (const m of MENUS) if (m.key && m.scopes.includes(scope)) walk(m, m.key, 0);
  const uniq = [...new Map(rows.map((r) => [r.join('|'), r])).values()];
  const close = () => { showShortcuts.value = false; };
  return (
    <Dialog title="Shortcut Keys" onClose={close} width={900} height={640}
      footer={<button class="btn default" onClick={close}>Close</button>}>
      <p class="muted">Letters chain through menus: press P then W to place a wire. Tools take Space, Shift+Space, Tab, Backspace and Esc first.</p>
      <div class="sheet-cols">
        <table class="keys">
          <tbody>
            {effectiveShortcuts().filter((s) => { const c = commands.get(s.command); return !!c && !c.planned; }).map((s) => <tr key={s.combo + s.command}><td><kbd>{s.combo}</kbd></td><td>{commands.get(s.command)?.label}{s.scopes ? <span class="muted"> ({s.scopes.join(', ')})</span> : null}</td></tr>)}
            <tr><td><kbd>Ctrl+click</kbd></td><td>Highlight net (PCB)</td></tr>
            <tr><td><kbd>Right-drag</kbd></td><td>Pan</td></tr>
            {WHEEL_MODS.filter((m) => settings.wheelMap[m] !== 'none').map((m) => (
              <tr key={m}><td><kbd>{m === 'Wheel' ? 'Wheel' : `${m}+wheel`}</kbd></td><td>{WHEEL_WORDS[settings.wheelMap[m]]}</td></tr>
            ))}
          </tbody>
        </table>
        <table class="keys">
          <tbody>{uniq.map(([k, v]) => <tr key={k + v}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}</tbody>
        </table>
      </div>
    </Dialog>
  );
}
