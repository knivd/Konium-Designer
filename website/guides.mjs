/**
 * konium.app's guides: one page for each thing people search for when they have a file and no
 * tool for it ("open a .PcbDoc without Altium Designer", "convert KiCad to Altium"). They name
 * Altium Designer in their titles and headings, as the searches do; the other pages keep their copy.
 *
 * Every claim is Konium Designer's own, from its User Guide (Getting started › Opening projects and
 * files, Importing designs from other tools; Outputs › Exporting to other design tools; Reference ›
 * Files, Sharing files both ways) or the Formats page's table: tests/website169.test.ts holds the
 * converter pages to those. Plain words, no dashes for punctuation.
 *
 * Text is plain, with [label](path) for a link to a page of the site (path from the site's root).
 * Blocks: { h2 }, { p } (with a label in bold before it, if given), { steps: [] }, { list: [] },
 * { table: { head, rows } }, { shot: [picture, alt, caption] }, and on a
 * converter page { roundTrip: [tools] }, the Formats table's rows for those tools.
 */

const RUN = 'Open [konium.app/app](app/) in Chrome or Edge on Windows, macOS or Linux, or [install Konium Designer](download/) first.';
const LOCAL = 'Konium Designer is a program that runs inside your browser, on your own computer. It reads the file from your disk and nothing is uploaded. Once it has been opened or installed it also works with no connection. The [FAQ](faq/#connections) lists everything it can connect to.';

/* ─── Opening files ────────────────────────────────────────────────────────────────── */

const openPcbDoc = {
  slug: 'open-pcbdoc',
  h1: 'Open a .PcbDoc file without Altium Designer',
  short: 'Open a .PcbDoc board',
  description: 'A .PcbDoc file is an Altium Designer board. Konium Designer opens it free in your browser on Windows, macOS or Linux, in 2D and 3D. The file stays on your computer.',
  lead: 'A .PcbDoc file is a circuit board designed in Altium Designer. Konium Designer opens it with no licence and no account, shows it as it looks there, and can edit it and save it back in the same format.',
  img: ['assets/img/pcb-editor.webp', 'A six-layer board open in Konium Designer\'s PCB editor: the Projects panel on the left, the routed board in the middle and the layer tabs along the bottom.', 'A .PcbDoc open in the PCB editor.'],
  blocks: [
    { h2: 'How to open it' },
    { steps: [RUN, 'Drop the .PcbDoc file on the window, or choose File › Open... (Ctrl+O).', 'The board opens in the PCB editor.'] },
    { p: 'To have the board together with its schematics, drop the whole project folder instead, or open its .PrjPcb file.' },
    { h2: 'What you can do with the board' },
    { list: [
      'Look at it layer by layer: the layer tabs along the bottom bring a layer to the front, and Single Layer Mode shows one at a time.',
      'See it in 3D: press 3 for 3D Layout Mode, and 2 to come back.',
      'Measure it: Ctrl+M measures the distance between two points.',
      'With the project open, Tools › Cross Probe goes from a part on the schematic to the same part on the board, and back.',
      'Print it or make a PDF. Printing goes through the browser\'s print dialog, where Save as PDF makes the file.',
      'Make manufacturing files from it: Gerber, Gerber X2, ODB++, IPC-2581, NC drill, pick and place and a bill of materials.',
      'Write the board as STEP or STL, or the design for KiCad, PADS, EasyEDA, EAGLE, DipTrace, OrCAD and Allegro.',
      'Edit it and save it as a .PcbDoc again, binary or ASCII.',
    ] },
    { h2: 'Which .PcbDoc files open' },
    { p: 'Binary and ASCII .PcbDoc files both open. A board saved by an older or a newer version of the format opens with a File Format Change Report, which lists what changed between the versions that matters to the board.' },
    { p: 'Saving rewrites only what you changed. The parts of the file Konium Designer did not change are written back as they were read.' },
    { h2: 'Your board stays on your computer' },
    { p: LOCAL },
  ],
  related: ['open-schdoc', 'altium-viewer', 'altium-to-kicad'],
};

