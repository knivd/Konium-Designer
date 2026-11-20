/**
 * CAMtastic (the CAM editor's panel), as AD17 lists a CAM document's layers: each with its
 * colour, shown or hidden, its name and type; the current layer highlighted (a click makes a
 * layer current, a double-click shows only it). All On, All Off and the stack order.
 */
import { tick } from '../state';
import { activeCam, camChanged, setLayers } from '../camCommands';
import { CAM_LAYER_TYPES, colourOf, type CamLayerType } from '../../formats/cam/camDoc';

export function CamPanel() {
  void tick.value;
  const ed = activeCam();
  if (!ed) return <p class="panel-empty">Open a CAM document (File › New › CAM Document, or open Gerber and drill files) to see its layers here.</p>;
  const d = ed.doc;
  const count = (i: number) => { const l = d.layers[i]!; return l.data.kind === 'gerber' ? l.data.objects.length : l.data.hits.length; };
  return (
    <div class="cam-panel">
      <div class="cam-bar">
        <button class="btn" onClick={() => setLayers(ed, () => true)} title="View › Layers › All On">All On</button>
        <button class="btn" onClick={() => setLayers(ed, () => false)} title="View › Layers › All Off">All Off</button>
        <button class="btn" disabled={!d.layers.length} onClick={() => setLayers(ed, (_, i) => i === d.current)} title="View › Layers › Isolate: only the current layer">Isolate</button>
      </div>
      {!d.layers.length && <p class="panel-empty">No layers yet: File › Import › Quick Load brings Gerber and drill files in.</p>}
      <ul class="cam-layers" aria-label="CAM layers">
        {d.layers.map((l, i) => (
          <li key={`${i}-${l.name}`} class={i === d.current ? 'on' : ''} onClick={() => { d.current = i; tick.value++; }} onDblClick={() => setLayers(ed, (_, k) => k === i)} title={`${l.name}: ${count(i)} objects`}>
            <input type="checkbox" aria-label={`Show ${l.name}`} checked={l.visible} onClick={(e) => e.stopPropagation()} onChange={(e) => { l.visible = (e.target as HTMLInputElement).checked; camChanged(ed); }} />
            <input type="color" aria-label={`${l.name} colour`} value={l.colour} onClick={(e) => e.stopPropagation()} onInput={(e) => { l.colour = (e.target as HTMLInputElement).value; camChanged(ed); }} />
            <span class="cam-name">{l.name}</span>
            <select aria-label={`${l.name} type`} value={l.type} onClick={(e) => e.stopPropagation()} onChange={(e) => {
              const t = (e.target as HTMLSelectElement).value as CamLayerType;
              if (l.colour === colourOf(l.type)) l.colour = colourOf(t);
              l.type = t;
              camChanged(ed);
            }}>{CAM_LAYER_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          </li>
        ))}
      </ul>
    </div>
  );
}
