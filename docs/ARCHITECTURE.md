# Architecture

## Principles

1. **The file is the source of truth.** Every editor operates on the raw records it loaded
   (schematic property bags, PCB binary subrecords). Typed objects (`SchObject`, `PcbPrim`) are a
   derived view rebuilt after each change. Untouched records serialise to their original bytes,
   so unknown keys, unknown bytes and records we don't model survive a save.
2. **Native units.** Coordinates are integers in 1/10000 mil — Altium's own PCB unit, and what
   schematic `X*100000 + X_FRAC` reduces to. No float drift on round-trip.
3. **Patch, don't regenerate.** Edited PCB records are written by patching known fields into a
   copy of an existing record from the same file (`encodeTrack(t, template)`), so the unknown
   bytes match whatever that Altium version writes.
4. **Commands by id.** Menus, shortcuts, accelerator chains, toolbars and (later) scripting all go
   through `commands.run(id, scope)`. Menus, toolbars and default shortcuts are Altium Designer 17's,
   generated into `app/menus/ad17.gen.ts` by `tests/tools/rcs/emit.py <AD17 System folder> x <out>`
   from its .rcs resources: `emit.py`'s MAP ties an Altium process launcher to a Konium command;
   unmapped launchers become planned `ad:*` commands (greyed). `gen.py` holds the out-of-scope
   filters. Run-time lists (recent projects, windows, outputs, toolbars) come from
   `registerMenuProvider` in `app/commands.ts`. Scopes nest: `pcblib` takes `pcb` commands,
   `schlib` takes `sch` ones (`scopeIncludes`).
5. **One edit = one transaction.** `undo.transact(label, tx => tx.add(change))`. Changes are
   apply/revert pairs on the raw records.

## Data flow

```
bytes ─► registry.detect ─► readSchDoc / readPcbDoc / readPrjPcb
                               │
                               ▼
               raw records (bags / subrecords)  ◄──── edit Changes (undoable)
                               │ rederive / rebuildPrims
                               ▼
                       typed model objects
                               │ Editor.build(scene, emit)
                               ▼
            Scene (instanced SDF prims, triangles, texts) + HitItems (rbush index)
                               │
                               ▼
                 WebGL2 Renderer + 2D text layer ◄── Camera ◄── Viewport input
save: raw records ─► join framing ─► cfbPut into cloned tree ─► writeCfb
```

## Rendering

One instanced shader draws round-capped segments, arcs and rotated rounded rectangles as signed
distance fields with analytic anti-aliasing — tracks, pads, wires and sheet frames at any zoom
without tessellation. Polygons go through ear-clipping triangles. Text is a 2D-canvas overlay
for now; PCB stroke-font glyphs on the GPU are a later step. Scene coordinates are relative to
the board/sheet origin so float32 keeps precision on large boards. Net names on pads, vias and
tracks are text items flagged `readable` (never mirrored or upside down, whatever the view).

3D Layout Mode (`render/gl3d/`) is a separate WebGL 2 view laid over the 2D one: `boardModel.ts`
builds the board solid (outline, cut-outs, layer-stack thickness), plated barrels and the
ComponentBodies6 extrusions in millimetres; `boardTexture.ts` paints each face (mask, copper
under mask, pad finish, silk, holes cut out) with Canvas 2D; `Viewer3D.ts` draws them with one
lit shader and an orbit camera. It rebuilds after each edit and is view-only.

## Keyboard model

Tool first (Space, Shift+Space, Tab, Backspace, Esc, `*` while placing) → direct shortcuts
(scope-specific before global) → accelerator chains: an unmodified letter opens a menu at the
cursor and the next letter picks (P, W = Place › Wire). Menu letters are the accelerators.
Arrow keys and Enter drive a keyboard cursor (`Viewport.moveCursorBy` / `clickAtCursor`): the
crosshair moves by grid steps and tools get the same pointer events a mouse would give them.

## Interface standards

