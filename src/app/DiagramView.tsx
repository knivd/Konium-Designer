/**
 * A diagram (.DgmDoc) in its tab: the Shapes panel (searchable libraries;
 * click a shape to add it, joined to the selected one, or drag it onto the page), the toolbar
 * (zoom, undo, delete, order, fill, line, shadow, waypoints, insert), the page (its paper in page
 * view, its grid), the Format panel (Diagram, or Style / Text / Arrange) and the pages. Shapes move
 * (snapped to the grid), resize by their handles and join by dragging a selected shape's blue
 * dots to another; double-click types a label. A block can be linked to a schematic sheet of the
 * project (Ctrl+click, or the link mark, opens it), and Add Project Sheets lays the project's
 * sheets out as linked blocks, each joined to the sheets below it in the hierarchy.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { activeId, docKeys, notify, projects, tick, type OpenDoc, type Project } from './state';
import {
  addEdge, addPage, addVertex, alignCells, alongRoute, attr, labelPoint, readModel, cellProps, cells, change, distributeCells, labelSource, replaceModel, setCellStyle, setModelAttr, setProperty, copyCells, drawOrder, edgeRoute, extent, groupCells, labelText, layers, layout, moveCells, orderCells, pageName, pasteCells,
  nearestOnRoute, redoDiagram, setLabelRaw, writeDrawio, removeCells, reparentCells, resizeCell, routeKind, setEdgePoints, setLabelPosition, setSheet, setStyle, setStyles, setTerminal, Style, undoDiagram, ungroupCells, type Cell, type DiagramPage, type DrawioDocument, type Layout, type P, type Rect,
} from '../formats/drawio';
import { docBaseName } from '../formats/altium/prjpcb';
import { openProjectDocument } from './actions';
import { projectTree } from './project';
import { openMenuAt } from './MenuBar';
import { ColourIcon } from './icons';
import type { HierNode } from '../model/schHierarchy';
import { EdgeView, EdgeText, fontOf, look, sample, ShadowDef, ShapeView, hex, num } from './diagram/render';
import { sanitise } from './diagram/richtext';
import { RichBar } from './diagram/RichBar';
import { LIBRARIES, sheetEntry, SHEET_STYLE, type Entry, type Library } from './diagram/library';
import { insertEntry, pageLayout, pageSize, pageView, withDefaults } from './diagram/ops';
import { Sidebar } from './diagram/Sidebar';
import { ColourButton, Format, WAYPOINTS, waypointKeys, waypointsOf } from './diagram/Format';
import { connectionPoints, crossings, EDGE_LENGTH, guideSnap, isContainer, isGroup, nearestPoint, portAt, resizeBy, turn, type Guide, type Port } from './diagram/geometry';
import { Layers } from './diagram/Layers';
import { EditStyleDialog } from './diagram/Format';
import { EditDataDialog, EditDiagramDialog, EditLinkDialog, ExportDialog, type DataEdit, type ExportChoice, type ExportKind } from './diagram/dialogs';
import { diagramSvg, pdfHtml, printPagesHtml, svgToPng } from './diagram/export';
import { diagramToVsdx } from './diagram/vsdx';
import { diagramApi, installDiagramMenus } from './diagram/menus';
import { showDialog } from './dialogs';
import { printHtml } from './print';
import { saveFileAs } from '../platform/fs';
import { writeTree } from '../formats/xmlTree';
import { winOf } from './docWindows';

installDiagramMenus();

const projectOf = (od: OpenDoc): Project | null => (od.projectId ? projects.value.find((p) => p.id === od.projectId) ?? null : null);

/** A new connector's style: orthogonal. */
const EDGE_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;';
const ZOOMS = [25, 50, 75, 100, 125, 150, 200, 300, 400];

const views = new Map<string, { pi: number; view: { x: number; y: number; z: number } | null; format: boolean }>();
/** What a drag is doing: moving (with its guides and the container it would go into), resizing (the box on the page), turning, connecting, picking by area. */
type Drag = { kind: 'move'; dx: number; dy: number; guides: Guide[]; into: string | null } | { kind: 'resize'; id: string; r: Rect } | { kind: 'rotate'; id: string; deg: number }
  | { kind: 'connect'; from: string; to: P } | { kind: 'band'; a: P; b: P }
  /** A connector being changed: its ends or waypoints (the connector as it would be), or its label (how far along, how far off) */
  | { kind: 'edge'; id: string; cell: Cell } | { kind: 'label'; id: string; along: number; offset: P };
/** The clipboard: cells copied (their XML) and how many times they have been pasted. */
let clip: { xml: string; n: number } | null = null;
/** A hover arrow's way out of a shape: where on its box, and which way. */
const ARROWS: [number, number, number, number][] = [[0.5, 0, 0, -1], [1, 0.5, 1, 0], [0.5, 1, 0, 1], [0, 0.5, -1, 0]];
const HANDLES: [number, number][] = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];

