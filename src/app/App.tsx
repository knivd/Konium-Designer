import { HelpPage } from './HelpPage';
import { useEffect } from 'preact/hooks';
import { fallbackLines, setDefaultStartIn, setWriteFallbackNotice } from '../platform/fs';
import { reopenLastWorkspace } from './sessionMemory';
import { SelectionPopup } from './SelectionPopup';
import { OutJobView } from './OutJobView';
import { DbLinkView } from './DocViews43';
import { BomDocView } from './BomDocView';
import { DiagramView } from './DiagramView';
import { EnclosureView } from './EnclosureView';
import { RequirementsView } from './RequirementsView';
import { PlannedDocView, plannedDoc } from './PlannedDoc';
import { DraftView } from './DraftView';
import { MbaView, MbsView } from './MultiBoardViews';
import { DbLibView } from './DbLibView';
import { SimTextView } from './SimTextView';
import { SimDataView } from './SimDataView';
import { StepDocView } from './StepDocView';
import { quitting } from './windows';
import { bindChainPopup, ChainPopup, MenuBar } from './MenuBar';
import { bindCtxFocus } from './workspace';
import { compareView } from './compare';
import { CompareView } from './CompareView';
import { DocTabs, LayerBar, ShortcutSheet, StatusBar, TiledHost, Toast, ViewportHost } from './Chrome';
import { DonateAsk } from './DonateAsk';
import { startDonate } from '../platform/donate';
import { openBatch, refreshRecent, reopenRecent, reopenRecentDocument } from './actions';
import { onLaunchFiles } from '../platform/fs';
import { ProjectAccess } from './ProjectAccess';
import { isDocDirty, activeId, docs, HELP, helpOpen, HOME, homeOpen, notify, openHome, projects, scopeOf, showPrefs, showShortcuts, tick, tileMode, type OpenDoc } from './state';
import { recovery, refreshRecovery, startBackup } from './backup';
import { effect } from '@preact/signals';
import { EmptyStage, HomePage } from './Home';
import { checkForUpdate, installed, online, served } from '../platform/distribution';
import { GetKoniumDialog } from './dialogs/GetKonium';
import { restoreModelFolders } from '../platform/modelFolders';
import { flushReports } from '../platform/report';
import { Workspace } from './dock/Dock';
import { showPanel } from './dock/store';
import { Toolbars } from './Toolbar';
import { Preferences } from './Preferences';
import { settings, settingsChanged, type Settings } from '../core/settings';
import { countVisit, mayConnect, sealOffline, sealedOffline, tellServiceWorker } from '../platform/network';
import { loadNews } from '../platform/whatsNew';
import { Dialogs, showDialog } from './dialogs';
import { InfoDialog } from './dialogs/Confirm';
import { noteError } from './diagnostics';
import { restoreInstalledLibraries } from './installedStore';
import { featureOn } from '../core/release';
import { askedPart, partAsked } from './worldLibrary';
import { restoreShelf } from './partShelf';
import { installColumnResize } from './columnResize';
import { bindWindowInput } from './windowInput';
import { activateWindow, mainShown, shownHere, trackOwner, useWin } from './docWindows';
import { textPrefs, type CodePage } from '../formats/text';

/** Preferences › System › General › Text without Unicode: how older files' 8-bit text is read. */
const applyCodePage = () => { textPrefs.codePage = settings.textCodePage === 'auto' ? 'auto' : (Number(settings.textCodePage) as CodePage); };
applyCodePage();
settingsChanged.on((p) => { if ('textCodePage' in p) applyCodePage(); });

const applyTheme = () => {
  const r = document.documentElement;
  r.dataset.theme = settings.theme;
  // System › View: shadows round menus, toolbars and panels
  r.dataset.shadows = settings.panelShadows ? 'on' : 'off';
  // System › View and Transparency: floating panels hidden while another window is in use; see-through while a tool works
  r.toggleAttribute('data-floats-hide', settings.hideFloatsOnBlur);
  r.toggleAttribute('data-floats-see', settings.transparentFloats);
  // The installed app's title bar (and the window controls over the menu bar) in the menu bar's colour
  const bar = getComputedStyle(r).getPropertyValue('--bar-a').trim();
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (bar && meta && meta.content !== bar) meta.content = bar;
};

/** Offline or updates switched (Home page, Preferences): sealed at once, or open again from the next load. */
function connectionsChanged(patch: Partial<Settings>): void {
  void tellServiceWorker();
  if (patch.offline === true) { sealOffline(); notify('Network activity off: Konium Designer makes no connections now, and the browser refuses any it could'); }
  else if (patch.offline === false && sealedOffline()) notify('Network activity on: connections come back when Konium Designer is loaded again (reload the page, or restart the app)');
  void loadNews(true);
  if (mayConnect('updates')) { countVisit(); void checkForUpdate(); }
}

