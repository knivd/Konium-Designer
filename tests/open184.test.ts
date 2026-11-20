/**
 * Opening what a project is sent as (26.184): a ZIP archive picked or dropped is taken as the files
 * in it, their paths kept so that the project finds its documents.
 */
import { describe, expect, it } from 'vitest';
import { unpacked } from '../src/app/actions';
import { demoFiles } from '../src/formats/synthetic/demo';
import { zip, zipDeflated } from '../src/formats/zip';

describe('a ZIP archive opens as its contents (26.184)', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const demo = demoFiles();

  it('each file in it becomes a picked file, by its name, with its path in the archive', async () => {
    const inner = demo.map((f) => ({ name: `Demo/${f.name}`, bytes: f.bytes }));
    for (const packed of [zip(inner), await zipDeflated(inner)]) {
      const out = await unpacked([{ name: 'Demo project.zip', bytes: packed }]);
      expect(out.map((f) => f.name)).toEqual(demo.map((f) => f.name));
      expect(out.map((f) => f.path)).toEqual(demo.map((f) => `Demo project.zip/Demo/${f.name}`));
      out.forEach((f, i) => expect(Array.from(f.bytes.subarray(0, 64)), f.name).toEqual(Array.from(demo[i]!.bytes.subarray(0, 64))));
      expect(out.reduce((a, f) => a + f.bytes.length, 0)).toBe(demo.reduce((a, f) => a + f.bytes.length, 0));
    }
  });

  it('folders, the archives inside it and a project\'s History are passed over; other files come through as they are', async () => {
    const packed = zip([
      { name: 'P/', bytes: new Uint8Array(0) }, { name: 'P/One.SchDoc', bytes: demo.find((f) => /\.SchDoc$/i.test(f.name))!.bytes },
      { name: 'P/History/One.~(1).SchDoc.Zip', bytes: enc('PK') }, { name: 'P/History/Old.SchDoc', bytes: enc('x') }, { name: 'P/__Previews/One.SchDocPreview', bytes: enc('x') },
      { name: '__MACOSX/P/._One.SchDoc', bytes: enc('x') }, { name: 'P/Inner.zip', bytes: zip([{ name: 'a.txt', bytes: enc('a') }]) },
    ]);
    const other = { name: 'Notes.txt', bytes: enc('not an archive') }, named = { name: 'Fake.zip', bytes: enc('this is not a ZIP archive at all, only named as one') };
    const out = await unpacked([other, { name: 'Sent.zip', bytes: packed }, named]);
    expect(out.map((f) => f.name)).toEqual(['Notes.txt', 'One.SchDoc', 'Fake.zip']);
    expect(out[0]).toBe(other); expect(out[2]).toBe(named);
    expect(out[1]!.path).toBe('Sent.zip/P/One.SchDoc');
  });

  it('an archive with nothing to open in it gives nothing', async () => {
    expect(await unpacked([{ name: 'Empty.zip', bytes: zip([{ name: 'Only a folder/', bytes: new Uint8Array(0) }]) }])).toEqual([]);
  });
});
