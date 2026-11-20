/**
 * The 3D model editor's view: a STEP document's parts lit as 3D Layout Mode lights a board (its
 * shaders, workspace colours and projection), the origin's axes (X red, Y green, Z blue) and
 * whatever the editor marks (a measurement). Drag turns the model, right-drag (or middle) pans,
 * the wheel zooms at the cursor (as Preferences say); a click picks the part under it.
 * Millimetres, Z up. Parts that are made (an enclosure) can be lit in studio shading instead, each
 * with its material, and drawn as a picture at any size: supersampled, on a background, with a soft
 * shadow on the floor under them.
 */
import { settings, wheelAction } from '../../core/settings';
import { hexRgb, workspaceEnds } from '../../core/view3d';
import type { Mesh, RGBA } from './boardModel';
import { BG_FS, BG_VS, FS, VS, bar, ident, marker, mul, ortho, perspective } from './Viewer3D';
import { BLUR_FS, DEFAULT_LIGHTING, FULL_VS, GROUND_FS, GROUND_VS, SATIN, SHADOW_FS, SHADOW_VS, STUDIO_FS, STUDIO_VS, envGradient, lightUniforms, type Lighting, type Material, type PictureBackground } from './studio';

type M4 = Float32Array;
export type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A mesh of a part (its id), and how its surface takes the light in studio shading. */
export interface PartMesh extends Mesh { key: string; material?: Material }
export interface ModelHit { p: V3; n: V3; vertex: V3; key: string }
interface GpuMesh { vao: WebGLVertexArrayObject; count: number; colour: RGBA; key: string; bufs: WebGLBuffer[]; material: Material; pos: Float32Array }
/** A picture of the parts: its size (pixels), background (of the lighting's room), whether they cast a shadow, from which side (else as the view sees them), and parts left out. */
export interface PictureOptions { width: number; height: number; background: PictureBackground; shadow: boolean; view?: ModelViewKind | null; hide?: string[] }
export type ModelViewKind = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

/** Where every program takes a mesh's corners, normals and texture coordinates. */
const ATTR: Record<string, number> = { aPos: 0, aNrm: 1, aUv: 2 };
type Made = { fbs: WebGLFramebuffer[]; rbs: WebGLRenderbuffer[]; tex: WebGLTexture[]; bufs: WebGLBuffer[]; vaos: WebGLVertexArrayObject[] };
type PicPrograms = { shadow: WebGLProgram; blur: WebGLProgram; ground: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> };

export class ModelView {
  readonly host: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null;
  private prog: WebGLProgram | null = null;
  private studio: WebGLProgram | null = null;
  private link: ((v: string, f: string) => WebGLProgram) | null = null;
  private picP: PicPrograms | null = null;
  /** Studio shading's light and room. */
  private lighting: Lighting = DEFAULT_LIGHTING;
  private bgProg: WebGLProgram | null = null;
  private bgVao: WebGLVertexArrayObject | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private meshes: GpuMesh[] = [];
  private extras: GpuMesh[] = [];
  private pickables: { pos: Float32Array; idx: Uint32Array; key: string }[] = [];
  private lo: V3 = [-5, -5, -5];
  private hi: V3 = [5, 5, 5];
  private frame = 0;
  private ro: ResizeObserver;
  private w = 1; private h = 1;
  private drag: { button: number; x: number; y: number; rotate: boolean; moved: number } | null = null;
  private disposed = false;
  target: V3 = [0, 0, 0];
  dist = 50;
  yaw = -Math.PI / 6;
  pitch = (55 * Math.PI) / 180;
  private fov = (30 * Math.PI) / 180;
  /** Parts drawn as selected. */
  selected = new Set<string>();
  readonly failed: boolean;

  constructor(parent: HTMLElement, private on: { click?: (hit: ModelHit | null, e: PointerEvent) => void; navigate?: () => void } = {}, private opts: { axes?: boolean; pickable?: (key: string) => boolean; studio?: boolean } = {}) {
    this.host = document.createElement('div');
    this.host.className = 'modelview';
    this.canvas = document.createElement('canvas');
    // Drawn at the screen's pixels but laid out at the view's size (else, with display scaling, it overflows and clicks miss)
    this.canvas.style.cssText = 'display:block;width:100%;height:100%';
    this.host.append(this.canvas);
    parent.append(this.host);
    this.gl = this.canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.failed = !this.gl;
    if (this.gl) this.initGl(this.gl);
    else this.host.append(Object.assign(document.createElement('p'), { className: 'viewer3d-error', textContent: 'The 3D view needs WebGL 2, which this browser has turned off.' }));
    this.ro = new ((this.host.ownerDocument.defaultView ?? window) as typeof window).ResizeObserver(() => this.resize());
    this.ro.observe(this.host);
    this.bind();
    this.resize();
  }

