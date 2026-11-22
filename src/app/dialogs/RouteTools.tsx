/**
 * The dialogs of 26.038's routing tools [est: laid out from AD17's, without screenshots]:
 * Interactive Length Tuning (Tab while tuning), Differential Pair / Multi-Routing properties (Tab
 * while routing them), Add Stitching to Net, Add Shielding to Net, Chamfered
 * Path, Shove Depth, Resize Polygon, and Configure Pin Swapping.
 */
import { useState } from 'preact/hooks';
import { netRouting } from '../../model/autoroute';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify } from '../state';
import { settings, updateSettings, type Settings } from '../../core/settings';
import { formatCoord } from '../../core/units';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import type { BusRouteTool } from '../../editors/pcb/BusRouteTool';
import { Check, LenInput, NetSelect, Row } from './pcbFields';
import { NO_NET, type PcbPad } from '../../model/pcb';
import { ruleTarget } from '../../model/lengthTune';
import { padsOf, partSwapOn, pinSwapOn, swapInfo, withSwapInfo, type SwapInfo } from '../../model/pinSwap';
import { replaceRecords, setComponentProps } from '../../model/pcbEdit';
import { ROUTE_MODES } from '../../editors/pcb/RouteTool';
import { numIn } from './numIn';

const mil = (n: number) => Math.round(n * 10_000);
const toMil = (c: number) => +(c / 10_000).toFixed(4);
const footer = (ok: () => void, okLabel = 'OK') => <><span class="spacer" /><button class="btn default" onClick={ok}>{okLabel}</button><button class="btn" onClick={closeDialog}>Cancel</button></>;

/** Interactive Length Tuning: the target and the accordion pattern. */
export function LengthTuningDialog({ ed, net, onDone }: { ed: PcbEditor; net: number; onDone?: () => void }) {
  const [s, setS] = useState(() => ({ ...settings }));
  const put = (p: Partial<Settings>) => setS({ ...s, ...p });
  const rule = net !== NO_NET ? ruleTarget(ed.doc, net) : null;
  const nets = [...ed.doc.nets].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const ok = () => {
    updateSettings({ pcbTuneTarget: s.pcbTuneTarget, pcbTuneManual: s.pcbTuneManual, pcbTuneFromNet: s.pcbTuneFromNet, pcbTuneStyle: s.pcbTuneStyle,
      pcbTuneAmplitude: s.pcbTuneAmplitude, pcbTuneSpace: s.pcbTuneSpace, pcbTuneMiter: s.pcbTuneMiter, pcbTuneAmplitudeInc: s.pcbTuneAmplitudeInc, pcbTuneSpaceInc: s.pcbTuneSpaceInc });
    closeDialog(); onDone?.();
  };
  const len = (label: string, k: keyof Settings, min = 0) => <Row label={label}><LenInput ed={ed} label={label} value={mil(s[k] as number)} min={min} onChange={(v) => put({ [k]: toMil(v) } as Partial<Settings>)} /></Row>;
  return (
    <Dialog title="Interactive Length Tuning" width={520} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok)}>
      <div class="tune-grid">
        <fieldset class="pd-group"><legend>Target Length</legend>
          <label class="pd-radio"><input type="radio" name="tt" checked={s.pcbTuneTarget === 'manual'} onChange={() => put({ pcbTuneTarget: 'manual' })} /> Manual</label>
          {len('Target Length', 'pcbTuneManual', 1)}
          <label class="pd-radio"><input type="radio" name="tt" checked={s.pcbTuneTarget === 'net'} onChange={() => put({ pcbTuneTarget: 'net' })} /> From Net</label>
          <Row label="Net"><select aria-label="From Net" value={s.pcbTuneFromNet} onChange={(e) => put({ pcbTuneFromNet: (e.target as HTMLSelectElement).value })}>
            <option value="">(choose)</option>{nets.map((n) => <option key={n.index}>{n.name}</option>)}</select></Row>
          <label class="pd-radio"><input type="radio" name="tt" checked={s.pcbTuneTarget === 'rules'} onChange={() => put({ pcbTuneTarget: 'rules' })} /> From Rules</label>
          <p class="muted small">{rule ? `${formatCoord(rule.target, ed.units())} (${rule.why})` : 'No Length or Matched Lengths rule applies'}</p>
        </fieldset>
        <fieldset class="pd-group"><legend>Accordion Pattern</legend>
          <Row label="Style"><select aria-label="Style" value={s.pcbTuneStyle} onChange={(e) => put({ pcbTuneStyle: (e.target as HTMLSelectElement).value as Settings['pcbTuneStyle'] })}>
            <option value="mitered">Mitered Lines</option><option value="arcs">Mitered Arcs</option><option value="rounded">Rounded</option></select></Row>
          <Row label="Miter"><input type="number" class="pd-val" aria-label="Miter" min={0} max={100} value={s.pcbTuneMiter} onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => put({ pcbTuneMiter: Math.max(0, Math.min(100, numIn(e, s.pcbTuneMiter))) })} /> %</Row>
          {len('Max Amplitude', 'pcbTuneAmplitude', 1)}
          {len('Space', 'pcbTuneSpace', 1)}
          {len('Amplitude Increment', 'pcbTuneAmplitudeInc', 1)}
          {len('Space Increment', 'pcbTuneSpaceInc', 1)}
        </fieldset>
      </div>
    </Dialog>
  );
}