const openSchDoc = {
  slug: 'open-schdoc',
  h1: 'Open a .SchDoc file without Altium Designer',
  short: 'Open a .SchDoc schematic',
  description: 'A .SchDoc file is an Altium Designer schematic. Konium Designer opens it free in your browser on Windows, macOS or Linux. The file stays on your computer.',
  lead: 'A .SchDoc file is a schematic sheet drawn in Altium Designer. Konium Designer opens it with no licence and no account, shows it as it was drawn, and can edit it and save it back in the same format.',
  img: ['assets/img/schematic.webp', 'A schematic sheet open in Konium Designer: a microcontroller with its pins wired to net labels, a debug connector and a flash memory beside it.', 'A .SchDoc open in the schematic editor.'],
  blocks: [
    { h2: 'How to open it' },
    { steps: [RUN, 'Drop the .SchDoc file on the window, or choose File › Open... (Ctrl+O).', 'The sheet opens in the schematic editor.'] },
    { p: 'A design usually has several sheets. To have them all, with the board, drop the whole project folder instead, or open its .PrjPcb file.' },
    { h2: 'What you can do with the sheet' },
    { list: [
      'Read it as it was drawn: parts, wires, buses, net labels, ports, sheet symbols and harnesses.',
      'Print it or make a PDF. Printing goes through the browser\'s print dialog, where Save as PDF makes the file.',
      'With the project open, compile it, run the electrical rules check and get a bill of materials (Reports › Bill of Materials).',
      'With the project open, Tools › Cross Probe goes from a part on the sheet to the same part on the board.',
      'Edit it and save it as a .SchDoc again. Saving loses nothing: records Konium Designer does not draw are kept.',
      'Write it for another tool with File › Export Wizard: KiCad, PADS, EasyEDA, EAGLE, DipTrace, OrCAD or EDIF.',
    ] },
    { h2: 'Which .SchDoc files open' },
    { p: 'Binary and ASCII sheets are both read. A sheet opened from ASCII is saved as ASCII.' },
    { p: 'Older sheets keep their text in the Windows code page of the computer that wrote them, Cyrillic or Central European for example. Konium Designer tells the page from the text itself, and the Messages panel says which it took.' },
    { p: 'Schematic libraries (.SchLib) open in the schematic library editor. Integrated libraries (.IntLib) open read-only.' },
    { h2: 'Your schematic stays on your computer' },
    { p: LOCAL },
  ],
  related: ['open-pcbdoc', 'altium-viewer', 'altium-to-kicad'],
};

