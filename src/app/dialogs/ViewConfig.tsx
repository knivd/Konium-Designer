import { useEffect, useRef, useState } from 'preact/hooks';
import { formerValue } from '../../core/former';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify } from '../state';
import { TRANSPARENCY_KINDS, TRANSPARENCY_LAYERS, TRANSPARENCY_STANDARD, TRANSPARENCY_TRANSPARENT, rgbToHex, settings, updateSettings, type Settings } from '../../core/settings';
import { FINISHES, MASK_COLOURS, VIEW3D_PRESETS, view3dFrom, view3dName, type View3D } from '../../core/view3d';
import { saveFileAs } from '../../platform/fs';
import { L, defaultLayerColour, isMech, isPlane, isSignal, layerName, mechLayer, type LayerId } from '../../model/layers';
import { MECH_KINDS, PAIR_KINDS, mechEnabled, mechKinds, mechPairs, setLayerNames, setMechEnabled, setMechLayout } from '../../model/pcbBoard';
import { setSheetLinked, sheetOf } from '../../model/sheet';
import type { PcbEditor, SingleLayerMode } from '../../editors/pcb/PcbEditor';

/**
 * Design › Board Layers & Colors (L) and View Configurations (Ctrl+D), as Altium Designer 17
 * lays the dialog out: the view configurations on the left (2D and 3D; Save As and Load move
 * one between browsers), and the tabs Board Layers And Colors (each group's layers with colour
 * and Show, mechanical layers with Enable (saved in the board) / Single Layer Mode / Linked To Sheet, their Layer Type
 * and the Component Layer Pairs (saved in the board: a part flipped to the other side moves its objects on one layer of
 * a pair to the other), System Colors,
 * the On / Off buttons), Show/Hide (Final, Draft, Hidden per object kind), View Options and
 * Transparency; a 3D configuration has the one tab Physical Materials (General, Colours and
 * Visibility, 3D Bodies). Picking a configuration of the other kind and pressing OK or Apply
 * switches the view to it. Apply and OK change the view; Cancel leaves it as it was.
 */
export type ViewConfigTab = 'layers' | 'showhide' | 'options' | 'transparency' | 'materials';

/** Show/Hide kinds: [key, label]. */
const KINDS: [string, string][] = [
  ['arc', 'Arcs'], ['fill', 'Fills'], ['pad', 'Pads'], ['polygon', 'Polygons'], ['dimension', 'Dimensions'], ['text', 'Strings'],
  ['track', 'Tracks'], ['via', 'Vias'], ['coordinate', 'Coordinates'], ['room', 'Rooms'], ['region', 'Regions'], ['body', '3D Bodies'],
];
const CONFIGS: [string, Record<string, number>][] = [['Standard 2D', TRANSPARENCY_STANDARD], ['Transparent 2D', TRANSPARENCY_TRANSPARENT]];
const sameTransparency = (a: Record<string, number>, b: Record<string, number>) => Object.keys(b).every((k) => (a[k] ?? 0) === b[k]);
/** The 2D configuration the transparency settings are (Custom once changed). */
const name2d = (t: Record<string, number>) => CONFIGS.find(([, v]) => sameTransparency(t, v))?.[0] ?? 'Custom';

const VIEW_KEYS = ['layerColours', 'pcbShowConnections', 'pcbShowHoles', 'pcbConnectionColour', 'pcbHoleColour', 'pcbViaColour', 'pcbBoardColour', 'pcbBackground',
  'pcbGridColour', 'selectionColour', 'pcbHiddenKinds', 'pcbShowPadNets', 'pcbShowPadNumbers', 'pcbShowViaNets', 'pcbTrackNetNames', 'pcbShowOriginMarker', 'pcbShowHiddenText', 'pcbShowPours', 'pcbTransparency',
  'pcbMechSingleLayer', 'pcbDrcMarkerColour', 'pcbDrcDetailColour', 'pcbGridColourLarge', 'pcbHighlightColour', 'pcbBoardLineColour', 'pcbSheetLineColour', 'pcbSheetAreaColour',
  'pcbWorkspaceEnd', 'pcbDimLine1', 'pcbDimLine2', 'pcbViolationOverlay', 'pcbViolationDetails', 'pcbDraftKinds', 'pcbConvertSpecial', 'pcbConnectionLayerColours', 'pcbShowRefPoint',
  'pcbShowTestPoints', 'pcbShowStatusInfo', 'pcbAllConnectionsSingle', 'pcbPlaneDrawing', 'pcbNewNetColour'] as const satisfies readonly (keyof Settings)[];
type ViewKeys = typeof VIEW_KEYS[number];
type Draft = Pick<Settings, ViewKeys>;
type ColourKey = { [K in ViewKeys]: Draft[K] extends string ? K : never }[ViewKeys];
type ShowKey = { [K in ViewKeys]: Draft[K] extends boolean ? K : never }[ViewKeys];

const pick = (from: Settings = settings): Draft => structuredClone(Object.fromEntries(VIEW_KEYS.map((k) => [k, from[k]])) as Draft);

