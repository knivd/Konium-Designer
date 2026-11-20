import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { encodeBody } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { defaultGerberSetup, gerberFiles } from '../src/formats/gerber/gerber';
import { gerberX2Files } from '../src/formats/gerber/gerberX2';
import { holes } from '../src/formats/gerber/drill';
import { ipc2581 } from '../src/formats/ipc2581';
import { odbArchive, odbFiles } from '../src/formats/odb';
import { exportStep, leftOutWords, modelRoot, real, renumber, stepStr } from '../src/formats/step/write';
import { isRef, parseStep } from '../src/formats/step/parse';
import { cfbPut, newEntry } from '../src/formats/cfb/cfb';
import { embeddedModels } from '../src/render/gl3d/stepBodies';
import { UndoStack } from '../src/core/undo';
import { addPrimRecords } from '../src/model/pcbEdit';
import { L } from '../src/model/layers';
import { mm } from '../src/core/units';
import type { PcbDocument } from '../src/model/pcb';

const demo = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
const when = new Date(Date.UTC(2026, 9, 27, 19, 0, 0));

/** Tags balance: every element opened is closed in order. */
function wellFormed(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml.replace(/<\?[^>]*\?>/g, '').matchAll(/<(\/?)([A-Za-z0-9_:-]+)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else stack.push(m[2]!);
  }
  return stack.length === 0;
}

