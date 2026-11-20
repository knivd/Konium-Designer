import { useState } from 'preact/hooks';
import { Grid } from '../Dialog';
import { compiled, cmdCompile, crossProbe } from '../project';
import { projects } from '../state';
import { ELECTRICAL, type CompiledNet, type ObjRef } from '../../model/compile';
import { settings } from '../../core/settings';
import type { SchDocument } from '../../model/sch';

/** A net's objects as the Navigator lists them (System › Navigation › Objects To Display). */
export interface NavRow { what: string; name: string; type: string; sheet: string; refs: ObjRef[] }
export function netObjects(net: CompiledNet, sheets: { name: string; doc: SchDocument }[]): NavRow[] {
  const out: NavRow[] = [];
  if (settings.navShowPins) for (const p of net.pins) out.push({ what: 'Pin', name: `${p.designator}-${p.pin}${p.name ? ` (${p.name})` : ''}`, type: ELECTRICAL[p.electrical] ?? '', sheet: p.ref.sheet, refs: [p.ref] });
  const docOf = new Map(sheets.map((s) => [s.name.toLowerCase(), s.doc]));
  const seen = new Set<string>();
  for (const r of net.refs) {
    const k = `${r.sheet}|${r.index}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const o = docOf.get(r.sheet.toLowerCase())?.objects[r.index];
    if (!o) continue;
    const row = (what: string, name: string, on: boolean) => { if (on) out.push({ what, name, type: '', sheet: r.sheet, refs: [r] }); };
    if (o.kind === 'text' && o.role === 'netlabel') row('Net Label', o.text, settings.navShowNetLabels);
    else if (o.kind === 'port') row('Port', o.name, settings.navShowPorts);
    else if (o.kind === 'sheetentry') row('Sheet Entry', o.name, settings.navShowEntries);
    else if (o.kind === 'power') row(o.crossSheet ? 'Off Sheet Connector' : 'Power Port', o.text, o.crossSheet ? settings.navShowConnectors : settings.navPowerParts);
    else if (o.kind === 'wire' || o.kind === 'bus') row(o.kind === 'wire' ? 'Wire' : 'Bus', `${o.pts.length} vertices`, settings.navShowLines);
  }
  return out;
}

/**
 * Navigator: what the last compile found — documents, component instances, nets and the pins
 * of the selected net. Clicking a row cross-probes to the schematic, as in Altium.
 */
export function NavigatorPanel() {
  const res = compiled.value;
  const [net, setNet] = useState<number | null>(null);
  const [comp, setComp] = useState<number | null>(null);
  const p = res?.projectId ? projects.value.find((x) => x.id === res.projectId) ?? null : null;
  const nets = res?.result.nets ?? [];
  const sel = net !== null ? nets[net] : undefined;
  const objs = sel && res ? netObjects(sel, res.sheets) : [];
  return (
    <section class="panel docked navigator" aria-label="Navigator">
      <div class="nav-bar">
        <button class="btn" onClick={() => { setNet(null); setComp(null); cmdCompile(); }}>{res ? 'Recompile' : 'Compile'}</button>
        <span class="muted small">{res ? `${res.name} · ${res.result.scope} net scope` : 'Compile the project to navigate it.'}</span>
      </div>
      {res && (
        <div class="nav-lists">
          <Grid cols={[{ label: 'Documents', get: (s: { name: string }) => s.name }]} rows={res.sheets} />
          <Grid
            cols={[
              { label: 'Instance', width: '70px', get: (c) => c.designator },
              { label: 'Comment', get: (c) => c.comment },
              { label: 'Type', get: (c) => c.libRef },
            ]}
            rows={res.result.components} sel={comp}
            onSel={(i) => { setComp(i); setNet(null); crossProbe(res.result.components[i]!.refs, p); }} />
          <Grid
            cols={[
              { label: 'Net / Bus', get: (n) => n.name },
              { label: 'Scope', width: '80px', get: (n) => (n.sheets.length > 1 ? 'Global' : 'Local') },
            ]}
            rows={nets} sel={net}
            onSel={(i) => { setNet(i); setComp(null); crossProbe(nets[i]!.refs, p); }} />
          <Grid
            cols={[
              { label: 'Object', width: '96px', get: (x: NavRow) => x.what },
              { label: 'Name', get: (x: NavRow) => x.name },
              { label: 'Type', width: '80px', get: (x: NavRow) => x.type },
              { label: 'Sheet', width: '110px', get: (x: NavRow) => x.sheet },
            ]}
            rows={objs} empty={sel ? 'Nothing to list on this net (System › Navigation › Objects To Display).' : 'Select a net to list its pins and other objects.'}
            onSel={(i) => { const o = objs[i]; if (o) crossProbe(o.refs, p); }} />
        </div>
      )}
    </section>
  );
}