const viewer = {
  slug: 'altium-viewer',
  h1: 'A free viewer for Altium Designer files',
  short: 'A free viewer for Altium Designer files',
  title: 'Free viewer for Altium Designer files',
  description: 'Read Altium Designer schematics and check boards in 2D and 3D with no licence. Konium Designer opens them free in your browser, and nothing is uploaded.',
  lead: 'To read a schematic, check a board or see it in 3D you do not need a licence. Konium Designer opens Altium Designer projects, schematics, boards and libraries in your browser, free and with no account. Nothing is uploaded.',
  img: ['assets/img/board-3d.webp', 'A board in Konium Designer\'s 3D Layout Mode, seen at an angle, with its parts as 3D models.', 'A board in 3D Layout Mode.'],
  blocks: [
    { h2: 'What it opens' },
    { table: { head: ['File', 'What it is', 'In Konium Designer'], rows: [
      ['.PrjPcb', 'PCB project', 'Opens with its documents in the Projects panel.'],
      ['.SchDoc', 'Schematic sheet', 'Opens in the schematic editor, binary or ASCII.'],
      ['.PcbDoc', 'Board', 'Opens in the PCB editor, in 2D and 3D, binary or ASCII.'],
      ['.SchLib, .PcbLib', 'Schematic and PCB libraries', 'Open in the library editors.'],
      ['.IntLib', 'Integrated library', 'Opens read-only.'],
      ['.OutJob', 'Output job', 'Opens in the output job editor.'],
      ['.PCBDwf', 'Draftsman document', 'Opens with its views and tables.'],
      ['.BomDoc', 'BOM document', 'Opens with its lines and part choices.'],
    ] } },
    { p: 'Multi-board and harness projects open too. [Formats](formats/) has the whole list.' },
    { h2: 'How to open a project' },
    { steps: [RUN, 'Drop the project\'s folder on the window. Or choose File › Open Project..., pick the .PrjPcb file, and confirm its folder when the browser asks.', 'The project appears in the Projects panel, and its first schematic and its board open.'] },
    { p: 'A single file opens the same way: drop it on the window, or choose File › Open... (Ctrl+O).' },
    { h2: 'Looking at a design' },
    { list: [
      'Layers: the layer tabs along the bottom of the board bring a layer to the front, and Single Layer Mode shows one at a time.',
      '3D: press 3 for 3D Layout Mode, and 2 to come back.',
      'Distances: Ctrl+M measures between two points.',
      'From schematic to board: Tools › Cross Probe finds a part on the other document.',
      'Paper: print, or save a PDF from the browser\'s print dialog.',
      'Parts: Reports › Bill of Materials lists them.',
    ] },
    { h2: 'More than a viewer' },
    { p: 'Konium Designer is a full editor. A reviewer can correct a value, move a part or add a note, and save the file in the same format for whoever sent it. A manufacturer can make Gerber, NC drill and pick and place files from the board. Saving rewrites only what was changed.' },
    { h2: 'Your files stay on your computer' },
    { p: LOCAL },
  ],
  related: ['open-pcbdoc', 'open-schdoc', 'altium-on-mac-and-linux'],
};

const alternative = {
  slug: 'altium-alternative',
  h1: 'A free alternative to Altium Designer',
  short: 'A free alternative to Altium Designer',
  title: 'A free alternative to Altium Designer that works in its files',
  description: 'Free schematic and PCB design software that opens, edits and saves Altium Designer files, with the same menus and shortcut keys. Windows, macOS and Linux.',
  lead: 'Konium Designer is schematic capture and PCB layout software that works in Altium Designer\'s own file formats, with the same menus, panels, dialogs and shortcut keys. It is free and runs on Windows, macOS and Linux. It is independent, and not made by Altium.',
  img: ['assets/img/pcb-editor.webp', 'Konium Designer\'s PCB editor with a six-layer board: the Projects panel on the left, the board in the middle and the layer tabs along the bottom.', 'Konium Designer\'s PCB editor.'],
  blocks: [
    { h2: 'Who it is for' },
    { list: [
      'Engineers who know Altium Designer and need to work where they have no licence: at home, on a second computer, on macOS or Linux.',
      'People who are sent Altium Designer projects by clients or colleagues and need to open, check or change them.',
      'People learning PCB design who expect to work in Altium Designer later.',
    ] },
    { h2: 'What carries over' },
    { list: [
      'Your files. Projects (.PrjPcb), schematics (.SchDoc), boards (.PcbDoc), libraries (.SchLib, .PcbLib), Output Jobs, Draftsman drawings and BOM documents open, are edited and are saved in their own formats. Integrated libraries (.IntLib) are read.',
      'Your work. A project can go back and forth: start or change it in Konium Designer, open it in Altium Designer, and bring it back. Saving rewrites only what you changed.',
      'Your habits. The menus, single-letter shortcuts, default shortcut keys and toolbars follow the same layout, with the panels and dialogs you know.',
    ] },
    { h2: 'What is in it' },
    { list: [
      'Schematic capture with annotation, compile and the electrical rules check.',
      'PCB layout with interactive routing, differential pairs, length tuning, polygon pours, design rules and the design rule check.',
      'Gerber, Gerber X2, ODB++, IPC-2581, NC drill, pick and place, BOM, Smart PDF and Draftsman drawings.',
      '3D with STEP models, SPICE simulation and signal integrity.',
      'Import and export for KiCad, PADS, EasyEDA, OrCAD, Allegro, EAGLE and DipTrace.',
    ] },
    { p: '[Features](features/) describes each part, with pictures.' },
    { h2: 'What is different' },
    { list: [
      'It runs inside a browser, Chrome or Edge, installed as an app or kept as one HTML file. It is not a Windows program.',
      'It is made by one author and is much younger. It does not do everything Altium Designer does. A file it cannot edit yet opens read-only, and it says so.',
      'It works with files on your computer and has its own version control. It does not connect to Altium\'s online services.',
      'Its source code is public, under the GNU General Public License (version 3 or later).',
      'It has AI tools, which are off until you switch them on.',
    ] },
    { h2: 'Beside other free tools' },
    { p: 'KiCad, EasyEDA and others are free too, each with its own file formats and its own way of working. Konium Designer is for people who want to stay in Altium Designer\'s files and habits. It reads and writes those tools\' files as well: see [Formats](formats/).' },
  ],
  related: ['altium-viewer', 'altium-on-mac-and-linux', 'altium-to-kicad'],
};

