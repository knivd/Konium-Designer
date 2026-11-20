/**
 * manifold-3d: robust solid modelling (unions, differences, extrusions, hulls) whose results are
 * always closed, printable solids. Loaded on first use; its WebAssembly travels inside Konium
 * Designer, compressed, so it works offline.
 */
import Module, { wasmGz } from 'virtual:manifold';
import type { ManifoldToplevel } from 'manifold-3d';

let ready: Promise<ManifoldToplevel> | null = null;

export function manifold(): Promise<ManifoldToplevel> {
  ready ??= (async () => {
    const options: { wasmBinary?: Uint8Array } = {};
    if (wasmGz) {
      const packed = Uint8Array.from(atob(wasmGz), (c) => c.charCodeAt(0));
      options.wasmBinary = new Uint8Array(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    }
    const m = await Module(options);
    m.setup();
    return m;
  })();
  return ready;
}