/**
 * System › Transparency › Dynamic transparency: while a tool is at work, each floating panel is
 * the more see-through the nearer the cursor — the highest transparency touching it, the
 * lowest at the distance factor (pixels) and beyond.
 */
export function dynamicTransparency(x: number, y: number): void {
  if (typeof document === 'undefined') return;
  const on = settings.transparentFloats && settings.dynTransparency && document.documentElement.hasAttribute('data-tool-at-work');
  for (const el of document.querySelectorAll<HTMLElement>('.dock-float')) {
    if (!on) { el.style.removeProperty('--float-see'); continue; }
    const r = el.getBoundingClientRect();
    const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
    const t = Math.min(1, d / Math.max(1, settings.dynDistance));
    const see = settings.dynHigh - (settings.dynHigh - settings.dynLow) * t;
    el.style.setProperty('--float-see', String(Math.max(0.05, 1 - see / 100)));
  }
}

export function App() {
  useEffect(() => {
    applyTheme();
    const away = () => document.documentElement.toggleAttribute('data-away', true), back = () => document.documentElement.toggleAttribute('data-away', false);
    window.addEventListener('blur', away);
    window.addEventListener('focus', back);
    bindChainPopup();
    bindCtxFocus();
    startDonate();
    // Keys, right-click menus and dropped files (the same in every Konium window)
    const offInput = bindWindowInput(window);
    const onMove = (e: MouseEvent) => dynamicTransparency(e.clientX, e.clientY);
    window.addEventListener('mousemove', onMove, { passive: true });
    // A press on the main window's menus, toolbars, tabs or document makes its document the active one
    // (the panels act on the active document, which may be in a document window)
    const onPress = (e: PointerEvent) => { if ((e.target as HTMLElement).closest?.('.menubar, .toolbars, .centre')) activateWindow(''); };
    window.addEventListener('pointerdown', onPress, true);
    onLaunchFiles(openBatch);
    // The website's Install (konium.app/download): the app opened with ?install shows its install window at once
    if (served && !installed() && /[?&]install\b/.test(location.search)) showDialog(GetKoniumDialog);
    // A part's public page (konium.app/parts/...) opens the app with ?part=<its number>: Tools › Parts, with the number typed
    if (featureOn('partsLibrary') && askedPart(location.search)) { partAsked.value = askedPart(location.search); showPanel('parts'); }
    // System › General › Document Path: where file selectors start
    setDefaultStartIn(() => (settings.documentPath === 'last' ? undefined : settings.documentPath));
    // A file downloaded because its place couldn't be written: said in a window
    setWriteFallbackNotice((f) => { noteError(`${f.name} could not be written (${f.why}): downloaded instead`); showDialog(InfoDialog, { title: f.unsaved ? 'Not Saved to Its File' : 'Downloaded Instead', lines: fallbackLines(f) }); });
    // System › General › Reopen Last Workspace: once the recent lists are read
    void refreshRecent().then(() => reopenLastWorkspace(reopenRecent, reopenRecentDocument));
    void restoreInstalledLibraries();
    // The parts shelf (R21): the parts kept here, as two libraries among the installed ones
    if (featureOn('partsLibrary')) void restoreShelf();
    installColumnResize();
    const offSettings = settingsChanged.on((patch) => {
      if ('theme' in patch || 'panelShadows' in patch || 'hideFloatsOnBlur' in patch || 'transparentFloats' in patch) applyTheme();
      if ('offline' in patch || 'checkUpdates' in patch) connectionsChanged(patch);
      for (const d of docs.value) d.editor?.invalidate();
      tick.value++;
    });
    // Preferences › System › General › Open Home Page if no documents open: at the start, and
    // whenever the last document closes (the Home tab stays the active one while it is open)
    if (settings.openHomePage) openHome();
    let had = 0;
    const offHome = effect(() => {
      const n = docs.value.filter((d) => !d.hidden).length;
      if (n === 0 && had > 0) { if (activeId.value === HELP && helpOpen.value) { /* the reference stays in front */ } else if (homeOpen.value) activeId.value = HOME; else if (settings.openHomePage) openHome(); }
      had = n;
    });
    // A newer version: looked for a little after starting, on coming back online, and every few hours
    const lookForUpdate = () => { if (settings.checkUpdates) void checkForUpdate(); };
    const firstLook = setTimeout(lookForUpdate, 4000);
    const everyFew = setInterval(lookForUpdate, 6 * 3600_000);
    // The STEP model folders remembered from earlier sessions (Preferences › PCB Editor › Models)
    void restoreModelFolders();
    // Bug reports kept while offline go when the connection is back
    const sendWaiting = () => { void flushReports().then((n) => { if (n) notify(`${n} waiting bug report${n > 1 ? 's' : ''} sent`); }); };
    const offOnline = effect(() => { if (online.value) { lookForUpdate(); setTimeout(sendWaiting, 3000); } });
    // Auto Save and recovery: copies of changed documents in the browser; those an ended session left are offered on the Home page
    const stopBackup = startBackup();
    const recoverLook = setTimeout(() => { void refreshRecovery().then(() => { const n = recovery.value.length; if (n) notify(`${n} document${n > 1 ? 's' : ''} with unsaved changes from an earlier session can be recovered (Home)`); }); }, 1200);
    const beforeUnload = (e: BeforeUnloadEvent) => { if (!quitting.value && (docs.value.some(isDocDirty) || projects.value.some((p) => p.dirty))) e.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      offInput();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('beforeunload', beforeUnload);
      stopBackup(); clearTimeout(recoverLook);
      offSettings();
      offHome(); offOnline(); clearTimeout(firstLook); clearInterval(everyFew);
    };
  }, []);

  void tick.value;
  void showShortcuts.value;
  void showPrefs.value;
  const shown = mainShown.value;
  const od = docs.value.find((d) => d.id === shown) ?? null;
  return (
    <div class={`app${settings.toolbars ? '' : ' no-toolbars'}`}>
      <MenuBar scope={scopeOf(od)} od={od} />
      {settings.toolbars && <Toolbars scope={scopeOf(od)} od={od} />}
      <Workspace>
        <DocTabs />
        <div class="stage">
          {homeOpen.value && shown === HOME ? <HomePage />
            : helpOpen.value && shown === HELP ? <HelpPage />
            : compareView.value && shown === compareView.value.newer.od.id ? <CompareView />
            : tileMode.value && docs.value.filter((d) => d.editor && !d.hidden && mainShown.value !== null).length > 1 && tiles() > 1 ? <TiledHost mode={tileMode.value} />
            : <Stage od={od} />}
        </div>
        <LayerBar od={od} />
      </Workspace>
      {settings.statusBar && <StatusBar od={od} />}
      <Overlays />
      <ProjectAccess />
      <DonateAsk />
    </div>
  );
}

