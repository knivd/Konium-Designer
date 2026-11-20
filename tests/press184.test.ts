/**
 * A press on a running sheet's switch (26.184): between its contacts nothing of the symbol is under the
 * cursor, and the press was taken for the start of a selection box, so a click there selected the switch
 * and did not throw it. The editor now asks Live Simulation first.
 */
import { describe, expect, it } from 'vitest';
import { LIVE_EXAMPLES, liveExampleBytes } from '../src/app/liveExamples';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { SchEditor } from '../src/editors/sch/SchEditor';
import type { ToolPointer } from '../src/core/tools';

describe('a press between a switch\'s contacts (26.184)', () => {
  const ed = new SchEditor(readSchDoc(liveExampleBytes(LIVE_EXAMPLES.find((e) => e.id === 'fuse')!), 'Fuse.SchDoc'));
  const sw = ed.doc.objects.find((o) => o.kind === 'component' && o.designator === 'SW1')!;
  const at = (x: number, y: number) => ({ raw: { x, y }, world: { x, y }, button: 0, shift: false, ctrl: false, alt: false }) as unknown as ToolPointer;
  if (sw.kind !== 'component') throw new Error('no switch');

  it('is the start of a box on a sheet that is not running, and a press on the switch on one that is', () => {
    const here = at(sw.at.x, sw.at.y), empty = at(sw.at.x + 6_000_000, sw.at.y + 6_000_000);
    // (the open switch's lever stands to one side: nothing of the symbol is at its origin)
    expect(ed.hits(here.raw)).toHaveLength(0);
    expect(ed.wantsDrag(here)).toBe(true);
    const calls: string[] = [];
    ed.liveHit = {
      near: (p) => (Math.abs(p.x - sw.at.x) < 900_000 && Math.abs(p.y - sw.at.y) < 900_000 ? `o${sw.index}` : null),
      down: (key) => { calls.push(`down ${key}`); },
      up: (key, _p, clicked) => { calls.push(`up ${key} ${clicked}`); },
    };
    expect(ed.wantsDrag(here)).toBe(false);
    expect(ed.wantsDrag(empty)).toBe(true);
    // So the press reaches the editor as a press and its release as a click on the switch
    ed.pointerDown(here); ed.pointerUp(here, false);
    expect(calls).toEqual([`down o${sw.index}`, `up o${sw.index} true`]);
    ed.liveHit = null;
    expect(ed.wantsDrag(here)).toBe(true);
  });
});
