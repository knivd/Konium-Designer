import { describe, expect, it } from 'vitest';
import { readSchDoc, writeSchDoc } from '../src/formats/altium/schdoc';
import { detect } from '../src/formats/registry';
import { cfbPut, newEntry } from '../src/formats/cfb/cfb';
import { HR, SR } from '../src/model/sch';
import { connectionPoints, harnessKind, wireList, wireListCsv } from '../src/model/harness';
import { PROJECT_FILE } from '../src/formats/altium/prjpcb';
import { docIcon } from '../src/app/icons';

const enc = (s: string) => new TextEncoder().encode(s);
const ascii = (head: string, recs: string[]) => enc([`|HEADER=${head}|WEIGHT=${recs.length}`, ...recs].join('\r\n') + '\r\n');

/** A wiring diagram: P1-1 and P2-1 to a splice; W2 in cable C1; both twisted together. */
const WIRING = ascii('Harness Wiring Diagram Binary File Version 1.0', [
  '|RECORD=104|UNIQUEID=SHEETAAA',
  '|RECORD=106|LOCATION.X=100|LOCATION.Y=100|UNIQUEID=CONAAAAA',
  '|RECORD=34|OWNERINDEX=1|TEXT=P1|LOCATION.X=100|LOCATION.Y=120',
  '|RECORD=113|OWNERINDEX=1|DESIGNATOR=1|NAME=1|LOCATION.X=110|LOCATION.Y=100|PINLENGTH=10|UNIQUEID=PINA1AAA',
  '|RECORD=106|LOCATION.X=400|LOCATION.Y=100|UNIQUEID=CONBBBBB',
  '|RECORD=34|OWNERINDEX=4|TEXT=P2|LOCATION.X=400|LOCATION.Y=120',
  '|RECORD=113|OWNERINDEX=4|DESIGNATOR=1|NAME=1|LOCATION.X=390|LOCATION.Y=100|PINLENGTH=10|UNIQUEID=PINB1BBB',
  '|RECORD=108|LOCATION.X=250|LOCATION.Y=100|TEXT=SPL1|SHOWNAME=T|UNIQUEID=SPLICEAA',
  '|RECORD=107|LOCATIONCOUNT=2|X1=120|Y1=100|X2=250|Y2=100|COLOR=255|UNIQUEID=WIREONEA|ENDVERTEX1CONNECTEDOBJECTUNIQUEID=PINA1AAA|ENDVERTEX2CONNECTEDOBJECTUNIQUEID=SPLICEAA',
  '|RECORD=34|OWNERINDEX=8|TEXT=W1|LOCATION.X=180|LOCATION.Y=105',
  '|RECORD=107|LOCATIONCOUNT=2|X1=380|Y1=100|X2=250|Y2=100|COLOR=65280|UNIQUEID=WIRETWOA|ENDVERTEX1CONNECTEDOBJECTUNIQUEID=PINB1BBB|ENDVERTEX2CONNECTEDOBJECTUNIQUEID=SPLICEAA|CONNECTEDCABLESUNIQUEIDSCOUNT=1|CONNECTEDCABLEUNIQUEID1=CABLEAAA',
  '|RECORD=34|OWNERINDEX=10|TEXT=W2|LOCATION.X=320|LOCATION.Y=105',
  '|RECORD=123|LOCATION.X=300|LOCATION.Y=90|CORNER.X=310|CORNER.Y=110|UNIQUEID=CABLEAAA',
  '|RECORD=118|LOCATION.X=200|LOCATION.Y=90|CORNER.X=210|CORNER.Y=110|UNIQUEID=TWISTAAA|CONNECTEDWIRESUNIQUEIDSCOUNT=2|CONNECTEDWIREUNIQUEID1=WIREONEA|CONNECTEDWIREUNIQUEID2=WIRETWOA',
]);

/** Its layout: P1 on CP1, the splice on CP3, P2 on CP4; bundles CP1–CP2 1000 mil, CP2–CP3 500, CP2–CP4 2000. */
const LAYOUT_RECORDS = [
  '|RECORD=105|UNIQUEID=SHEETBBB',
  '|RECORD=106|LOCATION.X=100|LOCATION.Y=300|UNIQUEID=LCONAAAA',
  '|RECORD=113|OWNERINDEX=1|DESIGNATOR=1|LOCATION.X=100|LOCATION.Y=300|UNIQUEID=LPINA1AA',
  '|RECORD=106|LOCATION.X=500|LOCATION.Y=300|UNIQUEID=LCONBBBB',
  '|RECORD=113|OWNERINDEX=3|DESIGNATOR=1|LOCATION.X=500|LOCATION.Y=300|UNIQUEID=LPINB1BB',
  '|RECORD=116|UNIQUEID=LSPLICEA|WIRINGDIAGRAMORIGINUNIQUEID=SPLICEAA',
  ...['CPONEAAA', 'CPTWOAAA', 'CPTHREEA', 'CPFOURAA'].map((u, i) => `|RECORD=110|LOCATION.X=${100 + i * 100}|LOCATION.Y=300|UNIQUEID=${u}`),
  '|RECORD=111|LOCATIONCOUNT=2|X1=100|Y1=300|X2=200|Y2=300|LENGTH=1000|LENGTH_FRAC=0|ENDVERTEX1CONNECTEDOBJECTUNIQUEID=CPONEAAA|ENDVERTEX2CONNECTEDOBJECTUNIQUEID=CPTWOAAA',
  '|RECORD=111|LOCATIONCOUNT=2|X1=200|Y1=300|X2=300|Y2=300|LENGTH=500|LENGTH_FRAC=0|ENDVERTEX1CONNECTEDOBJECTUNIQUEID=CPTWOAAA|ENDVERTEX2CONNECTEDOBJECTUNIQUEID=CPTHREEA',
  '|RECORD=111|LOCATIONCOUNT=2|X1=200|Y1=300|X2=400|Y2=300|LENGTH=1999|LENGTH_FRAC=50000|ENDVERTEX1CONNECTEDOBJECTUNIQUEID=CPTWOAAA|ENDVERTEX2CONNECTEDOBJECTUNIQUEID=CPFOURAA',
  '|RECORD=115|WIRINGDIAGRAMORIGINUNIQUEID=WIREONEA|ENDVERTEX1CONNECTEDOBJECTUNIQUEID=LPINA1AA|ENDVERTEX2CONNECTEDOBJECTUNIQUEID=LSPLICEA',
  '|RECORD=115|WIRINGDIAGRAMORIGINUNIQUEID=WIRETWOA|ENDVERTEX1CONNECTEDOBJECTUNIQUEID=LPINB1BB|ENDVERTEX2CONNECTEDOBJECTUNIQUEID=LSPLICEA',
  '|RECORD=124|WIRINGDIAGRAMORIGINUNIQUEID=CABLEAAA|DESIGNATOR=C1|COMMENT=3-CORE SCREENED',
];

