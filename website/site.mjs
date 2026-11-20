/**
 * konium.app's website (26.169): its pages, written at build time by website/build.mjs into dist/
 * around the app, which lives at app/. Plain HTML and one style sheet: no framework, no outside
 * fonts or scripts but the visit count (Umami, at konium.app only).
 *
 * The copy says only what Konium Designer does (each claim from the app, its User Guide or its
 * tests), in plain words: no dashes for punctuation, no slogans. Altium Designer is named here (the
 * website is what search engines read), with the trademark line on every page. The guides
 * (website/guides.mjs, under guides/) are the pages for what people search for, and name Altium
 * Designer in their titles and headings; they are reached from the footer and from each other.
 */
import { GUIDES } from './guides.mjs';

export const PAGES = [
  { path: 'index.html', nav: 'Home' },
  { path: 'features/index.html', nav: 'Features' },
  { path: 'formats/index.html', nav: 'Formats' },
  { path: 'download/index.html', nav: 'Install' },
  { path: 'whats-new/index.html', nav: "What's New" },
  { path: 'faq/index.html', nav: 'FAQ' },
  { path: 'support/index.html', nav: 'Support' },
  // The guides: in the sitemap and the footer, not in the header
  { path: 'guides/index.html' },
  ...GUIDES.map((g) => ({ path: `guides/${g.slug}/index.html` })),
];

export const ORIGIN = 'https://konium.app/';
/** The picture a link to the site is shown with elsewhere (a JPEG of the size those previews use: not every one of them takes WebP). */
export const OG_IMAGE = { path: 'assets/img/og.jpg', w: 1200, h: 630, alt: 'Konium Designer\'s PCB editor with a six-layer board.' };
const UMAMI_ID = '6de8aa87-b1a0-4c34-a4de-53fcc2df39a2';
export const KOFI = 'https://ko-fi.com/konium';
/** Where the source is published (the app's About says the same: src/platform/distribution.ts). */
export const SOURCE = 'https://github.com/knivd/konium-designer';
/**
 * The documentation of other products that the FAQ's statements about them rest on. Every such
 * statement is made from the page linked beside it and no further; they were read on the date in
 * CHECKED and are read again before a release changes what is said.
 */
export const SOURCES = {
  kicadProject: 'https://docs.kicad.org/10.0/en/kicad/kicad.html',
  kicadPcb: 'https://docs.kicad.org/10.0/en/pcbnew/pcbnew.html',
  easyedaImport: 'https://prodocs.easyeda.com/en/import-export/import-altium-designer/',
  easyedaExport: 'https://prodocs.easyeda.com/en/import-export/export-altium-designer/',
};
export const CHECKED = 'November 2026';
const out = (url, text) => `<a href="${url}" rel="noopener">${text}</a>`;

/** Text for HTML. */
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Width and height of a WebP picture (its header), or null. */
export function webpSize(b) {
  if (!b || b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const t = b.toString('ascii', 12, 16);
  if (t === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  if (t === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (t === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 }; }
  return null;
}

const ICON = `<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="km" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#186553"/><stop offset="1" stop-color="#0a2c25"/></linearGradient><linearGradient id="kc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6d47a"/><stop offset="1" stop-color="#d4972a"/></linearGradient></defs><rect x="1" y="1" width="62" height="62" rx="14" fill="url(#km)"/><path d="M24 16V48M24 32L40 16M24 32L40 48" fill="none" stroke="url(#kc)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><g fill="url(#kc)"><circle cx="24" cy="16" r="6.5"/><circle cx="24" cy="32" r="6.5"/><circle cx="24" cy="48" r="6.5"/><circle cx="40" cy="16" r="6.5"/><circle cx="40" cy="48" r="6.5"/></g><g fill="#0a2c25"><circle cx="24" cy="16" r="2.8"/><circle cx="24" cy="32" r="2.8"/><circle cx="24" cy="48" r="2.8"/><circle cx="40" cy="16" r="2.8"/><circle cx="40" cy="48" r="2.8"/></g></svg>`;

/**
 * The home page's first script: Konium itself moved from here to app/ in 26.169. An app installed
 * before then (in a window of its own) and links made for the app (?debug, ?features=…) go on there.
 * An installed app that opened files here first hands them on, kept in the browser's storage for
 * the app to open (src/platform/fs.ts, LAUNCH_DB).
 */
export const REDIRECT = `<script>
    // Konium Designer itself is at app/: the installed app, and links made for the app, go on there
    (function () {
      var standalone = false;
      // (as the app itself tells: not fullscreen, which a browser tab is too once F11 is pressed)
      try { standalone = navigator.standalone === true || ['standalone', 'window-controls-overlay', 'minimal-ui'].some(function (m) { return matchMedia('(display-mode: ' + m + ')').matches; }); } catch (e) {}
      if (!standalone && !/[?&](debug|features)\\b/.test(location.search)) return;
      document.documentElement.style.visibility = 'hidden';
      var gone = false, go = function () { if (!gone) { gone = true; location.replace('app/' + location.search + location.hash); } };
      if (!standalone || !window.launchQueue || !window.indexedDB) { go(); return; }
      var called = false;
      window.launchQueue.setConsumer(function (p) {
        called = true;
        if (!p.files || !p.files.length) { go(); return; }
        try {
          var r = indexedDB.open('konium-launch', 1);
          r.onupgradeneeded = function () { r.result.createObjectStore('files'); };
          r.onsuccess = function () { var db = r.result, t = db.transaction('files', 'readwrite'); t.objectStore('files').put({ at: Date.now(), files: p.files }, 'handles'); t.oncomplete = function () { db.close(); go(); }; t.onerror = go; };
          r.onerror = go;
        } catch (e) { go(); }
      });
      setTimeout(function () { if (!called) go(); }, 400);
    })();
  </script>`;

/**
 * A file's address with the fingerprint of its contents (?v=…), as the build gives it: the style
 * sheet and the pictures are kept by browsers, by Cloudflare and by the site's worker under their
 * address, so a changed file needs a new one to be seen at once. No build (the tests): none.
 */
let ver = () => '';
const asset = (path) => { const v = ver(path); return v ? `${path}?v=${v}` : path; };

function layout({ page, title, description, body, depth, extraHead = '', home = false, rel = '../'.repeat(depth) }) {
  const url = ORIGIN + page.path.replace(/index\.html$/, '');
  const nav = PAGES.filter((p) => p.nav && p.path !== 'index.html').map((p) => `<a href="${rel}${p.path.replace(/index\.html$/, '')}"${p === page ? ' aria-current="page"' : ''}>${esc(p.nav)}</a>`).join('');
  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8" />
  ${home ? `${REDIRECT}\n  ` : ''}<meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark light" />
  <meta name="theme-color" content="#13201d" media="(prefers-color-scheme: dark)" />
  <meta name="theme-color" content="#f7f8f5" media="(prefers-color-scheme: light)" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${url}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Konium Designer" />
  <meta property="og:url" content="${url}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:image" content="${ORIGIN}${OG_IMAGE.path}" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:image:width" content="${OG_IMAGE.w}" />
  <meta property="og:image:height" content="${OG_IMAGE.h}" />
  <meta property="og:image:alt" content="${esc(OG_IMAGE.alt)}" />
  <meta property="og:locale" content="en_GB" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="icon" href="${rel}favicon.ico" sizes="48x48" />
  <link rel="icon" type="image/svg+xml" href="${rel}icon.svg" />
  <link rel="manifest" href="${rel}manifest.webmanifest" />
  <link rel="preload" href="${rel}assets/fonts/plex-condensed-400.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="${rel}${asset('assets/site.css')}" />
  <script defer src="https://cloud.umami.is/script.js" data-website-id="${UMAMI_ID}" data-domains="konium.app"></script>${extraHead}
</head>
<body${home ? ' class="home"' : ''}>
  <header class="top">
    <div class="wrap top-row">
      <a class="brand" href="${rel || './'}" aria-label="Konium Designer, home">${ICON}<span>Konium Designer</span></a>
      <nav class="nav" aria-label="Pages">${nav}</nav>
      <a class="btn small primary install" href="${rel}app/?install">Install</a>
    </div>
  </header>
  <main>
${body}
  </main>
  <footer class="foot">
    <div class="wrap foot-row">
      <p>Konium Designer is free and made independently. Altium Designer is a trademark of Altium Ltd; Konium Designer is not affiliated with it. KiCad, PADS, EasyEDA, OrCAD, Allegro, EAGLE and DipTrace are their owners' trademarks.</p>
      <p><a href="${rel}download/">Install or download</a> <a href="${rel}whats-new/">What's New</a> <a href="${rel}guides/">Guides</a> <a href="${rel}support/">Contact</a> <a href="${rel}app/">Run it in a browser tab</a> <a href="${rel}llms.txt">llms.txt</a></p>
    </div>
  </footer>
  <script>
    if ('serviceWorker' in navigator) addEventListener('load', function () { navigator.serviceWorker.register('${rel}sw.js').catch(function () {}); });
    // Install: the browser's own offer when it makes one here (Chrome and Edge), else Konium Designer opened with its install window
    var offer = null;
    addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); offer = e; });
    addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a.install');
      if (!a || !offer) return;
      e.preventDefault(); offer.prompt(); offer.userChoice.then(function () { offer = null; });
    });
    // A picture this browser cannot show (the pictures are WebP): a short note takes its place. Without this
    // the picture's description, a sentence or three, fills its box as text beside the page's own
    function unseen(i) { var f = i.parentNode; if (f && /\bshot\b/.test(f.className) && !/\bunseen\b/.test(f.className)) f.className += ' unseen'; }
    addEventListener('error', function (e) { if (e.target && e.target.tagName === 'IMG') unseen(e.target); }, true);
    addEventListener('load', function () { var l = document.querySelectorAll('.shot img'); for (var k = 0; k < l.length; k++) if (l[k].complete && !l[k].naturalWidth) unseen(l[k]); });
  </script>
