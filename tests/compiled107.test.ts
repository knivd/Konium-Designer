import { afterEach, describe, expect, it } from 'vitest';
import { settings, DEFAULTS } from '../src/core/settings';
import { PAGES } from '../src/app/settingsSchema';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { compileProject } from '../src/model/compile';
import { compiledInstances, compiledLook } from '../src/model/compiledView';
import { SchEditor } from '../src/editors/sch/SchEditor';
import { SR } from '../src/model/sch';
import { reportHtml } from '../src/core/reportHtml';
import { locale } from '../src/core/locale';

const saved = structuredClone({ ...settings });
afterEach(() => { Object.assign(settings, structuredClone(saved)); });
const ALL = { designators: true, netLabels: true, ports: true, power: true, documentNumber: true, sheetNumber: true };

function sheet(name: string, build: (b: SchBuilder, part: (des: string, x: number, y: number, uid: string) => void) => void) {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial', SHEETSTYLE: 0 });
  const part = (des: string, x: number, y: number, uid: string) => {
    const ci = b.add({ RECORD: SR.COMPONENT, LIBREFERENCE: 'Res', PARTCOUNT: 2, CURRENTPARTID: 1, OWNERPARTID: -1, DISPLAYMODECOUNT: 1, UNIQUEID: uid }, { LOCATION: { x, y } });
    b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: 1, PINCONGLOMERATE: 2 | 0x18, PINLENGTH: 10, NAME: '1', DESIGNATOR: '1', ELECTRICAL: 4 }, { LOCATION: { x, y } });
    b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: 1, PINCONGLOMERATE: 0 | 0x18, PINLENGTH: 10, NAME: '2', DESIGNATOR: '2', ELECTRICAL: 4 }, { LOCATION: { x: x + 40, y } });
    b.add({ RECORD: SR.DESIGNATOR, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Designator', TEXT: des }, { LOCATION: { x, y: y + 10 } });
  };
  build(b, part);
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  return { name, doc: readSchDoc(writeCfb(root), name) };
}
// Top: a Repeat(CH,1,2) symbol of Chan.SchDoc; the channel: R2, R3 and port A
function sheets() {
  const top = sheet('Top.SchDoc', (b, part) => {
    const s = b.add({ RECORD: SR.SHEET_SYMBOL, OWNERPARTID: -1, XSIZE: 200, YSIZE: 100, UNIQUEID: 'SYMBOLAA' }, { LOCATION: { x: 300, y: 500 } });
    b.add({ RECORD: SR.SHEET_NAME, OWNERINDEX: s, OWNERPARTID: -1, TEXT: 'Repeat(CH,1,2)' }, { LOCATION: { x: 300, y: 502 } });
    b.add({ RECORD: SR.FILE_NAME, OWNERINDEX: s, OWNERPARTID: -1, TEXT: 'Chan.SchDoc' }, { LOCATION: { x: 300, y: 390 } });
    b.add({ RECORD: SR.SHEET_ENTRY, OWNERINDEX: s, OWNERPARTID: -1, DISTANCEFROMTOP: 1, NAME: 'A', IOTYPE: 2 });
    part('R1', 100, 490, 'RONEUIDX');
    b.wire([150, 490], [300, 490]);
  });
  const chan = sheet('Chan.SchDoc', (b, part) => {
    part('R2', 400, 300, 'RTWOUIDX');
    part('R3', 500, 300, 'RTHREEID');
    b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: 'A', STYLE: 3, IOTYPE: 2, WIDTH: 50, HEIGHT: 10 }, { LOCATION: { x: 300, y: 300 } });
    b.wire([350, 300], [390, 300]);
    b.wire([440, 300], [490, 300]);
  });
  return [top, chan];
}

describe('the last of Preferences once greyed (26.107)', () => {
  it('nothing in Preferences is greyed any more', () => {
    expect(PAGES.flatMap((p) => p.sections.flatMap((s) => s.fields)).filter((f) => f.todo !== undefined).map((f) => f.label)).toEqual([]);
    expect(DEFAULTS).toMatchObject({ schCompiledDesignators: true, schCompiledSheetNumber: true, localised: false, projHistoryStatus: false });
    expect(Object.keys(DEFAULTS.pcbReports).sort()).toEqual(['bgaEscape', 'boardInfo', 'netStatus', 'originToGrid', 'stackup']);
  });

  it('a repeated sheet compiles to an instance per channel, each shown with its own designators and sheet number; read-only', () => {
    const sh = sheets();
    const res = compileProject(sh);
    const insts = compiledInstances(res, 'Chan.SchDoc');
    expect(insts.length).toBe(2);
    const chan = sh[1]!.doc, names = sh.map((s) => s.name);
    const a = compiledLook(res, chan, 'Chan.SchDoc', insts[0]!, ALL, names), b = compiledLook(res, chan, 'Chan.SchDoc', insts[1]!, ALL, names);
    const des = (l: typeof a) => [...l.names.entries()].filter(([i]) => { const o = chan.objects[i]; return o?.kind === 'text' && o.role === 'designator'; }).map(([, v]) => v).sort();
    expect(des(a)).toEqual(['R2_CH1', 'R3_CH1']);
    expect(des(b)).toEqual(['R2_CH2', 'R3_CH2']);
    expect([a.specials.get('SHEETNUMBER'), b.specials.get('SHEETNUMBER'), a.specials.get('SHEETTOTAL')]).toEqual(['2', '3', '3']);
    const ed = new SchEditor(chan);
    ed.setCompiledView(a);
    expect(ed.undo.guard?.()).toMatch(/compiled view/);
    const shown = ed.scene().ordered().flatMap((g) => g.texts).map((t) => t.text);
    expect(shown).toContain('R2_CH1');
    ed.setCompiledView(null);
    expect(ed.undo.guard?.() ?? null).toBeNull();
    expect(compiledLook(res, chan, 'Chan.SchDoc', insts[0]!, { ...ALL, designators: false, netLabels: false, ports: false, power: false }, names).names.size).toBe(0);
  });

  it('reports as HTML; dates in Britain\'s way unless localised', () => {
    expect(reportHtml('Board Information', 'a < b')).toContain('<pre>a &lt; b</pre>');
    expect(locale()).toBe('en-GB');
    settings.localised = true;
    expect(locale()).toBeUndefined();
  });
});
