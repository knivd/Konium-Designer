/**
 * The parts library's example part (R21): Konium's own, not a maker's. A made-up low-dropout
 * regulator in an eight-lead small-outline package, with its symbol and its footprint by
 * IPC-7351B, made the way the Component Builder makes a part, so the shelf can be tried (and
 * tested, and pictured) without a datasheet or a model.
 */
import { buildSymbol } from '../ai/symbol';
import type { PinsRead, SymbolPin } from '../ai/jobs';
import { ipcDefaults, ipcFootprint, ipcRecords } from './ipcFootprint';
import { makePart, type PartPackage } from './partPackage';

export const EXAMPLE_PART = { mpn: 'KD-EX1833-SO8', maker: 'Konium (example)', device: 'KD-EX1833', description: 'Example part: 3.3 V 300 mA low-dropout regulator with enable, SO-8' };

const pin = (number: string, name: string, type: SymbolPin['type'], description: string): SymbolPin => ({ number, name, type, activeLow: false, group: '', description });
const PINS: PinsRead = {
  kind: 'ic', prefix: 'U', pages: [], notes: '',
  pins: [
    pin('1', 'OUT', 'power', 'Regulated output'), pin('2', 'SENSE', 'input', 'Output voltage sense'), pin('3', 'NC', 'nc', 'Not connected'), pin('4', 'GND', 'ground', 'Ground'),
    pin('5', 'EN', 'input', 'Enable, active high'), pin('6', 'NC', 'nc', 'Not connected'), pin('7', 'PG', 'oc', 'Power good, open drain'), pin('8', 'IN', 'power', 'Supply input'),
  ],
};

export function examplePart(app: string, at = new Date(Date.UTC(2026, 10, 19))): PartPackage {
  const spec = ipcDefaults('SOIC');
  const fp = ipcFootprint(spec);
  const symbol = buildSymbol(PINS, { name: EXAMPLE_PART.mpn, description: EXAMPLE_PART.description, footprint: fp.name });
  return makePart({
    ...EXAMPLE_PART, packageName: 'SO-8', from: 'ipc', symbol,
    footprint: { name: fp.name, description: `${EXAMPLE_PART.maker} ${EXAMPLE_PART.device} SO-8: ${fp.description || 'pads by IPC-7351B'}`.slice(0, 250), height: `${(fp.height / 0.0254).toFixed(2)}mil`, records: ipcRecords(fp, spec) },
    pins: PINS.pins.map((p) => ({ number: p.number, name: p.name, type: p.type })),
    datasheet: { url: '', title: '', sha256: '', pages: 0, pinPages: [], packagePages: [] },
    app, by: 'Konium\'s example', at,
  });
}
