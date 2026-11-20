/**
 * File › Export › STEP 3D (and the Output Job's Export STEP): the board as an AP214 assembly —
 * the bare board a solid (its shape, cut-outs and drill holes, the layer stack's thickness),
 * each component a part of its own named by designator: its embedded STEP models placed as
 * they are (their own exact geometry, merged into the file and positioned by a transformation),
 * its extruded bodies as solids. Millimetres from the board's origin, z up from the board's
 * underside [est: where AD puts z = 0]. Faceted solids (planar faces bounded by polygons)
 * stand for the board and extrusions [est: AD writes exact B-rep].
 */
import { UNITS_PER_MM } from '../../core/units';
import type { Vec2 } from '../../core/geom';
import { L } from '../../model/layers';
import type { PcbDocument } from '../../model/pcb';
import { boardThickness, componentBodies, type RGBA } from '../../render/gl3d/boardModel';
import { bodyTransform, stepBodies, type ModelFiles } from '../../render/gl3d/stepBodies';
import { parseStep, refOf, type StepFile } from './parse';
import type { V3, Xf } from './tessellate';

const BOARD_COLOUR: RGBA = [0.07, 0.36, 0.19, 1];

/** A STEP real: always with a decimal point. */
export function real(v: number): string {
  const r = Math.round(v * 1e6) / 1e6;
  if (Object.is(r, -0) || r === 0) return '0.';
  const s = String(r);
  if (s.includes('e')) { const [m, e] = s.split('e'); return `${m!.includes('.') ? m : `${m}.`}E${e}`; }
  return s.includes('.') ? s : `${s}.`;
}
/** A STEP string: quotes doubled, backslashes doubled, anything past ASCII as \X2\…\X0\. */
export function stepStr(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "'") out += "''";
    else if (ch === '\\') out += '\\\\';
    else if (c >= 0x20 && c < 0x7f) out += ch;
    else if (c <= 0xffff) out += `\\X2\\${c.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
    else out += `\\X4\\${c.toString(16).toUpperCase().padStart(8, '0')}\\X0\\`;
  }
  return `'${out}'`;
}

export class Writer {
  n = 0;
  lines: string[] = [];
  add(s: string): number { this.lines.push(`#${++this.n}=${s};`); return this.n; }
  /** Raw statements from another file, their numbers moved past ours. */
  merge(stmts: string[]): void { for (const s of stmts) this.lines.push(s); }
}

/** A closed polygon CCW (positive area). */
function ccw(p: Vec2[]): Vec2[] {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const u = p[i]!, v = p[(i + 1) % p.length]!; a += u.x * v.y - v.x * u.y; }
  return a >= 0 ? p : [...p].reverse();
}
const dedupe = (p: Vec2[]) => p.filter((v, i) => { const w = p[(i + 1) % p.length]!; return Math.abs(v.x - w.x) > 1e-7 || Math.abs(v.y - w.y) > 1e-7; });

