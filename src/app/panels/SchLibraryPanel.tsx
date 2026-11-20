import { useState } from 'preact/hooks';
import { Grid } from '../Dialog';
import { active, tick } from '../state';
import { showDialog } from '../dialogs';
import { LibComponentDialog } from '../dialogs/LibComponent';
import { commands } from '../../core/commands';
import { SchLibEditor } from '../../editors/sch/SchLibEditor';
import { ELECTRICAL } from '../../model/compile';
import { partLetter, SR, bagOf } from '../../model/sch';
import { currentSymbols } from '../../model/schLib';
import { PlacePartFromLibrary } from './placeFromLibrary';

/**
 * SCH Library panel: the library's components (Mask filter, Component / Description), Place,
 * Add, Delete, Edit; the shown component's pins (Pins / Name / Type) and its models.
 * Clicking a component shows it; double-click (or Edit) opens its properties.
 */
export function SchLibraryPanel() {
  void tick.value;
  const [mask, setMask] = useState('');
  const ed = active.value?.editor;
  if (!(ed instanceof SchLibEditor)) return null;
  const lib = ed.lib;
  const re = (() => { try { return new RegExp(`^${mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}`, 'i'); } catch { return /.*/; } })();
  const list = lib.symbols.map((s, i) => ({ s, i })).filter(({ s }) => !mask || re.test(s.libRef));
  const sel = list.findIndex((x) => x.i === ed.current);
  const doc = ed.doc;
  const pins = doc.objects.filter((o) => o.kind === 'pin' && (o.ownerPartId <= 0 || o.ownerPartId === ed.part));
  const models = doc.objects.filter((o) => o.record === SR.IMPLEMENTATION);
  const run = (id: string) => { commands.run(id, 'schlib'); tick.value++; };
  return (
    <section class="panel pcblib schlib" aria-label="SCH Library">
      <label class="pcblib-mask">Mask <input type="search" value={mask} placeholder="e.g. LM*" onInput={(e) => setMask((e.target as HTMLInputElement).value)} /></label>
      <div class="pcblib-list" data-ctx="components">
        <Grid
          cols={[
            { label: 'Component', width: 'minmax(90px, 1fr)', get: (x: { s: typeof lib.symbols[number] }) => (lib.views.get(x.s)?.objects.find((o) => o.kind === 'component') as { libRef?: string } | undefined)?.libRef ?? x.s.libRef },
            { label: 'Description', width: 'minmax(90px, 1.4fr)', get: (x) => { const v = lib.views.get(x.s); const c = v ? v.objects.find((o) => o.kind === 'component') : undefined; return (c && v ? bagOf(v, c)?.get('COMPONENTDESCRIPTION') : undefined) ?? x.s.description; } },
          ]}
          rows={list} sel={sel < 0 ? null : sel}
          onSel={(k) => { const x = list[k]; if (x) { ed.showSymbol(x.i); tick.value++; } }}
          onOpen={(k) => { const x = list[k]; if (x) { ed.showSymbol(x.i); showDialog(LibComponentDialog, { ed }); } }}
          empty="No components match." />
      </div>
      <div class="pcblib-buttons">
        <PlacePartFromLibrary ed={ed} symbols={() => currentSymbols(lib)} />
        <button class="btn" onClick={() => run('schlib.newComponent')}>Add</button>
        <button class="btn" disabled={lib.symbols.length < 2} onClick={() => run('schlib.removeComponent')}>Delete</button>
        <button class="btn" onClick={() => run('schlib.componentProperties')}>Edit</button>
      </div>
      <h3 class="pcblib-sub">Pins{ed.partCount > 1 ? ` — Part ${partLetter(ed.part)} of ${ed.partCount}` : ''}</h3>
      <div class="pcblib-prims">
        <Grid
          cols={[
            { label: 'Pins', width: '50px', get: (o: (typeof pins)[number]) => (o.kind === 'pin' ? o.designator : '') },
            { label: 'Name', width: 'minmax(50px, 1fr)', get: (o) => (o.kind === 'pin' ? o.name : '') },
            { label: 'Type', width: '84px', get: (o) => (o.kind === 'pin' ? ELECTRICAL[o.electrical] ?? '' : '') },
          ]}
          rows={pins}
          onSel={(k) => { const o = pins[k]; if (o) ed.select([`o${o.index}`]); }}
          onOpen={(k) => { const o = pins[k]; if (o) { ed.select([`o${o.index}`]); ed.fitSelection(2_000_000); } }}
          empty="No pins: Place › Pin (P, P)." />
      </div>
      <h3 class="pcblib-sub">Model</h3>
      <div class="schlib-models">
        {models.length ? models.map((o) => { const b = bagOf(doc, o); return <div key={o.index} class="schlib-model"><span>{b?.get('MODELNAME')}</span><span class="muted">{b?.get('MODELTYPE') === 'PCBLIB' ? 'Footprint' : b?.get('MODELTYPE')}</span></div>; })
          : <p class="muted small">No models. Edit adds a footprint.</p>}
      </div>
    </section>
  );
}
