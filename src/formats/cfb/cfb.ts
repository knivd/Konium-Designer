/**
 * Microsoft Compound File Binary (MS-CFB) reader and writer.
 *
 * Every binary Altium document (.SchDoc, .PcbDoc, .SchLib, .PcbLib, .IntLib) is a CFB
 * container. The reader accepts v3 (512 B) and v4 (4096 B) sectors, DIFAT chains and the
 * mini stream. The writer emits v3 with a valid red-black directory tree, DIFAT when the
 * FAT outgrows the header, and preserves CLSIDs, state bits and timestamps.
 */
import { BinReader } from '../bin';

export type CfbKind = 'root' | 'storage' | 'stream';

export interface CfbEntry {
  name: string;
  kind: CfbKind;
  children: CfbEntry[];          // storages/root only, in CFB sort order as read
  data: Uint8Array;              // streams only
  clsid: Uint8Array;             // 16 bytes
  stateBits: number;
  ctime: Uint8Array;             // 8 bytes FILETIME, preserved verbatim
  mtime: Uint8Array;
}

export interface CfbFile {
  root: CfbEntry;
  majorVersion: number;
}

const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREESECT = 0xffffffff, ENDOFCHAIN = 0xfffffffe, FATSECT = 0xfffffffd, DIFSECT = 0xfffffffc;
const NOSTREAM = 0xffffffff;
const MINI_CUTOFF = 4096;

export class CfbError extends Error {}

export function isCfb(b: Uint8Array): boolean {
  return b.length >= 512 && SIG.every((v, i) => b[i] === v);
}

/* ═══ Reader ═══════════════════════════════════════════════════════════════════════════ */

