import { describe, expect, it } from 'vitest';
import { parseStep } from '../src/formats/step/parse';
import { tessellateStep, type StepModel, type V3 } from '../src/formats/step/tessellate';
import { bodyTransform, embeddedModels, loadModel, type StepBody } from '../src/render/gl3d/stepBodies';
import { cfbPut, newEntry } from '../src/formats/cfb/cfb';
import { UNITS_PER_MM } from '../src/core/units';

/** A STEP file of the given DATA lines (#ids as written). */
const step = (lines: string[]) => `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nENDSEC;\nDATA;\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;

const units = (len = '( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )', extra: string[] = []) => [
  `#40 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#41,#42)) REPRESENTATION_CONTEXT('','') );`,
  `#41 = ${len};`,
  `#42 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );`,
  ...extra,
];
/** A cylinder r 1, height 2 on the origin: side (with a seam), bottom and top; red. */
const cylinder = (len?: string, extra: string[] = []) => [
  `#1 = CARTESIAN_POINT('',(0.,0.,0.));`, `#2 = DIRECTION('',(0.,0.,1.));`, `#3 = DIRECTION('',(1.,0.,0.));`,
  `#4 = AXIS2_PLACEMENT_3D('',#1,#2,#3);`, `#5 = CARTESIAN_POINT('',(0.,0.,2.));`, `#6 = AXIS2_PLACEMENT_3D('',#5,#2,#3);`,
  `#7 = CIRCLE('',#4,1.);`, `#8 = CIRCLE('',#6,1.);`,
  `#9 = CARTESIAN_POINT('',(1.,0.,0.));`, `#10 = VERTEX_POINT('',#9);`, `#11 = CARTESIAN_POINT('',(1.,0.,2.));`, `#12 = VERTEX_POINT('',#11);`,
  `#13 = EDGE_CURVE('',#10,#10,#7,.T.);`, `#14 = EDGE_CURVE('',#12,#12,#8,.T.);`,
  `#15 = DIRECTION('',(0.,0.,1.));`, `#16 = VECTOR('',#15,1.);`, `#17 = LINE('',#9,#16);`, `#18 = EDGE_CURVE('',#10,#12,#17,.T.);`,
  `#19 = ORIENTED_EDGE('',*,*,#13,.T.);`, `#20 = ORIENTED_EDGE('',*,*,#18,.T.);`, `#21 = ORIENTED_EDGE('',*,*,#14,.F.);`, `#22 = ORIENTED_EDGE('',*,*,#18,.F.);`,
  `#23 = EDGE_LOOP('',(#19,#20,#21,#22));`, `#24 = FACE_OUTER_BOUND('',#23,.T.);`,
  `#25 = CYLINDRICAL_SURFACE('',#4,1.);`, `#26 = ADVANCED_FACE('',(#24),#25,.T.);`,
  `#27 = PLANE('',#4);`, `#28 = ORIENTED_EDGE('',*,*,#13,.F.);`, `#29 = EDGE_LOOP('',(#28));`, `#30 = FACE_OUTER_BOUND('',#29,.T.);`, `#31 = ADVANCED_FACE('',(#30),#27,.F.);`,
  `#32 = PLANE('',#6);`, `#33 = ORIENTED_EDGE('',*,*,#14,.T.);`, `#34 = EDGE_LOOP('',(#33));`, `#35 = FACE_OUTER_BOUND('',#34,.T.);`, `#36 = ADVANCED_FACE('',(#35),#32,.T.);`,
  `#37 = CLOSED_SHELL('',(#26,#31,#36));`, `#38 = MANIFOLD_SOLID_BREP('cyl',#37);`,
  `#39 = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#38,#4),#40);`,
  ...units(len, extra),
  `#44 = COLOUR_RGB('',1.,0.,0.);`, `#45 = FILL_AREA_STYLE_COLOUR('',#44);`, `#46 = FILL_AREA_STYLE('',(#45));`, `#47 = SURFACE_STYLE_FILL_AREA(#46);`,
  `#48 = SURFACE_SIDE_STYLE('',(#47));`, `#49 = SURFACE_STYLE_USAGE(.BOTH.,#48);`, `#50 = PRESENTATION_STYLE_ASSIGNMENT((#49));`, `#51 = STYLED_ITEM('',(#50),#38);`,
];

function stats(m: StepModel) {
  let area = 0, tris = 0;
  for (const s of m.meshes) for (let i = 0; i < s.idx.length; i += 3) {
    const p = (k: number): V3 => [s.pos[s.idx[i + k]! * 3]!, s.pos[s.idx[i + k]! * 3 + 1]!, s.pos[s.idx[i + k]! * 3 + 2]!];
    const a = p(0), b = p(1), c = p(2);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    area += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
    tris++;
  }
  return { area, tris };
}
const close = (a: number[], b: number[], tol = 1e-3) => a.every((x, i) => Math.abs(x - b[i]!) < tol);

