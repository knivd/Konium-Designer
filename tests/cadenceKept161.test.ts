import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { demoFiles, demoPcbDoc } from '../src/formats/synthetic/demo';
import { keepBrd, keepDsn } from '../src/formats/cadenceKept';
import { exportCadence } from '../src/formats/cadenceExport';
import { moveComponent } from '../src/model/pcbEdit';
import { mil } from '../src/core/units';
import type { ExportProject } from '../src/formats/exporters';

/**
 * R11, Cadence's files both ways: an Allegro board and a Capture design read into Konium and
 * exported for Cadence unchanged are the files Allegro and Capture wrote; changed, they go in the
 * ASCII formats Cadence's translators read.
 */

// Stand-ins for the files the import read (any bytes: they are kept, not read again)
const brdFile = new Uint8Array(4096).map((_, i) => (i * 37 + 11) & 0xff);
const dsnFile = new Uint8Array(2048).map((_, i) => (i * 53 + 7) & 0xff);
const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

function project(changeBoard = false, changeSheet = false): ExportProject {
  const board = readPcbDoc(keepBrd(demoPcbDoc(), 'Demo.PcbDoc', brdFile, 'C:/boards/Demo Board.brd'), 'Demo.PcbDoc');
  if (changeBoard) moveComponent(board, 0, { x: mil(50), y: 0 }, 0).apply();
  const sheets = keepDsn(demoFiles().filter((f) => /\.schdoc$/i.test(f.name)), dsnFile, 'Demo.DSN').map((s) => ({ name: s.name, doc: readSchDoc(s.bytes, s.name) }));
  if (changeSheet) { const b = sheets[0]!.doc.records.find((r) => r.bag?.get('RECORD') === '1')!.bag!; b.set('LOCATION.X', String(Number(b.get('LOCATION.X') ?? 0) + 10)); }
  return { name: 'Demo', sheets, board: changeBoard ? readPcbDoc(writePcbDoc(board), 'Demo.PcbDoc') : board, schLibs: [], pcbLibs: [], hierarchyMode: 2, variables: [] };
}

describe('Cadence round trip: files kept (R11)', () => {
  it('unchanged: the .brd and .dsn as Allegro and Capture wrote them, nothing else', () => {
    const r = exportCadence(project());
    expect(r.files.map((f) => f.path).sort()).toEqual(['Demo/Demo Board.brd', 'Demo/Demo.DSN']);
    expect(same(r.files.find((f) => f.path.endsWith('.brd'))?.bytes, brdFile)).toBe(true);
    expect(same(r.files.find((f) => f.path.endsWith('.DSN'))?.bytes, dsnFile)).toBe(true);
    expect(r.messages.some((m) => /unchanged/.test(m.message))).toBe(true);
  });

  it('the board changed: the design as Capture wrote it, the board in the ASCII format with its project', () => {
    const r = exportCadence(project(true));
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain('Demo/Demo.DSN');
    expect(paths.some((p) => /\.brd$/.test(p))).toBe(false);
    expect(paths).toContain('Demo/Demo.PcbDoc');
    expect(paths).toContain('Demo/Demo.PrjPcb');
    expect(paths.some((p) => /\.SchDoc$/i.test(p))).toBe(false);
  });

  it('a sheet changed: the schematics in the ASCII format, the board as Allegro wrote it', () => {
    const r = exportCadence(project(false, true));
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain('Demo/Demo Board.brd');
    expect(paths.some((p) => /\.DSN$/.test(p))).toBe(false);
    expect(paths.filter((p) => /\.SchDoc$/i.test(p)).length).toBeGreaterThan(0);
  });
});