export function readCfb(input: Uint8Array): CfbFile {
  // Plain Uint8Array view: Node Buffers' slice() returns views, which would break the copies below.
  const buf = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (!isCfb(buf)) throw new CfbError('not a compound file (bad signature)');
  const h = new BinReader(buf, 0, 512);
  h.skip(24);
  h.u16(); // minor
  const major = h.u16();
  if (h.u16() !== 0xfffe) throw new CfbError('bad byte order mark');
  const shift = h.u16();
  const miniShift = h.u16();
  if ((major === 3 && shift !== 9) || (major === 4 && shift !== 12)) throw new CfbError(`v${major} with sector shift ${shift}`);
  const ss = 1 << shift, mss = 1 << miniShift;
  h.skip(6);
  h.u32(); // dir sector count (v4)
  const nFat = h.u32();
  const firstDir = h.u32();
  h.u32(); // transaction
  const cutoff = h.u32() || MINI_CUTOFF;
  const firstMiniFat = h.u32();
  const nMiniFat = h.u32();
  let difatSect = h.u32();
  const nDifat = h.u32();

  const nSectors = Math.ceil(buf.length / ss) - 1;
  const sector = (n: number): Uint8Array => {
    if (n >= nSectors) throw new CfbError(`sector ${n} beyond end of file`);
    const off = (n + 1) * ss;
    if (off + ss <= buf.length) return buf.subarray(off, off + ss);
    const pad = new Uint8Array(ss); // tolerate truncated final sector
    pad.set(buf.subarray(off));
    return pad;
  };

  // DIFAT: 109 in header, then chained sectors
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) { const v = h.u32(); if (v !== FREESECT && v !== ENDOFCHAIN) fatSectors.push(v); }
  const perDifat = ss / 4 - 1;
  for (let i = 0; i < nDifat && difatSect !== ENDOFCHAIN && difatSect !== FREESECT; i++) {
    const r = new BinReader(sector(difatSect));
    for (let j = 0; j < perDifat; j++) { const v = r.u32(); if (v !== FREESECT && v !== ENDOFCHAIN) fatSectors.push(v); }
    difatSect = r.u32();
  }
  if (fatSectors.length < nFat) throw new CfbError(`FAT declares ${nFat} sectors, DIFAT lists ${fatSectors.length}`);

  const fat = new Uint32Array(fatSectors.length * (ss / 4));
  fatSectors.forEach((s, i) => {
    const sec = sector(s).slice();
    fat.set(new Uint32Array(sec.buffer, 0, ss / 4), i * (ss / 4));
  });

  const chain = (start: number, table: Uint32Array, limit: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    let s = start;
    while (s !== ENDOFCHAIN && s !== FREESECT) {
      if (s >= table.length || seen.has(s)) throw new CfbError(`broken chain at ${s}`);
      if (out.length > limit) throw new CfbError('chain longer than file');
      seen.add(s);
      out.push(s);
      s = table[s]!;
    }
    return out;
  };

  const readChain = (start: number, size?: number): Uint8Array => {
    const secs = chain(start, fat, nSectors + 1);
    const out = new Uint8Array(secs.length * ss);
    secs.forEach((s, i) => out.set(sector(s), i * ss));
    return size === undefined ? out : out.subarray(0, Math.min(size, out.length));
  };

  // Directory
  const dirBytes = readChain(firstDir);
  const nEntries = dirBytes.length / 128;
  interface Raw { name: string; type: number; left: number; right: number; child: number; clsid: Uint8Array; state: number; ctime: Uint8Array; mtime: Uint8Array; start: number; size: number }
  const raw: Raw[] = [];
  for (let i = 0; i < nEntries; i++) {
    const r = new BinReader(dirBytes, i * 128, i * 128 + 128);
    const nameBytes = r.bytes(64);
    const nameLen = r.u16();
    const type = r.u8();
    r.u8(); // colour
    const left = r.u32(), right = r.u32(), child = r.u32();
    const clsid = r.bytes(16).slice();
    const state = r.u32();
    const ctime = r.bytes(8).slice(), mtime = r.bytes(8).slice();
    const start = r.u32();
    const sizeLo = r.u32(), sizeHi = r.u32();
    const size = major === 3 ? sizeLo : sizeHi * 0x100000000 + sizeLo;
    let name = '';
    for (let k = 0; k + 1 < Math.min(nameLen, 64) - 1; k += 2) name += String.fromCharCode(nameBytes[k]! | (nameBytes[k + 1]! << 8));
    raw.push({ name, type, left, right, child, clsid, state, ctime, mtime, start, size });
  }
  const root = raw[0];
  if (!root || root.type !== 5) throw new CfbError('missing root entry');

  // Mini stream + mini FAT
  const miniStream = root.start === ENDOFCHAIN ? new Uint8Array(0) : readChain(root.start, root.size);
  let miniFat = new Uint32Array(0);
  if (nMiniFat > 0 && firstMiniFat !== ENDOFCHAIN) {
    const mf = readChain(firstMiniFat).slice();
    miniFat = new Uint32Array(mf.buffer, 0, mf.length >> 2);
  }
  const readMini = (start: number, size: number): Uint8Array => {
    const secs = chain(start, miniFat, miniStream.length / mss + 1);
    const out = new Uint8Array(secs.length * mss);
    secs.forEach((s, i) => out.set(miniStream.subarray(s * mss, s * mss + mss), i * mss));
    return out.subarray(0, size);
  };

  const build = (id: number, kind: CfbKind): CfbEntry => {
    const e = raw[id]!;
    const node: CfbEntry = {
      name: e.name, kind, children: [], data: new Uint8Array(0),
      clsid: e.clsid, stateBits: e.state, ctime: e.ctime, mtime: e.mtime,
    };
    if (kind === 'stream') {
      node.data = e.size === 0 ? new Uint8Array(0)
        : e.size < cutoff ? readMini(e.start, e.size).slice() : readChain(e.start, e.size).slice();
    } else {
      // In-order walk of the sibling tree under `child`
      const seen = new Set<number>();
      const walk = (sid: number): void => {
        if (sid === NOSTREAM || sid >= raw.length || seen.has(sid)) return;
        seen.add(sid);
        const s = raw[sid]!;
        walk(s.left);
        if (s.type === 1) node.children.push(build(sid, 'storage'));
        else if (s.type === 2) node.children.push(build(sid, 'stream'));
        walk(s.right);
      };
      walk(e.child);
    }
    return node;
  };

  return { root: build(0, 'root'), majorVersion: major };
}

/* ═══ Tree helpers ════════════════════════════════════════════════════════════════════ */

export function newEntry(name: string, kind: CfbKind, data?: Uint8Array): CfbEntry {
  return {
    name, kind, children: [], data: data ?? new Uint8Array(0),
    clsid: new Uint8Array(16), stateBits: 0, ctime: new Uint8Array(8), mtime: new Uint8Array(8),
  };
}

