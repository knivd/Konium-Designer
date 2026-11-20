import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings, DEFAULTS } from '../src/core/settings';
import { PAGES } from '../src/app/settingsSchema';
import { newSheet } from '../src/app/newSheet';
import { sheetTemplate, withTemplate } from '../src/app/dataManagement';
import { templateOf } from '../src/model/schTemplate';
import { writeSchDoc } from '../src/formats/altium/schdoc';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { demoSchDoc } from '../src/formats/synthetic/demo';

const saved = structuredClone({ ...settings });
const store = new Map<string, string>();
beforeEach(() => { store.clear(); vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } }); });
afterEach(() => { Object.assign(settings, structuredClone(saved)); vi.unstubAllGlobals(); });

describe('Projects Panel, Data Management, Text Editors and Orcad Preferences once greyed (26.106)', () => {
  it('each is on its page with AD\'s default; those pages have nothing greyed', () => {
    const fields = PAGES.flatMap((p) => p.sections.flatMap((s) => s.fields)).filter((f) => f.key).map((f) => f.key as string);
    for (const k of ['projFullPathHint', 'projGrid', 'projDocStructure', 'projGroup', 'libSearch', 'useTemplates', 'templateName', 'backupFolder', 'textInsertKey', 'orcadFootprintField', 'orcadPorts']) expect(fields, k).toContain(k);
    expect(DEFAULTS).toMatchObject({ projFullPathHint: true, projGrid: false, projDocStructure: false, projGroup: 'type', libSearch: 'all', useTemplates: false, backupFolder: '',
      textInsertKey: false, orcadFootprintField: 'Part Field 1', orcadPorts: false, schDefaultsPermanent: false });
    const greyed = (id: string) => PAGES.find((p) => p.id === id)!.sections.flatMap((s) => s.fields).filter((f) => !f.key && f.type.kind !== 'action').map((f) => f.label);
    expect(greyed('sys-projects')).toEqual([]);
    for (const id of ['dm-search', 'dm-templates', 'dm-backup', 'text-general', 'sch-orcad']) expect(greyed(id), id).toEqual([]);
  });

  it('a new schematic starts from the template chosen, when Use templates is on', () => {
    const tpl = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const bytes = writeSchDoc(tpl);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    store.set('konium.template.sch.v1', JSON.stringify({ name: 'Company.SchDot', data: btoa(bin) }));
    settings.templateName = 'Company.SchDot';
    settings.useTemplates = false;
    expect(sheetTemplate()).toBeNull();
    expect(templateOf(withTemplate(newSheet('A.SchDoc')))).toBeUndefined();
    settings.useTemplates = true;
    expect(sheetTemplate()?.name).toBe('Company.SchDot');
    expect(templateOf(withTemplate(newSheet('B.SchDoc')))).toBeDefined();
  });
});
