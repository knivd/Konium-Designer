/** The showcase's footprint library, project file and Output Job. */
import { encodeArc, encodeBody, encodePad, encodeTrack, readPcbDoc } from '../../../src/formats/altium/pcbdoc';
import { writePcbLib, type FootprintDef } from '../../../src/formats/altium/pcblib';
import { newOutJob, newOutput, setOutJobOutputs, setOutputConfig, writeOutJob } from '../../../src/formats/altium/outjob';
import { drillToConfig, gerberToConfig, pnpToConfig, printJobToConfig } from '../../../src/formats/altium/outjobConfig';
import { defaultGerberSetup } from '../../../src/formats/gerber/gerber';
import { defaultDrillSetup } from '../../../src/formats/gerber/drill';
import { defaultPnpSetup } from '../../../src/formats/gerber/pnp';
import { defaultJob } from '../../../src/model/printouts';
import { binToBytes } from '../../../src/formats/text';
import { L } from '../../../src/model/layers';
import { mm } from '../../../src/core/units';
import { design } from './design';

export function footprintLibrary(): Uint8Array {
  const seen = new Map<string, FootprintDef>();
  for (const p of design.parts) {
    if (seen.has(p.fp.name)) continue;
    const f = p.fp;
    const Q = (x: number, y: number) => ({ x: mm(x), y: mm(y) });
    const recs = [
      ...f.pads.map((d) => encodePad({ name: d.name, layer: d.hole ? L.MULTI : L.TOP, at: Q(d.x, d.y), w: mm(d.w), h: mm(d.h), shape: d.shape, hole: d.hole ? mm(d.hole) : undefined })),
      ...f.silk.map(([x0, y0, x1, y1]) => encodeTrack({ layer: L.TOP_OVERLAY, a: Q(x0, y0), b: Q(x1, y1), width: mm(0.15) })),
      ...f.dots.map(([x, y, r]) => encodeArc({ layer: L.TOP_OVERLAY, c: Q(x, y), r: mm(r * 0.5), start: 0, end: 360, width: mm(r) })),
      ...[[f.court[0], f.court[1], f.court[2], f.court[1]], [f.court[2], f.court[1], f.court[2], f.court[3]], [f.court[2], f.court[3], f.court[0], f.court[3]], [f.court[0], f.court[3], f.court[0], f.court[1]]]
        .map(([x0, y0, x1, y1]) => encodeTrack({ layer: L.MECH1 + 14, a: Q(x0!, y0!), b: Q(x1!, y1!), width: mm(0.05) })),
      ...f.bodies.map((b) => {
        const pts = b.box ? [[b.box[0], b.box[1]], [b.box[2], b.box[1]], [b.box[2], b.box[3]], [b.box[0], b.box[3]]] : Array.from({ length: 28 }, (_, i) => [b.circle![0] + b.circle![2] * Math.cos((i / 28) * 2 * Math.PI), b.circle![1] + b.circle![2] * Math.sin((i / 28) * 2 * Math.PI)]);
        return encodeBody({ component: 0xffff, outline: pts.map(([x, y]) => Q(x!, y!)), standoff: mm(b.z0), overall: mm(b.z1), colour: b.colour, layer: L.MECH1 + 12 });
      }),
    ];
    seen.set(f.name, { name: f.name, description: f.description, height: `${f.height}mm`, records: recs });
  }
  return writePcbLib([...seen.values()].sort((a, b) => a.name.localeCompare(b.name)), 'Showcase.PcbLib');
}

export function project(docs: string[]): Uint8Array {
  const lines = ['[Design]', 'Version=1.0', 'HierarchyMode=3', 'ChannelRoomNamingStyle=0', 'OutputPath=Project Outputs for Showcase', ''];
  docs.forEach((d, i) => lines.push(`[Document${i + 1}]`, `DocumentPath=${d}`, 'AnnotationEnabled=1', ''));
  lines.push('[Parameter1]', 'Name=ProjectTitle', 'Value=Showcase controller', '', '[Parameter2]', 'Name=Revision', 'Value=A', '');
  return binToBytes(lines.join('\r\n'));
}

export function outJob(board: Uint8Array): Uint8Array {
  const doc = readPcbDoc(board, 'Showcase.PcbDoc');
  const job = newOutJob('Showcase.OutJob');
  const out = (type: string, name: string, cat: string, d: string, print: boolean, recs: (Record<string, string> | string)[], names?: string[]) => {
    const o = newOutput(type, name, cat, d, print);
    setOutputConfig(o, recs, names);
    return o;
  };
  const stack = doc.board.copperStack;
  const outs = [
    out('Gerber', 'Gerber Files', 'Fabrication', 'Showcase.PcbDoc', false, gerberToConfig({ ...defaultGerberSetup(doc), drillDrawing: true })),
    out('NC Drill', 'NC Drill Files', 'Fabrication', 'Showcase.PcbDoc', false, drillToConfig(defaultDrillSetup())),
    out('Pick Place', 'Generates pick and place files', 'Assembly', 'Showcase.PcbDoc', false, pnpToConfig(defaultPnpSetup())),
    out('BOM_PartType', 'Bill of Materials', 'Report', '', false, ['CaptionAsName', 'OpenExported=False|AddToProject=False|ForceFit=False|NotFitted=False|Database=False|IncludePCBData=False|ShowExportOptions=True|TemplateFilename=|BatchMode=5',
      'Comment=True|Footprint=True', 'Designator=Up|Comment=Up|Footprint=Up', 'Comment=100|Description=100|Designator=100|Footprint=100|LibRef=100|Quantity=100'],
      ['ColumnNameFormat', 'General', 'GroupOrder', 'SortOrder', 'VisibleOrder']),
    out('Assembly', 'Assembly Drawings', 'Assembly', 'Showcase.PcbDoc', true, printJobToConfig(defaultJob(doc, 'assembly'), [stack[0]!, stack.at(-1)!])),
    out('Drill', 'Drill Drawing/Guides', 'Fabrication', 'Showcase.PcbDoc', true, printJobToConfig(defaultJob(doc, 'drill'), [stack[0]!, stack.at(-1)!])),
  ];
  outs.forEach((o, i) => { if (i < 4) o.media.set(3, i + 1); else o.media.set(2, i - 3); });
  setOutJobOutputs(job, outs);
  return writeOutJob(job);
}
