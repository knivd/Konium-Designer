/**
 * Every connection Konium makes asks here first, so two switches (the Home page, and Preferences ›
 * System › Network Activity, as AD has it) can stop them:
 * - Network activity off (Offline): none at all. Besides Konium's own checks, the browser itself is told to refuse every
 *   connection the page could make (a Content-Security-Policy: scripts, styles, workers, connections,
 *   pictures, sound, fonts, frames and the install manifest only from inside the page, and nothing
 *   else at all), so it holds for any code, and the browser's console shows each one refused.
 *   Switched off again, connections come back when the page is next loaded. Two things no page can
 *   stop, and the list says so: a link you click, and (for a copy at konium.app or installed from
 *   it) the browser's own daily look for newer offline files.
 * - Updates: konium.app's version number and What's New, and the website's visit count. Off, a
 *   copy served from konium.app (or installed from it) stays on the version it has: the service
 *   worker serves its kept copy of the page instead of asking konium.app for it.
 * CONNECTIONS lists them all, for About.
 */
import { settings } from '../core/settings';
import { FORMERS } from '../core/former';
import { featureOn, type Feature } from '../core/release';

/** `link`: a page the browser opens at a click (not a connection of Konium Designer's: no switch stops it). */
export type Use = 'updates' | 'ai' | 'parts' | 'library' | 'report' | 'download' | 'vcs' | 'donate' | 'link';

/** The browser told to refuse connections (Offline was on at some point since the page loaded). */
let sealed = false;

export const OFFLINE_NOTE = 'Network activity is off (the Home page, or Preferences › System › Network Activity): Konium Designer makes no connections until it is back on and Konium Designer is loaded again';

/** May Konium connect for this, now? */
export function mayConnect(use: Use): boolean {
  if (use === 'link') return true;
  if (settings.offline || sealed) return false;
  return use === 'updates' ? settings.checkUpdates : true;
}

/**
 * What the browser is told when Offline is on: nothing from outside the page, of any kind. Every
 * kind of thing a page can load is named (and default-src 'none' stands for any that is not), so
 * no script, style sheet, worker or manifest can be fetched either. The page's own code is inside
 * it (inline, or made from text in memory: blob: and data:), so it goes on working; 'unsafe-eval'
 * and 'wasm-unsafe-eval' let the code already here run (the PDF reader, the solid modeller's
 * WebAssembly) and open no connection.
 */
export const OFFLINE_POLICY = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:; style-src 'unsafe-inline' data: blob:; worker-src data: blob:; child-src data: blob:; "
  + "connect-src data: blob:; img-src data: blob:; media-src data: blob:; font-src data: blob:; frame-src data: blob:; manifest-src 'none'; object-src 'none'; form-action 'none'";

/** Have the browser refuse every connection from now until the page is loaded again. */
export function sealOffline(doc: Document = document): void {
  if (sealed) return;
  const m = doc.createElement('meta');
  m.httpEquiv = 'Content-Security-Policy';
  m.content = OFFLINE_POLICY;
  m.setAttribute('data-konium', 'offline');
  doc.head.prepend(m);
  sealed = true;
}
/** The browser refuses connections (Offline was on at some point since the page loaded). */
export const sealedOffline = (): boolean => sealed;

const servedPage = (): boolean => typeof location !== 'undefined' && (location.protocol === 'https:' || location.protocol === 'http:');

/** The service worker keeps the page it has (Offline, or updates off), told through the cache it reads. */
export async function tellServiceWorker(): Promise<void> {
  if (typeof caches === 'undefined' || !servedPage()) return;
  try {
    const c = await caches.open('konium-flags'), key = new URL('./__pinned', location.href).href;
    if (settings.offline || !settings.checkUpdates) await c.put(key, new Response('1'));
    else await c.delete(key);
    // The flag as kept under the app's earlier names: this one says it now
    for (const f of FORMERS) await caches.delete(`${f}-flags`);
  } catch { /* storage refused: the worker goes on as before */ }
}

