import { useEffect, useRef } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { Logo } from '../icons';
import { shownConnections, mayConnect } from '../../platform/network';
import { settings } from '../../core/settings';
import { ContactDialog } from './Contact';
import { LicenceDialog, ThirdPartyDialog } from './ThirdParty';
import { COPYRIGHT, LICENCE_NAME, SOURCE_URL } from '../../platform/distribution';

declare const __APP_VERSION__: string | undefined;
const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';

/**
 * Help › About: Konium's name and version, what it is for (a two-way link with Altium Designer),
 * how it is made (with AI tools; its source public under the GPL: the source, the licence and the
 * software of others built in, each a button; Contact the Author),
 * donationware, the statement about Altium (the only place besides Home that names it), and every
 * connection Konium makes, each allowed or stopped now. Scrolls when the window is short; the Home
 * page opens it at the connections.
 */
export function AboutDialog({ at }: { at?: 'connections' }) {
  const net = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (at === 'connections') net.current?.scrollIntoView({ block: 'start' }); }, []);
  const contact = (topic?: string) => { closeDialog(); showDialog(ContactDialog, { topic }); };
  return (
    <Dialog title="About Konium Designer" width={660} onClose={closeDialog} onAccept={() => { closeDialog(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <div class="about-body">
        <p class="about-title"><Logo size={40} /><span><b>Konium Designer</b>{version && <> {version}</>}</span></p>
        <p>Schematic capture, libraries, PCB layout, Gerber and BOM outputs, on your own computer and without a connection.</p>

        <h3>A two-way link with Altium Designer</h3>
        <p>Konium Designer is meant to be a low-cost, two-way link with Altium Designer. It reads and writes the same files
          (.PrjPcb, .SchDoc, .SchLib, .PcbDoc, .PcbLib, .IntLib and .OutJob), and works the way Altium Designer does, so a
          project can go back and forth: start or edit it here, open it in Altium Designer, and bring it back.</p>

        <h3>How Konium Designer is made</h3>
        <p>Konium Designer is built from scratch by its author, with the help of AI tools. Its source code is public, under the {LICENCE_NAME}:
          anyone may read it, build it, change it and pass it on under the same licence. {COPYRIGHT}. To contact the author, send a message:
          it goes through konium.app to the author only.</p>
        <p class="about-buttons"><a class="btn" href={SOURCE_URL} target="_blank" rel="noopener noreferrer" title={`${SOURCE_URL.replace(/^https:\/\//, '')} (opens in your browser)`}>Source Code</a>
          <button class="btn" onClick={() => showDialog(LicenceDialog, {})}>Licence...</button>
          <button class="btn" onClick={() => showDialog(ThirdPartyDialog, {})}>Third-Party Software...</button>
          <button class="btn" onClick={() => contact()}>Contact the Author...</button></p>

        <h3>Free, with a tip jar</h3>
        <p>Konium Designer is donationware. It's free to use, with no adverts, no accounts and nothing locked away. It's a
          side project, made to help others with their side projects. If it helps with yours, you can chip in whatever you like
          through Help › Support Konium Designer or the jar beside the menus. Whatever you give is a thank-you, not a purchase: it doesn't
          unlock anything, and Konium Designer works the same either way.</p>

        <h3>Konium Designer and Altium Designer</h3>
        <p>Konium Designer is an independent project for hobbyists, students and makers. It is not a replacement for Altium
          Designer: for professional and commercial work, a genuine Altium Designer subscription, with the complete tool, support
          and updates, is the right choice. Konium Designer is made with hobby, learning and other small projects in mind; its
          licence sets no limit on what it is used for.</p>

        <h3 ref={net}>Your files and connections</h3>
        <p>Your files stay on your computer: Konium Designer never sends them anywhere by itself. It connects only for the things
          below, and only when it says. Switching <b>network activity</b> off (on the Home page, or Preferences › System ›
          Network Activity) stops them all, and has the browser itself refuse any connection the page could make, so it
          holds whatever the code does.{settings.offline ? ' Network activity is off now.' : ''} <b>To</b> names every party what goes
          reaches, in order: the address your browser asks, then whoever that passes it on to. konium.app's own services (AI,
          parts, reports and version control) run on Cloudflare, which also carries the requests to the website.</p>
        <table class="about-net">
          <thead><tr><th>What</th><th>When</th><th>To</th><th>What goes</th><th>Now</th></tr></thead>
          <tbody>{shownConnections().map((c) => (
            <tr key={c.what}><td>{c.what}</td><td>{c.when}</td><td>{c.to}</td><td>{c.sends}</td><td>{c.use === 'link' ? 'Your click' : mayConnect(c.use) ? 'Allowed' : 'Stopped'}</td></tr>
          ))}</tbody>
        </table>
        <p class="small">A downloaded copy of Konium Designer runs from your disk and never changes; What's New gives each release's SHA-256,
          to check a copy is the one published. A copy at konium.app, or installed from
          it, takes new versions from konium.app; with updates or network activity off, it stays on the version it has. For such
          a copy the browser itself also checks konium.app about once a day for a newer version of Konium Designer's offline files.</p>

        <h3>No warranty</h3>
        <p class="small">Konium Designer is provided "as is", without warranty of any kind, express or implied, including but not
          limited to the warranties of merchantability, fitness for a particular purpose and non-infringement. You use it at your
          own risk. Check every design, file and output (Gerber, drill, BOM, pick and place and the rest) before it is
          manufactured or relied on. In no event shall the authors or contributors be liable for any claim, damages or other
          loss, direct or indirect, including lost data, boards, parts, time or profit, arising from the use of Konium Designer
          or from its inability to be used, whether in contract, tort or otherwise, even if advised of the possibility of such
          loss. Where the law doesn't allow some of this to be excluded or limited, it is limited to the least the law allows.</p>

        <p class="small muted">Not affiliated with or endorsed by Altium. Altium Designer is a trademark of Altium Limited.
          No Altium code or artwork is used. The file formats are implemented from public descriptions and from files saved by
          Altium Designer; the menus, command names and shortcut keys follow Altium Designer's own, so that the two work alike.
          The source's docs/PROVENANCE.md says where everything in Konium Designer comes from.</p>
      </div>
    </Dialog>
  );
}