/**
 * A storage's children by upper-cased name, kept beside the entry and rebuilt when its
 * children list changed (libraries hold thousands of storages: lookups stay O(1)).
 */
const childIndex = new WeakMap<CfbEntry, { list: CfbEntry[]; n: number; map: Map<string, CfbEntry> }>();
function child(e: CfbEntry, name: string, scanOnMiss = false): CfbEntry | undefined {
  const kids = e.children, k = name.toUpperCase();
  if (kids.length < 16) return kids.find((c) => c.name.toUpperCase() === k);
  const build = () => {
    const map = new Map<string, CfbEntry>();
    for (const c of kids) { const u = c.name.toUpperCase(); if (!map.has(u)) map.set(u, c); }
    const ix = { list: kids, n: kids.length, map };
    childIndex.set(e, ix);
    return ix;
  };
  // Stale when the list was replaced, grew or shrank; a hit under another name means a rename
  let ix = childIndex.get(e);
  if (!ix || ix.list !== kids || ix.n !== kids.length) ix = build();
  let hit = ix.map.get(k);
  if (hit && hit.name.toUpperCase() !== k) hit = build().map.get(k);
  // A lookup that misses may be after a rename: look through once (puts skip this: theirs are new names)
  else if (!hit && scanOnMiss && kids.some((c) => c.name.toUpperCase() === k)) hit = build().map.get(k);
  return hit;
}
function addChild(e: CfbEntry, c: CfbEntry): void {
  e.children.push(c);
  const ix = childIndex.get(e);
  if (ix && ix.list === e.children && ix.n === e.children.length - 1) {
    ix.n++;
    const k = c.name.toUpperCase();
    if (!ix.map.has(k)) ix.map.set(k, c);
  }
}

/** Resolve "Storage/Stream" (case-insensitive, as CFB is). */
export function cfbFind(root: CfbEntry, path: string): CfbEntry | undefined {
  let cur: CfbEntry | undefined = root;
  for (const part of path.split('/').filter(Boolean)) {
    cur = cur && child(cur, part, true);
    if (!cur) return undefined;
  }
  return cur;
}

export function cfbStream(root: CfbEntry, path: string): Uint8Array | undefined {
  const e = cfbFind(root, path);
  return e?.kind === 'stream' ? e.data : undefined;
}

/** Create or replace a stream at "Storage/Stream", creating storages as needed. */
export function cfbPut(root: CfbEntry, path: string, data: Uint8Array): void {
  const parts = path.split('/').filter(Boolean);
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    let next = child(cur, p);
    if (!next) { next = newEntry(p, 'storage'); addChild(cur, next); }
    cur = next;
  }
  const leaf = parts.at(-1)!;
  const ex = child(cur, leaf);
  if (ex) ex.data = data; else addChild(cur, newEntry(leaf, 'stream', data));
}

export function walkCfb(e: CfbEntry, fn: (e: CfbEntry, path: string) => void, path = ''): void {
  for (const c of e.children) {
    const p = path ? `${path}/${c.name}` : c.name;
    fn(c, p);
    if (c.kind === 'storage') walkCfb(c, fn, p);
  }
}

/** MS-CFB directory ordering: shorter names first, then by upper-cased UTF-16 code unit. */
export function cfbCompare(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  const ua = a.toUpperCase(), ub = b.toUpperCase();
  for (let i = 0; i < ua.length; i++) {
    const d = ua.charCodeAt(i) - ub.charCodeAt(i);
    if (d) return d;
  }
  return 0;
}

/* ═══ Writer ══════════════════════════════════════════════════════════════════════════ */

