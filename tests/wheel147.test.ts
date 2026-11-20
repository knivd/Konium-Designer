import { describe, expect, it } from 'vitest';
import { sanitise, settings, wheelAction, wheelMapFrom } from '../src/core/settings';

const ev = (m: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m });

describe('Mouse Wheel Configuration: the wheel alone and with Ctrl, Shift or Alt (26.147)', () => {
  it('settings saved before the grid keep the scheme they had', () => {
    expect(sanitise({ wheel: 'zoom' }).wheelMap).toEqual({ Wheel: 'zoom', Ctrl: 'zoom', Shift: 'hscroll', Alt: 'none' });
    expect(sanitise({}).wheelMap).toEqual({ Wheel: 'vscroll', Ctrl: 'zoom', Shift: 'hscroll', Alt: 'none' });
    expect(sanitise({ wheel: 'zoom', wheelMap: { Wheel: 'zoom', Ctrl: 'vscroll', Shift: 'hscroll', Alt: 'bogus' } }).wheelMap).toEqual({ Wheel: 'zoom', Ctrl: 'vscroll', Shift: 'hscroll', Alt: 'none' });
    expect(wheelMapFrom('x', 'scroll').Wheel).toBe('vscroll');
  });
  it('a wheel event does what its modifier is given: Ctrl (or Cmd) first, then Shift, then Alt', () => {
    const was = settings.wheelMap;
    settings.wheelMap = { Wheel: 'zoom', Ctrl: 'vscroll', Shift: 'hscroll', Alt: 'none' };
    try {
      expect(wheelAction(ev())).toBe('zoom');
      expect(wheelAction(ev({ ctrlKey: true }))).toBe('vscroll');
      expect(wheelAction(ev({ metaKey: true, shiftKey: true }))).toBe('vscroll');
      expect(wheelAction(ev({ shiftKey: true }))).toBe('hscroll');
      expect(wheelAction(ev({ altKey: true }))).toBe('none');
    } finally { settings.wheelMap = was; }
  });
});
