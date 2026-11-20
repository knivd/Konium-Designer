/**
 * The CAM editor's View menu and keys (CAMtastic): Around Point, Dynamic pan and zoom, Zoom to a
 * D-code and to the film box; Views (Difference, Extents Box, Fill, Highlight Dcode, Negative, Origin,
 * Translucent); the CAM and NC editor modes; the Film Box; Preview Drill/Rout and Redraw a Rout Path
 * (the order drills and routs are made in, animated); Sort/Optimise; Display Symbols; the snap grids
 * popup and Snap Change; Next / Previous layer; layer sets on and off; Cancel Action and Execute.
 */
import type { Command, Scope } from '../core/commands';
import { commands } from '../core/commands';
import type { Tool, ToolOverlay } from '../core/tools';
import type { Vec2 } from '../core/geom';
import { mil, mm } from '../core/units';
import { routePoints, type CamEditor } from '../editors/cam/CamEditor';
import { DynamicViewTool, PickTool, PointsTool } from '../editors/cam/camTools';
import { camExtent } from '../formats/cam/camDoc';
import { liveObjects } from '../formats/cam/camModel';
import type { DrillLayer } from '../formats/gerber/gerberRead';
import { activeCam, ask, camChanged, camEdited, fmtLen } from './camCommon';
import { notify, tick } from './state';

const CAM: Scope[] = ['cam'];
const id = (n: string) => `ad:CAMTASTIC:${n}`;

/** The hits of a drill layer in the order they'd be drilled, nearest-neighbour by tool (Sort/Optimise › Automatic). */
export function sortedHits(d: DrillLayer, erased: Set<number>): number[] {
  const out: number[] = [];
  for (const t of [...d.tools.keys()].sort((a, b) => a - b)) {
    const left = d.hits.map((h, i) => [h, i] as const).filter(([h, i]) => h.tool === t && !erased.has(i));
    let at: Vec2 = { x: 0, y: 0 };
    while (left.length) {
      let best = 0, bd = Infinity;
      for (let k = 0; k < left.length; k++) { const h = left[k]![0]; const dd = (h.at.x - at.x) ** 2 + (h.at.y - at.y) ** 2; if (dd < bd) { bd = dd; best = k; } }
      const [h, i] = left.splice(best, 1)[0]!;
      out.push(i);
      at = h.slot ?? h.at;
    }
  }
  return out;
}

/** The path a drill or rout run takes, animated: hits appear in order, the moves between them drawn [est: CAMtastic's preview]. */
class AnimateTool implements Tool {
  readonly id = 'cam-animate';
  private n = 0;
  private timer = 0;
  constructor(private ed: CamEditor, private pts: { at: Vec2; r: number; route?: Vec2[] }[], private title: string) {
    const per = Math.max(1, Math.ceil(pts.length / 150));
    const step = () => { this.n = Math.min(this.pts.length, this.n + per); this.ed.viewport?.requestRender(); this.ed.invalidateOverlay(); if (this.n < this.pts.length) this.timer = window.setTimeout(step, 30); };
    this.timer = window.setTimeout(step, 30);
  }
  hint(): string { return `${this.title}: ${this.n} of ${this.pts.length} (Esc or right-click to stop)`; }
  overlay(): ToolOverlay {
    const segs: NonNullable<ToolOverlay['segments']> = [];
    const shown = this.pts.slice(0, this.n);
    shown.forEach((p, k) => {
      if (k) segs.push({ a: shown[k - 1]!.route?.at(-1) ?? shown[k - 1]!.at, b: p.at, width: 0, color: 0x808080 });
      if (p.route) for (let i = 1; i < p.route.length; i++) segs.push({ a: p.route[i - 1]!, b: p.route[i]!, width: 2 * p.r, color: 0xffff00 });
    });
    return { segments: segs, circles: shown.filter((p) => !p.route).map((p) => ({ c: p.at, r: p.r, color: 0xffff00 })) };
  }
  deactivate(): void { clearTimeout(this.timer); }
  cancel(): boolean { return false; }
}

