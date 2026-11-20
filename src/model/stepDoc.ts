/**
 * The 3D model editor's document (a .step / .stp file): its parts, each a STEP model of its own
 * (the file as opened, another one imported, or a box or cylinder made here) with its placement
 * (millimetres, a turn and a move) and, if given one, a colour of its own. Saved unchanged, the
 * file as it was; changed, an AP214 assembly of the parts (formats/step/write exportAssembly).
 * Undo and redo keep the parts as they were (they are never changed in place).
 */
import { IDENT, Tessellator, apply, compose, type RGBA, type V3, type Xf } from '../formats/step/tessellate';
import { Writer, exportAssembly, primitiveStep, renumber, stepStr, stepText, type Primitive } from '../formats/step/write';
import { argsOf, parseStep, refOf, str, type StepFile } from '../formats/step/parse';
import { isStl, stlBytesToStep } from '../formats/stl';

export interface StepPart {
  id: string;
  name: string;
  /** The part as a STEP file (as read, or made for a primitive). */
  text: string;
  /** Placement in the document (mm). */
  xf: Xf;
  /** A colour of its own over the model's (all of it), or none. */
  colour: RGBA | null;
  /** Hidden in the view (still saved). */
  hidden: boolean;
  /** A box or cylinder made here: its sizes and colour, to change them. */
  prim?: { shape: Primitive; colour: RGBA };
}
export interface StepDocument {
  kind: 'StepDoc';
  name: string;
  parts: StepPart[];
  dirty: boolean;
  /** The file as opened (saved back as it was while nothing changed). */
  original: Uint8Array | null;
  undo: { parts: StepPart[]; label: string }[];
  redo: { parts: StepPart[]; label: string }[];
}

const latin1 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return s; };
const bytesOf = (s: string) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
export const stem = (name: string) => name.replace(/\.(step|stp|stl)$/i, '');
let seq = 0;
const newId = () => `p${Date.now().toString(36)}${(++seq).toString(36)}`;

/** Whether bytes are a STEP file (ISO 10303-21). */
export const isStep = (bytes: Uint8Array, name: string): boolean => /\.(step|stp)$/i.test(name) || /^\s*ISO-10303-21\s*;/.test(latin1(bytes.subarray(0, 64)));

export function readStepDoc(bytes: Uint8Array, name: string): StepDocument {
  // An STL opens as a STEP model of its triangles, to be saved as one
  if (!/\.(step|stp)$/i.test(name) && isStl(bytes, name)) {
    const s = stlBytesToStep(bytes, name);
    return { kind: 'StepDoc', name: s.name, parts: [{ id: newId(), name: stem(s.name), text: latin1(s.bytes), xf: IDENT, colour: null, hidden: false }], dirty: true, original: null, undo: [], redo: [] };
  }
  return { kind: 'StepDoc', name, parts: [{ id: newId(), name: stem(name), text: latin1(bytes), xf: IDENT, colour: null, hidden: false }], dirty: false, original: bytes, undo: [], redo: [] };
}
export function newStepDoc(name: string): StepDocument {
  return { kind: 'StepDoc', name, parts: [], dirty: true, original: null, undo: [], redo: [] };
}

const isIdent = (m: Xf) => [m.x, m.y, m.z, m.o].every((v, i) => v.every((c, k) => Math.abs(c - (i < 3 && i === k ? 1 : 0)) < 1e-12));

/** The file to save: as opened while it's unchanged, else the parts as an assembly. */
export function writeStepDoc(doc: StepDocument, when?: Date): Uint8Array {
  const p = doc.parts[0];
  if (doc.original && doc.parts.length === 1 && p && isIdent(p.xf) && !p.colour && p.text === latin1(doc.original)) return doc.original;
  return bytesOf(exportAssembly(stem(doc.name), doc.parts.map((x) => ({ name: x.name, text: x.text, xf: x.xf, colour: x.colour })), when));
}

