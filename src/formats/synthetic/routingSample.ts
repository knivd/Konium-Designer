/**
 * A board to try the Smart Router on (Tools › Smart Router, 26.193): the Layout Planner's example
 * board (a small USB sensor node of 50 × 30 mm on two layers: Konium's own, drawn in
 * layoutSample.ts) with its parts placed and nothing routed. The parts are put where they stand by
 * the planner's own placer, from a plan written here as a model writes one.
 */
import { LAYOUT } from '../../ai/jobs';
import { readPcbDoc, writePcbDoc } from '../altium/pcbdoc';
import { planOnBoard } from '../../model/layoutPlan';
import { placeByPlan } from '../../model/planPlace';
import { moveComponentsEach } from '../../model/pcbEdit';
import type { PcbDocument } from '../../model/pcb';
import { layoutSampleBytes } from './layoutSample';

export const ROUTING_SAMPLE = { name: 'Routing Example.PcbDoc' };

/** The example board's layout, as a plan: the supply at the left, the microcontroller in the middle, the sensor top right, the debug header at the bottom. */
export const LAYOUT_SAMPLE_PLAN = {
  summary: 'A small USB sensor node: power comes in at the left, the microcontroller sits in the middle, the sensor away from the regulator, the headers at the edges.',
  groups: [
    { name: 'USB input and regulator', why: 'The cable\'s power comes in here and is regulated before it goes on.', parts: ['J1', 'U1', 'C1', 'C2'], main: 'J1', x: 0.12, y: 0.5, side: 'top' },
    { name: 'Microcontroller', why: 'The microcontroller with its decoupling, crystal and reset.', parts: ['U2', 'C3', 'C4', 'C5', 'C6', 'Y1', 'C7', 'C8', 'R1'], main: 'U2', x: 0.5, y: 0.5, side: 'top' },
    { name: 'Sensor', why: 'The sensor with its pull-ups, away from the regulator\'s heat.', parts: ['U3', 'C9', 'R2', 'R3'], main: 'U3', x: 0.78, y: 0.82, side: 'top' },
    { name: 'Debug and indicator', why: 'The debug header and the LED, where they can be reached.', parts: ['J3', 'D1', 'R4'], main: 'J3', x: 0.62, y: 0.1, side: 'top' },
    { name: 'UART header', why: 'Fixed at the right edge.', parts: ['J2'], main: 'J2', x: 0.94, y: 0.5, side: 'top' },
  ],
  edges: [{ part: 'J1', edge: 'left', along: 0.5, why: 'The USB cable plugs in from the left.' }, { part: 'J3', edge: 'bottom', along: 0.6, why: 'The debug probe plugs in from below.' }],
  near: [
    { part: 'C1', to: 'U1-3', mm: 3 }, { part: 'C2', to: 'U1-2', mm: 3 }, { part: 'C3', to: 'U2-1', mm: 2 }, { part: 'C4', to: 'U2-17', mm: 2 }, { part: 'C5', to: 'U2-32', mm: 2 },
    { part: 'C6', to: 'U2-5', mm: 2 }, { part: 'Y1', to: 'U2-2', mm: 5 }, { part: 'C7', to: 'Y1', mm: 3 }, { part: 'C8', to: 'Y1', mm: 3 }, { part: 'R1', to: 'U2-4', mm: 5 },
    { part: 'C9', to: 'U3-1', mm: 2 }, { part: 'R4', to: 'D1', mm: 4 },
  ],
  apart: [{ a: 'U1', b: 'U3', mm: 15 }],
  clear: [{ part: 'J1', mm: 1 }],
  notes: [],
};

/** The example board with its parts placed by that plan. */
export async function routingSampleDoc(): Promise<PcbDocument> {
  const doc = readPcbDoc(layoutSampleBytes(), ROUTING_SAMPLE.name);
  const plan = LAYOUT.check(LAYOUT_SAMPLE_PLAN, { board: '', brief: '', parts: doc.components.map((c) => c.designator), previous: '', result: '', remarks: '' });
  const on = planOnBoard(doc, plan, 'unlocked');
  if (on) {
    const r = await placeByPlan(doc, plan, on, 'unlocked');
    if (r.moves.length) moveComponentsEach(doc, r.moves).apply();
  }
  return doc;
}

export const routingSampleBytes = async (): Promise<Uint8Array> => writePcbDoc(await routingSampleDoc());