export function writeCfb(file: CfbFile | CfbEntry): Uint8Array {
  const root = 'root' in file ? file.root : file;
  const SS = 512, MSS = 64;

  // Flatten: id 0 = root, then breadth-first so siblings sit together
  interface Node { e: CfbEntry; id: number; left: number; right: number; child: number; red: boolean; start: number; size: number }
  const nodes: Node[] = [];
  const add = (e: CfbEntry): Node => { const n: Node = { e, id: nodes.length, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, red: false, start: 0, size: 0 }; nodes.push(n); return n; };
  const queue: Node[] = [add(root)];
  while (queue.length) {
    const parent = queue.shift()!;
    if (parent.e.kind === 'stream') continue;
    const kids = [...parent.e.children].sort((a, b) => cfbCompare(a.name, b.name));
    for (let i = 1; i < kids.length; i++) {
      if (cfbCompare(kids[i - 1]!.name, kids[i]!.name) === 0) throw new CfbError(`duplicate entry name "${kids[i]!.name}"`);
    }
    for (const k of kids) {
      if (k.name.length > 31) throw new CfbError(`entry name too long: ${k.name}`);
    }
    const kn = kids.map(add);
    // Balanced BST; nodes on the deepest level red, rest black → valid red-black tree.
    const depth = new Map<Node, number>();
    const buildTree = (lo: number, hi: number, d: number): number => {
      if (lo > hi) return NOSTREAM;
      const mid = (lo + hi) >> 1;
      const n = kn[mid]!;
      depth.set(n, d);
      n.left = buildTree(lo, mid - 1, d + 1);
      n.right = buildTree(mid + 1, hi, d + 1);
      return n.id;
    };
    parent.child = buildTree(0, kn.length - 1, 0);
    const maxD = Math.max(-1, ...depth.values());
    const leafDepths = kn.filter((n) => n.left === NOSTREAM || n.right === NOSTREAM).map((n) => depth.get(n)!);
    const minLeaf = leafDepths.length ? Math.min(...leafDepths) : 0;
    for (const n of kn) n.red = maxD > 0 && depth.get(n) === maxD && maxD > minLeaf;
    queue.push(...kn);
  }

  // Data placement: small streams → mini stream, large → regular sectors
  const mini: Node[] = [], big: Node[] = [];
  for (const n of nodes) {
    if (n.e.kind !== 'stream') continue;
    n.size = n.e.data.length;
    if (n.size === 0) n.start = ENDOFCHAIN;
    else (n.size < MINI_CUTOFF ? mini : big).push(n);
  }
  let miniSectors = 0;
  for (const n of mini) { n.start = miniSectors; miniSectors += Math.ceil(n.size / MSS); }
  const miniStreamBytes = miniSectors * MSS;

  const nDir = Math.ceil(nodes.length / 4);
  const nMiniFat = Math.ceil((miniSectors * 4) / SS);
  const nMiniStream = Math.ceil(miniStreamBytes / SS);
  const nBig = big.reduce((a, n) => a + Math.ceil(n.size / SS), 0);
  const dataSectors = nDir + nMiniFat + nMiniStream + nBig;

  let nFat = 1, nDifat = 0;
  for (;;) {
    nDifat = nFat > 109 ? Math.ceil((nFat - 109) / 127) : 0;
    if (nFat * 128 >= dataSectors + nFat + nDifat) break;
    nFat++;
  }

  const total = nFat + nDifat + dataSectors;
  const fat = new Uint32Array(nFat * 128).fill(FREESECT);
  let next = 0;
  const fatIds: number[] = [];
  for (let i = 0; i < nFat; i++) { fatIds.push(next); fat[next++] = FATSECT; }
  const difatIds: number[] = [];
  for (let i = 0; i < nDifat; i++) { difatIds.push(next); fat[next++] = DIFSECT; }
  const alloc = (count: number): number => {
    if (count === 0) return ENDOFCHAIN;
    const start = next;
    for (let i = 0; i < count; i++) fat[next + i] = i === count - 1 ? ENDOFCHAIN : next + i + 1;
    next += count;
    return start;
  };
  const dirStart = alloc(nDir);
  const miniFatStart = alloc(nMiniFat);
  const miniStreamStart = alloc(nMiniStream);
  for (const n of big) n.start = alloc(Math.ceil(n.size / SS));
  if (next !== total) throw new CfbError('sector accounting mismatch');

  const out = new Uint8Array((total + 1) * SS);
  const dv = new DataView(out.buffer);
  const secOff = (s: number) => (s + 1) * SS;

  // Header
  out.set(SIG, 0);
  dv.setUint16(24, 0x003e, true);
  dv.setUint16(26, 3, true);
  dv.setUint16(28, 0xfffe, true);
  dv.setUint16(30, 9, true);
  dv.setUint16(32, 6, true);
  dv.setUint32(40, 0, true);
  dv.setUint32(44, nFat, true);
  dv.setUint32(48, dirStart, true);
  dv.setUint32(52, 0, true);
  dv.setUint32(56, MINI_CUTOFF, true);
  dv.setUint32(60, nMiniFat ? miniFatStart : ENDOFCHAIN, true);
  dv.setUint32(64, nMiniFat, true);
  dv.setUint32(68, nDifat ? difatIds[0]! : ENDOFCHAIN, true);
  dv.setUint32(72, nDifat, true);
  for (let i = 0; i < 109; i++) dv.setUint32(76 + i * 4, i < nFat ? fatIds[i]! : FREESECT, true);

  // DIFAT sectors
  for (let d = 0; d < nDifat; d++) {
    const base = secOff(difatIds[d]!);
    for (let j = 0; j < 127; j++) {
      const k = 109 + d * 127 + j;
      dv.setUint32(base + j * 4, k < nFat ? fatIds[k]! : FREESECT, true);
    }
    dv.setUint32(base + 508, d + 1 < nDifat ? difatIds[d + 1]! : ENDOFCHAIN, true);
  }

  // FAT
  for (let i = 0; i < nFat; i++) {
    const base = secOff(fatIds[i]!);
    for (let j = 0; j < 128; j++) dv.setUint32(base + j * 4, fat[i * 128 + j]!, true);
  }

  // Root carries the mini stream
  nodes[0]!.start = nMiniStream ? miniStreamStart : ENDOFCHAIN;
  nodes[0]!.size = miniStreamBytes;

  // Directory
  const writeChainBytes = (start: number, bytes: Uint8Array): void => {
    let s = start, o = 0;
    while (o < bytes.length) {
      out.set(bytes.subarray(o, o + SS), secOff(s));
      o += SS;
      s = fat[s]!;
    }
  };
  const dir = new Uint8Array(nDir * SS);
  const ddv = new DataView(dir.buffer);
  for (let i = 0; i < nDir * 4; i++) {
    const o = i * 128;
    const n = nodes[i];
    if (!n) { ddv.setUint32(o + 68, NOSTREAM, true); ddv.setUint32(o + 72, NOSTREAM, true); ddv.setUint32(o + 76, NOSTREAM, true); continue; }
    const name = i === 0 ? 'Root Entry' : n.e.name;
    for (let k = 0; k < name.length; k++) ddv.setUint16(o + k * 2, name.charCodeAt(k), true);
    ddv.setUint16(o + 64, (name.length + 1) * 2, true);
    dir[o + 66] = n.e.kind === 'root' ? 5 : n.e.kind === 'storage' ? 1 : 2;
    dir[o + 67] = n.red ? 0 : 1;
    ddv.setUint32(o + 68, n.left, true);
    ddv.setUint32(o + 72, n.right, true);
    ddv.setUint32(o + 76, n.e.kind === 'stream' ? NOSTREAM : n.child, true);
    dir.set(n.e.clsid.subarray(0, 16), o + 80);
    ddv.setUint32(o + 96, n.e.stateBits >>> 0, true);
    if (n.e.kind !== 'root') { dir.set(n.e.ctime.subarray(0, 8), o + 100); dir.set(n.e.mtime.subarray(0, 8), o + 108); }
    ddv.setUint32(o + 116, n.e.kind === 'storage' ? 0 : n.start, true);
    ddv.setUint32(o + 120, n.e.kind === 'storage' ? 0 : n.size, true);
  }
  writeChainBytes(dirStart, dir);

  // Mini FAT + mini stream
  if (nMiniFat) {
    const mf = new Uint8Array(nMiniFat * SS);
    const mdv = new DataView(mf.buffer);
    for (let i = 0; i < nMiniFat * 128; i++) mdv.setUint32(i * 4, FREESECT, true);
    const ms = new Uint8Array(nMiniStream * SS);
    for (const n of mini) {
      const cnt = Math.ceil(n.size / MSS);
      for (let i = 0; i < cnt; i++) mdv.setUint32((n.start + i) * 4, i === cnt - 1 ? ENDOFCHAIN : n.start + i + 1, true);
      ms.set(n.e.data, n.start * MSS);
    }
    writeChainBytes(miniFatStart, mf);
    writeChainBytes(miniStreamStart, ms);
  }

  for (const n of big) writeChainBytes(n.start, n.e.data);
  return out;
}

/** Deep clone so edits never alias the originally loaded tree. */
export function cloneCfb(e: CfbEntry): CfbEntry {
  return { ...e, data: e.data, children: e.children.map(cloneCfb) };
}
