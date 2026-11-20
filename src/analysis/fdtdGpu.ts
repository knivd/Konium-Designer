/**
 * The FDTD's steps on the graphics card (WebGPU), where the browser has one: the same equations,
 * coefficients and absorber as fdtd.ts, a cell to an invocation. H from E, E from H, then the
 * port's source and its voltage, each a pass; a batch of steps goes to the card at once, and at
 * its end the fields at the nodes the far field and the currents are summed from are read back
 * into the simulation's own arrays, where the sums are made as they are without the card.
 *
 * Single precision throughout (the processor's steps store single and work in double): the port's
 * voltage agrees to a few parts in a hundred thousand [checked in the smoke test against the
 * processor's run].
 */
import { MU0, type Fdtd } from './fdtd';

/* The parts of WebGPU this uses are taken as the browser gives them: no types for them are installed. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Gpu = any;

export interface GpuRun {
  /** What the card says it is. */
  adapter: string;
  /** Runs one step for each source value (the port's source at the half steps), gives the port's voltage after each, and
   *  copies the watched nodes' fields into the simulation's arrays. At most `GpuRun.batch` steps at a time. */
  advance(vs: Float32Array): Promise<Float32Array>;
  batch: number;
  destroy(): void;
}

const SLOTS = 64;

const COMMON = /* wgsl */ `
struct Params {
  nx: u32, ny: u32, nz: u32, pml: u32, sx: u32, sy: u32, sxy: u32, n: u32,
  c: f32, edges: u32, watched: u32, pad0: u32,
  // Where each row of numbers starts in g: 1/dx, 1/dy, 1/dz, then those between cell centres; the absorber's b and c for E and for H along x, y, z
  oIdx: u32, oIdy: u32, oIdz: u32, oIdxd: u32, oIdyd: u32, oIdzd: u32,
  oBe: vec3<u32>, oCe: vec3<u32>, oBh: vec3<u32>, oCh: vec3<u32>,
  // Where each of the absorber's six memories starts (two for each axis): x's two and y's first, then y's second and z's two
  oPsiA: vec3<u32>, oPsiB: vec3<u32>,
}
// The slab a plane is in along an axis of n cells: its place in the slab's memory, or 0xffffffff outside the absorber
fn slabH(i: u32, n: u32, p: u32) -> u32 { if (i < p) { return i; } if (i + p >= n && i < n) { return i + 2u * p - n; } return 0xffffffffu; }
fn slabE(i: u32, n: u32, p: u32) -> u32 { if (i >= 1u && i <= p) { return i - 1u; } if (i + p >= n && i < n) { return i + 2u * p - n; } return 0xffffffffu; }
`;