/** Writes faceted solids: extrusions of a polygon with holes, and triangle sets. */
class Solids {
  constructor(private w: Writer) {}
  private pts = new Map<string, number>();
  point(x: number, y: number, z: number): number {
    const k = `${real(x)},${real(y)},${real(z)}`;
    let id = this.pts.get(k);
    if (id === undefined) { id = this.w.add(`CARTESIAN_POINT('',(${k}))`); this.pts.set(k, id); }
    return id;
  }
  private dir(v: V3): number { return this.w.add(`DIRECTION('',(${v.map(real).join(',')}))`); }
  axis(o: V3, z: V3, x: V3): number { return this.w.add(`AXIS2_PLACEMENT_3D('',#${this.w.add(`CARTESIAN_POINT('',(${o.map(real).join(',')}))`)},#${this.dir(z)},#${this.dir(x)})`); }
  /** A planar face: the outer loop CCW about the normal, holes CW. */
  face(outer: V3[], holes: V3[][], n: V3): number {
    const ref: V3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    // x direction: ref minus its normal part
    const d = ref[0] * n[0] + ref[1] * n[1] + ref[2] * n[2];
    const xr: V3 = [ref[0] - d * n[0], ref[1] - d * n[1], ref[2] - d * n[2]];
    const l = Math.hypot(...xr);
    const plane = this.w.add(`PLANE('',#${this.axis(outer[0]!, n, [xr[0] / l, xr[1] / l, xr[2] / l])})`);
    const loop = (p: V3[]) => this.w.add(`POLY_LOOP('',(${p.map((v) => `#${this.point(v[0], v[1], v[2])}`).join(',')}))`);
    const bounds = [this.w.add(`FACE_OUTER_BOUND('',#${loop(outer)},.T.)`), ...holes.map((h) => this.w.add(`FACE_BOUND('',#${loop(h)},.T.)`))];
    return this.w.add(`FACE_SURFACE('',(${bounds.map((b) => `#${b}`).join(',')}),#${plane},.T.)`);
  }
  /** An outline (with holes) extruded from z0 to z1. */
  prism(name: string, outline: Vec2[], holes: Vec2[][], z0: number, z1: number): number {
    const o = ccw(dedupe(outline)), hs = holes.map((h) => [...ccw(dedupe(h))].reverse()).filter((h) => h.length >= 3);
    const at = (p: Vec2[], z: number): V3[] => p.map((v) => [v.x, v.y, z]);
    const faces = [
      this.face(at(o, z1), hs.map((h) => at(h, z1)), [0, 0, 1]),
      this.face(at([...o].reverse(), z0), hs.map((h) => at([...h].reverse(), z0)), [0, 0, -1]),
    ];
    // Walls: each edge of the outline faces out; each edge of a hole faces into the hole
    for (const loop of [o, ...hs]) for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
      faces.push(this.face([[a.x, a.y, z0], [b.x, b.y, z0], [b.x, b.y, z1], [a.x, a.y, z1]], [], [dy / l, -dx / l, 0]));
    }
    return this.w.add(`FACETED_BREP(${stepStr(name)},#${this.w.add(`CLOSED_SHELL('',(${faces.map((f) => `#${f}`).join(',')}))`)})`);
  }
}

/** The colour of a solid, gathered for the presentation representation. */
export function styled(w: Writer, item: number, c: RGBA): number {
  const colour = w.add(`COLOUR_RGB('',${real(c[0])},${real(c[1])},${real(c[2])})`);
  const fill = w.add(`FILL_AREA_STYLE('',(#${w.add(`FILL_AREA_STYLE_COLOUR('',#${colour})`)}))`);
  const side = w.add(`SURFACE_SIDE_STYLE('',(#${w.add(`SURFACE_STYLE_FILL_AREA(#${fill})`)}))`);
  const psa = w.add(`PRESENTATION_STYLE_ASSIGNMENT((#${w.add(`SURFACE_STYLE_USAGE(.BOTH.,#${side})`)}))`);
  return w.add(`STYLED_ITEM('',(#${psa}),#${item})`);
}

/** A merged model: the product definition and shape representation the assembly links to. */
interface Embedded { stmts: string[]; pd: number; rep: number }

/** The DATA section of a STEP file as statements, every #n moved up by `offset`; and the highest number. */
export function renumber(text: string, offset: number): { stmts: string[]; max: number } {
  const start = text.search(/\bDATA\s*;/i);
  if (start < 0) return { stmts: [], max: 0 };
  const body = text.slice(text.indexOf(';', start) + 1);
  const stmts: string[] = [];
  let cur = '', inStr = false, max = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) {
      cur += ch;
      if (ch === "'") { if (body[i + 1] === "'") { cur += "'"; i++; } else inStr = false; }
      continue;
    }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === '#') {
      let j = i + 1;
      while (j < body.length && body.charCodeAt(j) >= 48 && body.charCodeAt(j) <= 57) j++;
      if (j > i + 1) { const v = Number(body.slice(i + 1, j)); max = Math.max(max, v); cur += `#${v + offset}`; i = j - 1; continue; }
    }
    if (ch === '/' && body[i + 1] === '*') { const e = body.indexOf('*/', i + 2); i = e < 0 ? body.length : e + 1; continue; }
    if (ch === ';') {
      const s = cur.trim();
      if (/^ENDSEC$/i.test(s)) break;
      if (s) stmts.push(`${s.replace(/\s*\n\s*/g, ' ')};`);
      cur = '';
      continue;
    }
    cur += ch;
  }
  return { stmts, max };
}

/** The root product definition of a model and its shape representation. */
export function modelRoot(f: StepFile): { pd: number; rep: number } | null {
  const related = new Set<number>();
  for (const e of f.values()) if (e.type === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE') related.add(refOf(e.args[4]));
  const pdShape = new Map<number, number>(); // PRODUCT_DEFINITION_SHAPE id → its product definition
  for (const [id, e] of f) if (e.type === 'PRODUCT_DEFINITION_SHAPE') pdShape.set(id, refOf(e.args[2]));
  let best: { pd: number; rep: number } | null = null;
  for (const e of f.values()) {
    if (e.type !== 'SHAPE_DEFINITION_REPRESENTATION') continue;
    const pd = pdShape.get(refOf(e.args[0]));
    if (pd === undefined || !f.get(pd)?.type.startsWith('PRODUCT_DEFINITION')) continue;
    const rep = refOf(e.args[1]);
    if (!related.has(pd)) return { pd, rep };
    best ??= { pd, rep };
  }
  return best;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Holes drilled through the board, as polygons (board units). */
function drillLoops(doc: PcbDocument): Vec2[][] {
  const out: Vec2[][] = [];
  for (const p of doc.prims) {
    const hole = p.kind === 'via' ? p.hole : p.kind === 'pad' && p.layer === L.MULTI ? p.hole : 0;
    if (!hole || (p.kind !== 'via' && p.kind !== 'pad')) continue;
    const r = hole / 2, seg = r > 0.6 * UNITS_PER_MM ? 24 : 12;
    out.push(Array.from({ length: seg }, (_, i) => ({ x: p.at.x + r * Math.cos((i / seg) * 2 * Math.PI), y: p.at.y + r * Math.sin((i / seg) * 2 * Math.PI) })));
  }
  return out;
}

export interface StepExportOptions {
  models?: ModelFiles; when?: Date; name?: string; holes?: boolean; /** Only these components' bodies (all when absent). */ components?: Set<number>;
  /** Filled with the parts whose 3D model could not be written (not in the file, or not readable as STEP): they are not in what is returned. */
  leftOut?: string[];
}

/**
 * What to say of parts left out of an exported model. A board handed on for a fit check with a
 * part missing looks complete, so whoever exports it is told which parts are not there.
 */
export function leftOutWords(left: string[]): string {
  const names = [...new Set(left)];
  return `Not in the file: ${names.length === 1 ? 'the 3D model of' : `the 3D models of ${names.length} parts,`} ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` and ${names.length - 8} more` : ''}. ${names.length === 1 ? 'It' : 'They'} could not be read as STEP, so the board is written without ${names.length === 1 ? 'it' : 'them'}.`;
}

export async function exportStep(doc: PcbDocument, o: StepExportOptions = {}): Promise<string> {
  const w = new Writer();
  const s = new Solids(w);
  const t = boardThickness(doc);
  const origin = doc.board.origin;
  const mm = (v: Vec2): Vec2 => ({ x: (v.x - origin.x) / UNITS_PER_MM, y: (v.y - origin.y) / UNITS_PER_MM });
  const name = o.name ?? doc.name.replace(/\.pcbdoc$/i, '');

  // Shared context: millimetres, radians
  const app = w.add(`APPLICATION_CONTEXT('automotive design')`);
  w.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${app})`);
  const prodCtx = w.add(`PRODUCT_CONTEXT('',#${app},'mechanical')`);
  const pdCtx = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`);
  const len = w.add(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const ang = w.add(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const sol = w.add(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const unc = w.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${len},'distance_accuracy_value','confusion accuracy')`);
  const ctx = w.add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${len},#${ang},#${sol}))REPRESENTATION_CONTEXT('Context3D','3D Context with UNIT and UNCERTAINTY'))`);

  const product = (pname: string) => {
    const prod = w.add(`PRODUCT(${stepStr(pname)},${stepStr(pname)},'',(#${prodCtx}))`);
    w.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${prod}))`);
    const pdf = w.add(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
    const pd = w.add(`PRODUCT_DEFINITION('design','',#${pdf},#${pdCtx})`);
    return { pd, pds: w.add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`) };
  };
  const ident = () => s.axis([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const styledItems: number[] = [];

  // The assembly
  const top = product(name);
  const topItems: number[] = [ident()];
  const instances: { pd: number; rep: number; xf: Xf; label: string }[] = [];

  // The bare board
  if (doc.board.outline.length >= 3) {
  const board = product(`${name} PCB`);
  const cutouts = doc.prims.filter((p) => p.kind === 'region' && p.boardCutout).map((p) => (p.kind === 'region' ? p.outline : [])).filter((c) => c.length >= 3);
  const holes = o.holes === false ? [] : drillLoops(doc);
  const boardSolid = s.prism(`${name} PCB`, doc.board.outline.map(mm), [...cutouts, ...holes].map((h) => h.map(mm)), 0, t);
  styledItems.push(styled(w, boardSolid, BOARD_COLOUR));
  const boardRep = w.add(`FACETED_BREP_SHAPE_REPRESENTATION(${stepStr(`${name} PCB`)},(#${ident()},#${boardSolid}),#${ctx})`);
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${board.pds},#${boardRep})`);
  instances.push({ pd: board.pd, rep: boardRep, xf: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], o: [0, 0, 0] }, label: `${name} PCB` });
  }

  // Extruded bodies, a part per component (those with a STEP model shown by it instead)
  const keep = (c: number) => !o.components || o.components.has(c);
  const steps = stepBodies(doc).filter((b) => keep(b.component));
  const bodies = componentBodies(doc, t).filter((b) => !b.step && keep(b.component));
  const byComp = new Map<number, typeof bodies>();
  for (const b of bodies) byComp.set(b.component, [...(byComp.get(b.component) ?? []), b]);
  for (const [c, bs] of byComp) {
    const des = doc.components[c]?.designator ?? `Body${c}`;
    const part = product(des);
    const solids = bs.map((b, i) => {
      const id = s.prism(`${des} body ${i + 1}`, b.outline.map(mm), [], Math.min(b.z0, b.z1), Math.max(b.z0, b.z1));
      styledItems.push(styled(w, id, b.colour));
      return id;
    });
    const rep = w.add(`FACETED_BREP_SHAPE_REPRESENTATION(${stepStr(des)},(#${ident()},${solids.map((x) => `#${x}`).join(',')}),#${ctx})`);
    w.add(`SHAPE_DEFINITION_REPRESENTATION(#${part.pds},#${rep})`);
    instances.push({ pd: part.pd, rep, xf: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], o: [0, 0, 0] }, label: des });
  }

  // Embedded STEP models, each merged once (its numbers moved past ours), placed per body
  const merged = new Map<string, Embedded | null>();
  for (const b of steps) {
    if (!merged.has(b.modelId)) {
      merged.set(b.modelId, null);
      const f = o.models?.get(b.modelId);
      if (f) {
        try {
          const raw = f.data[0] === 0x78 ? await inflate(f.data) : f.data;
          const text = new TextDecoder('latin1').decode(raw);
          const root = modelRoot(parseStep(text));
          if (root) {
            const base = w.n;
            const { stmts, max } = renumber(text, base);
            w.merge(stmts);
            w.n = base + max;
            merged.set(b.modelId, { stmts: [], pd: root.pd + base, rep: root.rep + base });
          }
        } catch { /* unreadable model: left out */ }
      }
    }
    const e = merged.get(b.modelId);
    const label = doc.components[b.component]?.designator ?? b.name;
    if (!e) { o.leftOut?.push(label); continue; }
    instances.push({ pd: e.pd, rep: e.rep, xf: bodyTransform(b, null as never, origin, t), label });
  }

  // Each part placed in the assembly
  const axes = instances.map((inst) => s.axis(inst.xf.o, inst.xf.z, inst.xf.x));
  const topRep = w.add(`SHAPE_REPRESENTATION(${stepStr(name)},(${[...topItems, ...axes].map((x) => `#${x}`).join(',')}),#${ctx})`);
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${top.pds},#${topRep})`);
  instances.forEach((inst, k) => {
    const nauo = w.add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE(${stepStr(`NAUO${k + 1}`)},${stepStr(inst.label)},'',#${top.pd},#${inst.pd},$)`);
    const pds = w.add(`PRODUCT_DEFINITION_SHAPE(${stepStr(inst.label)},'',#${nauo})`);
    const idt = w.add(`ITEM_DEFINED_TRANSFORMATION('','',#${ident()},#${axes[k]})`);
    const rr = w.add(`(REPRESENTATION_RELATIONSHIP('','',#${inst.rep},#${topRep})REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${idt})SHAPE_REPRESENTATION_RELATIONSHIP())`);
    w.add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${rr},#${pds})`);
  });
  w.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styledItems.map((x) => `#${x}`).join(',')}),#${ctx})`);

  const when = (o.when ?? new Date()).toISOString().slice(0, 19);
  return [
    'ISO-10303-21;', 'HEADER;',
    `FILE_DESCRIPTION((${stepStr(`${name}: board and components`)}),'2;1');`,
    `FILE_NAME(${stepStr(`${name}.step`)},'${when}',(''),(''),'Konium Designer','Konium Designer','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", 'ENDSEC;', 'DATA;',
    ...w.lines, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
}


/* ── STEP documents (the 3D model editor): parts merged into one assembly ── */

export interface AssemblyPart { name: string; text: string; xf: Xf; colour: RGBA | null }

/** A model's text with every colour it names made this one (its faces, shells and solids alike). */
export function recolour(text: string, c: RGBA): string {
  const rgb = `${real(c[0])},${real(c[1])},${real(c[2])}`;
  return text
    .replace(/COLOUR_RGB\(\s*('(?:[^']|'')*'|\$)\s*,[^,)]*,[^,)]*,[^,)]*\)/gi, (_m, n: string) => `COLOUR_RGB(${n},${rgb})`)
    .replace(/DRAUGHTING_PRE_DEFINED_COLOUR\(\s*'(?:[^']|'')*'\s*\)/gi, `COLOUR_RGB('',${rgb})`);
}

const SOLIDS = new Set(['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL']);

/**
 * The 3D model editor's document as one AP214 file: an assembly named after it, each part's own
 * file merged in (its numbers moved past the ones before) and placed by a transformation, a part
 * given a colour of its own recoloured throughout.
 */
export function exportAssembly(name: string, parts: AssemblyPart[], when?: Date): string {
  const w = new Writer();
  const s = new Solids(w);
  const app = w.add(`APPLICATION_CONTEXT('automotive design')`);
  w.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${app})`);
  const prodCtx = w.add(`PRODUCT_CONTEXT('',#${app},'mechanical')`);
  const pdCtx = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`);
  const len = w.add(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const ang = w.add(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const sol = w.add(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const unc = w.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${len},'distance_accuracy_value','confusion accuracy')`);
  const ctx = w.add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${len},#${ang},#${sol}))REPRESENTATION_CONTEXT('Context3D','3D Context with UNIT and UNCERTAINTY'))`);
  const prod = w.add(`PRODUCT(${stepStr(name)},${stepStr(name)},'',(#${prodCtx}))`);
  w.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${prod}))`);
  const topPd = w.add(`PRODUCT_DEFINITION('design','',#${w.add(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`)},#${pdCtx})`);
  const topPds = w.add(`PRODUCT_DEFINITION_SHAPE('','',#${topPd})`);
  const ident = () => s.axis([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const styledItems: number[] = [];
  const instances: { pd: number; rep: number; xf: Xf; label: string }[] = [];
  for (const part of parts) {
    const text = part.colour ? recolour(part.text, part.colour) : part.text;
    let f: StepFile;
    try { f = parseStep(text); } catch { continue; }
    const base = w.n;
    const { stmts, max } = renumber(text, base);
    w.merge(stmts);
    w.n = base + max;
    let root = modelRoot(f);
    if (!root) {
      // Geometry with no product of its own: one made for its first shape representation
      const rep = [...f].find(([, e]) => /SHAPE_REPRESENTATION$/.test(e.type) || e.type === 'SHAPE_REPRESENTATION')?.[0];
      if (rep === undefined) continue;
      const pr = w.add(`PRODUCT(${stepStr(part.name)},${stepStr(part.name)},'',(#${prodCtx}))`);
      const pd = w.add(`PRODUCT_DEFINITION('design','',#${w.add(`PRODUCT_DEFINITION_FORMATION('','',#${pr})`)},#${pdCtx})`);
      w.add(`SHAPE_DEFINITION_REPRESENTATION(#${w.add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`)},#${rep + base})`);
      root = { pd: pd - base, rep };
      instances.push({ pd, rep: rep + base, xf: part.xf, label: part.name });
    } else instances.push({ pd: root.pd + base, rep: root.rep + base, xf: part.xf, label: part.name });
    // A colour of its own: on every solid too (models that colour nothing)
    if (part.colour) for (const [id, e] of f) if (SOLIDS.has(e.type)) styledItems.push(styled(w, id + base, part.colour));
  }
  const axes = instances.map((inst) => s.axis(inst.xf.o, inst.xf.z, inst.xf.x));
  const topRep = w.add(`SHAPE_REPRESENTATION(${stepStr(name)},(${[ident(), ...axes].map((x) => `#${x}`).join(',')}),#${ctx})`);
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${topPds},#${topRep})`);
  instances.forEach((inst, k) => {
    const nauo = w.add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE(${stepStr(`NAUO${k + 1}`)},${stepStr(inst.label)},'',#${topPd},#${inst.pd},$)`);
    const pds = w.add(`PRODUCT_DEFINITION_SHAPE(${stepStr(inst.label)},'',#${nauo})`);
    const idt = w.add(`ITEM_DEFINED_TRANSFORMATION('','',#${ident()},#${axes[k]})`);
    const rr = w.add(`(REPRESENTATION_RELATIONSHIP('','',#${inst.rep},#${topRep})REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${idt})SHAPE_REPRESENTATION_RELATIONSHIP())`);
    w.add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${rr},#${pds})`);
  });
  if (styledItems.length) w.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styledItems.map((x) => `#${x}`).join(',')}),#${ctx})`);
  return stepText(name, w.lines, when);
}

/** A whole STEP file around these DATA statements. */
export function stepText(name: string, lines: string[], when?: Date): string {
  const at = (when ?? new Date()).toISOString().slice(0, 19);
  return [
    'ISO-10303-21;', 'HEADER;',
    `FILE_DESCRIPTION((${stepStr(name)}),'2;1');`,
    `FILE_NAME(${stepStr(`${name}.step`)},'${at}',(''),(''),'Konium Designer','Konium Designer','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", 'ENDSEC;', 'DATA;',
    ...lines, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
}

/**
 * Shapes made in the 3D model editor, as exact B-rep in a file of their own (mm), standing on z = 0
 * centred on the Z axis: a box (w × d, h tall; its upright edges filleted or chamfered by `corner`),
 * a cylinder (radius r, h tall; its top, bottom or both rims filleted or chamfered by `edge`), a
 * cone or frustum (r1 at the bottom, r2 at the top, 0 a point) and a dome (half a sphere).
 */
export type Primitive =
  | { kind: 'box'; w: number; d: number; h: number; corner?: number; corners?: 'fillet' | 'chamfer' }
  | { kind: 'cylinder'; r: number; h: number; edge?: number; edges?: 'fillet' | 'chamfer'; rims?: 'top' | 'bottom' | 'both' }
  | { kind: 'cone'; r1: number; r2: number; h: number }
  | { kind: 'dome'; r: number };

/** A stretch of an outline: a line, or an arc about c (anticlockwise or not). */
type Seg2 = { a: [number, number]; b: [number, number]; c?: [number, number]; ccw?: boolean };
const EPS = 1e-9;

/** A box's outline (anticlockwise) with its corners rounded or cut by r. */
function boxOutline(w: number, d: number, r: number, cut: boolean): Seg2[] {
  const x0 = -w / 2, x1 = w / 2, y0 = -d / 2, y1 = d / 2;
  const k = Math.min(r, w / 2, d / 2);
  const out: Seg2[] = [];
  const line = (a: [number, number], b: [number, number]) => { if (Math.hypot(b[0] - a[0], b[1] - a[1]) > EPS) out.push({ a, b }); };
  const corner = (a: [number, number], b: [number, number], c: [number, number]) => out.push(cut ? { a, b } : { a, b, c, ccw: true });
  line([x0 + k, y0], [x1 - k, y0]); corner([x1 - k, y0], [x1, y0 + k], [x1 - k, y0 + k]);
  line([x1, y0 + k], [x1, y1 - k]); corner([x1, y1 - k], [x1 - k, y1], [x1 - k, y1 - k]);
  line([x1 - k, y1], [x0 + k, y1]); corner([x0 + k, y1], [x0, y1 - k], [x0 + k, y1 - k]);
  line([x0, y1 - k], [x0, y0 + k]); corner([x0, y0 + k], [x0 + k, y0], [x0 + k, y0 + k]);
  return out;
}

/** A profile in (radius, z), anticlockwise from the axis back to it, of a shape turned about Z. */
function turnedProfile(p: Primitive): Seg2[] {
  const out: Seg2[] = [];
  const line = (a: [number, number], b: [number, number]) => { if (Math.hypot(b[0] - a[0], b[1] - a[1]) > EPS) out.push({ a, b }); };
  if (p.kind === 'cone') { line([0, 0], [p.r1, 0]); line([p.r1, 0], [p.r2, p.h]); line([p.r2, p.h], [0, p.h]); }
  else if (p.kind === 'dome') { line([0, 0], [p.r, 0]); out.push({ a: [p.r, 0], b: [0, p.r], c: [0, 0], ccw: true }); }
  else if (p.kind === 'cylinder') {
    const rims = p.rims ?? 'top', e = Math.min(p.edge ?? 0, p.r, rims === 'both' ? p.h / 2 : p.h), cut = p.edges === 'chamfer';
    const eb = rims !== 'top' ? e : 0, et = rims !== 'bottom' ? e : 0;
    line([0, 0], [p.r - eb, 0]);
    if (eb > EPS) out.push(cut ? { a: [p.r - eb, 0], b: [p.r, eb] } : { a: [p.r - eb, 0], b: [p.r, eb], c: [p.r - eb, eb], ccw: true });
    line([p.r, eb], [p.r, p.h - et]);
    if (et > EPS) out.push(cut ? { a: [p.r, p.h - et], b: [p.r - et, p.h] } : { a: [p.r, p.h - et], b: [p.r - et, p.h], c: [p.r - et, p.h - et], ccw: true });
    line([p.r - et, p.h], [0, p.h]);
  }
  return out;
}

export function primitiveStep(p: Primitive, name: string, colour: RGBA, when?: Date): string {
  if (p.kind === 'cone' || p.kind === 'dome' || (p.kind === 'cylinder' && (p.edge ?? 0) > EPS) || (p.kind === 'box' && (p.corner ?? 0) > EPS)) return profileStep(p, name, colour, when);
  const w = new Writer();
  const app = w.add(`APPLICATION_CONTEXT('automotive design')`);
  w.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${app})`);
  const prodCtx = w.add(`PRODUCT_CONTEXT('',#${app},'mechanical')`);
  const pdCtx = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`);
  const len = w.add(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const ang = w.add(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const sol = w.add(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const unc = w.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${len},'distance_accuracy_value','confusion accuracy')`);
  const ctx = w.add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${len},#${ang},#${sol}))REPRESENTATION_CONTEXT('Context3D','3D Context with UNIT and UNCERTAINTY'))`);
  const pt = (v: V3) => w.add(`CARTESIAN_POINT('',(${v.map(real).join(',')}))`);
  const dir = (v: V3) => w.add(`DIRECTION('',(${v.map(real).join(',')}))`);
  const axis = (o: V3, z: V3, x: V3) => w.add(`AXIS2_PLACEMENT_3D('',#${pt(o)},#${dir(z)},#${dir(x)})`);
  const vtx = (v: V3) => w.add(`VERTEX_POINT('',#${pt(v)})`);
  const line = (a: V3, b: V3) => { const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d) || 1; return w.add(`LINE('',#${pt(a)},#${w.add(`VECTOR('',#${dir([d[0] / l, d[1] / l, d[2] / l])},${real(l)})`)})`); };
  const face = (edges: [number, boolean][], surf: number, sense = true) => {
    const loop = w.add(`EDGE_LOOP('',(${edges.map(([e, f]) => `#${w.add(`ORIENTED_EDGE('',*,*,#${e},${f ? '.T.' : '.F.'})`)}`).join(',')}))`);
    return w.add(`ADVANCED_FACE('',(#${w.add(`FACE_OUTER_BOUND('',#${loop},.T.)`)}),#${surf},${sense ? '.T.' : '.F.'})`);
  };
  const faces: number[] = [];
  if (p.kind === 'box') {
    const X = [-p.w / 2, p.w / 2], Y = [-p.d / 2, p.d / 2], Z = [0, p.h];
    const corner = (i: number, j: number, k: number): V3 => [X[i]!, Y[j]!, Z[k]!];
    const vs = new Map<string, number>(), es = new Map<string, number>();
    const V = (c: [number, number, number]) => { const k = c.join(''); let id = vs.get(k); if (id === undefined) { id = vtx(corner(...c)); vs.set(k, id); } return id; };
    const E = (a: [number, number, number], b: [number, number, number]): [number, boolean] => {
      const ka = a.join(''), kb = b.join(''), key = ka < kb ? `${ka}-${kb}` : `${kb}-${ka}`;
      let id = es.get(key);
      const [lo, hi] = ka < kb ? [a, b] : [b, a];
      if (id === undefined) { id = w.add(`EDGE_CURVE('',#${V(lo)},#${V(hi)},#${line(corner(...lo), corner(...hi))},.T.)`); es.set(key, id); }
      return [id, ka < kb];
    };
    // Each face's corners anticlockwise seen from outside, and its outward normal
    const F: [[number, number, number][], V3, V3][] = [
      [[[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], [0, 0, -1], [1, 0, 0]],
      [[[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], [0, 0, 1], [1, 0, 0]],
      [[[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [0, -1, 0], [1, 0, 0]],
      [[[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], [0, 1, 0], [1, 0, 0]],
      [[[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], [-1, 0, 0], [0, 1, 0]],
      [[[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], [1, 0, 0], [0, 1, 0]],
    ];
    for (const [cs, n, x] of F) {
      const plane = w.add(`PLANE('',#${axis(corner(...cs[0]!), n, x)})`);
      faces.push(face(cs.map((c, i) => E(c, cs[(i + 1) % 4]!)), plane));
    }
  } else {
    const { r, h } = p;
    const v0 = vtx([r, 0, 0]), v1 = vtx([r, 0, h]);
    const c0 = w.add(`CIRCLE('',#${axis([0, 0, 0], [0, 0, 1], [1, 0, 0])},${real(r)})`), c1 = w.add(`CIRCLE('',#${axis([0, 0, h], [0, 0, 1], [1, 0, 0])},${real(r)})`);
    const e0 = w.add(`EDGE_CURVE('',#${v0},#${v0},#${c0},.T.)`), e1 = w.add(`EDGE_CURVE('',#${v1},#${v1},#${c1},.T.)`);
    const seam = w.add(`EDGE_CURVE('',#${v0},#${v1},#${line([r, 0, 0], [r, 0, h])},.T.)`);
    faces.push(face([[e1, true]], w.add(`PLANE('',#${axis([0, 0, h], [0, 0, 1], [1, 0, 0])})`)));
    faces.push(face([[e0, false]], w.add(`PLANE('',#${axis([0, 0, 0], [0, 0, -1], [1, 0, 0])})`)));
    faces.push(face([[e0, true], [seam, true], [e1, false], [seam, false]], w.add(`CYLINDRICAL_SURFACE('',#${axis([0, 0, 0], [0, 0, 1], [1, 0, 0])},${real(r)})`)));
  }
  const solid = w.add(`MANIFOLD_SOLID_BREP(${stepStr(name)},#${w.add(`CLOSED_SHELL('',(${faces.map((f) => `#${f}`).join(',')}))`)})`);
  const rep = w.add(`ADVANCED_BREP_SHAPE_REPRESENTATION(${stepStr(name)},(#${axis([0, 0, 0], [0, 0, 1], [1, 0, 0])},#${solid}),#${ctx})`);
  const prod = w.add(`PRODUCT(${stepStr(name)},${stepStr(name)},'',(#${prodCtx}))`);
  w.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${prod}))`);
  const pd = w.add(`PRODUCT_DEFINITION('design','',#${w.add(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`)},#${pdCtx})`);
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${w.add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`)},#${rep})`);
  w.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(#${styled(w, solid, colour)}),#${ctx})`);
  return stepText(name, w.lines, when);
}

/** A shape from an outline: a box's (lines and arcs, stood up h tall) or a turned one's (about Z), exact B-rep. */
function profileStep(p: Primitive, name: string, colour: RGBA, when?: Date): string {
  const w = new Writer();
  const app = w.add(`APPLICATION_CONTEXT('automotive design')`);
  w.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${app})`);
  const prodCtx = w.add(`PRODUCT_CONTEXT('',#${app},'mechanical')`);
  const pdCtx = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`);
  const len = w.add(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const ang = w.add(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const sol = w.add(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const unc = w.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${len},'distance_accuracy_value','confusion accuracy')`);
  const ctx = w.add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${len},#${ang},#${sol}))REPRESENTATION_CONTEXT('Context3D','3D Context with UNIT and UNCERTAINTY'))`);
  const pt = (v: V3) => w.add(`CARTESIAN_POINT('',(${v.map(real).join(',')}))`);
  const dir = (v: V3) => w.add(`DIRECTION('',(${v.map(real).join(',')}))`);
  const axis = (o: V3, z: V3, x: V3) => w.add(`AXIS2_PLACEMENT_3D('',#${pt(o)},#${dir(z)},#${dir(x)})`);
  const vtx = (v: V3) => w.add(`VERTEX_POINT('',#${pt(v)})`);
  const line = (a: V3, b: V3) => { const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d) || 1; return w.add(`LINE('',#${pt(a)},#${w.add(`VECTOR('',#${dir([d[0] / l, d[1] / l, d[2] / l])},${real(l)})`)})`); };
  const edge = (a: number, b: number, curve: number, sense = true) => w.add(`EDGE_CURVE('',#${a},#${b},#${curve},${sense ? '.T.' : '.F.'})`);
  const loop = (edges: [number, boolean][]) => w.add(`EDGE_LOOP('',(${edges.map(([e, f]) => `#${w.add(`ORIENTED_EDGE('',*,*,#${e},${f ? '.T.' : '.F.'})`)}`).join(',')}))`);
  const face = (bounds: [number, boolean][][], surf: number, sense = true) => {
    const b = bounds.map((l, i) => w.add(`${i ? 'FACE_BOUND' : 'FACE_OUTER_BOUND'}('',#${loop(l)},.T.)`));
    return w.add(`ADVANCED_FACE('',(${b.map((x) => `#${x}`).join(',')}),#${surf},${sense ? '.T.' : '.F.'})`);
  };
  const faces: number[] = [];
  if (p.kind === 'box') {
    const segs = boxOutline(p.w, p.d, p.corner ?? 0, p.corners === 'chamfer'), n = segs.length, h = p.h;
    const vb = segs.map((s) => vtx([s.a[0], s.a[1], 0])), vt = segs.map((s) => vtx([s.a[0], s.a[1], h]));
    const along = (i: number, z: number, vs: number[]) => {
      const s = segs[i]!, a = vs[i]!, b = vs[(i + 1) % n]!;
      if (!s.c) return edge(a, b, line([s.a[0], s.a[1], z], [s.b[0], s.b[1], z]));
      const r = Math.hypot(s.a[0] - s.c[0], s.a[1] - s.c[1]);
      return edge(a, b, w.add(`CIRCLE('',#${axis([s.c[0], s.c[1], z], [0, 0, 1], [1, 0, 0])},${real(r)})`), s.ccw !== false);
    };
    const eb = segs.map((_, i) => along(i, 0, vb)), et = segs.map((_, i) => along(i, h, vt));
    const ev = segs.map((s, i) => edge(vb[i]!, vt[i]!, line([s.a[0], s.a[1], 0], [s.a[0], s.a[1], h])));
    faces.push(face([[...eb].reverse().map((e): [number, boolean] => [e, false])], w.add(`PLANE('',#${axis([0, 0, 0], [0, 0, -1], [1, 0, 0])})`)));
    faces.push(face([et.map((e): [number, boolean] => [e, true])], w.add(`PLANE('',#${axis([0, 0, h], [0, 0, 1], [1, 0, 0])})`)));
    segs.forEach((s, i) => {
      const j = (i + 1) % n;
      let surf: number, sense = true;
      if (s.c) { surf = w.add(`CYLINDRICAL_SURFACE('',#${axis([s.c[0], s.c[1], 0], [0, 0, 1], [1, 0, 0])},${real(Math.hypot(s.a[0] - s.c[0], s.a[1] - s.c[1]))})`); sense = s.ccw !== false; }
      else { const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], l = Math.hypot(dx, dy); surf = w.add(`PLANE('',#${axis([s.a[0], s.a[1], 0], [dy / l, -dx / l, 0], [dx / l, dy / l, 0])})`); }
      faces.push(face([[[eb[i]!, true], [ev[j]!, true], [et[i]!, false], [ev[i]!, false]]], surf, sense));
    });
  } else {
    const segs = turnedProfile(p);
    const P: [number, number][] = [segs[0]!.a, ...segs.map((s) => s.b)];
    const V = P.map(([r, z]) => vtx([r, 0, z]));
    const C = P.map(([r, z], k) => (r > EPS ? edge(V[k]!, V[k]!, w.add(`CIRCLE('',#${axis([0, 0, z], [0, 0, 1], [1, 0, 0])},${real(r)})`)) : null));
    segs.forEach((s, i) => {
      const [ra, za] = s.a, [rb, zb] = s.b, dr = rb - ra, dz = zb - za;
      if (!s.c && Math.abs(dz) < EPS) {
        // A flat ring or disc: facing down if the outline runs outwards along it
        const up = dr < 0;
        const outer = ra > rb ? C[i] : C[i + 1], inner = ra > rb ? C[i + 1] : C[i];
        if (!outer) return;
        faces.push(face([[[outer, up]], ...(inner ? [[[inner, !up] as [number, boolean]]] : [])], w.add(`PLANE('',#${axis([0, 0, za], [0, 0, up ? 1 : -1], [1, 0, 0])})`)));
        return;
      }
      let seam: number, surf: number, sense: boolean;
      if (s.c) {
        const a = Math.hypot(ra - s.c[0], za - s.c[1]);
        seam = edge(V[i]!, V[i + 1]!, w.add(`CIRCLE('',#${axis([s.c[0], 0, s.c[1]], [0, -1, 0], [1, 0, 0])},${real(a)})`), s.ccw !== false);
        surf = s.c[0] < EPS ? w.add(`SPHERICAL_SURFACE('',#${axis([0, 0, s.c[1]], [0, 0, 1], [1, 0, 0])},${real(a)})`)
          : w.add(`TOROIDAL_SURFACE('',#${axis([0, 0, s.c[1]], [0, 0, 1], [1, 0, 0])},${real(s.c[0])},${real(a)})`);
        sense = s.ccw !== false;
      } else {
        seam = edge(V[i]!, V[i + 1]!, line([ra, 0, za], [rb, 0, zb]));
        if (Math.abs(dr) < EPS) surf = w.add(`CYLINDRICAL_SURFACE('',#${axis([0, 0, 0], [0, 0, 1], [1, 0, 0])},${real(ra)})`);
        else {
          // The cone's placement at its narrow end, its axis the way it widens
          const [rl, zl, zh] = ra < rb ? [ra, za, zb] : [rb, zb, za];
          surf = w.add(`CONICAL_SURFACE('',#${axis([0, 0, zl], [0, 0, zh > zl ? 1 : -1], [1, 0, 0])},${real(rl)},${real(Math.atan(Math.abs(dr) / Math.abs(dz)))})`);
        }
        sense = dz > 0;
      }
      const l: [number, boolean][] = [];
      if (C[i]) l.push([C[i]!, true]);
      l.push([seam, true]);
      if (C[i + 1]) l.push([C[i + 1]!, false]);
      l.push([seam, false]);
      faces.push(face([l], surf, sense));
    });
  }
  const solid = w.add(`MANIFOLD_SOLID_BREP(${stepStr(name)},#${w.add(`CLOSED_SHELL('',(${faces.map((f) => `#${f}`).join(',')}))`)})`);
  const rep = w.add(`ADVANCED_BREP_SHAPE_REPRESENTATION(${stepStr(name)},(#${axis([0, 0, 0], [0, 0, 1], [1, 0, 0])},#${solid}),#${ctx})`);
  const prod = w.add(`PRODUCT(${stepStr(name)},${stepStr(name)},'',(#${prodCtx}))`);
  w.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${prod}))`);
  const pd = w.add(`PRODUCT_DEFINITION('design','',#${w.add(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`)},#${pdCtx})`);
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${w.add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`)},#${rep})`);
  w.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(#${styled(w, solid, colour)}),#${ctx})`);
  return stepText(name, w.lines, when);
}
