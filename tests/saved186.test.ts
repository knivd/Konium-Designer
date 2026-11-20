/**
 * Live Simulation's monitors and scopes kept with the sheet (26.186): one parameter of the sheet holds them as text.
 */
import { describe, expect, it } from 'vitest';
import { LIVE_SAVED, liveSavedText, readLiveSaved, sameWatch, type LiveSaved } from '../src/app/liveSaved';
import { newSheet } from '../src/app/newSheet';
import { docParam, docParamChange } from '../src/model/schParams';
import { readSchDoc, writeSchDoc } from '../src/formats/altium/schdoc';

describe('what a sheet keeps of its Live Simulation (26.186)', () => {
  const full: LiveSaved = { views: ['time', 'spectrum', 'time'], zero: true, keep: [{ from: { part: 'R1' }, scope: 1 }, { from: { at: { x: 12_000_000, y: 34_005_000 } }, scope: 2 }, { from: { part: 'C3' }, scope: 0 }] };

  it('is written as one line and read back the same', () => {
    const text = liveSavedText(full);
    expect(text).toBe('v=1;scopes=time,spectrum;zero=1;keep=R1>1,1200:3400.5>2,C3>0');
    // (the third scope, against time and drawing nothing kept, is whatever a run gives the sheet anyway)
    expect(readLiveSaved(text)).toEqual({ ...full, views: ['time', 'spectrum'] });
    expect(liveSavedText(readLiveSaved(text)!)).toBe(text);
  });

  it('a sheet with nothing to keep has no text; a scope that draws a monitor, or has a view of its own, is kept', () => {
    expect(liveSavedText({ views: ['time'], zero: false, keep: [] })).toBe('');
    expect(liveSavedText({ views: ['time', 'time', 'time'], zero: false, keep: [] })).toBe('');
    expect(liveSavedText({ views: ['time', 'time', 'time'], zero: false, keep: [{ from: { part: 'R1' }, scope: 3 }] })).toBe('v=1;scopes=time,time,time;keep=R1>3');
    expect(liveSavedText({ views: ['time', 'response'], zero: false, keep: [] })).toBe('v=1;scopes=time,response');
    expect(liveSavedText({ views: ['time'], zero: true, keep: [] })).toBe('v=1;zero=1');
    expect(liveSavedText({ views: ['time'], zero: false, keep: [{ from: { part: 'R1' }, scope: 0 }] })).toBe('v=1;keep=R1>0');
  });

  it('a designator with the text\'s own marks in it comes back whole', () => {
    const odd: LiveSaved = { views: ['time'], zero: false, keep: [{ from: { part: 'R1;x=2,3>4:5' }, scope: 1 }, { from: { part: 'Ω 1' }, scope: 0 }] };
    const text = liveSavedText(odd);
    expect(text).not.toMatch(/\|/);
    expect(readLiveSaved(text)!.keep).toEqual(odd.keep);
  });

  it('what is not one of these is read as nothing, and what is half of one as far as it goes', () => {
    expect(readLiveSaved('')).toBeNull();
    expect(readLiveSaved('something typed over it')).toBeNull();
    expect(readLiveSaved('v=2;scopes=time')).toBeNull();
    expect(readLiveSaved('v=1;scopes=time,sideways,spectrum;keep=R1>9,R2,>1,12:x>1,R3>1')).toEqual({ views: ['time', 'spectrum'], zero: false, keep: [{ from: { part: '12:x' }, scope: 1 }, { from: { part: 'R3' }, scope: 1 }] });
  });

  it('two of them keep the same monitors and scopes whatever a run starts from, and a point is the same to a hundredth of a mil', () => {
    expect(sameWatch(full, { ...full, zero: false })).toBe(true);
    expect(sameWatch(full, { ...full, views: ['time', 'spectrum'] })).toBe(true);
    expect(sameWatch(full, { ...full, keep: full.keep.slice(0, 2) })).toBe(false);
    expect(sameWatch(null, { views: ['time'], zero: true, keep: [] })).toBe(true);
    const near = { ...full, keep: [full.keep[0]!, { from: { at: { x: 12_000_004, y: 34_005_003 } }, scope: 2 }, full.keep[2]!] };
    expect(sameWatch(full, near)).toBe(true);
  });

  it('it is the sheet\'s parameter LiveSimulation: saved with the file, back with it, and a change that can be undone', () => {
    const doc = newSheet('Sheet1.SchDoc');
    expect(docParam(doc, LIVE_SAVED)).toBeUndefined();
    const change = docParamChange(doc, LIVE_SAVED, liveSavedText(full))!;
    change.apply();
    const back = readSchDoc(writeSchDoc(doc), 'Sheet1.SchDoc');
    expect(readLiveSaved(docParam(back, LIVE_SAVED)!.value)).toEqual({ ...full, views: ['time', 'spectrum'] });
    change.revert();
    expect(docParam(doc, LIVE_SAVED)).toBeUndefined();
  });
});
