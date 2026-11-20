import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { ColourIcon } from '../icons';
import { online } from '../../platform/distribution';

/**
 * Where "Chip in" goes: Konium's page on the payment service, opened in the browser. Konium
 * sends nothing itself: no embedded widget, no referrer, no identifiers.
 */
export const SUPPORT = { url: 'https://ko-fi.com/konium', service: 'Ko-fi' };

export function openSupportPage(): void {
  if (SUPPORT.url) open(SUPPORT.url, '_blank', 'noopener,noreferrer');
}

/** The tip jar beside the menus, Help › Support Konium, the Home page: Konium is donationware. */
export function SupportDialog() {
  const ready = !!SUPPORT.url, net = online.value;
  return (
    <Dialog title="Support Konium Designer" width={460} onClose={closeDialog} onAccept={() => { openSupportPage(); closeDialog(); return false; }}
      footer={<>
        <span class="spacer" />
        <button class="btn default" disabled={!ready || !net} onClick={() => { openSupportPage(); closeDialog(); }}>Chip in...</button>
        <button class="btn" onClick={closeDialog}>Not now</button>
      </>}>
      <div class="support-body">
        <ColourIcon name="tipJar" size={48} />
        <div>
          <p><b>Konium Designer is free.</b> No adverts, no accounts, nothing locked away.</p>
          <p>It's a side project, made to help others with their side projects. If it helps with yours, you can chip in whatever you like.</p>
          <p class="small muted">
            {!ready ? 'The way to give isn\'t set up in this version yet.'
              : !net ? 'Needs an internet connection.'
              : `Opens Konium Designer's page on ${SUPPORT.service} in your browser: you choose the amount and pay ${SUPPORT.service} there. Konium Designer itself sends nothing about you or your work.`}
          </p>
        </div>
      </div>
    </Dialog>
  );
}