/** How many documents the main window would tile. */
function tiles(): number { return docs.value.filter((d) => d.editor && !d.hidden && !d.forCompare && !isElsewhere(d)).length; }
const isElsewhere = (d: OpenDoc) => !!docPlaceOf(d.id);
import { placeOf as docPlaceOf } from './docWindows';

/** A document in a window's stage: its editor's view, or its own page by its kind. */
export function Stage({ od }: { od: OpenDoc | null }) {
  return od && plannedDoc(od) ? <PlannedDocView od={od} feature={plannedDoc(od)!} /> : od?.editor ? <ViewportHost od={od} /> : od?.doc.kind === 'OutJob' ? <OutJobView od={od} /> : od?.doc.kind === 'BomDoc' ? <BomDocView od={od} /> : od?.doc.kind === 'DbLink' ? <DbLinkView od={od} /> : od?.doc.kind === 'DbLib' ? <DbLibView od={od} /> : od?.doc.kind === 'StepDoc' ? <StepDocView od={od} /> : od?.doc.kind === 'SimText' ? <SimTextView key={od.id} od={od} /> : od?.doc.kind === 'SimData' ? <SimDataView key={od.id} od={od} /> : od?.doc.kind === 'Draftsman' ? <DraftView key={od.id} od={od} /> : od?.doc.kind === 'MbsDoc' ? <MbsView key={od.id} od={od} /> : od?.doc.kind === 'MbaDoc' ? <MbaView key={od.id} od={od} /> : od?.doc.kind === 'Diagram' ? <DiagramView key={od.id} od={od} /> : od?.doc.kind === 'Enclosure' ? <EnclosureView key={od.id} od={od} /> : od?.doc.kind === 'ReqDoc' ? <RequirementsView key={od.id} od={od} /> : od ? <InspectOnlyNotice od={od} /> : <EmptyStage />;
}

trackOwner('prefs', () => showPrefs.value);
/** What opens over a window: menus, popups, dialogs, notices (each in the window it opened in). */
export function Overlays() {
  const here = useWin();
  return (
    <>
      <ChainPopup />
      <SelectionPopup />
      <ShortcutSheet />
      {shownHere('prefs', here) && <Preferences />}
      <Dialogs />
      <Toast />
    </>
  );
}

function InspectOnlyNotice({ od }: { od: OpenDoc }) {
  return (
    <div class="welcome">
      <div class="welcome-card">
        <h1>{od.name}</h1>
        <p class="lede">{od.doc.kind === 'Inspect' ? od.doc.detected : od.doc.kind} files open read-only for now.</p>
        <button class="btn default" onClick={() => showPanel('fileInspector')}>Show in File Inspector</button>
      </div>
    </div>
  );
}