describe('STEP reader', () => {
  it('reads simple and complex instances, strings, enumerations, typed values and lists', () => {
    const f = parseStep(step([
      `#1 = PRODUCT('it''s','x',$,(#2,#3));`,
      `#2=( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );`,
      `#3 = MEASURE(LENGTH_MEASURE(25.4),*, -1.5E-2, .T.);`,
      `/* a comment */ #4 = CARTESIAN_POINT ( 'p' , ( 1. , -2.5 , 3.0E+1 ) ) ;`,
    ]));
    expect(f.get(1)).toEqual({ type: 'PRODUCT', args: [{ s: "it's" }, { s: 'x' }, null, [{ r: 2 }, { r: 3 }]] });
    expect([...f.get(2)!.parts!.keys()]).toEqual(['LENGTH_UNIT', 'NAMED_UNIT', 'SI_UNIT']);
    expect(f.get(2)!.parts!.get('SI_UNIT')).toEqual([{ e: 'MILLI' }, { e: 'METRE' }]);
    expect(f.get(3)!.args).toEqual([{ t: 'LENGTH_MEASURE', a: [25.4] }, null, -0.015, { e: 'T' }]);
    expect(f.get(4)!.args[1]).toEqual([1, -2.5, 30]);
  });
});

describe('STEP to triangles', () => {
  it('a cylinder: its side round the seam and both ends, red from its STYLED_ITEM, the right size', () => {
    const m = tessellateStep(parseStep(step(cylinder())));
    expect(m.failed).toBe(0);
    expect(m.faces).toBe(3);
    expect(m.meshes.map((s) => s.colour)).toEqual([[1, 0, 0, 1]]);
    expect(close(m.min, [-1, -1, 0], 1e-2) && close(m.max, [1, 1, 2], 1e-2)).toBe(true);
    // Area 2πrh + 2πr² within a percent (chords cut a little off)
    const { area } = stats(m);
    expect(area / (6 * Math.PI)).toBeGreaterThan(0.99);
    expect(area / (6 * Math.PI)).toBeLessThan(1.001);
    // The side's normals point out
    const s = m.meshes[0]!;
    let out = 0, inward = 0;
    for (let i = 0; i < s.pos.length; i += 3) {
      if (s.pos[i + 2]! < 0.1 || s.pos[i + 2]! > 1.9) continue;
      const d = s.pos[i]! * s.nrm[i]! + s.pos[i + 1]! * s.nrm[i + 1]!;
      if (d > 0.5) out++; else if (d < -0.5) inward++;
    }
    expect(out).toBeGreaterThan(10);
    expect(inward).toBe(0);
  });

  it('inches: a CONVERSION_BASED_UNIT scales the model to millimetres', () => {
    const m = tessellateStep(parseStep(step(cylinder('( CONVERSION_BASED_UNIT(\'INCH\',#43) LENGTH_UNIT() NAMED_UNIT(#45) )', [
      `#43 = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#52);`, `#52 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );`,
    ]))));
    expect(close(m.max, [25.4, 25.4, 50.8], 0.3)).toBe(true);
  });

  it('a hemisphere cap closes at its pole on the side its face lies', () => {
    const lines = [
      `#1 = CARTESIAN_POINT('',(0.,0.,0.));`, `#2 = DIRECTION('',(0.,0.,1.));`, `#3 = DIRECTION('',(1.,0.,0.));`, `#4 = AXIS2_PLACEMENT_3D('',#1,#2,#3);`,
      `#7 = CIRCLE('',#4,1.);`, `#9 = CARTESIAN_POINT('',(1.,0.,0.));`, `#10 = VERTEX_POINT('',#9);`, `#13 = EDGE_CURVE('',#10,#10,#7,.T.);`,
      `#19 = ORIENTED_EDGE('',*,*,#13,.T.);`, `#23 = EDGE_LOOP('',(#19));`, `#24 = FACE_OUTER_BOUND('',#23,.T.);`,
      `#25 = SPHERICAL_SURFACE('',#4,1.);`, `#26 = ADVANCED_FACE('',(#24),#25,.T.);`,
      `#28 = ORIENTED_EDGE('',*,*,#13,.F.);`, `#29 = EDGE_LOOP('',(#28));`, `#30 = FACE_OUTER_BOUND('',#29,.T.);`, `#27 = PLANE('',#4);`, `#31 = ADVANCED_FACE('',(#30),#27,.F.);`,
      `#37 = CLOSED_SHELL('',(#26,#31));`, `#38 = MANIFOLD_SOLID_BREP('dome',#37);`, `#39 = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#38),#40);`, ...units(),
    ];
    const m = tessellateStep(parseStep(step(lines)));
    expect(m.failed).toBe(0);
    expect(m.min[2]).toBeGreaterThan(-1e-6);
    expect(m.max[2]).toBeGreaterThan(0.99);
    expect(m.meshes[0]!.colour).toEqual([0.75, 0.75, 0.75, 1]);
    const { area } = stats(m);
    expect(area / (3 * Math.PI)).toBeGreaterThan(0.985);
    // (thin cells round the pole stand a little proud)
    expect(area / (3 * Math.PI)).toBeLessThan(1.01);
  });

  it('a sphere on its side, halved by a circle through its poles: each half on its own side', () => {
    const lines = [
      `#1 = CARTESIAN_POINT('',(0.,0.,0.));`, `#2 = DIRECTION('',(0.,1.,0.));`, `#3 = DIRECTION('',(-1.,0.,0.));`, `#4 = AXIS2_PLACEMENT_3D('',#1,#2,#3);`,
      `#5 = DIRECTION('',(0.,0.,1.));`, `#6 = DIRECTION('',(1.,0.,0.));`, `#7 = AXIS2_PLACEMENT_3D('',#1,#5,#6);`, `#8 = CIRCLE('',#7,1.);`,
      `#9 = DIRECTION('',(0.,0.,-1.));`, `#10 = AXIS2_PLACEMENT_3D('',#1,#9,#6);`, `#11 = CIRCLE('',#10,1.);`,
      `#12 = CARTESIAN_POINT('',(0.,1.,0.));`, `#13 = VERTEX_POINT('',#12);`, `#14 = CARTESIAN_POINT('',(0.,-1.,0.));`, `#15 = VERTEX_POINT('',#14);`,
      `#16 = EDGE_CURVE('',#13,#15,#8,.T.);`, `#17 = EDGE_CURVE('',#13,#15,#11,.T.);`,
      `#20 = ORIENTED_EDGE('',*,*,#16,.T.);`, `#21 = ORIENTED_EDGE('',*,*,#17,.F.);`, `#22 = EDGE_LOOP('',(#20,#21));`, `#23 = FACE_OUTER_BOUND('',#22,.T.);`,
      `#24 = ORIENTED_EDGE('',*,*,#17,.T.);`, `#25 = ORIENTED_EDGE('',*,*,#16,.F.);`, `#26 = EDGE_LOOP('',(#24,#25));`, `#27 = FACE_OUTER_BOUND('',#26,.T.);`,
      `#28 = SPHERICAL_SURFACE('',#4,1.);`, `#29 = ADVANCED_FACE('',(#23),#28,.T.);`, `#30 = ADVANCED_FACE('',(#27),#28,.T.);`,
      `#37 = CLOSED_SHELL('',(#29,#30));`, `#38 = MANIFOLD_SOLID_BREP('ball',#37);`, `#39 = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#38),#40);`, ...units(),
    ];
    const m = tessellateStep(parseStep(step(lines)));
    expect(m.failed).toBe(0);
    expect(close(m.min, [-1, -1, -1], 0.02) && close(m.max, [1, 1, 1], 0.02)).toBe(true);
    const { area } = stats(m);
    expect(area / (4 * Math.PI)).toBeGreaterThan(0.98);
    expect(area / (4 * Math.PI)).toBeLessThan(1.01);
  });

  it('an assembly places its part by the ITEM_DEFINED_TRANSFORMATION (part item onto assembly item)', () => {
    const m = tessellateStep(parseStep(step([...cylinder(),
      `#60 = SHAPE_REPRESENTATION('',(#61),#40);`, `#61 = AXIS2_PLACEMENT_3D('',#1,#2,#3);`,
      `#62 = CARTESIAN_POINT('',(10.,0.,0.));`, `#63 = AXIS2_PLACEMENT_3D('',#62,#2,#3);`,
      `#64 = ITEM_DEFINED_TRANSFORMATION('','',#4,#63);`,
      `#65 = ( REPRESENTATION_RELATIONSHIP('','',#39,#60) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#64) SHAPE_REPRESENTATION_RELATIONSHIP() );`,
    ])));
    expect(close(m.min, [9, -1, 0], 1e-2) && close(m.max, [11, 1, 2], 1e-2)).toBe(true);
  });

  it('a shape aspect\'s copy of a placed part (Creo\'s "solid data with which properties are associated") is not drawn again at the origin', () => {
    const m = tessellateStep(parseStep(step([...cylinder(),
      `#60 = SHAPE_REPRESENTATION('',(#61),#40);`, `#61 = AXIS2_PLACEMENT_3D('',#1,#2,#3);`,
      `#62 = CARTESIAN_POINT('',(10.,0.,0.));`, `#63 = AXIS2_PLACEMENT_3D('',#62,#2,#3);`,
      `#64 = ITEM_DEFINED_TRANSFORMATION('','',#4,#63);`,
      `#65 = ( REPRESENTATION_RELATIONSHIP('','',#39,#60) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#64) SHAPE_REPRESENTATION_RELATIONSHIP() );`,
      `#70 = PRODUCT_DEFINITION_SHAPE('','part',$);`, `#71 = SHAPE_ASPECT('','solid data associated with part',#70,.F.);`,
      `#72 = PROPERTY_DEFINITION('','shape for solid data with which properties are associated',#71);`,
      `#73 = SHAPE_REPRESENTATION('',(#38),#40);`, `#74 = SHAPE_DEFINITION_REPRESENTATION(#72,#73);`,
    ])));
    expect(close(m.min, [9, -1, 0], 1e-2) && close(m.max, [11, 1, 2], 1e-2)).toBe(true);
  });
});