const STEP_H = COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> e: array<f32>;
@group(0) @binding(2) var<storage, read_write> h: array<f32>;
@group(0) @binding(3) var<storage, read> g: array<f32>;
@group(0) @binding(4) var<storage, read_write> psi: array<f32>;
@compute @workgroup_size(4, 4, 4) fn main(@builtin(global_invocation_id) q: vec3<u32>) {
  let i = q.x; let j = q.y; let k = q.z;
  if (i >= P.nx || j >= P.ny || k >= P.nz) { return; }
  let id = i + P.sx * (j + P.sy * k); let N = P.n;
  let ex = e[id]; let ey = e[N + id]; let ez = e[2u * N + id];
  let dx = g[P.oIdx + i]; let dy = g[P.oIdy + j]; let dz = g[P.oIdz + k];
  let ezy = (e[2u * N + id + P.sx] - ez) * dy; let eyz = (e[N + id + P.sxy] - ey) * dz;
  let exz = (e[id + P.sxy] - ex) * dz; let ezx = (e[2u * N + id + 1u] - ez) * dx;
  let eyx = (e[N + id + 1u] - ey) * dx; let exy = (e[id + P.sx] - ex) * dy;
  var hx = h[id] - P.c * (ezy - eyz);
  var hy = h[N + id] - P.c * (exz - ezx);
  var hz = h[2u * N + id] - P.c * (eyx - exy);
  if (P.pml > 0u) {
    let p2 = 2u * P.pml;
    let mx = slabH(i, P.nx, P.pml);
    if (mx != 0xffffffffu) {
      let m = mx + p2 * (j + P.sy * k); let b = g[P.oBh.x + i]; let c = g[P.oCh.x + i];
      let a0 = b * psi[P.oPsiA.x + m] + c * ezx; psi[P.oPsiA.x + m] = a0;
      let a1 = b * psi[P.oPsiA.y + m] + c * eyx; psi[P.oPsiA.y + m] = a1;
      hy += P.c * a0; hz -= P.c * a1;
    }
    let my = slabH(j, P.ny, P.pml);
    if (my != 0xffffffffu) {
      let m = i + P.sx * (my + p2 * k); let b = g[P.oBh.y + j]; let c = g[P.oCh.y + j];
      let a0 = b * psi[P.oPsiA.z + m] + c * ezy; psi[P.oPsiA.z + m] = a0;
      let a1 = b * psi[P.oPsiB.x + m] + c * exy; psi[P.oPsiB.x + m] = a1;
      hx -= P.c * a0; hz += P.c * a1;
    }
    let mz = slabH(k, P.nz, P.pml);
    if (mz != 0xffffffffu) {
      let m = i + P.sx * (j + P.sy * mz); let b = g[P.oBh.z + k]; let c = g[P.oCh.z + k];
      let a0 = b * psi[P.oPsiB.y + m] + c * eyz; psi[P.oPsiB.y + m] = a0;
      let a1 = b * psi[P.oPsiB.z + m] + c * exz; psi[P.oPsiB.z + m] = a1;
      hx += P.c * a0; hy -= P.c * a1;
    }
  }
  h[id] = hx; h[N + id] = hy; h[2u * N + id] = hz;
}`;

const STEP_E = COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> e: array<f32>;
@group(0) @binding(2) var<storage, read> h: array<f32>;
@group(0) @binding(3) var<storage, read> g: array<f32>;
@group(0) @binding(4) var<storage, read_write> psi: array<f32>;
@group(0) @binding(5) var<storage, read> ce: array<f32>;
@compute @workgroup_size(4, 4, 4) fn main(@builtin(global_invocation_id) q: vec3<u32>) {
  let i = q.x; let j = q.y; let k = q.z;
  if (i > P.nx || j > P.ny || k > P.nz) { return; }
  let id = i + P.sx * (j + P.sy * k); let N = P.n;
  let hx = h[id]; let hy = h[N + id]; let hz = h[2u * N + id];
  // The differences that are there: none across the first plane of an axis
  var hzy = 0.0; var hxy = 0.0; var hyz = 0.0; var hxz = 0.0; var hzx = 0.0; var hyx = 0.0;
  if (j >= 1u) { let d = g[P.oIdyd + j]; hzy = (hz - h[2u * N + id - P.sx]) * d; hxy = (hx - h[id - P.sx]) * d; }
  if (k >= 1u) { let d = g[P.oIdzd + k]; hyz = (hy - h[N + id - P.sxy]) * d; hxz = (hx - h[id - P.sxy]) * d; }
  if (i >= 1u) { let d = g[P.oIdxd + i]; hzx = (hz - h[2u * N + id - 1u]) * d; hyx = (hy - h[N + id - 1u]) * d; }
  let cbx = ce[N + id]; let cby = ce[3u * N + id]; let cbz = ce[5u * N + id];
  var ex = ce[id] * e[id] + cbx * (hzy - hyz);
  var ey = ce[2u * N + id] * e[N + id] + cby * (hxz - hzx);
  var ez = ce[4u * N + id] * e[2u * N + id] + cbz * (hyx - hxy);
  if (P.pml > 0u) {
    let p2 = 2u * P.pml;
    let mx = slabE(i, P.nx, P.pml);
    if (mx != 0xffffffffu && j < P.ny && k < P.nz) {
      let m = mx + p2 * (j + P.sy * k); let b = g[P.oBe.x + i]; let c = g[P.oCe.x + i];
      let a0 = b * psi[P.oPsiA.x + m] + c * hzx; psi[P.oPsiA.x + m] = a0;
      let a1 = b * psi[P.oPsiA.y + m] + c * hyx; psi[P.oPsiA.y + m] = a1;
      ey -= cby * a0; ez += cbz * a1;
    }
    let my = slabE(j, P.ny, P.pml);
    if (my != 0xffffffffu && i < P.nx && k < P.nz) {
      let m = i + P.sx * (my + p2 * k); let b = g[P.oBe.y + j]; let c = g[P.oCe.y + j];
      let a0 = b * psi[P.oPsiA.z + m] + c * hzy; psi[P.oPsiA.z + m] = a0;
      let a1 = b * psi[P.oPsiB.x + m] + c * hxy; psi[P.oPsiB.x + m] = a1;
      ex += cbx * a0; ez -= cbz * a1;
    }
    let mz = slabE(k, P.nz, P.pml);
    if (mz != 0xffffffffu && i < P.nx && j < P.ny) {
      let m = i + P.sx * (j + P.sy * mz); let b = g[P.oBe.z + k]; let c = g[P.oCe.z + k];
      let a0 = b * psi[P.oPsiB.y + m] + c * hyz; psi[P.oPsiB.y + m] = a0;
      let a1 = b * psi[P.oPsiB.z + m] + c * hxz; psi[P.oPsiB.z + m] = a1;
      ex -= cbx * a0; ey += cby * a1;
    }
  }
  e[id] = ex; e[N + id] = ey; e[2u * N + id] = ez;
}`;