const macLinux = {
  slug: 'altium-on-mac-and-linux',
  h1: 'Open and edit Altium Designer files on macOS and Linux',
  short: 'Altium Designer files on macOS and Linux',
  title: 'Altium Designer files on macOS and Linux',
  description: 'Altium Designer is a Windows program. Konium Designer opens, edits and saves the same files in Chrome or Edge on macOS and Linux. Free, no virtual machine.',
  lead: 'Altium Designer is a Windows program. Konium Designer runs in Chrome or Edge on macOS and Linux as well as on Windows, and opens, edits and saves the same projects, schematics, boards and libraries. It is free.',
  img: ['assets/img/schematic.webp', 'A schematic sheet open in Konium Designer.', 'The same program on Windows, macOS and Linux.'],
  blocks: [
    { h2: 'How to start' },
    { steps: [
      'Open [konium.app/app](app/) in Chrome or Edge.',
      'To keep it as an app, [install it](download/). It then has a window of its own, starts from the apps menu or the dock, and works offline.',
      'Drop a project folder on the window, or choose File › Open Project... and pick the .PrjPcb file.',
    ] },
    { p: 'There is no virtual machine and no Windows to install: Konium Designer is the same program on all three systems.' },
    { h2: 'Browsers' },
    { p: 'Chrome and Edge give the full experience: Konium Designer opens a project\'s folder, saves files back where they came from and keeps its recent lists. In other browsers you choose a project\'s whole folder to open it, and saving downloads the file.' },
    { h2: 'With no internet' },
    { p: 'Installed, it works offline. It can also be [downloaded as one HTML file](download/#file) that opens in Chrome or Edge with no connection at all.' },
    { h2: 'With colleagues on Windows' },
    { p: 'The files are the same ones, not copies or conversions. A project edited on a Mac or a Linux computer opens in Altium Designer on Windows, and comes back. Saving rewrites only what you changed.' },
    { h2: 'Your files stay on your computer' },
    { p: LOCAL },
  ],
  related: ['altium-viewer', 'altium-alternative', 'open-pcbdoc'],
};

/* ─── Converters ───────────────────────────────────────────────────────────────────── */

