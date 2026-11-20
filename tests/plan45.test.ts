import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';

describe('Board Planning Mode', () => {
  it('shows the design underneath, but only the board region takes clicks', () => {
    const ed = new PcbEditor(readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'));
    const before = ed.allItems().length;
    ed.setPlanning(true);
    expect(ed.allItems().map((i) => i.key)).toEqual(['region:0']);
    const s = ed.scene();
    expect(s.background).toBe(0x6d6a69);
    // The design is drawn (copper groups present), not just the region
    expect(s.ordered().filter((g) => g.key.startsWith('L')).length).toBeGreaterThan(0);
    expect(s.ordered().some((g) => g.texts.some((t) => t.text === 'Layer Stack Region 1 - Board Layer Stack'))).toBe(true);
    ed.setPlanning(false);
    expect(ed.allItems().length).toBe(before);
  });
});