// The port: its source added to its edges, then its voltage written down for this step
const PORT = /* wgsl */ `
struct Step { step: u32, edges: u32, off: u32, pad: u32 }
@group(0) @binding(0) var<uniform> S: Step;
@group(0) @binding(1) var<storage, read_write> e: array<f32>;
@group(0) @binding(2) var<storage, read> port: array<f32>;
@group(0) @binding(3) var<storage, read> src: array<f32>;
@group(0) @binding(4) var<storage, read_write> series: array<f32>;
@compute @workgroup_size(1) fn main() {
  let vs = src[S.step];
  var v = 0.0;
  for (var m = 0u; m < S.edges; m++) {
    let id = S.off + bitcast<u32>(port[3u * m]);
    let x = e[id] - port[3u * m + 2u] * vs;
    e[id] = x; v -= x * port[3u * m + 1u];
  }
  series[S.step] = v;
}`;

// The watched nodes' six fields, side by side
const GATHER = /* wgsl */ `
struct G { count: u32, n: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> U: G;
@group(0) @binding(1) var<storage, read> e: array<f32>;
@group(0) @binding(2) var<storage, read> h: array<f32>;
@group(0) @binding(3) var<storage, read> nodes: array<u32>;
@group(0) @binding(4) var<storage, read_write> o: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) q: vec3<u32>) {
  let m = q.x;
  if (m >= U.count) { return; }
  let id = nodes[m];
  o[6u * m] = e[id]; o[6u * m + 1u] = e[U.n + id]; o[6u * m + 2u] = e[2u * U.n + id];
  o[6u * m + 3u] = h[id]; o[6u * m + 4u] = h[U.n + id]; o[6u * m + 5u] = h[2u * U.n + id];
}`;

/** A "card" that is the processor drawing in software is many times slower than the processor's own steps: not one to run on. */
const software = (a: Gpu): boolean => a.isFallbackAdapter === true || a.info?.isFallbackAdapter === true
  || /swiftshader|llvmpipe|software|basic render/i.test(`${a.info?.architecture ?? ''} ${a.info?.description ?? ''} ${a.info?.device ?? ''}`);

/** The browser's graphics card to run on, or null (asked once). With `evenSoftware`, one drawn in software too: for testing. */
let asked: Promise<Gpu | null> | null = null;
export function gpuAdapter(evenSoftware = false): Promise<Gpu | null> {
  const nav = (globalThis as { navigator?: { gpu?: Gpu } }).navigator;
  asked ??= nav?.gpu ? (nav.gpu.requestAdapter({ powerPreference: 'high-performance' }) as Promise<Gpu | null>).catch(() => null) : Promise.resolve(null);
  return asked.then((a) => (a && (evenSoftware || !software(a)) ? a : null));
}

/**
 * The simulation taken to the graphics card: null when there is none, or it has not room. `nodes`
 * are the nodes whose fields are read back after each batch. The simulation's own arrays are left
 * as they are but for those nodes; its step count is the caller's to keep.
 */
