/** manifold-3d's loader, and its WebAssembly gzip-compressed and base64-encoded at build time (vite.config.ts). */
declare module 'virtual:manifold' {
  import type { ManifoldToplevel } from 'manifold-3d';
  const Module: (options?: { wasmBinary?: Uint8Array }) => Promise<ManifoldToplevel>;
  export default Module;
  export const wasmGz: string;
}
