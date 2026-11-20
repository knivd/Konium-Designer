/**
 * File › Fabrication Outputs › Gerber X2 Files: Gerber with attributes — each file says what it
 * is (%TF.FileFunction: Copper,L1,Top; Soldermask,Top; Legend,Top; Profile,NP …, its polarity,
 * the software, date and project), each aperture what it draws (%TA.AperFunction: Conductor,
 * SMDPad,CuDef, ComponentPad, ViaPad, NonConductor, Profile, ViaDrill, ComponentDrill), each
 * object its net, pin and component (%TO.N / .P / .C). The holes go in Gerber drill files, plated
 * and non-plated apart. Files are named <board>-<function>.gbr [est: AD17's names].
 */
import { locale } from '../../core/locale';
import { L, layerName, type LayerId } from '../../model/layers';
import type { PcbDocument } from '../../model/pcb';
import { APP_VERSION } from '../../platform/distribution';
import { Plot, drawCoverlay, drawLayer, specialStrings, x2Value, type GerberSetup, type OutputFile } from './gerber';
import { holes } from './drill';
import { coverlayLayers } from '../../model/coverlay';

const isCopper = (l: LayerId) => l >= L.TOP && l <= L.BOTTOM;

/** A layer's file function and polarity, and the name its file takes; null: not plotted in X2. */
export function x2Function(doc: PcbDocument, layer: LayerId): { fn: string; polarity: 'Positive' | 'Negative'; name: string } | null {
  const stack = doc.board.copperStack;
  // A plane plotted as its copper (positive), named as a plane
  if (layer >= L.PLANE1 && layer <= L.PLANE16) {
    const n = stack.indexOf(layer) + 1;
    return n > 0 ? { fn: `Copper,L${n},Inr,Plane`, polarity: 'Positive', name: `Copper_Plane_L${n}` } : null;
  }
  if (isCopper(layer)) {
    const n = stack.indexOf(layer) + 1;
    if (n <= 0) return null;
    const pos = n === 1 ? 'Top' : n === stack.length ? 'Bot' : 'Inr';
    return { fn: `Copper,L${n},${pos}`, polarity: 'Positive', name: pos === 'Inr' ? `Copper_Signal_L${n}` : `Copper_Signal_${pos}` };
  }
  if (layer >= L.MECH1 && layer <= L.MECH16) return { fn: `Other,Mechanical_${layer - L.MECH1 + 1}`, polarity: 'Positive', name: `Mechanical_${layer - L.MECH1 + 1}` };
  switch (layer) {
    case L.TOP_SOLDER: return { fn: 'Soldermask,Top', polarity: 'Negative', name: 'Soldermask_Top' };
    case L.BOTTOM_SOLDER: return { fn: 'Soldermask,Bot', polarity: 'Negative', name: 'Soldermask_Bot' };
    case L.TOP_PASTE: return { fn: 'Paste,Top', polarity: 'Positive', name: 'Paste_Top' };
    case L.BOTTOM_PASTE: return { fn: 'Paste,Bot', polarity: 'Positive', name: 'Paste_Bot' };
    case L.TOP_OVERLAY: return { fn: 'Legend,Top', polarity: 'Positive', name: 'Legend_Top' };
    case L.BOTTOM_OVERLAY: return { fn: 'Legend,Bot', polarity: 'Positive', name: 'Legend_Bot' };
    case L.KEEPOUT: return { fn: 'Other,Keep-out', polarity: 'Positive', name: 'Keep-out' };
    case L.DRILL_DRAWING: return { fn: 'Drillmap', polarity: 'Positive', name: 'Drillmap' };
    default: return null;
  }
}