export async function startGpu(sim: Fdtd, nodes: Uint32Array, evenSoftware = false): Promise<GpuRun | null> {
  const adapter = await gpuAdapter(evenSoftware);
  if (!adapter) return null;
  const N = sim.sx * sim.sy * sim.sz, P = sim.pml, port = sim.ports[0];
  if (!port || sim.ports.length !== 1) return null;
  const need = Math.max(6 * N * 4, 6 * Math.max(1, nodes.length) * 4);
  if (need > adapter.limits.maxStorageBufferBindingSize || need > adapter.limits.maxBufferSize) return null;
  let dev: Gpu;
  try {
    dev = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } });
  } catch { return null; }
  const U = (globalThis as unknown as { GPUBufferUsage: Record<string, number>; GPUShaderStage: Record<string, number>; GPUMapMode: Record<string, number> });
  const usage = U.GPUBufferUsage, COMPUTE = U.GPUShaderStage.COMPUTE!;
  const made: Gpu[] = [];
  const buffer = (data: ArrayBufferView | number, use: number) => {
    const size = Math.max(16, Math.ceil((typeof data === 'number' ? data : data.byteLength) / 4) * 4);
    const b = dev.createBuffer({ size, usage: use });
    if (typeof data !== 'number') dev.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
    made.push(b);
    return b;
  };
  const STORE = usage.STORAGE! | usage.COPY_DST! | usage.COPY_SRC!;
  // The rows of numbers along the axes, end to end
  const rows: Float32Array[] = [sim.idx, sim.idy, sim.idz, sim.idxd, sim.idyd, sim.idzd, ...sim.be, ...sim.ce, ...sim.bh, ...sim.ch];
  const offs: number[] = [];
  let total = 0;
  for (const r of rows) { offs.push(total); total += r.length; }
  const g = new Float32Array(total);
  rows.forEach((r, q) => g.set(r, offs[q]!));
  // The absorber's memories fold the cells' sizes into c on the processor; here the differences come already divided
  const { sx, sy, sz, nx, ny, nz } = sim;
  const psiSize = [2 * P * sy * sz, 2 * P * sy * sz, sx * 2 * P * sz, sx * 2 * P * sz, sx * sy * 2 * P, sx * sy * 2 * P], psiOff: number[] = [];
  let psiTotal = 0;
  for (const q of psiSize) { psiOff.push(psiTotal); psiTotal += q; }
  const params = new ArrayBuffer(176), pu = new Uint32Array(params), pf = new Float32Array(params);
  pu.set([nx, ny, nz, P, sx, sy, sx * sy, N], 0);
  pf[8] = sim.dt / MU0; pu[9] = port.edges.length; pu[10] = nodes.length; pu[11] = 0;
  pu.set(offs.slice(0, 6), 12);
  // vec3<u32> fields are laid out on 16-byte boundaries
  pu.set(offs.slice(6, 9), 20); pu.set(offs.slice(9, 12), 24); pu.set(offs.slice(12, 15), 28); pu.set(offs.slice(15, 18), 32);
  pu.set(psiOff.slice(0, 3), 36); pu.set(psiOff.slice(3, 6), 40);
  const pBuf = buffer(new Uint8Array(params), usage.UNIFORM! | usage.COPY_DST!);
  const eBuf = buffer(3 * N * 4, STORE), hBuf = buffer(3 * N * 4, STORE);
  const all = new Float32Array(3 * N);
  all.set(sim.ex, 0); all.set(sim.ey, N); all.set(sim.ez, 2 * N); dev.queue.writeBuffer(eBuf, 0, all);
  all.set(sim.hx, 0); all.set(sim.hy, N); all.set(sim.hz, 2 * N); dev.queue.writeBuffer(hBuf, 0, all);
  const ce = new Float32Array(6 * N);
  [sim.cax, sim.cbx, sim.cay, sim.cby, sim.caz, sim.cbz].forEach((a, q) => ce.set(a, q * N));
  const ceBuf = buffer(ce, STORE), gBuf = buffer(g, STORE);
  const psiE = buffer(Math.max(4, psiTotal) * 4, STORE), psiH = buffer(Math.max(4, psiTotal) * 4, STORE);
  // The port: each edge's place (in its own field's array), its length and what the source adds to it
  const pd = new ArrayBuffer(12 * port.edges.length), pdu = new Uint32Array(pd), pdf = new Float32Array(pd);
  for (let m = 0; m < port.edges.length; m++) { pdu[3 * m] = port.edges[m]!; pdf[3 * m + 1] = port.len[m]!; pdf[3 * m + 2] = port.drive[m]!; }
  const portBuf = buffer(new Uint8Array(pd), STORE);
  const srcBuf = buffer(SLOTS * 4, STORE), seriesBuf = buffer(SLOTS * 4, STORE);
  const steps = new ArrayBuffer(256 * SLOTS), su = new Uint32Array(steps);
  for (let q = 0; q < SLOTS; q++) su.set([q, port.edges.length, port.axis * N, 0], q * 64);
  const stepBuf = buffer(new Uint8Array(steps), usage.UNIFORM! | usage.COPY_DST!);
  const count = nodes.length;
  const nodeBuf = buffer(count ? nodes : new Uint32Array(4), STORE), outBuf = buffer(Math.max(4, 6 * count) * 4, STORE);
  const gU = buffer(new Uint32Array([count, N, 0, 0]), usage.UNIFORM! | usage.COPY_DST!);
  const readSeries = buffer(SLOTS * 4, usage.MAP_READ! | usage.COPY_DST!), readOut = buffer(Math.max(4, 6 * count) * 4, usage.MAP_READ! | usage.COPY_DST!);

  const pipeline = (code: string, kinds: string[], dynamic = false) => {
    const layout = dev.createBindGroupLayout({ entries: kinds.map((type, binding) => ({ binding, visibility: COMPUTE, buffer: { type, ...(binding === 0 && dynamic ? { hasDynamicOffset: true, minBindingSize: 16 } : {}) } })) });
    const pipe = dev.createComputePipeline({ layout: dev.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module: dev.createShaderModule({ code }), entryPoint: 'main' } });
    return { pipe, group: (bufs: Gpu[]) => dev.createBindGroup({ layout, entries: bufs.map((b, binding) => ({ binding, resource: binding === 0 && dynamic ? { buffer: b, size: 16 } : { buffer: b } })) }) };
  };
  const RO = 'read-only-storage', RW = 'storage';
  const hP = pipeline(STEP_H, ['uniform', RO, RW, RO, RW]), eP = pipeline(STEP_E, ['uniform', RW, RO, RO, RW, RO]);
  const pP = pipeline(PORT, ['uniform', RW, RO, RO, RW], true), gP = pipeline(GATHER, ['uniform', RO, RO, RO, RW]);
  const hG = hP.group([pBuf, eBuf, hBuf, gBuf, psiH]), eG = eP.group([pBuf, eBuf, hBuf, gBuf, psiE, ceBuf]);
  const pG = pP.group([stepBuf, eBuf, portBuf, srcBuf, seriesBuf]), gG = gP.group([gU, eBuf, hBuf, nodeBuf, outBuf]);
  const wx = Math.ceil(sx / 4), wy = Math.ceil(sy / 4), wz = Math.ceil(sz / 4);
  const fields = [sim.ex, sim.ey, sim.ez, sim.hx, sim.hy, sim.hz];
  let lost = false;
  void (dev.lost as Promise<unknown>).then(() => { lost = true; });

  return {
    adapter: String(adapter.info?.description || adapter.info?.vendor || 'graphics card'),
    batch: SLOTS,
    async advance(vs) {
      if (lost) throw new Error('The graphics card was lost');
      const K = Math.min(vs.length, SLOTS);
      dev.queue.writeBuffer(srcBuf, 0, vs.buffer, vs.byteOffset, K * 4);
      const enc = dev.createCommandEncoder();
      for (let q = 0; q < K; q++) {
        let ps = enc.beginComputePass(); ps.setPipeline(hP.pipe); ps.setBindGroup(0, hG); ps.dispatchWorkgroups(wx, wy, wz); ps.end();
        ps = enc.beginComputePass(); ps.setPipeline(eP.pipe); ps.setBindGroup(0, eG); ps.dispatchWorkgroups(wx, wy, wz); ps.end();
        ps = enc.beginComputePass(); ps.setPipeline(pP.pipe); ps.setBindGroup(0, pG, [q * 256]); ps.dispatchWorkgroups(1); ps.end();
      }
      if (count) { const ps = enc.beginComputePass(); ps.setPipeline(gP.pipe); ps.setBindGroup(0, gG); ps.dispatchWorkgroups(Math.ceil(count / 64)); ps.end(); }
      enc.copyBufferToBuffer(seriesBuf, 0, readSeries, 0, K * 4);
      if (count) enc.copyBufferToBuffer(outBuf, 0, readOut, 0, 6 * count * 4);
      dev.queue.submit([enc.finish()]);
      const READ = U.GPUMapMode.READ!;
      await Promise.all([readSeries.mapAsync(READ, 0, K * 4), count ? readOut.mapAsync(READ, 0, 6 * count * 4) : null]);
      const v = new Float32Array(readSeries.getMappedRange(0, K * 4).slice(0));
      readSeries.unmap();
      if (count) {
        const o = new Float32Array(readOut.getMappedRange(0, 6 * count * 4));
        for (let m = 0; m < count; m++) { const id = nodes[m]!; for (let c = 0; c < 6; c++) fields[c]![id] = o[6 * m + c]!; }
        readOut.unmap();
      }
      return v;
    },
    destroy() { for (const b of made) b.destroy(); dev.destroy?.(); },
  };
}