/** Layer sets (Tables › Layers Sets) turned on or off. */
function layerSet(ed: CamEditor, on: boolean): void {
  const sets = ed.doc.layerSets ?? [];
  if (!sets.length) { notify('No layer sets: Tables › Layers Sets makes them'); return; }
  ask(on ? 'View Set Lay On' : 'View Set Lay Off', [
    { key: 'set', label: 'Layer set', kind: 'select', value: sets[0]!.name, options: sets.map((s) => s.name) },
    { key: 'only', label: on ? 'Turn every other layer off' : 'Turn every other layer on', kind: 'bool', value: on },
  ], (v) => {
    const s = sets.find((x) => x.name === v.set)!;
    const inSet = new Set(s.layers);
    for (const l of ed.doc.layers) { if (inSet.has(l.name)) l.visible = on; else if (v.only) l.visible = !on; }
    camChanged(ed);
  });
}

const SNAP_GRIDS: [string, string, number][] = [
  ['PopupSnapGrid1Mil', '1 Mil', mil(1)], ['PopupSnapGrid5Mil', '5 Mil', mil(5)], ['PopupSnapGrid10Mil', '10 Mil', mil(10)], ['PopupSnapGrid20Mil', '20 Mil', mil(20)],
  ['PopupSnapGrid25Mil', '25 Mil', mil(25)], ['PopupSnapGrid50Mil', '50 Mil', mil(50)], ['PopupSnapGrid100Mil', '100 Mil', mil(100)], ['PopupSnapGrid200Mil', '200 Mil', mil(200)],
  ['PopupSnapGrid500Mil', '500 Mil', mil(500)], ['PopupSnapGrid025mm', '0.025 mm', mm(0.025)], ['PopupSnapGrid100mm', '0.100 mm', mm(0.1)], ['PopupSnapGrid250mm', '0.250 mm', mm(0.25)],
  ['PopupSnapGrid500mm', '0.500 mm', mm(0.5)], ['PopupSnapGrid1000mm', '1.000 mm', mm(1)], ['PopupSnapGrid2500mm', '2.500 mm', mm(2.5)], ['PopupSnapGrid5000mm', '5.000 mm', mm(5)],
  ['PopupSnapGrid7500mm', '7.500 mm', mm(7.5)],
];

