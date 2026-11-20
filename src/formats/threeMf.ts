/**
 * 3MF (3D Manufacturing Format) files, as slicers take them: an OPC package (a zip) of one model
 * part — its objects as meshes (shared corners, triangles anticlockwise seen from outside), in
 * millimetres, each with a name and a colour, and all of them on the build plate as given. An
 * object printed in more than one colour is made of components: its own mesh and its parts' (text
 * in another filament), each mesh with its colour, so a slicer takes them as one object of parts.
 */
import { zip } from './zip';

export interface ThreeMfObject {
  name: string;
  /** Corners (x, y, z in mm, three numbers each) and triangles (three corner numbers each). */
  pos: ArrayLike<number>; idx: ArrayLike<number>;
  /** Red, green, blue (0 … 1). */
  colour?: [number, number, number];
  /** Parts of it in other colours (in place, the same coordinates). */
  parts?: { name: string; pos: ArrayLike<number>; idx: ArrayLike<number>; colour?: [number, number, number] }[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v: number) => { const t = v.toFixed(4); return t.includes('.') ? t.replace(/\.?0+$/, '') : t; };
const hex = (c: number) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0').toUpperCase();

export function write3mf(objects: ThreeMfObject[], app = 'Konium Designer', when = new Date()): Uint8Array {
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-GB" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n');
  parts.push(` <metadata name="Application">${esc(app)}</metadata>\n <metadata name="CreationDate">${when.toISOString().slice(0, 10)}</metadata>\n <resources>\n`);
  // Every mesh (the objects' and their parts') with its colour, in order
  const meshes = objects.flatMap((o) => [o, ...(o.parts ?? [])]);
  parts.push(`  <basematerials id="1">${meshes.map((o) => `<base name="${esc(o.name)}" displaycolor="#${(o.colour ?? [0.7, 0.7, 0.72]).map(hex).join('')}FF"/>`).join('')}</basematerials>\n`);
  let id = 2, m = 0;
  const meshObject = (o: { name: string; pos: ArrayLike<number>; idx: ArrayLike<number> }): number => {
    const v: string[] = [], t: string[] = [];
    for (let k = 0; k < o.pos.length; k += 3) v.push(`<vertex x="${num(o.pos[k]!)}" y="${num(o.pos[k + 1]!)}" z="${num(o.pos[k + 2]!)}"/>`);
    for (let k = 0; k < o.idx.length; k += 3) t.push(`<triangle v1="${o.idx[k]}" v2="${o.idx[k + 1]}" v3="${o.idx[k + 2]}"/>`);
    parts.push(`  <object id="${id}" type="model" name="${esc(o.name)}" pid="1" pindex="${m++}"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>\n`);
    return id++;
  };
  const items: number[] = [];
  for (const o of objects) {
    const own = meshObject(o);
    if (!o.parts?.length) { items.push(own); continue; }
    const ids = [own, ...o.parts.map(meshObject)];
    parts.push(`  <object id="${id}" type="model" name="${esc(o.name)}"><components>${ids.map((c) => `<component objectid="${c}"/>`).join('')}</components></object>\n`);
    items.push(id++);
  }
  parts.push(` </resources>\n <build>${items.map((i) => `<item objectid="${i}"/>`).join('')}</build>\n</model>\n`);
  const enc = new TextEncoder();
  return zip([
    { name: '[Content_Types].xml', bytes: enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n') },
    { name: '_rels/.rels', bytes: enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n') },
    { name: '3D/3dmodel.model', bytes: enc.encode(parts.join('')) },
  ], when);
}
