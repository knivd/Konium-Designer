/**
 * Runs a simulation off the main thread (inlined into the page as a worker, so it works offline
 * and from a single file). Message: { id, text, files } — the netlist and the model files it
 * may .include by name; answer: { id, plots, messages, ms } with the waves' buffers transferred.
 */
import { readNetlist } from './netlist';
import { COLLECT_DEFAULT, type Collect, type Plot, type SimMessage } from './engine';
import { runAll } from './sweep';

self.onmessage = (e: MessageEvent<{ id: number; text: string; files: Record<string, string>; collect?: Collect }>) => {
  const { id, text, files, collect } = e.data;
  const t0 = performance.now();
  const lower = new Map(Object.entries(files ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let plots: Plot[] = [];
  let messages: SimMessage[] = [];
  try {
    const c = readNetlist(text, { include: (n) => lower.get(n.split(/[\\/]/).pop()!.toLowerCase()) ?? null });
    ({ plots, messages } = runAll(c, collect ?? COLLECT_DEFAULT));
    if (!c.analyses.length) messages.push({ level: 'warn', text: 'The netlist asks for no analysis (.OP, .TRAN, .AC, .DC, .TF, .NOISE, .PZ)' });
  } catch (err) {
    messages = [...messages, { level: 'error', text: (err as Error).message }];
  }
  // Waves as typed arrays, their buffers moved rather than copied
  const transfer: ArrayBuffer[] = [];
  for (const p of plots) for (const v of p.vectors) {
    if (!(v.re instanceof Float64Array)) v.re = Float64Array.from(v.re);
    transfer.push((v.re as Float64Array).buffer as ArrayBuffer);
    if (v.im) { if (!(v.im instanceof Float64Array)) v.im = Float64Array.from(v.im); transfer.push((v.im as Float64Array).buffer as ArrayBuffer); }
  }
  (self as unknown as Worker).postMessage({ id, plots, messages, ms: performance.now() - t0 }, transfer);
};
