/**
 * PCB ActiveRoute, laid out as AD's: Action (the ActiveRoute and Route Guide buttons, Tune
 * Selected, Pin Swap Routing), Layers (where ActiveRoute routes: each route on one of them, no
 * vias), Control (Track-Track Space in Route Guide, the guide's width, Meander), and Pin Swap (the
 * components with pin swapping on, ticked here as in each component's own dialog). It says what
 * the selection would route. Route › ActiveRoute (Shift+A) uses the same settings.
 */
import { commands } from '../../core/commands';
import { settings, updateSettings } from '../../core/settings';
import { active, tick } from '../state';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../../editors/pcb/PcbLibEditor';
import { isSignal, layerColour, layerName, type LayerId } from '../../model/layers';
import { activeRouteConnections, activeRouteLayers } from '../pcbAutoCommands';
import { padsOf, pinSwapOn, swapInfo } from '../../model/pinSwap';
import { setComponentProps } from '../../model/pcbEdit';
import { natural } from '../../model/compile';
import { formatCoord, parseLengthIn } from '../../core/units';
import { PLANNED_NOTE, featureOn } from '../../core/release';

/** What the Action section says: what the selection would route, nothing selected, or a selection with nothing left to route. */
export function activeRouteStatus(conns: readonly { net: number }[], selected: boolean): string {
  if (!conns.length) return selected ? 'Nothing to route: the selection has no unrouted connections.' : 'Select components, pads or routing whose connections to route.';
  const nets = new Set(conns.map((c) => c.net)).size;
  return `${conns.length} connection${conns.length === 1 ? '' : 's'} of ${nets} net${nets === 1 ? '' : 's'} selected`;
}

