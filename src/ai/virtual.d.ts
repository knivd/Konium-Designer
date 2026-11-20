/** pdf.js's two modules, gzip-compressed and base64-encoded at build time (vite.config.ts). */
declare module 'virtual:pdfjs' {
  export const main: string;
  export const worker: string;
}
