/**
 * 3D bodies whose model is a STEP file embedded in the PcbDoc (Models storage: Models/Data lists
 * them, Models/<n> holds each zlib-compressed) or linked to one (ModelsNoEmbed lists them; the
 * file is looked for by name, platform/modelFolders.ts). A body places its model at MODEL.2D.X/Y, turned by
 * MODEL.3D.ROTX, ROTY, ROTZ (about X, then Y, then Z, in degrees) and raised by MODEL.3D.DZ above
 * the board's surface on the body's side. Tessellated once per model and cached.
 */
import { cfbFind, cfbStream, type CfbEntry } from '../../formats/cfb/cfb';
import { PropertyBag } from '../../formats/altium/props';
import { REGION } from '../../formats/altium/pcbLayouts';
import { bodyComponent } from '../../model/pcbEdit';
import { UNITS_PER_MM, parseLength } from '../../core/units';
import { parseStep } from '../../formats/step/parse';
import { tessellateStep, type StepModel, type V3, type Xf, apply, applyDir, compose } from '../../formats/step/tessellate';
import type { Vec2 } from '../../core/geom';
import type { PcbDocument } from '../../model/pcb';
import type { PcbRawRecord } from '../../formats/altium/framing';
import type { Mesh } from './boardModel';
import { snapPoints } from '../../model/body3d';
import StepWorker from './stepWorker?worker&inline';

export interface StepBody {
  component: number; modelId: string; name: string;
  /** Board coordinates of the model's origin. */
  at: Vec2;
  rot: V3; dz: number; bottom: boolean;
  /** Millimetres away from the board on the body's side. */
  standoff: number; overall: number;
  outline: Vec2[];
  opacity: number;
  /** Snap points (the model's own axes, mm). */
  snaps?: V3[];
}

const props = (s: Uint8Array) => {
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  const len = dv.getUint32(REGION.propsAt, true) & 0x00ffffff;
  return PropertyBag.parse(s.subarray(REGION.propsAt + 4, REGION.propsAt + 4 + len));
};

/** A body's STEP placement from its properties (null: not a placed STEP model). */
export function stepBodyFrom(p: PropertyBag, rec: PcbRawRecord, outline: Vec2[]): StepBody | null {
  if (p.int('MODEL.MODELTYPE') !== 1) return null;
  const x = parseLength(p.getRaw('MODEL.2D.X')), y = parseLength(p.getRaw('MODEL.2D.Y'));
  if (x === undefined || y === undefined) return null;
  return {
    component: bodyComponent(rec) ?? 0xffff, modelId: (p.get('MODELID') ?? '').toUpperCase(), name: p.get('MODEL.NAME') ?? '',
    at: { x, y }, rot: [p.float('MODEL.3D.ROTX'), p.float('MODEL.3D.ROTY'), p.float('MODEL.3D.ROTZ')],
    dz: (parseLength(p.getRaw('MODEL.3D.DZ')) ?? 0) / UNITS_PER_MM, bottom: p.int('BODYPROJECTION') === 1,
    standoff: (parseLength(p.getRaw('STANDOFFHEIGHT')) ?? 0) / UNITS_PER_MM, overall: (parseLength(p.getRaw('OVERALLHEIGHT')) ?? 0) / UNITS_PER_MM,
    outline, opacity: Math.min(1, Math.max(0.1, p.float('BODYOPACITY3D') || 1)), snaps: snapPoints(p),
  };
}

/** The bodies that show a STEP model. */
export function stepBodies(doc: PcbDocument): StepBody[] {
  const out: StepBody[] = [];
  for (const rec of doc.streams.get('ComponentBodies6')?.records ?? []) {
    const s = rec.subs[0];
    if (!s || s.length < REGION.propsAt + 8) continue;
    try {
      const p = props(s);
      const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
      let o = REGION.propsAt + 4 + (dv.getUint32(REGION.propsAt, true) & 0x00ffffff);
      const n = dv.getUint32(o, true); o += 4;
      const outline: Vec2[] = [];
      for (let i = 0; i < n && o + 16 <= s.length; i++, o += 16) outline.push({ x: dv.getFloat64(o, true), y: dv.getFloat64(o + 8, true) });
      const b = stepBodyFrom(p, rec, outline);
      if (b) out.push(b);
    } catch { /* unreadable: left to the extruded fallback */ }
  }
  return out;
}

export type ModelFiles = Map<string, { name: string; data: Uint8Array; checksum: string }>;
/**
 * The embedded models: <storage>/Data holds a length-prefixed |KEY=VALUE| record per model,
 * <storage>/<i> its compressed STEP text (a PcbDoc's Models, a PcbLib's Library/Models).
 */
export function embeddedModels(root: CfbEntry, storage = 'Models'): ModelFiles {
  const out: ModelFiles = new Map();
  const data = cfbStream(root, `${storage}/Data`);
  if (!data || !cfbFind(root, storage)) return out;
  let o = 0, i = 0;
  while (o + 4 <= data.length) {
    const len = data[o]! | (data[o + 1]! << 8) | (data[o + 2]! << 16) | (data[o + 3]! << 24);
    if (len <= 0 || o + 4 + len > data.length) break;
    const bag = PropertyBag.parse(data.subarray(o + 4, o + 4 + len));
    o += 4 + len;
    const id = (bag.get('ID') ?? '').toUpperCase();
    const bytes = cfbStream(root, `${storage}/${i}`);
    i++;
    if (!id || !bytes || out.has(id)) continue;
    out.set(id, { name: bag.get('NAME') ?? '', data: bytes, checksum: bag.get('CHECKSUM') ?? '' });
  }
  return out;
}

/**
 * Linked models (not carried in the file): <storage>/Data's records in ModelsNoEmbed, their ID
 * and NAME (the model file's path where it was linked [est: as the embedded list, without the
 * files]). By model id.
 */
