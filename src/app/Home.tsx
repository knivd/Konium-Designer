/**
 * View › Home: AD17's Home page as a tab ahead of the documents [est: AD17's layout, made Konium's]:
 * what Konium is (for Altium Designer users, on their own files: the one place besides About that
 * names it, with the trademark line), things to start with, the recent projects and documents to reopen, the version (and a newer
 * one when there is), getting Konium onto this computer when it runs in a browser tab, and
 * supporting it. Opens by itself when no documents are open (Preferences › System › General).
 */
import { featureOn } from '../core/release';
import { locale } from '../core/locale';
import { commands } from '../core/commands';
import { pendingWorkspace } from './sessionMemory';
import { settings, settingsChanged, updateSettings } from '../core/settings';
import { ColourIcon, Logo, docIcon } from './icons';
import { notify, recentDocuments, recentProjects } from './state';
import { refreshRecent, reopenRecent, reopenRecentDocument } from './actions';
import { forgetDocument, forgetProject, recentSupported } from '../platform/recent';
import { APP_VERSION, canGet, fromFile, latest, update } from '../platform/distribution';
import { showDialog } from './dialogs';
import { GetKoniumDialog } from './dialogs/GetKonium';
import { SupportDialog } from './dialogs/Support';
import { ReportBugDialog } from './dialogs/ReportBug';
import { useEffect, useState } from 'preact/hooks';
import { Dialog } from './Dialog';
import { closeDialog } from './dialogs';
import { lastSeen, loadNews, markSeen, news, type NewsRelease } from '../platform/whatsNew';
import { versionNumber } from '../platform/distribution';
import { discardCopies, recoverCopies, recovery } from './backup';
import { AboutDialog } from './dialogs/About';

const run = (id: string) => () => commands.run(id, 'global');

/** Documents an earlier session left with unsaved changes (a crash, a tab closed): opened again or let go. */
function RecoverCard() {
  const list = recovery.value;
  if (!list.length) return null;
  const when = (t: number) => new Date(t).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div class="home-recover" role="status" aria-label="Recover documents">
      <strong>Unsaved changes from an earlier session</strong>
      <ul>
        {list.map((c) => (
          <li key={c.key}><span>{c.name}</span><span class="muted small">{c.project ? `${c.project}, ` : ''}auto-saved {when(c.at)}</span>
            <button class="btn" onClick={() => void recoverCopies([c])}>Open</button>
            <button class="btn" onClick={() => void discardCopies([c])}>Discard</button></li>
        ))}
      </ul>
      {list.length > 1 && <div class="home-recover-all"><button class="btn default" onClick={() => void recoverCopies(list)}>Open all</button><button class="btn" onClick={() => void discardCopies(list)}>Discard all</button></div>}
      <p class="muted small">Opened, a document is unsaved until you save it (File › Save As puts it back where it was). Auto Save: Preferences › Data Management › Backup.</p>
    </div>
  );
}

function Item({ icon, label, onClick, hint }: { icon: string; label: string; onClick: () => void; hint?: string }) {
  return (
    <li><button class="home-link" onClick={onClick} title={hint}><ColourIcon name={icon} size={16} /><span>{label}</span></button></li>
  );
}

/** System › General › Reopen Last Workspace, where the browser wants a click before it lets Konium back into the folders. */
function LastWorkspaceCard() {
  const w = pendingWorkspace.value;
  if (!w) return null;
  const names = [...w.projects.map((r) => r.name.replace(/\.prjpcb$/i, '')), ...w.documents.map((r) => r.name)];
  const go = async () => { pendingWorkspace.value = null; for (const r of w.projects) await reopenRecent(r); for (const r of w.documents) await reopenRecentDocument(r); };
  return (
    <div class="home-lastws" role="region" aria-label="Last workspace">
      <p>Open when Konium Designer was last closed: {names.join(', ')}</p>
      <button class="btn default" onClick={() => void go()}>Reopen Last Workspace</button>
      <button class="btn" onClick={() => { pendingWorkspace.value = null; }}>Not now</button>
    </div>
  );
}