</body>
</html>
`;
}

/** A picture. first: the page's first, in view as it opens, so fetched at once and ahead of the rest (the others when they come near). */
const shot = (rel, src, alt, caption, size, cls = '', first = false) => {
  const s = size(src);
  return `<figure class="shot${cls ? ` ${cls}` : ''}"><img src="${rel}${asset(src)}" alt="${esc(alt)}"${s ? ` width="${s.w}" height="${s.h}"` : ''} ${first ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" />${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
};

/* ─── Home ─────────────────────────────────────────────────────────────────────────── */

function home(d) {
  const rel = '';
  const body = `
    <section class="hero">
      <div class="wrap">
        <div class="hero-text">
          <h1>Konium Designer</h1>
          <p class="lead">Schematic capture and PCB layout for engineers who work in Altium Designer. It opens, edits and saves your projects, schematics, boards and libraries in their own formats, with the menus, panels, dialogs and shortcut keys you already use. It is free.</p>
          <p class="actions"><a class="btn primary install" href="app/?install">Install Konium Designer</a><a class="btn" href="download/#file">Download as one file</a></p>
          <p class="fine">Version ${esc(d.version)}. Chrome or Edge on Windows, macOS or Linux. No account. Installed, it has a window of its own and works offline.</p>
          <p class="fine"><a href="download/">More on installing</a>, or <a href="app/">try it in a browser tab</a>.</p>
        </div>
        ${shot(rel, 'assets/img/pcb-editor.webp', 'The PCB editor with Konium\'s six-layer showcase board: the Projects panel on the left listing the showcase project\'s four schematic sheets and its board, the routed board in the middle, and the layer tabs along the bottom.', 'Konium\'s showcase board, six layers, in the PCB editor.', d.size, 'hero-shot', true)}
      </div>
    </section>

    <section class="band">
      <div class="wrap narrow">
        <h2>It runs on your computer</h2>
        <p>konium.app is where you get Konium Designer. The program itself runs inside your browser, on your own computer. Your projects are opened from your disk and saved back to it; they are not uploaded anywhere. Once it has been opened, it starts without a connection.</p>
        <div class="table-wrap"><table class="ways">
          <thead><tr><th scope="col">Run it</th><th scope="col">How</th><th scope="col">What you get</th></tr></thead>
          <tbody>
            <tr><th scope="row">As an app</th><td><a class="install" href="app/?install">Install it</a> from Chrome or Edge</td><td>A window of its own, started from the Start menu, apps menu or dock. .PrjPcb, .SchDoc, .PcbDoc, library and STEP files open in it from your computer. It takes new versions by itself when online.</td></tr>
            <tr><th scope="row">As one file</th><td><a href="download/#file">Konium-${esc(d.version)}.html</a></td><td>One HTML file of ${esc(d.mb)} MB to keep anywhere and open in Chrome or Edge. No internet needed, and it never changes by itself.</td></tr>
            <tr><th scope="row">In a browser tab</th><td><a href="app/">konium.app/app</a></td><td>Nothing to install. The browser keeps a copy, so after the first visit it opens offline too.</td></tr>
          </tbody>
        </table></div>
        <p>All three are the same program. It connects only for a short list of things: the version check and What's New, the AI tools and part searches when you use them, a bug report when you send one. The <a href="faq/#connections">FAQ</a> lists them all. Offline mode stops every one of them, and has the browser itself refuse any connection the program could make.</p>
      </div>
    </section>

    <section>
      <div class="wrap">
        <div class="split">
          <div>
            <h2>The files you already have</h2>
            <p>Konium Designer reads and writes the same files: projects (.PrjPcb), schematics (.SchDoc), boards (.PcbDoc), schematic and PCB libraries (.SchLib, .PcbLib), Output Jobs (.OutJob), Draftsman drawings (.PCBDwf), database libraries (.DbLib) and BOM documents (.BomDoc). It reads integrated libraries (.IntLib).</p>
            <p>Drop a project folder on the window and it opens as you know it. A project can go back and forth: start or change it here, open it in the desktop software, and bring it back.</p>
          </div>
          ${shot(rel, 'assets/img/schematic.webp', 'The showcase project\'s MCU sheet in the schematic editor: the microcontroller with its pins wired to net labels, a debug connector and a QSPI flash beside it.', 'The MCU sheet of the same project.', d.size)}
        </div>
      </div>
    </section>

    <section>
      <div class="wrap">
        <div class="split reverse">
          <div>
            <h2>What is in it</h2>
            <ul class="ticks">
              <li>Interactive routing that walks round or pushes obstacles, differential pairs, length tuning and ActiveRoute.</li>
              <li>AI layout planning: a model plans placement and routing; a placer, the autorouter and the design rule check carry the plans out and measure them.</li>
              <li>Free-flowing routes: tracks at any angle that curve round what they pass, as well as 45° and 90° corners.</li>
              <li>Polygon pours, rooms, design rules and the design rule check.</li>
              <li>Gerber, Gerber X2, ODB++, IPC-2581, NC drill, pick and place, BOM, Smart PDF and Draftsman drawings.</li>
              <li>SPICE simulation, live on the sheet as you draw or as full analyses, and signal integrity.</li>
              <li>Power, thermal and EMC analysis of the board, supply impedance and a field solver for track impedance.</li>
              <li>Antenna analysis: a printed antenna's match, efficiency, gain and pattern, from the board's copper.</li>
              <li>3D with STEP models and STEP export, and an enclosure designer for 3D printing.</li>
              <li>Multi-board and harness design, requirements, diagrams, version control and scripting.</li>
              <li>Import and export for KiCad, PADS, EasyEDA, OrCAD, Allegro, EAGLE and DipTrace, and Specctra files for Freerouting.</li>
              <li>A User Guide with pictures. F1 opens it at the section for what you are doing.</li>
            </ul>
            <p><a href="features/">All the features</a> <span class="sep">or</span> <a href="formats/">the file formats</a></p>
          </div>
          ${shot(rel, 'assets/img/board-3d.webp', 'The showcase board in 3D Layout Mode, seen at an angle: the microcontroller, the FPGA, pin headers, buttons, electrolytic capacitors and a terminal block on the green board.', 'The board in 3D Layout Mode.', d.size)}
        </div>
      </div>
    </section>

    <section class="band">
      <div class="wrap narrow">
        <h2>Free</h2>
        <p>Konium Designer costs nothing, with no account and no adverts. The AI service is paid for by its author and has a daily allowance. If Konium Designer saves you time or money, a <a href="support/">donation</a> helps keep it going.</p>
      </div>
    </section>
`;
  return layout({
    page: PAGES[0], depth: 0, home: true, body,
    title: 'Konium Designer: free schematic and PCB design that opens Altium files',
    description: 'Free schematic capture and PCB layout that opens, edits and saves .PrjPcb projects, .SchDoc schematics, .PcbDoc boards and their libraries, with familiar menus and shortcut keys. Runs in your browser on your own computer, installs as an app, works offline.',
    extraHead: `\n  <script type="application/ld+json">${JSON.stringify(jsonLd(d))}</script>`,
  });
}

function jsonLd(d) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Konium Designer',
    alternateName: 'Konium',
    url: ORIGIN,
    softwareVersion: d.version,
    applicationCategory: 'DesignApplication',
    applicationSubCategory: 'Electronic design automation (EDA): schematic capture and PCB layout',
    operatingSystem: 'Web browser on Windows, macOS and Linux (installable; works offline)',
    inLanguage: 'en-GB',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'GBP' },
    downloadUrl: `${ORIGIN}download/`,
    screenshot: `${ORIGIN}assets/img/pcb-editor.webp`,
    description: 'Free schematic and PCB design software for engineers who work in Altium Designer, with the same menus, panels and shortcut keys. Opens, edits and saves Altium projects, schematics, boards and libraries. Runs in the browser on the user\'s own computer, installs as an app and works offline. Independent and not affiliated with Altium Ltd.',
    fileFormat: ['.PrjPcb', '.SchDoc', '.PcbDoc', '.SchLib', '.PcbLib', '.IntLib', '.DbLib', '.OutJob', '.PCBDwf', '.BomDoc', '.PrjMbd', '.MbsDoc', '.MbaDoc'],
  };
}

