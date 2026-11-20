/**
 * Signal Integrity's screening of a net (both edges, unterminated) against its limits, and the
 * context it runs in: the setup, the parts' types and models and the schematic's pin types — given
 * by the app for the board in front (the project's setup and the schematic), the defaults without.
 */
import { failures, type SiFailure, type SiLimits, type Stimulus, DEFAULT_STIMULUS } from './rules';
import { runEdge, type EdgeMeasures } from './screen';
import type { SiContext, SiNetwork } from './topology';
import type { PcbDocument } from '../model/pcb';

export type SiStatus = 'Passed' | 'Failed' | 'Not analysed' | 'Analysis errors';
export interface SiNetResult {
  net: string;
  status: SiStatus;
  reason?: string;
  rising?: EdgeMeasures; falling?: EdgeMeasures;
  length?: number; zMin?: number; zMax?: number; estimated?: boolean;
  driver?: string; receivers?: string[];
  fails: SiFailure[];
}

/** A net's screening: its network (or why it has none) run on both edges and held to the limits. */
export function screenNet(net: string, nw: SiNetwork | string, limits: SiLimits): SiNetResult {
  if (typeof nw === 'string') return { net, status: 'Not analysed', reason: nw, fails: [] };
  try {
    const r = runEdge(nw, 'rising'), f = runEdge(nw, 'falling');
    const res: SiNetResult = {
      net, status: 'Passed', rising: r.worst, falling: f.worst, length: nw.length, zMin: nw.zMin, zMax: nw.zMax, estimated: nw.estimated,
      driver: `${nw.driver.designator}-${nw.driver.pin}`, receivers: nw.receivers.map((x) => `${x.designator}-${x.pin}`), fails: [],
    };
    res.fails = failures({ rising: r.worst, falling: f.worst, zMin: nw.zMin, zMax: nw.zMax }, limits);
    if (res.fails.length) res.status = 'Failed';
    return res;
  } catch (e) {
    return { net, status: 'Analysis errors', reason: (e as Error).message, fails: [] };
  }
}

/** The defaults: 50 Ω tracks of 2000 mil on average (schematic only), CMOS-3.3V ICs [AD's Setup Options defaults]. */
export const defaultSiContext = (): SiContext => ({ setup: { trackZ: 50, avgLength: 20_000_000, tech: 'CMOS-3.3V', supplies: new Map() }, models: new Map() });

/** What the app adds for a board: the project's setup and models, the schematic's pin types (set at start). */
export interface SiProvided { ctx: SiContext; tolerances: SiLimits; stimulus: Stimulus }
let provider: ((doc: PcbDocument | null) => SiProvided) | null = null;
export function setSiProvider(f: (doc: PcbDocument | null) => SiProvided): void { provider = f; }
export function siProvided(doc: PcbDocument | null): SiProvided {
  try { if (provider) return provider(doc); } catch { /* the defaults */ }
  return { ctx: defaultSiContext(), tolerances: {}, stimulus: DEFAULT_STIMULUS };
}
