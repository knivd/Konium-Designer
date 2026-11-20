import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { autoroute } from '../src/model/autoroute';
import { connections } from '../src/model/drc';
import { L } from '../src/model/layers';
import { mil, mm } from '../src/core/units';

const O = { x: mil(1000), y: mil(1000) };
const P = (x: number, y: number) => ({ x: O.x + mm(x), y: O.y + mm(y) });

/** The demo board with one +3V3 track taken up: a connection to route. */
function unrouted() {
  const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  doc.prims = doc.prims.filter((p) => !(p.kind === 'track' && p.net === 2 && p.width === mm(0.8) && p.a.x === P(24, 9.4).x));
  return doc;
}

describe('ActiveRoute', () => {
  it('routes only on the layers ticked in its panel, with through vias', async () => {
    const doc = unrouted();
    const conns = connections(doc);
    expect(conns.length).toBeGreaterThan(0);
    const r = await autoroute(doc, conns, { layers: [L.BOTTOM] });
    expect(r.routed).toBeGreaterThan(0);
    expect(r.tracks.every((t) => t.layer === L.BOTTOM)).toBe(true);
    expect(r.vias.every((v) => v.layerStart === L.TOP && v.layerEnd === L.BOTTOM)).toBe(true);
  });
  it('every signal layer when none is given', async () => {
    const doc = unrouted();
    const r = await autoroute(doc, connections(doc));
    expect(r.routed).toBe(connections(doc).length);
  });
});
