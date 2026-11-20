import { describe, expect, it } from 'vitest';
import { DEFAULTS, exportSettings, fromStored, importSettings, sanitise, settings, updateSettings, resetSettings } from '../src/core/settings';
import { effectiveShortcuts } from '../src/app/commands';
import { PAGES, pageKeys } from '../src/app/settingsSchema';
import { L, layerColour, defaultLayerColour } from '../src/model/layers';

describe('settings', () => {
  it('zoom steps are half as big: the old default moves, a chosen step stays', () => {
    expect(DEFAULTS.zoomStep).toBeCloseTo(1.12);
    expect(fromStored({ zoomStep: 1.25 }).zoomStep).toBe(DEFAULTS.zoomStep);
    expect(fromStored({ zoomStep: 1.4 }).zoomStep).toBe(1.4);
    expect(fromStored({ zoomStep: 1.25, settingsRev: 2 }).zoomStep).toBe(1.25);
  });

  it("earlier builds' routing defaults give way to AD17's (HugNPush, loops kept); a mode chosen since stays", () => {
    expect(fromStored({ pcbRoutingMode: 'stop', pcbRemoveLoops: true, settingsRev: 2 }).pcbRoutingMode).toBe('hug');
    expect(fromStored({ pcbRoutingMode: 'stop', pcbRemoveLoops: true, settingsRev: 2 }).pcbRemoveLoops).toBe(false);
    expect(fromStored({ pcbRoutingMode: 'push', settingsRev: 2 }).pcbRoutingMode).toBe('push');
    expect(fromStored({ pcbRoutingMode: 'stop', settingsRev: 3 }).pcbRoutingMode).toBe('stop');
  });

  it('Track Width Mode defaults to User Choice; Rule Preferred left from the old default moves, one chosen since stays', () => {
    expect(DEFAULTS.pcbTrackWidthMode).toBe('user');
    expect(fromStored({ pcbTrackWidthMode: 'pref', settingsRev: 3 }).pcbTrackWidthMode).toBe('user');
    expect(fromStored({ pcbTrackWidthMode: 'max', settingsRev: 3 }).pcbTrackWidthMode).toBe('max');
    expect(fromStored({ pcbTrackWidthMode: 'pref', settingsRev: 4 }).pcbTrackWidthMode).toBe('pref');
  });

  it('sanitise keeps known keys of the right type only', () => {
    const s = sanitise({ schTextScale: 0.8, schTextAnchor: 'baseline', bogus: 1, zoomStep: 'fast', layerColours: [1, 2] });
    expect(s.schTextScale).toBe(0.8);
    expect(s.schTextAnchor).toBe('baseline');
    expect((s as unknown as Record<string, unknown>).bogus).toBeUndefined();
    expect(s.zoomStep).toBe(DEFAULTS.zoomStep);
    expect(s.layerColours).toEqual({});
  });

  it('export → import round-trips and rejects foreign files', () => {
    updateSettings({ schTextScale: 1.3, layerColours: { [L.TOP]: '#112233' } });
    const json = exportSettings();
    resetSettings();
    expect(settings.schTextScale).toBe(1);
    importSettings(json);
    expect(settings.schTextScale).toBe(1.3);
    expect(layerColour(L.TOP)).toBe(0x112233);
    expect(() => importSettings('{"a":1}')).toThrow();
    resetSettings();
    expect(layerColour(L.TOP)).toBe(defaultLayerColour(L.TOP));
  });

  it('names no other product, and old saved values carry over', () => {
    const text = JSON.stringify(PAGES.map((p) => ({ ...p, sections: p.sections.map((x) => ({ ...x, fields: x.fields.map((f) => ({ ...f, type: { ...f.type, format: undefined } })) })) })));
    expect(text).not.toMatch(/altium|vibium/i);
    expect(JSON.stringify(DEFAULTS)).not.toMatch(/altium|vibium|ad17/i);
    const s = sanitise({ theme: 'ad17', wheel: 'altium' });
    expect([s.theme, s.wheel]).toEqual(['classic', 'scroll']);
    expect(sanitise({ theme: 'bogus' }).theme).toBe('classic');
    importSettings(JSON.stringify({ vibium: 'settings', version: 1, settings: { schTextScale: 1.1 } }));
    expect(settings.schTextScale).toBe(1.1);
    resetSettings();
  });

  it('every schema field exists in Settings and has a default', () => {
    for (const p of PAGES) for (const k of pageKeys(p)) expect(k in DEFAULTS).toBe(true);
  });

  it('shortcut overrides replace defaults; empty string removes', () => {
    const base = effectiveShortcuts().filter((s) => s.command === 'view.fitObjects').map((s) => s.combo);
    expect(base).toContain('Ctrl+PageDown');
    updateSettings({ shortcuts: { 'view.fitObjects': 'Ctrl+K', 'view.units': '' } });
    const eff = effectiveShortcuts();
    expect(eff.filter((s) => s.command === 'view.fitObjects').map((s) => s.combo)).toEqual(['Ctrl+K']);
    expect(eff.some((s) => s.command === 'view.units')).toBe(false);
    resetSettings();
  });
});
