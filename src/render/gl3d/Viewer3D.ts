/**
 * 3D Layout Mode (3): the board as a solid, its painted faces and its components' 3D bodies,
 * drawn with WebGL 2 over the 2D view. Navigation as Altium's 3D view: Shift + right-drag
 * rotates, right-drag pans, Ctrl + wheel zooms at the cursor (wheel scrolls, Shift + wheel
 * scrolls sideways), 0 looks straight down, 9 straight down turned 90°, 8 from an angle.
 * Colours, opacity, projection and which bodies show come from the 3D view configuration
 * (settings.pcb3d, View Configurations › Physical Materials).
 */
import { rgbToHex, settings, settingsChanged, wheelAction, type Settings } from '../../core/settings';
import { baseOpacity, hexRgb, sideLook, workspaceEnds, type View3D } from '../../core/view3d';
import { L, layerColour, type LayerId } from '../../model/layers';
import { bodyMesh, buildBoardModel, type BoardModel, type Body3D, type Mesh, type RGBA } from './boardModel';
import { bodyTransform, embeddedModels, linkedModels, loadModel, placedMeshes, type ModelFiles } from './stepBodies';
import { addModelFolder, allowModelFolders, modelFolders, modelFoldersChanged } from '../../platform/modelFolders';
import { apply, invert, type StepModel } from '../../formats/step/tessellate';
import { UNITS_PER_MM } from '../../core/units';
import type { Vec2 } from '../../core/geom';
import { paintSide, paintSingle, singleFace } from './boardTexture';
import { foldPoints, regionAt } from '../../model/rigidFlex';
import type { PcbDocument } from '../../model/pcb';
import { routeCuts } from '../../model/routeToolPath';
import { roomsOf } from '../../model/rooms';

type M4 = Float32Array;
export const ident = (): M4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
export function mul(a: M4, b: M4): M4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
    o[c * 4 + r] = s;
  }
  return o;
}
export function perspective(fovy: number, aspect: number, near: number, far: number): M4 {
  const f = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = (2 * far * near) / (near - far);
  return m;
}
type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const VS = `#version 300 es
in vec3 aPos; in vec3 aNrm; in vec2 aUv;
uniform mat4 uMvp;
out vec3 vN; out vec2 vUv; out vec3 vP;
void main() { vN = aNrm; vUv = aUv; vP = aPos; gl_Position = uMvp * vec4(aPos, 1.0); }`;
export const FS = `#version 300 es
precision highp float;
in vec3 vN; in vec2 vUv; in vec3 vP;
uniform vec4 uColour; uniform int uTex; uniform sampler2D uSampler; uniform vec3 uEye; uniform float uSee;
out vec4 o;
void main() {
  vec4 c = uColour;
  if (uTex == 1) {
    c = texture(uSampler, vUv);
    // An opaque board's faces are solid (holes cut at half cover); a see-through one keeps the painted alpha
    if (uSee < 0.5) { if (c.a < 0.5) discard; c.a = 1.0; } else if (c.a < 0.02) discard;
  }
  vec3 n = normalize(vN);
  if (dot(n, uEye - vP) < 0.0) n = -n;
  vec3 l1 = normalize(vec3(-0.35, -0.5, 1.0)), l2 = normalize(vec3(0.6, 0.45, 0.5));
  float d = 0.36 + 0.52 * max(dot(n, l1), 0.0) + 0.22 * max(dot(n, l2), 0.0);
  vec3 h = normalize(l1 + normalize(uEye - vP));
  float s = pow(max(dot(n, h), 0.0), 40.0) * 0.12;
  o = vec4(min(c.rgb * d + s, vec3(1.0)), c.a);
}`;

