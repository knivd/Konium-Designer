/** 26.066: Auto Save and Local History — AD's names, the copies' rotation, what history keeps and purges; the History zips. */
import { describe, expect, it } from 'vitest';
import { autoSaveLabel, backupName, docKeyOf, expired, historyZipName, nextSlot, nextVersion, parseHistoryZip, purgeSelection, sessionGone, versionTitle } from '../src/model/historyNames';
import { zipDeflated } from '../src/formats/zip';
import { unzipEntries } from '../src/formats/xlsxRead';
import { sanitise } from '../src/core/settings';

const DAY = 86_400_000;

describe('Auto Save and Local History names', () => {
  it('copies as Name.~(n).Ext, versions as Name.~(n).Ext.Zip, read back (dots in the name too)', () => {
    expect(backupName('MySchematic.SchDoc', 1)).toBe('MySchematic.~(1).SchDoc');
    expect(historyZipName('SheetZ.SchDoc', 3)).toBe('SheetZ.~(3).SchDoc.Zip');
    expect(parseHistoryZip('SheetZ.~(3).SchDoc.Zip')).toEqual({ name: 'SheetZ.SchDoc', n: 3 });
    expect(parseHistoryZip(historyZipName('My.Board v2.PcbDoc', 12))).toEqual({ name: 'My.Board v2.PcbDoc', n: 12 });
    expect(parseHistoryZip('Notes.txt')).toBeNull();
    expect(parseHistoryZip('README.~(2).zip')).toEqual({ name: 'README', n: 2 });
    expect(versionTitle(4)).toBe('Version 4');
    expect(versionTitle(4, 'Sent to fab')).toBe('Version 4 [Sent to fab]');
    expect(autoSaveLabel(new Date(2015, 0, 28, 14, 14, 17, 935))).toBe('AutoSave 2015-01-28 14~14~17-935');
    expect(docKeyOf('Demo.PrjPcb', 'Sub\\Sheet1.SchDoc', 'Sheet1.SchDoc')).toBe('demo.prjpcb|sub/sheet1.schdoc');
  });

  it('copies rotate: free slots first, then the oldest one\'s; versions count up', () => {
    expect(nextSlot([], 5)).toBe(1);
    expect(nextSlot([{ slot: 1, at: 10 }, { slot: 3, at: 5 }], 5)).toBe(2);
    expect(nextSlot([{ slot: 1, at: 10 }, { slot: 2, at: 5 }, { slot: 3, at: 7 }], 3)).toBe(2);
    expect(nextVersion([])).toBe(1);
    expect(nextVersion([1, 4, 2])).toBe(5);
  });

  it('history keeps its days (labelled versions stay; AutoSave labels don\'t protect); Purge History: all, by age, the newest kept, labelled ones only when asked', () => {
    const now = 100 * DAY;
    const vs = [
      { n: 1, at: now - 20 * DAY }, { n: 2, at: now - 15 * DAY, label: 'Released' }, { n: 3, at: now - 12 * DAY, label: 'AutoSave 2026-01-01 10~00~00-000' },
      { n: 4, at: now - 2 * DAY }, { n: 5, at: now - DAY / 2 },
    ];
    expect(expired(vs, 7, now).map((v) => v.n)).toEqual([1, 3]);
    expect(purgeSelection(vs, {}, now).map((v) => v.n)).toEqual([1, 3, 4, 5]);
    expect(purgeSelection(vs, { labelled: true }, now).map((v) => v.n)).toEqual([1, 2, 3, 4, 5]);
    expect(purgeSelection(vs, { days: 10, keep: 1 }, now).map((v) => v.n)).toEqual([1, 3]);
    expect(purgeSelection(vs, { keep: 2, labelled: true }, now).map((v) => v.n)).toEqual([1, 2, 3]);
  });

  it('a session with no heartbeat for 90 s (or none at all) has ended', () => {
    expect(sessionGone({ a: 1000 }, 'a', 50_000)).toBe(false);
    expect(sessionGone({ a: 1000 }, 'a', 200_000)).toBe(true);
    expect(sessionGone({}, 'b', 0)).toBe(true);
  });

  it('a History zip: deflated, read back the same', async () => {
    const text = new TextEncoder().encode('|RECORD=31|'.repeat(4000));
    const z = await zipDeflated([{ name: 'Sheet1.SchDoc', bytes: text }]);
    expect(z.length).toBeLessThan(text.length / 10);
    const [e] = unzipEntries(z);
    expect(e!.name).toBe('Sheet1.SchDoc');
    expect([...(await e!.data())]).toEqual([...text]);
    // Incompressible: stored
    const rnd = Uint8Array.from({ length: 300 }, (_, i) => (i * 7919 + 13) % 251);
    const z2 = await zipDeflated([{ name: 'x.bin', bytes: rnd }]);
    expect([...(await unzipEntries(z2)[0]!.data())]).toEqual([...rnd]);
  });

  it('Preferences: Auto Save on every 10 minutes, 5 copies; history 7 days; values kept in range', () => {
    const d = sanitise({});
    expect([d.autoSave, d.autoSaveMinutes, d.autoSaveVersions, d.historyDays, d.historyAutosaves, d.historyGlobal]).toEqual([true, 10, 5, 7, false, false]);
    const s = sanitise({ autoSaveMinutes: 0, autoSaveVersions: 40, historyDays: 2.6 });
    expect([s.autoSaveMinutes, s.autoSaveVersions, s.historyDays]).toEqual([1, 10, 3]);
  });
});