/** Tab while routing a pair or a bus: width and gap (the rules' or typed) and the conflict mode. */
export function BusRoutingDialog({ ed, tool }: { ed: PcbEditor; tool: BusRouteTool }) {
  const [w, setW] = useState<number | null>(tool.userWidth);
  const [g, setG] = useState<number | null>(tool.userGap);
  const [mode, setMode] = useState(settings.pcbRoutingMode);
  const ok = () => { tool.userWidth = w; tool.userGap = g; updateSettings({ pcbRoutingMode: mode }); closeDialog(); ed.invalidateOverlay(); };
  const title = tool.kind === 'pair' ? 'Interactive Differential Pair Routing' : 'Interactive Multi-Routing';
  return (
    <Dialog title={title} width={420} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok)}>
      <fieldset class="pd-group"><legend>{tool.kind === 'pair' ? 'Width and Gap' : 'Width and Bus Spacing'}</legend>
        <Check label="Width From Rule" checked={w === null} onChange={(v) => setW(v ? null : ed.trackWidth)} />
        {w !== null && <Row label="Width"><LenInput ed={ed} label="Width" value={w} min={1} onChange={setW} /></Row>}
        <Check label={tool.kind === 'pair' ? 'Gap From Rule' : 'Spacing From Rule'} checked={g === null} onChange={(v) => setG(v ? null : tool.gap())} />
        {g !== null && <Row label={tool.kind === 'pair' ? 'Gap' : 'Spacing'}><LenInput ed={ed} label="Gap" value={g} min={1} onChange={setG} /></Row>}
      </fieldset>
      <fieldset class="pd-group"><legend>Routing Conflict Resolution</legend>
        {ROUTE_MODES.filter(([m]) => ['ignore', 'walkaround', 'stop', 'push', 'hug'].includes(m)).map(([m, label]) => (
          <label key={m} class="pd-radio"><input type="radio" name="crm" checked={mode === m} onChange={() => setMode(m)} /> {label}</label>
        ))}
      </fieldset>
    </Dialog>
  );
}

const defaultNet = (ed: PcbEditor) => { const g = ed.doc.nets.find((n) => /^(gnd|dgnd|agnd|vss)$/i.test(n.name)); return g ? g.index : ed.doc.nets[0]?.index ?? NO_NET; };

