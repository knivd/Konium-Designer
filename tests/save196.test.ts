/**
 * 26.196: a save whose place can't be written (the browser's temporary file held back or
 * refused, the file moved away since) no longer leaves an empty file that passes for the saved
 * one: the empty file is taken away, the document is downloaded instead and the person is told
 * in a window; a file that has gone is asked for again; saves are listed in a report's
 * diagnostics.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WriteFallbackError, fallbackLines, saveFile, saveFileAs, setWriteFallbackNotice, writeFallbacks, writeHandle, writeInto, type WriteFallback } from '../src/platform/fs';
import { diagnosticsText, noteSave } from '../src/app/diagnostics';

const g = globalThis as unknown as Record<string, unknown>;
const err = (name: string, message: string) => Object.assign(new Error(message), { name });
const NOT_FOUND = 'A requested file or directory could not be found at the time an operation was processed.';

interface Fake { name: string; size: number | null; written: Uint8Array | null; removed: boolean; aborted: boolean; handle: FileSystemFileHandle }
/** A file handle as the browser gives one: `fail` names the step that throws; size null: the file isn't there. */
function fake(name: string, o: { size?: number | null; fail?: 'create' | 'write' | 'close'; error?: Error; remove?: boolean } = {}): Fake {
  const f: Fake = { name, size: o.size === undefined ? 0 : o.size, written: null, removed: false, aborted: false, handle: null as unknown as FileSystemFileHandle };
  const boom = () => { throw o.error ?? err('NotFoundError', NOT_FOUND); };
  const h: Record<string, unknown> = {
    name, kind: 'file',
    createWritable: async () => {
      if (o.fail === 'create') boom();
      return {
        write: async (b: Uint8Array) => { if (o.fail === 'write') boom(); f.written = b; },
        close: async () => { if (o.fail === 'close') boom(); f.size = f.written?.length ?? 0; },
        abort: async () => { f.aborted = true; },
      };
    },
    getFile: async () => { if (f.size === null || f.removed) throw err('NotFoundError', NOT_FOUND); return { size: f.size }; },
    requestPermission: async () => 'granted',
  };
  if (o.remove !== false) h.remove = async () => { f.removed = true; };
  f.handle = h as unknown as FileSystemFileHandle;
  return f;
}

let downloads: string[] = [], notices: WriteFallback[] = [], picks: (FileSystemFileHandle | Error)[] = [];
beforeEach(() => {
  downloads = []; notices = []; picks = [];
  g.document = { createElement: () => ({ href: '', download: '', click(this: { download: string }) { downloads.push(this.download); } }) };
  g.showSaveFilePicker = async () => { const p = picks.shift(); if (!p) throw err('AbortError', 'The user aborted a request.'); if (p instanceof Error) throw p; return p; };
  setWriteFallbackNotice((f) => notices.push(f));
});
afterEach(() => { delete g.document; delete g.showSaveFilePicker; setWriteFallbackNotice(() => {}); });

const BYTES = new Uint8Array([1, 2, 3, 4]);

describe('a file written through its handle (26.196)', () => {
  it('written and closed; nothing else is touched', async () => {
    const f = fake('Board.PcbDoc');
    await writeHandle(f.handle, BYTES);
    expect(f.written).toBe(BYTES);
    expect(f.size).toBe(4);
    expect(f.removed).toBe(false);
  });

  it('a failed write drops the stream and takes away the empty file the file selector made', async () => {
    for (const fail of ['create', 'write', 'close'] as const) {
      const f = fake('Board.PcbDoc', { fail });
      await expect(writeHandle(f.handle, BYTES)).rejects.toMatchObject({ name: 'NotFoundError', emptyLeft: false });
      expect(f.removed, fail).toBe(true);
      expect(f.aborted, fail).toBe(fail !== 'create');
    }
    // A file that was there with something in it keeps it
    const kept = fake('Board.PcbDoc', { fail: 'close', size: 120 });
    await expect(writeHandle(kept.handle, BYTES)).rejects.toMatchObject({ emptyLeft: false });
    expect(kept.removed).toBe(false);
    // A browser that can't remove a file: the empty one is said to be left
    const left = fake('Board.PcbDoc', { fail: 'close', remove: false });
    await expect(writeHandle(left.handle, BYTES)).rejects.toMatchObject({ emptyLeft: true });
  });

  it('a file written into a folder: the same care', async () => {
    const f = fake('Board.PcbDoc', { fail: 'close' });
    const dir = { getFileHandle: async () => f.handle } as unknown as FileSystemDirectoryHandle;
    await expect(writeInto(dir, 'Board.PcbDoc', BYTES)).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(f.removed).toBe(true);
  });
});

