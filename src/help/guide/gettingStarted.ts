import type { Chapter } from '../types';

export const GETTING_STARTED: Chapter = {
  id: 'getting-started',
  title: 'Getting started',
  sections: [
    /* ─── What it is ─────────────────────────────────────────────────────────────────── */
    {
      id: 'gs-welcome',
      title: 'Welcome to Konium Designer',
      blocks: [
        { p: "Konium Designer is a schematic capture and PCB design program that runs on your own computer. You draw schematics, build libraries of symbols and footprints, lay out the board, check it against its design rules and generate the files a manufacturer needs: Gerber, NC drill, bill of materials, pick and place and more." },
        { p: "It works on .PrjPcb projects and their documents, reading and writing the files themselves, so you can open an existing project, change it and save it back in the same formats, or start a new one. It also has tools of its own: an AI component builder, an AI design adviser, requirements, diagrams, an enclosure designer, version control and scripting." },
        { p: "Konium Designer is made for hobbyists, students and makers, for hobby, learning and other non-commercial projects. It is free to use, with no adverts, no accounts and nothing locked away, and your files stay on your computer." },
        {
          head: ['File', 'What it is'],
          table: [
            ['.PrjPcb', 'A PCB project: the list of its documents (by their paths from the project file) and the project\'s options.'],
            ['.SchDoc', 'A schematic sheet.'],
            ['.PcbDoc', 'A PCB.'],
            ['.SchLib', 'A schematic library: component symbols.'],
            ['.PcbLib', 'A PCB library: footprints.'],
            ['.IntLib', 'An integrated library: install it to use its parts and footprints. An Integrated Library project (.LibPkg) makes one.'],
            ['.OutJob', 'An output job: the outputs a project generates, and where they go.'],
            ['.DbLib, .DbLink', 'A database library and a database link: parts kept in a database.'],
            ['.DsnWrk', 'A design workspace: a list of projects opened together.'],
            ['.step, .stp, .stl', '3D models. A STEP file opens in the 3D model editor; an STL opens as a new STEP model.'],
            ['Gerber and NC drill files', 'Fabrication files: they open together in a CAM document.'],
          ],
        },
        { p: "Designs from other tools (KiCad, PADS, EasyEDA, OrCAD, Allegro, EAGLE, DipTrace, IPC-2581 and EDIF files) are converted on the way in: see [Importing designs from other tools](#gs-import)." },
        { note: "Konium Designer is donationware. It works the same whether or not you give, but if it helps with your projects you can chip in: see [Getting help and supporting Konium Designer](#gs-help)." },
        { note: "Konium Designer is provided as is, without warranty of any kind. Check every design, file and output (Gerber, drill, BOM, pick and place and the rest) before it is manufactured or relied on. **Help › About...** has the full statement." },
        { p: "This guide has these chapters:" },
        {
          list: [
            "**Getting started** (this chapter): running Konium Designer, the window, projects, opening and saving, panels and Preferences.",
            "**Schematic capture**: drawing and checking schematics, and compiling a project.",
            "**Libraries and components**: symbols, footprints, the library editors and placing parts.",
            "**PCB design**: the board, its layers, placement, routing and design rules.",
            "[Outputs and manufacturing](#outputs): Gerber and drill files, bills of materials, Output Jobs, prints, the CAM editor and packaging a project.",
            "[More tools](#tools): the Design Adviser, requirements, diagrams, the enclosure designer, multi-board and harness design, simulation, version control and comparing versions.",
            "[Reference](#reference): Preferences, keys, file formats, network connections, where your data is kept, limits, troubleshooting and a glossary.",
            "The [Scripting Reference](#scr-intro) (**Help › Scripting Reference**) documents the scripting interface.",
          ],
        },
      ],
    },

    /* ─── Running and installing ─────────────────────────────────────────────────────── */
    {
      id: 'gs-install',
      title: 'Running Konium Designer: in the browser, as an app, or from a file',
      blocks: [
        { p: "Konium Designer is a web app: the same program runs in a browser tab, as an installed app in a window of its own, or from a single downloaded file. Your projects stay on your computer whichever you choose." },
        {
          head: ['How', 'How to get it', 'Good to know'],
          table: [
            ['In a browser tab', 'Open konium.app/app in your browser (konium.app itself is the website, with the download and What\'s New).', 'The quickest start. This is where you can install Konium Designer or download it.'],
            ['Installed app', 'In a browser tab, the **Install** button at the right of the menu bar (or **Help › Get Konium Designer on This Computer...**), then **Install Konium Designer**, or your browser\'s own Install where the window says.', 'A window of its own without the browser\'s address bar and buttons, started from your Start menu, apps menu or dock. .PrjPcb, .SchDoc, .PcbDoc, library and STEP files can be opened with it from your computer. It works offline and takes new versions when online. Where the browser supports it, the menu bar is the window\'s title bar: drag an empty part of it to move the window.'],
            ['Downloaded file', '**Help › Get Konium Designer on This Computer...**, then the **Download** button.', 'One self-contained .html file, named after the version. Open it from disk in Chrome or Edge: nothing to install, no internet needed. It never changes by itself.'],
          ],
        },
        { img: 'gs-get-konium', alt: "The Get Konium Designer on this computer dialog in Chrome: an Install section describing Konium Designer as an app in a window of its own that works offline, with no Install Konium Designer button (Chrome hadn't offered one) but where Chrome's own Install is: the install icon at the right of the address bar, or the ⋮ menu › Cast, save and share › Install page as app; a Download section with a filled Download Konium-26.199.html button that saves Konium Designer as one file; and a Close button. Each section is a card with its picture at the left.", caption: 'Get Konium Designer on this computer' },
        { p: "To install Konium Designer or download it:" },
        {
          steps: [
            "In a browser tab, click **Install** at the right end of the menu bar. **Help › Get Konium Designer on This Computer...** and **Install or download...** in the Install Konium Designer box on the Home page open the same window.",
            "To install, click **Install Konium Designer**. If the browser hasn't offered Konium Designer an install (or was told not now), the window says where the browser's own Install is: in Chrome, the install icon at the right of the address bar, or the ⋮ menu › Cast, save and share › Install page as app; in Edge, the ⋯ menu › Apps › Install this site as an app; in Safari, File › Add to Dock (on a Mac) or Share › Add to Home Screen.",
            "To keep the single file instead, click the button under **Download** and keep the file wherever you like.",
          ],
        },
        { note: "The **Install** button and the Install Konium Designer box on the Home page show only in a browser tab with a connection. A downloaded file can't be installed itself: there **Help › Get Konium Designer on This Computer...** offers to open konium.app/app, to install from there. In the installed app it says it is installed, and still downloads the single file." },
        { p: "Chrome and Edge on a computer give the full experience: Konium Designer can open a project's folder, save files back where they came from and keep its recent lists. In other browsers you choose a project's whole folder to open it, and saving downloads the file." },
        { p: "**Updates.** How a copy gets new versions depends on how you run it:" },
        {
          list: [
            "A copy at konium.app, or installed from it, looks for a newer version a little after it starts and then every few hours. When there is one, **Update to** and the version appear at the right end of the menu bar, and the Home page says it is out with an **Update now** button. Either one reloads Konium Designer in the new version (if you have unsaved changes, the browser asks first).",
            "A downloaded file never changes. When you are online and a newer version is out, **Update to** and the version appear at the right end of the menu bar, and the Home page says so with a **Get it...** button. Either one opens the Download page on konium.app for the new file.",
            "With updates switched off (untick **Check konium.app for updates and What's New** on the Home page or in **Preferences › System › Network Activity**), a copy installed from konium.app stays on the version it has.",
            "The version you are running is at the top of the Home page and in **Help › About...**.",
          ],
        },
        { note: "Recent releases in What's New on the Home page show the SHA-256 checksum of their single file. Click it to copy it, and compare it with your downloaded file's: on Windows `certutil -hashfile <file> SHA256`, on macOS and Linux `shasum -a 256 <file>`." },
        { note: "Without WebGL 2 (switched off in the browser, or a blocked graphics driver) the editors draw with the 2D canvas instead: the same picture, slower on big boards. The 3D views need WebGL 2." },
      ],
    },

    /* ─── Home ───────────────────────────────────────────────────────────────────────── */
    {
      id: 'gs-home',
      title: 'The Home page',
      blocks: [
        { p: "The Home page is a tab of its own, ahead of the documents. It opens when Konium Designer starts and whenever the last document closes, and it is where you begin: open or create something, reopen recent work, recover unsaved changes and see what is new." },
        { img: 'gs-home-page', alt: "The Konium Designer window with the Home page in front and no documents open, the Projects panel on the left holding only Workspace1.DsnWrk and the Libraries, Requirements, Calculators and Clipboard tabs on the right edge. On the Home page: the name, the files it opens and the version at the top; a Start column with links to open a project, a document, the demo project or the simulation demo and to import or export, and a New column below it; a middle column with the What's New card and the empty Recent projects and Recent documents lists; and a side column with the Get Konium Designer, Support Konium Designer, Found a bug? and Network activity boxes and the top of the Good to know box.", caption: 'The Home page' },
        {
          list: [
            "**View › Home** opens it at any time, and **Help › What's New** opens it at What's New.",
            "Close it with the × on its tab.",
            "To stop it opening by itself, untick **Open the Home page when no documents are open** at its foot (or **Preferences › System › General › Open Home Page if no documents open**).",
          ],
        },
        {
          head: ['Part', 'What it has'],
          table: [
            ['Heading', 'The version you are running and the files Konium Designer opens. Unsaved work from an earlier session is listed here to open or discard (see [Auto Save and recovering unsaved work](#gs-autosave)), and so is a newer version when one is out.'],
            ['Start', '**Open a project...**, **Open a document...**, **Open the demo project**, **Open the simulation demo** (a transistor amplifier ready to simulate), **Import from another tool...** and **Export to another tool...**.'],
            ['New', '**PCB Project...**, **Schematic**, **PCB**, **Schematic library**, **PCB library**, **3D model (STEP)**, **Diagram** and **Requirements**.'],
            ['What\'s New card', 'The latest release, its first picture and **See what\'s new**, which scrolls down to the full log. **New** marks a release you haven\'t seen yet.'],
            ['Last workspace', 'When the browser wants a click before Konium Designer may reopen what you had open last time, the projects and documents are listed with **Reopen Last Workspace** and **Not now**.'],
            ['Recent projects, Recent documents', 'Click one to reopen it. The × beside it takes it off the list; the file itself is untouched.'],
            ['Install Konium Designer', '**Install or download...**: install Konium Designer or save it as one file (only in a browser tab with a connection).'],
            ['Support Konium Designer', '**Chip in...** (see [Getting help and supporting Konium Designer](#gs-help)).'],
            ['Found a bug?', '**Report a bug...**'],
            ['Network activity', '**Allow network activity**, **Check konium.app for updates and What\'s New**, and **What Konium Designer connects to** (see [Privacy and network connections](#gs-privacy)).'],
            ['Good to know', 'A few tips.'],
            ['What\'s New', 'Below the columns: the feature log, latest releases first, with pictures (click one to see it full size). **Earlier releases** shows the older ones, and a release newer than your copy is marked **Newer than this copy**.'],
          ],
        },
        { note: "What's New is read from konium.app. With network activity off, or with updates switched off, it isn't shown." },
      ],
    },

    /* ─── The window ─────────────────────────────────────────────────────────────────── */
    {
      id: 'gs-window',
      title: 'The main window',
      blocks: [
        { p: "The window has the same parts whatever you are working on. The menus, toolbars and panels change with the document in front: a schematic brings the schematic editor's, a PCB the PCB editor's." },
        { img: 'gs-main-window', alt: "The Konium Designer window with the demo project open and Demo.SchDoc in front: the menu bar and toolbars at the top, the Home, Demo.SchDoc and Demo.PcbDoc tabs below them, the Projects panel docked on the left listing Demo.PrjPcb and its documents, the schematic in the middle with Mask Level and Clear under it, the Libraries, Requirements, Calculators and Clipboard tabs on the right edge, and the status bar along the bottom with the cursor position, the grid, a hint, the panel buttons and Shortcuts.", caption: 'The main window with the demo project' },
        {
          head: ['Part', 'What it does'],
          table: [
            ['Menu bar', 'The menus of the editor in front. With no document open they are File, View, Project, Window and Help; a schematic adds Edit, Place, Design, Tools and Reports, and a PCB adds Route as well. The Konium Designer logo at the left opens a menu with **Customise...** and **Preferences...**. After the menus comes the path of the active document in its project.'],
            ['Right end of the menu bar', '**Update to** a newer version (when there is one), **Offline** (when network activity is off: click it for its Preferences page), **Install** (in a browser tab with a connection: see [Running Konium Designer](#gs-install)), the Gydel icon (a link to gydel.games), the tip jar (**Support Konium Designer**) and the gear (**Preferences**).'],
            ['Toolbars', 'Buttons for common commands of the editor in front. Point at a button for its name and its shortcut. **View › Toolbars** switches each toolbar on or off; right-click the menu bar or the toolbars for the same list.'],
            ['Document tabs', 'One tab per open document, plus Home and the help (the User Guide or the Scripting Reference) when they are open. See [Document tabs and windows](#gs-documents).'],
            ['Document area', 'The editor of the document in front. A PCB has its layer tabs along the bottom; a schematic has Mask Level and Clear there.'],
            ['Panels', 'Docked along the edges, floating, or tucked away as tabs on an edge. See [Panels](#gs-panels).'],
            ['Status bar', 'The cursor\'s X and Y, the snap grid, on a board the current layer, how many objects are selected, and a hint for the tool at work. At the right: a count of warnings and errors (click it for the Messages panel), the panel buttons (System, Design Compiler, SCH, PCB and so on) and **Shortcuts**.'],
          ],
        },
        {
          list: [
            "**View › Status Bar** shows or hides the status bar, and **View › Command Status** adds the command at work to it.",
            "**View › Full Screen** (Alt+F5) gives the whole screen to the window.",
            "**Preferences › System › General › Show toolbars** hides every toolbar at once.",
            "The window's title is the active document's name, with `*` when it has unsaved changes. **Preferences › System › View › Show full path in title bar** shows its path in the project instead.",
            "Short notices (a file saved, something that went wrong) appear for a moment at the bottom of the window.",
          ],
        },
      ],
    },

    /* ─── Tabs and windows ───────────────────────────────────────────────────────────── */
    {
      id: 'gs-documents',
      title: 'Document tabs and windows',
      blocks: [
        { p: "Each open document has a tab above the document area. The tab in front is the active document: the menus, toolbars, panels and keys follow it." },
        {
          list: [
            "Click a tab to bring its document to the front. Ctrl+Tab and Ctrl+Shift+Tab step through the tabs where the browser passes these keys on; a browser tab keeps them for its own tabs.",
            "Drag a tab along the strip to change the order.",
            "A `*` after a document's name means it has unsaved changes.",
            "Close a document with the × on its tab, **File › Close** (Ctrl+F4, where the browser passes it on) or a middle-click on its tab. If it has unsaved changes you are asked whether to save them: **Yes** saves, **No** closes it without saving, **Cancel** keeps it open.",
            "**Window › Close All** closes every document, asking about each one with unsaved changes.",
            "The **Window** menu lists the open documents that have a tab: choose one to bring it forward.",
          ],
        },
        { p: "Right-click a tab for these commands:" },
        {
          head: ['Command', 'What it does'],
          table: [
            ['Close Current, Close All Documents', 'Close this document, or every document.'],
            ['Save', 'Save this document.'],
            ['Hide Current, Hide All Documents', 'Take tabs away but keep the documents open, their edits and undo included.'],
            ['Split Vertical, Split Horizontal, Tile All', 'Show the open documents side by side, one above another, or in a grid, each in a pane of its own. A click in a pane makes that document the active one.'],
            ['Merge All', 'Back to one document at a time.'],
            ['Open In New Window', 'Move the document to a window of its own, for a second monitor (see below).'],
          ],
        },
        { p: "**A document in a window of its own.** Drag a tab out of the window and let go (or right-click it, **Open In New Window**): the document moves to a new window, which you can put on another monitor. It is the same Konium Designer, not a second copy: one project, one undo, one clipboard. The new window has its own tabs, menus, toolbars, layer tabs and status bar; the panels stay in the main window and show the document you last clicked in, in either window. Menus, dialogs and popups open in the window you asked for them in. Drag more tabs onto it to group documents there." },
        { p: "With **Tools › Cross Select Mode** on, selecting parts on the sheet selects them on the board in the other window, and the other way round; with **Selection Behaviour** set to **Zoom** (Preferences › System › Navigation), the other window shows them at once. To bring a document back, drag its tab onto the main window, or close its window: its documents come back to the main window as they are, nothing lost." },
        { p: "A hidden document comes back when you open it again from the Projects panel. **Window › More Windows...** lists every open document, hidden ones too: select one and click **Activate**." },
        { p: "**Window › Tile**, **Tile Horizontally** and **Tile Vertically** show the documents in panes from the menu, as the tab commands do; you need two or more documents open. **Window › Arrange All Windows Horizontally** and **Arrange All Windows Vertically** place the Konium Designer windows one above another or side by side. A browser keeps a tab where it is; the installed app's windows can be moved." },
        { note: "If the browser blocks the new window, a notice says so: allow pop-ups for Konium Designer. Reloading the main window closes the document windows (unsaved changes are asked about first, as always)." },
        { p: "**Preferences › System › View › Documents Bar** sets how the tabs behave: **Group documents if need** (documents of a kind share one tab when they don't all fit), **Use equal-width buttons**, **Auto-hide the documents bar** (while there is only one tab), **Multiline documents bar** and **Middle click closes document tab**." },
        { p: "**File › Exit** closes Konium Designer. If documents have unsaved changes, **Confirm Save for Modified Documents** lists them: tick the ones to save (or use **Save All** or **Save None**) and click OK. The installed app then closes; a browser may keep its tab open, so close it from the browser. If you close a browser tab while documents have unsaved changes, the browser asks first." },
      ],
    },

    /* ─── Mouse and keyboard ─────────────────────────────────────────────────────────── */
    {
      id: 'gs-navigate',
      title: 'Mouse and keyboard basics',
      blocks: [
        { p: "The schematic, PCB and library editors share the same ways to move around, pick objects and undo. Their own chapters add the keys particular to each." },
        { p: "**With the mouse:**" },
        {
          keys: [
            ['Wheel', 'Scroll up and down'],
            ['Shift+wheel', 'Scroll left and right'],
            ['Ctrl+wheel', 'Zoom in or out at the cursor (a trackpad pinch does the same)'],
            ['Right-drag', 'Pan the view'],
            ['Middle-drag', 'Pan the view'],
            ['Click', 'Select the object under the cursor (the topmost one)'],
            ['Shift+click', 'Add an object to the selection, or take it out'],
            ['Click on empty space', 'Clear the selection'],
            ['Drag from left to right across empty space', 'Select the objects wholly inside the rectangle'],
            ['Drag from right to left across empty space', 'Select every object the rectangle touches'],
            ['Double-click', 'Open the object\'s properties'],
            ['Right-click', 'The right-click menu for the object under the cursor, or for the document. While a tool is at work, a right-click ends it or steps back.'],
          ],
        },
        { p: "**With the keyboard:**" },
        {
          keys: [
            ['PageUp', 'Zoom in around the cursor'],
            ['PageDown', 'Zoom out around the cursor'],
            ['Home', 'Pan: centre the view on the cursor'],
            ['Ctrl+PageDown', 'Fit all objects in the window'],
            ['End', 'Refresh the view'],
            ['Esc', 'Leave the tool at work; with no tool at work, clear the selection'],
            ['Ctrl+A', 'Select everything'],
            ['Delete', 'Delete the selection'],
            ['Ctrl+Z', 'Undo (Alt+Backspace also undoes)'],
            ['Ctrl+Y', 'Redo (Ctrl+Shift+Z and Ctrl+Backspace also redo)'],
            ['Ctrl+C', 'Copy'],
            ['Ctrl+X', 'Cut'],
            ['Ctrl+V', 'Paste'],
            ['Ctrl+S', 'Save the document'],
            ['Alt+F5', 'Full screen'],
          ],
        },
        {
          list: [
            "**View › Fit Document** fits the document in the window and **View › Zoom Last** goes back to the view before. The View menu has the other zoom commands.",
            "Each document has its own undo history, and a short notice says what was undone or redone. How many steps are kept is set in **Preferences › Schematic › Graphical Editing** (Stack Size) and **Preferences › PCB Editor › General** (Undo/Redo).",
            "While a tool is at work (placing, wiring, routing), Space, Shift+Space, Tab, Backspace and Esc go to the tool first. Tab while placing opens the properties of the object about to go down.",
            "In a dialog, Enter clicks the default button (usually OK) and Esc cancels. Drag a dialog by its title bar to move it.",
          ],
        },
        { p: "To make the plain wheel zoom instead of scroll, open **Preferences › System › Mouse Wheel Configuration** and tick **Wheel** for **Zoom Main Window** (with Shift held, the wheel still scrolls left and right). How far each wheel notch, PageUp and PageDown zoom is the **Zoom step** in **Preferences › System › Navigation**." },
      ],
    },

    /* ─── Shortcuts ──────────────────────────────────────────────────────────────────── */
    {
      id: 'gs-shortcuts',
      title: 'Menus, letter shortcuts and shortcut keys',
      blocks: [
        { p: "Konium Designer can be driven from the keyboard as much as the mouse. There are three kinds of keys:" },
        {
          list: [
            "**Menu letters.** Alt with a menu's underlined letter opens that menu on the menu bar.",
            "**Letter shortcuts.** Press the underlined letters of a menu path one after another, without Alt: in the schematic editor, P then W starts placing a wire (**Place › Wire**). The first letter opens its menu as a popup at the cursor. Untick **Preferences › System › General › Show menus for letter shortcuts** to work without the popup; the letters still work.",
            "**Direct shortcuts.** Many commands have a key of their own, such as Ctrl+S or F11. A menu shows it at the right of the item, and a toolbar button's tooltip shows its shortcut or its letters.",
          ],
        },
        { p: "**Help › Shortcut Keys** lists the keys. The **Shortcuts** button at the right of the status bar, or the ? key, opens it too. On the left are the direct shortcuts of every editor, each with the editors it works in (in brackets, unless it works everywhere), and mouse actions such as Ctrl+click to highlight a net on a PCB; on the right, the letter shortcuts of the editor in front, such as `P, W` for **Place › Wire**." },
        { img: 'gs-shortcut-keys', alt: "The Shortcut Keys window: a note that letters chain through menus and that tools take Space, Shift+Space, Tab, Backspace and Esc first; on the left the direct shortcuts, each with its command and, in brackets, the editors it works in (cam, pcb, pcblib, sch, schlib, simview); on the right the letter shortcuts, such as F, N, J for New › Project..., each with the menu and item it runs; and a Close button.", caption: 'Help › Shortcut Keys' },
        { p: "To change a direct shortcut:" },
        {
          steps: [
            "Open **Preferences › System › Keyboard Shortcuts**. **View › Toolbars › Customise...** and **Customise...** on the Konium Designer logo menu open the same page.",
            "Type part of the command's name in **Filter commands**.",
            "Click the command's shortcut and press the new keys. Backspace removes the shortcut; Esc leaves it as it was.",
            "Click **OK** or **Apply**.",
          ],
        },
        {
          list: [
            "If the keys belonged to another command, they move to this one and a notice says so.",
            "↺ beside a command puts its default shortcut back.",
            "Letter shortcuts always follow the menus: this page sets direct shortcuts only.",
            "Menu items that Konium Designer doesn't have yet are greyed. Choosing one says it is on the roadmap.",
          ],
        },
      ],
    },

    /* ─── Projects ───────────────────────────────────────────────────────────────────── */
    {
      id: 'gs-projects',
      title: 'Projects, workspaces and the Projects panel',
      blocks: [
        { p: "A **project** (.PrjPcb) is a list of documents (schematics, PCBs, libraries, output jobs and so on) and the project's options. It names each document by its path from the project file's folder, so documents can sit beside the project file or in folders below it. When you open a project, Konium Designer reads its documents from that folder, which is why it asks you to confirm the folder (see [Opening projects and files](#gs-open))." },
        { p: "A document opened on its own, outside any project, is a **free document**. Free documents are listed together under **Free Documents** in the Projects panel." },
        { p: "Several projects can be open at once: together they are the **design workspace**, shown on the top line of the Projects panel (Workspace1.DsnWrk until you open or save one). **File › Save Design Workspace** (with no document in front, or on the workspace line's right-click menu) saves the list of open projects as a .DsnWrk file; opening that file later opens its projects again." },
        { p: "The project you last clicked, or opened, is the **active project**: new documents go into it. Right-click a project and choose **Make Active Project** to set it." },
        { img: 'gs-projects-panel', alt: "The Projects panel with the demo project open and Demo.SchDoc selected: the Workspace1.DsnWrk line at the top, Demo.PrjPcb below it, and its folders expanded: Source Documents with Demo.SchDoc, Symbols.SchDoc with Child.SchDoc under it, and Demo.PcbDoc; Libraries with its Schematic Library Documents, PCB Library Documents and Database Libraries folders holding Demo.SchLib, Demo.PcbLib and Demo.DbLib; and Settings with its Output Job Files folder holding Demo.OutJob. Tabs along the foot: Projects, Navigator, SCH Filter and SCH Inspector.", caption: 'The Projects panel' },
        { p: "**The Projects panel** shows the open projects and their documents. Open it with **View › Workspace Panels › System › Projects**, or the **System** button on the status bar. In it:" },
        {
          list: [
            "By default, each project's documents are grouped in folders: **Source Documents** (child sheets under their parent sheets), **Libraries** (with a folder for each kind of library), **Generated** and **Settings** (output job files).",
            "Open documents are shown in bold and changed ones with a dot on their icon; a project with unsaved changes has a `*` after its name.",
            "A document whose file wasn't found, or wasn't loaded because the project's folder wasn't opened, is shown as not loaded; its tooltip says so.",
            "A click on an open document brings it to the front; a double-click opens any document.",
            "Click a folder to open or close it.",
          ],
        },
        { p: "Right-click a line of the tree for its commands:" },
        {
          head: ['Right-click on', 'Commands'],
          table: [
            ['A project', 'Compile and recompile, **Add New to Project** (a schematic, PCB, library or other document), **Add Existing to Project...**, **Save Project**, **Save Project As...**, **Make Active Project**, **Open Project Documents**, **Hide All In Project**, **Close Project Documents**, **Close Project**, **Explore**, **Version Control**, **Variants...**, **Project Packager...** and **Project Options...**.'],
            ['A document', '**Open**, **Hide**, **Close**, **Explore**, **Add Document to Project...** (a free document), **Remove from Project...**, **Save**, **Save As...**, printing and **Document Options...**.'],
            ['A folder', '**Open All**, **Hide All**, **Close All**, **Save All** and **Remove All...** for the documents in it.'],
            ['The workspace line or empty space', '**Compile All Projects**, **Add New Project** (PCB Project, Integrated Library, or **Project...**), **Add Existing Project...**, **Create Projects from Path...**, **Save Design Workspace**, **Open Workspace Documents**, **Save All**, **Explore**, **Home** and **System Preferences...**.'],
          ],
        },
        {
          list: [
            "**Add Existing to Project...** adds documents you choose. A file inside the project's folder is listed by its path from the project file.",
            "**Remove from Project...** takes a document out of the project. The file itself is kept, and an open document stays open as a free document.",
            "**Explore** shows the files in the project's (or document's) folder: open sub-folders, go **Up**, and **Open** a document. It needs a project opened from its folder.",
            "**Create Projects from Path...** asks for a folder and offers a project for each folder of design documents that has none. Save the new projects to keep them.",
            "**Close Project** closes its documents (asking about unsaved ones) and then the project.",
            "**Project › Project Documents...** (Ctrl+Alt+O) lists the active project's documents in a dialog to open one.",
          ],
        },
        { p: "**Preferences › System › Projects Panel** sets what opens with a project (the first schematic and the board, every schematic and board, or nothing), whether closing a changed document asks first, and how the tree looks: open and modified marks, the number of Local History versions beside each document (**Show VCS status**), document numbers, full paths in tooltips, child sheets under their parents (**Show Project Structure**), a sheet's sheet symbols and ports under it (**Show Document Structure**), sorting, grouping, how folders start (expanded or not) and what a single click does." },
      ],
    },

    /* ─── New ────────────────────────────────────────────────────────────────────────── */
    {
      id: 'gs-new',
      title: 'Creating projects and documents',
      blocks: [
        { p: "To create a project:" },
        {
          steps: [
            "Choose **File › New › Project...** (on the Home page, **PCB Project...**).",
            "In **Project Types**, choose **PCB Project** (or **Integrated Library** for a library package, or **Multi-board Design Project**).",
            "Type a **Name**.",
            "Click **Browse Location...** and choose the folder to put the project in.",
            "Leave **Create Project Folder** ticked to put the project in a new folder of its own name inside that folder.",
            "Click **OK**. The project file is saved there at once and the project appears in the Projects panel.",
          ],
        },
        { img: 'gs-new-project', alt: "The New Project dialog: the Project Types list with PCB Project selected above Integrated Library and Multi-board Design Project, the Project Templates list with <Default>, the Name field holding PCB_Project, an empty Location field with a Browse Location... button, Create Project Folder ticked, the note that OK asks for the folder if none is chosen, and the OK and Cancel buttons.", caption: 'File › New › Project...' },
        {
          list: [
            "If you click OK without choosing a location, Konium Designer asks for one.",
            "In a browser that can't write into folders, the project stays in Konium Designer until you save it, and saving the project downloads its file.",
            "**Add New Project** on the Projects panel's right-click menu adds an unsaved PCB project or integrated library straight away: save it to keep it.",
          ],
        },
        { p: "To add documents, choose **File › New** and the kind of document: **Schematic**, **PCB**, **Library › Schematic Library** or **Library › PCB Library**, among others. The first button on the toolbar opens the same list. You can also right-click a project in the Projects panel and use **Add New to Project**." },
        {
          list: [
            "A new document gets a free name (Sheet1.SchDoc, PCB1.PcbDoc, SchLib1.SchLib, PcbLib1.PcbLib and so on) and goes into the active project, or becomes a free document when no project is open.",
            "It is unsaved until you save it. For a project opened from its folder, saving a new document writes it into that folder, beside the project file.",
            "File › New also makes BOM documents, CAM documents, output job files, database libraries and links, simulation files, multi-board schematics and assemblies, diagrams, enclosures, requirements and 3D models (STEP).",
            "To start new schematics from a sheet template, choose one in **Preferences › Data Management › Templates** (**Choose Template...**) and tick **Use templates for new documents**.",
          ],
        },
      ],
    },

    /* ─── Open ───────────────────────────────────────────────────────────────────────── */
    {
      id: 'gs-open',
      title: 'Opening projects and files',
      blocks: [
        {
          head: ['To open', 'Use'],
          table: [
            ['A project', '**File › Open Project...** (Home: **Open a project...**), or drop its folder or its .PrjPcb on the window.'],
            ['Documents or other files', '**File › Open...** (Ctrl+O; Home: **Open a document...**), or drop them on the window.'],
            ['Something you had open before', '**File › Recent Projects**, **File › Recent Documents**, or the lists on the Home page.'],
            ['The demo project', '**Help › Open Demo Project**, or **Open the demo project** on the Home page.'],
            ['A design from another tool', '**File › Import Wizard** (see [Importing designs from other tools](#gs-import)).'],
            ['A project under version control', '**File › Open Project from Version Control...** (see [Version control](#kd-vcs))'],
          ],
        },
        { p: "**Opening a project.** A browser gives a web page only the files you choose, so opening a project takes two choices: the project file, then its folder." },
        {
          steps: [
            "Choose **File › Open Project...** and pick the .PrjPcb file.",
            "The browser then asks you to choose the project's folder, starting in the folder that holds the project file. Confirm it.",
            "The project appears in the Projects panel, and its first schematic and its PCB open.",
          ],
        },
        { img: 'gs-project-folder', alt: "The Open Demo.PrjPcb dialog: it explains that the browser gave Konium Designer only the project file and asks to confirm its folder once, with the buttons Choose project folder..., Open project file only and Cancel.", caption: 'Confirming a project\'s folder' },
        {
          list: [
            "When only the project file arrives (a dropped .PrjPcb, a .PrjPcb chosen with **File › Open...**, or one your computer opened in the installed app), or the browser wants a click before it shows the folder selector, a dialog asks for its folder: **Choose project folder...** loads the documents, **Open project file only** opens the project without them.",
            "In browsers that can't open a single file with access to its folder, **File › Open Project...** asks for the project's folder straight away.",
            "If some of the project's documents live outside its folder, choose a folder that holds the project and all of them. Documents that weren't found are shown as not loaded in the Projects panel and listed as a warning in the Messages panel (the warnings count on the status bar opens it).",
            "Konium Designer looks for documents up to three folders deep, and skips the History, Project Logs, Project Outputs and __Previews folders.",
            "A project that is already open is brought forward rather than opened twice.",
            "What opens with a project is set in **Preferences › System › Projects Panel** (**When a project opens**). **Preferences › System › View › Restore open documents** reopens the documents a project had open when it was last closed.",
          ],
        },
        { p: "**Opening files.** **File › Open...** takes one or several files at once:" },
        {
          list: [
            "Documents open in tabs as free documents. A document that is already open is brought forward.",
            "A .PrjPcb opens its project, and a .DsnWrk the projects of the workspace (after you confirm the folder that holds them).",
            "Other tools' files are imported, as the Import Wizard does.",
            "Gerber and NC drill files open together in one CAM document.",
            "A .zip archive is taken as the files in it (a project sent as one opens with its documents).",
          ],
        },
        { p: "**Drag and drop.** Drop a .PrjPcb, a project folder or documents anywhere in the window. A dropped folder opens the project (or projects) in it." },
        { p: "**A project in a ZIP archive.** A project that was sent to you as a .zip opens as it is: choose it with **File › Open...** or drop it on the window, and the files in it are opened as if you had picked them, the project with its schematics and board. They are read from the archive, so the first Save asks where to keep them." },
        { p: "**Text in other alphabets.** Newer files keep text in Unicode, and it shows as written. Older ones (and newer ones for most text) keep it in the Windows code page of the computer that wrote them: Cyrillic on a Bulgarian or Russian computer, Central European on a Polish or Czech one, and so on. Konium Designer tells the page from the text itself (a word of Cyrillic letters, a Ł or ż) and reads the document in it; the Messages panel says which page it took when it isn't the Western one. Text you change is written back in that page, with a Unicode copy beside it as the desktop software writes one. Pages that use the same bytes for different letters (Turkish and Western, Greek and Cyrillic) are told by the language of the browser; to choose one, set **Preferences › System › General › Text without Unicode** before opening the file. A schematic library's pin names and descriptions beyond that page are read from, and written to, the library's wide pin text, as the desktop software keeps them." },
        { p: "**Text in the Symbol font** shows as Windows draws it: the desktop software keeps Ω as W and µ as m in that font, and Konium Designer draws the Greek and maths characters they stand for." },
        { p: "**Recent projects and documents.** Projects you open from a folder, and documents you open on their own, are kept in **File › Recent Projects** and **File › Recent Documents** (the latest nine) and on the Home page. **All Recent Documents and Projects** at the end of either menu lists them all, with a **Filter**. Reopening one may need you to allow access to its folder or file again, with one click. A project reopened from the list doesn't ask for its folder." },
        { note: "Chrome and Edge keep the recent lists; other browsers can't, and the Home page says so." },
        { p: "**Reopen Last Workspace.** When Konium Designer starts, the projects and documents that were open when it was last closed open again (**Preferences › System › General › Reopen Last Workspace**, on unless you switch it off). If the browser wants a click first, the Home page offers **Reopen Last Workspace**." },
        { p: "**The demo project.** **Help › Open Demo Project** opens Demo.PrjPcb: the schematics Demo.SchDoc, Child.SchDoc and Symbols.SchDoc, the board Demo.PcbDoc, a schematic and a PCB library, an output job and a database library. It is made fresh each time and has no folder: to keep your changes, save it into a folder of your own (see [Saving your work](#gs-save)). **Open the simulation demo** on the Home page opens a transistor amplifier ready for simulation." },
        { note: "To have the Messages panel open by itself whenever a file loads with warnings, tick **Preferences › System › General › Open Messages when a file loads with warnings**." },
      ],
    },

    /* ─── Import ─────────────────────────────────────────────────────────────────────── */
    {
      id: 'gs-import',
      title: 'Importing designs from other tools',
      blocks: [
        { p: "The Import Wizard converts designs and libraries from other PCB tools into Konium Designer projects, schematics, PCBs and libraries." },
        {
          steps: [
            "Choose **File › Import Wizard** (Home: **Import from another tool...**).",
            "Under **Select Type of Files to Import**, choose the kind of files. A note under the list says what is taken from them.",
            "Under **Files to Import**, click **Add Folder...** to take a project's folder with everything it uses, or **Add Files...** for single files. Untick anything you don't want; **Clear** empties the list.",
            "Under **Output Folder**, click **Browse...** to choose where the converted projects are saved, each in a folder of its own with its libraries beside it. Leave it empty to have them open unsaved (**None** clears a folder you chose).",
            "Click **Import**. The projects open, and the import's report goes to the Messages panel.",
          ],
        },
        { img: 'gs-import-wizard', alt: "The Import Wizard dialog: the Select Type of Files to Import list with KiCad Design Files and Libraries selected and its note below, an empty Files to Import list with the Add Folder..., Add Files... and Clear buttons, the empty Output Folder field with a Browse... button, and 0 of 0 to import beside the greyed Import button and Cancel.", caption: 'File › Import Wizard' },
        {
          head: ['Type of files', 'Files'],
          table: [
            ['KiCad Design Files and Libraries', '.kicad_pro, .kicad_sch, .kicad_pcb, .kicad_sym, .kicad_mod (KiCad 6 and later)'],
            ['IPC-2581 Files', '.xml, .cvg'],
            ['PADS ASCII Design Files', '.asc, .txt'],
            ['EasyEDA Design Files and Libraries', '.json, .zip, .epro, .epro2, .elibz, .elibz2, .efoo, .esym'],
            ['OrCAD Designs and Libraries Files', '.dsn, .olb, .brd'],
            ['Allegro Design Files', '.brd'],
            ['EAGLE Design Files and Libraries', '.sch, .brd, .lbr'],
            ['DipTrace XML Files', '.dchxml, .dipxml, .elixml, .libxml (DipTrace\'s XML export)'],
            ['EDIF Files', '.edf, .edn, .edif, .eds (and any name: told by its content)'],
            ['PCB 2.8 ASCII Files', '.pcb (the board text format of the 1990s)'],
            ['Diagram Files', '.drawio, .vsdx'],
          ],
        },
        {
          list: [
            "Opening or dropping such files does the same as the wizard. A KiCad project file on its own opens the wizard, so you can add its folder.",
            "3D models are linked by name: add their folder in **Preferences › PCB Editor › Models**.",
            "**File › Export Wizard** (Home: **Export to another tool...**) goes the other way, writing the open project for another tool (see [Exporting to other design tools](#out-export)).",
          ],
        },
      ],
    },

    /* ─── Save ───────────────────────────────────────────────────────────────────────── */
    {
      id: 'gs-save',
      title: 'Saving your work',
      blocks: [
        {
          head: ['Command', 'What it does'],
          table: [
            ['**File › Save** (Ctrl+S)', 'Saves the document back to its file. A project\'s new document is written into the project\'s folder, beside the project file.'],
            ['**File › Save As...** (Ctrl+Shift+S)', 'Saves the document under another name or in another place. For a schematic or a PCB you first choose the file type, binary or ASCII, then where.'],
            ['**File › Save Copy As...**', 'Saves a copy (named with " - Copy"); the tab keeps its own file.'],
            ['**File › Save All**', 'Saves every changed document and project.'],
            ['**Save Project**', 'On the File menu with no document in front, and on a project\'s right-click menu: saves the project\'s changed documents and its project file.'],
            ['**File › Save Project As...**', 'Saves the project file under another name or in another place.'],
            ['**Save Design Workspace**', 'On the File menu with no document in front, and on the workspace line\'s right-click menu in the Projects panel: saves the list of open projects as a .DsnWrk file.'],
          ],
        },
        {
          list: [
            "Changed documents have a `*` on their tab and a dot on their icon in the Projects panel.",
            "Saving a project's document under another name renames it in the project too. Konium Designer warns you if you save it outside the project's folder.",
            "A project with no folder yet (the demo project, an import without an output folder, a project added unsaved) is saved into a folder you choose: **File › Save All** asks once, writes the project file there and saves its changed documents beside it.",
            "In a browser that can't write files in place, saving downloads the file.",
            "Closing a changed document, or the window, asks whether to save it first (see [Document tabs and windows](#gs-documents)).",
          ],
        },
        { note: "A browser allows one file selector per click. If a save says so, save that document on its own with **File › Save**." },
        { p: "Konium Designer also looks after your work between saves:" },
        {
          list: [
            "**Auto Save** keeps copies of changed documents in the browser, and offers them back after a crash: see [Auto Save and recovering unsaved work](#gs-autosave).",
            "**Local History** keeps the file each save replaces, so you can go back to an earlier version: see [Local History and the Storage Manager](#gs-history).",
            "**Version control** (**Project › Version Control**) keeps a project's versions in a Git repository and shares them with your team (see [Version control](#kd-vcs)).",
          ],
        },
      ],
    },

    /* ─── Auto Save ──────────────────────────────────────────────────────────────────── */
    {
      id: 'gs-autosave',
      title: 'Auto Save and recovering unsaved work',
      blocks: [
        { p: "Auto Save copies every changed document into the browser's storage every 10 minutes by default, and also when the page is hidden (you switch to another tab or minimise the window) or closed. Each document keeps up to five copies by default (Name.~(1).SchDoc, Name.~(2).SchDoc and so on); after that the oldest is reused. Saving or closing a document clears its copies." },
        { p: "**Recovering unsaved work.** If Konium Designer ends while documents have unsaved changes (a crash, a tab closed), the next time it starts a notice says how many documents can be recovered, and the Home page lists them under **Unsaved changes from an earlier session**:" },
        {
          steps: [
            "Open the Home page (**View › Home**) if it isn't in front.",
            "Click **Open** beside a document to open its newest copy, or **Discard** to let it go. With several documents, **Open all** and **Discard all** act on every one.",
            "A recovered document opens with unsaved changes, into its project when that project is open. Save it to keep it: **File › Save As...** puts it back where it was.",
          ],
        },
        { p: "**Settings.** **Preferences › Data Management › Backup**:" },
        {
          head: ['Option', 'What it does'],
          table: [
            ['Auto save every', 'Switches Auto Save on (the default) or off.'],
            ['Minutes', 'How often changed documents are copied: 1 to 120 (10 by default).'],
            ['Number of versions to keep', 'Copies kept per document: 1 to 10 (5 by default).'],
            ['Path: Choose Folder...', 'A folder that gets each copy too, as well as the browser\'s storage (the browser asks for access).'],
            ['Browser storage only: No Folder', 'Stops copying into the folder.'],
          ],
        },
        { img: 'gs-backup-prefs', alt: "The Preferences dialog open at Data Management, Backup: Auto save every ticked, Minutes set to 10, Number of versions to keep set to 5, a Choose Folder... button with an empty Folder chosen field, and a No Folder button.", caption: 'Preferences › Data Management › Backup' },
        {
          list: [
            "The Storage Manager panel lists a document's auto-saved copies when you choose **Show Autobackups** on its right-click menu (see [Local History and the Storage Manager](#gs-history)).",
            "**Preferences › Data Management › Local History › Add autosaved documents to history** keeps each auto-saved copy in Local History as well.",
          ],
        },
        { note: "Auto Save copies are a safety net kept in this browser, not a replacement for saving your files." },
      ],
    },

    /* ─── Local History ──────────────────────────────────────────────────────────────── */
    {
      id: 'gs-history',
      title: 'Local History and the Storage Manager',
      blocks: [
        { p: "Each time you save a document, Konium Designer first keeps the file the save replaces. These kept files are the document's **Local History**: you can open, compare or go back to any of them." },
        {
          list: [
            "For a project opened from its folder, versions are kept as zip files (Name.~(1).SchDoc.Zip and so on) in a **History** folder beside the project file, following the project's sub-folders.",
            "Otherwise they are kept in the browser: for a project opened without access to its folder, for a document outside the project's folder, and when **Use global repository** is on.",
            "Versions older than the days kept go when a new version is written. Labelled versions stay.",
          ],
        },
        {
          head: ['Preferences › Data Management › Local History', 'What it does'],
          table: [
            ['Number of days to keep documents in history', '1 to 10 days (7 by default).'],
            ['Add autosaved documents to history', 'Auto-saved copies become versions too, named Version n [AutoSave ...].'],
            ['Use global repository', 'Keeps every version in the browser rather than in History folders.'],
          ],
        },
        { p: "**The Storage Manager panel** (**View › Workspace Panels › System › Storage Manager**) shows the active project's files, or the open free documents, and the history of the one you select." },
        { img: 'gs-storage-manager', alt: "The Storage Manager panel with the demo project: the Project Files table listing Demo.PrjPcb and its documents with their sizes, kinds and status (Demo.SchDoc selected and Modified, Demo.PcbDoc Open), and below it the Local History of Demo.SchDoc with the lines Document, Last Saved Contents, Version 2 and Version 1, each version labelled AutoSave with its date and kept in the browser.", caption: 'The Storage Manager panel' },
        {
          list: [
            "**Project Files** lists each file with its Size, Kind, Date Modified and Status (Open or Modified). Click a file to see its history.",
            "**Local History** lists, newest first: **Document** (as it is open now), **Last Saved Contents** (the file), then each **Version n**, with its date, size and where it is kept (History folder or Browser).",
            "Double-click a version to open it as a document of its own, such as [Version 3] Demo.SchDoc. Double-click **Document** to bring the open document forward.",
            "Ctrl+click or Shift+click to pick more than one line.",
          ],
        },
        { p: "Right-click a line of the Local History for these commands:" },
        {
          head: ['Command', 'What it does'],
          table: [
            ['Open', 'Opens that version as a document of its own.'],
            ['Compare', 'For schematics and PCBs: one line against the document as it is now, or two lines side by side, the older on the left.'],
            ['Apply Label...', 'Names a version (up to 64 characters). Labelled versions are never removed for their age.'],
            ['Revert to', 'Makes the file that version. The file it replaces is kept in history first, so a revert can itself be reverted; unsaved changes are kept as a version too. A document with no file becomes that version as unsaved changes.'],
            ['Delete', 'Removes the versions picked.'],
            ['Purge History...', 'Removes all versions, or those older than a number of days, keeping at least the latest few and, unless you tick **Include labelled versions**, the labelled ones.'],
            ['Show Autobackups', 'Adds the document\'s auto-saved copies to the list.'],
            ['Refresh', 'Reads the files and history again.'],
          ],
        },
        { p: "**Preferences › System › Projects Panel › Show VCS status** shows how many Local History versions each document has (such as ⟲3) in the Projects panel, for projects not under version control." },
      ],
    },

    /* ─── Panels ─────────────────────────────────────────────────────────────────────── */
    {
      id: 'gs-panels',
      title: 'Panels',
      blocks: [
        { p: "Panels sit around the document: the Projects tree, Messages, the libraries, the selected objects' properties and more. They can be docked along any edge, grouped as tabs, floated over the window, or tucked away as tabs on an edge." },
        { p: "**At first.** Projects, the Storage Manager and the SCH or PCB Inspector are docked on the left, as tabs of one group. Libraries, Requirements, Calculators and the Clipboard are tucked away behind tabs on the right edge: point at a tab and its panel slides out over the document. Every other panel opens when you ask for it, and a library's own panel when you open a library." },
        {
          head: ['Panel', 'What it is for'],
          table: [
            ['Projects', 'The open projects and their documents (see [Projects, workspaces and the Projects panel](#gs-projects)).'],
            ['Messages', 'Warnings and errors from opening files, compiling and checks.'],
            ['Libraries', 'Parts and footprints from the project\'s, open and installed libraries.'],
            ['Storage Manager', 'The project\'s files and their Local History (see [Local History and the Storage Manager](#gs-history)).'],
            ['File Inspector', 'The streams inside a .SchDoc, .PcbDoc, .SchLib or .PcbLib file.'],
            ['Navigator', 'Browsing a compiled project.'],
            ['Requirements, Calculators, Clipboard', 'The project\'s requirements; the everyday sums and the board\'s; what was cut or copied lately.'],
            ['SCH or PCB Inspector, Filter, List', 'The selected objects\' properties (F11), finding objects with a query (F12), and objects as a table (Shift+F12).'],
            ['SCH Library, PCB Library', 'The components of the library in front, in a library editor.'],
            ['PCB, PCB Rules And Violations', 'The board\'s nets, components and other objects; its rules and the violations found.'],
          ],
        },
        { p: "**Showing and hiding panels.**" },
        {
          list: [
            "**View › Workspace Panels** lists the panels by kind (System, Design Compiler, SCH, PCB and so on), with a tick beside the open ones. Choose a panel to show it, or to hide it if it is showing.",
            "The panel buttons at the right of the status bar open the same lists.",
            "In the schematic and PCB editors, F11, F12 and Shift+F12 show or hide the Inspector, the Filter and the List.",
            "A panel opens where it was last, or in its usual place the first time.",
            "Panels that belong to one editor, such as the SCH Inspector, show only while a document of that kind is in front, and come back with it.",
          ],
        },
        { p: "**The title bar.** A panel group's title bar shows the panel in front and three buttons: the down arrow (the panel menu: the group's panels, the one in front ticked, then a Close item for it), the pin (**Auto-hide**, or **Dock (pin open)** on a tucked-away panel; a floating group has no pin) and **×** (**Close**). When a group holds several panels, their tabs run along its foot: click one to bring it forward." },
        { img: 'gs-panel-group', alt: "The panels docked on the left of the window with Demo.PcbDoc in front and selected in the tree: the Projects panel's title bar with its menu, pin and close buttons, the project tree below it, and tabs along the foot for Projects, Storage Manager and PCB Inspector.", caption: 'A docked panel group' },
        { p: "**Moving panels.** Drag a title bar to move the whole group, or a tab to move one panel. An outline shows where it will go:" },
        {
          list: [
            "Onto another group's title bar or tabs: it joins that group as a tab. Dropped between two tabs, it goes there; this also reorders a group's tabs.",
            "Near an edge of the window: it docks along that edge.",
            "Over the top or bottom part of a docked group (the left or right part on the top and bottom edges): it shares that space with the group.",
            "Anywhere else, or with Ctrl held: it floats.",
            "Esc while dragging leaves everything where it was.",
          ],
        },
        {
          list: [
            "Double-click a title bar to float a docked group, or to dock a floating one where it was.",
            "Drag the inner edge of a docked edge to resize it (double-click the edge to reset its size), the bar between two stacked groups to share the space, and the edges or corners of a floating panel to resize it.",
            "**Pinning.** Click the pin to tuck a docked group away: its panels become tabs on its edge, and pointing at a tab slides the panel out over the document. It slides back when the cursor leaves it, or when you click elsewhere. Click the pin again to dock it open.",
            "Right-click a title bar or tab for a Close item for that panel and **Allow Dock** (**Horizontally** for the top and bottom edges, **Vertically** for the left and right); untick one to stop the panel docking there.",
            "F4 hides or shows every floating panel; Shift+F5 moves between the document and the top floating panel.",
          ],
        },
        { p: "**Desktop Layouts.** **View › Desktop Layouts** has **Default** (the panels as they are at first: Projects, the Storage Manager and the Inspector on the left; Libraries, Requirements, Calculators and the Clipboard behind tabs on the right edge), **Startup** (the panels as they were when this session started), **Load Layout...** and **Save Layout...** (to keep an arrangement in a file)." },
        {
          head: ['Preferences › System › View', 'What it does'],
          table: [
            ['Autosave desktop', 'Keeps the panels\' layout from one session to the next; off, changes to the layout aren\'t kept, and the next session starts with the layout kept last.'],
            ['Remember window for each document kind', 'Each kind of document (schematic, board, library and so on) keeps its own panel layout, put back when one comes to the front.'],
            ['Popup Panels', 'How long the cursor rests on a tab before a tucked-away panel slides out (**Popup delay**), how long before it slides back (**Hide delay**), and its animation.'],
            ['Hide floating panels on focus change', 'Floating panels hide while another window is in use.'],
          ],
        },
        { p: "**Preferences › System › Transparency** makes floating panels see-through while a tool is at work, or more see-through the nearer the cursor is." },
      ],
    },

    /* ─── Preferences ────────────────────────────────────────────────────────────────── */
    {
      id: 'gs-preferences',
      title: 'Preferences',
      blocks: [
        { p: "Preferences hold the settings that apply to all your work: how the window, editors and files behave. Open them with the gear at the right end of the menu bar, **Preferences...** on the Konium Designer logo menu, **Tools › Preferences...** in the PCB editor or **Tools › Schematic Preferences...** in the schematic editor." },
        { img: 'gs-preferences', alt: "The Preferences dialog open at System, General: on the left a search box above the page tree, showing the System and Data Management groups and the start of the Schematic group, the General page on the right with its Startup, General, Default Locations, Messages and Localisation sections, and the Set To Defaults, Save..., Load..., OK, Cancel and Apply buttons along the bottom.", caption: 'Preferences' },
        {
          list: [
            "The tree on the left has five groups: **System**, **Data Management**, **Schematic**, **PCB Editor** and **Text Editors**. Click a page to show it. Preferences opens at the page you used last.",
            "**Search preferences...** above the tree finds options on every page by their names and descriptions; each result says which page it is on.",
            "A dot beside a page means it has changes not applied yet. **OK** applies them and closes, **Apply** applies them and stays open, **Cancel** discards them.",
            "↺ beside an option puts its default back. **Set To Defaults** resets the page, its whole group, or **All**.",
            "**Save...** writes all your preferences, keyboard shortcuts included, to a file, and **Load...** reads such a file: use them to move your preferences to another browser or computer. Preferences are kept in this browser.",
            "A greyed option is either not in Konium Designer yet or waits on a switch above it; point at it to see which.",
          ],
        },
        {
          head: ['Page', 'What it sets'],
          table: [
            ['System › General', 'What happens at the start (**Reopen Last Workspace**, **Open Home Page if no documents open**, **Show startup screen**), the **UI Theme** (light or dark), **Show toolbars**, **Show menus for letter shortcuts**, where file selectors start (**Document Path**, **Library Path**), when the Messages panel opens, **Use localised resources** for dates, times and numbers, and **Text without Unicode** (below).'],
            ['System › View', 'The desktop (**Autosave desktop**, **Restore open documents**), **Popup Panels**, **Smooth edges (anti-aliasing)**, the window title, panel behaviour and the **Documents Bar**.'],
            ['System › Transparency', 'See-through floating panels.'],
            ['System › Navigation', 'What cross-probing does (zoom, dim, mask, select, connection graph), the **Zoom step**, and **Cross Select Mode**.'],
            ['System › Projects Panel', 'What opens with a project, asking before closing a changed document, and how the Projects panel tree looks.'],
            ['System › File Types', 'The files Konium Designer opens when your computer hands them over.'],
            ['System › Mouse Wheel Configuration', 'Whether the plain wheel scrolls or zooms.'],
            ['System › Network Activity', 'The network switches and every connection Konium Designer makes (see [Privacy and network connections](#gs-privacy)).'],
            ['System › Keyboard Shortcuts', 'Your own shortcuts (see [Menus, letter shortcuts and shortcut keys](#gs-shortcuts)).'],
            ['System › AI', 'How the AI tools connect: off until you choose a way.'],
            ['Data Management', '**Installed Libraries**, where libraries are searched (**File-based Libraries**), sheet **Templates**, **Backup** (see [Auto Save](#gs-autosave)), **Version Control** and **Local History** (see [Local History](#gs-history)).'],
            ['Schematic, PCB Editor, Text Editors', 'How each editor behaves and looks. The chapters Schematic capture and PCB design describe the options that matter there.'],
          ],
        },
        { note: "Most options have a short description under their name: read it, or search for a word in it, to find the option you want." },
      ],
    },

    /* ─── Privacy ────────────────────────────────────────────────────────────────────── */
    {
      id: 'gs-privacy',
      title: 'Privacy and network connections',
      blocks: [
        { p: "Your files stay on your computer: Konium Designer never sends them anywhere by itself. It connects to the network only for the things below, and only when it says." },
        {
          head: ['What', 'When', 'To', 'What goes'],
          table: [
            ['Updates', 'A little after starting, then every few hours (updates on).', 'konium.app', 'A request for the version number. Nothing about you or your files.'],
            ['What\'s New', 'When the Home page shows it (updates on).', 'konium.app', 'A request for the release log and its pictures.'],
            ['Donation note', 'Only on the rare start that asks for a donation, while online.', 'konium.app', 'A request for the day\'s wording of the ask, written there once a day by a small AI model through OpenRouter from fixed facts. Nothing about you or your files goes to either.'],
            ['Visit count', 'Only at konium.app itself (updates on); never in a downloaded copy.', 'cloud.umami.is (Umami)', 'The page visited, with no cookies and nothing that identifies you.'],
            ['AI jobs', 'When you start one, and when an AI tool\'s panel or **Preferences › System › AI** asks the service for its models and today\'s allowance. AI is off until you switch it on in **Preferences › System › AI**.', 'With the Konium service: konium.app, then OpenRouter, then the company that runs the chosen model. With your own key: OpenRouter or the provider you gave, straight from your browser. With a local model: your own computer or network.', 'What the job needs (a datasheet, or the design as text), shown before it goes. konium.app keeps nothing of your design.'],
            ['Supplier data: JLCPCB', 'Only when you look parts up in JLCPCB\'s parts list in a BOM document, or update their supplier data.', 'jlcsearch.tscircuit.com: a public copy of JLCPCB\'s parts list, not JLCPCB itself.', 'The part number or value searched for.'],
            ['Supplier data: Digi-Key and Mouser', 'Only when you search Digi-Key or Mouser in a BOM document, or update their parts\' supplier data.', 'konium.app, then Digi-Key or Mouser.', 'The part number or words searched for. konium.app keeps the answer for a day; your IP address is counted only as a salted hash, for the daily limit.'],
            ['Bug reports and messages', 'Only when you press **Send**.', 'konium.app, then the author\'s mailbox; a bug report also goes to the author\'s private repository at GitHub, where the author and the AI assistant that helps build Konium Designer read it.', 'What you write and attach.'],
            ['Version control', 'Only for a project you put under version control: when you commit, update or open one, and every few minutes while one is open.', 'The version control store at konium.app, or your team\'s own Git server (through konium.app\'s relay unless you switch it off).', 'To the store: the project\'s versions, sealed with your team\'s key before they leave (konium.app never has the key). To your own server: what Git sends, with your sign-in.'],
            ['Links you click', 'Only when you click one: **Chip in...**, a part\'s page, a datasheet\'s address.', 'Your browser opens ko-fi.com (donations), the supplier\'s or the datasheet\'s website, in a new tab.', 'Nothing from Konium Designer.'],
          ],
        },
        { p: "**To** names every party what goes reaches, in order. [Network connections](#ref-network) lists every connection in full, with how to stop each." },
        { p: "A copy at konium.app, or installed from it, also has the browser check konium.app about once a day for a newer version of Konium Designer's offline files." },
        { p: "**Stopping connections.** Two switches control the network, on the Home page (**Network activity** box) and in **Preferences › System › Network Activity**:" },
        {
          list: [
            "**Allow network activity** (in Preferences, **Allow Konium Designer to use network activity**): untick it and Konium Designer makes no connections at all, and the browser itself is told to refuse any the page could make. **Offline** shows at the right end of the menu bar. When you switch it back on, connections return the next time Konium Designer is loaded.",
            "**Check konium.app for updates and What's New**: untick it to stop the update check, What's New and the visit count only. A copy installed from konium.app then stays on the version it has.",
          ],
        },
        { img: 'gs-network', alt: "The Preferences dialog open at System, Network Activity: the switches Allow Konium Designer to use network activity and Check konium.app for updates and What's New, both ticked, and below them the Connections table listing each connection with when it happens, where it goes, what goes and whether it is allowed.", caption: 'Preferences › System › Network Activity' },
        {
          list: [
            "The **Connections** table on that page says whether each connection is allowed with the switches as you have set them.",
            "**Help › About...** lists the same connections under **Your files and connections**, each marked Allowed or Stopped now. **What Konium Designer connects to** on the Home page opens it there.",
            "A bug report written while network activity is off, or with no connection, is kept and sent once it can be.",
          ],
        },
      ],
    },

    /* ─── Help ───────────────────────────────────────────────────────────────────────── */
    {
      id: 'gs-help',
      title: 'Getting help and supporting Konium Designer',
      blocks: [
        { p: "**This guide.** **Help › User Guide** opens this guide in a tab of its own, after Home, at the section for the editor in front. F1 opens it at the section for what you are doing: the panel you are working in, or else the document in front. With no document in front, or one the guide doesn't cover yet, either opens it at [The Home page](#gs-home). The chapters are listed on the left with the sections of the one you are reading; the search box above them searches the whole guide. Click a picture to see it full size." },
        {
          list: [
            "**Help › Shortcut Keys**, or the ? key, lists the shortcut keys (see [Menus, letter shortcuts and shortcut keys](#gs-shortcuts)).",
            "**Help › Scripting Reference** opens the [Scripting Reference](#scr-intro) in the same tab, in place of this guide; **Help › User Guide** brings the guide back.",
            "Point at a toolbar button for its name and shortcut. The status bar says what the tool at work expects next.",
            "**Help › What's New** shows what each release brought (see [The Home page](#gs-home)).",
            "**Help › About...** shows your version, how Konium Designer is made, the connections it makes and the warranty statement. Its source code is public: **Source Code** opens the repository in your browser, **Licence...** shows the GNU General Public License it is under (the text is in your copy, so it shows without a connection), and **Third-Party Software...** lists the software of others that is built in, each with its own licence.",
          ],
        },
        { p: "**Reporting a bug.** If something goes wrong, tell Konium Designer's author:" },
        {
          steps: [
            "Choose **Help › Report a Bug...** (or **Report a bug...** on the Home page).",
            "Your name and email are optional; give your email to hear back.",
            "Describe what happened, and what you expected.",
            "Click **Add files...**, or drop screenshots or files on the Attachments box, to show the problem. Attachments over 8 MB together are zipped before they go (40 MB zipped at most: board files come to a quarter of their size or less). Tick **Attach the active document** to send the document in front as it is now.",
            "Leave **Include diagnostics** ticked to send the version, browser, open documents' names, recent errors, the last files saved (name, size and how) and recent messages; **Show what they say** shows them.",
            "Click **Send**.",
          ],
        },
        { img: 'gs-report-bug', alt: "The Report a Bug dialog with Demo.SchDoc in front: a note on where the report goes, optional Your name and Your email fields, a box for what happened, an Attachments box with an Add files... button, the Attach the active document, Demo.SchDoc, as it is now box (unticked) and a drop area for screenshots, the Include diagnostics box (ticked) with Show what they say below it, and the Send and Cancel buttons.", caption: 'Help › Report a Bug...' },
        { p: "The report goes through konium.app to the author and to the AI assistant that helps build Konium Designer. Without a connection, or with network activity off, it is kept and sent once it can be. **Help › Contact the Author...** sends a message instead: a question or a comment, a security problem reported privately, or something else." },
        { p: "**Supporting Konium Designer.** Konium Designer is free, with no adverts and no accounts. It is a side project, and if it helps with yours you can chip in whatever you like:" },
        {
          steps: [
            "Choose **Help › Support Konium Designer...**, click the tip jar at the right end of the menu bar, or click **Chip in...** on the Home page.",
            "Click **Chip in...**. Konium Designer's page on Ko-fi opens in your browser, where you choose the amount and pay.",
          ],
        },
        { note: "Whatever you give is a thank-you, not a purchase: it unlocks nothing, and Konium Designer works the same either way. Konium Designer itself sends nothing about you or your work. Chipping in needs a connection." },
        { p: "**The occasional ask.** Once you have started Konium Designer more than 40 times, about one start in a hundred brings a small card to the bottom right corner a minute later, asking whether you would like to chip in. **Chip in...** opens the same Ko-fi page, **Not now** (or the ×) closes it, and **I've chipped in** tells it you have. After it shows, it doesn't ask again for at least 5 days, or for 180 days after **I've chipped in**: Konium Designer can't see whether a donation was made, so it takes your word for it. The starts are counted in this browser only and go nowhere. Online, its words are the day's own wording from konium.app (see [Privacy and network connections](#gs-privacy)); with Offline on, or when there is no wording for the day, they are always the same." },
      ],
    },
  ],
};
