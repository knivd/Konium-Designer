/**
 * Sim Model (the component's Models › Add › Simulation, or Edit on a SIM model), as AD17 lays
 * it out: Model Kind (Model Kind, Model Sub-Kind, Spice Prefix, Model Name with Browse...,
 * Description, where the model file was found), Parameters (Value, Component parameter: the part's
 * own parameter of that name gives it), Port Map (each model pin's schematic pin); below, the
 * Netlist Template, the Netlist Preview and the Model File.
 */
import { useMemo, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { ChooseListDialog } from './ChooseList';
import { MODEL_KINDS, type SubKind } from '../../model/simKinds';
import { expandTemplate } from '../../model/simModels';
import { BUILTIN_MODELS, builtinModel } from '../../sim/library';

export interface SimModelValue {
  name: string; description: string; kind: string; subKind: string; prefix: string; netlist: string;
  file?: { entity: string; kind: string };
  params: [string, string][];
  /** [model pin, schematic pin] */
  portMap: [string, string][];
}

/** A new model's starting point for a sub-kind. */
export function newSimModel(kind: string, sub: SubKind, pins: { designator: string }[]): SimModelValue {
  const n = Math.max(0, ...[...sub.template.matchAll(/%(\d+)/g)].map((m) => Number(m[1])));
  return {
    name: sub.file ? '' : sub.name.toUpperCase().replace(/[^A-Z0-9]+/g, ''), description: sub.name, kind, subKind: sub.name, prefix: sub.prefix, netlist: sub.template,
    ...(sub.file ? { file: { entity: '', kind: sub.file } } : {}),
    params: sub.params.map(([k, v]) => [k, v]),
    portMap: Array.from({ length: Math.min(n, pins.length) }, (_, i) => [String(i + 1), pins[i]!.designator] as [string, string]),
  };
}

const defined = (text: string) => [...text.matchAll(/^\s*\.(model|subckt)\s+(\S+)(?:\s+(\w+))?/gim)].map((m) => ({ card: m[1]!.toLowerCase(), name: m[2]!, type: (m[3] ?? '').toUpperCase() }));

export function SimModelDialog({ value, pins, partParam, findModel, onOk }: {
  value: SimModelValue;
  pins: { designator: string; name: string }[];
  /** The part's own parameter (for Component parameter values in the preview). */
  partParam: (name: string) => string | undefined;
  /** A model file by name and kind: its text and where it was found. */
  findModel: (entity: string, kind: string) => { text: string; from: string } | null;
  onOk: (v: SimModelValue) => void;
}) {
  const [v, setV] = useState<SimModelValue>(() => JSON.parse(JSON.stringify(value)) as SimModelValue);
  const [tab, setTab] = useState<'kind' | 'params' | 'ports'>('kind');
  const [low, setLow] = useState<'template' | 'preview' | 'file'>('preview');
  const kinds = Object.keys(MODEL_KINDS);
  const subs = MODEL_KINDS[v.kind] ?? [];
  const set = (p: Partial<SimModelValue>) => setV({ ...v, ...p });
  const pickSub = (kind: string, name: string) => {
    const sub = (MODEL_KINDS[kind] ?? []).find((s) => s.name === name);
    if (!sub) { set({ kind, subKind: name }); return; }
    const fresh = newSimModel(kind, sub, pins);
    // Keep values the user already gave for parameters of the same name
    fresh.params = fresh.params.map(([k, d]) => [k, v.params.find(([n]) => n.toLowerCase() === k.toLowerCase())?.[1] ?? d]);
    setV({ ...fresh, name: sub.file ? v.name : fresh.name, description: v.description && v.subKind !== v.description ? v.description : fresh.description });
  };
  const entity = v.file ? v.file.entity || v.name : '';
  const found = useMemo(() => (v.file ? findModel(entity, v.file.kind) ?? (() => { const b = builtinModel(`${entity}.${v.file!.kind.toLowerCase()}`) ?? builtinModel(entity); return b ? { text: b.text, from: "Konium Designer's built-in models" } : null; })() : null), [entity, v.file?.kind]);
  const preview = useMemo(() => {
    const param = (n: string) => { const own = v.params.find(([k]) => k.toUpperCase() === n); const x = own?.[1]; return x !== undefined && x !== '' && x !== '*' ? x : partParam(n) ?? partParam(n.toLowerCase()); };
    const r = expandTemplate(v.netlist, {
      designator: `${v.prefix}${v.prefix === 'X' ? 'U' : ''}1`, model: v.name,
      net: (i) => { const pin = v.portMap.find(([m]) => m === String(i))?.[1] ?? pins[i - 1]?.designator; return pin === undefined ? undefined : `Net_${pin}`; },
      param: (n) => param(n.toUpperCase()),
    });
    return r.missing.length ? `${r.line}\n\n* Missing: ${r.missing.join(', ')}` : r.line;
  }, [v, pins]);
  const modelPins = Math.max(0, ...[...v.netlist.matchAll(/%(\d+)/g)].map((m) => Number(m[1])));
  const browse = () => {
    const want = v.subKind.toLowerCase();
    const fit = (type: string, card: string) => (v.file?.kind === 'CKT' ? card === 'subckt' : want === 'diode' ? type === 'D' : want === 'bjt' ? type === 'NPN' || type === 'PNP' : want === 'mosfet' ? type === 'NMOS' || type === 'PMOS' : want === 'jfet' ? type === 'NJF' || type === 'PJF' : card === 'model');
    const list = Object.entries(BUILTIN_MODELS).flatMap(([file, text]) => defined(text).filter((d) => fit(d.type, d.card)).map((d) => ({ name: d.name, file })));
    if (!list.length) return;
    showDialog(ChooseListDialog, { title: 'Browse Models', header: "Konium Designer's built-in models", items: list.map((x) => `${x.name}  (${x.file})`), onOk: (i: number) => {
      const m = list[i]!;
      set({ name: m.name, file: { entity: m.name, kind: v.file?.kind ?? 'MDL' } });
    } });
  };
  const ok = () => { closeDialog(); onOk(v); return false; };
  return (
    <Dialog title={`Sim Model - ${v.kind} / ${v.subKind}`} width={760} height={640} class="simmodel" onClose={closeDialog} onAccept={ok}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="sm-tabs" role="tablist">
        {([['kind', 'Model Kind'], ['params', 'Parameters'], ['ports', 'Port Map']] as const).map(([id, l]) => <button key={id} role="tab" aria-selected={tab === id} class={`sm-tab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>{l}</button>)}
      </div>
      <div class="sm-page">
        {tab === 'kind' && (
          <div class="sm-kind">
            <label>Model Kind<select value={v.kind} onChange={(e) => { const k = (e.target as HTMLSelectElement).value; pickSub(k, MODEL_KINDS[k]?.[0]?.name ?? ''); }}>{kinds.map((k) => <option key={k}>{k}</option>)}</select></label>
            <label class="sm-sub">Model Sub-Kind
              <select size={9} aria-label="Model Sub-Kind" value={v.subKind} onChange={(e) => pickSub(v.kind, (e.target as HTMLSelectElement).value)}>
                {subs.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                {!subs.some((s) => s.name === v.subKind) && <option value={v.subKind}>{v.subKind || '(none)'}</option>}
              </select>
            </label>
            <label>Spice Prefix<input type="text" value={v.prefix} onInput={(e) => set({ prefix: (e.target as HTMLInputElement).value })} /></label>
            <label>Model Name<span class="sm-row"><input type="text" value={v.name} onInput={(e) => { const n = (e.target as HTMLInputElement).value; set({ name: n, ...(v.file ? { file: { ...v.file, entity: n } } : {}) }); }} />
              <button class="btn" onClick={browse} disabled={!v.file}>Browse...</button></span></label>
            <label>Description<input type="text" value={v.description} onInput={(e) => set({ description: (e.target as HTMLInputElement).value })} /></label>
            {v.file && <p class={found ? 'muted small' : 'warn small'}>{found ? `Found In: ${found.from}` : `${entity || '(no name)'}.${v.file.kind.toLowerCase()} isn't in the project or Konium Designer's built-in models: add the model file to the project.`}</p>}
          </div>
        )}
        {tab === 'params' && (
          <table class="as-params"><thead><tr><th>Parameter</th><th>Value</th><th>Component parameter</th></tr></thead><tbody>
            {v.params.map(([k, val], i) => (
              <tr key={k}>
                <td>{k}</td>
                <td><input type="text" aria-label={k} value={val === '*' ? partParam(k) ?? '' : val} disabled={val === '*'} onInput={(e) => { const p = [...v.params]; p[i] = [k, (e.target as HTMLInputElement).value]; set({ params: p }); }} /></td>
                <td><input type="checkbox" aria-label={`${k}: the part's parameter`} checked={val === '*'} onChange={(e) => { const p = [...v.params]; p[i] = [k, (e.target as HTMLInputElement).checked ? '*' : partParam(k) ?? '']; set({ params: p }); }} /></td>
              </tr>
            ))}
            {!v.params.length && <tr><td colSpan={3} class="muted">This model takes no parameters.</td></tr>}
          </tbody></table>
        )}
        {tab === 'ports' && (
          <table class="as-params"><thead><tr><th>Model Pin</th><th>Schematic Pin</th></tr></thead><tbody>
            {Array.from({ length: modelPins }, (_, i) => String(i + 1)).map((mp) => {
              const cur = v.portMap.find(([m]) => m === mp)?.[1] ?? '';
              return (
                <tr key={mp}>
                  <td>{mp}</td>
                  <td><select aria-label={`Model pin ${mp}`} value={cur} onChange={(e) => set({ portMap: [...v.portMap.filter(([m]) => m !== mp), [mp, (e.target as HTMLSelectElement).value] as [string, string]].filter(([, s]) => s) })}>
                    <option value="">(not connected)</option>
                    {pins.map((p) => <option key={p.designator} value={p.designator}>{p.designator}{p.name && p.name !== p.designator ? ` (${p.name})` : ''}</option>)}
                  </select></td>
                </tr>
              );
            })}
            {!modelPins && <tr><td colSpan={2} class="muted">The netlist template names no pins (%1, %2 …).</td></tr>}
          </tbody></table>
        )}
      </div>
      <div class="sm-tabs" role="tablist">
        {([['template', 'Netlist Template'], ['preview', 'Netlist Preview'], ['file', 'Model File']] as const).map(([id, l]) => <button key={id} role="tab" aria-selected={low === id} class={`sm-tab${low === id ? ' on' : ''}`} onClick={() => setLow(id)}>{l}</button>)}
      </div>
      {low === 'template' && <textarea class="sm-text" spellcheck={false} aria-label="Netlist Template" value={v.netlist} onInput={(e) => set({ netlist: (e.target as HTMLTextAreaElement).value })} />}
      {low === 'preview' && <pre class="sm-text" aria-label="Netlist Preview">{preview}</pre>}
      {low === 'file' && <pre class="sm-text" aria-label="Model File">{found?.text ?? (v.file ? 'Model file not found' : 'This model needs no file')}</pre>}
    </Dialog>
  );
}