export function HomePage() {
  // The switches below show the settings as they are now (changed here or in Preferences)
  const [, redraw] = useState(0);
  useEffect(() => settingsChanged.on((p) => { if ('offline' in p || 'checkUpdates' in p || 'openHomePage' in p) redraw((n) => n + 1); }), []);
  const projects = recentProjects.value, docs = recentDocuments.value, newer = latest.value;
  return (
    <div class="home" aria-label="Home">
      <header class="home-head">
        <Logo size={38} />
        <div class="home-title">
          <h1>Konium Designer</h1>
          <p class="home-pitch">For engineers who work in Altium Designer: the same environment, so you feel at home.</p>
          <p class="home-files">Opens, edits and saves real Altium projects and libraries: .PrjPcb, .SchDoc, .PcbDoc, .SchLib, .PcbLib, .DbLib, .OutJob.</p>
          <p class="home-version">Version {APP_VERSION}. Schematic capture, PCB layout and outputs, free and on your own computer.</p>
        </div>
        <RecoverCard />
        {newer && (
          <div class="home-update" role="status">
            <span>Konium Designer {newer.version} is out{newer.notes ? `: ${newer.notes}` : '.'}</span>
            <button class="btn default" onClick={update}>{fromFile ? 'Get it...' : 'Update now'}</button>
          </div>
        )}
      </header>
      <div class="home-cols">
        <section class="home-col" aria-label="Start">
          <h2>Start</h2>
          <ul class="home-links">
            <Item icon="openProject" label="Open a project..." onClick={run('file.openProject')} />
            <Item icon="open" label="Open a document..." onClick={run('file.open')} />
            <Item icon="demo" label="Open the demo project" onClick={run('file.openDemo')} />
            <Item icon="simDemo" label="Open the simulation demo" onClick={run('file.openSimDemo')} hint="A transistor amplifier: Design › Simulate › Mixed Sim runs its operating point, transient and AC analyses" />
            {featureOn('live') && <Item icon="liveSim" label="Live Simulation examples..." onClick={run('live.examples')} hint="Circuits that run as they open, to watch and to change: a divider, filters, rectifiers, amplifiers, oscillators and more" />}
            {featureOn('calculators') && <Item icon="calculator" label="Calculators..." onClick={run('tools.calculators')} hint="A divider, an LED's resistor, RC and LC, a regulator's feedback pair, a track's current and width, a via, spacing for a voltage, impedance: Tools › Calculators" />}
            <Item icon="importWizard" label="Import from another tool..." onClick={run('file.importWizard')} hint="KiCad, PADS, EasyEDA, OrCAD, Allegro, EAGLE, DipTrace, IPC-2581: File › Import Wizard" />
            <Item icon="exportWizard" label="Export to another tool..." onClick={run('file.exportWizard')} hint="The open project as KiCad, PADS, EasyEDA, OrCAD, Allegro, EAGLE or DipTrace files: File › Export Wizard" />
          </ul>
          <h2>New</h2>
          <ul class="home-links">
            <Item icon="prjpcb" label="PCB Project..." onClick={run('file.newProject')} />
            <Item icon="schdoc" label="Schematic" onClick={run('file.newSch')} />
            <Item icon="pcbdoc" label="PCB" onClick={run('file.newPcb')} />
            <Item icon="schlib" label="Schematic library" onClick={run('file.newSchLib')} />
            <Item icon="pcblib" label="PCB library" onClick={run('file.newPcbLib')} />
            <Item icon="stepDoc" label="3D model (STEP)" onClick={run('file.newStepModel')} />
            {featureOn('diagrams') && <Item icon="diagramDoc" label="Diagram" onClick={run('file.newDiagram')} />}
            {featureOn('requirements') && <Item icon="reqDoc" label="Requirements" onClick={run('file.newRequirements')} />}
          </ul>
        </section>
        <section class="home-col" aria-label="Recent">
          <WhatsNewCard />
          <LastWorkspaceCard />
          <h2>Recent projects</h2>
          {projects.length ? (
            <ul class="home-recent">
              {projects.map((r) => (
                <li key={r.key}>
                  <button class="home-link" onClick={() => void reopenRecent(r)} title={`${r.folder}/${r.prjPath}`}>
                    <ColourIcon name="prjpcb" size={16} /><span class="home-recent-name">{r.name.replace(/\.prjpcb$/i, '')}</span><span class="home-recent-where">{r.folder}</span>
                  </button>
                  <button class="home-forget" title="Remove from the list" aria-label={`Remove ${r.name} from recent projects`} onClick={async () => { await forgetProject(r.key); await refreshRecent(); }}>×</button>
                </li>
              ))}
            </ul>
          ) : <p class="home-none">{recentSupported() ? 'Projects you open from a folder show here.' : 'This browser can\'t keep recent projects (Chrome and Edge can).'}</p>}
          <h2>Recent documents</h2>
          {docs.length ? (
            <ul class="home-recent">
              {docs.map((r) => (
                <li key={r.key}>
                  <button class="home-link" onClick={() => void reopenRecentDocument(r)} title={r.name}>
                    <ColourIcon name={docIcon(r.name)} size={16} /><span class="home-recent-name">{r.name}</span><span class="home-recent-where">{new Date(r.at).toLocaleDateString(locale())}</span>
                  </button>
                  <button class="home-forget" title="Remove from the list" aria-label={`Remove ${r.name} from recent documents`} onClick={async () => { await forgetDocument(r.key); await refreshRecent(); }}>×</button>
                </li>
              ))}
            </ul>
          ) : <p class="home-none">{recentSupported() ? 'Documents you open on their own show here.' : 'This browser can\'t keep recent documents.'}</p>}
        </section>
        <section class="home-col home-side" aria-label="Konium Designer">
          {canGet() && (
            <div class="home-box home-get">
              <h2><ColourIcon name="download" size={16} /> Install Konium Designer</h2>
              <p>As an app in a window of its own, without the browser's address bar and buttons, or as one downloaded file. Either way it runs without a connection.</p>
              <button class="btn default" onClick={() => showDialog(GetKoniumDialog)}>Install or download...</button>
            </div>
          )}
          <div class="home-box home-support">
            <h2><ColourIcon name="tipJar" size={16} /> Support Konium Designer</h2>
            <p>Konium Designer is free, with no adverts or accounts. If it helps with your projects, you can chip in.</p>
            <button class="btn" onClick={() => showDialog(SupportDialog)}>Chip in...</button>
          </div>
          <div class="home-box home-bug">
            <h2><ColourIcon name="bug" size={16} /> Found a bug?</h2>
            <p>Tell Konium Designer's developer what went wrong, with a screenshot or the file that shows it.</p>
            <button class="btn" onClick={() => showDialog(ReportBugDialog)}>Report a bug...</button>
          </div>
          <div class="home-box home-netbox" aria-label="Network activity">
            <h2><ColourIcon name="network" size={16} /> Network activity</h2>
            <label title="Off: Konium Designer makes no connections at all (no updates, What's New, AI jobs, supplier data or reports), and the browser itself is told to refuse them">
              <input type="checkbox" checked={!settings.offline} onChange={(e) => updateSettings({ offline: !(e.target as HTMLInputElement).checked })} /> Allow network activity</label>
            <label title="Ask konium.app for a newer version and What's New. Off, a copy installed from konium.app stays on the version it has">
              <input type="checkbox" checked={settings.checkUpdates && !settings.offline} disabled={settings.offline} onChange={(e) => updateSettings({ checkUpdates: (e.target as HTMLInputElement).checked })} /> Check konium.app for updates and What's New</label>
            <button class="link" onClick={() => showDialog(AboutDialog, { at: 'connections' as const })}>What Konium Designer connects to</button>
          </div>
          <div class="home-box">
            <h2>Good to know</h2>
            <ul class="home-tips">
              <li>Drop a .PrjPcb, a project folder or documents anywhere in the window.</li>
              <li>F1 opens the User Guide at what you are doing; ? lists the shortcut keys; letter shortcuts work as you know them (P, W for a wire).</li>
              <li>Your files stay on this computer: only what you choose to send (a bug report, an AI job) leaves it. Network activity, above, can stop every connection.</li>
            </ul>
          </div>
        </section>
      </div>
      <WhatsNew />
      <footer class="home-foot">
        <label><input type="checkbox" checked={settings.openHomePage} onChange={(e) => updateSettings({ openHomePage: (e.target as HTMLInputElement).checked })} /> Open the Home page when no documents are open</label>
        <span class="spacer" />
        <span>View › Home opens it again.</span>
      </footer>
      <p class="home-legal">Altium Designer is a trademark of Altium Ltd. Konium Designer is independent and not affiliated with it.</p>
    </div>
  );
}