/* ─── Features ─────────────────────────────────────────────────────────────────────── */

/** Each part of Konium Designer: what it does, with a picture from the showcase or the demo project. */
export const FEATURES = [
  { id: 'schematic', h: 'Schematic capture', img: 'assets/img/schematic.webp', alt: 'The showcase project\'s MCU sheet in the schematic editor.',
    p: ['Parts, wires, buses, net labels, ports, sheet symbols and harnesses, with annotation, compile and the electrical rules check. Shift+drag copies what you press on.',
      'Update the PCB from the schematic, and the schematic from the PCB, through engineering change orders.'] },
  { id: 'pcb', h: 'PCB layout', img: 'assets/img/pcb-editor.webp', alt: 'The showcase board in the PCB editor.',
    p: ['Interactive routing that walks round obstacles or pushes them, differential pairs, length tuning, polygon pours, rooms, unions, design rules and the design rule check. The Layer Stack Manager, rigid-flex boards and Board Planning Mode.',
      'ActiveRoute routes the selected connections in one go on the layers you choose, optionally along a route guide you draw. For a whole board, Route › Auto Route › Export Specctra Design... writes it for Freerouting, and Import Specctra Session... brings its routes back.',
      'Design › Netlist › Load a Netlist brings a board to a netlist file from another tool, as an engineering change order. Tools › Calculators has the everyday sums (dividers, LED resistors, RC and LC, standard values) and the board\'s own: a track\'s width for a current by IPC-2221, a via, the spacing for a voltage and a track\'s impedance.'] },
  { id: '3d', h: '3D and enclosures', img: 'whats-new/26.135-enclosure.webp', alt: 'The demo board\'s enclosure in the enclosure designer: a box with a lid, the board inside, the tools down the left and the box\'s settings on the right.',
    p: ['The board in 3D with STEP models, rigid-flex boards folded, STEP and STL export.',
      'The enclosure designer makes a box for the board to be 3D printed: base and lid or two shells, press fit, snap catches or screws, standoffs, and openings found for the parts at the board\'s edge. It writes STL, 3MF and STEP.'] },
  { id: 'libraries', h: 'Libraries and the Component Builder', img: 'whats-new/26.082-ai-builder.webp', alt: 'The Component Builder on a USB-C receptacle\'s datasheet: the variants it found, the land pattern read from the drawing, and the footprint made from it.',
    p: ['Schematic symbols and PCB footprints, the Component Wizard and library reports. Database libraries read their Excel, CSV, Access or SQLite database in the browser. The IPC footprint wizard gives a footprint its package in 3D: the body, each lead, the balls of a BGA.',
      'The Component Builder makes a footprint and a symbol from a datasheet PDF: it reads the land pattern, measures it on the drawing and checks it against it, and lays out the pin table as a symbol. It uses AI, which is off until you switch it on.'] },
  { id: 'outputs', h: 'Outputs and manufacturing', img: 'whats-new/26.089-draftsman.webp', alt: 'A Draftsman document for the demo board: assembly views, the fabrication view and the tables beside them.',
    p: ['Gerber, Gerber X2, ODB++ and IPC-2581, NC drill, pick and place, bills of materials, test points (IPC-D-356A), Smart PDF and Output Jobs. Gerber and drill files open in the CAM editor to be looked at and checked, and Tools › Panelize PCB puts copies of the board in a panel.',
      'Draftsman documents (.PCBDwf): fabrication and assembly drawings with board views, drill, layer stack and BOM tables and title blocks, opened, edited, printed and saved.'] },
  { id: 'bom', h: 'BOM documents', img: 'whats-new/26.113-bom-supply.webp', alt: 'The demo project\'s BOM document grouped by comment and footprint for a quantity of 100, with suppliers, stock and prices.',
    p: ['ActiveBOM documents with part choices for each line: from the parts\' parameters, by hand, or searched for in a public copy of JLCPCB\'s parts list or at Digi-Key and Mouser. Stock and price breaks where given, the cost for a production quantity, BOM checks and JLCPCB\'s assembly BOM.'] },
  { id: 'simulation', h: 'Simulation and signal integrity', img: 'whats-new/26.184-live.webp', alt: 'A 555 timer flashing an LED in Live Simulation: the wires coloured by voltage with dots moving along them, the LED lit, test points reading out on the sheet, the palette of parts as their symbols on the right, and the scope drawing the output and the timing capacitor along the bottom.',
    p: ['Live Simulation runs the schematic as a circuit while you draw it: the wires take the colour of their voltage, dots move with the current, monitors read out the voltage and current at any point you click, switches are thrown with a click, values are turned with a slider, and scopes side by side draw what you choose against time, as a spectrum or as the circuit\'s frequency response. A palette of 77 parts and sources, shown as their symbols and each set by a few plain values (a diode\'s forward voltage, a transistor\'s beta, a source\'s amplitude, offset and frequency), is there to sketch with, by mouse or by single keys; voltmeters, ammeters, lamps, LEDs and a seven-segment display read out on the sheet, and a speaker is played through the computer\'s sound; and 55 example circuits, from Ohm\'s law to a counter on a display and a 555 timer playing a tone, open ready to run. A part worked beyond its rating is ringed on the sheet, Solve for a value finds the value of a part that gives a reading you ask for, and a selection of a real design runs as a sketch of its own with its supplies given by their names.',
      'The full analyses are SPICE in the browser, on the same simulator: operating point, transient with Fourier, DC sweep, AC and transfer function analyses of the schematic, with the waveforms in SimView.',
      'Signal integrity screens every net for overshoot, undershoot, flight time and slope from the board\'s copper and layer stack, suggests terminations and tries them, and draws reflections and crosstalk as waveforms.'] },
  { id: 'analysis', h: 'Power, thermal and EMC analysis', img: 'whats-new/26.177-thermal.webp', alt: 'The demo board with the Thermal Analysis panel beside it: the board coloured by temperature, red at the regulator through yellow to blue-green at the far end, a read-out of the temperature beside the cursor, and the hottest place and the part\'s junction temperature under Results.',
    p: ['Power analysis works out a supply net at direct current from the board\'s copper: the voltage each load is left with, the current in every track, copper area and via, tracks and vias against IPC-2221, and the copper coloured by voltage drop or current density. Thermal analysis gives the temperature the board settles at from what each part dissipates, with junction temperatures and the warm-up over time.',
      'The EMC check finds where a signal\'s return current has no easy way back: tracks over gaps and splits in the copper under them, layer changes, supply pins with no capacitor near, ground copper far from a via. Supply impedance draws what a load sees against frequency with the capacitors and the planes, and estimates the noise a switching regulator conducts back. The field solver gives a track\'s impedance from its cross-section. All of them are estimates to design by, worked out in the browser.'] },
  { id: 'antenna', h: 'Antenna analysis', img: 'whats-new/26.180-antenna.webp', alt: 'A board with an inverted F antenna at its end and the Antenna Analysis panel beside it: the copper coloured by the current on it, red on the antenna and blue over the ground, and in the panel the impedance and S11 at 2450 MHz, the S11 chart with its dip at 2435 MHz, and the Smith chart.',
    p: ['An antenna drawn in the board\'s copper, such as an inverted F, a meander, a patch or a printed dipole, is worked out from the copper itself: Maxwell\'s equations are stepped in time through the board and the air round it. You pick the pad the antenna is fed at and its ground and give the frequency.',
      'The results are the impedance and S11 across the band, on a chart and on a Smith chart, the parts that would match it, the share of the power it radiates, its gain, and its pattern in three cuts and as a shape to turn. The current on the copper is laid over the board. The run uses the graphics card where the browser has one: a model the size of the example board\'s took 3 seconds on the graphics of an Intel Core Ultra 9 288V and 19 seconds on its processor. It is an estimate to design by: the parts, an enclosure and cables are not in the model.'] },
  { id: 'multiboard', h: 'Multi-board and harness design',
    p: ['Multi-board projects with their schematic of modules and connections, where every pin the boards share is listed with its nets and checked, and the boards\' assembly in 3D.',
      'Harness projects with wiring diagrams and layout drawings, and the wire list with each wire\'s ends, cable and length along the bundles.'] },
  { id: 'requirements', h: 'Requirements', img: 'whats-new/26.139-requirements.webp', alt: 'A requirements document in the demo project: requirements under sections, with their priority, status and verification.',
    p: ['A project\'s requirements under sections, each with its identifier, priority, status, source and verification, linked to parts, nets, sheets or the board. Checks against the design (layers, board size, part heights, cost, temperature, tracks, holes, rules) pass or fail as the design changes. Import and export with Excel and CSV.'] },
  { id: 'diagrams', h: 'Diagrams', img: 'whats-new/26.123-diagrams.webp', alt: 'A diagram in the demo project, the Shapes panel open at its Electrical library.',
    p: ['Block diagrams, flowcharts and circuit sketches beside the design, with shape libraries (circuit symbols among them), connectors, layers and formatted labels. Blocks can link to the project\'s schematic sheets. .drawio and Visio (.vsdx) files open and save.'] },
  { id: 'vcs', h: 'Version control', img: 'whats-new/26.142-compare.webp', alt: 'Two versions of the demo board side by side, the differences coloured and listed below.',
    p: ['A project kept as a Git repository in its own folder, readable by any Git tool, and shared with a team: in Konium\'s store, sealed with the team\'s key before it leaves the browser, or on the team\'s own Git server. Commit, update, history, soft locks, and two versions of a schematic or board compared side by side.'] },
  { id: 'scripting', h: 'Scripting', img: 'whats-new/26.146-scripts.webp', alt: 'The demo board with the Scripts panel beside it, a script that places a via fence along the selected tracks.',
    p: ['Short JavaScript scripts that work on the board or footprint: parts placed by a rule and renumbered, stitching vias and tracks added, reports and CSV files for manufacturers. Scripts run in a sandbox with no network, and every change they make is one step to undo.'] },
  { id: 'layout', h: 'AI layout planning and routing', img: 'whats-new/26.195-smart-router.webp', alt: 'The Smart Router panel beside the example board it has routed by a plan: the classes in the order they were routed, each marked routed, and the result of the run.',
    p: ['The Layout Planner has the AI model you chose plan where a board\'s parts go: what belongs together, what sits at an edge, what must be close to which pin, each with its reason. A placer puts every part in its place by that plan and marks what was met.',
      'The Smart Router has the model plan the routing: net classes with their widths, layers, vias and order, the via, pours and differential pairs. The plan becomes the board\'s own classes and design rules, the autorouter carries it out, and the design rule check measures the result. The model is never asked for coordinates, every step can be undone, and Plan, Place and Route runs both with a stop at each stage.',
      'Routes can be free-flowing: the direct way at any angle, curved in arcs round the pads and vias they pass. It is a routing style for the autorouter, the Smart Router and routes placed by hand, and Route › Make Free-Flowing reshapes routes that are already there.'] },
  { id: 'ai', h: 'AI tools', img: 'whats-new/26.089-ai-adviser.webp', alt: 'The Design Adviser panel beside the demo board, with its review of the board.',
    p: ['The Design Adviser reviews the schematic and the board before they are made, each part against its own datasheet. The Component Builder reads datasheets, and the Requirements Adviser reviews requirements.',
      'AI is off until you switch it on. You choose the Konium service (free within a daily allowance), your own key with OpenRouter or another provider, or a model on your own computer. What a job sends is shown before it goes.'] },
  { id: 'windows', h: 'Windows and the User Guide', img: 'whats-new/26.168-document-windows.webp', alt: 'Two Konium Designer windows side by side: the demo schematic on the left, the board on the right.',
    p: ['Window › Open In New Window puts a document in a second window, so the schematic can sit on one monitor and the board on the other, with one undo and clipboard and cross-probing between them.',
      'Help › User Guide has seven chapters with pictures, from getting started to file formats. F1 opens it at the section for what you are doing.'] },
];