describe('Save As to a place that can\'t be written (26.196)', () => {
  it('the document is downloaded instead, the person is told, and no empty file stays', async () => {
    const f = fake('Board.PcbDoc', { fail: 'close' });
    picks.push(f.handle);
    const before = writeFallbacks();
    expect(await saveFileAs('Board.PcbDoc', BYTES)).toBeUndefined();
    expect(downloads).toEqual(['Board.PcbDoc']);
    expect(f.removed).toBe(true);
    expect(writeFallbacks()).toBe(before + 1);
    expect(notices).toEqual([{ name: 'Board.PcbDoc', why: NOT_FOUND, existing: false, unsaved: false, emptyLeft: false }]);
    const lines = fallbackLines(notices[0]!);
    expect(lines[0]).toBe(`Board.PcbDoc could not be written to the place chosen. The browser reported: “${NOT_FOUND}”`);
    expect(lines[1]).toBe('It has been downloaded instead: look in the browser\'s downloads folder.');
    expect(lines.join(' ')).toContain('Security or file-sync software');
    expect(lines.join(' ')).not.toMatch(/[–—]/);
    expect(lines).toHaveLength(3);
  });

  it('an empty file that couldn\'t be taken away is named as not the saved file', async () => {
    picks.push(fake('Board.PcbDoc', { fail: 'create', remove: false }).handle);
    await saveFileAs('Board.PcbDoc', BYTES);
    expect(notices[0]!.emptyLeft).toBe(true);
    expect(fallbackLines(notices[0]!).at(-1)).toBe('An empty file named Board.PcbDoc may have been left at the place chosen: it is not the saved file, and can be deleted.');
  });

  it('cancelled: nothing is written or downloaded; a place that works is written as before', async () => {
    expect(await saveFileAs('Board.PcbDoc', BYTES)).toBeNull();
    expect(downloads).toEqual([]);
    const f = fake('Board.PcbDoc');
    picks.push(f.handle);
    expect(await saveFileAs('Board.PcbDoc', BYTES)).toBe(f.handle);
    expect(f.written).toBe(BYTES);
    expect(downloads).toEqual([]);
    expect(notices).toEqual([]);
  });
});

describe('Save to the document\'s own file (26.196)', () => {
  it('a file that can\'t be written keeps what it had: the document is downloaded and still counts as unsaved', async () => {
    const f = fake('Board.PcbDoc', { fail: 'close', size: 500, error: err('NoModificationAllowedError', 'The file is locked.') });
    const e = await saveFile('Board.PcbDoc', BYTES, f.handle).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WriteFallbackError);
    expect((e as Error).message).toBe('Board.PcbDoc could not be written to its file (The file is locked.); the document as it is now was downloaded instead');
    expect(downloads).toEqual(['Board.PcbDoc']);
    expect(f.removed).toBe(false);
    expect(notices[0]).toMatchObject({ existing: true, unsaved: true, emptyLeft: false });
    const lines = fallbackLines(notices[0]!);
    expect(lines[0]).toContain('could not be written to its file, which keeps what it had');
    expect(lines[1]).toContain('The document here still counts as unsaved.');
  });

  it('a file that has gone (moved, renamed or deleted since): where to save is asked again', async () => {
    const gone = fake('Board.PcbDoc', { fail: 'create', size: null });
    const fresh = fake('Board.PcbDoc');
    picks.push(fresh.handle);
    expect(await saveFile('Board.PcbDoc', BYTES, gone.handle)).toBe(fresh.handle);
    expect(fresh.written).toBe(BYTES);
    expect(downloads).toEqual([]);
    expect(notices).toEqual([]);
    // No file selector to be had (too long since the click): downloaded, and said
    const gone2 = fake('Board.PcbDoc', { fail: 'create', size: null });
    picks.push(err('SecurityError', 'Must be handling a user gesture to show a file picker.'));
    await expect(saveFile('Board.PcbDoc', BYTES, gone2.handle)).rejects.toBeInstanceOf(WriteFallbackError);
    expect(downloads).toEqual(['Board.PcbDoc']);
  });
});

describe('a bug report\'s diagnostics (26.196)', () => {
  it('list the last files saved: name, size and how they went out', () => {
    noteSave('Board.PcbDoc', 52_488_704, 'written to its file');
    noteSave('Sheet1.SchDoc', 20_000, 'downloaded: the place chosen could not be written');
    const text = diagnosticsText({ docs: [], messages: [] });
    expect(text).toMatch(/Last saves \(2\):\n {2}\d\d:\d\d:\d\d Board\.PcbDoc: 50\.1 MB, written to its file\n {2}\d\d:\d\d:\d\d Sheet1\.SchDoc: 20 KB, downloaded: the place chosen could not be written/);
  });
});
