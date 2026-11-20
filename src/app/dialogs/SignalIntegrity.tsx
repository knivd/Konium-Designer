/**
 * Signal Integrity's dialogs: Setup Options (track impedance and average length for what the
 * board doesn't route, the default IC technology, the supply nets and their voltages, the
 * stimulus), Set Tolerances (what the panel's status holds each net to where no rule does) and
 * Model Assignments (each part's type and, for an IC, its technology or an IBIS model; Import
 * IBIS reads .ibs files). Each saves to the project.
 */
import { useMemo, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import { notify, units } from '../state';
import { formatCoord, parseLength } from '../../core/units';
import { natural } from '../../model/compile';
import { SI_RULES, siNum, siShow, siText, type SiLimit, type Stimulus } from '../../si/rules';
import { TECHNOLOGIES, ibisToIc, readIbis, technology, type IcModel } from '../../si/models';
import { SI_TYPES, supplyVoltage, typeByDesignator, type SiType } from '../../si/topology';
import { siBoardRules } from '../../model/drcMore';
import { designFacts, readSiSetup, saveSiSetup, DEFAULT_TOLERANCES, type SiProjectSetup } from '../siProject';
import { forgetPrepared, siTarget } from '../siRun';

const num = (s: string) => { const v = siNum(s); return Number.isFinite(v) ? v : NaN; };

/* ─── Setup Options ──────────────────────────────────────────────────────────────── */

export function SiSetupDialog({ onDone }: { onDone?: () => void }) {
  const t = siTarget();
  const [s, setS] = useState<SiProjectSetup>(() => readSiSetup(t?.project ?? null, t?.name ?? ''));
  const u = units.value;
  const [len, setLen] = useState(formatCoord(s.avgLength, u, 1));
  const [z, setZ] = useState(String(s.trackZ));
  const [add, setAdd] = useState('');
  // The nets that are supplies: the board's Supply Nets rules, the setup's, those named so
  const rows = useMemo(() => {
    const ruled = t?.board ? siBoardRules(t.board).supplies : new Map<string, number>();
    const names = t?.board ? t.board.nets.map((n) => n.name) : (designFacts(t?.project ?? null).compiled?.nets.map((n) => n.name) ?? []);
    const setup = { trackZ: s.trackZ, avgLength: s.avgLength, tech: s.tech, supplies: new Map(s.supplies.map(([n, v]) => [n.toUpperCase(), v])) };
    const out: { net: string; volts: number; from: 'Rule' | 'Setup' | 'Name' }[] = [];
    for (const n of new Set(names)) {
      const k = n.toUpperCase();
      if (ruled.has(k)) out.push({ net: n, volts: ruled.get(k)!, from: 'Rule' });
      else if (setup.supplies.has(k)) out.push({ net: n, volts: setup.supplies.get(k)!, from: 'Setup' });
      else { const v = supplyVoltage(n, { ...setup, supplies: new Map() }); if (v !== null) out.push({ net: n, volts: v, from: 'Name' }); }
    }
    for (const [n, v] of s.supplies) if (!out.some((x) => x.net.toUpperCase() === n.toUpperCase())) out.push({ net: n, volts: v, from: 'Setup' });
    return out.sort((a, b) => natural(a.net, b.net));
  }, [s]);
  const setSupply = (net: string, volts: number | null) => {
    const rest = s.supplies.filter(([n]) => n.toUpperCase() !== net.toUpperCase());
    setS({ ...s, supplies: volts === null ? rest : [...rest, [net, volts]] });
  };
  const st = s.stimulus;
  const setSt = (p: Partial<Stimulus>) => setS({ ...s, stimulus: { ...st, ...p } });
  const ok = () => {
    const zz = Number(z), ll = parseLength(/^[\d.]+$/.test(len.trim()) ? `${len.trim()}${u}` : len);
    const next = { ...s, trackZ: zz > 0 ? zz : s.trackZ, avgLength: ll !== undefined && ll > 0 ? ll : s.avgLength };
    saveSiSetup(t?.project ?? null, next, t?.name ?? '');
    forgetPrepared();
    closeDialog();
    onDone?.();
  };
  return (
    <Dialog title="Signal Integrity Setup Options" width={620} onClose={closeDialog} onAccept={ok} class="si-dlg"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <fieldset>
        <legend>Track Setup</legend>
        <p class="muted">For what the board doesn't route (the schematic alone, pins the copper doesn't reach).</p>
        <label class="si-row">Track Impedance (Ω)<input type="text" value={z} onInput={(e) => setZ((e.target as HTMLInputElement).value)} /></label>
        <label class="si-row">Average Track Length<input type="text" value={len} onInput={(e) => setLen((e.target as HTMLInputElement).value)} /></label>
        <label class="si-row">Default IC Technology
          <select value={s.tech} onChange={(e) => setS({ ...s, tech: (e.target as HTMLSelectElement).value })}>{TECHNOLOGIES.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}</select>
        </label>
      </fieldset>
      <fieldset>
        <legend>Supply Nets</legend>
        <Grid rows={rows} empty="No supply nets"
          cols={[
            { label: 'Net', width: 'minmax(120px,1fr)', get: (r) => r.net },
            { label: 'Voltage', width: '100px', get: (r) => r.from === 'Rule' ? siShow(r.volts, 'V')
              : <input type="text" aria-label={`${r.net} voltage`} value={String(r.volts)} onChange={(e) => { const v = num((e.target as HTMLInputElement).value); if (Number.isFinite(v)) setSupply(r.net, v); }} /> },
            { label: 'From', width: '150px', get: (r) => (r.from === 'Rule' ? 'Supply Nets rule' : r.from === 'Setup' ? 'Setup' : 'Its name') },
            { label: '', width: '70px', get: (r) => (r.from === 'Setup' ? <button class="btn" onClick={() => setSupply(r.net, null)}>Remove</button> : '') },
          ]} />
        <div class="si-add">
          <input type="text" placeholder="Net name" aria-label="Supply net to add" value={add} onInput={(e) => setAdd((e.target as HTMLInputElement).value)} />
          <button class="btn" disabled={!add.trim()} onClick={() => { setSupply(add.trim(), technology(s.tech).vcc); setAdd(''); }}>Add</button>
          <span class="muted">A board's Supply Nets rules come first; edit them in Design › Rules.</span>
        </div>
      </fieldset>
      <fieldset>
        <legend>Stimulus</legend>
        <p class="muted">For Reflections and Crosstalk where no Signal Stimulus rule takes the net.</p>
        <label class="si-row">Stimulus Kind
          <select value={st.kind} onChange={(e) => setSt({ kind: (e.target as HTMLSelectElement).value as Stimulus['kind'] })}>{(['Constant Level', 'Single Pulse', 'Periodic Pulse'] as const).map((k) => <option key={k} value={k}>{k}</option>)}</select>
        </label>
        <label class="si-row">Start Level
          <select value={st.startHigh ? 'h' : 'l'} onChange={(e) => setSt({ startHigh: (e.target as HTMLSelectElement).value === 'h' })}><option value="l">Low Level</option><option value="h">High Level</option></select>
        </label>
        {(['start', 'stop', 'period'] as const).map((k) => (
          <label key={k} class="si-row">{k === 'start' ? 'Start Time (s)' : k === 'stop' ? 'Stop Time (s)' : 'Period Time (s)'}
            <input type="text" value={siText(st[k]).trim()} onChange={(e) => { const v = num((e.target as HTMLInputElement).value); if (Number.isFinite(v) && v >= 0) setSt({ [k]: v }); }} />
          </label>
        ))}
      </fieldset>
    </Dialog>
  );
}

