import { describe, expect, it } from 'vitest';
import { readDsnWrk, writeDsnWrk, resolvePath, relativeTo, projectsFromPath } from '../src/model/designWorkspace';
import { packFiles, packageZip, PACK_SKIP } from '../src/model/packager';
import { harnessFileName, harnessFileText, readHarnessFile } from '../src/model/harnessFile';
import { harnessConnectorItems } from '../src/model/schHarness';
import { addRecords } from '../src/model/schEdit';
import { newSchDoc } from '../src/formats/altium/schdoc';
import { newLibPkg, newPrjPcb, addDocument, writePrjPcb, readPrjPcb, PROJECT_FILE } from '../src/formats/altium/prjpcb';
import { messagesReportHtml } from '../src/app/messagesReport';
import { SCH_UNIT } from '../src/core/units';
import type { PropertyBag } from '../src/formats/altium/props';

const enc = new TextEncoder();

describe('Design Workspace files', () => {
  const real = '[ProjectGroup]\r\nVersion=1.0\r\n[Project1]\r\nProjectPath=..\\..\\altium-libraries\\inductors\\inductors.LibPkg\r\n[Project2]\r\nProjectPath=main.PrjPcb\r\n';
  it('reads and writes AD17\'s layout', () => {
    expect(readDsnWrk(real)).toEqual(['..\\..\\altium-libraries\\inductors\\inductors.LibPkg', 'main.PrjPcb']);
    expect(writeDsnWrk(['main.PrjPcb', 'Libs/Passives.LibPkg'])).toBe('[ProjectGroup]\r\nVersion=1.0\r\n[Project1]\r\nProjectPath=main.PrjPcb\r\n[Project2]\r\nProjectPath=Libs\\Passives.LibPkg\r\n');
    expect(readDsnWrk(writeDsnWrk(['a\\b.PrjPcb', 'c.LibPkg']))).toEqual(['a\\b.PrjPcb', 'c.LibPkg']);
  });
  it('resolves paths relative to the workspace folder', () => {
    expect(resolvePath('boards/main', '..\\libs\\R.LibPkg')).toBe('boards/libs/R.LibPkg');
    expect(resolvePath('', 'main.PrjPcb')).toBe('main.PrjPcb');
    expect(resolvePath('a', '..\\..\\x.PrjPcb')).toBeNull();
    expect(relativeTo('ws/W.DsnWrk', 'ws/main/main.PrjPcb')).toBe('main\\main.PrjPcb');
    expect(relativeTo('ws/W.DsnWrk', 'libs/R.LibPkg')).toBe('..\\libs\\R.LibPkg');
    expect(relativeTo('W.DsnWrk', 'B.PrjPcb')).toBe('B.PrjPcb');
  });
  it('Create Projects from Path: one project per folder of documents without one', () => {
    const files = ['Top.SchDoc', 'Top.PcbDoc', 'power/Power.SchDoc', 'power/Power.PcbDoc', 'libs/R.SchLib', 'libs/R.PcbLib', 'done/Done.PrjPcb', 'done/Done.SchDoc', 'notes/readme.txt']
      .map((path) => ({ path }));
    const found = projectsFromPath(files, 'Root');
    expect(found.map((f) => [f.folder, f.name])).toEqual([['', 'Root.PrjPcb'], ['libs', 'libs.LibPkg'], ['power', 'power.PrjPcb']]);
    expect(found[0]!.documents).toEqual(['Top.SchDoc', 'Top.PcbDoc']);
    expect(found[1]!.documents).toEqual(['R.SchLib', 'R.PcbLib']);
  });
});

describe('Integrated Library packages', () => {
  it('a new .LibPkg is a project file with its own outputs folder', () => {
    const p = newLibPkg('Passives.LibPkg');
    addDocument(p, 'Passives.SchLib'); addDocument(p, 'Passives.PcbLib');
    const back = readPrjPcb(writePrjPcb(p), 'Passives.LibPkg');
    expect(back.documents).toEqual(['Passives.SchLib', 'Passives.PcbLib']);
    expect(new TextDecoder().decode(writePrjPcb(p))).toContain('OutputPath=Project Outputs for Passives');
    expect(PROJECT_FILE.test('a.LibPkg') && PROJECT_FILE.test('a.PrjPcb') && !PROJECT_FILE.test('a.DsnWrk')).toBe(true);
  });
});

