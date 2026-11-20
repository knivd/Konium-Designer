/**
 * The CAM editor's Tables, Tools, Rout, Analysis and Reports menus (CAMtastic): the aperture wizard,
 * layer sets, NC tools, steps and parts tables; panels and films; copper area, copper pour, pad
 * removal, spread/reduce, teardrops, silk trimming, venting, drawing order; the netlist (extract,
 * clean, compare, rename, query, measure); parts and their designators; SMT stencil home plates and
 * epoxy bars; closed polylines made polygons; rout paths (made, changed, round the border, by hand,
 * tabs, arcs and circles fitted, mill boundaries); the design check and its rules from an open board;
 * invalid polygons, the drill drawing, boundaries cleaned, filled and outlined; and the reports.
 */
import { pushAll } from '../core/lists';
import type { Command, Scope } from '../core/commands';
import type { Vec2 } from '../core/geom';
import { mil, mm } from '../core/units';
import { apertureText, routePoints, type CamEditor } from '../editors/cam/CamEditor';
import { PickTool, PointsTool, PREVIEW, previewPath } from '../editors/cam/camTools';
import { camExtent, sortLayers, type CamLayer } from '../formats/cam/camDoc';
import { compareNets, copperArea, copperLayers, camDrc, dcodeUsage, drcReport, extractNets, invalidPolygons, netlistReport, netOf, piecesDist, piecesOf, rfqReport, routReport, xyReport, annularRings, type Piece } from '../formats/cam/camAnalysis';
import { boardOutline, cleanBoundaries, closedToRegions, copperPour, epoxyBars, fabDrawing, fillBoundary, filmPlacement, homebase, linesToArcs, linesToCircle, nonFunctionalPads, outlinesOf, panelise, routAround, teardrops, trimSilk, venting, addTab } from '../formats/cam/camProcess';
import { chainPoints, chains } from '../formats/cam/camOps';
import { findOrAddAperture, findOrAddTool, grownAperture, liveObjects, moveXf, xfHit, xfObject, xfRoute, type CamPart } from '../formats/cam/camModel';
import type { DrillLayer, GerberLayer, GerberObject } from '../formats/gerber/gerberRead';
import { activeCam, ask, camChanged, camEdited, currentAperture, emptyLayer, fmtLen, freshLayerName, gerberLayer } from './camCommon';
import { showDialog } from './dialogs';
import { CamReportDialog } from './dialogs/CamTables';
import { CamApertureWizardDialog, CamLayerSetsDialog, CamNcToolsDialog, CamPartsDialog, CamRenameNetsDialog, CamStepsDialog } from './dialogs/CamTables2';
import { docs, notify, units } from './state';
import { InfoDialog } from './dialogs/Confirm';
import { ruleKind, ruleLength } from '../formats/altium/rules';
import type { PcbDocument } from '../model/pcb';

const CAM: Scope[] = ['cam'];
const id = (n: string) => `ad:CAMTASTIC:${n}`;
const report = (title: string, text: string) => showDialog(CamReportDialog, { title, text });
const names = (ls: CamLayer[]) => ls.map((l) => l.name);

/** The rout layer routs go to: the current drill layer, the first one named for routing, or a new one. */
function routLayer(ed: CamEditor): { l: CamLayer; d: DrillLayer; added: boolean } {
  const cur = ed.layer;
  if (cur?.data.kind === 'drill') return { l: cur, d: cur.data, added: false };
  const r = ed.doc.layers.find((l) => l.data.kind === 'drill' && /rout|mill|rte|gko/i.test(l.name));
  if (r) return { l: r, d: r.data as DrillLayer, added: false };
  const l = emptyLayer(freshLayerName(ed.doc, 'Rout.RTE'), 'Border', true);
  return { l, d: l.data as DrillLayer, added: true };
}
function withRoutLayer(ed: CamEditor, label: string, fn: (l: CamLayer, d: DrillLayer, tool: number) => void): void {
  const { l, d, added } = routLayer(ed);
  ed.edit(label, added ? 'all' : [l], () => {
    if (added) ed.doc.layers = sortLayers([...ed.doc.layers, l]);
    fn(l, d, findOrAddTool(d, ed.routOptions.tool));
  });
  camEdited();
}

/** The objects to work on: the selection's, else the current layer's. */
function targets(ed: CamEditor): { l: CamLayer; g: GerberLayer; objs: { o: GerberObject; i: number }[] }[] {
  const sel = ed.selectedObjects().filter((s) => s.layer.data.kind === 'gerber');
  if (sel.length) return [...new Set(sel.map((s) => s.layer))].map((l) => ({ l, g: l.data as GerberLayer, objs: sel.filter((s) => s.layer === l).map((s) => ({ o: (l.data as GerberLayer).objects[s.i]!, i: s.i })) }));
  const t = gerberLayer(ed);
  return t ? [{ l: t.l, g: t.g, objs: liveObjects(t.l) }] : [];
}

/** The design check's rules from an open board (its Clearance, Width, Minimum Annular Ring, Hole Size, Silk To Solder Mask Clearance rules). */
function rulesFromBoard(ed: CamEditor): string | null {
  // The board in front of the others: the CAM document's project's, else any open one
  const boards = docs.value.filter((d) => (d.doc as { kind?: string }).kind === 'PcbDoc');
  const own = boards.find((d) => d.projectId && docs.value.some((x) => x.editor === ed && x.projectId === d.projectId));
  const board = (own ?? boards[0])?.doc as PcbDocument | undefined;
  if (!board) return null;
  const r = ed.drcRules;
  const pick = (kind: string) => board.rules.filter((x) => ruleKind(x) === kind).sort((a, b) => a.bag.int('PRIORITY', 1) - b.bag.int('PRIORITY', 1))[0];
  const cl = pick('Clearance'), w = pick('Width'), ar = pick('MinimumAnnularRing'), hs = pick('HoleSize'), sm = pick('SilkToSolderMaskClearance');
  if (cl) r.clearance = ruleLength(cl, 'GAP', '10mil');
  if (w) r.minWidth = ruleLength(w, 'MINLIMIT', '10mil');
  if (ar) r.annularRing = ruleLength(ar, 'MINIMUMRING', '10mil');
  if (hs) { r.minHole = ruleLength(hs, 'MINLIMIT', '1mil'); r.maxHole = ruleLength(hs, 'MAXLIMIT', '100mil'); }
  if (sm) r.silkToMask = ruleLength(sm, 'MINSILKSCREENTOMASKGAP', '10mil');
  return [cl && 'Clearance', w && 'Width', ar && 'Minimum Annular Ring', hs && 'Hole Size', sm && 'Silk To Solder Mask Clearance'].filter(Boolean).join(', ') || 'none of the rules checked';
}

/** Two objects picked one after the other (for the measures). */
function pickTwo(ed: CamEditor, idTool: string, hint: string, done: (a: { layer: CamLayer; i: number }, b: { layer: CamLayer; i: number }) => void): void {
  let first: { layer: CamLayer; i: number } | null = null;
  ed.setTool(new PickTool(ed, idTool, hint, (hit) => {
    const p = hit ? ed.selectedObjects([hit.key])[0] : undefined;
    if (!p || p.layer.data.kind !== 'gerber') { notify('Click a Gerber object'); return; }
    if (!first) { first = p; ed.select([hit!.key]); return; }
    const a = first;
    first = null;
    done(a, p);
  }));
}

