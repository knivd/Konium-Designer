/**
 * Where a script runs (R8): a Worker started inside a sandboxed frame of its own (an opaque
 * origin, so nothing of Konium's: not its storage, its files or its pages), under a content
 * policy that lets it reach nothing (no network, no eval). Konium sends it the board and gets its
 * changes back as a message; a script that runs too long is stopped by taking its frame away.
 */
import { scriptRuntime, type ScriptMessage, type Snapshot } from './runtime';
import { checkedMessage } from './outcome';

export const SCRIPT_TIMEOUT_MS = 20_000;

const FRAME = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:">
<script>
addEventListener('message', (e) => {
  if (e.source !== parent) return;
  let w;
  try { w = new Worker(URL.createObjectURL(new Blob([e.data.src], { type: 'text/javascript' }))); }
  catch (err) { parent.postMessage({ type: 'error', message: String(err && err.message || err), log: [] }, '*'); return; }
  w.onmessage = (m) => parent.postMessage(m.data, '*');
  w.onerror = (m) => { m.preventDefault(); parent.postMessage({ type: 'error', message: m.message, line: m.lineno, log: [] }, '*'); };
  w.postMessage(e.data.snapshot);
});
parent.postMessage({ type: 'ready' }, '*');
</script>`;

/** The worker's source: the runtime, then the script as the body of an async function. */
export function workerSource(code: string): { src: string; offset: number } {
  const head = `"use strict";
const scriptRuntime = (${scriptRuntime.toString()});
self.onmessage = (e) => {
  self.onmessage = null;
  scriptRuntime(e.data, async function (board, output, print, mm, mil, inch, toMil, toInch) { const console = { log: print, info: print, warn: print, error: print, debug: print };
`;
  return { src: `${head}${code}\n}, (m) => self.postMessage(m));\n};\n`, offset: head.split('\n').length - 1 };
}

/**
 * The script's own line an error is at: the worker's line (a syntax error), else the stack's first
 * frame in the script itself (an error raised by a method of the board is raised in the runtime,
 * ahead of the script, called from the script's line).
 */
export function scriptLine(offset: number, line?: number, stack?: string): number | null {
  if (line) return line > offset ? line - offset : null;
  for (const m of (stack ?? '').matchAll(/blob:[^\s)]*?:(\d+):\d+/g)) if (Number(m[1]) > offset) return Number(m[1]) - offset;
  return null;
}

export type RunOutcome = Extract<ScriptMessage, { type: 'done' }> | { type: 'error'; message: string; line: number | null; log: string[] };

/** Run a script on a snapshot of the board; resolves when it ends, fails or is stopped. */
export function runInSandbox(code: string, snapshot: Snapshot, o: { timeout?: number; signal?: AbortSignal } = {}): Promise<RunOutcome> {
  const { src, offset } = workerSource(code);
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.display = 'none';
    frame.srcdoc = FRAME;
    let timer = 0;
    const end = (r: RunOutcome) => {
      removeEventListener('message', on);
      o.signal?.removeEventListener('abort', stop);
      clearTimeout(timer);
      frame.remove();
      resolve(r);
    };
    const stop = () => end({ type: 'error', message: 'Stopped', line: null, log: [] });
    let sent = false;
    const on = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      // The script's word and no more: rebuilt from checked values before anything here uses it (outcome.ts)
      const m = checkedMessage(e.data);
      if (!m) return;
      if (m.type === 'ready') { if (!sent) { sent = true; frame.contentWindow!.postMessage({ src, snapshot }, '*'); } return; }
      if (m.type === 'done') { end(m); return; }
      end({ type: 'error', message: m.message, line: scriptLine(offset, m.line, m.stack), log: m.log });
    };
    addEventListener('message', on);
    o.signal?.addEventListener('abort', stop);
    const ms = o.timeout ?? SCRIPT_TIMEOUT_MS;
    timer = window.setTimeout(() => end({ type: 'error', message: `Stopped after ${Math.round(ms / 1000)} seconds (a script may run for ${Math.round(SCRIPT_TIMEOUT_MS / 1000)} at most)`, line: null, log: [] }), ms);
    document.body.appendChild(frame);
  });
}
