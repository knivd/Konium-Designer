import { isCfb, readCfb, writeCfb, cfbFind, cfbStream, type CfbFile } from './cfb/cfb';
import { readSchDoc, writeSchDoc } from './altium/schdoc';
import { readPcbDoc, writePcbDoc } from './altium/pcbdoc';
import { isPcbAscii, readPcbAscii, writePcbAscii } from './altium/pcbAscii';
import { isPcb5, pcb5To6 } from './altium/pcb5';
import { readPrjPcb, writePrjPcb, type PrjPcb } from './altium/prjpcb';
import { bytesToBin } from './text';
import type { DocKind } from '../model/common';
import type { SchDocument } from '../model/sch';
import type { PcbDocument } from '../model/pcb';
import { openPcbLib, writePcbLibDoc, type PcbLibDocument } from '../model/pcbLib';
import { openSchLib, writeSchLibDoc, type SchLibDocument } from '../model/schLib';
import { readOutJob, writeOutJob, type OutJobDocument } from './altium/outjob';
import { readBomDoc, writeBomDoc, type BomDocument } from './altium/bomdoc';
import { readDbLink, writeDbLink, type DbLinkDocument } from './altium/dblink';
import { readDbLib, writeDbLib, type DbLibDocument } from './altium/dblib';
import { SIM_TEXT_EXT, readSimText, writeSimText, type SimTextDocument } from '../sim/simText';
import { isSimData, readSimData, writeSimData, type SimDataDocument } from '../sim/simData';
import { readStepDoc, writeStepDoc, type StepDocument } from '../model/stepDoc';
import { isCamText, readCam, writeCam, type CamDocument } from './cam/camDoc';
import { isPcbDwf, readPcbDwf, writePcbDwf, type DraftDocument } from './altium/pcbdwf';
import { isDrawio, readDrawio, writeDrawio, type DrawioDocument } from './drawio';
import { isEnclosure, readEnclosure, writeEnclosure, type EnclosureDocument } from './enclosureDoc';
import { isReqDoc, readReqDoc, writeReqDoc, type ReqDocument } from './reqDoc';
import { isZip, readMbaDoc, readMbsDoc, writeMbaDoc, writeMbsDoc, type MbaDocument, type MbsDocument } from './altium/multiboard';

/** A container we can only inspect (libraries, unknown CFB). */
export interface InspectOnly { kind: 'Inspect'; name: string; detected: DocKind; cfb: CfbFile | null }

export type LoadedDoc = SchDocument | PcbDocument | PcbLibDocument | SchLibDocument | PrjPcb | OutJobDocument | BomDocument | DbLinkDocument | DbLibDocument | StepDocument | SimTextDocument | SimDataDocument | CamDocument | DraftDocument | MbsDocument | MbaDocument | DrawioDocument | EnclosureDocument | ReqDocument | InspectOnly;

const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

/** Detect by content first, extension second. */
export function detect(bytes: Uint8Array, name: string): DocKind {
  if (isCfb(bytes)) {
    try {
      const { root } = readCfb(bytes);
      if (cfbFind(root, 'Board6') || isPcb5(root)) return 'PcbDoc';
      if (cfbFind(root, 'Library')) return 'PcbLib';
      const fh = cfbStream(root, 'FileHeader');
      if (fh) {
        const head = bytesToBin(fh.subarray(0, 200));
        if (/Schematic Capture/i.test(head)) return 'SchDoc';
        if (/Schematic Library/i.test(head)) return 'SchLib';
        // AD's harness documents are schematic files of their own records
        if (/Harness (Wiring Diagram|Layout Drawing)/i.test(head)) return 'SchDoc';
      }
      if (root.children.some((c) => /^(SchLib|PCBLib)$/i.test(c.name))) return 'IntLib';
    } catch { /* fall through */ }
  } else {
    // Multi-board schematics and assemblies: ZIPs of JSON
    if (isZip(bytes) && ext(name) === 'mbsdoc') return 'MbsDoc';
    if (isZip(bytes) && ext(name) === 'mbadoc') return 'MbaDoc';
    // A diagram: Konium's own (.DgmDoc), or one in the same XML from elsewhere (.drawio)
    if (ext(name) === 'dgmdoc' || ext(name) === 'drawio' || isDrawio(bytes)) return 'Diagram';
    // An enclosure (Konium's enclosure designer)
    if (ext(name) === 'enclosure' || isEnclosure(bytes)) return 'Enclosure';
    // A project's requirements (Konium's requirements documents)
    if (ext(name) === 'reqdoc' || isReqDoc(bytes)) return 'ReqDoc';
    // A Draftsman document: LZ4 chunks of its XML
    if ((bytes[0] === 1 || bytes[0] === 0) && (ext(name) === 'pcbdwf' || isPcbDwf(bytes)) && isPcbDwf(bytes)) return 'Draftsman';
    const head = bytesToBin(bytes.subarray(0, 64));
    if (head.startsWith('|HEADER=')) return /Library/i.test(head) ? 'SchLib' : 'SchDoc';
    if (isPcbAscii(bytes)) return 'PcbDoc';
    if (/^\s*\[Design\]/m.test(bytesToBin(bytes.subarray(0, 4096))) || ext(name) === 'prjpcb') return 'PrjPcb';
    if (/^\s*\[OutputJobFile\]/.test(head) || ext(name) === 'outjob') return 'OutJob';
    if (/^\s*\[ActiveBOM\]/.test(head) || /^\|RECORD=BOM\|/.test(head) || ext(name) === 'bomdoc') return 'BomDoc';
    // Libraries and links share a layout: a library names its database type (and search paths) in [DatabaseLinks]
    if (ext(name) === 'dblib' || ext(name) === 'svndblib') return 'DbLib';
    if (ext(name) === 'dblink') return 'DbLink';
    if (/^\s*\[(DatabaseLinks|OutputDatabaseLinkFile)\]/.test(head)) return /^LibraryDatabaseType=|^LibrarySearchPath=/m.test(bytesToBin(bytes.subarray(0, 8192))) ? 'DbLib' : 'DbLink';
    if (/^\s*ISO-10303-21\s*;/.test(head) || ext(name) === 'step' || ext(name) === 'stp' || ext(name) === 'stl') return 'StepDoc';
    // Simulation: results (SPICE raw text) and netlists, models and subcircuits by their extension
    if (ext(name) === 'sdf' || isSimData(bytesToBin(bytes.subarray(0, 2000)))) return 'SimData';
    if (SIM_TEXT_EXT.test(name)) return 'SimText';
    // A CAM document Konium saved [est: AD's own .Cam files are binary, and inspected only]
    if (isCamText(bytesToBin(bytes.subarray(0, 400)))) return 'CamDoc';
  }
  return ({ schdoc: 'SchDoc', pcbdoc: 'PcbDoc', prjpcb: 'PrjPcb', schlib: 'SchLib', pcblib: 'PcbLib', intlib: 'IntLib', outjob: 'OutJob', bomdoc: 'BomDoc', dblink: 'DbLink', dblib: 'DbLib', svndblib: 'DbLib' } as Record<string, DocKind>)[ext(name)] ?? 'Unknown';
}