export function linkedModels(root: CfbEntry, storage = 'ModelsNoEmbed'): Map<string, string> {
  const out = new Map<string, string>();
  const data = cfbStream(root, `${storage}/Data`);
  if (!data) return out;
  let o = 0;
  while (o + 4 <= data.length) {
    const len = data[o]! | (data[o + 1]! << 8) | (data[o + 2]! << 16) | (data[o + 3]! << 24);
    if (len <= 0 || o + 4 + len > data.length) break;
    const bag = PropertyBag.parse(data.subarray(o + 4, o + 4 + len));
    o += 4 + len;
    const id = (bag.get('ID') ?? '').toUpperCase(), name = bag.get('NAME') ?? '';
    if (id && name && !out.has(id)) out.set(id, name);
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('latin1') : null;

/** In this thread (no workers: tests, or a page the browser won't give one). */
async function readHere(data: Uint8Array): Promise<StepModel | null> {
  try {
    // zlib normally; a plain STEP text as it is
    const raw = data[0] === 0x78 ? await inflate(data) : data;
    const text = decoder ? decoder.decode(raw) : String.fromCharCode(...raw);
    const m = tessellateStep(parseStep(text));
    return m.meshes.length ? m : null;
  } catch { return null; }
}

/** One worker reads the models in turn; if it can't start or fails, they're read here. */
let worker: Worker | null | undefined;
const waiting = new Map<number, { data: Uint8Array; done: (m: StepModel | null) => void }>();
let nextId = 1;
function stepWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    if (typeof Worker === 'undefined') throw new Error('no workers');
    const w = new StepWorker();
    w.onmessage = (e: MessageEvent<{ id: number; model: StepModel | null }>) => {
      const job = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      job?.done(e.data.model);
    };
    w.onerror = () => {
      worker = null;
      w.terminate();
      for (const [id, job] of waiting) { waiting.delete(id); void readHere(job.data).then(job.done); }
    };
    worker = w;
  } catch { worker = null; }
  return worker;
}

const cache = new Map<string, Promise<StepModel | null>>();
/** Preferences › PCB Editor › Models › Temporary Mesh Data: how many models' triangles are kept, and letting them go. */
export const meshCacheSize = (): number => cache.size;
export function clearMeshCache(): void { cache.clear(); }
/** A model's triangles (millimetres, its own axes), shared by every body that shows it. */
export function loadModel(key: string, data: Uint8Array): Promise<StepModel | null> {
  let p = cache.get(key);
  if (!p) {
    const w = stepWorker();
    p = w
      ? new Promise<StepModel | null>((done) => {
        const id = nextId++;
        waiting.set(id, { data, done });
        // Its own copy (the file's bytes stay here), handed over rather than copied again
        const own = data.slice();
        w.postMessage({ id, data: own }, [own.buffer]);
      })
      : readHere(data);
    cache.set(key, p);
    // Kept for the boards opened in this session, the oldest let go past a few hundred
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
  }
  return p;
}

const rad = (d: number) => (d * Math.PI) / 180;
const rotX = (a: number): Xf => ({ x: [1, 0, 0], y: [0, Math.cos(a), Math.sin(a)], z: [0, -Math.sin(a), Math.cos(a)], o: [0, 0, 0] });
const rotY = (a: number): Xf => ({ x: [Math.cos(a), 0, -Math.sin(a)], y: [0, 1, 0], z: [Math.sin(a), 0, Math.cos(a)], o: [0, 0, 0] });
const rotZ = (a: number): Xf => ({ x: [Math.cos(a), Math.sin(a), 0], y: [-Math.sin(a), Math.cos(a), 0], z: [0, 0, 1], o: [0, 0, 0] });

/**
 * The map from the model's millimetres to the 3D view's (millimetres from the board's centre,
 * z up from the board's underside): turned about X, Y, then Z, raised by DZ; on the top the
 * heights go up from the top surface, underneath the whole is turned over about the board's
 * X axis so they go down from the bottom surface (as the bodies' outlines and heights in AD
 * files show: x kept, y and z reversed).
 */
export function bodyTransform(b: StepBody, _m: StepModel, centre: Vec2, thickness: number): Xf {
  const r = compose(rotZ(rad(b.rot[2])), compose(rotY(rad(b.rot[1])), rotX(rad(b.rot[0]))));
  const x = (b.at.x - centre.x) / UNITS_PER_MM, y = (b.at.y - centre.y) / UNITS_PER_MM;
  if (!b.bottom) return { ...r, o: [x, y, thickness + b.dz] };
  const over = (v: V3): V3 => [v[0], -v[1], -v[2]];
  return { x: over(r.x), y: over(r.y), z: over(r.z), o: [x, y, -b.dz] };
}
/** The model's meshes placed for this body. */
export function placedMeshes(b: StepBody, m: StepModel, xf: Xf): Mesh[] {
  return m.meshes.map((s) => {
    const pos = new Float32Array(s.pos.length), nrm = new Float32Array(s.nrm.length);
    for (let i = 0; i < s.pos.length; i += 3) {
      const p = apply(xf, [s.pos[i]!, s.pos[i + 1]!, s.pos[i + 2]!]);
      pos[i] = p[0]; pos[i + 1] = p[1]; pos[i + 2] = p[2];
      const n = applyDir(xf, [s.nrm[i]!, s.nrm[i + 1]!, s.nrm[i + 2]!]);
      nrm[i] = n[0]; nrm[i + 1] = n[1]; nrm[i + 2] = n[2];
    }
    return { pos, nrm, uv: null, idx: s.idx, colour: [s.colour[0], s.colour[1], s.colour[2], Math.min(s.colour[3], b.opacity)] };
  });
}
