/**
 * 26.208: four faults. The routing conflict mode in force is always one of those ticked in the
 * preferences (a mode unticked while it was the current one went on being used: Hug And Push
 * went on pushing with every pushing mode switched off). A layer shown alone in the 3D view is
 * copper like the rest of the view. The 3D view's shader lays a finer picture of the part in
 * view over a face's own. (The project folder chosen in a browser without the folder picker,
 * and the finer picture itself, are checked in the browser run.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, fromStored, routingModeOf, settings, updateSettings } from '../src/core/settings';
import { loneColour } from '../src/render/gl3d/boardTexture';
import { FS } from '../src/render/gl3d/Viewer3D';
import { L } from '../src/model/layers';

const ALL = { pcbModeIgnore: true, pcbModePush: true, pcbModeWalkaround: true, pcbModeStop: true, pcbModeHug: true, pcbModeAutoroute: true, pcbModeAutorouteMulti: true };

describe('the routing conflict mode in force (26.208)', () => {
  beforeEach(() => { updateSettings({ ...ALL, pcbRoutingMode: 'hug' }); });

  it('is the current one while it is ticked, and otherwise the next that moves nothing', () => {
    expect(routingModeOf({ ...ALL, pcbRoutingMode: 'hug' })).toBe('hug');
    // (the two pushing modes unticked: nothing is pushed)
    expect(routingModeOf({ ...ALL, pcbModePush: false, pcbModeHug: false, pcbRoutingMode: 'hug' })).toBe('walkaround');
    expect(routingModeOf({ ...ALL, pcbModePush: false, pcbModeHug: false, pcbRoutingMode: 'push' })).toBe('walkaround');
    expect(routingModeOf({ ...ALL, pcbModePush: false, pcbModeHug: false, pcbModeWalkaround: false, pcbRoutingMode: 'hug' })).toBe('stop');
    expect(routingModeOf({ ...ALL, pcbModeHug: false, pcbModeWalkaround: false, pcbModeStop: false, pcbRoutingMode: 'hug' })).toBe('ignore');
    // (only pushing left: the other pushing mode; nothing ticked: as it was)
    expect(routingModeOf({ pcbModeIgnore: false, pcbModePush: true, pcbModeWalkaround: false, pcbModeStop: false, pcbModeHug: false, pcbModeAutoroute: false, pcbModeAutorouteMulti: false, pcbRoutingMode: 'hug' })).toBe('push');
    expect(routingModeOf({ pcbModeIgnore: false, pcbModePush: false, pcbModeWalkaround: false, pcbModeStop: false, pcbModeHug: false, pcbModeAutoroute: false, pcbModeAutorouteMulti: false, pcbRoutingMode: 'hug' })).toBe('hug');
  });

  it('follows the ticks as they are changed, and a mode chosen by name is ticked with it', () => {
    updateSettings({ pcbModeHug: false });
    expect(settings.pcbRoutingMode).toBe('walkaround');
    // (a tick on another mode changes nothing)
    updateSettings({ pcbModePush: false });
    expect(settings.pcbRoutingMode).toBe('walkaround');
    // (the PCB panel's choice, a routing tool's own window: the mode comes with its tick)
    updateSettings({ pcbRoutingMode: 'push' });
    expect([settings.pcbRoutingMode, settings.pcbModePush, settings.pcbModeHug]).toEqual(['push', true, false]);
    // (the dialog's OK: ticks and mode together, the mode kept if it is among the ticked)
    updateSettings({ pcbModePush: false, pcbModeStop: true, pcbRoutingMode: 'stop' });
    expect(settings.pcbRoutingMode).toBe('stop');
    updateSettings({ pcbModeStop: false, pcbRoutingMode: 'stop' });
    expect(settings.pcbRoutingMode).toBe('walkaround');
  });

  it('is put right where an earlier build left it unticked', () => {
    const stored = { ...DEFAULTS, pcbModePush: false, pcbModeHug: false, pcbRoutingMode: 'hug' } as unknown as Record<string, unknown>;
    expect(fromStored(stored).pcbRoutingMode).toBe('walkaround');
    expect(fromStored({ ...DEFAULTS } as unknown as Record<string, unknown>).pcbRoutingMode).toBe(DEFAULTS.pcbRoutingMode);
  });
});

describe('settings kept in the browser, read as the program starts (26.208)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('are read whole: what reading them uses is ready by then, so nothing falls back to the defaults', async () => {
    // (the module read afresh with settings in the browser's store, as on every start of the program)
    const kept = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) });
    vi.resetModules();
    const first = await import('../src/core/settings');
    first.updateSettings({ offline: true, zoomStep: 1.5, pcbRoutingMode: 'hug' });
    expect(kept.size).toBe(1);
    // (as an earlier build could leave them: the mode in force unticked)
    const [key, raw] = [...kept.entries()][0]!;
    kept.set(key, JSON.stringify({ ...JSON.parse(raw), pcbModePush: false, pcbModeHug: false }));
    vi.resetModules();
    const again = await import('../src/core/settings');
    expect(again.settings).not.toBe(first.settings);
    expect([again.settings.offline, again.settings.zoomStep, again.settings.pcbRoutingMode, again.settings.pcbModeHug]).toEqual([true, 1.5, 'walkaround', false]);
  });
});

describe('the 3D view (26.208)', () => {
  it('shows a layer alone in copper like the rest of the view, every copper layer alike; by layer where the view is so coloured', () => {
    const hex = (l: number) => `#layer${l}`;
    for (const l of [L.TOP, L.BOTTOM, L.TOP + 1, L.TOP + 2]) expect(loneColour(l, 'realistic', '#d6ae4f', hex)).toBe('#d6ae4f');
    for (const l of [L.TOP, L.BOTTOM, L.TOP + 1]) expect(loneColour(l, 'layers', '#d6ae4f', hex)).toBe(`#layer${l}`);
    // (what is not copper keeps its own colour either way)
    expect(loneColour(L.TOP_OVERLAY, 'realistic', '#d6ae4f', hex)).toBe(`#layer${L.TOP_OVERLAY}`);
  });

  it('lays a finer picture of the part in view over a face, and only inside its rectangle', () => {
    expect(FS).toContain('uniform int uDet; uniform sampler2D uDetail; uniform vec4 uDetRect;');
    expect(FS).toMatch(/vec2 d = \(vUv - uDetRect\.xy\) \* uDetRect\.zw;/);
    expect(FS).toMatch(/if \(d\.x > 0\.0 && d\.x < 1\.0 && d\.y > 0\.0 && d\.y < 1\.0\) c = fine;/);
  });
});
