# Where everything in Konium Designer comes from

Konium Designer is written from scratch by its author with the help of AI tools. This note says
what in it comes from elsewhere, and how the things it had to learn from other programs were
learnt. It is here so that anyone can check it against the source.

## Software built in

The packages built into the program are few. Each travels with every copy of the one file, with
its licence (Help › About › Third-Party Software). The build writes that list from what it really
took in (`tests/tools/notices.mjs`), so it is the full one, the packages these bring with them
included; the main ones:

| What | For | Licence |
|---|---|---|
| Preact and Preact Signals | The interface | MIT |
| pdf.js (pdfjs-dist) | Reading datasheets | Apache 2.0 |
| Manifold (manifold-3d) | Solid modelling for the enclosure designer and 3D bodies | Apache 2.0 |
| Clipper (clipper-lib) | Polygon clipping for pours and outputs | Boost Software License 1.0 |
| isomorphic-git (with buffer) | The Git client under version control | MIT |
| earcut | Cutting polygons into triangles for drawing | ISC |
| RBush | Finding what is near a point on a large board | MIT |
| IBM Plex Sans Condensed | The interface's typeface | SIL Open Font License 1.1 |
| Hershey Simplex Roman | The stroke font of plotted text | Public domain glyphs, taken from the hersheytext package (MIT) |

The tools the build and the tests use (Vite, TypeScript, Vitest, Playwright and the rest of
package.json's devDependencies) are not part of the program.

Everything else under `src/` is Konium Designer's own code: the compound-file and ZIP readers and
writers, the inflate and LZ4 code, the STEP reader and tessellator, the Gerber, drill, ODB++ and
IPC-2581 writers, the circuit simulators, the field, thermal and antenna solvers, the autorouter
and the rest.

## File formats

No code was copied from any other program. Formats were learnt in three ways, and the source says
which at each place (the marks `[est]`, `[checked: …]`, `[seen …]` in comments, and
docs/FORMATS.md field by field):

1. **Published standards and the makers' own documentation**: Gerber (Ucamco's specification),
   Excellon, IPC-D-356A, IPC-2581, ODB++, STEP (ISO 10303-21 and AP214), EDIF 2 0 0, SPICE, the
   Specctra design and session files, draw.io's XML, KiCad's own file format documentation, the
   EasyEDA Standard and Pro format documentation, DipTrace's XML exports, PADS ASCII and Eagle's
   XML.
2. **Reading other open programs' sources for the facts of a format** (where a byte is, what a
   value means), then writing Konium Designer's own reader:
   - KiCad's importers for Altium, PADS, Allegro, OrCAD and Eagle files (GPL, version 3 or later);
   - python-altium's description of the schematic format;
   - a public converter for the 1990s' Protel files, and public descriptions of that format;
   - Freerouting's source, for how an autorouter reads a Specctra design and writes its session.
3. **Files saved by the programs themselves**: designs opened and saved in Altium Designer and the
   others, compared byte by byte with what Konium Designer writes. Third-party sample designs were
   read for this on the author's own machine and are not in the repository; the files under
   `demo/` and those the tests make (`src/formats/synthetic/`) are Konium Designer's own.

Where a field's meaning could not be confirmed it is marked as an estimate, and Konium Designer
keeps what it does not understand as it found it, so that a file goes back out with it.

## Altium Designer's menus

Konium Designer is built so that people who use Altium Designer feel at home: its menus, command
names and shortcut keys follow Altium Designer's own. The menu tree (`src/app/menus/ad17.gen.ts`)
was generated from the menu resource files of an installed copy of Altium Designer 17: the
arrangement of the menus, the captions, the shortcut keys and the names by which commands are
known. No program code, icons or other artwork of Altium's is in Konium Designer: every command
is Konium Designer's own implementation and every icon its own drawing.

Altium, Altium Designer and Protel are trademarks of Altium Limited. Konium Designer is not
affiliated with or endorsed by Altium.

## Live Simulation

Design › Simulate › Live Simulation is built to behave like CircuitJS1, Paul Falstad's circuit
simulator (GPL, version 2 or later): circuits that run as they are drawn, with currents shown
moving, and a comparable list of parts. Its behaviour and its parts' parameters were studied; none
of its code, circuit files or texts are in Konium Designer. The parts, the solver and the example
circuits are Konium Designer's own.

## Data that reaches the program while it runs

Parts data comes from the distributors' own services (Digi-Key, Mouser) and from a public copy of
JLCPCB's parts list kept by tscircuit (jlcsearch); datasheets come from wherever they are
published; the AI tools use models offered through OpenRouter or a provider of the user's own.
None of that data is in the repository. The list of every connection is in the program (Help ›
About) and in the User Guide.

## The AI tools that helped write it

The code was written with Claude, by Anthropic. Every change is the author's decision and
responsibility. What keeps it honest is in the repository: the tests (`tests/`), the browser run
that checks the built program (`tests/tools/smoke.py`), and the review made before the source
went public (docs/REVIEW-26.200.md).