/** Change the parts (one undo step). */
export function editParts(doc: StepDocument, label: string, parts: StepPart[]): void {
  doc.undo.push({ parts: doc.parts, label });
  if (doc.undo.length > 200) doc.undo.shift();
  doc.redo = [];
  doc.parts = parts;
  doc.dirty = true;
}
export function undoStep(doc: StepDocument): string | null {
  const u = doc.undo.pop();
  if (!u) return null;
  doc.redo.push({ parts: doc.parts, label: u.label });
  doc.parts = u.parts; doc.dirty = true;
  return u.label;
}
export function redoStep(doc: StepDocument): string | null {
  const r = doc.redo.pop();
  if (!r) return null;
  doc.undo.push({ parts: doc.parts, label: r.label });
  doc.parts = r.parts; doc.dirty = true;
  return r.label;
}

/* ── placements ── */

/** A turn about the X, Y or Z axis through the origin (degrees). */
export function turn(axis: 'x' | 'y' | 'z', deg: number): Xf {
  const a = (deg * Math.PI) / 180, c = Math.round(Math.cos(a) * 1e12) / 1e12, s = Math.round(Math.sin(a) * 1e12) / 1e12;
  if (axis === 'x') return { x: [1, 0, 0], y: [0, c, s], z: [0, -s, c], o: [0, 0, 0] };
  if (axis === 'y') return { x: [c, 0, -s], y: [0, 1, 0], z: [s, 0, c], o: [0, 0, 0] };
  return { x: [c, s, 0], y: [-s, c, 0], z: [0, 0, 1], o: [0, 0, 0] };
}
export const shift = (d: V3): Xf => ({ ...IDENT, o: d });
/** A placement moved after it (in the document's axes). */
export const andThen = (m: Xf, after: Xf): Xf => compose(after, m);

/** Parts' extent in the document (mm), from their models' own extents. */
export function extent(parts: { xf: Xf; min: V3; max: V3 }[]): { min: V3; max: V3 } | null {
  let lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    for (const x of [p.min[0], p.max[0]]) for (const y of [p.min[1], p.max[1]]) for (const z of [p.min[2], p.max[2]]) {
      const q = apply(p.xf, [x, y, z]);
      lo = [Math.min(lo[0], q[0]), Math.min(lo[1], q[1]), Math.min(lo[2], q[2])];
      hi = [Math.max(hi[0], q[0]), Math.max(hi[1], q[1]), Math.max(hi[2], q[2])];
    }
  }
  return Number.isFinite(lo[0]) ? { min: lo, max: hi } : null;
}

/* ── parts made here ── */

/** A box or cylinder as a part (its STEP made from its sizes). */
export function primitivePart(shape: Primitive, colour: RGBA, name: string, xf: Xf = IDENT, id = newId()): StepPart {
  return { id, name, text: primitiveStep(shape, name, colour, new Date(0)), xf, colour: null, hidden: false, prim: { shape, colour } };
}
export function importedPart(bytes: Uint8Array, name: string): StepPart {
  if (!/\.(step|stp)$/i.test(name) && isStl(bytes, name)) { const s = stlBytesToStep(bytes, name); return { id: newId(), name: stem(s.name), text: latin1(s.bytes), xf: IDENT, colour: null, hidden: false }; }
  return { id: newId(), name: stem(name), text: latin1(bytes), xf: IDENT, colour: null, hidden: false };
}

/* ── an assembly split into its parts ── */

