/**
 * Place › 3D Body › Generic: a STEP model as a component body, embedded in the board (Models:
 * Data lists it, Models/<n> holds it zlib-compressed) or linked to its file (ModelsNoEmbed lists
 * it by name; the file is looked for in the project's folder and the model folders). The body's
 * 2D outline is the model's outline seen from above, its heights the model's, turned and raised
 * as set. In a library the storages are Library/Models and Library/ModelsNoEmbed.
 */
import { cfbFind, cfbPut, cfbStream, type CfbEntry } from '../formats/cfb/cfb';
import { encodeBody } from '../formats/altium/pcbdoc';
import { PropertyBag } from '../formats/altium/props';
import { formatAltiumLength } from '../core/units';
import { UNITS_PER_MM } from '../core/units';
import type { PcbRawRecord } from '../formats/altium/framing';
import type { StepModel, V3 } from '../formats/step/tessellate';
import type { Change } from '../core/undo';
import type { Vec2 } from '../core/geom';
import { convexHull, type BodySpec } from './bodies';

export interface GenericModel {
  /** The file's name (a linked model keeps it to be found again). */
  name: string;
  /** The STEP file as read. */
  bytes: Uint8Array;
  link: boolean;
}

/** Turned about X, then Y, then Z (degrees), as AD places a model. */
export function turn(v: V3, rot: [number, number, number]): V3 {
  const [ax, ay, az] = rot.map((d) => (d * Math.PI) / 180) as [number, number, number];
  let [x, y, z] = v;
  [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
  [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
  [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
  return [x, y, z];
}

/** The model seen from above once turned: its outline (mm, around its origin) and lowest and highest points. */
export function modelFootprint(m: StepModel, rot: [number, number, number]): { outline: Vec2[]; minZ: number; maxZ: number } {
  const pts: Vec2[] = [];
  let minZ = Infinity, maxZ = -Infinity, n = 0;
  for (const s of m.meshes) n += s.pos.length / 3;
  // A few thousand points are plenty for the outline
  const step = Math.max(1, Math.floor(n / 20000));
  let k = 0;
  for (const s of m.meshes) {
    for (let i = 0; i < s.pos.length; i += 3, k++) {
      const v = turn([s.pos[i]!, s.pos[i + 1]!, s.pos[i + 2]!], rot);
      minZ = Math.min(minZ, v[2]); maxZ = Math.max(maxZ, v[2]);
      if (k % step === 0) pts.push({ x: Math.round(v[0] * 1000) / 1000, y: Math.round(v[1] * 1000) / 1000 });
    }
  }
  if (!pts.length) return { outline: [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }], minZ: 0, maxZ: 1 };
  return { outline: convexHull(pts), minZ, maxZ };
}

const guid = (): string => {
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).toUpperCase().padStart(4, '0');
  return `{${h()}${h()}-${h()}-${h()}-${h()}-${h()}${h()}${h()}}`;
};

/** A stand-in for AD's model checksum [est: its algorithm isn't known; AD reads the model again when it differs]. */
export function modelChecksum(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c | 0;
}

/** The body's record: the model placed with its origin at `at`, its outline and heights from the model (board units). */
export function genericBodyRecord(spec: BodySpec, model: GenericModel, at: Vec2, fp: { outline: Vec2[]; minZ: number; maxZ: number }, id: string, component = 0xffff): PcbRawRecord {
  const rot = spec.rot ?? [0, 0, 0];
  const dz = spec.standoff;
  // Underneath, the model is turned over about the board's X axis (y and z reversed)
  const outline = fp.outline.map((v) => ({ x: Math.round(at.x + v.x * UNITS_PER_MM), y: Math.round(at.y + (spec.bottom ? -v.y : v.y) * UNITS_PER_MM) }));
  const len = (v: number) => formatAltiumLength(Math.round(v));
  return encodeBody({
    component, outline, at, layer: spec.layer, bottom: spec.bottom, colour: 0x808080, opacity: spec.opacity, identifier: spec.identifier, id,
    standoff: Math.max(0, Math.round(dz + fp.minZ * UNITS_PER_MM)), overall: Math.round(dz + fp.maxZ * UNITS_PER_MM), modelType: 1,
    extra: {
      'MODEL.CHECKSUM': modelChecksum(model.bytes), 'MODEL.EMBED': model.link ? 'FALSE' : 'TRUE', 'MODEL.NAME': model.name,
      'MODEL.3D.ROTX': rot[0].toFixed(3), 'MODEL.3D.ROTY': rot[1].toFixed(3), 'MODEL.3D.ROTZ': rot[2].toFixed(3), 'MODEL.3D.DZ': len(dz),
      'MODEL.SNAPCOUNT': 0,
    },
  });
}

/** zlib-compressed, as Models/<n> holds a model. */
export async function compressModel(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function records(data: Uint8Array | undefined): Uint8Array[] {
  const out: Uint8Array[] = [];
  let o = 0;
  while (data && o + 4 <= data.length) {
    const len = data[o]! | (data[o + 1]! << 8) | (data[o + 2]! << 16) | (data[o + 3]! << 24);
    if (len <= 0 || o + 4 + len > data.length) break;
    out.push(data.subarray(o, o + 4 + len));
    o += 4 + len;
  }
  return out;
}
/** A listing as AD writes it: length, then KEY=VALUE|… (no leading bar), NUL-ended. */
const record = (bag: PropertyBag): Uint8Array => {
  const all = bag.toBytes(), text = all[0] === 0x7c ? all.subarray(1) : all;
  const out = new Uint8Array(4 + text.length);
  new DataView(out.buffer).setUint32(0, text.length, true);
  out.set(text, 4);
  return out;
};
const join = (parts: Uint8Array[]): Uint8Array => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const header = (n: number) => { const h = new Uint8Array(4); new DataView(h.buffer).setUint32(0, n, true); return h; };

/**
 * The model in the file, as an undoable change: embedded, its listing in <prefix>Models/Data and
 * its compressed file as the next <prefix>Models/<n>; linked, its listing in
 * <prefix>ModelsNoEmbed/Data. A model the file already lists (same name and checksum) is used
 * again: no change. `compressed` is the embedded file (compressModel).
 */
export function modelEntry(root: CfbEntry, prefix: string, model: GenericModel, rot: [number, number, number], dz: number, compressed?: Uint8Array): { id: string; change: Change | null } {
  const storage = `${prefix}${model.link ? 'ModelsNoEmbed' : 'Models'}`;
  const before = { data: cfbStream(root, `${storage}/Data`), head: cfbStream(root, `${storage}/Header`) };
  const list = records(before.data);
  const sum = String(modelChecksum(model.bytes));
  for (const r of list) {
    const b = PropertyBag.parse(r.subarray(4));
    if ((b.get('NAME') ?? '').toLowerCase() === model.name.toLowerCase() && b.get('CHECKSUM') === sum && b.get('ID')) return { id: b.get('ID')!, change: null };
  }
  const id = guid();
  const bag = PropertyBag.from({
    EMBED: model.link ? 'FALSE' : 'TRUE', MODELSOURCE: model.link ? 'FromFile' : 'Undefined', ID: id,
    ROTX: rot[0].toFixed(3), ROTY: rot[1].toFixed(3), ROTZ: rot[2].toFixed(3), DZ: String(Math.round(dz)), CHECKSUM: sum, NAME: model.name,
  });
  const n = list.length;
  return {
    id,
    change: {
      apply() {
        cfbPut(root, `${storage}/Data`, join([...list, record(bag)]));
        cfbPut(root, `${storage}/Header`, header(n + 1));
        if (!model.link && compressed) cfbPut(root, `${storage}/${n}`, compressed);
      },
      revert() {
        cfbPut(root, `${storage}/Data`, before.data ?? new Uint8Array(0));
        cfbPut(root, `${storage}/Header`, before.head ?? header(0));
        if (!model.link) {
          const st = cfbFind(root, storage);
          if (st) st.children = st.children.filter((c) => c.name !== String(n));
        }
      },
    },
  };
}