export function ActiveRoutePanel() {
  void tick.value;
  const e = active.value?.editor;
  if (!(e instanceof PcbEditor) || e instanceof PcbLibEditor) return <p class="panel-empty">Open a board to route with ActiveRoute.</p>;
  const doc = e.doc;
  const sig = doc.board.copperStack.filter(isSignal);
  const on = new Set(activeRouteLayers(doc));
  const flip = (l: LayerId) => {
    const now = new Set(sig.filter((x) => on.has(x)));
    if (now.has(l)) now.delete(l); else now.add(l);
    // None ticked is every layer: keep at least one
    if (!now.size) return;
    updateSettings({ activeRouteLayers: [...now].length === sig.length ? [] : [...now] });
    tick.value++;
  };
  const conns = activeRouteConnections(e);
  // Route Guide and Pin Swapping: planned until their release
  const guide = featureOn('routeGuide');
  // The components whose pads have pin swap groups (Tools › Pin/Part Swapping › Configure)
  const swappable = doc.components.filter((c) => padsOf(doc, c.index).some((p) => swapInfo(doc, p).pin)).sort((a, b) => natural(a.designator, b.designator));
  const flipSwap = (i: number) => {
    const on = pinSwapOn(doc, i);
    e.undo.transact(on ? 'Disable Pin Swapping' : 'Enable Pin Swapping', (tx) => tx.add(setComponentProps(doc, i, { ENABLEPINSWAPPING: on ? 'FALSE' : 'TRUE' })));
    tick.value++;
  };
  const planned = (on: boolean) => (on ? '' : ' planned-feature');
  return (
    <div class="panel-body activeroute">
      <section aria-label="Action">
        <h4>Action</h4>
        <p class="small">{activeRouteStatus(conns, e.selection.size > 0)}</p>
        <div class="ar-actions">
          <button class="btn default" disabled={!conns.length} onClick={() => commands.run('route.active', 'pcb')}>ActiveRoute</button>
          <span class="muted small">Shift+A</span>
          <button class={`btn${planned(guide)}`} disabled={!conns.length || !guide} title={guide ? 'Draw the way the connections should go (Up and Down change its width), then ActiveRoute routes them along it' : PLANNED_NOTE} onClick={() => commands.run('route.activeGuide', 'pcb')}>Route Guide{!guide && <span class="planned-tag">Planned</span>}</button>
          <button class={`btn${planned(guide)}`} disabled={!guide} title={guide ? "The selected nets tuned to their Matched Lengths rules, with Interactive Length Tuning's pattern" : PLANNED_NOTE} onClick={() => commands.run('route.activeTune', 'pcb')}>Tune Selected{!guide && <span class="planned-tag">Planned</span>}</button>
        </div>
        <label class={`small${planned(guide)}`} title={guide ? 'Before routing, the selected components\' pins are swapped within their swap groups where that shortens the connections' : PLANNED_NOTE}>
          <input type="checkbox" disabled={!guide} checked={guide && settings.activeRoutePinSwap} onChange={(ev) => { updateSettings({ activeRoutePinSwap: (ev.target as HTMLInputElement).checked }); tick.value++; }} />Pin Swap Routing{!guide && <span class="planned-tag">Planned</span>}
        </label>
      </section>
      <section aria-label="Layers">
        <h4>Layers</h4>
        <ul class="ar-layers" role="group" aria-label="Layers to route on">
          {sig.map((l) => (
            <li key={l}>
              <label>
                <input type="checkbox" checked={on.has(l)} onChange={() => flip(l)} />
                <span class="ar-swatch" style={{ background: `#${layerColour(l).toString(16).padStart(6, '0')}` }} />
                {doc.board.layerNames.get(l) ?? layerName(l)}
              </label>
            </li>
          ))}
        </ul>
        <p class="muted small">Each route keeps to one of these layers: ActiveRoute places no vias.</p>
      </section>
      <section aria-label="Control">
        <h4>Control</h4>
        <label class={`ar-guide small${planned(guide)}`} title={guide ? 'Centre to centre between routes in a guide; empty: each net\'s width and clearance' : PLANNED_NOTE}>Track-Track Space in Route Guide <input aria-label="Track-Track Space in Route Guide" placeholder="By rules" disabled={!guide} value={settings.activeRouteGuideSpace > 0 ? formatCoord(settings.activeRouteGuideSpace, e.units()) : ''}
          onChange={(ev) => { const v = (ev.target as HTMLInputElement).value.trim(); const n = v ? parseLengthIn(v, e.units()) ?? 0 : 0; updateSettings({ activeRouteGuideSpace: n && n > 0 ? n : 0 }); tick.value++; }} /></label>
        <label class={`ar-guide small${planned(guide)}`} title={guide ? 'Empty: the connections\' tracks and gaps over the layers, and 30% more' : PLANNED_NOTE}>Guide width <input aria-label="Guide width" placeholder="Auto" disabled={!guide} value={settings.activeRouteGuideWidth > 0 ? formatCoord(settings.activeRouteGuideWidth, e.units()) : ''}
          onChange={(ev) => { const v = (ev.target as HTMLInputElement).value.trim(); const n = v ? parseLengthIn(v, e.units()) ?? 0 : 0; updateSettings({ activeRouteGuideWidth: n && n > 0 ? n : 0 }); tick.value++; }} /></label>
        <label><input type="checkbox" checked={settings.activeRouteMeander} onChange={(ev) => { updateSettings({ activeRouteMeander: (ev.target as HTMLInputElement).checked }); tick.value++; }} />Meander</label>
        <p class="muted small">Tunes the routed nets up to the longest net of their Matched Lengths rule, with the pattern of Interactive Length Tuning (not along a route guide).</p>
      </section>
      <section aria-label="Pin Swap" class={planned(guide).trim()} title={guide ? undefined : PLANNED_NOTE}>
        <h4>Pin Swap{!guide && <span class="planned-tag">Planned</span>}</h4>
        {swappable.length ? <ul class="ar-layers" role="group" aria-label="Components with Pin Swap Enabled">
          {swappable.map((c) => <li key={c.index}><label><input type="checkbox" disabled={!guide} checked={pinSwapOn(doc, c.index)} onChange={() => flipSwap(c.index)} />{c.designator}</label></li>)}
        </ul> : <p class="muted small">No component has pin swap groups yet: Tools › Pin/Part Swapping › Configure.</p>}
        <p class="muted small">Components with Pin Swap Enabled: their pins swap within their groups where that shortens the connections.</p>
      </section>
    </div>
  );
}