const importSteps = (choose, add) => [
  RUN,
  `Choose File › Import Wizard. Under Select Type of Files to Import, choose ${choose}.`,
  add ?? 'Click Add Folder... to take the design\'s folder with everything it uses, or Add Files... for single files.',
  'Under Output Folder, click Browse... to choose where the converted project is saved. Left empty, the project opens unsaved.',
  'Click Import. The project opens, and the import\'s report goes to the Messages panel.',
];
const exportSteps = (type) => [
  RUN,
  'Open the Altium Designer project: drop its folder on the window, or choose File › Open Project... and pick the .PrjPcb file.',
  `Choose File › Export Wizard. Under Select Type of Files to Export, choose ${type}.`,
  'Under What to Export, tick Schematics, PCB and Libraries as wanted.',
  'Under Output Folder, click Browse... to choose a folder, where the files go in a folder named after the project. Left empty, they download as one zip.',
  'Click Export. The Messages panel lists what was written and anything left out.',
];
const RESULT = 'The converted project is in Altium Designer\'s formats: a .PrjPcb project with its .SchDoc schematics and its .PcbDoc board, and .SchLib and .PcbLib libraries beside it. Dropping the files on the window does the same as the wizard.';
const FREE = 'It is free, with no account, and it runs on your own computer, so the design is not uploaded anywhere.';

/**
 * A converter page. tools: the Formats table's rows for it, shown under "There and back";
 * imports: [Import Wizard type, what comes in, the files], and exports: [Export Wizard type, what
 * is written], each as the User Guide's tables have them (Reference › Files).
 */
const converter = ({ slug, name, pic, tools, toFirst = false, description, lead, choose, add, imports, exports, before, after, more = [], related }) => ({
  slug, converter: true, name, tools, imports, exports,
  h1: toFirst ? `Convert Altium to ${name}, and ${name} to Altium` : `Convert ${name} to Altium, and Altium to ${name}`,
  short: toFirst ? `Altium to ${name}, and back` : `${name} to Altium, and back`,
  title: toFirst ? `Convert Altium to ${name} and ${name} to Altium` : `Convert ${name} to Altium and Altium to ${name}`,
  description,
  lead: `${lead} ${FREE}`,
  blocks: [
    ...(toFirst ? ['out', 'in'] : ['in', 'out']).flatMap((dir) => dir === 'in' ? [
      { h2: `${name} to Altium` },
      ...(before ? [{ p: before }] : []),
      { steps: importSteps(choose ?? imports[0][0], add) },
      { shot: [`assets/img/import-${pic}.webp`, `Konium Designer's Import Wizard with ${imports[0][0]} chosen in the list of file types, the note under the list saying what is taken from them, the Files to Import list with its Add Folder... and Add Files... buttons, and the Output Folder field.`, `File › Import Wizard, with ${imports[0][0]} chosen.`], dialog: true },
      ...imports.map(([type, what, files]) => ({ label: imports.length > 1 ? `${type}.` : 'What comes in.', p: `${what} The files: ${files}.` })),
      { p: RESULT },
    ] : [
      { h2: `Altium to ${name}` },
      { steps: exportSteps(exports.map(([type]) => type).join(' or ')) },
      ...exports.map(([type, what]) => ({ label: exports.length > 1 ? `${type}.` : 'What is written.', p: what })),
      ...(after ? [{ p: after }] : []),
    ]),
    { h2: 'There and back' },
    { roundTrip: tools },
    { h2: 'Good to know' },
    { list: ['3D models are linked by name: add their folder in Preferences › PCB Editor › Models.', ...more, 'Other tools convert the same way: [Formats](formats/) lists them all.'] },
  ],
  related,
});

const kicad = converter({
  slug: 'altium-to-kicad', pic: 'kicad', name: 'KiCad', toFirst: true, tools: ['KiCad'],
  description: 'Convert an Altium Designer project to KiCad 8 files, or a KiCad 6 or later project to .PrjPcb, .SchDoc and .PcbDoc files. Free, on your own computer.',
  lead: 'Konium Designer converts both ways. It writes an Altium Designer project as KiCad 8 files, and it reads KiCad 6 and later projects and saves them as .PrjPcb, .SchDoc and .PcbDoc files.',
  add: 'Click Add Folder... and choose the KiCad project\'s folder, so that its sheets come with it.',
  imports: [['KiCad Design Files and Libraries', 'KiCad 6 and later: projects with their schematics and board, symbol libraries, footprint libraries (.pretty folders).', '.kicad_pro, .kicad_sch, .kicad_pcb, .kicad_sym, .kicad_mod']],
  exports: [['KiCad Project', 'KiCad 8 files (KiCad 8 and later open them): the project with its net classes and design rules, the schematics, the board, symbol libraries of the symbols placed and of each schematic library, a footprint library (.pretty) of the board\'s and the PCB libraries\' footprints, the library tables and the 3D models the board uses. Harnesses, directives, images, extruded 3D bodies and dimensions are left out.']],
  more: ['A KiCad project file opened on its own opens the wizard, so that you can add its folder.'],
  related: ['open-pcbdoc', 'eagle-to-altium', 'easyeda-to-altium'],
});

