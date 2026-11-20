import { afterEach, describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { settings, DEFAULTS } from '../src/core/settings';
import { PAGES } from '../src/app/settingsSchema';
import { forOutput, uniquePrims } from '../src/model/duplicates';
import { connectionLines, connections } from '../src/model/drc';
import { addTracks, removePrims } from '../src/model/pcbEdit';
import { L } from '../src/model/layers';
import { changeReport, formatVersions, KONIUM_FORMAT_VERSIONS } from '../src/formats/altium/fileVersion';
import { deflateFont, fontFile, readEmbeddedFonts, writeEmbeddedFonts } from '../src/formats/altium/embeddedFonts';
import { newEntry, cfbPut } from '../src/formats/cfb/cfb';
import { pathPolylines, svgStrokes } from '../src/formats/svgStrokes';
import { avoidFraction, componentBox, pushes } from '../src/model/compPush';
import { placement } from '../src/formats/altium/pcbTransform';
import { mil } from '../src/core/units';
import type { PcbPad, PcbTrack } from '../src/model/pcb';

const saved = structuredClone({ ...settings });
afterEach(() => { Object.assign(settings, structuredClone(saved)); });
const board = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
const chars = (s: string) => [...s].map((c) => c.charCodeAt(0)).join(',');
const versionInfo = (vers: string[]) => {
  const body = `|COUNT=${vers.length}${vers.map((v, i) => `|VER${i}=${chars(v)}|FWDMSG${i}=|BKMSG${i}=${chars(`<b>CAUTION</b> - note ${i}`)}`).join('')}\0`;
  const b = new TextEncoder().encode(body), out = new Uint8Array(4 + b.length);
  new DataView(out.buffer).setUint32(0, b.length, true); out.set(b, 4);
  const root = newEntry('Root Entry', 'root'); cfbPut(root, 'FileVersionInfo/Data', out); return root;
};

describe('PCB Editor › General and the rest of PCB Preferences once greyed (26.104)', () => {
  it('each is on its page with AD\'s default; nothing greyed is left on General, Interactive Routing or True Type Fonts', () => {
    const fields = PAGES.flatMap((p) => p.sections.flatMap((s) => s.fields)).filter((f) => f.key).map((f) => f.key as string);
    for (const k of ['pcbRemoveDuplicates', 'pcbConfirmGlobalEdit', 'pcbShiftClickSelect', 'pcbShiftClickKinds', 'pcbSmartTrackEnds', 'pcbSelectPopup', 'pcbAutoPan', 'pcbAutoPanSpeed',
      'pcbNoReportOlder', 'pcbNoReportNewer', 'pcbPasteFormat', 'pcbCompPushing', 'pcbEmbedFonts']) expect(fields, k).toContain(k);
    expect(DEFAULTS).toMatchObject({ pcbRemoveDuplicates: true, pcbConfirmGlobalEdit: true, pcbShiftClickSelect: false, pcbSmartTrackEnds: true, pcbSelectPopup: true,
      pcbAutoPan: 'Adaptive', pcbAutoPanSpeed: 1200, pcbNoReportOlder: false, pcbNoReportNewer: false, pcbPasteFormat: 'Metafile', pcbCompPushing: 'Ignore', pcbEmbedFonts: false });
    for (const id of ['pcb-general', 'pcb-routing', 'pcb-ttf']) expect(PAGES.find((p) => p.id === id)!.sections.flatMap((s) => s.fields).filter((f) => !f.key && f.type.kind !== 'action').map((f) => f.label), id).toEqual([]);
  });

  it('Remove Duplicates: outputs see a duplicated object once; the board keeps both', () => {
    const doc = board();
    const t = doc.prims.find((p) => p.kind === 'track')!;
    const dup = { ...t, src: { ...t.src, index: 999 } };
    const withDup = { ...doc, prims: [...doc.prims, dup] };
    expect(uniquePrims(withDup.prims).length).toBe(doc.prims.length);
    expect(forOutput(withDup).prims.length).toBe(doc.prims.length);
    settings.pcbRemoveDuplicates = false;
    expect(forOutput(withDup)).toBe(withDup);
  });

  it('Smart Track Ends: a partly routed connection\'s line runs from the track\'s end', () => {
    const doc = board();
    // A net's tracks taken up: its pads joined by connection lines; then one track part of the way
    const net = doc.prims.find((p): p is PcbTrack => p.kind === 'track' && p.net !== 0xffff)!.net;
    removePrims(doc, doc.prims.filter((p) => (p.kind === 'track' || p.kind === 'arc' || p.kind === 'via') && p.net === net)).apply();
    const c = connections(doc).find((k) => k.net === net)!;
    expect(c).toBeDefined();
    const pad = doc.prims.find((p): p is PcbPad => p.kind === 'pad' && p.at.x === c.a.x && p.at.y === c.a.y)!;
    const layer = pad.layer === L.MULTI ? L.TOP : pad.layer;
    const mid = { x: Math.round((c.a.x + c.b.x) / 2), y: Math.round((c.a.y + c.b.y) / 2) };
    addTracks(doc, [{ layer, a: c.a, b: mid, width: mil(10), net: c.net }]).apply();
    const smart = connectionLines(doc, true).filter((k) => k.net === c.net);
    const plain = connectionLines(doc, false).filter((k) => k.net === c.net);
    expect(plain.some((k) => (k.a.x === c.a.x && k.a.y === c.a.y) || (k.b.x === c.a.x && k.b.y === c.a.y))).toBe(true);
    expect(smart.some((k) => (k.a.x === mid.x && k.a.y === mid.y) || (k.b.x === mid.x && k.b.y === mid.y))).toBe(true);
  });

  it('the File Format Change Report: a newer board\'s own notes past Konium\'s level, an older board\'s changes since', () => {
    const newer = Array.from({ length: KONIUM_FORMAT_VERSIONS + 2 }, (_, i) => `V${i}`);
    const r = changeReport(formatVersions(versionInfo(newer)))!;
    expect(r).toMatchObject({ kind: 'newer', savedBy: `V${KONIUM_FORMAT_VERSIONS + 1}` });
    expect(r.notes).toEqual([`CAUTION - note ${KONIUM_FORMAT_VERSIONS}`, `CAUTION - note ${KONIUM_FORMAT_VERSIONS + 1}`]);
    const older = changeReport(formatVersions(versionInfo(Array.from({ length: 20 }, (_, i) => `V${i}`))))!;
    expect(older.kind).toBe('older');
    expect(older.notes.length).toBe(2);
    expect(changeReport(formatVersions(versionInfo(Array.from({ length: KONIUM_FORMAT_VERSIONS }, (_, i) => `V${i}`))))).toBeNull();
  });

  it('embedded fonts: read back as written, the font file inflated', async () => {
    const ttf = new Uint8Array(5000).map((_, i) => (i * 7) & 0xff);
    const root = newEntry('Root Entry', 'root');
    writeEmbeddedFonts(root, [{ name: 'Test Sans Bold', family: 'Test Sans', style: 'Bold', bold: true, italic: false, flag: 1, zlib: await deflateFont(ttf) }]);
    const back = readEmbeddedFonts(root);
    expect(back.map((f) => [f.name, f.family, f.style, f.bold, f.italic])).toEqual([['Test Sans Bold', 'Test Sans', 'Bold', true, false]]);
    expect(fontFile(back[0]!)).toEqual(ttf);
  });

  it('a drawing from another application as lines: paths (arcs, curves) and shapes, sized by its units', () => {
    expect(pathPolylines('M0 0 L10 0 L10 10 Z')[0]).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 }]);
    const arc = pathPolylines('M0 0 A5 5 0 0 1 10 0')[0]!;
    expect(arc.at(-1)).toEqual({ x: 10, y: 0 });
    expect(Math.min(...arc.map((v) => v.y))).toBeCloseTo(-5, 1);
    const s = svgStrokes('<svg width="1in" height="1in" viewBox="0 0 100 100"><rect x="0" y="0" width="100" height="50"/><circle cx="50" cy="50" r="10"/></svg>');
    expect(s.length).toBe(2);
    expect(Math.max(...s[0]!.map((v) => v.x)) - Math.min(...s[0]!.map((v) => v.x))).toBeCloseTo(1, 6);
    expect(svgStrokes('just text')).toEqual([]);
  });

  it('component pushing: Avoid stops short of another component; Push moves it clear along the move', () => {
    const doc = board();
    const [a, b] = doc.components;
    const ba = componentBox(doc, a!.index)!, bb = componentBox(doc, b!.index)!;
    // Move a onto b's centre
    const d = { x: (bb.minX + bb.maxX) / 2 - (ba.minX + ba.maxX) / 2, y: (bb.minY + bb.maxY) / 2 - (ba.minY + ba.maxY) / 2 };
    const t = avoidFraction(doc, [a!.index], (f) => placement(a!.at, 0, { x: d.x * f, y: d.y * f }));
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1);
    const sh = pushes(doc, [a!.index], placement(a!.at, 0, d), d);
    expect(sh.has(b!.index)).toBe(true);
    const s = sh.get(b!.index)!;
    expect(Math.sign(Math.abs(d.x) >= Math.abs(d.y) ? s.x : s.y)).toBe(Math.sign(Math.abs(d.x) >= Math.abs(d.y) ? d.x : d.y));
  });

  it('Shift Click To Select passes the kinds ticked by; overlapping objects are listed to choose from; autopan as set', () => {
    const ed = new PcbEditor(board()); ed.scene();
    const pad = ed.doc.prims.find((p): p is PcbPad => p.kind === 'pad' && p.net !== 0xffff)!;
    const units = ed.unitsAt(pad.at);
    expect(units.length).toBeGreaterThan(1);
    expect(units.some((u) => u.label.startsWith('Component '))).toBe(true);
    settings.pcbShiftClickSelect = true; settings.pcbShiftClickKinds = ['Component', 'Polygon', 'Track', '3D Body'];
    const kinds = ed.clickable(pad.at, false).map((h) => ed.unitKind(ed.keysFor(h.key), h.key));
    expect(kinds.some((k) => ['Component', 'Polygon', 'Track', '3D Body'].includes(k))).toBe(false);
    expect(ed.clickable(pad.at, true).length).toBe(ed.hits(pad.at).length);
    ed.setTool(null);
    expect(ed.autoPan()).toBeNull();
    (ed as unknown as { tool: unknown }).tool = {};
    expect(ed.autoPan()).toMatchObject({ style: 'speed', worldSpeed: mil(1200) });
    settings.pcbAutoPan = 'Re-Centre';
    expect(ed.autoPan()!.style).toBe('recenter');
  });
});