/** Add Stitching to Net: grid, via size, an area if wanted, the net. */
export function StitchingDialog({ ed, onOk }: { ed: PcbEditor; onOk: (o: { net: number; grid: number; diameter: number; hole: number; area?: { minX: number; minY: number; maxX: number; maxY: number } }) => void }) {
  const o = ed.doc.board.outline, xs = o.map((p) => p.x), ys = o.map((p) => p.y);
  // The via size: the net's Routing Via Style when the via template follows the rules
  const net0 = defaultNet(ed), size = ed.viaTemplate.fromRule && net0 !== NO_NET ? netRouting(ed.doc, net0).via : ed.viaTemplate;
  const [v, setV] = useState({ net: net0, grid: mil(100), diameter: size.diameter, hole: size.hole, constrain: false,
    x1: xs.length ? Math.min(...xs) : 0, y1: ys.length ? Math.min(...ys) : 0, x2: xs.length ? Math.max(...xs) : 0, y2: ys.length ? Math.max(...ys) : 0 });
  const ok = () => {
    if (v.net === NO_NET) { notify('Choose the net to stitch', 'error'); return; }
    closeDialog();
    onOk({ net: v.net, grid: v.grid, diameter: v.diameter, hole: v.hole, area: v.constrain ? { minX: Math.min(v.x1, v.x2), minY: Math.min(v.y1, v.y2), maxX: Math.max(v.x1, v.x2), maxY: Math.max(v.y1, v.y2) } : undefined });
  };
  const len = (label: string, k: keyof typeof v, disabled = false) => <Row label={label}><LenInput ed={ed} label={label} value={v[k] as number} disabled={disabled} onChange={(c) => setV({ ...v, [k]: c })} /></Row>;
  const org = ed.origin();
  const coord = (label: string, k: 'x1' | 'y1' | 'x2' | 'y2') => <Row label={label}><LenInput ed={ed} label={label} value={(v[k] as number) - (k.startsWith('x') ? org.x : org.y)} disabled={!v.constrain}
    onChange={(c) => setV({ ...v, [k]: c + (k.startsWith('x') ? org.x : org.y) })} /></Row>;
  return (
    <Dialog title="Add Stitching to Net" width={480} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok)}>
      <div class="tune-grid">
        <div>
          <fieldset class="pd-group"><legend>Stitching Grid</legend>{len('Grid Spacing', 'grid')}</fieldset>
          <fieldset class="pd-group"><legend>Via Style</legend>{len('Hole Size', 'hole')}{len('Via Diameter', 'diameter')}</fieldset>
          <fieldset class="pd-group"><legend>Via Net</legend><Row label="Net"><NetSelect ed={ed} value={v.net} onChange={(n) => setV({ ...v, net: n })} /></Row></fieldset>
        </div>
        <fieldset class="pd-group"><legend>Constraint Area</legend>
          <Check label="Constrain Area" checked={v.constrain} onChange={(c) => setV({ ...v, constrain: c })} />
          {coord('X1', 'x1')}{coord('Y1', 'y1')}{coord('X2', 'x2')}{coord('Y2', 'y2')}
        </fieldset>
      </div>
    </Dialog>
  );
}

/** Add Shielding to Net: the net shielded, the via net, spacing, distance from the tracks, via size. */
export function ShieldingDialog({ ed, shielded, onOk }: { ed: PcbEditor; shielded: number; onOk: (o: { net: number; shielded: number; spacing: number; gap: number; diameter: number; hole: number }) => void }) {
  const [v, setV] = useState({ net: defaultNet(ed), shielded, spacing: mil(100), gap: mil(10), diameter: ed.viaTemplate.diameter, hole: ed.viaTemplate.hole });
  const ok = () => {
    if (v.net === NO_NET || v.shielded === NO_NET) { notify('Choose both nets', 'error'); return; }
    if (v.net === v.shielded) { notify('A net cannot shield itself', 'error'); return; }
    closeDialog(); onOk(v);
  };
  const len = (label: string, k: keyof typeof v) => <Row label={label}><LenInput ed={ed} label={label} value={v[k]} min={1} onChange={(c) => setV({ ...v, [k]: c })} /></Row>;
  return (
    <Dialog title="Add Shielding to Net" width={420} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok)}>
      <fieldset class="pd-group"><legend>Nets</legend>
        <Row label="Net To Shield"><NetSelect ed={ed} value={v.shielded} onChange={(n) => setV({ ...v, shielded: n })} /></Row>
        <Row label="Via Net"><NetSelect ed={ed} value={v.net} onChange={(n) => setV({ ...v, net: n })} /></Row>
      </fieldset>
      <fieldset class="pd-group"><legend>Placement</legend>{len('Via Spacing', 'spacing')}{len('Distance From Edge', 'gap')}</fieldset>
      <fieldset class="pd-group"><legend>Via Style</legend>{len('Hole Size', 'hole')}{len('Via Diameter', 'diameter')}</fieldset>
    </Dialog>
  );
}

/** One number (Shove Depth, Chamfer, Resize Polygon). */
export function NumberDialog({ title, label, value, unit, onOk, length, ed }: { title: string; label: string; value: number; unit?: string; onOk: (v: number) => void; length?: boolean; ed?: PcbEditor }) {
  const [v, setV] = useState(value);
  const ok = () => { closeDialog(); onOk(v); };
  return (
    <Dialog title={title} width={340} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok)}>
      <Row label={label}>
        {length && ed ? <LenInput ed={ed} label={label} value={v} onChange={setV} />
          : <><input type="number" class="pd-val" aria-label={label} value={v} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setV(numIn(e, v))} />{unit && <span> {unit}</span>}</>}
      </Row>
    </Dialog>
  );
}

