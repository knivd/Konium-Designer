import { useMemo, useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { markProjectDirty, notify, type Project } from '../state';
import { alternateFields, alternateOf, readVariants, variationOf, writeVariants, VARIATION_KINDS, type ParamVariation, type Variant, type Variation, type VariationKind } from '../../model/variants';
import { availableLibraries } from './PlacePart';
import { symbolFootprint } from '../../model/schPlace';
import { natural, type CompiledComponent } from '../../model/compile';
import { currentVariant, setCurrentVariant } from '../variantState';

/** Add Variant / rename: one line of text. */
export function NameDialog({ title, value, onOk }: { title: string; value: string; onOk: (v: string) => void }) {
  const [v, setV] = useState(value);
  const ok = () => { if (!v.trim()) return; closeDialog(); onOk(v.trim()); };
  return (
    <Dialog title={title} width={360} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <label class="do-row"><span>Name</span><input type="text" value={v} autofocus onInput={(e) => setV((e.target as HTMLInputElement).value)} /></label>
    </Dialog>
  );
}

/**
 * Variant Management: every part of the project down the side, a column per variant; a cell
 * says how the part goes into that variant — Fitted, Not Fitted, or Alternate (another part from
 * the libraries, its library reference and footprint). Edit Parameters gives the selected part
 * other parameter values in the selected variant (Comment, Value …). Add / Remove / Rename
 * variants, choose the current one (parts not fitted in it are crossed out on the sheets). OK
 * writes the .PrjPcb's [ProjectVariantN] sections.
 */
export function VariantsDialog({ project, parts, focus }: { project: Project; parts: CompiledComponent[]; focus?: string }) {
  const [list, setList] = useState<Variant[]>(() => readVariants(project.prj));
  const [cur, setCur] = useState(() => currentVariant(project.id));
  const [sel, setSel] = useState<number | null>(list.length ? 0 : null);
  const [row, setRow] = useState<string | null>(focus ?? null);
  const rows = useMemo(() => [...parts].sort((a, b) => (a.designator === focus ? -1 : b.designator === focus ? 1 : natural(a.designator, b.designator))), [parts, focus]);
  const put = (vi: number, c: CompiledComponent, x: Variation | null) => {
    setList(list.map((v, i) => {
      if (i !== vi) return v;
      const rest = v.variations.filter((y) => y !== variationOf(v, c.designator, c.uniqueId));
      return { ...v, variations: x ? [...rest, x] : rest };
    }));
  };
  const setKind = (vi: number, c: CompiledComponent, kind: VariationKind) => {
    const prev = variationOf(list[vi], c.designator, c.uniqueId);
    const base = { designator: c.designator, uniqueId: prev?.uniqueId || c.uniqueId, alternate: prev?.alternate ?? c.params.Comment ?? '', fields: [] as [string, string][] };
    if (kind === 2) {
      showDialog(AlternatePartDialog, { part: c, onOk: (a: { libRef: string; footprint: string; library: string }) =>
        put(vi, c, { ...base, kind: 2, fields: alternateFields({ ...a, sameFootprint: a.footprint.toLowerCase() === c.footprint.toLowerCase() }) }) });
      return;
    }
    put(vi, c, kind || list[vi]!.params.some((pv) => pv.designator === c.designator) ? { ...base, kind } : null);
  };
  const editParams = () => {
    const c = rows.find((r) => r.designator === row);
    if (sel === null || !c) return;
    const v = list[sel]!;
    showDialog(VariantParamsDialog, { part: c, variant: v.name, values: v.params.filter((x) => x.designator === c.designator), onOk: (vals: ParamVariation[]) => {
      setList(list.map((x, i) => (i === sel ? { ...x, params: [...x.params.filter((y) => y.designator !== c.designator), ...vals] } : x)));
    } });
  };
  const ok = () => {
    const before = project.prj.lines.join('\n');
    writeVariants(project.prj, list);
    if (project.prj.lines.join('\n') !== before) markProjectDirty(project);
    setCurrentVariant(project.id, list.some((v) => v.name === cur) ? cur : '');
    closeDialog();
    notify(`${list.length} variant${list.length === 1 ? '' : 's'}${cur ? `; current: ${cur}` : ''}`);
  };
  const cols = `90px minmax(120px, 1fr) ${list.map(() => '150px').join(' ')}`;
  const label = (v: Variant, c: CompiledComponent) => {
    const x = variationOf(v, c.designator, c.uniqueId);
    const pv = v.params.filter((y) => y.designator === c.designator);
    return [x?.kind === 2 ? `→ ${alternateOf(x).libRef}${alternateOf(x).footprint && alternateOf(x).footprint !== c.footprint ? ` (${alternateOf(x).footprint})` : ''}` : '', pv.length ? pv.map((y) => `${y.name}=${y.value}`).join(', ') : ''].filter(Boolean).join('; ');
  };
  return (
    <Dialog title={`Variant Management For ${project.name}`} width={Math.min(1180, Math.max(860, 440 + list.length * 160))} height={580} onClose={closeDialog} class="variants"
      footer={<>
        <button class="btn" onClick={() => showDialog(NameDialog, { title: 'Add Variant', value: `Variant${list.length + 1}`, onOk: (n: string) => { setList([...list, { name: n, allowFabrication: true, variations: [], params: [], extra: [] }]); setSel(list.length); } })}>Add Variant...</button>
        <button class="btn" disabled={sel === null} onClick={() => showDialog(NameDialog, { title: 'Rename Variant', value: list[sel!]!.name, onOk: (n: string) => { if (cur === list[sel!]!.name) setCur(n); setList(list.map((v, i) => (i === sel ? { ...v, name: n } : v))); } })}>Rename...</button>
        <button class="btn" disabled={sel === null} onClick={() => { if (cur === list[sel!]?.name) setCur(''); setList(list.filter((_, i) => i !== sel)); setSel(null); }}>Remove</button>
        <button class="btn" disabled={sel === null || !row} onClick={editParams}>Edit Parameters...</button>
        <label class="do-row va-cur"><span>Current Variant</span>
          <select value={cur} onChange={(e) => setCur((e.target as HTMLSelectElement).value)}><option value="">[No Variations]</option>{list.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}</select></label>
        <span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button>
      </>}>
      <div class="va-grid" role="grid" style={{ '--cols': cols } as Record<string, string>}>
        <div class="va-row cp-ghead" role="row"><span>Designator</span><span>Comment</span>{list.map((v, i) => <span key={v.name} class={sel === i ? 'on' : ''} onMouseDown={() => setSel(i)}>{v.name}{cur === v.name ? ' ✓' : ''}</span>)}</div>
        {rows.map((c) => (
          <div key={`${c.designator}|${c.uniqueId}`} class={`va-row${c.designator === row ? ' focus' : ''}`} role="row" onMouseDown={() => setRow(c.designator)}>
            <span>{c.designator}</span><span>{c.comment}</span>
            {list.map((v, i) => {
              const k = variationOf(v, c.designator, c.uniqueId)?.kind ?? 0;
              const note = label(v, c);
              return <span key={v.name} class="va-cell" title={note}><select class={k === 1 ? 'nf' : k === 2 ? 'alt' : ''} value={String(k)} aria-label={`${c.designator} in ${v.name}`}
                onFocus={() => setSel(i)} onChange={(e) => setKind(i, c, Number((e.target as HTMLSelectElement).value) as VariationKind)}>
                {VARIATION_KINDS.map((x, j) => <option key={x} value={String(j)}>{x}</option>)}</select>{note && <span class="va-note">{note}</span>}</span>;
            })}
          </div>
        ))}
        {!list.length && <p class="grid-empty">No variants yet: Add Variant… makes one</p>}
      </div>
    </Dialog>
  );
}

/** The alternate for a part: a component of the available libraries, with its footprint. */
export function AlternatePartDialog({ part, onOk }: { part: CompiledComponent; onOk: (a: { libRef: string; footprint: string; library: string }) => void }) {
  const [mask, setMask] = useState('');
  const [sel, setSel] = useState<number | null>(null);
  const all = useMemo(() => availableLibraries().flatMap((lib) => lib.symbols.map((s) => ({ library: lib.name, libRef: s.libRef, description: s.description, footprint: symbolFootprint(s.bags) }))), []);
  const rows = all.filter((r) => !mask || `${r.libRef} ${r.description} ${r.footprint}`.toLowerCase().includes(mask.toLowerCase()));
  const [typed, setTyped] = useState({ libRef: '', footprint: part.footprint });
  const ok = () => {
    const r = sel === null ? null : rows[sel];
    const a = r ? { libRef: r.libRef, footprint: r.footprint || part.footprint, library: r.library } : typed.libRef.trim() ? { libRef: typed.libRef.trim(), footprint: typed.footprint.trim(), library: '' } : null;
    if (!a) return;
    closeDialog(); onOk(a);
  };
  return (
    <Dialog title={`Alternate Part For ${part.designator}`} width={680} height={500} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" disabled={sel === null && !typed.libRef.trim()} onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <p class="muted small">{part.designator} is {part.libRef} ({part.footprint || 'no footprint'}). Choose the part fitted instead in this variant.</p>
      <label class="do-row"><span>Filter</span><input type="text" aria-label="Filter" value={mask} onInput={(e) => { setMask((e.target as HTMLInputElement).value); setSel(null); }} onKeyDown={(e) => e.stopPropagation()} /></label>
      <Grid cols={[
        { label: 'Library Reference', width: '180px', get: (r: typeof all[number]) => r.libRef },
        { label: 'Description', width: 'minmax(140px, 1fr)', get: (r) => r.description },
        { label: 'Footprint', width: '140px', get: (r) => r.footprint },
        { label: 'Library', width: '130px', get: (r) => r.library },
      ]} rows={rows} sel={sel} onSel={setSel} onOpen={(i) => { setSel(i); }} empty="No libraries loaded: type the part below" />
      <fieldset><legend>Or type it</legend>
        <label class="do-row"><span>Library Reference</span><input type="text" aria-label="Alternate library reference" value={typed.libRef} onInput={(e) => { setTyped({ ...typed, libRef: (e.target as HTMLInputElement).value }); setSel(null); }} onKeyDown={(e) => e.stopPropagation()} /></label>
        <label class="do-row"><span>Footprint</span><input type="text" aria-label="Alternate footprint" value={typed.footprint} onInput={(e) => setTyped({ ...typed, footprint: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.stopPropagation()} /></label>
      </fieldset>
    </Dialog>
  );
}

/** Edit Component Parameters in a variant: each of the part's parameters with the value it takes there (blank: unchanged). */
export function VariantParamsDialog({ part, variant, values, onOk }: { part: CompiledComponent; variant: string; values: ParamVariation[]; onOk: (vals: ParamVariation[]) => void }) {
  const names = [...new Set(['Comment', ...Object.keys(part.params).filter((n) => !/^(Comment)$/i.test(n))])];
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(values.map((v) => [v.name, v.value])));
  const ok = () => { closeDialog(); onOk(names.filter((n) => (vals[n] ?? '') !== '').map((n) => ({ designator: part.designator, name: n, value: vals[n]! }))); };
  return (
    <Dialog title={`Edit Component Parameters — ${part.designator} in ${variant}`} width={560} height={460} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="grid" style={{ '--cols': '140px 1fr 1fr' } as Record<string, string>}>
        <div class="grid-row grid-head"><span>Parameter</span><span>Original Value</span><span>Variant Value</span></div>
        <div class="grid-body">
          {names.map((n) => <div key={n} class="grid-row"><span>{n}</span><span class="muted">{n === 'Comment' ? part.params.Comment ?? part.comment : part.params[n]}</span>
            <span><input type="text" aria-label={`${n} in ${variant}`} value={vals[n] ?? ''} placeholder="(unchanged)" onInput={(e) => setVals({ ...vals, [n]: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.stopPropagation()} /></span></div>)}
        </div>
      </div>
    </Dialog>
  );
}
