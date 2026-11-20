/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
// @ts-expect-error a build tool in plain JavaScript, shared with the tests
import { notices, noticesElement, packageOf } from './tests/tools/notices.mjs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
/**
 * Version shown to users: year and build within the year, 26.009. package.json keeps it as
 * semver for npm (26.9.0 → 26.009).
 */
const [year, build] = pkg.version.split('.');
const appVersion = `${year}.${String(build ?? 0).padStart(3, '0')}`;
/** The packages whose modules went into the build (for their licence notices). */
const bundled = new Set<string>();

/**
 * Build output: one self-contained dist/index.html (JS, CSS, fonts inlined) that runs
 * from a server, from any sub-folder, or opened straight from disk (file://).
 * sw.js, manifest and icon are copied alongside for the installable PWA when served over http(s).
 */
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [preact(), viteSingleFile({ removeViteModuleLoader: true }), {
    // pdf.js (datasheets for the AI tools), compressed into Konium and unpacked on first use (src/ai/datasheet.ts)
    name: 'konium-pdfjs',
    resolveId(id) { return id === 'virtual:pdfjs' ? '\0virtual:pdfjs' : null; },
    load(id) {
      if (id !== '\0virtual:pdfjs') return null;
      const pack = (f: string) => gzipSync(readFileSync(new URL(`./node_modules/pdfjs-dist/build/${f}`, import.meta.url)), { level: 9 }).toString('base64');
      return `export const main = ${JSON.stringify(pack('pdf.min.mjs'))};\nexport const worker = ${JSON.stringify(pack('pdf.worker.min.mjs'))};\n`;
    },
  }, {
    // manifold-3d (the enclosure designer's solids): its loader as it is, its WebAssembly compressed into Konium and handed to it (src/platform/manifold.ts).
    // The tests use the package itself (tests/shims/manifold.ts).
    name: 'konium-manifold',
    resolveId(id) { return id === 'virtual:manifold' && !process.env.VITEST ? '\0virtual:manifold' : null; },
    load(id) {
      if (id !== '\0virtual:manifold') return null;
      const dir = new URL('./node_modules/manifold-3d/', import.meta.url);
      // The loader's way to the .wasm file, and its Node branch, left out: it is given the bytes, in a browser
      const node = 'if(ENVIRONMENT_IS_NODE){const{createRequire}=await import("node:module");var require=createRequire(import.meta.url)}';
      const raw = readFileSync(new URL('manifold.js', dir), 'utf8');
      if (!raw.includes(node) || !/new URL\("manifold\.wasm",import\.meta\.url\)\.href/.test(raw)) throw new Error('manifold-3d: its loader has changed');
      const js = raw.replace(node, '').replace(/new URL\("manifold\.wasm",import\.meta\.url\)\.href/g, '"manifold.wasm"');
      return `${js}\nexport const wasmGz = ${JSON.stringify(gzipSync(readFileSync(new URL('manifold.wasm', dir)), { level: 9 }).toString('base64'))};\n`;
    },
  }, {
    // The licence notices of the software built in, put into the page itself so that every copy of the one file carries them
    // (Help › About › Third-Party Software reads them; tests/tools/notices.mjs gathers them). After the single-file step, so the page is whole.
    name: 'konium-notices',
    apply: 'build',
    enforce: 'post',
    moduleParsed(info) { const p = packageOf(info.id) as string; if (p) bundled.add(p); },
    generateBundle(_options, bundle) {
      const page = bundle['index.html'];
      if (!page || page.type !== 'asset' || typeof page.source !== 'string') throw new Error('konium-notices: the page is not there to take its notices');
      const at = page.source.lastIndexOf('</body>');
      if (at < 0) throw new Error('konium-notices: the page has no end to put its notices before');
      const list = notices(fileURLToPath(new URL('.', import.meta.url)), [...bundled]) as { name: string }[];
      for (const need of ['preact', 'clipper-lib', 'pdfjs-dist', 'manifold-3d']) if (!list.some((n) => n.name === need)) throw new Error(`konium-notices: ${need} is built in and its notice is missing`);
      page.source = `${page.source.slice(0, at)}${noticesElement(list)}\n${page.source.slice(at)}`;
    },
  }, {
    // version.json beside index.html: what a running copy asks to learn of a newer one
    name: 'konium-version',
    apply: 'build',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ version: appVersion })}\n` }); },
  }],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 1_000_000, cssCodeSplit: false },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], alias: { 'virtual:manifold': fileURLToPath(new URL('./tests/shims/manifold.ts', import.meta.url)) } },
});