/** Tools › Pin/Part Swapping › Configure: which components swap, and each pad's pin and part group. */
export function PinSwapConfigDialog({ ed }: { ed: PcbEditor }) {
  const doc = ed.doc;
  const comps = doc.components.map((c, i) => ({ c, i })).sort((a, b) => a.c.designator.localeCompare(b.c.designator, undefined, { numeric: true }));
  const [flags, setFlags] = useState(() => new Map(comps.map(({ i }) => [i, { pin: pinSwapOn(doc, i), part: partSwapOn(doc, i) }])));
  const [groups, setGroups] = useState(() => new Map<PcbPad, SwapInfo>());
  const [cur, setCur] = useState<number | null>(comps[0]?.i ?? null);
  const pads = cur !== null ? padsOf(doc, cur).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) : [];
  const infoOf = (p: PcbPad) => groups.get(p) ?? swapInfo(doc, p);
  const ok = () => {
    ed.undo.transact('Configure pin swapping', (tx) => {
      for (const [i, f] of flags) {
        if (f.pin === pinSwapOn(doc, i) && f.part === partSwapOn(doc, i)) continue;
        tx.add(setComponentProps(doc, i, { ENABLEPINSWAPPING: f.pin ? 'TRUE' : 'FALSE', ENABLEPARTSWAPPING: f.part ? 'TRUE' : 'FALSE' }));
      }
      const edits = [...groups].flatMap(([p, info]) => { const r = doc.streams.get(p.src.storage)?.records[p.src.index]; return r ? [{ storage: p.src.storage, index: p.src.index, after: withSwapInfo(r, info) }] : []; });
      if (edits.length) tx.add(replaceRecords(doc, edits));
    });
    closeDialog();
  };
  return (
    <Dialog title="Configure Pin Swapping" width={760} height={540} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok)} class="pinswap">
      <div class="pinswap-body">
        <div class="grid" style={{ '--cols': '90px 1fr 1fr 64px 64px' } as Record<string, string>}>
          <div class="grid-row grid-head"><span>Designator</span><span>Comment</span><span>Footprint</span><span>Pin Swap</span><span>Part Swap</span></div>
          <div class="grid-body">
            {comps.map(({ c, i }) => {
              const f = flags.get(i)!;
              const set = (k: 'pin' | 'part', v: boolean) => { const n = new Map(flags); n.set(i, { ...f, [k]: v }); setFlags(n); };
              return (
                <div key={i} class={`grid-row${cur === i ? ' on' : ''}`} onClick={() => setCur(i)}>
                  <span>{c.designator}</span><span>{c.bag.get('COMMENT') ?? ''}</span><span>{c.pattern}</span>
                  <span><input type="checkbox" aria-label={`Pin swap ${c.designator}`} checked={f.pin} onChange={(e) => set('pin', (e.target as HTMLInputElement).checked)} /></span>
                  <span><input type="checkbox" aria-label={`Part swap ${c.designator}`} checked={f.part} onChange={(e) => set('part', (e.target as HTMLInputElement).checked)} /></span>
                </div>
              );
            })}
          </div>
        </div>
        <div class="grid" style={{ '--cols': '70px 1fr 90px 90px' } as Record<string, string>}>
          <div class="grid-row grid-head"><span>Pad</span><span>Net</span><span>Pin Group</span><span>Part Group</span></div>
          <div class="grid-body">
            {pads.map((p) => {
              const info = infoOf(p);
              const set = (k: keyof SwapInfo, v: string) => { const n = new Map(groups); n.set(p, { ...info, [k]: v.trim() }); setGroups(n); };
              return (
                <div key={`${p.src.index}`} class="grid-row">
                  <span>{p.name}</span><span>{p.net === NO_NET ? 'No Net' : doc.nets[p.net]?.name}</span>
                  <span><input type="text" aria-label={`Pin group ${p.name}`} value={info.pin} onKeyDown={(e) => e.stopPropagation()} onInput={(e) => set('pin', (e.target as HTMLInputElement).value)} /></span>
                  <span><input type="text" aria-label={`Part group ${p.name}`} value={info.part} onKeyDown={(e) => e.stopPropagation()} onInput={(e) => set('part', (e.target as HTMLInputElement).value)} /></span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