const SOLID_REP: Record<string, string> = { FACETED_BREP: 'FACETED_BREP_SHAPE_REPRESENTATION', SHELL_BASED_SURFACE_MODEL: 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION' };

/**
 * A part whose model holds more than one solid (an assembly, or several bodies in one shape) as a
 * part for each solid, placed where the assembly puts it: each solid's own entities taken verbatim
 * (with its units and the colours of its faces, shells and solid) into a file of its own, named
 * after its product (else the solid). Null when there is only one solid.
 */
export function splitPart(part: StepPart): StepPart[] | null {
  let f: StepFile;
  try { f = parseStep(part.text); } catch { return null; }
  const found = new Tessellator(f).solids();
  if (found.length < 2) return null;
  const { stmts, max } = renumber(part.text, 0);
  const byId = new Map<number, string>();
  for (const st of stmts) { const m = /^#(\d+)\s*=/.exec(st); if (m) byId.set(Number(m[1]), st); }
  const refs = (id: number): number[] => { const st = byId.get(id); return st ? [...st.replace(/'(?:[^']|'')*'/g, "''").slice(st.indexOf('=') + 1).matchAll(/#(\d+)/g)].map((m) => Number(m[1])) : []; };
  const closure = (roots: number[]): Set<number> => {
    const seen = new Set<number>(), todo = [...roots];
    while (todo.length) { const id = todo.pop()!; if (seen.has(id) || !byId.has(id)) continue; seen.add(id); todo.push(...refs(id)); }
    return seen;
  };
  // Styled items by what they colour
  const styles = new Map<number, number[]>();
  for (const [id, e] of f) if (e.type === 'STYLED_ITEM' || e.type === 'OVER_RIDING_STYLED_ITEM') { const it = refOf(e.args[2]); styles.set(it, [...(styles.get(it) ?? []), id]); }
  // A representation's context; the products representations are of
  const ctxOf = (rep: number): number => { const e = f.get(rep); const a = e ? (e.type ? e.args : argsOf(e, 'REPRESENTATION') ?? argsOf(e, 'SHAPE_REPRESENTATION')) : undefined; return refOf(a?.[2]); };
  const anyCtx = [...f].find(([, e]) => e.type === 'GEOMETRIC_REPRESENTATION_CONTEXT' || !!e.parts?.has('GEOMETRIC_REPRESENTATION_CONTEXT'))?.[0] ?? -1;
  const productOf = new Map<number, string>();
  for (const e of f.values()) {
    if (e.type !== 'SHAPE_DEFINITION_REPRESENTATION') continue;
    const pd = f.get(refOf(f.get(refOf(e.args[0]))?.args[2]));
    const prod = f.get(refOf(f.get(refOf(pd?.args[2]))?.args[2]));
    const nm = prod ? str(prod.args[1]) || str(prod.args[0]) : '';
    if (nm) productOf.set(refOf(e.args[1]), nm);
  }
  const texts = new Map<number, { text: string; name: string; styled: boolean }>();
  const fileOf = (solid: number, rep: number, k: number) => {
    let t = texts.get(solid);
    if (t) return t;
    const se = f.get(solid)!;
    const name = productOf.get(rep) || str(se.args[0]) || `${part.name} ${k + 1}`;
    const ctx = rep >= 0 && ctxOf(rep) >= 0 ? ctxOf(rep) : anyCtx;
    const ids = closure([solid, ctx]);
    const styled = [...ids].flatMap((id) => styles.get(id) ?? []);
    for (const id of closure(styled)) ids.add(id);
    const w = new Writer();
    w.n = max;
    w.merge([...ids].sort((a, b) => a - b).map((id) => byId.get(id)!));
    const app = w.add(`APPLICATION_CONTEXT('automotive design')`);
    w.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${app})`);
    const prodCtx = w.add(`PRODUCT_CONTEXT('',#${app},'mechanical')`);
    const pdCtx = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`);
    const axis = w.add(`AXIS2_PLACEMENT_3D('',#${w.add(`CARTESIAN_POINT('',(0.,0.,0.))`)},#${w.add(`DIRECTION('',(0.,0.,1.))`)},#${w.add(`DIRECTION('',(1.,0.,0.))`)})`);
    const r = w.add(`${SOLID_REP[se.type] ?? 'ADVANCED_BREP_SHAPE_REPRESENTATION'}(${stepStr(name)},(#${axis},#${solid}),#${ctx})`);
    const prod = w.add(`PRODUCT(${stepStr(name)},${stepStr(name)},'',(#${prodCtx}))`);
    w.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${prod}))`);
    const pd = w.add(`PRODUCT_DEFINITION('design','',#${w.add(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`)},#${pdCtx})`);
    w.add(`SHAPE_DEFINITION_REPRESENTATION(#${w.add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`)},#${r})`);
    if (styled.length) w.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styled.map((x) => `#${x}`).join(',')}),#${ctx})`);
    t = { text: stepText(name, w.lines, new Date(0)), name, styled: styled.length > 0 };
    texts.set(solid, t);
    return t;
  };
  const named = new Map<string, number>();
  return found.map((s, k) => {
    const t = fileOf(s.solid, s.rep, k);
    const n = (named.get(t.name) ?? 0) + 1;
    named.set(t.name, n);
    return { id: newId(), name: n > 1 ? `${t.name} (${n})` : t.name, text: t.text, xf: compose(part.xf, s.xf), colour: part.colour ?? (!t.styled && s.colour ? s.colour : null), hidden: part.hidden };
  });
}