describe('Gerber X2', () => {
  it('names each file by its function and carries file, aperture and object attributes', () => {
    const doc = demo();
    const { files } = gerberX2Files(doc, { ...defaultGerberSetup(doc), units: 'mm', intDigits: 4, decDigits: 6 }, when);
    const names = files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Demo-Copper_Signal_Top.gbr', 'Demo-Copper_Signal_Bot.gbr', 'Demo-Soldermask_Top.gbr', 'Demo-Legend_Top.gbr', 'Demo-Profile.gbr', 'Demo-Plated_1-2_PTH_Drill.gbr']));
    const top = files.find((f) => f.name === 'Demo-Copper_Signal_Top.gbr')!.text;
    expect(top).toContain('%TF.FileFunction,Copper,L1,Top*%');
    expect(top).toContain('%TF.FilePolarity,Positive*%');
    expect(top).toMatch(/%TF\.GenerationSoftware,Konium,Konium Designer,[^*]+\*%/);
    expect(top).toContain('%TF.CreationDate,2026-10-27T19:00:00+00:00*%');
    expect(top).toContain('%TA.AperFunction,SMDPad,CuDef*%');
    expect(top).toContain('%TA.AperFunction,Conductor*%');
    expect(top).toMatch(/%TO\.N,GND\*%/);
    expect(top).toMatch(/%TO\.P,U1,\d+\*%/);
    expect(top).toContain('%TO.C,U1*%');
    // Every aperture with a function has it set where it's defined; the object dictionary is cleared at the end
    for (const m of top.matchAll(/%TA\.AperFunction,[^*]+\*%\n%ADD(\d+)/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(10);
    expect(top.trimEnd().split('\n').slice(-2)).toEqual(['%TD*%', 'M02*']);
    expect(files.find((f) => f.name === 'Demo-Soldermask_Top.gbr')!.text).toContain('%TF.FilePolarity,Negative*%');
    expect(files.find((f) => f.name === 'Demo-Profile.gbr')!.text).toContain('%TA.AperFunction,Profile*%');
    const drill = files.find((f) => f.name === 'Demo-Plated_1-2_PTH_Drill.gbr')!.text;
    expect(drill).toContain('%TF.FileFunction,Plated,1,2,PTH*%');
    expect(drill).toContain('%TA.AperFunction,ViaDrill*%');
    expect((drill.match(/D03\*/g) ?? []).length).toBe(holes(doc).filter((h) => h.plated).length);
  });
  it('plain Gerber stays without attributes', () => {
    const doc = demo();
    for (const f of gerberFiles(doc, defaultGerberSetup(doc)).files) expect(f.text).not.toMatch(/%T[AOFD]/);
  });
});

describe('IPC-2581', () => {
  it('a well-formed revision B file with the stackup, packages, components, nets, features and holes', () => {
    const doc = demo();
    const x = ipc2581(doc, { when });
    expect(wellFormed(x)).toBe(true);
    expect(x).toContain('<IPC-2581 revision="B" xmlns="http://webstds.ipc.org/2581"');
    expect(x).toContain('<Layer name="Top Layer" layerFunction="SIGNAL" side="TOP" polarity="POSITIVE"/>');
    expect(x).toMatch(/<StackupLayer layerOrGroupRef="Top Layer" thickness="0\.0\d+"/);
    expect(x).toMatch(/<Component refDes="U1" packageRef="[^"]+" layerRef="Top Layer"/);
    expect(x).toMatch(/<LogicalNet name="GND">(<PinRef componentRef="[A-Z]+\d+" pin="\d+"\/>)+<\/LogicalNet>/);
    expect(x).toMatch(/<LayerFeature layerRef="Top Layer">[\s\S]*?<Set net="[^"]+"/);
    expect(x).toMatch(/<Pad>(<Xform rotation="[\d.]+"\/>)?<Location x="[\d.-]+" y="[\d.-]+"\/><StandardPrimitiveRef id="PRIM_\d+"\/><PinRef componentRef="U1"/);
    expect((x.match(/<Hole /g) ?? []).length).toBe(holes(doc).length);
    expect(x).toMatch(/<Profile><Polygon><PolyBegin x="0" y="0"\/>/);
    // Every primitive referred to is in the dictionary
    for (const m of x.matchAll(/StandardPrimitiveRef id="([^"]+)"/g)) expect(x).toMatch(new RegExp(`<Entry(Standard|User) id="${m[1]}">`));
  });
});

describe('ODB++', () => {
  it('a matrix in stack order, features per layer, components and nets', () => {
    const doc = demo();
    const files = odbFiles(doc, { when });
    const get = (p: string) => files.find((f) => f.name === `demo/${p}`)?.text ?? '';
    const matrix = get('matrix/matrix');
    const names = [...matrix.matchAll(/NAME=(\S+)/g)].map((m) => m[1]);
    expect(names.slice(0, 2)).toEqual(['PCB', 'comp_+_top']);
    expect(names.indexOf('top_layer')).toBeLessThan(names.indexOf('bottom_layer'));
    expect(names.indexOf('top_solder')).toBeLessThan(names.indexOf('top_layer'));
    expect(matrix).toMatch(/TYPE=DRILL\n   NAME=drill_1-2\n   POLARITY=POSITIVE\n   START_NAME=top_layer\n   END_NAME=bottom_layer/);
    const top = get('steps/pcb/layers/top_layer/features');
    expect(top).toMatch(/^UNITS=MM/);
    expect(top).toMatch(/\$0 r\d+/);
    expect(top).toMatch(/\nL [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ \d+ P 0\n/);
    expect(top).toMatch(/\nP [\d.-]+ [\d.-]+ \d+ P 0 (0|8 [\d.]+) ;0\n/);
    const eda = get('steps/pcb/eda/data');
    expect(eda).toMatch(/^HDR Konium Designer/);
    expect(eda).toMatch(/NET gnd\n(SNT [^\n]+\n(FID C \d+ \d+\n)*)+/);
    expect(eda).toMatch(/SNT TOP T \d+ \d+\nFID C 0 \d+/);
    expect(eda).toMatch(/\nPKG \S+ [\d.]+ /);
    const comps = get('steps/pcb/layers/comp_+_top/components');
    expect(comps).toMatch(/CMP \d+ [\d.-]+ [\d.-]+ [\d.]+ N U1 /);
    expect(comps).toMatch(/\nTOP 0 [\d.-]+ [\d.-]+ [\d.]+ N \d+ \d+ \S+/);
    expect(get('steps/pcb/profile')).toMatch(/S P 0\nOB [\d.-]+ [\d.-]+ I\n/);
    expect(get('misc/info')).toContain('ODB_VERSION_MAJOR=7');
  });
  it('packs the job as a .tgz', async () => {
    const a = await odbArchive(demo(), { when });
    expect(a.name).toBe('demo.tgz');
    expect([a.bytes[0], a.bytes[1]]).toEqual([0x1f, 0x8b]);
    const tarBytes = new Uint8Array(await new Response(new Blob([a.bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    expect(tarBytes.length % 512).toBe(0);
    const first = new TextDecoder().decode(tarBytes.subarray(0, 100)).replace(/\0+$/, '');
    expect(first).toBe('demo/');
    expect(new TextDecoder().decode(tarBytes.subarray(257, 262))).toBe('ustar');
    expect(new TextDecoder('latin1').decode(tarBytes)).toContain('demo/matrix/matrix');
  });
});

/** A cylinder model with a product (r 1, 2 high), as the embedded STEP files are. */
const cylinderStep = () => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('cyl'),'2;1');
ENDSEC;
DATA;
#1=CARTESIAN_POINT('',(0.,0.,0.));#2=DIRECTION('',(0.,0.,1.));#3=DIRECTION('',(1.,0.,0.));
#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);#5=CARTESIAN_POINT('',(0.,0.,2.));#6=AXIS2_PLACEMENT_3D('',#5,#2,#3);
#7=CIRCLE('',#4,1.);#8=CIRCLE('',#6,1.);#9=CARTESIAN_POINT('',(1.,0.,0.));#10=VERTEX_POINT('',#9);
#11=CARTESIAN_POINT('',(1.,0.,2.));#12=VERTEX_POINT('',#11);#13=EDGE_CURVE('',#10,#10,#7,.T.);#14=EDGE_CURVE('',#12,#12,#8,.T.);
#15=DIRECTION('',(0.,0.,1.));#16=VECTOR('',#15,1.);#17=LINE('',#9,#16);#18=EDGE_CURVE('',#10,#12,#17,.T.);
#19=ORIENTED_EDGE('',*,*,#13,.T.);#20=ORIENTED_EDGE('',*,*,#18,.T.);#21=ORIENTED_EDGE('',*,*,#14,.F.);#22=ORIENTED_EDGE('',*,*,#18,.F.);
#23=EDGE_LOOP('',(#19,#20,#21,#22));#24=FACE_OUTER_BOUND('',#23,.T.);#25=CYLINDRICAL_SURFACE('',#4,1.);#26=ADVANCED_FACE('',(#24),#25,.T.);
#27=PLANE('',#4);#28=ORIENTED_EDGE('',*,*,#13,.F.);#29=EDGE_LOOP('',(#28));#30=FACE_OUTER_BOUND('',#29,.T.);#31=ADVANCED_FACE('',(#30),#27,.F.);
#32=PLANE('',#6);#33=ORIENTED_EDGE('',*,*,#14,.T.);#34=EDGE_LOOP('',(#33));#35=FACE_OUTER_BOUND('',#34,.T.);#36=ADVANCED_FACE('',(#35),#32,.T.);
#37=CLOSED_SHELL('',(#26,#31,#36));#38=MANIFOLD_SOLID_BREP('cyl; with a semicolon',#37);
#39=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#38,#4),#40);
#40=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#41,#42))REPRESENTATION_CONTEXT('',''));
#41=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));#42=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#50=APPLICATION_CONTEXT('automotive design');#51=PRODUCT_CONTEXT('',#50,'mechanical');#52=PRODUCT('cyl','cyl','',(#51));
#53=PRODUCT_DEFINITION_FORMATION('','',#52);#54=PRODUCT_DEFINITION_CONTEXT('part definition',#50,'design');
#55=PRODUCT_DEFINITION('design','',#53,#54);#56=PRODUCT_DEFINITION_SHAPE('','',#55);#57=SHAPE_DEFINITION_REPRESENTATION(#56,#39);
ENDSEC;
END-ISO-10303-21;
`;

async function withModel(doc: PcbDocument): Promise<void> {
  const text = new TextEncoder().encode(cylinderStep());
  const zipped = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const rec = new TextEncoder().encode('|EMBED=TRUE|ID={CYL}|CHECKSUM=1|NAME=cyl.step');
  const data = new Uint8Array(4 + rec.length);
  new DataView(data.buffer).setUint32(0, rec.length, true);
  data.set(rec, 4);
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'Models/Data', data);
  cfbPut(root, 'Models/0', zipped);
  (doc as { cfb: { root: typeof root } }).cfb = { ...doc.cfb, root };
  const c = doc.components.findIndex((x) => x.designator === 'C1');
  const at = doc.components[c]!.at;
  const body = encodeBody({ component: c, outline: [{ x: at.x - mm(1), y: at.y - mm(1) }, { x: at.x + mm(1), y: at.y - mm(1) }, { x: at.x + mm(1), y: at.y + mm(1) }, { x: at.x - mm(1), y: at.y + mm(1) }],
    standoff: 0, overall: mm(2), colour: 0x808080, layer: L.MECH1, at, id: '{CYL}', modelType: 1, extra: { 'MODEL.3D.ROTZ': '90.000' } });
  new UndoStack().transact('body', (t) => t.add(addPrimRecords(doc, [{ storage: 'ComponentBodies6', rec: body }])));
}

describe('STEP export', () => {
  it('writes reals and strings as STEP wants them', () => {
    expect([real(1), real(-0), real(2.5), real(1e-9), real(-3)]).toEqual(['1.', '0.', '2.5', '0.', '-3.']);
    expect(stepStr("C1 'x' µ")).toBe("'C1 ''x'' \\X2\\00B5\\X0\\'");
  });
  it('renumbers a model past ours, strings and comments left alone', () => {
    const r = renumber(cylinderStep(), 1000);
    expect(r.max).toBe(57);
    expect(r.stmts[0]).toBe("#1001=CARTESIAN_POINT('',(0.,0.,0.));");
    expect(r.stmts.find((s) => s.includes('MANIFOLD_SOLID_BREP'))).toBe("#1038=MANIFOLD_SOLID_BREP('cyl; with a semicolon',#1037);");
    expect(modelRoot(parseStep(cylinderStep()))).toEqual({ pd: 55, rep: 39 });
  });
  it('a part whose model cannot be written is named, not left out without a word (26.200)', async () => {
    const doc = demo();
    await withModel(doc);
    const models = embeddedModels(doc.cfb.root);
    // Its model there and readable: nothing left out
    const all: string[] = [];
    const whole = await exportStep(doc, { models, when, leftOut: all });
    expect(all).toEqual([]);
    // Not among the files given, or not STEP at all: the part is named, and is not in the file
    for (const broken of [new Map(), new Map([...models].map(([k, f]) => [k, { ...f, data: new TextEncoder().encode('solid cube\nendsolid') }]))]) {
      const left: string[] = [];
      const text = await exportStep(doc, { models: broken as typeof models, when, leftOut: left });
      expect(left).toEqual(['C1']);
      expect(text.length).toBeLessThan(whole.length);
      expect(text).not.toContain('MANIFOLD_SOLID_BREP');
    }
    expect(leftOutWords(['C1'])).toBe('Not in the file: the 3D model of C1. It could not be read as STEP, so the board is written without it.');
    expect(leftOutWords(['J1', 'U3', 'J1'])).toBe('Not in the file: the 3D models of 2 parts, J1, U3. They could not be read as STEP, so the board is written without them.');
    expect(leftOutWords(Array.from({ length: 11 }, (_, k) => `R${k + 1}`))).toContain('R8 and 3 more.');
  });
  it('the board a solid with its holes, the bodies parts, an embedded model merged and placed', async () => {
    const doc = demo();
    await withModel(doc);
    const text = await exportStep(doc, { models: embeddedModels(doc.cfb.root), when });
    expect(text.startsWith('ISO-10303-21;')).toBe(true);
    expect(text).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));");
    const f = parseStep(text);
    const of = (t: string) => [...f.values()].filter((e) => e.type === t);
    // Board, every component with extrusions, and the model: a part each, placed in the assembly
    const nauo = of('NEXT_ASSEMBLY_USAGE_OCCURRENCE');
    expect(nauo.map((e) => (e.args[1] as { s: string }).s)).toEqual(expect.arrayContaining(['Demo PCB', 'C1']));
    expect(of('MANIFOLD_SOLID_BREP')).toHaveLength(1); // the model's own solid, kept exact
    expect(of('CYLINDRICAL_SURFACE')).toHaveLength(1);
    expect(of('FACETED_BREP').length).toBeGreaterThanOrEqual(1);
    // Every reference points at an entity in the file, and references are written as such
    for (const m of text.matchAll(/#(\d+)/g)) expect(f.has(Number(m[1]))).toBe(true);
    for (const e of of('AXIS2_PLACEMENT_3D')) expect(e.args.slice(1).every((a) => isRef(a))).toBe(true);
    for (const e of of('FACE_SURFACE')) expect([e.args[2], ...(e.args[1] as unknown[])].every((a) => isRef(a as never))).toBe(true);
    for (const t of ['FACETED_BREP', 'PLANE', 'FACE_OUTER_BOUND', 'SURFACE_STYLE_FILL_AREA']) for (const e of of(t)) expect(e.args.some((a) => isRef(a))).toBe(true);
    // The board's shell: top and bottom faces plus a wall per outline edge and per hole edge
    const shell = of('CLOSED_SHELL')[0]!;
    const faces = (shell.args[1] as unknown[]).length;
    const holeEdges = holes(doc).reduce((a, h) => a + (h.size / 2 > 0.6 * 393700.787 ? 24 : 12), 0);
    expect(faces).toBe(2 + doc.board.outline.length + holeEdges);
  });
});
