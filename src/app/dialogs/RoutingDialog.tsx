/**
 * Tab while routing (or before the first click): AD17's Interactive Routing dialog — the width and
 * via size the route uses with the rules that bound them, the layer, pin swapping, and the
 * Interactive Routing preferences beside them (conflict resolution, options, gloss, width
 * sources, favourites). Also Favourite Interactive Routing Widths (Shift+W while routing).
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { ROUTE_MODES, type RouteTool, type ViaMode, type WidthMode } from '../../editors/pcb/RouteTool';
import { DEFAULTS, settings, updateSettings, type Settings } from '../../core/settings';
import { formatCoord, parseLength } from '../../core/units';
import { isSignal } from '../../model/layers';
import { viaTemplateName } from '../../model/padTemplates';
import { compiled } from '../compiled';
import { activeProject } from '../project';
import { commands } from '../../core/commands';
import { RulesDialog } from './Rules';
import { LenInput } from './pcbFields';
import { openMenuAt } from '../MenuBar';

const MODE_NAMES: [WidthMode, string][] = [['user', 'User Choice'], ['min', 'Rule Minimum'], ['pref', 'Rule Preferred'], ['max', 'Rule Maximum']];
const WIDTH_FROM: Record<WidthMode, string> = { user: 'Width from user preferred value', min: 'Width from rule minimum value', pref: 'Width from rule preferred value', max: 'Width from rule maximum value' };

/** The favourites as lengths, smallest first. */
export const favouriteWidths = (): number[] => [...new Set(settings.pcbFavouriteWidths.map((w) => parseLength(w)).filter((c): c is number => !!c && c > 0))].sort((a, b) => a - b);

