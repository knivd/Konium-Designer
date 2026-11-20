/**
 * Preferences › System › Network Activity, below its switches: every connection Konium makes —
 * what, when, to where, what goes — and whether it would be allowed with the switches as they
 * are in the dialog (a page Offline has sealed allows none until it is loaded again).
 */
import type { Settings } from '../core/settings';
import { shownConnections, sealedOffline, type Use } from '../platform/network';

const allowed = (s: Settings, use: Use): boolean => !s.offline && (use !== 'updates' || s.checkUpdates);

export function NetworkConnections({ draft }: { draft: Settings }) {
  const sealed = sealedOffline();
  return (
    <fieldset class="pref-section wide">
      <legend>Connections</legend>
      <p class="pref-help">Konium Designer connects only for these, and only when it says. Your files are never sent anywhere by themselves. To names every party what goes reaches, in order: the address your browser asks, then whoever that passes it on to.</p>
      <table class="about-net">
        <thead><tr><th>What</th><th>When</th><th>To</th><th>What goes</th><th>Allowed</th></tr></thead>
        <tbody>{shownConnections().map((c) => {
          const ok = allowed(draft, c.use);
          return <tr key={c.what}><td>{c.what}</td><td>{c.when}</td><td>{c.to}</td><td>{c.sends}</td><td>{c.use === 'link' ? 'Your click' : !ok ? 'No' : sealed ? 'After a reload' : 'Yes'}</td></tr>;
        })}</tbody>
      </table>
    </fieldset>
  );
}
