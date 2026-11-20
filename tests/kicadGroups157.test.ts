import { describe, expect, it } from 'vitest';
import { importKicad } from '../src/formats/kicad/project';
import { exportKicad } from '../src/formats/kicad/export';
import { encodeTrack, readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { carryPrimInfo } from '../src/formats/altium/primInfo';
import { groupMembers } from '../src/formats/kicad/board';
import { kuuid } from '../src/formats/kicad/write';
import { keptId } from '../src/formats/kicad/kept';
import { parseSexpr, kid, kids, num, str, type SList } from '../src/formats/kicad/sexpr';
import type { PcbDocument } from '../src/model/pcb';
import { PCB, PRO, SCH } from './fixtures/kicadMini';

/**
 * R9: KiCad's groups and generated objects (tuning patterns) come back. The items they name keep
 * their uuids; a tuning pattern goes back while all its tracks are there unchanged (else its tracks
 * alone), a group with the members that are there (groups of groups too).
 */

const enc = (s: string) => new TextEncoder().encode(s);
const td = new TextDecoder();
const U = (k: string, n: number) => `${k.repeat(8)}-0000-0000-0000-00000000000${n}`;
const EXTRA = `
 (footprint "MountingHole:Hole" (layer "F.Cu") (uuid "${U('c', 1)}") (at 135 75) (attr through_hole board_only exclude_from_bom)
   (property "Reference" "H8" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
   (property "Value" "Hole" (at 0 2 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
   (pad "" np_thru_hole circle (at 0 0) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask")))
 (segment (start 112 82) (end 114 82) (width 0.2) (layer "F.Cu") (net 0) (uuid "${U('d', 1)}"))
 (segment (start 114 82) (end 116 82) (width 0.2) (layer "F.Cu") (net 0) (uuid "${U('d', 2)}"))
 (gr_line (start 102 72) (end 104 72) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "${U('e', 1)}"))
 (generated (uuid "${U('f', 1)}") (type tuning_pattern) (name "Tuning Pattern") (layer "F.Cu")
   (base_line (pts (xy 112 82) (xy 116 82))) (corner_radius_percent 80) (end (xy 116 82)) (initial_side "left")
   (origin (xy 112 82)) (rounded yes) (target_length 4) (tuning_mode "single") (members "${U('d', 1)}" "${U('d', 2)}"))
 (group "parts" (uuid "${U('f', 2)}") (locked yes) (members "${U('c', 1)}" "${U('e', 1)}" "${U('f', 1)}" "${U('9', 9)}"))
 (group "" (uuid "${U('f', 3)}") (members "${U('f', 2)}"))`;

async function board(): Promise<PcbDocument> {
  const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(SCH) }, { path: 'mini/mini.kicad_pcb', bytes: enc(PCB.replace(/\)\s*$/, `${EXTRA})`)) }]);
  // Saved and opened again on the way, as a project would be
  return readPcbDoc(writePcbDoc(readPcbDoc(r.projects[0]!.documents.find((d) => d.name === 'mini.PcbDoc')!.bytes, 'mini.PcbDoc')), 'mini.PcbDoc');
}
const exported = (doc: PcbDocument) => exportKicad({ name: 'mini', sheets: [], board: doc });
const text = (doc: PcbDocument) => td.decode(exported(doc).files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes);
const uuidOf = (n: SList) => str(kid(n, 'uuid'), 0);
const members = (n: SList | undefined) => (kid(n, 'members')?.items ?? []).map(String);
const byId = (pcb: SList, k: string, id: string) => kids(pcb, k).find((n) => uuidOf(n) === id);

describe('KiCad round trip: groups and tuning patterns (R9)', () => {
  it('reads the members a board\'s groups name, quoted or bare, across lines', () => {
    expect([...groupMembers('(group "" (uuid "g") (members "a" "b"\n\t\t"c"))\n(group x (id g2) (members 5e2f d))')]).toEqual(['a', 'b', 'c', '5e2f', 'd']);
    // A uuid kept from KiCad is itself; any other seed still makes one
    expect(kuuid(U('d', 1))).toBe(U('d', 1));
    expect(kuuid('free:Tracks6:1:0')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });

  it('the tuning pattern, the groups and the items they name come back with their uuids', async () => {
    const t = text(await board());
    const pcb = parseSexpr(t);
    // The items keep theirs: the footprint, both tracks, the board line
    expect(uuidOf(kids(pcb, 'footprint').find((f) => kids(f, 'property').some((p) => str(p, 1) === 'H8'))!)).toBe(U('c', 1));
    const s1 = byId(pcb, 'segment', U('d', 1))!, s2 = byId(pcb, 'segment', U('d', 2));
    expect(s1 && s2).toBeTruthy();
    expect(byId(pcb, 'gr_line', U('e', 1))).toBeTruthy();
    // The tuning pattern: its members, its places moved with the board (its base line starts on its first track)
    const gen = byId(pcb, 'generated', U('f', 1))!;
    expect(members(gen)).toEqual([U('d', 1), U('d', 2)]);
    const p0 = kids(kid(kid(gen, 'base_line'), 'pts'), 'xy')[0]!, st = kid(s1, 'start')!;
    expect([num(p0, 0) - num(st, 0), num(p0, 1) - num(st, 1)].map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0]);
    // Quoted as KiCad writes them: its words, but its type and yes and no
    expect(t).toContain('(type tuning_pattern)');
    expect(t).toContain('(initial_side "left")');
    expect(t).toContain('(rounded yes)');
    // The group: what is there of its members (the one no item has, left out), locked still; the group of it too
    const g = byId(pcb, 'group', U('f', 2))!;
    expect(str(g, 0)).toBe('parts');
    expect(members(g)).toEqual([U('c', 1), U('e', 1), U('f', 1)]);
    expect(str(kid(g, 'locked'), 0)).toBe('yes');
    expect(members(byId(pcb, 'group', U('f', 3)))).toEqual([U('f', 2)]);
    // Each uuid once
    const ids = t.match(/\(uuid "[^"]+"\)/g) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a track of the pattern changed in Konium: its tracks alone, the group without it', async () => {
    const doc = await board();
    const p = doc.prims.find((x) => keptId(doc, x)?.id === U('d', 1));
    if (!p || p.kind !== 'track') throw new Error('no track');
    // Moved, as an edit does: a record of its own, taking the old one's entries
    const store = doc.streams.get(p.src.storage)!;
    const old = store.records[p.src.index]!;
    const rec = encodeTrack({ layer: p.layer, a: { x: p.a.x, y: p.a.y + 20000 }, b: { x: p.b.x, y: p.b.y + 20000 }, width: p.width });
    carryPrimInfo(old, rec);
    store.records[p.src.index] = rec;
    const r = exported(doc);
    const pcb = parseSexpr(td.decode(r.files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes));
    expect(kids(pcb, 'generated')).toHaveLength(0);
    // Both tracks still there, with their uuids
    expect(byId(pcb, 'segment', U('d', 1)) && byId(pcb, 'segment', U('d', 2))).toBeTruthy();
    expect(members(byId(pcb, 'group', U('f', 2)))).toEqual([U('c', 1), U('e', 1)]);
    expect(r.messages.some((m) => /Tuning patterns/.test(m.message))).toBe(true);
  });
});
