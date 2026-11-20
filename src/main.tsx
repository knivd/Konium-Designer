import { render, Component, type ComponentChildren } from 'preact';
import '@fontsource/ibm-plex-sans-condensed/latin-400.css';
import '@fontsource/ibm-plex-sans-condensed/latin-500.css';
import '@fontsource/ibm-plex-sans-condensed/latin-600.css';
// (Central European letters in the same face: Ł, ő, ť … in names and panels; other alphabets come from the system's fonts)
import '@fontsource/ibm-plex-sans-condensed/latin-ext-400.css';
import '@fontsource/ibm-plex-sans-condensed/latin-ext-500.css';
import '@fontsource/ibm-plex-sans-condensed/latin-ext-600.css';
import './app/styles.css';
import './app/commands';
import { App } from './app/App';
// Document windows (Window › Open In New Window) draw with the app's own parts
import './app/Satellite';
import { notify } from './app/state';
import { webGlFallback } from './render/Viewport';
import { startConnections } from './platform/network';
import { siteBase } from './platform/distribution';
import { settings } from './core/settings';

// Offline sealed (and the service worker told) before anything else could connect
startConnections();

/** Any render error shows its message instead of leaving a blank window. */
class Guard extends Component<{ children: ComponentChildren }, { error: Error | null }> {
  override state = { error: null as Error | null };
  override componentDidCatch(error: Error): void { this.setState({ error }); console.error(error); }
  override render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div class="crash">
        <h1>Konium Designer hit an error</h1>
        <pre>{e.stack ?? e.message}</pre>
        <button class="primary" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

const root = document.getElementById('app')!;
root.textContent = '';
render(<Guard><App /></Guard>, root);
// No WebGL 2 here: the editors draw with the 2D canvas (said once)
webGlFallback.listeners.add(() => notify('This browser has WebGL 2 turned off, or its graphics driver is blocked: Konium Designer draws with the 2D canvas instead (slower on big boards; the 3D views need WebGL 2)'));

const served = location.protocol === 'http:' || location.protocol === 'https:';
// With network activity off nothing is asked of the site, the install manifest and the offline files' worker included
// (a worker registered before goes on serving the copy it keeps)
if (served && !settings.offline) {
  // PWA bits only make sense over http(s); from file:// they would just log CORS errors.
  const link = document.createElement('link');
  link.rel = 'manifest';
  // The website's manifest (konium.app/manifest.webmanifest, the app at app/): one install, kept where it always was
  link.href = `${siteBase()}manifest.webmanifest`;
  document.head.append(link);
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker:', e)); });
  }
}

// Dev/test hook: lets tooling drive the app without UI clicks.
if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
  void Promise.all([import('./app/actions'), import('./app/state'), import('./formats/synthetic/demo'), import('./app/dock/store'), import('./core/commands'), import('./core/settings'), import('./app/outjobRun'), import('./app/backup'), import('./model/drcOptions'), import('./app/vcs'), import('./platform/donate'), import('./app/antennaRun'), import('./app/liveSim'), import('./app/partShelf')]).then(([a, s, d, k, c, p, o, bk, dr, v, dn, an, lv, ps]) => {
    // run(id): a command by id, as a menu item or shortcut would run it (commandIds: every one there is); prefs: Preferences as the dialog sets them; outjob: what Output Jobs generate
    Object.assign(window, { konium: { ...a, parts: () => ps.shelf.value.map((x) => x.record), partRemove: (mpn: string) => ps.removePart(mpn), state: s, demoFiles: d.demoFiles, dock: k, prefs: { get: () => p.settings, set: p.updateSettings }, run: (id: string) => c.commands.run(id, s.activeScope.value), commandIds: () => c.commands.all().map((x) => x.id), outjob: o, backup: bk, drcSettings: dr.drcSettings, vcs: v, donate: dn, gpuCheck: an.gpuSelfCheck, liveReading: lv.liveReading, liveProbe: lv.probeAt, liveScope: (id?: number) => lv.scopeData(id), liveMonitors: lv.liveMonitors, liveFieldsNow: lv.liveFields, liveScopes: () => lv.scope.value.scopes.map((s: { id: number }) => s.id), liveFields: lv.liveFields, liveLights: lv.liveLights, liveDisplays: lv.liveDisplays, liveFuses: lv.liveFuses, liveStress: lv.liveStress, liveReadables: lv.liveReadables, liveSolve: lv.liveSolve, liveSound: lv.liveSound, liveExample: (id: string) => import('./app/simCommands').then((m) => m.openLiveExample(id)), liveKey: lv.sketchKey } });
  });
}