function features(d) {
  const rel = '../';
  const body = `
    <section class="page-head"><div class="wrap narrow">
      <h1>Features</h1>
      <p class="lead">What Konium Designer does. The pictures are of Konium's own sample projects.</p>
      <p class="toc">${FEATURES.map((f) => `<a href="#${f.id}">${esc(f.h)}</a>`).join('')}</p>
    </div></section>
${FEATURES.map((f, i) => `    <section id="${f.id}" class="feature"><div class="wrap ${f.img ? `split${i % 2 ? ' reverse' : ''}` : 'narrow'}">
      <div>
        <h2>${esc(f.h)}</h2>
        ${f.p.map((t) => `<p>${esc(t)}</p>`).join('\n        ')}
      </div>
      ${f.img ? shot(rel, f.img, f.alt, '', d.size, '', i === 0) : ''}
    </div></section>`).join('\n')}
`;
  return layout({ page: PAGES[1], depth: 1, body, title: 'Features: Konium Designer', description: 'Schematic capture, PCB layout, 3D and enclosures, libraries, manufacturing outputs, BOMs, simulation, signal integrity, power, thermal, EMC and antenna analysis, multi-board and harness design, requirements, diagrams, version control and scripting in Konium Designer.' });
}

/* ─── Formats ──────────────────────────────────────────────────────────────────────── */

/** Other design tools: what Konium Designer reads, what it writes, and what comes back. */
export const TOOLS = [
  ['KiCad', 'Version 6 and later: projects, schematics, boards and libraries', 'KiCad 8 files', 'Unchanged objects come back setting for setting, with their identifiers.'],
  ['PADS', 'PADS Logic and PADS Layout ASCII files', 'PADS ASCII files', 'Unchanged, the file PADS wrote, byte for byte. Changed, that file with the changes written in (parts moved, nets rerouted, texts, drawings, copper and pours), in its own units and format version.'],
  ['EasyEDA', 'Standard and Pro projects and libraries', 'Standard source files, or a Pro project (.epro)', 'Read back in, a Pro export keeps every part, net, pad, via, pour and routed length. Not yet tried in EasyEDA Pro itself.'],
  ['OrCAD Capture', 'Designs and libraries (.dsn, .olb)', 'ASCII files that Cadence\'s translators read', 'Unchanged, the file Capture wrote, byte for byte.'],
  ['Allegro and OrCAD PCB Editor', 'Boards (.brd)', 'ASCII files that Cadence\'s translators read', 'Unchanged, the file Allegro wrote, byte for byte.'],
  ['EAGLE', 'Version 6 and later: schematics, boards and libraries (.sch, .brd, .lbr)', 'EAGLE 9 files', 'Unchanged, the files EAGLE wrote, byte for byte. A board with parts moved or nets rerouted is EAGLE\'s own file with those changes written in.'],
  ['DipTrace', 'XML files: schematics (.dchxml), boards (.dipxml), component and pattern libraries', 'DipTrace XML files', 'Unchanged, the files DipTrace wrote, byte for byte. Read back in, an export keeps every net, part, pad, via, pour and routed length. Not yet tried in DipTrace itself.'],
  ['IPC-2581', 'Revisions A to C: the board with its layers, stack-up, parts, nets and copper, and its footprints', 'IPC-2581 files (a fabrication output)', ''],
  ['Specctra autorouters (Freerouting)', 'Sessions (.ses): the router\'s routes', 'Designs (.dsn)', 'Each pin goes where Freerouting\'s own code places it. A full round through Freerouting has yet to be tried.'],
  ['EDIF', 'EDIF 2 0 0 schematics and netlists (.edf, .edn, .edif, .eds) from OrCAD, Mentor xDX Designer, Cadence, FPGA tools and others', 'The schematics as one EDIF 2 0 0 file (.edf)', ''],
  ['Protel boards of the 1990s', 'Boards saved as Protel PCB 2.8 ASCII (.pcb), and PCB 5.0 binary boards. The binary boards before those (PCB 3.0 and 4.0), binary schematics and .ddb design databases are not read: save them from Altium Designer as .PcbDoc and .SchDoc first', 'Saved as .PcbDoc', ''],
  ['Netlists', 'Onto a board (Design › Netlist › Load a Netlist): Protel, Tango, PADS, Telesis, KiCad, P-CAD, MultiWire and EDIF netlists', 'Of a project or a sheet: the Protel netlist (.NET), EDIF for PCB, P-CAD and MultiWire', 'Each of the four comes back as written.'],
];

