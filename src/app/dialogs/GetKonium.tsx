import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { ColourIcon, Icon } from '../icons';
import { APP_VERSION, SITE, downloadCopy, fromFile, install, installOffer, installed } from '../../platform/distribution';
import { notify } from '../state';

/** The browser, as far as installing goes. */
export function browserOf(ua: string): 'edge' | 'chrome' | 'android' | 'safari' | 'firefox' | 'other' {
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/OPR\/|SamsungBrowser\//.test(ua)) return 'other';
  if (/(Chrome|Chromium|CriOS)\//.test(ua)) return /Android/.test(ua) ? 'android' : 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

/** Where this browser's own Install is, for when it hasn't offered one to Konium (or was told not now). */
export function ownInstall(ua: string): string {
  switch (browserOf(ua)) {
    case 'chrome': return 'In Chrome: the install icon at the right of the address bar, or the ⋮ menu › Cast, save and share › Install page as app.';
    case 'edge': return 'In Edge: the install icon in the address bar, or the ⋯ menu › Apps › Install this site as an app (in some versions under More tools).';
    case 'android': return 'In Chrome: the ⋮ menu › Install app (or Add to Home screen).';
    case 'safari': return 'In Safari: File › Add to Dock (on a Mac), or Share › Add to Home Screen (on an iPhone or iPad).';
    default: return 'Open konium.app/app in Chrome or Edge and install it there, or download the single file below.';
  }
}

/**
 * Help › Get Konium Designer on This Computer (the Install button beside the menus, the Home
 * page's box): Konium onto this computer, as an installed app or as its single file. In a tab it
 * installs (the browser's offer, else where its own Install is); a downloaded file can't be
 * installed itself, so it points to konium.app/app; the installed app says so.
 */
export function GetKoniumDialog() {
  const [busy, setBusy] = useState(false);
  const offer = installOffer.value;
  const ua = navigator.userAgent;
  const asApp = installed();
  return (
    <Dialog title="Get Konium Designer on this computer" width={520} onClose={closeDialog} onAccept={() => { closeDialog(); return false; }}
      footer={<><span class="spacer" /><button class="btn" onClick={closeDialog}>Close</button></>}>
      <div class="get-body">
        <section class="get-option">
          <ColourIcon name="home" size={32} />
          <div>
            <h3>Install</h3>
            <p class="small">Konium Designer in a window of its own, without the browser’s address bar and buttons, started from your Start menu, apps menu or dock; .PrjPcb, .SchDoc, .PcbDoc and library files can open in it. Works offline; when online it takes new versions by itself.</p>
            {asApp
              ? <p class="small get-how">Installed: this is the app.</p>
              : fromFile
                ? <>
                  <p class="small get-how">This copy runs from the file you downloaded, which can't be installed itself. Open konium.app/app in Chrome or Edge and install it from there: it installs the newest version, and your projects aren't touched.</p>
                  <a class="btn" href={`${SITE}app/`} target="_blank" rel="noopener">Open konium.app/app</a>
                </>
                : offer
                  ? <button class="btn default kv-cta" onClick={async () => { if (await install()) closeDialog(); }}><Icon name="getInstall" />Install Konium Designer</button>
                  : <p class="small get-how">{ownInstall(ua)}</p>}
          </div>
        </section>
        <section class="get-option">
          <ColourIcon name="download" size={32} />
          <div>
            <h3>Download</h3>
            <p class="small">One file, Konium-{APP_VERSION}.html. Open it from disk in Chrome or Edge: nothing to install, no internet needed. A newer version shows on the Home page when you're online.</p>
            {fromFile
              ? <p class="small get-how">This is that file. The newest version is on konium.app's Download page.</p>
              : <button class={offer && !asApp ? 'btn' : 'btn default kv-cta'} disabled={busy} onClick={async () => {
                setBusy(true);
                try { await downloadCopy(); } catch (e) { notify(`Couldn't download: ${(e as Error).message}`, 'error'); }
                setBusy(false);
              }}><Icon name="getDownload" />Download Konium-{APP_VERSION}.html</button>}
          </div>
        </section>
        <p class="small muted">Either way, your projects stay on your computer.</p>
      </div>
    </Dialog>
  );
}
