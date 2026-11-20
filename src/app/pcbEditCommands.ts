/**
 * Board and footprint editing of 26.022: Place › Keepout (track, arcs, circle, fill, region),
 * Convert Selected Keepouts ↔ Primitives, Edit › Break Track, Slice Tracks, Paste Special,
 * Paste Array, Flip Selection, Copy As Text, Lasso Select / Deselect, Create Region from
 * Selected Primitives, Create Pad from Selected Primitives (a polygon pad), Move All Components
 * Origin To Grid, component spacing, Reports › Measure Primitives, Toggle Visible Grid Kind.
 */
import type { Command, Scope } from '../core/commands';
import { active, notify, replaceMessages, units } from './state';
import { showDialog } from './dialogs';
import { PasteArrayDialog, PasteSpecialDialog } from './dialogs/PcbPaste';
import { AlignDialog } from './dialogs/Align';
import { ViewConfigDialog } from './dialogs/ViewConfig';
import { compressModel, modelChecksum, modelFootprint } from '../model/genericBody';
import { loadModel } from '../render/gl3d/stepBodies';
import { Body3DDialog, BodyManagerDialog, LibraryBodyManagerDialog } from './dialogs/Body3D';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { defaultBody, type BodySpec } from '../model/bodies';
import { changedBagDefaults } from '../model/bagDefaults';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PlaceTrackTool } from '../editors/pcb/PlaceTrackTool';
import { placeArcAnyTool, placeArcCentreTool, placeArcEdgeTool, placeBodyTool, placeGenericBodyTool, placeCircleTool, placeCutoutTool, placeFillTool, placeRegionTool, placeStringTool } from '../editors/pcb/PcbPlaceTools';
import { commitMove } from '../editors/pcb/PcbMoveTool';
import { DragTrackEndTool, TwoPointTool } from '../editors/pcb/PcbEditTools';
import { LassoTool } from '../editors/LassoTool';
import { PickTool } from '../editors/Editor';
import { clipboard } from '../editors/clipboard';
import { addPrimRecords, removePrims, replaceRecords } from '../model/pcbEdit';
import { PAD_SHAPE_KEY, padShapeGroup, planPad, shapeRegions } from '../model/padShapes';
import { encodePad, encodeRegion } from '../formats/altium/pcbdoc';
import { pasteMask, solderMask } from '../formats/gerber/gerber';
import { layerName } from '../model/layers';
import { KEEPOUT_KINDS, breakTrack, measurePrims, pointOnTrack, regionFromLoop, sliceTracks, withKeepout } from '../model/pcbTrackEdit';
import { placement } from '../formats/altium/pcbTransform';
import { formatCoord, parseLength } from '../core/units';
import { L } from '../model/layers';
import { setBoardProps } from '../model/pcbBoard';
import { settings, updateSettings } from '../core/settings';
import type { PcbArc, PcbPad, PcbTrack } from '../model/pcb';
import type { AlignKind } from '../editors/align';

const BOTH: Scope[] = ['pcb', 'pcblib'];
const ed = () => { const e = active.value?.editor; return e instanceof PcbEditor ? e : null; };
const has = () => !!ed();
const run = (fn: (e: PcbEditor) => void) => () => { const e = ed(); if (e) fn(e); };
const selectedPrims = (e: PcbEditor) => [...e.selection].map((k) => e.primByKey(k)).filter((p): p is NonNullable<typeof p> => !!p);

/** Selected components spread out (+1) or drawn together (−1) by a grid step along an axis, the first one staying. */
function spacing(e: PcbEditor, axis: 'x' | 'y', dir: 1 | -1): void {
  const set = e.moveSet();
  const comps = [...set.components].sort((a, b) => e.doc.components[a]!.at[axis] - e.doc.components[b]!.at[axis]);
  if (comps.length < 2) { notify('Select two or more components', 'error'); return; }
  const g = e.gridSize();
  e.undo.transact(`${dir > 0 ? 'Increase' : 'Decrease'} ${axis === 'x' ? 'horizontal' : 'vertical'} spacing`, () => {
    comps.forEach((c, k) => { if (k) commitMove(e, { components: [c], polygons: [], prims: [] }, placement({ x: 0, y: 0 }, 0, axis === 'x' ? { x: dir * k * g, y: 0 } : { x: 0, y: dir * k * g }), 0, 'move'); });
  });
}