/** A stable project id from the board's name [est: AD uses the project's GUID]. */
function guid(name: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (const c of name) { h1 = Math.imul(h1 ^ c.charCodeAt(0), 16777619); h2 = Math.imul(h2 + c.charCodeAt(0), 2654435761); }
  const hex = (v: number) => (v >>> 0).toString(16).padStart(8, '0');
  const x = hex(h1) + hex(h2) + hex(h1 ^ h2) + hex(h2 * 31 + 7);
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}`;
}

function header(doc: PcbDocument, fn: string, polarity: string, when: Date): string[] {
  const base = doc.name.replace(/\.pcbdoc$/i, '');
  const iso = when.toISOString().replace(/\.\d{3}Z$/, '+00:00');
  return [
    `G04 ${fn} of ${doc.name}*`,
    `%TF.GenerationSoftware,Konium,Konium Designer,${APP_VERSION}*%`,
    `%TF.CreationDate,${iso}*%`,
    `%TF.ProjectId,${x2Value(base)},${guid(base)},1*%`,
    '%TF.SameCoordinates,Original*%',
    `%TF.FileFunction,${fn}*%`,
    `%TF.FilePolarity,${polarity}*%`,
  ];
}

/** Every chosen layer as an X2 file, the board profile, and the holes. */
export function gerberX2Files(doc: PcbDocument, s: GerberSetup, when = new Date()): { files: OutputFile[]; notes: string[] } {
  const base = doc.name.replace(/\.pcbdoc$/i, '');
  const origin = s.relative ? doc.board.origin : { x: 0, y: 0 };
  const notes = new Set<string>();
  const files: OutputFile[] = [];
  for (const l of s.layers) {
    if (!l.plot) continue;
    const f = x2Function(doc, l.layer);
    if (!f) { notes.add(`${layerName(l.layer)}: no Gerber X2 file function, left out`); continue; }
    const plot = new Plot(s, origin, l.mirror, true);
    drawLayer(plot, doc, l.layer, { outlineOnMech1: false, notes, drill: s.drill, special: specialStrings(doc, l.layer), midPads: !!s.unconnectedMidPads });
    files.push({ name: `${base}-${f.name}.gbr`, text: plot.finish(header(doc, f.fn, f.polarity, when)) });
  }
  // Coverlay (rigid-flex): each coverlay layer its own file, with its side's solder mask [est: AD's file function for it]
  for (const c of coverlayLayers(doc)) {
    const mask = s.layers.find((l) => l.layer === (c.side === 'top' ? L.TOP_SOLDER : L.BOTTOM_SOLDER));
    if (!mask?.plot) continue;
    const plot = new Plot(s, origin, mask.mirror, true);
    drawCoverlay(plot, doc, c);
    files.push({ name: `${base}-Coverlay_${c.side === 'top' ? 'Top' : 'Bot'}${c.n > 1 ? `_${c.n}` : ''}.gbr`, text: plot.finish(header(doc, `Other,Coverlay ${c.side === 'top' ? 'Top' : 'Bot'}`, 'Negative', when)) });
  }
  // The board's outline: its own file
  if (doc.board.outline.length > 2) {
    const plot = new Plot(s, origin, false, true);
    plot.begin({ fn: 'Profile' });
    plot.polyline([...doc.board.outline, doc.board.outline[0]!], 39_370); // 0.1 mm
    files.push({ name: `${base}-Profile.gbr`, text: plot.finish(header(doc, 'Profile,NP', 'Positive', when)) });
  }
  // Holes: plated and non-plated, through the stack
  const n = doc.board.copperStack.length;
  const all = holes(doc);
  const via = new Set(doc.prims.filter((p) => p.kind === 'via').map((p) => (p.kind === 'via' ? `${p.at.x},${p.at.y},${p.hole}` : '')));
  for (const plated of [true, false]) {
    const list = all.filter((h) => h.plated === plated);
    if (!list.length) continue;
    const plot = new Plot(s, origin, false, true);
    for (const h of list) {
      plot.begin({ fn: plated ? (via.has(`${h.at.x},${h.at.y},${h.size}`) ? 'ViaDrill' : 'ComponentDrill') : 'ComponentDrill' });
      if (h.slot) plot.line(h.slot.a, h.slot.b, h.size); else plot.dot(h.at, h.size);
    }
    const fn = plated ? `Plated,1,${n},PTH` : `NonPlated,1,${n},NPTH`;
    files.push({ name: `${base}-${plated ? 'Plated' : 'NonPlated'}_1-${n}_${plated ? 'PTH' : 'NPTH'}_Drill.gbr`, text: plot.finish(header(doc, fn, 'Positive', when)) });
  }
  files.push({ name: `${base}-GerberX2.REP`, text: [
    `Gerber X2 files for ${doc.name}`, `Written by Konium Designer ${APP_VERSION} on ${when.toLocaleString(locale())}`, '',
    `Units: ${s.units === 'in' ? 'Inches' : 'Millimetres'}  Format: ${s.intDigits}:${s.decDigits}`,
    `Origin: ${s.relative ? 'relative origin of the board' : 'absolute origin'}`, '', 'Files:', ...files.map((f) => `  ${f.name}`),
    ...(notes.size ? ['', 'Notes:', ...[...notes].map((x) => `  ${x}`)] : []), '',
  ].join('\r\n') });
  return { files, notes: [...notes] };
}
