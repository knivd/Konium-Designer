import { describe, expect, it } from 'vitest';
import { OTHER_TOOL_EXTS, pickerExt, pickerTypes } from '../src/platform/fs';

describe('File › Open: the system file selector\'s filters', () => {
  it('only extensions Chromium takes (letters, digits, + and ., up to 16): KiCad\'s are left to All Files', () => {
    expect(['.PcbDoc', '.SVNDbLib', '.epro2', '.c++', '.tar.gz'].every(pickerExt)).toBe(true);
    expect(['.kicad_pcb', '.my-ext', 'PcbDoc', '.a.', '.abcdefghijklmnopq'].some(pickerExt)).toBe(false);
    const t = pickerTypes([{ description: 'Other tools\' files to import', exts: OTHER_TOOL_EXTS }]);
    expect(t[0]!.description).toBe("Other tools' files to import (KiCad's: All Files)");
    expect(t[0]!.accept['application/octet-stream']!.every(pickerExt)).toBe(true);
    // A list with nothing the selector takes gives no filter at all (All Files)
    expect(pickerTypes([{ description: 'KiCad', exts: ['.kicad_pro', '.kicad_pcb'] }])).toEqual([]);
  });
});