/** Place › 3D Body: the settings, then the outline; then the settings for the next one (Cancel ends), as Altium does. */
let lastBody: BodySpec | null = null;
function placeBody(e: PcbEditor): void {
  const lib = e instanceof PcbLibEditor ? e.entry : null;
  const h = lib ? parseLength(lib.height) : undefined;
  // The first of a session starts from Preferences › Defaults › Component Body (a footprint's own height before the default's)
  const d = changedBagDefaults('Component Body'), len = (v: string | undefined) => { const c = v === undefined ? undefined : parseLength(v); return c !== undefined && c >= 0 ? Math.round(c) : undefined; };
  const own: Partial<BodySpec> = { ...(len(d.STANDOFF) !== undefined ? { standoff: len(d.STANDOFF)! } : {}), ...(d.SIDE ? { bottom: d.SIDE === 'Bottom' } : {}), ...(d.OPACITY !== undefined ? { opacity: Math.min(1, Math.max(0, Number(d.OPACITY) / 100)) } : {}) };
  const start = lastBody ?? { ...defaultBody(h && h > 0 ? Math.round(h) : len(d.OVERALL) || undefined), ...own, layer: e.currentLayer >= L.MECH1 && e.currentLayer <= L.MECH16 ? e.currentLayer : L.MECH1 };
  const next = () => { e.setTool(null); placeBody(e); };
  showDialog(Body3DDialog, { ed: e, spec: start, onOk: (spec: BodySpec) => {
    lastBody = spec;
    if (spec.type === 'generic') void placeGeneric(e, spec, next);
    else e.setTool(placeBodyTool(e, spec, next));
  } });
}

/** A generic body: the model read (for its outline and heights), compressed if embedded, then placed with a click. */
async function placeGeneric(e: PcbEditor, spec: BodySpec, next: () => void): Promise<void> {
  const m = spec.model!;
  notify(`Reading ${m.name}...`);
  const model = await loadModel(`place:${m.name}:${m.bytes.length}:${modelChecksum(m.bytes)}`, m.bytes);
  if (!model) { notify(`${m.name} couldn't be read as a STEP model`, 'error'); return; }
  const fp = modelFootprint(model, spec.rot ?? [0, 0, 0]);
  const compressed = m.link ? undefined : await compressModel(m.bytes);
  const lib = e instanceof PcbLibEditor ? e.lib.lib : null;
  const store = lib ? { root: lib.cfb.root, prefix: 'Library/' } : { root: e.doc.cfb.root, prefix: '' };
  e.setTool(placeGenericBodyTool(e, spec, fp, store, compressed, next));
  notify(`${m.name}: ${model.meshes.length} part${model.meshes.length === 1 ? '' : 's'}; click to place it`);
}

/**
 * The 3D model editor's Place on Footprint: its model as a generic 3D body of the footprint (or
 * board), embedded, placed with a click on the current mechanical layer.
 */
export function placeModelOnFootprint(e: PcbEditor, model: { name: string; bytes: Uint8Array }): void {
  const layer = e.currentLayer >= L.MECH1 && e.currentLayer <= L.MECH16 ? e.currentLayer : L.MECH1;
  const spec: BodySpec = { ...defaultBody(), type: 'generic', layer, identifier: model.name.replace(/\.(step|stp)$/i, ''), model: { ...model, link: false }, rot: [0, 0, 0] };
  void placeGeneric(e, spec, () => e.setTool(null));
}

/** The component a right-click (or the selection) is on. */
function contextComponent(e: PcbEditor): number | null {
  const k = e.contextKey ?? [...e.selection][0];
  const p = k ? e.primByKey(k) : undefined;
  return p && 'component' in p && p.component !== 0xffff && e.doc.components[p.component] ? p.component : null;
}