export function camViewCommands(): Command[] {
  const on = () => !!activeCam();
  const withCam = (f: (ed: CamEditor) => void) => () => { const e = activeCam(); if (e) f(e); };
  const cmd = (name: string, label: string, run: (ed: CamEditor) => void, checked?: (ed: CamEditor) => boolean): Command =>
    ({ id: id(name), label, scopes: CAM, enabled: on, run: withCam(run), ...(checked ? { checked: () => { const e = activeCam(); return !!e && checked(e); } } : {}) });
  const toggle = (name: string, label: string, key: 'fill' | 'translucent' | 'difference' | 'extents' | 'origin' | 'filmBox' | 'drillSymbols' | 'arrows' | 'centreline' | 'plunge' | 'retract') =>
    cmd(name, label, (ed) => { ed.view[key] = !ed.view[key]; camChanged(ed); }, (ed) => ed.view[key]);
  return [
    cmd('ZoomPan', 'Around Point', (ed) => ed.setTool(new PointsTool(ed, { id: 'cam-zoom-around', count: 1, hint: () => 'Around Point: click the point to centre the view on', done: ([p]) => { ed.pushView(); ed.viewport?.cam.centreOn(p!); ed.viewport?.requestRender(); } }))),
    cmd('ZoomDynamicPan', 'Dynamic', (ed) => ed.setTool(new DynamicViewTool(ed, 'pan'))),
    cmd('ZoomDynamicZoom', 'Dynamic', (ed) => ed.setTool(new DynamicViewTool(ed, 'zoom'))),
    cmd('ZoomDcode', 'Dcode', (ed) => {
      const l = ed.layer;
      if (l?.data.kind !== 'gerber') { notify('Make a Gerber layer current'); return; }
      const used = [...new Set(liveObjects(l).flatMap(({ o }) => (o.kind === 'region' ? [] : [o.ap])))].sort((a, b) => a - b);
      if (!used.length) { notify('The layer has no apertures in use'); return; }
      ask('Zoom Dcode', [{ key: 'ap', label: 'D-Code', kind: 'select', value: `D${used[0]}`, options: used.map((c) => `D${c}`) }], (v) => {
        const code = Number(String(v.ap).slice(1));
        const keys = liveObjects(l).filter(({ o }) => o.kind !== 'region' && o.ap === code).map(({ i }) => ed.keyOf(l, i));
        ed.zoomToBox(ed.boundsOf(keys), mil(100));
        ed.view.highlight = code;
        camChanged(ed);
      });
    }),
    cmd('ZoomFilmBox', 'Zoom Film Box', (ed) => { if (!ed.doc.filmBox) { notify('No film box yet: View › Film Box sets one'); return; } ed.zoomToBox(ed.doc.filmBox); }),
    // Views
    toggle('ViewShowDiff', 'Difference', 'difference'),
    toggle('ViewExtents', 'Extents Box', 'extents'),
    toggle('ViewFill', 'Fill', 'fill'),
    cmd('HighlightAll', 'Highlight Dcode', (ed) => {
      if (ed.view.highlight !== null) { ed.view.highlight = null; camChanged(ed); return; }
      const l = ed.layer;
      if (l?.data.kind !== 'gerber') { notify('Make a Gerber layer current'); return; }
      const codes = [...l.data.apertures.keys()].sort((a, b) => a - b);
      ask('Highlight Dcode', [{ key: 'ap', label: 'D-Code', kind: 'select', value: `D${codes[0] ?? 10}`, options: codes.map((c) => `D${c}`) }], (v) => { ed.view.highlight = Number(String(v.ap).slice(1)); camChanged(ed); });
    }, (ed) => ed.view.highlight !== null),
    cmd('DrawNegative', 'Negative', (ed) => {
      const l = ed.layer;
      if (l?.data.kind !== 'gerber') { notify('Make a Gerber layer current'); return; }
      if (ed.view.negative.has(l)) ed.view.negative.delete(l); else ed.view.negative.add(l);
      camChanged(ed);
    }, (ed) => !!ed.layer && ed.view.negative.has(ed.layer)),
    toggle('ViewOrigin', 'Origin', 'origin'),
    toggle('ViewTranslucent', 'Translucent', 'translucent'),
    cmd('WindowToggleMenu', 'CAM Editor...', (ed) => { ed.ncMode = false; camChanged(ed); notify('CAM Editor: every layer picks'); }, (ed) => !ed.ncMode),
    cmd('WindowToggleMenu0', 'NC Editor...', (ed) => { ed.ncMode = true; camChanged(ed); notify('NC Editor: drill and rout layers pick'); }, (ed) => ed.ncMode),
    // Film box
    cmd('EditBoundBox', 'Film Box...', (ed) => {
      const b = ed.doc.filmBox ?? (() => { const e = camExtent(ed.doc, false); const m = mm(10); return e ? { minX: e.minX - m, minY: e.minY - m, maxX: e.maxX + m, maxY: e.maxY + m } : { minX: 0, minY: 0, maxX: mm(305), maxY: mm(406) }; })();
      ask('Film Box', [
        { key: 'x', label: 'Lower-left X', kind: 'length', value: b.minX },
        { key: 'y', label: 'Lower-left Y', kind: 'length', value: b.minY },
        { key: 'w', label: 'Width', kind: 'length', value: b.maxX - b.minX, min: 1 },
        { key: 'h', label: 'Height', kind: 'length', value: b.maxY - b.minY, min: 1 },
      ], (v) => {
        ed.edit('Film Box', [], () => { ed.doc.filmBox = { minX: v.x as number, minY: v.y as number, maxX: (v.x as number) + (v.w as number), maxY: (v.y as number) + (v.h as number) }; });
        ed.view.filmBox = true;
        camEdited();
      });
    }),
    toggle('ViewBoundBox', 'View Film Box', 'filmBox'),
    // Drill and rout previews
    cmd('ToolsAnimate', 'Preview Drill/Rout...', (ed) => {
      const l = ed.layer?.data.kind === 'drill' ? ed.layer : ed.doc.layers.find((x) => x.data.kind === 'drill');
      if (!l) { notify('No drill layer'); return; }
      const d = l.data as DrillLayer, er = new Set(l.erased ?? []);
      const order = ed.sortMode === 'auto' ? sortedHits(d, er) : d.hits.map((_, i) => i).filter((i) => !er.has(i));
      const pts = [...order.map((i) => ({ at: d.hits[i]!.at, r: (d.tools.get(d.hits[i]!.tool) ?? 0) / 2 })),
        ...d.routes.map((r) => { const p = routePoints(r); return { at: p[0]!, r: (d.tools.get(r.tool) ?? 0) / 2, route: p }; })];
      if (!pts.length) { notify(`${l.name} has nothing to drill or rout`); return; }
      ed.setTool(new AnimateTool(ed, pts, `Preview Drill/Rout of ${l.name}`));
    }),
    cmd('ToolsMillAnimate', 'Redraw a Rout Path', (ed) => ed.setTool(new PickTool(ed, 'cam-redraw-rout', 'Redraw a Rout Path: click a rout path', (hit) => {
      const r = hit ? ed.selectedRoutes([hit.key])[0] : undefined;
      if (!r) { notify('Click a rout path'); return; }
      const d = r.layer.data as DrillLayer, route = d.routes[r.k]!, p = routePoints(route), w = (d.tools.get(route.tool) ?? 0) / 2;
      ed.setTool(new AnimateTool(ed, p.map((q, i) => ({ at: q, r: w, route: p.slice(0, i + 1) })).filter((_, i) => i % Math.max(1, Math.floor(p.length / 120)) === 0 || i === p.length - 1), 'Redraw a Rout Path'));
    }))),
    cmd('MillSortAuto', 'Automatic...', (ed) => ask('Sort/Optimise', [
      { kind: 'note', text: 'Each tool\'s hits in the order a drill reaches them nearest first; the drill layers are written in that order.' },
      { key: 'apply', label: 'Reorder the hits now', kind: 'bool', value: true },
    ], (v) => {
      ed.sortMode = 'auto';
      if (!v.apply) return;
      const layers = ed.doc.layers.filter((l) => l.data.kind === 'drill');
      ed.edit('Sort Drills', layers, () => {
        for (const l of layers) {
          const d = l.data as DrillLayer, er = new Set(l.erased ?? []);
          // Erased hits go with the reordering (their indices would no longer hold)
          d.hits = sortedHits(d, er).map((i) => d.hits[i]!);
          delete l.erased;
        }
      });
      camEdited();
      notify(`Drills sorted on ${layers.length} layer${layers.length === 1 ? '' : 's'}`);
    }), (ed) => ed.sortMode === 'auto'),
    cmd('MillSortUser', 'User Select', (ed) => {
      const l = ed.layer?.data.kind === 'drill' ? ed.layer : undefined;
      if (!l) { notify('Make a drill layer current'); return; }
      ed.sortMode = 'user';
      let next = 0;
      ed.setTool(new PickTool(ed, 'cam-sort-user', 'Sort/Optimise › User Select: click the hits in the order to drill them (right-click to finish)', (hit) => {
        const p = hit ? ed.selectedObjects([hit.key])[0] : undefined;
        if (!p || p.layer !== l) return;
        const d = l.data as DrillLayer;
        // The clicked hit goes to the next place in the file
        ed.edit('Sort Drills', [l], () => {
          const order = d.hits.map((_, i) => i).filter((i) => i !== p.i);
          order.splice(Math.min(next, order.length), 0, p.i);
          d.hits = order.map((i) => d.hits[i]!);
          if (l.erased) l.erased = l.erased.map((e) => order.indexOf(e)).filter((e) => e >= 0).sort((a, b) => a - b);
        });
        next++;
        camEdited();
      }, (h) => !!ed.selectedObjects([h.key])[0] && ed.selectedObjects([h.key])[0]!.layer === l));
    }, (ed) => ed.sortMode === 'user'),
    cmd('MillSortNone', 'None', (ed) => { ed.sortMode = 'none'; tick.value++; }, (ed) => ed.sortMode === 'none'),
    // Display symbols
    toggle('DrillSymbol', 'Drill', 'drillSymbols'),
    toggle('ToolsMillArrow', 'Direction Arrows', 'arrows'),
    toggle('ToolsMillViewOriginal', 'Centerline Path', 'centreline'),
    toggle('ToolsMillViewPlunge', 'Plunge', 'plunge'),
    toggle('ToolsMillViewRetract', 'Retract', 'retract'),
    // Snap grids
    ...SNAP_GRIDS.map(([n, label, g]) => cmd(n, label, (ed) => { ed.setGrid(g); tick.value++; notify(`Snap grid ${label}`); }, (ed) => ed.gridSize() === g)),
    cmd('PopupSnapGridOther', 'Set Snap Grid...', (ed) => ask('Snap Grid', [{ key: 'g', label: 'Snap grid', kind: 'length', value: ed.gridSize(), min: 1 }], (v) => { ed.setGrid(v.g as number); tick.value++; })),
    cmd('SnapChange', 'Snap Change', (ed) => { ed.snapOn = !ed.snapOn; tick.value++; notify(ed.snapOn ? `Snapping to the ${fmtLen(ed.gridSize())} grid` : 'Snapping off'); }, (ed) => !ed.snapOn),
    // Layers
    cmd('NextLayer', 'Next Layer', (ed) => { if (!ed.doc.layers.length) return; ed.doc.current = (ed.doc.current + 1) % ed.doc.layers.length; camChanged(ed); notify(`Current layer: ${ed.layer!.name}`); }),
    cmd('PreviousLayer', 'Previous Layer', (ed) => { const n = ed.doc.layers.length; if (!n) return; ed.doc.current = (ed.doc.current + n - 1) % n; camChanged(ed); notify(`Current layer: ${ed.layer!.name}`); }),
    cmd('NextSignalLayer', 'Next Signal/Plane Layer', (ed) => {
      const n = ed.doc.layers.length;
      for (let k = 1; k <= n; k++) {
        const i = (ed.doc.current + k) % n, l = ed.doc.layers[i]!;
        if (['Top', 'Bottom', 'Internal', 'Plane'].includes(l.type)) { ed.doc.current = i; camChanged(ed); notify(`Current layer: ${l.name}`); return; }
      }
      notify('No signal or plane layer');
    }),
    cmd('ViewSetLayOn', 'View Set Lay On', (ed) => layerSet(ed, true)),
    cmd('ViewSetLayOff', 'View Set Lay Off', (ed) => layerSet(ed, false)),
    cmd('EscapeBreak', 'Cancel Action', (ed) => { if (!ed.toolKey('Escape')) ed.clearSelection(); }),
    cmd('ExecuteFunction', 'Execute', () => ask('Execute', [{ key: 'name', label: 'Command (its menu name or id)', kind: 'text', value: '' }], (v) => {
      const q = String(v.name).trim().toLowerCase().replace(/\.\.\.$/, '');
      if (!q) return 'Type a command';
      const all = commands.all().filter((c) => !c.planned && (!c.scopes || c.scopes.includes('cam')));
      const c = all.find((x) => x.id.toLowerCase() === q || x.id.toLowerCase() === `ad:camtastic:${q}`) ?? all.find((x) => x.label.toLowerCase().replace(/\.\.\.$/, '') === q);
      if (!c) return `No command called "${v.name}"`;
      setTimeout(() => commands.run(c.id, 'cam'), 0);
    })),
  ];
}
