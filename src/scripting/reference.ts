/**
 * The Scripting Reference (Help › Scripting Reference; the Scripts panel's Help): everything a
 * script can use, how it runs, and recipes. Tests hold it to the runtime: every member a script
 * can reach is in a table here and nothing else is, and every example runs.
 *
 * Inline marks in text: `code`, **bold**, [words](#section-id).
 */

/** Which objects an API table describes (the tests compare each with the runtime's). */
export type ApiOf = 'globals' | 'board' | 'component' | 'primitive' | 'pad' | 'track' | 'arc' | 'via' | 'text' | 'region' | 'fill' | 'net' | 'output';
/** How a code example is run by the tests: on the demo board, with its parts, a track or a region selected, on an empty footprint. */
export type RunOn = 'board' | 'parts' | 'track' | 'region' | 'footprint';

import type { Block, Section } from '../help/types';
export type { Block, Section };

export const REFERENCE_TITLE = 'Scripting Reference';

export const REFERENCE: Section[] = [
  {
    id: 'scr-intro', title: 'Scripting', blocks: [
      { p: 'A script is a few lines of JavaScript that work on the board or footprint in front of you: placing parts by a rule, renumbering, adding stitching vias, changing widths and nets, or writing a report or a file for a manufacturer. What would take an afternoon of clicking takes a second, and the same script does it again on the next board.' },
      { p: 'Scripts run in the PCB editor and the PCB library editor (**Tools › Scripts...**). They see the board as plain objects (parts, pads, tracks, arcs, vias, texts, regions, fills) in millimetres, and change it only through the methods listed here. Every change a script asks for is made when it ends, as one step: **Edit › Undo** takes the lot back.' },
      { p: 'A script can’t reach anything but the board: no network, no files on your computer, no other documents, nothing of Konium Designer’s own (see [Safety and limits](#scr-limits)). Schematic scripting is planned.' },
    ],
  },
  {
    id: 'scr-start', title: 'Your first script', blocks: [
      { steps: [
        'Open a board (the demo project will do: **Help › Open Demo Project**) and click on it.',
        'Choose **Tools › Scripts...**. The Scripts panel opens on the right.',
        'Click **New**. A new script of your own appears, with a line of comments to start from.',
        'Replace its text with the script below.',
        'Click **Run on the board** (or press **Ctrl+Enter** in the script). What it printed appears under the script; the board shows its changes.',
        'Press **Ctrl+Z** on the board: the changes go, all together.',
      ] },
      { code: `// Lists the parts, then moves C1 2 mm to the right.
for (const c of board.components) print(c.designator, c.footprint, c.x, c.y);
const c1 = board.component('C1');
if (!c1) throw new Error('This board has no C1');
c1.moveBy(2, 0);
print('C1 is now at', c1.x, c1.y);`, run: 'board' },
      { p: '`board` is the board in front, `print()` writes a line under the script, and `throw new Error(...)` stops the script with a message (nothing is changed then). The rest of this reference lists everything else.' },
    ],
  },
  {
    id: 'scr-panel', title: 'The Scripts panel', blocks: [
      { table: [
        ['Script list', 'The project’s scripts (when its folder is open), your scripts, then the examples. Choose one to show it.'],
        ['New', 'A new script of your own.'],
        ['Add to Project', 'Copies the script shown into the project’s Scripts folder (see [Keeping and sharing scripts](#scr-keep)).'],
        ['Import, Export', 'Add a .js file to your scripts; save the script shown as a .js file.'],
        ['Delete', 'Deletes the script shown (one of yours, or the project’s file after asking).'],
        ['Help', 'Opens this reference.'],
        ['Name', 'The script’s name, as the list shows it.'],
        ['The script', 'Its text. Your scripts and the project’s are saved as you type. Changing an example makes it yours first (the example stays as it was). **Tab** indents, **Ctrl+Enter** runs, **F1** opens this reference.'],
        ['Run on the board / Run on <footprint>', 'Runs the script on the board, or the footprint, in front. Greyed when neither is in front.'],
        ['Stop', 'Stops a script that is running (nothing is changed).'],
        ['Write with AI', 'Has an AI model write a script, or change the one shown (see [Writing scripts with AI](#scr-ai)).'],
        ['Output', 'What the script printed, then what it did. An error shows its line: click it to go to that line. Files the script made are listed with **Save...**.'],
      ], head: ['Part', 'What it does'] },
    ],
  },
  {
    id: 'scr-run', title: 'How a script runs', blocks: [
      { list: [
        'When you run a script, Konium Designer takes a copy of the board (or footprint) as it is, and the selection, and gives it to the script.',
        'The script is the body of an `async` function: it may use `await`, and may `return` early. It is modern JavaScript, as the browser runs it.',
        'What a script changes shows at once in its own copy: a part moved has its new `x` and `y`, and its pads have moved with it; a removed track is no longer in `board.tracks`.',
        'When the script ends, Konium Designer makes every change it asked for on the board, as one step for Undo. The output says what was done: “2 parts moved or turned, 14 objects added”.',
        'If the script throws an error, or is stopped, nothing is changed and no files are offered. An error thrown while it runs keeps the lines it printed before.',
        'If the board was changed while the script ran (you edited it, or switched footprint), nothing is changed: run it again.',
        'A script may run for 20 seconds at most; then it is stopped.',
      ] },
    ],
  },
  {
    id: 'scr-units', title: 'Units, coordinates and angles', blocks: [
      { list: [
        'Lengths are in **millimetres**. Positions are measured from the board’s origin (**Edit › Origin › Set**), as the status bar shows them, x to the right and **y upwards**.',
        'Angles are in **degrees, anticlockwise**, 0 pointing along x. Rotations read from 0 up to (not including) 360.',
        'Konium Designer keeps positions to 1/10,000 of a mil (2.54 nm); a script reads them rounded to 10 nm, so a 23.622 mil track reads as 0.6 mm wide.',
        'Use `mil()` and `inch()` to give lengths in other units, `toMil()` and `toInch()` to show them: `mil(10)` is 0.254, `toMil(2.54)` is 100.',
        'A footprint’s positions are from its own origin.',
      ] },
      { api: 'globals', rows: [
        ['mm(v)', 'number', 'Millimetres, as they are (for scripts that spell their units out).'],
        ['mil(v)', 'number', 'Mils to millimetres: `mil(10)` is 0.254.'],
        ['inch(v)', 'number', 'Inches to millimetres: `inch(0.1)` is 2.54.'],
        ['toMil(mm)', 'number', 'Millimetres to mils.'],
        ['toInch(mm)', 'number', 'Millimetres to inches.'],
        ['print(...values)', '', 'Writes a line under the script: its values separated by spaces (numbers to 6 decimal places, objects as JSON).'],
        ['console', '', '`console.log`, `info`, `warn`, `error` and `debug` do what `print` does.'],
        ['board', 'object', 'The board or footprint in front (see [The board](#scr-board)).'],
        ['output', 'object', 'Files the script makes (see [Printing and files](#scr-output)).'],
      ] },
      { code: `print(mil(10), inch(0.1), toMil(2.54), toInch(25.4));`, run: 'board' },
    ],
  },
  {
    id: 'scr-board', title: 'The board', blocks: [
      { p: '`board` is the board (or footprint) the script runs on. Its lists hold what is on it now, without what the script removed and with what it added. Treat them as read-only: change the objects in them through their methods.' },
      { api: 'board', rows: [
        ['kind', 'string', '`board` or `footprint`.'],
        ['name', 'string', 'The board’s file name without .PcbDoc, or the footprint’s name.'],
        ['outline', '{x, y}[]', 'The board shape’s corners (arcs as short lines); empty for a footprint.'],
        ['layers', 'string[]', 'The layer names a script may use (see [Layers](#scr-layers)).'],
        ['nets', 'string[]', 'The board’s net names.'],
        ['components', 'part[]', 'The parts (see [Parts](#scr-parts)); none in a footprint.'],
        ['pads', 'pad[]', 'Every pad: the parts’ and the free ones.'],
        ['tracks', 'track[]', 'Every track (pour copper left out).'],
        ['arcs', 'arc[]', 'Every arc.'],
        ['vias', 'via[]', 'Every via.'],
        ['texts', 'text[]', 'Every text shown (a part’s hidden designator or comment left out).'],
        ['regions', 'region[]', 'Every region (see [What a script doesn’t see](#scr-limits)).'],
        ['fills', 'fill[]', 'Every fill.'],
        ['selected', 'object[]', 'What is selected: a part selected whole is the part, else the primitives selected. It follows `board.select`.'],
        ['component(designator)', 'part or undefined', 'The part with that designator: `board.component(\'U1\')`.'],
        ['net(name)', 'net', 'What is on a net: `{name, pads, tracks, arcs, vias, regions, fills}` (see [Nets](#scr-nets)).'],
        ['addTrack({...})', 'track', 'A new track (see [Adding objects](#scr-add)).'],
        ['addArc({...})', 'arc', 'A new arc.'],
        ['addVia({...})', 'via', 'A new via.'],
        ['addPad({...})', 'pad', 'A new pad.'],
        ['addText({...})', 'text', 'A new text.'],
        ['addRegion({...})', 'region', 'A new region.'],
        ['select(objects)', '', 'What is selected when the script ends: objects (or their ids), one or a list. `board.select([])` selects nothing.'],
      ] },
      { code: `print(board.kind, board.name, board.components.length + ' parts', board.nets.length + ' nets');
print('Tracks:', board.tracks.length, 'vias:', board.vias.length);
print('Board corners:', board.outline.map((p) => '(' + p.x + ', ' + p.y + ')').join(' '));`, run: 'board' },
    ],
  },
  {
    id: 'scr-parts', title: 'Parts', blocks: [
      { p: 'Each part (a component placed on the board) in `board.components`. Its pads, outline and its other primitives move and turn with it, in the script as on the board.' },
      { api: 'component', rows: [
        ['id', 'string', 'The part’s id in this run (`c0`, `c1` …).'],
        ['kind', 'string', '`component`.'],
        ['designator', 'string', 'R1, U3 …'],
        ['comment', 'string', 'Its comment (the value, as 10k or 100nF).'],
        ['footprint', 'string', 'Its footprint’s name.'],
        ['x, y', 'number', 'Where its origin is.'],
        ['rotation', 'number', 'Its rotation in degrees.'],
        ['side', 'string', '`top` or `bottom`.'],
        ['locked', 'boolean', 'Locked parts can’t be moved or turned by a script.'],
        ['pads()', 'pad[]', 'Its pads.'],
        ['moveTo(x, y)', 'part', 'Moves its origin to (x, y).'],
        ['moveBy(dx, dy)', 'part', 'Moves it by dx, dy.'],
        ['rotateTo(degrees)', 'part', 'Turns it to that rotation, about its origin.'],
        ['rotateBy(degrees)', 'part', 'Turns it by that many degrees, anticlockwise.'],
        ['setDesignator(text)', 'part', 'Renames it. **Design › Update Schematics in <project>** then takes the new designators back to the sheets.'],
      ] },
      { p: 'The methods that change a part return it, so they chain: `c.moveTo(10, 20).rotateTo(90)`. A script can’t add or delete parts, or change a part’s footprint or comment: those come from the schematic.' },
      { code: `// Each part's pads, where they are
for (const c of board.components) {
  print(c.designator + ' (' + c.comment + ', ' + c.side + '):', c.pads().map((p) => p.name + '@' + p.x.toFixed(2) + ',' + p.y.toFixed(2)).join(' '));
}`, run: 'board' },
    ],
  },
  {
    id: 'scr-prims', title: 'Primitives', blocks: [
      { p: 'Pads, tracks, arcs, vias, texts, regions and fills are primitives. Each has an id, its kind, and the fields in its table below; all have the same four methods. A primitive that belongs to a part has the part’s designator in `component` (null when it is free).' },
      { api: 'primitive', rows: [
        ['id', 'string', 'Its id in this run (`Tracks6:12`; a new one `new3`).'],
        ['kind', 'string', '`pad`, `track`, `arc`, `via`, `text`, `region` or `fill`.'],
        ['remove()', '', 'Removes it. Not a part’s own primitives.'],
        ['moveBy(dx, dy)', 'itself', 'Moves it. Not a part’s own primitives: move the part.'],
        ['setNet(name)', 'itself', 'Puts it on a net, or on none with `null`. Not texts. A part’s pads too, as Properties does.'],
        ['setWidth(width)', 'itself', 'A track’s or an arc’s width.'],
      ] },
      { p: '**Pads**' },
      { api: 'pad', rows: [
        ['name', 'string', 'Its designator: 1, 2, A3 …'],
        ['component', 'string or null', 'Its part’s designator.'],
        ['net', 'string or null', 'Its net.'],
        ['x, y', 'number', 'Its centre.'],
        ['layer', 'string', '`Top Layer`, `Bottom Layer`, or `Multi-Layer` for a through-hole pad.'],
        ['width, height', 'number', 'Its size (on the top layer of its stack).'],
        ['shape', 'string', '`round`, `rect`, `roundrect` or `octagon`.'],
        ['hole', 'number', 'Its hole’s diameter; 0 for a surface-mount pad.'],
        ['plated', 'boolean', 'Whether its hole is plated.'],
        ['rotation', 'number', 'Its rotation.'],
      ] },
      { p: '**Tracks**' },
      { api: 'track', rows: [
        ['x1, y1, x2, y2', 'number', 'Its two ends.'],
        ['width', 'number', 'Its width.'],
        ['layer', 'string', 'Its layer.'],
        ['net', 'string or null', 'Its net.'],
        ['component', 'string or null', 'Its part’s designator (an outline drawn on the overlay).'],
        ['keepout', 'boolean', 'Whether it is a keepout.'],
      ] },
      { p: '**Arcs**' },
      { api: 'arc', rows: [
        ['x, y', 'number', 'Its centre.'],
        ['radius', 'number', 'Its radius (to the middle of its width).'],
        ['start, end', 'number', 'Its start and end angles, drawn anticlockwise from start to end (0 and 360: a circle).'],
        ['width', 'number', 'Its width.'],
        ['layer', 'string', 'Its layer.'],
        ['net', 'string or null', 'Its net.'],
        ['component', 'string or null', 'Its part’s designator.'],
        ['keepout', 'boolean', 'Whether it is a keepout.'],
      ] },
      { p: '**Vias**' },
      { api: 'via', rows: [
        ['x, y', 'number', 'Its centre.'],
        ['diameter', 'number', 'Its diameter.'],
        ['hole', 'number', 'Its hole’s diameter.'],
        ['net', 'string or null', 'Its net.'],
      ] },
      { p: '**Texts**' },
      { api: 'text', rows: [
        ['x, y', 'number', 'Where it is anchored.'],
        ['text', 'string', 'What it says.'],
        ['height', 'number', 'Its height.'],
        ['layer', 'string', 'Its layer.'],
        ['rotation', 'number', 'Its rotation.'],
        ['component', 'string or null', 'Its part’s designator (a part’s designator or comment).'],
      ] },
      { p: '**Regions**' },
      { api: 'region', rows: [
        ['points', '{x, y}[]', 'Its outline’s corners.'],
        ['layer', 'string', 'Its layer.'],
        ['net', 'string or null', 'Its net.'],
        ['component', 'string or null', 'Its part’s designator.'],
        ['keepout', 'boolean', 'Whether it is a keepout.'],
      ] },
      { p: '**Fills**' },
      { api: 'fill', rows: [
        ['x1, y1, x2, y2', 'number', 'Two opposite corners (before its rotation).'],
        ['rotation', 'number', 'Its rotation about its centre.'],
        ['layer', 'string', 'Its layer.'],
        ['net', 'string or null', 'Its net.'],
        ['component', 'string or null', 'Its part’s designator.'],
        ['keepout', 'boolean', 'Whether it is a keepout.'],
      ] },
      { code: `// Tracks narrower than 0.2 mm, with their nets
for (const t of board.tracks) {
  if (t.width < 0.2) print(t.id, t.layer, t.net ?? '(no net)', t.width);
}`, run: 'board' },
    ],
  },
  {
    id: 'scr-add', title: 'Adding objects', blocks: [
      { p: 'Each add method takes an object of settings and returns the new primitive, which the script can move, change or remove like any other. Settings not given take the defaults below.' },
      { table: [
        ['addTrack', 'x1, y1, x2, y2', 'width 0.254 (10 mil), layer `Top Layer`, net none'],
        ['addArc', 'x, y, radius', 'start 0, end 360 (a circle), width 0.254, layer `Top Layer`, net none'],
        ['addVia', 'x, y', 'diameter 0.6, hole 0.3, net none; from the top layer to the bottom'],
        ['addPad', 'x, y', 'name: the next number after the highest free pad’s; width 1, height as the width, shape `round`, hole 0, layer `Top Layer` (`Multi-Layer` with a hole), rotation 0, net none. A `roundrect` pad’s corner radius 50%'],
        ['addText', 'x, y, text', 'height 1, layer `Top Overlay`, rotation 0; a stroke font, its lines a tenth of its height'],
        ['addRegion', 'points (3 or more, as `{x, y}` or `[x, y]`)', 'layer `Top Layer`, net none'],
      ], head: ['Method', 'Settings it needs', 'Defaults'] },
      { code: `// A GND via at each corner of the board, 3 mm in, and a label
const inset = 3;
const xs = board.outline.map((p) => p.x), ys = board.outline.map((p) => p.y);
const [x0, x1, y0, y1] = [Math.min(...xs) + inset, Math.max(...xs) - inset, Math.min(...ys) + inset, Math.max(...ys) - inset];
for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) board.addVia({ x, y, net: 'GND', diameter: 0.8, hole: 0.4 });
board.addText({ x: x0, y: y0 + 1, text: 'Fixing vias', height: 0.8 });`, run: 'board' },
    ],
  },
  {
    id: 'scr-nets', title: 'Nets', blocks: [
      { p: '`board.nets` lists the board’s nets; `board.net(name)` gives what is on one. A script can put objects on a net (`setNet`) or take them off (`setNet(null)`), but can’t make a net: nets come from the schematic (**Design › Update PCB Document**). Naming a net the board doesn’t have is an error.' },
      { api: 'net', rows: [
        ['name', 'string', 'The net’s name.'],
        ['pads', 'pad[]', 'Its pads.'],
        ['tracks', 'track[]', 'Its tracks (pour copper left out).'],
        ['arcs', 'arc[]', 'Its arcs.'],
        ['vias', 'via[]', 'Its vias.'],
        ['regions', 'region[]', 'Its regions.'],
        ['fills', 'fill[]', 'Its fills.'],
      ] },
      { code: `// Widen the VIN tracks to 0.8 mm
const vin = board.net('VIN');
for (const t of vin.tracks) t.setWidth(0.8);
print(vin.tracks.length, 'tracks widened');`, run: 'board' },
    ],
  },
  {
    id: 'scr-layers', title: 'Layers', blocks: [
      { p: 'Layers are named as on the layer tabs, upper or lower case alike: `Top Layer`, `Mid-Layer 1` …, `Bottom Layer`, `Internal Plane 1` …, `Top Overlay`, `Bottom Overlay`, `Top Paste`, `Bottom Paste`, `Top Solder`, `Bottom Solder`, `Drill Guide`, `Keep-Out Layer`, `Drill Drawing`, `Multi-Layer`, `Mechanical 1` to `Mechanical 16` (and any other layer in use). A layer renamed in the Layer Stack Manager keeps its standard name here. `board.layers` lists them all; naming another is an error.' },
      { code: `// How many tracks and arcs each layer has
const count = {};
for (const t of [...board.tracks, ...board.arcs]) count[t.layer] = (count[t.layer] ?? 0) + 1;
for (const [layer, n] of Object.entries(count)) print(layer + ':', n);`, run: 'board' },
    ],
  },
  {
    id: 'scr-select', title: 'The selection', blocks: [
      { p: '`board.selected` is what was selected when the script started. A part selected whole is listed as the part (not its pads); otherwise the primitives selected are listed. `board.select(...)` sets what is selected when the script ends (and what `board.selected` lists from then on).' },
      { code: `// Select the GND vias
board.select(board.net('GND').vias);
print(board.selected.length, 'selected');`, run: 'board' },
      { code: `// Move the selection 50 mil right: the parts, and the free objects
for (const o of board.selected) {
  if (o.kind === 'component' || !o.component) o.moveBy(mil(50), 0);
}`, run: 'parts' },
    ],
  },
  {
    id: 'scr-output', title: 'Printing and files', blocks: [
      { p: '`print(...)` (or `console.log`) writes a line under the script. A script may also make files: they are listed under the output with **Save...** when it finishes.' },
      { api: 'output', rows: [
        ['csv(name, rows)', '', 'A CSV file: rows are lists of cells. Cells with a comma, quote or line break are quoted; numbers as `print` writes them; lines end CR LF.'],
        ['text(name, text)', '', 'A text file with that text.'],
      ] },
      { code: `// The parts as a CSV, one line each
const rows = [['Designator', 'Comment', 'Footprint', 'X (mm)', 'Y (mm)', 'Rotation', 'Side']];
for (const c of board.components) rows.push([c.designator, c.comment, c.footprint, c.x.toFixed(3), c.y.toFixed(3), c.rotation, c.side]);
output.csv(board.name + '-parts.csv', rows);
output.text(board.name + '-summary.txt', board.components.length + ' parts, ' + board.nets.length + ' nets\\n');`, run: 'board' },
    ],
  },
  {
    id: 'scr-errors', title: 'Errors', blocks: [
      { p: 'When something isn’t right (nothing selected, a net missing), stop the script with a message: `throw new Error(\'Select two parts or more first\')`. The message shows in red; nothing is changed.' },
      { p: 'Mistakes in the script show the same way, with the line they are on (click it to go there): a name misspelt, a method that doesn’t exist, a net or layer the board hasn’t got, a number that isn’t one, a locked part moved, a part’s pad moved on its own.' },
      { code: `const parts = board.selected.filter((o) => o.kind === 'component');
if (parts.length < 2) throw new Error('Select two parts or more first');`, run: 'parts' },
    ],
  },
  {
    id: 'scr-limits', title: 'Safety and limits', blocks: [
      { p: 'A script runs apart from Konium Designer, in a sandbox of its own (a worker in a frame with no origin, under a policy that allows no connections). It gets a copy of the board and hands back the changes it wants; it can’t do anything else:' },
      { list: [
        'no network: `fetch`, XMLHttpRequest and WebSocket fail;',
        'no files on your computer, and none of Konium Designer’s: not its storage, its settings, other documents or the page (`window`, `document`, `localStorage` don’t exist);',
        'no `eval` or `new Function`;',
        '20 seconds at most; 200,000 changes, 5,000 printed lines and 20 files at most.',
      ] },
      { p: '**What a script doesn’t see:** polygon pours and their copper, 3D bodies, a polygon pad’s shape (it follows its pad), a part’s hidden designator or comment, board cutouts and other special regions. Keepouts are there, with `keepout` true.' },
      { p: '**What a script can’t do (yet):** add or delete parts, change footprints, comments, rules, classes or polygons, make nets, or work on schematics.' },
      { p: 'Scripts you didn’t write deserve a read before you run them, as any program does: within the board they can change anything listed here. Undo takes it back.' },
    ],
  },
  {
    id: 'scr-footprints', title: 'Footprints', blocks: [
      { p: 'In the PCB library editor, a script runs on the footprint in front: `board.kind` is `footprint`, its name the footprint’s, positions from the footprint’s origin. A footprint has no parts and no nets; its pads and other primitives are all free to move and remove. `addPad` numbers new pads after the highest.' },
      { code: `// A 1 x 10 header: 2.54 mm pitch, 1.0 mm holes, pad 1 square
const count = 10, pitch = 2.54;
for (let i = 0; i < count; i++) {
  board.addPad({ x: i * pitch, y: 0, width: 1.7, hole: 1.0, shape: i === 0 ? 'rect' : 'round' });
}
for (let i = 0; i < count; i++) {
  board.addTrack({ x1: i * pitch - 1.27, y1: 1.27, x2: i * pitch + 1.27, y2: 1.27, width: 0.15, layer: 'Top Overlay' });
}`, run: 'footprint' },
    ],
  },
  {
    id: 'scr-ai', title: 'Writing scripts with AI', blocks: [
      { p: '**Write with AI** in the Scripts panel has an AI model write a script from a sentence: “put a GND via beside every GND pad”. Tick **Change the script shown** to have it change the script in front instead (“make the radius 15 mm and skip locked parts”).' },
      { list: [
        'It uses the model and the connection chosen in **Preferences › System › AI**; the panel shows what a script will cost (or how many of the day’s job tokens, on the Konium service).',
        'It sends what you asked, the script shown (when changing it), and the names of the board’s layers and nets, its designator prefixes, how many objects of each kind it has and what is selected. It doesn’t send the design itself.',
        'The new script goes into your scripts. Read it through before you run it, as you would anyone’s: Undo takes back what it does.',
      ] },
    ],
  },
  {
    id: 'scr-keep', title: 'Keeping and sharing scripts', blocks: [
      { list: [
        '**Your scripts** are kept in this browser with Konium Designer’s settings. Clearing the site’s data deletes them, so export the ones you need.',
        '**The project’s scripts** are .js files in a **Scripts** folder beside the project file, when the project is open from its folder (**File › Open Project...**). They go with the project: version control commits them, your colleagues see them in their Scripts panel. **Add to Project** copies the script shown there; changes are saved to the file as you type.',
        '**Export** saves the script shown as a .js file; **Import** adds a .js file to your scripts. A script file starts with a `// @name ...` line holding its name.',
      ] },
    ],
  },
  {
    id: 'scr-examples', title: 'The examples', blocks: [
      { table: [
        ['Place selected parts in a circle', 'The selected parts evenly round a circle about their middle, each turned to face outwards. Radius at the top.'],
        ['Renumber designators by position', 'Each prefix on its own (R, C, U …), numbered in rows from the top left.'],
        ['Pick and place file for JLCPCB', 'A CSV in JLCPCB’s columns: Designator, Mid X, Mid Y, Layer, Rotation (the middle of each part’s pads).'],
        ['Via fence along selected tracks', 'GND vias along both sides of the selected tracks, for an RF line, leaving out any too close to another net’s tracks, arcs, pads or vias. Net, pitch, offset, size and clearance at the top.'],
        ['Net report', 'Each net’s pads, vias and routed length, as a CSV.'],
        ['Pads round a circle (footprint)', 'Pads round a circle in a footprint, for a round connector or an LED ring.'],
      ], head: ['Example', 'What it does'] },
      { p: 'Change an example and it becomes your own copy, ready to adjust.' },
    ],
  },
  {
    id: 'scr-recipes', title: 'Recipes', blocks: [
      { p: '**Snap parts to a 50 mil grid**' },
      { code: `const grid = mil(50);
let n = 0;
for (const c of board.components) {
  if (c.locked) continue;
  c.moveTo(Math.round(c.x / grid) * grid, Math.round(c.y / grid) * grid);
  n++;
}
print(n, 'parts snapped');`, run: 'board' },
      { p: '**Remove the bottom layer’s tracks that have no net**' },
      { code: `let n = 0;
for (const t of board.tracks) {
  if (t.layer === 'Bottom Layer' && !t.net && !t.component) { t.remove(); n++; }
}
print(n, 'tracks removed');`, run: 'board' },
      { p: '**Turn every capacitor to 90°**' },
      { code: `for (const c of board.components) if (/^C\\d+$/.test(c.designator) && !c.locked) c.rotateTo(90);`, run: 'board' },
      { p: '**Draw the board shape on Mechanical 1**' },
      { code: `const o = board.outline;
o.forEach((p, i) => {
  const q = o[(i + 1) % o.length];
  board.addTrack({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, width: 0.1, layer: 'Mechanical 1' });
});`, run: 'board' },
      { p: '**A bill of materials grouped by comment and footprint**' },
      { code: `const groups = new Map();
for (const c of board.components) {
  const key = c.comment + '|' + c.footprint;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(c.designator);
}
const rows = [['Comment', 'Footprint', 'Quantity', 'Designators']];
for (const [key, list] of groups) {
  const [comment, footprint] = key.split('|');
  rows.push([comment, footprint, list.length, list.join(', ')]);
}
output.csv(board.name + '-BOM.csv', rows);`, run: 'board' },
      { p: '**Stitch a GND region with vias on a grid**' },
      { code: `// Vias every 2 mm inside the selected region, on GND
const r = board.selected.find((o) => o.kind === 'region');
if (!r) throw new Error('Select a region first');
const inside = (x, y) => {
  let c = false;
  for (let i = 0, j = r.points.length - 1; i < r.points.length; j = i++) {
    const a = r.points[i], b = r.points[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
};
const xs = r.points.map((p) => p.x), ys = r.points.map((p) => p.y);
for (let x = Math.min(...xs) + 1; x < Math.max(...xs); x += 2)
  for (let y = Math.min(...ys) + 1; y < Math.max(...ys); y += 2)
    if (inside(x, y)) board.addVia({ x, y, net: 'GND' });`, run: 'region' },
    ],
  },
  {
    id: 'scr-js', title: 'JavaScript in brief', blocks: [
      { p: 'Enough JavaScript for most scripts. For more, any JavaScript guide will do (MDN’s is thorough).' },
      { table: [
        ['const n = 5; let i = 0;', 'Names for values: `const` can’t be given another value, `let` can.'],
        ['// a comment', 'Ignored to the end of the line.'],
        ['\'text\' + n, `R${n}`', 'Joining text; a template string puts values into text.'],
        ['if (a > b) { ... } else { ... }', 'Choosing. Compare with `===`, `!==`, `<`, `>=`; combine with `&&` (and), `||` (or), `!` (not).'],
        ['for (const c of board.components) { ... }', 'Each item of a list in turn.'],
        ['for (let i = 0; i < 10; i++) { ... }', 'Counting.'],
        ['list.filter((t) => t.width < 0.2)', 'The items for which the test holds.'],
        ['list.map((c) => c.designator)', 'A new list made from each item.'],
        ['list.find((c) => c.comment === \'10k\')', 'The first item for which the test holds (or undefined).'],
        ['list.sort((a, b) => a.x - b.x)', 'Sorting (here by x, smallest first).'],
        ['list.length, list.push(v)', 'How many; adding to a list of your own.'],
        ['x.toFixed(2)', 'A number as text to 2 decimal places.'],
        ['Math.round, Math.min, Math.max, Math.hypot, Math.sin, Math.cos, Math.PI', 'Arithmetic. Angles in Math are radians: `Math.cos(deg * Math.PI / 180)`.'],
        ['/^R\\d+$/.test(c.designator)', 'A pattern: here, R followed by digits.'],
        ['const f = (a, b) => a + b;', 'A function of your own.'],
        ['a ?? b', '`a`, or `b` when `a` is null or undefined.'],
      ], head: ['Write', 'For'], codeCol: true },
    ],
  },
];

/** The names a table's first column documents ("moveTo(x, y)" → moveTo; "x, y" → x and y). */
export function documentedNames(rows: [string, string, string][]): string[] {
  return rows.flatMap(([sig]) => (sig.includes('(') ? [sig.slice(0, sig.indexOf('('))] : sig.split(',').map((x) => x.trim())));
}