Every new panel, dialog and row follows these (the project's standing rules, restated on 19 Nov: good function and good looks, fields and buttons in line, icons before buttons, the look of the 2020s and not of the 1990s):

- **Alignment.** Labels in one column and their fields in another; a row keeps its columns when something is added to it (a second control goes into the field's cell, not into the grid). Buttons in a row share a height and a baseline; buttons stacked share a width.
- **Icons before buttons.** A panel's tools are icon buttons (`.ex-icon-btn` with an `<Icon>` from src/app/icons.tsx), each with a tooltip saying what it does and an `aria-label` naming it. Different actions never share an icon: draw a new one. One action in a view may carry a label with its icon: the one the view is for.
- **The look.** In the manner of the enclosure view's side panel and Tools › Parts (src/app/panels/PartsPanel.tsx): a search field that narrows as it is typed in, rather than a field with a Look Up button; a head with a count and its tools; rows with their state as a mark at the end; facts in one aligned column; cards with rounded corners; an empty state that says what goes there and offers the way in. No rows of wrapping text buttons.
- **One style, shared pieces.** Konium's own panels are built from the same pieces, in src/app/panels/kv.tsx: `SectionHead` (a section's name, small and upper-case, with its tools as icons at the right), `Tool` (an icon button named by its `label`), `EmptyState` (what is missing, why, and the button that is the way in) and `AiOff`. Their rules are `.kv-head`, `.kv-tools`, `.btn.kv-cta` (the filled action), `.kp-board` (the document in a card), `.kp-note` (a note with its mark), `.lp-card`, `.lp-group`, `.lp-list` (cards) and the stepper `.br-stages`; the analysis panels take the same look through `.powerpanel`. A new panel uses these and adds no look of its own. The windows that follow the desktop software (its dialogs, its panels) keep that software's look: that is what they are for.
- **Where it stands (26.199).** To the standard: Tools › Parts, the Component Builder's part row and Keep as a Part, the Layout Planner, the Smart Router, Plan, Place and Route, Power, Thermal, EMC, Supply Impedance, Field Solver, Antenna, Calculators, Live Simulation's fields, the enclosure view, Help › Get Konium Designer. Still to do: the Design Adviser's results, Scripts, Live Simulation's controls, the Live Scope, Requirements, Signal Integrity, Storage Manager, Clipboard, Report a Bug, the Component Builder's steps and the other AI windows.
- **Whole sentences.** A sentence is written as one piece with its values put into it (a template string), never glued from pieces of sentences, and a word that follows a number comes from `count` or `noun` (src/core/words.ts), never from an "s" added by hand. Glued pieces can't be put into another language, where the order of the words and the plural differ: the rule is kept in new code so that translating Konium Designer one day is a matter of its sentences and not of its code (decided 21 Nov; older code is brought to it as it is touched).
- **Both themes.** Colours come from the stylesheet's variables; a new view is looked at in the classic and the dark theme before it goes out. The colour icons (`ColourIcon`, `.cicon`) are drawn for a light ground: the dark theme turns them light with one filter in the stylesheet, so a new colour icon needs nothing of its own.
- **Looked at.** A picture of every new view is taken and read before a build is delivered; tests/tools/uiAudit.py runs before a public release.

## What comes from outside is hostile

Konium Designer opens files from strangers, runs scripts people pass round, shows what models
answer and what services send back. The rules every reader, view and service is written to
(docs/REVIEW-26.200.md is where they were last checked across the whole code):

- **A file's value reaches the page as text or as a checked number, never as markup.** Views are
  Preact elements, where a string is text. The few places that write markup themselves (a drawing
  as SVG, the rich-text editors, the pages written for reports and prints) escape every text, make
  every number a number first (`mbsColour`, `mbsLine`), and keep of pasted or stored HTML only what
  a cleaner writes anew from a short list (`src/model/richText.ts`, `src/app/diagram/richtext.ts`).
- **A page the program writes can run nothing.** Reports and prints carry `NO_SCRIPT`
  (`src/core/reportHtml.ts`): opened from the program they have its standing in the browser, so
  they are told to run no script and fetch nothing from outside.
- **A link from a file is a web address or it is no link** (`webLink`, and the cleaners' own
  lists): never an address that runs.
- **A script is given a copy and asks for changes.** It runs in a worker inside a sandboxed frame
  with no network and no access to the page. What comes back is the script's word: it is rebuilt
  from checked values before use (`src/scripting/outcome.ts`), and a change that is not one a
  script can ask for fails the run with nothing changed.
- **A reader fails closed.** What it cannot read it says, in Messages or in an error, and keeps
  as it found it so that the file goes back out whole; it does not guess its way into the model.
  Lists read from JSON are made lists of objects before anything walks them; an archive entry
  that would unpack past what can be held is refused.
- **Every connection asks first** (`src/platform/network.ts`, `mayConnect`), is in the list the
  program shows, and with network activity off the browser itself is told to refuse every kind of
  load. A new connection is added to the list, the guide's table and the website's in the same
  change (tests/network191.test.ts holds them to each other).
- **The services trust nothing a request says of itself.** A body is read through `bodyUpTo`
  (never by its Content-Length); what is passed on to another service is either made here or
  checked to be the program's own request to the letter; an allowance is taken in the step that
  checks it; what a stranger may write into a shared store needs a pass the service gave for that
  very thing; what a service fetches for someone is a named host on the web's own ports, at every
  redirect; what it serves from elsewhere is served as a file that is not to be run.

## Where the next work plugs in

| Feature | Location |
|---|---|
| Pour engine refinements (necks, cutouts, arcs in outlines) | `model/pour.ts` (Clipper); `repour()` in `model/pcbEdit.ts` |
| Gerber / drill / BOM / P&P | new `formats/output/*`, commands `output.*` already registered as planned |
| Net compiler (sch) | new `model/netlist.ts` over `SchDocument.objects` |
| More placement tools | Schematic: a record factory in `model/schPlace.ts`, then `SchPasteTool` (one object at the cursor, `SchPlaceOpts`) or `SchShapeTool` (drawn by points); PCB: `editors/pcb/PcbPlaceTools.ts` (`freshRecord` + `addPrimRecords`). Commands in `app/placeCommands.ts` (Altium `ad:*` ids can be registered there directly); map other launchers in `tests/tools/rcs/emit.py` |
| Move / drag / copy | `SchMoveTool` + `model/schTransform.ts` / `schDrag.ts`; `PcbMoveTool` (`commitMove`) + `formats/altium/pcbTransform.ts` (moves, turns, mirrors and flips records in place, region and 3D-body property blocks included); clipboard in `editors/clipboard.ts` |
| Schematic libraries | `model/schLib.ts`: each symbol is edited as a small schematic (`symbolView` ↔ `viewBags`), `SchLibEditor` (library mode of `SchEditor`, one undo stack whose steps bring their symbol back), `writeSchLibDoc` rewrites only what changed. IEEE symbols and display modes plug into the view the same way |
| BOM | `model/bom.ts` (grouping, columns, CSV / HTML / Simple BOM), `formats/xlsx.ts` (minimal workbook), dialog in `app/dialogs/Bom.tsx` |
| Board shape | `model/pcbBoard.ts` (Board6 shape and origin, rewritten in place), tools in `editors/pcb/BoardShapeTools.ts` |
| Workspace panels | `app/dock/layout.ts` (pure layout model: zones, groups, floating, last places; unit-tested), `dock/store.ts` (signal, persistence, show / hide / toggle, Desktop Layouts), `dock/panels.ts` (ids, titles per editor, categories, first places), `dock/views.tsx` (id → component), `dock/Dock.tsx` (zones, groups, tabs, strips, floating windows, drag-to-dock). A new panel: an entry in `panels.ts`, a case in `views.tsx`, a `view.panel.*` command in `commands.ts` |
| Hierarchy | `model/schHierarchy.ts` (entry positions, which sheet a symbol stands for, the sheet tree, the .REP report; pure, unit-tested); `model/compile.ts` joins an entry to the child's port of the same name; `app/hierarchy.ts` (placing, Up/Down Hierarchy, create / rename / synchronise) with its dialogs in `app/dialogs/Hierarchy.tsx` |
| Schematic properties | `model/schProps.ts` is the one list of Altium's Inspector properties per object kind (read and write as undoable changes); the SCH Inspector, SCH List, Find Similar, the query language (`model/schQuery.ts`) and the generic Properties dialog (`app/dialogs/SchObjectProps.tsx`) all use it. A property whose file key isn't certain is listed read-only. Board objects still show their `PcbEditor.properties()` sections in the PCB Inspector; a `pcbProps.ts` on the same pattern is the next step there |
| 3D view | `render/gl3d/`: STEP model shapes would replace a body's extrusion in `boardModel.ts` (`Models` storage holds the zlib'd STEP text) |
| Geometry kernel (pour, DRC, router) | Rust → WASM behind a worker; scene/model stay in TS |
| Libraries (SchLib/PcbLib) | SchLib: `formats/altium/schlib.ts` reads and writes symbols (binary pins ↔ property form); `SchLibEditor` (display modes, insert / remove symbols); IEEE symbols in `editors/sch/ieee.ts` (names, command ids, glyphs in cell units). PcbLib editor in `editors/pcb/PcbLibEditor.ts` (`insertFootprint`). Library tools: `model/libCheck.ts` (rule checks and reports, pure, unit-tested), commands in `app/libTools.ts`, dialogs in `app/dialogs/LibTools.tsx` and `LibOptions.tsx` |
| Library sync | `model/schUpdate.ts` (`updatedPart`: a placed part rebuilt from its library symbol, placement found by probing the 8 turns / mirrors, parameters keep / add / update / replace; `applyPartUpdates` as one change), `app/libSync.ts` (find symbols in open libraries, Update From Libraries, Update Schematics), dialog in `app/dialogs/UpdateFromLibraries.tsx`. Footprint swaps by ECO: `swapFootprint` in `model/pcbEco.ts` |
| AI tools | `ai/jobs.ts` (each job's prompt, answer limit and answer check — shared with the service's Worker, so it runs only these jobs), `ai/client.ts` (the connections: Konium service, own key, local model; models, usage, estimates), `ai/datasheet.ts` (pdf.js, packed into Konium by `vite.config.ts`'s `virtual:pdfjs`; page text, which pages are drawings, pictures, fingerprint, which pages to send), `ai/footprint.ts` (a package read to a footprint: the datasheet's land pattern or IPC-7351B through `model/ipcFootprint.ts`, and its checks), `ai/snap.ts` (the land pattern's pads measured in a picture of its drawing: solid shapes, the scale from the pitch, rows matched in order), `ai/models.ts` (model families and successors, shared with the Worker). Dialogs: `app/dialogs/AiBuilder.tsx` (with `AiPackage.tsx`, the footprint's review), `app/AiPreferences.tsx`. The service: `cloudflare/ai` (`handler.ts` testable, `store.ts` over SQLite, `index.ts` the Worker and Durable Object). A new job: a `JobSpec` in `jobs.ts`, added to `JOBS` and to the Worker's `COUNTED` (and `CACHEABLE` if its answers are shared) |
| Preferences | `app/settingsSchema.ts` is AD17's page tree (groups, pages, sections, fields); a field without `key` is a greyed placeholder at AD's default. Values live in `core/settings.ts` (`DEFAULTS`, `sanitise`); custom pages (wheel, grid presets, file types, reports, primitives, installed libraries, shortcuts, layer colours) are components in `app/Preferences.tsx`. `tests/settings.test.ts` keeps 'Altium' out of the UI text |
| Schematic display | `render/Scene.ts`: `scene.inOrder` draws polygon fills as triangle primitives among the rest, so record order is z-order (schematics); boards keep fills beneath. `scene.darken()` puts fills in a MIN-blended run (Altium's Transparent: the darker of fill and what lies beneath); the renderer draws a group's runs in order. Special strings: `model/schSpecial.ts` (`specialResolver`, built per scene; the app supplies the document and project context). Embedded pictures: `schStorage` in `formats/altium/schdoc.ts`, decoded asynchronously in `editors/sch/schImages.ts`, drawn on the text layer (`Scene.image`) |
| ERC and Project Options | `model/erc.ts` (Altium's 100 violation kinds in TErrorKind order with groups and defaults, the 17 × 17 Connection Matrix, read / written as the .PrjPcb's [Electrical Rules Check] and [ERC Connection Matrix]); `model/compile.ts` reports each violation through `report(kind, …)` at the project's level and filters by No ERC markers (all, or the kinds / pairs they name) and compile masks; `formats/altium/prjpcb.ts` edits the INI in place (`iniSet`, `addDocument`, `removeDocument`, `reorderDocuments`, project parameters). Dialog: `app/dialogs/ProjectOptions.tsx` |
| Project and schematic tools | `app/projectCommands.ts` (Project, Tools, Reports, Convert, Refactor, Templates, Print, Window commands) over pure models: `model/schParams.ts` (document / part parameters), `model/convertPart.ts` (Part → Ports / Sheet Symbol, Push Part to Sheet), `model/makeLib.ts` (Make Schematic Library, Create Component From Sheet), `model/schTemplate.ts`, `model/smartPaste.ts`, `model/schReports.ts`; dialogs in `app/dialogs/ProjectDialogs.tsx`, `SmartPaste.tsx`, `AvailableLibraries.tsx`, `Print.tsx` |
| Sheet frame, print | `editors/sch/sheetFrame.ts` (border, reference zones, title block geometry; pure); `render/svgExport.ts` turns any Scene into SVG (in mils), `app/print.ts` lays documents on pages for Print, Print Preview and Smart PDF (the browser's print / Save as PDF) |
| Harnesses | `readSchDoc` appends the Additional stream's records to `doc.records` (marked `additional`; owners counted on from FileHeader's objects, or locally, as the file had it) so harnesses edit like anything else; `splitForWrite` puts them back and renumbers owners. `model/schHarness.ts` (geometry, records, definitions), harness bundles in `model/compile.ts` (a second union-find over connectors, signal harnesses, harness ports / sheet entries), commands in `app/harnessCommands.ts` |
| Libraries | Large libraries read lazily: `readSchLib` parses a symbol's COMPONENT record only (`LibSymbol.bags` is a getter over its Data stream; `symbolRecordCount` counts without parsing), `readPcbLib` splits and decodes a footprint on first use, `libEntry` makes its editable document when shown, `footprintCounts` reads pads from records. `PropertyBag` keeps its key index on insert and deletes only present keys; CFB storages index their children (`child`/`addChild`, rename-safe) — both were quadratic. `Grid` draws long lists windowed. `platform/libStore.ts` + `app/installedStore.ts` keep installed libraries in IndexedDB. `app/libEditCommands.ts`: Component Wizard (`model/footprintWizard.ts`, `dialogs/FootprintPreview.tsx`), Set Reference (`PcbLibEditor.setReference`), Model Manager (`model/libModels.ts` on symbol views via `SchLibEditor.editSymbols`), library Parameter Manager, Paste Array (`lineClip`), Library Splitter (`model/libSplit.ts`) |
| Schematic preferences | Behaviour where Preferences › Schematic asks for it: `model/wireTidy.ts` (after a wire goes down: break, optimize, auto sheet entries, cross junctions; parts cutting wires), `model/schLook.ts` (port and entry shapes by direction, cross-over hops, junction status, the AutoFocus set), `SchEditor.startFocus/endFocus`, `unlocked` (Protect Locked), `jumpToSelection` (Auto Zoom), `autoPan` → `Viewport.edgePan`; `UndoStack.limit / groupWindow / guard / editedAt`; `app/compiled.ts` (last compile, violation markers), `app/newSheet.ts` (default sheet size, DISPLAY_UNIT), `app/increment.ts` (auto-increment), `app/deviceSheets.ts` |
| Variants, sync, tiling | `model/variants.ts` ([ProjectVariantN]), `app/variantState.ts` (current variant, crossed-out parts), `app/syncCommands.ts` (back annotation, component links, cross select, Make Integrated Library via `formats/altium/intlib.ts`, Tile), `app/schMiscCommands.ts` (unions, port cross references `model/portRefs.ts`, cross junctions `model/crossJunctions.ts`, NoERC to Suppress, alternate parts, note shapes, device sheets, filter dialogs, pin swapping); tiled panes are `TiledHost` in `app/Chrome.tsx` |
| PCB editing tools (26.022) | `app/pcbEditCommands.ts` (keepouts, Break / Slice Track, Drag Track End, Paste Special / Array / Text, Flip, lasso, spacing, Measure Primitives, 3D bodies, Mechanical Layers, hotspot snapping) and `app/pcbNetCommands.ts` (Un-Route, connections show / hide, physical connection and component selections, explode, pads ↔ vias, cutouts, lock, jump, Board Options, reports) over pure models: `model/pcbTrackEdit.ts` (keepout flag, break, slice, measure, region from a loop, array clips, paste on layer), `model/pcbNets.ts` (routing by net, physical connection via `connectedCopper(…, through)`, component routing), `model/bodies.ts` (body specs and records, Body Manager candidates, convex hull), `explodeComponents` / `explodePolygons` in `model/pcbEdit.ts` (`removeOwners` with a `free` mapping), `setBoardProps` / `setLayerNames` in `model/pcbBoard.ts`. Tools: `editors/pcb/PcbEditTools.ts` (`TwoPointTool`, `DragTrackEndTool`), `placeBodyTool` / `placeCutoutTool` in `PcbPlaceTools.ts`. Object hotspots: `PcbEditor.snapPointer` while a placing tool is active |
| Component placement and netlist (26.023) | `app/pcbComponentCommands.ts` (arrange, swap, Position Component Text, Re-Annotate, Update Free Primitives From Component Pads, Applicable Rules, Netlist Manager, Selection Memory) over `model/pcbPlacement.ts` (text autoposition, positional re-annotation; pure), `netsFromPads` in `model/pcbNets.ts`, `applicableRules` in `model/drc.ts`, `clearAllNets` / `renameNet` / `removeNet` in `model/pcbEdit.ts`. Dialogs: `PcbComponentTools.tsx`, `NetlistManager.tsx`, `SelectionMemory.tsx`, `PcbModel.tsx` (PCB Model, Browse Libraries, Model Map; used by component Properties and Model Manager) |
| Layer stack and 3D bodies (26.024) | `model/pcbStack.ts` (readStack / writeStack over Board6's legacy keys and the LAYER_V8 / V9_STACK entries, add / delete / move, setStack as one undo step) and `app/dialogs/LayerStack.tsx`; `model/bodies.ts` (per-layer bounding rectangles and closed outlines as body candidates, polygon areas, editBody) and the Component Body Manager in `app/dialogs/Body3D.tsx`; footprint models' PCB Library (MODELDATAFILE0) in `model/libModels.ts`, `app/dialogs/PcbModel.tsx`, compile and `footprintFinder` |
| Toolbars | `app/Toolbar.tsx` (command → icon, AD17's descriptions as tooltips from the generated `TIPS`), icons in `app/icons.tsx`; the generator `tests/tools/rcs/emit.py` takes per-editor captions (`SCOPED_CAPTION`), items AD adds from its extensions (`INJECT_AFTER`) and names unnamed dropdowns by their picture |
| View Configurations | `app/dialogs/ViewConfig.tsx` drafts the view keys of `core/settings.ts` plus the editor's hidden layers and single layer mode; mechanical Enable is a Board6 edit (`mechEnabled` / `setMechEnabled` in `model/pcbBoard.ts`: LAYERnMECHENABLED and the V8 / V9 layer entries) |
