/**
 * A turn of the event loop given up in the middle of long work (an analysis, the autorouter, an
 * import), so that the window can draw its progress and take a click on Stop. Not a timer: a
 * browser holds a hidden tab's timers back (to one a second, and to less once the tab has used
 * its share of the processor), so work that paused on a timer crawled whenever its tab was out
 * of view. A message is delivered as soon as the loop comes round, in view or not.
 */
let port: MessagePort | null = null;
const waiting: (() => void)[] = [];

export function breathe(): Promise<void> {
  // Outside a browser (the tests) there is no tab to hide: a timer, as before
  if (typeof document === 'undefined' || typeof MessageChannel === 'undefined') return new Promise((r) => setTimeout(r, 0));
  if (!port) {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => waiting.shift()?.();
    // (where a port can keep a process alive, this one doesn't)
    (ch.port1 as unknown as { unref?: () => void }).unref?.();
    port = ch.port2;
  }
  return new Promise((r) => { waiting.push(r); port!.postMessage(0); });
}