const piece = (l: CamLayer, i: number): Piece | undefined => piecesOf(l, false).find((p) => p.i === i);

export function camToolCommands(): Command[] {
  const on = () => !!activeCam();
  const withCam = (f: (ed: CamEditor) => void) => () => { const e = activeCam(); if (e) f(e); };
  const cmd = (name: string, label: string, run: (ed: CamEditor) => void): Command => ({ id: id(name), label, scopes: CAM, enabled: on, run: withCam(run) });
  return [
    // Tables
    cmd('ApertureWizard', 'Aperture List Wizard...', (ed) => showDialog(CamApertureWizardDialog, { ed, units: units.value })),
    cmd('TablesLayersSets', 'Layers Sets...', (ed) => showDialog(CamLayerSetsDialog, { ed })),
    cmd('TablesMill', 'NC Tools...', (ed) => showDialog(CamNcToolsDialog, { ed, units: units.value })),
    cmd('ProcessTable', 'Steps...', (ed) => showDialog(CamStepsDialog, { ed, units: units.value })),
    cmd('FileExportCentroid0', 'Parts...', (ed) => showDialog(CamPartsDialog, { ed, units: units.value })),
    // Panel and film
    cmd('ToolsPanelize', 'Panelize PCB', (ed) => ask('Panelize PCB', [
      { kind: 'note', text: 'Every layer repeated in a panel, the board\'s size plus the gaps apart (written as step-and-repeat).' },
      { key: 'nx', label: 'Columns', kind: 'number', value: 2, min: 1, max: 100 },
      { key: 'ny', label: 'Rows', kind: 'number', value: 2, min: 1, max: 100 },
      { key: 'gx', label: 'Gap between columns', kind: 'length', value: mm(2), min: 0 },
      { key: 'gy', label: 'Gap between rows', kind: 'length', value: mm(2), min: 0 },
      { key: 'frame', label: 'Frame round the panel (on the border layer)', kind: 'bool', value: true },
      { key: 'fw', label: 'Frame margin', kind: 'length', value: mm(5), min: 0 },
    ], (v) => {
      const nx = Math.round(v.nx as number), ny = Math.round(v.ny as number);
      if (nx * ny < 2) return 'A panel has two boards or more';
      ed.edit('Panelize PCB', 'all', () => {
        panelise(ed.doc, nx, ny, v.gx as number, v.gy as number);
        if (v.frame) {
          const border = ed.doc.layers.find((l) => l.type === 'Border' && l.data.kind === 'gerber') ?? (() => { const b = emptyLayer(freshLayerName(ed.doc, 'Panel.GKO'), 'Border'); ed.doc.layers = sortLayers([...ed.doc.layers, b]); return b; })();
          const g = border.data as GerberLayer;
          const e = camExtent(ed.doc, false)!, m = v.fw as number;
          const c = [{ x: e.minX - m, y: e.minY - m }, { x: e.maxX + m, y: e.minY - m }, { x: e.maxX + m, y: e.maxY + m }, { x: e.minX - m, y: e.maxY + m }];
          const ap = findOrAddAperture(g, 'C', mil(10));
          for (let k = 0; k < 4; k++) g.objects.push({ kind: 'draw', a: c[k]!, b: c[(k + 1) % 4]!, ap, dark: true });
        }
      });
      camEdited();
      ed.fit();
    })),
    cmd('ToolsFilmWizard', 'Film Wizard...', (ed) => ask('Film Wizard', [
      { key: 'size', label: 'Film size', kind: 'select', value: '16 x 20 in', options: ['12 x 16 in', '16 x 20 in', '20 x 24 in', '24 x 28 in', 'A4', 'A3', 'Custom'] },
      { key: 'w', label: 'Custom width', kind: 'length', value: mil(16000), min: 1 },
      { key: 'h', label: 'Custom height', kind: 'length', value: mil(20000), min: 1 },
      { key: 'centre', label: 'Centre the image on the film (its lower-left corner at the origin)', kind: 'bool', value: true },
    ], (v) => {
      const sizes: Record<string, [number, number]> = { '12 x 16 in': [mil(12000), mil(16000)], '16 x 20 in': [mil(16000), mil(20000)], '20 x 24 in': [mil(20000), mil(24000)], '24 x 28 in': [mil(24000), mil(28000)], A4: [mm(210), mm(297)], A3: [mm(297), mm(420)] };
      const [w, h] = sizes[String(v.size)] ?? [v.w as number, v.h as number];
      const e = camExtent(ed.doc, false);
      if (e && (e.maxX - e.minX > w || e.maxY - e.minY > h)) return 'The image is bigger than the film';
      const pl = filmPlacement(ed.doc, w, h, !!v.centre);
      ed.edit('Film Wizard', 'all', () => {
        if (pl.move.x || pl.move.y) {
          const t = moveXf(pl.move.x, pl.move.y);
          for (const l of ed.doc.layers) {
            if (l.data.kind === 'gerber') { const g = l.data; g.objects = g.objects.map((o) => xfObject(o, t)); }
            else { const d = l.data; d.hits = d.hits.map((x) => xfHit(x, t)); d.routes = d.routes.map((x) => xfRoute(x, t)); }
          }
        }
        ed.doc.filmBox = pl.box;
      });
      ed.view.filmBox = true;
      camEdited();
      ed.fit();
    })),
    // Copper
    cmd('ToolsCopperArea', 'Calc. Copper Area', (ed) => {
      const ls = copperLayers(ed.doc).filter((l) => l.visible);
      if (!ls.length) { notify('No copper layer is shown'); return; }
      const sq = (a: number) => (units.value === 'mm' ? `${(a / (393700.787 ** 2)).toFixed(2)} mm²` : `${(a / 1e14).toFixed(3)} in²`);
      const lines = ['Copper Area', ''];
      for (const l of ls) { const a = copperArea(ed.doc, l); lines.push(`${l.name} (${l.type}): ${sq(a.copper)}${a.board ? `, ${((100 * a.copper) / a.board).toFixed(1)}% of ${sq(a.board)}` : ''}`); }
      report('Copper Area', lines.join('\n'));
    }),
    cmd('ToolsCopperPour', 'Copper Pour', (ed) => {
      const t = gerberLayer(ed);
      if (!t) return;
      ask('Copper Pour', [
        { kind: 'note', text: `Fills ${t.l.name} inside the board outline, keeping clear of what's there and of the holes.` },
        { key: 'cl', label: 'Clearance', kind: 'length', value: mil(15), min: 0 },
        { key: 'm', label: 'Margin from the board edge', kind: 'length', value: mil(20), min: 0 },
      ], (v) => {
        const regions = copperPour(ed.doc, t.l, v.cl as number, v.m as number);
        if (!regions.length) return 'Nothing to pour: no board outline, or no room';
        ed.edit('Copper Pour', [t.l], () => { pushAll(t.g.objects, regions); });
        camEdited();
        notify(`${regions.length} poured area${regions.length === 1 ? '' : 's'}`);
      });
    }),
    cmd('ToolsPads', 'Pad Removal', (ed) => {
      const copper = copperLayers(ed.doc);
      if (!copper.length) { notify('No copper layers'); return; }
      ask('Pad Removal', [
        { kind: 'note', text: 'Takes off pads that sit on a hole and touch nothing else on their layer (non-functional pads).' },
        { key: 'layers', label: 'Layers', kind: 'layers', value: names(copper.filter((l) => l.type === 'Internal')), options: names(copper) },
      ], (v) => {
        const ls = copper.filter((l) => (v.layers as string[]).includes(l.name));
        const nfp = nonFunctionalPads(ed.doc, ls);
        if (!nfp.length) { notify('No non-functional pads'); return; }
        ed.edit('Pad Removal', ls, () => { for (const l of ls) { const mine = nfp.filter((x) => x.layer === l).map((x) => x.i); if (mine.length) l.erased = [...new Set([...(l.erased ?? []), ...mine])].sort((a, b) => a - b); } });
        camEdited();
        notify(`${nfp.length} pad${nfp.length === 1 ? '' : 's'} removed`);
      });
    }),
    cmd('ToolsSpread', 'Spread/Reduce', (ed) => ask('Spread/Reduce', [
      { kind: 'note', text: 'Grows (or, negative, shrinks) objects by changing their apertures, as for mask and paste openings.' },
      { key: 'by', label: 'Amount all round', kind: 'length', value: mil(2) },
      { key: 'layers', label: 'Layers', kind: 'layers', value: ed.layer?.data.kind === 'gerber' ? [ed.layer.name] : [], options: names(ed.doc.layers.filter((l) => l.data.kind === 'gerber')) },
      { key: 'what', label: 'Objects', kind: 'select', value: 'Flashes', options: ['Flashes', 'Lines and arcs', 'Both'] },
    ], (v) => {
      const ls = ed.doc.layers.filter((l) => (v.layers as string[]).includes(l.name) && l.data.kind === 'gerber');
      if (!ls.length) return 'Tick a layer';
      const by = v.by as number, what = String(v.what);
      let n = 0;
      ed.edit('Spread/Reduce', ls, () => {
        for (const l of ls) {
          const g = l.data as GerberLayer;
          const map = new Map<number, number>();
          for (const { o, i } of liveObjects(l)) {
            if (o.kind === 'region') continue;
            if ((o.kind === 'flash') !== (what !== 'Lines and arcs') && what !== 'Both') continue;
            if (!map.has(o.ap)) map.set(o.ap, grownAperture(g, o.ap, by));
            g.objects[i] = { ...o, ap: map.get(o.ap)! };
            n++;
          }
        }
      });
      camEdited();
      notify(`${n} object${n === 1 ? '' : 's'} ${by >= 0 ? 'spread' : 'reduced'}`);
    })),
    cmd('ToolsTearDrop', 'Teardrops', (ed) => {
      const copper = copperLayers(ed.doc).filter((l) => !(l.data as GerberLayer).negative);
      ask('Teardrops', [
        { key: 'layers', label: 'Layers', kind: 'layers', value: names(copper.filter((l) => l.visible)), options: names(copper) },
        { key: 'r', label: 'Length (times the pad\'s radius)', kind: 'number', value: 1.5, min: 0.6, max: 5 },
      ], (v) => {
        const ls = copper.filter((l) => (v.layers as string[]).includes(l.name));
        let n = 0;
        ed.edit('Teardrops', ls, () => { for (const l of ls) { const t = teardrops(l, v.r as number); n += t.length; (l.data as GerberLayer).objects.push(...t); } });
        camEdited();
        notify(n ? `${n} teardrop${n === 1 ? '' : 's'} added` : 'No track ends on a round pad');
      });
    }),
    cmd('ToolsTrimsilk', 'Trim Silkscreen...', (ed) => ask('Trim Silkscreen', [
      { kind: 'note', text: 'Cuts silk back from the solder mask openings on its side.' },
      { key: 'cl', label: 'Clearance from the openings', kind: 'length', value: mil(5), min: 0 },
    ], (v) => {
      const r = trimSilk(ed.doc, v.cl as number);
      if (!r.length) { notify('No silk crosses a mask opening'); return; }
      ed.edit('Trim Silkscreen', r.map((x) => x.layer), () => {
        for (const { layer, erase, add } of r) { layer.erased = [...new Set([...(layer.erased ?? []), ...erase])].sort((a, b) => a - b); (layer.data as GerberLayer).objects.push(...add); }
      });
      camEdited();
      notify(`${r.reduce((n, x) => n + x.erase.length, 0)} silk object${r.length === 1 ? '' : 's'} trimmed`);
    })),
    cmd('ToolsVenting', 'Venting...', (ed) => {
      const t = gerberLayer(ed);
      if (!t) return;
      ask('Venting', [
        { kind: 'note', text: `Fills the empty parts of ${t.l.name} with a grid of vent dots (copper balancing).` },
        { key: 'shape', label: 'Shape', kind: 'select', value: 'Round', options: ['Round', 'Square'] },
        { key: 'size', label: 'Size', kind: 'length', value: mil(50), min: 1 },
        { key: 'pitch', label: 'Pitch', kind: 'length', value: mil(100), min: 1 },
        { key: 'cl', label: 'Clearance from copper', kind: 'length', value: mil(30), min: 0 },
        { key: 'm', label: 'Margin from the board edge', kind: 'length', value: mil(50), min: 0 },
      ], (v) => {
        if ((v.pitch as number) <= (v.size as number)) return 'The pitch must be more than the size';
        const dots = venting(ed.doc, t.l, { pitch: v.pitch as number, size: v.size as number, square: v.shape === 'Square', clearance: v.cl as number, margin: v.m as number });
        if (!dots.length) return 'No room for vents';
        ed.edit('Venting', [t.l], () => { t.g.objects.push(...dots); });
        camEdited();
        notify(`${dots.length} vents added`);
      });
    }),
    cmd('UpdatePolygonsDrawingOrder', 'Refresh Database Drawing Order', (ed) => {
      // Each layer's polygons in a polarity run largest first, so smaller ones draw over them [est]
      const ls = ed.doc.layers.filter((l) => l.data.kind === 'gerber');
      let moved = 0;
      ed.edit('Refresh Drawing Order', ls, () => {
        for (const l of ls) {
          const g = l.data as GerberLayer, er = new Set(l.erased ?? []);
          const area = (o: GerberObject) => (o.kind === 'region' ? Math.abs(o.contours[0]!.reduce((t, p, i, c) => t + (p.x * c[(i + 1) % c.length]!.y - c[(i + 1) % c.length]!.x * p.y), 0)) : -1);
          const order: number[] = [];
          let run: number[] = [];
          const flush = () => { const regs = run.filter((i) => g.objects[i]!.kind === 'region').sort((a, b) => area(g.objects[b]!) - area(g.objects[a]!)); let k = 0; for (const i of run) order.push(g.objects[i]!.kind === 'region' ? regs[k++]! : i); run = []; };
          g.objects.forEach((o, i) => { if (run.length && g.objects[run[0]!]!.dark !== o.dark) flush(); run.push(i); });
          flush();
          if (order.every((x, i) => x === i)) continue;
          moved++;
          g.objects = order.map((i) => g.objects[i]!);
          if (er.size) l.erased = order.map((x, i) => (er.has(x) ? i : -1)).filter((i) => i >= 0);
        }
      });
      ed.clearSelection();
      camEdited();
      notify(moved ? `Drawing order refreshed on ${moved} layer${moved === 1 ? '' : 's'}` : 'The drawing order is as it should be');
    }),
    // Netlist
    cmd('ToolsNetListEx', 'Extract', (ed) => {
      if (!copperLayers(ed.doc).length) { notify('No copper layers to extract a netlist from', 'error'); return; }
      const nets = extractNets(ed.doc);
      ed.edit('Extract Netlist', [], () => { ed.doc.nets = nets; });
      camEdited();
      notify(`${nets.length} net${nets.length === 1 ? '' : 's'} extracted`);
    }),
    cmd('ToolsNetListCleanNets', 'Clean All Nets...', (ed) => {
      if (!ed.doc.nets?.length) { notify('No nets to clean'); return; }
      ed.edit('Clean All Nets', [], () => { delete ed.doc.nets; });
      ed.shownNet = null;
      camEdited();
      notify('Nets cleared');
    }),
    cmd('ToolsNetListComparison', 'Compare', (ed) => {
      if (!ed.doc.refNets?.length) { notify('Import a netlist to compare with first (File › Import › Netlist)'); return; }
      if (!ed.doc.nets) { const nets = extractNets(ed.doc); ed.edit('Extract Netlist', [], () => { ed.doc.nets = nets; }); }
      const r = compareNets(ed.doc);
      report('Netlist Compare', ['Netlist Compare', '', `Extracted nets: ${ed.doc.nets!.length}; nets in the netlist: ${ed.doc.refNets.length}`, '',
        `Opens (${r.opens.length})`, ...r.opens.map((x) => `  ${x}`), '', `Shorts (${r.shorts.length})`, ...r.shorts.map((x) => `  ${x}`), '',
        `Not found in the copper (${r.missing.length})`, ...r.missing.map((x) => `  ${x}`)].join('\n'));
    }),
    cmd('ToolsNetListRenameNets', 'Rename Nets...', (ed) => { if (!ed.doc.nets?.length) { notify('Extract the netlist first (Tools › Netlist › Extract)'); return; } showDialog(CamRenameNetsDialog, { ed }); }),
    cmd('InfoQueryNet', 'Net', (ed) => {
      if (!ed.doc.nets) { const nets = extractNets(ed.doc); ed.edit('Extract Netlist', [], () => { ed.doc.nets = nets; }); camEdited(); }
      ed.setTool(new PickTool(ed, 'cam-query-net', 'Query Net: click copper to see its net (right-click to finish)', (hit) => {
        const p = hit ? ed.selectedObjects([hit.key])[0] : undefined;
        const n = p ? netOf(ed.doc, p.layer, p.i) : undefined;
        if (!n) { ed.shownNet = null; camChanged(ed); notify('Not in a net'); return; }
        ed.shownNet = n.name;
        camChanged(ed);
        showDialog(InfoDialog, { title: 'Query Net', lines: [`Net: ${n.name}`, ...Object.entries(n.members).map(([l, idx]) => `${l}: ${idx.length} object${idx.length === 1 ? '' : 's'}`)] });
      }));
    }),
    cmd('InfoMeasureNet', 'Net to Net', (ed) => {
      if (!ed.doc.nets) { const nets = extractNets(ed.doc); ed.edit('Extract Netlist', [], () => { ed.doc.nets = nets; }); }
      pickTwo(ed, 'cam-measure-net', 'Measure Net to Net: click copper of one net, then of another', (a, b) => {
        const na = netOf(ed.doc, a.layer, a.i), nb = netOf(ed.doc, b.layer, b.i);
        if (!na || !nb || na === nb) { notify(na === nb ? 'Both are in one net' : 'Click copper in a net'); return; }
        let best = { d: Infinity, at: { x: 0, y: 0 } as Vec2, layer: '' };
        for (const l of copperLayers(ed.doc)) {
          const ia = na.members[l.name] ?? [], ib = nb.members[l.name] ?? [];
          if (!ia.length || !ib.length) continue;
          const pa = piecesOf(l).filter((p) => ia.includes(p.i)), pb = piecesOf(l).filter((p) => ib.includes(p.i));
          for (const x of pa) for (const y of pb) { const r = piecesDist(x, y); if (r.d < best.d) best = { ...r, layer: l.name }; }
        }
        showDialog(InfoDialog, { title: 'Measure Net to Net', lines: Number.isFinite(best.d) ? [`${na.name} to ${nb.name}`, `Distance = ${fmtLen(best.d)} on ${best.layer}`] : [`${na.name} and ${nb.name} share no layer`] });
      });
    }),
    cmd('InfoMeasureObject', 'Object to Object', (ed) => pickTwo(ed, 'cam-measure-object', 'Measure Object to Object: click an object, then another', (a, b) => {
      const pa = piece(a.layer, a.i), pb = piece(b.layer, b.i);
      if (!pa || !pb) { notify('Click two objects'); return; }
      const r = piecesDist(pa, pb);
      showDialog(InfoDialog, { title: 'Measure Object to Object', lines: [`Distance = ${fmtLen(r.d)}${r.d === 0 ? ' (they touch)' : ''}`, `${a.layer.name} to ${b.layer.name}`] });
    })),
    cmd('InfoQueryMultiple', 'Group', (ed) => {
      const sel = ed.selectedObjects();
      if (!sel.length) { notify('Select the objects first'); return; }
      const kinds = new Map<string, number>(), codes = new Map<string, number>();
      for (const s of sel) {
        if (s.layer.data.kind === 'drill') { kinds.set('Drill hit', (kinds.get('Drill hit') ?? 0) + 1); continue; }
        const o = s.layer.data.objects[s.i]!;
        const k = { draw: 'Line', arc: 'Arc', flash: 'Flash', region: 'Polygon' }[o.kind];
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
        if (o.kind !== 'region') codes.set(`D${o.ap}`, (codes.get(`D${o.ap}`) ?? 0) + 1);
      }
      const b = ed.selectionBounds();
      showDialog(InfoDialog, { title: 'Query Group', lines: [`${sel.length} objects on ${[...new Set(sel.map((s) => s.layer.name))].join(', ')}`,
        ...[...kinds].map(([k, n]) => `${k}: ${n}`), ...(codes.size ? [`D-codes: ${[...codes].map(([c, n]) => `${c} (${n})`).join(', ')}`] : []),
        `Extent: ${fmtLen(b.maxX - b.minX)} x ${fmtLen(b.maxY - b.minY)}`] });
    }),
    cmd('InfoMinAnnularRing', 'Minimum Annular Ring', (ed) => {
      const rings = annularRings(ed.doc);
      if (!rings.length) { notify('No pads on plated holes'); return; }
      const min = rings.reduce((m, r) => (r.ring < m.ring ? r : m));
      ed.zoomToBox({ minX: min.at.x - min.pad, minY: min.at.y - min.pad, maxX: min.at.x + min.pad, maxY: min.at.y + min.pad }, mil(200));
      showDialog(InfoDialog, { title: 'Minimum Annular Ring', lines: [`Smallest ring: ${fmtLen(min.ring)} on ${min.layer}`, `Pad ${fmtLen(min.pad)}, hole ${fmtLen(min.hole)}`, `At ${fmtLen(min.at.x)}, ${fmtLen(min.at.y)}`, `${rings.length} pads checked`] });
    }),
    // Parts
    cmd('ToolsBuildCentroid', 'Create & Group Parts', (ed) => {
      const sel = ed.selectedObjects().filter((s) => s.layer.data.kind === 'gerber' && (s.layer.data as GerberLayer).objects[s.i]!.kind === 'flash');
      if (!sel.length) { notify('Select a part\'s pads (flashes) first'); return; }
      const pts = sel.map((s) => ((s.layer.data as GerberLayer).objects[s.i] as Extract<GerberObject, { kind: 'flash' }>).at);
      const at = { x: Math.round(pts.reduce((t, p) => t + p.x, 0) / pts.length), y: Math.round(pts.reduce((t, p) => t + p.y, 0) / pts.length) };
      const side: CamPart['side'] = sel.every((s) => /Bottom/.test(s.layer.type)) ? 'bottom' : 'top';
      const n = (ed.doc.parts?.length ?? 0) + 1;
      ask('Create Part', [
        { key: 'ref', label: 'Designator', kind: 'text', value: `U${n}` },
        { key: 'value', label: 'Value', kind: 'text', value: '' },
        { key: 'fp', label: 'Footprint', kind: 'text', value: '' },
        { key: 'rot', label: 'Rotation', kind: 'number', value: 0 },
      ], (v) => {
        const ref = String(v.ref).trim();
        if (!ref) return 'A part needs a designator';
        if (ed.doc.parts?.some((p) => p.ref === ref)) return `${ref} is in use`;
        const pads: Record<string, number[]> = {};
        for (const s of sel) (pads[s.layer.name] ??= []).push(s.i);
        ed.edit('Create Part', [], () => { ed.doc.parts = [...(ed.doc.parts ?? []), { ref, at, rot: v.rot as number, side, pads, ...(String(v.value) ? { value: String(v.value) } : {}), ...(String(v.fp) ? { footprint: String(v.fp) } : {}) }]; });
        camEdited();
      });
    }),
    cmd('ToolsAssignRefDes', 'Assign Ref Designators', (ed) => {
      if (!ed.doc.parts?.length) { notify('No parts: Tools › Parts › Create & Group Parts makes them'); return; }
      ask('Assign Ref Designators', [
        { key: 'prefix', label: 'Prefix (blank keeps each part\'s own letters)', kind: 'text', value: '' },
        { key: 'start', label: 'Start at', kind: 'number', value: 1, min: 0 },
        { key: 'order', label: 'Order', kind: 'select', value: 'Across then down', options: ['Across then down', 'Down then across'] },
      ], (v) => {
        const row = mil(100);
        const parts = [...ed.doc.parts!].sort((a, b) => (v.order === 'Across then down' ? Math.round(b.at.y / row) - Math.round(a.at.y / row) || a.at.x - b.at.x : Math.round(a.at.x / row) - Math.round(b.at.x / row) || b.at.y - a.at.y));
        const next = new Map<string, number>();
        ed.edit('Assign Ref Designators', [], () => {
          ed.doc.parts = parts.map((p) => {
            const pre = String(v.prefix).trim() || p.ref.replace(/\d+.*$/, '') || 'U';
            const k = next.get(pre) ?? (v.start as number);
            next.set(pre, k + 1);
            return { ...p, ref: `${pre}${k}` };
          });
        });
        camEdited();
        notify(`${parts.length} parts numbered`);
      });
    }),
    // SMT stencil
    cmd('ToolsHomebase', 'Homebase Pad Conversion', (ed) => {
      const paste = ed.layer && /Paste/.test(ed.layer.type) && ed.layer.data.kind === 'gerber' ? ed.layer : ed.doc.layers.find((l) => /Paste/.test(l.type) && l.data.kind === 'gerber');
      if (!paste) { notify('No paste layer', 'error'); return; }
      ask('Homebase Pad Conversion', [
        { kind: 'note', text: `Makes ${paste.name}'s rectangular openings home plates, pointed towards their part's centre.` },
        { key: 'cut', label: 'Point length (percent of the pad)', kind: 'number', value: 25, min: 5, max: 50 },
      ], (v) => {
        const centres = (ed.doc.parts ?? []).filter((p) => p.pads[paste.name]?.length);
        const partOf = (p: Vec2) => centres.find((c) => c.pads[paste.name]!.some((i) => { const o = (paste.data as GerberLayer).objects[i]; return o?.kind === 'flash' && Math.hypot(o.at.x - p.x, o.at.y - p.y) < 100; }))?.at;
        let n = 0;
        ed.edit('Homebase Pad Conversion', [paste], () => { const m = homebase(paste, (v.cut as number) / 100, partOf); n = m.size; for (const [i, o] of m) (paste.data as GerberLayer).objects[i] = o; });
        camEdited();
        notify(n ? `${n} paste openings made home plates` : 'No pads to convert');
      });
    }),
    cmd('ToolsEpoxy', 'Add Epoxy Bars', (ed) => {
      const src = ed.doc.layers.filter((l) => l.data.kind === 'gerber' && /Paste|Top|Bottom/.test(l.type));
      if (!src.length) { notify('No pad layers', 'error'); return; }
      ask('Add Epoxy Bars', [
        { key: 'src', label: 'Pads from', kind: 'select', value: src.find((l) => /Top Paste/.test(l.type))?.name ?? src[0]!.name, options: names(src) },
        { key: 'w', label: 'Bar width', kind: 'length', value: mil(15), min: 1 },
        { key: 'len', label: 'Bar length', kind: 'length', value: mil(40), min: 0 },
        { key: 'gap', label: 'Pads apart at most', kind: 'length', value: mil(200), min: 1 },
      ], (v) => {
        const s = src.find((l) => l.name === v.src)!;
        const bars = epoxyBars(s, v.gap as number);
        if (!bars.length) return 'No two-pad parts found';
        const side = /Bottom/.test(s.type) ? 'Bottom' : 'Top';
        const glue = ed.doc.layers.find((l) => l.name === `Glue ${side}.GBR`) ?? emptyLayer(freshLayerName(ed.doc, `Glue ${side}.GBR`), 'Mechanical');
        const added = !ed.doc.layers.includes(glue);
        ed.edit('Add Epoxy Bars', added ? 'all' : [glue], () => {
          if (added) ed.doc.layers = sortLayers([...ed.doc.layers, glue]);
          const g = glue.data as GerberLayer;
          const ap = findOrAddAperture(g, 'C', v.w as number), half = (v.len as number) / 2;
          for (const b of bars) g.objects.push(half ? { kind: 'draw', a: b.along === 'x' ? { x: b.at.x - half, y: b.at.y } : { x: b.at.x, y: b.at.y - half }, b: b.along === 'x' ? { x: b.at.x + half, y: b.at.y } : { x: b.at.x, y: b.at.y + half }, ap, dark: true } : { kind: 'flash', at: b.at, ap, dark: true });
        });
        camEdited();
        notify(`${bars.length} epoxy bar${bars.length === 1 ? '' : 's'} on ${glue.name}`);
      });
    }),
    // Convert
    ...([['ConvertDrawsToSolidPolygon', 'Closed Polyline to Solid Polygon (Convert Inner Voids)', 'solid-voids'], ['ConvertDrawsToVoidPolygon', 'Closed Polyline to CutOut Polygon', 'cutout'], ['ConvertDrawsToSolidRegion', 'Closed Polyline to Solid Polygon Region', 'solid']] as const)
      .map(([n, label, mode]) => cmd(n, label, (ed) => {
        const ts = targets(ed);
        let made = 0;
        ed.edit(label, ts.map((t) => t.l), () => {
          for (const t of ts) {
            const r = closedToRegions(t.g, t.objs, mode);
            if (!r.add.length) continue;
            t.l.erased = [...new Set([...(t.l.erased ?? []), ...r.erase])].sort((a, b) => a - b);
            t.g.objects.push(...r.add);
            made += r.add.length;
          }
        });
        ed.clearSelection();
        camEdited();
        notify(made ? `${made} polygon${made === 1 ? '' : 's'} made` : 'No closed polylines among them');
      })),
    cmd('ViewGrid', 'Preferences...', (ed) => ask('CAM Preferences', [
      { key: 'grid', label: 'Snap grid', kind: 'length', value: ed.gridSize(), min: 1 },
      { key: 'snap', label: 'Snap to the grid', kind: 'bool', value: ed.snapOn },
      { key: 'fill', label: 'Draw objects filled', kind: 'bool', value: ed.view.fill },
      { key: 'tr', label: 'Translucent layers', kind: 'bool', value: ed.view.translucent },
      { key: 'origin', label: 'Show the origin', kind: 'bool', value: ed.view.origin },
      { key: 'sym', label: 'Drill symbols', kind: 'bool', value: ed.view.drillSymbols },
    ], (v) => { ed.setGrid(v.grid as number); ed.snapOn = !!v.snap; Object.assign(ed.view, { fill: !!v.fill, translucent: !!v.tr, origin: !!v.origin, drillSymbols: !!v.sym }); camChanged(ed); })),
    // Rout
    cmd('ToolsCreateToolPathCam', 'Create Rout Path(s)', (ed) => {
      const ts = targets(ed);
      const loops = ts.flatMap((t) => chains(t.objs).filter((c) => c.closed).map((c) => chainPoints(t.g, c.items).slice(0, -1)));
      const regions = ts.flatMap((t) => t.objs.filter(({ o }) => o.kind === 'region').map(({ o }) => (o as Extract<GerberObject, { kind: 'region' }>).contours[0]!));
      const outlines = [...loops, ...regions];
      if (!outlines.length) { notify('Select closed outlines (or make a layer with them current)'); return; }
      ask('Create Rout Path(s)', [
        { key: 'tool', label: 'Tool diameter', kind: 'length', value: ed.routOptions.tool, min: 1 },
        { key: 'side', label: 'Cut', kind: 'select', value: ed.routOptions.outside ? 'Outside the outlines' : 'Inside the outlines', options: ['Outside the outlines', 'Inside the outlines', 'Outside the largest, inside the rest'] },
      ], (v) => {
        ed.routOptions.tool = v.tool as number;
        const big = outlines.reduce((m, o) => (Math.abs(area2(o)) > Math.abs(area2(m)) ? o : m), outlines[0]!);
        let n = 0;
        withRoutLayer(ed, 'Create Rout Path(s)', (_l, d, tool) => {
          for (const o of outlines) {
            const outside = v.side === 'Outside the outlines' || (v.side !== 'Inside the outlines' && o === big);
            const r = routAround(o, v.tool as number, outside, tool);
            if (r) { d.routes.push(ed.routOptions.compensation !== 'none' ? { ...r, comp: ed.routOptions.compensation } : r); n++; }
          }
        });
        notify(`${n} rout path${n === 1 ? '' : 's'} made`);
      });
    }),
    cmd('ToolsModifyToolPathCam', 'Modify Rout Path(s)', (ed) => {
      const routes = ed.selectedRoutes();
      if (!routes.length) { notify('Select rout paths first'); return; }
      const first = routes[0]!, d0 = first.layer.data as DrillLayer;
      ask('Modify Rout Path(s)', [
        { key: 'tool', label: 'Tool diameter', kind: 'length', value: d0.tools.get(d0.routes[first.k]!.tool) ?? ed.routOptions.tool, min: 1 },
        { key: 'comp', label: 'Cutter compensation', kind: 'select', value: d0.routes[first.k]!.comp === 'L' ? 'Left (G41)' : d0.routes[first.k]!.comp === 'R' ? 'Right (G42)' : 'None', options: ['None', 'Left (G41)', 'Right (G42)'] },
        { key: 'rev', label: 'Reverse the direction', kind: 'bool', value: false },
      ], (v) => {
        ed.edit('Modify Rout Path(s)', [...new Set(routes.map((r) => r.layer))], () => {
          for (const { layer, k } of routes) {
            const d = layer.data as DrillLayer, r = d.routes[k]!;
            const tool = findOrAddTool(d, v.tool as number);
            let nr = { ...r, tool };
            if (v.comp === 'None') delete nr.comp; else nr = { ...nr, comp: v.comp === 'Left (G41)' ? 'L' : 'R' };
            if (v.rev) {
              if (nr.circle) nr = { ...nr, circle: { ...nr.circle, cw: !nr.circle.cw } };
              else { const n = nr.path.length; nr = { ...nr, path: [...nr.path].reverse(), ...(nr.arcs ? { arcs: nr.arcs.map((a) => ({ ...a, i: n - 2 - a.i, cw: !a.cw })) } : {}) }; }
            }
            d.routes[k] = nr;
          }
        });
        camEdited();
      });
    }),
    cmd('ToolsCreateToolPathOptions', 'Rout Pads Options...', (ed) => ask('Rout Pads Options', [
      { key: 'tool', label: 'Rout tool diameter', kind: 'length', value: ed.routOptions.tool, min: 1 },
      { key: 'side', label: 'Cut', kind: 'select', value: ed.routOptions.outside ? 'Outside' : 'Inside', options: ['Outside', 'Inside'] },
      { key: 'tab', label: 'Tab width', kind: 'length', value: ed.routOptions.tabWidth, min: 1 },
      { key: 'comp', label: 'Cutter compensation', kind: 'select', value: ed.routOptions.compensation === 'L' ? 'Left (G41)' : ed.routOptions.compensation === 'R' ? 'Right (G42)' : 'None', options: ['None', 'Left (G41)', 'Right (G42)'] },
    ], (v) => { Object.assign(ed.routOptions, { tool: v.tool, outside: v.side === 'Outside', tabWidth: v.tab, compensation: v.comp === 'Left (G41)' ? 'L' : v.comp === 'Right (G42)' ? 'R' : 'none' }); })),
    cmd('ToolsMillAuto', 'Auto-Rout PCB Border', (ed) => {
      const outline = boardOutline(ed.doc);
      if (outline.length < 3) { notify('No board border found', 'error'); return; }
      let ok = false;
      withRoutLayer(ed, 'Auto-Rout PCB Border', (_l, d, tool) => { const r = routAround(outline, ed.routOptions.tool, true, tool); if (r) { d.routes.push(r); ok = true; } });
      notify(ok ? `The border routed with a ${fmtLen(ed.routOptions.tool)} tool` : 'Could not rout the border');
    }),
    cmd('ToolsMillManual', 'Manual Rout...', (ed) => ed.setTool(new PointsTool(ed, {
      id: 'cam-manual-rout', count: 'many', min: 2, repeat: true,
      hint: (n) => (n ? 'Manual Rout: click the next point (right-click or Enter finishes the path)' : `Manual Rout: click where the tool plunges (${fmtLen(ed.routOptions.tool)} tool)`),
      preview: (pts, c) => (pts.length ? { segments: previewPath([...pts, c], ed.routOptions.tool, PREVIEW) } : null),
      done: (pts) => { withRoutLayer(ed, 'Manual Rout', (_l, d, tool) => { d.routes.push({ tool, path: pts }); }); },
    }))),
    cmd('ToolsMillTab', 'Add Tabs', (ed) => ed.setTool(new PickTool(ed, 'cam-rout-tab', `Add Tabs: click a rout path where a tab (${fmtLen(ed.routOptions.tabWidth)}) is left uncut (right-click to finish)`, (hit, _at, raw) => {
      const r = hit ? ed.selectedRoutes([hit.key])[0] : undefined;
      if (!r) { notify('Click a rout path'); return; }
      const d = r.layer.data as DrillLayer;
      const parts = addTab(d.routes[r.k]!, raw, ed.routOptions.tabWidth);
      if (!parts) { notify('No room for a tab there'); return; }
      ed.edit('Add Tab', [r.layer], () => { d.routes.splice(r.k, 1, ...parts); });
      ed.clearSelection();
      camEdited();
    }))),
    ...([['ToolsMillConvertArcs', 'Convert Lines to Arc'], ['ToolsMillConvertCircle', 'Convert Lines to Circle']] as const).map(([n, label]) => cmd(n, label, (ed) => {
      const sel = ed.selectedRoutes();
      const all = sel.length ? sel : ed.doc.layers.flatMap((l, li) => (l.data.kind === 'drill' ? l.data.routes.map((_, k) => ({ layer: l, li, k })) : []));
      if (!all.length) { notify('No rout paths'); return; }
      let changed = 0;
      ed.edit(label, [...new Set(all.map((r) => r.layer))], () => {
        for (const { layer, k } of all) {
          const d = layer.data as DrillLayer, r = d.routes[k]!;
          const tol = Math.max(mil(0.5), (d.tools.get(r.tool) ?? 0) / 50);
          const nr = n === 'ToolsMillConvertArcs' ? linesToArcs(r, tol) : linesToCircle(r, tol);
          if (nr && nr !== r && (nr.path.length !== r.path.length || nr.circle)) { d.routes[k] = nr; changed++; }
        }
      });
      camEdited();
      notify(changed ? `${changed} rout path${changed === 1 ? '' : 's'} converted` : 'Nothing to convert');
    })),
    cmd('MillMilling', 'Mill Boundary', (ed) => {
      const ts = targets(ed);
      const loops = ts.flatMap((t) => [...chains(t.objs).filter((c) => c.closed).map((c) => chainPoints(t.g, c.items).slice(0, -1)), ...t.objs.filter(({ o }) => o.kind === 'region').map(({ o }) => (o as Extract<GerberObject, { kind: 'region' }>).contours[0]!)]);
      if (!loops.length) { notify('Select the closed boundaries to mill'); return; }
      let n = 0;
      withRoutLayer(ed, 'Mill Boundary', (_l, d, tool) => { for (const o of loops) { const r = routAround(o, ed.routOptions.tool, false, tool); if (r) { d.routes.push(r); n++; } } });
      notify(`${n} boundar${n === 1 ? 'y' : 'ies'} milled (inside)`);
    }),
    // Analysis
    cmd('InfoDrc', 'PCB Design Check/Fix...', (ed) => {
      const r = ed.drcRules;
      ask('PCB Design Check', [
        { key: 'cl', label: 'Clearance between nets', kind: 'length', value: r.clearance, min: 0 }, { key: 'clOn', label: 'Check clearance (extracts the netlist)', kind: 'bool', value: r.checks.clearance },
        { key: 'w', label: 'Minimum track width', kind: 'length', value: r.minWidth, min: 0 }, { key: 'wOn', label: 'Check track width', kind: 'bool', value: r.checks.width },
        { key: 'ar', label: 'Minimum annular ring', kind: 'length', value: r.annularRing, min: 0 }, { key: 'arOn', label: 'Check annular rings', kind: 'bool', value: r.checks.annular },
        { key: 'h1', label: 'Smallest hole', kind: 'length', value: r.minHole, min: 0 }, { key: 'h2', label: 'Largest hole', kind: 'length', value: r.maxHole, min: 0 }, { key: 'hOn', label: 'Check hole sizes', kind: 'bool', value: r.checks.holes },
        { key: 'dc', label: 'Non-plated hole to copper', kind: 'length', value: r.drillToCopper, min: 0 }, { key: 'dcOn', label: 'Check holes to copper', kind: 'bool', value: r.checks.drillToCopper },
        { key: 'sm', label: 'Silk to mask openings', kind: 'length', value: r.silkToMask, min: 0 }, { key: 'smOn', label: 'Check silk over pads (Trim Silkscreen fixes it)', kind: 'bool', value: r.checks.silk },
      ], (v) => {
        Object.assign(r, { clearance: v.cl, minWidth: v.w, annularRing: v.ar, minHole: v.h1, maxHole: v.h2, drillToCopper: v.dc, silkToMask: v.sm });
        r.checks = { clearance: !!v.clOn, width: !!v.wOn, annular: !!v.arOn, holes: !!v.hOn, drillToCopper: !!v.dcOn, silk: !!v.smOn };
        const hadNets = !!ed.doc.nets;
        ed.drc = camDrc(ed.doc, r);
        ed.drcClearance = r.checks.clearance ? r.clearance : null;
        if (!hadNets && ed.doc.nets) { const nets = ed.doc.nets; delete ed.doc.nets; ed.edit('Extract Netlist', [], () => { ed.doc.nets = nets; }); }
        camChanged(ed);
        ed.invalidateOverlay();
        notify(ed.drc.length ? `${ed.drc.length} violation${ed.drc.length === 1 ? '' : 's'} (Reports › DRC/DFM lists them)` : 'No violations', ed.drc.length ? 'error' : 'ok');
      }, { width: 480 });
    }),
    cmd('InfoLoadDRCRulesFromPCB', 'Re-load DRC Rules from PCB...', (ed) => {
      const got = rulesFromBoard(ed);
      notify(got === null ? 'Open the board (.PcbDoc) to take its rules' : `Rules taken from the board: ${got}`, got === null ? 'error' : 'ok');
    }),
    cmd('InfoPolygons', 'Invalid Polygon Search', (ed) => {
      const bad = invalidPolygons(ed.doc);
      if (!bad.length) { notify('No invalid polygons'); return; }
      ed.select(bad.map((b) => ed.keyOf(b.layer, b.i)));
      ed.fitSelection(mil(200));
      report('Invalid Polygons', ['Invalid Polygon Search', '', `${bad.length} found (selected)`, ...bad.map((b) => `  ${b.layer.name} object ${b.i + 1}: ${b.why}`)].join('\n'));
    }),
    ...([['ToolsCreateFab', 'Create Fab Drawing (from Drill)'], ['ToolsCreateFab0', 'Create Fab Drawing ( from Drill )']] as const).map(([n, label]) => cmd(n, label, (ed) => {
      if (!ed.doc.layers.some((l) => l.data.kind === 'drill')) { notify('No drill layers', 'error'); return; }
      ask('Create Fab Drawing', [
        { key: 's', label: 'Symbol size', kind: 'length', value: mil(50), min: 1 },
        { key: 'h', label: 'Table text height', kind: 'length', value: mil(60), min: 1 },
        { key: 'mm', label: 'Sizes in millimetres', kind: 'bool', value: units.value === 'mm' },
      ], (v) => {
        const l = emptyLayer(freshLayerName(ed.doc, 'FabDrawing.GD1'), 'Drill Drawing');
        const g = l.data as GerberLayer;
        g.objects.push(...fabDrawing(ed.doc, g, v.s as number, v.h as number, !!v.mm));
        ed.edit('Create Fab Drawing', 'all', () => { ed.doc.layers = sortLayers([...ed.doc.layers, l]); ed.doc.current = ed.doc.layers.indexOf(l); });
        camEdited();
        ed.fit();
      });
    })),
    cmd('ToolsPolyLinePro', 'Clean Boundaries', (ed) => {
      const t = gerberLayer(ed);
      if (!t) return;
      const r = cleanBoundaries(t.l);
      if (!r.erase.length && !r.replace.size) { notify('Nothing to clean'); return; }
      ed.edit('Clean Boundaries', [t.l], () => { for (const [i, o] of r.replace) t.g.objects[i] = o; t.l.erased = [...new Set([...(t.l.erased ?? []), ...r.erase])].sort((a, b) => a - b); });
      ed.clearSelection();
      camEdited();
      notify(`${r.erase.length} draw${r.erase.length === 1 ? '' : 's'} taken out, ${r.replace.size} merged`);
    }),
    cmd('ToolsPoly2Vect', 'Fill Boundaries', (ed) => {
      const ts = ed.selectedObjects().length ? targets(ed) : [];
      if (!ts.length) { notify('Select polygons or closed polylines to fill'); return; }
      let n = 0;
      ed.edit('Fill Boundaries', ts.map((t) => t.l), () => {
        for (const t of ts) {
          const ap = currentAperture(ed, t.l, t.g), a = t.g.apertures.get(ap)!, w = Math.min(a.w, a.h) || a.w;
          for (const { o, i } of t.objs) if (o.kind === 'region') { t.l.erased = [...new Set([...(t.l.erased ?? []), i])]; t.g.objects.push(...fillBoundary(o.contours, ap, w, o.dark)); n++; }
          for (const c of chains(t.objs).filter((x) => x.closed)) { const pts = chainPoints(t.g, c.items).slice(0, -1); t.l.erased = [...new Set([...(t.l.erased ?? []), ...c.items.map((x) => x.i)])]; t.g.objects.push(...fillBoundary([pts], ap, w, true)); n++; }
        }
      });
      ed.clearSelection();
      camEdited();
      notify(n ? `${n} boundar${n === 1 ? 'y' : 'ies'} filled with the current D-code` : 'No closed boundaries selected');
    }),
    cmd('ToolsVect2Out', 'Generate Outlines', (ed) => {
      const ts = targets(ed);
      if (!ts.length) return;
      ask('Generate Outlines', [
        { key: 'to', label: 'Put the outlines on', kind: 'select', value: 'A new layer', options: ['A new layer', 'The same layer'] },
        { key: 'w', label: 'Outline width', kind: 'length', value: mil(1), min: 1 },
      ], (v) => {
        const fresh = v.to === 'A new layer' ? emptyLayer(freshLayerName(ed.doc, `${ts[0]!.l.name.replace(/\.[^.]+$/, '')}_OUTLINE.GBR`), 'Mechanical') : null;
        ed.edit('Generate Outlines', fresh ? 'all' : ts.map((t) => t.l), () => {
          if (fresh) ed.doc.layers = sortLayers([...ed.doc.layers, fresh]);
          for (const t of ts) {
            const dest = fresh ?? t.l, g = dest.data as GerberLayer;
            g.objects.push(...outlinesOf(t.objs.map((x) => x.o), t.g, findOrAddAperture(g, 'C', v.w as number)));
          }
        });
        camEdited();
      });
    }),
    // Reports
    cmd('InfoPCBReport', 'PCB RFQ Report', (ed) => report('PCB RFQ Report', rfqReport(ed.doc, fmtLen, ed.drc ?? undefined, ed.drcClearance))),
    cmd('InspectReport', 'Dcode/Layer Usage', (ed) => report('Dcode/Layer Usage', dcodeUsage(ed.doc, (a) => apertureText(a, fmtLen)))),
    cmd('InspectReportDrcDfm', 'DRC/DFM', (ed) => { if (!ed.drc) { notify('Run Analysis › PCB Design Check first'); return; } report('DRC/DFM', drcReport(ed.drc, fmtLen)); }),
    cmd('InspectReportsRout', 'Rout/Mill', (ed) => report('Rout/Mill', routReport(ed.doc, fmtLen, routePoints))),
    cmd('InspectReportsXYCoordinates', 'X:Y Coordinates', (ed) => report('X:Y Coordinates', xyReport(ed.doc, fmtLen))),
    cmd('FileExportNetList', 'Netlist...', (ed) => { if (!ed.doc.nets) { notify('Extract the netlist first (Tools › Netlist › Extract)'); return; } report('Netlist', netlistReport(ed.doc)); }),
  ];
}

const area2 = (p: Vec2[]) => p.reduce((t, q, i) => t + (q.x * p[(i + 1) % p.length]!.y - p[(i + 1) % p.length]!.x * q.y), 0);