/** The workspace behind the board: its colour, shaded top to bottom. */
export const BG_VS = `#version 300 es
out float vY;
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vY = p.y; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
export const BG_FS = `#version 300 es
precision mediump float;
in float vY; uniform vec3 uTop; uniform vec3 uBottom;
out vec4 o;
void main() { o = vec4(mix(uBottom, uTop, clamp(vY, 0.0, 1.0)), 1.0); }`;

export function ortho(hw: number, hh: number, near: number, far: number): M4 {
  const m = new Float32Array(16);
  m[0] = 1 / hw; m[5] = 1 / hh; m[10] = -2 / (far - near); m[14] = -(far + near) / (far - near); m[15] = 1;
  return m;
}
const rgba = (hex: string, a = 1): RGBA => { const [r, g, b] = hexRgb(hex); return [r / 255, g / 255, b / 255, a]; };

/** What a click in 3D met: the point and the face (view millimetres), the body if any, the nearest corner. */
export interface Hit3D {
  p: V3; n: V3; tri: [V3, V3, V3]; vertex: V3;
  body?: Body3D;
  /** The triangles of the same mesh in the clicked face's plane (the whole face). */
  coplanar?: () => [V3, V3, V3][];
  /** Board coordinates of the point, and its height above the board's underside (mm). */
  board: Vec2; z: number;
}
interface Pickable { pos: Float32Array; idx: Uint32Array; body?: Body3D }

/** A small diamond marking a snap point (or the origin). */
export function marker(c: V3, r: number, colour: RGBA = [1, 0.85, 0.1, 1]): Mesh {
  const v: V3[] = [[r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r]].map((d) => [c[0] + d[0]!, c[1] + d[1]!, c[2] + d[2]!] as V3);
  const faces = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
  const pos: number[] = [], nrm: number[] = [];
  for (const f of faces) {
    const [a, b, cc] = f.map((i) => v[i]!) as [V3, V3, V3];
    const n = [(b[1] - a[1]) * (cc[2] - a[2]) - (b[2] - a[2]) * (cc[1] - a[1]), (b[2] - a[2]) * (cc[0] - a[0]) - (b[0] - a[0]) * (cc[2] - a[2]), (b[0] - a[0]) * (cc[1] - a[1]) - (b[1] - a[1]) * (cc[0] - a[0])];
    for (const q of [a, b, cc]) { pos.push(...q); nrm.push(...n); }
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: null, idx: new Uint32Array(pos.length / 3).map((_, i) => i), colour };
}

/** A thin square bar from `a` to `b` (the axes). */
export function bar(a: V3, b: V3, r: number, colour: RGBA): Mesh {
  const d = sub(b, a), l = Math.hypot(...d) || 1, u = scale(d, 1 / l);
  const p: V3 = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const cr = (x: V3, y: V3): V3 => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const s1 = scale(cr(u, p), r / Math.hypot(...cr(u, p))), s2 = scale(cr(u, s1), 1);
  const ring = (c: V3) => [add(c, add(s1, s2)), add(c, sub(s2, s1)), sub(c, add(s1, s2)), add(c, sub(s1, s2))];
  const lo = ring(a), hi = ring(b);
  const pos: number[] = [], nrm: number[] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4, q = [lo[i]!, lo[j]!, hi[j]!, lo[i]!, hi[j]!, hi[i]!];
    const n = sub(add(lo[i]!, lo[j]!), scale(a, 2));
    for (const v of q) { pos.push(...v); nrm.push(...n); }
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: null, idx: new Uint32Array(pos.length / 3).map((_, i) => i), colour };
}

/** Models the file links to instead of carrying: their paths by model id, and how to find one's file. */
export interface LinkedModels { names: () => Map<string, string>; find: (path: string) => Promise<Uint8Array | null> }

interface GpuMesh { vao: WebGLVertexArrayObject; count: number; colour: Mesh['colour']; texture?: 'top' | 'bottom' | 'single'; bufs: WebGLBuffer[] }

export class Viewer3D {
  readonly host: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null;
  private prog: WebGLProgram | null = null;
  private bgProg: WebGLProgram | null = null;
  private bgVao: WebGLVertexArrayObject | null = null;
  private offSettings: () => void = () => {};
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private meshes: GpuMesh[] = [];
  /** The components' bodies, drawn after the board (see-through ones last). */
  private bodyMeshes: GpuMesh[] = [];
  /** STEP models read so far, by model id (null: unreadable, the extrusion stays). */
  private stepModels = new Map<string, StepModel | null>();
  private stepTimer = 0;
  /** STEP models being read (ready() waits for them). */
  private loading = new Set<Promise<unknown>>();
  /** Linked models not found (model id → the file's name), and the note that says so. */
  private missing = new Map<string, string>();
  private note: HTMLDivElement | null = null;
  private offFolders: () => void = () => {};
  /** CPU copies of what is drawn, for picking. */
  private pickBoard: Pickable[] = [];
  private pickBodies: Pickable[] = [];
  /** Tools › 3D Body Placement: clicks go to this while it is set. */
  private picker: { hint: string; fn: (h: Hit3D | null) => void } | null = null;
  private downAt: { x: number; y: number } | null = null;
  private textures = new Map<'top' | 'bottom' | 'single', WebGLTexture>();
  private model: BoardModel | null = null;
  private frame = 0;
  /** Rigid-flex: how far the board is folded (0 flat … 1 folded), and the animation towards a target. */
  private foldNow = 0;
  private foldFrame = 0;
  private ro: ResizeObserver;
  private dpr = 1;
  private w = 1; private h = 1;
  /** Orbit camera: target point, distance, turn about Z and tilt away from straight down (radians). */
  target: V3 = [0, 0, 0];
  dist = 100;
  yaw = 0;
  pitch = 0;
  private fov = (30 * Math.PI) / 180;
  private drag: { button: number; x: number; y: number; rotate: boolean } | null = null;
  private disposed = false;
  /** The window the view is in (a document window's too). */
  private get win(): Window & typeof globalThis { return (this.host.ownerDocument.defaultView ?? window) as Window & typeof globalThis; }
  /** Set when there was no WebGL 2: the view says so instead. */
  readonly failed: boolean;

  constructor(parent: HTMLElement, private doc: () => PcbDocument, private onNavigate?: () => void, private modelFiles: () => ModelFiles = () => embeddedModels(this.doc().cfb.root),
    private linked: LinkedModels = { names: () => linkedModels(this.doc().cfb.root), find: async () => null }, private folded: () => boolean = () => false,
    /** Single layer mode (Shift+S): the layer shown alone, or null. */ private single: () => LayerId | null = () => null) {
    this.host = document.createElement('div');
    this.host.className = 'viewer3d';
    this.canvas = document.createElement('canvas');
    this.host.append(this.canvas);
    parent.append(this.host);
    this.gl = this.canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.failed = !this.gl;
    if (this.gl) this.initGl(this.gl);
    else this.host.append(Object.assign(document.createElement('p'), { className: 'viewer3d-error', textContent: '3D Layout Mode needs WebGL 2, which this browser has turned off.' }));
    this.ro = new this.win.ResizeObserver(() => this.resize());
    this.ro.observe(this.host);
    this.bind();
    // A changed 3D view configuration (or the layers' colours it may use) shows at once
    const watch: (keyof Settings)[] = ['pcb3d', 'layerColours', 'pcbHiddenKinds', 'pcbBoardColour'];
    this.offSettings = settingsChanged.on((p) => { if (watch.some((k) => k in p)) this.rebuild(); });
    // A model folder added (or allowed again): look again for the linked models not found
    this.offFolders = modelFoldersChanged.on(() => {
      if (!this.missing.size) return;
      for (const id of this.missing.keys()) this.stepModels.delete(id);
      this.missing.clear();
      this.showNote();
      this.loadModels();
    });
    this.rebuild();
    this.resize();
    this.fit();
  }

  dispose(): void {
    this.disposed = true;
    this.offSettings();
    this.offFolders();
    try { this.win.cancelAnimationFrame(this.frame); this.win.cancelAnimationFrame(this.foldFrame); } catch { /* its window closed */ }
    clearTimeout(this.stepTimer);
    this.ro.disconnect();
    this.freeGpu();
    // Give the context back now (a browser keeps only so many)
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.host.remove();
  }

  /* ── model ── */
  /** Re-read the board (after edits). */
  rebuild(): void {
    const gl = this.gl;
    if (!gl) return;
    this.freeGpu();
    const doc = this.doc();
    const v = settings.pcb3d;
    const top = baseOpacity(v, 'top'), bottom = baseOpacity(v, 'bottom');
    const core = v.colouring === 'layers' ? settings.pcbBoardColour : v.core;
    // Single layer mode: the layer alone, on its face or on a plane at its depth, in a board seen through and without its components
    const alone = this.single();
    const face = alone !== null ? singleFace(doc, alone) : null;
    const stack = doc.board.copperStack;
    const model = buildBoardModel(doc, {
      zScale: v.zScale, cutouts: v.showCutouts, faceAlpha: alone !== null || Math.min(top, bottom) < 1 ? 0.999 : 1, routeCuts: v.showRoutePath ? routeCuts(doc) : undefined,
      core: rgba(core, alone !== null ? 0.08 : v.coreShow ? v.coreOpacity / 100 : 0),
      copper: rgba(v.colouring === 'layers' ? rgbToHex(layerColour(L.MULTI)) : v.copper, alone !== null ? 0.35 : 1),
      inner: face === 'inner' && alone !== null ? 1 - stack.indexOf(alone) / Math.max(1, stack.length - 1) : undefined,
      noBodies: alone !== null,
    });
    this.model = model;
    const outline = doc.board.outline.length >= 3 ? doc.board.outline : [
      { x: model.rect.minX, y: model.rect.minY }, { x: model.rect.maxX, y: model.rect.minY }, { x: model.rect.maxX, y: model.rect.maxY }, { x: model.rect.minX, y: model.rect.maxY }];
    const maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, 4096);
    const upload = (side: 'top' | 'bottom' | 'single', c: ReturnType<typeof paintSide>) => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c as TexImageSource);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const an = gl.getExtension('EXT_texture_filter_anisotropic');
      if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(an.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number));
      this.textures.set(side, tex);
    };
    for (const side of ['top', 'bottom'] as const) {
      const lh = (l: number) => rgbToHex(layerColour(l));
      const layerHex = side === 'top'
        ? { copper: lh(L.TOP), mask: lh(L.TOP_SOLDER), silk: lh(L.TOP_OVERLAY), board: settings.pcbBoardColour }
        : { copper: lh(L.BOTTOM), mask: lh(L.BOTTOM_SOLDER), silk: lh(L.BOTTOM_OVERLAY), board: settings.pcbBoardColour };
      upload(side, alone !== null ? paintSingle(doc, face === side ? alone : null, outline, model.rect, Math.min(maxTex, 3072), rgbToHex(layerColour(alone)), settings.pcbBoardColour, 0.14, v.showCutouts)
        : paintSide(doc, side, outline, model.rect, Math.min(maxTex, 3072), sideLook(v, side, layerHex), side === 'top' ? top : bottom));
    }
    // A layer inside the board: its own plane
    if (alone !== null && face === 'inner') upload('single', paintSingle(doc, alone, outline, model.rect, Math.min(maxTex, 3072), rgbToHex(layerColour(alone)), settings.pcbBoardColour, 0, v.showCutouts));
    this.foldNow = model.fold && this.folded() ? 1 : 0;
    this.uploadBoard();
    this.uploadBodies();
    this.loadModels();
    this.requestRender();
  }

  /** A mesh as the board's folds put it (flat: as built). */
  private foldMesh(m: Mesh, region?: number): Mesh {
    const f = this.model?.fold;
    if (!f || this.foldNow <= 0) return m;
    const pos = m.pos.slice(), nrm = m.nrm.slice();
    foldPoints(f, this.foldNow, pos, nrm, region ?? m.region);
    return { ...m, pos, nrm };
  }
  /** The region a body stands in (by its outline's middle). */
  private bodyRegion(b: Body3D): number {
    const f = this.model?.fold;
    if (!f || !b.outline.length) return -1;
    const x = b.outline.reduce((a, p) => a + p.x, 0) / b.outline.length, y = b.outline.reduce((a, p) => a + p.y, 0) / b.outline.length;
    return regionAt(f, x, y);
  }

  /** The board's own meshes (faces, edges, barrels), folded as far as it is. */
  private uploadBoard(): void {
    const gl = this.gl, model = this.model;
    if (!gl || !model) return;
    for (const m of this.meshes) { gl.deleteVertexArray(m.vao); for (const b of m.bufs) gl.deleteBuffer(b); }
    this.meshes = [];
    const shown = model.meshes.map((m) => this.foldMesh(m));
    for (const m of shown) this.upload(m);
    this.pickBoard = shown.map((m) => ({ pos: m.pos, idx: m.idx }));
  }

  /** View › Fold/Unfold: the board folds (1) or unfolds (0) over half a second, its bends in Fold Index order. */
  foldTo(target: number): void {
    if (!this.model?.fold) return;
    this.win.cancelAnimationFrame(this.foldFrame);
    const from = this.foldNow, t0 = performance.now(), ms = 400 + 300 * this.model.fold.groups;
    const step = () => {
      if (this.disposed) return;
      const k = Math.min(1, (performance.now() - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      this.foldNow = from + (target - from) * e;
      this.uploadBoard(); this.uploadBodies(); this.requestRender();
      if (k < 1) this.foldFrame = this.win.requestAnimationFrame(step);
    };
    step();
  }
  /** Folded this far at once (the PCB panel's Fold State). */
  setFold(v: number): void {
    if (!this.model?.fold) return;
    this.win.cancelAnimationFrame(this.foldFrame);
    this.foldNow = Math.max(0, Math.min(1, v));
    this.uploadBoard(); this.uploadBodies(); this.requestRender();
  }
  /** How far the board is folded (0 … 1). */
  get foldState(): number { return this.foldNow; }

  /** Bodies: a STEP model where it has been read, else the body's extrusion. Opaque first. */
  private uploadBodies(): void {
    const gl = this.gl, model = this.model;
    if (!gl || !model) return;
    for (const m of this.bodyMeshes) { gl.deleteVertexArray(m.vao); for (const b of m.bufs) gl.deleteBuffer(b); }
    this.bodyMeshes = [];
    const all: Mesh[] = [];
    this.pickBodies = [];
    const v = settings.pcb3d;
    for (const b of this.shownBodies(model.bodies, v)) {
      const m = b.step ? this.stepModels.get(b.step.modelId) : undefined;
      const reg = this.bodyRegion(b);
      const meshes = (b.step && m ? placedMeshes(b.step, m, bodyTransform(b.step, m, model.centre, model.thickness)) : [bodyMesh(b)]).map((x) => (reg >= 0 ? { ...x, region: reg } : x));
      all.push(...meshes);
      for (const x of meshes) this.pickBodies.push({ pos: x.pos, idx: x.idx, body: b });
      // Snap points, marked
      if (v.snapMarkers && b.step && m && b.step.snaps?.length) {
        const xf = bodyTransform(b.step, m, model.centre, model.thickness);
        for (const sp of b.step.snaps) all.push(marker(apply(xf, sp), Math.max(0.08, this.size() / 400)));
      }
    }
    // Wire links (Place › Wire Link): their wires and solder, whatever bodies show
    all.push(...(model.wires ?? []));
    // The origin and the axes, as asked
    const o = this.doc().board.origin, at = (z: number): V3 => [(o.x - model.centre.x) / UNITS_PER_MM, (o.y - model.centre.y) / UNITS_PER_MM, z];
    const sz = this.size();
    if (v.showOrigin) all.push(marker(at(model.thickness), Math.max(0.15, sz / 150), [1, 1, 1, 1]));
    if (v.axes) {
      const len = Math.max(2, sz / 5), r = Math.max(0.03, sz / 900), a = at(model.thickness);
      all.push(bar(a, add(a, [len, 0, 0]), r, [0.9, 0.2, 0.2, 1]), bar(a, add(a, [0, len, 0]), r, [0.2, 0.8, 0.25, 1]), bar(a, add(a, [0, 0, len]), r, [0.25, 0.45, 1, 1]));
    }
    // Rooms: see-through boxes on their side of the board [est: 2 mm tall, AD17's lilac]
    if (v.showRooms) for (const r of roomsOf(this.doc())) {
      const h = 2, top = r.layer !== L.BOTTOM;
      all.push(bodyMesh({ component: 0xffff, outline: r.outline.map((q) => ({ x: (q.x - model.centre.x) / UNITS_PER_MM, y: (q.y - model.centre.y) / UNITS_PER_MM })),
        z0: top ? model.thickness : -h, z1: top ? model.thickness + h : 0, colour: [0.706, 0.549, 0.902, r.enabled ? 0.28 : 0.14] }));
    }
    // Folded with the board (bodies on a part that turns, turn with it)
    const folded = all.map((m) => this.foldMesh(m));
    if (folded.some((m, i) => m !== all[i])) {
      let k = 0;
      for (const p of this.pickBodies) { while (k < all.length && all[k]!.pos !== p.pos) k++; if (k < all.length) p.pos = folded[k]!.pos; }
    }
    for (const m of folded.sort((a, c) => c.colour[3] - a.colour[3])) this.upload(m, this.bodyMeshes);
  }

  /**
   * The bodies the configuration shows: simple (extruded) and generic (STEP) ones each by its
   * setting (Use System Setting: as Show/Hide's 3D Bodies), and of a component with both kinds
   * the ones it prefers.
   */
  private shownBodies(bodies: Body3D[], v: View3D): Body3D[] {
    const system = !settings.pcbHiddenKinds.includes('body');
    const on = (s: View3D['simpleBodies']) => s === 'yes' || (s === 'system' && system);
    const simple = on(v.simpleBodies), generic = on(v.genericBodies);
    const kinds = new Map<number, number>();
    for (const b of bodies) kinds.set(b.component, (kinds.get(b.component) ?? 0) | (b.step ? 2 : 1));
    return bodies.filter((b) => {
      if (b.step ? !generic : !simple) return false;
      if (b.component === 0xffff || kinds.get(b.component) !== 3 || v.both === 'both') return true;
      return v.both === 'generic' ? !!b.step : !b.step;
    });
  }

  /**
   * Read the STEP models the bodies show (once each), then show them: embedded in the file, or
   * linked (its file looked for by name in the project's folder and the model folders).
   */
  private loadModels(): void {
    const model = this.model;
    if (!model) return;
    const want = new Map<string, string>();
    for (const b of model.bodies) if (b.step && !this.stepModels.has(b.step.modelId) && !want.has(b.step.modelId)) want.set(b.step.modelId, b.step.name);
    if (!want.size) return;
    const files = this.modelFiles();
    let links: Map<string, string> | null = null;
    const show = (id: string, m: StepModel | null) => {
      if (this.disposed) return;
      this.stepModels.set(id, m);
      // Shown in batches as they come in
      if (!this.stepTimer) this.stepTimer = window.setTimeout(() => { this.stepTimer = 0; this.uploadBodies(); this.requestRender(); }, 120);
    };
    for (const [id, bodyName] of want) {
      const f = files.get(id);
      if (f) {
        const p = loadModel(`${id}:${f.checksum}:${f.data.length}`, f.data).then((m) => show(id, m));
        this.loading.add(p);
        void p.finally(() => this.loading.delete(p));
        continue;
      }
      links ??= this.linked.names();
      const path = links.get(id) || bodyName;
      // Not looked for twice at once; null until found (the extrusion stands in)
      this.stepModels.set(id, null);
      if (!path) continue;
      const p = this.linked.find(path).then(async (data) => {
        if (this.disposed) return;
        if (!data) { this.missing.set(id, path.split(/[\\/]/).pop() ?? path); this.showNote(); return; }
        show(id, await loadModel(`link:${path.toLowerCase()}:${data.length}`, data));
      });
      this.loading.add(p);
      void p.finally(() => this.loading.delete(p));
    }
  }

  /** Linked models not found: which, and where to tell Konium to look. */
  private showNote(): void {
    if (!this.missing.size) { this.note?.remove(); this.note = null; return; }
    if (!this.note) {
      this.note = document.createElement('div');
      this.note.className = 'viewer3d-note';
      this.note.addEventListener('pointerdown', (e) => e.stopPropagation());
      this.host.append(this.note);
    }
    const names = [...new Set(this.missing.values())];
    const ask = modelFolders.value.some((f) => f.state === 'ask');
    this.note.replaceChildren();
    const text = document.createElement('span');
    text.textContent = `${names.length} linked STEP model${names.length === 1 ? '' : 's'} not found (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''}): add the folder ${names.length === 1 ? 'it is' : 'they are'} in.`;
    text.title = names.join('\n');
    const btn = (label: string, fn: () => void) => { const b = document.createElement('button'); b.className = 'btn'; b.textContent = label; b.addEventListener('click', fn); return b; };
    this.note.append(text);
    if (ask) this.note.append(btn('Allow Model Folders', () => { void allowModelFolders(); }));
    const close = btn('×', () => { this.note?.remove(); this.note = null; });
    close.className = 'viewer3d-close';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    this.note.append(btn('Add Model Folder...', () => { void addModelFolder(); }), close);
  }
  /** The linked models not found (their file names). */
  get missingModels(): string[] { return [...new Set(this.missing.values())]; }

  private upload(m: Mesh, into: GpuMesh[] = this.meshes): void {
    const gl = this.gl!;
    if (!m.idx.length) return;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const bufs: WebGLBuffer[] = [];
    const attr = (name: string, data: Float32Array, size: number) => {
      const loc = gl.getAttribLocation(this.prog!, name);
      if (loc < 0) return;
      const b = gl.createBuffer()!;
      bufs.push(b);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    attr('aPos', m.pos, 3);
    attr('aNrm', m.nrm, 3);
    // Untextured meshes leave the UVs at the attribute's constant default
    if (m.uv) attr('aUv', m.uv, 2);
    const ib = gl.createBuffer()!;
    bufs.push(ib);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    into.push({ vao, count: m.idx.length, colour: m.colour, texture: m.texture, bufs });
  }

  private freeGpu(): void {
    const gl = this.gl;
    if (!gl) return;
    for (const m of [...this.meshes, ...this.bodyMeshes]) { gl.deleteVertexArray(m.vao); for (const b of m.bufs) gl.deleteBuffer(b); }
    for (const t of this.textures.values()) gl.deleteTexture(t);
    this.meshes = [];
    this.bodyMeshes = [];
    this.textures.clear();
  }

  private initGl(gl: WebGL2RenderingContext): void {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    this.prog = p;
    for (const u of ['uMvp', 'uColour', 'uTex', 'uSampler', 'uEye', 'uSee']) this.loc[u] = gl.getUniformLocation(p, u);
    const b = gl.createProgram()!;
    gl.attachShader(b, sh(gl.VERTEX_SHADER, BG_VS));
    gl.attachShader(b, sh(gl.FRAGMENT_SHADER, BG_FS));
    gl.linkProgram(b);
    if (gl.getProgramParameter(b, gl.LINK_STATUS)) {
      this.bgProg = b;
      this.bgVao = gl.createVertexArray();
      this.loc.uTop = gl.getUniformLocation(b, 'uTop');
      this.loc.uBottom = gl.getUniformLocation(b, 'uBottom');
    }
  }

  /* ── camera ── */
  private basis(): { right: V3; up: V3; back: V3 } {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    // Rz(yaw) · Rx(pitch) applied to the camera's x, y, z
    const right: V3 = [cy, sy, 0];
    const up: V3 = [-sy * cp, cy * cp, sp];
    const back: V3 = [sy * sp, -cy * sp, cp];
    return { right, up, back };
  }
  private eye(): V3 { return add(this.target, scale(this.basis().back, this.dist)); }

  private mvp(): M4 {
    const { right, up, back } = this.basis();
    const e = this.eye();
    const view = ident();
    view[0] = right[0]; view[4] = right[1]; view[8] = right[2];
    view[1] = up[0]; view[5] = up[1]; view[9] = up[2];
    view[2] = back[0]; view[6] = back[1]; view[10] = back[2];
    view[12] = -dot(right, e); view[13] = -dot(up, e); view[14] = -dot(back, e);
    const size = this.size();
    if (this.ortho) {
      const hh = this.dist * Math.tan(this.fov / 2);
      return mul(ortho(hh * (this.w / this.h), hh, -size * 4, this.dist + size * 4), view);
    }
    return mul(perspective(this.fov, this.w / this.h, Math.max(0.05, this.dist / 1000), this.dist + size * 4), view);
  }
  /** Projection › Orthographic: no perspective (the same size near and far). */
  private get ortho(): boolean { return settings.pcb3d.projection === 'orthographic'; }
  /** The ray through a screen point (view millimetres): from the eye (perspective) or the eye's plane (orthographic). */
  private ray(sx: number, sy: number): { o: V3; dir: V3 } {
    const { right, up, back } = this.basis();
    const t = Math.tan(this.fov / 2);
    const nx = ((sx / this.w) * 2 - 1) * t * (this.w / this.h), ny = (1 - (sy / this.h) * 2) * t;
    const e = this.eye();
    if (this.ortho) {
      // Started well behind the eye's plane: everything in view lies ahead of it
      const o = add(add(e, add(scale(right, nx * this.dist), scale(up, ny * this.dist))), scale(back, this.size() * 4));
      return { o, dir: scale(back, -1) };
    }
    const dir: V3 = add(add(scale(right, nx), scale(up, ny)), scale(back, -1));
    return { o: e, dir: scale(dir, 1 / Math.hypot(...dir)) };
  }
  private size(): number { const r = this.model?.rect; return r ? Math.max(r.maxX - r.minX, r.maxY - r.minY) / 393700.787 : 100; }

  /** Fit the board (and what stands on it) in the view, keeping the angle. */
  fit(): void {
    const m = this.model;
    if (!m) { this.requestRender(); return; }
    const hw = (m.rect.maxX - m.rect.minX) / 2 / 393700.787, hh = (m.rect.maxY - m.rect.minY) / 2 / 393700.787;
    const pts: V3[] = [];
    for (const z of [0, m.thickness]) for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const) pts.push([x, y, z]);
    for (const b of m.bodies) {
      const xs = b.outline.map((v) => v.x), ys = b.outline.map((v) => v.y);
      for (const z of [b.z0, b.z1]) for (const x of [Math.min(...xs), Math.max(...xs)]) for (const y of [Math.min(...ys), Math.max(...ys)]) pts.push([x, y, z]);
    }
    // Centre on the box around everything, then back off until every corner is in view
    const lo = [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i]!))), hi = [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i]!)));
    this.target = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2];
    const { right, up, back } = this.basis();
    const ty = Math.tan(this.fov / 2) / 1.08, tx = ty * (this.w / this.h);
    let d = 1;
    for (const p of pts) {
      const r = sub(p, this.target);
      const z = dot(r, back);
      d = Math.max(d, z + Math.abs(dot(r, right)) / tx, z + Math.abs(dot(r, up)) / ty);
    }
    this.dist = d;
    this.requestRender();
  }
  /** 0: straight down, no turn; 9: straight down, turned 90°; 8: from an angle. */
  view(kind: 'top' | 'top90' | 'angle' | 'bottom'): void {
    if (kind === 'top') { this.yaw = 0; this.pitch = 0; }
    else if (kind === 'top90') { this.yaw = -Math.PI / 2; this.pitch = 0; }
    else if (kind === 'angle') { this.yaw = -Math.PI / 6; this.pitch = (52 * Math.PI) / 180; }
    else { this.yaw = Math.PI; this.pitch = Math.PI; }
    this.fit();
  }
  /** View › Flip Board in 3D: look from the other side. */
  flip(): void { this.yaw += Math.PI; this.pitch = Math.PI - this.pitch; this.requestRender(); }
  get fromBelow(): boolean { return Math.cos(this.pitch) < 0; }

  /* ── drawing ── */
  requestRender(): void {
    if (this.frame || this.disposed) return;
    this.frame = this.win.requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  render(): void {
    const gl = this.gl;
    if (!gl || !this.prog) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const v = settings.pcb3d;
    const [hi, lo] = workspaceEnds(v);
    gl.clearColor(lo[0] / 255, lo[1] / 255, lo[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (this.bgProg && v.gradient) {
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.bgProg);
      gl.uniform3f(this.loc.uTop!, hi[0] / 255, hi[1] / 255, hi[2] / 255);
      gl.uniform3f(this.loc.uBottom!, lo[0] / 255, lo[1] / 255, lo[2] / 255);
      gl.bindVertexArray(this.bgVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.uMvp!, false, this.mvp());
    // Lighting looks along the view: from far back along it when there is no perspective
    gl.uniform3fv(this.loc.uEye!, this.ortho ? add(this.eye(), scale(this.basis().back, this.size() * 50)) : this.eye());
    gl.uniform1i(this.loc.uSampler!, 0);
    // Solid things first, then the see-through ones far side first (the board's faces: the one away from the eye)
    const all = [...this.meshes, ...this.bodyMeshes];
    const below = this.fromBelow;
    // (a layer shown alone inside the board lies between the two faces)
    const far = (m: GpuMesh) => (m.texture === 'single' ? 1 : (m.texture === 'top') === below ? 2 : 0);
    const order = [
      ...all.filter((m) => m.colour[3] >= 1),
      ...all.filter((m) => m.colour[3] < 1 && m.texture).sort((a, b) => far(b) - far(a)),
      ...all.filter((m) => m.colour[3] < 1 && !m.texture),
    ];
    for (const m of order) {
      const see = m.colour[3] < 1;
      if (see) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); }
      gl.uniform1f(this.loc.uSee!, see ? 1 : 0);
      gl.uniform4fv(this.loc.uColour!, m.colour);
      gl.uniform1i(this.loc.uTex!, m.texture ? 1 : 0);
      if (m.texture) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.textures.get(m.texture)!); }
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
      if (see) { gl.disable(gl.BLEND); gl.depthMask(true); }
    }
    gl.bindVertexArray(null);
  }

  private resize(): void {
    const r = this.host.getBoundingClientRect();
    this.dpr = this.win.devicePixelRatio || 1;
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
    this.requestRender();
  }

  /* ── input ── */
  /** Where a screen point's ray meets the board's top surface plane (for zooming at the cursor). */
  private onBoard(sx: number, sy: number): V3 {
    const { o: e, dir } = this.ray(sx, sy);
    const z = this.target[2];
    if (Math.abs(dir[2]) < 1e-6) return this.target;
    const k = (z - e[2]) / dir[2];
    return k > 0 ? add(e, scale(dir, k)) : this.target;
  }

  private pan(dx: number, dy: number): void {
    const { right, up } = this.basis();
    const perPx = (2 * this.dist * Math.tan(this.fov / 2)) / this.h;
    this.target = add(this.target, add(scale(right, -dx * perPx), scale(up, dy * perPx)));
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const p = this.onBoard(sx, sy);
    const k = 1 - 1 / factor;
    this.target = add(this.target, scale(sub(p, this.target), k));
    this.dist = Math.max(0.5, Math.min(this.dist / factor, this.size() * 20));
  }

  private bind(): void {
    const h = this.host;
    const stop = (e: Event) => e.stopPropagation();
    h.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
    h.addEventListener('dblclick', stop);
    h.addEventListener('wheel', (e) => {
      e.preventDefault(); e.stopPropagation();
      const r = h.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.h : 1;
      const act = wheelAction(e);
      if (act === 'none') return;
      if (act === 'zoom') this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(settings.zoomStep, (-(e.deltaY || e.deltaX) * unit) / 100));
      else if (act === 'hscroll') this.pan(-(e.deltaY || e.deltaX) * unit, 0);
      else this.pan(-e.deltaX * unit, -e.deltaY * unit);
      this.onNavigate?.();
      this.requestRender();
    }, { passive: false });
    h.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      (h.closest('.viewport') as HTMLElement | null)?.focus({ preventScroll: true });
      if (this.picker && e.button === 0 && !e.shiftKey) {
        const r = h.getBoundingClientRect();
        this.picker.fn(this.pick(e.clientX - r.left, e.clientY - r.top));
        this.requestRender();
        return;
      }
      this.downAt = { x: e.clientX, y: e.clientY };
      h.setPointerCapture(e.pointerId);
      // Altium: Shift + right-drag rotates; right-drag (or middle) pans
      this.drag = { button: e.button, x: e.clientX, y: e.clientY, rotate: e.button === 2 && e.shiftKey || (e.button === 0 && e.shiftKey) };
    });
    h.addEventListener('pointermove', (e) => {
      e.stopPropagation();
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      if (d.rotate) {
        this.yaw -= dx * 0.008;
        // Vertical drag tilts the board the way Altium does
        this.pitch -= dy * 0.008;
      } else if (d.button === 2 || d.button === 1) this.pan(dx, dy);
      else return;
      this.onNavigate?.();
      this.requestRender();
    });
    h.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      const moved = this.downAt ? Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) : 99;
      if (this.picker && e.button === 2 && moved < 4) this.setPicker(null);
      this.drag = null; this.downAt = null;
    });
  }

  /** For screenshots and tests. */
  get canvasElement(): HTMLCanvasElement { return this.canvas; }

  /* ── picking (Tools › 3D Body Placement) ── */
  get boardModel(): BoardModel | null { return this.model; }
  /** The STEP model a body shows, once read. */
  stepModel(b: Body3D): StepModel | null { return b.step ? this.stepModels.get(b.step.modelId) ?? null : null; }
  /** A point of the view (mm) in a STEP body's own axes. */
  toModel(b: Body3D, p: V3): V3 | null {
    const m = this.stepModel(b), model = this.model;
    if (!b.step || !m || !model) return null;
    return apply(invert(bodyTransform(b.step, m, model.centre, model.thickness)), p);
  }
  /** A direction of the view in a STEP body's own axes. */
  toModelDir(b: Body3D, d: V3): V3 | null {
    const o = this.toModel(b, [0, 0, 0]), q = this.toModel(b, d);
    return o && q ? [q[0] - o[0], q[1] - o[1], q[2] - o[2]] : null;
  }
  /** Where a view point (mm) falls on the screen (CSS pixels in the view). */
  project(p: V3): { x: number; y: number } {
    const { right, up, back } = this.basis();
    const r = sub(p, this.eye());
    const z = this.ortho ? this.dist : -dot(r, back), t = Math.tan(this.fov / 2);
    return { x: ((dot(r, right) / (z * t * (this.w / this.h))) + 1) / 2 * this.w, y: (1 - dot(r, up) / (z * t)) / 2 * this.h };
  }
  /** What the ray through a screen point meets first. */
  pick(sx: number, sy: number): Hit3D | null {
    const model = this.model;
    if (!model) return null;
    const { o: e, dir } = this.ray(sx, sy);
    let best: { t: number; tri: [V3, V3, V3]; body?: Body3D; pk: Pickable } | null = null;
    const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    for (const pk of [...this.pickBoard, ...this.pickBodies]) {
      const P = pk.pos, I = pk.idx;
      for (let i = 0; i + 2 < I.length; i += 3) {
        const v = (k: number): V3 => [P[I[i + k]! * 3]!, P[I[i + k]! * 3 + 1]!, P[I[i + k]! * 3 + 2]!];
        const a = v(0), b = v(1), c = v(2);
        const e1 = sub(b, a), e2 = sub(c, a), h = cross(dir, e2), det = dot(e1, h);
        if (Math.abs(det) < 1e-12) continue;
        const f = 1 / det, s0 = sub(e, a), u = f * dot(s0, h);
        if (u < 0 || u > 1) continue;
        const q = cross(s0, e1), w = f * dot(dir, q);
        if (w < 0 || u + w > 1) continue;
        const tt = f * dot(e2, q);
        if (tt > 1e-6 && (!best || tt < best.t)) best = { t: tt, tri: [a, b, c], body: pk.body, pk };
      }
    }
    if (!best) return null;
    const p = add(e, scale(dir, best.t));
    const [a, b, c] = best.tri;
    let n = cross(sub(b, a), sub(c, a));
    const l = Math.hypot(...n) || 1;
    n = scale(n, 1 / l);
    if (dot(n, dir) > 0) n = scale(n, -1);
    const vertex = [a, b, c].reduce((m, q) => (Math.hypot(...sub(q, p)) < Math.hypot(...sub(m, p)) ? q : m));
    const pk = best.pk, nn = n, d0 = dot(nn, a);
    const coplanar = () => {
      const out: [V3, V3, V3][] = [];
      const P = pk.pos, I = pk.idx;
      for (let i = 0; i + 2 < I.length; i += 3) {
        const v = (k: number): V3 => [P[I[i + k]! * 3]!, P[I[i + k]! * 3 + 1]!, P[I[i + k]! * 3 + 2]!];
        const t3: [V3, V3, V3] = [v(0), v(1), v(2)];
        if (t3.every((q) => Math.abs(dot(nn, q) - d0) < 1e-3)) out.push(t3);
      }
      return out;
    };
    return { p, n, tri: best.tri, vertex, body: best.body, coplanar, board: { x: p[0] * UNITS_PER_MM + model.centre.x, y: p[1] * UNITS_PER_MM + model.centre.y }, z: p[2] };
  }
  /** Clicks in the view go to `fn` (null ends it); right-click without dragging ends it too. */
  setPicker(hint: string | null, fn?: (h: Hit3D | null) => void): void {
    this.picker = hint && fn ? { hint, fn } : null;
    this.host.style.cursor = this.picker ? 'crosshair' : '';
    this.onNavigate?.();
  }
  get pickHint(): string | null { return this.picker?.hint ?? null; }

  /** Resolves once every STEP model the bodies show has been read and put in place. */
  async ready(): Promise<void> {
    while (this.loading.size) await Promise.all([...this.loading]);
    if (this.stepTimer) { clearTimeout(this.stepTimer); this.stepTimer = 0; }
    this.uploadBodies();
  }
  /** Size the canvas to its host now (the resize observer does it later). */
  layout(): void { this.resize(); }
  /** One view drawn now, as a PNG data URL (PCB 3D Print). */
  snapshot(kind?: 'top' | 'top90' | 'angle' | 'bottom'): string {
    if (kind) this.view(kind);
    if (this.frame) { this.win.cancelAnimationFrame(this.frame); this.frame = 0; }
    this.render();
    return this.canvas.toDataURL('image/png');
  }
}
