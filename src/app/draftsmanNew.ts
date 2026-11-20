/**
 * File › New › Draftsman Document: a new .PCBDwf for the board, into the focused project, its
 * first sheet (A3) laid out as a fabrication and assembly drawing — the top and bottom assembly
 * views and the fabrication view at a scale that fits, the drill table, the layer stack table, the
 * bill of materials, notes and a title block — each item then moved, rescaled or removed as wanted
 * [est: AD starts from its template's empty sheet].
 */
import type { PcbDocument } from '../model/pcb';
import { drillRows } from '../model/boardTables';
import { PX_PER_MM, SHEETS, newDraftsman, writePcbDwf, type PlaceKind } from '../formats/altium/pcbdwf';
import { stackRows } from '../render/draftDoc';
import { boardThickness } from '../render/gl3d/boardModel';
import { addNewDocument, freshName } from './actions';
import { newDocTarget } from './workspace';
import { docs, projects, tick } from './state';
import { L } from '../model/layers';

const MM = 25.4 / 10_000_000;
const SCALES = [10, 5, 4, 3, 2, 1, 0.5, 0.25, 0.2, 0.1];

/** Where each item goes on the sheet (px, top-left corners) and the views' scale. */
export function defaultLayout(doc: PcbDocument, size = 'A3'): { kind: PlaceKind; x: number; y: number; scale?: number; side?: 'Top' | 'Bottom'; text?: string }[] {
  const [wmm, hmm] = SHEETS[size]!;
  const k = PX_PER_MM, m = 10 + 5 * k + 6 * k;
  const xs = doc.board.outline.map((v) => v.x), ys = doc.board.outline.map((v) => v.y);
  const bw = xs.length ? (Math.max(...xs) - Math.min(...xs)) * MM : 50, bh = ys.length ? (Math.max(...ys) - Math.min(...ys)) * MM : 40;
  // Views: the left 55 %, the assembly views side by side above the fabrication view
  const areaW = (wmm * k - 2 * m) * 0.55, areaH = hmm * k - 2 * m;
  const fits = (s: number) => 2 * bw * s * k + 14 * k <= areaW && 2 * (bh * s * k + 14 * k) <= areaH;
  const scale = SCALES.find(fits) ?? 0.1;
  const vw = bw * scale * k * 1.04, vh = bh * scale * k * 1.04;
  const out: ReturnType<typeof defaultLayout> = [
    { kind: 'assembly', x: m, y: m, scale, side: 'Top' },
    { kind: 'assembly', x: m + vw + 12 * k, y: m, scale, side: 'Bottom' },
    { kind: 'fabrication', x: m, y: m + vh + 16 * k, scale },
  ];
  // Tables on the right, one below another
  const rx = m + areaW + 8 * k;
  const row = 12 * 0.75 * 1.6;
  let y = m;
  const rowsOf = (n: number) => (n + 2) * row + 8 * k;
  out.push({ kind: 'drillTable', x: rx, y }); y += rowsOf(drillRows(doc).length + 1);
  if (doc.board.bag) { out.push({ kind: 'layerStack', x: rx, y }); y += rowsOf(stackRows(doc).length + 1); }
  out.push({ kind: 'bom', x: rx, y });
  const top = doc.components.filter((c) => c.layer !== L.BOTTOM).length;
  out.push({ kind: 'text', x: m, y: hmm * k - m - 14 * k, text: `NOTES: dimensions in millimetres; board thickness ${boardThickness(doc).toFixed(2)} mm; ${doc.board.copperStack.length} copper layers; ${doc.components.length} components (top ${top}, bottom ${doc.components.length - top}).` });
  out.push({ kind: 'titleBlock', x: wmm * k - 10 - 5 * k - 122 * k, y: hmm * k - 10 - 5 * k - 38 * k });
  return out;
}

export function newDraftsmanDocument(board: PcbDocument): void {
  const od0 = docs.value.find((d) => d.doc === board);
  const p = (od0?.projectId ? projects.value.find((x) => x.id === od0.projectId) : null) ?? newDocTarget();
  const stem = board.name.replace(/\.[^.]+$/, '');
  const name = freshName(stem, 'PCBDwf');
  const d = newDraftsman(name, board.name, { size: 'A3', layout: defaultLayout(board, 'A3'), params: { Title: stem, Revision: '1' } });
  const od = addNewDocument(name, writePcbDwf(d), p);
  if (od && od.doc.kind === 'Draftsman') { od.doc.dirty = true; tick.value++; }
}