  dispose(): void {
    this.disposed = true;
    try { ((this.host.ownerDocument.defaultView ?? window) as typeof window).cancelAnimationFrame(this.frame); } catch { /* its window closed */ }
    this.ro.disconnect();
    this.free(this.meshes); this.free(this.extras);
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.host.remove();
  }

  /** The parts' meshes (placed, mm) and the extent they fill. */
  setMeshes(meshes: PartMesh[], bounds: { min: V3; max: V3 } | null): void {
    if (!this.gl) return;
    this.free(this.meshes);
    this.meshes = [];
    for (const m of meshes) this.upload(m, this.meshes, m.key, m.material);
    this.pickables = meshes.map((m) => ({ pos: m.pos, idx: m.idx, key: m.key }));
    if (bounds) { this.lo = bounds.min; this.hi = bounds.max; }
    this.setAxes();
    this.requestRender();
  }
  /** Marks drawn over the model (a measurement): meshes in mm. */
  private marks: Mesh[] = [];
  setMarks(marks: Mesh[]): void { this.marks = marks; this.setAxes(); this.requestRender(); }
  /** The origin's axes, sized to the model, and the marks. */
  private setAxes(): void {
    if (!this.gl) return;
    this.free(this.extras);
    this.extras = [];
    const s = this.size(), len = s * 0.6, r = Math.max(0.01, s / 600);
    const o: V3 = [0, 0, 0];
    const axes = this.opts.axes === false ? [] : [bar(o, [len, 0, 0], r, [0.9, 0.2, 0.2, 1]), bar(o, [0, len, 0], r, [0.2, 0.8, 0.25, 1]), bar(o, [0, 0, len], r, [0.25, 0.45, 1, 1]), marker(o, Math.max(0.03, s / 120), [1, 1, 1, 1])];
    for (const m of [...axes, ...this.marks]) this.upload(m, this.extras, '');
  }
  /** The model's size (mm): the longest side of its extent. */
  size(): number { return Math.max(1e-3, this.hi[0] - this.lo[0], this.hi[1] - this.lo[1], this.hi[2] - this.lo[2]); }

  private free(list: GpuMesh[]): void {
    const gl = this.gl;
    if (!gl) return;
    for (const m of list) { gl.deleteVertexArray(m.vao); for (const b of m.bufs) gl.deleteBuffer(b); }
  }
  private upload(m: Mesh, into: GpuMesh[], key: string, material: Material = SATIN): void {
    const gl = this.gl!;
    if (!m.idx.length) return;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const bufs: WebGLBuffer[] = [];
    // Every program takes its corners and normals at the same places (bound before linking)
    const attr = (name: string, data: Float32Array, size: number) => {
      const loc = ATTR[name];
      if (loc === undefined) return;
      const b = gl.createBuffer()!;
      bufs.push(b);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    attr('aPos', m.pos, 3);
    attr('aNrm', m.nrm, 3);
    const ib = gl.createBuffer()!;
    bufs.push(ib);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    into.push({ vao, count: m.idx.length, colour: m.colour, key, bufs, material, pos: m.pos });
  }
  private initGl(gl: WebGL2RenderingContext): void {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const link = (v: string, f: string) => { const p = gl.createProgram()!; gl.attachShader(p, sh(gl.VERTEX_SHADER, v)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, f)); for (const [n, l] of Object.entries(ATTR)) gl.bindAttribLocation(p, l, n); gl.linkProgram(p); return p; };
    this.link = link;
    this.prog = link(VS, FS);
    this.studio = link(STUDIO_VS, STUDIO_FS);
    for (const u of ['uMvp', 'uColour', 'uEye', 'uMat', 'uKey', 'uFill', 'uRim', 'uKeyI', 'uAmb', 'uEnvTop', 'uEnvBottom', 'uHue']) this.loc[`s${u}`] = gl.getUniformLocation(this.studio, u);
    for (const u of ['uMvp', 'uColour', 'uTex', 'uSampler', 'uEye', 'uSee']) this.loc[u] = gl.getUniformLocation(this.prog, u);
    const b = link(BG_VS, BG_FS);
    if (gl.getProgramParameter(b, gl.LINK_STATUS)) { this.bgProg = b; this.bgVao = gl.createVertexArray(); this.loc.uTop = gl.getUniformLocation(b, 'uTop'); this.loc.uBottom = gl.getUniformLocation(b, 'uBottom'); }
  }