/**
 * A release's SHA-256 at the right of its heading: the checksum of its single file, as a download
 * saves it (Konium-<version>.html), to check a copy is the one published. Click to copy it.
 */
function ShaStamp({ version, sha256 }: { version: string; sha256: string }) {
  const copy = () => { void navigator.clipboard?.writeText(sha256).then(() => notify(`SHA-256 of Konium Designer ${version} copied`), () => notify(sha256)); };
  return (
    <button class="news-sha" data-sha256={sha256} onClick={copy}
      title={`SHA-256 of Konium-${version}.html, the single file a download saves:\n${sha256}\n\nTo check a copy — Windows: certutil -hashfile Konium-${version}.html SHA256; macOS and Linux: shasum -a 256 Konium-${version}.html\nClick to copy it.`}>
      SHA-256 <code>{sha256.slice(0, 8)}…{sha256.slice(-8)}</code>
    </button>
  );
}

/** A picture from What's New (or the help), full size. */
export function NewsPicture({ src, alt, title = "What's New" }: { src: string; alt: string; title?: string }) {
  return (
    <Dialog title={title} width={1260} onClose={closeDialog} class="news-picture"
      footer={<><span class="small muted news-picture-caption">{alt}</span><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <img src={src} alt={alt} />
    </Dialog>
  );
}

/**
 * The latest release at the top of the middle column, where it's seen without scrolling and
 * leaves the side column's boxes in view: its first picture as a thumbnail beside its version,
 * and title, and a button down to What's New in full.
 */
function WhatsNewCard() {
  const n = news.value;
  const [seen] = useState(lastSeen);
  useEffect(() => { void loadNews(); }, []);
  const r = n.state === 'ok' ? n.releases[0] : undefined;
  if (!r) return null;
  const fresh = versionNumber(r.version) > versionNumber(APP_VERSION) || (seen ? versionNumber(r.version) > versionNumber(seen) : r.version === APP_VERSION);
  const shot = r.items.find((it) => it.image);
  const go = () => document.getElementById('whats-new')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <div class={`home-box home-newscard${fresh ? ' fresh' : ''}${shot ? '' : ' no-shot'}`}>
      <h2><ColourIcon name="whatsNew" size={16} /> What's New{fresh && <span class="news-badge">New</span>}</h2>
      <p><b>{r.version}</b> {r.title}</p>
      {shot && <button class="news-card-shot" title="See what's new" onClick={go}><img src={shot.image} alt={shot.alt ?? ''} loading="lazy" style={shot.focus ? { objectPosition: shot.focus } : undefined} /></button>}
      <button class="btn" onClick={go}>See what's new</button>
    </div>
  );
}