const eagle = converter({
  slug: 'eagle-to-altium', pic: 'eagle', name: 'EAGLE', tools: ['EAGLE'],
  description: 'Convert EAGLE 6 and later schematics, boards and libraries to Altium Designer files, or an Altium Designer project to EAGLE 9 files. Free, on your own computer.',
  lead: 'Konium Designer converts both ways. It reads EAGLE 6 and later schematics, boards and libraries and saves them as .SchDoc, .PcbDoc and library files, and it writes an Altium Designer project as EAGLE 9 files.',
  imports: [['EAGLE Design Files and Libraries', 'EAGLE 6 and later: schematics, boards and libraries. A schematic and a board of one name become one project.', '.sch, .brd, .lbr']],
  exports: [['EAGLE Design Files', 'EAGLE 9 XML: the schematic (.sch) and board (.brd) of one name, and a library (.lbr) of the devices and packages they use. Harnesses, images and directives are left out. Files read from EAGLE and unchanged are written as they were; a board where only parts were moved and nets rerouted keeps the rest of EAGLE\'s file.']],
  more: ['EAGLE 5 and earlier saved binary files, which are not read: save them again in EAGLE 6 or later first.'],
  related: ['altium-to-kicad', 'easyeda-to-altium', 'open-pcbdoc'],
});

const easyeda = converter({
  slug: 'easyeda-to-altium', pic: 'easyeda', name: 'EasyEDA', tools: ['EasyEDA'],
  description: 'Convert EasyEDA Standard and Pro projects to Altium Designer files, or an Altium Designer project to EasyEDA files. Free, on your own computer.',
  lead: 'Konium Designer converts both ways. It reads EasyEDA Standard and Pro projects and libraries and saves them as .SchDoc, .PcbDoc and library files, and it writes an Altium Designer project as EasyEDA Standard source files or as an EasyEDA Pro project.',
  imports: [['EasyEDA Design Files and Libraries', 'EasyEDA Standard schematics, boards and project backups; EasyEDA Pro projects (each board a project), libraries, footprints and symbols.', '.json, .zip, .epro, .epro2, .elibz, .elibz2, .efoo, .esym']],
  exports: [
    ['EasyEDA Source Files', 'EasyEDA Standard source files (.json): the schematics as one schematic, and the board. Harnesses, images and directives are left out.'],
    ['EasyEDA Pro Project', 'An EasyEDA Pro project (.epro): a page for each sheet, the board, and the symbols, footprints and devices they use; every wire named by its net, power ports as net flags, ports as net ports, pours with their poured copper. Harnesses, images and directives are left out.'],
  ],
  after: 'EasyEDA Pro imports the .epro file with File › Import › EasyEDA Professional.',
  related: ['altium-to-kicad', 'eagle-to-altium', 'open-pcbdoc'],
});