  /* ── camera ── */
  private basis(): { right: V3; up: V3; back: V3 } {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    return { right: [cy, sy, 0], up: [-sy * cp, cy * cp, sp], back: [sy * sp, -cy * sp, cp] };
  }
  private eye(): V3 { return add(this.target, scale(this.basis().back, this.dist)); }
  private get isOrtho(): boolean { return settings.pcb3d.projection === 'orthographic'; }
  private mvp(): M4 {
    const { right, up, back } = this.basis();
    const e = this.eye();
    const view = ident();
    view[0] = right[0]; view[4] = right[1]; view[8] = right[2];
    view[1] = up[0]; view[5] = up[1]; view[9] = up[2];
    view[2] = back[0]; view[6] = back[1]; view[10] = back[2];
    view[12] = -dot(right, e); view[13] = -dot(up, e); view[14] = -dot(back, e);
    const s = this.size();
    if (this.isOrtho) { const hh = this.dist * Math.tan(this.fov / 2); return mul(ortho(hh * (this.w / this.h), hh, -s * 4, this.dist + s * 4), view); }
    return mul(perspective(this.fov, this.w / this.h, Math.max(0.01, this.dist / 1000), this.dist + s * 4), view);
  }
  private ray(sx: number, sy: number): { o: V3; dir: V3 } {
    const { right, up, back } = this.basis();
    const t = Math.tan(this.fov / 2);
    const nx = ((sx / this.w) * 2 - 1) * t * (this.w / this.h), ny = (1 - (sy / this.h) * 2) * t;
    const e = this.eye();
    if (this.isOrtho) return { o: add(add(e, add(scale(right, nx * this.dist), scale(up, ny * this.dist))), scale(back, this.size() * 4)), dir: scale(back, -1) };
    const dir: V3 = add(add(scale(right, nx), scale(up, ny)), scale(back, -1));
    return { o: e, dir: scale(dir, 1 / Math.hypot(...dir)) };
  }
  /** The whole model in view, keeping the angle. */
  fit(): void {
    const pts: V3[] = [];
    for (const x of [this.lo[0], this.hi[0]]) for (const y of [this.lo[1], this.hi[1]]) for (const z of [this.lo[2], this.hi[2]]) pts.push([x, y, z]);
    pts.push([0, 0, 0]);
    const lo = [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i]!))), hi = [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i]!)));
    this.target = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2];
    const { right, up, back } = this.basis();
    const ty = Math.tan(this.fov / 2) / 1.12, tx = ty * (this.w / this.h);
    let d = 0.5;
    for (const p of pts) { const r = sub(p, this.target), z = dot(r, back); d = Math.max(d, z + Math.abs(dot(r, right)) / tx, z + Math.abs(dot(r, up)) / ty); }
    this.dist = d;
    this.requestRender();
  }
  /** Standard views (Z up): iso from the front left above, top, bottom, front (from −Y), back, left (from −X), right. */
  view(kind: ModelViewKind): void {
    const r = Math.PI / 180;
    const v: Record<ModelViewKind, [number, number]> = { iso: [-30, 55], top: [0, 0], bottom: [0, 180], front: [0, 90], back: [180, 90], left: [-90, 90], right: [90, 90] };
    [this.yaw, this.pitch] = [v[kind][0] * r, v[kind][1] * r];
    this.fit();
  }

  /* ── drawing ── */
  requestRender(): void {
    if (this.frame || this.disposed) return;
    this.frame = ((this.host.ownerDocument.defaultView ?? window) as typeof window).requestAnimationFrame(() => { this.frame = 0; this.render(); });
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
    this.drawParts([...this.meshes, ...this.extras], !!this.opts.studio, true);
  }
  private eyeAt(): V3 { return this.isOrtho ? add(this.eye(), scale(this.basis().back, this.size() * 50)) : this.eye(); }
  /** The parts drawn (opaque first, then the see-through ones), in board or studio shading, the selected tinted. */
  private drawParts(list: GpuMesh[], studio: boolean, tinted: boolean): void {
    const gl = this.gl!;
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    const L = (u: string) => this.loc[studio ? `s${u}` : u]!;
    gl.useProgram(studio ? this.studio : this.prog);
    gl.uniformMatrix4fv(L('uMvp'), false, this.mvp());
    gl.uniform3fv(L('uEye'), this.eyeAt());
    if (!studio) gl.uniform1i(this.loc.uTex!, 0);
    else {
      const u = lightUniforms(this.lighting);
      gl.uniform3fv(L('uKey'), u.key); gl.uniform3fv(L('uFill'), u.fill); gl.uniform3fv(L('uRim'), u.rim);
      gl.uniform1f(L('uKeyI'), u.strength); gl.uniform1f(L('uAmb'), u.ambient);
      gl.uniform3fv(L('uEnvTop'), u.top); gl.uniform3fv(L('uEnvBottom'), u.bottom); gl.uniform3fv(L('uHue'), u.hue);
    }
    const [sr, sg, sb] = hexRgb(settings.selectionColour);
    const tint = (m: GpuMesh): RGBA => (tinted && this.selected.has(m.key) ? [m.colour[0] * 0.45 + (sr / 255) * 0.55, m.colour[1] * 0.45 + (sg / 255) * 0.55, m.colour[2] * 0.45 + (sb / 255) * 0.55, m.colour[3]] : m.colour);
    for (const m of [...list.filter((x) => x.colour[3] >= 1), ...list.filter((x) => x.colour[3] < 1)]) {
      const see = m.colour[3] < 1;
      // See-through over see-through (a picture's clear background): the alpha kept as covered
      if (see) { gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); }
      if (studio) gl.uniform4f(L('uMat'), m.material.spec, m.material.shine, m.material.metal, m.material.fuzz);
      else gl.uniform1f(this.loc.uSee!, see ? 1 : 0);
      gl.uniform4fv(L('uColour'), tint(m));
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
      if (see) { gl.disable(gl.BLEND); gl.depthMask(true); }
    }
    gl.bindVertexArray(null);
  }
  private resize(): void {
    const r = this.host.getBoundingClientRect(), dpr = (this.host.ownerDocument.defaultView ?? window).devicePixelRatio || 1;
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr); this.canvas.height = Math.round(this.h * dpr);
    this.requestRender();
  }

  /* ── input ── */
  private pan(dx: number, dy: number): void {
    const { right, up } = this.basis();
    const perPx = (2 * this.dist * Math.tan(this.fov / 2)) / this.h;
    this.target = add(this.target, add(scale(right, -dx * perPx), scale(up, dy * perPx)));
  }
  private zoomAt(sx: number, sy: number, factor: number): void {
    // Towards what's under the cursor (the model, else the target's depth)
    const hit = this.pick(sx, sy);
    const { o, dir } = this.ray(sx, sy);
    const p = hit?.p ?? add(o, scale(dir, Math.max(0, dot(sub(this.target, o), dir))));
    this.target = add(this.target, scale(sub(p, this.target), 1 - 1 / factor));
    this.dist = Math.max(this.size() / 2000, Math.min(this.dist / factor, this.size() * 40));
  }
  private bind(): void {
    const h = this.host;
    h.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
    h.addEventListener('wheel', (e) => {
      e.preventDefault(); e.stopPropagation();
      const r = h.getBoundingClientRect(), unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.h : 1;
      // A model view zooms with the wheel unless the grid gives the wheel (with its modifier) to scrolling across
      const act = wheelAction(e);
      if (act === 'none') return;
      if (act !== 'hscroll') this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(settings.zoomStep, (-e.deltaY * unit) / 100));
      else this.pan(-(e.deltaY || e.deltaX) * unit, 0);
      this.on.navigate?.(); this.requestRender();
    }, { passive: false });
    h.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      // Drag turns (left, or Shift + right as 3D Layout Mode); right or middle pans
      this.drag = { button: e.button, x: e.clientX, y: e.clientY, rotate: e.button === 0 || (e.button === 2 && e.shiftKey), moved: 0 };
    });
    h.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY; d.moved += Math.abs(dx) + Math.abs(dy);
      if (d.moved < 4) return;
      if (d.rotate) { this.yaw -= dx * 0.008; this.pitch -= dy * 0.008; } else this.pan(dx, dy);
      this.on.navigate?.(); this.requestRender();
    });
    h.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (d && d.button === 0 && d.moved < 4) { const r = h.getBoundingClientRect(); this.on.click?.(this.pick(e.clientX - r.left, e.clientY - r.top), e); }
    });
  }

  /** What the ray through a screen point meets first: the point, the face's normal, its nearest corner, the part. */
  pick(sx: number, sy: number): ModelHit | null {
    const { o: e, dir } = this.ray(sx, sy);
    let best: { t: number; tri: [V3, V3, V3]; key: string } | null = null;
    for (const pk of this.pickables) {
      if (this.opts.pickable && !this.opts.pickable(pk.key)) continue;
      const P = pk.pos, I = pk.idx;
      for (let i = 0; i + 2 < I.length; i += 3) {
        const v = (k: number): V3 => [P[I[i + k]! * 3]!, P[I[i + k]! * 3 + 1]!, P[I[i + k]! * 3 + 2]!];
        const a = v(0), b = v(1), c = v(2);
        const e1 = sub(b, a), e2 = sub(c, a), hh = cross(dir, e2), det = dot(e1, hh);
        if (Math.abs(det) < 1e-14) continue;
        const f = 1 / det, s0 = sub(e, a), u = f * dot(s0, hh);
        if (u < 0 || u > 1) continue;
        const q = cross(s0, e1), w = f * dot(dir, q);
        if (w < 0 || u + w > 1) continue;
        const t = f * dot(e2, q);
        if (t > 1e-9 && (!best || t < best.t)) best = { t, tri: [a, b, c], key: pk.key };
      }
    }
    if (!best) return null;
    const p = add(e, scale(dir, best.t));
    const [a, b, c] = best.tri;
    let n = cross(sub(b, a), sub(c, a));
    n = scale(n, 1 / (Math.hypot(...n) || 1));
    if (dot(n, dir) > 0) n = scale(n, -1);
    const vertex = [a, b, c].reduce((m, q) => (Math.hypot(...sub(q, p)) < Math.hypot(...sub(m, p)) ? q : m));
    return { p, n, vertex, key: best.key };
  }
  /** Where a point (mm) falls on the screen (CSS pixels in the view). */
  project(p: V3): { x: number; y: number } {
    const { right, up, back } = this.basis();
    const r = sub(p, this.eye());
    const z = this.isOrtho ? this.dist : -dot(r, back), t = Math.tan(this.fov / 2);
    return { x: ((dot(r, right) / (z * t * (this.w / this.h))) + 1) / 2 * this.w, y: (1 - dot(r, up) / (z * t)) / 2 * this.h };
  }
  /** Studio shading's light and room (drawn again). */
  setLighting(l: Lighting): void { this.lighting = l; this.requestRender(); }
  /** The programs a picture needs besides the parts' (made the first time). */
  private picPrograms(): PicPrograms {
    if (this.picP) return this.picP;
    const gl = this.gl!, link = this.link!;
    const shadow = link(SHADOW_VS, SHADOW_FS), blur = link(FULL_VS, BLUR_FS), ground = link(GROUND_VS, GROUND_FS);
    const u = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);
    this.picP = { shadow, blur, ground, loc: { shadowMvp: u(shadow, 'uMvp'), uZ0: u(shadow, 'uZ0'), uH: u(shadow, 'uH'), uSrc: u(blur, 'uSrc'), uStep: u(blur, 'uStep'), groundMvp: u(ground, 'uMvp'), uBox: u(ground, 'uBox'), uShadow: u(ground, 'uShadow'), uStrength: u(ground, 'uStrength') } };
    return this.picP;
  }
  /** The parts seen from straight above, each point as dark as it is near the floor, blurred: the shadow they cast, over a box round them. */
  private shadowTexture(list: GpuMesh[], lo: V3, hi: V3, made: Made): { tex: WebGLTexture; box: [number, number, number, number]; z0: number } {
    const gl = this.gl!, P = this.picPrograms(), S = 512;
    const span = Math.max(1, hi[0] - lo[0], hi[1] - lo[1]), m = span * 0.35 + 2;
    const box: [number, number, number, number] = [lo[0] - m, lo[1] - m, hi[0] + m, hi[1] + m];
    const target = (): [WebGLTexture, WebGLFramebuffer] => {
      const t = gl.createTexture()!; made.tex.push(t);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) gl.texParameteri(gl.TEXTURE_2D, k, v);
      const f = gl.createFramebuffer()!; made.fbs.push(f);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return [t, f];
    };
    const [a, fa] = target(), [b, fb] = target();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fa);
    gl.viewport(0, 0, S, S);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(P.shadow);
    // Plan view over the box (every height at once)
    const mvp = new Float32Array(16);
    mvp[0] = 2 / (box[2] - box[0]); mvp[12] = -(box[2] + box[0]) / (box[2] - box[0]);
    mvp[5] = 2 / (box[3] - box[1]); mvp[13] = -(box[3] + box[1]) / (box[3] - box[1]);
    mvp[15] = 1;
    gl.uniformMatrix4fv(P.loc.shadowMvp!, false, mvp);
    gl.uniform1f(P.loc.uZ0!, lo[2]); gl.uniform1f(P.loc.uH!, Math.max(1, hi[2] - lo[2]));
    for (const q of list) { if (q.colour[3] < 0.2) continue; gl.bindVertexArray(q.vao); gl.drawElements(gl.TRIANGLES, q.count, gl.UNSIGNED_INT, 0); }
    gl.blendEquation(gl.FUNC_ADD); gl.disable(gl.BLEND);
    // Blurred across and up, twice: soft, a little wider than the parts
    gl.useProgram(P.blur);
    const vao = gl.createVertexArray()!; made.vaos.push(vao); gl.bindVertexArray(vao);
    const step = (span * 0.11) / 12;
    const pass = (src: WebGLTexture, dst: WebGLFramebuffer, dx: number, dy: number) => { gl.bindFramebuffer(gl.FRAMEBUFFER, dst); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src); gl.uniform1i(P.loc.uSrc!, 0); gl.uniform2f(P.loc.uStep!, dx, dy); gl.drawArrays(gl.TRIANGLES, 0, 3); };
    for (let k = 0; k < 2; k++) { pass(a, fb, step / (box[2] - box[0]), 0); pass(b, fa, 0, step / (box[3] - box[1])); }
    gl.bindVertexArray(null);
    return { tex: a, box, z0: lo[2] };
  }
  /** The floor under the parts with their shadow on it (just under their lowest point). */
  private drawGround(sh: { tex: WebGLTexture; box: [number, number, number, number]; z0: number }, made: Made): void {
    const gl = this.gl!, P = this.picPrograms();
    const [x0, y0, x1, y1] = sh.box, z = sh.z0 - Math.max(0.02, this.size() * 1e-4);
    const vao = gl.createVertexArray()!; made.vaos.push(vao); gl.bindVertexArray(vao);
    const b = gl.createBuffer()!; made.bufs.push(b);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(ATTR.aPos!); gl.vertexAttribPointer(ATTR.aPos!, 3, gl.FLOAT, false, 0, 0);
    gl.useProgram(P.ground);
    gl.uniformMatrix4fv(P.loc.groundMvp!, false, this.mvp());
    gl.uniform4f(P.loc.uBox!, x0, y0, x1, y1);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sh.tex); gl.uniform1i(P.loc.uShadow!, 0);
    gl.uniform1f(P.loc.uStrength!, 0.6);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(false);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND); gl.depthMask(true);
    gl.bindVertexArray(null);
  }
  /**
   * A picture of the parts (a PNG) at a size in pixels: studio shading, supersampled twice over up
   * to about 2560 × 1600 (above that, multisampled only), on a background (see-through keeps the
   * alpha), with the soft shadow they cast on the floor under them; from a side, fitted to the
   * picture, or from where the view looks.
   */
  async picture(o: PictureOptions): Promise<Blob> {
    const gl = this.gl;
    if (!gl || !this.studio || !this.link) throw new Error('The 3D view needs WebGL 2');
    const W = Math.max(16, Math.round(o.width)), H = Math.max(16, Math.round(o.height));
    const maxRb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
    if (Math.max(W, H) > maxRb) throw new Error(`This graphics card draws pictures up to ${maxRb} pixels across`);
    if (W * H > 40e6) throw new Error('A picture is up to 40 megapixels');
    const ss = W * H <= 4.2e6 && 2 * Math.max(W, H) <= maxRb ? 2 : 1;
    const RW = W * ss, RH = H * ss;
    const hide = new Set(o.hide ?? []);
    const list = this.meshes.filter((m) => !hide.has(m.key));
    const was = { yaw: this.yaw, pitch: this.pitch, target: this.target, dist: this.dist, w: this.w, h: this.h };
    const made: Made = { fbs: [], rbs: [], tex: [], bufs: [], vaos: [] };
    const c = document.createElement('canvas');
    try {
      // The picture's camera: its shape, from the side asked (or the view's), the parts fitted with room round them
      this.w = W; this.h = H;
      if (o.view) this.view(o.view); else this.fit();
      this.dist *= 1.1;
      const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
      for (const m of list) for (let i = 0; i < m.pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = m.pos[i + k]!; if (v < lo[k]!) lo[k] = v; if (v > hi[k]!) hi[k] = v; }
      // No floor seen from under it
      const shadow = o.shadow && list.length > 0 && this.basis().back[2] > 0.02 ? this.shadowTexture(list, lo, hi, made) : null;
      const rb = (fmt: number) => { const r = gl.createRenderbuffer()!; made.rbs.push(r); gl.bindRenderbuffer(gl.RENDERBUFFER, r); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt, RW, RH); return r; };
      const ms = gl.createFramebuffer()!; made.fbs.push(ms);
      gl.bindFramebuffer(gl.FRAMEBUFFER, ms);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb(gl.RGBA8));
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb(gl.DEPTH_COMPONENT24));
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The picture could not be drawn at that size');
      gl.viewport(0, 0, RW, RH);
      const bg = o.background === 'none' ? null : envGradient(this.lighting.env, o.background === 'flat');
      gl.clearColor(bg ? bg[1][0] : 0, bg ? bg[1][1] : 0, bg ? bg[1][2] : 0, bg ? 1 : 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (bg && this.bgProg) {
        gl.disable(gl.DEPTH_TEST);
        gl.useProgram(this.bgProg);
        gl.uniform3f(this.loc.uTop!, ...bg[0]); gl.uniform3f(this.loc.uBottom!, ...bg[1]);
        gl.bindVertexArray(this.bgVao); gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      if (shadow) this.drawGround(shadow, made);
      this.drawParts(list, true, false);
      // Resolved into a plain target and read back
      const out = gl.createFramebuffer()!; made.fbs.push(out);
      const orb = gl.createRenderbuffer()!; made.rbs.push(orb);
      gl.bindRenderbuffer(gl.RENDERBUFFER, orb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, RW, RH);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, out); gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, orb);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, ms);
      gl.blitFramebuffer(0, 0, RW, RH, 0, 0, RW, RH, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, out);
      const px = new Uint8Array(RW * RH * 4);
      gl.readPixels(0, 0, RW, RH, gl.RGBA, gl.UNSIGNED_BYTE, px);
      // The right way up, averaged down from the supersampled size; see-through: the colours as they are, not darkened by their alpha
      const img = new ImageData(W, H), d = img.data, n = ss * ss;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let r = 0, g = 0, bl = 0, al = 0;
        for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) { const q = ((RH - 1 - (y * ss + j)) * RW + x * ss + i) * 4; r += px[q]!; g += px[q + 1]!; bl += px[q + 2]!; al += px[q + 3]!; }
        const t = (y * W + x) * 4;
        if (bg) { d[t] = r / n; d[t + 1] = g / n; d[t + 2] = bl / n; d[t + 3] = 255; }
        else { const f = al > 0 ? 255 / al : 0; d[t] = Math.min(255, r * f); d[t + 1] = Math.min(255, g * f); d[t + 2] = Math.min(255, bl * f); d[t + 3] = al / n; }
      }
      c.width = W; c.height = H;
      c.getContext('2d')!.putImageData(img, 0, 0);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      for (const f of made.fbs) gl.deleteFramebuffer(f);
      for (const r of made.rbs) gl.deleteRenderbuffer(r);
      for (const t of made.tex) gl.deleteTexture(t);
      for (const b of made.bufs) gl.deleteBuffer(b);
      for (const v of made.vaos) gl.deleteVertexArray(v);
      this.yaw = was.yaw; this.pitch = was.pitch; this.target = was.target; this.dist = was.dist; this.w = was.w; this.h = was.h;
      this.requestRender();
    }
    return new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('The picture could not be made'))), 'image/png'));
  }
  /** A view drawn now, as a PNG data URL. */
  snapshot(): string { ((this.host.ownerDocument.defaultView ?? window) as typeof window).cancelAnimationFrame(this.frame); this.frame = 0; this.render(); return this.canvas.toDataURL('image/png'); }
}