export function ViewConfigDialog({ ed, tab: first = 'layers' }: { ed: PcbEditor; tab?: ViewConfigTab }) {
  // In 3D Layout Mode the dialog opens on the 3D configuration
  const [kind, setKind] = useState<'2d' | '3d'>(ed.mode3d || first === 'materials' ? '3d' : '2d');
  const [tab, setTab] = useState<ViewConfigTab>(ed.mode3d ? 'materials' : first);
  const [d, setD] = useState<Draft>(() => pick());
  const [d3, setD3] = useState<View3D>(() => view3dFrom(settings.pcb3d));
  const set3 = (p: Partial<View3D>) => setD3({ ...d3, ...p });
  const [hidden, setHidden] = useState(() => new Set(ed.hidden));
  const [single, setSingle] = useState<SingleLayerMode>(ed.singleLayer);
  const [inStack, setInStack] = useState(true);
  const [planesInStack, setPlanesInStack] = useState(true);
  const [usedMech, setUsedMech] = useState(true);
  const [picked, setPicked] = useState<Set<LayerId>>(new Set());
  // Mechanical layer names: double-click one to rename it
  const [names, setNames] = useState<Map<LayerId, string>>(new Map());
  const [renaming, setRenaming] = useState<LayerId | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (p: Partial<Draft>) => setD({ ...d, ...p });

  const doc = ed.doc;
  const used = new Set<LayerId>();
  for (const p of doc.prims) if ('layer' in p && p.layer) used.add(p.layer);
  // Mechanical layers the board has enabled (Board6), else the ones in use
  const [enabled0] = useState(() => mechEnabled(doc) ?? new Set([...used].filter(isMech)));
  const [enabled, setEnabled] = useState(() => new Set(enabled0));
  const canEnable = !!doc.board.bag;
  // Mechanical layer types and component layer pairs (kept in the board)
  const [kinds0] = useState(() => mechKinds(doc));
  const [kinds, setKinds] = useState(() => new Map(kinds0));
  const [pairs0] = useState(() => mechPairs(doc));
  const [pairs, setPairs] = useState<[LayerId, LayerId][]>(() => pairs0.map(([a, b]) => [a, b]));
  const [pairKind, setPairKind] = useState('Assembly');
  const [pairA, setPairA] = useState<LayerId>(mechLayer(13));
  const [pairB, setPairB] = useState<LayerId>(mechLayer(15));
  const kindName = (l: LayerId) => MECH_KINDS.find(([k]) => k === (kinds.get(l) ?? ''))?.[1] ?? kinds.get(l) ?? '';
  const pairName = ([a, b]: [LayerId, LayerId]) => PAIR_KINDS.find(([, t, u]) => kinds.get(a) === t && kinds.get(b) === u)?.[0] ?? '';
  // Linked To Sheet (kept in the board)
  const [linked0] = useState(() => new Set(sheetOf(doc).linked));
  const [linked, setLinked] = useState(() => new Set(linked0));
  const stack = doc.board.copperStack;
  const signals = (inStack ? stack.filter(isSignal) : [L.TOP, ...Array.from({ length: 30 }, (_, i) => L.MID1 + i), L.BOTTOM]);
  const planes = (planesInStack ? stack.filter(isPlane) : Array.from({ length: 16 }, (_, i) => L.PLANE1 + i));
  const mechs = Array.from({ length: 32 }, (_, i) => mechLayer(i + 1)).filter((l) => !usedMech || enabled.has(l) || used.has(l));
  const groups: [string, LayerId[]][] = [
    ['Signal Layers', signals], ['Internal Planes', planes], ['Mechanical Layers', mechs],
    ['Mask Layers', [L.TOP_PASTE, L.BOTTOM_PASTE, L.TOP_SOLDER, L.BOTTOM_SOLDER]],
    ['Other Layers', [L.DRILL_GUIDE, L.KEEPOUT, L.DRILL_DRAWING, L.MULTI]],
    ['Silkscreen Layers', [L.TOP_OVERLAY, L.BOTTOM_OVERLAY]],
  ];
  const all = groups.flatMap(([, ls]) => ls);
  const colour = (l: LayerId) => d.layerColours[String(l)] ?? rgbToHex(defaultLayerColour(l));
  const setColour = (l: LayerId, hex: string) => set({ layerColours: { ...d.layerColours, [String(l)]: hex } });
  const toggle = (l: LayerId) => { const h = new Set(hidden); if (h.has(l)) h.delete(l); else h.add(l); setHidden(h); };
  const label = (l: LayerId) => names.get(l) ?? doc.board.layerNames.get(l) ?? layerName(l);
  // AD's keys while the window is open: T Top copper, B Bottom copper, E Top Overlay, R Bottom Overlay, 1, 2, 3 … the internal copper layers in stack order
  useEffect(() => {
    const inner = stack.filter((l) => l !== L.TOP && l !== L.BOTTOM);
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes((t as HTMLInputElement).type)))) return;
      const k = e.key.toLowerCase();
      const l: LayerId | undefined = k === 't' ? L.TOP : k === 'b' ? L.BOTTOM : k === 'e' ? L.TOP_OVERLAY : k === 'r' ? L.BOTTOM_OVERLAY : /^[1-9]$/.test(k) ? inner[Number(k) - 1] : undefined;
      if (l === undefined) return;
      e.preventDefault(); e.stopPropagation();
      setHidden((h0) => { const h = new Set(h0); if (h.has(l)) h.delete(l); else h.add(l); return h; });
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [stack.join()]);
  const pickRow = (l: LayerId, add: boolean) => { const s = new Set(add ? picked : []); if (s.has(l)) s.delete(l); else s.add(l); setPicked(s); };

  const apply = () => {
    const changed = new Map<LayerId, boolean>();
    for (const l of new Set([...enabled0, ...enabled])) if (enabled0.has(l) !== enabled.has(l)) changed.set(l, enabled.has(l));
    if (changed.size && canEnable) {
      ed.undo.transact('Enable mechanical layers', (tx) => tx.add(setMechEnabled(doc, changed)));
      enabled0.clear(); for (const l of enabled) enabled0.add(l);
    }
    if (canEnable && (linked.size !== linked0.size || [...linked].some((l) => !linked0.has(l)))) {
      ed.undo.transact('Link layers to sheet', (tx) => tx.add(setSheetLinked(doc, linked)));
      linked0.clear(); for (const l of linked) linked0.add(l);
    }
    const kindsChanged = new Map([...new Set([...kinds0.keys(), ...kinds.keys()])].filter((l) => (kinds0.get(l) ?? '') !== (kinds.get(l) ?? '')).map((l) => [l, kinds.get(l) ?? '']));
    const pairsChanged = pairs.length !== pairs0.length || pairs.some(([a, b], i) => pairs0[i]?.[0] !== a || pairs0[i]?.[1] !== b);
    if (canEnable && (kindsChanged.size || pairsChanged)) {
      ed.undo.transact('Mechanical layer types and pairs', (tx) => tx.add(setMechLayout(doc, kindsChanged, pairs)));
      kinds0.clear(); for (const [l, k] of kinds) kinds0.set(l, k);
      pairs0.splice(0, pairs0.length, ...pairs.map(([a, b]): [LayerId, LayerId] => [a, b]));
    }
    const renamed = new Map([...names].filter(([l, n]) => n && n !== (doc.board.layerNames.get(l) ?? layerName(l))));
    if (renamed.size && canEnable) { ed.undo.transact('Rename mechanical layers', (tx) => tx.add(setLayerNames(doc, renamed))); setNames(new Map()); }
    updateSettings({ ...d, pcb3d: d3 });
    ed.hidden = new Set(hidden);
    ed.singleLayer = single;
    ed.invalidate();
    // A configuration of the other kind picked: the view goes to it
    if ((kind === '3d') !== ed.mode3d) ed.set3d(kind === '3d');
  };
  const pick2d = (t: Record<string, number>) => { setKind('2d'); if (tab === 'materials') setTab('layers'); set({ pcbTransparency: { ...t } }); };
  const pick3d = (p: View3D) => { setKind('3d'); setTab('materials'); setD3({ ...p }); };
  const ok = () => { apply(); closeDialog(); };

  /** View configuration files: the view settings and the layers shown, as JSON. */
  const saveAs = () => {
    const json = JSON.stringify({ konium: 'viewConfiguration', version: 1, settings: { ...d, pcb3d: d3 }, hidden: [...hidden], single }, null, 2);
    void saveFileAs(kind === '3d' ? `${view3dName(d3).replace(/ \(changed\)$/, '')}.config_3d.json` : `${name2d(d.pcbTransparency)}.config_2dsimple.json`, new TextEncoder().encode(json));
  };
  const load = async (f: File) => {
    try {
      const o = JSON.parse(await f.text()) as Record<string, unknown> & { konium?: string; settings?: Partial<Draft> & { pcb3d?: unknown }; hidden?: number[]; single?: SingleLayerMode };
      if ((o.konium ?? formerValue(o)) !== 'viewConfiguration' || !o.settings) throw new Error('not a Konium Designer view configuration');
      setD({ ...d, ...pick({ ...settings, ...o.settings } as Settings) });
      if (o.settings.pcb3d) setD3(view3dFrom(o.settings.pcb3d));
      if (Array.isArray(o.hidden)) setHidden(new Set(o.hidden));
      if (o.single) setSingle(o.single);
      notify(`Loaded ${f.name}: Apply or OK to use it`);
    } catch (e) { notify(`Couldn't load ${f.name}: ${(e as Error).message}`, 'error'); }
  };

  const slider = (k: string, n: string) => {
    const val = d.pcbTransparency[k] ?? 0;
    return (
      <label key={k} class="vc-line">{n}
        <span class="vc-range"><input type="range" min={0} max={90} step={5} value={val} aria-label={`${n} transparency`}
          onInput={(e) => set({ pcbTransparency: { ...d.pcbTransparency, [k]: Number((e.target as HTMLInputElement).value) } })} /><span class="vc-pct">{val}%</span></span>
      </label>
    );
  };

  const sys: [string, ColourKey, ShowKey?][] = [
    ['Connection Lines', 'pcbConnectionColour', 'pcbShowConnections'], ['DRC Error / Waiver Markers', 'pcbDrcMarkerColour', 'pcbViolationOverlay'], ['DRC Detail Markers', 'pcbDrcDetailColour', 'pcbViolationDetails'],
    ['Selections', 'selectionColour'], ['Default Grid Colour - Small', 'pcbGridColour'], ['Default Grid Colour - Large', 'pcbGridColourLarge'], ['Pad Holes', 'pcbHoleColour', 'pcbShowHoles'], ['Via Holes', 'pcbViaColour'],
    ['Highlight Colour', 'pcbHighlightColour'], ['Board Line Colour', 'pcbBoardLineColour'], ['Board Area Colour', 'pcbBoardColour'], ['Sheet Line Colour', 'pcbSheetLineColour'], ['Sheet Area Colour', 'pcbSheetAreaColour'],
    ['Workspace Start Colour', 'pcbBackground'], ['Workspace End Colour', 'pcbWorkspaceEnd'], ['First Dimension Line', 'pcbDimLine1'], ['Second Dimension Line', 'pcbDimLine2'],
  ];

  /** A section's All On, All Off, Used On (the layers with objects on, the rest off). */
  const showAll = (ls: LayerId[], on: boolean | 'used') => {
    const h = new Set(hidden);
    for (const l of ls) { if (on === true || (on === 'used' && (used.has(l) || l === L.MULTI))) h.delete(l); else h.add(l); }
    setHidden(h);
  };
  const links = (onAll: () => void, offAll: () => void, usedOn: () => void) => (
    <div class="vc-links"><button class="linkish" onClick={onAll}>All On</button><button class="linkish" onClick={offAll}>All Off</button><button class="linkish" onClick={usedOn}>Used On</button></div>
  );
  const check = (k: ShowKey, text: string) => <label><input type="checkbox" checked={d[k]} onChange={() => set({ [k]: !d[k] } as Partial<Draft>)} />{text}</label>;
  /** Headings as AD17 has them, with the letter that picks the section. */
  const HEADINGS: Record<string, string> = { 'Signal Layers': 'Signal Layers (S)', 'Internal Planes': 'Internal Planes (P)', 'Mechanical Layers': 'Mechanical', 'Mask Layers': 'Mask Layers (A)', 'Other Layers': 'Other Layers (O)', 'Silkscreen Layers': 'Silkscreen Layers (K)' };
  /** The mechanical layer picked: its Layer Type; the Component Layer Pairs (each with its type), added and removed. */
  const mechExtras = () => {
    const one = [...picked].filter(isMech);
    const sel = one.length === 1 ? one[0]! : null;
    const all32 = Array.from({ length: 32 }, (_, i) => mechLayer(i + 1));
    const inPair = (l: LayerId) => pairs.some(([a, b]) => a === l || b === l);
    const add = () => {
      if (pairA === pairB) { notify('A pair needs two different mechanical layers', 'error'); return; }
      if (inPair(pairA) || inPair(pairB)) { notify(`${inPair(pairA) ? label(pairA) : label(pairB)} is in a pair already`, 'error'); return; }
      setPairs([...pairs, [pairA, pairB]]);
      const pk = PAIR_KINDS.find(([n]) => n === pairKind);
      const k = new Map(kinds);
      if (pk) { k.set(pairA, pk[1]); k.set(pairB, pk[2]); } else { k.delete(pairA); k.delete(pairB); }
      setKinds(k);
      // (both layers enabled, as the desktop software does)
      setEnabled(new Set([...enabled, pairA, pairB]));
    };
    return (
      <div class="vc-mechx">
        <label class="vc-line">Layer Type{sel !== null ? ` of ${label(sel)}` : ''}
          <select value={sel !== null ? kinds.get(sel) ?? '' : ''} disabled={sel === null} title={sel === null ? 'Pick a mechanical layer above to set its type' : undefined}
            onChange={(e) => { const v = (e.target as HTMLSelectElement).value, k = new Map(kinds); if (v) k.set(sel!, v); else k.delete(sel!); setKinds(k); }}>
            {MECH_KINDS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
          </select>
        </label>
        <div class="vc-head"><span>Component Layer Pairs</span></div>
        {!pairs.length && <p class="muted small">None: a part flipped to the other side keeps its mechanical layers.</p>}
        {pairs.map((p, i) => (
          <div key={i} class="vc-pair">
            <span>{label(p[0])} ↔ {label(p[1])}</span><span class="vc-kind">{pairName(p)}</span>
            <button class="linkish" title="Remove this pair" onClick={() => setPairs(pairs.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <div class="vc-pair-add">
          <select value={pairKind} aria-label="Pair type" onChange={(e) => setPairKind((e.target as HTMLSelectElement).value)}>
            {PAIR_KINDS.map(([n]) => <option key={n} value={n}>{n}</option>)}
            <option value="">Generic</option>
          </select>
          <select value={String(pairA)} aria-label="Top layer of the pair" onChange={(e) => setPairA(Number((e.target as HTMLSelectElement).value))}>{all32.map((l) => <option key={l} value={String(l)}>{label(l)}</option>)}</select>
          <span>↔</span>
          <select value={String(pairB)} aria-label="Bottom layer of the pair" onChange={(e) => setPairB(Number((e.target as HTMLSelectElement).value))}>{all32.map((l) => <option key={l} value={String(l)}>{label(l)}</option>)}</select>
          <button class="btn" onClick={add}>Add Pair</button>
        </div>
      </div>
    );
  };
  const layerGroup = ([title, ls]: [string, LayerId[]]) => {
    const mech = title === 'Mechanical Layers';
    return (
      <div key={title} class={`vc-group${mech ? ' mech' : ''}`} role="group" aria-label={title}>
        <div class={`vc-head${mech ? ' mech' : ''}`}><span>{HEADINGS[title] ?? title}</span><span>Colour</span><span>Show</span>{mech && <><span>Enable</span><span>Single Layer</span><span>Linked To Sheet</span></>}</div>
        {ls.map((l) => (
          <label key={l} class={`vc-row${mech ? ' mech' : ''}${used.has(l) ? '' : ' muted'}${picked.has(l) ? ' on' : ''}`} onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') pickRow(l, e.ctrlKey || e.metaKey); }}>
            {renaming === l
              ? <input class="vc-name" type="text" value={label(l)} autoFocus aria-label={`Name of ${layerName(l)}`}
                  onBlur={(e) => { setNames(new Map(names).set(l, (e.target as HTMLInputElement).value.trim() || label(l))); setRenaming(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (e.key === 'Enter') setNames(new Map(names).set(l, (e.target as HTMLInputElement).value.trim() || label(l))); setRenaming(null); } }} />
              : <span class="vc-name" title={mech && canEnable ? 'Double-click to rename' : undefined} onDblClick={() => { if (mech && canEnable) setRenaming(l); }}>{label(l)}{mech && kinds.get(l) ? <span class="vc-kind"> {kindName(l)}</span> : null}</span>}
            <input type="color" value={colour(l)} onInput={(e) => setColour(l, (e.target as HTMLInputElement).value)} aria-label={`${label(l)} colour`} />
            <input type="checkbox" checked={!hidden.has(l)} onChange={() => toggle(l)} aria-label={`Show ${label(l)}`} />
            {mech && <>
              <input type="checkbox" checked={enabled.has(l)} disabled={!canEnable} aria-label={`Enable ${label(l)}`}
                onChange={() => { const s = new Set(enabled); if (s.has(l)) s.delete(l); else s.add(l); setEnabled(s); }} />
              <input type="checkbox" checked={d.pcbMechSingleLayer.includes(l)} aria-label={`${label(l)} in single layer mode`} title="Shown beside the current layer in single layer mode"
                onChange={() => set({ pcbMechSingleLayer: d.pcbMechSingleLayer.includes(l) ? d.pcbMechSingleLayer.filter((x) => x !== l) : [...d.pcbMechSingleLayer, l] })} />
              <input type="checkbox" checked={linked.has(l)} disabled={!canEnable} aria-label={`${label(l)} linked to sheet`} title="Shown only with the sheet (Board Options › Display Sheet)"
                onChange={() => { const s2 = new Set(linked); if (s2.has(l)) s2.delete(l); else s2.add(l); setLinked(s2); }} />
            </>}
          </label>
        ))}
        {title === 'Signal Layers' && <label class="vc-only"><input type="checkbox" checked={inStack} onChange={() => setInStack(!inStack)} />Only show layers in layer stack</label>}
        {title === 'Internal Planes' && <label class="vc-only"><input type="checkbox" checked={planesInStack} onChange={() => setPlanesInStack(!planesInStack)} />Only show planes in layer stack</label>}
        {mech && <label class="vc-only"><input type="checkbox" checked={usedMech} onChange={() => setUsedMech(!usedMech)} />Only show enabled mechanical layers</label>}
        {mech && canEnable && mechExtras()}
        {links(() => showAll(ls, true), () => showAll(ls, false), () => showAll(ls, 'used'))}
      </div>
    );
  };

  return (
    <Dialog title="View Configurations" width={1060} height={680} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="outputs viewcfg"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button><button class="btn" onClick={apply}>Apply</button></>}>
      <div class="vc-shell">
        <aside class="vc-configs">
          <p class="vc-caption">Select PCB View Configuration</p>
          <div class="vc-list" role="listbox" aria-label="View configurations">
            <div class="vc-cat">2D</div>
            {CONFIGS.map(([n, t]) => {
              const on = kind === '2d' && name2d(d.pcbTransparency) === n;
              return <div key={n} role="option" aria-selected={on} class={`vc-cfg${on ? ' on' : ''}`} onClick={() => pick2d(t)}>{n}</div>;
            })}
            <div class="vc-cat">3D</div>
            {VIEW3D_PRESETS.map((p) => {
              const on = kind === '3d' && d3.config === p.config;
              return <div key={p.config} role="option" aria-selected={on} class={`vc-cfg${on ? ' on' : ''}`} onClick={() => pick3d(p)}>{p.config}</div>;
            })}
          </div>
          <button class="btn" onClick={saveAs}>Save As View Configuration...</button>
          <button class="btn" onClick={() => fileRef.current?.click()}>Load View Configuration...</button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void load(f); (e.target as HTMLInputElement).value = ''; }} />
          <p class="muted small">Current configuration: {kind === '3d' ? view3dName(d3) : name2d(d.pcbTransparency)}</p>
        </aside>
        <section class="vc-main">
          <nav class="out-tabs" role="tablist">
            {(kind === '3d' ? [['materials', 'Physical Materials']] as [ViewConfigTab, string][] : [['layers', 'Board Layers And Colours'], ['showhide', 'Show/Hide'], ['options', 'View Options'], ['transparency', 'Transparency']] as [ViewConfigTab, string][]).map(([t, l]) =>
              <button key={t} role="tab" aria-selected={tab === t} class={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{l}</button>)}
          </nav>
          {tab === 'layers' && (
            <div class="out-page vc-layers">
              {/* AD17's arrangement: Signal, Planes, Mechanical; Mask, Other, System Colors; Silkscreen */}
              <div class="vc-cols">
                {groups.slice(0, 3).map(layerGroup)}
                {layerGroup(groups[3]!)}
                {layerGroup(groups[4]!)}
                <div class="vc-group vc-system" role="group" aria-label="System Colours">
                    <div class="vc-head"><span>System Colours (Y)</span><span>Colour</span><span>Show</span></div>
                    {sys.map(([name, key, show]) => (
                      <label key={name} class="vc-row">
                        <span class="vc-name">{name}</span>
                        <input type="color" value={d[key]} onInput={(e) => set({ [key]: (e.target as HTMLInputElement).value } as Partial<Draft>)} aria-label={`${name} colour`} />
                        {show ? <input type="checkbox" checked={d[show]} onChange={() => set({ [show]: !d[show] } as Partial<Draft>)} aria-label={`Show ${name}`} /> : <span />}
                      </label>
                    ))}
                    {(() => { const shows = sys.flatMap(([, , k]) => (k ? [k] : [])), all = (on: boolean) => set(Object.fromEntries(shows.map((k) => [k, on])) as Partial<Draft>);
                      return links(() => all(true), () => all(false), () => all(true)); })()}
                </div>
                {layerGroup(groups[5]!)}
              </div>
              <div class="vc-buttons vc-links">
                <button class="linkish" onClick={() => setHidden(new Set())}>All Layers On</button>
                <button class="linkish" onClick={() => setHidden(new Set(all))}>All Layers Off</button>
                <button class="linkish" onClick={() => setHidden(new Set(all.filter((l) => !used.has(l) && !stack.includes(l) && l !== L.MULTI)))}>Used Layers On</button>
                <button class="linkish" disabled={!picked.size} onClick={() => { const h = new Set(hidden); for (const l of picked) h.delete(l); setHidden(h); }}>Selected Layers On</button>
                <button class="linkish" disabled={!picked.size} onClick={() => { const h = new Set(hidden); for (const l of picked) h.add(l); setHidden(h); }}>Selected Layers Off</button>
                <button class="linkish" disabled={!picked.size} onClick={() => setPicked(new Set())}>Clear All Layers</button>
              </div>
            </div>
          )}
          {tab === 'showhide' && (
            <div class="out-page">
              <div class="vc-kinds-grid">
                {KINDS.map(([k, name]) => {
                  const mode = d.pcbHiddenKinds.includes(k) ? 'hidden' : d.pcbDraftKinds.includes(k) ? 'draft' : 'final';
                  const put = (m: 'final' | 'draft' | 'hidden') => set({ pcbHiddenKinds: [...d.pcbHiddenKinds.filter((x) => x !== k), ...(m === 'hidden' ? [k] : [])], pcbDraftKinds: [...d.pcbDraftKinds.filter((x) => x !== k), ...(m === 'draft' ? [k] : [])] });
                  return (
                    <fieldset key={k} class="vc-kind-box">
                      <legend>{name}</legend>
                      <label><input type="radio" name={`vk-${k}`} checked={mode === 'final'} onChange={() => put('final')} aria-label={`${name} final`} />Final</label>
                      <label title="Drawn as outlines"><input type="radio" name={`vk-${k}`} checked={mode === 'draft'} onChange={() => put('draft')} aria-label={`${name} draft`} />Draft</label>
                      <label><input type="radio" name={`vk-${k}`} checked={mode === 'hidden'} onChange={() => put('hidden')} aria-label={`${name} hidden`} />Hidden</label>
                    </fieldset>
                  );
                })}
              </div>
              <div class="vc-buttons">
                <button class="btn" onClick={() => set({ pcbHiddenKinds: [], pcbDraftKinds: [] })}>All Final</button>
                <button class="btn" onClick={() => set({ pcbHiddenKinds: [], pcbDraftKinds: KINDS.map(([k]) => k) })}>All Draft</button>
                <button class="btn" onClick={() => set({ pcbHiddenKinds: KINDS.map(([k]) => k), pcbDraftKinds: [] })}>All Hidden</button>
              </div>
            </div>
          )}
          {tab === 'options' && (
            <div class="out-page vc-options">
              <fieldset><legend>Display Options</legend>
                {check('pcbConvertSpecial', 'Convert Special Strings')}
                {check('pcbConnectionLayerColours', 'Use Layer Colours For Connection Drawing')}
                <label class="vc-line">Single Layer Mode
                  <select value={single} onChange={(e) => setSingle((e.target as HTMLSelectElement).value as SingleLayerMode)}>
                    <option value="off">Off</option><option value="hide">Hide Other Layers</option><option value="grey">Grey Scale Other Layers</option>
                  </select>
                </label>
                <label><input type="checkbox" checked={d.pcbShowPours} onChange={() => set({ pcbShowPours: !d.pcbShowPours })} />Show Poured Polygons</label>
                <label><input type="checkbox" checked={d.pcbShowHiddenText} onChange={() => set({ pcbShowHiddenText: !d.pcbShowHiddenText })} />Show Hidden Designators and Comments</label>
                {check('pcbShowRefPoint', 'Show Component Reference Point')}
              </fieldset>
              <fieldset><legend>Show</legend>
                <label><input type="checkbox" checked={d.pcbShowPadNets} onChange={() => set({ pcbShowPadNets: !d.pcbShowPadNets })} />Show Pad Nets</label>
                <label><input type="checkbox" checked={d.pcbShowPadNumbers} onChange={() => set({ pcbShowPadNumbers: !d.pcbShowPadNumbers })} />Show Pad Numbers</label>
                <label><input type="checkbox" checked={d.pcbShowViaNets} onChange={() => set({ pcbShowViaNets: !d.pcbShowViaNets })} />Show Via Nets</label>
                {check('pcbShowTestPoints', 'Show Test Points')}
                <label><input type="checkbox" checked={d.pcbShowOriginMarker} onChange={() => set({ pcbShowOriginMarker: !d.pcbShowOriginMarker })} />Show Origin Marker</label>
                {check('pcbShowStatusInfo', 'Show Status Info')}
                <label class="vc-line">Net Names on Tracks
                  <select value={d.pcbTrackNetNames} onChange={(e) => set({ pcbTrackNetNames: (e.target as HTMLSelectElement).value as Draft['pcbTrackNetNames'] })}>
                    <option value="none">Do Not Display</option><option value="single">Single and Centred</option><option value="repeated">Repeated</option>
                  </select>
                </label>
                {check('pcbAllConnectionsSingle', 'Show All Connections in Single Layer Mode')}
              </fieldset>
              <fieldset><legend>Plane Drawing</legend>
                <label><input type="radio" name="vc-plane" checked={d.pcbPlaneDrawing === 'outlined'} onChange={() => set({ pcbPlaneDrawing: 'outlined' })} />Outlined Layer Coloured</label>
                <label><input type="radio" name="vc-plane" checked={d.pcbPlaneDrawing === 'solid'} onChange={() => set({ pcbPlaneDrawing: 'solid' })} />Solid Net Coloured</label>
              </fieldset>
              <fieldset><legend>Default Colour for New Nets</legend>
                <label class="vc-line">Colour<input type="color" value={d.pcbNewNetColour} aria-label="Default colour for new nets" onInput={(e) => set({ pcbNewNetColour: (e.target as HTMLInputElement).value })} /></label>
              </fieldset>
            </div>
          )}
          {tab === 'transparency' && (
            <div class="out-page vc-options">
              <fieldset><legend>Transparency</legend>
                {TRANSPARENCY_LAYERS.map(([k, n]) => slider(k, n))}
              </fieldset>
              <fieldset><legend>Default Transparency</legend>
                {TRANSPARENCY_KINDS.map(([k, n]) => slider(k, n))}
                <p class="small muted">On top of their layer's. Transparent 2D shows what lies under each layer.</p>
              </fieldset>
            </div>
          )}
          {tab === 'materials' && <Materials v={d3} set={set3} />}
        </section>
      </div>
    </Dialog>
  );
}

/** View Configurations › Physical Materials (a 3D configuration). */
function Materials({ v, set }: { v: View3D; set: (p: Partial<View3D>) => void }) {
  const real = v.colouring === 'realistic';
  type Row = { name: string; show?: keyof View3D; colour: keyof View3D; opacity?: keyof View3D };
  const rows: Row[] = [
    { name: 'Copper', colour: 'copper' },
    { name: 'Core', show: 'coreShow', colour: 'core', opacity: 'coreOpacity' },
    { name: 'Top Silkscreen', show: 'silkTopShow', colour: 'silkTop', opacity: 'silkTopOpacity' },
    { name: 'Bottom Silkscreen', show: 'silkBottomShow', colour: 'silkBottom', opacity: 'silkBottomOpacity' },
    { name: 'Top Solder Mask', show: 'maskTopShow', colour: 'maskTop', opacity: 'maskTopOpacity' },
    { name: 'Bottom Solder Mask', show: 'maskBottomShow', colour: 'maskBottom', opacity: 'maskBottomOpacity' },
  ];
  const bodies = (k: 'simpleBodies' | 'genericBodies', label: string) => (
    <label class="vc-line">{label}
      <select value={v[k]} onChange={(e) => set({ [k]: (e.target as HTMLSelectElement).value } as Partial<View3D>)}>
        <option value="no">No</option><option value="yes">Yes</option><option value="system">Use System Setting</option>
      </select>
    </label>
  );
  return (
    <div class="out-page vc-options vc-materials">
      <fieldset><legend>General</legend>
        <label class="vc-line">Workspace Colour<input type="color" value={v.workspace} onInput={(e) => set({ workspace: (e.target as HTMLInputElement).value })} /></label>
        <label class="vc-line">Gradient
          <span class="vc-range"><input type="range" min={-100} max={100} step={5} value={v.gradient} aria-label="Gradient" onInput={(e) => set({ gradient: Number((e.target as HTMLInputElement).value) })} /><span class="vc-pct">{v.gradient}</span></span>
        </label>
        <label class="vc-line">Board Thickness (Scale)
          <span class="vc-range"><input type="range" min={1} max={100} step={1} value={v.zScale} aria-label="Board thickness scale" onInput={(e) => set({ zScale: Number((e.target as HTMLInputElement).value) })} /><span class="vc-pct">{v.zScale}×</span></span>
        </label>
        <label><input type="checkbox" checked={v.showOrigin} onChange={() => set({ showOrigin: !v.showOrigin })} />Show Origin Marker</label>
        <label><input type="checkbox" checked={v.showCutouts} onChange={() => set({ showCutouts: !v.showCutouts })} />Show Board Cutouts</label>
        <label><input type="checkbox" checked={v.showRooms} onChange={() => set({ showRooms: !v.showRooms })} />Show Rooms</label>
        <label title="Board Options › Route Tool Path names the layer"><input type="checkbox" checked={v.showRoutePath} onChange={() => set({ showRoutePath: !v.showRoutePath })} />Show Route Tool Path</label>
        <div class="vc-line">Projection
          <span class="vc-radios">
            <label><input type="radio" name="vc-proj" checked={v.projection === 'perspective'} onChange={() => set({ projection: 'perspective' })} />Perspective</label>
            <label><input type="radio" name="vc-proj" checked={v.projection === 'orthographic'} onChange={() => set({ projection: 'orthographic' })} />Orthographic</label>
          </span>
        </div>
      </fieldset>
      <fieldset><legend>3D Bodies</legend>
        {bodies('simpleBodies', 'Show Simple 3D Bodies')}
        {bodies('genericBodies', 'Show Generic Models')}
        <label><input type="checkbox" checked={v.snapMarkers} onChange={() => set({ snapMarkers: !v.snapMarkers })} />Show Snap Point Markers</label>
        <label><input type="checkbox" checked={v.axes} onChange={() => set({ axes: !v.axes })} />Show Axes</label>
        <label class="vc-line">Components with both Simple and Generic Bodies
          <select value={v.both} onChange={(e) => set({ both: (e.target as HTMLSelectElement).value as View3D['both'] })}>
            <option value="simple">Prefer simple bodies in components</option><option value="generic">Prefer Generic in components</option><option value="both">Show both in components</option>
          </select>
        </label>
        <p class="small muted">Use System Setting follows Show/Hide › 3D Bodies.</p>
      </fieldset>
      <fieldset class="vc-colours"><legend>Colours and Visibility</legend>
        <label><input type="radio" name="vc-colouring" checked={real} onChange={() => set({ colouring: 'realistic' })} />Realistic Colours</label>
        <label><input type="radio" name="vc-colouring" checked={!real} onChange={() => set({ colouring: 'layers' })} />Colour By Layer Using Current System Colours</label>
        <div class="vc-mat" role="table" aria-label="Physical materials">
          <div class="vc-mat-head" role="row"><span /><span>Layer</span><span>Colour</span><span>Opacity</span></div>
          {rows.map((r) => (
            <div key={r.name} class="vc-mat-row" role="row">
              {r.show ? <input type="checkbox" checked={v[r.show] as boolean} onChange={() => set({ [r.show!]: !v[r.show!] } as Partial<View3D>)} aria-label={`Show ${r.name}`} />
                : <input type="checkbox" checked disabled aria-label={`${r.name} always shown`} />}
              <span>{r.name}</span>
              <input type="color" value={v[r.colour] as string} disabled={!real} aria-label={`${r.name} colour`} onInput={(e) => set({ [r.colour]: (e.target as HTMLInputElement).value } as Partial<View3D>)} />
              {r.opacity ? <span class="vc-range"><input type="range" min={0} max={100} step={1} value={v[r.opacity] as number} aria-label={`${r.name} opacity`}
                  onInput={(e) => set({ [r.opacity!]: Number((e.target as HTMLInputElement).value) } as Partial<View3D>)} /><span class="vc-pct">{v[r.opacity] as number}%</span></span>
                : <span />}
            </div>
          ))}
        </div>
        <div class="vc-swatches" role="group" aria-label="Solder mask colours">
          <span class="small">Solder mask</span>
          {MASK_COLOURS.map(([n, c]) => <button key={n} class="vc-swatch" disabled={!real} title={n} aria-label={`${n} solder mask`} style={{ background: c }} onClick={() => set({ maskTop: c, maskBottom: c })} />)}
        </div>
        <div class="vc-swatches" role="group" aria-label="Surface finishes">
          <span class="small">Surface finish</span>
          {FINISHES.map(([n, c]) => <button key={n} class="vc-swatch" disabled={!real} title={n} aria-label={n} style={{ background: c }} onClick={() => set({ copper: c })} />)}
        </div>
      </fieldset>
    </div>
  );
}