describe('embedded models on the board', () => {
  const model = (min: V3, max: V3): StepModel => ({ meshes: [], min, max, faces: 1, failed: 0 });
  const body = (o: Partial<StepBody>): StepBody => ({ component: 0, modelId: 'X', name: 'x.step', at: { x: 0, y: 0 }, rot: [0, 0, 0], dz: 0, bottom: false, standoff: 0, overall: 0, outline: [], opacity: 1, ...o });
  it('turned about X, then Y, then Z, and raised by DZ above the top surface', () => {
    // A model 1 wide (x), 2 deep (y), 3 high (z) from z −1
    const m = model([0, 0, -1], [1, 2, 2]);
    const xf = bodyTransform(body({ rot: [90, 0, 90], dz: 0.5, at: { x: 10 * UNITS_PER_MM, y: 0 } }), m, { x: 0, y: 0 }, 1.6);
    // X 90 takes y up to z; then Z 90 takes x to y
    const p = (q: V3) => [xf.o[0] + xf.x[0] * q[0] + xf.y[0] * q[1] + xf.z[0] * q[2], xf.o[1] + xf.x[1] * q[0] + xf.y[1] * q[1] + xf.z[1] * q[2], xf.o[2] + xf.x[2] * q[0] + xf.y[2] * q[1] + xf.z[2] * q[2]];
    expect(close(p([1, 0, 0]), [10, 1, 2.1])).toBe(true);
    expect(close(p([0, 1, 0]), [10, 0, 3.1])).toBe(true);
  });
  it('underneath: turned over about X, so x stays, y and the heights (from the bottom surface) reverse', () => {
    const m = model([-1, -1, -0.5], [1, 2, 3]);
    const xf = bodyTransform(body({ rot: [0, 0, 90], bottom: true, dz: 0.25 }), m, { x: 0, y: 0 }, 1.6);
    const p = (q: V3) => [xf.o[0] + xf.x[0] * q[0] + xf.y[0] * q[1] + xf.z[0] * q[2], xf.o[1] + xf.x[1] * q[0] + xf.y[1] * q[1] + xf.z[1] * q[2], xf.o[2] + xf.x[2] * q[0] + xf.y[2] * q[1] + xf.z[2] * q[2]];
    // Z 90 takes the model's +y to −x; turned over: x kept, y reversed; 3 high plus DZ goes down to −3.25
    expect(close(p([0, 2, 0]), [-2, 0, -0.25])).toBe(true);
    expect(close(p([1, 0, 0]), [0, -1, -0.25])).toBe(true);
    expect(close(p([0, 0, 3]), [0, 0, -3.25])).toBe(true);
  });
  it('reads Models/Data and the zlib-compressed model streams, and tessellates once per model', async () => {
    const text = new TextEncoder().encode(step(cylinder()));
    const zipped = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const rec = new TextEncoder().encode('|EMBED=TRUE|ID={ABC}|CHECKSUM=1|NAME=cyl.step');
    const data = new Uint8Array(4 + rec.length);
    new DataView(data.buffer).setUint32(0, rec.length, true);
    data.set(rec, 4);
    const root = newEntry('Root Entry', 'root');
    cfbPut(root, 'Models/Data', data);
    cfbPut(root, 'Models/0', zipped);
    const files = embeddedModels(root);
    expect([...files.keys()]).toEqual(['{ABC}']);
    const a = loadModel('t:{ABC}', files.get('{ABC}')!.data), b = loadModel('t:{ABC}', files.get('{ABC}')!.data);
    expect(a).toBe(b);
    const m = await a;
    expect(m?.faces).toBe(3);
  });
});