export function load(input: Uint8Array, name: string): LoadedDoc {
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength); // normalise Node Buffers
  const kind = detect(bytes, name);
  switch (kind) {
    case 'SchDoc': return readSchDoc(bytes, name);
    case 'PcbDoc': {
      if (!isCfb(bytes)) return readPcbAscii(bytes, name);
      // A board in the binary format before the present one: read as the present one (formats/altium/pcb5)
      const cfb = readCfb(bytes);
      if (!isPcb5(cfb.root)) return readPcbDoc(bytes, name);
      const doc = readPcbDoc(writeCfb(pcb5To6(cfb)), name);
      doc.diags.info('A PCB 5.0 binary board: read as the present format, and saved in it from now on');
      return doc;
    }
    case 'PrjPcb': return readPrjPcb(bytes, name);
    case 'PcbLib': return openPcbLib(bytes, name);
    case 'SchLib': if (isCfb(bytes)) return openSchLib(bytes, name); break;
    case 'OutJob': return readOutJob(bytes, name);
    case 'BomDoc': return readBomDoc(bytes, name);
    case 'DbLink': return readDbLink(bytes, name);
    case 'DbLib': return readDbLib(bytes, name);
    case 'StepDoc': return readStepDoc(bytes, name);
    case 'SimText': return readSimText(bytes, name);
    case 'SimData': return readSimData(new TextDecoder().decode(bytes), name);
    case 'CamDoc': return readCam(new TextDecoder().decode(bytes), name);
    case 'Draftsman': return readPcbDwf(bytes, name);
    case 'MbsDoc': return readMbsDoc(bytes, name);
    case 'Diagram': return readDrawio(bytes, name);
    case 'Enclosure': return readEnclosure(bytes, name);
    case 'ReqDoc': return readReqDoc(bytes, name);
    case 'MbaDoc': return readMbaDoc(bytes, name);
  }
  return { kind: 'Inspect', name, detected: kind, cfb: isCfb(bytes) ? readCfb(bytes) : null };
}

export function save(doc: LoadedDoc): Uint8Array {
  switch (doc.kind) {
    case 'SchDoc': return writeSchDoc(doc);
    case 'PcbDoc': return doc.ascii ? writePcbAscii(doc).bytes : writePcbDoc(doc);
    case 'PrjPcb': return writePrjPcb(doc);
    case 'PcbLib': return writePcbLibDoc(doc);
    case 'SchLib': return writeSchLibDoc(doc);
    case 'OutJob': return writeOutJob(doc);
    case 'BomDoc': return writeBomDoc(doc);
    case 'DbLink': return writeDbLink(doc);
    case 'DbLib': return writeDbLib(doc);
    case 'StepDoc': return writeStepDoc(doc);
    case 'SimText': return writeSimText(doc);
    case 'SimData': return new TextEncoder().encode(writeSimData(doc));
    case 'CamDoc': return new TextEncoder().encode(writeCam(doc));
    case 'Draftsman': return writePcbDwf(doc);
    case 'MbsDoc': return writeMbsDoc(doc);
    case 'Diagram': return writeDrawio(doc);
    case 'Enclosure': return writeEnclosure(doc);
    case 'ReqDoc': return writeReqDoc(doc);
    case 'MbaDoc': return writeMbaDoc(doc);
    default: throw new Error(`${doc.name}: saving ${doc.detected} is not supported yet`);
  }
}

export const canSave = (doc: LoadedDoc): boolean => doc.kind !== 'Inspect';