/** The connection points' stream: [1, count, then each point, its objects and their pins], zlib after a length. */
async function pointsStream(map: [string, [string, string[]][]][]): Promise<Uint8Array> {
  const parts: number[] = [];
  const u32 = (v: number) => parts.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const id = (s: string) => parts.push(s.length, ...enc(s));
  u32(1); u32(map.length);
  for (const [cp, objs] of map) { id(cp); u32(objs.length); for (const [o, pins] of objs) { id(o); u32(pins.length); pins.forEach(id); } }
  const s = new Blob([Uint8Array.from(parts) as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  const z = new Uint8Array(await new Response(s).arrayBuffer());
  const out = new Uint8Array(4 + z.length);
  new DataView(out.buffer).setUint32(0, z.length, true);
  out.set(z, 4);
  return out;
}

async function layoutFile(): Promise<Uint8Array> {
  const doc = readSchDoc(ascii('Harness Layout Drawing Binary File Version 1.0', LAYOUT_RECORDS), 'H.LdrDoc');
  doc.asciiEol = null;
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'HarnessConnectionPointConnector', await pointsStream([
    ['CPONEAAA', [['LCONAAAA', ['LPINA1AA']]]], ['CPTHREEA', [['LSPLICEA', []]]], ['CPFOURAA', [['LCONBBBB', ['LPINB1BB']]]],
  ]));
  doc.cfb = { root, majorVersion: 3 };
  return writeSchDoc(doc);
}

describe('Harness documents (.WirDoc, .LdrDoc)', () => {
  it('read as schematics of their own records: the sheet, connectors as parts with pins, wires, splices, cables, twists', () => {
    expect(detect(WIRING, 'H.WirDoc')).toBe('SchDoc');
    const w = readSchDoc(WIRING, 'H.WirDoc');
    expect(harnessKind(w)).toBe('wiring');
    expect(w.diags.items.filter((d) => d.level !== 'info')).toEqual([]);
    expect(w.objects[0]!.record).toBe(SR.SHEET);
    const p1 = w.objects[1]!;
    expect(p1.kind === 'component' && p1.designator).toBe('P1');
    expect(w.objects[3]!.kind).toBe('pin');
    expect(w.objects[7]).toMatchObject({ kind: 'splice', name: 'SPL1', point: false });
    expect(w.objects[8]!.kind).toBe('polyline');
    expect(w.objects[12]!.kind).toBe('rect');
    expect(w.objects.filter((o) => o.kind === 'component')).toHaveLength(2);
  });

  it('the wire list: ends by connector pin or splice, colour, cable, twist; lengths along the layout\'s bundles', async () => {
    const w = readSchDoc(WIRING, 'H.WirDoc');
    expect(wireList(w).map((r) => [r.wire, r.from, r.to, r.colour, r.cable, r.twisted, r.length])).toEqual([
      ['W1', 'P1-1', 'SPL1', 255, '', true, undefined],
      ['W2', 'P2-1', 'SPL1', 65280, 'CABLEAAA', true, undefined],
    ]);
    const bytes = await layoutFile();
    expect(detect(bytes, 'H.LdrDoc')).toBe('SchDoc');
    const l = readSchDoc(bytes, 'H.LdrDoc');
    expect(harnessKind(l)).toBe('layout');
    expect(connectionPoints(l).get('LPINB1BB')).toBe('CPFOURAA');
    const rows = wireList(w, l);
    expect(rows.map((r) => [r.wire, r.cable, r.length!.toFixed(3)])).toEqual([['W1', '', '38.100'], ['W2', 'C1 3-CORE SCREENED', '63.487']]);
    // 1000 + 500 mil; 1999.5 + 500 mil
    expect(wireListCsv(rows).split('\r\n')).toEqual([
      'Wire,From,To,Colour,Cable,Shield,Twisted,Length (mm)',
      'W1,P1-1,SPL1,#FF0000,,No,Yes,38.1',
      'W2,P2-1,SPL1,#00FF00,C1 3-CORE SCREENED,No,Yes,63.5',
      '',
    ]);
  });

  it('a harness project is a project; its files have icons of their own', () => {
    expect(PROJECT_FILE.test('Loom.PrjHar')).toBe(true);
    expect([docIcon('Loom.PrjHar'), docIcon('A.WirDoc'), docIcon('A.LdrDoc'), docIcon('A.HarDwf')]).toEqual(['prjhar', 'wirDoc', 'ldrDoc', 'draftDoc']);
    expect(HR.WIRE).toBe(107);
  });
});