function formats(d) {
  const body = `
    <section class="page-head"><div class="wrap narrow">
      <h1>Formats and round trips</h1>
      <p class="lead">Konium Designer works in Altium Designer's file formats. Designs from other tools come in through File › Import Wizard as projects in those formats, and go out through File › Export Wizard.</p>
    </div></section>

    <section><div class="wrap narrow">
      <h2>Its own files</h2>
      <p>Opened, edited and saved as they are:</p>
      <ul class="ticks cols">
        <li>Projects: .PrjPcb</li>
        <li>Schematics: .SchDoc</li>
        <li>PCBs: .PcbDoc</li>
        <li>Libraries: .SchLib, .PcbLib</li>
        <li>Integrated libraries: .IntLib (read)</li>
        <li>Database libraries: .DbLib, .DbLink</li>
        <li>Output Jobs: .OutJob</li>
        <li>Draftsman documents: .PCBDwf</li>
        <li>BOM documents: .BomDoc</li>
        <li>Multi-board: .PrjMbd, .MbsDoc, .MbaDoc</li>
        <li>Harness: .PrjHar, .WirDoc, .LdrDoc</li>
      </ul>
    </div></section>

    <section><div class="wrap">
      <h2 class="narrow-h">Other design tools</h2>
      <div class="table-wrap"><table class="formats">
        <thead><tr><th scope="col">Tool</th><th scope="col">Reads</th><th scope="col">Writes</th><th scope="col">Read and written back</th></tr></thead>
        <tbody>
${TOOLS.map(([t, r, w, n]) => `          <tr><th scope="row">${esc(t)}</th><td>${esc(r) || '<span class="muted">No</span>'}</td><td>${esc(w)}</td><td>${esc(n)}</td></tr>`).join('\n')}
        </tbody>
      </table></div>
      <p class="narrow-p muted">"Not yet tried" means the files have been checked by reading them back into Konium Designer and against the tool's own format, but not yet by opening them in that tool.</p>
    </div></section>

    <section><div class="wrap narrow">
      <h2>Manufacturing and other files</h2>
      <div class="table-wrap"><table class="plain">
        <tbody>
          <tr><th scope="row">Fabrication</th><td>Gerber, Gerber X2, ODB++, IPC-2581, NC drill, test points (IPC-D-356A, text, CSV)</td></tr>
          <tr><th scope="row">Assembly</th><td>Pick and place, bills of materials, JLCPCB assembly BOM, Smart PDF, Draftsman drawings</td></tr>
          <tr><th scope="row">3D</th><td>STEP models read and placed; boards written as STEP and STL; enclosures as STL, 3MF and STEP</td></tr>
          <tr><th scope="row">Simulation</th><td>SPICE netlists (.nsx, .cir), models and subcircuits (.mdl, .ckt), results (.sdf)</td></tr>
          <tr><th scope="row">Diagrams</th><td>.DgmDoc (Konium Designer's own); .drawio and Visio .vsdx opened and saved; PNG and SVG export</td></tr>
          <tr><th scope="row">Requirements</th><td>.ReqDoc (Konium Designer's own); Excel and CSV in and out; the compliance report as HTML</td></tr>
        </tbody>
      </table></div>
    </div></section>
`;
  return layout({ page: PAGES[2], depth: 1, body, title: 'Formats and round trips: Konium Designer', description: '.PrjPcb, .SchDoc and .PcbDoc files opened and saved as they are; KiCad, PADS, EasyEDA, OrCAD, Allegro, EAGLE, DipTrace, IPC-2581, Specctra and EDIF read or written, and what comes back unchanged.' });
}

/* ─── Download ─────────────────────────────────────────────────────────────────────── */

function download(d) {
  const file = `Konium-${d.version}.html`;
  const body = `
    <section class="page-head"><div class="wrap narrow">
      <h1>Install and download</h1>
      <p class="lead">Konium Designer runs on your computer. Install it as an app, or keep it as one file; you can also try it in a browser tab. It is the same program each way, and your projects stay on your computer.</p>
    </div></section>

    <section id="install"><div class="wrap narrow">
      <h2>As an app</h2>
      <p>Installed, Konium Designer has a window of its own, starts from the Start menu, apps menu or dock, and opens .PrjPcb, .SchDoc, .PcbDoc, library and STEP files from your computer. It works offline and takes new versions by itself.</p>
      <p class="actions"><a class="btn primary install" href="../app/?install">Install Konium Designer</a></p>
      <p>The button asks your browser to install it, or opens Konium Designer with its install window. You can also use the browser's own Install:</p>
      <ul class="ticks">
        <li>Chrome: the install icon at the right of the address bar, or the ⋮ menu › Cast, save and share › Install page as app.</li>
        <li>Edge: the install icon in the address bar, or the ⋯ menu › Apps › Install this site as an app.</li>
      </ul>
    </div></section>

    <section id="file" class="band"><div class="wrap narrow">
      <h2>As one file</h2>
      <p>The whole program in one HTML file. Keep it anywhere, open it in Chrome or Edge, and it runs with no internet. It never changes by itself; when you are online and a newer version is out, it says so.</p>
      <p class="actions"><a class="btn" href="../app/index.html" download="${esc(file)}">Download ${esc(file)}</a></p>
      <p class="fine">${esc(d.mb)} MB. Version ${esc(d.version)}.</p>
      <h3>Check the file</h3>
      <p>Its SHA-256 checksum:</p>
      <p><code class="hash">${esc(d.sha256)}</code></p>
      <div class="table-wrap"><table class="plain">
        <tbody>
          <tr><th scope="row">Windows (PowerShell)</th><td><code>Get-FileHash ${esc(file)}</code></td></tr>
          <tr><th scope="row">macOS</th><td><code>shasum -a 256 ${esc(file)}</code></td></tr>
          <tr><th scope="row">Linux</th><td><code>sha256sum ${esc(file)}</code></td></tr>
        </tbody>
      </table></div>
      <p>The checksum of each public release is also on the <a href="../whats-new/">What's New</a> page.</p>
    </div></section>

    <section id="tab"><div class="wrap narrow">
      <h2>In a browser tab</h2>
      <p>To try it first, open <a href="../app/">konium.app/app</a>. Nothing is installed. The browser keeps a copy of the program, so after the first visit it also opens without a connection, and it takes each new version when online.</p>
    </div></section>

    <section id="browsers"><div class="wrap narrow">
      <h2>Browsers</h2>
      <p>Chrome and Edge on Windows, macOS and Linux give the full experience: Konium Designer opens a project's folder, saves files back where they came from and keeps its recent lists. In other browsers you choose a project's whole folder to open it, and saving downloads the file.</p>
    </div></section>

    <section id="moved"><div class="wrap narrow">
      <h2>If you used konium.app before</h2>
      <p>Konium Designer used to open at konium.app itself and is now at konium.app/app. An installed app moves there by itself. Your settings, recent projects and local history are kept by the browser for konium.app, so the app at its new address has them.</p>
    </div></section>
`;

  return layout({ page: PAGES[3], depth: 1, body, title: 'Install and download: Konium Designer', description: `Konium Designer ${d.version}: install it as an app from Chrome or Edge, download it as one HTML file with its SHA-256 checksum, or try it in a browser tab. Works offline.` });
}

/* ─── What's New ───────────────────────────────────────────────────────────────────── */

function whatsNew(d) {
  const rel = '../';
  const body = `
    <section class="page-head"><div class="wrap narrow">
      <h1>What's New</h1>
      <p class="lead">Every public release, the newest first. Each entry covers everything since the release before it. The same log is on the Home page inside Konium Designer.</p>
    </div></section>
${d.releases.map((r) => `    <section class="release" id="v${esc(r.version)}"><div class="wrap narrow">
      <h2><span class="ver">${esc(r.version)}</span> ${esc(r.title)}</h2>
      ${r.sha256 ? `<p class="fine">SHA-256 of Konium-${esc(r.version)}.html: <code class="hash">${esc(r.sha256)}</code></p>` : ''}
      <ul class="items">
${r.items.map((i) => `        <li><p>${esc(i.text)}</p>${i.image && !/^https?:/i.test(i.image) ? shot(rel, i.image, i.alt || '', '', d.size) : ''}</li>`).join('\n')}
      </ul>
    </div></section>`).join('\n')}
`;
  return layout({ page: PAGES[4], depth: 1, body, title: "What's New: Konium Designer", description: `Konium Designer's release log, from ${d.releases.at(-1)?.version ?? ''} to ${d.releases[0]?.version ?? ''}: what each public release added, with pictures and checksums.` });
}

/* ─── FAQ ──────────────────────────────────────────────────────────────────────────── */

