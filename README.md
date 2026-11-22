# Konium Designer

> **Yes, AI wrote this code.** If that alone settles your opinion, stop reading here: nothing below will change a mind made up before the evidence. An opinion formed before trying something is not a review, it is a reflex. Everyone else: try it, break it, report it.

Schematic capture and PCB layout that reads and writes Altium Designer's files, following its
look, menus, shortcuts and workflow: schematic → Compile → Update PCB Document (ECO) → place →
Interactive Routing with design rules → DRC → Gerber, NC Drill and Pick and Place outputs, with
library editors, 3D, simulation, board analyses and an enclosure designer. It runs in a browser,
on your own computer, offline, as one self-contained HTML file. Nothing is installed and no file
of yours is uploaded.

- **Run it:** [konium.app/app](https://konium.app/app/) in Chrome or Edge, or [download the one file](https://konium.app/download/).
- **What it does:** [features](https://konium.app/features/), [formats and round trips](https://konium.app/formats/), [questions](https://konium.app/faq/).
- **Something wrong?** Help › Report a Bug in the program, or an issue here.

Konium Designer is an independent project for hobby, learning and other non-commercial work. It
is not a replacement for Altium Designer; for professional and commercial work we recommend a
genuine Altium Designer subscription. (That is what it is built and tested for. The licence
itself puts no limit on what you use it for.)

## How it is made

An electronics engineer directs the work and decides what ships. An AI (Claude, by Anthropic)
writes the code, the tests and most of this text, one build at a time; every commit says so. A
build goes out only when all of this passes:

- the type check and the unit tests (`npm test`: over 1,800 tests of the file formats, the
  model, the analyses and the services);
- a run in a real browser (`tests/tools/smoke.py`: over 800 checks that open, edit, save and
  read back documents through the interface);
- for a public release, a sweep of every dialog for fields out of line (`tests/tools/uiAudit.py`).

Bug reports are read every day and their fixes go into the next builds. The record of every
build is in [UNRELEASED.md](UNRELEASED.md) and [docs/STATUS.md](docs/STATUS.md); the plan is
[docs/RELEASES.md](docs/RELEASES.md); how the code is laid out, and the rules it is written to,
are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Where the knowledge of each file format
came from is in [docs/PROVENANCE.md](docs/PROVENANCE.md).

## What does it do that KiCad doesn't?

It works on Altium Designer's files as they are: it opens a .PrjPcb with its .SchDoc and .PcbDoc
files and saves them back as the same files, where KiCad imports them into its own format. It
needs no installing. And it has an autorouter, power, thermal, EMC and antenna analyses and an
enclosure designer built in. The [FAQ](https://konium.app/faq/#kicad) gives the answer in full,
with the pages of KiCad's own documentation each statement rests on. If KiCad already does what
you need, keep using it: Konium Designer is for the desk where the files are Altium Designer's,
and it reads and writes KiCad's files for the day a design has to cross over.

## Contributing

Reports of faults are welcome: what you did, what happened, and the file if you can share it.
Changes from outside (pull requests) are not taken in yet: the code is written through one
process with one set of checks, and there is no good way yet to bring outside patches through
it. Say what you need in an issue instead. You are free to fork it under the licence.

## Reporting a security problem

Privately, please, before it is public: Help › Contact the Author in the program, or the form at
[konium.app/support](https://konium.app/support/#contact), with the topic "A security problem,
reported privately". It reaches the author only. Say what you found, where, and how to see it
happen; you will be answered. [SECURITY.md](SECURITY.md) says what counts and what to expect.

## Licence

Copyright (C) 2026 Konstantin Dimitrov

Konium Designer is free software: you can redistribute it and/or modify it under the terms of
the GNU General Public License as published by the Free Software Foundation, either version 3 of
the License, or (at your option) any later version. It is distributed in the hope that it will
be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the licence itself.

The software of others that is built into it keeps its own licences: the build writes each
one's notice into the program (Help › About › Third-Party Software; `tests/tools/notices.mjs`
gathers them from the packages in `package.json`).

"Konium", "Konium Designer" and the Konium mark are the author's: a changed version that is
passed on should carry another name. Not affiliated with or endorsed by Altium. Altium Designer
is a trademark of Altium Limited; KiCad, PADS, EasyEDA, OrCAD, Allegro, EAGLE and DipTrace are
their owners' trademarks. No code or artwork of any of them is used.

Versions are the year and the build within it: 26.009 is 2026's ninth build (package.json keeps
it as semver, 26.9.0).

## Run from source

Windows: double-click `start.cmd` (installs dependencies on first run, then opens the app).
In PowerShell, use `npm.cmd` instead of `npm` if script execution is disabled.

```
npm install
npm run dev          # open the http://localhost:5173 address it prints
npm test             # unit tests (formats, keymap)
npm run build        # → dist/: the website (konium.app), and the app at dist/app/index.html, one self-contained file (JS, CSS, fonts inlined)
```

Three switches can be put in the program's address, for testing: `?features=all` shows the
features still marked as planned (`src/core/release.ts`: each belongs to a release and is
switched on with it); `?debug` puts the program's own functions on `window.konium`, which is how
the browser run drives it; `?gpu=software` lets the antenna solver use a software-drawn GPU. None
of them reaches anything a script on the page could not reach already.

The root `index.html` is the Vite source entry: opened directly from disk it can't run (it shows
a message saying so). `dist/app/index.html` runs anywhere: double-clicked from disk, from any folder
on a server, or at a site root. Served over http(s) it also installs as a PWA (its worker `sw.js`
beside it; `manifest.webmanifest` and `icon.svg` in the website's folder above it): a window of its own without the browser's
address bar, its menu bar the title bar (Window Controls Overlay: the window's buttons over its
right end, or left on a Mac; its empty parts drag the window).

**File › Open Project…** picks a .PrjPcb, then asks once to confirm its folder: browsers only
hand a page the files you choose, and the confirmation is what lets the schematics and board load
with the project. Opened projects go in **Recent projects** (welcome page and File › Recent), one
click away next time. Dropping a project folder or a .PrjPcb on the window works too. Chromium
desktop also gets save in place and PWA file handlers (double-click a .PrjPcb once installed).
Other browsers pick the project folder directly and save by download. Tested in Chromium only.
Without WebGL 2 (turned off, or the graphics driver blocked, as on many Windows 7 computers) the
editors draw with the 2D canvas instead, the same picture, slower on big boards; the 3D views need it.

**File › Import Wizard** brings in KiCad projects and libraries (KiCad 6 and later), PADS and
EasyEDA designs, OrCAD Capture designs and libraries, Allegro boards, EAGLE designs and libraries,
DipTrace designs and libraries, EDIF schematics, IPC-2581 boards and diagrams: Add Folder takes a project's folder (its schematics, board and libraries come
with it), Import converts and opens it as an AD project, saved into the output folder if one is
chosen. Opening or dropping such files does the same. **File › Export Wizard** goes the other
way: the open project as a KiCad project (KiCad 8's files), PADS ASCII, EasyEDA source, OrCAD and
Allegro ASCII, EAGLE, DipTrace or EDIF files, into a folder or as a zip.

Konium edits one model, the desktop software's documents; the other formats are converted on the
way in and out. A KiCad project read and written back comes back as KiCad had it: what Konium makes
nothing of is kept in the converted files (KICAD… keys, a kept store, the PrjPcb's [KiCad] section)
and written again while the object it belongs to is unchanged; an object changed in Konium is
written from Konium's. `tests/tools/kicadRoundTrip.ts` and `kicadLibRoundTrip.ts` measure it. A PADS
design read and written back unchanged is the files PADS wrote, byte for byte; a board changed in
Konium is the file PADS wrote but for what changed (parts moved, nets rerouted, free texts, drawings,
copper, keep-outs and pours changed, added or taken away), in the file's own units and as its
version writes them; changed beyond that (parts added or taken away, footprints, the board outline,
nets, rules), it is written from Konium's in the file's frame and units with its layer numbers,
decal and part type names. `tests/tools/padsRoundTrip.ts` measures it. An Allegro board (.brd)
and an OrCAD Capture design (.dsn) read and exported for Cadence unchanged are the files Allegro
and Capture wrote, byte for byte; changed, they go in the ASCII formats Cadence's own translators
read, so Cadence's tools make their native files from them. `tests/tools/allegroCheck.ts` compares
the boards Konium reads with Allegro's own extract of them; `cadenceRoundTrip.ts` checks the files
come back.

`Symbols.SchDoc` in the demo project has every schematic symbol Konium draws (power port
styles, pin decorations, ports, sheet entries, junctions, No ERC). Open it in Altium and here to
compare; geometry lives in `src/editors/sch/powerPort.ts` and `symbols.ts`, each value tagged
with its source.

## Verify against real files (do this first)

```
npx vite-node tests/tools/corpus.ts  <folder-of-altium-projects> report.json
npx vite-node tests/tools/cfb-crosscheck.ts <file.PcbDoc> …      # needs: pip install olefile
python3 -I tests/tools/smoke.py <screenshot-dir>                   # needs: playwright, vite preview on :4173
```

`corpus.ts` loads every SchDoc/PcbDoc/PrjPcb, checks an unmodified save is stream-identical,
compares decoded primitive counts with each storage's Header count, and tallies schematic
record types. What each part of a format's reading rests on is in docs/FORMATS.md, field by
field; an estimate is marked `[est]` in the source where it stands.

## Layout

```
src/
  core/        units (1/10000 mil ints), geometry, commands, keymap + accelerator chains, undo, tool contract
  formats/
    cfb/       MS-CFB reader/writer (v3/v4, DIFAT, mini stream, red-black directory)
    altium/    property bags, record framing, SchDoc, PcbDoc, PrjPcb, PCB field layouts
    synthetic/ demo project + symbol gallery written by our own encoders
    registry   detect / load / save by content
  model/       sch + pcb document models, layers, edit operations (→ undo Changes)
  sim/         SPICE engine (MNA, Newton, devices, transient/AC/DC/TF), netlists, Mixed Sim netlister, results
  render/      Scene display list, WebGL2 instanced SDF renderer (2D canvas fallback), camera, text overlay, viewport
  editors/     Editor base (selection, picking, overlay, tools), SchEditor, PcbEditor, tools
  app/         Preact shell: menus, tabs, panels, inspector, status bar, commands, keymap data
  platform/    file access (FSA API, project + folder access, recent projects, launch queue, drag-drop)
tests/         vitest + tools/ (corpus runner, olefile cross-check, headless smoke test)
docs/          ARCHITECTURE.md (how it is laid out, and its rules), FORMATS.md (what each format's reading rests on), PROVENANCE.md (where everything comes from), STATUS.md and RELEASES.md (the record and the plan), REVIEW-26.200.md (the review before the source went public)
cloudflare/    the Workers behind konium.app/api: ai/ (the Konium AI service), parts/ (part searches), report/ (Report a Bug), vcs/ (version control's store and Git relay), library/ (the world parts library, not in service yet); each has a README with how it is set up and what it guards against
website/       konium.app's website (26.169): site.mjs writes its pages (Home, Features, Formats, Download, What's New, FAQ, Support, and the guides of guides.mjs: the pages for what people search for), indexnow.mjs tells Bing and others of new pages after an upload, build.mjs runs after the app's build (moves the app into dist/app/, stamps its checksum, writes the pages); site.css, img/
dist/          what npm run build makes: the website with the built app in app/ (upload as it is); not kept in the repository
demo/          the example files written by Konium's own encoders (npm run samples)
```

What's New (in the program and at konium.app) gives each public release's SHA-256, so a copy of
`dist/app/index.html` from anywhere can be checked against the one published.

## Setting up from scratch (Windows)

`install-konium.cmd` (double-click, in the build's folder) runs `install-konium.ps1`: it checks Node.js
(22 or newer; offers to install it), signs in to Cloudflare once (a browser window; Wrangler
4.152.0 through `npx.cmd`), checks konium.app is on the account, uploads `site/` to the web host by
SFTP (or copies it to a folder), and deploys the four Workers with their routes: konium-ai
(OpenRouter key), konium-parts (Digi-Key and Mouser keys), konium-report (Email Routing switched on,
the address reports go to verified, an optional GitHub token) and konium-vcs (the R2 bucket). Salts
are made there and sent straight to Cloudflare; keys and the report address are typed into hidden
prompts and kept only as Worker secrets. Then it tries each part from outside. What it can't do for
you (an OpenRouter or distributor account, R2 switched on, the DNS record for the web host) it
explains, opens the page, and waits. Run it again after each build: it deploys the new site and
Workers and keeps what is set (a salt is never replaced). `-Steps ai,check` runs some steps only (`-Steps library` deploys the parts library's Worker, which is not among the default steps while the library is not in service);
`-ReplaceKeys` asks again for the keys.

## Status

What is built, area by area, and what each release added: [docs/STATUS.md](docs/STATUS.md).
