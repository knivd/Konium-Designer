/**
 * Integrated libraries (.IntLib): a compound file whose SchLib and PCBLib storages hold the
 * source libraries, each stream a zlib-compressed .SchLib / .PcbLib file. Reading unpacks them
 * (so their parts and footprints can be placed); Make Integrated Library writes the same shape
 * with a Version.Txt [est: stream names "0", "1" … and Version.Txt as public descriptions give
 * them; Altium may also expect LibCrossRef.Txt and Parameters.bin].
 */
import { cfbPut, newEntry, readCfb, writeCfb, type CfbEntry } from '../cfb/cfb';
import { binToBytes } from '../text';

export interface PackedLib { kind: 'SchLib' | 'PcbLib'; name: string; data: Uint8Array }

async function pipe(data: Uint8Array, t: 'deflate' | 'inflate'): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(t === 'deflate' ? new CompressionStream('deflate') : new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** The libraries inside, still compressed. */
export function intLibMembers(bytes: Uint8Array): PackedLib[] {
  const cfb = readCfb(bytes);
  const out: PackedLib[] = [];
  for (const st of cfb.root.children) {
    const kind = /^SchLib$/i.test(st.name) ? 'SchLib' : /^PCBLib$/i.test(st.name) ? 'PcbLib' : null;
    if (!kind || st.kind !== 'storage') continue;
    for (const s of st.children) if (s.kind === 'stream' && s.data) out.push({ kind, name: s.name, data: s.data });
  }
  return out;
}

/** Unpack: one file per library, named after the stream (or the IntLib and an index). */
export async function unpackIntLib(bytes: Uint8Array, name: string): Promise<{ name: string; bytes: Uint8Array }[]> {
  const base = name.replace(/\.intlib$/i, '');
  const members = intLibMembers(bytes);
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const [i, m] of members.entries()) {
    const ext = m.kind === 'SchLib' ? '.SchLib' : '.PcbLib';
    const own = new RegExp(`\\${ext}$`, 'i').test(m.name) ? m.name : `${base}${members.filter((x) => x.kind === m.kind).length > 1 ? `_${i}` : ''}${ext}`;
    try { out.push({ name: own, bytes: await pipe(m.data, 'inflate') }); } catch { /* not zlib: skip */ }
  }
  return out;
}

export async function packIntLib(libs: { kind: 'SchLib' | 'PcbLib'; bytes: Uint8Array }[]): Promise<Uint8Array> {
  const root: CfbEntry = newEntry('Root Entry', 'root');
  const n = { SchLib: 0, PcbLib: 0 };
  for (const l of libs) {
    const storage = l.kind === 'SchLib' ? 'SchLib' : 'PCBLib';
    cfbPut(root, `${storage}/${n[l.kind]++}`, await pipe(l.bytes, 'deflate'));
  }
  cfbPut(root, 'Version.Txt', binToBytes('Version=1.1\r\n'));
  return writeCfb(root);
}