/** Every connection Konium Designer can make: the User Guide's table (Reference › Network connections), word for word but its markup. */
export const CONNECTIONS = [
  ['Updates', 'A little after starting, then every few hours.', 'konium.app', 'A request for the version number, without cookies or referrer. Nothing about you or your files.', "Untick Check konium.app for updates and What's New."],
  ["What's New", 'When the Home page shows it.', 'konium.app', 'A request for the release log and its pictures.', 'The same switch.'],
  ['Donation note', 'Only on the rare start that asks for a donation.', 'konium.app', "A request for the day's wording of the ask. konium.app has it written once a day by a small AI model through OpenRouter, from fixed facts: nothing about you or your files goes to either.", 'Offline on (the ask then keeps its own words).'],
  ['Visit count', 'Only at konium.app itself; never in a downloaded copy.', "cloud.umami.is (Umami, which counts the website's visits)", 'The page visited, with no cookies and nothing that identifies you.', 'The same switch.'],
  ['Offline files', 'A copy at konium.app, or installed from it: when it is loaded, and about once a day when the browser itself looks for newer offline files.', 'konium.app', "A request for a newer version of Konium Designer's offline files.", "The same switch keeps the version you have. The browser's own daily look cannot be switched off from a page; a downloaded copy has none."],
  ['AI jobs: Konium service', "Only when you start a job, and when an AI tool's panel or Preferences › System › AI asks the service for its models and today's allowance.", 'konium.app, then OpenRouter (openrouter.ai), then the company OpenRouter has run the chosen model: its maker (Anthropic, Google, OpenAI) or a host of it.', 'What the job needs (a datasheet, or the design as text), shown before it goes. konium.app keeps nothing of your design and counts your IP address only as a salted hash, for the daily allowance; companies that train on what they are sent are left out.', 'Choose Off on Preferences › System › AI (the default).'],
  ['AI jobs: your own key', "Only when you start a job, when an AI tool's panel asks for the models and their prices, and when you press Load Models or Test on Preferences › System › AI.", 'Straight from your browser, not through konium.app: OpenRouter (openrouter.ai), which passes the job to the company that runs the model; or the address you gave for another provider (api.openai.com, for one).', 'The same, with your key. The key is kept in this browser only and goes nowhere else.', 'The same.'],
  ['AI jobs: a local model', 'The same.', 'The address you gave: a model server on your computer or your network.', 'The same. Nothing leaves your computer or network.', 'The same.'],
  ['Datasheets for the AI tools', "When an AI tool looks for a part's datasheet on the web, and when it fetches one.", 'Looking for it is an AI job (the rows above) with a web search that OpenRouter makes. Fetching it: konium.app, then the website the datasheet is on.', "To look for it: the part number, its maker and its description. To fetch it: the datasheet's address and the part number.", 'AI Off, or give the datasheet as a file.'],
  ['Shared AI results', 'With Konium service, when you accept what was read from a datasheet that came from the web (never one opened from your computer).', 'konium.app', "What was read and accepted, kept by the datasheet's fingerprint for the next person. Nothing of your design.", 'Untick Share what I accept, and use what others accepted.'],
  ['Supplier data: JLCPCB', "When you look parts up in JLCPCB's list in a BOM document, or update their supplier data.", "jlcsearch.tscircuit.com: a public copy of JLCPCB's parts list kept by tscircuit, not JLCPCB itself.", 'The part number or value searched for.', "Don't search."],
  ['Supplier data: Digi-Key and Mouser', "When you search Digi-Key or Mouser in a BOM document, or update their parts' supplier data.", 'konium.app, then Digi-Key (api.digikey.com) or Mouser (api.mouser.com).', 'The part number or words searched for; Digi-Key or Mouser gets only those, from konium.app. Answers are kept a day; your IP address is counted only as a salted hash, for the daily limit.', "Don't search."],
  ['Bug reports and messages', 'When you press Send.', "konium.app, then the author's mailbox. A bug report is also filed in the author's private repository at GitHub (github.com), where the author and the AI assistant that helps build Konium Designer (Claude, by Anthropic) read it. A message to the author is mailed only.", 'What you write and attach, and the diagnostics if Include diagnostics is ticked.', "Don't send. A report written offline waits in the browser and goes once it can."],
  ['Version control', 'For a project under version control: when you commit, update or open it, and every few minutes while it is open.', "Konium's store at konium.app (kept in Cloudflare's storage), or your team's own Git server (GitHub, GitLab, Bitbucket or your own) through the relay at konium.app/api/git unless you change it.", "To the store: the project's versions, sealed with your team's key first (konium.app never has the key). To your own server: what Git sends, with your sign-in; the relay passes it on and keeps nothing.", 'On Preferences › Data Management › Version Control: Look for them every 0 minutes checks only when you update; Reached through can go straight to a server that allows it, or through another relay.'],
  ['Download', 'When you click Download Konium-<version>.html in Help › Get Konium Designer on This Computer... (in a browser tab).', 'The site the page came from (konium.app).', 'A request for the page itself, to save as one file.', 'Network activity off saves the copy the browser keeps for offline use, if there is one.'],
  ['Links you click', "When you click a link that leads out of Konium Designer: Chip in... in Help › Support Konium Designer or on the donation ask, a part's page in a BOM document, a datasheet's address, a board house's page in Design › Fab-House Profile, the Gydel icon beside the menus, Source Code in Help › About, a page of the website, a link in one of your own documents.", "Your browser opens the page in a new tab: ko-fi.com (donations, paid to Ko-fi there), lcsc.com and the Digi-Key and Mouser websites (parts), the datasheet's website, the board house's website, gydel.games, github.com (the source code), konium.app, or wherever your document's link leads.", 'Nothing from Konium Designer. The website sees a visit from your browser, as from any link.', "Don't click. Network activity off does not stop these: the click is yours."],
];

export const FAQ = [
  // The three that are asked with an edge: answered with one. The rest of the page only informs.
  { id: 'ai-slop', blunt: true, q: 'Is this "AI slop"?',
    a: ['<strong>Yes, AI wrote this code.</strong> If that alone settles your opinion, stop reading here: nothing below will change a mind made up before the evidence. An opinion formed before trying something is not a review, it is a reflex.',
      `For everyone else, the evidence. An electronics engineer directs the work and decides what ships; the AI writes the code. Every build has to pass more than 1,800 automated tests and more than 800 checks made in a real browser before it goes out. ${out(SOURCE, 'The source is public')}, tests included, so none of this has to be taken on trust. Bug reports are read every day, and their fixes go into the next builds.`,
      'Try it, break it, <a href="../support/">report it</a>.'] },
  { id: 'kicad', blunt: true, q: "What does it do that KiCad doesn't?",
    a: [`It works on Altium Designer's files as they are. It opens a .PrjPcb with its .SchDoc and .PcbDoc files, you edit them with the menus and keys you already know, and it saves them back as the same files. KiCad ${out(SOURCES.kicadProject, 'imports an Altium Designer project')} into its own format, and the ${out(SOURCES.kicadPcb, "outputs its PCB editor's manual lists")} are fabrication and exchange files (Gerber, drill, IPC-2581, ODB++, STEP and the like), with no Altium Designer format among them. If the people you work with send .PcbDoc and expect .PcbDoc back, that is the whole difference.`,
      `It needs no installing: one file in a browser tab, working offline. KiCad is ${out(SOURCES.kicadProject, 'a desktop program')} for Windows, Linux and macOS.`,
      `And it has built in what the ${out(SOURCES.kicadPcb, "KiCad PCB editor's manual")} has no chapter for: an autorouter (that manual covers interactive routing, and Specctra files to and from an outside autorouter), analysis of a supply's voltage drop, of the board's temperature and of its supply impedance, EMC checks, antenna analysis, and an enclosure designer for the board.`,
      `If KiCad already does what you need, keep using it. Konium Designer is not out to replace it: it is for the desk where the files are Altium Designer's. Checked against KiCad 10's documentation in ${CHECKED}.`] },
  { id: 'free-eda', blunt: true, q: 'There are free EDA tools already. Why another?',
    a: [`Because those are built round file formats of their own: hand them an Altium Designer project and they convert it. KiCad imports it (the answer above). EasyEDA Pro ${out(SOURCES.easyedaImport, 'imports Altium Designer files saved as ASCII')}, and its documentation says binary files are not supported for the time being; ${out(SOURCES.easyedaExport, 'its export writes ASCII files')} without the board's rules or its copper pours, and advises against exporting and importing back repeatedly, because detail is lost. Konium Designer converts nothing: the Altium Designer file is the file it works on.`,
      `So it competes with neither. If your designs live in KiCad or EasyEDA, stay there; Konium Designer <a href="../formats/">reads and writes their files</a> for the day a design has to cross over. If the designs you are sent, or your own archive, are Altium Designer files, and you want to open, change and return them on any computer with Chrome or Edge and without an Altium Designer licence, this is the tool for that. Checked against EasyEDA Pro's documentation in ${CHECKED}.`] },
  { id: 'online', q: 'Does Konium Designer only work online?',
    a: ['No. It runs in your browser, on your computer, and works without a connection. Opened at <a href="../app/">konium.app/app</a> once, it opens offline afterwards; installed as an app, it works offline; downloaded as one HTML file, it never needs the internet. konium.app is where it comes from, and where its optional services are (the AI tools, part searches, bug reports).'] },
  { id: 'ai-layout', q: 'Does the AI lay out my board for me?',
    a: ['It plans, and tools you can check carry the plans out. The Layout Planner asks the model you chose where the parts should go and why; a placer then places them and shows what the plan asked against what was met. The Smart Router asks the model how the nets should be routed (widths, layers, order, pours); the plan becomes ordinary net classes and design rules, the autorouter routes by them, and the design rule check measures the result. The model never gives coordinates and every step can be undone. How good a plan is depends on the model, so read it before you carry it out.'] },
  { id: 'files', q: 'Where are my files kept?',
    a: ['On your computer. Konium Designer opens projects from your disk and saves them back there, in the same formats. Nothing is uploaded unless you send it yourself: a bug report, an AI job, or a project you share through version control.'] },
  { id: 'connections', q: 'What does it connect to?',
    a: ['Only for the things below; your files are never sent anywhere by themselves. To names every party what goes reaches, in order: the address your browser asks, then whoever that passes it on to. Help › About lists the connections too, each marked as allowed or stopped. To switch them all off, untick Allow Konium Designer to use network activity in Preferences › System › Network Activity (Offline): the browser itself then refuses every connection the page tries.', "konium.app's own services (AI, parts, reports and version control) run on Cloudflare, which also carries the requests to this website."], table: true },
  { id: 'ai', q: 'Does it use AI?',
    a: ['Only if you switch it on, in Preferences › System › AI. It is off to begin with, and then nothing is sent anywhere. With it on, you choose where jobs go: the Konium service (free within a daily allowance; it passes jobs to the chosen model through OpenRouter and excludes providers that train on what they are sent), your own key, or a model on your own computer, where nothing leaves it. Each job shows what it will send before it goes.'] },
  { id: 'cost', q: 'Is it really free? Do I need an account?',
    a: ['It is free, with no account and no adverts. It is supported by donations, which help pay for the AI service.'] },
  { id: 'altium', q: 'Can I open Altium Designer files without Altium Designer?',
    a: ['Yes. Konium Designer opens .PrjPcb, .SchDoc, .PcbDoc, .SchLib and .PcbLib files, shows them as they look there and saves them back in the same formats. It reads integrated libraries (.IntLib) too. See <a href="../formats/">Formats</a>.'] },
  { id: 'familiar', q: 'Will it feel familiar?',
    a: ['That is what it is made for: the menus, panels, dialogs and shortcut keys are the ones you know, so you can work as you do in the desktop software.'] },
  { id: 'affiliated', q: 'Is Konium Designer made by Altium?',
    a: ['No. Konium Designer is independent and not affiliated with Altium Ltd.'] },
  { id: 'other-tools', q: 'Can it import KiCad, PADS, EasyEDA, OrCAD, Allegro, EAGLE or DipTrace designs?',
    a: ['Yes. File › Import Wizard brings them in as projects of its own, and File › Export Wizard writes a project for each of them. <a href="../formats/">Formats</a> says what each one reads and writes, and what comes back unchanged.'] },
  { id: 'browsers', q: 'Which browsers and computers does it run on?',
    a: ['Chrome and Edge on Windows, macOS and Linux, with whole project folders. Other browsers work with a project\'s folder chosen to open it, and saving downloads the file.'] },
  { id: 'updates', q: 'How do I get new versions?',
    a: ['In a browser tab or installed, Konium Designer looks for a newer version a little after it starts and then every few hours, and offers to reload into it. A downloaded file never changes; when you are online it tells you a newer version is out, and you download that one. With updates switched off, an installed copy stays on the version it has.'] },
  { id: 'source', q: 'Is the source code available?',
    a: [`Yes. Konium Designer is free software under the GNU General Public License, version 3 or later, and its source is at ${out(SOURCE, SOURCE.replace('https://', ''))}: the program, its tests and the services behind konium.app. It is built from scratch by its author, with AI tools (the first question on this page says how). Reports of faults are welcome there; changes from outside are not taken in yet.`] },
  { id: 'moved', q: 'Konium Designer used to open at konium.app. Where is it?',
    a: ['At <a href="../app/">konium.app/app</a>. An app installed from konium.app moves there by itself, and your settings, recent projects and local history come with it, since the browser keeps them for konium.app.'] },
];