export function pcbEditCommands(): Command[] {
  const keepout = (id: string, label: string, make: (e: PcbEditor) => import('../core/tools').Tool): Command =>
    ({ id, label, scopes: BOTH, enabled: has, run: run((e) => e.setTool(make(e))) });
  const convert = (to: boolean) => run((e) => {
    const edits = selectedPrims(e).filter((p) => KEEPOUT_KINDS.has(p.kind) && 'keepout' in p && p.keepout !== to)
      .map((p) => { const rec = e.doc.streams.get(p.src.storage)!.records[p.src.index]!; return { storage: p.src.storage, index: p.src.index, after: withKeepout(rec, to) }; });
    if (!edits.length) { notify(to ? 'Select tracks, arcs, fills or regions to make keepouts' : 'Select keepouts to make primitives', 'error'); return; }
    e.undo.transact(to ? 'Convert to keepouts' : 'Convert keepouts to primitives', (tx) => tx.add(replaceRecords(e.doc, edits)));
    e.invalidate();
    notify(`${edits.length} object${edits.length === 1 ? '' : 's'} ${to ? 'now keepouts' : 'no longer keepouts'}`);
  });
  return [
    // Place › Keepout
    keepout('ad:ManRoute:PlaceKeepoutTrack', 'Track', (e) => new PlaceTrackTool(e, true)),
    keepout('ad:PCB:PlaceKeepoutArcCenter', 'Arc (Centre)', (e) => placeArcCentreTool(e, true)),
    keepout('ad:PCB:PlaceKeepoutArcEdge', 'Arc (Edge)', (e) => placeArcEdgeTool(e, true)),
    keepout('ad:PCB:PlaceKeepoutArcAnyAngle', 'Arc (Any Angle)', (e) => placeArcAnyTool(e, true)),
    keepout('ad:PCB:PlaceKeepoutFullCircle', 'Full Circle', (e) => placeCircleTool(e, true)),
    keepout('ad:PCB:PlaceKeepoutFill', 'Fill', (e) => placeFillTool(e, true)),
    keepout('ad:PCB:PlaceKeepoutSolidRegion', 'Solid Region', (e) => placeRegionTool(e, true)),
    { id: 'ad:PCB:PlaceCutoutRegion', label: 'Polygon Pour Cutout', scopes: BOTH, enabled: has, run: run((e) => e.setTool(placeCutoutTool(e))) },
    { id: 'ad:PCB:ConvertPrimitiveToKeepout', label: 'Convert Selected Primitives to Keepouts', scopes: BOTH, enabled: () => !!ed()?.selection.size, run: convert(true) },
    { id: 'ad:PCB:ConvertKeepoutToPrimitive', label: 'Convert Selected Keepouts to Primitives', scopes: BOTH, enabled: () => !!ed()?.selection.size, run: convert(false) },
    // Edit › Break Track: click on tracks, each splits where clicked
    { id: 'ad:PCB:BreakTrack', label: 'Break Track', scopes: BOTH, enabled: has, run: run((e) => e.setTool(new PickTool(e, 'Break Track: click on a track where it should break (right-click ends)', (p) => {
      const tol = 4 / (e.viewport?.cam.scale ?? 1);
      for (const t of e.doc.prims) {
        if (t.kind !== 'track') continue;
        const at = pointOnTrack(t, e.snap(p.raw), tol) ?? pointOnTrack(t, p.raw, tol);
        const rec = at && e.doc.streams.get(t.src.storage)?.records[t.src.index];
        const halves = rec && at ? breakTrack(rec, t, at) : null;
        if (!halves) continue;
        e.undo.transact('Break track', (tx) => { tx.add(replaceRecords(e.doc, [{ storage: t.src.storage, index: t.src.index, after: halves[0] }])); tx.add(addPrimRecords(e.doc, [{ storage: t.src.storage, rec: halves[1] }])); });
        e.invalidate();
        return false;
      }
      return false;
    }, true))) },
    { id: 'ad:PCB:MoveDragTrackEnd', label: 'Drag Track End', scopes: BOTH, enabled: has, run: run((e) => e.setTool(new DragTrackEndTool(e))) },
    { id: 'ad:PCB:SliceTracks', label: 'Slice Tracks', scopes: BOTH, enabled: has, run: run((e) => e.setTool(new TwoPointTool(e, 'slice-tracks',
      ['Slice Tracks: click the start of the cutting line', 'Slice Tracks: click the end of the cutting line'], (a, b) => {
        const { edits, added } = sliceTracks(e.doc, a, b);
        if (!edits.length) { notify('The line crosses no tracks'); return; }
        e.undo.transact(`Slice ${edits.length} track${edits.length === 1 ? '' : 's'}`, (tx) => { tx.add(replaceRecords(e.doc, edits)); tx.add(addPrimRecords(e.doc, added.map((rec) => ({ storage: 'Tracks6', rec })))); });
        e.invalidate();
      }))) },
    // Edit › Paste Special / Paste Array
    { id: 'ad:PCB:PasteSpecial', label: 'Paste Special...', scopes: BOTH, enabled: () => has() && clipboard?.kind === 'pcb', run: run((e) => { if (clipboard?.kind === 'pcb') showDialog(PasteSpecialDialog, { ed: e, clip: clipboard }); }) },
    { id: 'ad:PCB:PasteArray', label: 'Paste Array...', scopes: BOTH, enabled: () => has() && clipboard?.kind === 'pcb', run: run((e) => { if (clipboard?.kind === 'pcb') showDialog(PasteArrayDialog, { ed: e, clip: clipboard }); }) },
    // Edit › Move › Flip Selection: to the other side of the board, about its middle
    { id: 'ad:PCB:FlipSelectedObjects', label: 'Flip Selection', scopes: ['pcb'], enabled: () => !!ed()?.selection.size, run: run((e) => {
      const set = e.moveSet();
      if (!set.components.length && !set.prims.length && !set.polygons.length) return;
      const b = e.selectionBounds();
      const c = e.snap({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
      commitMove(e, set, placement(c, 0, { x: 0, y: 0 }, true), 0, 'move', 'Flip selection', { mirror: true, flip: true });
    }) },
    { id: 'ad:PCB:CopyAsText', label: 'Copy As Text', scopes: BOTH, enabled: () => !!ed()?.selection.size, run: run((e) => {
      const lines = selectedPrims(e).map((p) => (p.kind === 'text' ? p.text : p.kind === 'pad' ? p.name : '')).filter(Boolean);
      if (!lines.length) { notify('Select strings (or pads) to copy their text', 'error'); return; }
      void navigator.clipboard?.writeText(lines.join('\r\n')).then(() => notify(`Copied ${lines.length} line${lines.length === 1 ? '' : 's'} of text`), () => notify('The browser refused the clipboard', 'error'));
    }) },
    { id: 'ad:PCB:SelectLasso', label: 'Lasso Select', scopes: BOTH, enabled: has, run: run((e) => e.setTool(new LassoTool(e))) },
    { id: 'ad:PCB:DeSelectLasso', label: 'Lasso Deselect', scopes: BOTH, enabled: has, run: run((e) => e.setTool(new LassoTool(e, true))) },
    { id: 'ad:PCB:ConvertSelectedToRegion', label: 'Create Region from Selected Primitives', scopes: BOTH, enabled: () => !!ed()?.selection.size, run: run((e) => {
      const loop = selectedPrims(e).filter((p): p is PcbTrack | PcbArc => p.kind === 'track' || p.kind === 'arc');
      const r = regionFromLoop(loop);
      if (typeof r === 'string') { notify(r, 'error'); return; }
      e.undo.transact('Create region', (tx) => tx.add(addPrimRecords(e.doc, [{ storage: 'Regions6', rec: r }])));
      e.invalidate();
    }) },
    // Konium's: any shape made a pad (notched pads, rings): a pad and its copper, mask and paste regions as one (model/padShapes)
    { id: 'pcb.padFromSelection', label: 'Create Pad from Selected Primitives', scopes: BOTH, enabled: () => !!ed()?.selection.size, run: run((e) => {
      const doc = e.doc;
      const plan = planPad(selectedPrims(e), doc.prims.filter((p): p is PcbPad => p.kind === 'pad'), e.currentLayer);
      if (typeof plan === 'string') { notify(plan, 'error'); return; }
      let made: PcbPad | null = null;
      e.undo.transact('Create pad from selected primitives', (tx) => {
        tx.add(removePrims(doc, plan.sources));
        let pad = plan.anchor;
        if (plan.fresh) {
          const f = plan.fresh;
          tx.add(addPrimRecords(doc, [{ storage: 'Pads6', rec: encodePad({ name: f.name, layer: f.layer, at: f.at, w: f.size, h: f.size, shape: 'round', net: f.net, component: f.component }) }]));
          const n = (doc.streams.get('Pads6')?.records.length ?? 1) - 1;
          pad = doc.prims.find((p): p is PcbPad => p.kind === 'pad' && p.src.storage === 'Pads6' && p.src.index === n) ?? null;
        }
        if (!pad) throw new Error('The pad couldn’t be made');
        const anchor = pad;
        const regions = shapeRegions(plan, (top) => solderMask(doc, anchor, top), pasteMask(doc, anchor));
        tx.add(addPrimRecords(doc, regions.map((r) => ({ storage: 'Regions6', rec: encodeRegion({ layer: r.layer, outline: r.shape.outline, holes: r.shape.holes, net: anchor.net, component: anchor.component, extra: { [PAD_SHAPE_KEY]: anchor.name } }) }))));
        made = doc.prims.find((p): p is PcbPad => p.kind === 'pad' && p.src.storage === anchor.src.storage && p.src.index === anchor.src.index) ?? null;
      });
      const pad = made as PcbPad | null;
      if (!pad) return;
      e.selection = new Set(padShapeGroup(doc.prims, pad));
      e.invalidate(); e.invalidateOverlay();
      const where = plan.copper.length > 1 ? 'the Top and Bottom Layers' : `the ${layerName(plan.copper[0]!)}`;
      notify(`Pad ${pad.name || '(no designator)'}: the shape on ${where}, with its solder mask${plan.copper.length === 1 ? ' and paste' : ''} openings`);
    }) },
    { id: 'ad:PCB:MoveAllComponentsOriginToGrid', label: 'Move All Components Origin To Grid', scopes: ['pcb'], enabled: () => !!ed()?.doc.components.length, run: run((e) => {
      const keep = e.selection;
      e.selection = new Set(e.doc.components.flatMap((_, i) => e.componentKeys(i)));
      e.alignToGrid();
      e.selection = keep;
      e.invalidate();
    }) },
    // Component spacing and the Align dialog
    ...([['Expand', 1], ['Contract', -1]] as const).flatMap(([w, dir]) => (['Horizontal', 'Vertical'] as const).flatMap((axis) => ['ad:PCB:', 'ad:PCB:Popup'].map((pre): Command => ({
      id: `${pre}AlignComponents${w}${axis}`, label: `${dir > 0 ? 'Increase' : 'Decrease'} ${axis} Spacing`, scopes: BOTH, enabled: () => (ed()?.moveSet().components.length ?? 0) > 1,
      run: run((e) => spacing(e, axis === 'Horizontal' ? 'x' : 'y', dir)),
    })))),
    // Align Left / Right / Top / Bottom (maintain spacing): the selected components' edges lined up, each
    // keeping its place the other way (so their spacing along the edge stays)
    ...([['Left', 'left'], ['Right', 'right'], ['Top', 'top'], ['Bottom', 'bottom']] as const).flatMap(([w, kind]) => ['ad:PCB:', 'ad:PCB:Popup'].map((pre): Command => ({
      id: `${pre}AlignComponents${w}SideBySide`, label: `Align ${w} (maintain spacing)`, scopes: BOTH, enabled: () => (ed()?.moveSet().components.length ?? 0) > 1,
      run: run((e) => {
        const keep = e.selection;
        e.selection = new Set(e.moveSet().components.flatMap((c) => e.componentKeys(c)));
        try { e.align(kind); } finally { e.selection = keep; e.invalidate(); }
      }),
    }))),
    ...['ad:PCB:AlignComponentsDialog', 'ad:PCB:PopupAlignComponentsDialog'].map((id): Command => ({ id, label: 'Align...', scopes: BOTH, enabled: () => !!ed()?.selection.size, run: run((e) => {
      showDialog(AlignDialog, { onOk: (h: AlignKind | null, v: AlignKind | null, grid: boolean) => e.undo.transact('Align objects', () => { if (h) e.align(h); if (v) e.align(v); if (grid) e.alignToGrid(); e.invalidate(); }) });
    }) })),
    // Reports › Measure Primitives: two objects, the gap between their edges
    { id: 'ad:PCB:MeasurePrimitives', label: 'Measure Primitives', scopes: BOTH, enabled: has, run: run((e) => e.setTool(new TwoPointTool(e, 'measure-prims',
      ['Measure Primitives: click the first object', 'Measure Primitives: click the second object'], (_a, _b, pa, pb) => {
        if (!pa || !pb) return;
        const d = measurePrims(e.doc, pa, pb);
        const what = (p: typeof pa) => `${p.kind[0]!.toUpperCase()}${p.kind.slice(1)}${p.kind === 'pad' ? ` ${p.name}` : ''}`;
        const u = units.value;
        const msg = d === null ? `Can't measure ${what(pa)} to ${what(pb)}` : `Distance between ${what(pa)} and ${what(pb)}: ${formatCoord(Math.round(d), u)}${d === 0 ? ' (touching)' : ''}`;
        notify(msg);
        replaceMessages('Measure Primitives', [{ doc: e.title(), level: 'info', message: msg }]);
      }, true))) },
    // Design › Mechanical Layers: the mechanical layers of View Configurations (enable, show, rename)
    { id: 'ad:PCB:MechanicalLayers', label: 'Mechanical Layers...', scopes: BOTH, enabled: has, run: run((e) => showDialog(ViewConfigDialog, { ed: e, tab: 'layers' as const })) },
    { id: 'ad:PCB:PopupOptionsTransparency', label: 'Board Layers Transparency...', scopes: BOTH, enabled: has, run: run((e) => showDialog(ViewConfigDialog, { ed: e, tab: 'transparency' as const })) },
    // 3D bodies
    { id: 'ad:PCB:PlaceComponentBody', label: '3D Body', scopes: BOTH, enabled: has, run: run(placeBody) },
    { id: 'ad:PCB:ManageSingleComponentBodies', label: 'Manage 3D Bodies', scopes: BOTH, enabled: () => { const e = ed(); return !!e && (e instanceof PcbLibEditor || contextComponent(e) !== null); }, run: run((e) => {
      if (e instanceof PcbLibEditor) { showDialog(BodyManagerDialog, { ed: e }); return; }
      const c = contextComponent(e);
      if (c === null) { notify('Right-click a component (or select one) first', 'error'); return; }
      showDialog(BodyManagerDialog, { ed: e, component: c });
    }) },
    { id: 'ad:PCB:RunComponentBodyManager', label: 'Component Body Manager...', scopes: BOTH, enabled: has, run: run((e) => showDialog(LibraryBodyManagerDialog, { ed: e })) },
    { id: 'ad:PCB:ToggleElectricalGrid', label: 'Toggle Object Hotspot Snapping', scopes: BOTH, enabled: has, checked: () => !!ed()?.hotspotSnap,
      // On a board it is Board Options › Snap To Object Hotspots, saved with the board (as Altium does)
      run: run((e) => {
        const on = !e.hotspotSnap;
        if (e.doc.board.bag) { e.undo.transact(on ? 'Object hotspot snapping on' : 'Object hotspot snapping off', (tx) => tx.add(setBoardProps(e.doc, { ELECTRICALGRIDENABLED: on ? 'TRUE' : 'FALSE' }))); e.readSnapOptions(); }
        else e.hotspotSnap = on;
        notify(`Object hotspot snapping ${e.hotspotSnap ? 'on' : 'off'}`);
      }) },
    // Edit › Paste Text: the system clipboard's text as a string on the current layer, following the cursor
    { id: 'ad:PCB:PasteText', label: 'Paste Text', scopes: BOTH, enabled: has, run: run((e) => {
      const read = navigator.clipboard?.readText?.bind(navigator.clipboard);
      if (!read) { notify('The browser gives no access to the clipboard here', 'error'); return; }
      void read().then((t) => {
        const text = t.replace(/\r\n?/g, '\n').split('\n').find((l) => l.trim())?.trim();
        if (!text) { notify('The clipboard holds no text'); return; }
        e.stringTemplate.text = text;
        e.setTool(placeStringTool(e));
      }, () => notify('The browser refused the clipboard', 'error'));
    }) },
    { id: 'ad:PCB:ToggleVisibleGridKind', label: 'Toggle Visible Grid Kind', scopes: BOTH, enabled: has, run: run((e) => { updateSettings({ pcbGridStyle: settings.pcbGridStyle === 'dots' ? 'lines' : 'dots' }); e.invalidate(); notify(`Visible grid: ${settings.pcbGridStyle}`); }) },
  ];
}