describe('Project Packager', () => {
  const prj = newPrjPcb('Board.PrjPcb');
  addDocument(prj, 'Sheet1.SchDoc'); addDocument(prj, 'Sub/Power.SchDoc'); addDocument(prj, 'Board.PcbDoc'); addDocument(prj, 'Parts.SchLib');
  const folder = [
    { path: 'Board.PrjPcb', bytes: enc.encode('old project') },
    { path: 'Sheet1.SchDoc', bytes: enc.encode('sheet on disk') },
    { path: 'Sub/Power.SchDoc', bytes: enc.encode('power') },
    { path: 'Board.PcbDoc', bytes: enc.encode('board') },
    { path: 'Parts.SchLib', bytes: enc.encode('lib') },
    { path: 'Project Outputs for Board/Gerber.GTL', bytes: enc.encode('G04*') },
    { path: 'History/Sheet1.~(1).SchDoc', bytes: enc.encode('old') },
    { path: '__Previews/Sheet1.SchDocPreview', bytes: enc.encode('p') },
    { path: 'notes.txt', bytes: enc.encode('notes') },
  ];
  const files = packFiles({ name: 'Board.PrjPcb', prj: writePrjPcb(prj), documents: prj.documents, folder, files: new Map(), current: new Map([['sheet1.schdoc', { bytes: enc.encode('edited sheet'), dirty: true }]]) });
  it('lists the project, its documents as they are now, outputs and other files', () => {
    expect(files.map((f) => [f.path, f.kind])).toEqual([
      ['Board.PrjPcb', 'project'], ['Sheet1.SchDoc', 'document'], ['Sub/Power.SchDoc', 'document'], ['Board.PcbDoc', 'document'], ['Parts.SchLib', 'library'],
      ['Project Outputs for Board/Gerber.GTL', 'output'], ['notes.txt', 'other'],
    ]);
    expect(new TextDecoder().decode(files[1]!.bytes)).toBe('edited sheet');
    expect(files[1]!.modified).toBe(true);
    expect(new TextDecoder().decode(files[0]!.bytes)).toContain('[Design]');
    expect(PACK_SKIP.test('History/x') && PACK_SKIP.test('a/__Previews/b') && !PACK_SKIP.test('Historical.SchDoc')).toBe(true);
  });
  it('zips them under a folder named after the project', () => {
    const z = new TextDecoder('latin1').decode(packageZip('Board.PrjPcb', files.filter((f) => f.kind !== 'other')));
    expect(z).toContain('Board/Board.PrjPcb');
    expect(z).toContain('Board/Sub/Power.SchDoc');
    expect(z).not.toContain('notes.txt');
  });
});

describe('Harness definition files', () => {
  it('writes each harness type of a sheet with its entries, as AD\'s .Harness', () => {
    const doc = newSchDoc('MCU.SchDoc', 0, 0);
    const place = (items: { bag: PropertyBag; owner: number }[]) => {
      const base = doc.records.length - 1;
      addRecords(doc, items.map((it) => { const b = it.bag.clone(); if (it.owner >= 0) b.setRaw('OWNERINDEX', String(base + it.owner)); return b; })).apply();
    };
    place(harnessConnectorItems({ x: 0, y: 0 }, { x: 60 * SCH_UNIT, y: -50 * SCH_UNIT }, 'SPI', ['SCK', 'MOSI', 'MISO']));
    place(harnessConnectorItems({ x: 200 * SCH_UNIT, y: 0 }, { x: 260 * SCH_UNIT, y: -50 * SCH_UNIT }, 'ADC_DIG', ['DRDY', 'RESET']));
    // A nested harness entry carries its own type
    const entry = doc.objects.find((o) => o.kind === 'harnessentry' && o.name === 'RESET')!;
    doc.records[entry.index + 1]!.bag!.set('HARNESSTYPE', 'Reset_Bus');
    place(harnessConnectorItems({ x: 400 * SCH_UNIT, y: 0 }, { x: 460 * SCH_UNIT, y: -50 * SCH_UNIT }, 'spi', ['X']));
    const text = harnessFileText(doc);
    expect(text).toBe('ADC_DIG=DRDY,{RESET:Reset_Bus}\r\nSPI=SCK,MOSI,MISO\r\n');
    expect(harnessFileName('MCU.SchDoc')).toBe('MCU.Harness');
    expect(readHarnessFile('SunS_Solar_Ctrl={MUX:MUX_Control},SUNS_ON,{SOL:LCL}\nI2C=SCL,SDA\n').get('SunS_Solar_Ctrl')).toEqual(['{MUX:MUX_Control}', 'SUNS_ON', '{SOL:LCL}']);
  });
});

describe('Messages report', () => {
  it('lists the messages, grouped as the panel groups them', () => {
    const at = Date.UTC(2026, 9, 27, 10, 0, 0);
    const list = [
      { doc: 'A.SchDoc', level: 'warn' as const, message: 'Net N1 has no driving source', source: 'Compiler', at, no: 1 },
      { doc: 'B.SchDoc', level: 'error' as const, message: 'Duplicate designator <R1>', source: 'Compiler', at, no: 2 },
      { doc: 'A.SchDoc', level: 'info' as const, message: 'Compile successful', source: 'Compiler', at, no: 3 },
    ];
    const html = messagesReportHtml(list, 'document');
    expect(html).toContain('<h1>Messages Report</h1>');
    expect(html).toContain('A.SchDoc (2)');
    expect(html).toContain('Duplicate designator &lt;R1&gt;');
    expect(html.indexOf('A.SchDoc (2)')).toBeLessThan(html.indexOf('B.SchDoc (1)'));
    expect(messagesReportHtml([], 'none')).toContain('No messages.');
  });
});
