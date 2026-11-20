import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify, tick } from '../state';
import type { Editor } from '../../editors/Editor';
import { SchEditor } from '../../editors/sch/SchEditor';
import { SchFindSimilarDialog } from './SchFindSimilar';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { pcbObjects, pcbProps } from '../../model/pcbProps';
import { pcbExpressionFor } from '../../model/pcbQuery';
import { pcbFilterQuery, queryCtx } from '../panels/PcbFilter';
import { showPanel } from '../dock/store';

type Match = 'Any' | 'Same' | 'Different';

/**
 * Edit › Find Similar Objects (Shift+F, or right-click › Find Similar Objects): the clicked
 * object's properties, each set to Any / Same / Different; OK selects every object that
 * matches (Object Kind starts at Same, as in Altium).
 */
export function FindSimilarDialog({ ed, key: start }: { ed: Editor; key: string }) {
  if (ed instanceof SchEditor) return <SchFindSimilarDialog ed={ed} index={parseInt(start.slice(1), 10)} />;
  return <BoardFindSimilar ed={ed} key0={start} />;
}

/**
 * A board's Find Similar Objects: the clicked object's properties as the PCB Inspector groups them
 * (Kind, Graphical, Object Specific), each Any / Same / Different; Zoom, Select and Mask Matching,
 * Clear Existing, and Create Expression (the PCB Filter's query for it).
 */
function BoardFindSimilar({ ed, key0: start }: { ed: Editor; key0: string }) {
  const e = ed as PcbEditor;
  const x = queryCtx(e);
  const objs = pcbObjects(e.doc);
  // A component's primitive stands for the component (as a click picks it), its designator and comment for themselves
  const whole = e.keysFor(start).length > 1;
  const ref = (whole ? objs.find((o) => o.component !== undefined && o.keys.includes(start)) : undefined) ?? objs.find((o) => o.prim && o.keys.includes(start)) ?? objs.find((o) => o.keys.includes(start));
  const props = ref ? pcbProps(ref, x) : [];
  const [match, setMatch] = useState<Record<string, Match>>(() => Object.fromEntries(props.map((p) => [p.name, p.name === 'Object Kind' ? 'Same' : 'Any'])));
  const [opt, setOpt] = useState({ zoom: true, select: true, clear: true, mask: false, expr: false });
  if (!ref) return null;
  const want = props.filter((p) => match[p.name] !== 'Any').map((p) => ({ name: p.name, value: p.value, same: match[p.name] === 'Same' }));
  const hits = objs.filter((o) => {
    const ps = pcbProps(o, x);
    return want.every((w) => { const v = ps.find((q) => q.name === w.name)?.value; return v !== undefined && (w.same ? v === w.value : v !== w.value); });
  });
  const ok = () => {
    const keys = hits.flatMap((o) => o.keys);
    if (opt.select) { if (opt.clear) ed.selection.clear(); for (const k of keys) ed.selection.add(k); }
    if (opt.mask) e.setMask(keys); 
    ed.invalidateOverlay();
    if (opt.zoom && keys.length) ed.zoomToBox(ed.boundsOf(keys), 2_000_000);
    if (opt.expr) { pcbFilterQuery.value = pcbExpressionFor(want); showPanel('filter'); }
    tick.value++;
    notify(`${hits.length} matching object${hits.length === 1 ? '' : 's'}`);
    closeDialog();
  };
  const cats = ['Kind', 'Graphical', 'Object Specific'] as const;
  return (
    <Dialog title="Find Similar Objects" width={560} height={620} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="similar"
      footer={<><span class="muted small">{hits.length} match{hits.length === 1 ? '' : 'es'}</span><span class="spacer" />
        <button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="grid" style={{ '--cols': 'minmax(120px, 0.9fr) minmax(140px, 1.3fr) 110px' } as Record<string, string>}>
        <div class="grid-row grid-head"><span>Property</span><span>Value</span><span>Match</span></div>
        <div class="grid-body">
          {cats.map((c) => {
            const rows = props.filter((p) => p.cat === c);
            if (!rows.length) return null;
            return [<div key={c} class="grid-row similar-cat"><span>{c}</span><span /><span /></div>, ...rows.map((p) => (
              <div key={p.name} class="grid-row">
                <span>{p.name}</span><span title={p.value}>{p.value}</span>
                <span><select aria-label={`${p.name} match`} value={match[p.name] ?? 'Any'} onChange={(ev) => setMatch({ ...match, [p.name]: (ev.target as HTMLSelectElement).value as Match })}>
                  <option>Any</option><option>Same</option><option>Different</option>
                </select></span>
              </div>
            ))];
          })}
        </div>
      </div>
      <div class="similar-opts">
        {([['zoom', 'Zoom Matching'], ['select', 'Select Matching'], ['clear', 'Clear Existing'], ['mask', 'Mask Matching'], ['expr', 'Create Expression']] as const).map(([k, l]) => (
          <label key={k}><input type="checkbox" checked={opt[k]} onChange={(ev) => setOpt({ ...opt, [k]: (ev.target as HTMLInputElement).checked })} />{l}</label>
        ))}
      </div>
    </Dialog>
  );
}
