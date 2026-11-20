import { useMemo, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { Icon } from '../icons';
import { COPYRIGHT, SOURCE_URL } from '../../platform/distribution';

/** The notice of one package built into Konium Designer: as the build wrote it into the page. */
export interface Notice { name: string; version: string; licence: string; text: string }

/** Where the build puts them (vite.config.ts, tests/tools/notices.mjs). */
export const NOTICES_ID = 'third-party-notices';
/** The name Konium Designer's own licence is under in that list (tests/tools/notices.mjs, OWN). */
export const OWN = 'Konium Designer';

/** The notices this copy carries; none when it is run from source (the build puts them in). */
export function bundledNotices(doc: { getElementById(id: string): { textContent: string | null } | null } = document): Notice[] {
  try {
    const list: unknown = JSON.parse(doc.getElementById(NOTICES_ID)?.textContent ?? '[]');
    if (!Array.isArray(list)) return [];
    return list.filter((n): n is Notice => !!n && typeof n === 'object' && ['name', 'version', 'licence', 'text'].every((k) => typeof (n as Record<string, unknown>)[k] === 'string'));
  } catch { return []; }
}

/**
 * Help › About › Licence: Konium Designer's own licence, with its copyright line and the notice
 * the licence asks an interactive program to show, then the licence in full (every copy of the one
 * file carries it, so it is there without a connection).
 */
export function LicenceDialog() {
  const own = useMemo(() => bundledNotices().find((n) => n.name === OWN), []);
  return (
    <Dialog title="Licence" width={640} height={520} onClose={closeDialog} class="third-party"
      footer={<><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <div class="tp-body">
        <p><b>Konium Designer</b><br />{COPYRIGHT}</p>
        <p class="small">This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as
          published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is
          distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
          FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License below for more details.</p>
        <p class="small">The source this copy was built from is at <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">{SOURCE_URL.replace(/^https:\/\//, '')}</a>.</p>
        {own
          ? <pre class="tp-text tp-own" tabIndex={0} aria-label="The GNU General Public License, version 3">{own.text}</pre>
          : <p class="parts-empty kv-empty"><Icon name="anReport" size={22} /><b>The licence is beside the source</b><span>This copy runs from its source, where the licence is the file LICENSE. The build writes it into the finished program.</span></p>}
      </div>
    </Dialog>
  );
}

/**
 * Help › About › Third-Party Software: the software of others that is built into Konium
 * Designer, each with its version, its licence and the notice its licence asks to go with every
 * copy. A field narrows the list as it is typed in.
 */
export function ThirdPartyDialog() {
  const all = useMemo(() => bundledNotices().filter((n) => n.name !== OWN), []);
  const [find, setFind] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const q = find.trim().toLowerCase();
  const shown = q ? all.filter((n) => n.name.toLowerCase().includes(q) || n.licence.toLowerCase().includes(q)) : all;
  return (
    <Dialog title="Third-Party Software" width={640} height={520} onClose={closeDialog} class="third-party"
      footer={<><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <div class="tp-body">
        <p class="small">Konium Designer is built on the work of others. Each of these is part of it, under the licence beside its name; a row opens the notice that licence asks to travel with every copy.</p>
        {all.length === 0
          ? <p class="parts-empty kv-empty"><Icon name="anReport" size={22} /><b>No list in this copy</b><span>The build writes the list into the finished program. This copy runs from its source, where the list is package.json's dependencies.</span></p>
          : <>
            <label class="parts-search tp-search"><Icon name="partsSearch" /><input type="search" value={find} placeholder="Find a package or a licence" aria-label="Find a package or a licence" onInput={(e) => setFind((e.target as HTMLInputElement).value)} /></label>
            <div class="parts-head"><span>Built in</span><span class="parts-count">{shown.length}</span></div>
            <ul class="tp-list">
              {shown.map((n) => (
                <li key={n.name} class={open === n.name ? 'open' : ''}>
                  <button class="tp-row" aria-expanded={open === n.name} onClick={() => setOpen(open === n.name ? null : n.name)}>
                    <b>{n.name}</b><span class="tp-version">{n.version}</span><span class="tp-licence">{n.licence}</span><Icon name="kpMore" size={13} />
                  </button>
                  {open === n.name && <pre class="tp-text" tabIndex={0}>{n.text}</pre>}
                </li>
              ))}
              {shown.length === 0 && <li class="tp-none">Nothing built in matches.</li>}
            </ul>
          </>}
      </div>
    </Dialog>
  );
}
