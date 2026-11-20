/**
 * Reads and tessellates an embedded STEP model off the main thread (inlined into the page as a
 * worker, so it works offline and from a single file). Message: { id, data } with the model's
 * stored bytes (zlib or plain text); answer: { id, model } with the meshes' buffers transferred.
 */
import { parseStep } from '../../formats/step/parse';
import { tessellateStep } from '../../formats/step/tessellate';

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

self.onmessage = async (e: MessageEvent<{ id: number; data: Uint8Array }>) => {
  const { id, data } = e.data;
  try {
    const raw = data[0] === 0x78 ? await inflate(data) : data;
    const m = tessellateStep(parseStep(new TextDecoder('latin1').decode(raw)));
    if (!m.meshes.length) { postMessage({ id, model: null }); return; }
    const transfer = m.meshes.flatMap((s) => [s.pos.buffer, s.nrm.buffer, s.idx.buffer]);
    (self as unknown as Worker).postMessage({ id, model: m }, transfer as Transferable[]);
  } catch {
    postMessage({ id, model: null });
  }
};