const orcad = converter({
  slug: 'orcad-allegro-to-altium', pic: 'orcad', name: 'OrCAD and Allegro', tools: ['OrCAD Capture', 'Allegro and OrCAD PCB Editor'],
  description: 'Convert OrCAD Capture designs and Allegro boards to Altium Designer files, or an Altium Designer project to ASCII files Cadence\'s importers read. Free.',
  lead: 'Konium Designer converts both ways. It reads OrCAD Capture designs and Allegro boards and saves them as .SchDoc and .PcbDoc files, and it writes an Altium Designer project in the ASCII form that Cadence\'s own importers read.',
  choose: 'OrCAD Designs and Libraries Files for Capture designs and libraries, or Allegro Design Files for boards',
  imports: [
    ['OrCAD Designs and Libraries Files', 'OrCAD Capture designs (16.0 and later) with their parts as a schematic library, and Capture libraries. A board of the design\'s name becomes its PCB.', '.dsn, .olb, .brd'],
    ['Allegro Design Files', 'Allegro and OrCAD PCB Editor boards, 16.0 to 19: layers, components, nets, tracks, vias, shapes as polygon pours, keep-outs, drawings and text, constraint sets as rules, and the symbols as a PCB library.', '.brd'],
  ],
  exports: [['OrCAD and Allegro (ASCII Files)', 'The project, its sheet tree, every schematic and the board in ASCII form, for the importers in OrCAD Capture and PCB Editor 17.2 and later. Embedded images and 3D models aren\'t carried.']],
  related: ['pads-to-altium', 'altium-to-kicad', 'open-pcbdoc'],
});

const pads = converter({
  slug: 'pads-to-altium', pic: 'pads', name: 'PADS', tools: ['PADS'],
  description: 'Convert PADS Logic and PADS Layout ASCII files to Altium Designer files, or an Altium Designer project to PADS ASCII files. Free, on your own computer.',
  lead: 'Konium Designer converts both ways. It reads PADS Logic and PADS Layout ASCII files and saves them as .SchDoc and .PcbDoc files, and it writes an Altium Designer project as PADS ASCII files.',
  before: 'Konium Designer reads PADS\'s ASCII exports, not its own design files: export the schematic and the board from PADS as ASCII first.',
  more: ['ASCII files from PADS 2005 to VX are read, and from PowerLogic and PowerPCB before them.'],
  imports: [['PADS ASCII Design Files', 'PADS Logic and PADS Layout ASCII exports: schematics with their part types as a schematic library, boards with their decals as a PCB library. A schematic and a board of the same name become one project.', '.asc, .txt']],
  exports: [['PADS ASCII Design Files', 'PADS Logic (.txt) and PADS Layout (.asc) ASCII files for PADS 9.x and later. Harnesses, images and directives are left out.']],
  related: ['orcad-allegro-to-altium', 'altium-to-kicad', 'open-pcbdoc'],
});

const diptrace = converter({
  slug: 'diptrace-to-altium', pic: 'diptrace', name: 'DipTrace', tools: ['DipTrace'],
  description: 'Convert DipTrace XML files to Altium Designer files, or an Altium Designer project to DipTrace XML files. Free, on your own computer.',
  lead: 'Konium Designer converts both ways. It reads DipTrace\'s XML files and saves them as .SchDoc, .PcbDoc and library files, and it writes an Altium Designer project as DipTrace XML files.',
  before: 'DipTrace\'s own binary files (.dch, .dip, .eli) are not read. Export them as DipTrace XML first: File › Export › DipTrace XML in Schematic Capture and PCB Layout, and Library › Export › DipXML in its library editors.',
  imports: [['DipTrace XML Files', 'DipTrace\'s XML export (File › Export › DipTrace XML; Library › Export › DipXML for libraries): schematics, boards, component and pattern libraries. A schematic and a board of one name become one project; DipTrace\'s binary files are named, not read.', '.dchxml, .dipxml, .elixml, .libxml']],
  exports: [['DipTrace XML Files', 'DipTrace XML: the schematic (.dchxml), the board (.dipxml) and a component library (.elixml) of the components and patterns they use; files read from DipTrace and unchanged are written as they were. Harnesses, images and directives are left out.']],
  related: ['eagle-to-altium', 'altium-to-kicad', 'open-pcbdoc'],
});

export const GUIDES = [openPcbDoc, openSchDoc, viewer, alternative, macLinux, kicad, eagle, easyeda, orcad, pads, diptrace];