/** The website counts its visits (Umami: no cookies, nothing that identifies anyone): only konium.app itself, with updates on. */
export const countsVisits = (host: string, served: boolean): boolean => served && host === 'konium.app';
export function countVisit(): void {
  if (typeof document === 'undefined' || !countsVisits(location.hostname, servedPage()) || !mayConnect('updates') || document.querySelector('script[data-website-id]')) return;
  const s = document.createElement('script');
  s.defer = true;
  s.src = 'https://cloud.umami.is/script.js';
  s.dataset.websiteId = '6de8aa87-b1a0-4c34-a4de-53fcc2df39a2';
  s.dataset.domains = 'konium.app';
  document.head.append(s);
}

/** At the start: Offline sealed before anything could connect, the worker told, the visit counted. */
export function startConnections(): void {
  if (settings.offline) sealOffline();
  void tellServiceWorker();
  countVisit();
}

/**
 * Every connection Konium Designer can make (a feature's only once its release has switched it on:
 * `shownConnections`), for About and Preferences › System › Network Activity. `to` names every
 * party what goes reaches, in order: the address the browser asks, then whoever that passes it on
 * to (26.191). The User Guide's table (Reference › Network connections) and the website's FAQ say
 * the same, word for word (tests/network191.test.ts).
 */
export const CONNECTIONS: { what: string; when: string; to: string; sends: string; use: Use; feature?: Feature }[] = [
  { what: 'Updates', when: 'A little after starting, then every few hours (updates on)', to: 'konium.app', sends: 'A request for the version number, without cookies or referrer. Nothing about you or your files', use: 'updates' },
  { what: "What's New", when: 'When the Home page shows it (updates on)', to: 'konium.app', sends: 'A request for the release log and its pictures', use: 'updates' },
  { what: 'Donation note', when: 'Only on the rare start that asks for a donation', to: 'konium.app', sends: 'A request for the day\'s wording of the ask. konium.app has it written once a day by a small AI model through OpenRouter, from fixed facts: nothing about you or your files goes to either', use: 'donate' },
  { what: 'Visit count', when: 'Only at konium.app itself (updates on); never in a downloaded copy', to: 'cloud.umami.is (Umami, which counts the website\'s visits)', sends: 'The page visited, with no cookies and nothing that identifies you', use: 'updates' },
  { what: 'Offline files', when: 'A copy at konium.app, or installed from it: when it is loaded (updates on), and about once a day when the browser itself looks for newer offline files (the browser\'s own doing: no switch here stops it; a downloaded copy has none)', to: 'konium.app', sends: 'A request for a newer version of Konium Designer\'s offline files', use: 'updates' },
  { what: 'AI jobs: Konium service', when: 'Only when you start a job, and when an AI tool\'s panel or Preferences › System › AI asks the service for its models and today\'s allowance (AI is off until you switch it on)', to: 'konium.app, then OpenRouter (openrouter.ai), then the company OpenRouter has run the chosen model: its maker (Anthropic, Google, OpenAI) or a host of it', sends: 'What the job needs (a datasheet, or the design as text), shown before it goes. konium.app keeps nothing of your design and counts your IP address only as a salted hash, for the daily allowance; companies that train on what they are sent are left out', use: 'ai' },
  { what: 'AI jobs: your own key', when: 'Only when you start a job, when an AI tool\'s panel asks for the models and their prices, and when you press Load Models or Test on Preferences › System › AI', to: 'Straight from your browser, not through konium.app: OpenRouter (openrouter.ai), which passes the job to the company that runs the model; or the address you gave for another provider (api.openai.com, for one)', sends: 'The same, with your key. The key is kept in this browser only and goes nowhere else', use: 'ai' },
  { what: 'AI jobs: a local model', when: 'The same', to: 'The address you gave: a model server on your computer or your network', sends: 'The same. Nothing leaves your computer or network', use: 'ai' },
  { what: 'Datasheets for the AI tools', when: 'When an AI tool looks for a part\'s datasheet on the web, and when it fetches one', to: 'Looking for it is an AI job (the rows above) with a web search that OpenRouter makes. Fetching it: konium.app, then the website the datasheet is on', sends: 'To look for it: the part number, its maker and its description. To fetch it: the datasheet\'s address and the part number', use: 'ai' },
  { what: 'Shared AI results', when: 'With Konium service, when you accept what was read from a datasheet that came from the web (never one opened from your computer)', to: 'konium.app', sends: 'What was read and accepted, kept by the datasheet\'s fingerprint for the next person. Nothing of your design', use: 'ai' },
  { what: 'Supplier data: JLCPCB', when: 'When you look parts up in JLCPCB\'s list in a BOM document, or update their supplier data', to: 'jlcsearch.tscircuit.com: a public copy of JLCPCB\'s parts list kept by tscircuit, not JLCPCB itself', sends: 'The part number or value searched for', use: 'parts' },
  { what: 'Supplier data: Digi-Key and Mouser', when: 'When you search Digi-Key or Mouser in a BOM document, or update their parts\' supplier data', to: 'konium.app, then Digi-Key (api.digikey.com) or Mouser (api.mouser.com)', sends: 'The part number or words searched for; Digi-Key or Mouser gets only those, from konium.app. Answers are kept a day; your IP address is counted only as a salted hash, for the daily limit', use: 'parts' },
  { what: 'World parts library', when: 'When you look a part number up in the world library (Tools › Parts), when you open its Publish window (which asks whether the library is there, and who is signed in), when you sign in, and when you publish a part', to: 'konium.app, then the library\'s public repository at GitHub (github.com). The sign-in link reaches your mailbox through the service\'s mail provider', sends: 'Looking up: the part number. Signing in: your email address, kept by the service to sign you in and to reach you about your parts, and never published. Publishing: the part (its record, its symbol and its footprint; of the datasheet only its link and its fingerprint), the name you chose to show, and this copy\'s version. Nothing of your designs', use: 'library', feature: 'partsLibrary' },
  { what: 'Bug reports and messages', when: 'When you press Send', to: 'konium.app, then the author\'s mailbox. A bug report is also filed in the author\'s private repository at GitHub (github.com), where the author and the AI assistant that helps build Konium Designer (Claude, by Anthropic) read it. A message to the author is mailed only', sends: 'What you write and attach, and the diagnostics if Include diagnostics is ticked', use: 'report' },
  { what: 'Version control', when: 'For a project under version control: when you commit, update or open it, and every few minutes while it is open', to: 'Konium\'s store at konium.app (kept in Cloudflare\'s storage), or your team\'s own Git server (GitHub, GitLab, Bitbucket or your own) through the relay at konium.app/api/git unless you change it', sends: 'To the store: the project\'s versions, sealed with your team\'s key first (konium.app never has the key). To your own server: what Git sends, with your sign-in; the relay passes it on and keeps nothing', use: 'vcs', feature: 'versionControl' },
  { what: 'Download', when: 'When you click Download Konium-<version>.html in Help › Get Konium Designer on This Computer... (in a browser tab)', to: 'The site the page came from (konium.app)', sends: 'A request for the page itself, to save as one file', use: 'download' },
  { what: 'Links you click', when: 'When you click a link that leads out of Konium Designer: Chip in... in Help › Support Konium Designer or on the donation ask, a part\'s page in a BOM document, a datasheet\'s address, a board house\'s page in Design › Fab-House Profile, the Gydel icon beside the menus, Source Code in Help › About, a page of the website, a link in one of your own documents', to: 'Your browser opens the page in a new tab: ko-fi.com (donations, paid to Ko-fi there), lcsc.com and the Digi-Key and Mouser websites (parts), the datasheet\'s website, the board house\'s website, gydel.games, github.com (the source code), konium.app, or wherever your document\'s link leads', sends: 'Nothing from Konium Designer. The website sees a visit from your browser, as from any link', use: 'link' },
];
/** The connections this release can make (a planned feature's are left out). */
export const shownConnections = () => CONNECTIONS.filter((c) => !c.feature || featureOn(c.feature));