export function InteractiveRoutingDialog({ ed }: { ed: PcbEditor }) {
  const tool = ed.tool.id === 'route' ? ed.tool as unknown as RouteTool : null;
  const [, setRev] = useState(0);
  const bump = () => setRev((n) => n + 1);
  const [draft] = useState<Partial<Settings>>(() => ({}));
  const s = <K extends keyof Settings>(k: K): Settings[K] => (k in draft ? draft[k] as Settings[K] : settings[k]);
  const put = (p: Partial<Settings>) => { Object.assign(draft, p); bump(); };
  const [width, setWidth] = useState(ed.trackWidth);
  const [wMode, setWMode] = useState<WidthMode>(tool?.trackWidthMode ?? settings.pcbTrackWidthMode);
  const [vMode, setVMode] = useState<ViaMode>(tool?.viaSizeMode ?? settings.pcbViaSizeMode);
  const via0 = tool?.nextVia() ?? { diameter: ed.viaTemplate.diameter, hole: ed.viaTemplate.hole };
  const [via, setVia] = useState(via0);
  const [layer, setLayer] = useState(ed.currentLayer);
  // Apply to all layers off: the width is the chosen layer's own
  const [allLayers, setAllLayers] = useState(() => !ed.layerWidths.has(ed.currentLayer));
  const viaTemplates = [...new Map(ed.doc.prims.filter((p): p is Extract<typeof p, { kind: 'via' }> => p.kind === 'via').map((v) => [viaTemplateName(v.diameter, v.hole), { diameter: v.diameter, hole: v.hole }])).entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  const u = ed.units();
  const f = (c: number) => formatCoord(c, u, u === 'mil' ? 3 : 4);
  const wr = tool?.widthRule(), vr = tool?.viaRule();
  const proj = activeProject();
  const upToDate = !!proj && compiled.value?.projectId === proj.id;
  const net = tool?.active ? tool.netLabel : '';
  const title = `Interactive Routing${net ? ` For Net [${net}]` : ''} [${u}]`;
  const ok = () => {
    updateSettings({ ...draft, pcbTrackWidthMode: wMode, pcbViaSizeMode: vMode });
    if (layer !== ed.currentLayer) ed.setCurrentLayer?.(layer);
    if (tool) {
      tool.setTrackWidthMode(wMode);
      tool.setViaSizeMode(vMode);
      if (wMode === 'user' && !allLayers) tool.setLayerWidth(layer, width);
      else if (wMode === 'user' && (width !== ed.trackWidth || ed.layerWidths.size)) tool.setUserWidth(width);
    } else if (wMode === 'user' && !allLayers) { ed.layerWidths.set(layer, width); if (layer === ed.currentLayer) ed.trackWidth = width; }
    else if (wMode === 'user') { updateSettings({ pcbTrackWidth: width / 10_000 }); ed.layerWidths.clear(); ed.trackWidth = width; }
    if (via.diameter !== via0.diameter || via.hole !== via0.hole) ed.viaTemplate = { diameter: via.diameter, hole: via.hole, fromRule: false };
    ed.invalidateOverlay();
    closeDialog();
  };
  const widthMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenuAt({ key: '', label: '', children: favouriteWidths().map((w) => ({ key: '', label: `${formatCoord(w, 'mil', 3)}  (${formatCoord(w, 'mm', 4)})`, action: () => { setWidth(w); setWMode('user'); } })) }, r.left, r.bottom + 1);
  };
  const check = (k: keyof Settings, label: string, sub = false, disabled = false, title?: string) => (
    <label class={`ir-check${sub ? ' sub' : ''}`} title={title}><input type="checkbox" checked={!!s(k)} disabled={disabled} onChange={(e) => put({ [k]: (e.target as HTMLInputElement).checked } as Partial<Settings>)} /> {label}</label>
  );
  const ruleText = wr ? `Trace Width is currently constrained by the rule '${wr.name}' to a minimum of ${f(wr.min)} and a maximum of ${f(wr.max)}.` : 'No Width rule applies.';
  const viaText = vr ? `Via style is currently constrained by the rule '${vr.name}'. The minimum and maximum hole sizes are ${f(vr.minHole)} and ${f(vr.maxHole)}. The minimum and maximum diameters are ${f(vr.minDia)} and ${f(vr.maxDia)}.` : 'No Routing Via Style rule applies.';
  return (
    <Dialog title={title} width={1240} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="irdlg"
      footer={<><button class="btn" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt({ key: '', label: '', children: [
        { key: 'W', label: 'Edit Width Rule...', accelAt: 5, action: () => showDialog(RulesDialog, { ed }) },
        { key: 'V', label: 'Edit Via Rule...', accelAt: 5, action: () => showDialog(RulesDialog, { ed }) },
        { key: 'F', label: 'Favourite Interactive Routing Widths...', accelAt: 0, action: () => showDialog(FavouriteWidthsDialog, {}), separatorBefore: true },
        { key: 'D', label: 'Restore Default Options', accelAt: 8, action: () => put(Object.fromEntries((['pcbModeIgnore', 'pcbModePush', 'pcbModeWalkaround', 'pcbModeStop', 'pcbModeHug', 'pcbModeAutoroute', 'pcbModeAutorouteMulti', 'pcbRoutingMode', 'pcbRestrict9045', 'pcbFollowMouseTrail', 'pcbAutoTerminate', 'pcbRemoveLoops', 'pcbRemoveNetAntennas', 'pcbAllowViaPushing', 'pcbClearanceBoundaries', 'pcbReduceClearanceArea', 'pcbGlossRouted', 'pcbPickupWidth'] as const).map((k) => [k, DEFAULTS[k]]))) },
      ] }, r.left, r.top - 120); }}><u>M</u>enu</button><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="ir-cols">
        <div class="ir-left">
          <fieldset class="pd-group ir-props"><legend>Properties</legend>
            <div class="ir-fig">
              <div class="ir-width">
                <span class="pd-label">{WIDTH_FROM[wMode]}</span>
                <span class="ir-combo">
                  <LenInput ed={ed} id="ir-width" class="ir-val" label="Width" value={width} min={1} onChange={(v) => { setWidth(v); setWMode('user'); }} />
                  <button class="ir-drop" aria-label="Favourite widths" onClick={widthMenu}>▾</button>
                </span>
                <label class="ir-check" title="Off: this width is the chosen layer's own; the other layers keep theirs"><span>Apply to all layers</span> <input type="checkbox" checked={allLayers} onChange={() => setAllLayers(!allLayers)} /></label>
                <span class="pd-label">(Impedance: 0)</span>
              </div>
              <svg viewBox="0 0 300 150" class="ir-pic" aria-hidden="true">
                <line x1="20" y1="66" x2="196" y2="66" stroke="#f2c443" stroke-width="26" stroke-linecap="round" />
                <circle cx="210" cy="66" r="44" fill="#f2c443" /><circle cx="210" cy="66" r="18" fill="#fff" />
                <line x1="70" y1="40" x2="70" y2="52" stroke="#3d8fc4" /><line x1="70" y1="92" x2="70" y2="80" stroke="#3d8fc4" />
                <line x1="150" y1="10" x2="250" y2="122" stroke="#9aa3ab" /><line x1="196" y1="2" x2="272" y2="86" stroke="#9aa3ab" />
              </svg>
              <div class="ir-via">
                <span class="pd-label">Via Hole Size</span>
                <LenInput ed={ed} label="Via Hole Size" class="ir-val" value={via.hole} min={1} onChange={(v) => { if (v < via.diameter) { setVia({ ...via, hole: v }); setVMode('user'); } }} />
                <span class="pd-label">Via Diameter</span>
                <LenInput ed={ed} label="Via Diameter" class="ir-val" value={via.diameter} min={1} onChange={(v) => { if (v > via.hole) { setVia({ ...via, diameter: v }); setVMode('user'); } }} />
              </div>
            </div>
            <div class="ir-row">
              <span class="pd-label">Layer</span>
              <select aria-label="Layer" value={String(layer)} onChange={(e) => { const l = Number((e.target as HTMLSelectElement).value); setLayer(l); const w = ed.layerWidths.get(l); if (w !== undefined) setWidth(w); }}>
                {ed.doc.board.copperStack.filter(isSignal).map((l) => <option key={l} value={String(l)}>{ed.layerLabel(l)}</option>)}
              </select>
              <span class="pd-label">Template</span>
              <select aria-label="Template" title="The board's via sizes, by their standard template names" value={viaTemplateName(via.diameter, via.hole)}
                onChange={(e) => { const t = viaTemplates.find(([n]) => n === (e.target as HTMLSelectElement).value); if (t) { setVia({ ...t[1] }); setVMode('user'); } }}>
                {!viaTemplates.some(([n]) => n === viaTemplateName(via.diameter, via.hole)) && <option value={viaTemplateName(via.diameter, via.hole)}>{viaTemplateName(via.diameter, via.hole)}</option>}
                {viaTemplates.map(([n]) => <option key={n} value={n}>{n}</option>)}</select>
            </div>
          </fieldset>
          <fieldset class="pd-group"><legend>Routing Width Constraints</legend>
            <div class="ir-rule"><button class="btn" onClick={() => showDialog(RulesDialog, { ed })}>Edit <u>W</u>idth Rule...</button><span>{ruleText}</span></div>
          </fieldset>
          <fieldset class="pd-group"><legend>Via Style Constraints</legend>
            <div class="ir-rule"><button class="btn" onClick={() => showDialog(RulesDialog, { ed })}>Edit <u>V</u>ia Rule...</button><span>{viaText}</span></div>
          </fieldset>
          <fieldset class="pd-group"><legend>Pin Swapping</legend>
            <div class="ir-rule">
              <label class="ir-check"><input type="checkbox" checked={upToDate} disabled /> Enabled</label>
              {upToDate ? <span class="muted">Project compiled</span> : <span class="error-text">Project compilation out of date</span>}
              <button class="btn" disabled={!proj} onClick={() => { commands.get('tools.erc')?.run(); bump(); }}>Compile Project</button>
            </div>
            <div class="ir-row" title="The longest jumper Route › Add Subnet Jumpers offers to start with"><span class="pd-label">Preferred Subnet Jumper Length</span>
              <LenInput ed={ed} label="Preferred Subnet Jumper Length" class="pd-val ir-val" value={parseLength(s('pcbSubnetJumperLength')) ?? 200_000} min={0} onChange={(v) => put({ pcbSubnetJumperLength: `${+(v / 10_000).toFixed(4)}mil` })} /></div>
          </fieldset>
        </div>
        <div class="ir-right">
          <div class="ir-block"><h4>Routing Conflict Resolution</h4>
            {ROUTE_MODES.map(([, label, k]) => check(k, label))}
            <div class="ir-row"><span>Current Mode</span>
              <select aria-label="Current Mode" value={s('pcbRoutingMode')} onChange={(e) => put({ pcbRoutingMode: (e.target as HTMLSelectElement).value as Settings['pcbRoutingMode'] })}>
                {ROUTE_MODES.map(([m, label]) => <option key={m} value={m}>{m === 'hug' ? 'HugNPush Obstacles' : label}</option>)}
              </select></div>
          </div>
          <div class="ir-block"><h4>Interactive Routing Width Sources</h4>
            {check('pcbPickupWidth', 'Pickup Track Width From Existing Routes')}
            <div class="ir-row"><span>Track Width Mode</span>
              <select aria-label="Track Width Mode" value={wMode} onChange={(e) => setWMode((e.target as HTMLSelectElement).value as WidthMode)}>
                {MODE_NAMES.map(([m, n]) => <option key={m} value={m}>{n}</option>)}</select></div>
            <div class="ir-row"><span>Via Size Mode</span>
              <select aria-label="Via Size Mode" value={vMode} onChange={(e) => setVMode((e.target as HTMLSelectElement).value as ViaMode)}>
                {MODE_NAMES.map(([m, n]) => <option key={m} value={m}>{n}</option>)}</select></div>
          </div>
          <div class="ir-block"><h4>Interactive Routing Options</h4>
            {check('pcbRestrict9045', 'Restrict To 90/45')}
            {check('pcbFollowMouseTrail', 'Follow Mouse Trail', false, false, 'Walkaround Obstacles and AutoRoute On Current Layer take the way the cursor went since the last click, not the shortest way to where it is')}
            {check('pcbAutoTerminate', 'Automatically Terminate Routing')}
            {check('pcbRemoveLoops', 'Automatically Remove Loops')}
            {check('pcbRemoveNetAntennas', 'Remove Net Antennas', true, !s('pcbRemoveLoops'))}
            {check('pcbAllowViaPushing', 'Allow Via Pushing')}
            {check('pcbClearanceBoundaries', 'Display Clearance Boundaries')}
            {check('pcbReduceClearanceArea', 'Reduce Clearance Display Area', true, !s('pcbClearanceBoundaries'))}
          </div>
          <div class="ir-block"><h4>Favourites</h4>
            <button class="btn" onClick={() => showDialog(FavouriteWidthsDialog, {})}><u>F</u>avourite Interactive Routing Widths</button>
          </div>
          <div class="ir-block"><h4>Routing Gloss Effort</h4>
            {(['off', 'weak', 'strong'] as const).map((g) => <label key={g} class="ir-check"><input type="radio" name="ir-gloss" checked={s('pcbGlossRouted') === g} onChange={() => put({ pcbGlossRouted: g })} /> {g[0]!.toUpperCase() + g.slice(1)}</label>)}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** Favourite Interactive Routing Widths: the widths Shift+W offers while routing [est: AD17's columns]. */
export function FavouriteWidthsDialog() {
  const [rows, setRows] = useState<string[]>(() => [...settings.pcbFavouriteWidths]);
  const [sel, setSel] = useState<number | null>(null);
  const ok = () => { updateSettings({ pcbFavouriteWidths: rows.filter((r) => parseLength(r)) }); closeDialog(); };
  const conv = (r: string, to: 'mil' | 'mm') => { const c = parseLength(r); return c ? formatCoord(c, to, to === 'mil' ? 3 : 4) : ''; };
  return (
    <Dialog title="Favourite Interactive Routing Widths" width={460} height={480} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="favwidths"
      footer={<><button class="btn" onClick={() => { setRows([...rows, '10mil']); setSel(rows.length); }}>Add</button>
        <button class="btn" disabled={sel === null} onClick={() => { if (sel === null) return; setRows(rows.filter((_, i) => i !== sel)); setSel(null); }}>Delete</button>
        <button class="btn" onClick={() => { setRows([...DEFAULTS.pcbFavouriteWidths]); setSel(null); }}>Restore Defaults</button>
        <span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="grid" style={{ '--cols': '1fr 1fr 1fr' } as Record<string, string>}>
        <div class="grid-row grid-head"><span>Width</span><span>Imperial</span><span>Metric</span></div>
        <div class="grid-body">
          {rows.map((r, i) => (
            <div key={i} class={`grid-row${sel === i ? ' sel' : ''}`} onMouseDown={() => setSel(i)}>
              <span><input type="text" aria-label={`Width ${i + 1}`} value={r} onInput={(e) => { const n = [...rows]; n[i] = (e.target as HTMLInputElement).value; setRows(n); }} onKeyDown={(e) => e.stopPropagation()} /></span>
              <span>{conv(r, 'mil')}</span><span>{conv(r, 'mm')}</span>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

/** Shift+W while routing: choose one of the favourite widths, at the cursor. */
export function chooseWidthAt(tool: RouteTool, ed: PcbEditor, x: number, y: number): void {
  openMenuAt({ key: '', label: '', children: [
    ...favouriteWidths().map((w) => ({ key: '', label: `${formatCoord(w, 'mil', 3)}   ${formatCoord(w, 'mm', 4)}`, checked: w === ed.trackWidth, action: () => { tool.setUserWidth(w); ed.invalidateOverlay(); } })),
    { key: '', label: 'Favourite Interactive Routing Widths...', separatorBefore: true, action: () => showDialog(FavouriteWidthsDialog, {}) },
  ] }, x, y);
}