function faq(d) {
  const table = `<div class="table-wrap"><table class="conn">
          <thead><tr><th scope="col">Connection</th><th scope="col">When</th><th scope="col">To</th><th scope="col">What goes</th><th scope="col">To stop it</th></tr></thead>
          <tbody>
${CONNECTIONS.map((c) => `            <tr><th scope="row">${c.slice(0, 1).map(esc)}</th>${c.slice(1).map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('\n')}
          </tbody>
        </table></div>`;
  const body = `
    <section class="page-head"><div class="wrap narrow">
      <h1>Questions</h1>
    </div></section>
    <section><div class="wrap narrow faq">
${FAQ.map((f) => `      <div class="qa${f.blunt ? ' blunt' : ''}" id="${f.id}">
        <h2>${esc(f.q)}</h2>
        ${f.a.map((t) => `<p>${t}</p>`).join('\n        ')}${f.table ? `\n        ${table}` : ''}
      </div>`).join('\n')}
    </div></section>
`;
  const ld = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a.join(' ').replace(/<[^>]+>/g, '') } })) };
  return layout({ page: PAGES[5], depth: 1, body, extraHead: `\n  <script type="application/ld+json">${JSON.stringify(ld)}</script>`, title: 'Questions: Konium Designer', description: 'Is it AI slop? What does it do that KiCad does not? Does Konium Designer only work online, where are files kept, what does it connect to, which browsers, and is the source available.' });
}

/* ─── Support ──────────────────────────────────────────────────────────────────────── */

/** The topics of Help › Contact the Author (src/app/dialogs/Contact.tsx TOPICS). */
export const TOPICS = ['A question or a comment', 'A security problem, reported privately', 'Something else'];

function support(d) {
  const body = `
    <section class="page-head"><div class="wrap narrow">
      <h1>Support and contact</h1>
    </div></section>

    <section id="donate"><div class="wrap narrow">
      <h2>Donate</h2>
      <p>Konium Designer is free and has no adverts. Donations help pay for its development and for the free AI service. They go through Ko-fi.</p>
      <p class="actions"><a class="btn primary" href="${KOFI}" rel="noopener">Donate on Ko-fi</a></p>
    </div></section>

    <section id="bugs" class="band"><div class="wrap narrow">
      <h2>Report a bug</h2>
      <p>Use Help › Report a Bug in Konium Designer. It can attach screenshots and files, or the document you have open, and diagnostics (the version, the browser, the open documents' names, recent errors), which you can read before you send them. Your name and address are optional.</p>
    </div></section>

    <section id="contact"><div class="wrap narrow">
      <h2>Write to the author</h2>
      <p>A question, a comment, or a security problem you would rather report privately than in public. Your message goes to the author only, and your address is used only to answer you.</p>
      <form class="contact" novalidate>
        <label>Your name <span class="muted">(optional)</span><input name="name" type="text" maxlength="100" autocomplete="name" /></label>
        <label>Your email<input name="email" type="email" maxlength="254" autocomplete="email" required /></label>
        <label>About<select name="topic">${TOPICS.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
        <label>Your message<textarea name="text" rows="7" maxlength="20000" required></textarea></label>
        <label class="trap" aria-hidden="true">Leave this empty<input name="website" type="text" tabindex="-1" autocomplete="off" /></label>
        <p class="form-row"><button class="btn primary" type="submit">Send</button> <span class="status" role="status"></span></p>
      </form>
    </div></section>
`;
  const script = `
  <script>
    // The message goes to konium.app's report service as Help › Contact the Author sends it (kind=contact)
    addEventListener('DOMContentLoaded', function () {
      var f = document.querySelector('form.contact'); if (!f) return;
      var status = f.querySelector('.status'), button = f.querySelector('button');
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var data = new FormData(f);
        if (!String(data.get('email') || '').trim()) { status.textContent = 'An email address is needed, to answer you.'; return; }
        if (!String(data.get('text') || '').trim()) { status.textContent = 'Write your message.'; return; }
        data.append('kind', 'contact'); data.append('version', 'website');
        button.disabled = true; status.textContent = 'Sending...';
        fetch('../api/report', { method: 'POST', body: data }).then(function (r) { return r.json().catch(function () { return { error: 'The server answered ' + r.status }; }); })
          .then(function (j) { if (j && j.ok) { f.reset(); status.textContent = 'Sent. Thank you.'; } else { status.textContent = (j && j.error) || 'It could not be sent.'; } })
          .catch(function () { status.textContent = 'konium.app could not be reached. Try again later.'; })
          .then(function () { button.disabled = false; });
      });
    });
  </script>`;
  return layout({ page: PAGES[6], depth: 1, body, extraHead: script, title: 'Support and contact: Konium Designer', description: 'Donate to Konium Designer on Ko-fi, report a bug from inside the app, or write to its author.' });
}

/* ─── Guides ───────────────────────────────────────────────────────────────────────── */

/** A guide's text as HTML: escaped, its [label](path) links made (path from the site's root). */
const guideText = (t, rel) => esc(t).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, path) => `<a href="${rel}${path}">${label}</a>`);

const guideBlock = (b, rel, d) => {
  if (b.h2) return `<h2>${esc(b.h2)}</h2>`;
  if (b.p) return `<p>${b.label ? `<strong>${esc(b.label)}</strong> ` : ''}${guideText(b.p, rel)}</p>`;
  if (b.steps) return `<ol class="steps">\n${b.steps.map((t) => `          <li>${guideText(t, rel)}</li>`).join('\n')}\n        </ol>`;
  if (b.list) return `<ul class="ticks">\n${b.list.map((t) => `          <li>${guideText(t, rel)}</li>`).join('\n')}\n        </ul>`;
  if (b.table) return `<div class="table-wrap"><table class="formats">
          <thead><tr>${b.table.head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>
${b.table.rows.map(([first, ...rest]) => `            <tr><th scope="row">${esc(first)}</th>${rest.map((c) => `<td>${guideText(c, rel)}</td>`).join('')}</tr>`).join('\n')}
          </tbody>
        </table></div>`;
  if (b.roundTrip) {
    // The Formats page's own rows for these tools: what is read, what is written, and what comes back
    const rows = TOOLS.filter(([t]) => b.roundTrip.includes(t));
    return `<div class="table-wrap"><table class="formats">
          <thead><tr><th scope="col">Tool</th><th scope="col">Reads</th><th scope="col">Writes</th><th scope="col">Read and written back</th></tr></thead>
          <tbody>
${rows.map(([t, r, w, n]) => `            <tr><th scope="row">${esc(t)}</th><td>${esc(r)}</td><td>${esc(w)}</td><td>${esc(n)}</td></tr>`).join('\n')}
          </tbody>
        </table></div>${rows.some(([, , , n]) => /Not yet tried/.test(n)) ? `\n        <p class="muted">"Not yet tried" means the files have been checked by reading them back into Konium Designer and against the tool's own format, but not yet by opening them in that tool.</p>` : ''}`;
  }
  return b.shot ? shot(rel, b.shot[0], b.shot[1], esc(b.shot[2]), d.size, b.dialog ? 'dialog' : '') : '';
};

const guidePath = (g) => `guides/${g.slug}/index.html`;
const guideTitle = (g) => `${g.title ?? g.h1}: Konium Designer`;

function guide(g, d) {
  const rel = '../../';
  const page = PAGES.find((p) => p.path === guidePath(g));
  const url = `${ORIGIN}guides/${g.slug}/`;
  // Its picture after the first part (how to open it)
  const second = g.blocks.findIndex((b, i) => i > 0 && b.h2);
  const blocks = g.img && second > 0 ? [...g.blocks.slice(0, second), { shot: g.img }, ...g.blocks.slice(second)] : g.blocks;
  const body = `
    <section class="page-head guide-head"><div class="wrap narrow">
      <p class="crumbs"><a href="${rel}">Konium Designer</a> <span aria-hidden="true">›</span> <a href="../">Guides</a></p>
      <h1>${esc(g.h1)}</h1>
      <p class="lead">${guideText(g.lead, rel)}</p>
      <p class="actions"><a class="btn primary install" href="${rel}app/?install">Install Konium Designer</a><a class="btn" href="${rel}app/">Try it in a browser tab</a></p>
    </div></section>

    <section><div class="wrap narrow guide">
        ${blocks.map((b) => guideBlock(b, rel, d)).join('\n        ')}
    </div></section>

    <section class="band"><div class="wrap narrow">
      <h2>Get Konium Designer</h2>
      <p>It is free, with no account. Install it from Chrome or Edge, keep it as one file, or try it in a browser tab. Version ${esc(d.version)}.</p>
      <p class="actions"><a class="btn primary install" href="${rel}app/?install">Install Konium Designer</a><a class="btn" href="${rel}download/#file">Download as one file</a></p>
      <p class="fine"><a href="${rel}download/">More on installing</a>, <a href="${rel}features/">what it does</a>, and <a href="${rel}faq/">questions</a>.</p>
    </div></section>

    <section><div class="wrap narrow">
      <h2>More guides</h2>
      <ul class="ticks">
${g.related.map((slug) => GUIDES.find((x) => x.slug === slug)).map((x) => `        <li><a href="../${x.slug}/">${esc(x.h1)}</a></li>`).join('\n')}
        <li><a href="../">All the guides</a></li>
      </ul>
    </div></section>
`;
  const ld = [
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [['Konium Designer', ORIGIN], ['Guides', `${ORIGIN}guides/`], [g.h1, url]].map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })) },
    { '@context': 'https://schema.org', '@type': 'TechArticle', headline: g.h1, description: g.description, inLanguage: 'en-GB', url, about: { '@type': 'SoftwareApplication', name: 'Konium Designer', url: ORIGIN }, publisher: { '@type': 'Organization', name: 'Konium Designer', url: ORIGIN } },
  ];
  return layout({ page, depth: 2, body, title: guideTitle(g), description: g.description, extraHead: `\n  <script type="application/ld+json">${JSON.stringify(ld)}</script>` });
}

function guides() {
  const rel = '../';
  const item = (g) => `        <li><a href="${g.slug}/">${esc(g.h1)}</a><p>${esc(g.description)}</p></li>`;
  const body = `
    <section class="page-head"><div class="wrap narrow">
      <h1>Guides</h1>
      <p class="lead">How to open, view and convert Altium Designer files with Konium Designer, on Windows, macOS and Linux.</p>
    </div></section>

    <section><div class="wrap narrow guide">
      <h2>Opening Altium Designer files</h2>
      <ul class="guides">
${GUIDES.filter((g) => !g.converter).map(item).join('\n')}
      </ul>
      <h2>Converting between Altium Designer and other tools</h2>
      <ul class="guides">
${GUIDES.filter((g) => g.converter).map(item).join('\n')}
      </ul>
      <p><a href="${rel}formats/">Formats</a> has every file type Konium Designer reads and writes.</p>
    </div></section>
`;
  return layout({ page: PAGES.find((p) => p.path === 'guides/index.html'), depth: 1, body, title: 'Guides: open and convert Altium Designer files with Konium Designer', description: 'How to open .PcbDoc and .SchDoc files without Altium Designer, view them free, use them on macOS and Linux, and convert between Altium Designer and KiCad, EAGLE, EasyEDA, OrCAD, Allegro, PADS and DipTrace.' });
}

/** Every page of the website: [path, html]. d: { version, sha256, mb, releases, size(path) → {w, h} | null }. */
export function renderSite(d) {
  ver = d.ver ?? (() => '');
  return [
    ['index.html', home(d)],
    ['features/index.html', features(d)],
    ['formats/index.html', formats(d)],
    ['download/index.html', download(d)],
    ['whats-new/index.html', whatsNew(d)],
    ['faq/index.html', faq(d)],
    ['support/index.html', support(d)],
    ['guides/index.html', guides()],
    ...GUIDES.map((g) => [guidePath(g), guide(g, d)]),
  ];
}

/**
 * The page for an address the site doesn't have (the server's ErrorDocument, .htaccess): its links
 * from the site's root, since it is shown at any address. Not one of PAGES: not in the sitemap, and
 * not for search engines.
 */
export function notFound(d) {
  ver = d.ver ?? (() => '');
  const body = `
    <section class="page-head"><div class="wrap narrow">
      <h1>This page is not here</h1>
      <p class="lead">The address may be mistyped, or the page may have moved.</p>
      <p class="actions"><a class="btn primary" href="/">Konium Designer's home page</a><a class="btn" href="/app/">Open Konium Designer</a></p>
      <ul class="ticks">
${PAGES.filter((p) => p.nav && p.path !== 'index.html').map((p) => `        <li><a href="/${p.path.replace(/index\.html$/, '')}">${esc(p.nav)}</a></li>`).join('\n')}
        <li><a href="/guides/">Guides</a></li>
      </ul>
    </div></section>
`;
  return layout({ page: { path: '404.html' }, depth: 0, rel: '/', body, title: 'Page not found: Konium Designer', description: 'This address is not a page of konium.app. Konium Designer, free schematic and PCB design software, is at konium.app.', extraHead: '\n  <meta name="robots" content="noindex" />' })
    .replace(/\n  <link rel="canonical"[^\n]*/, '').replace(/\n  <meta property="og:url"[^\n]*/, '');
}

/**
 * The site's worker as it is sent out (public/sw.js as the build finds it): its cache named for
 * this upload too (fingerprint: of every file of the website), and the pages and style sheet it
 * keeps at once (more: their addresses from the site's root).
 */
export function stampWorker(source, fingerprint, more) {
  const cache = /const CACHE = '(konium-site-v\d+\.\d+)';/, list = 'const MORE = [];';
  if (!cache.test(source) || !source.includes(list)) throw new Error('website: sw.js has no CACHE or MORE to stamp');
  return source.replace(cache, (_, name) => `const CACHE = '${name}-${fingerprint}';`).replace(list, `const MORE = ${JSON.stringify(more.map((m) => `./${m}`))};`);
}

/** The sitemap: the pages, at their canonical addresses (llms.txt is found where it always is, not here). */
export const sitemap = () => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.map((p) => `  <url><loc>${ORIGIN}${p.path.replace(/index\.html$/, '')}</loc></url>`).join('\n')}
</urlset>
`;
