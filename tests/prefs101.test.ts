import { afterEach, describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { settings, DEFAULTS } from '../src/core/settings';
import { PAGES } from '../src/app/settingsSchema';
import { sortProjectRows } from '../src/app/panels/Panels';

const SRC = import.meta.glob(['../src/**/*.ts', '../src/**/*.tsx', '../index.html'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const saved = { ...settings };
afterEach(() => { Object.assign(settings, saved); });

const NEW = ['showStartupScreen', 'autosaveDesktop', 'popupDelay', 'popupHideDelay', 'popupAnimation', 'popupAnimationSpeed', 'titleFullPath', 'panelShadows', 'hideFloatsOnBlur',
  'autoPreviews', 'equalWidthTabs', 'middleClickCloses', 'transparentFloats', 'navZoom', 'navMask', 'navSelect', 'navPowerParts', 'projShowStatus', 'projShowPosition',
  'projShowStructure', 'projSort', 'projAscending', 'projExpand', 'projSingleClick', 'libraryPath', 'pcbSmartComponentSnap', 'pcbSnapRoomHotSpots', 'pcbProtectLocked',
  'pcbConfirmMemoryClear', 'pcbClickClearsSelection', 'pcbDoubleClickInspector', 'pcbUndoStack', 'pcbCompDrag', 'pcbSubstituteFont', 'crossSelect', 'schConfirmMemoryClear'] as const;

describe('Preferences wired in 26.101', () => {
  it('each is on its page with AD\'s default, and something reads it', () => {
    const fields = PAGES.flatMap((p) => p.sections.flatMap((s) => s.fields)).filter((f) => f.key).map((f) => f.key as string);
    const code = Object.entries(SRC).filter(([f]) => !/settings(Schema)?\.ts$/.test(f)).map(([, t]) => t).join('\n');
    for (const k of NEW) {
      expect(fields, k).toContain(k);
      expect(code.includes(`settings.${k}`) || code.includes(`"${k}"`), `${k} is read`).toBe(true);
    }
    expect(DEFAULTS).toMatchObject({ autosaveDesktop: true, popupDelay: 220, popupHideDelay: 600, equalWidthTabs: true, middleClickCloses: true, navZoom: true, navSelect: true, navMask: false,
      projSort: 'project', projExpand: 'source', projSingleClick: 'activate', pcbProtectLocked: true, pcbClickClearsSelection: true, pcbDoubleClickInspector: false, pcbUndoStack: 30, pcbCompDrag: 'tracks', pcbSubstituteFont: 'Arial' });
  });

  it('Protect Locked Objects: locked components stay out of a move and the rest go; only locked, nothing; off, all go', () => {
    const ed = new PcbEditor(readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'));
    const said: string[] = [];
    ed.status = (m) => said.push(m);
    const [a, b] = [0, 1];
    ed.doc.components[b]!.bag.set('LOCKED', 'TRUE');
    const set = { components: [a, b], polygons: [], prims: [] };
    expect(ed.unlockedSet(set)?.components).toEqual([a]);
    expect(said.pop()).toMatch(/^1 locked object stays put/);
    expect(ed.unlockedSet({ components: [b], polygons: [], prims: [] })).toBeNull();
    expect(said.pop()).toMatch(/is locked$/);
    settings.pcbProtectLocked = false;
    expect(ed.unlockedSet(set)?.components).toEqual([a, b]);
  });

  it('Projects panel sorting: project order, by name, open and modified first; either way round', () => {
    const rows = [{ name: 'b.SchDoc', position: 1 }, { name: 'a.PcbDoc', position: 2, open: true }, { name: 'c.SchDoc', position: 3, open: true, dirty: true }];
    const names = () => sortProjectRows(rows).map((r) => r.name);
    expect(names()).toEqual(['b.SchDoc', 'a.PcbDoc', 'c.SchDoc']);
    settings.projSort = 'alpha';
    expect(names()).toEqual(['a.PcbDoc', 'b.SchDoc', 'c.SchDoc']);
    settings.projSort = 'status';
    expect(names()).toEqual(['c.SchDoc', 'a.PcbDoc', 'b.SchDoc']);
    settings.projAscending = false;
    expect(names()).toEqual(['b.SchDoc', 'a.PcbDoc', 'c.SchDoc']);
  });
});
