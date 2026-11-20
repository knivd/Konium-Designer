import { GRID_FS, GRID_VS, PRIM_FS, PRIM_VS, TRI_FS, TRI_VS } from './shaders';
import { INSTANCE_FLOATS, type DrawGroup, type Scene } from '../Scene';
import type { Camera } from '../Camera';

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

interface GpuGroup { primVao: WebGLVertexArrayObject; primBuf: WebGLBuffer; primVer: number; triVao: WebGLVertexArrayObject; triBuf: WebGLBuffer; triCol: WebGLBuffer; triVer: number }

export interface GridSpec { size: number; dots: boolean; color: [number, number, number, number]; major: [number, number, number, number] }

export interface Tint { rgb: number; amount: number }

const hex4 = (rgb: number, a = 1): [number, number, number, number] => [((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255, a];
export { hex4 };

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private prim: WebGLProgram;
  private tri: WebGLProgram;
  private grid: WebGLProgram;
  private emptyVao: WebGLVertexArrayObject;
  private gpu = new WeakMap<DrawGroup, GpuGroup>();
  /** A scene's GPU buffers go with it (every edit makes new draw groups). */
  private freed = new FinalizationRegistry<GpuGroup>((r) => this.free(r));
  private u = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  /** Smoothed edges: the shader's own over a pixel, and multisampling for the plain triangles (polygon fills); off: hard edges throughout. */
  constructor(canvas: HTMLCanvasElement, readonly smooth = true) {
    const gl = canvas.getContext('webgl2', { antialias: smooth, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.prim = compile(gl, PRIM_VS, PRIM_FS);
    this.tri = compile(gl, TRI_VS, TRI_FS);
    this.grid = compile(gl, GRID_VS, GRID_FS);
    this.emptyVao = gl.createVertexArray()!;
  }

  private free(r: GpuGroup): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    gl.deleteBuffer(r.primBuf); gl.deleteBuffer(r.triBuf); gl.deleteBuffer(r.triCol);
    gl.deleteVertexArray(r.primVao); gl.deleteVertexArray(r.triVao);
  }

  /** The document closed: its context goes back to the browser at once. */
  dispose(): void { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); }

  private loc(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.u.get(p);
    if (!m) this.u.set(p, (m = new Map()));
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name)!;
  }

  private gpuFor(g: DrawGroup): GpuGroup {
    const gl = this.gl;
    let r = this.gpu.get(g);
    if (!r) {
      const primVao = gl.createVertexArray()!, primBuf = gl.createBuffer()!;
      gl.bindVertexArray(primVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, primBuf);
      const stride = INSTANCE_FLOATS * 4;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0); gl.vertexAttribDivisor(0, 1);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 16); gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 32); gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, stride, 36); gl.vertexAttribDivisor(3, 1);
      const triVao = gl.createVertexArray()!, triBuf = gl.createBuffer()!, triCol = gl.createBuffer()!;
      gl.bindVertexArray(triVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, triCol);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.bindVertexArray(null);
      r = { primVao, primBuf, primVer: -1, triVao, triBuf, triCol, triVer: -1 };
      this.gpu.set(g, r);
      this.freed.register(g, r);
    }
    if (r.primVer !== g.prims.version) {
      gl.bindBuffer(gl.ARRAY_BUFFER, r.primBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(g.prims.buf, 0, g.prims.count * INSTANCE_FLOATS * 4), gl.STATIC_DRAW);
      r.primVer = g.prims.version;
    }
    if (r.triVer !== g.tris.version) {
      gl.bindBuffer(gl.ARRAY_BUFFER, r.triBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g.tris.pos), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.triCol);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint32Array(g.tris.col), gl.STATIC_DRAW);
      r.triVer = g.tris.version;
    }
    return r;
  }

  private setView(p: WebGLProgram, cam: Camera, scene: Scene, dpr: number): void {
    const gl = this.gl;
    gl.useProgram(p);
    gl.uniform2f(this.loc(p, 'u_center'), cam.cx - scene.origin.x, cam.cy - scene.origin.y);
    gl.uniform1f(this.loc(p, 'u_scale'), cam.scale * dpr);
    gl.uniform2f(this.loc(p, 'u_view'), gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(this.loc(p, 'u_flip'), cam.flipX ? -1 : 1);
    if (p === this.prim) gl.uniform1f(this.loc(p, 'u_aa'), this.smooth ? 1 : 0);
  }

  draw(scene: Scene, cam: Camera, dpr: number, opts: { grid?: GridSpec | null; gridAbove?: string; tints?: Map<string, Tint>; overlay?: Scene } = {}): void {
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    const bg = hex4(scene.background);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (scene.backgroundEnd !== undefined && scene.backgroundEnd !== scene.background) {
      // The workspace's gradient: bands cleared top to bottom from its start colour to its end colour
      const end = hex4(scene.backgroundEnd), H = gl.drawingBufferHeight, n = Math.min(128, Math.max(2, H >> 2));
      gl.enable(gl.SCISSOR_TEST);
      for (let k = 0; k < n; k++) {
        const t = k / (n - 1), y1 = Math.round(H - (H * k) / n), y0 = Math.round(H - (H * (k + 1)) / n);
        gl.scissor(0, y0, gl.drawingBufferWidth, y1 - y0);
        gl.clearColor(bg[0] + (end[0] - bg[0]) * t, bg[1] + (end[1] - bg[1]) * t, bg[2] + (end[2] - bg[2]) * t, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.disable(gl.SCISSOR_TEST);
    }
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const groups = scene.ordered();
    let gridDrawn = !opts.grid;
    if (!gridDrawn && opts.gridAbove === undefined) { this.drawGrid(opts.grid!, cam, scene, dpr); gridDrawn = true; }
    for (const g of groups) {
      if (!gridDrawn && opts.gridAbove !== undefined && g.key !== opts.gridAbove && g.z > (scene.groups.get(opts.gridAbove)?.z ?? -Infinity)) {
        this.drawGrid(opts.grid!, cam, scene, dpr); gridDrawn = true;
      }
      if (g.visible) this.drawGroup(g, cam, scene, dpr, opts.tints?.get(g.key));
    }
    if (!gridDrawn) this.drawGrid(opts.grid!, cam, scene, dpr);
    if (opts.overlay) for (const g of opts.overlay.ordered()) if (g.visible) this.drawGroup(g, cam, opts.overlay, dpr);
  }

  private drawGroup(g: DrawGroup, cam: Camera, scene: Scene, dpr: number, tint?: Tint): void {
    const gl = this.gl;
    if (!g.prims.count && !g.tris.count) return;
    const r = this.gpuFor(g);
    const t = tint ? hex4(tint.rgb, tint.amount) : [0, 0, 0, 0];
    const pat = g.pattern ? [g.pattern.id, g.pattern.cell, g.pattern.out, 1] : [0, 0, 0, 0];
    if (g.tris.count) {
      this.setView(this.tri, cam, scene, dpr);
      gl.uniform1f(this.loc(this.tri, 'u_alpha'), g.alpha);
      gl.uniform4fv(this.loc(this.tri, 'u_tint'), t);
      gl.uniform4fv(this.loc(this.tri, 'u_pat'), pat);
      gl.bindVertexArray(r.triVao);
      gl.drawArrays(gl.TRIANGLES, 0, g.tris.count);
    }
    if (g.prims.count) {
      this.setView(this.prim, cam, scene, dpr);
      gl.uniform1f(this.loc(this.prim, 'u_alpha'), g.alpha);
      gl.uniform4fv(this.loc(this.prim, 'u_tint'), t);
      gl.uniform4fv(this.loc(this.prim, 'u_pat'), pat);
      gl.bindVertexArray(r.primVao);
      const runs = g.prims.runs;
      if (!runs.length) {
        gl.uniform1f(this.loc(this.prim, 'u_min'), 0);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, g.prims.count);
      } else {
        // Normal and darkening runs in order: each drawn from its first instance with its blending
        const spans = [{ start: 0, min: false }, ...runs];
        spans.forEach((sp, i) => {
          const end = spans[i + 1]?.start ?? g.prims.count;
          if (end <= sp.start) return;
          gl.blendEquation(sp.min ? gl.MIN : gl.FUNC_ADD);
          gl.uniform1f(this.loc(this.prim, 'u_min'), sp.min ? 1 : 0);
          this.pointPrims(r, sp.start);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, end - sp.start);
        });
        gl.blendEquation(gl.FUNC_ADD);
        this.pointPrims(r, 0);
      }
    }
    gl.bindVertexArray(null);
  }

  /** Instance attributes of the bound primitive VAO, starting at instance `first`. */
  private pointPrims(r: GpuGroup, first: number): void {
    const gl = this.gl, stride = INSTANCE_FLOATS * 4, base = first * stride;
    gl.bindBuffer(gl.ARRAY_BUFFER, r.primBuf);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, base);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, base + 16);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, base + 32);
    gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, stride, base + 36);
  }

  private drawGrid(spec: GridSpec, cam: Camera, scene: Scene, dpr: number): void {
    const gl = this.gl;
    this.setView(this.grid, cam, scene, dpr);
    gl.uniform1f(this.loc(this.grid, 'u_grid'), spec.size);
    gl.uniform1f(this.loc(this.grid, 'u_dots'), spec.dots ? 1 : 0);
    gl.uniform4fv(this.loc(this.grid, 'u_color'), spec.color);
    gl.uniform4fv(this.loc(this.grid, 'u_major'), spec.major);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}