export function DiagramView({ od }: { od: OpenDoc }) {
  void tick.value;
  const d = od.doc as DrawioDocument;
  const kept = views.get(od.id);
  const [pi, setPi] = useState(kept?.pi ?? 0);
  const page: DiagramPage = d.pages[Math.min(pi, d.pages.length - 1)]!;
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [view, setView] = useState<{ x: number; y: number; z: number } | null>(kept?.view ?? null);
  const [format, setFormat] = useState(kept?.format ?? true);
  // The page, view and panels kept for when the tab comes back
  useEffect(() => { views.set(od.id, { pi, view, format }); }, [pi, view, format]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [ghost, setGhost] = useState<{ x: Entry; at: P } | null>(null);
  const [edit, setEdit] = useState<{ id: string; text: string; html: boolean; orig: string } | null>(null);
  const richEl = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [, redraw] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const changed = () => { tick.value++; redraw((x) => x + 1); };
  const list = useMemo(() => drawOrder(cells(page)), [page, tick.value, d.undo.length, d.redo.length]);
  const L: Layout = useMemo(() => layout(list), [list]);
  // Layers: hidden ones aren't drawn; a locked one's cells can't be picked; a locked cell can't be moved, resized or deleted
  const lays = useMemo(() => layers(page), [list]);
  const layerOf = (c: Cell): string => { let x: Cell | undefined = c; for (let n = 0; x && n < 60; n++) { const par = L.byId.get(x.parent); if (!par || !par.parent) return x.id; x = par; } return ''; };
  const hiddenLayers = new Set(lays.filter((l) => !l.visible).map((l) => l.id)), lockedLayers = new Set(lays.filter((l) => l.locked).map((l) => l.id));
  const shown = (c: Cell) => !hiddenLayers.has(layerOf(c)) && attr(c.node, 'visible') !== '0';
  const frozen = (c: Cell) => lockedLayers.has(layerOf(c));
  const locked = (c: Cell | undefined) => !!c && (frozen(c) || look(c.style, 'locked') === '1');
  const dragging = useRef(false);
  // The selection holds only cells on the page, shown and on an unlocked layer: a layer hidden, locked or deleted lets its cells go
  useEffect(() => {
    const live = [...sel].filter((id) => { const c = L.byId.get(id); return !!c && shown(c) && !frozen(c); });
    if (live.length !== sel.size) setSel(new Set(live));
  });
  const m = page.model;
  const grid = Number(attr(m, 'gridSize') ?? 10) || 10;
  const gridOn = attr(m, 'grid') !== '0';
  const snap = (v: number) => (gridOn ? Math.round(v / grid) * grid : Math.round(v));
  const p = projectOf(od);
  const sheets = (p?.prj.documents ?? []).map(docBaseName).filter((n) => /\.schdoc$/i.test(n));
  const libs: Library[] = useMemo(() => [...LIBRARIES, ...(sheets.length ? [{ id: 'project', title: 'Project Sheets', entries: sheets.map(sheetEntry) }] : [])], [sheets.join('|')]);
  const paged = pageView(m);
  const psize = pageSize(m);
  const content = extent(list, L);
  const pages = paged ? pageLayout(psize, content) : [];

  const fitTo = (e: Rect) => {
    const h = host.current;
    if (!h) return;
    const z = Math.min(2, Math.max(0.05, Math.min((h.clientWidth - 60) / Math.max(e.w, 100), (h.clientHeight - 60) / Math.max(e.h, 100))));
    setView({ z, x: e.x + e.w / 2 - h.clientWidth / 2 / z, y: e.y + e.h / 2 - h.clientHeight / 2 / z });
  };
  const fit = () => fitTo(content ?? (paged ? pages[0]! : { x: 0, y: 0, w: 800, h: 500 }));
  const fitPage = () => { if (!pages.length) { fit(); return; } const x0 = Math.min(...pages.map((q) => q.x)), y0 = Math.min(...pages.map((q) => q.y)); fitTo({ x: x0, y: y0, w: Math.max(...pages.map((q) => q.x + q.w)) - x0, h: Math.max(...pages.map((q) => q.y + q.h)) - y0 }); };
  const first = useRef(true);
  useEffect(() => {
    if (first.current && kept?.view) { first.current = false; return; }
    first.current = false;
    fit(); setSel(new Set());
  }, [pi, od.id]);
  const v = view ?? { x: -20, y: -20, z: 1 };
  const zoomTo = (z: number) => {
    const h = host.current;
    const cx = v.x + (h?.clientWidth ?? 800) / 2 / v.z, cy = v.y + (h?.clientHeight ?? 600) / 2 / v.z;
    const nz = Math.min(8, Math.max(0.05, z));
    setView({ z: nz, x: cx - (h?.clientWidth ?? 800) / 2 / nz, y: cy - (h?.clientHeight ?? 600) / 2 / nz });
  };
  const toModel = (cx: number, cy: number): P => { const b = svg.current!.getBoundingClientRect(); return { x: v.x + (cx - b.left) / v.z, y: v.y + (cy - b.top) / v.z }; };
  const overCanvas = (cx: number, cy: number) => { const b = svg.current?.getBoundingClientRect(); return !!b && cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom; };

  const vertexAt = (q: P, not?: string): Cell | undefined => [...list].reverse().find((c) => {
    if (!c.vertex || c.id === not || c.relative || !shown(c) || frozen(c)) return false;
    const r = L.abs.get(c.id);
    return !!r && q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h;
  });
  const openSheet = (c: Cell) => {
    if (!c.sheet) return false;
    if (!p) { notify(`${c.sheet}: the diagram isn't in a project`, 'error'); return true; }
    const path = p.prj.documents.find((x) => docBaseName(x).toLowerCase() === c.sheet.toLowerCase());
    if (!path) { notify(`${c.sheet} isn't in ${p.name}`, 'error'); return true; }
    openProjectDocument(p, path);
    return true;
  };

  const del = () => { const ids = new Set([...sel].filter((id) => { const c = L.byId.get(id); return !!c && shown(c) && !locked(c); })); if (!ids.size) return; change(d, 'Delete', () => removeCells(page, ids), page); setSel(new Set()); changed(); };
  const copy = () => { if (sel.size) clip = { xml: copyCells(page, sel), n: 0 }; };
  const paste = () => {
    if (!clip) return;
    const c = clip; c.n++;
    let ids: string[] = [];
    change(d, 'Paste', () => { ids = pasteCells(page, c.xml, grid * c.n, grid * c.n); }, page);
    setSel(new Set(ids)); changed();
  };
  const group = () => { if (sel.size < 1) return; let g = ''; change(d, 'Group', () => { g = groupCells(page, sel); }, page); if (g) setSel(new Set([g])); changed(); };
  const ungroup = () => { if (!sel.size) return; let freed: string[] = []; change(d, 'Ungroup', () => { freed = ungroupCells(page, sel); }, page); setSel(new Set(freed)); changed(); };
  const lock = () => { if (!sel.size) return; const on = [...sel].some((id) => look(L.byId.get(id)?.style ?? new Style([]), 'locked') !== '1'); change(d, on ? 'Lock' : 'Unlock', () => setStyle(page, sel, 'locked', on ? '1' : null), page); changed(); };
  const order = (how: 'front' | 'back') => { if (!sel.size) return; change(d, how === 'front' ? 'To Front' : 'To Back', () => orderCells(page, sel, how), page); changed(); };
  /** Ctrl+D: the selection copied beside itself, connectors between its shapes and linked sheets kept. */
  const duplicate = () => {
    if (!sel.size) return;
    const xml = copyCells(page, sel);
    let ids: string[] = [];
    change(d, 'Duplicate', () => { ids = pasteCells(page, xml, grid, grid); }, page);
    setSel(new Set(ids)); changed();
  };

  /* Library entries: placed where dropped; a click adds one beside the selected shape, joined to it (else in the middle of the view) */
  /** The container a point is over (not one of `not` or inside them). */
  const containerAt = (q: P, not: Set<string> = new Set()): Cell | undefined => [...list].reverse().find((c) => {
    if (!c.vertex || c.relative || !shown(c) || frozen(c) || !isContainer(c)) return false;
    for (let x: Cell | undefined = c, n = 0; x && n < 60; x = L.byId.get(x.parent), n++) if (not.has(x.id)) return false;
    const r = L.abs.get(c.id);
    return !!r && q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h;
  });
  const place = (x: Entry, centre: P, from?: Cell) => {
    let ids: string[] = [];
    const into = x.edge ? undefined : containerAt(centre);
    change(d, `Add ${x.title}`, () => {
      ids = insertEntry(page, x, { x: snap(centre.x - x.w / 2), y: snap(centre.y - x.h / 2) });
      if (into && ids[0]) reparentCells(page, [ids[0]], into.id);
      if (from && !x.edge && ids[0]) addEdge(page, from.id, ids[0], withDefaults(EDGE_STYLE, 'edge'));
    }, page);
    if (ids[0]) setSel(new Set([ids[0]]));
    setHover(null); changed();
  };
  // For a picture read in the meantime: placed on the page as it is when it has been read
  const placeLater = useRef(place);
  placeLater.current = place;
  const addEntry = (x: Entry) => {
    const one = sel.size === 1 ? list.find((c) => sel.has(c.id) && c.vertex && !c.relative) : undefined;
    const r = one ? L.abs.get(one.id) : undefined;
    if (one && r && !x.edge) {
      // To its right, clear of other shapes
      const at = { x: r.x + r.w + EDGE_LENGTH + x.w / 2, y: r.y + r.h / 2 };
      const clash = (q: P) => list.some((c) => { const b = c.vertex && !c.relative ? L.abs.get(c.id) : undefined; return !!b && c.id !== one.id && q.x + x.w / 2 > b.x && q.x - x.w / 2 < b.x + b.w && q.y + x.h / 2 > b.y && q.y - x.h / 2 < b.y + b.h; });
      for (let n = 0; n < 20 && clash(at); n++) at.y += x.h + 2 * grid;
      place(x, at, one);
      return;
    }
    const h = host.current;
    place(x, { x: v.x + (h?.clientWidth ?? 800) / 2 / v.z, y: v.y + (h?.clientHeight ?? 600) / 2 / v.z });
  };
  const pressEntry = (x: Entry, e: PointerEvent) => {
    const window = winOf(e);
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const mv = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4) moved = true;
      if (moved) setGhost(overCanvas(ev.clientX, ev.clientY) ? { x, at: toModel(ev.clientX, ev.clientY) } : null);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      setGhost(null);
      if (!moved) { addEntry(x); return; }
      if (overCanvas(ev.clientX, ev.clientY)) place(x, toModel(ev.clientX, ev.clientY));
      host.current?.focus();
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  // Keys while the diagram is in front (the handler of this render: keys pressed in quick succession see the selection the last one made)
  {
    docKeys.set(od.id, (key) => {
      if (activeId.value !== od.id || edit) return false;
      // While something is dragged, nothing else changes the diagram (Ctrl+Z would leave the drag's page behind)
      if (dragging.current) return true;
      if (key === 'Delete' || key === 'Backspace') { del(); return true; }
      if (key === 'Ctrl+Z') { if (undoDiagram(d)) { setSel(new Set()); changed(); } return true; }
      if (key === 'Ctrl+Y' || key === 'Ctrl+Shift+Z') { if (redoDiagram(d)) { setSel(new Set()); changed(); } return true; }
      if (key === 'Ctrl+A') { setSel(new Set(list.filter((c) => (c.vertex || c.edge) && shown(c) && !frozen(c)).map((c) => c.id))); return true; }
      if (key === 'Ctrl+D') { duplicate(); return true; }
      if (key === 'Ctrl+C') { copy(); return true; }
      if (key === 'Ctrl+X') { copy(); del(); return true; }
      if (key === 'Ctrl+V') { paste(); return true; }
      if (key === 'Ctrl+G') { group(); return true; }
      if (key === 'Ctrl+Shift+U') { ungroup(); return true; }
      if (key === 'Ctrl+L') { lock(); return true; }
      if (key === 'Ctrl+Shift+L') { setLayersOpen(!layersOpen); return true; }
      if (key === 'Ctrl+Shift+I') { setSel(new Set(list.filter((c) => c.vertex && !c.relative && shown(c) && !frozen(c)).map((c) => c.id))); return true; }
      if (key === 'Ctrl+E') { editStyle(); return true; }
      if (key === 'Ctrl+M') { editData(); return true; }
      if (key === 'Alt+Shift+L') { editLink(); return true; }
      if (key === 'Ctrl+F') { setFind({ q: find?.q ?? '', i: -1 }); return true; }
      if (key === 'Ctrl+P') { print(); return true; }
      if (key === 'Ctrl+Shift+A') { setSel(new Set()); return true; }
      if (key === 'Ctrl+R') { rotate90(); return true; }
      if (key === 'Ctrl+Shift+E') { setSel(new Set(list.filter((c) => c.edge && shown(c) && !frozen(c)).map((c) => c.id))); return true; }
      if (key === 'Ctrl+Shift+F') { order('front'); return true; }
      if (key === 'Ctrl+Shift+B') { order('back'); return true; }
      if (key === 'Ctrl+Shift+P') { setFormat(!format); return true; }
      if (key === 'Ctrl+Shift+H') { fit(); return true; }
      if (key === 'Ctrl+H') { zoomTo(1); return true; }
      if (key === 'Ctrl+=' || key === 'Ctrl++' || key === 'Ctrl+Shift+=') { zoomTo(v.z * 1.25); return true; }
      if (key === 'Ctrl+-') { zoomTo(v.z / 1.25); return true; }
      if (key === 'Escape') { setSel(new Set()); return true; }
      const arrow = /^(Shift\+)?(ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/.exec(key);
      if (arrow && sel.size && ![...sel].some((id) => locked(L.byId.get(id)))) {
        const k = arrow[1] ? grid : 1, dir = arrow[2]!;
        change(d, 'Move', () => moveCells(page, sel, dir === 'ArrowLeft' ? -k : dir === 'ArrowRight' ? k : 0, dir === 'ArrowUp' ? -k : dir === 'ArrowDown' ? k : 0), page);
        changed(); return true;
      }
      return false;
    });
  }
  useEffect(() => () => { docKeys.delete(od.id); diagramApi.delete(od.id); }, [od.id]);

  /* Pointer: shapes, handles, connection points, the page */
  const track = (on: (q: P) => void, done: (q: P) => void) => {
    dragging.current = true;
    // (the window the diagram is in: it may be a document window)
    const window = winOf(host.current);
    const mv = (e: PointerEvent) => on(toModel(e.clientX, e.clientY));
    const up = (e: PointerEvent) => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); dragging.current = false; done(toModel(e.clientX, e.clientY)); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  /** What a click on a cell picks: the group round it until that group is picked, then the cell (as the editors do). */
  const pickOf = (c: Cell): Cell => {
    const chain: Cell[] = [];
    for (let x = L.byId.get(c.parent), n = 0; x?.vertex && n < 60; x = L.byId.get(x.parent), n++) chain.push(x);
    for (let i = chain.length - 1; i >= 0; i--) { const g = chain[i]!; if (isGroup(g) && !sel.has(g.id) && !chain.slice(0, i).some((k) => sel.has(k.id)) && !sel.has(c.id)) return g; }
    return c;
  };
  const downCell = (e: PointerEvent, c0: Cell) => {
    if (e.button !== 0) return;
    // A cell on a locked layer can't be picked: the page's (an area)
    if (frozen(c0)) return;
    e.stopPropagation();
    host.current?.focus();
    if ((e.ctrlKey || e.metaKey) && (openSheet(c0) || openLink(c0))) return;
    const c = pickOf(c0);
    // A picked shape among others stays with them (to move them all); a click without moving picks it alone
    const was = sel.has(c.id) && sel.size > 1 && !e.shiftKey;
    const next = e.shiftKey ? new Set(sel) : sel.has(c.id) && c.vertex ? new Set(sel) : new Set<string>();
    if (e.shiftKey && sel.has(c.id)) next.delete(c.id); else next.add(c.id);
    setSel(next);
    if (!c.vertex || e.shiftKey || [...next].some((id) => locked(L.byId.get(id)))) return;
    const a = toModel(e.clientX, e.clientY);
    // The shapes moving (not those whose parent moves too), their box, and the shapes to line up with
    const tops = list.filter((x) => next.has(x.id) && x.vertex && !x.relative && !next.has(x.parent));
    const box = extent(tops, L);
    const inside = (x: Cell) => { for (let y: Cell | undefined = x, n = 0; y && n < 60; y = L.byId.get(y.parent), n++) if (next.has(y.id)) return true; return false; };
    const others = list.filter((x) => x.vertex && !x.relative && shown(x) && !inside(x) && L.abs.get(x.id)).map((x) => L.abs.get(x.id)!);
    const guidesOn = attr(m, 'guides') !== '0';
    const moved = new Set(tops.map((x) => x.id));
    let dx = 0, dy = 0, into: string | null = null, q1 = a;
    track((q) => {
      q1 = q;
      const rx = q.x - a.x, ry = q.y - a.y;
      dx = snap(rx); dy = snap(ry);
      let guides: Guide[] = [];
      if (guidesOn && box) {
        const g = guideSnap({ ...box, x: box.x + rx, y: box.y + ry }, others, 6 / v.z);
        if (g.dx !== null) dx = rx + g.dx;
        if (g.dy !== null) dy = ry + g.dy;
        guides = g.lines;
      }
      into = containerAt(q, moved)?.id ?? null;
      setDrag({ kind: 'move', dx, dy, guides, into });
    }, () => {
      setDrag(null);
      // Into the container dropped on; out of its container when dropped outside it (a group keeps its cells)
      const outOf = tops.filter((x) => { const par = L.byId.get(x.parent); return !into && !!par?.vertex && isContainer(par) && !containerAt(q1, moved); });
      const intoIds = into ? tops.filter((x) => x.parent !== into).map((x) => x.id) : [];
      if (!dx && !dy && !intoIds.length && !outOf.length) { if (was) setSel(new Set([c.id])); return; }
      change(d, 'Move', () => {
        if (dx || dy) moveCells(page, next, dx, dy);
        if (into && intoIds.length) reparentCells(page, intoIds, into);
        for (const x of outOf) reparentCells(page, [x.id], layerOf(x));
      }, page);
      changed();
    });
  };
  const downHandle = (e: PointerEvent, c: Cell, h: [number, number]) => {
    e.stopPropagation();
    const r0 = L.abs.get(c.id)!;
    const off = { x: r0.x - c.rect.x, y: r0.y - c.rect.y };
    const rot = num(c.style, 'rotation', 0);
    const a = toModel(e.clientX, e.clientY);
    let r = r0;
    track((q) => {
      const raw = { x: q.x - a.x, y: q.y - a.y };
      const dd = rot % 360 ? raw : { x: snap(raw.x), y: snap(raw.y) };
      r = resizeBy(r0, rot, h, dd, e.shiftKey || look(c.style, 'aspect') === 'fixed');
      setDrag({ kind: 'resize', id: c.id, r });
    }, () => { setDrag(null); if (r !== r0) { change(d, 'Resize', () => resizeCell(page, c.id, { x: r.x - off.x, y: r.y - off.y, w: r.w, h: r.h }), page); changed(); } });
  };
  /** The turning handle: by 15° steps (Alt held: freely). */
  const downRotate = (e: PointerEvent, c: Cell) => {
    e.stopPropagation();
    const r = L.abs.get(c.id)!;
    const ctr = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    const rot0 = num(c.style, 'rotation', 0);
    const a = toModel(e.clientX, e.clientY);
    const a0 = Math.atan2(a.y - ctr.y, a.x - ctr.x);
    let deg = rot0;
    track((q) => {
      let k = rot0 + ((Math.atan2(q.y - ctr.y, q.x - ctr.x) - a0) * 180) / Math.PI;
      if (!e.altKey) k = Math.round(k / 15) * 15;
      deg = ((Math.round(k) % 360) + 360) % 360;
      setDrag({ kind: 'rotate', id: c.id, deg });
    }, () => { setDrag(null); if (deg !== rot0) { change(d, 'Rotate', () => setStyle(page, [c.id], 'rotation', deg ? String(deg) : null), page); changed(); } });
  };
  /** A connector from a shape to another, its end on the connection point dropped on (else the shape's outline). */
  const connectTo = (from: Cell, t: Cell, q: P) => {
    const tr = L.abs.get(t.id)!;
    const f = nearestPoint(tr, t, connectionPoints(t), q, 10 / v.z);
    let id = '';
    const style = withDefaults(EDGE_STYLE, 'edge') + (f ? `entryX=${f.x};entryY=${f.y};entryDx=0;entryDy=0;${f.perimeter ? '' : 'entryPerimeter=0;'}` : '');
    change(d, 'Connect', () => { id = addEdge(page, from.id, t.id, style); }, page);
    setSel(new Set([id])); changed();
  };
  /** A copy of a shape at a point (its centre), joined to it. */
  const cloneAt = (c: Cell, centre: P) => {
    const r = L.abs.get(c.id)!;
    const off = { x: r.x - c.rect.x, y: r.y - c.rect.y };
    let id = '';
    change(d, 'Clone', () => {
      id = addVertex(page, { x: snap(centre.x - r.w / 2) - off.x, y: snap(centre.y - r.h / 2) - off.y, w: r.w, h: r.h }, c.value, c.style.toString(), c.parent);
      addEdge(page, c.id, id, withDefaults(EDGE_STYLE, 'edge'));
    }, page);
    setSel(new Set([id])); setHover(null); changed();
  };
  /** A hover arrow: clicked, a copy of the shape that way, joined to it; dragged, a connector to the shape dropped on (or a copy where dropped). */
  const downArrow = (e: PointerEvent, c: Cell, dir: [number, number]) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const s0 = { x: e.clientX, y: e.clientY };
    let moved = false;
    track((q) => {
      const b = svg.current!.getBoundingClientRect();
      if (!moved && Math.hypot(v.x + (s0.x - b.left) / v.z - q.x, v.y + (s0.y - b.top) / v.z - q.y) * v.z > 4) moved = true;
      if (moved) setDrag({ kind: 'connect', from: c.id, to: q });
    }, (q) => {
      setDrag(null);
      const r = L.abs.get(c.id)!;
      if (!moved) {
        // Its copy that way, clear of other shapes
        const at = { x: r.x + r.w / 2 + dir[0] * (r.w + EDGE_LENGTH), y: r.y + r.h / 2 + dir[1] * (r.h + EDGE_LENGTH) };
        const clash = (p0: P) => list.some((x) => { const o = x.vertex && !x.relative && shown(x) ? L.abs.get(x.id) : undefined; return !!o && x.id !== c.id && p0.x + r.w / 2 > o.x && p0.x - r.w / 2 < o.x + o.w && p0.y + r.h / 2 > o.y && p0.y - r.h / 2 < o.y + o.h; });
        for (let n = 0; n < 20 && clash(at); n++) { if (dir[0]) at.y += r.h + 2 * grid; else at.x += r.w + 2 * grid; }
        cloneAt(c, at);
        return;
      }
      const t = vertexAt(q, c.id);
      if (t) connectTo(c, t, q); else cloneAt(c, q);
    });
  };
  /** Which shape the pointer is over (or near enough for its arrows). */
  const hoverAt = (e: PointerEvent) => {
    if (drag || edit || ghost) return;
    const q = toModel(e.clientX, e.clientY), k = 34 / v.z;
    const c = [...list].reverse().find((x) => {
      if (!x.vertex || x.relative || !shown(x) || frozen(x) || x.style.shape() === 'edgeLabel') return false;
      const r = L.abs.get(x.id);
      return !!r && q.x >= r.x - k && q.x <= r.x + r.w + k && q.y >= r.y - k && q.y <= r.y + r.h + k && (x.id === hover || (q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h));
    });
    const id = c?.id ?? null;
    if (id !== hover) setHover(id);
  };
  /* A selected connector: its ends (drag onto a shape, a connection point or loose), its waypoints and segments, its label */
  /** The frame a connector's points are in (a group's, else the page). */
  const frameOfEdge = (c: Cell): P => { const par = L.byId.get(c.parent); const r = par?.vertex ? L.abs.get(par.id) : undefined; return r ? { x: r.x, y: r.y } : { x: 0, y: 0 }; };
  const editEdge = (c: Cell, change0: (x: Cell) => Cell, commit: (x: Cell) => void) => {
    let cur = c;
    void change0;
    return { move: (x: Cell) => { cur = x; setDrag({ kind: 'edge', id: c.id, cell: x }); }, done: () => { setDrag(null); if (cur !== c) commit(cur); } };
  };
  const downEnd = (e: PointerEvent, c: Cell, source: boolean) => {
    e.stopPropagation();
    if (e.button !== 0 || locked(c)) return;
    const fr = frameOfEdge(c);
    let to: { cell: string | null; at?: P; fixed: Port | null } | null = null;
    const ed = editEdge(c, (x) => x, () => {
      if (!to) return;
      const t = to;
      change(d, source ? 'Move Start' : 'Move End', () => setTerminal(page, c.id, source, t.cell, t.at, t.fixed), page);
      changed();
    });
    track((q) => {
      const t = vertexAt(q);
      const tr = t ? L.abs.get(t.id) : undefined;
      const f = t && tr ? nearestPoint(tr, t, connectionPoints(t), q, 10 / v.z) : null;
      const at = { x: snap(q.x) - fr.x, y: snap(q.y) - fr.y };
      to = t && t.id !== c.id ? { cell: t.id, fixed: f } : { cell: null, at, fixed: null };
      const st = Style.parse(c.style.toString()), pre = source ? 'exit' : 'entry';
      for (const k of ['X', 'Y', 'Dx', 'Dy', 'Perimeter']) st.set(pre + k, null);
      if (to.cell && f) { st.set(`${pre}X`, String(f.x)); st.set(`${pre}Y`, String(f.y)); if (!f.perimeter) st.set(`${pre}Perimeter`, '0'); }
      ed.move({ ...c, style: st, ...(source ? { source: to.cell ?? '', sourcePoint: to.at } : { target: to.cell ?? '', targetPoint: to.at }) });
    }, () => ed.done());
  };
  /** A waypoint dragged (index i), or one put in at a segment (insert), or a segment of a square route moved across. */
  const downPoint = (e: PointerEvent, c: Cell, how: { move: number } | { insert: number } | { segment: number; route: P[] }) => {
    e.stopPropagation();
    if (e.button !== 0 || locked(c)) return;
    const fr = frameOfEdge(c);
    const base = c.points.map((q) => ({ x: q.x + fr.x, y: q.y + fr.y }));
    let pts: P[] | null = null;
    const ed = editEdge(c, (x) => x, () => { if (pts) { const out = pts.map((q) => ({ x: q.x - fr.x, y: q.y - fr.y })); change(d, 'Move Waypoint', () => setEdgePoints(page, c.id, out), page); changed(); } });
    track((q0) => {
      const q = { x: snap(q0.x), y: snap(q0.y) };
      if ('move' in how) { pts = base.map((p0, k) => (k === how.move ? q : p0)); }
      else if ('insert' in how) { pts = [...base.slice(0, how.insert), q, ...base.slice(how.insert)]; }
      else {
        // The segment's two corners move across with it; the route's corners are the waypoints
        const r = how.route.map((p0) => ({ ...p0 }));
        const a = r[how.segment]!, b = r[how.segment + 1]!;
        if (Math.abs(a.y - b.y) < 1e-6) { a.y = q.y; b.y = q.y; } else { a.x = q.x; b.x = q.x; }
        const kind = routeKind(c.style);
        pts = kind === 'elbow' ? [{ x: a.x, y: (a.y + b.y) / 2 }] : kind === 'elbowVertical' ? [{ x: (a.x + b.x) / 2, y: a.y }] : r.slice(1, -1);
      }
      ed.move({ ...c, points: pts.map((p0) => ({ x: p0.x - fr.x, y: p0.y - fr.y })) });
    }, () => ed.done());
  };
  const removePoint = (c: Cell, i: number) => { const pts = c.points.filter((_, k) => k !== i); change(d, 'Remove Waypoint', () => setEdgePoints(page, c.id, pts), page); changed(); };
  /** A connector's label (its own, or a label cell on it) dragged along it and off it. */
  const downLabel = (e: PointerEvent, edge: Cell, label: Cell) => {
    e.stopPropagation();
    if (e.button !== 0 || locked(edge)) return;
    const route = routeOf(edge);
    let pos: { along: number; offset: P } | null = null;
    track((q) => {
      const n = nearestOnRoute(route, q);
      pos = { along: Math.round(n.along * 1000) / 1000, offset: { x: Math.round(q.x - n.at.x), y: Math.round(q.y - n.at.y) } };
      setDrag({ kind: 'label', id: label.id, ...pos });
    }, () => { setDrag(null); const p0 = pos; if (p0) { change(d, 'Move Label', () => setLabelPosition(page, label.id, p0.along, p0.offset), page); changed(); } });
  };
  /** Line jumps: the points a connector with jumpStyle crosses connectors drawn before it. */
  const jumpsOf = (c: Cell, route: P[]): P[] => {
    if ((look(c.style, 'jumpStyle') ?? 'none') === 'none') return [];
    const before: P[][] = [];
    for (const x of list) { if (x.id === c.id) break; if (x.edge && shown(x)) before.push(routeOf(x)); }
    return crossings(route, before);
  };

  /* Edit Style, Edit Data, Edit Link, Edit Diagram; find; links; export and print */
  const editStyle = () => {
    const first = list.find((c) => sel.has(c.id));
    if (!first) return;
    const ids = [...sel];
    showDialog(EditStyleDialog, { style: first.style.toString(), apply: (t: string) => { change(d, 'Edit Style', () => setCellStyle(page, ids, t), page); changed(); } });
  };
  const editData = () => {
    const c = sel.size === 1 ? list.find((x) => sel.has(x.id)) : undefined;
    if (!c) return;
    const before = cellProps(c);
    showDialog(EditDataDialog, { id: c.id, props: before, placeholders: look(c.style, 'placeholders') === '1', tooltip: attr(c.wrap, 'tooltip') ?? '', apply: (x: DataEdit) => {
      change(d, 'Edit Data', () => {
        for (const [k] of before) if (!x.props.some(([n]) => n === k)) setProperty(page, c.id, k, null);
        for (const [k, val] of x.props) setProperty(page, c.id, k, val);
        setProperty(page, c.id, 'tooltip', x.tooltip || null);
        setStyle(page, [c.id], 'placeholders', x.placeholders ? '1' : null);
      }, page);
      changed();
    } });
  };
  const pageIds = () => d.pages.map((pg, i) => ({ id: attr(pg.node, 'id') ?? '', name: pageName(pg, i) })).filter((x) => x.id);
  const editLink = () => {
    const c = sel.size === 1 ? list.find((x) => sel.has(x.id)) : undefined;
    if (!c) return;
    showDialog(EditLinkDialog, { link: c.link, pages: pageIds(), apply: (url: string) => { if (url === c.link) return; change(d, url ? 'Edit Link' : 'Remove Link', () => setProperty(page, c.id, 'link', url || null), page); changed(); } });
  };
  /** A shape's link followed: another page of the diagram, or a web address in a new tab. */
  const openLink = (c: Cell): boolean => {
    if (!c.link) return false;
    const pg = /^data:page\/id,(.*)$/.exec(c.link)?.[1];
    if (pg !== undefined) { const i = d.pages.findIndex((x) => attr(x.node, 'id') === pg); if (i >= 0) setPi(i); else notify('That page isn\'t in the diagram any more', 'error'); return true; }
    if (/^(https?:|mailto:)/i.test(c.link)) window.open(c.link, '_blank', 'noopener');
    else notify(`${c.link}: not a web address`, 'error');
    return true;
  };
  const editDiagram = () => {
    showDialog(EditDiagramDialog, { xml: writeTree(page.model), apply: (x: string) => {
      // Checked first: a refused XML changes nothing (and a corrected one goes to the page as it is now)
      if (!readModel(x)) return false;
      const pg = d.pages[Math.min(pi, d.pages.length - 1)] ?? page;
      change(d, 'Edit Diagram', () => { replaceModel(d, pg, x); }, pg);
      setSel(new Set()); changed();
      return true;
    } });
  };
  const rotate90 = () => { const ids = [...sel].filter((id) => L.byId.get(id)?.vertex); if (!ids.length) return; change(d, 'Rotate', () => { for (const id of ids) { const c = L.byId.get(id)!; setStyle(page, [id], 'rotation', String((num(c.style, 'rotation', 0) + 90) % 360)); } }, page); changed(); };
  const flip = (h: boolean) => { const ids = [...sel].filter((id) => L.byId.get(id)?.vertex); if (!ids.length) return; const k = h ? 'flipH' : 'flipV'; const on1 = look(L.byId.get(ids[0]!)!.style, k) !== '1'; change(d, h ? 'Flip Horizontal' : 'Flip Vertical', () => setStyle(page, ids, k, on1 ? '1' : null), page); changed(); };
  const baseName = d.name.replace(/\.[^.]+$/, '');
  const exportAs = (kind: ExportKind) => showDialog(ExportDialog, { kind, hasSelection: sel.size > 0, run: (o: ExportChoice) => {
    const only = o.selection ? new Set(sel) : undefined;
    const { svg, w, h } = diagramSvg(page, { border: o.border, transparent: o.transparent, only });
    if (kind === 'pdf') { printHtml(pdfHtml(svg, w, h)); notify('In the print dialog choose “Save as PDF” as the destination'); return; }
    void (async () => {
      try {
        if (kind === 'svg') await saveFileAs(`${baseName}.svg`, new TextEncoder().encode(svg));
        else await saveFileAs(`${baseName}.png`, await svgToPng(svg, w, h, o.scale));
      } catch (e) { notify(`Export: ${(e as Error).message}`, 'error'); }
    })();
  } });
  const print = () => printHtml(printPagesHtml(page, paged));
  /** A picture (PNG, JPEG, GIF, SVG, WebP, BMP) put in the diagram where dropped, or in the middle of the view: kept in the file, up to 400 px across. */
  const imageInput = useRef<HTMLInputElement>(null);
  const insertImage = (f: File, at?: P) => {
    if (!/^image\/(png|jpeg|gif|svg\+xml|webp|bmp)$/.test(f.type)) { notify(`${f.name}: not a picture Konium Designer puts in a diagram`, 'error'); return; }
    const rd = new FileReader();
    rd.onload = () => {
      const url = String(rd.result);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 400 / Math.max(img.naturalWidth || 100, img.naturalHeight || 100));
        const w = Math.max(10, Math.round((img.naturalWidth || 100) * k)), h = Math.max(10, Math.round((img.naturalHeight || 100) * k));
        const hh = host.current;
        const c = at ?? { x: v.x + (hh?.clientWidth ?? 800) / 2 / v.z, y: v.y + (hh?.clientHeight ?? 600) / 2 / v.z };
        // The style keeps it as data:image/…,<base64> (a ; would end the style's value)
        placeLater.current({ title: 'Image', style: `shape=image;verticalLabelPosition=bottom;verticalAlign=top;imageAspect=0;aspect=fixed;image=${url.replace(';base64,', ',')};`, w, h, value: '' }, c);
      };
      img.onerror = () => notify(`${f.name}: the picture couldn't be read`, 'error');
      img.src = url;
    };
    rd.readAsDataURL(f);
  };
  const isPictureDrag = (e: DragEvent) => [...(e.dataTransfer?.items ?? [])].some((it) => it.kind === 'file' && /^image\//.test(it.type));
  /** The diagram as another tool's file: .drawio (its XML as it is), or a Visio drawing. */
  const exportFile = (kind: 'drawio' | 'vsdx') => {
    void (async () => {
      try {
        if (kind === 'drawio') { await saveFileAs(`${baseName}.drawio`, writeDrawio(d)); return; }
        const { bytes, notes } = diagramToVsdx(d);
        await saveFileAs(`${baseName}.vsdx`, bytes);
        if (notes.length) notify(`Visio drawing: ${notes.join('; ')}`);
      } catch (e) { notify(`Export: ${(e as Error).message}`, 'error'); }
    })();
  };
  const [find, setFind] = useState<{ q: string; i: number } | null>(null);
  /** Find: the next shape or connector whose label has the words, picked and brought into view. */
  const findNext = (q: string, from: number) => {
    const want = q.trim().toLowerCase();
    if (!want) return;
    const hits = list.filter((c) => (c.vertex || c.edge) && shown(c) && labelText(c).toLowerCase().includes(want));
    if (!hits.length) { notify(`No label has “${q.trim()}”`, 'error'); setFind({ q, i: -1 }); return; }
    const i = (from + 1) % hits.length, c = hits[i]!;
    setFind({ q, i });
    setSel(new Set([c.id]));
    const r = c.vertex ? L.abs.get(c.id) : (() => { const q0 = alongRoute(edgeRoute(c, L), 0); return { x: q0.x, y: q0.y, w: 0, h: 0 }; })();
    const h = host.current;
    if (r && h) setView({ ...v, x: r.x + r.w / 2 - h.clientWidth / 2 / v.z, y: r.y + r.h / 2 - h.clientHeight / 2 / v.z });
  };

  const downPage = (e: PointerEvent) => {
    host.current?.focus();
    if (edit) return;
    const a = toModel(e.clientX, e.clientY);
    // Middle button, or Alt held: the page moves
    if (e.button === 1 || e.altKey) {
      e.preventDefault();
      const v0 = v, c0 = { x: e.clientX, y: e.clientY };
      const window = winOf(e);
      const mv = (ev: PointerEvent) => setView({ ...v0, x: v0.x - (ev.clientX - c0.x) / v0.z, y: v0.y - (ev.clientY - c0.y) / v0.z });
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
      return;
    }
    if (e.button !== 0) return;
    if (!e.shiftKey) setSel(new Set());
    let b = a;
    track((q) => { b = q; setDrag({ kind: 'band', a, b }); }, () => {
      setDrag(null);
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      if (x1 - x0 < 2 && y1 - y0 < 2) return;
      const inside = (r: Rect) => r.x >= x0 && r.y >= y0 && r.x + r.w <= x1 && r.y + r.h <= y1;
      const hit = list.filter((c) => (c.vertex && !c.relative && L.abs.get(c.id) && inside(L.abs.get(c.id)!)) || (c.edge && edgeRoute(c, L).every((q) => q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1)));
      setSel(new Set([...(e.shiftKey ? sel : []), ...hit.map((c) => c.id)]));
    });
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const q = toModel(e.clientX, e.clientY), z = Math.min(8, Math.max(0.05, v.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const b = svg.current!.getBoundingClientRect();
      setView({ z, x: q.x - (e.clientX - b.left) / z, y: q.y - (e.clientY - b.top) / z });
    } else setView({ ...v, x: v.x + (e.shiftKey ? e.deltaY : e.deltaX) / v.z, y: v.y + (e.shiftKey ? 0 : e.deltaY) / v.z });
  };
  const editing = useRef<string | null>(null);
  const startEdit = (c: Cell) => {
    if (locked(c)) return;
    editing.current = c.id;
    const html = look(c.style, 'html') === '1';
    // As written (a label with %name% placeholders keeps them); a formatted one only with the formatting Konium keeps (nothing in it runs)
    const text = html ? sanitise(c.value) : c.value;
    setEdit({ id: c.id, text, html, orig: text });
  };
  const commitEdit = () => {
    // Once: Ctrl+Enter, then the box's blur as it goes
    if (!edit || editing.current !== edit.id) return;
    editing.current = null;
    const c = list.find((x) => x.id === edit.id);
    if (edit.html) {
      // A formatted label: the editor's HTML, its formatting kept and nothing else
      const v0 = sanitise(richEl.current?.innerHTML ?? edit.text).replace(/^(<br>)+$/, '');
      if (c && edit.orig !== v0) { change(d, 'Edit Label', () => setLabelRaw(page, edit.id, v0), page); changed(); }
    } else if (c && edit.orig !== edit.text) { change(d, 'Edit Label', () => setLabelRaw(page, edit.id, edit.text), page); changed(); }
    setEdit(null);
    host.current?.focus();
  };

  /** The project's sheets as blocks, each joined to the sheets below it. */
  const addSheets = () => {
    if (!p || !sheets.length) { notify('Add Project Sheets: the diagram isn\'t in a project with schematics', 'error'); return; }
    const roots: HierNode[] = projectTree(p) ?? sheets.map((s) => ({ sheet: s, children: [] }));
    const e = extent(list, L);
    const x0 = e ? snap(e.x) : 40, y0 = e ? snap(e.y + e.h + 60) : 40;
    const made = new Set<string>();
    change(d, 'Add Project Sheets', () => {
      let col = 0;
      const placeNode = (n: HierNode, depth: number): string => {
        const id = addVertex(page, { x: x0 + col * 180, y: y0 + depth * 120, w: 140, h: 60 }, n.sheet.replace(/\.schdoc$/i, ''), SHEET_STYLE);
        setSheet(page, id, n.sheet);
        made.add(id);
        if (!n.children.length) col++;
        for (const k of n.children) addEdge(page, id, placeNode(k, depth + 1), withDefaults(EDGE_STYLE, 'edge'));
        return id;
      };
      for (const r of roots) placeNode(r, 0);
    }, page);
    setSel(made); changed();
    setTimeout(fit, 0);
  };

  const one = sel.size === 1 ? list.find((c) => sel.has(c.id)) : undefined;
  const picked = list.filter((c) => sel.has(c.id));
  const edges = picked.filter((c) => c.edge);
  const W = host.current?.clientWidth ?? 1000, H = host.current?.clientHeight ?? 700;
  const rectOf = (c: Cell): Rect | undefined => {
    const r = L.abs.get(c.id);
    if (!r) return undefined;
    if (drag?.kind === 'resize') {
      if (drag.id === c.id) return drag.r;
      // A resized container's cells go with its corner
      for (let x = L.byId.get(c.parent), n = 0; x?.vertex && n < 60; x = L.byId.get(x.parent), n++) if (x.id === drag.id) { const a0 = L.abs.get(x.id)!; return { ...r, x: r.x + drag.r.x - a0.x, y: r.y + drag.r.y - a0.y }; }
    }
    if (drag?.kind === 'move' && moving(c)) return { ...r, x: r.x + drag.dx, y: r.y + drag.dy };
    return r;
  };
  const moving = (c: Cell): boolean => { let x: Cell | undefined = c; for (let n = 0; x && n < 50; n++) { if (sel.has(x.id)) return true; x = L.byId.get(x.parent); } return false; };
  // Edges drawn with their shapes where they are being dragged to
  const live: Layout = drag && (drag.kind === 'move' || drag.kind === 'resize') ? { ...L, abs: new Map([...L.abs].map(([id, r]) => [id, rectOf(L.byId.get(id)!) ?? r])) } : L;
  const routeOf = (c: Cell) => {
    const r = edgeRoute(drag?.kind === 'edge' && drag.id === c.id ? drag.cell : c, live);
    return drag?.kind === 'move' && sel.has(c.id) ? r.map((q) => ({ x: q.x + drag.dx, y: q.y + drag.dy })) : r;
  };

  const vb = `${v.x} ${v.y} ${W / v.z} ${H / v.z}`;
  const uid = od.id;
  const allShadow = attr(m, 'shadow') === '1';
  const arrowsOn = attr(m, 'arrows') !== '0' && attr(m, 'connect') !== '0';
  const sheetMark = (c: Cell, r: Rect) => c.sheet ? (
    <g class="dg-link" role="link" aria-label={`Open ${c.sheet}`} onPointerDown={(e) => { e.stopPropagation(); openSheet(c); }}>
      <title>{`${c.sheet} — click to open`}</title>
      <rect x={r.x + r.w - 18} y={r.y + 2} width={16} height={12} rx={2} fill="#ffffff" stroke="#2f5a8e" stroke-width={1} />
      <path d={`M${r.x + r.w - 15},${r.y + 5} h10 M${r.x + r.w - 15},${r.y + 8} h10 M${r.x + r.w - 15},${r.y + 11} h6`} stroke="#2f5a8e" stroke-width={1} />
    </g>
  ) : null;
  const bg = attr(m, 'background');
  const paper = bg && bg !== 'none' ? bg : '#ffffff';
  const gridPattern = `dg-grid-${uid}`;
  const styleSel = (label: string, kv: Record<string, string | null>, ids = [...sel]) => { change(d, label, () => setStyles(page, ids, kv), page); changed(); };

  /* The toolbar */
  const menuAt = (e: MouseEvent, children: { label: string; checked?: boolean; disabled?: boolean; separatorBefore?: boolean; action: () => void }[]) => {
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenuAt({ key: '', label: '', children: children.map((c) => ({ key: '', ...c })) }, b.left, b.bottom + 1);
  };
  const zoomMenu = (e: MouseEvent) => menuAt(e, [
    { label: 'Reset View', action: () => zoomTo(1) }, { label: 'Zoom In', action: () => zoomTo(v.z * 1.25) }, { label: 'Zoom Out', action: () => zoomTo(v.z / 1.25) },
    { label: 'Fit Window', separatorBefore: true, action: fit }, { label: 'Fit Page', disabled: !paged, action: fitPage },
    ...ZOOMS.map((z, i) => ({ label: `${z}%`, checked: Math.round(v.z * 100) === z, separatorBefore: i === 0, action: () => zoomTo(z / 100) })),
  ]);
  const waypointMenu = (e: MouseEvent) => menuAt(e, WAYPOINTS.map((w) => ({
    label: w.label, checked: !!edges.length && edges.every((c) => waypointsOf(c.style) === w.id), action: () => styleSel('Waypoints', waypointKeys(w.id), edges.map((c) => c.id)),
  })));
  const insertMenu = (e: MouseEvent) => menuAt(e, [
    ...['Rectangle', 'Ellipse', 'Text'].map((t) => ({ label: t, action: () => addEntry(LIBRARIES[0]!.entries.find((x) => x.title === t)!) })),
    { label: 'Horizontal Line', action: () => addEntry(LIBRARIES[1]!.entries.find((x) => x.title === 'Horizontal Line')!) },
    { label: 'Image...', action: () => imageInput.current?.click() },
    { label: 'Project Sheets', separatorBefore: true, disabled: !sheets.length, action: addSheets },
  ]);
  const first0 = picked[0];
  // What the menu bar's Edit, View, Arrange and Extras ask of this diagram
  diagramApi.set(od.id, {
    canUndo: d.undo.length > 0, canRedo: d.redo.length > 0, canPaste: !!clip, hasSel: sel.size > 0, hasEdges: edges.length > 0, manySel: picked.filter((c) => c.vertex).length > 1, format, layers: layersOpen, grid: gridOn, paged, sheets: sheets.length > 0,
    undo: () => { if (undoDiagram(d)) { setSel(new Set()); changed(); } }, redo: () => { if (redoDiagram(d)) { setSel(new Set()); changed(); } },
    cut: () => { copy(); del(); }, copy, paste, del, duplicate, find: () => setFind({ q: find?.q ?? '', i: -1 }), editStyle, editData, editLink,
    selectVertices: () => setSel(new Set(list.filter((c) => c.vertex && !c.relative && shown(c) && !frozen(c)).map((c) => c.id))), selectEdges: () => setSel(new Set(list.filter((c) => c.edge && shown(c) && !frozen(c)).map((c) => c.id))),
    selectAll: () => setSel(new Set(list.filter((c) => (c.vertex || c.edge) && shown(c) && !frozen(c)).map((c) => c.id))), selectNone: () => setSel(new Set()), lock,
    toggleFormat: () => setFormat(!format), toggleLayers: () => setLayersOpen(!layersOpen),
    toggleGrid: () => { change(d, 'Grid', () => setModelAttr(page, 'grid', gridOn ? '0' : '1'), page); changed(); }, togglePageView: () => { change(d, 'Page View', () => setModelAttr(page, 'page', paged ? '0' : '1'), page); changed(); },
    resetView: () => zoomTo(1), zoomIn: () => zoomTo(v.z * 1.25), zoomOut: () => zoomTo(v.z / 1.25), fit, fitPage,
    order: (how) => { if (sel.size) { change(d, 'Order', () => orderCells(page, sel, how), page); changed(); } }, group, ungroup,
    align: (how) => { change(d, 'Align', () => alignCells(page, sel, how), page); changed(); }, distribute: (hz) => { change(d, 'Distribute', () => distributeCells(page, sel, hz), page); changed(); },
    rotate90, flip, waypoints: (k) => styleSel('Waypoints', waypointKeys(k), edges.map((c) => c.id)), clearWaypoints: () => { change(d, 'Clear Waypoints', () => { for (const c of edges) setEdgePoints(page, c.id, []); }, page); changed(); },
    waypointKinds: WAYPOINTS.map((w) => ({ ...w, on: !!edges.length && edges.every((c) => waypointsOf(c.style) === w.id) })),
    editDiagram, exportAs, exportFile, print, addSheets,
  });
  const tb = (name: string, label: string, act: () => void, off = false, pressed?: boolean) => (
    <button type="button" class={`tbtn${pressed ? ' on' : ''}`} title={label} aria-label={label} aria-pressed={pressed} disabled={off} onClick={act}><ColourIcon name={name} /></button>
  );

  return (
    <div class="diagram" aria-label={`Diagram ${d.name}`}>
      <div class="dg-bar" role="toolbar" aria-label="Diagram">
        <button type="button" class="btn dg-zoom" aria-label="Zoom" aria-haspopup="menu" title="Zoom" onClick={(e) => zoomMenu(e as unknown as MouseEvent)}>{Math.round(v.z * 100)}%</button>
        {tb('zoomIn', 'Zoom In (Ctrl+Plus)', () => zoomTo(v.z * 1.25))}
        {tb('zoomOut', 'Zoom Out (Ctrl+Minus)', () => zoomTo(v.z / 1.25))}
        <span class="dd-sep" />
        {tb('undo', 'Undo (Ctrl+Z)', () => { if (undoDiagram(d)) { setSel(new Set()); changed(); } }, !d.undo.length)}
        {tb('redo', 'Redo (Ctrl+Y)', () => { if (redoDiagram(d)) { setSel(new Set()); changed(); } }, !d.redo.length)}
        <span class="dd-sep" />
        {tb('delete', 'Delete', del, !sel.size)}
        <span class="dd-sep" />
        {tb('dgToFront', 'To Front (Ctrl+Shift+F)', () => order('front'), !sel.size)}
        {tb('dgToBack', 'To Back (Ctrl+Shift+B)', () => order('back'), !sel.size)}
        <span class="dd-sep" />
        <ColourButton label="Fill Colour" icon={<ColourIcon name="dgFillColour" />} disabled={!picked.some((c) => c.vertex)} value={first0 ? look(first0.style, 'fillColor') : undefined} def="#ffffff"
          onPick={(c) => styleSel('Fill Colour', { fillColor: c }, picked.filter((x) => x.vertex).map((x) => x.id))} />
        <ColourButton label="Line Colour" icon={<ColourIcon name="dgLineColour" />} disabled={!sel.size} value={first0 ? look(first0.style, 'strokeColor') : undefined} def="#000000" onPick={(c) => styleSel('Line Colour', { strokeColor: c })} />
        {tb('dgShadow', 'Shadow', () => styleSel('Shadow', { shadow: first0 && look(first0.style, 'shadow') === '1' ? null : '1' }), !sel.size, !!first0 && look(first0.style, 'shadow') === '1')}
        <span class="dd-sep" />
        <button type="button" class="tbtn tbtn-drop" title="Waypoints" aria-label="Waypoints" aria-haspopup="menu" disabled={!edges.length} onClick={(e) => waypointMenu(e as unknown as MouseEvent)}><ColourIcon name="dgWaypoints" /><span class="tbtn-arrow" aria-hidden="true" /></button>
        <button type="button" class="tbtn tbtn-drop" title="Insert" aria-label="Insert" aria-haspopup="menu" onClick={(e) => insertMenu(e as unknown as MouseEvent)}><ColourIcon name="dgInsert" /><span class="tbtn-arrow" aria-hidden="true" /></button>
        <span class="spacer" />
        {tb('dgLayers', 'Layers (Ctrl+Shift+L)', () => setLayersOpen(!layersOpen), false, layersOpen)}
        {tb('dgFormat', 'Format Panel (Ctrl+Shift+P)', () => setFormat(!format), false, format)}
      </div>
      <div class={`dg-main${format ? '' : ' no-format'}`}>
        <Sidebar libs={libs} onPress={pressEntry} />
        <div class="dg-host" ref={host} tabIndex={0} onWheel={(e) => wheel(e as unknown as WheelEvent)}
          onDragOver={(e) => { if (isPictureDrag(e as unknown as DragEvent)) { e.preventDefault(); e.stopPropagation(); } }}
          onDrop={(e) => {
            const files = [...((e as unknown as DragEvent).dataTransfer?.files ?? [])].filter((f) => /^image\//.test(f.type));
            if (!files.length) return;
            e.preventDefault(); e.stopPropagation();
            files.forEach((f, i) => insertImage(f, { x: toModel(e.clientX, e.clientY).x + i * 20, y: toModel(e.clientX, e.clientY).y + i * 20 }));
          }}>
          <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp,image/bmp" hidden onChange={(e) => { const el = e.target as HTMLInputElement; const f = el.files?.[0]; if (f) insertImage(f); el.value = ''; }} />
          <svg ref={svg} class="dg-svg" viewBox={vb} width="100%" height="100%" onPointerDown={(e) => downPage(e as unknown as PointerEvent)} onPointerMove={(e) => hoverAt(e as unknown as PointerEvent)} onPointerLeave={() => setHover(null)} style={{ background: paged ? '#ececec' : paper }}>
            <defs>
              <pattern id={gridPattern} width={grid} height={grid} patternUnits="userSpaceOnUse"><path d={`M${grid},0 V${grid} H0`} fill="none" stroke="#e6e6e6" stroke-width={0.5 / v.z} /></pattern>
              <ShadowDef uid={uid} />
            </defs>
            {/* The paper: page view's pages (their background and grid), else the grid over the view */}
            {paged ? pages.map((q, i) => (
              <g key={`p${i}`} class="dg-paper" pointer-events="none">
                <rect x={q.x} y={q.y} width={q.w} height={q.h} fill={paper} stroke="#d0d0d0" stroke-width={1 / v.z} />
                {gridOn && <rect x={q.x} y={q.y} width={q.w} height={q.h} fill={`url(#${gridPattern})`} />}
              </g>
            )) : gridOn && <rect x={v.x} y={v.y} width={W / v.z} height={H / v.z} fill={`url(#${gridPattern})`} pointer-events="none" />}
            {list.map((c) => {
              if (!shown(c)) return null;
              if (c.edge) {
                const route = routeOf(c);
                return (
                  <g key={c.id} class={`dg-cell${sel.has(c.id) ? ' on' : ''}`} data-shape="edge" onPointerDown={(e) => downCell(e as unknown as PointerEvent, c)} onDblClick={() => startEdit(c)}>
                    <EdgeView c={drag?.kind === 'label' && drag.id === c.id ? { ...c, rect: { ...c.rect, x: drag.along, y: 0 }, offset: drag.offset } : c} route={route} uid={uid} shadow={allShadow} jumps={jumpsOf(c, route)} />
                    <path d={`M${route.map((q) => `${q.x},${q.y}`).join(' L')}`} fill="none" stroke="transparent" stroke-width={10 / v.z} />
                    {sel.has(c.id) && <path d={`M${route.map((q) => `${q.x},${q.y}`).join(' L')}`} fill="none" stroke="#2f7fd8" stroke-width={2 / v.z} stroke-dasharray={`${4 / v.z} ${3 / v.z}`} pointer-events="none" />}
                  </g>
                );
              }
              if (c.vertex && c.relative) {
                // An edge's label (a child of the edge, placed along it)
                const parent = L.byId.get(c.parent);
                if (!parent?.edge) return null;
                const lp = drag?.kind === 'label' && drag.id === c.id ? { along: drag.along, across: 0, offset: drag.offset } : { along: c.rect.x, across: c.rect.y, offset: c.offset ?? { x: 0, y: 0 } };
                const at = labelPoint(routeOf(parent), lp.along, lp.across);
                return <EdgeText key={c.id} at={{ x: at.x + lp.offset.x, y: at.y + lp.offset.y }} text={labelText(c)} s={c.style} size={num(c.style, 'fontSize', 11)} raw={labelSource(c)} />;
              }
              if (!c.vertex) return null;
              const r = rectOf(c);
              if (!r) return null;
              return (
                <g key={c.id} class={`dg-cell${sel.has(c.id) ? ' on' : ''}${c.sheet ? ' linked' : ''}${locked(c) ? ' locked' : ''}`} data-shape={c.style.shape()} onPointerDown={(e) => downCell(e as unknown as PointerEvent, c)} onDblClick={(e) => { e.stopPropagation(); startEdit(c); }}>
                  {c.sheet ? <title>{`${labelText(c)} — linked to ${c.sheet} (Ctrl+click opens it)`}</title> : (attr(c.wrap, 'tooltip') || c.link) ? <title>{[attr(c.wrap, 'tooltip'), c.link && `${c.link.startsWith('data:page/id,') ? 'A page of this diagram' : c.link} (Ctrl+click follows it)`].filter(Boolean).join('\n')}</title> : null}
                  <ShapeView c={drag?.kind === 'rotate' && drag.id === c.id ? { ...c, style: (() => { const t = Style.parse(c.style.toString()); t.set('rotation', String(drag.deg)); return t; })() } : c} r={r} uid={uid} shadow={allShadow} />
                  {/* Text and invisible shapes are picked by their box */}
                  {(hex(look(c.style, 'fillColor'), c.style.shape() === 'text' ? 'none' : '#ffffff') === 'none') && <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="transparent" />}
                  {sheetMark(c, r)}
                  {c.link && !c.sheet && <g class="dg-link" role="link" aria-label={`Follow ${c.link}`} onPointerDown={(e) => { e.stopPropagation(); openLink(c); }}>
                    <rect x={r.x + r.w - 16} y={r.y + 2} width={14} height={12} rx={2} fill="#ffffff" stroke="#2f5a8e" stroke-width={1} />
                    <path d={`M${r.x + r.w - 12},${r.y + 11} L${r.x + r.w - 6},${r.y + 5} M${r.x + r.w - 9.5},${r.y + 5} H${r.x + r.w - 6} V${r.y + 8.5}`} fill="none" stroke="#2f5a8e" stroke-width={1.2} />
                  </g>}
                </g>
              );
            })}
            {/* One connector picked: its ends, waypoints (and where one can go in), square segments, labels */}
            {one?.edge && !locked(one) && (!drag || drag.kind === 'edge' || drag.kind === 'label') && (() => {
              const route = routeOf(one);
              if (route.length < 2) return null;
              const k = 8 / v.z, fr = frameOfEdge(one), kind = routeKind(one.style);
              const bends = kind === 'straight' || kind === 'isometric';
              const mids = (i: number) => ({ x: (route[i]!.x + route[i + 1]!.x) / 2, y: (route[i]!.y + route[i + 1]!.y) / 2 });
              const labels = [...(labelText(one) ? [one] : []), ...list.filter((x) => x.parent === one.id && x.vertex && x.relative && labelText(x))];
              return (
                <g class="dg-edge-handles">
                  {bends && route.slice(0, -1).map((_, i) => { const q = mids(i); return <circle key={`v${i}`} class="dg-vbend" cx={q.x} cy={q.y} r={3.5 / v.z} onPointerDown={(e) => downPoint(e as unknown as PointerEvent, one, { insert: i })}><title>Drag to add a waypoint</title></circle>; })}
                  {bends && one.points.map((q0, i) => { const q = { x: q0.x + fr.x, y: q0.y + fr.y }; return <rect key={`b${i}`} class="dg-bend" x={q.x - k / 2} y={q.y - k / 2} width={k} height={k} onPointerDown={(e) => downPoint(e as unknown as PointerEvent, one, { move: i })} onDblClick={(e) => { e.stopPropagation(); removePoint(one, i); }}><title>Drag to move; double-click to remove</title></rect>; })}
                  {!bends && kind !== 'entityRelation' && route.slice(0, -1).map((_, i) => {
                    if (i === 0 || i === route.length - 2) return null;
                    const q = mids(i), across = Math.abs(route[i]!.y - route[i + 1]!.y) < 1e-6;
                    return <rect key={`g${i}`} class="dg-segment" x={q.x - k / 2} y={q.y - k / 2} width={k} height={k} style={{ cursor: across ? 'ns-resize' : 'ew-resize' }} onPointerDown={(e) => downPoint(e as unknown as PointerEvent, one, { segment: i, route })}><title>Drag to move this segment</title></rect>;
                  })}
                  {[0, route.length - 1].map((i) => { const q = route[i]!, src = i === 0, tied = src ? !!one.source : !!one.target; return <rect key={`e${i}`} class={`dg-end${tied ? ' tied' : ''}`} x={q.x - k / 2} y={q.y - k / 2} width={k} height={k} onPointerDown={(e) => downEnd(e as unknown as PointerEvent, one, src)}><title>{src ? 'Start' : 'End'}: drag onto a shape (or a connection point) to connect it, or anywhere to leave it loose</title></rect>; })}
                  {labels.map((lb) => {
                    const lp = drag?.kind === 'label' && drag.id === lb.id ? { along: drag.along, across: 0, offset: drag.offset } : { along: lb.rect.x, across: lb.rect.y, offset: lb.offset ?? { x: 0, y: 0 } };
                    const a = labelPoint(route, lp.along, lp.across), q = { x: a.x + lp.offset.x, y: a.y + lp.offset.y };
                    return <path key={`l${lb.id}`} class="dg-label-handle" d={`M${q.x},${q.y - 6 / v.z} L${q.x + 6 / v.z},${q.y} L${q.x},${q.y + 6 / v.z} L${q.x - 6 / v.z},${q.y} Z`} onPointerDown={(e) => downLabel(e as unknown as PointerEvent, one, lb)}><title>Drag to move the label</title></path>;
                  })}
                </g>
              );
            })()}
            {/* Selection: boxes (turned with their shapes); one shape's handles and turning handle */}
            {[...sel].map((id) => {
              const c = L.byId.get(id); const r = c?.vertex && !c.relative ? rectOf(c) : undefined;
              if (!r || !c) return null;
              const rot = drag?.kind === 'rotate' && drag.id === id ? drag.deg : num(c.style, 'rotation', 0);
              return <rect key={`s${id}`} x={r.x - 2 / v.z} y={r.y - 2 / v.z} width={r.w + 4 / v.z} height={r.h + 4 / v.z} fill="none" stroke="#2f7fd8" stroke-width={1 / v.z} stroke-dasharray={`${3 / v.z} ${3 / v.z}`} pointer-events="none" transform={rot ? `rotate(${rot} ${r.x + r.w / 2} ${r.y + r.h / 2})` : undefined} />;
            })}
            {one?.vertex && !one.relative && !locked(one) && (!drag || drag.kind === 'rotate') && (() => {
              const r = rectOf(one)!;
              const k = 7 / v.z;
              const rot = drag?.kind === 'rotate' ? drag.deg : num(one.style, 'rotation', 0);
              const ctr = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
              const at = (fx: number, fy: number, ox = 0, oy = 0) => turn({ x: r.x + fx * r.w + ox, y: r.y + fy * r.h + oy }, ctr, rot);
              const rh = at(1, 0, 14 / v.z, -14 / v.z);
              return (
                <g>
                  {!drag && HANDLES.map((h, i) => { const q = at(h[0], h[1]); return <rect key={i} class="dg-handle" x={q.x - k / 2} y={q.y - k / 2} width={k} height={k} transform={rot ? `rotate(${rot} ${q.x} ${q.y})` : undefined} onPointerDown={(e) => downHandle(e as unknown as PointerEvent, one, h)} />; })}
                  {look(one.style, 'rotatable') !== '0' && <g class="dg-rotate" role="button" aria-label="Rotate" onPointerDown={(e) => downRotate(e as unknown as PointerEvent, one)}>
                    <title>Drag to turn it (Alt: freely)</title>
                    <circle cx={rh.x} cy={rh.y} r={7 / v.z} fill="#ffffff" stroke="#2f7fd8" stroke-width={1 / v.z} />
                    <path d={`M${rh.x - 3.5 / v.z},${rh.y} A${3.5 / v.z},${3.5 / v.z} 0 1 1 ${rh.x},${rh.y + 3.5 / v.z}`} fill="none" stroke="#2f7fd8" stroke-width={1.3 / v.z} />
                    <path d={`M${rh.x - 5.5 / v.z},${rh.y - 1 / v.z} L${rh.x - 3.5 / v.z},${rh.y + 1.5 / v.z} L${rh.x - 1.5 / v.z},${rh.y - 1 / v.z}`} fill="none" stroke="#2f7fd8" stroke-width={1.3 / v.z} />
                  </g>}
                </g>
              );
            })()}
            {/* The hover arrows: click for a joined copy that way, drag to connect */}
            {(() => {
              const c = !drag && !edit && arrowsOn ? (hover ? L.byId.get(hover) : one?.vertex && !one.relative ? one : undefined) : undefined;
              const r = c ? L.abs.get(c.id) : undefined;
              if (!c || !r || locked(c)) return null;
              return ARROWS.map(([fx, fy, ox, oy], i) => {
                const g = 22 / v.z, len = 9 / v.z, wd = 6 / v.z;
                const tip = { x: r.x + fx * r.w + ox * (g + len), y: r.y + fy * r.h + oy * (g + len) }, base = { x: r.x + fx * r.w + ox * g, y: r.y + fy * r.h + oy * g };
                return (
                  <path key={`a${i}`} class="dg-connect" aria-label="Connect" d={`M${tip.x},${tip.y} L${base.x - oy * wd},${base.y + ox * wd} L${base.x + ox * len * 0.35},${base.y + oy * len * 0.35} L${base.x + oy * wd},${base.y - ox * wd} Z`}
                    onPointerDown={(e) => downArrow(e as unknown as PointerEvent, c, [ox, oy])}><title>Click for a copy joined to it; drag to another shape to connect</title></path>
                );
              });
            })()}
            {drag?.kind === 'connect' && (() => {
              const r = L.abs.get(drag.from); const t = vertexAt(drag.to, drag.from); const tr = t ? L.abs.get(t.id) : undefined;
              if (!r) return null;
              const pts = t && tr ? connectionPoints(t) : [];
              const f = t && tr ? nearestPoint(tr, t, pts, drag.to, 10 / v.z) : null;
              const fAt = f && t && tr ? portAt(tr, t, f) : null;
              const k = 3 / v.z;
              return <g pointer-events="none">
                {tr && <rect x={tr.x} y={tr.y} width={tr.w} height={tr.h} fill="none" stroke={f ? '#2f7fd8' : '#2f7fd8'} stroke-width={(f ? 1 : 2) / v.z} />}
                {t && tr && pts.map((q, i) => { const { x, y } = portAt(tr, t, q); return <path key={i} class="dg-point" d={`M${x - k},${y - k} L${x + k},${y + k} M${x - k},${y + k} L${x + k},${y - k}`} stroke={f === q ? '#2f7fd8' : '#4a90d9'} stroke-width={(f === q ? 2.5 : 1.2) / v.z} />; })}
                <line x1={r.x + r.w / 2} y1={r.y + r.h / 2} x2={fAt ? fAt.x : drag.to.x} y2={fAt ? fAt.y : drag.to.y} stroke="#2f7fd8" stroke-width={1.5 / v.z} stroke-dasharray={`${4 / v.z} ${3 / v.z}`} />
              </g>;
            })()}
            {/* Moving: the guides lined up with, the container it would go into */}
            {drag?.kind === 'move' && <g pointer-events="none">
              {drag.guides.map((g, i) => <line key={i} class="dg-guide" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke="#0000ff" stroke-width={1 / v.z} stroke-dasharray={`${3 / v.z} ${3 / v.z}`} />)}
              {drag.into && (() => { const r = L.abs.get(drag.into); return r ? <rect class="dg-into" x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke="#2f7fd8" stroke-width={3 / v.z} /> : null; })()}
            </g>}
            {drag?.kind === 'band' && <rect x={Math.min(drag.a.x, drag.b.x)} y={Math.min(drag.a.y, drag.b.y)} width={Math.abs(drag.b.x - drag.a.x)} height={Math.abs(drag.b.y - drag.a.y)} fill="rgba(47,127,216,0.08)" stroke="#2f7fd8" stroke-width={1 / v.z} pointer-events="none" />}
            {/* A shape from the library on its way to the page: its outline where it will go */}
            {ghost && (() => {
              const at = { x: snap(ghost.at.x - ghost.x.w / 2), y: snap(ghost.at.y - ghost.x.h / 2) };
              const e = ghost.x.edge;
              return (
                <g class="dg-ghost" opacity={0.5} pointer-events="none">
                  {e ? <EdgeView c={sample(ghost.x.style, ghost.x.value ?? '', 'ghost')} route={[e.from, ...(e.points ?? []), e.to].map((q) => ({ x: at.x + q.x, y: at.y + q.y }))} uid={uid} />
                    : <>
                      <ShapeView c={sample(ghost.x.style, ghost.x.value ?? '', 'ghost')} r={{ ...at, w: ghost.x.w, h: ghost.x.h }} uid={uid} />
                      {ghost.x.kids?.map((k, i) => <ShapeView key={i} c={sample(k.style, k.value, `ghost-${i}`)} r={{ ...k.rect, x: at.x + k.rect.x, y: at.y + k.rect.y }} uid={uid} />)}
                    </>}
                  <rect x={at.x} y={at.y} width={Math.max(ghost.x.w, 2)} height={Math.max(ghost.x.h, 2)} fill="none" stroke="#2f7fd8" stroke-width={1 / v.z} stroke-dasharray={`${4 / v.z} ${3 / v.z}`} />
                </g>
              );
            })()}
          </svg>
          {find && <div class="dg-find" role="search" aria-label="Find">
            <input aria-label="Find" placeholder="Find" value={find.q} ref={(el) => { if (el && !el.dataset.focused) { el.dataset.focused = '1'; el.focus(); el.select(); } }}
              onInput={(e) => setFind({ q: (e.target as HTMLInputElement).value, i: -1 })}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') findNext(find.q, find.i); if (e.key === 'Escape') { setFind(null); host.current?.focus(); } }} />
            <button type="button" class="btn" onClick={() => findNext(find.q, find.i)}>Find Next</button>
            <button type="button" class="dg-x" aria-label="Close Find" onClick={() => { setFind(null); host.current?.focus(); }}>×</button>
          </div>}
          {layersOpen && <Layers d={d} page={page} sel={sel} changed={changed} onClose={() => setLayersOpen(false)} />}
          {edit && (() => {
            const c = L.byId.get(edit.id);
            const r = c?.vertex ? L.abs.get(c.id) : undefined;
            const at = r ?? (c?.edge ? (() => { const q = alongRoute(edgeRoute(c, L), 0); return { x: q.x - 60, y: q.y - 15, w: 120, h: 30 }; })() : undefined);
            if (!at) return null;
            const pos = { left: `${(at.x - v.x) * v.z}px`, top: `${(at.y - v.y) * v.z}px`, width: `${Math.max(80, at.w * v.z)}px`, height: `${Math.max(28, at.h * v.z)}px` };
            const keys = (e: KeyboardEvent) => { e.stopPropagation(); if (e.key === 'Escape') { editing.current = null; setEdit(null); host.current?.focus(); } if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitEdit(); } };
            if (edit.html && c) {
              const st = c.style, fsz = num(st, 'fontSize', c.edge ? 11 : 12) * v.z;
              return <>
                <RichBar at={{ left: pos.left, top: `${Math.max(0, (at.y - v.y) * v.z - 34)}px` }} />
                <div class="dg-edit dg-rich-edit" contentEditable role="textbox" aria-multiline="true" aria-label="Label" style={{ ...pos, fontSize: `${fsz}px`, fontFamily: fontOf(st), color: hex(look(st, 'fontColor'), '#000000'), textAlign: (look(st, 'align') ?? 'center') as 'left' }}
                  ref={(el) => { richEl.current = el; if (el && !el.dataset.focused) { el.dataset.focused = '1'; el.innerHTML = edit.text; el.focus(); const r0 = document.createRange(); r0.selectNodeContents(el); const sl = window.getSelection(); sl?.removeAllRanges(); sl?.addRange(r0); } }}
                  onBlur={commitEdit} onKeyDown={(e) => keys(e as unknown as KeyboardEvent)} />
              </>;
            }
            return <textarea class="dg-edit" aria-label="Label" ref={(el) => { if (el && !el.dataset.focused) { el.dataset.focused = '1'; el.focus(); el.select(); } }} value={edit.text} style={pos}
              onInput={(e) => setEdit({ ...edit, text: (e.target as HTMLTextAreaElement).value })} onBlur={commitEdit}
              onKeyDown={(e) => keys(e as unknown as KeyboardEvent)} />;
          })()}
        </div>
        {format && (
          <aside class="dd-props dg-side" aria-label="Diagram properties">
            <Format d={d} page={page} list={list} sel={sel} sheets={sheets} changed={changed} openSheet={openSheet} select={setSel} />
            {sheets.length > 0 && !sel.size && <div class="dg-konium"><button class="btn" title="The project's sheets as blocks linked to them, joined as the hierarchy goes" onClick={addSheets}><ColourIcon name="dgSheets" /> Add Project Sheets</button></div>}
          </aside>
        )}
      </div>
      <div class="dg-pages" role="tablist" aria-label="Pages">
        {d.pages.map((pg, i) => <button key={i} role="tab" aria-selected={pg === page} class={`dg-page${pg === page ? ' on' : ''}`} onClick={() => setPi(i)}>{pageName(pg, i)}</button>)}
        <button class="dg-page" aria-label="Add Page" title="Add Page" onClick={() => { change(d, 'Add Page', () => { addPage(d, `Page-${d.pages.length + 1}`); }); setPi(d.pages.length - 1); changed(); }}>+</button>
        <span class="spacer" />
        {page.unreadable && <span class="error-text small" title="Its content isn't in a form Konium Designer reads">This page couldn't be read: it is saved as it was unless you draw on it · </span>}
        <span class="muted small">{list.filter((c) => c.vertex && !c.relative).length} shapes, {list.filter((c) => c.edge).length} connectors · {Math.round(v.z * 100)}% · Ctrl+wheel zooms, Alt+drag moves the page</span>
      </div>
    </div>
  );
}