/* ─── Set Tolerances ─────────────────────────────────────────────────────────────── */

const CHECKS: { limit: SiLimit; label: string; unit: string }[] = SI_RULES.flatMap((r) => r.fields.filter((f) => f.limit).map((f) => ({
  limit: f.limit!, label: r.kind === 'MaxMinImpedance' ? `Impedance ${f.label.replace(/ \(.*$/, '').toLowerCase()}` : r.label, unit: f.unit,
})));

export function SiTolerancesDialog({ onDone }: { onDone?: () => void }) {
  const t = siTarget();
  const [s, setS] = useState<SiProjectSetup>(() => readSiSetup(t?.project ?? null, t?.name ?? ''));
  const set = (limit: SiLimit, v: number | undefined) => { const tol = { ...s.tolerances }; if (v === undefined) delete tol[limit]; else tol[limit] = v; setS({ ...s, tolerances: tol }); };
  const ok = () => { saveSiSetup(t?.project ?? null, s, t?.name ?? ''); forgetPrepared(); closeDialog(); onDone?.(); };
  return (
    <Dialog title="Set Screening Analysis Tolerances" width={520} onClose={closeDialog} onAccept={ok} class="si-dlg"
      footer={<><button class="btn" onClick={() => setS({ ...s, tolerances: { ...DEFAULT_TOLERANCES } })}>Defaults</button><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <p class="muted">A net fails where it goes past an enabled tolerance. The board's Signal Integrity rules come first for the nets they take.</p>
      <Grid rows={CHECKS} cols={[
        { label: 'Enabled', width: '64px', align: 'center', get: (c) => <input type="checkbox" aria-label={`${c.label} enabled`} checked={s.tolerances[c.limit] !== undefined}
          onChange={(e) => set(c.limit, (e.target as HTMLInputElement).checked ? siNum(SI_RULES.flatMap((r) => r.fields).find((f) => f.limit === c.limit)?.def) : undefined)} /> },
        { label: 'Check', width: 'minmax(170px,1fr)', get: (c) => c.label },
        { label: 'Tolerance', width: '120px', get: (c) => s.tolerances[c.limit] === undefined ? <span class="muted">—</span>
          : <input type="text" aria-label={`${c.label} tolerance`} value={siText(s.tolerances[c.limit]!).trim()} onChange={(e) => { const v = num((e.target as HTMLInputElement).value); if (Number.isFinite(v)) set(c.limit, v); }} /> },
        { label: 'Unit', width: '50px', get: (c) => c.unit },
      ]} />
    </Dialog>
  );
}

/* ─── Model Assignments ──────────────────────────────────────────────────────────── */

/** IBIS models imported this session ("file: model"), offered for ICs. */
const imported = signal<Map<string, IcModel>>(new Map());

export function SiModelsDialog({ onDone }: { onDone?: () => void }) {
  const t = siTarget();
  const [s, setS] = useState<SiProjectSetup>(() => readSiSetup(t?.project ?? null, t?.name ?? ''));
  const [sel, setSel] = useState<number | null>(null);
  const facts = useMemo(() => designFacts(t?.project ?? null), []);
  const rows = useMemo(() => {
    const des = new Set<string>();
    if (t?.board) for (const c of t.board.components) if (c.designator) des.add(c.designator);
    for (const c of facts.compiled?.components ?? []) if (c.kind !== 1 && c.kind !== 2) des.add(c.designator);
    return [...des].sort(natural).map((d) => {
      const k = d.toUpperCase();
      const comp = facts.compiled?.components.find((c) => c.designator.toUpperCase() === k);
      const userType = s.types.get(k), schType = facts.types.get(k), guess = typeByDesignator(d);
      const type: SiType = userType ?? schType ?? guess;
      const model = s.models.get(k) ?? (facts.techs.has(k) ? technology(facts.techs.get(k)!) : null);
      const status = s.types.has(k) || s.models.has(k) ? 'User modified' : schType ? 'Model found' : type === 'None' ? 'No match' : type === 'IC' ? 'Low confidence' : 'Medium confidence';
      const value = type === 'IC' ? (model?.name ?? s.tech) : facts.values.has(k) ? siShow(facts.values.get(k), type === 'Resistor' ? 'Ω' : type === 'Capacitor' ? 'F' : type === 'Inductor' ? 'H' : '') : (comp?.comment ?? '');
      return { des: d, key: k, type, status, value, comment: comp?.comment ?? '' };
    });
  }, [s]);
  const icChoices = [...TECHNOLOGIES.map((m) => m.name), ...imported.value.keys()];
  const setType = (k: string, v: SiType) => { const types = new Map(s.types); types.set(k, v); setS({ ...s, types }); };
  const setModel = (k: string, name: string) => {
    const models = new Map(s.models);
    const m = imported.value.get(name) ?? TECHNOLOGIES.find((x) => x.name === name);
    if (m) models.set(k, m); else models.delete(k);
    setS({ ...s, models });
  };
  const importIbis = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.ibs,.IBS'; input.multiple = true;
    input.onchange = async () => {
      const next = new Map(imported.value);
      let count = 0;
      for (const f of [...(input.files ?? [])]) {
        try {
          const ibis = readIbis(await f.text(), f.name);
          for (const [name, m] of ibis.models) {
            if (!/output|i\/o|3-state|open/i.test(m.type) && !/input/i.test(m.type)) continue;
            next.set(`${f.name}: ${name}`, ibisToIc(m, `${f.name}: ${name}`, technology(s.tech))); count++;
          }
        } catch (e) { notify(`${f.name}: ${(e as Error).message}`, 'error'); }
      }
      imported.value = next;
      notify(`Import IBIS: ${count} model${count === 1 ? '' : 's'} read; pick one in an IC's Value/Type`);
    };
    input.click();
  };
  const ok = () => { saveSiSetup(t?.project ?? null, s, t?.name ?? ''); forgetPrepared(); closeDialog(); onDone?.(); };
  return (
    <Dialog title="Signal Integrity Model Assignments" width={760} height={560} onClose={closeDialog} onAccept={ok} class="si-dlg"
      footer={<><button class="btn" onClick={importIbis}>Import IBIS...</button><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <p class="muted">ICs drive and listen by their pins' electrical types (from the schematic); resistors, capacitors and inductors by their values; connectors and the rest are left out. The schematic's own SI models (Type, Tech) are read; changes here are kept in the project.</p>
      <Grid rows={rows} sel={sel} onSel={setSel} empty="No parts"
        cols={[
          { label: 'Type', width: '120px', get: (r) => (
            <select aria-label={`${r.des} type`} value={r.type} onChange={(e) => setType(r.key, (e.target as HTMLSelectElement).value as SiType)}>{SI_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}</select>) },
          { label: 'Designator', width: '90px', get: (r) => r.des },
          { label: 'Status', width: '130px', get: (r) => <span class={r.status === 'No match' ? 'muted' : ''}>{r.status}</span> },
          { label: 'Value/Type', width: 'minmax(180px,1fr)', get: (r) => r.type === 'IC'
            ? <select aria-label={`${r.des} model`} value={s.models.get(r.key)?.name ?? (facts.techs.has(r.key) ? technology(facts.techs.get(r.key)!).name : '')} onChange={(e) => setModel(r.key, (e.target as HTMLSelectElement).value)}>
                <option value="">{`Default (${s.tech})`}</option>
                {[...new Set([...icChoices, ...(s.models.has(r.key) ? [s.models.get(r.key)!.name] : [])])].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            : r.value },
          { label: 'Comment', width: 'minmax(100px,1fr)', get: (r) => r.comment },
        ]} />
    </Dialog>
  );
}
