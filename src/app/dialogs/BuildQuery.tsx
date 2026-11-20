/**
 * Build Query (right-click › Filter › Build Query…, and Build Query… on an object): AD17's
 * query builder [est: laid out after its Building Query from Board]. Each row a condition — a
 * property, how it compares, a value — taken from the object under the cursor or added by hand,
 * joined by And or Or; the query is shown as it will run. OK puts it in the PCB Filter and runs it.
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { pcbObjects, pcbProps, PCB_OBJECT_KINDS, type PcbObj } from '../../model/pcbProps';
import { applyPcbFilter, pcbFilterQuery, queryCtx } from '../panels/PcbFilter';
import { showPanel } from '../dock/store';


interface Cond { on: boolean; prop: string; op: string; value: string }
const OPS = ['=', '<>', '<', '>', '<=', '>=', 'Like'];

export function BuildQueryDialog({ ed, key: at }: { ed: PcbEditor; key?: string }) {
  const x = queryCtx(ed);
  const obj: PcbObj | undefined = at ? pcbObjects(ed.doc).find((o) => o.keys.includes(at)) : undefined;
  const props = obj ? pcbProps(obj, x) : [];
  const [conds, setConds] = useState<Cond[]>(() => obj
    ? props.filter((p) => p.value !== '').map((p, i) => ({ on: i === 0, prop: p.name, op: '=', value: p.value }))
    : [{ on: true, prop: 'Object Kind', op: '=', value: 'Track' }]);
  const [join, setJoin] = useState<'And' | 'Or'>('And');
  const names = [...new Set(['Object Kind', 'Layer', 'Net', 'Component', 'Width', 'Locked', ...props.map((p) => p.name)])];
  const q = (v: string) => (/^(true|false)$/i.test(v) ? (v.toLowerCase() === 'true' ? 'True' : 'False') : /^-?[0-9.]+(mil|mm)?$/.test(v) ? v : `'${v.replace(/'/g, '')}'`);
  const term = (c: Cond) => (c.prop === 'Object Kind' && c.op === '=' && PCB_OBJECT_KINDS.includes(c.value) ? `Is${c.value.replace(/\s+/g, '')}` : `(${c.prop.replace(/[\s-]+/g, '')} ${c.op} ${q(c.value)})`);
  const query = conds.filter((c) => c.on).map(term).join(` ${join} `) || 'All';
  const set = (i: number, p: Partial<Cond>) => setConds(conds.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const ok = () => { pcbFilterQuery.value = query; showPanel('filter'); applyPcbFilter('all', query); closeDialog(); };
  return (
    <Dialog title="Building Query from Board" width={720} height={520} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="buildquery"
      footer={<><button class="btn" onClick={() => setConds([...conds, { on: true, prop: 'Layer', op: '=', value: '' }])}>Add Condition</button>
        <span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="bq-join">Join the conditions with
        <label><input type="radio" name="bq-join" checked={join === 'And'} onChange={() => setJoin('And')} /> And</label>
        <label><input type="radio" name="bq-join" checked={join === 'Or'} onChange={() => setJoin('Or')} /> Or</label>
      </div>
      <div class="grid bq-grid" style={{ '--cols': '30px minmax(140px,1fr) 80px minmax(140px,1.4fr) 30px' } as Record<string, string>}>
        <div class="grid-row grid-head"><span /><span>Condition Type</span><span>Operator</span><span>Condition Value</span><span /></div>
        <div class="grid-body">
          {conds.map((c, i) => (
            <div key={i} class="grid-row">
              <span><input type="checkbox" aria-label={`Use condition ${i + 1}`} checked={c.on} onChange={(e) => set(i, { on: (e.target as HTMLInputElement).checked })} /></span>
              <span><select aria-label="Condition Type" value={c.prop} onChange={(e) => set(i, { prop: (e.target as HTMLSelectElement).value })}>{names.map((n) => <option key={n}>{n}</option>)}</select></span>
              <span><select aria-label="Operator" value={c.op} onChange={(e) => set(i, { op: (e.target as HTMLSelectElement).value })}>{OPS.map((o) => <option key={o}>{o}</option>)}</select></span>
              <span><input type="text" aria-label="Condition Value" value={c.value} onInput={(e) => set(i, { value: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.stopPropagation()} /></span>
              <span><button class="btn bq-del" aria-label="Remove condition" onClick={() => setConds(conds.filter((_, j) => j !== i))}>×</button></span>
            </div>
          ))}
        </div>
      </div>
      <fieldset class="bq-preview"><legend>Query Preview</legend><code>{query}</code></fieldset>
    </Dialog>
  );
}
