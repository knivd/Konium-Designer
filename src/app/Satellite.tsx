/**
 * A document window's contents: its menus (for the document it shows), toolbars, tabs, the
 * document, its layer bar and the status bar; menus, dialogs and popups opened from it show in it.
 * The panels stay in the main window. A press or a key here makes this window's document the
 * active one.
 */
import { Component, type ComponentChildren } from 'preact';
import { settings } from '../core/settings';
import { MenuBar } from './MenuBar';
import { Toolbars } from './Toolbar';
import { DocTabs, LayerBar, StatusBar } from './Chrome';
import { Overlays, Stage } from './App';
import { docs, scopeOf } from './state';
import { activateWindow, renderIn, setWindowMounter, shownIn, uiWin, type DocWin } from './docWindows';
import { bindWindowInput } from './windowInput';
import { installColumnResize } from './columnResize';

/** A render error here shows its message in this window instead of a blank one. */
class Guard extends Component<{ children: ComponentChildren }, { error: Error | null }> {
  override state = { error: null as Error | null };
  override componentDidCatch(error: Error): void { this.setState({ error }); console.error(error); }
  override render() {
    const e = this.state.error;
    return e ? <div class="crash"><h1>This window hit an error</h1><pre>{e.stack ?? e.message}</pre><p>Close it: its documents go back to the main window.</p></div> : this.props.children;
  }
}

function SatelliteApp({ id }: { id: string }) {
  const shown = shownIn(id);
  const od = docs.value.find((d) => d.id === shown) ?? null;
  const scope = scopeOf(od);
  return (
    <div class={`app satellite${settings.toolbars ? '' : ' no-toolbars'}`}>
      <MenuBar scope={scope} od={od} />
      {settings.toolbars && <Toolbars scope={scope} od={od} />}
      <main class="centre">
        <DocTabs win={id} />
        <div class="stage"><Stage od={od} /></div>
        <LayerBar od={od} />
      </main>
      {settings.statusBar && <StatusBar od={od} />}
      <Overlays />
    </div>
  );
}

setWindowMounter((dw: DocWin) => {
  const win = dw.win;
  const offInput = bindWindowInput(win);
  const offColumns = installColumnResize(win.document);
  // Anything pressed here (or the window coming to the front) makes its document the active one
  const press = () => { uiWin.value = win; activateWindow(dw.id); };
  const focus = () => { uiWin.value = win; activateWindow(dw.id); };
  win.addEventListener('pointerdown', press, true);
  win.addEventListener('focus', focus);
  const unrender = renderIn(dw, <Guard><SatelliteApp id={dw.id} /></Guard>);
  return () => {
    unrender();
    offInput(); offColumns();
    try { win.removeEventListener('pointerdown', press, true); win.removeEventListener('focus', focus); } catch { /* closed */ }
  };
});