const SHOWN = 3;
/**
 * What's New: the feature log from konium.app, the latest releases first, pictures where they show
 * a feature (click for full size). The latest release this copy has is marked New until it has been
 * shown; one newer than this copy says so.
 */
function WhatsNew() {
  const n = news.value;
  const [all, setAll] = useState(false);
  const [seen] = useState(lastSeen);
  useEffect(() => { void loadNews(); }, []);
  useEffect(() => { if (n.state === 'ok' && n.releases[0]) markSeen(n.releases[0].version); }, [n]);
  const list = n.state === 'ok' ? n.releases : [];
  // Only the latest release this copy has, when it wasn't shown here before (not every one since the last look)
  const latest = list.find((r) => versionNumber(r.version) <= versionNumber(APP_VERSION));
  const isNew = (r: NewsRelease) => r === latest && (seen ? versionNumber(r.version) > versionNumber(seen) : r.version === APP_VERSION);
  return (
    <section id="whats-new" class="home-news" aria-label="What's New">
      <h2><ColourIcon name="whatsNew" size={16} /> What's New</h2>
      {n.state === 'loading' && <p class="home-none">Reading the feature log from konium.app…</p>}
      {n.state === 'off' && <p class="home-none">{n.why === 'offline' ? 'Network activity is off: What\'s New comes from konium.app, so it isn\'t shown.' : 'What\'s New comes from konium.app: tick Check konium.app for updates and What\'s New, above, to see it.'}</p>}
      {(n.state === 'offline' || n.state === 'failed') && (
        <p class="home-none">{n.state === 'offline' ? 'What\'s New comes from konium.app: it shows when there\'s a connection.' : 'konium.app didn\'t answer.'} <button class="link" onClick={() => void loadNews(true)}>Try again</button></p>
      )}
      {list.slice(0, all ? list.length : SHOWN).map((r) => (
        <article key={r.version} class="news-release">
          <h3>
            <span class="news-version">{r.version}</span><span class="news-title">{r.title}</span>
            {versionNumber(r.version) > versionNumber(APP_VERSION) ? <span class="news-badge newer">Newer than this copy</span> : isNew(r) && <span class="news-badge">New</span>}
            {r.sha256 && <ShaStamp version={r.version} sha256={r.sha256} />}
          </h3>
          <ul>
            {r.items.map((it, i) => (
              <li key={i}>
                <p>{it.text}</p>
                {it.image && (
                  <button class="news-shot" title="Show full size" onClick={() => showDialog(NewsPicture, { src: it.image!, alt: it.alt ?? '' })}>
                    <img src={it.image} alt={it.alt ?? ''} loading="lazy" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </article>
      ))}
      {list.length > SHOWN && <button class="link news-more" onClick={() => setAll(!all)}>{all ? 'Fewer releases' : `Earlier releases (${list.length - SHOWN})`}</button>}
    </section>
  );
}

/** No documents and no Home tab: the empty stage, as AD shows it, with where to go. */
export function EmptyStage() {
  return (
    <div class="empty-stage">
      <p>No documents open. <button class="link" onClick={run('view.home')}>View › Home</button>, File › Open, or drop files here.</p>
    </div>
  );
}
