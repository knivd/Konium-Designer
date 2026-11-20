"""Headless smoke test: drives the built app, asserts behaviour, screenshots key states.

    npm run build && npx vite preview --port 4173 &
    python3 -I tests/tools/smoke.py <out-dir>
"""
import sys, os, json, re, base64
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
SITE = "http://localhost:4173/"  # the website (26.169); Konium Designer itself is at app/
URL = SITE + "app/?debug&features=all"  # every feature on; the release's own stage is checked on its own below
errors, checks = [], []

def check(name, ok):
    checks.append((name, bool(ok)))
    print(("ok   " if ok else "FAIL ") + name)

def shot(page, name):
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(OUT, name))

# World point (internal units) → page coordinates via the active editor's camera
TO_SCREEN = """([x, y]) => { const ed = window.konium.state.active.value.editor; const r = ed.viewport.host.getBoundingClientRect();
  const s = ed.viewport.cam.toScreen({x, y}); return [r.left + s.x, r.top + s.y]; }"""
PRIM = """(q) => { const ed = window.konium.state.active.value.editor; const p = ed.doc.prims.find(p => eval(q));
  return p.kind === 'track' ? [(p.a.x+p.b.x)/2, (p.a.y+p.b.y)/2] : [p.at.x, p.at.y]; }"""
ED = "window.konium.state.active.value.editor"

def inspector(page):
    """The Inspector's text (brought to the front of its group first)."""
    page.evaluate("window.konium.dock.showPanel('inspector')"); page.wait_for_timeout(150)
    return page.locator(".panel.inspector").inner_text()

def show_panel(page, pid):
    page.evaluate(f"window.konium.dock.showPanel('{pid}')"); page.wait_for_timeout(150)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = b.new_page(viewport={"width": 1440, "height": 880}, device_scale_factor=float(os.environ.get("SMOKE_DPR", "1")))
    # The website's visit counting: an empty stand-in (the page sends nothing off konium.app anyway)
    umami = []
    page.route("https://cloud.umami.is/**", lambda r: (umami.append(r.request.url), r.fulfill(status=200, content_type="text/javascript", body=""))[1])
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.goto(URL)
    page.wait_for_function("window.konium !== undefined")
    shot(page, "01-home.png")

    # View › Home: open at the start, as a tab ahead of the documents
    check("Home page open at the start, its tab active", page.locator(".doctab.kind-home.on").count() == 1 and "Open a project..." in page.locator(".home").inner_text())
    check("Home page offers the version", "Version " in page.locator(".home-title").inner_text())
    # What search engines and language models read: the website's home page as served (26.169: the app's own page isn't indexed)
    import urllib.request
    served = urllib.request.urlopen(SITE).read().decode("utf-8")
    app_page = urllib.request.urlopen(URL.split("?")[0]).read().decode("utf-8")
    extra = {f: urllib.request.urlopen(SITE + f).status for f in ("robots.txt", "sitemap.xml", "llms.txt")}
    check(f"the website is indexable: title, description, JSON-LD, the program at the top; robots.txt, sitemap.xml, llms.txt served ({extra}); the app's page not indexed",
          page.title().startswith("Konium Designer") and 'name="description"' in served and '"@type":"SoftwareApplication"' in served
          and "<h1>Konium Designer</h1>" in served and "It runs on your computer" in served and all(v == 200 for v in extra.values())
          and '<meta name="robots" content="noindex" />' in app_page and page.locator("#boot").count() == 0)
    ht = page.locator(".home").inner_text()
    check("Home page says what Konium is: for Altium Designer users, on real Altium projects and libraries, with the trademark line",
          "For engineers who work in Altium Designer" in ht and ".PrjPcb, .SchDoc, .PcbDoc, .SchLib, .PcbLib" in ht and "not affiliated" in page.locator(".home-legal").inner_text())
    # 26.120: Gydel beside the tip jar: a link to gydel.games in a new tab, its mark drawn
    gy = page.locator(".menubar-icon.gydel")
    check("the top bar's Gydel button: gydel.games in a new tab, its hint, its mark", gy.count() == 1 and gy.get_attribute("href") == "https://gydel.games" and gy.get_attribute("target") == "_blank"
          and "spare moments" in (gy.get_attribute("title") or "") and page.evaluate("document.querySelector('.menubar-icon.gydel img').naturalWidth") == 48)
    # The tip jar beside the menus: Support Konium
    page.locator(".menubar-icon.support").click()
    check("the tip jar opens Support Konium", page.locator(".dlg", has_text="Support Konium").count() == 1 and "free" in page.locator(".support-body").inner_text())
    page.locator(".dlg-foot .btn", has_text="Not now").click()
    # Served online in a tab: Download beside the menus gets the single file
    check("Install shows beside the menus in a browser tab online", page.locator(".menubar-chip.get").count() == 1 and page.locator(".menubar-chip.get").inner_text().strip() == "Install")
    page.locator(".menubar-chip.get").click()
    gb = page.locator(".get-body").inner_text()
    # 26.156: the browser's offer to install, else where Chrome's own Install is
    check(f"…its window: Install Konium Designer, or where Chrome's own Install is ({gb[:60]!r}…)",
          page.locator(".get-body .btn", has_text="Install Konium Designer").count() == 1 or "Cast, save and share › Install page as app" in gb)
    with page.expect_download() as dl:
        page.locator(".get-body .btn", has_text="Download Konium-").click()
    check(f"Download saves Konium-<version>.html ({dl.value.suggested_filename})", re.match(r"^Konium-\d+\.\d{3}\.html$", dl.value.suggested_filename) is not None)
    saved = open(dl.value.path(), encoding="utf-8").read()
    import hashlib
    dl_sha = hashlib.sha256(open(dl.value.path(), "rb").read()).hexdigest()
    check(f"no outside script: the visit count is added at konium.app only (asked for here: {len(umami)}), a downloaded copy carries none", len(umami) == 0 and re.search(r'<script[^>]+src="https?:', saved) is None and "<title>Konium Designer" in saved)
    page.locator(".dlg-foot .btn", has_text="Close").click()
    # Closing Home leaves the empty stage; View › Home brings it back
    page.locator(".doctab.kind-home .doctab-close").dispatch_event("mousedown")
    check("closing Home leaves the empty stage", page.locator(".empty-stage").count() == 1 and page.locator(".doctab.kind-home").count() == 0)
    page.evaluate("window.konium.run('view.home')")
    check("View › Home reopens it", page.locator(".doctab.kind-home.on").count() == 1)
    # The rest runs without the Home tab in the way
    page.evaluate("window.konium.prefs.set({ openHomePage: false, projExpand: 'full', layoutPerKind: false, groupTabs: false })")  # (the Projects tree fully open: AD's own default, Source files expanded, is checked in 26.101's section; one panel layout for every kind of document, as this run expects: a layout per kind is checked in 26.105's)
    page.locator(".doctab.kind-home .doctab-close").dispatch_event("mousedown")
    # A lone .PrjPcb (Open…, drop, desktop launch) asks for its folder; 'project file only' still opens the tree
    page.evaluate("""window.konium.openBatch([{ name: 'Lonely.PrjPcb', bytes: new TextEncoder().encode('[Design]\\r\\nVersion=1.0\\r\\n[Document1]\\r\\nDocumentPath=Sheet1.SchDoc\\r\\n') }])""")
    page.wait_for_timeout(200)
    check("lone project file opens the folder-access dialog", page.locator(".access").count() == 1)
    shot(page, "00-project-access.png")
    page.locator(".access button", has_text="Open project file only").click()
    tree = page.locator(".panel[aria-label=Projects]").inner_text()
    check("project file only: dialog closes, tree shows the project once", page.locator(".access").count() == 0 and tree.count("Lonely.PrjPcb") == 1 and "Sheet1" in tree)
    # Folder route: a mock directory handle stands in for the folder the user confirms
    opened = page.evaluate("""(async () => {
      const fs = window.konium.demoFiles();
      const mk = (f) => ({ kind: 'file', name: f.name, getFile: async () => new File([f.bytes], f.name) });
      // A writable mock: outputs land in window.__written as "<folder>/<file>"
      window.__written = {};
      const sub = (path) => ({ kind: 'directory', name: path,
        getDirectoryHandle: async (n) => sub(`${path}/${n}`),
        getFileHandle: async (n) => ({ createWritable: async () => { let buf = new Uint8Array(0);
          return { write: async (b) => { buf = b; }, close: async () => { window.__written[`${path}/${n}`] = new TextDecoder().decode(buf); } }; } }) });
      const dir = { ...sub('DemoFolder'), name: 'DemoFolder', queryPermission: async () => 'granted',
        entries: async function* () { for (const f of fs) yield [f.name, mk(f)]; } };
      return await window.konium.openProjectFolder(dir, 'Demo.PrjPcb');
    })()""")
    page.wait_for_timeout(400)
    check("project opened from its folder (schematic + board tabs)", opened and page.locator(".doctab").count() == 2)
    page.wait_for_timeout(500)
    check("two tabs open", page.locator(".doctab").count() == 2)
    check("Projects shows the sheet tree on open (Child.SchDoc under Symbols.SchDoc, no compile)",
          page.locator(".tree-hier", has_text="Symbols.SchDoc").locator(".tree-children .tree-doc", has_text="Child.SchDoc").count() == 1)
    front = lambda: page.locator(".dock-group[data-dock-group=g1] .dock-tabs [aria-selected=true]").inner_text()
    check("Projects is the tab in front on start", front() == "Projects")
    page.locator(".doctab", has_text="Demo.PcbDoc").click(); page.wait_for_timeout(200)
    page.evaluate("window.konium.dock.showPanel('inspector')"); page.wait_for_timeout(100)
    pcb_front = front()
    page.locator(".doctab", has_text="Demo.SchDoc").click(); page.wait_for_timeout(200)
    check(f"the PCB Inspector brought up on a board doesn't put the SCH Inspector in front ({pcb_front} / {front()})", pcb_front == "PCB Inspector" and front() == "Projects")
    tabs = lambda: page.locator(".doctab .doctab-name").all_inner_texts()
    t0 = tabs()
    a = page.locator(".doctab", has_text="Demo.PcbDoc").bounding_box(); z = page.locator(".doctab", has_text="Demo.SchDoc").bounding_box()
    page.mouse.move(a["x"] + 30, a["y"] + 10); page.mouse.down(); page.mouse.move(a["x"] + 10, a["y"] + 10, steps=3); page.mouse.move(z["x"] + 5, z["y"] + 10, steps=8); page.mouse.up()
    t1 = tabs()
    check(f"document tabs drag to a new place ({t0} -> {t1})", t1 == list(reversed(t0)))
    a = page.locator(".doctab", has_text="Demo.PcbDoc").bounding_box(); z = page.locator(".doctab", has_text="Demo.SchDoc").bounding_box()
    page.mouse.move(a["x"] + 30, a["y"] + 10); page.mouse.down(); page.mouse.move(z["x"] + z["width"] - 5, z["y"] + 10, steps=8); page.mouse.up()
    check("…and back", tabs() == t0)
    page.locator(".doctab", has_text="Demo.SchDoc").click(); page.wait_for_timeout(150)
    page.locator(".tree-hier", has_text="Symbols.SchDoc").locator(".tree-twisty").first.click()
    check("a parent sheet's twisty folds its children away", page.locator(".tree-doc", has_text="Child.SchDoc").count() == 0)
    page.locator(".tree-hier", has_text="Symbols.SchDoc").locator(".tree-twisty").first.click()
    check("schematic grid starts at sheet snap grid (100mil)", "Grid:100mil" in page.locator(".statusbar").inner_text())
    CENTRED = """(() => { const ed = window.konium.state.active.value.editor; const b = ed.fitBounds(); const c = ed.viewport.cam;
      const a = c.toScreen({x: b.minX, y: b.maxY}), z = c.toScreen({x: b.maxX, y: b.minY});
      return [a.x, c.width - z.x, a.y, c.height - z.y].map(Math.round); })()"""
    m = page.evaluate(CENTRED)
    check(f"schematic opens fitted to its sheet, centred ({m})", abs(m[0] - m[1]) <= 2 and abs(m[2] - m[3]) <= 2 and min(m) >= 0)
    shot(page, "02-schematic.png")

    vp = page.locator(".viewport").bounding_box()
    cx, cy = vp["x"] + vp["width"] * 0.5, vp["y"] + vp["height"] * 0.5
    page.mouse.move(cx, cy)
    page.keyboard.press("p")
    pop = page.locator(".menu-popup").bounding_box()
    check("accelerator popup opens at the cursor (moved up when it would not fit)", pop and abs(pop["x"] - (cx + 8)) < 4 and (abs(pop["y"] - (cy + 8)) < 4 or (pop["y"] < cy + 8 and pop["y"] + pop["height"] <= 880)))
    check("P chain does not highlight the menu bar", page.locator(".menubar-item.open").count() == 0)
    shot(page, "03-place-chain.png")
    page.keyboard.press("w")
    check("P,W starts the wire tool", page.evaluate(f"{ED}.tool.id") == "place-wire")
    n0 = page.evaluate(f"{ED}.doc.objects.length")
    page.mouse.click(cx - 200, cy + 150)
    page.mouse.move(cx + 40, cy + 60); page.mouse.click(cx + 40, cy + 60)
    page.mouse.move(cx + 120, cy)
    shot(page, "04-placing-wire.png")
    page.mouse.click(cx + 120, cy, button="right")
    page.mouse.click(cx + 120, cy, button="right")
    check("wire committed as one record", page.evaluate(f"{ED}.doc.objects.length") == n0 + 1)
    check("wire tool exited on second right-click", page.evaluate(f"{ED}.tool.id") == "select")
    check("tab shows modified mark", page.locator(".doctab.on .doctab-name").inner_text().endswith("*"))
    page.keyboard.press("Control+z")
    check("undo removes the wire and clears dirty", page.evaluate(f"{ED}.doc.objects.length") == n0 and not page.locator(".doctab.on .doctab-name").inner_text().endswith("*"))

    # Click a component body: selects the whole component, properties show designator
    u1 = page.evaluate(f"(() => {{ const o = {ED}.doc.objects.find(o => o.kind === 'rect' && {ED}.doc.objects[o.owner]?.designator === 'U1'); return [(o.a.x+o.b.x)/2, (o.a.y+o.b.y)/2]; }})()")
    sx, sy = page.evaluate(TO_SCREEN, u1)
    page.keyboard.press("Control+PageDown")
    for _ in range(4): page.mouse.move(sx, sy); page.keyboard.press("PageUp")
    sx, sy = page.evaluate(TO_SCREEN, u1)
    page.mouse.click(sx, sy)
    props = inspector(page)
    check("component selected: the SCH Inspector shows the part", "U1" in props and "Symbol Reference" in props and "Part" in props)
    shot(page, "05-schematic-selected.png")
    page.keyboard.press("Escape")

    # PCB
    page.locator(".doctab").nth(1).click()
    page.wait_for_timeout(500)
    m = page.evaluate(CENTRED)
    check(f"board opens fitted to its objects, centred ({m})", abs(m[0] - m[1]) <= 2 and abs(m[2] - m[3]) <= 2 and min(m) >= 0)
    check("layer bar present with Top Layer current", page.locator(".layer.on").inner_text().strip() == "Top Layer")
    shot(page, "06-pcb.png")

    pt = page.evaluate(PRIM, "p.kind === 'track' && p.layer === 1 && p.net === 1")
    sx, sy = page.evaluate(TO_SCREEN, pt)
    page.keyboard.down("Control"); page.mouse.click(sx, sy); page.keyboard.up("Control")
    check("Ctrl+click highlights net VIN", page.evaluate(f"{ED}.highlightNet") == 1)
    pad = page.evaluate(PRIM, "p.kind === 'pad' && p.component === 3 && p.name === '1'")
    sx, sy = page.evaluate(TO_SCREEN, pad)
    page.mouse.click(sx, sy)
    props = inspector(page)
    check("clicking a pad selects its component (C2, 0805)", "C2" in props and "0805" in props and "Component" in props)
    shot(page, "07-pcb-net-and-pad.png")
    page.keyboard.press("Shift+c"); page.keyboard.press("Escape")

    # Altium's single keys on a board: L, Ctrl+D, Ctrl+M, arrows + Enter, 3 / 2
    labels = page.evaluate(f"{ED}.scene().ordered().find(g => g.key === 'netlabels')?.texts.map(t => t.text) ?? []")
    check(f"pads show their number and net name ({len(labels)} labels)", "VIN" in labels and "GND" in labels and "1" in labels)
    page.mouse.move(cx, cy)
    page.keyboard.press("l")
    check("L opens View Configurations on Board Layers And Colours", page.locator(".viewcfg").count() == 1 and page.locator(".viewcfg .out-tabs .on").inner_text() == "Board Layers And Colours")
    shot(page, "07a-view-configurations.png")
    # 26.073: AD's keys in the window — T Top Layer (twice: off, on again)
    top_cb = page.locator(".viewcfg input[aria-label='Show Top Layer']")
    page.keyboard.press("t"); page.wait_for_timeout(50); t_off = not top_cb.is_checked(); page.keyboard.press("t"); page.wait_for_timeout(50)
    check("View Configurations: mechanical layers' Layer Type and Component Layer Pairs (Add Pair)", page.locator(".viewcfg .vc-mechx").count() == 1 and page.locator(".viewcfg .vc-pair-add .btn", has_text="Add Pair").count() == 1)
    check("View Configurations: T switches Top Layer off and on again, as in AD", t_off and top_cb.is_checked())
    page.locator(".viewcfg .vc-row", has_text="Top Overlay").locator("input[type=checkbox]").click()
    page.locator(".viewcfg .dlg-foot .btn", has_text="OK").click()
    check("unticking Show hides the layer", page.evaluate(f"{ED}.hidden.has(33)"))
    # 26.158: a layer turned off leaves the bottom bar (as AD); the mechanical layers' types and component layer pairs in the window
    page.wait_for_timeout(100)
    check("…and leaves the layer bar", page.locator(".layer-tabs .layer", has_text="Top Overlay").count() == 0 and page.locator(".layer-tabs .layer", has_text="Top Layer").count() == 1)
    page.keyboard.press("Control+d")
    check("Ctrl+D opens View Options", page.locator(".viewcfg .out-tabs .on").inner_text() == "View Options")
    page.locator(".viewcfg .vc-row, .viewcfg label", has_text="Show Pad Nets").locator("input").click()
    page.locator(".viewcfg .dlg-foot .btn", has_text="OK").click()
    labels2 = page.evaluate(f"{ED}.scene().ordered().find(g => g.key === 'netlabels')?.texts.map(t => t.text) ?? []")
    pads = page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'pad' && p.net !== 0xffff).length")
    check(f"Show Pad Nets off leaves the numbers ({len(labels)} -> {len(labels2)} labels)", len(labels) - len(labels2) == pads and "1" in labels2)
    page.evaluate(f"{ED}.hidden.delete(33)")
    page.keyboard.press("Control+d"); page.locator(".viewcfg label", has_text="Show Pad Nets").locator("input").click(); page.locator(".viewcfg .dlg-foot .btn", has_text="OK").click()
    page.keyboard.press("l")
    cfgs = page.locator(".viewcfg .vc-list").inner_text()
    check("View Configurations lists the 2D and 3D configurations, Standard 2D current", "3D Blue" in cfgs and page.locator(".viewcfg .vc-cfg.on").inner_text() == "Standard 2D" and "Altium" not in cfgs)
    groups = page.locator(".viewcfg .vc-group").evaluate_all("els => els.map(e => e.getAttribute('aria-label'))")
    check(f"Board Layers And Colours: AD's groups in AD's order ({len(groups)})", groups == ["Signal Layers", "Internal Planes", "Mechanical Layers", "Mask Layers", "Other Layers", "System Colours", "Silkscreen Layers"])
    # 26.031: each section's All On / All Off / Used On
    sig = page.locator(".viewcfg .vc-group[aria-label='Signal Layers']")
    sig.locator(".vc-links button", has_text="All Off").click()
    off = page.locator(".viewcfg .vc-group[aria-label='Signal Layers'] .vc-row input[type=checkbox]:checked").count()
    sig.locator(".vc-links button", has_text="All On").click()
    on = page.locator(".viewcfg .vc-group[aria-label='Signal Layers'] .vc-row input[type=checkbox]:checked").count()
    check(f"View Configurations: a section's All Off / All On ({off} -> {on} shown)", off == 0 and on >= 2)
    shot(page, "07a-view-layers.png")
    page.locator(".viewcfg .vc-row.mech", has_text="Mechanical 1").locator("input[aria-label='Enable Mechanical 1']").click()
    page.locator(".viewcfg .out-tabs button", has_text="Show/Hide").click()
    shot(page, "07b-view-showhide.png")
    page.locator(".viewcfg .vc-kind-box", has_text="Tracks").locator("input[aria-label='Tracks hidden']").check()
    # 26.108: Draft works for every kind (Coordinates and Rooms too); View Options has nothing greyed as not built
    page.locator(".viewcfg .vc-kind-box", has_text="Vias").locator("input[aria-label='Vias draft']").check()
    kinds_on = page.locator(".viewcfg .vc-kind-box input:enabled").count()
    page.locator(".viewcfg .out-tabs button", has_text="View Options").click()
    vo = page.locator(".viewcfg .vc-options input:enabled").count()
    check(f"View Configurations (26.108): all 12 kinds' Final / Draft / Hidden live ({kinds_on}), View Options all live ({vo}), nothing marked not built",
          kinds_on == 36 and vo >= 15 and page.locator(".viewcfg [title='Not in Konium Designer yet']").count() == 0)
    page.locator(".viewcfg .out-tabs button", has_text="Transparency").click()
    check("Transparency tab is there (greyed)", page.locator(".viewcfg input[type=range]").count() >= 10)
    page.locator(".viewcfg .dlg-foot .btn", has_text="OK").click()
    check("Show/Hide › Tracks Hidden takes the tracks off the board", "track" in page.evaluate("JSON.parse(localStorage.getItem('konium.settings.v2')).pcbHiddenKinds"))
    check("Show/Hide › Vias Draft draws the vias as outlines (26.108)", "via" in page.evaluate("JSON.parse(localStorage.getItem('konium.settings.v2')).pcbDraftKinds"))
    check("Enable unticked: Board6 LAYER57MECHENABLED=FALSE, one undo step", page.evaluate(f"{ED}.doc.board.bag.get('LAYER57MECHENABLED')") == "FALSE" and page.evaluate(f"{ED}.undo.undoLabel") == "Enable mechanical layers")
    page.mouse.move(cx, cy); page.keyboard.press("Control+z")
    check("…and Ctrl+Z enables it again", page.evaluate(f"{ED}.doc.board.bag.get('LAYER57MECHENABLED')") == "TRUE")
    page.keyboard.press("l"); page.locator(".viewcfg .out-tabs button", has_text="Show/Hide").click()
    page.locator(".viewcfg .vc-buttons .btn", has_text="All Final").click(); page.locator(".viewcfg .dlg-foot .btn", has_text="OK").click()
    page.mouse.move(cx, cy)
    x0 = page.evaluate(f"{ED}.cursor.x")
    page.keyboard.press("ArrowRight"); page.keyboard.press("Shift+ArrowRight")
    g = page.evaluate(f"{ED}.gridSize()")
    check("arrow keys move the cursor 1 and 10 grid steps", abs(page.evaluate(f"{ED}.cursor.x") - page.evaluate(f"{ED}.snap({{x: {x0}, y: 0}}).x") - 11 * g) < 2)
    page.keyboard.press("Control+m")
    check("Ctrl+M starts Measure Distance", page.evaluate(f"{ED}.tool.id") == "measure")
    page.mouse.click(cx - 100, cy); page.mouse.move(cx + 100, cy); page.mouse.click(cx + 100, cy)
    info = page.locator(".dlg").inner_text() if page.locator(".dlg").count() else ""
    check("measure reports the distance in both units", "Distance =" in info and "mil" in info and "mm" in info)
    shot(page, "07b-measure.png")
    page.keyboard.press("Enter"); page.keyboard.press("Escape")
    page.mouse.move(cx, cy)
    page.keyboard.press("3")
    page.wait_for_timeout(600)
    check("3 switches to 3D Layout Mode", page.locator(".viewer3d canvas").count() == 1 and page.evaluate(f"{ED}.mode3d"))
    page.keyboard.press("8")
    page.wait_for_timeout(400)
    shot(page, "07c-3d.png")
    page.keyboard.press("2")
    check("2 returns to 2D", page.locator(".viewer3d").count() == 0 and not page.evaluate(f"{ED}.mode3d"))

    tracks0 = page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'track').length")
    page.mouse.move(cx, cy)
    page.keyboard.press("p"); page.keyboard.press("l")
    check("P,L starts the line (track) tool", page.evaluate(f"{ED}.tool.id") == "place-track")
    page.mouse.click(cx + 100, cy + 120)
    page.mouse.move(cx + 250, cy + 40)
    shot(page, "08-placing-track.png")
    page.mouse.click(cx + 250, cy + 40)
    page.mouse.click(cx + 250, cy + 40, button="right")
    page.mouse.click(cx + 250, cy + 40, button="right")
    added = page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'track').length") - tracks0
    check(f"45-degree track committed as 2 segments (got {added})", added == 2)
    check("Tracks6 marked for re-serialisation", page.evaluate(f"{ED}.doc.dirty.has('Tracks6')"))
    page.keyboard.press("*")
    check("* moves to Bottom Layer", page.locator(".layer.on").inner_text().strip() == "Bottom Layer")
    page.keyboard.press("Shift+S")
    shot(page, "09-single-layer.png")
    page.keyboard.press("Shift+S"); page.keyboard.press("Shift+S"); page.keyboard.press("*")

    # Interactive routing from U1-1 (GND) straight at the VIN track: stops at the first obstacle
    W = "([x, y]) => [10000000 + x * 10000000 / 25.4, 10000000 + y * 10000000 / 25.4]"
    page.keyboard.press("Control+z")  # drop the free line so the DRC below sees the routed board
    tracks0 = page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'track').length")
    page.mouse.move(cx, cy)
    # Width from the Width rule (Track Width Mode: Rule Preferred; User Choice is the default)
    page.evaluate("window.konium.prefs.set({ pcbRoutingMode: 'walkaround', pcbTrackWidthMode: 'pref' })")
    page.keyboard.press("p"); page.keyboard.press("t")
    check("P,T starts Interactive Routing", page.evaluate(f"{ED}.tool.id") == "route")
    page.keyboard.press("Shift+R")
    check("Shift+R: Walkaround Obstacles to Stop At First Obstacle", page.evaluate("window.konium.prefs.get().pcbRoutingMode") == "stop")
    sx, sy = page.evaluate(TO_SCREEN, page.evaluate(W, [21.7, 9.4]))
    page.mouse.move(sx, sy); page.mouse.click(sx, sy)
    page.wait_for_timeout(100)
    check("route takes the pad's net (status bar)", "GND" in page.locator(".statusbar").inner_text())
    page.keyboard.press("Tab")
    check("Tab while routing opens Interactive Routing For Net [GND] [unit]", page.locator(".dlg[aria-label^='Interactive Routing For Net [GND] [']").count() == 1)
    page.keyboard.press("Escape")
    ex, ey = page.evaluate(TO_SCREEN, page.evaluate(W, [21.7, 5.0]))
    page.mouse.move(ex, ey, steps=3)
    shot(page, "08b-routing.png")
    page.mouse.click(ex, ey)
    page.mouse.click(ex, ey, button="right")
    new = page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'track').slice({tracks0})")
    end_mm = (new[0]["b"]["y"] - 10000000) / (10000000 / 25.4) if new else 0
    check(f"route stopped short of VIN (1 GND track, ends at {end_mm:.3f} mm)", len(new) == 1 and new[0]["net"] == 0 and 8.0 < end_mm < 8.1)
    page.evaluate("window.konium.prefs.set({ pcbTrackWidthMode: 'user' })")
    page.mouse.click(ex, ey, button="right")
    check("second right-click leaves the router", page.evaluate(f"{ED}.tool.id") == "select")

    # 26.030: Push Obstacles moves the free +3V3 track out of a GND route's way, at clearance
    page.evaluate("window.konium.prefs.set({ pcbRoutingMode: 'push', pcbClearanceBoundaries: true })")
    v33 = f"{ED}.doc.prims.filter(p => p.kind === 'track' && p.net === 2).length"
    n33 = page.evaluate(v33)
    page.mouse.move(cx, cy); page.keyboard.press("p"); page.keyboard.press("t")
    page.keyboard.press("1")
    for x, y in [(35.6, 15.0), (35.6, 19.3)]:
        px, py = page.evaluate(TO_SCREEN, page.evaluate(W, [x, y])); page.mouse.move(px, py, steps=2); page.mouse.click(px, py)
    px, py = page.evaluate(TO_SCREEN, page.evaluate(W, [26.0, 19.3])); page.mouse.move(px, py, steps=4)
    shot(page, "08c-push.png")
    page.mouse.click(px, py); page.mouse.click(px, py, button="right"); page.mouse.click(px, py, button="right")
    drc = page.evaluate(f"{ED}.runBatchDrc(new Set(['Clearance', 'ShortCircuit'])).violations.length")
    check(f"Push Obstacles: the +3V3 run bends aside ({n33} -> {page.evaluate(v33)} tracks), no clearance broken ({drc})", page.evaluate(v33) > n33 and drc == 0)
    page.keyboard.press("Control+z")
    check("one undo step takes the route and the push back", page.evaluate(v33) == n33)
    page.evaluate("window.konium.prefs.set({ pcbRoutingMode: 'walkaround' })")

    # Design » Rules: edit the Power clearance, OK, undo
    page.mouse.move(cx, cy)
    page.keyboard.press("d"); page.keyboard.press("r")
    check("D,R opens the PCB Rules and Constraints Editor", page.locator(".dlg.rules").count() == 1)
    check("rules tree lists the board's rules", "Clearance_Power" in page.locator(".rules-tree").inner_text())
    page.locator(".rules-row", has_text="Clearance_Power").click()
    page.locator(".rule-field", has_text="Minimum Clearance").locator("input").fill("14")
    page.locator(".rule-field", has_text="Minimum Clearance").locator("input").press("Tab")
    shot(page, "17-rules.png")
    page.locator(".rules-row .tree-name", has_text="Clearance").first.click()
    check("rule type lists its rules with priorities", page.locator(".rules-table .grid-body .grid-row").count() == 2)
    page.locator(".dlg-foot .btn", has_text="OK").click()
    gap = page.evaluate(f"{ED}.doc.rules.find(r => r.bag.get('NAME') === 'Clearance_Power').bag.get('GAP')")
    check(f"OK applies the edit (GAP={gap}) and marks Rules6 for saving", gap == "14mil" and page.evaluate(f"{ED}.doc.dirty.has('Rules6')"))
    page.keyboard.press("Control+z")
    check("undo restores the rule", page.evaluate(f"{ED}.doc.rules.find(r => r.bag.get('NAME') === 'Clearance_Power').bag.get('GAP')") == "12mil")
    nr0 = page.evaluate(f"{ED}.doc.rules.length")
    page.evaluate("window.konium.run('design.rules')"); page.wait_for_timeout(200)
    page.locator(".dlg.rules .dlg-foot .btn", has_text="Rule Wizard").click(); page.wait_for_timeout(150)
    page.locator(".dlg .dlg-foot .btn", has_text="Finish").last.click(); page.wait_for_timeout(150)
    check("Design › Rules › Rule Wizard...: the new rule joins the editor's list, the board unchanged until OK",
          page.locator(".dlg.rules").count() == 1 and page.locator(".dlg.rules .dlg-foot .btn", has_text="Apply").is_enabled() and page.evaluate(f"{ED}.doc.rules.length") == nr0)
    page.locator(".dlg.rules .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(150)
    check("…OK adds it to the board; undo takes it back", page.evaluate(f"{ED}.doc.rules.length") == nr0 + 1 and (page.keyboard.press("Control+z") or True) and page.evaluate(f"{ED}.doc.rules.length") == nr0)

    # Tools » Design Rule Check: report, Messages, green markers
    page.keyboard.press("t"); page.keyboard.press("d")
    check("T,D opens the Design Rule Checker", page.locator(".dlg.drc").count() == 1)
    page.locator(".rules-row", has_text="Rules To Check").click()
    shot(page, "18-drc.png")
    pages0 = len(page.context.pages)
    page.locator(".dlg-foot .btn", has_text="Run Design Rule Check").click()
    page.wait_for_timeout(400)
    check("DRC report opened", len(page.context.pages) == pages0 + 1)
    for extra in page.context.pages[pages0:]: extra.close()
    check("DRC results in Messages", page.locator(".messages").count() == 1 and page.evaluate("window.konium.state.messages.value.some(m => m.source === 'Advanced PCB' && m.message.startsWith('Design Rule Check:'))"))
    # 26.151: Net Antennae is checked with no rule of its own (as the desktop suite does): the routing test's stub up from U1-1 ends in the open
    left = page.evaluate(f"{ED}.violations.filter(v => v.kind !== 'NetAntennae').map(v => v.message).slice(0, 4)")
    stubs = page.evaluate(f"{ED}.violations.filter(v => v.kind === 'NetAntennae').length")
    check(f"routed board is clean but for the test stub's open end ({left}, {stubs} antenna)", len(left) == 0 and stubs <= 1)
    # 26.071: Rules To Check are the board's own (AD's defaults for a board without them)
    check("Rules To Check: the board's (AD's defaults: silk and mask checks in batch)", page.evaluate(f"(() => {{ const s = window.konium.drcSettings({ED}.doc); return s.batch.has('MinimumSolderMaskSliver') && s.batch.has('NetAntennae') && !s.batch.has('ComponentClearance'); }})()"))
    # 26.071: Design » Fab-House Profile: the house against the board's rules, Check Board
    page.evaluate("window.konium.run('design.fabProfile')"); page.wait_for_selector(".dlg.fab-profile")
    rows_fab = page.locator(".dlg.fab-profile .grid-body .grid-row").count()
    page.locator(".dlg.fab-profile .dlg-foot .btn", has_text="Check Board").click(); page.wait_for_timeout(300)
    fab_msg = page.evaluate("window.konium.state.messages.value.filter(m => m.source === 'Fab-House Check').map(m => m.message).pop() || ''")
    shot(page, "18b-fab-profile.png")
    check(f"Fab-House Profile: {rows_fab} limits against the board's rules, Check Board in Messages ({fab_msg[:60]})", rows_fab >= 6 and 'JLCPCB' in fab_msg)
    page.locator(".dlg.fab-profile .dlg-foot .btn", has_text="Close").click()
    # 26.071: PCB ActiveRoute panel: the board's signal layers and Meander
    page.evaluate("window.konium.run('view.panel.activeRoute')"); page.wait_for_timeout(200)
    check("PCB ActiveRoute panel lists the signal layers", page.locator(".activeroute .ar-layers li").count() >= 2 and page.locator(".activeroute button", has_text="ActiveRoute").count() == 1)
    page.evaluate("window.konium.run('view.panel.activeRoute')"); page.wait_for_timeout(100)
    # 26.030: a column of the Messages list sized by dragging its header edge
    head = page.locator(".messages .grid-head > span").nth(1)
    hb = head.bounding_box()
    page.mouse.move(hb["x"] + hb["width"] - 2, hb["y"] + hb["height"] / 2); page.mouse.down()
    page.mouse.move(hb["x"] + hb["width"] + 60, hb["y"] + hb["height"] / 2, steps=4); page.mouse.up()
    w2 = page.locator(".messages .grid-head > span").nth(1).bounding_box()["width"]
    cell = page.locator(".messages .grid-body .grid-row").first.locator(":scope > span").nth(1).bounding_box()["width"]
    check(f"Messages: a column widens by dragging its header edge ({hb['width']:.0f} -> {w2:.0f}, rows follow {cell:.0f})", w2 > hb["width"] + 50 and abs(cell - w2) < 2)

    # Design » Update PCB Document from the schematic: the ECO adds the LED indicator
    page.locator(".doctab").nth(0).click(); page.wait_for_timeout(300)
    page.mouse.move(cx, cy)
    page.keyboard.press("d"); page.keyboard.press("u")
    check("D,U opens the Engineering Change Order", page.locator(".dlg.eco").count() == 1)
    rows = page.locator(".eco .grid-body .grid-row:not(.eco-group)").count()
    check(f"ECO lists the LED indicator changes ({rows})", rows == 7)
    page.locator(".dlg-foot .btn", has_text="Validate Changes").click()
    check("all changes validate", page.locator(".eco .eco-err").count() == 0 and page.locator(".eco .eco-ok").count() == 7)
    page.locator(".dlg-foot .btn", has_text="Execute Changes").click()
    shot(page, "19-eco.png")
    check("all changes done", page.locator(".eco .eco-ok").count() == 14)
    page.locator(".dlg-foot .btn", has_text="Close").click()
    page.wait_for_timeout(400)
    check("board tab active with R1 and D1 placed", page.evaluate(f"{ED}.doc.components.map(c => c.designator).join(',')") == "J1,C1,U1,C2,D1,R1")
    shot(page, "20-after-eco.png")

    # Drag R1 onto the board by its pad 1, turning it with Space on the way (Smart Component Snap off: Snap To Center holds it by its reference point)
    page.evaluate("window.konium.prefs.set({ pcbSmartComponentSnap: false })")
    R1 = f"{ED}.doc.components.find(c => c.designator === 'R1')"
    pad = page.evaluate(f"(() => {{ const c = {R1}; const p = {ED}.doc.prims.find(p => p.kind === 'pad' && p.component === c.index && p.name === '1'); return [p.at.x, p.at.y, c.at.x, c.at.y]; }})()")
    sx, sy = page.evaluate(TO_SCREEN, pad[:2])
    target = page.evaluate(W, [30, 11])
    tx, ty = page.evaluate(TO_SCREEN, target)   # Snap To Center: the part hangs from its reference point
    page.mouse.move(sx, sy); page.mouse.down(); page.mouse.move(tx, ty, steps=8)
    page.keyboard.press("Space")
    page.mouse.move(tx + 1, ty, steps=1)
    shot(page, "21-drag-component.png")
    page.mouse.up()
    at = page.evaluate(f"(() => {{ const c = {R1}; return [(c.at.x - 10000000) / (10000000 / 25.4), (c.at.y - 10000000) / (10000000 / 25.4), c.rotation]; }})()")
    check(f"R1 dragged onto the board and turned ({at[0]:.2f}, {at[1]:.2f} mm, {at[2]}°)", abs(at[0] - 30) < 0.2 and abs(at[1] - 11) < 0.2 and at[2] == 90)
    # Smart Component Snap (on, as AD): picked up by pad 1, the part is held by that pad's centre, which lands on the cursor
    page.evaluate("window.konium.prefs.set({ pcbSmartComponentSnap: true })")
    PAD1 = f"{ED}.doc.prims.find(p => p.kind === 'pad' && p.component === {R1}.index && p.name === '1')"
    sx, sy = page.evaluate(TO_SCREEN, page.evaluate(f"[{PAD1}.at.x, {PAD1}.at.y]"))
    tx, ty = page.evaluate(TO_SCREEN, page.evaluate(W, [30, 16]))
    page.mouse.move(sx, sy); page.mouse.down(); page.mouse.move(tx, ty, steps=8); page.mouse.up(); page.wait_for_timeout(200)
    p1 = page.evaluate(f"(() => {{ const p = {PAD1}; return [(p.at.x - 10000000) / (10000000 / 25.4), (p.at.y - 10000000) / (10000000 / 25.4)]; }})()")
    check(f"…Smart Component Snap: picked up by pad 1, R1 is held by that pad's centre ({p1[0]:.2f}, {p1[1]:.2f} mm)", abs(p1[0] - 30) < 0.2 and abs(p1[1] - 16) < 0.2)
    page.keyboard.press("Control+z"); page.wait_for_timeout(200)
    check("PCB Inspector shows the component", "R1" in inspector(page))
    page.keyboard.press("Control+z")
    page.keyboard.press("Control+z")
    check("undo the move, then the whole change order", page.evaluate(f"{ED}.doc.components.length") == 4)

    # File » Fabrication Outputs » Gerber Files: setup, OK, files in "Project Outputs for Demo"
    page.mouse.move(cx, cy)
    page.keyboard.press("f"); page.keyboard.press("f"); page.keyboard.press("g")
    check("F,F,G opens Gerber Setup", page.locator(".dlg[aria-label='Gerber Setup']").count() == 1)
    page.locator(".out-tabs button", has_text="Apertures").click()
    page.locator(".out-check", has_text="Embedded apertures").locator("input").uncheck(); page.wait_for_timeout(300)
    naps = page.locator(".out-apertures .ap-row:not(.ap-head)").count()
    check(f"Gerber Setup › Apertures: Embedded apertures off lists the run's D-codes for Demo.APR ({naps})", naps > 3 and "Demo.APR" in page.locator(".out-page").inner_text())
    page.locator(".out-check", has_text="Embedded apertures").locator("input").check()
    page.locator(".out-tabs button", has_text="Layers").click()
    shot(page, "22-gerber-setup.png")
    page.locator(".dlg-foot .btn", has_text="OK").click()
    page.wait_for_timeout(400)
    written = page.evaluate("Object.keys(window.__written)")
    check(f"Gerber files written to Project Outputs ({len(written)})", "DemoFolder/Project Outputs for Demo/Demo.GTL" in written and "DemoFolder/Project Outputs for Demo/Demo.EXTREP" in written)
    page.wait_for_timeout(400)
    cam = page.evaluate("(() => { const d = window.konium.state.active.value.doc; return d.kind === 'CamDoc' ? [window.konium.state.active.value.name, d.layers.map(l => l.type)] : [d.kind, []]; })()")
    check(f"…and opened in the CAM editor as AD opens them ({cam[0]}: {len(cam[1])} layers)", cam[0].startswith("CAM1") and "Top" in cam[1] and "Top Silk" in cam[1] and page.locator(".cam-layers li").count() == len(cam[1]))
    shot(page, "22b-cam-editor.png")
    page.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(400)
    page.mouse.move(cx, cy)
    page.keyboard.press("f"); page.keyboard.press("f"); page.keyboard.press("n")
    routdia = page.locator(".dlg input[aria-label='Rout Tool Dia']")
    was = routdia.is_disabled()
    page.locator(".out-check", has_text="Generate Board Edge Rout Paths").locator("input").check()
    check("NC Drill Setup: Optimise, G85 and Board Edge Rout Paths can be set; the rout tool's diameter with them",
          was and routdia.is_enabled() and page.locator(".out-check", has_text="Use drilled slot command").locator("input").is_enabled() and page.locator(".out-check", has_text="Optimise change location").locator("input").is_enabled())
    page.locator(".out-check", has_text="Generate Board Edge Rout Paths").locator("input").uncheck()
    page.locator(".dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(600)
    page.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(400)
    page.mouse.move(cx, cy)
    page.keyboard.press("f"); page.keyboard.press("b"); page.keyboard.press("g")
    page.locator(".dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(300)
    written = page.evaluate("Object.keys(window.__written)")
    check("NC drill and pick and place written", "DemoFolder/Project Outputs for Demo/Demo.TXT" in written and "DemoFolder/Project Outputs for Demo/Pick Place for Demo.csv" in written)
    # Kept for the CAM editor's checks (the reloads further on clear window.__written)
    cam_files = page.evaluate(r"""() => Object.entries(window.__written).filter(([k]) => /Project Outputs for Demo\/Demo\.(GTL|GBL|GTO|GTS|GM1|TXT)$/.test(k)).map(([k, v]) => ({ name: k.split('/').pop(), text: v }))""")

    # Design » Make PCB Library, then edit the library: new footprint, two pads, rename
    page.mouse.move(cx, cy)
    page.keyboard.press("d"); page.keyboard.press("p")
    page.wait_for_timeout(500)
    check("Make PCB Library opens Demo1.PcbLib", page.locator(".doctab.on").inner_text().strip().startswith("Demo1.PcbLib"))
    lst = page.locator(".pcblib-list").inner_text()
    check("PCB Library panel lists the footprints", all(n in lst for n in ["HDR1X2", "0805", "SOT-223"]))
    shot(page, "23-pcb-library.png")
    page.locator(".pcblib-buttons .btn", has_text="Add").click()
    page.wait_for_timeout(200)
    check("Add makes PCBCOMPONENT_1", page.evaluate(f"{ED}.entry.name") == "PCBCOMPONENT_1")
    vp = page.locator(".viewport").bounding_box()
    mx, my = vp["x"] + vp["width"] / 2, vp["y"] + vp["height"] / 2
    page.mouse.move(mx, my)
    page.keyboard.press("p"); page.keyboard.press("p")
    check("P,P places pads", page.evaluate(f"{ED}.tool.id") == "place-pad")
    page.mouse.move(mx - 60, my); page.mouse.click(mx - 60, my)
    page.mouse.move(mx + 60, my); page.mouse.click(mx + 60, my)
    page.mouse.click(mx + 60, my, button="right")
    pads = page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'pad').map(p => p.name)")
    check(f"two pads, designators 1 and 2 ({pads})", pads == ["1", "2"])
    page.keyboard.press("t"); page.keyboard.press("e")
    page.locator(".fp-form input").first.fill("MYPART")
    page.locator(".dlg-foot .btn", has_text="OK").click()
    shot(page, "24-new-footprint.png")
    names = page.evaluate(f"{ED}.lib.footprints.map(f => f.name)")
    check(f"footprint renamed ({names})", names == ["HDR1X2", "0805", "SOT-223", "MYPART"])

    page.locator(".doctab", has_text="Demo.PcbDoc").click(); page.wait_for_timeout(200)
    show_panel(page, "fileInspector")
    page.locator(".cfb-row", has_text="Data").nth(4).click()
    page.wait_for_timeout(200)
    page.locator(".records details").first.click()
    shot(page, "10-inspector.png")

    page.keyboard.press("?")
    shot(page, "11-shortcuts.png")
    check("? opens Shortcut Keys", page.locator(".dlg[aria-label='Shortcut Keys']").count() == 1)
    page.keyboard.press("Escape")
    check("Esc closes the dialog", page.locator(".dlg").count() == 0)
    page.keyboard.press("F1"); page.wait_for_timeout(400)
    f1_guide = page.locator(".help-page[aria-label='User Guide']").count()
    page.locator(".doctab.kind-help .doctab-close").dispatch_event("mousedown"); page.wait_for_timeout(300)
    check("F1 opens the User Guide in a tab of its own (and it closes)", f1_guide == 1 and page.locator(".doctab.kind-help").count() == 0)

    # Altium-style behaviour checks
    page.locator(".doctab").nth(1).click(); page.wait_for_timeout(300)
    check("PCB Inspector shows board options when nothing is selected", "Copper layers" in inspector(page))
    show_panel(page, "projects")

    check("PCB toolbars shown", page.locator(".tbar[aria-label=Wiring] .tbtn").count() >= 8)
    untitled = page.evaluate("[...document.querySelectorAll('.toolbars .tbtn')].filter(b => !b.title).length")
    check(f"every toolbar button has a tooltip ({untitled} without)", untitled == 0)
    check("toolbar tooltips are AD's descriptions", page.locator(".tbtn[data-cmd='edit.deselectAll']").get_attribute("title").startswith("Deselect All"))
    # Design › Layer Stack Manager: the stack listed, a layer added, OK writes it
    page.evaluate(f"window.konium.run('pcb.layerStackManager')"); page.wait_for_timeout(300)
    n0 = page.locator(".lsm-row:not(.lsm-head)").count()
    check(f"Layer Stack Manager lists the stack ({n0} rows) with its thickness", n0 == 7 and "Total Thickness" in page.locator(".lsm-total").inner_text())
    page.locator(".lsm-row:not(.lsm-head)").nth(2).dispatch_event("mousedown")
    page.locator(".lsm .btn", has_text="Add Layer").dispatch_event("mousedown"); page.wait_for_timeout(150)
    page.locator(".menu-popup .menu-item", has_text="Add Internal Plane").click(); page.wait_for_timeout(150)
    check("Add Internal Plane adds a plane and its dielectric", page.locator(".lsm-row:not(.lsm-head)").count() == n0 + 2)
    page.locator(".lsm .btn", has_text="OK").click(); page.wait_for_timeout(200)
    check("OK puts the plane in the board's stack (one undo step)", page.evaluate(f"{ED}.doc.board.copperStack.length") == 3)
    # 26.109: Presets › Six Layer puts in four inner layers; Cancel leaves the board as it was
    page.evaluate(f"window.konium.run('pcb.layerStackManager')"); page.wait_for_timeout(300)
    lsm_off = page.locator(".lsm .lsm-bar button:disabled, .lsm .lsm-bar input:disabled").count()
    page.locator(".lsm .btn", has_text="Presets").dispatch_event("mousedown"); page.wait_for_timeout(150)
    page.locator(".menu-popup .menu-item", has_text="Six Layer").click(); page.wait_for_timeout(150)
    copper6 = page.locator(".lsm-row:not(.lsm-head)", has_text="Signal").count() + page.locator(".lsm-row:not(.lsm-head)", has_text="Internal Plane").count()
    page.locator(".lsm .lsm-bar input[type=checkbox]").check(); page.wait_for_timeout(100)
    slabs = page.locator(".lsm .lsm-glyph polygon").count()
    page.locator(".lsm .btn", has_text="Cancel").click(); page.wait_for_timeout(150)
    check(f"Layer Stack Manager (26.109): Save, Load, Presets and 3D live ({lsm_off} greyed); Six Layer gives six copper layers ({copper6}); 3D draws slabs ({slabs})",
          lsm_off == 0 and copper6 >= 6 and slabs > 10 and page.evaluate(f"{ED}.doc.board.copperStack.length") == 3)
    page.keyboard.press("Control+z"); page.wait_for_timeout(150)
    check("undo takes it out again", page.evaluate(f"{ED}.doc.board.copperStack.length") == 2)
    check("pour regions decoded", page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'region').length") == 2)
    check("hidden comment text not drawn", page.evaluate(f"{ED}.scene().ordered().flatMap(g => g.texts).some(t => t.text === 'LDO 3V3')") is False)
    vp = page.locator(".viewport").bounding_box()
    page.mouse.click(vp["x"] + 40, vp["y"] + vp["height"] - 40, button="right")
    ctx = page.locator(".menu-popup").inner_text() if page.locator(".menu-popup").count() == 1 else ""
    check("right-click opens Altium's free-space menu", all(t in ctx for t in ["Find Similar Objects", "Snap Grid", "View", "Interactive Routing"]))
    page.locator(".menu-popup .menu-item", has_text="View").hover(); page.wait_for_timeout(100)
    check("View cascades to its submenu (Fit Board)", page.locator(".menu-popup").count() == 2 and "Fit Board" in page.locator(".menu-popup[data-depth='1']").inner_text())
    shot(page, "12-context-menu.png")
    page.keyboard.press("Escape")

    # Polygon pours: picked by their copper, edited in place, deleted, placed (P, G), managed
    page.evaluate(f"{ED}.setCurrentLayer(32)")
    px, py = page.evaluate(TO_SCREEN, page.evaluate(W, [10, 18]))
    page.mouse.click(px, py)
    check("click on pour copper selects the pour", page.evaluate(f"[...{ED}.selection].join()") == "poly:0")
    check("PCB Inspector shows the Polygon Pour", "Polygon Pour" in inspector(page))
    show_panel(page, "projects")
    check("selected pour shows vertex and mid-edge handles", page.evaluate(f"{ED}.grips().length") == 8)
    page.mouse.dblclick(px, py); page.wait_for_timeout(200)
    check("double-click opens the Polygon Pour dialog", page.locator(".dlg.polydlg").count() == 1)
    shot(page, "25-polygon-dialog.png")
    page.keyboard.press("Escape")
    gx, gy = page.evaluate(TO_SCREEN, page.evaluate(W, [39, 20.5]))
    page.mouse.move(gx, gy); page.mouse.down(); page.mouse.move(gx - 120, gy - 60, steps=5); page.mouse.up()
    check("dragging a corner handle reshapes and repours", page.evaluate(f"{ED}.undo.undoLabel") == "Move polygon vertex")
    shot(page, "26-polygon-reshaped.png")
    page.keyboard.press("Control+z")
    page.mouse.click(px, py); page.keyboard.press("Delete")
    check("Delete removes the pour with its copper", page.evaluate(f"{ED}.doc.polygons.length") == 0 and page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'region').length") == 1)
    page.keyboard.press("Control+z")
    check("undo brings it back", page.evaluate(f"{ED}.doc.polygons.length") == 1)
    page.evaluate(f"{ED}.setCurrentLayer(1)")
    page.mouse.move(*page.evaluate(TO_SCREEN, page.evaluate(W, [15, 7.2])))
    page.keyboard.press("p"); page.keyboard.press("g")
    check("P,G opens Polygon Pour with the net under the cursor", page.locator(".dlg.polydlg").count() == 1 and page.locator(".polydlg select").nth(1).input_value() == "1")
    page.locator(".dlg-foot .btn", has_text="OK").click()
    for x, y in [(10, 5), (20, 5), (20, 9), (10, 9)]:
        page.mouse.click(*page.evaluate(TO_SCREEN, page.evaluate(W, [x, y])))
    page.mouse.move(*page.evaluate(TO_SCREEN, page.evaluate(W, [12, 10])))
    shot(page, "27-placing-polygon.png")
    page.mouse.click(*page.evaluate(TO_SCREEN, page.evaluate(W, [12, 10])), button="right")
    page.mouse.click(*page.evaluate(TO_SCREEN, page.evaluate(W, [12, 10])), button="right")
    check("polygon placed and poured", page.evaluate(f"{ED}.doc.polygons.map(p => p.name).join()") == "GND_L2_P000,VIN_L1_P001"
          and page.evaluate(f"{ED}.doc.prims.some(p => p.kind === 'region' && p.polygon === 1)") and page.evaluate(f"{ED}.tool.id") == "select")
    shot(page, "28-polygon-placed.png")
    page.keyboard.press("t"); page.keyboard.press("g"); page.keyboard.press("m")
    check("T,G,M opens the Polygon Pour Manager listing both", page.locator(".dlg.polymgr .grid-body .grid-row").count() == 2)
    shot(page, "29-polygon-manager.png")
    page.keyboard.press("Escape")
    # 26.028: Place › Dimension › Linear, the print outputs' preview, the Output Job
    check("the demo board carries its two dimensions", page.evaluate(f"{ED}.doc.dimensions.length") == 2)
    page.evaluate(f"{ED}.setCurrentLayer(57)")
    page.evaluate("window.konium.run('ad:PCB:PlaceDimensionLinear')")
    for x, y in [(5, 23), (15, 23), (10, 26.5)]:
        page.mouse.click(*page.evaluate(TO_SCREEN, page.evaluate(W, [x, y])))
    dims = page.evaluate(f"{ED}.doc.dimensions.map(d => d.kind + ':' + Math.round(Math.abs(d.refs[1].x - d.refs[0].x) / 393700.787))")
    check(f"Place › Dimension › Linear: two points and the line give a 10 mm dimension ({dims})", dims[-1:] == ["1:10"] and len(dims) == 3)
    shot(page, "56-dimension-placed.png")
    page.keyboard.press("Escape"); page.keyboard.press("Escape")
    # 26.029: Angular as AD picks it — two points on each edge, then the radius and side
    page.evaluate("window.konium.run('ad:PCB:PlaceDimensionAngular')")
    for x, y in [(5, 21), (15, 21), (5, 21), (10, 26), (12, 24)]:
        page.mouse.click(*page.evaluate(TO_SCREEN, page.evaluate(W, [x, y])))
    ang = page.evaluate(f"(() => {{ const d = {ED}.doc.dimensions.at(-1); return [d.kind, d.refs.length, d.bag.has('RADIUS'), d.bag.has('ANGLE'), d.bag.get('TEXTFORMAT')]; }})()")
    check(f"Place › Dimension › Angular: four points and the radius ({ang})", ang == [2, 4, True, False, "%d°"])
    shot(page, "56b-angular-placed.png")
    page.keyboard.press("Escape"); page.keyboard.press("Escape")
    page.keyboard.press("Control+z"); page.keyboard.press("Control+z")
    check("undo takes them away", page.evaluate(f"{ED}.doc.dimensions.length") == 2)
    page.evaluate("window.konium.run('output.drillDrawings')"); page.wait_for_timeout(400)
    check("Fabrication Outputs › Drill Drawings previews its printouts", page.locator(".dlg.printpreview svg").count() == 1 and "Drill Drawing For" in page.locator(".dlg.printpreview").inner_text())
    shot(page, "57-drill-drawing-preview.png")
    page.keyboard.press("Escape")
    page.locator(".tree-doc", has_text="Demo.OutJob").dblclick(); page.wait_for_timeout(400)
    rows = page.locator(".outjob .oj-row").count()
    check(f"Demo.OutJob opens in its editor under Settings › Output Job Files ({rows} outputs)", rows == 6 and page.locator(".tree-folder, .tree-row", has_text="Output Job Files").count() >= 1)
    shot(page, "58-outjob.png")
    page.locator(".oj-cont", has_text="Folder Structure").locator("button", has_text="Generate content").click(); page.wait_for_timeout(800)
    written = page.evaluate("Object.keys(window.__written)")
    check(f"Generate content: the Folder Structure outputs written ({len(written)})", "DemoFolder/Project Outputs for Demo/Demo.GD1" in written and "DemoFolder/Project Outputs for Demo/Demo.TXT" in written
          and any(w.endswith(".xlsx") for w in written))
    check("with AD's .RUL and Status Report.Txt", "DemoFolder/Project Outputs for Demo/Demo.RUL" in written and "DemoFolder/Project Outputs for Demo/Status Report.Txt" in written)
    page.locator(".oj-cont", has_text="PDF").click()
    page.locator(".oj-row", has_text="Gerber Files").locator("input[type=checkbox]").click()
    check("enabling an output in the PDF container marks the job unsaved", "*" in page.locator(".doctab.on").first.inner_text())
    page.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(300)
    # Find Similar Objects on a via: every via selected
    page.mouse.move(*page.evaluate(TO_SCREEN, page.evaluate(W, [35.6, 15])))
    page.keyboard.press("Shift+F")
    check("Shift+F opens Find Similar Objects", page.locator(".dlg.similar").count() == 1)
    shot(page, "30-find-similar.png")
    page.locator(".dlg-foot .btn", has_text="OK").click()
    check("matching vias selected", page.evaluate(f"[...{ED}.selection].every(k => k.startsWith('Vias6'))") and page.evaluate(f"{ED}.selection.size") >= 3)
    # Drag a free via: its tracks follow
    vx, vy = page.evaluate(TO_SCREEN, page.evaluate(W, [35.6, 15]))
    page.mouse.click(vx, vy)
    page.mouse.move(vx, vy); page.mouse.down(); page.mouse.move(vx - 40, vy + 30, steps=5)
    shot(page, "31-drag-via.png")
    page.mouse.up()
    to = page.evaluate(f"(() => {{ const v = {ED}.doc.prims.filter(p => p.kind === 'via').map(p => p.at); return v; }})()")
    joined = page.evaluate(f"(() => {{ const vs = {ED}.doc.prims.filter(p => p.kind === 'via'); return vs.every(v => {ED}.doc.prims.filter(t => t.kind === 'track' && t.polygon === 65535 && ((t.a.x === v.at.x && t.a.y === v.at.y) || (t.b.x === v.at.x && t.b.y === v.at.y))).length >= 2); }})()")
    check("dragged via keeps its tracks attached", joined and page.evaluate(f"{ED}.undo.undoLabel") == "Drag Via")
    page.keyboard.press("Control+z")
    # Place › Via on a track takes its net; Place › String; Place › Fill by two corners
    page.mouse.move(600, 400); page.keyboard.press("Control+PageDown"); page.wait_for_timeout(100)
    VIA_NETS = f"{ED}.doc.prims.filter(p => p.kind === 'via').map(p => p.net)"
    v0 = page.evaluate(VIA_NETS)
    tr = page.evaluate(f"(() => {{ const t = {ED}.doc.prims.find(p => p.kind === 'track' && p.net !== 65535 && p.layer === 1 && p.polygon === 65535 && p.component === 65535); return [ (t.a.x + t.b.x) / 2, (t.a.y + t.b.y) / 2, t.net ]; }})()")
    page.mouse.move(*page.evaluate(TO_SCREEN, tr[:2])); page.keyboard.press("p"); page.keyboard.press("v")
    page.mouse.click(*page.evaluate(TO_SCREEN, tr[:2])); page.mouse.click(*page.evaluate(TO_SCREEN, tr[:2]), button="right")
    v1 = page.evaluate(VIA_NETS)
    check(f"P,V on a track places a via on its net ({v1[len(v0):]} = {tr[2]})", len(v1) == len(v0) + 1 and tr[2] in v1[len(v0):] if len(v1) > len(v0) else False)
    page.keyboard.press("p"); page.keyboard.press("s")
    page.mouse.click(*page.evaluate(TO_SCREEN, page.evaluate(W, [5, 3]))); page.mouse.click(*page.evaluate(TO_SCREEN, page.evaluate(W, [5, 3])), button="right")
    check("P,S places a String on the current layer", page.evaluate(f"{ED}.doc.prims.some(p => p.kind === 'text' && p.text === 'String' && p.layer === {ED}.currentLayer)"))
    page.keyboard.press("p"); page.keyboard.press("f")
    page.mouse.click(*page.evaluate(TO_SCREEN, page.evaluate(W, [33, 2]))); page.mouse.click(*page.evaluate(TO_SCREEN, page.evaluate(W, [36, 4])))
    page.mouse.click(*page.evaluate(TO_SCREEN, page.evaluate(W, [36, 4])), button="right")
    check("P,F places a fill by two corners", page.evaluate(f"{ED}.undo.undoLabel") == "Place fill")
    n0 = page.evaluate(f"{ED}.doc.components.length")
    page.keyboard.press("p"); page.keyboard.press("c")
    check("P,C opens AD17's Place Component (Footprint placement)", page.locator(".dlg.placecomp").count() == 1 and page.locator(".placecomp .pc-type input").first.is_checked())
    check("Place Component: the Component placement type is there to choose (26.110)", page.locator(".placecomp .pc-type input:disabled").count() == 0)
    page.locator(".placecomp .pc-more[aria-label='Browse Libraries']").click(); page.wait_for_timeout(200)
    check("... opens Browse Libraries with the project's footprints", "SOT-223" in page.locator(".browselib .grid-body").inner_text() and page.locator(".browselib .fp-preview").count() == 1)
    page.locator(".browselib .grid-row", has_text="SOT-223").first.click()
    page.locator(".browselib .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(100)
    check("the footprint chosen comes back to Place Component", page.input_value("#pc-footprint") == "SOT-223")
    page.locator(".placecomp .dlg-foot .btn", has_text="OK").click()
    page.mouse.move(*page.evaluate(TO_SCREEN, page.evaluate(W, [8, 12]))); page.mouse.click(*page.evaluate(TO_SCREEN, page.evaluate(W, [8, 12])))
    page.mouse.click(*page.evaluate(TO_SCREEN, page.evaluate(W, [8, 12])), button="right")
    comp = page.evaluate(f"{ED}.doc.components.at(-1)")
    check(f"component placed from the footprint library ({comp['designator']} {comp['pattern']})", page.evaluate(f"{ED}.doc.components.length") == n0 + 1 and comp["pattern"] == "SOT-223")
    shot(page, "38-pcb-placed.png")
    for _ in range(4): page.keyboard.press("Control+z")
    check("undo the via, string, fill and component", page.evaluate(VIA_NETS) == v0 and page.evaluate(f"{ED}.doc.components.length") == n0)
    page.locator(".doctab").nth(0).click(); page.wait_for_timeout(300)
    # Copy and paste a part: its designator resets to R? (Reset Parts Designators On Paste); T,A,U annotates it quietly
    DES = f"{ED}.doc.objects.filter(o => o.kind === 'component').map(o => o.designator)"
    n0 = len(page.evaluate(DES))
    r1 = page.evaluate(f"(() => {{ const o = {ED}.doc.objects.find(o => o.kind === 'component' && o.designator === 'R1'); return [o.index, o.at.x, o.at.y]; }})()")
    page.evaluate(f"{ED}.select(['o{r1[0]}'])")
    page.evaluate(f"{ED}.zoomToBox({ED}.boundsOf(['o{r1[0]}']), 30000000)"); page.wait_for_timeout(150)
    page.mouse.move(*page.evaluate(TO_SCREEN, r1[1:]))
    page.keyboard.press("Control+c")
    # Clipboard Reference (on by default): copying asks for the reference point
    check("Ctrl+C asks for the clipboard reference point", "reference point" in page.locator(".statusbar .hint").inner_text())
    page.mouse.click(*page.evaluate(TO_SCREEN, r1[1:]))
    vb = page.locator(".viewport").bounding_box()
    px, py = vb["x"] + vb["width"] * 0.3, vb["y"] + 90
    page.keyboard.press("Control+v")
    page.mouse.move(px, py, steps=3); page.mouse.click(px, py)
    des = page.evaluate(DES)
    check(f"pasted part gets R? ({des[-1] if des else None})", len(des) == n0 + 1 and des[-1] == "R?" and page.evaluate(f"{ED}.tool.id") == "select")
    page.mouse.move(cx, cy)
    page.keyboard.press("t"); page.keyboard.press("a")
    shot(page, "32-tools-annotation.png")
    page.keyboard.press("u")
    page.wait_for_timeout(200)
    des = page.evaluate(DES)
    check(f"T,A,U annotates quietly ({des[-1]})", des[-1] == "R2" and page.evaluate(f"{ED}.undo.undoLabel") == "Annotate schematics quietly")
    page.keyboard.press("Control+z"); page.keyboard.press("Control+z")
    check("undo the annotation, then the paste", len(page.evaluate(DES)) == n0)
    # Place › Net Label (P, N): two labels, the second stepped on; Tab edits the next one
    vb = page.locator(".viewport").bounding_box()
    spot = lambda fx, fy: (vb["x"] + vb["width"] * fx, vb["y"] + vb["height"] * fy)
    NL = f"{ED}.doc.objects.filter(o => o.kind === 'text' && o.role === 'netlabel').map(o => o.text)"
    nl0 = page.evaluate(NL)
    page.mouse.move(*spot(0.3, 0.2)); page.keyboard.press("p"); page.keyboard.press("n")
    page.mouse.click(*spot(0.3, 0.2)); page.mouse.click(*spot(0.4, 0.2))
    page.keyboard.press("Tab")
    check("Tab while placing opens the Net Label dialog", page.locator(".dlg[aria-label='Net Label']").count() == 1)
    page.locator(".dlg[aria-label='Net Label'] .dlg-field", has_text="Net").locator("input").fill("SDA")
    page.locator(".dlg-foot .btn", has_text="OK").click()
    page.mouse.move(*spot(0.5, 0.2)); page.mouse.click(*spot(0.5, 0.2))
    shot(page, "37-net-labels.png")
    page.mouse.click(*spot(0.5, 0.2), button="right")
    added = page.evaluate(NL)[len(nl0):]
    check(f"P,N places NetLabel1, NetLabel2, then SDA from Tab ({added})", added == ["NetLabel1", "NetLabel2", "SDA"] and page.evaluate(f"{ED}.tool.id") == "select")
    page.locator(".tbtn[data-cmd='place.gnd']").click()
    page.mouse.move(*spot(0.6, 0.2)); page.mouse.click(*spot(0.6, 0.2)); page.mouse.click(*spot(0.6, 0.2), button="right")
    check("GND from the Wiring toolbar", page.evaluate(f"{ED}.doc.objects.at(-1).kind") == "power" and page.evaluate(f"{ED}.doc.objects.at(-1).text") == "GND")
    page.mouse.move(*spot(0.3, 0.3)); page.keyboard.press("p"); page.keyboard.press("r")
    page.mouse.click(*spot(0.3, 0.3)); page.mouse.move(*spot(0.45, 0.3)); page.mouse.click(*spot(0.45, 0.3)); page.mouse.click(*spot(0.45, 0.3), button="right")
    check("P,R places Port1 by its two ends", page.evaluate(f"{ED}.doc.objects.at(-1).kind") == "port" and page.evaluate(f"{ED}.doc.objects.at(-1).name") == "Port1")
    COMPS = f"{ED}.doc.objects.filter(o => o.kind === 'component').map(o => o.libRef + ':' + o.designator)"
    c0 = page.evaluate(COMPS)
    page.mouse.move(*spot(0.6, 0.35)); page.keyboard.press("p"); page.keyboard.press("p")
    check("P,P opens AD17's Place Part (Physical Component, History, Choose)", page.locator(".dlg.placepart2").count() == 1 and all(t in page.locator(".placepart2").inner_text() for t in ["Physical Component", "History", "Choose", "Logical Symbol", "Database Table"]))
    page.locator("#pp-choose").click(); page.wait_for_timeout(150)
    check("Choose opens Browse Libraries with the project's schematic library", page.locator(".dlg.schbrowse").count() == 1 and "LDO SOT-223" in page.locator(".schbrowse .grid-body").first.inner_text())
    page.locator(".schbrowse .grid-row", has_text="LDO SOT-223").click()
    shot(page, "39-place-part.png")
    page.locator(".schbrowse .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(100)
    check("the part chosen comes back to Place Part", page.locator("#pp-physical").input_value() == "LDO SOT-223")
    page.locator(".placepart2 .dlg-foot .btn", has_text="OK").click()
    page.mouse.move(*spot(0.6, 0.35)); page.mouse.click(*spot(0.6, 0.35)); page.mouse.click(*spot(0.6, 0.35), button="right")
    c1 = page.evaluate(COMPS)
    pins = page.evaluate(f"(() => {{ const d = {ED}.doc; const c = d.objects.filter(o => o.kind === 'component').at(-1); return d.objects.filter(o => o.kind === 'pin' && o.owner === c.index).length; }})()")
    check(f"part placed from the library with its pins ({c1[len(c0):]}, {pins} pins)", c1[len(c0):] == ["LDO SOT-223:U?"] and pins == 4)
    for _ in range(6): page.keyboard.press("Control+z")
    check("undo takes the placed objects away", page.evaluate(NL) == nl0 and page.evaluate(COMPS) == c0)
    # Right-click outside the documents: tabs, Projects tree, toolbars, panel title bars
    page.locator(".doctab").nth(0).click(button="right")
    check("tab right-click: Close Current, Hide Current …", all(t in page.locator(".menu-popup").inner_text() for t in ["Close Current", "Close All Documents", "Hide Current"]))
    shot(page, "35-tab-menu.png")
    page.locator(".menu-popup .menu-item", has_text="Hide Current").click(); page.wait_for_timeout(150)
    hidden_ok = page.locator(".doctab", has_text="Demo.SchDoc").count() == 0
    page.locator(".tree-doc", has_text="Demo.SchDoc").click(); page.wait_for_timeout(200)
    check("Hide Current takes the tab away; the Projects panel brings it back", hidden_ok and page.locator(".doctab.on").inner_text().startswith("Demo.SchDoc"))
    page.locator(".tree-project-row", has_text="Demo.PrjPcb").click(button="right")
    check("project right-click: Compile PCB Project Demo.PrjPcb …", "Compile PCB Project Demo.PrjPcb" in page.locator(".menu-popup").inner_text())
    shot(page, "36-project-menu.png")
    page.keyboard.press("Escape")
    page.locator(".toolbars").click(button="right", position={"x": 2, "y": 2})
    check("toolbar right-click lists the toolbars", all(t in page.locator(".menu-popup").inner_text() for t in ["Schematic Standard", "Wiring", "Utilities", "Customise"]))
    page.keyboard.press("Escape")
    page.locator(".panel-head", has_text="Projects").click(button="right")
    check("panel title right-click: Close 'Projects', Allow Dock", "Close 'Projects'" in page.locator(".menu-popup").inner_text())
    page.keyboard.press("Escape")
    # Menu bar, DXP menu, toolbar dropdown
    page.keyboard.press("Alt+t")
    check("Alt+T opens Tools from the menu bar", page.locator(".menubar-item.open").inner_text().strip() == "Tools")
    page.locator(".menu-popup .menu-item", has_text="Annotation").hover(); page.wait_for_timeout(100)
    check("Tools › Annotation cascades with Annotate Schematics Quietly", "Annotate Schematics Quietly" in page.locator(".menu-popup[data-depth='1']").inner_text())
    shot(page, "33-menubar-cascade.png")
    page.keyboard.press("Escape")
    check("logo is Konium Designer's, in the menu bar and the tab", page.locator(".brand").get_attribute("title") == "Konium Designer"
          and page.evaluate("document.querySelector('link[rel=icon]').href.startsWith('data:image/svg+xml')"))
    page.locator(".brand").click()
    check("logo opens DXP (Preferences, Customise)", "Preferences" in page.locator(".menu-popup").inner_text() and "Customise" in page.locator(".menu-popup").inner_text())
    page.keyboard.press("Escape")
    page.locator(".tbar[data-bar='sch.utilities'] .tbtn-drop").nth(1).click()
    check("Utilities › Alignment Tools dropdown", "Align Left" in page.locator(".menu-popup").inner_text())
    shot(page, "34-align-dropdown.png")
    page.keyboard.press("Escape")
    size100 = page.evaluate(f"{ED}.scene().ordered().flatMap(g => g.texts)[0].size")
    page.locator(".menubar-icon[aria-label=Preferences]").click()
    check("Preferences opens from the gear", page.locator(".prefs").count() == 1)
    npages = page.locator(".prefs-page").count()
    ptext = page.locator(".prefs").inner_text()
    check(f"Preferences: AD's page tree ({npages} pages: System, Data Management, Schematic, PCB Editor, Text Editors), no 'Altium'",
          npages == 46 and all(g in ptext for g in ["Data Management", "Board Insight Display", "Break Wire", "Port Cross References"]) and "Altium" not in ptext)
    page.locator(".prefs-page", has_text="Break Wire").click()
    check("Break Wire page drives the tool settings", page.locator(".prefs-page-body .pref-row").count() >= 4)
    page.locator(".prefs-page", has_text="Interactive Routing").click()
    check("Interactive Routing: nothing greyed as not built (26.104)", page.locator(".prefs-page-body .pref-todo[title='Not in Konium Designer yet']").count() == 0 and page.locator(".prefs-page-body .pref-row").count() > 10)
    # 26.080: PCB Editor › Display › Layer Drawing Order, AD's (forum: mechanical layers drawn over the silkscreen)
    page.locator(".prefs-page").filter(has_text=re.compile(r"^Display$")).first.click(); page.wait_for_timeout(100)
    page.locator(".prefs-page-body .btn", has_text="Layer Drawing Order...").click(); page.wait_for_timeout(200)
    order = page.locator(".dlg.layer-order .as-item").all_inner_texts()
    page.locator(".dlg.layer-order .as-item", has_text="Mechanical Layers").click()
    page.locator(".dlg.layer-order .btn", has_text="Promote").click()
    moved = page.locator(".dlg.layer-order .as-item").all_inner_texts()
    page.locator(".dlg.layer-order .btn", has_text="Cancel").click(); page.wait_for_timeout(100)
    check(f"PCB Editor › Display › Layer Drawing Order: AD's ({len(order)} kinds, {order[0]} … {order[-1]}), Promote moves one up",
          order[:6] == ["Multi Layer", "Top Overlay", "Bottom Overlay", "Connect Layer", "Current Layer", "Signal Layers"] and order[-3:] == ["Mechanical Layers", "Drill Drawing", "Visible Grids"]
          and moved[12:14] == ["Mechanical Layers", "Keep Out Layer"] and page.evaluate("window.konium.prefs.get().pcbLayerDrawOrder[13]") == "mech")
    page.locator(".prefs-page").filter(has_text="General").nth(1).click()
    page.locator("#pref-schTextScale").fill("0.6")
    page.locator(".dlg-foot .btn", has_text="Apply").click()
    page.wait_for_timeout(200)
    shot(page, "13-preferences.png")
    size60 = page.evaluate(f"{ED}.scene().ordered().flatMap(g => g.texts)[0].size")
    check(f"schematic text scale applies ({size100:.0f} -> {size60:.0f})", abs(size60 / size100 - 0.6) < 0.01)
    page.locator(".prefs-search").first.fill("grid")
    check("settings search finds grid options", page.locator(".prefs-page-body .pref-row").count() >= 3)
    page.locator(".prefs-search").first.fill("")
    page.locator(".prefs-page", has_text="Keyboard Shortcuts").click()
    page.locator(".shortcut-table tr", has_text="Fit Document").first.locator(".combo").click()
    page.wait_for_selector(".capture")
    page.locator(".capture").press("Control+k")
    page.wait_for_timeout(150)
    check("shortcut rebound to Ctrl+K", "Ctrl+K" in page.locator(".shortcut-table tr", has_text="Fit Document").first.inner_text())
    shot(page, "14-keyboard.png")
    page.locator(".prefs-page", has_text="Layer Colours").click()
    page.locator(".layer-colour", has_text="Top Layer").locator("input[type=color]").fill("#00ff00")
    check("layer colour staged until Apply", page.evaluate("JSON.parse(localStorage.getItem('konium.settings.v2') || '{}').layerColours?.['1'] ?? null") is None)
    page.locator(".dlg-foot .btn", has_text="Apply").click()
    check("layer colour override stored on Apply", page.evaluate("JSON.parse(localStorage.getItem('konium.settings.v2')).layerColours['1']") == "#00ff00")
    shot(page, "15-layer-colours.png")
    page.locator(".dlg-foot .btn", has_text="Set To Defaults").click()
    page.locator(".dropdown-menu button", has_text="All").last.click()
    page.locator(".dlg-foot .btn", has_text="OK").click()
    check("Set To Defaults › All, OK clears overrides", page.evaluate("JSON.parse(localStorage.getItem('konium.settings.v2')).shortcuts['view.fit']") is None and page.locator(".prefs").count() == 0)
    page.evaluate("window.konium.prefs.set({ projExpand: 'full', layoutPerKind: false, groupTabs: false })")  # (the Projects tree open again, as the rest of this run expects)

    # Reports › Bill of Materials, Edit › Origin, Design › Redefine Board Shape, the schematic library editor
    page.locator(".doctab", has_text="Demo.PcbDoc").click(); page.wait_for_timeout(300)
    page.keyboard.press("Alt+r")
    page.locator(".menu-popup .menu-item", has_text="Bill of Materials").click()
    rows = page.locator(".bom-scroll tbody tr").count()
    check(f"Reports › Bill of Materials lists the parts grouped ({rows} lines)", page.locator(".bom").count() == 1 and rows == 6 and "LDO 3V3" in page.locator(".bom-scroll").inner_text())
    shot(page, "40-bom.png")
    page.locator(".bom .dlg-foot .btn", has_text="Cancel").click()
    o0 = page.evaluate(f"{ED}.doc.board.origin")
    page.mouse.move(cx, cy)
    page.keyboard.press("e"); page.keyboard.press("o"); page.keyboard.press("s")
    page.mouse.click(cx + 60, cy + 40)
    o1 = page.evaluate(f"{ED}.doc.board.origin")
    check("Edit › Origin › Set moves the relative origin", o1 != o0 and page.evaluate(f"{ED}.doc.dirty.has('Board6')"))
    page.keyboard.press("Control+z")
    page.keyboard.press("Alt+d")
    page.locator(".menu-popup .menu-item", has_text="Redefine Board Shape").click()
    for (dx, dy) in [(-220, -130), (220, -130), (220, 130), (-220, 130)]: page.mouse.click(cx + dx, cy + dy)
    page.mouse.click(cx - 220, cy + 130, button="right")
    nv = page.evaluate(f"{ED}.doc.board.vertices.length")
    check(f"Design › Redefine Board Shape draws a new outline ({nv} vertices)", nv == 4)
    shot(page, "41-board-shape.png")
    page.keyboard.press("Control+z")
    # Route › Un-Route › All, undone; Reports › Board Information
    routed = f"{ED}.doc.prims.filter(p => (p.kind === 'track' || p.kind === 'via') && p.net !== 65535 && p.polygon !== undefined ? p.polygon === 65535 && p.component === 65535 : p.kind === 'via' && p.net !== 65535).length"
    r0 = page.evaluate(routed)
    page.evaluate("window.konium.run('ad:PCB:UnRouteAll')"); page.wait_for_timeout(200)
    r1 = page.evaluate(routed)
    page.keyboard.press("Control+z"); page.wait_for_timeout(150)
    check(f"Route › Un-Route › All takes the routing away, undo brings it back ({r0} -> {r1} -> {page.evaluate(routed)})", r0 > 0 and r1 == 0 and page.evaluate(routed) == r0)
    page.evaluate("window.konium.run('ad:PCB:ReportBoardInformation')"); page.wait_for_timeout(200)
    check("Reports › Board Information shows the board's counts", "Board Information Report for Demo.PcbDoc" in page.locator(".report-text").inner_text())
    page.locator(".dlg.report .dlg-foot .btn", has_text="Close").click()
    page.evaluate("window.konium.run('ad:PCB:DesignOptions')"); page.wait_for_timeout(200)
    page.locator(".boardoptions .do-check", has_text="Snap On All Layers").locator("input").check()
    # 26.109: every snap switch live, Grids... and Guides... open their managers over the dialog
    page.locator(".boardoptions .do-check", has_text="Snap To Linear Guides").locator("input").check()
    bo_off = page.locator(".boardoptions input:disabled, .boardoptions select:disabled, .boardoptions button:disabled").count()
    page.locator(".boardoptions .dlg-foot .btn", has_text="Guides...").click(); page.wait_for_timeout(200)
    gm = page.locator(".dlg", has_text="Guide Manager").count()
    page.locator(".dlg", has_text="Guide Manager").locator(".dlg-foot .btn", has_text="Cancel").click(); page.wait_for_timeout(150)
    check(f"Board Options (26.109): nothing greyed ({bo_off}), Guides... opens the Guide Manager over it", bo_off == 0 and gm >= 1 and page.locator(".boardoptions").count() == 1)
    shot(page, "41b-board-options.png")
    page.locator(".boardoptions .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(150)
    check("…and Snap To Linear Guides is kept as MGSNAPENABLED", page.evaluate(f"{ED}.doc.board.bag.get('MGSNAPENABLED')") == "TRUE" and page.evaluate(f"{ED}.snapLinearGuides") is True)
    # Tools › Component Placement › Position Component Text, Re-Annotate, Applicable Unary Rules
    page.evaluate(f"{ED}.selectComponent(0)")
    page.evaluate("window.konium.run('ad:PCB:AutopositionComponentTexts')"); page.wait_for_timeout(200)
    page.locator(".ctp input[aria-label='Designator Bottom-Centre']").check()
    page.locator(".ctp .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(200)
    check("Position Component Text: the designator goes below the part (NAMEAUTOPOSITION 6)", page.evaluate(f"{ED}.doc.components[0].bag.get('NAMEAUTOPOSITION')") == "6")
    page.keyboard.press("Control+z")
    page.evaluate("window.konium.run('ad:PCB:ReAnnotate')"); page.wait_for_timeout(200)
    check("Tools › Re-Annotate shows the renames per order", page.locator(".dlg.reannotate").count() == 1)
    page.locator(".reannotate .do-check", has_text="Name from Position").locator("input").check(); page.wait_for_timeout(150)
    check("Re-Annotate › 5 Name from Position names each part from where it is (26.109)", page.locator(".reannotate input:disabled").count() == 0 and "_" in page.locator(".reannotate .ra-list").inner_text())
    shot(page, "41c-reannotate.png")
    page.locator(".reannotate .dlg-foot .btn", has_text="Cancel").click()
    page.evaluate(f"(() => {{ const e = {ED}; const t = e.doc.prims.find(p => p.kind === 'track' && p.component === 65535); e.contextKey = t.src.storage + ':' + t.src.index; }})()")
    page.evaluate("window.konium.run('ad:PCB:PopupRightMouseUnaryRules')"); page.wait_for_timeout(200)
    check("right-click › Applicable Unary Rules lists the track's width rule", "Width" in page.locator(".dlg.applicable").inner_text())
    page.locator(".applicable .dlg-foot .btn", has_text="Close").click()
    page.evaluate("window.konium.run('ad:PCB:EditNets')"); page.wait_for_timeout(200)
    check("Design › Netlist › Edit Nets lists the nets and the focused net's pins", page.locator(".netmgr .nm-list").nth(1).locator(".grid-row:not(.grid-head)").count() >= 3
          and page.locator(".netmgr .nm-list").nth(2).locator(".grid-row:not(.grid-head)").count() >= 1)
    shot(page, "41d-netlist-manager.png")
    page.locator(".netmgr .dlg-foot .btn", has_text="Close").click()
    page.keyboard.press("Control+q"); page.wait_for_timeout(200)
    check("Ctrl+Q opens Selection Memory", page.locator(".dlg.selmem").count() == 1)
    page.locator(".selmem .dlg-foot .btn", has_text="Close").click()
    check("Design › Board Options writes the snap options to the board", page.evaluate(f"{ED}.doc.board.bag.get('ELECTRICALGRIDUSEALLLAYERS')") == "TRUE"
          and page.evaluate(f"{ED}.hotspotAllLayers") is True)
    page.keyboard.press("Control+z")
    # Tools › Component Wizard: an SOP8 from the defaults, previewed, added and shown
    page.locator(".doctab", has_text="Demo1.PcbLib").click(); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('ad:CompMake:RunWizard')"); page.wait_for_timeout(200)
    page.locator(".compwizard select[aria-label=Pattern]").select_option("sop"); page.wait_for_timeout(150)
    check("Component Wizard previews the package (8 pads)", page.locator(".compwizard .fp-preview rect").count() >= 9)
    shot(page, "43-component-wizard.png")
    page.locator(".compwizard .dlg-foot .btn", has_text="Finish").click(); page.wait_for_timeout(300)
    check(f"…Finish adds SOP8 with 8 pads ({page.evaluate(f'{ED}.entry.name')})", page.evaluate(f"{ED}.entry.name") == "SOP8"
          and page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'pad').length") == 8)
    # Edit › Set Reference › Centre: the origin goes to the middle of the footprint
    page.evaluate("window.konium.run('ad:PCB:SetComponentReferenceCenter')"); page.wait_for_timeout(150)
    c = page.evaluate(f"{ED}.centre()")
    check(f"Set Reference › Centre puts the origin in the middle ({c})", abs(c["x"]) < 2 and abs(c["y"]) < 2)
    page.keyboard.press("Control+z"); page.keyboard.press("Control+z")
    # Place › 3D Body: settings first, then the outline; the dialog comes back for the next one
    nb = lambda: page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'body').length")
    b0 = nb()
    page.mouse.move(cx, cy); page.evaluate("window.konium.run('ad:PCB:PlaceComponentBody')"); page.wait_for_timeout(200)
    check("Place › 3D Body asks for the body's settings first", page.locator(".dlg.body3d").count() == 1)
    page.locator(".body3d .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(100)
    for (dx, dy) in [(-80, -60), (80, -60), (80, 60), (-80, 60)]: page.mouse.click(cx + dx, cy + dy)
    page.mouse.click(cx - 80, cy + 60, button="right"); page.wait_for_timeout(200)
    b1 = nb()
    check(f"…clicks and a right-click place it, then it asks for the next ({b0} -> {b1})", b1 == b0 + 1 and page.locator(".dlg.body3d").count() == 1)
    page.locator(".body3d .dlg-foot .btn", has_text="Cancel").click(); page.wait_for_timeout(100)
    shot(page, "45-3d-body.png")
    page.evaluate("window.konium.run('ad:PCB:ManageSingleComponentBodies')"); page.wait_for_timeout(200)
    ins = page.locator(".bodymanager .bm-state.in").count(); outs = page.locator(".bodymanager .bm-state:not(.in)").count()
    check(f"Tools › Manage 3D Bodies for Current Component: the bodies In Component, the shapes Not In ({ins}/{outs})", ins == b1 and outs >= 2
          and page.locator(".bodymanager .bm-desc", has_text="Shape created from bounding rectangle on All Layers").count() == 1)
    page.locator(".bodymanager .bm-state:not(.in)").first.click(); page.wait_for_timeout(150)
    check(f"…Body State: Not In Component adds that body ({nb()})", nb() == b1 + 1 and page.locator(".bodymanager .bm-state.in").count() == ins + 1)
    shot(page, "46-body-manager.png")
    page.locator(".bodymanager .dlg-foot .btn", has_text="Close").click(); page.wait_for_timeout(100)
    page.keyboard.press("Control+z"); page.keyboard.press("Control+z")
    check("…both undo", nb() == b0)
    # Place › Keepout › Fill
    page.mouse.move(cx, cy); page.evaluate("window.konium.run('ad:PCB:PlaceKeepoutFill')"); page.wait_for_timeout(100)
    page.mouse.click(cx - 40, cy - 40); page.mouse.click(cx + 40, cy + 40); page.wait_for_timeout(150)
    check("Place › Keepout › Fill places a keepout fill", page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'fill' && p.keepout).length") == 1)
    page.keyboard.press("Escape"); page.keyboard.press("Control+z")
    page.locator(".tree-doc", has_text="Demo.SchLib").dblclick(); page.wait_for_timeout(800)
    check("Demo.SchLib opens in the library editor with the SCH Library panel", page.evaluate("window.konium.state.activeScope.value") == "schlib"
          and page.locator(".panel.schlib").count() == 1 and page.locator(".dlg").count() == 0)
    page.locator(".schlib .grid-row", has_text="LM358").click(); page.wait_for_timeout(200)
    pins0 = page.locator(".schlib .pcblib-prims .grid-row:not(.grid-head)").count()
    page.mouse.move(cx, cy); page.keyboard.press("p"); page.keyboard.press("p")
    PINS = f"{ED}.doc.objects.filter(o => o.kind === 'pin').map(o => [o.designator, o.at.x, o.at.y])"
    page.mouse.move(cx - 150, cy + 150); page.mouse.click(cx - 150, cy + 150); page.wait_for_timeout(50)
    # Each pin steps the cursor a grid down; a click without moving the mouse, or Enter, places there
    page.mouse.click(cx - 150, cy + 150); page.wait_for_timeout(50); page.keyboard.press("Enter"); page.wait_for_timeout(50)
    page.mouse.click(cx - 150, cy + 150, button="right")
    page.wait_for_timeout(200)
    pins1 = page.locator(".schlib .pcblib-prims .grid-row:not(.grid-head)").count()
    last3, grid = page.evaluate(PINS)[-3:], page.evaluate(f"{ED}.gridSize()")
    check(f"P, P places pins on the part shown, the cursor a grid down after each, the number counting up ({pins0} -> {pins1}; {last3})", pins1 == pins0 + 3
          and len({x for _, x, _ in last3}) == 1 and [y - last3[0][2] for _, _, y in last3] == [0, -grid, -2 * grid]
          and [int(d) - int(last3[0][0]) for d, _, _ in last3] == [0, 1, 2])
    shot(page, "42-schlib.png")
    page.keyboard.press("t"); page.keyboard.press("i")
    check("T, I opens Library Component Properties", page.locator(".libcomp").count() == 1)
    page.keyboard.press("Escape")
    page.evaluate("window.konium.run('ad:Sch:ComponentRuleCheck')"); page.wait_for_timeout(150)
    check("Tools › Component Rule Check opens its dialog", page.locator(".dlg.rulecheck").count() == 1)
    page.locator(".rulecheck .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(200)
    check("…and reports in AD's ERR format", "Component Rule Check Report for : Demo.SchLib" in page.locator(".report-text").inner_text())
    page.locator(".dlg.report .dlg-foot .btn", has_text="Close").click()
    # Tools › Model Manager: give LM358 a second footprint
    page.evaluate("window.konium.run('ad:Sch:ModelManager')"); page.wait_for_timeout(200)
    page.locator(".modelmgr .mm-left .grid-row", has_text="LM358").first.click(); page.wait_for_timeout(100)
    page.locator(".modelmgr .dlg-foot .btn", has_text="Add Footprint").click(); page.wait_for_timeout(100)
    check("…Add Footprint opens the PCB Model dialog", page.locator(".dlg.pcbmodel").count() == 1)
    page.locator(".pcbmodel input[aria-label='Footprint name']").fill("SOIC8"); page.locator(".pcbmodel .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(200)
    check("Model Manager › Add Footprint adds SOIC8 to LM358", "SOIC8" in page.locator(".modelmgr .mm-right").inner_text())
    shot(page, "44-model-manager.png")
    page.locator(".modelmgr .dlg-foot .btn", has_text="Close").click()
    page.keyboard.press("Control+z")
    n0 = page.evaluate(f"{ED}.doc.objects.length")
    page.mouse.move(cx, cy); page.evaluate("window.konium.run('ad:Sch:PlaceIEEEClockSymbol')"); page.wait_for_timeout(100)
    page.mouse.move(cx + 40, cy + 40); page.mouse.click(cx + 40, cy + 40); page.mouse.click(cx + 40, cy + 40, button="right"); page.wait_for_timeout(150)
    check("Place › IEEE Symbols › Clock places an IEEE symbol", page.evaluate(f"{ED}.doc.objects.length") == n0 + 1 and page.evaluate(f"{ED}.doc.objects.at(-1).kind") == "ieee")
    page.keyboard.press("Control+z")
    page.evaluate("window.konium.run('ad:Sch:ToggleComponentAddMode')"); page.wait_for_timeout(100)
    check("Tools › Mode › Add makes a second display mode", page.evaluate(f"{ED}.modeCount") == 2 and page.evaluate(f"{ED}.mode") == 1)
    page.keyboard.press("Control+z")
    page.keyboard.press("Control+z")
    page.keyboard.press("Alt+h")
    page.locator(".menu-popup .menu-item", has_text="About").click()
    check("About says what Konium Designer is for", "not a replacement for Altium Designer" in page.locator(".about-body").inner_text())
    page.keyboard.press("Escape")
    show_panel(page, "projects")

    # Schematic: Inspector, Properties dialogs, Filter, List, Find Similar, Document Options
    page.locator(".tree-row", has_text="Demo.SchDoc").dblclick(); page.wait_for_timeout(400)
    page.keyboard.press("Escape")
    caps = page.evaluate(f"{ED}.doc.objects.filter(o => o.kind === 'component' && /^C/.test(o.designator)).map(o => 'o' + o.index)")
    page.evaluate(f"{ED}.select({json.dumps(caps)})")
    txt = inspector(page)
    check(f"Inspector with C1 and C2: shared rows, differing values as <...> ({len(caps)} parts)", len(caps) == 2 and "<...>" in txt and "2 object(s) are displayed in 1 document(s)" in txt)
    row = page.locator(".panel.inspector .insp-row", has_text="Lock Designator")
    row.locator("input[type=checkbox]").check()
    locked = page.evaluate(f"{json.dumps(caps)}.map(k => {ED}.doc.records[+k.slice(1) + 1].bag.bool('DESIGNATORLOCKED'))")
    check("Inspector edit applies to every selected part in one undo step", locked == [True, True] and page.evaluate(f"{ED}.undo.undoLabel") == "Change Lock Designator")
    page.keyboard.press("Control+z")
    check("…and undoes as one", page.evaluate(f"{json.dumps(caps)}.map(k => {ED}.doc.records[+k.slice(1) + 1].bag.bool('DESIGNATORLOCKED'))") == [False, False])
    shot(page, "50-sch-inspector.png")
    u1 = page.evaluate(f"(() => {{ const o = {ED}.doc.objects.find(o => o.kind === 'rect' && {ED}.doc.objects[o.owner]?.designator === 'U1'); return [(o.a.x+o.b.x)/2, (o.a.y+o.b.y)/2]; }})()")
    page.evaluate(f"{ED}.fit()"); page.wait_for_timeout(200)
    ux, uy = page.evaluate(TO_SCREEN, u1)
    page.mouse.dblclick(ux, uy); page.wait_for_timeout(300)
    check("double-click a part: Properties for Schematic Component", page.locator(".dlg.compprops").count() == 1)
    shot(page, "51-component-dialog.png")
    page.locator(".compprops .cp-mrow:not(.cp-ghead)").first.click()
    page.locator(".compprops .cp-models .btn", has_text="Edit...").click(); page.wait_for_timeout(300)
    check(f"Models › Edit opens the PCB Model dialog with the footprint drawn ({page.locator('.pcbmodel .pm-found').inner_text() if page.locator('.pcbmodel').count() else '-'})",
          page.locator(".dlg.pcbmodel").count() == 1 and page.locator(".pcbmodel .pm-preview .fp-preview").count() == 1 and "Found in:" in page.locator(".pcbmodel .pm-found").inner_text())
    shot(page, "51b-pcb-model.png")
    xs = [page.locator(f".pcbmodel input[aria-label='{n}']").bounding_box()["x"] for n in ["Library name", "Library path"]]
    page.locator(".pcbmodel .pm-lib", has_text="Library path").locator("input[type=radio]").check()
    check(f"PCB Library: the name and path boxes line up ({xs[0]:.0f}, {xs[1]:.0f}); Library path takes typing and Choose...",
          abs(xs[0] - xs[1]) < 1 and page.locator(".pcbmodel input[aria-label='Library path']").is_enabled() and page.locator(".pcbmodel .btn", has_text="Choose...").is_enabled())
    page.locator(".pcbmodel .dlg-foot .btn", has_text="Cancel").click(); page.wait_for_timeout(100)
    page.locator(".compprops .cp-row", has_text="Designator").locator("input[type=text]").fill("U7")
    page.locator(".compprops .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(200)
    check("component dialog renames U1 to U7", "U7" in page.evaluate(f"{ED}.doc.objects.filter(o => o.kind === 'component').map(o => o.designator)"))
    page.keyboard.press("Control+z")
    page.locator("#filter-query").count() or show_panel(page, "filter")
    show_panel(page, "filter")
    page.locator("#filter-query").fill("IsPart And (Designator Like 'C*')")
    page.locator(".schfilter .btn", has_text="Apply").click(); page.wait_for_timeout(200)
    check("SCH Filter: query selects C1, C2 and masks the rest", page.evaluate(f"{ED}.selection.size") == 2 and page.evaluate(f"{ED}.mask?.size") == 2)
    shot(page, "52-sch-filter.png")
    page.mouse.move(700, 400); page.keyboard.press("Shift+F12"); page.wait_for_timeout(200)
    check("Shift+F12 opens SCH List with the non-masked objects", page.locator(".panel.schlist").count() == 1 and "Objects" in page.locator(".schlist .insp-foot").inner_text())
    shot(page, "53-sch-list.png")
    page.mouse.move(700, 400); page.keyboard.press("Shift+c"); page.wait_for_timeout(100)
    check("Shift+C clears the filter mask", page.evaluate(f"{ED}.mask") is None)
    page.locator(".panel-btn[aria-label='Close SCH List']").click()
    page.evaluate(f"{ED}.fit()"); page.wait_for_timeout(200)
    ux, uy = page.evaluate(TO_SCREEN, u1)
    page.mouse.move(ux, uy); page.keyboard.press("Shift+f"); page.wait_for_timeout(300)
    check("Shift+F on a schematic: Find Similar Objects by Inspector properties", page.locator(".dlg.findsim").count() == 1 and "Object Specific" in page.locator(".dlg.findsim").inner_text())
    page.locator(".dlg.findsim .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(200)
    check("…Select, Mask Matching and Run Inspector: every part", page.evaluate(f"{ED}.selection.size") == 6 and page.evaluate(f"{ED}.mask?.size") == 6 and page.locator(".panel.inspector").count() == 1)
    page.mouse.move(700, 400); page.keyboard.press("Shift+c")
    page.keyboard.press("d"); page.keyboard.press("o"); page.wait_for_timeout(200)
    check("D, O opens Document Options", page.locator(".dlg.docopts").count() == 1)
    shot(page, "54-document-options.png")
    page.keyboard.press("Escape")
    n0 = page.evaluate(f"{ED}.doc.objects.length")
    page.mouse.move(700, 400); page.evaluate("window.konium.run('ad:Sch:PlaceDifferentialPair')"); page.wait_for_timeout(100)
    page.mouse.move(705, 400); page.mouse.click(705, 400); page.mouse.click(705, 400, button="right"); page.wait_for_timeout(150)
    placed = page.evaluate(f"{ED}.doc.objects.slice({n0}).map(o => o.kind + ':' + (o.name ?? o.text))")
    check(f"Place › Directives › Differential Pair: DIFFPAIR with DifferentialPair=True ({placed})", placed == ["directive:DIFFPAIR", "text:True"])
    page.mouse.dblclick(705, 400); page.wait_for_timeout(250)
    check("double-click a directive: its Parameters dialog (DifferentialPair = True)", page.locator(".dlg.directive").count() == 1
          and page.locator(".dlg.directive input[aria-label='DifferentialPair value']").input_value() == "True")
    page.locator(".dlg.directive select").last.select_option("1")
    page.locator(".dlg.directive .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(150)
    turned = page.evaluate(f"{ED}.doc.objects.slice({n0}).map(o => o.kind === 'directive' ? o.orient : o.at.x === {ED}.doc.objects[{n0}].at.x)")
    check(f"…Orientation 90 Degrees turns it, its parameter with it, one undo step ({turned})", turned == [1, True] and page.evaluate(f"{ED}.undo.undoLabel").startswith("Properties of"))
    page.keyboard.press("Control+z"); page.keyboard.press("Control+z")
    # A cascade near the right edge turns left and keeps going left; the pointer can cross the menu to reach it
    vb = page.locator(".viewport").bounding_box()
    page.mouse.click(vb["x"] + vb["width"] - 260, vb["y"] + 120, button="right"); page.wait_for_timeout(150)
    it = page.locator(".menu-popup[data-depth='0'] .menu-item").filter(has_text=re.compile(r"^Place(?! No)")).first.bounding_box()
    page.mouse.move(it["x"] + 20, it["y"] + 8, steps=3); page.wait_for_timeout(150)
    it = page.locator(".menu-popup[data-depth='1'] .menu-item", has_text="Directives").first.bounding_box()
    page.mouse.move(it["x"] + 20, it["y"] + 8, steps=3); page.wait_for_timeout(150)
    lv = [page.locator(f".menu-popup[data-depth='{d}']").bounding_box() for d in range(3)]
    t = page.locator(".menu-popup[data-depth='2'] .menu-item", has_text="Parameter Set").first.bounding_box()
    page.mouse.move(t["x"] + 30, t["y"] + 8, steps=12); page.wait_for_timeout(400)
    check(f"submenus at the right edge open leftwards, each left of the last, and stay open on the way in ({[round(b['x']) for b in lv]})",
          lv[1]["x"] < lv[0]["x"] and lv[2]["x"] < lv[1]["x"] and page.locator(".menu-popup").count() == 3)
    page.keyboard.press("Escape"); page.keyboard.press("Escape"); page.keyboard.press("Escape")
    page.evaluate("window.konium.run('ad:WorkspaceManager:ConfigureLibrarySynch')"); page.wait_for_timeout(200)
    rows = page.locator(".dlg.updatelib .grid-row:not(.grid-head)").count()
    check(f"Tools › Update From Libraries lists the sheet's parts ({rows})", page.locator(".dlg.updatelib").count() == 1 and rows >= 4)
    shot(page, "54a-update-from-libraries.png")
    page.keyboard.press("Escape")
    # Libraries panel (auto-hidden on the right), Tab while placing a part, Find Text / F3
    page.locator(".strip-right .strip-tab", has_text="Libraries").click(); page.wait_for_timeout(300)
    check("Libraries slides out from the right edge", page.locator(".dock-slide .panel.libraries").count() == 1)
    page.locator(".libraries .lib-pick select").select_option("Demo1.PcbLib"); page.wait_for_timeout(200)
    nfp = page.locator(".libraries .lib-list .grid-row:not(.grid-head)").count()
    check(f"Libraries lists a PCB library's footprints, previewed ({nfp})", nfp >= 1 and page.locator(".libraries .lib-preview .fp-preview").count() == 1)
    page.locator(".libraries .lib-pick select").select_option(index=0); page.wait_for_timeout(200)
    page.locator(".libraries .grid-row", has_text="LM358").first.click()
    shot(page, "55-libraries.png")
    page.locator(".libraries .btn.default").click(); page.wait_for_timeout(150)
    vb = page.locator(".viewport").bounding_box()
    page.mouse.move(vb["x"] + vb["width"] * 0.5, vb["y"] + vb["height"] * 0.25); page.keyboard.press("Tab"); page.wait_for_timeout(200)
    check("Tab while placing a part opens its Component Properties", page.locator(".dlg.compprops").count() == 1)
    page.locator(".compprops .cp-row", has_text="Designator").locator("input[type=text]").fill("U42")
    page.locator(".compprops .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(150)
    page.mouse.click(vb["x"] + vb["width"] * 0.5, vb["y"] + vb["height"] * 0.25); page.mouse.click(vb["x"] + vb["width"] * 0.5, vb["y"] + vb["height"] * 0.25, button="right")
    check("…and the part goes down as U42", "U42" in page.evaluate(f"{ED}.doc.objects.filter(o => o.kind === 'component').map(o => o.designator)"))
    page.keyboard.press("Control+z")
    page.mouse.move(vb["x"] + 40, vb["y"] + 40); page.keyboard.press("Control+f"); page.wait_for_timeout(150)
    page.locator(".findtext input[type=text]").first.fill("GND")
    page.locator(".findtext .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(300)
    first = page.evaluate(f"[...{ED}.selection]")
    page.keyboard.press("F3"); page.wait_for_timeout(200)
    second = page.evaluate(f"[...{ED}.selection]")
    check(f"Ctrl+F finds GND, F3 the next one ({first} → {second})", len(first) == 1 and len(second) == 1 and first != second
          and page.evaluate(f"{ED}.doc.records[+'{second[0]}'.slice(1) + 1].bag.get('TEXT')") == "GND" if second else False)
    show_panel(page, "projects")

    # Hierarchy: the demo's Symbols.SchDoc sheet symbol stands for Child.SchDoc
    page.locator(".tree-doc", has_text="Symbols.SchDoc").dblclick(); page.wait_for_timeout(500)
    page.evaluate(f"(() => {{ const ed = {ED}; ed.zoomToBox(ed.boundsOf(['o' + ed.doc.objects.find(o => o.kind === 'sheetsymbol').index]), 0); }})()"); page.wait_for_timeout(200)
    ENTRY = f"""(n) => {{ const ed = {ED}; const e = ed.doc.objects.find(o => o.kind === 'sheetentry' && o.name === n); const s = ed.doc.objects[e.owner];
      return [s.at.x + (e.side === 1 ? s.w - 1000000 : 1000000), s.at.y - e.distance]; }}"""
    sx, sy = page.evaluate(TO_SCREEN, page.evaluate(ENTRY, "InL"))
    page.mouse.click(sx, sy, button="right"); page.wait_for_timeout(150)
    ctx = page.locator(".menu-popup").first.inner_text()
    check("right-click on a sheet entry: Sheet Entry and Sheet Symbol Actions, no Port or Part Actions",
          "Sheet Entry Actions" in ctx and "Sheet Symbol Actions" in ctx and "Port Actions" not in ctx and "Part Actions" not in ctx)
    page.keyboard.press("Escape"); page.keyboard.press("Escape")
    page.mouse.move(sx, sy); page.keyboard.press("t"); page.keyboard.press("h")
    page.mouse.click(sx, sy); page.wait_for_timeout(600)
    # (the child sheet may still be opening on a busy machine)
    try: page.wait_for_function(f"window.konium.state.active.value.name === 'Child.SchDoc' && {ED}.selection.size > 0", timeout=4000)
    except Exception: pass
    sel = page.evaluate(f"[...{ED}.selection].map(k => {ED}.doc.objects[+k.slice(1)]).map(o => o.kind + ':' + o.name)")
    check(f"Up/Down Hierarchy: an entry goes down to its port on the child sheet ({sel})", page.evaluate("window.konium.state.active.value.name") == "Child.SchDoc" and sel == ["port:InL"])
    q = page.evaluate(f"(() => {{ const o = {ED}.doc.objects.find(o => o.kind === 'port' && o.name === 'OutL'); return [o.at.x + 200000, o.at.y]; }})()")
    qx, qy = page.evaluate(TO_SCREEN, q)
    page.mouse.click(qx, qy); page.wait_for_timeout(600)
    try: page.wait_for_function(f"window.konium.state.active.value.name === 'Symbols.SchDoc' && {ED}.selection.size > 0", timeout=4000)
    except Exception: pass
    sel = page.evaluate(f"[...{ED}.selection].map(k => {ED}.doc.objects[+k.slice(1)]).map(o => o.kind + ':' + o.name)")
    check(f"…and a port goes up to its sheet entry, the tool still on ({sel})", page.evaluate("window.konium.state.active.value.name") == "Symbols.SchDoc" and sel == ["sheetentry:OutL"]
          and page.evaluate(f"{ED}.tool.id") == "updown-hierarchy")
    page.keyboard.press("Escape")
    # 26.031: Ctrl+double-click the sheet symbol opens the child sheet, as AD
    page.wait_for_timeout(200)
    cx2, cy2 = page.evaluate(TO_SCREEN, page.evaluate(f"(() => {{ const s = {ED}.doc.objects.find(o => o.kind === 'sheetsymbol'); return [s.at.x + s.w / 2, s.at.y - s.h / 2]; }})()"))
    page.keyboard.down("Control"); page.mouse.dblclick(cx2, cy2); page.keyboard.up("Control"); page.wait_for_timeout(700)
    check(f"Ctrl+double-click on the sheet symbol opens its sheet ({page.evaluate('window.konium.state.active.value.name')})", page.evaluate("window.konium.state.active.value.name") == "Child.SchDoc")
    page.locator(".doctab", has_text="Symbols.SchDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('tools.erc')"); page.wait_for_timeout(300)
    check("after a compile, Projects still shows Child.SchDoc under Symbols.SchDoc",
          page.locator(".tree-hier", has_text="Symbols.SchDoc").locator(".tree-children .tree-doc", has_text="Child.SchDoc").count() == 1)
    check("hierarchical compile: every demo entry meets its port", "not linked" not in page.locator(".messages").inner_text() if page.locator(".messages").count() else True)

    # A new sheet: Place › Sheet Symbol (Tab names it), Add Sheet Entry, then make its child sheet
    page.evaluate("window.konium.cmdNewDocument('SchDoc')"); page.wait_for_timeout(500)
    newname = page.evaluate("window.konium.state.active.value.name")
    page.evaluate(f"{ED}.zoomToBox({{minX: 0, minY: 30000000, maxX: 50000000, maxY: 70000000}})"); page.wait_for_timeout(150)
    SC = lambda x, y: page.evaluate(TO_SCREEN, [x * 10000, y * 10000])
    x0, y0 = SC(1000, 6000); page.mouse.move(x0, y0)
    page.keyboard.press("p"); page.keyboard.press("s"); page.keyboard.press("Tab"); page.wait_for_timeout(200)
    labels = page.locator(".schprops .dlg-label").all_inner_texts()
    check(f"Tab while placing a sheet symbol: its dialog, Designator and Filename included", "Designator" in labels and "Filename" in labels)
    page.locator(".schprops .dlg-field", has_text="Designator").locator("input").fill("U_Power")
    page.locator(".schprops .dlg-field", has_text="Filename").locator("input").fill("Power.SchDoc")
    page.locator(".schprops button.default").click(); page.wait_for_timeout(100)
    page.mouse.click(x0, y0); x1, y1 = SC(2500, 5000); page.mouse.move(x1, y1); page.mouse.click(x1, y1)
    page.mouse.click(x1, y1, button="right")
    syms = page.evaluate(f"{ED}.doc.objects.filter(o => o.kind === 'sheetsymbol').map(o => [o.at.x / 10000, o.at.y / 10000, o.w / 10000, o.h / 10000])")
    # (a new sheet also holds AD17's 27 hidden document parameters)
    names = page.evaluate(f"{ED}.doc.objects.filter(o => o.kind === 'text' && o.owner >= 0).map(o => o.text)")
    check(f"two clicks place the symbol, named as set ({syms}, {names})", syms == [[1000, 6000, 1500, 1000]] and names == ["U_Power", "Power.SchDoc"])
    page.keyboard.press("p"); page.keyboard.press("a")
    mx, my = SC(1500, 5500); page.mouse.move(mx, my); page.mouse.click(mx, my)
    for (xx, yy) in ((1010, 5800), (1010, 5600), (2490, 5700)):
        ex, ey = SC(xx, yy); page.mouse.move(ex, ey); page.mouse.click(ex, ey)
    page.mouse.click(ex, ey, button="right"); page.mouse.click(ex, ey, button="right")
    ents = page.evaluate(f"{ED}.doc.objects.filter(o => o.kind === 'sheetentry').map(o => [o.name, o.side, o.distance / 10000])")
    check(f"Add Sheet Entry: entries slide to the nearest edge, names step on ({ents})", ents == [["Entry1", 0, 200], ["Entry2", 0, 400], ["Entry3", 1, 300]])
    shot(page, "17-sheet-symbol.png")
    sx, sy = SC(1700, 5300)
    page.mouse.click(sx, sy, button="right"); page.wait_for_timeout(150)
    page.locator(".menu-popup .menu-item", has_text="Sheet Symbol Actions").hover(); page.wait_for_timeout(200)
    page.locator(".menu-popup .menu-item", has_text="Create Sheet From Sheet Symbol").click(); page.wait_for_timeout(500)
    ports = page.evaluate(f"{ED}.doc.objects.filter(o => o.kind === 'port').map(o => o.name)")
    check(f"Create Sheet From Sheet Symbol: Power.SchDoc with a port per entry ({ports})", page.evaluate("window.konium.state.active.value.name") == "Power.SchDoc" and ports == ["Entry1", "Entry2", "Entry3"])
    page.locator(".doctab", has_text=newname).click(); page.wait_for_timeout(300)
    page.evaluate(f"(() => {{ const ed = {ED}; const s = ed.doc.objects.find(o => o.kind === 'sheetsymbol'); ed.select(['o' + s.index]); ed.contextKey = 'o' + s.index; }})()")
    page.evaluate("window.konium.run('ad:Sch:SynchronizeHierarchySheetSymbolWithContext')"); page.wait_for_timeout(200)
    sync = page.locator(".syncentries").inner_text()
    check("Synchronise Sheet Entries and Ports: all three matched", sync.count("Unspecified") == 6 and "U_Power" in sync)
    page.keyboard.press("Escape")
    page.evaluate("window.konium.run('reports.hierarchy')"); page.wait_for_timeout(200)
    rep = page.locator(".report-text").inner_text()
    check("Report Project Hierarchy lists U_Power → Power.SchDoc under the new sheet", f"   {newname}" in rep and "U_Power" in rep and "SCH (Power.SchDoc)" in rep)
    page.keyboard.press("Escape")

    # Everyday editing on Demo.SchDoc: Break Wire, Select Connection, Bring To Front, net colours, electrical grid, Lasso, memory
    page.locator(".doctab", has_text="Demo.SchDoc").click(); page.wait_for_timeout(300)
    w = page.evaluate(f"""(() => {{ const ed = {ED}; let best = null; for (const o of ed.doc.objects) if (o.kind === 'wire') for (let i = 1; i < o.pts.length; i++) {{
       const a = o.pts[i-1], b = o.pts[i]; if (a.y === b.y && Math.abs(b.x - a.x) > (best ? best.L : 0)) best = {{ i: o.index, L: Math.abs(b.x - a.x), a, b }}; }} return best; }})()""")
    mid = [(w["a"]["x"] + w["b"]["x"]) / 2, w["a"]["y"]]
    page.evaluate(f"{ED}.zoomToBox({{minX: {mid[0]} - 16000000, maxX: {mid[0]} + 16000000, minY: {mid[1]} - 9000000, maxY: {mid[1]} + 9000000}})"); page.wait_for_timeout(150)
    mx, my = page.evaluate(TO_SCREEN, mid)
    nw = lambda: page.evaluate(f"{ED}.doc.objects.filter(o => o.kind === 'wire').length")
    n0 = nw()
    page.mouse.move(mx, my); page.keyboard.press("e"); page.keyboard.press("w")
    page.mouse.move(mx + 2, my); page.mouse.move(mx, my)
    shot(page, "18-break-wire.png")
    page.mouse.click(mx, my); page.mouse.click(mx, my, button="right")
    check(f"Edit › Break Wire (E, W) cuts the wire in two ({n0} → {nw()})", nw() == n0 + 1)
    page.keyboard.press("Control+z")
    page.keyboard.press("e"); page.keyboard.press("s"); page.keyboard.press("c"); page.mouse.click(mx, my)
    kinds = page.evaluate(f"[...{ED}.selection].map(k => {ED}.doc.objects[+k.slice(1)].kind)")
    check(f"Select › Connection: the wire and what is joined to it ({kinds})", "wire" in kinds and len(kinds) >= 2)
    page.keyboard.press("Escape")
    # Net colours: Red on that net; F5 hides and shows the override
    page.evaluate("window.konium.run('sch.netColour.3')"); page.mouse.click(mx, my); page.mouse.click(mx, my, button="right")
    nc = page.evaluate(f"[...{ED}.netColours.entries()]")
    check(f"View › Set Net Colours › Red colours the net ({nc})", len(nc) == 1 and nc[0][1] == 0xff0000)
    shot(page, "19-net-colour.png")
    page.keyboard.press("F5")
    check("F5 hides the net colour override", page.evaluate("window.konium.state.active.value.editor.constructor.showNetColours") is False)
    page.keyboard.press("F5"); page.evaluate("window.konium.run('ad:Sch:ClearAllNetColors')")
    # Electrical grid: the wire tool's cursor jumps to a wire end within 40 mil, marked
    end = w["a"]
    ex, ey = page.evaluate(TO_SCREEN, [end["x"] + 250000, end["y"] + 200000])
    page.mouse.move(ex, ey); page.keyboard.press("p"); page.keyboard.press("w"); page.mouse.move(ex + 1, ey); page.mouse.move(ex, ey)
    hs = page.evaluate(f"{ED}.hotSpot")
    check(f"electrical grid: the wire tool snaps to a wire end nearby ({hs})", hs == end)
    page.keyboard.press("Shift+E"); page.mouse.move(ex + 1, ey); page.mouse.move(ex, ey)
    check("Shift+E turns the electrical grid off", page.evaluate(f"{ED}.hotSpot") is None and page.evaluate(f"{ED}.electricalGrid") is False)
    page.keyboard.press("Shift+E"); page.keyboard.press("Escape")
    # Bring To Front (E, M, F) and undo
    u1 = page.evaluate(f"(() => {{ const ed = {ED}; const u = ed.doc.objects.find(o => o.kind === 'component' && o.designator === 'U1'); return ed.boundsOf(['o' + u.index]); }})()")
    page.evaluate(f"{ED}.zoomToBox({{minX: {u1['minX']} - 8000000, maxX: {u1['maxX']} + 8000000, minY: {u1['minY']} - 6000000, maxY: {u1['maxY']} + 6000000}})"); page.wait_for_timeout(150)
    U1 = f"{ED}.doc.objects.findIndex(o => o.kind === 'component' && o.designator === 'U1')"
    i0 = page.evaluate(U1)
    ux, uy = page.evaluate(TO_SCREEN, [(u1["minX"] + u1["maxX"]) / 2, (u1["minY"] + u1["maxY"]) / 2])
    page.mouse.move(ux, uy); page.keyboard.press("e"); page.keyboard.press("m"); page.keyboard.press("f")
    page.mouse.click(ux, uy); page.mouse.click(ux, uy, button="right")
    i1 = page.evaluate(U1)
    page.keyboard.press("Control+z")
    check(f"Edit › Move › Bring To Front puts the part last in the file; undo puts it back ({i0} → {i1} → {page.evaluate(U1)})", i1 > i0 and page.evaluate(U1) == i0)
    # Lasso Select (E, S, E) round U1, Selection Memory 1
    pad = 1500000
    pts = [page.evaluate(TO_SCREEN, c) for c in ([u1["minX"] - pad, u1["minY"] - pad], [u1["maxX"] + pad, u1["minY"] - pad], [u1["maxX"] + pad, u1["maxY"] + pad], [u1["minX"] - pad, u1["maxY"] + pad])]
    page.mouse.move(*pts[0]); page.keyboard.press("e"); page.keyboard.press("s"); page.keyboard.press("e")
    page.mouse.click(*pts[0])
    for q in pts[1:]: page.mouse.move(q[0], q[1], steps=6)
    page.mouse.move(pts[0][0] + 2, pts[0][1] - 2, steps=6); page.mouse.click(pts[0][0] + 2, pts[0][1] - 2)
    lasso = page.evaluate(f"[...{ED}.selection].map(k => {ED}.doc.objects[+k.slice(1)]).filter(o => o.kind === 'component').map(o => o.designator)")
    check(f"Lasso Select takes what the lasso encloses ({lasso})", lasso == ["U1"])
    nsel = page.evaluate(f"{ED}.selection.size")
    page.locator(".menubar-item", has_text="Edit").click(); page.locator(".menu-popup .menu-item", has_text="Selection Memory").hover(); page.wait_for_timeout(150)
    page.locator(".menu-popup .menu-item", has_text="Store").first.hover(); page.wait_for_timeout(150)
    page.locator(".menu-popup .menu-item", has_text="Memory 1").first.click()
    page.keyboard.press("Escape"); page.mouse.click(10 + vp["x"], 10 + vp["y"])
    page.evaluate(f"{ED}.clearSelection()")
    page.locator(".menubar-item", has_text="Edit").click(); page.locator(".menu-popup .menu-item", has_text="Selection Memory").hover(); page.wait_for_timeout(150)
    page.locator(".menu-popup .menu-item", has_text="Recall").first.hover(); page.wait_for_timeout(150)
    page.locator(".menu-popup .menu-item", has_text="Memory 1").first.click()
    check(f"Selection Memory › Store, then Recall, brings the selection back ({nsel})", page.evaluate(f"{ED}.selection.size") == nsel and nsel > 0)
    page.keyboard.press("Escape")

    # Project › Project Options: Error Reporting, Connection Matrix, Options, Parameters → the .PrjPcb
    page.evaluate("window.konium.run('ad:WorkspaceManager:ConfigureOptions')"); page.wait_for_timeout(200)
    check("Project › Project Options opens on Error Reporting", page.locator(".dlg.projopts").count() == 1 and "Off grid object" in page.locator(".projopts .po-errors").inner_text())
    page.locator(".projopts select[aria-label='Unconnected wires']").select_option("2")
    page.locator(".projopts .dlg-tabs button", has_text="Connection Matrix").click(); page.wait_for_timeout(100)
    cell = page.locator(".projopts td[aria-label^='Output Pin to Output Pin']")
    before = cell.get_attribute("class"); cell.click(); after = cell.get_attribute("class")
    check(f"Connection Matrix: a click steps the cell ({before} → {after})", before != after)
    page.locator(".projopts .dlg-tabs button", has_text="Parameters").click()
    page.locator(".projopts .cp-buttons .btn", has_text="Add").click()
    page.locator(".projopts input[aria-label='Parameter name']").last.fill("Revision")
    page.locator(".projopts input[aria-label='Revision value']").fill("B")
    page.locator(".projopts .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(150)
    prj = page.evaluate("(() => { const p = window.konium.state.projects.value.find(x => x.name === 'Demo.PrjPcb'); return { dirty: !!p.dirty, lines: p.prj.lines.join('\\n') }; })()")
    check("OK writes Type8=2, the matrix and [Parameter1] into the .PrjPcb and marks the project unsaved",
          prj["dirty"] and "Type8=2" in prj["lines"] and "[ERC Connection Matrix]" in prj["lines"] and "Name=Revision" in prj["lines"])
    check("the Projects panel marks the project modified", page.locator(".tree-project-row", has_text="*").count() >= 1)
    page.evaluate("window.konium.run('tools.erc')"); page.wait_for_timeout(300)
    msgs = page.evaluate("window.konium.state.messages.value.filter(m => m.source === 'Compiler').map(m => m.message)")
    check(f"compile reports through Error Reporting ({len(msgs)} messages)", any("Compile" in m for m in msgs))
    # Tools › Number Schematic Sheets: Auto Sheet Number, OK → SheetNumber parameters
    page.evaluate("window.konium.run('ad:Sch:ProjectSystemParametersManagement')"); page.wait_for_timeout(200)
    page.locator(".numsheets .dlg-foot .btn", has_text="Auto Sheet Number").click()
    page.locator(".numsheets .dlg-foot .btn", has_text="Update Sheet Count").click()
    page.locator(".numsheets .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(300)
    sn = page.evaluate(f"{ED}.doc.objects.filter(o => o.record === 41 && o.owner < 0).map(o => {ED}.doc.records[o.index + 1].bag.get('NAME') + '=' + o.text)")
    check(f"Number Schematic Sheets sets SheetNumber and SheetTotal ({sn})", any(x.startswith("SheetNumber=") for x in sn) and any(x.startswith("SheetTotal=") for x in sn))
    # Edit In-Place (F2) on a net label
    nl = page.evaluate(f"{ED}.doc.objects.find(o => o.kind === 'text' && o.role === 'netlabel').index")
    page.evaluate(f"{ED}.select(['o{nl}'])"); page.keyboard.press("F2"); page.wait_for_timeout(150)
    check("F2 edits the net label in place", page.locator("input.inplace-edit").count() == 1)
    page.locator("input.inplace-edit").fill("RENAMED"); page.keyboard.press("Enter"); page.wait_for_timeout(100)
    check("Enter keeps the new text (one undo step)", page.evaluate(f"{ED}.doc.objects[{nl}].text") == "RENAMED")
    page.keyboard.press("Control+z")
    # Smart Paste: a net label as an array of 4, stepping names
    page.evaluate(f"{ED}.select(['o{nl}'])"); page.keyboard.press("Control+c")
    nlp = page.evaluate(f"(() => {{ const o = {ED}.doc.objects[{nl}]; return [o.at.x, o.at.y]; }})()")
    page.mouse.click(*page.evaluate(TO_SCREEN, nlp))
    labels0 = page.evaluate(f"{ED}.doc.objects.filter(o => o.kind === 'text' && o.role === 'netlabel').length")
    page.evaluate("window.konium.run('ad:Sch:PasteSpecial')"); page.wait_for_timeout(200)
    page.locator(".smartpaste input[type=checkbox]").first.check()
    page.locator(".smartpaste input[aria-label='rows']").fill("4")
    page.locator(".smartpaste .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(150)
    page.mouse.click(vp["x"] + vp["width"] * 0.3, vp["y"] + vp["height"] * 0.3); page.mouse.click(vp["x"] + vp["width"] * 0.3, vp["y"] + vp["height"] * 0.3, button="right")
    labels1 = page.evaluate(f"{ED}.doc.objects.filter(o => o.kind === 'text' && o.role === 'netlabel').length")
    check(f"Smart Paste › Paste Array places 4 net labels ({labels0} → {labels1})", labels1 == labels0 + 4)
    page.keyboard.press("Control+z")
    # File › Print Preview: the sheet as SVG on a page
    page.evaluate("window.konium.run('ad:WorkspaceManager:PrintPreview')"); page.wait_for_timeout(300)
    check("File › Print Preview shows the sheet on a page", page.locator(".printpreview .pp-art svg line").count() > 50)
    shot(page, "20-print-preview.png")
    page.locator(".printpreview .dlg-foot .btn", has_text="Close").click()

    # Place › Harness: connector (two corners), an entry on it, a signal harness from its nub
    page.locator(".doctab", has_text="Demo.SchDoc").click(); page.wait_for_timeout(300)
    page.evaluate(f"{ED}.zoomToBox({{minX: 60000000, maxX: 110000000, minY: 5000000, maxY: 30000000}})"); page.wait_for_timeout(150)
    hx0, hy0 = page.evaluate(TO_SCREEN, [70000000, 25000000]); hx1, hy1 = page.evaluate(TO_SCREEN, [76000000, 17000000])
    page.evaluate("window.konium.run('ad:Sch:PlaceHarnessConnector')"); page.mouse.move(hx0, hy0); page.mouse.click(hx0, hy0); page.mouse.move(hx1, hy1); page.mouse.click(hx1, hy1)
    page.keyboard.press("Escape"); page.keyboard.press("Escape")
    kinds = page.evaluate(f"{ED}.doc.objects.filter(o => o.kind === 'harness' || (o.kind === 'text' && o.role === 'harnesstype')).map(o => o.kind)")
    check(f"Place › Harness › Harness Connector: the connector and its type ({kinds})", kinds == ["harness", "text"])
    ex, ey = page.evaluate(TO_SCREEN, [70000000, 22000000])
    page.evaluate("window.konium.run('ad:Sch:PlaceHarnessEntry')"); page.mouse.move(ex + 5, ey); page.mouse.click(ex + 5, ey); page.mouse.move(ex, ey); page.mouse.click(ex, ey)
    page.keyboard.press("Escape"); page.keyboard.press("Escape")
    ents = page.evaluate(f"{ED}.doc.objects.filter(o => o.kind === 'harnessentry').map(o => o.name + '@' + o.owner)")
    check(f"Place › Harness › Harness Entry goes on the connector ({ents})", len(ents) == 1 and ents[0].startswith("Entry1@"))
    tip = page.evaluate(f"(() => {{ const h = {ED}.doc.objects.find(o => o.kind === 'harness'); return [h.at.x + h.w + 500000, h.at.y - h.primary]; }})()")
    sx0, sy0 = page.evaluate(TO_SCREEN, tip); sx1, sy1 = page.evaluate(TO_SCREEN, [tip[0] + 10000000, tip[1]])
    page.evaluate("window.konium.run('ad:Sch:PlaceSignalHarness')"); page.mouse.move(sx0, sy0); page.mouse.click(sx0, sy0); page.mouse.move(sx1, sy1); page.mouse.click(sx1, sy1); page.mouse.click(sx1, sy1, button="right")
    page.keyboard.press("Escape"); page.keyboard.press("Escape")
    sh = page.evaluate(f"{ED}.doc.objects.filter(o => o.kind === 'signalharness').length")
    check(f"Place › Harness › Signal Harness from the connector's nub ({sh})", sh == 1)
    shot(page, "21-harness.png")
    for _ in range(3): page.keyboard.press("Control+z")
    # Unions: two net labels made one; a click on one selects both
    labs = page.evaluate(f"{ED}.doc.objects.filter(o => o.kind === 'text' && o.role === 'netlabel').slice(0, 2).map(o => 'o' + o.index)")
    page.evaluate(f"{ED}.select({json.dumps(labs)})"); page.evaluate("window.konium.run('ad:Sch:CreateUnion')"); page.evaluate(f"{ED}.clearSelection()")
    page.evaluate(f"{ED}.zoomToBox({ED}.boundsOf([{json.dumps(labs[0])}]), 4000000)"); page.wait_for_timeout(150)
    lb = page.evaluate(f"(() => {{ const b = {ED}.boundsOf([{json.dumps(labs[0])}]); return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]; }})()")
    lx, ly = page.evaluate(TO_SCREEN, lb); page.mouse.click(lx, ly); page.wait_for_timeout(100)
    sel = sorted(page.evaluate(f"[...{ED}.selection]"))
    check(f"Edit › Unions: a click on one member selects the union ({sel})", sel == sorted(labs))
    page.keyboard.press("Control+z"); page.keyboard.press("Escape")
    # Break Wires At Autojunctions: a wire ended part-way along another splits it
    page.evaluate(f"{ED}.zoomToBox({{minX: 76000000, maxX: 104000000, minY: 4000000, maxY: 18000000}})"); page.wait_for_timeout(150)
    WIRES = f"{ED}.doc.objects.filter(o => o.kind === 'wire').map(o => o.pts.map(p => p.x + ',' + p.y).join(' '))"
    w0 = len(page.evaluate(WIRES))
    def at(x, y): return page.evaluate(TO_SCREEN, [x, y])
    page.evaluate("window.konium.run('place.wire')")
    for pt in ([80000000, 8000000], [100000000, 8000000]): page.mouse.move(*at(*pt)); page.mouse.click(*at(*pt))
    page.mouse.click(*at(100000000, 8000000), button="right")
    for pt in ([90000000, 14000000], [90000000, 8000000]): page.mouse.move(*at(*pt)); page.mouse.click(*at(*pt))
    page.mouse.click(*at(90000000, 8000000), button="right"); page.keyboard.press("Escape")
    ws = page.evaluate(WIRES)
    check(f"Break Wires At Autojunctions splits the wire a new one ends on ({len(ws) - w0} new)", len(ws) == w0 + 3 and "80000000,8000000 90000000,8000000" in ws)
    # (Group Undo may have made the two placements one step)
    page.keyboard.press("Control+z")
    if len(page.evaluate(WIRES)) != w0: page.keyboard.press("Control+z")
    check("…undo takes both wires back", len(page.evaluate(WIRES)) == w0)
    # Document Options › Units: Inches shows the status bar in inches
    page.evaluate("window.konium.run('ad:Sch:DocumentPreferencesSchDocumentOptions')"); page.wait_for_timeout(200)
    page.locator(".docopts [role=tab]", has_text="Units").click()
    page.locator(".docopts select").first.select_option(label="Inches")
    page.locator(".docopts .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(150)
    page.mouse.move(*at(90000000, 8000000)); page.wait_for_timeout(100)
    coord = page.locator(".statusbar .coord").inner_text()
    check(f"Document Options › Units: the status bar in inches ({coord})", coord.endswith("in") and "mil" not in coord)
    page.keyboard.press("Control+z")
    # Protect Locked Objects: a locked part stays put on Delete
    r1i = page.evaluate(f"{ED}.doc.objects.find(o => o.kind === 'component' && o.designator === 'R1').index")
    page.evaluate(f"(() => {{ const e = {ED}; e.doc.records[{r1i} + 1].bag.set('LOCKED', 'T'); e.select(['o{r1i}']); }})()")
    page.mouse.move(*at(90000000, 8000000)); page.keyboard.press("Delete"); page.wait_for_timeout(100)
    still = page.evaluate(f"{ED}.doc.objects.some(o => o.kind === 'component' && o.designator === 'R1')")
    check("Protect Locked Objects: Delete leaves a locked part", still and "protected" in page.locator(".statusbar, .toast").all_inner_texts().__str__())
    page.evaluate(f"{ED}.doc.records[{r1i} + 1].bag.delete('LOCKED')"); page.keyboard.press("Escape")
    # Window › Tile: every open document in its own pane; Merge All puts them back
    page.evaluate("window.konium.run('ad:Client:TileAllOpenDocuments')"); page.wait_for_timeout(400)
    panes = page.locator(".tiled .pane").count()
    check(f"Window › Tile shows the open documents side by side ({panes} panes)", panes >= 2 and page.locator(".tiled .pane canvas").count() >= 2)
    shot(page, "22-tile.png")
    page.evaluate("window.konium.run('window.mergeAll')"); page.wait_for_timeout(300)
    check("…Merge All goes back to one document", page.locator(".tiled").count() == 0 and page.locator(".viewport-host canvas").count() >= 1)
    # Project › Variants: a variant with R1 not fitted, made current: R1 crossed out, BOM without it
    page.locator(".doctab", has_text="Demo.SchDoc").click(); page.wait_for_timeout(200)
    page.evaluate("window.konium.run('ad:WorkspaceManager:VariantManagement')"); page.wait_for_timeout(200)
    page.locator(".variants .dlg-foot .btn", has_text="Add Variant").click(); page.wait_for_timeout(100)
    page.keyboard.press("Enter"); page.wait_for_timeout(100)
    page.locator(".variants select[aria-label='R1 in Variant1']").select_option("1")
    page.locator(".variants .va-cur select").select_option("Variant1")
    page.locator(".variants .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(200)
    nf = page.evaluate(f"(() => {{ const e = {ED}; return e.notFitted ? [...e.notFitted()].map(i => e.doc.objects[i].designator) : null; }})()")
    lines = page.evaluate("window.konium.state.projects.value.find(x => x.name === 'Demo.PrjPcb').prj.lines.join('\\n')")
    check(f"Project › Variants: R1 not fitted in the current variant, written to the project ({nf})", nf == ["R1"] and "[ProjectVariant1]" in lines and "Kind=1" in lines)
    # Right-click › Filter › Examples
    page.evaluate("window.konium.run('ad:SCH:FilterExamplesApply')"); page.wait_for_timeout(150)
    page.locator(".dlg .grid-row", has_text="All net labels").click(); page.locator(".dlg .dlg-foot .btn", has_text="Apply").click(); page.wait_for_timeout(200)
    k2 = page.evaluate(f"[...new Set([...{ED}.selection].map(k => {ED}.doc.objects[+k.slice(1)].role))]")
    check(f"Filter › Examples › All net labels selects the net labels ({k2})", k2 == ["netlabel"])
    page.evaluate("window.konium.run('pcb.clearHighlight')"); page.evaluate(f"{ED}.clearSelection()")

    # 26.031: a tab dragged along its strip reorders the group's tabs
    tabs0 = page.locator(".zone-left .dock-tabs").first.locator("[role=tab]").all_inner_texts()
    ta = page.locator(".zone-left .dock-tabs").first.locator("[role=tab]").last.bounding_box()
    tb = page.locator(".zone-left .dock-tabs").first.locator("[role=tab]").first.bounding_box()
    page.mouse.move(ta["x"] + 8, ta["y"] + 6); page.mouse.down(); page.mouse.move(ta["x"] - 20, ta["y"] + 6, steps=4); page.mouse.move(tb["x"] + 3, tb["y"] + 6, steps=6)
    page.mouse.up(); page.wait_for_timeout(150)
    tabs1 = page.locator(".zone-left .dock-tabs").first.locator("[role=tab]").all_inner_texts()
    check(f"a tab dragged to the front of its strip goes first ({tabs0} -> {tabs1})", len(tabs0) >= 2 and tabs1 == [tabs0[-1]] + tabs0[:-1])
    page.locator(".zone-left .dock-tabs").first.locator("[role=tab]", has_text=tabs0[0]).click(); page.wait_for_timeout(100)
    # Docking: drag a tab to an edge, float a group, close and reopen, auto-hide, F4, sizes remembered
    t = page.locator(".dock-tabs [role=tab]", has_text="Navigator").bounding_box()
    page.mouse.move(t["x"] + 8, t["y"] + 6); page.mouse.down(); page.mouse.move(t["x"] + 40, t["y"] - 40, steps=4); page.mouse.move(1432, 420, steps=8)
    check("dragging a tab shows where it will dock", page.locator(".dock-preview").count() == 1)
    page.mouse.up(); page.wait_for_timeout(150)
    check("tab dropped at the right edge docks there", page.locator(".zone-right .panel-title").all_inner_texts() == ["Navigator"])
    h = page.locator(".zone-right .panel-head").bounding_box()
    page.mouse.move(h["x"] + 30, h["y"] + 8); page.mouse.down(); page.mouse.move(700, 300, steps=10); page.mouse.up(); page.wait_for_timeout(150)
    check("title bar dragged into the document floats the group", page.locator(".dock-float .panel-title").all_inner_texts() == ["Navigator"] and page.locator(".zone-right").count() == 0)
    page.mouse.move(700, 600); page.keyboard.press("F4")
    check("F4 hides floating panels", page.locator(".dock-float").count() == 0)
    page.keyboard.press("F4")
    check("…and shows them again", page.locator(".dock-float").count() == 1)
    page.locator(".panel-btn[aria-label='Close Navigator']").click()
    check("closing a panel takes it out of the layout", page.locator(".dock-float").count() == 0 and page.locator("[role=tab]", has_text="Navigator").count() == 0)
    page.locator(".status-panel-btn", has_text="Design Compiler").dispatch_event("mousedown"); page.wait_for_timeout(150)
    page.locator(".menu-popup .menu-item", has_text="Navigator").click(); page.wait_for_timeout(150)
    check("status-bar Design Compiler › Navigator brings it back where it was", page.locator(".dock-float .panel-title").all_inner_texts() == ["Navigator"])
    page.locator(".panel-btn[aria-label='Close Navigator']").click()
    page.locator(".panel-btn[aria-label='Auto-hide Projects']").click()
    check("pin off: the group hides behind tabs on its edge", page.locator(".strip-left .strip-tab").count() >= 2 and page.locator(".zone-left").count() == 0)
    page.locator(".strip-left .strip-tab", has_text="Projects").click(); page.wait_for_timeout(200)
    check("pointing at a tab slides the panel out", page.locator(".dock-slide .panel-title").all_inner_texts() == ["Projects"])
    shot(page, "16-panels-autohide.png")
    page.locator(".dock-slide .panel-btn[aria-label='Pin Projects']").click()
    check("pin on: docked again", page.locator(".zone-left .panel-title").count() == 1)
    h = page.locator(".zr-left").bounding_box()
    page.mouse.move(h["x"] + 3, h["y"] + 200); page.mouse.down(); page.mouse.move(h["x"] + 63, h["y"] + 200, steps=4); page.mouse.up()
    w = page.locator(".zone-left").bounding_box()["width"]
    check(f"left zone resized by drag (width {w:.0f})", 355 <= w <= 366)
    # 26.066: Auto Save — a new sheet copied into the browser; after the reload the Home page offers it back
    page.evaluate("window.konium.run('file.newSch')"); page.wait_for_timeout(300)
    rec_n = page.evaluate("window.konium.backup.autoSaveNow()")
    page.reload(); page.wait_for_function("window.konium !== undefined")
    w2 = page.locator(".zone-left").bounding_box()["width"]
    check(f"layout remembered after reload ({w2:.0f})", abs(w2 - w) < 2 and page.locator("[role=tab]", has_text="Navigator").count() == 0)
    page.wait_for_timeout(1500)
    rc = page.locator(".home-recover")
    check(f"Auto Save: a new sheet copied ({rec_n}); after the reload the Home page offers it back ({rc.inner_text().splitlines()[:2] if rc.count() else None})", rec_n >= 1 and rc.count() == 1 and ".SchDoc" in rc.inner_text())
    shot(page, "90-recover.png")
    (rc.get_by_role("button", name="Discard all") if rc.get_by_role("button", name="Discard all").count() else rc.get_by_role("button", name="Discard")).first.click(); page.wait_for_timeout(600)
    check("…Discard: the copies go, the offer with them", page.locator(".home-recover").count() == 0)
    page.evaluate("window.konium.dock.restoreLayout('default')"); page.wait_for_timeout(100)
    check("Desktop Layouts › Default: Projects group back, messages closed", page.locator(".zone-left .panel-title").all_inner_texts() == ["Projects"] and page.locator(".messages").count() == 0)
    # Settings and layout saved under the previous name carry over
    page.evaluate("""(() => { const l = structuredClone(window.konium.dock.layout.value); l.zones.left.size = 333;
      localStorage.clear();
      localStorage.setItem('vibium.settings.v2', JSON.stringify({ theme: 'ad17', wheel: 'altium', schTextScale: 1.2 }));
      localStorage.setItem('vibium.layout.v1', JSON.stringify(l)); })()""")
    page.reload(); page.wait_for_function("window.konium !== undefined"); page.wait_for_timeout(300)
    mig = page.evaluate("JSON.parse(localStorage.getItem('konium.settings.v2') || 'null')")
    check(f"Vibium-era settings and layout carry over ({mig and [mig.get('theme'), mig.get('wheel'), mig.get('schTextScale')]})",
          page.evaluate("document.documentElement.dataset.theme") == "classic" and abs(page.locator(".zone-left").bounding_box()["width"] - 333) < 2)
    page.evaluate("window.konium.prefs.set({ projExpand: 'full', layoutPerKind: false, groupTabs: false })")  # (the settings were cleared: the Projects tree open again, as the rest of this run expects)

    # Project › Show Differences: the demo's board lacks the LED indicator; all to the PCB, then they agree
    page.evaluate("window.konium.run('file.openDemo')"); page.wait_for_timeout(800)
    page.evaluate("window.konium.run('ad:WorkspaceManager:ShowDifferences')"); page.wait_for_timeout(300)
    check("Show Differences: Choose Documents To Compare offers the board", page.locator(".dlg", has_text="Choose Documents To Compare").count() == 1 and "Demo.PcbDoc" in page.locator(".cmp-list").inner_text())
    # 26.110: Advanced Mode lists the schematics too (the project as a whole stays chosen)
    page.locator(".dlg", has_text="Choose Documents To Compare").locator(".np-check input").check(); page.wait_for_timeout(100)
    check("Choose Documents To Compare › Advanced Mode lists the project's schematics (26.110)", page.locator(".cmp-list").count() == 2 and ".SchDoc" in page.locator(".cmp-list").first.inner_text())
    page.locator(".dlg", has_text="Choose Documents To Compare").locator(".np-check input").uncheck(); page.wait_for_timeout(100)
    page.locator(".dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(500)
    cmp = page.locator(".dlg.cmp")
    groups = cmp.locator(".cmp-group").all_inner_texts()
    check(f"Differences between the schematics and the board, grouped ({groups})", cmp.count() == 1 and "Extra Components (2)" in groups and cmp.locator(".cmp-dec.on", has_text="·").count() == cmp.locator(".grid-body .grid-row:not(.eco-group)").count())
    check("the schematic can't take an extra component (<< disabled)", cmp.locator(".grid-body .grid-row:not(.eco-group)").first.locator(".cmp-dec").first.is_disabled())
    cmp.locator(".cmp-tools .btn", has_text="Update All in >> PCB Document").click()
    shot(page, "39-differences.png")
    check("Update All in >> PCB Document: every row goes to the board", "No Change" not in cmp.locator(".grid-body").inner_text())
    cmp.locator(".dlg-foot .btn", has_text="Create Engineering Change Order").click(); page.wait_for_timeout(300)
    n = page.locator(".eco .grid-body .grid-row:not(.eco-group)").count()
    page.locator(".dlg-foot .btn", has_text="Execute Changes").click(); page.wait_for_timeout(300)
    check(f"the change order from the differences executes ({n} changes)", n == 7 and page.locator(".eco .eco-err").count() == 0)
    page.locator(".dlg-foot .btn", has_text="Close").click(); page.wait_for_timeout(200)
    page.evaluate("window.konium.run('ad:WorkspaceManager:ShowDifferences')"); page.wait_for_timeout(200)
    page.locator(".dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(400)
    check("then no differences", page.locator(".dlg.cmp").count() == 0 and "No differences" in page.locator(".toast").inner_text())
    # Design › Update Schematics from the board: nothing to send back
    page.evaluate("""(() => { const d = window.konium.state.docs.value.find(x => x.name === 'Demo.PcbDoc'); window.konium.state.activeId.value = d.id; })()"""); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('design.updateSch')"); page.wait_for_timeout(300)
    check("Update Schematics: the schematics and the board agree", "agree" in page.locator(".toast").inner_text())
    # R1 renamed R7 on the board (linked by unique ID since the change order): Update Schematics takes it back
    page.evaluate(f"(() => {{ const c = {ED}.doc.components.find(x => x.designator === 'R1'); c.designator = 'R7'; c.bag.set('SOURCEDESIGNATOR', 'R7'); }})()")
    page.evaluate("window.konium.run('design.updateSch')"); page.wait_for_timeout(300)
    eco = page.locator(".eco .grid-body .grid-row:not(.eco-group)").all_inner_texts()
    check(f"Update Schematics: the ECO renames R1 to R7 on Demo.SchDoc ({eco})", len(eco) == 1 and "R1 -> R7" in eco[0] and "Demo.SchDoc" in eco[0])
    page.locator(".dlg-foot .btn", has_text="Execute Changes").click(); page.wait_for_timeout(300)
    page.locator(".dlg-foot .btn", has_text="Close").click(); page.wait_for_timeout(200)
    SHEET = "window.konium.state.docs.value.find(x => x.name === 'Demo.SchDoc').editor"
    check("the sheet now has R7", page.evaluate(f"{SHEET}.doc.objects.some(o => o.kind === 'component' && o.designator === 'R7')"))
    page.evaluate(f"{SHEET}.undo.undo()"); page.wait_for_timeout(100)
    check("one undo on the sheet puts R1 back", page.evaluate(f"{SHEET}.doc.objects.some(o => o.kind === 'component' && o.designator === 'R1')"))

    # Double-click a board object: AD17's dialog for it (Via, Track, String, Fill), OK in one undo step
    page.evaluate("""(() => { const d = window.konium.state.docs.value.find(x => x.name === 'Demo.PcbDoc'); window.konium.state.activeId.value = d.id; })()"""); page.wait_for_timeout(300)
    page.evaluate(f"window.konium.editObject({ED}, 'Vias6:0')"); page.wait_for_timeout(200)
    check("a via opens AD17's Via dialog", page.locator(".dlg.pd").count() == 1 and "Via [" in page.locator(".dlg.pd").inner_text() and "Solder Mask Expansions" in page.locator(".dlg.pd").inner_text())
    shot(page, "40-via-dialog.png")
    # Enter takes the typed value and is OK (the dialog's default button), as in AD
    page.fill("#pd-dia", "40mil"); page.keyboard.press("Enter"); page.wait_for_timeout(200)
    check("Via: the diameter typed, Enter is OK, one undo step", page.locator(".dlg.pd").count() == 0 and page.evaluate(f"{ED}.doc.prims.find(p => p.src.storage === 'Vias6' && p.src.index === 0).diameter") == 400000 and page.evaluate(f"{ED}.undo.undoLabel") == "Via properties")
    page.evaluate(f"window.konium.editObject({ED}, 'Tracks6:0')"); page.wait_for_timeout(200)
    page.fill("#pd-width", "25mil"); page.keyboard.press("Enter"); page.wait_for_timeout(200)
    check("Track: the width typed", page.evaluate(f"{ED}.doc.prims.find(p => p.src.storage === 'Tracks6' && p.src.index === 0).width") == 250000)
    page.evaluate(f"window.konium.editObject({ED}, 'Texts6:5')"); page.wait_for_timeout(200)
    check("a string opens AD17's String dialog", "String [" in page.locator(".dlg.pd").inner_text() and page.locator(".dlg.pd textarea").input_value() == "Konium demo board v0.1")
    shot(page, "41-string-dialog.png")
    page.locator(".dlg.pd textarea").fill("Konium board")
    page.locator(".dlg.pd .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(150)
    check("String: the new words", page.evaluate(f"{ED}.doc.prims.find(p => p.src.storage === 'Texts6' && p.src.index === 5).text") == "Konium board")
    page.evaluate(f"window.konium.editObject({ED}, 'Fills6:0')"); page.wait_for_timeout(200)
    check("a fill opens AD17's Fill dialog with its mask expansions", "Fill [" in page.locator(".dlg.pd").inner_text() and page.locator(".dlg.pd .pd-mask").count() == 2)
    shot(page, "42-fill-dialog.png")
    page.keyboard.press("Escape")
    for _ in range(3): page.keyboard.press("Control+z")
    check("three undos put the via, track and string back", page.evaluate(f"{ED}.doc.prims.find(p => p.src.storage === 'Vias6' && p.src.index === 0).diameter") == 314961
          and page.evaluate(f"{ED}.doc.prims.find(p => p.src.storage === 'Texts6' && p.src.index === 5).text") == "Konium demo board v0.1")

    # 26.037: Region and Component dialogs; Tab while placing a via and while routing; classes; PCB Filter, List, panel, rules
    page.evaluate(f"window.konium.editObject({ED}, 'ShapeBasedRegions6:0')"); page.wait_for_timeout(200)
    check("a region opens AD17's Region dialog (Kind, Layer, Net, masks)", page.locator(".dlg.regiondlg").count() == 1 and all(t in page.locator(".regiondlg").inner_text() for t in ["Region [", "Kind", "Solder Mask Expansion"]))
    page.locator(".regiondlg .pd-tabs button", has_text="Outline Vertices").click()
    check("its Outline Vertices tab lists the vertices", page.locator(".regiondlg .grid-body .grid-row").count() >= 3)
    shot(page, "43-region-dialog.png")
    page.keyboard.press("Escape")
    jpad = page.evaluate(f"(() => {{ const e = {ED}; const j = e.doc.components.findIndex(c => c.designator === 'J1'); const p = e.doc.prims.find(q => q.kind === 'pad' && q.component === j); return p.src.storage + ':' + p.src.index; }})()")
    page.evaluate(f"window.konium.editObject({ED}, '{jpad}')"); page.wait_for_timeout(200)
    check("a component's pad opens the Component dialog (Lock Primitives)", page.locator(".dlg.pcbcomp").count() == 1 and all(t in page.locator(".pcbcomp").inner_text() for t in ["Component Properties", "Designator", "Comment", "Footprint", "Schematic Reference Information"]))
    shot(page, "44-component-dialog.png")
    page.locator(".pcbcomp input[aria-label='Designator text']").fill("J9")
    page.locator(".pcbcomp .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(150)
    check("Component: a new designator, one undo step", page.evaluate(f"{ED}.doc.components.some(c => c.designator === 'J9')") and page.evaluate(f"{ED}.undo.undoLabel").startswith("Component J1"))
    page.keyboard.press("Control+z"); page.wait_for_timeout(100)
    check("undo gives J1 back", page.evaluate(f"{ED}.doc.components.some(c => c.designator === 'J1')"))
    nv = page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'via').length")
    page.evaluate("window.konium.run('place.via')"); page.mouse.move(700, 450); page.wait_for_timeout(100)
    page.keyboard.press("Tab"); page.wait_for_timeout(200)
    check("Tab while placing a via opens AD17's Via dialog", page.locator(".dlg.pd").count() == 1 and "Via [" in page.locator(".dlg.pd").inner_text())
    page.fill("#pd-dia", "30mil"); page.keyboard.press("Enter"); page.wait_for_timeout(200)
    page.mouse.click(700, 450); page.wait_for_timeout(150)
    page.mouse.click(700, 450, button="right"); page.keyboard.press("Escape")
    vias = page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'via').map(p => p.diameter)")
    check(f"the next via is the one set in Tab ({vias[-1] if vias else None})", len(vias) == nv + 1 and vias[-1] == 300000)
    page.keyboard.press("Control+z")
    page.evaluate(f"(() => {{ {ED}.viaTemplate.fromRule = true; }})()")
    page.evaluate("window.konium.run('ad:PCB:PopupOptionsDefaults')"); page.wait_for_timeout(200)
    check("Options › Defaults: AD17's primitive list (Via changed from AD17's)", "Via *" in page.locator(".pdef-list").inner_text())
    page.locator(".pdef-row", has_text="Polygon").first.dispatch_event("mousedown")
    page.locator(".pdef-buttons .btn", has_text="Edit Values").click(); page.wait_for_timeout(150)
    page.locator(".dlg.bagdefaults select[aria-label='Fill Mode / Hatch']").select_option("45Degree")
    page.locator(".dlg.bagdefaults .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(100)
    hatch = page.evaluate("(JSON.parse(localStorage.getItem('konium.pcbBagDefaults') || '{}').Polygon || {}).HATCHSTYLE")
    check(f"Defaults › Polygon › Edit Values: the next pour hatched at 45 degrees ({hatch})", hatch == "45Degree" and "Polygon *" in page.locator(".pdef-list").inner_text())
    page.locator(".pdef-file .btn", has_text="Reset All").click()
    check("Reset All goes back to AD17's", "*" not in page.locator(".pdef-list").inner_text() and page.evaluate("localStorage.getItem('konium.pcbBagDefaults')") in (None, "{}"))
    page.locator(".prefs .dlg-foot .btn, .dlg .dlg-foot .btn", has_text="Cancel").first.click(); page.wait_for_timeout(100)
    page.evaluate("window.konium.run('route.interactive')"); page.mouse.move(700, 450); page.keyboard.press("Tab"); page.wait_for_timeout(200)
    check("Tab while routing: AD17's Interactive Routing dialog", page.locator(".dlg.irdlg").count() == 1 and all(t in page.locator(".irdlg").inner_text() for t in ["Routing Conflict Resolution", "Via Hole Size", "Routing Width Constraints", "Favourite Interactive Routing Widths"]))
    shot(page, "45-routing-dialog.png")
    page.keyboard.press("Escape"); page.keyboard.press("Escape"); page.wait_for_timeout(100)
    page.evaluate("window.konium.run('ad:PCB:Classes')"); page.wait_for_timeout(200)
    page.locator(".oce-node.cls", has_text="Power").first.dispatch_event("mousedown")
    page.locator(".oce-list", has_text="Non-Members").locator(".oce-item", has_text="GND").dblclick()
    page.locator(".oce .dlg-foot .btn", has_text="Close").click(); page.wait_for_timeout(100)
    check("Design › Classes: GND joins the Power net class, one undo step", "GND" in page.evaluate(f"{ED}.doc.classes.find(c => c.name === 'Power').members") and page.evaluate(f"{ED}.undo.undoLabel") == "Edit classes")
    page.keyboard.press("Control+z")
    page.evaluate("window.konium.run('ad:PCB:PCBExpressionFilter')"); page.wait_for_timeout(200)
    page.fill("#pcb-filter-query", "IsVia")
    page.locator(".pcbfilter .btn", has_text="Apply To All").click(); page.wait_for_timeout(150)
    check("PCB Filter: IsVia selects the vias and masks the rest", page.evaluate(f"[...{ED}.selection].every(k => k.startsWith('Vias6'))") and page.evaluate(f"{ED}.selection.size") == nv and page.evaluate(f"{ED}.mask.size") == nv)
    shot(page, "46-pcb-filter.png")
    page.keyboard.press("Shift+C"); page.wait_for_timeout(100)
    check("Shift+C clears the mask", page.evaluate(f"{ED}.mask") is None)
    page.evaluate("window.konium.run('ad:PCB:PCBObjectList')"); page.wait_for_timeout(200)
    check("Shift+F12: PCB List of the board's objects", page.locator(".pcblist .list-row:not(.list-headrow)").count() > 10)
    page.evaluate("window.konium.run('view.panel.pcb')"); page.wait_for_timeout(200)
    page.locator(".pcbpanel .pcbp-row", has_text="GND").first.dispatch_event("mousedown"); page.wait_for_timeout(150)
    check("PCB panel: a net picked selects its objects", page.evaluate(f"{ED}.selection.size") > 3 and page.evaluate(f"(() => {{ const e = {ED}; return [...e.selection].every(k => {{ const p = e.primByKey(k); return !p || !('net' in p) || e.doc.nets[p.net]?.name === 'GND'; }}); }})()"))
    shot(page, "47-pcb-panel.png")
    page.keyboard.press("Shift+C")
    page.evaluate("window.konium.run('view.panel.rules')"); page.wait_for_timeout(200)
    check("PCB Rules And Violations lists the rule kinds", "All Rules" in page.locator(".rulespanel").inner_text() and "Clearance" in page.locator(".rulespanel").inner_text())

    # 26.038: differential pairs, routing them, length tuning, teardrops, stitching, slicing a pour, pin swapping
    page.evaluate("window.konium.run('view.panel.pcb')"); page.wait_for_timeout(150)
    page.locator(".pcbpanel select.pcbp-mode").select_option(label="Differential Pairs Editor"); page.wait_for_timeout(150)
    page.locator(".pcbpanel .btn", has_text="Add").click(); page.wait_for_timeout(150)
    page.fill(".dlg input[aria-label='Name']", "PWR")
    page.locator(".dlg select[aria-label='Positive Net']").select_option(label="VIN")
    page.locator(".dlg select[aria-label='Negative Net']").select_option(label="+3V3")
    page.locator(".dlg .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(150)
    check("Differential Pairs Editor: Add makes a pair, listed with its nets", page.evaluate(f"({ED}.doc.diffPairs || []).length") == 1 and "PWR" in page.locator(".pcbpanel").inner_text())
    shot(page, "48-diff-pairs.png")
    nr = page.evaluate(f"{ED}.doc.rules.length")
    page.locator(".pcbpanel .btn", has_text="Rule Wizard").click(); page.wait_for_timeout(150)
    page.locator(".dlg .dlg-foot .btn", has_text="Finish").click(); page.wait_for_timeout(150)
    check("Rule Wizard: a Differential Pairs Routing and a Matched Lengths rule", page.evaluate(f"{ED}.doc.rules.length") == nr + 2)
    page.evaluate("window.konium.run('route.diffPair')")
    vx, vy = page.evaluate(TO_SCREEN, page.evaluate(PRIM, "p.kind === 'pad' && ed.doc.nets[p.net]?.name === 'VIN' && p.layer === 1"))
    page.mouse.move(vx, vy); page.mouse.click(vx, vy); page.wait_for_timeout(150)
    page.mouse.move(vx + 60, vy); page.wait_for_timeout(150)
    hint = page.evaluate(f"{ED}.tool.hint()")
    check(f"Interactive Differential Pair Routing: a VIN pad starts the pair with +3V3 ({hint[:40]})", page.evaluate(f"{ED}.tool.active") and "VIN, +3V3" in hint)
    page.keyboard.press("Tab"); page.wait_for_timeout(150)
    check("Tab: the pair's width, gap and conflict mode", "Interactive Differential Pair Routing" in page.locator(".dlg").inner_text() and "Gap From Rule" in page.locator(".dlg").inner_text())
    page.keyboard.press("Escape"); page.keyboard.press("Escape"); page.keyboard.press("Escape"); page.wait_for_timeout(100)
    for _ in range(3):
        if page.evaluate(f"({ED}.doc.diffPairs || []).length") == 0 and page.evaluate(f"{ED}.doc.rules.length") == nr: break
        page.keyboard.press("Control+z"); page.wait_for_timeout(80)
    check("undo takes the pair and its rules back", page.evaluate(f"({ED}.doc.diffPairs || []).length") == 0 and page.evaluate(f"{ED}.doc.rules.length") == nr)
    VINLEN = f"{ED}.doc.prims.filter(p => p.kind === 'track' && {ED}.doc.nets[p.net]?.name === 'VIN').reduce((s, t) => s + Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y), 0)"
    l0 = page.evaluate(VINLEN)
    page.evaluate(f"window.konium.prefs.set({{ pcbTuneTarget: 'manual', pcbTuneManual: {l0 / 1e4 + 60}, pcbTuneStyle: 'mitered', pcbTuneAmplitude: 40, pcbTuneSpace: 20 }})")
    page.evaluate("window.konium.run('route.length')")
    tr = page.evaluate(f"(() => {{ const t = {ED}.doc.prims.find(p => p.kind === 'track' && p.a.y === p.b.y && {ED}.doc.nets[p.net]?.name === 'VIN' && Math.abs(p.b.x - p.a.x) > 4000000); return [t.a.x, t.b.x, t.a.y]; }})()")
    x0, y0 = page.evaluate(TO_SCREEN, [tr[0] + (tr[1] - tr[0]) * 0.15, tr[2]]); x1, y1 = page.evaluate(TO_SCREEN, [tr[0] + (tr[1] - tr[0]) * 0.85, tr[2] - 300000])
    page.mouse.move(x0, y0); page.mouse.click(x0, y0); page.wait_for_timeout(100)
    page.keyboard.press("Tab"); page.wait_for_timeout(150)
    check("Tab while tuning: Interactive Length Tuning (target, accordion pattern)", all(t in page.locator(".dlg").inner_text() for t in ["Target Length", "Accordion Pattern", "Mitered Lines", "Max Amplitude"]))
    shot(page, "49-length-tuning-dialog.png")
    page.locator(".dlg .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(100)
    page.mouse.move(x1, y1); page.wait_for_timeout(150)
    shot(page, "50-length-tuning.png")
    page.mouse.click(x1, y1); page.wait_for_timeout(200)
    l1 = page.evaluate(VINLEN)
    check(f"Interactive Length Tuning: VIN lengthened to the target ({(l1 - l0) / 1e4:.1f} mil added of 60)", abs(l1 - l0 - 600000) < 10000)
    page.keyboard.press("Escape"); page.keyboard.press("Escape"); page.keyboard.press("Control+z"); page.wait_for_timeout(100)
    check("undo gives VIN its length back", abs(page.evaluate(VINLEN) - l0) < 2)
    na = page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'arc').length")
    page.evaluate("window.konium.run('ad:PCB:TearDrops')"); page.wait_for_timeout(150)
    check("Tools › Teardrops: AD17's Teardrop Options", all(t in page.locator(".dlg").inner_text() for t in ["All Pads", "All Vias", "Force Teardrops", "Teardrop Style"]))
    page.locator(".dlg .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(200)
    check("teardrops: arcs where tracks meet pads and vias, one undo step", page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'arc').length") > na and page.evaluate(f"{ED}.undo.undoLabel") == "Teardrops")
    shot(page, "51-teardrops.png")
    page.keyboard.press("Control+z")
    nv0 = page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'via').length")
    viol0 = page.evaluate(f"{ED}.violations.length")
    page.evaluate("window.konium.run('ad:PCB:ViaStitchingFlood')"); page.wait_for_timeout(150)
    page.locator(".dlg .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(400)
    viol1 = page.evaluate(f"{ED}.violations.length")
    check(f"Add Stitching to Net: GND vias over its pour, no new violations ({viol0} → {viol1})", page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'via').length") > nv0 + 3 and viol1 <= viol0)
    shot(page, "52-stitching.png")
    page.keyboard.press("Control+z")
    bx = page.evaluate(f"(() => {{ const o = {ED}.doc.polygons[0].outline; const xs = o.map(p => p.x), ys = o.map(p => p.y); return [(Math.min(...xs) + Math.max(...xs)) / 2, Math.min(...ys) - 400000, Math.max(...ys) + 400000]; }})()")
    page.evaluate("window.konium.run('ad:PCB:CutPolygonPlane')")
    for yy in (bx[1], bx[2]):
        sx, sy = page.evaluate(TO_SCREEN, [bx[0], yy]); page.mouse.move(sx, sy); page.mouse.click(sx, sy); page.wait_for_timeout(150)
    check("Slice Polygon Pour: the GND pour is two pours", page.evaluate(f"{ED}.doc.polygons.length") == 2)
    page.keyboard.press("Control+z"); page.wait_for_timeout(150)
    check("…undo makes it one again", page.evaluate(f"{ED}.doc.polygons.length") == 1)
    page.evaluate("window.konium.run('ad:PCB:ConfigurePinSwap')"); page.wait_for_timeout(150)
    check("Pin/Part Swapping › Configure: components and their pads' groups", "Configure Pin Swapping" in page.locator(".dlg").inner_text() and page.locator(".pinswap .grid-body .grid-row").count() > 5)
    page.keyboard.press("Escape")

    # 26.039: rooms, unions, grids and guides, drill table, Auto Route, Fanout, Auto Placer
    U1 = f"{ED}.doc.components.findIndex(c => c.designator === 'U1')"
    page.evaluate(f"(() => {{ const e = {ED}; e.selection = new Set(e.componentKeys({U1})); e.invalidateOverlay(); }})()")
    page.evaluate("window.konium.run('ad:PCB:CreateRoomFromComponentsBoundingRect')"); page.wait_for_timeout(200)
    rooms = page.evaluate(f"{ED}.doc.rules.filter(r => (r.bag.get('RULEKIND') || '') === 'RoomDefinition').map(r => r.bag.get('NAME') + '|' + r.bag.get('SCOPE1EXPRESSION'))")
    check(f"Design › Rooms › Create Rectangle Room from selected components: a Room Definition round U1 ({rooms})", len(rooms) == 1 and "U1" in rooms[0])
    shot(page, "53-room.png")
    page.evaluate(f"(() => {{ const e = {ED}; e.selection = new Set(['room:' + e.doc.rules.findIndex(r => r.bag.get('RULEKIND') === 'RoomDefinition')]); }})()")
    ux = page.evaluate(f"{ED}.doc.components[{U1}].at.x")
    page.evaluate(f"(() => {{ const e = {ED}; const s = e.moveSet(); window.konium.__room = s; }})()")
    check("a selected room carries its components when moved", page.evaluate("window.konium.__room.components.length") >= 1 and page.evaluate("window.konium.__room.rooms.length") == 1)
    page.keyboard.press("Control+z"); page.wait_for_timeout(100)
    page.evaluate(f"(() => {{ const e = {ED}; const keys = e.doc.prims.map((p, i) => [p, i]).filter(([p]) => p.kind === 'track' && e.doc.nets[p.net]?.name === 'GND').slice(0, 3).map(([p]) => p.src.storage + ':' + p.src.index); e.selection = new Set(keys); }})()")
    page.evaluate("window.konium.run('ad:PCB:CreateUnion')"); page.wait_for_timeout(150)
    un = page.evaluate(f"({ED}.doc.unionNames || []).map(u => u.name)")
    check(f"Tools › Convert › Create Union from selected objects: a named union ({un})", un == ["Unions"])
    page.evaluate("window.konium.run('ad:PCB:BreakAllUnions')"); page.wait_for_timeout(150)
    page.locator(".dlg.confirm .btn", has_text="Yes").click(); page.wait_for_timeout(150)
    check("Break All Unions, after Confirm", page.evaluate(f"({ED}.doc.unionNames || []).length") == 0)
    page.keyboard.press("Control+z"); page.keyboard.press("Control+z"); page.wait_for_timeout(100)
    page.evaluate("window.konium.run('ad:PCB:RunGridManager')"); page.wait_for_timeout(150)
    check("Grid Manager: the board's global grid", "Grid Manager" in page.locator(".dlg").inner_text() and "Global Board Snap Grid" in page.locator(".dlg").inner_text())
    page.keyboard.press("Escape")
    page.evaluate("window.konium.run('ad:PCB:PlaceDrillTable')"); page.wait_for_timeout(100)
    bx0 = page.evaluate(f"(() => {{ const o = {ED}.doc.board.outline; return [Math.max(...o.map(p => p.x)) + 2000000, Math.max(...o.map(p => p.y))]; }})()")
    sx, sy = page.evaluate(TO_SCREEN, bx0); page.mouse.move(sx, sy); page.wait_for_timeout(100); page.mouse.click(sx, sy); page.wait_for_timeout(200)
    dt = page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'text' && /Symbol|Count|Hole Size/.test(p.text)).length")
    check(f"Place › Drill Table: a table of the holes on the Drill Drawing layer, in a union ({dt} headings)", dt >= 3 and "Drill Tables" in page.evaluate(f"JSON.stringify({ED}.doc.unionNames || [])"))
    shot(page, "54-drill-table.png")
    page.keyboard.press("Control+z"); page.wait_for_timeout(100)
    page.evaluate("window.konium.run('ad:PCB:UnRouteAll')"); page.wait_for_timeout(300)
    CONNS = "window.konium.state.active.value.editor.doc.prims.filter(p => p.kind === 'track' && p.layer <= 32 && p.polygon === 0xffff).length"
    t0 = page.evaluate(CONNS)
    page.evaluate("window.konium.run('ad:PCB:AutorouteAll')"); page.wait_for_timeout(200)
    check("Route › Auto Route › All: Routing Strategies with Route All", "Routing Strategies" in page.locator(".dlg").inner_text() and page.locator(".dlg .dlg-foot .btn", has_text="Route All").count() == 1)
    page.locator(".dlg .dlg-foot .btn", has_text="Route All").click(); page.wait_for_timeout(2500)
    msgs = page.evaluate("window.konium.state.messages.value.filter(m => m.source === 'Auto Route').map(m => m.message)")
    viol = page.evaluate(f"{ED}.violations.filter(v => v.kind === 'Clearance' || v.kind === 'ShortCircuit').length")
    # (components placed off the board by the ECO checks above stay unrouted: nothing routes outside the board)
    left_in = len([m for m in msgs if m.startswith("Not routed")])
    # pads of components off the board: each can leave at most one connection unrouted
    off = page.evaluate(f"(() => {{ const ed = {ED}, o = ed.doc.board.outline, xs = o.map(p => p.x), ys = o.map(p => p.y); const out = new Set(ed.doc.components.map((c, i) => [c, i]).filter(([c]) => c.at.x > Math.max(...xs) || c.at.x < Math.min(...xs) || c.at.y > Math.max(...ys) || c.at.y < Math.min(...ys)).map(([, i]) => i)); return ed.doc.prims.filter(p => p.kind === 'pad' && out.has(p.component) && p.net !== 0xffff).length; }})()")
    check(f"Auto Route All: the board's connections routed, no clearance errors ({t0} → {page.evaluate(CONNS)} tracks; {left_in} left, {off} pads off the board)",
          page.evaluate(CONNS) > t0 and any(m.startswith("Routing finished") for m in msgs) and viol == 0 and left_in <= off)
    shot(page, "55-autoroute.png")
    page.keyboard.press("Control+z"); page.wait_for_timeout(200)
    page.evaluate("window.konium.run('ad:PCB:FanoutAll')"); page.wait_for_timeout(150)
    page.locator(".dlg .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(400)
    check("Route › Fanout › All: a via out from every surface-mount pad", page.evaluate(f"{ED}.undo.undoLabel") == "Fanout all" and page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'via').length") >= 8)
    page.keyboard.press("Control+z"); page.keyboard.press("Control+z"); page.wait_for_timeout(200)
    pos0 = page.evaluate(f"{ED}.doc.components.map(c => c.at.x + ',' + c.at.y).join(' ')")
    page.evaluate("window.konium.run('ad:AutoPlacer:RunAutoPlacer')"); page.wait_for_timeout(150)
    page.locator(".dlg .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(800)
    check("Tools › Component Placement › Auto Placer: components moved in one undo step", page.evaluate(f"{ED}.doc.components.map(c => c.at.x + ',' + c.at.y).join(' ')") != pos0 and page.evaluate(f"{ED}.undo.undoLabel") == "Auto Placer")
    page.keyboard.press("Control+z"); page.wait_for_timeout(200)
    check("…undo puts them back", page.evaluate(f"{ED}.doc.components.map(c => c.at.x + ',' + c.at.y).join(' ')") == pos0)

    # 26.040: Gerber X2, IPC-2581, ODB++, STEP export, Stackup Compatibility Report, Board Planning Mode, 3D measuring
    # (outputs land in the project's folder, or are saved as a .zip when the project has none: both caught here)
    page.evaluate("""() => { window.__saves = []; window.__ssfp = window.showSaveFilePicker;
      window.showSaveFilePicker = async (o) => ({ createWritable: async () => ({ write: async (b) => { window.__saves.push({ name: o.suggestedName, text: new TextDecoder('latin1').decode(b) }); }, close: async () => {} }) }); }""")
    OUTPUT = """(n) => { const w = window.__written ? Object.entries(window.__written).find(([k]) => k.endsWith('/' + n)) : null;
      if (w) return w[1]; const s = window.__saves.find((x) => x.name === n || x.text.includes(n)); return s ? s.text : ''; }"""
    page.evaluate("window.konium.run('output.gerberX2')"); page.wait_for_timeout(200)
    page.locator(".out-tabs button", has_text="Layers").click(); page.wait_for_timeout(100)
    check("Fabrication Outputs › Gerber X2 Files: Gerber X2 Setup, the layers by file function",
          page.locator(".dlg[aria-label='Gerber X2 Setup']").count() == 1 and "Copper,L1,Top" in page.locator(".dlg").inner_text())
    shot(page, "56-gerber-x2-setup.png")
    page.locator(".dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(600)
    page.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(400)
    gtl = page.evaluate(OUTPUT, "Demo-Copper_Signal_Top.gbr")
    check("Gerber X2 files written, with file, aperture and object attributes",
          "%TF.FileFunction,Copper,L1,Top*%" in gtl and "%TA.AperFunction,SMDPad,CuDef*%" in gtl and "%TO.N,GND*%" in gtl and page.evaluate(OUTPUT, "Demo-Profile.gbr") != "")
    page.evaluate("window.konium.run('output.ipc2581')"); page.wait_for_timeout(200)
    check("IPC-2581 Files: its configuration", page.locator(".dlg[aria-label='IPC-2581 Configuration']").count() == 1)
    page.locator(".dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(600)
    xml = page.evaluate(OUTPUT, "Demo.xml")
    check("IPC-2581 written: revision B, components, nets", '<IPC-2581 revision="B"' in xml and '<Component refDes="U1"' in xml and '<LogicalNet name="GND">' in xml)
    page.evaluate("window.konium.run('output.odb')"); page.wait_for_timeout(200)
    page.locator(".dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(1200)
    check("ODB++ Files: the job as demo.tgz", page.evaluate(OUTPUT, "demo.tgz") != "")
    page.locator(".menubar-item", has_text="File").first.click(); page.wait_for_timeout(150)
    page.locator(".menu-popup .menu-item", has_text="Export").first.hover(); page.wait_for_timeout(200)
    check("File › Export › STEP 3D", page.locator(".menu-popup .menu-item", has_text="STEP 3D").count() >= 1)
    page.locator(".menu-popup .menu-item", has_text="STEP 3D").first.click(); page.wait_for_timeout(200)
    check("STEP 3D: Export STEP options", page.locator(".dlg[aria-label='Export STEP']").count() == 1)
    page.locator(".dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(1500)
    saved = page.evaluate("window.__saves.find((x) => x.name === 'Demo.step') || null")
    check(f"…Demo.step: an AP214 assembly, the board a solid, each component a part ({(saved or {}).get('name')})",
          bool(saved) and saved["name"] == "Demo.step" and saved["text"].startswith("ISO-10303-21;") and "AUTOMOTIVE_DESIGN" in saved["text"] and "NEXT_ASSEMBLY_USAGE_OCCURRENCE('NAUO1','Demo PCB'" in saved["text"])
    page.evaluate("window.konium.run('ad:PCB:ReportLayerStackupCompatibility')"); page.wait_for_timeout(200)
    check("Reports › Stackup Compatibility Report: the stack and its checks", "Stackup Compatibility Report for Demo.PcbDoc" in page.locator(".dlg.report").inner_text() and "Checks" in page.locator(".dlg.report").inner_text())
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    page.evaluate("window.konium.run('view.modePlanning')"); page.wait_for_timeout(300)
    check("View › Board Planning Mode: the board as its region", page.evaluate(f"{ED}.planning") and "Board Planning Mode" in page.evaluate(f"{ED}.hint()"))
    shot(page, "57-board-planning.png")
    bc = page.evaluate(f"(() => {{ const o = {ED}.doc.board.outline; const xs = o.map(p => p.x), ys = o.map(p => p.y); return [(Math.min(...xs) + Math.max(...xs)) / 2, Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * 0.2]; }})()")
    bx, by = page.evaluate(TO_SCREEN, bc)
    page.mouse.dblclick(bx, by); page.wait_for_timeout(200)
    check("…double-click: Board Region with its layer stack", page.locator(".dlg.board-region input[aria-label='Name']").input_value() == "Layer Stack Region 1" and "Layer Stack" in page.locator(".dlg").inner_text())
    page.keyboard.press("Enter"); page.wait_for_timeout(100)
    page.evaluate("window.konium.run('view.mode2d')"); page.wait_for_timeout(200)
    check("…2D Layout Mode again", not page.evaluate(f"{ED}.planning"))
    page.evaluate("window.konium.run('ad:PCB:Measure3DObjects')"); page.wait_for_timeout(900)
    check("Measure 3D Objects: in 3D Layout Mode, asks for the first point", page.evaluate(f"{ED}.mode3d") and "Measure 3D Objects" in page.evaluate(f"{ED}.hint()"))
    vb = page.locator(".viewer3d").bounding_box()
    page.mouse.click(vb["x"] + vb["width"] / 2 - 80, vb["y"] + vb["height"] / 2); page.wait_for_timeout(200)
    page.mouse.click(vb["x"] + vb["width"] / 2 + 80, vb["y"] + vb["height"] / 2); page.wait_for_timeout(300)
    check("…two clicks: the distance between them", page.locator(".dlg", has_text="Distance").count() == 1 and "mm" in page.locator(".dlg").inner_text())
    shot(page, "58-measure-3d.png")
    page.keyboard.press("Enter"); page.wait_for_timeout(100)
    # 26.046: View Configurations in 3D: Physical Materials (colours, opacity, projection, bodies), the 3D configurations
    page.evaluate("window.konium.run('pcb.viewConfigurations')"); page.wait_for_timeout(300)
    vc = page.locator(".dlg.viewcfg")
    check("3D: View Configurations opens on Physical Materials", vc.count() == 1 and "Physical Materials" in vc.inner_text() and "Top Solder Mask" in vc.inner_text())
    vc.locator(".vc-swatch[aria-label='Red solder mask']").click()
    vc.locator("input[aria-label='Core opacity']").fill("60")
    vc.get_by_label("Orthographic").check()
    shot(page, "59-physical-materials.png")
    vc.locator(".dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(1500)
    p3 = page.evaluate("window.konium.prefs.get().pcb3d")
    check(f"…OK: red mask, see-through core, orthographic ({p3['maskTop']}, {p3['coreOpacity']}, {p3['projection']})", p3["maskTop"] == "#8c1010" and p3["coreOpacity"] == 60 and p3["projection"] == "orthographic")
    shot(page, "60-3d-red.png")
    page.evaluate("window.konium.run('pcb.viewConfigurations')"); page.wait_for_timeout(300)
    page.locator(".dlg.viewcfg [role=option]", has_text="3D Dk Green").click()
    check("…a 3D configuration picked: its name", "Current configuration: 3D Dk Green" in page.locator(".dlg.viewcfg").inner_text())
    page.locator(".dlg.viewcfg .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(800)
    check("…3D Dk Green again", page.evaluate("window.konium.prefs.get().pcb3d.projection") == "perspective")
    page.mouse.move(vb["x"] + vb["width"] / 2, vb["y"] + vb["height"] / 2)
    page.keyboard.press("2"); page.wait_for_timeout(300)
    p3d = page.evaluate("""async () => { const notes = []; const pages = await window.konium.outjob.outputPages(null, { n: 9, type: 'PCB 3D Print', name: 'PCB 3D Print', category: 'Documentation', document: 'Demo.PcbDoc', enabled: true, media: new Map(), rest: [] }, notes);
      return { names: pages.map(p => p.name), png: pages.every(p => p.svg.includes('data:image/png;base64,') && p.svg.length > 20000), notes }; }""")
    # 26.047: barcode strings, pad Jumper IDs, Impedance Calculation
    page.evaluate(f"window.konium.editObject({ED}, 'Texts6:5')"); page.wait_for_timeout(300)
    sd = page.locator(".dlg.pd")
    sd.locator("label", has_text="BarCode").locator("input").check(); page.wait_for_timeout(150)
    check("String › Font BarCode: the barcode's settings (type, render mode, sizes, margins, Show Text, Inverted)", "Barcode Text" in sd.inner_text() and sd.locator("select[aria-label='Barcode type']").count() == 1)
    sd.locator("select[aria-label='Barcode type']").select_option("1")
    sd.locator(".dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(300)
    bc = page.evaluate(f"(() => {{ const p = {ED}.doc.prims.find(p => p.src.storage === 'Texts6' && p.src.index === 5); return p && p.barcode ? [p.barcode.type, p.fontType] : null; }})()")
    check(f"…OK: the String is a Code 128 barcode ({bc})", bc == ['code128', 2])
    shot(page, "63-barcode.png")
    # A component's pad opens the Pad dialog once the component's primitives are unlocked
    PADK = f"(() => {{ const p = {ED}.doc.prims.find(p => p.kind === 'pad'); const c = {ED}.doc.components[p.component]; if (c) c.bag.set('PRIMITIVELOCK', 'FALSE'); return p.src.storage + ':' + p.src.index; }})()"
    page.evaluate(f"window.konium.editObject({ED}, '" + page.evaluate(PADK) + "')"); page.wait_for_timeout(300)
    ji = page.locator(".dlg input[aria-label='Jumper ID']")
    check("Pad › Jumper ID can be set", ji.count() == 1 and ji.is_enabled())
    ji.fill("3"); ji.dispatch_event("change")
    page.locator(".dlg .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(300)
    check("…kept in the pad (offset 110, as AD17 writes it)", page.evaluate(f"{ED}.doc.prims.find(p => p.kind === 'pad').jumper") == 3)
    page.evaluate("window.konium.run('pcb.layerStackManager')"); page.wait_for_timeout(300)
    page.locator(".lsm .btn", has_text="Impedance Calculation").click(); page.wait_for_timeout(300)
    imp = page.locator(".dlg.impedance")
    rows = imp.locator(".imp-table tbody tr").count()
    check(f"Layer Stack Manager › Impedance Calculation: AD17's Impedance Formula Editor, the formulas worked out per layer ({rows} rows)",
          imp.count() == 1 and "Calculated Impedance" in imp.inner_text() and "Calculated Trace Width" in imp.inner_text() and rows >= 2 and "Microstrip" in imp.locator(".imp-table").inner_text())
    shot(page, "64-impedance.png")
    imp.locator(".dlg-foot .btn", has_text="Cancel").click(); page.wait_for_timeout(150)
    page.locator(".dlg .dlg-foot .btn", has_text="Cancel").last.click(); page.wait_for_timeout(150)
    check("Preferences › Interactive Routing: Allow Via Pushing on, Hugging Style Mitered With Lines", page.evaluate("[window.konium.prefs.get().pcbAllowViaPushing, window.konium.prefs.get().pcbHugStyle].join()") == "true,lines")
    # The menu bar: moving along it with a menu open, each menu opens under its own title
    page.locator(".menubar-item", has_text="File").first.dispatch_event("mousedown"); page.wait_for_timeout(150)
    for t in ("Help", "Project"):
        page.locator(".menubar-item", has_text=t).first.hover(); page.wait_for_timeout(150)
    px = page.locator(".menubar-item", has_text="Project").first.bounding_box()["x"]
    mx = page.locator(".menu-popup[data-depth='0']").bounding_box()["x"]
    check(f"Moving along the menu bar: Project's menu opens under Project ({mx:.0f} / {px:.0f})", abs(mx - px) < 3)
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    check(f"Documentation Outputs › PCB 3D Print: top, bottom and isometric views ({p3d['names']}{p3d['notes']})", len(p3d["names"]) == 3 and p3d["png"])

    # 26.041: Draftsman, Update From PCB Libraries, subnet jumpers, physical nets, netlists, the IPC footprint wizard
    page.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('file.newDraftsman')"); page.wait_for_timeout(1200)
    dname = page.evaluate("window.konium.state.active.value.name")
    ditems = page.locator(".draftdoc .dd-hit").evaluate_all("els => els.map(e => e.getAttribute('aria-label'))")
    check(f"File › New › Draftsman Document (26.089: a .PCBDwf document): {dname}, its sheet laid out ({', '.join(ditems)})",
          dname.endswith(".PCBDwf") and "Drill Table" in ditems and "Bill of Materials" in ditems and "Title Block" in ditems and "Board Assembly View (Top)" in ditems and "Board Fabrication View" in ditems
          and page.locator(".draftdoc .dd-art > svg").count() == 1 and "Drill Table" in page.locator(".draftdoc .dd-art").inner_html())
    shot(page, "59-draftsman.png")
    tb = page.locator(".draftdoc .dd-hit[aria-label='Title Block']")
    bb = tb.bounding_box()
    x0 = None
    page.mouse.click(bb["x"] + 20, bb["y"] + 20); page.wait_for_timeout(200)
    x0 = page.locator(".draftdoc .dd-props input").first.input_value()
    page.mouse.move(bb["x"] + 20, bb["y"] + 20); page.mouse.down(); page.mouse.move(bb["x"] - 80, bb["y"] - 40, steps=6); page.mouse.up(); page.wait_for_timeout(300)
    x1 = page.locator(".draftdoc .dd-props input").first.input_value()
    page.locator(".draftdoc .dd-bar .btn", has_text="Undo").click(); page.wait_for_timeout(300)
    page.mouse.click(bb["x"] + 20, bb["y"] + 20); page.wait_for_timeout(200)
    x2 = page.locator(".draftdoc .dd-props input").first.input_value()
    check(f"…an item dragged (title block X {x0} → {x1} mm) and the move undone ({x2} mm)", x0 and x1 and float(x1) < float(x0) - 5 and x2 == x0)
    page.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('ad:WorkspaceManager:ConfigurePCBLibrarySynch')"); page.wait_for_timeout(300)
    check("Tools › Update From PCB Libraries: the board's footprints against the libraries'", "differ from their library footprint" in page.locator(".dlg").inner_text())
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    split = page.evaluate(f"""(() => {{ const e = {ED}; e.currentLayer = 1; const len = (p) => Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
      const t = e.doc.prims.filter(p => p.kind === 'track' && p.layer === 1 && p.polygon === 0xffff && len(p) > 400000 && p.net !== 0xffff).sort((a, b) => len(a) - len(b))[0];
      e.select([t.src.storage + ':' + t.src.index]); e.deleteSelection(); return e.doc.nets[t.net].name; }})()""")
    page.evaluate("window.konium.run('ad:PCB:ConnectSubnets')"); page.wait_for_timeout(200)
    # (26.185: the box starts from Interactive Routing's Preferred Subnet Jumper Length, 20 mil; the gap made here wants more)
    jl = page.locator(".dlg input[aria-label='Maximum Jumper Length']"); jl.fill("10mm"); jl.press("Tab"); page.wait_for_timeout(150)
    page.locator(".dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(300)
    check(f"Route › Add Subnet Jumpers: {split} joined again, the jumper in a Subnet Jumpers union",
          page.evaluate(f"{ED}.undo.undoLabel") == "Add subnet jumpers" and "Subnet Jumpers" in page.evaluate(f"JSON.stringify({ED}.doc.unionNames || [])"))
    page.evaluate("window.konium.run('ad:PCB:RemoveSubnetJumpers')"); page.wait_for_timeout(200)
    check("Route › Remove Subnet Jumpers", page.evaluate(f"{ED}.undo.undoLabel") == "Remove subnet jumpers" and "Subnet Jumpers" not in page.evaluate(f"JSON.stringify({ED}.doc.unionNames || [])"))
    for _ in range(3):
        page.evaluate(f"{ED}.undo.undo()"); page.wait_for_timeout(60)
    page.evaluate("window.konium.run('ad:PCB:ConfigurePhysicalNets')"); page.wait_for_timeout(300)
    check("Design › Netlist › Configure Physical Nets: the pieces of connected copper", "pieces of connected copper" in page.locator(".dlg").inner_text())
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    page.locator(".doctab", has_text="Demo.SchDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('netlist.project.edif')"); page.wait_for_timeout(600)
    edf = page.evaluate(OUTPUT, "Demo.EDF")
    check("Design › Netlist For Project › EDIF for PCB: Demo.EDF", "(edif Demo" in edf and "(instance U1" in edf)
    page.evaluate("""() => { const f = window.konium.demoFiles().find((x) => x.name === 'Demo.PcbLib'); window.konium.openDocument({ name: 'Demo.PcbLib', bytes: f.bytes }); }"""); page.wait_for_timeout(600)
    n0 = page.evaluate(f"{ED}.lib.footprints.length")
    page.evaluate("window.konium.run('ad:IPCFootprintWizard:Run')"); page.wait_for_timeout(300)
    page.locator(".dlg select[aria-label='Component Type']").select_option("QFN"); page.wait_for_timeout(200)
    nm = page.input_value(".dlg input[aria-label='Footprint Name']")
    check(f"Tools › IPC Compliant Footprint Wizard: a QFN by IPC-7351B, named for it ({nm})", nm == "QFN50P500X500X90-33N" and "Z " in page.locator(".dlg").inner_text())
    shot(page, "60-ipc-wizard.png")
    page.locator(".dlg-foot .btn", has_text="Finish").click(); page.wait_for_timeout(300)
    check("…Finish adds it to the library", page.evaluate(f"{ED}.lib.footprints.length") == n0 + 1 and page.evaluate(f"{ED}.entry.name") == "QFN50P500X500X90-33N" and page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'pad').length") == 33)
    page.evaluate("() => { window.showSaveFilePicker = window.__ssfp; }")

    # 26.043: alternate parts and parameter variations, database links, BOM documents
    # (on the Demo sheet's parts as earlier steps left them)
    page.locator(".doctab", has_text="Demo.SchDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(300)
    live = page.evaluate("""() => { const d = window.konium.state.docs.value.find(x => x.name === 'Demo.SchDoc').doc;
      return d.objects.filter(o => o.kind === 'component' && o.designator && !o.designator.endsWith('?')).map(o => [o.designator, (d.objects.find(c => c.owner === o.index && c.kind === 'text' && c.role === 'parameter' && d.records[c.index + 1].bag.get('NAME') === 'Comment') || {}).text || '']); }""")
    picks = [x for x in live if x[0] != "R1" and x[1]]
    pa, pb = picks[0], next(x for x in picks[1:] if x[1] != picks[0][1])
    page.evaluate("""([ca, cb]) => { window.__saves = []; window.__ssfp = window.showSaveFilePicker; window.__sofp = window.showOpenFilePicker;
      window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, createWritable: async () => ({ write: async (b) => { window.__saves.push({ name: o.suggestedName, text: new TextDecoder('latin1').decode(b) }); }, close: async () => {} }) });
      const csv = `Comment,Manufacturer,Manufacturer Part Number\r\n${ca},Yageo,RC0805FR-071KL\r\n${cb},Kingbright,APT2012SGC\r\n`;
      window.showOpenFilePicker = async () => [{ kind: 'file', name: 'Parts.csv', getFile: async () => new File([csv], 'Parts.csv') }]; }""", [pa[1], pb[1]])
    page.evaluate("window.konium.run('ad:WorkspaceManager:VariantManagement')"); page.wait_for_timeout(300)
    # A variant of its own (the demo may have been opened afresh since Variant1 was made)
    page.locator(".variants .dlg-foot .btn", has_text="Add Variant").click(); page.wait_for_timeout(150)
    page.locator(".dlg", has_text="Add Variant").locator("input").fill("V43"); page.keyboard.press("Enter"); page.wait_for_timeout(150)
    page.locator(".variants select[aria-label='R1 in V43']").select_option("1"); page.wait_for_timeout(100)
    page.locator(f".variants select[aria-label='{pa[0]} in V43']").select_option("2"); page.wait_for_timeout(200)
    alt = page.locator(".dlg", has_text=f"Alternate Part For {pa[0]}")
    alt.locator("input[aria-label='Alternate library reference']").fill("ALT_PART"); alt.locator("input[aria-label='Alternate footprint']").fill("ALT0603")
    alt.locator(".dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(150)
    check(f"Variants › Alternate: {pa[0]}'s alternate part in V43", "→ ALT_PART (ALT0603)" in page.locator(".variants").inner_text())
    page.locator(".variants .va-row", has_text=pb[0]).first.dispatch_event("mousedown"); page.wait_for_timeout(100)
    page.locator(".variants .dlg-foot .btn", has_text="Edit Parameters").click(); page.wait_for_timeout(150)
    page.locator(".dlg input[aria-label='Comment in V43']").fill("47µF")
    page.locator(".dlg", has_text="Edit Component Parameters").locator(".dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(150)
    shot(page, "63-variant-alternates.png")
    page.locator(".variants .dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(200)
    lines = page.evaluate("window.konium.state.projects.value.find(x => x.name === 'Demo.PrjPcb').prj.lines.join('\\n')")
    check("…written as AD writes them: Kind=2 with its AltLibLink_ fields, ParamVariation / ParamDesignator",
          "Kind=2" in lines and "AltLibLink_DesignItemID=ALT_PART" in lines and "AltLibLink_Footprint=ALT0603" in lines and "ParameterName=Comment|VariantValue=47µF" in lines and f"={pb[0]}" in lines)
    # A database link: its data file, the key, then Update Parameters From Database
    page.evaluate("window.konium.run('ad:WorkspaceManager:NewDatabaseLink')"); page.wait_for_timeout(400)
    page.locator(".dblink .btn", has_text="Browse").click(); page.wait_for_timeout(500)
    dl = page.locator(".dblink")
    check("File › New › Library › Database Link File: the CSV's table and fields, each mapped to its parameter", dl.count() == 1 and "Connected: 1 table" in dl.inner_text() and "Parts.csv" in dl.inner_text()
          and page.input_value(".dblink input[aria-label='Parameter for Manufacturer']") == "Manufacturer")
    page.locator(".dblink select[aria-label='Key database field']").select_option("Comment")
    page.locator(".dblink input[aria-label='Key part parameter']").fill("Comment")
    shot(page, "64-database-link.png")
    show_panel(page, "projects")
    check("…in the project, listed with its libraries", "Database_Link1.DbLink" in page.locator(".panel[aria-label=Projects]").inner_text())
    page.locator(".doctab", has_text="Demo.SchDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('ad:WorkspaceManager:ConfigureDatabaseUpdate')"); page.wait_for_timeout(600)
    sc = page.locator(".dlg.dbchanges")
    check("Tools › Update Parameters From Database: Select Parameter Changes, the parts found by their key", sc.count() == 1 and "RC0805FR-071KL" in sc.inner_text() and "Kingbright" in sc.inner_text() and "parts found" in sc.inner_text())
    sc.locator(".btn", has_text="Accept Changes").click(); page.wait_for_timeout(300)
    mfr = page.evaluate("(() => { const d = window.konium.state.docs.value.find(x => x.name === 'Demo.SchDoc').doc; return [...new Set(d.objects.filter(o => o.kind === 'text' && o.role === 'parameter' && d.records[o.index + 1].bag.get('NAME') === 'Manufacturer').map(o => o.text))].sort(); })()")
    check(f"…the parts take the database's values, one undo step ({mfr})", mfr == ["Kingbright", "Yageo"] and page.evaluate(f"{ED}.undo.undoLabel") == "Update parameters from database")
    # A BOM document: the project's parts, for a variant, exported
    page.evaluate("window.konium.run('ad:WorkspaceManager:NewBOM')"); page.wait_for_timeout(600)
    bom = page.locator(".bomdoc")
    t0 = bom.locator("table").inner_text()
    check("File › New › BOM Document: Demo.BomDoc, the project's parts grouped", bom.count() == 1 and "Demo.BomDoc" in page.locator(".doctab.on").inner_text() and "R1" in t0 and pa[0] in t0)
    bom.locator("select[aria-label='Variant']").select_option("V43"); page.wait_for_timeout(300)
    t1 = bom.locator("table").inner_text()
    check("…for V43: R1 not fitted (left out), the alternate part fitted, a varied comment", "R1" not in t1.replace(",", " ").split() and "ALT0603" in t1 and "47µF" in t1)
    shot(page, "65-bom-document.png")
    bom.locator("input[aria-label='Show Manufacturer']").check(); page.wait_for_timeout(200)
    bom.locator(".btn", has_text="Export...").first.click(); page.wait_for_timeout(500)
    x = page.evaluate("(window.__saves.find((s) => s.name === 'Demo.xlsx') || {}).text || ''")
    check("…Export: Demo.xlsx with the database's Manufacturer column", "Manufacturer" in x and "Kingbright" in x)
    # 26.092: ActiveBOM — a line looked up at JLCPCB (the service stubbed), its part added; the run's cost; the checks; JLCPCB's assembly BOM
    bom.locator("select[aria-label='Variant']").select_option(""); page.wait_for_timeout(300)
    page.evaluate("""() => { window.__fetch0 = window.fetch; window.fetch = async (u, o) => String(u).includes('jlcsearch.tscircuit.com') ? new Response(JSON.stringify({ components: [
      { lcsc: 25744, mfr: '0402WGF1002TCE', package: '0402', description: 'Thick film resistor 10k 0402', stock: 2500000, price: '[{"qFrom":20,"qTo":180,"price":0.0009},{"qFrom":200,"qTo":null,"price":0.0004}]', is_basic: true },
      { lcsc: 60490, mfr: 'RC0402FR-0710KL', package: '0402', description: '10k 1% 0402', stock: 50, price: '[{"qFrom":10,"price":0.0012}]', is_basic: false } ] }), { status: 200 }) : window.__fetch0(u, o); }""")
    chk0 = bom.locator(".bom-checks legend").inner_text()
    r1row = lambda: bom.locator("tbody tr").filter(has=page.locator("td", has_text=re.compile(r"^R1$")))
    r1row().first.click(); page.wait_for_timeout(300)
    q0 = bom.locator("input[aria-label^='Search JLCPCB']").input_value()
    bom.locator(".bom-search .btn").click(); page.wait_for_timeout(600)
    hits = bom.locator(".bom-hits tbody tr").count()
    bom.locator(".bom-hits tbody tr", has_text="C60490").locator(".link").click(); page.wait_for_timeout(300)
    bom.locator("input[aria-label='Production Quantity']").fill("100"); bom.locator("input[aria-label='Production Quantity']").press("Tab"); page.wait_for_timeout(400)
    tot = bom.locator(".bom-total").inner_text(); chk1 = bom.locator(".bom-checks").inner_text(); row = r1row().first.inner_text()
    check(f"BOM document › Solutions: R1 looked up at JLCPCB by '{q0}' ({hits} found), C60490 added: its line priced, the run's cost ('{tot.splitlines()[0] if tot else ''}'), stock short for 100 boards flagged ({chk0} → {chk1.splitlines()[0] if chk1 else ''})",
          hits == 2 and "C60490" in row and "RC0402FR-0710KL" in row and "$0.1200" in tot and "Insufficient stock" in chk1)
    bom.locator(".btn", has_text="Export For JLCPCB").click(); page.wait_for_timeout(500)
    jl = page.evaluate("(window.__saves.find((s) => /_JLCPCB_BOM\\.csv$/.test(s.name)) || {}).text || ''")
    check(f"…Export For JLCPCB: Comment, Designator, Footprint, LCSC Part # ({jl.splitlines()[0] if jl else ''} / {[l for l in jl.splitlines() if 'C60490' in l][:1]})", jl.startswith("Comment,Designator,Footprint,LCSC Part #") and any(l.split(",")[1] == "R1" and l.endswith(",C60490") for l in jl.splitlines()))
    # 26.093: Fill Part Numbers With AI (the service stubbed): a part for each line with none, each looked up at JLCPCB; the one found there added
    mpn_jobs = []
    def mpn_route(route):
        if route.request.url.endswith("/config"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"models": [{"id": "m/vision", "name": "Vision", "vision": True, "roles": ["text", "vision"]}],
                                 "defaults": {"model": "m/vision"}, "allowance": {"jobs": 20, "left": 20}, "shareCache": True, "jobs": ["mpn", "ping"]}))
        body = json.loads(route.request.post_data); mpn_jobs.append(body)
        ids = [l["id"] for l in body["input"]["lines"]]
        ans = {"parts": [{"id": ids[0], "manufacturer": "UNI-ROYAL", "mpn": "0402WGF1002TCE", "lcsc": "C25744", "confidence": "high", "why": "Stand-in."}]
               + [{"id": i, "manufacturer": "Acme", "mpn": "NOPE-1", "lcsc": "", "confidence": "medium", "why": "Stand-in."} for i in ids[1:2]]}
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": ans, "usage": {"in": 900, "out": 120, "cost": 0.001}, "model": "m/vision", "allowance": {"jobs": 20, "left": 19}}))
    page.route("https://konium.app/api/ai/**", mpn_route)
    page.evaluate("window.konium.prefs.set({ aiMode: 'konium' })")
    bom.locator(".btn", has_text="Fill Part Numbers With AI").click(); page.wait_for_timeout(600)
    fd = page.locator(".dlg.bom-ai")
    setup = fd.inner_text()
    fd.locator(".btn", has_text="Suggest Parts").click(); page.wait_for_timeout(1500)
    frows = fd.locator("tbody tr").all_inner_texts()
    first_des = fd.locator("tbody tr").first.locator("td").nth(1).inner_text().split(",")[0].strip() if frows else ""
    ticked = fd.locator("tbody input[type=checkbox]:checked").count()
    sent = mpn_jobs[0]["input"] if mpn_jobs else {}
    fd.locator(".btn", has_text="Add Ticked").click(); page.wait_for_timeout(400)
    frow = bom.locator("tbody tr").filter(has=page.locator("td", has_text=re.compile("^" + re.escape(first_des) + "(,|$)"))).first.inner_text() if first_des else ""
    check(f"BOM document › Fill Part Numbers With AI: the lines with no part choices sent ({len(sent.get('lines', []))}, for JLCPCB: {sent.get('prefer')}), each suggestion looked up at JLCPCB ({' | '.join(r.replace(chr(9), ' ').replace(chr(10), ' ')[:60] for r in frows)}); the one found there ticked and added to {first_des}",
          "Lines with no part choices" in setup and sent.get("prefer") == "jlcpcb" and len(frows) == 2 and "C25744" in frows[0] and "not at JLCPCB" in frows[1] and ticked == 1 and "C25744" in frow and "0402WGF1002TCE" in frow)
    page.evaluate("window.konium.prefs.set({ aiMode: 'off' })")
    page.unroute("https://konium.app/api/ai/**")
    page.evaluate("ed => window.konium.run('file.save')"); page.wait_for_timeout(600)
    saved = page.evaluate("(window.__saves.find((s) => s.name === 'Demo.BomDoc') || {}).text || ''")
    check("…saved as AD keeps ActiveBOM (records; the part choice with its price breaks)", saved.startswith("|RECORD=BOM|") and "|RECORD=PartChoice|" in saved and "|SUPPLIERPARTNO=C60490|" in saved and "|PRODUCTIONQUANTITY=100|" in saved)
    # 26.114: Digi-Key through Konium's parts service (stubbed): Mouser not set up there; a part added in pounds; the totals per currency
    parts_asked = []
    def parts_route(route):
        if route.request.url.endswith("/config"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"sources": [{"id": "digikey", "name": "Digi-Key", "ready": True}, {"id": "mouser", "name": "Mouser", "ready": False}], "left": 100, "perDay": 100, "cacheHours": 24}))
        parts_asked.append(json.loads(route.request.post_data))
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"parts": [{"supplier": "Digi-Key", "spn": "497-1234-1-ND", "mpn": "LD1117S33TR", "manufacturer": "STMicroelectronics", "description": "IC REG LINEAR 3.3V 800MA SOT223",
            "stock": 25000, "prices": [{"qty": 1, "price": 0.52}, {"qty": 100, "price": 0.31}], "currency": "GBP", "lifecycle": "Active", "url": "https://www.digikey.co.uk/x", "packaging": "Cut Tape (CT)", "moq": 1}], "at": 0, "left": 99}))
    page.route("https://konium.app/api/parts/**", parts_route)
    u1row = lambda: bom.locator("tbody tr").filter(has=page.locator("td", has_text=re.compile(r"^U1$")))
    u1row().first.click(); page.wait_for_timeout(300)
    bom.locator("select[aria-label='Search at']").select_option("mouser"); page.wait_for_timeout(500)
    mouser_note = bom.locator(".bom-add").inner_text(); mouser_off = bom.locator(".bom-search .btn").is_disabled()
    bom.locator("select[aria-label='Search at']").select_option("digikey"); page.wait_for_timeout(300)
    bom.locator("input[aria-label='Search Digi-Key']").fill("LD1117 3.3V SOT-223")
    bom.locator(".bom-search .btn").click(); page.wait_for_timeout(600)
    dk_note = bom.locator(".bom-add").inner_text(); dk_hits = bom.locator(".bom-hits tbody tr").count()
    bom.locator(".bom-hits tbody tr", has_text="497-1234-1-ND").locator(".link").click(); page.wait_for_timeout(300)
    tot2 = bom.locator(".bom-total").inner_text(); u1 = u1row().first.inner_text()
    check(f"BOM document › Solutions › Search at Digi-Key, through Konium's parts service (stubbed): Mouser shown as not set up there; the part found added to U1 in pounds; the cost added up per currency ('{tot2.splitlines()[0] if tot2 else ''}')",
          "aren't set up" in mouser_note and mouser_off and parts_asked and parts_asked[0] == {"source": "digikey", "q": "LD1117 3.3V SOT-223", "exact": False} and dk_hits == 1 and "99 new searches left" in dk_note
          and "497-1234-1-ND" in u1 and "£" in tot2 and "$" in tot2 and " + " in tot2 and "each currency added up on its own" in tot2)
    page.unroute("https://konium.app/api/parts/**")
    bom.locator("select[aria-label='Search at']").select_option("jlc"); page.wait_for_timeout(200)
    page.evaluate("() => { window.fetch = window.__fetch0; }")
    shot(page, "92-activebom.png")
    page.evaluate("() => { window.showSaveFilePicker = window.__ssfp; window.showOpenFilePicker = window.__sofp; }")

    # A database library: Demo.DbLib's records as parts in the Libraries panel, one placed, the library's own document
    show_panel(page, "projects")
    tree = page.locator(".panel[aria-label=Projects]").inner_text()
    check("Demo.DbLib in the project under Libraries › Database Libraries", "Database Libraries" in tree and "Demo.DbLib" in tree)
    page.locator(".doctab", has_text="Demo.SchDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(300)
    show_panel(page, "libraries")
    page.locator(".panel.libraries select[aria-label=Library]").select_option("Demo.DbLib/Parts$"); page.wait_for_timeout(1500)
    lp = page.locator(".panel.libraries")
    check(f"Libraries panel › Demo.DbLib/Parts$: its records as parts — key, description, footprint ({lp.locator('.lib-count').inner_text()})",
          "6 components" in lp.inner_text() and "RES-0805-10K" in lp.inner_text() and "Low-dropout regulator" in lp.inner_text() and "LED0805" in lp.inner_text())
    lp.locator(".grid-row", has_text="CAP-0805-100N").first.click(); page.wait_for_timeout(200)
    mods = lp.locator(".lib-models").inner_text()
    check("…a record's symbol (previewed) and footprint, found in the libraries it names", lp.locator(".lib-preview svg").count() == 1 and "Cap" in mods and "0805" in mods and "not found" not in mods)
    lp.locator(".btn.default").click(); page.wait_for_timeout(300)
    vp = page.locator(".viewport").bounding_box()
    page.mouse.move(vp["x"] + vp["width"] * 0.25, vp["y"] + vp["height"] * 0.8); page.wait_for_timeout(150)
    page.mouse.click(vp["x"] + vp["width"] * 0.25, vp["y"] + vp["height"] * 0.8); page.wait_for_timeout(300)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    placed = page.evaluate("""(() => { const d = window.konium.state.active.value.editor.doc; const c = d.objects.filter(o => o.kind === 'component').at(-1); const b = d.records[c.index + 1].bag;
      const ps = d.objects.filter(o => o.owner === c.index && o.record === 41).map(o => { const k = d.records[o.index + 1].bag; return k.get('NAME') + '=' + k.get('TEXT'); });
      return [b.get('SOURCELIBRARYNAME'), b.get('DATABASETABLENAME'), b.get('DESIGNITEMID'), b.get('LIBREFERENCE'), ps.sort().join(';')]; })()""")
    check(f"…Place: the part from the library's table, its key the Design Item ID, the record's parameters ({placed})",
          placed[:4] == ["Demo.DbLib", "Parts$", "CAP-0805-100N", "Cap"] and "Value=100nF" in placed[4] and "Manufacturer Part Number=C0805-100N-50V" in placed[4] and "Part Number=CAP-0805-100N" in placed[4])
    shot(page, "71-dblib-placed.png")
    page.evaluate("window.konium.run('ad:WorkspaceManager:ConfigureLibrarySynch')"); page.wait_for_timeout(400)
    ul = page.locator(".updatelib").inner_text()
    check("…Update From Libraries finds it again in its library's table", "Demo.DbLib" in ul and "Not found (Demo.DbLib)" not in ul)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    page.keyboard.press("Control+z"); page.wait_for_timeout(200)
    show_panel(page, "projects")
    page.locator(".tree-doc", has_text="Demo.DbLib").dblclick(); page.wait_for_timeout(1200)
    dv = page.locator(".dblib")
    check("Demo.DbLib opens: its database connected, the table, Part Number the key, the bracketed mappings", dv.count() == 1 and "Connected: 1 table" in dv.inner_text() and "Parts$" in dv.inner_text()
          and "Part Number (key)" in dv.inner_text() and page.input_value(".dblib input[aria-label='Parameter for Library Ref']") == "[Library Ref]")
    dv.locator("[role=tab]", has_text="Table Browser").click(); page.wait_for_timeout(300)
    check("…Table Browser: the table's records", "6 of 6 records" in dv.inner_text() and "LDO-3V3-SOT223" in dv.inner_text())
    shot(page, "72-dblib-document.png")

    # File › New › Project: AD17's New Project dialog; OK makes the project and saves it at once,
    # in a folder of its name (the folder selector stands in with a private folder of the browser's)
    page.evaluate("""async () => {
      const work = await (await navigator.storage.getDirectory()).getDirectoryHandle('Work', { create: true });
      window.__picked = 0; window.showDirectoryPicker = async () => { window.__picked++; return work; };
      // (headless Chromium crashes reading such a folder back from IndexedDB: no recent list from here on)
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    }""")
    LIST = """async (path) => { let d = await navigator.storage.getDirectory(); for (const s of path.split('/')) d = await d.getDirectoryHandle(s);
      const out = []; for await (const [n] of d.entries()) out.push(n); return out.sort(); }"""
    READ = """async (path) => { let d = await navigator.storage.getDirectory(); const ps = path.split('/');
      for (const s of ps.slice(0, -1)) d = await d.getDirectoryHandle(s); return await (await (await d.getFileHandle(ps.at(-1))).getFile()).text(); }"""
    page.evaluate("window.konium.run('file.newProject')"); page.wait_for_timeout(300)
    np = page.locator(".dlg.newproject")
    check("File › New › Project: AD17's New Project dialog (PCB Project, <Default>, PCB_Project)",
          np.count() == 1 and "PCB Project" in np.inner_text() and "<Default>" in np.inner_text() and page.input_value("#np-name") == "PCB_Project")
    page.fill("#np-name", "Blinky")
    np.locator(".btn", has_text="OK").click(); page.wait_for_timeout(800)
    check(f"OK asks for the Location and saves Blinky/Blinky.PrjPcb there ({page.evaluate(LIST, 'Work/Blinky')})",
          page.evaluate(LIST, "Work/Blinky") == ["Blinky.PrjPcb"] and page.evaluate("window.__picked") == 1)
    show_panel(page, "projects")
    check("the new project in the Projects panel: No Documents Added", "No Documents Added" in page.locator(".panel[aria-label=Projects]").inner_text())
    page.evaluate("window.konium.run('file.newSch')"); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('file.newPcb')"); page.wait_for_timeout(900)
    tree = page.locator(".panel[aria-label=Projects]").inner_text()
    check("File › New › Schematic and PCB go into the focused project", "Sheet1.SchDoc" in tree and "PCB1.PcbDoc" in tree and "Blinky.PrjPcb *" in tree)
    bb = page.evaluate(f"(() => {{ const v = {ED}.doc.board.vertices.map(v => v.p); const xs = v.map(p => p.x / 1e4), ys = v.map(p => p.y / 1e4);"
                       " return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), " + ED + ".doc.rules.length]; })()")
    check(f"File › New › PCB: AD17's new board, 6000 × 4000 mil from (1000, 1000), 35 rules ({bb})", bb == [1000, 1000, 7000, 5000, 35])
    shot(page, "17-new-pcb.png")
    page.keyboard.press("Control+s"); page.wait_for_timeout(600)
    check(f"Save puts PCB1.PcbDoc beside the project, no file selector ({page.evaluate(LIST, 'Work/Blinky')})", "PCB1.PcbDoc" in page.evaluate(LIST, "Work/Blinky") and page.evaluate("window.__picked") == 1)
    page.evaluate("window.konium.run('file.saveAll')"); page.wait_for_timeout(1200)
    prj = page.evaluate(READ, "Work/Blinky/Blinky.PrjPcb")
    check("Save All: the sheet and the project, with both documents", page.evaluate(LIST, "Work/Blinky") == ["Blinky.PrjPcb", "History", "PCB1.PcbDoc", "Sheet1.SchDoc"]
          and "DocumentPath=Sheet1.SchDoc" in prj and "DocumentPath=PCB1.PcbDoc" in prj and "Blinky.PrjPcb *" not in page.locator(".panel[aria-label=Projects]").inner_text())
    # 26.066: Local History — a save keeps the file it replaces, zipped in History beside the project (AD's Name.~(n).Ext.Zip); the Storage Manager; Auto Save
    check(f"Local History: the project file Save All replaced kept as History/Blinky.~(1).PrjPcb.Zip ({page.evaluate(LIST, 'Work/Blinky/History')})", page.evaluate(LIST, "Work/Blinky/History") == ["Blinky.~(1).PrjPcb.Zip"])
    pcb1 = page.evaluate(READ, "Work/Blinky/PCB1.PcbDoc")
    page.locator(".doctab", has_text="PCB1.PcbDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('place.via')"); page.mouse.move(700, 450); page.wait_for_timeout(100)
    page.mouse.click(700, 450); page.wait_for_timeout(150)
    page.mouse.click(700, 450, button="right"); page.keyboard.press("Escape"); page.wait_for_timeout(100)
    page.wait_for_timeout(300)
    # (IndexedDB is switched off from here on: Auto Save quietly keeps nothing)
    copies = page.evaluate("window.konium.backup.autoSaveNow()")
    page.keyboard.press("Control+s"); page.wait_for_timeout(1000)
    zipped = page.evaluate("""async () => { const b = await (await (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('Work')).getDirectoryHandle('Blinky')).getDirectoryHandle('History')).getFileHandle('PCB1.~(1).PcbDoc.Zip')).getFile();
      const z = new Uint8Array(await b.arrayBuffer()); const dv = new DataView(z.buffer); const n = dv.getUint16(26, true), c = dv.getUint32(18, true), m = dv.getUint16(8, true);
      const raw = z.subarray(30 + n, 30 + n + c); const out = m === 8 ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) : raw;
      return [new TextDecoder().decode(z.subarray(30, 30 + n)), m, out.length]; }""")
    check(f"…a board changed and saved: History/PCB1.~(1).PcbDoc.Zip holds the board as it was ({zipped}); without IndexedDB Auto Save keeps nothing, quietly ({copies})", copies == 0 and zipped[0] == "PCB1.PcbDoc" and zipped[1] == 8 and zipped[2] > 10000)
    page.evaluate("window.konium.run('view.panel.storage')"); page.wait_for_timeout(1200)
    sm = page.locator("section.storage")
    files = sm.locator("table[aria-label='Project Files'] tbody tr td:first-child").all_inner_texts()
    tl = [r.split('\t')[0] for r in sm.locator("table[aria-label='Local History'] tbody tr").all_inner_texts()]
    check(f"View › Workspace Panels › System › Storage Manager: the project's files, the board's time line ({files}; {tl})", files == ["Blinky.PrjPcb", "Sheet1.SchDoc", "PCB1.PcbDoc"] and tl == ["Document", "Last Saved Contents", "Version 1"])
    shot(page, "89-storage-manager.png")
    sm.locator("table[aria-label='Local History'] tbody tr", has_text="Version 1").first.click(button="right"); page.wait_for_timeout(200)
    page.locator(".menu-popup .menu-item", has_text="Show Autobackups").click(); page.wait_for_timeout(900)
    tl = [r.split('\t')[0] for r in sm.locator("table[aria-label='Local History'] tbody tr").all_inner_texts()]
    check(f"…Show Autobackups: none left once the board is saved ({tl})", tl == ["Document", "Last Saved Contents", "Version 1"])
    # 26.141: Compare: Version 1 beside the board as it is, the differences coloured and listed
    sm.locator("table[aria-label='Local History'] tbody tr", has_text="Version 1").first.click(button="right"); page.wait_for_timeout(200)
    page.locator(".menu-popup .menu-item", has_text="Compare").first.click(); page.wait_for_timeout(1500)
    crows = page.locator(".cmp-list tr").all_inner_texts()
    ctitles = page.locator(".cmp .pane-title").all_inner_texts()
    check(f"…Compare: Version 1 beside the board as it is, the via added since listed ({ctitles}; {crows})",
          len(ctitles) == 2 and "Version 1" in ctitles[0] and "as it is" in ctitles[1] and len(crows) == 1 and crows[0].startswith("+") and "Via" in crows[0])
    page.get_by_role("button", name="Close Compare").click(); page.wait_for_timeout(500)
    sm.locator("table[aria-label='Local History'] tbody tr", has_text="Version 1").first.click(button="right"); page.wait_for_timeout(200)
    page.locator(".menu-popup .menu-item", has_text="Revert to").click(); page.wait_for_timeout(200)
    page.locator(".dlg.confirm .btn", has_text="Yes").click(); page.wait_for_timeout(2000)
    vias = page.evaluate("window.konium.state.docs.value.find(d => d.name === 'PCB1.PcbDoc').doc.prims.filter(p => p.kind === 'via').length")
    check(f"…Revert to Version 1: the board without the via, saved, the file it replaced Version 2 ({page.evaluate(LIST, 'Work/Blinky/History')}, {vias} vias)",
          vias == 0 and page.evaluate(LIST, "Work/Blinky/History") == ["Blinky.~(1).PrjPcb.Zip", "PCB1.~(1).PcbDoc.Zip", "PCB1.~(2).PcbDoc.Zip"] and page.evaluate(READ, "Work/Blinky/PCB1.PcbDoc") == pcb1)
    page.evaluate("window.konium.run('view.panel.storage')"); page.wait_for_timeout(300)

    # 26.042: workspace, Integrated Library packages, Project Packager, Explore, Create Projects from Path,
    # Messages grouping and report, Command Status, Open In New Window, Exit
    page.evaluate("""async () => { const work = await (await navigator.storage.getDirectory()).getDirectoryHandle('Work');
      const blinky = await work.getDirectoryHandle('Blinky'); window.__saves = []; window.__ssfp = window.showSaveFilePicker;
      window.showSaveFilePicker = async (o) => { if (/\\.DsnWrk$/i.test(o.suggestedName)) return await blinky.getFileHandle(o.suggestedName, { create: true });
        return { name: o.suggestedName, createWritable: async () => ({ write: async (b) => { window.__saves.push({ name: o.suggestedName, text: new TextDecoder('latin1').decode(b) }); }, close: async () => {} }) }; };
      const loose = await work.getDirectoryHandle('Loose', { create: true }); const f = window.konium.demoFiles().find((x) => x.name === 'Demo.SchDoc');
      const w = await (await loose.getFileHandle('Loose.SchDoc', { create: true })).createWritable(); await w.write(f.bytes); await w.close(); }""")
    show_panel(page, "projects")
    page.locator(".tree-workspace-row").click(button="right"); page.wait_for_timeout(200)
    wm = page.locator(".menu-popup").last.inner_text()
    check("Projects panel: the Design Workspace row and its menu (Save Design Workspace, Create Projects from Path, Add New Project)",
          "Workspace1.DsnWrk" in page.locator(".panel[aria-label=Projects]").inner_text() and "Save Design Workspace" in wm and "Create Projects from Path" in wm and "Add New Project" in wm)
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    page.locator(".doctab", has_text="Sheet1.SchDoc").last.dispatch_event("mousedown"); page.wait_for_timeout(200)
    page.evaluate("window.konium.run('ad:WorkspaceManager:SaveWorkspace')"); page.wait_for_timeout(800)
    dsn = page.evaluate(READ, "Work/Blinky/Workspace1.DsnWrk")
    check(f"File › Save Design Workspace: [ProjectGroup], each project by its path from the workspace ({dsn.splitlines()[:4]})",
          dsn.startswith("[ProjectGroup]\r\nVersion=1.0\r\n[Project1]") and "ProjectPath=Blinky.PrjPcb" in dsn)
    page.evaluate("window.konium.run('ad:WorkspaceManager:Archive')"); page.wait_for_timeout(800)
    pk = page.locator(".dlg.packager")
    check("Project › Project Packager: the project's files, options for generated and other files",
          pk.count() == 1 and "Blinky.PrjPcb" in pk.inner_text() and "Sheet1.SchDoc" in pk.inner_text() and "PCB1.PcbDoc" in pk.inner_text() and "Include non-project files" in pk.inner_text())
    shot(page, "61-project-packager.png")
    pk.locator(".btn", has_text="Finish").click(); page.wait_for_timeout(600)
    z = page.evaluate("(window.__saves.find((x) => x.name === 'Blinky.zip') || {}).text || ''")
    check("…Finish: Blinky.zip, the files under Blinky/", "Blinky/Blinky.PrjPcb" in z and "Blinky/Sheet1.SchDoc" in z and "Blinky/PCB1.PcbDoc" in z and "Workspace1.DsnWrk" not in z)
    page.evaluate("window.konium.run('ad:WorkspaceManager:ExploreToFocusedProject')"); page.wait_for_timeout(700)
    ex = page.locator(".dlg.explore")
    check("Explore: the project's folder and its files", ex.count() == 1 and "Blinky.PrjPcb" in ex.inner_text() and "Workspace1.DsnWrk" in ex.inner_text())
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    # An Integrated Library package: new, its libraries, compiled to an .IntLib
    page.evaluate("window.konium.run('ad:WorkspaceManager:NewProject_LIB')"); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('file.newSchLib')"); page.wait_for_timeout(500)
    page.evaluate("window.konium.run('file.newPcbLib')"); page.wait_for_timeout(700)
    # 26.072: Tools › Component Builder with AI off says where to switch it on; Preferences › System › AI
    page.evaluate("window.konium.run('ai.componentBuilder')"); page.wait_for_timeout(200)
    aib = page.locator(".dlg.ai-builder")
    check("Tools › Component Builder with AI off: where to switch it on", aib.count() == 1 and "Preferences › System › AI" in aib.inner_text())
    aib.locator(".btn", has_text="Open Preferences").click(); page.wait_for_timeout(400)
    modes = page.locator(".dlg.prefs .ai-mode").count()
    check(f"…Open Preferences: System › AI, four ways to connect ({modes}), Off chosen", modes == 4 and page.locator(".dlg.prefs .ai-mode input").first.is_checked())
    page.locator(".dlg.prefs .btn", has_text="Cancel").click(); page.wait_for_timeout(200)
    # 26.075: the builder's whole way, with a stand-in for the service: the datasheet surveyed (its drawing page sent as a
    # picture too), a variant's drawing read, its footprint (IPC-7351B from the dimensions) reviewed and added to the library
    ai_jobs = []
    survey_ans = {"maker": "Acme", "device": "AB123", "description": "Test part", "variants": [
        {"partNumbers": ["AB123D"], "package": "SO8", "pins": 8, "leadForm": "gull-wing", "body": {"length": 4.9, "width": 3.9, "height": 1.75}, "pitch": 1.27,
         "thermalPad": False, "pinout": "A", "drawingPages": [2], "landPatternPages": [], "pinTablePages": [1], "orderingPage": 1}]}
    pins_ans = {"kind": "ic", "prefix": "U", "pages": [1], "notes": "", "pins": [{"number": n, "name": nm, "type": t, "group": g} for n, nm, t, g in [
        ("1", "CS#", "input", "SPI"), ("2", "DO", "output", "SPI"), ("3", "WP#", "input", "Control"), ("4", "GND", "ground", "Power"),
        ("5", "DI", "input", "SPI"), ("6", "CLK", "input", "SPI"), ("7", "HOLD#", "input", "Control"), ("8", "VCC", "power", "Power")]]}
    read_ans = {"family": "SOIC", "standard": False, "pins": 8, "pinsSide": 0, "pitch": 1.27, "bodyD": {"min": 4.8, "max": 5.0}, "bodyE": {"min": 3.8, "max": 4.0},
                "height": {"min": 1.35, "max": 1.75}, "span": {"min": 5.8, "max": 6.2}, "span2": None, "term": {"min": 0.4, "max": 1.27}, "leadW": {"min": 0.31, "max": 0.51},
                "tab": None, "ball": None, "rows": 0, "cols": 0, "land": [], "outline": None, "pages": [2], "notes": ""}
    def ai_route(route):
        url = route.request.url
        if url.endswith("/config"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"models": [{"id": "m/vision", "name": "Vision", "vision": True, "roles": ["text", "vision"]}],
                                 "defaults": {"text": "m/vision", "vision": "m/vision"}, "allowance": {"jobs": 20, "left": 20}, "shareCache": True}))
        if url.endswith("/accept"):
            return route.fulfill(status=200, content_type="application/json", body='{"ok": true}')
        body = json.loads(route.request.post_data)
        ai_jobs.append(body)
        locate_ans = {"regions": [{"page": 2, "kind": "land", "left": 790, "top": 120, "right": 975, "bottom": 240}] if ai_land["on"] else []}
        locate_ans["regions"].append({"page": 2, "kind": "outline", "left": 40, "top": 60, "right": 700, "bottom": 900})
        reviews = sum(1 for j in ai_jobs if j["job"] == "review")
        answer = survey_ans if body["job"] == "survey" else locate_ans if body["job"] == "locate" else (land_ans if ai_land["on"] else read_ans) if body["job"] == "package" \
            else pins_ans if body["job"] == "pins" else (fix_ans if reviews == 1 else {"verdict": "ok", "problems": []})
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": answer,
                      "usage": {"in": 3000, "out": 500, "cost": 0.001}, "model": "m/vision", "allowance": {"jobs": 20, "left": 19}}))
    # 26.079: the datasheet's own land pattern (an SO8's pads drawn on page 2), read with pads 5 … 8 numbered the wrong way and
    # the rows too close: measured on the drawing's lines, then checked by the model, put right once, matching the second time
    ai_land = {"on": False}
    row = lambda first, last, d, x, y: {"first": first, "last": last, "count": 4, "pitch": 1.27, "direction": d, "x": x, "y": y, "w": 1.55, "h": 0.6, "shape": "rect", "hole": 0}
    land_ans = {"family": "SOIC", "pins": 8, "pitch": 1.27, "landPattern": {"dimensions": ["1.27: pitch", "5.40: rows' centres"], "rows": [row("1", "4", "down", -2.5, 1.905), row("8", "5", "up", 2.5, -1.905)], "pads": []}, "pages": [2]}
    fix_ans = {"verdict": "fix", "problems": ["pads 5 to 8 run up the right side from 5, not 8"],
               "landPattern": {"dimensions": ["1.27: pitch", "5.40: rows' centres"], "rows": [row("1", "4", "down", -2.7, 1.905), row("5", "8", "up", 2.7, -1.905)], "pads": []}}
    page.route("https://konium.app/api/ai/**", ai_route)
    page.evaluate("window.konium.prefs.set({ aiMode: 'konium' })")
    # A two-page datasheet: ordering text, then a drawing (600 strokes, a title)
    lines = " ".join(f"{50 + (i % 30) * 15} {100 + (i // 30) * 20} m {60 + (i % 30) * 15} {110 + (i // 30) * 20} l S" for i in range(600))
    # …and its land pattern at 10 pt to the millimetre, centred at (540, 650)
    pads = " ".join(f"{540 + (sx * 2.7 - 0.775) * 10:.2f} {650 + (y - 0.3) * 10:.2f} 15.5 6 re f" for sx in (-1, 1) for y in (1.905, 0.635, -0.635, -1.905))
    streams = ["BT /F1 10 Tf 50 760 Td (Ordering information AB123D SO8 8 pins) Tj ET", f"BT /F1 10 Tf 50 760 Td (Package outline SO8) Tj ET {lines} {pads}"]
    objs = ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"] + [f"<< /Length {len(t)} >>\nstream\n{t}\nendstream" for t in streams]
    objs += [f"<< /Type /Page /Parent 6 0 R /MediaBox [0 0 612 792] /Contents {k + 2} 0 R /Resources << /Font << /F1 1 0 R >> >> >>" for k in range(2)]
    objs += ["<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >>", "<< /Type /Catalog /Pages 6 0 R >>"]
    pdf, at = "%PDF-1.4\n", []
    for i, o in enumerate(objs):
        at.append(len(pdf)); pdf += f"{i + 1} 0 obj\n{o}\nendobj\n"
    xref = len(pdf)
    pdf += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{a:010d} 00000 n \n" for a in at) + f"trailer\n<< /Size {len(objs) + 1} /Root 7 0 R >>\nstartxref\n{xref}\n%%EOF"
    pdf_path = os.path.join(OUT, "ab123.pdf")
    open(pdf_path, "w", encoding="latin-1").write(pdf)
    fps0 = page.evaluate("window.konium.state.active.value.editor.lib.footprints.length")
    page.evaluate("window.konium.run('ai.componentBuilder')"); page.wait_for_timeout(300)
    aib = page.locator(".dlg.ai-builder")
    aib.locator("input[type=file]").set_input_files(pdf_path)
    aib.locator(".ai-send").wait_for(timeout=20000)
    send = aib.locator(".ai-send").inner_text()
    check(f"Component Builder: what the survey sends, the drawing page as a picture too ({send[:90]}…)", "all 2 pages" in send and "pictures of page 2" in send)
    # 26.082: the model chosen in the builder itself (as in Preferences)
    mopts = aib.locator("select[aria-label=Model] option").all_inner_texts()
    check(f"…the model chosen in the builder too ({mopts})", mopts[:2] == ["Default (Vision)", "Vision"])
    aib.locator(".btn", has_text="Read the Datasheet").click()
    aib.locator("table.ai-variants").first.wait_for(timeout=10000)
    aib.locator("table.ai-variants tbody tr").first.locator("a", has_text="create").first.click(); page.wait_for_timeout(200)
    plan = aib.locator(".ai-package .ai-send").inner_text()
    check(f"…a variant's footprint job says what it sends ({plan[:80]}…)", "Finds the drawings on page 2" in plan and "text of page 2" in plan)
    aib.get_by_role("button", name="Create Footprint", exact=True).click()
    aib.locator(".ai-review").wait_for(timeout=10000); page.wait_for_timeout(300)
    kinds = [j["job"] for j in ai_jobs]
    pics = [p.get("label", "") for p in (ai_jobs[-1]["input"]["pictures"] if ai_jobs else []) if p["url"].startswith("data:image/jpeg;base64,")]
    fp_name = aib.locator("input[aria-label='Footprint name']").input_value()
    check(f"…the drawing found, then read enlarged ({kinds}, {pics}); the footprint by IPC-7351B, named {fp_name}", kinds == ["survey", "locate", "package"]
          and pics == ["the package outline drawing, enlarged"] and fp_name == "SOIC127P600X175-8N"
          and aib.locator(".ai-review .fp-preview rect, .ai-review .fp-preview path, .ai-review .fp-preview polygon, .ai-review .fp-preview circle").count() >= 8)
    shot(page, "75-ai-builder-review.png")
    aib.locator(".btn", has_text="Add to Library").click(); page.wait_for_timeout(300)
    fps1 = page.evaluate("window.konium.state.active.value.editor.lib.footprints.map((f) => f.name)")
    check(f"…Add to Library: the footprint in the open PCB library ({fps1[-3:]})", len(fps1) == fps0 + 1 and "SOIC127P600X175-8N" in fps1)
    ai_land["on"] = True; n0 = len(ai_jobs)
    aib.locator(".ai-retry .btn", has_text="Read Again").click()
    for _ in range(100):
        page.wait_for_timeout(200)
        if sum(1 for j in ai_jobs[n0:] if j["job"] == "review") >= 2 and aib.locator(".ai-busy").count() == 0 and aib.locator(".ai-review").count() == 1: break
    page.wait_for_timeout(300)
    kinds = [j["job"] for j in ai_jobs[n0:]]
    first = next((j for j in ai_jobs[n0:] if j["job"] == "review"), None)
    rpics = [(p.get("label", ""), p["url"].split(";")[0]) for p in (first["input"]["pictures"] if first else [])]
    measured = aib.locator(".ai-review label.do-check", has_text="Pads where the drawing has them").inner_text() if aib.locator(".ai-review label.do-check", has_text="Pads where the drawing has them").count() else ""
    rchecks = aib.locator(".ai-review .ai-checks").inner_text()
    names = page.evaluate("[...document.querySelectorAll('.ai-review input[aria-label^=\"Pad \"][aria-label$=\" name\"]')].map((e) => e.value)")
    check(f"…Read Again with a land pattern: measured on the drawing's lines ({measured.strip()}), then checked: {kinds}, pictures {[l for l, _ in rpics]}",
          kinds == ["locate", "package", "review", "review"] and "8 of 8 measured on its lines" in measured
          and [u for _, u in rpics] == ["data:image/jpeg", "data:image/png", "data:image/jpeg"] and first["input"]["measured"] is True)
    check(f"…put right once (pads 5 … 8 up the right side from 5: {names}), matching the second time",
          "it matches (round 2, after putting it right once)" in rchecks and names[:8] == ["1", "2", "3", "4", "5", "6", "7", "8"])
    # 26.080: how it went, step by step, each with its time
    aib.locator(".ai-how summary").click(); page.wait_for_timeout(100)
    steps = aib.locator(".ai-how .ai-steps li").all_inner_texts()
    check(f"…how it went, each step with its time ({steps})", len(steps) == 5 and steps[0].startswith("✓ Found the land pattern on page 2")
          and steps[1].startswith("✓ Read by Vision: 8 pads") and "Measured 8 of 8 pads in the drawing, on its lines" in steps[2]
          and steps[3].startswith("✓ Check 1: put right — pads 5 to 8") and steps[4].startswith("✓ Check 2: it matches the drawing") and all(s.rstrip().endswith(" s") for s in steps))
    shot(page, "75b-ai-builder-checked.png")
    # 26.083: the variant's symbol from its pin table: read (the page's text and a picture of it), laid out round its body,
    # checked against the footprint's pads, edited, and added to the open schematic library linked to a footprint in the PCB library
    fp_now = aib.locator("input[aria-label='Footprint name']").input_value()
    aib.get_by_role("tab", name="Symbol").click(); page.wait_for_timeout(200)
    splan = aib.locator(".ai-package .ai-send").inner_text()
    check(f"…its symbol: what the pin-table job sends ({splan[:80]}…)", "Sends the text of page 1, and pictures of it (the pin table)" in splan)
    n0 = len(ai_jobs)
    page.evaluate("window.konium.prefs.set({ schPinLength: 200 })")   # 26.084: Default Primitives' pin length
    aib.get_by_role("button", name="Create Symbol", exact=True).click()
    aib.locator(".ai-symbol").wait_for(timeout=10000); page.wait_for_timeout(300)
    pj = ai_jobs[n0:]
    rows = aib.locator(".ai-symbol .ai-pins tbody tr").count()
    schecks = aib.locator(".ai-symbol .ai-checks").inner_text()
    sfp = aib.locator(".ai-symbol input[aria-label=Footprint]").input_value()
    sname = aib.locator(".ai-symbol input[aria-label='Symbol name']").input_value()
    bars = aib.locator(".ai-symbol-preview text[text-decoration=overline]").count()
    check(f"…Create Symbol: the pins read ({[j['job'] for j in pj]}, {rows} pins), named {sname}, linked to {sfp}, every pin on its pad, CS, WP and HOLD overbarred ({bars})",
          [j["job"] for j in pj] == ["pins"] and pj[0]["input"]["pages"][0]["page"] == 1 and len(pj[0]["input"]["pictures"]) == 1 and rows == 8 and sname == "AB123D"
          and sfp == fp_now and "Every pin has its pad in the footprint" in schecks and bars == 3)
    shot(page, "83-ai-builder-symbol.png")
    aib.locator(".ai-symbol input[aria-label=Footprint]").fill("SOIC127P600X175-8N")
    aib.locator(".ai-symbol input[aria-label='Pin 4 name']").fill("VSS"); page.wait_for_timeout(200)
    vss = "VSS" in aib.locator(".ai-symbol-preview").inner_html()
    SCHLIB = "window.konium.state.docs.value.find(x => x.name === 'SchLib1.SchLib').editor"
    syms0 = page.evaluate(SCHLIB + ".lib.symbols.length")
    aib.locator("select[aria-label='Schematic library']").select_option(label="SchLib1.SchLib")
    aib.locator(".ai-add .btn", has_text="Add to Library").click(); page.wait_for_timeout(300)
    added = page.evaluate(SCHLIB + """.lib.symbols.filter((s) => s.libRef === 'AB123D').map((s) => ({ pins: s.bags.filter((b) => b.get('RECORD') === '2').map((b) => b.get('NAME')),
        fp: (s.bags.find((b) => b.get('RECORD') === '45') || { get: () => '' }).get('MODELNAME'), len: [...new Set(s.bags.filter((b) => b.get('RECORD') === '2').map((b) => b.get('PINLENGTH')))] }))""")
    page.evaluate("window.konium.prefs.set({ schPinLength: 300 })")
    sstat = aib.locator("table.ai-variants tbody tr").first.locator("td").last.inner_text()
    check(f"…Add to Library: the symbol in SchLib1.SchLib ({added}), the edit drawn ({vss}), its row says so ({sstat})",
          page.evaluate(SCHLIB + ".lib.symbols.length") == syms0 + 1 and len(added) == 1 and len(added[0]["pins"]) == 8 and "VSS" in added[0]["pins"] and "C\\S\\" in added[0]["pins"]
          and added[0]["fp"] == "SOIC127P600X175-8N" and added[0]["len"] == ["20"] and vss and sstat == "added to SchLib1.SchLib")
    # 26.197 (R21): the variant with its footprint and its symbol kept as a part on the shelf (and taken off again: the shelf's libraries are among the installed ones)
    shot(page, "197-keep.png")
    aib.locator(".ai-keep .btn", has_text="Keep as a Part").click(); page.wait_for_timeout(500)
    kept_hint = aib.locator(".ai-keep").inner_text()
    kp = next((p for p in page.evaluate("window.konium.parts()") if p["mpn"] == "AB123D"), None)
    check(f"…Keep as a Part (26.197): the variant on the shelf under its part number ({kp and kp['mpn']}, {kp and kp['package']}, symbol {kp and kp['symbol']}, {kp and len(kp['pins'])} pins; pins read on page {kp and kp['datasheet']['pinPages']}, the package on {kp and kp['datasheet']['packagePages']}, of {kp and kp['datasheet']['pages']}; link '{kp and kp['datasheet']['url']}'; by {kp and kp['made']['by']}); the builder says so ('{kept_hint.strip()[-60:]}')",
          kp is not None and kp["package"] == {"name": "SO8", "pins": 8, "footprint": "SO8", "from": "datasheet"} and len(kp["pins"]) == 8 and kp["symbol"] == "AB123D" and re.fullmatch(r"[0-9a-f]{64}", kp["datasheet"]["sha256"]) is not None
          and kp["datasheet"]["url"] == "" and kp["datasheet"]["pages"] == 2 and kp["datasheet"]["pinPages"] == [1] and kp["datasheet"]["packagePages"] == [2] and kp["made"]["by"] == "the Component Builder" and "Kept on your shelf as AB123D" in kept_hint)
    page.evaluate("window.konium.partRemove('AB123D')"); page.wait_for_timeout(200)
    aib.locator(".btn", has_text="Close").click(); page.wait_for_timeout(100)
    # 26.085: Tools › Design Adviser on the demo schematic: what it sends first, the check, a finding shown on the sheet, one dismissed
    adv_jobs = []
    def adv_route(route):
        url = route.request.url
        if url.endswith("/config"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"models": [{"id": "m/vision", "name": "Vision", "vision": True, "roles": ["text", "vision"]}],
                                 "defaults": {"model": "m/vision"}, "allowance": {"jobs": 20, "left": 20}, "shareCache": True}))
        if "/fetch?" in url:   # 26.086: a datasheet fetched through the service
            adv_jobs.append({"job": "fetch", "input": {}})
            return route.fulfill(status=200, content_type="application/pdf", headers={"X-Source-Url": "https://maker.example/ds.pdf", "Access-Control-Expose-Headers": "X-Source-Url"}, body=open(pdf_path, "rb").read())
        body = json.loads(route.request.post_data)
        adv_jobs.append(body)
        if body["job"] == "datasheet":
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": {"url": "https://maker.example/ds.pdf"}, "usage": {"in": 500, "out": 50, "cost": 0.008}, "model": "m/vision"}))
        if body["job"] == "part":
            des = re.search(r"^([A-Z]+\d+): ", body["input"]["part"], re.M).group(1)
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": {"facts": f"{des}: stand-in facts.", "findings": [
                {"severity": "warning", "title": f"{des} against its datasheet", "detail": "Stand-in.", "fix": "", "parts": [des], "nets": [], "pages": [1]}]}, "usage": {"in": 3000, "out": 200, "cost": 0.002}, "model": "m/vision"}))
        if body["job"] == "ask":
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": {"answer": "Stand-in answer.", "parts": [], "nets": []}, "usage": {"in": 2500, "out": 40, "cost": 0.001}, "model": "m/vision"}))
        if body["job"] == "board":   # 26.087: a board's review
            comp = re.search(r"^Components[^\n]*\n([A-Z]+\d+): ", body["input"]["board"], re.M).group(1)
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": {"summary": "A small board.", "findings": [
                {"severity": "warning", "title": f"{comp} placement", "detail": "Stand-in.", "fix": "", "parts": [comp], "nets": []}]}, "usage": {"in": 2000, "out": 100, "cost": 0.001}, "model": "m/vision"}))
        design = body["input"]["design"]
        part = re.search(r"^([A-Z]+\d+): ", design, re.M).group(1)
        net = re.search(r"^Nets \(name: pins\):\n([^:\n]+?)(?: \[| \(|:)", design, re.M).group(1)
        ans = {"summary": "A small test design.", "findings": [
            {"severity": "warning", "title": f"Check {part}", "detail": "Stand-in finding.", "fix": "Nothing.", "parts": [part], "nets": [net]},
            {"severity": "suggestion", "title": "A second thought", "detail": "", "fix": "", "parts": ["ZZ99"], "nets": []}]}
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": ans, "usage": {"in": 2000, "out": 300, "cost": 0.001}, "model": "m/vision", "allowance": {"jobs": 20, "left": 19}}))
    page.unroute("https://konium.app/api/ai/**"); page.route("https://konium.app/api/ai/**", adv_route)
    page.evaluate("""(() => { const d = window.konium.state.docs.value.find(x => x.name === 'Demo.SchDoc'); window.konium.state.activeId.value = d.id; })()"""); page.wait_for_timeout(300)
    page.locator(".menubar-item", has_text="Tools").first.click(); page.wait_for_timeout(200)
    tm = page.locator(".menu-popup").last.inner_text()
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    page.evaluate("window.konium.run('ai.adviser')"); page.wait_for_timeout(600)
    adv = page.locator(".adviser")
    asend = adv.locator(".adv-send").inner_text() if adv.locator(".adv-send").count() else ""
    check(f"Tools › Design Adviser: the Design Adviser panel says what it sends first ({asend[:100]}…)", "Design Adviser..." in tm and adv.count() == 1
          and re.search(r"Sends the design's \d+ parts, their \d+ pins and \d+ nets as text", asend) is not None and "keeps nothing" in asend)
    adv.locator("label.do-check", has_text="In depth").locator("input").uncheck()
    # Whether the model's choice was locked at any moment while checking (the stand-in answers at once)
    page.evaluate("""(() => { window.__locked = false; const el = document.querySelector('.adviser');
      new MutationObserver(() => { if (document.querySelector('.adviser select[aria-label=Model]')?.disabled) window.__locked = true; }).observe(el, { attributes: true, subtree: true, childList: true }); })()""")
    adv.get_by_role("button", name="Check Design").click()
    page.wait_for_timeout(50)
    locked = page.evaluate("window.__locked")
    adv.locator(".adv-finding").first.wait_for(timeout=10000); page.wait_for_timeout(200)
    titles = adv.locator(".adv-finding .adv-title").all_inner_texts()
    sent = adv_jobs[-1] if adv_jobs else {"job": "", "input": {"design": ""}}
    check(f"…Check Design: the design sent as text ({sent['job']}, {len(sent['input']['design'])} characters), the model locked meanwhile ({locked}), the findings listed ({titles})",
          sent["job"] == "advise" and "Parts (designator" in sent["input"]["design"] and locked and len(titles) == 2 and titles[0].startswith("Check "))
    adv.locator(".adv-finding").first.locator(".adv-title").click(); page.wait_for_timeout(400)
    picked = page.evaluate("window.konium.state.active.value.editor.selection.size")
    unknown = adv.locator(".adv-finding").nth(1).locator(".adv-refs .muted", has_text="ZZ99").count()
    adv.locator(".adv-finding").first.get_by_role("button", name="Dismiss").click(); page.wait_for_timeout(200)
    left = adv.locator(".adv-finding").count()
    check(f"…a finding's title shows its part and net on the sheet ({picked} selected), a part not in the design isn't a link, Dismiss hides it ({left} left)", picked >= 1 and unknown == 1 and left == 1)
    shot(page, "85-ai-adviser.png")
    # 26.086: in depth — the parts checked against their datasheets; one given as a file; its finding's datasheet page shown; a question asked
    n0 = len(adv_jobs)
    adv.locator("label.do-check", has_text="In depth").locator("input").check()
    adv.get_by_role("button", name="Check Design").click()
    adv.locator(".adv-parts").wait_for(timeout=15000)
    for _ in range(100):
        page.wait_for_timeout(200)
        if adv.locator(".ai-busy").count() == 0: break
    deep_jobs = [j["job"] for j in adv_jobs[n0:]]
    rows = adv.locator(".adv-parts tbody tr").count()
    row = adv.locator(".adv-parts tbody tr").filter(has=page.get_by_role("button", name="Add PDF...")).first
    des = row.locator("td").first.inner_text().split("\n")[0] if rows else ""
    with page.expect_file_chooser() as fc:
        row.get_by_role("button", name="Add PDF...").click()
    fc.value.set_files(pdf_path)
    adv.locator(".adv-finding", has_text=f"{des.split(',')[0]} against its datasheet").wait_for(timeout=15000); page.wait_for_timeout(300)
    part_jobs = [j for j in adv_jobs[n0:] if j["job"] == "part"]
    sent_pages = [q["page"] for q in part_jobs[-1]["input"]["datasheet"]["pages"]] if part_jobs else []
    check(f"…In depth: the parts listed against their datasheets ({rows} rows, jobs {deep_jobs}); Add PDF… on {des}: checked against the file (pages {sent_pages})",
          rows >= 1 and deep_jobs[-1] == "advise" and part_jobs and 1 in sent_pages and "Parts (designator" not in part_jobs[-1]["input"]["part"])
    adv.locator(".adv-finding", has_text=f"{des.split(',')[0]} against its datasheet").get_by_role("link", name="p. 1").click(); page.wait_for_timeout(1500)
    pimg = page.locator(".dlg.adv-page img").count()
    page.locator(".dlg.adv-page .btn", has_text="Close").click(); page.wait_for_timeout(200)
    adv.locator("textarea[aria-label='Ask about the design']").fill("Why that value?")
    adv.get_by_role("button", name="Ask", exact=True).click()
    adv.locator(".adv-qa .adv-a").wait_for(timeout=10000)
    asked = [j for j in adv_jobs if j["job"] == "ask"]
    check(f"…the finding's datasheet page shown ({pimg}); Ask: the question with the design and the review, answered ({adv.locator('.adv-qa .adv-a').inner_text()})",
          pimg == 1 and asked and asked[-1]["input"]["question"] == "Why that value?" and "against its datasheet" in asked[-1]["input"]["review"] and adv.locator(".adv-qa .adv-a").inner_text() == "Stand-in answer.")
    shot(page, "86-ai-adviser-deep.png")
    # 26.087: the board reviewed — what it sends (measured here), the review with what the datasheets said, a finding shown on the board
    page.evaluate("""(() => { const d = window.konium.state.docs.value.find(x => x.name === 'Demo.PcbDoc'); window.konium.state.activeId.value = d.id; })()"""); page.wait_for_timeout(600)
    page.evaluate("window.konium.run('ai.adviser')"); page.wait_for_timeout(500)
    bsend = adv.locator(".adv-send").inner_text() if adv.locator(".adv-send").count() else ""
    adv.get_by_role("button", name="Check Board").click()
    adv.locator(".adv-finding", has_text="placement").first.wait_for(timeout=10000); page.wait_for_timeout(200)
    bj = [j for j in adv_jobs if j["job"] == "board"]
    adv.locator(".adv-finding", has_text="placement").first.locator(".adv-title").click(); page.wait_for_timeout(600)
    bsel = page.evaluate("window.konium.state.active.value.editor.selection.size"); bname = page.evaluate("window.konium.state.active.value.name")
    check(f"…on the board: its components, routing and measurements sent ({bsend[:70]}…), with what the datasheets said; a finding shown on the board ({bsel} selected in {bname})",
          "decoupling distances" in bsend and bj and "Decoupling (each IC supply pad" in bj[-1]["input"]["board"] and "stand-in facts" in bj[-1]["input"]["facts"] and bsel >= 1 and bname == "Demo.PcbDoc")
    shot(page, "87-ai-adviser-board.png")
    # 26.088: Tools › Signal Integrity on the demo board with two 30 mm lines added (CLK, DATA side by side): screened, reflections with a series resistor, crosstalk
    page.evaluate("""(() => {
      const doc = window.konium.state.active.value.doc;
      window.__siBackup = { nets: doc.nets, prims: doc.prims, components: doc.components };
      const mm = (v) => Math.round(v * 393700.787);
      const o = { x: doc.board.origin.x + mm(4), y: doc.board.origin.y + mm(4) };
      const P = (x, y) => ({ x: o.x + mm(x), y: o.y + mm(y) });
      const src = (s) => ({ storage: s, index: -1 });
      const bag = doc.nets[0].bag.constructor;
      doc.nets = [...doc.nets]; doc.components = [...doc.components];
      const net = (name) => { const index = doc.nets.length; doc.nets.push({ index, name, bag: bag.from({ NAME: name }) }); return index; };
      const comp = (d) => { const index = doc.components.length + 100; doc.components.push({ index, designator: d, pattern: 'X', at: P(0, 0), rotation: 0, layer: 1, bag: bag.from({}), nameOn: true, commentOn: false }); return index; };
      const st = (w) => ({ w: mm(w), h: mm(w), shape: 'round', cornerPct: 0 });
      const pad = (at, n, c, name) => ({ kind: 'pad', src: src('Pads6'), name, layer: 1, at: P(...at), rotation: 0, top: st(0.6), mid: st(0.6), bot: st(0.6), hole: 0, plated: true, net: n, component: c, locked: false });
      const tr = (a, b, n) => ({ kind: 'track', src: src('Tracks6'), layer: 1, a: P(...a), b: P(...b), width: mm(0.2), net: n, component: 0xffff, polygon: 0xffff, locked: false, keepout: false });
      const clk = net('CLK'), dat = net('DATA'), u10 = comp('U10'), u11 = comp('U11');
      doc.prims = [...doc.prims, pad([0, 0], clk, u10, '1'), pad([30, 0], clk, u11, '1'), tr([0, 0], [30, 0], clk), pad([0, 0.5], dat, u10, '2'), pad([30, 0.5], dat, u11, '2'), tr([0, 0.5], [30, 0.5], dat)];
    })()""")
    page.locator(".menubar-item", has_text="Tools").first.click(); page.wait_for_timeout(200)
    ptm = page.locator(".menu-popup").last.inner_text()
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    page.evaluate("window.konium.run('si.panel')")
    page.wait_for_function("document.querySelector('.sipanel .si-state')?.textContent.includes('analysed')", timeout=30000); page.wait_for_timeout(300)
    sip = page.locator(".sipanel")
    sstate = sip.locator(".si-state").inner_text()
    srows = [r.replace("\n", " | ") for r in sip.locator(".si-nets .pcbp-row").all_inner_texts()]
    clkrow = next((r for r in srows if r.startswith("CLK")), "")
    check(f"Tools › Signal Integrity... (PCB): every net screened ({sstate}); CLK {clkrow[:60]}; supplies not analysed",
          "Signal In" in ptm and sstate.startswith("2 of ") and "nets analysed" in sstate and "Passed" in clkrow and " mV" in clkrow and any(r.startswith("GND | Not analysed") for r in srows))
    sip.locator(".si-nets .pcbp-row", has_text="CLK").click(); page.wait_for_timeout(300)
    spins = " / ".join(t.replace("\n", " ") for t in sip.locator(".si-pins .pcbp-row").all_inner_texts())
    sugg = sip.get_by_label("Serial Res R").get_attribute("placeholder")
    sip.locator(".si-term", has_text="Serial Res").locator("input[type=checkbox]").check(); page.wait_for_timeout(200)
    check(f"…the net's pins ({spins}) and a series resistor suggested ({sugg})", "U10 1 Out CMOS-3.3V" in spins and "U11 1 In" in spins and sugg and sugg.endswith("Ω"))
    shot(page, "88-signal-integrity.png")
    sip.get_by_role("button", name="Reflections...").click(); page.wait_for_timeout(1200)
    rname = page.evaluate("window.konium.state.active.value.name")
    rvec = page.evaluate("window.konium.state.active.value.doc.plots[0].vectors.map(v => v.name)")
    check(f"…Reflections: the waveforms in SimView ({rname}: {', '.join(rvec)})", rname == "Demo_Reflections.sdf" and "U11-1" in rvec and "U11-1 (Serial Res)" in rvec)
    shot(page, "88-si-reflections.png")
    page.evaluate("""(() => { const d = window.konium.state.docs.value.find(x => x.name === 'Demo.PcbDoc'); window.konium.state.activeId.value = d.id; })()"""); page.wait_for_timeout(500)
    sip.get_by_role("button", name="Crosstalk...").click(); page.wait_for_timeout(1200)
    xname = page.evaluate("window.konium.state.active.value.name")
    xvec = page.evaluate("window.konium.state.active.value.doc.plots[0].vectors.map(v => v.name)")
    check(f"…Crosstalk: CLK against the net beside it ({xname}: {', '.join(xvec)})", xname == "Demo_Crosstalk.sdf" and "DATA near end" in xvec and "DATA far end" in xvec)
    page.evaluate("""(() => { const d = window.konium.state.docs.value.find(x => x.name === 'Demo.PcbDoc'); window.konium.state.activeId.value = d.id; })()"""); page.wait_for_timeout(500)
    sip.get_by_role("button", name="Model Assignments...").click(); page.wait_for_timeout(400)
    mrows = " / ".join(t.replace("\n", " ") for t in page.locator(".dlg.si-dlg .grid-row").all_inner_texts()[:12])
    page.locator(".dlg.si-dlg").get_by_label("U10 model").select_option("LVTTL"); page.wait_for_timeout(100)
    page.locator(".dlg.si-dlg .btn", has_text="OK").click(); page.wait_for_timeout(800)
    sip.locator(".si-nets .pcbp-row", has_text="CLK").click(); page.wait_for_timeout(300)
    spins2 = " / ".join(t.replace("\n", " ") for t in sip.locator(".si-pins .pcbp-row").all_inner_texts())
    prjsec = page.evaluate("window.konium.state.projects.value.find(p => p.name.startsWith('Demo')).prj.lines.join('\\n')")
    check(f"…Model Assignments: each part's type ({mrows[:90]}…); U10 made LVTTL and kept in the project ({spins2})",
          "Resistor" in mrows and "R1" in mrows and "U10 1 Out LVTTL" in spins2 and "[Konium Signal Integrity]" in prjsec and "Model1=U10|name=LVTTL" in prjsec)
    # The demo as it was
    page.evaluate("""(() => { const doc = window.konium.state.docs.value.find(x => x.name === 'Demo.PcbDoc').doc; Object.assign(doc, window.__siBackup); })()""")
    # Back to the integrated library's PCB library, as before
    page.evaluate("""(() => { const d = window.konium.state.docs.value.find(x => x.name === 'PcbLib1.PcbLib'); window.konium.state.activeId.value = d.id; })()"""); page.wait_for_timeout(300)
    page.evaluate("window.konium.prefs.set({ aiMode: 'off' })")
    page.unroute("https://konium.app/api/ai/**")
    show_panel(page, "projects")
    tree = page.locator(".panel[aria-label=Projects]").inner_text()
    check("Add New Project › Integrated Library: Integrated_Library.LibPkg with its libraries as source documents",
          "Integrated_Library.LibPkg" in tree and "SchLib1.SchLib" in tree and "PcbLib1.PcbLib" in tree)
    page.locator(".menubar-item", has_text="Project").first.click(); page.wait_for_timeout(200)
    pm = page.locator(".menu-popup").last.inner_text()
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    check("Project menu: Compile Integrated Library Integrated_Library.LibPkg", "Compile Integrated Library Integrated_Library.LibPkg" in pm)
    page.evaluate("window.konium.run('wm.compileProject')"); page.wait_for_timeout(1200)
    msgs = page.evaluate("window.konium.state.messages.value.map(m => m.message)")
    intlib = page.evaluate("(window.__saves.find((x) => x.text.includes('Integrated_Library.IntLib')) || {}).name || ''")
    check(f"…compiled: the missing footprint reported, Integrated_Library.IntLib written ({intlib})",
          any("Compile successful" in m for m in msgs) and any("has no footprint" in m for m in msgs) and "Integrated Library" in intlib)
    page.evaluate("window.konium.run('file.newProject')"); page.wait_for_timeout(300)
    page.locator(".dlg.newproject .np-item", has_text="Integrated Library").click(); page.wait_for_timeout(100)
    check(f"New Project: Integrated Library among the types, named Integrated_Library1 ({page.input_value('#np-name')})", page.input_value("#np-name") == "Integrated_Library1")
    page.locator(".dlg.newproject .btn", has_text="Cancel").click(); page.wait_for_timeout(100)
    # Messages: Group By, More Info, Export To Report
    page.evaluate("window.konium.run('ad:WorkspaceManager:Messages_GroupByClass')"); show_panel(page, "messages"); page.wait_for_timeout(200)
    check("Messages › Group By › Class: a heading per class", page.locator(".messages .msg-grouprow").count() >= 1 and "[Warning] (" in page.locator(".messages .msg-grouprow").first.inner_text())
    shot(page, "62-messages-grouped.png")
    page.locator(".messages .grid-row.msg-warn", has_text="has no footprint").first.dispatch_event("mousedown"); page.wait_for_timeout(100)
    page.evaluate("window.konium.run('ad:WorkspaceManager:Messages_MoreInfo')"); page.wait_for_timeout(200)
    check("Messages › More Info: the message in full", page.locator(".dlg", has_text="Message").count() >= 1 and "has no footprint" in page.locator(".dlg .msg-info").inner_text())
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    page.evaluate("window.konium.run('ad:WorkspaceManager:Messages_ExportToReport')"); page.wait_for_timeout(400)
    rep = page.evaluate("(window.__saves.find((x) => x.name === 'Messages Report.html') || {}).text || ''")
    check("Messages › Export To Report: Messages Report.html, grouped", "<h1>Messages Report</h1>" in rep and "[Warning] (" in rep)
    page.evaluate("window.konium.run('ad:WorkspaceManager:Messages_GroupByNone')")
    # Create Projects from Path: a project for the folder of documents that has none; Remove All takes them out again
    page.evaluate("window.konium.run('ad:WorkspaceManager:CreateProjectsFromPath')"); page.wait_for_timeout(900)
    cp = page.locator(".dlg", has_text="Create Projects from Path")
    check("Create Projects from Path: Loose.PrjPcb for Work/Loose (Blinky has its project)", cp.count() == 1 and "Loose.PrjPcb" in cp.inner_text() and "Blinky.PrjPcb" not in cp.inner_text())
    cp.locator(".btn", has_text="OK").click(); page.wait_for_timeout(300)
    show_panel(page, "projects")
    lp = page.locator(".tree-project", has_text="Loose.PrjPcb")
    check("…the project with its document, unsaved", lp.count() == 1 and "Loose.SchDoc" in lp.inner_text() and "Loose.PrjPcb *" in lp.inner_text())
    lp.locator(".tree-folder-row").first.click(button="right"); page.wait_for_timeout(200)
    page.locator(".menu-popup .menu-item", has_text="Remove All").first.click(); page.wait_for_timeout(200)
    page.locator(".dlg.confirm .btn", has_text="Yes").click(); page.wait_for_timeout(200)
    check("Folder › Remove All: its documents leave the project", "No Documents Added" in page.locator(".tree-project", has_text="Loose.PrjPcb").inner_text())
    # View › Command Status
    page.locator(".doctab", has_text="Sheet1.SchDoc").last.dispatch_event("mousedown"); page.wait_for_timeout(200)
    page.evaluate("window.konium.run('ad:Client:ToggleCommandStatusBar')"); page.wait_for_timeout(150)
    idle = page.locator(".statusbar .cmd-status").inner_text()
    page.evaluate("window.konium.run('place.wire')"); page.wait_for_timeout(200)
    busy = page.locator(".statusbar .cmd-status").inner_text()
    check(f"View › Command Status: idle, then the command at work ({idle} / {busy})", idle == "Idle state - ready for command" and busy != idle and busy != "")
    page.keyboard.press("Escape"); page.keyboard.press("Escape"); page.wait_for_timeout(100)
    page.evaluate("window.konium.run('ad:Client:ToggleCommandStatusBar')")
    # File › Exit asks about unsaved work first
    page.evaluate("window.konium.run('ad:Client:QuitFromEDAClient')"); page.wait_for_timeout(200)
    xd = page.locator(".dlg", has_text="Confirm Save for Modified Documents")
    check("File › Exit: Confirm Save for Modified Documents lists the unsaved work", xd.count() == 1 and "Integrated_Library.LibPkg" in xd.inner_text())
    xd.locator(".btn", has_text="Cancel").click(); page.wait_for_timeout(100)
    # Open In New Window: the document moves to a window of its own (26.163: run by this one, its project the same)
    with page.context.expect_page() as pi:
        page.locator(".doctab", has_text="PCB1.PcbDoc").last.click(button="right"); page.wait_for_timeout(200)
        page.locator(".menu-popup .menu-item", has_text="Open In New Window").first.click()
    win = pi.value
    win.wait_for_timeout(1500)
    there = [t.split("\n")[0] for t in win.locator(".doctab").all_inner_texts()]
    here = [t.split("\n")[0] for t in page.locator(".doctab").all_inner_texts()]
    proj = page.evaluate("(() => { const d = window.konium.state.docs.value.find(x => x.name === 'PCB1.PcbDoc'); return window.konium.state.projects.value.find(p => p.id === d.projectId)?.name; })()")
    check(f"Open In New Window: PCB1.PcbDoc in a window of its own, still in Blinky.PrjPcb, its tab gone from this one ({there}, {proj})",
          there == ["PCB1.PcbDoc"] and proj == "Blinky.PrjPcb" and "PCB1.PcbDoc" not in here)
    page.evaluate("window.konium.run('ad:Client:ArrangeAllWindowsVertically')"); page.wait_for_timeout(200)
    check("Window › Arrange All Windows Vertically: both windows", "arranged" in page.locator(".toast").inner_text())
    win.close()
    page.evaluate("() => { window.showSaveFilePicker = window.__ssfp; }")
    # 26.046: Help › Report a Bug: the report goes to konium.app (caught here), a thank-you
    sent = []
    def report(route):
        sent.append(route.request.post_data_buffer or b"")
        route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body='{"ok":true,"id":"x"}')
    page.route("https://konium.app/api/report", report)
    page.evaluate("window.konium.run('help.reportBug')"); page.wait_for_timeout(300)
    rb = page.locator(".dlg.reportbug")
    check("Help › Report a Bug: name, email, what happened, attachments, diagnostics", rb.count() == 1 and rb.locator("#rb-text").count() == 1 and "Include diagnostics" in rb.inner_text())
    rb.locator(".btn", has_text="Send").click(); page.wait_for_timeout(200)
    check("…nothing said: asks what happened", "Say what happened first" in rb.inner_text() and not sent)
    rb.locator("#rb-name").fill("Smoke Test"); rb.locator("#rb-email").fill("smoke@example.com")
    rb.locator("#rb-text").fill("Smoke test report\nSteps: none")
    shot(page, "61-report-bug.png")
    rb.locator(".btn", has_text="Send").click(); page.wait_for_timeout(1500)
    body = sent[0].decode("latin1") if sent else ""
    check(f"…Send: posted to konium.app with the text and diagnostics, thanked ({len(body)} bytes)", "Smoke test report" in body and "smoke@example.com" in body and "Konium Designer 26." in body
          and page.locator(".dlg.reportbug").count() == 0 and "Report sent" in page.locator(".toast").inner_text())
    page.unroute("https://konium.app/api/report")
    # What's New on the Home page: the feature log from the site, newest first, with pictures
    page.evaluate("window.konium.run('help.whatsNew')"); page.wait_for_timeout(1500)
    wn = page.locator("#whats-new")
    rels = wn.locator(".news-release").count()
    first = wn.locator(".news-release").first.inner_text() if rels else ""
    more = wn.locator(".news-more").inner_text() if wn.locator(".news-more").count() else ""
    if more: wn.locator(".news-more").click(); page.wait_for_timeout(300)
    rels_all = wn.locator(".news-release").count()
    check(f"Help › What's New: the Home page's feature log — 26.200 first, three shown, Earlier releases down to the Initial Release, their pictures, no dates ({rels}, '{more}', {rels_all} releases, {wn.locator('.news-shot').count()} pictures)",
          wn.count() == 1 and rels == 3 and "26.200" in first and more == "Earlier releases (31)" and rels_all == 34 and "Initial Release" in wn.inner_text() and wn.locator(".news-shot").count() == 69
          and not re.search(r"\b20\d\d\b", wn.inner_text()))
    sha = wn.locator(".news-release").first.locator(".news-sha")
    # The newest entry's SHA-256: this build's own when the build has an entry (a build with nothing to tell has none, and the release before keeps its own)
    newest = json.load(open("public/whats-new.json", encoding="utf-8"))["releases"][0]
    this = json.load(open("package.json", encoding="utf-8"))["version"].split(".")
    want = dl_sha if newest["version"] == f"{this[0]}.{int(this[1]):03d}" else newest.get("sha256", "")
    check(f"…the latest release's SHA-256 at the right of its heading: {'the downloaded copy' if want == dl_sha else newest['version'] + ' as published'}'s own ({want[:12]}…)",
          sha.count() == 1 and sha.get_attribute("data-sha256") == want and want[:8] in sha.inner_text())
    shot(page, "62-whats-new.png")
    # 26.055: Export Wizard › OrCAD and Allegro — the demo project in AD's ASCII formats
    if page.locator(".doctab", has_text="Demo.PcbDoc").count(): page.locator(".doctab", has_text="Demo.PcbDoc").first.click(); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('file.exportCadence')"); page.wait_for_timeout(400)
    ew = page.locator(".dlg", has_text="Export Wizard")
    check("File › Export › OrCAD and Allegro opens the Export Wizard on its type", ew.count() == 1 and "OrCAD and Allegro" in ew.locator("[role=option][aria-selected=true]").inner_text())
    shot(page, "63-export-cadence.png")
    # As a zip (no output folder): the save picker's file taken as written
    page.evaluate("""window.__zip = null; window.__ssfp = window.showSaveFilePicker; window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, createWritable: async () => ({
      write: async (b) => { const u = b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); window.__zip = Array.from(u); },
      close: async () => {} }) }); true""")
    if ew.get_by_role("button", name="None", exact=True).count(): ew.get_by_role("button", name="None", exact=True).click(); page.wait_for_timeout(150)
    ew.get_by_role("button", name="Export", exact=True).click()
    for _ in range(60):
        page.wait_for_timeout(500)
        if page.evaluate("window.__zip !== null"): break
    import zipfile, io
    raw = page.evaluate("window.__zip") or []
    names, sch, pcb, zf = [], [], [], None
    try:
        zf = zipfile.ZipFile(io.BytesIO(bytes(raw))); names = zf.namelist()
        sch = [n for n in names if n.lower().endswith(".schdoc")]; pcb = [n for n in names if n.lower().endswith(".pcbdoc")]
    except Exception as e: print("zip:", e)
    check(f"…the zip: project, structure file, ASCII schematics and board ({len(names)} files)",
          any(n.endswith(".PrjPcbStructure") for n in names) and any(n.endswith(".PrjPcb") for n in names) and bool(sch) and bool(pcb)
          and zf.read(sch[0])[:8] == b"|HEADER=" and zf.read(pcb[0]).startswith(b"|RECORD=Board|"))
    page.evaluate("window.showSaveFilePicker = window.__ssfp; true")
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    # 26.057: Export Wizard › EAGLE — the demo project as EAGLE's schematic, board and library; opened again, imported
    page.evaluate("window.konium.run('file.exportEagle')"); page.wait_for_timeout(400)
    ew = page.locator(".dlg", has_text="Export Wizard")
    check("File › Export › EAGLE opens the Export Wizard on its type", ew.count() == 1 and "EAGLE" in ew.locator("[role=option][aria-selected=true]").inner_text())
    page.evaluate("""window.__zip = null; window.__ssfp = window.showSaveFilePicker; window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, createWritable: async () => ({
      write: async (b) => { const u = b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); window.__zip = Array.from(u); },
      close: async () => {} }) }); true""")
    if ew.get_by_role("button", name="None", exact=True).count(): ew.get_by_role("button", name="None", exact=True).click(); page.wait_for_timeout(150)
    ew.get_by_role("button", name="Export", exact=True).click()
    for _ in range(60):
        page.wait_for_timeout(500)
        if page.evaluate("window.__zip !== null"): break
    raw = page.evaluate("window.__zip") or []
    names, ez = [], None
    try: ez = zipfile.ZipFile(io.BytesIO(bytes(raw))); names = ez.namelist()
    except Exception as e: print("zip:", e)
    esch = [n for n in names if n.endswith(".sch")]; ebrd = [n for n in names if n.endswith(".brd")]
    check(f"…the zip: EAGLE's schematic, board and library ({len(names)} files)", bool(esch) and bool(ebrd) and any(n.endswith(".lbr") for n in names)
          and b"<eagle version=" in ez.read(esch[0])[:200] and b"<board>" in ez.read(ebrd[0]))
    page.evaluate("window.showSaveFilePicker = window.__ssfp; true")
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    if esch and ebrd:
        page.evaluate("([a, b]) => window.konium.openBatch([{ name: 'Back.sch', bytes: new Uint8Array(a) }, { name: 'Back.brd', bytes: new Uint8Array(b) }])", [list(ez.read(esch[0])), list(ez.read(ebrd[0]))])
        for _ in range(40):
            page.wait_for_timeout(500)
            if page.evaluate("window.konium.state.projects.value.some(p => p.name === 'Back.PrjPcb')"): break
        docs = page.evaluate("(() => { const p = window.konium.state.projects.value.find(p => p.name === 'Back.PrjPcb'); return p ? p.prj.documents : []; })()")
        check(f"…opened again: imported as a project, its sheets, board and libraries ({len(docs)} documents)", any(d.endswith('.PcbDoc') for d in docs) and sum(d.endswith('.SchDoc') for d in docs) >= 2 and any(d.endswith('.SchLib') for d in docs))
        shot(page, "64-eagle-back.png")
    # 26.070: Export Wizard › EDIF Schematic — the demo project's sheets as one EDIF file
    if page.locator(".doctab", has_text="Demo.PcbDoc").count(): page.locator(".doctab", has_text="Demo.PcbDoc").first.click(); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('file.exportEdif')"); page.wait_for_timeout(400)
    ew = page.locator(".dlg", has_text="Export Wizard")
    page.evaluate("""window.__zip = null; window.__ssfp = window.showSaveFilePicker; window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, createWritable: async () => ({
      write: async (b) => { const u = b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); window.__zip = Array.from(u); },
      close: async () => {} }) }); true""")
    if ew.get_by_role("button", name="None", exact=True).count(): ew.get_by_role("button", name="None", exact=True).click(); page.wait_for_timeout(150)
    ew.get_by_role("button", name="Export", exact=True).click()
    for _ in range(60):
        page.wait_for_timeout(500)
        if page.evaluate("window.__zip !== null"): break
    raw = page.evaluate("window.__zip") or []
    names, edf = [], b""
    try: ez = zipfile.ZipFile(io.BytesIO(bytes(raw))); names = ez.namelist(); edf = ez.read([n for n in names if n.endswith(".edf")][0])
    except Exception as e: print("zip:", e)
    check(f"File › Export › EDIF Schematic: one EDIF file, its symbols, power symbols and the design's pages ({names}, {edf.count(b'(page ')} pages)",
          len(names) == 1 and edf.startswith(b"(edif ") and b"(library SYMBOLS" in edf and b"(library POWER" in edf and edf.count(b"(page ") == 3 and b"(design " in edf)
    page.evaluate("window.showSaveFilePicker = window.__ssfp; true")
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    # 26.057: File › Save As › Save as type: a board (a fresh copy of the demo's) saved as AD's ASCII PCB file
    page.evaluate("() => { const f = window.konium.demoFiles().find(x => x.name === 'Demo.PcbDoc'); window.konium.openBatch([{ name: 'Asc.PcbDoc', bytes: f.bytes }]); }"); page.wait_for_timeout(1200)
    page.evaluate("""window.__saved = null; window.__ssfp = window.showSaveFilePicker; window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, createWritable: async () => ({
      write: async (b) => { const u = b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); window.__saved = Array.from(u.subarray(0, 40)); },
      close: async () => {} }) }); true""")
    page.evaluate("window.konium.run('file.saveAs')"); page.wait_for_timeout(300)
    sa = page.locator(".dlg", has_text="Save as type")
    opts = sa.locator("select option").all_inner_texts() if sa.count() else []
    check(f"File › Save As: Save as type, binary or ASCII ({len(opts)} types)", sa.count() == 1 and "PCB ASCII File (*.PcbDoc)" in opts)
    if sa.count():
        sa.locator("select").select_option("ascii"); sa.get_by_role("button", name="Save...").click()
        for _ in range(20):
            page.wait_for_timeout(250)
            if page.evaluate("window.__saved !== null"): break
    head = bytes(page.evaluate("window.__saved") or []).decode("latin1")
    check(f"…saved as AD's ASCII PCB file ({head[:14]!r})", head.startswith("|RECORD=Board|"))
    page.evaluate("window.showSaveFilePicker = window.__ssfp; true")
    # 26.048: rigid-flex — layer stacks, split lines, regions, bending lines, Fold/Unfold (on a fresh copy of the demo board)
    page.evaluate("() => { const f = window.konium.demoFiles().find(x => x.name === 'Demo.PcbDoc'); window.konium.openBatch([{ name: 'Flex.PcbDoc', bytes: f.bytes }]); }"); page.wait_for_timeout(1500)
    check("Rigid-flex: a fresh board to fold", page.evaluate("window.konium.state.active.value.name") == "Flex.PcbDoc")
    page.mouse.move(700, 500)
    page.evaluate("window.konium.run('pcb.layerStackManager')"); page.wait_for_timeout(300)
    lsm = page.locator('.dlg.lsm')
    lsm.get_by_role('button', name='Advanced >>').click(); page.wait_for_timeout(150)
    lsm.get_by_role('button', name='Add Stack').click(); page.wait_for_timeout(150)
    lsm.locator("input[aria-label='Stack name']").fill('Flex')
    lsm.locator("input[aria-label='Is Flex']").check()
    for n in ['Top Overlay', 'Top Solder', 'Top Layer', 'Bottom Solder', 'Bottom Overlay']:
        lsm.locator(f"input[aria-label='{n} in Flex']").uncheck()
    check("Layer Stack Manager › Advanced: the board's layer stacks, Add Stack, Is Flex, the layers each has", "Layer Stack" in lsm.inner_text() and lsm.locator("input[aria-label='Bottom Layer in Flex']").is_checked())
    shot(page, "66-layer-stacks.png")
    lsm.locator('.dlg-foot .btn', has_text='OK').click(); page.wait_for_timeout(300)
    sub = page.evaluate(f"(() => {{ const b = {ED}.doc.board.bag; const id = b.get('V9_SUBSTACK1_ID'); const k = b.keys().find(k => /^V9_STACK_LAYER\\d+_NAME$/.test(k) && b.get(k) === 'Top Layer'); return [b.get('V9_SUBSTACK1_NAME'), b.get('V9_SUBSTACK1_ISFLEX'), b.get(k.replace('NAME', id + 'CONTEXT'))]; }})()")
    check(f"…kept in Board6 as AD17 keeps stacks: V9_SUBSTACK1 Flex, ISFLEX, Top Layer left out ({sub})", sub == ['Flex', 'TRUE', '1'])
    # A layer put back into a stack on its own (nothing else changed) is kept too
    page.evaluate("window.konium.run('pcb.layerStackManager')"); page.wait_for_timeout(300)
    lsm = page.locator('.dlg.lsm')
    lsm.get_by_role('button', name='Advanced >>').click(); page.wait_for_timeout(150)
    lsm.locator("select[aria-label='Layer stack']").select_option(label='Flex (flex)'); page.wait_for_timeout(100)
    lsm.locator("input[aria-label='Bottom Solder in Flex']").check()
    lsm.locator('.dlg-foot .btn', has_text='OK').click(); page.wait_for_timeout(300)
    bs = page.evaluate(f"(() => {{ const b = {ED}.doc.board.bag; const id = b.get('V9_SUBSTACK1_ID'); const k = b.keys().find(k => /^V9_STACK_LAYER\\d+_NAME$/.test(k) && b.get(k) === 'Bottom Solder'); return b.get(k.replace('NAME', id + 'CONTEXT')); }})()")
    check(f"…a layer ticked into the flex stack on its own: kept ({bs})", bs == '0')
    page.evaluate("window.konium.run('view.modePlanning')"); page.wait_for_timeout(300)
    fb = page.evaluate(f"(() => {{ const o = {ED}.doc.board.outline; const xs = o.map(p => p.x), ys = o.map(p => p.y); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }})()")
    FX = lambda f: fb[0] + (fb[2] - fb[0]) * f
    FY = lambda f: fb[1] + (fb[3] - fb[1]) * f
    for f in (0.40, 0.50):
        page.evaluate("window.konium.run('ad:PCB:PlaceSplitLine')"); page.wait_for_timeout(200)
        x1, y1 = page.evaluate(TO_SCREEN, [FX(f), fb[1] + 2000]); x2, y2 = page.evaluate(TO_SCREEN, [FX(f), FY(0.5)])
        page.mouse.move(x1, y1); page.mouse.click(x1, y1); page.wait_for_timeout(150)
        page.mouse.move(x2, y2); page.wait_for_timeout(150)
        page.mouse.click(x2, y2); page.wait_for_timeout(200)
        page.keyboard.press('Escape'); page.wait_for_timeout(100)
    nreg = page.evaluate(f"window.konium.state.active.value.editor.doc.flex.regions.length")
    check(f"Design › Define Split Line (twice): the board in three regions ({nreg})", nreg == 3 and page.evaluate(f"{ED}.doc.flex.splits.length") == 2)
    page.evaluate("window.konium.run('ad:PCB:PlaceBendingLine')"); page.wait_for_timeout(200)
    x, y = page.evaluate(TO_SCREEN, [FX(0.1), fb[1] + 2000]); page.mouse.click(x, y); page.wait_for_timeout(200)
    check("Define Bending Line on a rigid region: not there (only flex regions bend)", "flex layer stack" in page.locator(".toast").last.inner_text())
    page.keyboard.press('Escape'); page.wait_for_timeout(100)
    x, y = page.evaluate(TO_SCREEN, [FX(0.45), FY(0.75)])
    page.mouse.dblclick(x, y); page.wait_for_timeout(300)
    d = page.locator('.dlg.board-region')
    check("Board Region (double-click a region): Name, Layer Stack, 3D Locked", d.count() == 1 and d.locator("select[aria-label='Layer Stack']").count() == 1 and "3D Locked" in d.inner_text())
    d.locator("select[aria-label='Layer Stack']").select_option(label='Flex (flex)')
    d.locator('.dlg-foot .btn', has_text='OK').click(); page.wait_for_timeout(300)
    rf = page.evaluate(f"JSON.stringify({ED}.doc.flex.regions.map(r => [r.stackId === {ED}.doc.board.bag.get('V9_SUBSTACK1_ID'), r.bends.length]))")
    check(f"…on the flex stack: a bending line across its middle, as AD adds one ({rf})", '[true,1]' in rf)
    x, y = page.evaluate(TO_SCREEN, [FX(0.1), FY(0.1)])
    page.mouse.dblclick(x, y); page.wait_for_timeout(300)
    d = page.locator('.dlg.board-region'); d.get_by_label('3D Locked').check(); d.locator('.dlg-foot .btn', has_text='OK').click(); page.wait_for_timeout(300)
    # The bending line: double-click it
    bl = page.evaluate(f"(() => {{ const r = {ED}.doc.flex.regions.findIndex(r => r.bends.length); const regs = window.konium.state.active.value.editor.allItems().filter(i => i.key.startsWith('bend:')); return regs.length ? regs[0].key : null; }})()")
    mid = page.evaluate(f"(() => {{ const f = {ED}.doc.flex; const l = f.regions.find(r => r.bends.length).bends[0]; return [(l.a.x + l.b.x) / 2, l.a.y + (l.b.y - l.a.y) * 0.3]; }})()")
    x, y = page.evaluate(TO_SCREEN, mid)
    page.mouse.dblclick(x, y); page.wait_for_timeout(300)
    bd = page.locator('.dlg.bending-line')
    check(f"Bending Line (double-click one): Radius, Bending Angle, Affected Area Width, Fold Index ({bl})", bd.count() == 1 and all(t in bd.inner_text() for t in ['Radius', 'Bending Angle', 'Affected Area Width', 'Fold Index']))
    if bd.count():
        bd.locator("input[aria-label='Bending Angle']").fill('120')
        bd.locator('.dlg-foot .btn', has_text='OK').click(); page.wait_for_timeout(300)
    check("…a new angle kept", page.evaluate(f"{ED}.doc.flex.regions.find(r => r.bends.length).bends[0].angle") == 120)
    page.mouse.move(700, 880)
    shot(page, "67-board-planning-flex.png")
    page.mouse.move(800, 500); page.keyboard.press('3'); page.wait_for_timeout(3500)
    page.keyboard.press('5'); page.wait_for_timeout(2500)
    fs = page.evaluate(f"[{ED}.view3d ? {ED}.view3d.foldState : -1, {ED}.folded]")
    check(f"View › Fold/Unfold (5): the board folds in 3D about its bending lines, the locked part still ({fs})", fs == [1, True])
    page.evaluate(f"(() => {{ const v = {ED}.view3d; v.yaw = -35 * Math.PI / 180; v.pitch = 60 * Math.PI / 180; v.fit(); }})()"); page.wait_for_timeout(800)
    shot(page, "68-fold.png")
    page.keyboard.press('5'); page.wait_for_timeout(2000)
    check("…5 again: flat", page.evaluate(f"{ED}.view3d.foldState") == 0)
    page.keyboard.press('1'); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('ad:PCB:DeleteSplitLine')"); page.wait_for_timeout(200)
    x, y = page.evaluate(TO_SCREEN, [FX(0.5), FY(0.3)]); page.mouse.move(x, y); page.mouse.click(x, y); page.wait_for_timeout(300)
    page.keyboard.press('Escape')
    check(f"Design › Delete Split Line: its two regions one again ({page.evaluate(f'{ED}.doc.flex.regions.length')})", page.evaluate(f"{ED}.doc.flex.regions.length") == 2)
    page.keyboard.press('Control+z'); page.wait_for_timeout(200)
    check("…undone: three again", page.evaluate(f"{ED}.doc.flex.regions.length") == 3)
    # A split line's end dragged along the edge (select it, drag its handle)
    sx, sy = page.evaluate(TO_SCREEN, [FX(0.40), FY(0.3)]); page.mouse.click(sx, sy); page.wait_for_timeout(200)
    hx, hy = page.evaluate(TO_SCREEN, [FX(0.40), fb[3]]); tx, ty = page.evaluate(TO_SCREEN, [FX(0.33), fb[3]])
    page.mouse.move(hx, hy); page.mouse.down(); page.mouse.move((hx + tx) / 2, hy, steps=4); page.mouse.move(tx, ty, steps=4); page.wait_for_timeout(150)
    page.mouse.up(); page.wait_for_timeout(300)
    ends = page.evaluate(f"{ED}.doc.flex.splits.map(s => Math.round(Math.max(s.a.x, s.b.x) - Math.min(s.a.x, s.b.x)))")
    check(f"…a split line's end dragged along the edge: the line slants, its regions follow ({ends})", any(e > (fb[2] - fb[0]) * 0.05 for e in ends) and page.evaluate(f"{ED}.doc.flex.regions.length") == 3)
    page.keyboard.press('Control+z'); page.wait_for_timeout(200)
    page.locator(".menubar-item", has_text="Design").first.dispatch_event("mousedown"); page.wait_for_timeout(200)
    dm = page.locator(".menu-popup[data-depth='0']").inner_text()
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    page.locator(".menubar-item", has_text="View").first.dispatch_event("mousedown"); page.wait_for_timeout(200)
    vm = page.locator(".menu-popup[data-depth='0']").inner_text()
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    check("Menus: Design › Define Split Line, Delete Split Line, Define Bending Line; View › Fold/Unfold", all(t in dm for t in ['Define Split Line', 'Delete Split Line', 'Define Bending Line']) and 'Fold/Unfold' in vm)
    page.keyboard.press('2'); page.wait_for_timeout(200)
    # 26.049: the 3D model editor (STEP): a new model, a box and a cylinder, turned, undone, placed on a footprint
    page.evaluate("window.konium.run('file.newStepModel')"); page.wait_for_timeout(600)
    sd = page.locator('.stepdoc')
    check("File › New › 3D Model (STEP): the 3D model editor", sd.count() == 1 and page.evaluate("window.konium.state.active.value.doc.kind") == "StepDoc" and "No parts yet" in sd.inner_text())
    sd.get_by_role('button', name='Box').click(); page.wait_for_timeout(1500)
    for lbl, v in (('Width (X)', '5mm'), ('Depth (Y)', '4mm'), ('Height (Z)', '1.5mm')):
        f = sd.locator(f"input[aria-label='{lbl}']"); f.fill(v); f.press('Tab'); page.wait_for_timeout(500)
    sd.get_by_role('button', name='Cylinder').click(); page.wait_for_timeout(1500)
    f = sd.locator("input[aria-label='Position X']"); f.fill('1.5mm'); f.press('Tab'); page.wait_for_timeout(500)
    parts = page.evaluate("window.konium.state.active.value.doc.parts.map(p => [p.name, p.prim ? p.prim.shape.kind : '', p.xf.o.map(v => Math.round(v * 1000) / 1000).join(',')])")
    check(f"…Box (5 × 4 × 1.5 mm) and Cylinder at X 1.5 mm as parts ({parts})", parts == [['Box1', 'box', '0,0,0'], ['Cylinder1', 'cylinder', '1.5,0,0']]
          and page.evaluate("window.konium.state.active.value.doc.parts[0].prim.shape.w") == 5)
    sd.get_by_role('button', name='Z 90°').click(); page.wait_for_timeout(500)
    o = page.evaluate("window.konium.state.active.value.doc.parts[1].xf.o.map(v => Math.round(v * 1000) / 1000)")
    check(f"…Z 90°: the selected part turned about the origin ({o})", o == [0, 1.5, 0])
    page.keyboard.press('Control+z'); page.wait_for_timeout(300)
    check("…Ctrl+Z: back where it was", page.evaluate("window.konium.state.active.value.doc.parts[1].xf.o[0]") == 1.5)
    page.keyboard.press('Control+y'); page.wait_for_timeout(300)
    sd.get_by_role('button', name='Origin: Bottom Centre').click(); page.wait_for_timeout(800)
    info = sd.locator('.sd-info').inner_text()
    check(f"…size, parts, faces ({info.splitlines()[0]})", "2 parts" in info and "faces" in info and page.locator('.doctab.on', has_text='*').count() == 1)
    sd.get_by_role('button', name='Measure').click()
    cb = page.locator('.sd-canvas').bounding_box()
    page.mouse.click(cb['x'] + cb['width'] * 0.47, cb['y'] + cb['height'] * 0.5); page.wait_for_timeout(300)
    page.mouse.click(cb['x'] + cb['width'] * 0.56, cb['y'] + cb['height'] * 0.56); page.wait_for_timeout(300)
    check(f"…Measure: the distance between two points ({page.locator('.sd-result').inner_text() if page.locator('.sd-result').count() else ''})", page.locator('.sd-result').count() == 1 and "Distance" in page.locator('.sd-result').inner_text())
    page.keyboard.press('Escape'); page.wait_for_timeout(100)
    shot(page, "69-model-editor.png")
    has_lib = page.evaluate("window.konium.state.docs.value.some(d => d.name.toLowerCase().endsWith('.pcblib'))")
    if not has_lib:
        page.evaluate("() => { const f = window.konium.demoFiles().find(x => x.name === 'Demo.PcbLib'); window.konium.openBatch([{ name: 'Models.PcbLib', bytes: f.bytes }]); }"); page.wait_for_timeout(1200)
        page.locator('.doctab', has_text='Model1.step').first.dispatch_event('mousedown'); page.wait_for_timeout(300)
    page.locator('.stepdoc').get_by_role('button', name='Place on Footprint').click(); page.wait_for_timeout(2500)
    act = page.evaluate("[window.konium.state.active.value.name, window.konium.state.active.value.editor && window.konium.state.active.value.editor.tool.id]")
    check(f"Place on Footprint: the PCB library in front, placing the model as a 3D body ({act})", act[0].lower().endswith('.pcblib') and act[1] == 'place-body')
    page.keyboard.press('Escape'); page.wait_for_timeout(200); page.keyboard.press('Escape'); page.wait_for_timeout(200)
    # Mixed Sim: the simulation demo, Analyses Setup, the run, SimView, the generated netlist, the Simulation Sources toolbar
    page.evaluate("window.konium.run('file.openSimDemo')"); page.wait_for_timeout(1800)
    off = page.locator('.tbar[data-bar="sch.simSources"]').count() == 0
    page.evaluate("window.konium.prefs.set({ shownToolbars: ['sch.simSources'] })"); page.wait_for_timeout(300)
    check("Simulation demo: Amplifier.SchDoc in front; the Simulation Sources toolbar off until View › Toolbars switches it on",
          off and page.evaluate("window.konium.state.active.value.name") == "Amplifier.SchDoc" and page.locator('.tbar[data-bar="sch.simSources"] .tbtn').count() == 12)
    page.evaluate("window.konium.run('sim.mixedSim')"); page.wait_for_timeout(600)
    dlg = page.locator(".analyses-setup")
    act = dlg.locator("select[aria-label='Active Signals'] option").all_inner_texts()
    check(f"Design › Simulate › Mixed Sim: Analyses Setup, the Active Signals ({act}) and analyses", dlg.count() == 1 and act == ["IN", "OUT"]
          and dlg.locator(".as-analyses li").all_inner_texts() == ["Operating Point Analysis", "Transient Analysis", "AC Small Signal Analysis"])
    dlg.locator(".as-item", has_text="Transient Analysis").click(); page.wait_for_timeout(200)
    shot(page, "73-analyses-setup.png")
    check("…Transient Analysis: Use Transient Defaults gives 5 cycles of the 1 kHz source", dlg.locator("input[aria-label='Transient Stop Time']").input_value() == "5.000m")
    dlg.get_by_role("button", name="OK").click()
    page.wait_for_selector(".simview", timeout=20000); page.wait_for_timeout(800)
    tabs = page.locator(".sv-tab").all_inner_texts()
    names = page.locator(".sv-name").all_text_contents()
    check(f"…the run: SimView opens on the transient, a plot for each active signal ({tabs}, {names})", tabs == ["Transient Analysis", "AC Analysis", "Operating Point"] and names == ["IN", "OUT"])
    msgs = page.evaluate("window.konium.state.messages.value.filter(m => m.source === 'Mixed Sim').map(m => m.message)")
    check(f"…Messages: Mixed Sim's summary ({msgs})", any("3 analyses in" in m for m in msgs))
    pb = page.locator(".sv-plot").bounding_box()
    before = page.locator(".sv-label").all_text_contents()
    page.mouse.move(pb["x"] + pb["width"] * 0.4, pb["y"] + pb["height"] * 0.5)
    vals = page.locator(".sv-wave-val").all_inner_texts()
    page.wait_for_timeout(300)
    under = page.evaluate(f"(() => {{ const e = document.elementFromPoint({pb['x'] + pb['width'] * 0.4}, {pb['y'] + pb['height'] * 0.5}); return e ? e.tagName + '.' + (e.getAttribute('class') || '') : '' }})()")
    page.evaluate("window.__wheels = []; document.addEventListener('wheel', (e) => window.__wheels.push((e.target.getAttribute && e.target.getAttribute('class')) + ':' + e.deltaY + ':' + e.defaultPrevented), { capture: true, passive: true })")
    tries = 0
    while tries < 4:
        tries += 1
        for _ in range(3): page.mouse.wheel(0, -200); page.wait_for_timeout(150)
        page.wait_for_timeout(200)
        after = page.locator(".sv-label").all_text_contents()
        if after != before: break
        page.mouse.move(pb["x"] + pb["width"] * 0.42, pb["y"] + pb["height"] * 0.5)
    diag = ''
    if before == after:
        seen = page.evaluate("window.__wheels.slice(0, 3)")
        page.evaluate(f"document.querySelector('.sv-plot').dispatchEvent(new WheelEvent('wheel', {{ deltaY: -200, clientX: {pb['x'] + pb['width'] * 0.4}, clientY: {pb['y'] + pb['height'] * 0.5}, bubbles: true, cancelable: true }}))")
        page.wait_for_timeout(300)
        synth = page.locator(".sv-label").all_text_contents() != before
        diag = f", under {under}, seen {seen}, synthetic zooms {synth}"
    check(f"…the waves' values under the cursor ({vals}); the wheel zooms the time axis (try {tries}{diag})", all(v.endswith("V") for v in vals) and before != after)
    shot(page, "74-simview.png")
    page.mouse.dblclick(pb["x"] + pb["width"] * 0.4, pb["y"] + pb["height"] * 0.5); page.wait_for_timeout(300)
    check("…a double-click fits it again", page.locator(".sv-label").all_text_contents() == before)
    page.locator(".sv-tab", has_text="Operating Point").click(); page.wait_for_timeout(300)
    op = page.locator(".sv-table").inner_text()
    check("…Operating Point: the bias (BASE about 2.03 V, Q1's collector current)", "BASE\t2.028V" in op and "Q1[ic]" in op)
    page.locator(".sv-tab", has_text="AC Analysis").click(); page.wait_for_timeout(300)
    page.locator(".sv-acshow").select_option("Magnitude (dB)"); page.wait_for_timeout(300)
    check("…AC Analysis: magnitude in dB over a log frequency axis", any(t.endswith("dB") for t in page.locator(".sv-label").all_text_contents()) and "1.000kHz" in page.locator(".sv-label").all_text_contents())
    shot(page, "75-simview-ac.png")
    # 26.060: a wave selected, cursors A and B on it, the Sim Data panel's measurements; an expression added; an FFT chart
    page.locator(".sv-tab", has_text="Transient Analysis").first.click(); page.wait_for_timeout(300)
    page.locator(".sv-waves li", has_text="OUT").first.click(); page.wait_for_timeout(150)
    for c in ("simview.cursorA", "simview.cursorB", "simview.cursorMax"): page.evaluate(f"window.konium.run('{c}')"); page.wait_for_timeout(100)
    page.evaluate("window.konium.run('view.panel.simdata')"); page.wait_for_timeout(400)
    sd = page.locator(".simdata").inner_text() if page.locator(".simdata").count() else ""
    check("Wave › Cursor A, B, Select Maximum Point: the Sim Data panel measures OUT between them (its frequency about 1 kHz, its top about 1 V)",
          "Measurement Cursors" in sd and "Frequency A..B" in sd and any(t in sd for t in ("998", "999", "1.000kHz", "1.001kHz")) and "Waveform Measurements" in sd and page.locator(".sv-mcursor").count() >= 2)
    page.evaluate("window.konium.run('simview.addWave')"); page.wait_for_selector(".addwave")
    page.locator(".addwave input[aria-label=Expression]").fill("OUT-IN")
    page.locator(".addwave button.default").click(); page.wait_for_timeout(300)
    check("Wave › Add Wave: an expression of signals (OUT-IN) on the selected plot", "OUT-IN" in page.locator(".sv-waves").inner_text() and page.locator(".doctab.on", has_text="*").count() == 1)
    shot(page, "76-simview-cursors.png")
    page.evaluate("window.konium.run('simview.fft')"); page.wait_for_timeout(500)
    check("Chart › Create FFT Chart: a chart of the waves' spectra", page.locator(".sv-tab.on").inner_text() == "FFT of Transient Analysis" and page.locator(".sv-acshow").count() == 1)
    page.evaluate("window.konium.run('view.panel.simdata')"); page.wait_for_timeout(200)
    tree = page.locator(".panel[aria-label=Projects]").inner_text()
    check("Projects: the netlist and the results under the project's Generated folder", "Generated" in tree and "Sim Demo.nsx" in tree and "Sim Demo.sdf" in tree)
    page.locator(".doctab", has_text="Sim Demo.nsx").first.dispatch_event("mousedown"); page.wait_for_timeout(500)
    nsx = page.evaluate("window.konium.state.active.value.doc.text")
    check("…the netlist: each part by its SIM model, the analyses, the 2N3904 model at the end", "Q1 NetC3_1 BASE NetC2_1 2N3904" in nsx and ".TRAN 20.00u 5.000m" in nsx and ".MODEL 2N3904 NPN(" in nsx
          and page.locator(".simtext .st-card").count() > 3)
    page.locator(".st-area").click(); page.keyboard.press("Control+End"); page.keyboard.type("\n* edited")
    page.evaluate("window.konium.run('sim.run')"); page.wait_for_timeout(1500)
    check("…edited (its tab marked) and run itself: Simulate › Run Simulation, the results in front", page.locator(".doctab.on", has_text="Sim Demo.sdf").count() == 1 and page.locator(".doctab", has_text="Sim Demo.nsx *").count() == 1)
    page.locator(".doctab", has_text="Amplifier.SchDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(500)
    page.locator('.tbar[data-bar="sch.simSources"] .tbtn[data-cmd="sim.source.sin10k"]').dispatch_event("mousedown"); page.wait_for_timeout(300)
    vb = page.locator(".viewport").first.bounding_box()
    page.mouse.click(vb["x"] + vb["width"] * 0.75, vb["y"] + vb["height"] * 0.3); page.wait_for_timeout(300)
    page.keyboard.press("Escape"); page.wait_for_timeout(200); page.keyboard.press("Escape"); page.wait_for_timeout(200)
    placed = page.evaluate("(() => { const d = window.konium.state.active.value.doc; return d.objects.filter(o => o.kind === 'text' && o.role === 'designator').map(o => o.text); })()")
    check(f"Simulation Sources › 10kHz Sine Wave: a VSIN placed as AD's preset names it ({placed[-3:]})", "10KHz" in placed)
    page.keyboard.press("Control+z"); page.wait_for_timeout(200)
    page.evaluate("window.konium.prefs.set({ shownToolbars: [] })")
    # The part's Models › Simulation: the Sim Model dialog (kind, parameters, port map, netlist preview)
    qi = page.evaluate(f"(() => {{ const d = {ED}.doc; return d.objects.find(o => o.kind === 'text' && o.role === 'designator' && o.text === 'Q1').owner; }})()")
    page.evaluate(f"window.konium.editObject({ED}, 'o{qi}')"); page.wait_for_timeout(400)
    page.locator(".cp-mrow", has_text="Simulation").first.dblclick(); page.wait_for_timeout(400)
    sm = page.locator(".simmodel")
    check("Q1 › Models › Simulation › Edit: Sim Model - Transistor / BJT, its 2N3904 found, the netlist preview",
          sm.count() == 1 and "Sim Model - Transistor / BJT" in sm.inner_text() and "Found In" in sm.inner_text() and "Q1 Net_1 Net_2 Net_3 2N3904" in sm.inner_text())
    shot(page, "77-sim-model.png")
    page.keyboard.press("Escape"); page.wait_for_timeout(200); page.keyboard.press("Escape"); page.wait_for_timeout(200)
    # 26.061: Noise, Pole-Zero and a Parameter Sweep from Analyses Setup; the runs together in SimView; a second Y axis; Document Options
    page.evaluate("window.konium.run('sim.mixedSim')"); page.wait_for_selector(".analyses-setup")
    dlg = page.locator(".analyses-setup")
    for item, en in (("Noise Analysis", True), ("Pole-Zero Analysis", True), ("Parameter Sweep", True)):
        dlg.locator(".as-item", has_text=item).click(); page.wait_for_timeout(150)
        dlg.locator(f"input[aria-label='{item} enabled']").check()
        if item == "Noise Analysis":
            dlg.locator("select[aria-label='Noise Source']").select_option("V2"); dlg.locator("select[aria-label='Output Node']").select_option("OUT")
            dlg.locator("input[aria-label='Points Per Summary']").fill("1")
        elif item == "Pole-Zero Analysis":
            dlg.locator("select[aria-label='Input Node']").select_option("IN"); dlg.locator("select[aria-label='Output Node']").select_option("OUT")
        else:
            for lbl, v in (("Primary Sweep Variable", "R1"), ("Primary Start Value", "40k"), ("Primary Stop Value", "50k"), ("Primary Step Value", "5k")): dlg.locator(f"input[aria-label='{lbl}']").fill(v)
    shot(page, "78-analyses-noise-sweep.png")
    dlg.locator(".as-item", has_text="General Setup").click(); page.wait_for_timeout(150)
    active_an = dlg.locator(".as-analyses li").all_inner_texts()
    dlg.get_by_role("button", name="OK").click()
    page.wait_for_function("document.querySelectorAll('.sv-tab').length >= 5", timeout=30000); page.wait_for_timeout(600)
    tabs = page.locator(".sv-tab").all_inner_texts()
    check(f"Analyses Setup: Noise, Pole-Zero and Parameter Sweep enabled ({active_an}); the run's charts ({tabs})",
          "Noise Analysis" in active_an and "Parameter Sweep" in active_an and all(t in tabs for t in ("Noise Spectral Density", "Integrated Noise", "Pole-Zero Analysis")))
    page.locator(".sv-tab", has_text="Transient Analysis").first.click(); page.wait_for_timeout(300)
    names = page.locator(".sv-waves .sv-wave-name").all_text_contents()
    check(f"Parameter Sweep: each signal's runs drawn together, each with its value ({names[:3]})", any(n.startswith("OUT_p1") and "R1=40k" in n for n in names) and any(n.startswith("OUT_p3") and "R1=50k" in n for n in names))
    page.locator(".sv-waves li", has_text="OUT_p2").first.click(); page.wait_for_timeout(150)
    page.evaluate("window.konium.run('simview.addYAxis')"); page.wait_for_timeout(300)
    check("Plot › Add Y Axis: the selected run on an axis of its own, on the right", page.locator(".sv-axis2").count() == 1)
    page.evaluate("window.konium.run('simview.documentOptions')"); page.wait_for_selector(".sv-options")
    page.locator(".sv-options input[aria-label='Plot Area']").evaluate("(e) => { e.value = '#203040'; e.dispatchEvent(new Event('input', { bubbles: true })); }")
    page.locator(".sv-options button.default").click(); page.wait_for_timeout(300)
    fill = page.evaluate("getComputedStyle(document.querySelector('.sv-bg')).fill")
    check(f"Tools › Document Options: the plot area's colour ({fill})", fill in ("rgb(32, 48, 64)", "#203040"))
    shot(page, "79-simview-runs-axes.png")
    page.locator(".sv-tab", has_text="Noise Spectral Density").first.click(); page.wait_for_timeout(300)
    nz = page.locator(".sv-waves").inner_text()
    page.locator(".sv-tab", has_text="Pole-Zero Analysis").first.click(); page.wait_for_timeout(300)
    pz = page.locator(".sv-table").inner_text()
    check("Noise: the output and input noise densities and the parts' shares; Pole-Zero: a table of poles and zeros per run",
          "onoise_spectrum_p1" in nz and "inoise_spectrum_p1" in nz and "Pole 1" in pz and "Zero 1" in pz and "R1=45k" in pz)
    # 26.062: the CAM editor — the board's Gerber and drill files dropped on the window open as a CAM document
    page.evaluate("(fs) => { const enc = new TextEncoder(); window.konium.openBatch(fs.map((f) => ({ name: f.name, bytes: enc.encode(f.text) }))); }", cam_files); page.wait_for_timeout(1500)
    cam = page.evaluate("(() => { const a = window.konium.state.active.value; return a.doc.kind === 'CamDoc' ? a.doc.layers.map(l => l.name + ':' + l.type) : [a.doc.kind]; })()")
    check(f"CAM editor: Gerber and drill files dropped open as a CAM document, each layer typed by its extension ({cam})",
          cam == ["Demo.GM1:Mechanical", "Demo.GBL:Bottom", "Demo.GTL:Top", "Demo.GTS:Top Mask", "Demo.GTO:Top Silk", "Demo.TXT:Drill Top"])
    vb = page.locator(".viewport").first.bounding_box()
    page.evaluate("window.konium.run('cam.layersAllOff')"); page.wait_for_timeout(200)
    off = page.evaluate("window.konium.state.active.value.doc.layers.filter(l => l.visible).length")
    page.evaluate("window.konium.run('cam.layersAllOn')"); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('view.fit')"); page.wait_for_timeout(300)
    # A flash of the top layer (a surface-mount pad: no drill hit above it) picked; Properties tell its D-code and aperture
    at = page.evaluate("""(() => { const ed = window.konium.state.active.value.editor, d = ed.doc, li = d.layers.findIndex(l => l.type === 'Top');
      const hits = d.layers.filter(l => l.data.kind === 'drill').flatMap(l => l.data.hits);
      const f = d.layers[li].data.objects.find(o => o.kind === 'flash' && !hits.some(h => Math.hypot(h.at.x - o.at.x, h.at.y - o.at.y) < 1e4));
      const p = ed.viewport.cam.toScreen(f.at); return [p.x, p.y]; })()""")
    page.mouse.click(vb["x"] + at[0], vb["y"] + at[1]); page.wait_for_timeout(300)
    props = page.evaluate("window.konium.state.active.value.editor.properties().flatMap(s => s.rows.map(r => r.label + ' ' + r.value))")
    check(f"…View › Layers › All Off / All On; a flash picked: its layer, D-code and aperture ({props[:4]})", off == 0 and any(p.startswith("D-Code D") for p in props) and any(p.startswith("Object Flash") for p in props))
    page.keyboard.press("Control+e"); page.wait_for_timeout(200)
    erased = page.evaluate("window.konium.state.active.value.doc.layers.map(l => (l.erased || []).length).reduce((a, b) => a + b, 0)")
    page.keyboard.press("Control+z"); page.wait_for_timeout(200)
    back = page.evaluate("window.konium.state.active.value.doc.layers.map(l => (l.erased || []).length).reduce((a, b) => a + b, 0)")
    check(f"…Edit › Erase (Ctrl+E, AD's key) takes it out, undo puts it back ({erased} → {back})", erased == 1 and back == 0)
    page.evaluate("window.konium.run('cam.reportDrill')"); page.wait_for_timeout(300)
    rep = page.locator(".cam-report").inner_text() if page.locator(".cam-report").count() else ""
    page.keyboard.press("Escape"); page.wait_for_timeout(150)
    page.locator(".cam-layers li", has_text="Demo.GTL").click(); page.wait_for_timeout(150)
    page.evaluate("window.konium.run('cam.apertures')"); page.wait_for_timeout(300)
    aps = page.locator(".cam-table table[aria-label=Apertures] tbody tr").count()
    page.keyboard.press("Escape"); page.wait_for_timeout(150)
    menus = page.locator(".menubar-item").all_inner_texts()
    check(f"…Reports › Drill (tools, sizes, hits: {[l for l in rep.splitlines() if l.startswith('Total')]}), the current layer's Tables › Apertures ({aps} D-codes), CAMtastic's menus ({menus[:7]})",
          "T01" in rep and "Total   5 holes" in rep and aps > 3 and menus[:7] == ["File", "Edit", "View", "Place", "Tools", "Rout", "Analysis"])
    shot(page, "80-cam-editor.png")
    # 26.068: CAMtastic editing — Place › Rectangle and Text on the silk layer, the rectangle moved and the move undone; the toolbar's own buttons
    page.locator(".cam-layers li", has_text="Demo.GTO").click(); page.wait_for_timeout(150)
    GTO = "window.konium.state.active.value.doc.layers.find(l => l.name === 'Demo.GTO')"
    n0 = page.evaluate(f"{GTO}.data.objects.length")
    cx, cy = vb["x"] + vb["width"] / 2, vb["y"] + vb["height"] / 2
    page.evaluate("window.konium.run('ad:CAMTASTIC:DrawRect')"); page.mouse.click(cx - 200, cy - 150); page.mouse.click(cx - 80, cy - 60); page.mouse.click(cx, cy, button="right"); page.wait_for_timeout(200)
    page.evaluate("window.konium.run('ad:CAMTASTIC:DrawText')"); page.mouse.click(cx - 200, cy + 120); page.wait_for_timeout(300)
    page.locator(".camform input#cf-text").fill("REV A"); page.locator(".camform .btn.default").click(); page.wait_for_timeout(200)
    page.mouse.click(cx, cy, button="right"); page.wait_for_timeout(200)
    kinds = page.evaluate(f"[...({GTO}.groups || new Map()).values()].map(g => g.kind + (g.text ? ':' + g.text : ''))")
    n1 = page.evaluate(f"{GTO}.data.objects.length")
    rect0 = page.evaluate(f"{GTO}.data.objects[{n0}].a.x")
    page.mouse.click(cx - 200, cy - 105); page.wait_for_timeout(150)
    picked = page.evaluate(f"{ED}.selectedObjects().length")
    page.evaluate("window.konium.run('ad:CAMTASTIC:EditMove')"); page.mouse.click(cx - 200, cy - 150); page.mouse.click(cx - 100, cy - 150); page.wait_for_timeout(200)
    rect1 = page.evaluate(f"{GTO}.data.objects[{n0}].a.x")
    page.keyboard.press("Control+z"); page.wait_for_timeout(200)
    rect2 = page.evaluate(f"{GTO}.data.objects[{n0}].a.x")
    own = page.locator(".tbtn[data-cmd^='ad:CAMTASTIC:Edit']").count()
    check(f"CAM editing: Place › Rectangle (a closed polyline) and Text ({kinds}, {n1 - n0} objects); a click picks the rectangle whole ({picked} sides), Move moves it, undo puts it back; Cut, Copy, Paste on the toolbar ({own})",
          kinds == ["polyline", "text:REV A"] and n1 - n0 > 10 and picked == 4 and rect1 > rect0 and rect2 == rect0 and own == 3)
    shot(page, "81-cam-editing.png")
    # 26.069: CAMtastic's Tools, Analysis and File — the netlist extracted, the design checked, the films made back into a board
    page.evaluate("window.konium.run('ad:CAMTASTIC:ToolsNetListEx')"); page.wait_for_timeout(300)
    nets = page.evaluate("(window.konium.state.active.value.doc.nets || []).length")
    page.evaluate("window.konium.run('ad:CAMTASTIC:InfoDrc')"); page.wait_for_selector(".camform input#cf-cl")
    page.locator(".camform input#cf-cl").fill("40mil"); page.locator(".camform .btn.default").click(); page.wait_for_timeout(500)
    drc = page.evaluate(f"({ED}.drc || []).map(v => v.rule)")
    page.evaluate("window.konium.run('ad:CAMTASTIC:InfoPCBReport')"); page.wait_for_selector(".cam-report", timeout=15000)
    rfq = page.locator(".cam-report").inner_text()
    page.keyboard.press("Escape"); page.wait_for_timeout(150)
    check(f"CAM tools: Netlist › Extract ({nets} nets), Analysis › PCB Design Check at 40 mil ({len(drc)} violations: {sorted(set(drc))}), Reports › PCB RFQ Report",
          nets >= 3 and len(drc) > 0 and "Copper layers: 2" in rfq)
    shot(page, "82-cam-drc.png")
    page.evaluate("window.konium.run('ad:CAMTASTIC:ExportToPCB')"); page.wait_for_timeout(1500)
    pcb = page.evaluate("(() => { const d = window.konium.state.active.value.doc; return d.kind === 'PcbDoc' ? [d.name, d.prims.filter(p => p.kind === 'track').length, d.prims.filter(p => p.kind === 'pad').length, d.nets.length] : [d.kind]; })()")
    check(f"…File › Export › Export to PCB: a board of the films' tracks, pads and nets ({pcb})", pcb[0].endswith(".PcbDoc") and pcb[1] > 5 and pcb[2] > 3 and pcb[3] == nets)

    # 26.063: the text editor's Edit, Tools and Window menus on the simulation netlist
    page.locator(".doctab", has_text="Sim Demo.nsx").first.dispatch_event("mousedown"); page.wait_for_timeout(400)
    ta = page.locator("textarea.st-area").first
    page.evaluate("window.konium.run('ad:TextEdit:FindAndReplace')"); page.wait_for_timeout(200)
    page.locator("input[aria-label='Text to find']").fill("VCC"); page.locator("input[aria-label='Replace with']").fill("VSUP")
    page.get_by_role("button", name="Replace All").click(); page.wait_for_timeout(300)
    replaced = ta.input_value().count("VSUP")
    page.locator("input[aria-label='Text to find']").fill("VSUP")
    page.get_by_role("button", name="Find Next").click(); page.wait_for_timeout(150)
    marks = page.locator(".st-under mark").count()
    ta.focus(); page.keyboard.press("Control+Shift+C"); page.wait_for_timeout(150)
    check(f"Text editor: Edit › Replace All ({replaced} replaced), the matches marked ({marks}) until Clear Browser Marks (Ctrl+Shift+C)",
          replaced >= 2 and "VCC" not in ta.input_value() and marks >= 2 and page.locator(".st-under mark").count() == 0)
    page.evaluate("(() => { const a = document.querySelector('textarea.st-area'); const v = a.value; const s = v.indexOf('\\nC1') + 1; a.focus(); a.setSelectionRange(s, v.indexOf('\\n', v.indexOf('\\n', s) + 1)); })()")
    page.evaluate("window.konium.run('ad:TextEdit:IndentTextBlock')"); page.wait_for_timeout(100)
    ind = [l for l in ta.input_value().split("\n") if l.lstrip().startswith(("C1", "C2"))]
    page.keyboard.press("Shift+Tab"); page.wait_for_timeout(100)
    outd = [l for l in ta.input_value().split("\n") if l.lstrip().startswith(("C1", "C2"))]
    page.evaluate("(() => { const a = document.querySelector('textarea.st-area'); const i = a.value.toUpperCase().indexOf('.TRAN'); a.focus(); a.setSelectionRange(i + 2, i + 2); })()")
    page.evaluate("window.konium.run('ad:TextEdit:SetWordToLowerCase')"); page.wait_for_timeout(100)
    low = ".tran" in ta.input_value()
    check(f"…Tools › Indent / Unindent (Shift+Tab) the selected lines ({[l[:4] for l in ind]} → {[l[:4] for l in outd]}), Change Case › Word To Lower Case",
          all(l.startswith("\t") for l in ind) and len(ind) == 2 and all(not l.startswith("\t") for l in outd) and low)
    page.evaluate("window.konium.run('ad:TextEdit:SplitEditorVertically')"); page.wait_for_timeout(200)
    two = page.locator("textarea.st-area").count()
    page.locator("textarea.st-area").nth(1).focus(); page.keyboard.press("Control+End"); page.keyboard.type("* from the second view")
    seen = page.locator("textarea.st-area").first.input_value().endswith("* from the second view")
    page.evaluate("window.konium.run('ad:TextEdit:WordWrapAtWindow')"); page.wait_for_timeout(200)
    wrapped = page.locator("textarea.st-area.wrap").count()
    shot(page, "81-text-editor.png")
    page.evaluate("window.konium.run('ad:TextEdit:WordWrapNone')"); page.evaluate("window.konium.run('ad:TextEdit:CombineEditors')"); page.wait_for_timeout(200)
    check(f"…Window › Split Vertically: two views of the one text ({two}, typed in one shown in the other: {seen}); Tools › Word Wrap › At Window; Remove Split",
          two == 2 and seen and wrapped == 2 and page.locator("textarea.st-area").count() == 1)
    page.evaluate("window.konium.run('ad:TextEdit:ShowCodeTemplates')"); page.wait_for_timeout(300)
    page.locator(".dlg", has_text="Code Templates").locator("text=.NOISE — noise").dblclick(); page.wait_for_timeout(300)
    tmpl = ".NOISE V(OUT) V1" in page.locator("textarea.st-area").first.input_value()
    page.evaluate("window.konium.run('ad:TextEdit:SetupPreferences')"); page.wait_for_timeout(300)
    ptitle = page.locator(".prefs-page-title").inner_text() if page.locator(".prefs-page-title").count() else ""
    page.locator(".prefs").get_by_role("button", name="Cancel").click(); page.wait_for_timeout(150)
    check(f"…Tools › Show Code Templates puts a card in; Editor Preferences opens Preferences › {ptitle}", tmpl and ptitle == "Text Editors – General")
    # 26.063: SimView — a wave picked by its name dims the others (Esc clears), Edit › Cut / Insert / Paste, the plots scroll
    page.locator(".doctab", has_text="Sim Demo.sdf").first.dispatch_event("mousedown"); page.wait_for_timeout(400)
    page.locator(".sv-tab", has_text="Transient Analysis").first.click(); page.wait_for_timeout(300)
    page.locator(".sv-plotwaves li").first.click(); page.wait_for_timeout(200)
    dimmed = page.locator(".sv-plotwaves li.dim").count()
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    undimmed = page.locator(".sv-plotwaves li.dim").count()
    nw = page.locator(".sv-plotwaves li").count(); npl = page.locator(".sv-plotwaves").count()
    page.keyboard.press("Control+x"); page.wait_for_timeout(200)
    cut = page.locator(".sv-plotwaves li").count()
    for _ in range(12): page.evaluate("window.konium.run('ad:SimView:InsertCell')")
    page.keyboard.press("Control+v"); page.wait_for_timeout(300)
    pasted = page.locator(".sv-plotwaves").count()
    sp = page.evaluate("(() => { const e = document.querySelector('.sv-plot'); return [e.scrollHeight > e.clientHeight, e.scrollTop]; })()")
    page.keyboard.press("Control+End"); page.wait_for_timeout(200)
    bottom = page.evaluate("document.querySelector('.sv-plot').scrollTop")
    page.evaluate("window.konium.run('ad:SimView:ScrollVerticalTop')"); page.wait_for_timeout(150)
    topped = page.evaluate("document.querySelector('.sv-plot').scrollTop")
    check(f"SimView: Wave › Clear Filter (Esc) after a wave picked by name ({dimmed} dimmed → {undimmed}); Edit › Cut ({nw} → {cut} waves), Insert and Paste ({npl} → {pasted} plots); the plots scroll (Ctrl+End {bottom}, Vertical Top {topped})",
          dimmed >= 1 and undimmed == 0 and cut == nw - 1 and pasted >= npl + 11 and sp[0] and bottom > 0 and topped == 0)
    shot(page, "82-simview-scroll.png")
    # 26.063: EDIF — a schematic page (from the unit test's sample) and EAGLE modules
    src63 = open(os.path.join(os.path.dirname(__file__), "..", "edif63.test.ts")).read()
    edif = re.search(r"const SCH = `(.*?)`;", src63, re.S).group(1)
    page.evaluate("(t) => window.konium.openBatch([{ name: 'Test.edf', path: 'Test.edf', bytes: new TextEncoder().encode(t) }])", edif); page.wait_for_timeout(2500)
    msgs = page.evaluate("window.konium.state.messages.value.filter(m => m.doc === 'Test').map(m => m.message)")
    objs = page.evaluate("(() => { const d = window.konium.state.active.value.doc; return [window.konium.state.active.value.name, d.objects.filter(o => o.kind === 'component').map(o => o.designator + ':' + o.orient + (o.mirrored ? 'm' : ''))]; })()")
    check(f"File › Open an EDIF schematic: a project of its page and the SchLib of its cells, parts turned and mirrored as drawn ({objs}; {msgs[:1]})",
          objs[0] == "Test.SchDoc" and sorted(objs[1]) == ["R1:0", "R2:1", "R3:2m", "R4:0"] and any("1 sheet, 4 parts" in m for m in msgs) and not any("drawn otherwise" in m for m in msgs))
    shot(page, "83-edif-import.png")
    src57 = open(os.path.join(os.path.dirname(__file__), "..", "eagle57.test.ts")).read()
    lib57 = re.search(r"const LIB = `(.*?)`;", src57, re.S).group(1)
    pairs = re.findall(r"\[(\d+), '([^']+)'\]", re.search(r"const LAYERS = `<layers>\$\{(.*?)\}</layers>`;", src57, re.S).group(1))
    layers57 = "<layers>" + "".join(f'<layer number="{n}" name="{nm}" color="1" fill="1" visible="yes" active="yes"/>' for n, nm in pairs) + "</layers>"
    mod = re.search(r"const MODSCH = head\(`(.*?)`\);", src57, re.S).group(1).replace("${LIB}", lib57)
    mod = re.sub(r"\$\{W\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)\}", lambda m: f'<wire x1="{m[1]}" y1="{m[2]}" x2="{m[3]}" y2="{m[4]}" width="0.1524" layer="91"/>', mod)
    xml57 = f'<?xml version="1.0" encoding="utf-8"?>\n<eagle version="9.6.2"><drawing>{layers57}{mod}</drawing></eagle>'
    page.evaluate("(t) => window.konium.openBatch([{ name: 'M.sch', path: 'M.sch', bytes: new TextEncoder().encode(t) }])", xml57); page.wait_for_timeout(2500)
    show_panel(page, "projects")
    under = page.locator(".tree-hier", has_text="M.SchDoc").locator(".tree-children .tree-doc").all_inner_texts()
    syms = page.evaluate("window.konium.state.active.value.doc.objects.filter(o => o.kind === 'sheetsymbol').length")
    check(f"EAGLE modules: each instance's sheets under its sheet symbol ({syms} symbols; {under} under M.SchDoc)", syms == 2 and any("M DIV1.SchDoc" in t for t in under) and any("M DIV2.SchDoc" in t for t in under))
    shot(page, "84-eagle-modules.png")

    # 26.064: rigid-flex coverlay (a Layer Stack Manager layer, its Gerber file, 3D) and Advanced Rigid-Flex (regions placed, sliced, deleted)
    page.evaluate("() => { const f = window.konium.demoFiles().find(x => x.name === 'Demo.PcbDoc'); window.konium.openBatch([{ name: 'Flex64.PcbDoc', bytes: f.bytes }]); }"); page.wait_for_timeout(1500)
    page.evaluate("""() => { window.__saves = []; window.showSaveFilePicker = async (o) => ({ createWritable: async () => ({ write: async (b) => { window.__saves.push({ name: o.suggestedName, text: new TextDecoder('latin1').decode(b) }); }, close: async () => {} }) }); }""")
    ROWIDX = """(n) => [...document.querySelectorAll('.dlg.lsm .lsm-row:not(.lsm-head)')].findIndex(r => r.querySelector("input[aria-label='Layer Name']")?.value === n)"""
    def lsm_row(n): return page.locator('.dlg.lsm .lsm-row:not(.lsm-head)').nth(page.evaluate(ROWIDX, n)).locator('span').nth(2)
    def insert_coverlay(n):
        lsm_row(n).click(button='right'); page.wait_for_timeout(150)
        page.locator(".menu-popup .menu-item", has_text="Insert layer above").hover(); page.wait_for_timeout(150)
        page.locator(".menu-popup[data-depth='1'] .menu-item", has_text="Coverlay").click(); page.wait_for_timeout(150)
    page.mouse.move(700, 500)
    page.evaluate("window.konium.run('pcb.layerStackManager')"); page.wait_for_timeout(300)
    lsm = page.locator('.dlg.lsm')
    insert_coverlay('Top Layer')
    check("Layer Stack Manager › right-click › Insert layer above › Coverlay: only with a flex stack", "flex layer stack" in page.locator(".toast").last.inner_text() and page.evaluate(ROWIDX, 'Top Coverlay') < 0)
    lsm.get_by_role('button', name='Advanced >>').click(); page.wait_for_timeout(150)
    lsm.get_by_role('button', name='Add Stack').click(); page.wait_for_timeout(150)
    lsm.locator("input[aria-label='Stack name']").fill('Flex')
    lsm.locator("input[aria-label='Is Flex']").check()
    for n in ['Top Overlay', 'Top Solder', 'Bottom Solder', 'Bottom Overlay']:
        lsm.locator(f"input[aria-label='{n} in Flex']").uncheck()
    insert_coverlay('Top Layer')
    ce = lsm.locator(".lsm-row.on input[aria-label='Coverlay Expansion']"); ce.fill('10'); ce.press('Tab'); page.wait_for_timeout(100)
    check("…with one: Top Coverlay above the top copper, in the flex stack, a Coverlay Expansion", page.evaluate(ROWIDX, 'Top Coverlay') == page.evaluate(ROWIDX, 'Top Layer') - 1
          and lsm.locator("input[aria-label='Top Coverlay in Flex']").is_checked())
    shot(page, "85-coverlay-layer.png")
    lsm.locator('.dlg-foot .btn', has_text='OK').click(); page.wait_for_timeout(300)
    cov = page.evaluate(f"(() => {{ const b = {ED}.doc.board.bag; const k = b.keys().find(k => /^V9_STACK_LAYER\\d+_NAME$/.test(k) && b.get(k) === 'Top Coverlay'); return k ? [b.get(k.replace('NAME', 'LAYERID')), b.get(k.replace('NAME', 'COVERLAY_EXPANSION')), b.get(k.replace('NAME', 'DIELMATERIAL'))] : null; }})()")
    check(f"…kept in Board6: its layer id, expansion, Polyimide ({cov})", cov == [str(0x01050001), '10mil', 'Polyimide'])
    page.evaluate("window.konium.run('view.modePlanning')"); page.wait_for_timeout(300)
    fb = page.evaluate(f"(() => {{ const o = {ED}.doc.board.outline; const xs = o.map(p => p.x), ys = o.map(p => p.y); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }})()")
    FX = lambda f: fb[0] + (fb[2] - fb[0]) * f
    FY = lambda f: fb[1] + (fb[3] - fb[1]) * f
    for f in (0.40, 0.55):
        page.evaluate("window.konium.run('ad:PCB:PlaceSplitLine')"); page.wait_for_timeout(200)
        x1, y1 = page.evaluate(TO_SCREEN, [FX(f), fb[1] + 2000]); x2, y2 = page.evaluate(TO_SCREEN, [FX(f), FY(0.5)])
        page.mouse.move(x1, y1); page.mouse.click(x1, y1); page.wait_for_timeout(150)
        page.mouse.move(x2, y2); page.wait_for_timeout(150); page.mouse.click(x2, y2); page.wait_for_timeout(200)
        page.keyboard.press('Escape'); page.wait_for_timeout(100)
    x, y = page.evaluate(TO_SCREEN, [FX(0.47), FY(0.75)])
    page.mouse.dblclick(x, y); page.wait_for_timeout(300)
    d = page.locator('.dlg.board-region')
    d.locator("select[aria-label='Layer Stack']").select_option(label='Flex (flex)'); page.wait_for_timeout(100)
    check("Board Region: Custom Coverlays, on a flex stack with a coverlay", d.get_by_label('Custom Coverlays').is_enabled())
    d.locator('.dlg-foot .btn', has_text='OK').click(); page.wait_for_timeout(300)
    # A coverlay cutout drawn on the flex region: its coverlay custom, the cutout one of its shapes
    page.evaluate("window.konium.run('ad:PCB:PlaceCoverlayCutout')"); page.wait_for_timeout(200)
    for (fx, fy) in [(0.45, 0.40), (0.50, 0.40), (0.50, 0.55), (0.45, 0.55)]:
        x, y = page.evaluate(TO_SCREEN, [FX(fx), FY(fy)]); page.mouse.move(x, y); page.mouse.click(x, y); page.wait_for_timeout(120)
    page.mouse.click(x, y, button='right'); page.wait_for_timeout(300)
    page.keyboard.press('Escape'); page.wait_for_timeout(100)
    fr = page.evaluate(f"(() => {{ const r = {ED}.doc.flex.regions.find(r => r.customCoverlay); return r ? [r.coverlays.length, r.coverlays.filter(c => c.cutout).length] : null; }})()")
    check(f"Design › Place Coverlay Cutout: the region's coverlay custom, the cutout among its shapes ({fr})", fr == [2, 1])
    page.keyboard.press('End'); page.wait_for_timeout(200)
    shot(page, "86-coverlay-planning.png")
    page.mouse.move(800, 500); page.keyboard.press('3'); page.wait_for_timeout(3000)
    shot(page, "87-coverlay-3d.png")
    page.keyboard.press('2'); page.wait_for_timeout(300)
    page.mouse.move(800, 500)
    page.keyboard.press("f"); page.keyboard.press("f"); page.keyboard.press("g"); page.wait_for_timeout(300)
    page.locator(".dlg-foot .btn", has_text="OK").click(); page.wait_for_timeout(1500)
    check("Gerber Files: a GCL1 file for the coverlay", page.evaluate("window.__saves.some(s => s.text.includes('Flex64.GCL1'))"))
    page.locator(".doctab", has_text="Flex64.PcbDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(400)
    # Advanced Rigid-Flex: the Layer Stack Manager's mode; a region placed, one sliced, one deleted
    page.mouse.move(700, 500)
    page.evaluate("window.konium.run('pcb.layerStackManager')"); page.wait_for_timeout(300)
    lsm = page.locator('.dlg.lsm')
    lsm.get_by_role('button', name='Advanced >>').click(); page.wait_for_timeout(150)
    lsm.locator("select[aria-label='Rigid-Flex mode']").select_option('a')
    lsm.locator('.dlg-foot .btn', has_text='OK').click(); page.wait_for_timeout(300)
    adv = page.evaluate(f"[{ED}.doc.flex.advanced, {ED}.doc.board.bag.get('RIGIDFLEXMODE'), {ED}.doc.flex.regions.length, {ED}.allItems().filter(i => i.key.startsWith('split:')).length]")
    check(f"Layer Stack Manager › Rigid-Flex Advanced: the regions kept on their own, no split lines, RIGIDFLEXMODE in Board6 ({adv})", adv == [True, 'ADVANCED', 3, 0])
    page.evaluate("window.konium.run('ad:PCB:PlaceBoardRegion')"); page.wait_for_timeout(200)
    for (fx, fy) in [(0.60, 0.20), (0.75, 0.20), (0.75, 0.60), (0.60, 0.60)]:
        x, y = page.evaluate(TO_SCREEN, [FX(fx), FY(fy)]); page.mouse.move(x, y); page.mouse.click(x, y); page.wait_for_timeout(120)
    page.mouse.click(x, y, button='right'); page.wait_for_timeout(300)
    page.keyboard.press('Escape'); page.wait_for_timeout(100)
    regs = page.evaluate(f"{ED}.doc.flex.regions.map(r => [r.name, r.priority ?? 0])")
    check(f"Place › Board Region: a region of its own, above the others ({regs})", len(regs) == 4 and regs[3] == ['Layer Stack Region 4', 1])
    page.evaluate("window.konium.run('ad:PCB:SliceBoardRegion')"); page.wait_for_timeout(200)
    x1, y1 = page.evaluate(TO_SCREEN, [FX(0.2), fb[1] + 2000]); x2, y2 = page.evaluate(TO_SCREEN, [FX(0.2), FY(0.5)])
    page.mouse.move(x1, y1); page.mouse.click(x1, y1); page.wait_for_timeout(150)
    page.mouse.move(x2, y2); page.wait_for_timeout(150); page.mouse.click(x2, y2); page.wait_for_timeout(250)
    page.keyboard.press('Escape'); page.keyboard.press('Escape'); page.wait_for_timeout(100)
    check(f"Design › Slice Board Region: one region two ({page.evaluate(f'{ED}.doc.flex.regions.length')})", page.evaluate(f"{ED}.doc.flex.regions.length") == 5)
    x, y = page.evaluate(TO_SCREEN, [FX(0.68), FY(0.4)]); page.mouse.click(x, y); page.wait_for_timeout(200)
    grips = len(page.evaluate(f"{ED}.grips()"))
    page.keyboard.press('Delete'); page.wait_for_timeout(200)
    n = page.evaluate(f"{ED}.doc.flex.regions.length")
    page.keyboard.press('Control+z'); page.wait_for_timeout(200)
    check(f"…a region selected: a handle at each vertex ({grips}); Delete takes it, Ctrl+Z brings it back ({n} → {page.evaluate(f'{ED}.doc.flex.regions.length')})", grips == 4 and n == 4 and page.evaluate(f"{ED}.doc.flex.regions.length") == 5)
    shot(page, "88-advanced-rigid-flex.png")
    page.keyboard.press('Escape'); page.keyboard.press('2'); page.wait_for_timeout(200)

    # Help › About: what Konium is for, donationware, scrolling when long
    page.evaluate("window.konium.run('help.about')"); page.wait_for_timeout(200)
    ab = page.locator(".about-body")
    check("About: a two-way link with Altium Designer, donationware, the no-warranty notice, scrolls", "two-way link with Altium Designer" in ab.inner_text() and "donationware" in ab.inner_text()
          and 'provided "as is", without warranty' in ab.inner_text() and page.evaluate("getComputedStyle(document.querySelector('.about-body')).overflowY") == "auto")
    ab.evaluate("e => e.scrollTop = e.scrollHeight"); page.wait_for_timeout(150)
    shot(page, "65-about-warranty.png")
    page.keyboard.press("Escape")
    # File › Open: the system file selector takes every filter (Chrome refuses the call over one extension it won't take)
    page.evaluate("""() => { const real = window.showOpenFilePicker.bind(window); window.__picks = []; window.showOpenFilePicker = (o) => { const p = real(o); p.then(() => {}, (e) => window.__picks.push(e.name)); return p; }; }""")
    page.evaluate("window.konium.run('file.open')"); page.wait_for_timeout(1200)
    picks = page.evaluate("window.__picks")
    check(f"File › Open: the file selector opens with its filters, none refused ({picks})", len(picks) >= 1 and "TypeError" not in picks)
    # A pinned-off panel's slide-out: dragged wider, it stays out and keeps the width
    tab = page.locator(".strip-tab", has_text="Libraries").first
    if tab.count():
        tab.click(); page.wait_for_timeout(500)
        sl = page.locator(".dock-slide")
        w0 = sl.bounding_box()["width"]; hb = sl.locator(".dock-zone-resize").bounding_box()
        page.mouse.move(hb["x"] + 3, hb["y"] + 200); page.mouse.down(); page.mouse.move(hb["x"] - 80, hb["y"] + 200, steps=6); page.wait_for_timeout(700); page.mouse.up(); page.wait_for_timeout(300)
        w1 = sl.bounding_box()["width"] if sl.count() else 0
        check(f"Auto-hide panel: its slide-out resized by its edge ({round(w0)} → {round(w1)} px)", sl.count() == 1 and w1 > w0 + 60)
        page.mouse.click(700, 450); page.wait_for_timeout(300)
    b.close()

    # 26.090: a multi-board project — the demo as its child, a new multi-board schematic (a module placed for it) and assembly (its board inserted, in 3D)
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = b.new_page(viewport={"width": 1440, "height": 880})
    page.on("pageerror", lambda e: errors.append(f"pageerror (multi-board): {e}"))
    page.goto(URL + ("&" if "?" in URL else "?") + "debug")
    page.wait_for_function("window.konium !== undefined"); page.wait_for_timeout(500)
    page.evaluate("window.konium.prefs.set({ openHomePage: false })")
    mbo = page.evaluate("""(async () => {
      const fs = window.konium.demoFiles();
      const mk = (name, bytes) => ({ kind: 'file', name, getFile: async () => new File([bytes], name) });
      const prj = new TextEncoder().encode('[Design]\\r\\nVersion=1.0\\r\\n\\r\\n[Document1]\\r\\nDocumentPath=..\\\\Demo\\\\Demo.PrjPcb\\r\\n');
      const dir = (name, files, dirs) => ({ kind: 'directory', name, queryPermission: async () => 'granted', getDirectoryHandle: async (n) => dirs.find((d) => d.name === n),
        entries: async function* () { for (const f of files) yield [f.name, f]; for (const d of dirs) yield [d.name, d]; } });
      const demo = dir('Demo', fs.map((f) => mk(f.name, f.bytes)), []);
      const mb = dir('MB', [mk('MB.PrjMbd', prj)], []);
      const ok = await window.konium.openProjectFolder(dir('Work', [], [demo, mb]), 'MB.PrjMbd');
      return ok + ' ' + window.konium.state.projects.value.map((p) => p.name).join(', ');
    })()""")
    page.wait_for_timeout(1000)
    page.evaluate("window.konium.run('file.newMbs')"); page.wait_for_timeout(800)
    page.locator(".mbsdoc .dd-bar .btn", has_text="Place Module").click(); page.wait_for_timeout(500)
    mods = page.locator(".mbsdoc .dd-hit").count()
    side = page.locator(".mbsdoc .mbs-side").inner_text()
    check(f"Multi-board: the project opens its child project ({mbo}); File › New › Multi-board Schematic, Place Module for Demo.PrjPcb ({mods} module: {side[:40]}…)",
          mbo.startswith("true") and "MB.PrjMbd" in mbo and "Demo.PrjPcb" in mbo and mods == 1 and "1 module," in side)
    shot(page, "90-multiboard-schematic.png")
    page.evaluate("window.konium.run('file.newMba')"); page.wait_for_timeout(800)
    page.locator(".mbadoc .dd-bar .btn", has_text="Insert Board").click(); page.wait_for_timeout(2500)
    parts = page.locator(".mbadoc .mba-parts").inner_text()
    page.locator(".mbadoc .mba-parts .link").first.click(); page.wait_for_timeout(300)
    page.locator(".mbadoc .mba-moves .btn", has_text="+X").click(); page.wait_for_timeout(500)
    at = page.locator(".mbadoc .dd-props").inner_text()
    lit = page.evaluate("""(() => { const c = document.querySelector('.mbadoc canvas'); const x = document.createElement('canvas'); x.width = c.width; x.height = c.height;
      const g = x.getContext('2d'); g.drawImage(c, 0, 0); const d = g.getImageData(0, 0, x.width, x.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 4 * 9) if ((d[i] + d[i + 1] + d[i + 2]) / 3 > 75) n++; return n; })()""")
    check(f"…File › New › Multi-board Assembly, Insert Board: the child's board in 3D ({lit} board pixels), moved 5 mm along X ({at.split(chr(10))[-1] if at else ''})",
          "Demo" in parts and lit > 3000 and "At X 5" in at)
    shot(page, "90-multiboard-assembly.png")
    b.close()

    # 26.091: a harness project (made here): its wiring diagram opens, drawn; Reports › Harness Wire List from it, the layout drawing named
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = b.new_page(viewport={"width": 1440, "height": 880})
    page.on("pageerror", lambda e: errors.append(f"pageerror (harness): {e}"))
    page.goto(URL + ("&" if "?" in URL else "?") + "debug")
    page.wait_for_function("window.konium !== undefined"); page.wait_for_timeout(500)
    page.evaluate("window.konium.prefs.set({ openHomePage: false })")
    hopen = page.evaluate("""(() => {
      const enc = (s) => new TextEncoder().encode(s);
      const doc = (head, recs) => enc(['|HEADER=' + head + '|WEIGHT=' + recs.length, ...recs].join('\\r\\n') + '\\r\\n');
      const wir = doc('Harness Wiring Diagram Binary File Version 1.0', [
        '|RECORD=104|UNIQUEID=SHEETAAA',
        '|RECORD=106|LOCATION.X=100|LOCATION.Y=400|UNIQUEID=CONAAAAA',
        '|RECORD=34|OWNERINDEX=1|TEXT=P1|LOCATION.X=100|LOCATION.Y=420',
        '|RECORD=113|OWNERINDEX=1|DESIGNATOR=1|NAME=1|LOCATION.X=110|LOCATION.Y=400|PINLENGTH=10|UNIQUEID=PINA1AAA',
        '|RECORD=106|LOCATION.X=500|LOCATION.Y=400|UNIQUEID=CONBBBBB',
        '|RECORD=34|OWNERINDEX=4|TEXT=P2|LOCATION.X=500|LOCATION.Y=420',
        '|RECORD=113|OWNERINDEX=4|DESIGNATOR=1|NAME=1|LOCATION.X=490|LOCATION.Y=400|PINLENGTH=10|UNIQUEID=PINB1BBB',
        '|RECORD=108|LOCATION.X=300|LOCATION.Y=400|TEXT=SPL1|SHOWNAME=T|UNIQUEID=SPLICEAA',
        '|RECORD=107|LOCATIONCOUNT=2|X1=120|Y1=400|X2=300|Y2=400|COLOR=255|UNIQUEID=WIREONEA|ENDVERTEX1CONNECTEDOBJECTUNIQUEID=PINA1AAA|ENDVERTEX2CONNECTEDOBJECTUNIQUEID=SPLICEAA',
        '|RECORD=34|OWNERINDEX=8|TEXT=W1|LOCATION.X=200|LOCATION.Y=405',
        '|RECORD=107|LOCATIONCOUNT=2|X1=480|Y1=400|X2=300|Y2=400|COLOR=32768|UNIQUEID=WIRETWOA|ENDVERTEX1CONNECTEDOBJECTUNIQUEID=PINB1BBB|ENDVERTEX2CONNECTEDOBJECTUNIQUEID=SPLICEAA',
        '|RECORD=34|OWNERINDEX=10|TEXT=W2|LOCATION.X=400|LOCATION.Y=405',
      ]);
      const ldr = doc('Harness Layout Drawing Binary File Version 1.0', ['|RECORD=105|UNIQUEID=SHEETBBB']);
      const prj = enc('[Design]\\r\\nVersion=1.0\\r\\n\\r\\n[Document1]\\r\\nDocumentPath=Loom.WirDoc\\r\\n\\r\\n[Document2]\\r\\nDocumentPath=Loom.LdrDoc\\r\\n');
      window.konium.openBatch([{ name: 'Loom.PrjHar', bytes: prj }, { name: 'Loom.WirDoc', bytes: wir }, { name: 'Loom.LdrDoc', bytes: ldr }]);
      return window.konium.state.projects.value.map((p) => p.name).join(', ') + ' / ' + window.konium.state.docs.value.map((d) => d.name).join(', ');
    })()""")
    page.wait_for_timeout(1500)
    hdrawn = page.evaluate("""(() => { const c = document.querySelector('.editor-host canvas, canvas'); if (!c) return 0; const x = document.createElement('canvas'); x.width = c.width; x.height = c.height;
      const g = x.getContext('2d'); g.drawImage(c, 0, 0); const d = g.getImageData(0, 0, x.width, x.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90) n++; return n; })()""")
    page.evaluate("window.konium.run('reports.harnessWires')"); page.wait_for_timeout(600)
    hw = page.locator(".harness-wires")
    hrows = hw.locator("tbody tr").all_inner_texts() if hw.count() else []
    hnote = hw.locator(".hw-note").first.inner_text() if hw.count() else ""
    check(f"Harness: the project opens its wiring diagram ({hopen}), the red wire drawn ({hdrawn} px); Reports › Harness Wire List ({len(hrows)} wires: {' | '.join(r.replace(chr(9), ' ') for r in hrows)}; '{hnote}')",
          "Loom.PrjHar" in hopen and "Loom.WirDoc" in hopen and hdrawn > 20 and len(hrows) == 2 and "P1-1" in hrows[0] and "SPL1" in hrows[0] and "P2-1" in hrows[1] and "Loom.LdrDoc" in hnote)
    shot(page, "91-harness-wire-list.png")
    b.close()

    # 26.094: a diagram (.drawio) in the demo project — its sheets as linked blocks, a shape placed, joined, labelled and moved; a block opens its sheet; saved as draw.io's XML
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = b.new_page(viewport={"width": 1440, "height": 880})
    page.on("pageerror", lambda e: errors.append(f"pageerror (diagram): {e}"))
    page.goto(URL + ("&" if "?" in URL else "?") + "debug")
    page.wait_for_function("window.konium !== undefined"); page.wait_for_timeout(500)
    page.evaluate("window.konium.prefs.set({ openHomePage: false })")
    page.evaluate("""() => { window.__saves = []; window.showSaveFilePicker = async (o) => ({ createWritable: async () => ({ write: async (b) => { window.__saves.push({ name: o.suggestedName, text: new TextDecoder().decode(b) }); }, close: async () => {} }) }); }""")
    page.evaluate("window.konium.run('file.openDemo')"); page.wait_for_timeout(2500)
    page.locator(".menubar-item", has_text="File").first.click(); page.wait_for_timeout(200)
    page.locator(".menu-popup .menu-item", has_text="New").first.hover(); page.wait_for_timeout(300)
    newmenu = page.locator(".menu-popup").last.inner_text()
    page.locator(".menu-popup").last.locator(".menu-item", has_text="Diagram").first.click(); page.wait_for_timeout(800)
    dg = page.locator(".diagram")
    dg.locator(".btn", has_text="Add Project Sheets").click(); page.wait_for_timeout(600)
    linked = page.evaluate("window.konium.state.active.value.doc.pages[0].model.kids.length >= 0") and dg.locator(".dg-cell.linked").count()
    conns0 = dg.locator(".dg-pages").inner_text()
    # The Ellipse dragged from the Shapes panel onto the page
    box = dg.locator(".dg-svg").bounding_box()
    it = dg.locator('.dg-lib-item[data-shape="Ellipse"]').first.bounding_box()
    page.mouse.move(it["x"] + it["width"] / 2, it["y"] + it["height"] / 2); page.mouse.down()
    page.mouse.move(box["x"] + 200, box["y"] + 430, steps=10); page.mouse.up(); page.wait_for_timeout(300)
    # Its top connection point dragged to the Demo block
    dot = dg.locator(".dg-connect").first.bounding_box()
    demo = dg.locator(".dg-cell.linked", has_text="Demo").first.bounding_box()
    page.mouse.move(dot["x"] + dot["width"] / 2, dot["y"] + dot["height"] / 2); page.mouse.down()
    page.mouse.move(demo["x"] + demo["width"] / 2, demo["y"] + demo["height"] / 2, steps=8); page.mouse.up(); page.wait_for_timeout(300)
    conns1 = dg.locator(".dg-pages").inner_text()
    # The ellipse labelled (double-click, type) and nudged with the arrow keys
    ell = dg.locator('.dg-cell[data-shape="ellipse"]').first.bounding_box()
    page.mouse.dblclick(ell["x"] + ell["width"] / 2, ell["y"] + ell["height"] / 2); page.wait_for_timeout(300)
    page.keyboard.type("Power In"); page.keyboard.press("Control+Enter"); page.wait_for_timeout(200)
    page.mouse.click(ell["x"] + ell["width"] / 2, ell["y"] + ell["height"] / 2); page.wait_for_timeout(200)
    page.keyboard.press("Shift+ArrowRight"); page.keyboard.press("Shift+ArrowRight"); page.wait_for_timeout(200)
    ell2 = dg.locator('.dg-cell[data-shape="ellipse"]').first.bounding_box()
    label = dg.locator(".dg-cell", has_text="Power In").count()
    check(f"File › New › Diagram ({'Diagram' in newmenu}): Add Project Sheets — the demo's sheets as blocks linked to them ({linked}), joined as the hierarchy goes ({conns0.split('·')[0].strip()}); an ellipse dragged from the Shapes panel, joined to Demo by dragging its blue dot ({conns1.split('·')[0].strip()}), labelled 'Power In', nudged right ({round(ell2['x'] - ell['x'])} px)",
          "Diagram" in newmenu and linked == 3 and "3 shapes, 1 connectors" in conns0 and "4 shapes, 2 connectors" in conns1 and label == 1 and ell2["x"] - ell["x"] > 10)
    shot(page, "94-diagram.png")
    # Ctrl+click on the Child block: its sheet in front
    ch = dg.locator(".dg-cell.linked", has_text="Child").first.bounding_box()
    page.keyboard.down("Control"); page.mouse.click(ch["x"] + ch["width"] / 2, ch["y"] + ch["height"] / 2); page.keyboard.up("Control"); page.wait_for_timeout(800)
    front = page.locator(".doctab.on").inner_text()
    page.locator(".doctab", has_text="Diagram1.DgmDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(400)
    page.evaluate("window.konium.run('file.save')"); page.wait_for_timeout(800)
    xml = page.evaluate("(window.__saves.find((s) => s.name === 'Diagram1.DgmDoc') || {}).text || ''")
    ellx = """(() => { const d = window.konium.state.active.value.doc; const el = (n) => n.kids.filter((k) => typeof k !== 'string'); const root = el(d.pages[0].model).find((k) => k.name === 'root');
      const c = el(root).find((k) => k.name === 'mxCell' && ((k.attrs.find((a) => a[0] === 'style') || [])[1] || '').startsWith('ellipse')); const g = el(c).find((k) => k.name === 'mxGeometry'); return Number(g.attrs.find((a) => a[0] === 'x')[1]); })()"""
    x1 = page.evaluate(ellx)
    page.locator(".diagram .dg-host").focus(); page.keyboard.press("Control+z"); page.wait_for_timeout(200)
    x0 = page.evaluate(ellx)
    check(f"…Ctrl+click on a linked block opens its sheet ({front.strip()}); saved as draw.io's XML (mxfile, the link a property, the ellipse's label); Ctrl+Z undoes a nudge ({x1} → {x0})",
          "Child.SchDoc" in front and xml.startswith("<mxfile") and 'koniumSheet="Child.SchDoc"' in xml and "Power In" in xml and "ellipse;" in xml and x1 - x0 == 10)
    # 26.117 (Diagrams D1): the Shapes panel's search; a shape clicked there joins the selected one; a quick style; the Format panel's tabs
    ell = dg.locator('.dg-cell[data-shape="ellipse"]').first.bounding_box()
    page.mouse.click(ell["x"] + ell["width"] / 2, ell["y"] + ell["height"] / 2); page.wait_for_timeout(200)
    dg.locator(".dg-search").fill("cloud"); page.wait_for_timeout(200)
    found = dg.locator(".dg-lib-item").count()
    dg.locator('.dg-lib-item[data-shape="Cloud"]').first.click(); page.wait_for_timeout(300)
    conns2 = dg.locator(".dg-pages").inner_text()
    dg.locator(".dg-quick").nth(2).click(); page.wait_for_timeout(200)
    tabs = dg.locator(".dg-tab").all_inner_texts()
    cloud = page.evaluate("""(() => { const d = window.konium.state.active.value.doc; const el = (n) => n.kids.filter((k) => typeof k !== 'string'); const root = el(d.pages[0].model).find((k) => k.name === 'root');
      const c = el(root).find((k) => k.name === 'mxCell' && /shape=cloud/.test(((k.attrs.find((a) => a[0] === 'style') || [])[1] || ''))); return c ? (c.attrs.find((a) => a[0] === 'style') || [])[1] : ''; })()""")
    dg.locator(".dg-search").fill("")
    check(f"Diagrams D1: Search shapes finds the cloud ({found}); clicked with the ellipse selected, it is added joined to it ({conns2.split('·')[0].strip()}); a quick style colours it; Format tabs {tabs}",
          found >= 1 and "5 shapes, 3 connectors" in conns2 and "fillColor=#dae8fc" in cloud and tabs == ["Style", "Text", "Arrange"])
    # 26.118 (Diagrams D2): a selected shape's hover arrow clicked: a joined copy; Ctrl+C, Ctrl+V; the turning handle; the Layers window
    rot = dg.locator(".dg-rotate").count()
    arr = dg.locator(".dg-connect").nth(1).bounding_box()
    page.mouse.click(arr["x"] + arr["width"] / 2, arr["y"] + arr["height"] / 2); page.wait_for_timeout(300)
    conns3 = dg.locator(".dg-pages").inner_text()
    page.locator(".diagram .dg-host").focus(); page.keyboard.press("Control+c"); page.keyboard.press("Control+v"); page.wait_for_timeout(300)
    conns4 = dg.locator(".dg-pages").inner_text()
    page.keyboard.press("Control+Shift+l"); page.wait_for_timeout(200)
    lay = dg.locator(".dg-layers").inner_text() if dg.locator(".dg-layers").count() else ""
    check(f"Diagrams D2: the turning handle ({rot}); a hover arrow clicked, a copy joined to it ({conns3.split('·')[0].strip()}); Ctrl+C, Ctrl+V ({conns4.split('·')[0].strip()}); Ctrl+Shift+L, the Layers window",
          rot == 1 and "6 shapes, 4 connectors" in conns3 and "7 shapes, 4 connectors" in conns4 and "Background" in lay)
    # 26.119 (Diagrams D3): a connector picked shows its ends; its end dragged onto another block connects it there
    page.keyboard.press("Control+Shift+l"); page.wait_for_timeout(150)
    e0 = dg.locator('.dg-cell[data-shape="edge"]').first.bounding_box()
    page.mouse.click(e0["x"] + e0["width"] / 2, e0["y"] + e0["height"] / 2); page.wait_for_timeout(200)
    ends = dg.locator(".dg-end").count()
    end = dg.locator(".dg-end").nth(1).bounding_box()
    demo = dg.locator(".dg-cell.linked", has_text="Demo").first.bounding_box()
    page.mouse.move(end["x"] + end["width"] / 2, end["y"] + end["height"] / 2); page.mouse.down()
    page.mouse.move(demo["x"] + demo["width"] / 2, demo["y"] + demo["height"] / 2, steps=8); page.mouse.up(); page.wait_for_timeout(300)
    ends_at = page.evaluate("""(() => { const d = window.konium.state.active.value.doc; const el = (n) => n.kids.filter((k) => typeof k !== 'string'); const root = el(d.pages[0].model).find((k) => k.name === 'root');
      const a = (k, n) => (k.attrs.find((x) => x[0] === n) || [])[1]; const lab = {}; for (const k of el(root)) if (k.name === 'UserObject') lab[a(k, 'id')] = a(k, 'label');
      return el(root).filter((k) => k.name === 'mxCell' && a(k, 'edge') === '1').map((k) => (lab[a(k, 'source')] || '?') + '>' + (lab[a(k, 'target')] || '?')); })()""")
    check(f"Diagrams D3: a picked connector's two ends ({ends}); its end dragged from Child onto Demo reconnects it ({ends_at})",
          ends == 2 and "Symbols>Demo" in ends_at and "Symbols>Child" not in ends_at)
    # 26.121 (Diagrams D5): the diagram's own menus in the menu bar; Extras › Export as › SVG (nothing picked: the whole page)
    page.locator(".diagram .dg-host").focus(); page.keyboard.press("Control+Shift+a"); page.wait_for_timeout(150)
    bar = page.locator(".menubar-item").all_inner_texts()
    page.locator(".menubar-item", has_text="Extras").first.click(); page.wait_for_timeout(200)
    page.locator(".menu-popup .menu-item", has_text="Export as").first.hover(); page.wait_for_timeout(300)
    page.locator(".menu-popup").last.locator(".menu-item", has_text="SVG").first.click(); page.wait_for_timeout(300)
    page.locator(".dlg .btn.default").click(); page.wait_for_timeout(800)
    svg = page.evaluate("(window.__saves.find((s) => s.name === 'Diagram1.svg') || {}).text || ''")
    check(f"Diagrams D5: Edit, Arrange and Extras in the menu bar ({bar}); Extras › Export as › SVG saves the page as SVG ({len(svg)} bytes)",
          all(x in bar for x in ["Edit", "Arrange", "Extras"]) and svg.startswith("<?xml") and "<svg" in svg and "Demo" in svg and "dg-handle" not in svg)
    # 26.122 (Diagrams D6): the Electrical library; Extras › Export as › Visio Drawing (.vsdx)
    el = dg.locator('.dg-lib-item[data-shape="Resistor"]').count()
    page.locator(".menubar-item", has_text="Extras").first.click(); page.wait_for_timeout(200)
    page.locator(".menu-popup .menu-item", has_text="Export as").first.hover(); page.wait_for_timeout(300)
    page.locator(".menu-popup").last.locator(".menu-item", has_text="Visio Drawing").first.click(); page.wait_for_timeout(800)
    vs = page.evaluate("(window.__saves.find((s) => s.name === 'Diagram1.vsdx') || {}).text || ''")
    check(f"Diagrams D6: the Electrical library's Resistor ({el}); Extras › Export as › Visio Drawing saves a .vsdx ({len(vs)} bytes)",
          el == 1 and vs.startswith("PK") and "visio/pages/page1.xml" in vs and "<Connect " in vs)
    b.close()

    # 26.095: ActiveRoute's Route Guide on the demo board — a net's routing taken up, a component's connections routed along a guide drawn with a bend; Pin Swapping in the panel
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = b.new_page(viewport={"width": 1440, "height": 880})
    page.on("pageerror", lambda e: errors.append(f"pageerror (route guide): {e}"))
    page.goto(URL + ("&" if "?" in URL else "?") + "debug")
    page.wait_for_function("window.konium !== undefined"); page.wait_for_timeout(500)
    page.evaluate("window.konium.prefs.set({ openHomePage: false })")
    page.evaluate("window.konium.run('file.openDemo')"); page.wait_for_timeout(2500)
    page.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(1200)
    # +3V3's routing taken up (Delete), then C2 picked: its +3V3 pad and U1's, unrouted
    ends = page.evaluate(f"""(() => {{ const ed = {ED}, d = ed.doc; const net = d.nets.findIndex((n) => n.name === '+3V3');
      ed.selectWhere((t) => (t.kind === 'track' || t.kind === 'via' || t.kind === 'arc') && t.net === net);
      window.konium.run('edit.delete');
      const ci = d.components.findIndex((c) => c.designator === 'C2');
      const pads = d.prims.filter((p) => p.kind === 'pad' && p.net === net);
      const a = pads.find((p) => p.component === ci), other = pads.find((p) => p.component !== ci);
      if (!a || !other || d.prims.some((t) => t.kind === 'track' && t.net === net)) return null;
      ed.selectComponent(ci);
      return [a.at.x, a.at.y, other.at.x, other.at.y, net, '+3V3']; }})()""")
    page.evaluate("window.konium.run('view.panel.activeRoute')"); page.wait_for_timeout(300)
    panel = page.locator(".activeroute").inner_text() if page.locator(".activeroute").count() else ""
    routed = ""
    if ends:
        ax, ay, bx, by, net, nname = ends
        mx, my = (ax + bx) / 2, (ay + by) / 2
        L = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5 or 1
        off = 3 * 1e7 / 25.4   # 3 mm to one side
        bend = [mx - (by - ay) / L * off, my + (bx - ax) / L * off]
        tracks0 = page.evaluate(f"{ED}.doc.prims.filter((t) => t.kind === 'track' && t.net === {net}).length")
        page.locator(".activeroute .btn", has_text="Route Guide").click(); page.wait_for_timeout(200)
        for wx, wy in [(ax, ay), bend, (bx, by)]:
            sx, sy = page.evaluate(TO_SCREEN, [wx, wy]); page.mouse.click(sx, sy); page.wait_for_timeout(120)
        sx, sy = page.evaluate(TO_SCREEN, [bx, by]); page.mouse.click(sx, sy, button="right"); page.wait_for_timeout(3000)
        tracks1 = page.evaluate(f"{ED}.doc.prims.filter((t) => t.kind === 'track' && t.net === {net}).length")
        msg = page.evaluate("window.konium.state.messages.value.filter((m) => m.source === 'ActiveRoute').map((m) => m.message).join(' | ')")
        routed = f"{nname}: {tracks0} → {tracks1} tracks; {msg[:120]}"
    check(f"PCB ActiveRoute › Route Guide: +3V3 taken up, C2's connections routed along a guide drawn with a bend ({routed}); Pin Swapping offered",
          ends is not None and "Pin Swap Routing" in panel and "Route Guide" in panel and "tracks;" in routed and int(routed.split(" → ")[1].split(" ")[0]) > int(routed.split(": ")[1].split(" → ")[0]) and "routed, 0 connections not completed" in routed)
    shot(page, "95-route-guide.png")
    b.close()

    # 26.096: the enclosure designer — File › New › Enclosure for the demo board: the box in 3D, an opening added, STL and STEP exported
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = b.new_page(viewport={"width": 1440, "height": 880})
    page.on("pageerror", lambda e: errors.append(f"pageerror (enclosure): {e}"))
    page.goto(URL + ("&" if "?" in URL else "?") + "debug")
    page.wait_for_function("window.konium !== undefined"); page.wait_for_timeout(500)
    page.evaluate("window.konium.prefs.set({ openHomePage: false })")
    # 26.127: with no board open, File › New › Enclosure stays on and asks for a PCB document (the picker cancelled here: nothing made, no error)
    page.evaluate("() => { window.showOpenFilePicker = async () => { window.__boardAsked = true; throw new DOMException('The user aborted a request.', 'AbortError'); }; }")
    page.locator(".menubar-item", has_text="File").first.click(); page.wait_for_timeout(300)
    page.locator(".menu-item", has_text="New").first.hover(); page.wait_for_timeout(400)
    ecls = page.locator(".menu-item", has_text="Enclosure").first.get_attribute("class") or ""
    page.locator(".menu-item", has_text="Enclosure").first.click(); page.wait_for_timeout(800)
    asked = page.evaluate("!!window.__boardAsked")
    check(f"File › New › Enclosure with no board open: on ({ecls}), asks for a PCB document ({asked}); cancelled, nothing made",
          "disabled" not in ecls and "planned" not in ecls and asked and page.locator(".doctab", has_text=".Enclosure").count() == 0 and not any("error" in (x.get_attribute("class") or "") for x in page.locator(".toast").all()))
    page.evaluate("""() => { window.__saves = []; window.showSaveFilePicker = async (o) => ({ createWritable: async () => ({ write: async (b) => { const u = b instanceof Uint8Array ? b : new Uint8Array(b); window.__saves.push({ name: o.suggestedName, size: u.length, head: new TextDecoder('latin1').decode(u.subarray(0, 4000)), text: u.length < 3e6 ? new TextDecoder('latin1').decode(u) : '' }); }, close: async () => {} }) }); }""")
    page.evaluate("window.konium.run('file.openDemo')"); page.wait_for_timeout(2500)
    page.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(1200)
    page.evaluate("window.konium.run('file.newEnclosure')"); page.wait_for_timeout(2500)
    enc = page.locator(".enclosure")
    info = enc.locator(".ex-facts").first.inner_text() if enc.count() else ""
    ED_DOC = ED.replace('editor', 'doc')
    def tool(name):
        enc.locator(".ex-tool", has_text=name).first.click(); page.wait_for_timeout(250)
    def face(name):
        enc.locator(".encf-faces button", has_text=name).first.click(); page.wait_for_timeout(300)
    def click_face(fx=0.5, fy=0.5):
        sv = enc.locator(".encf-svg").bounding_box()
        page.mouse.click(sv["x"] + sv["width"] * fx, sv["y"] + sv["height"] * fy); page.wait_for_timeout(900)
    def export(kind):
        enc.locator(".ex-export").click(); page.wait_for_timeout(300)
        page.locator(".menu-item", has_text=kind).first.click(); page.wait_for_timeout(1500)
    # 26.128: the workspace: tools down the left, a cut-out put on the front face by clicking the face view
    tool("Cut-out"); face("Front"); click_face(0.5, 0.45); page.keyboard.press("Escape"); page.wait_for_timeout(300)
    lit = page.evaluate("""(() => { const c = document.querySelector('.enclosure canvas'); if (!c) return 0; const x = document.createElement('canvas'); x.width = c.width; x.height = c.height;
      const g = x.getContext('2d'); g.drawImage(c, 0, 0); const d = g.getImageData(0, 0, x.width, x.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 4 * 9) if ((d[i] + d[i + 1] + d[i + 2]) / 3 > 150) n++; return n; })()""")
    ops = page.evaluate(f"JSON.stringify({ED_DOC}.spec.openings.map((o) => [o.name, o.face, o.shape]))")
    check(f"File › New › Enclosure: the demo board's box in 3D ({lit} light pixels; {info[:60]}), the Cut-out tool puts one on the front face ({ops}), listed under Added ({enc.locator('.ex-feat-list').nth(1).locator('.ex-feat').count()})",
          enc.count() == 1 and "46.0 × 31.0" in info and lit > 3000 and ops == '[["Cut-out 1","S","rounded"]]' and enc.locator(".ex-feat-list").nth(1).locator(".ex-feat").count() == 1)
    shot(page, "96-enclosure.png")
    # The face view: the top face, a hole put there with the Hole tool and dragged 4 mm across with Select
    face("Top"); tool("Hole"); click_face(0.5, 0.5); page.keyboard.press("Escape"); page.wait_for_timeout(300)
    h0 = page.evaluate(f"JSON.stringify({ED_DOC}.spec.openings.filter((o) => o.face === 'top').map((o) => [o.shape, o.x, o.y]))")
    sv = page.evaluate("(() => { const s = document.querySelector('.encf-svg'), r = s.getBoundingClientRect(), v = s.viewBox.baseVal; return Math.min(r.width / v.width, r.height / v.height); })()")
    ob = enc.locator(".encf-open path").first.bounding_box()
    if ob:
        page.mouse.move(ob["x"] + ob["width"] / 2, ob["y"] + ob["height"] / 2); page.mouse.down(); page.mouse.move(ob["x"] + ob["width"] / 2 + 4 * sv, ob["y"] + ob["height"] / 2, steps=5); page.mouse.up(); page.wait_for_timeout(900)
    h1 = page.evaluate(f"JSON.stringify({ED_DOC}.spec.openings.filter((o) => o.face === 'top').map((o) => [o.shape, o.x, o.y]))")
    import json as _json
    a0, a1 = (_json.loads(h0) or [[None, 0, 0]])[0], (_json.loads(h1) or [[None, 0, 0]])[0]
    check(f"…the face view: the Hole tool on the top ({h0}), dragged 4 mm across ({h1}); its Properties", a0[0] == "circle" and a1[0] == "circle" and abs(a1[1] - a0[1] - 4) < 1e-6 and a1[2] == a0[2]
          and enc.locator(".ex-panel-head", has_text="Hole").count() == 1)
    # Protrusions (26.128): a boss inside the floor from the face view; Duplicate, and Repeat (three more)
    face("Bottom"); tool("Boss"); click_face(0.62, 0.5); page.keyboard.press("Escape"); page.wait_for_timeout(300)
    enc.locator(".ex-act", has_text="Duplicate").click(); page.wait_for_timeout(600)
    enc.locator(".ex-act", has_text="Repeat").click(); page.wait_for_timeout(300)
    enc.locator(".ex-make").click(); page.wait_for_timeout(1500)
    adds = page.evaluate(f"JSON.stringify({ED_DOC}.spec.adds.map((a) => [a.kind, a.face, a.side]))")
    check(f"…protrusions: a boss inside the floor, duplicated and repeated ({adds})", adds == _json.dumps([["boss", "bottom", "in"]] * 5).replace(" ", ""))
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    # 26.129: a tool's feature follows the pointer, and a click on a feature already there (the cut-out) puts it there too
    face("Front"); tool("Pin")
    ob = enc.locator(".encf-open path").first.bounding_box()
    ghost = 0
    if ob:
        page.mouse.move(ob["x"] + ob["width"] / 2 - 4, ob["y"] + ob["height"] / 2); page.mouse.move(ob["x"] + ob["width"] / 2, ob["y"] + ob["height"] / 2, steps=3); page.wait_for_timeout(300)
        ghost = enc.locator(".encf-ghost").count()
        page.mouse.click(ob["x"] + ob["width"] / 2, ob["y"] + ob["height"] / 2); page.wait_for_timeout(900)
    pins = page.evaluate(f"JSON.stringify({ED_DOC}.spec.adds.filter((a) => a.kind === 'pin').map((a) => [a.face, a.side]))")
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    # Display scaling: at 150 % the 3D view's picture is laid out at the view's size (it overflowed, so clicks missed what it showed)
    cdp = page.context.new_cdp_session(page)
    cdp.send("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 880, "deviceScaleFactor": 1.5, "mobile": False})
    fv = enc.locator("button[aria-label^='The face view']"); fv.click(); page.wait_for_timeout(900)
    fit = page.evaluate("(() => { const h = document.querySelector('.enc-3d .modelview'), c = h && h.querySelector('canvas'); if (!c) return '0,0,0,0,0,0'; const a = h.getBoundingClientRect(), b = c.getBoundingClientRect(); return [a.width, a.height, b.width, b.height, c.width, c.height].map(Math.round).join(','); })()")
    fv.click(); page.wait_for_timeout(600)
    cdp.send("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 880, "deviceScaleFactor": 1, "mobile": False}); page.wait_for_timeout(600)
    fw = [int(x) for x in fit.split(",")]
    check(f"…a tool's feature shown under the pointer ({ghost}) and put on the cut-out ({pins}); at 150 % display scaling the 3D picture fits its view ({fit})",
          ghost == 1 and pins == '[["S","in"]]' and fw[0] > 0 and fw[0] == fw[2] and fw[1] == fw[3] and abs(fw[4] - 1.5 * fw[0]) <= 1)
    # 26.130: the parts' colours and finishes; Export › Picture: a room's colour, a lighting set-up, no background, a size; saved as a PNG
    if enc.locator("button[aria-label='Back to the box']").count(): enc.locator("button[aria-label='Back to the box']").click(); page.wait_for_timeout(300)
    enc.locator("button[aria-label='Base colour']").click(); page.wait_for_timeout(200)
    enc.locator(".ex-palette button[aria-label='Teal']").click(); page.wait_for_timeout(200)
    enc.locator("select[aria-label='Top finish']").select_option("gloss"); page.wait_for_timeout(1200)
    looks = page.evaluate(f"JSON.stringify({ED_DOC}.spec.looks.base) + JSON.stringify({ED_DOC}.spec.looks.top.finish)")
    export("Picture")
    pic_open = page.locator(".encpic").count()
    page.locator(".encpic-rooms button[aria-label='Navy']").click(); page.wait_for_timeout(200)
    page.locator(".encpic [aria-label='Lighting set-up'] button", has_text="Soft").click(); page.wait_for_timeout(200)
    page.locator(".encpic [aria-label='Background'] button", has_text="None").click(); page.wait_for_timeout(200)
    page.locator(".encpic select[aria-label='Size']").select_option("web"); page.wait_for_timeout(3000)
    shown = page.evaluate("(() => { const i = document.querySelector('.encpic-preview img'); return i && i.complete ? [i.naturalWidth, i.naturalHeight] : [0, 0]; })()")
    page.locator(".encpic button.default").click(); page.wait_for_timeout(8000)
    png = page.evaluate("(() => { const s = window.__saves.find((x) => x.name.endsWith('.png')); if (!s) return null; const h = s.head; const n = (i) => ((h.charCodeAt(i) << 24) | (h.charCodeAt(i + 1) << 16) | (h.charCodeAt(i + 2) << 8) | h.charCodeAt(i + 3)) >>> 0; return [s.name, h.slice(1, 4), n(16), n(20), h.charCodeAt(25), s.size]; })()")
    scene = page.evaluate(f"JSON.stringify({ED_DOC}.spec.scene)")
    check(f"…colours and finishes ({looks}); Export › Picture ({pic_open} dialog, preview {shown}): a navy room, soft light, no background, 1200 × 800, saved as a PNG ({png}); the scene kept ({scene})",
          looks == '{"colour":"#00808a","finish":"satin"}"gloss"' and pic_open == 1 and shown[0] > 100 and png is not None and png[0] == "Demo1.png" and png[1] == "PNG" and png[2] == 1200 and png[3] == 800 and png[4] == 6
          and '"env":"#1c2b45"' in scene and '"background":"none"' in scene and '"ambient":1.6' in scene and page.locator(".encpic").count() == 0)
    export("STL"); export("STEP")
    saves = page.evaluate("window.__saves.map((s) => [s.name, s.size, s.head.slice(0, 40), (s.text.match(/FACETED_BREP\\(/g) || []).length, /Demo1 Base/.test(s.text), /Demo1 Top/.test(s.text), /PRODUCT\\('Demo'/.test(s.text)])")
    stl = next((x for x in saves if x[0].endswith(".stl")), None); stp = next((x for x in saves if x[0].endswith(".step")), None)
    page.evaluate("window.konium.run('file.save')"); page.wait_for_timeout(600)
    js = page.evaluate("(window.__saves.find((s) => s.name === 'Demo1.Enclosure') || {}).text || ''")
    check(f"…Export › STL (base and top in one file, {stl[1] if stl else 0} bytes) and STEP (base, top and the board in place: {stp[3] if stp else 0} faceted solids); saved as JSON",
          stl is not None and stl[2].startswith("Konium Designer STL") and (stl[1] - 84) % 50 == 0 and stl[1] > 20000 and stp is not None and stp[3] >= 2 and stp[4] and stp[5] and stp[6]
          and js.startswith('{\n  "koniumEnclosure": 2') and '"board": "Demo.PcbDoc"' in js and '"name": "Cut-out 1"' in js)
    # 26.125: a logo from a drawing on the top (the file picker stood in for), cut through; a pocket; a printed gasket in a groove round the rim, in the 3MF
    mark = '<svg xmlns="http://www.w3.org/2000/svg" width="12mm" height="8mm" viewBox="0 0 12 8"><rect width="12" height="8" fill="#fff"/><path d="M0 8L6 0L12 8Z"/><circle cx="6" cy="5" r="1.5" fill="white"/></svg>'
    page.evaluate("""(svg) => { window.showOpenFilePicker = async () => [{ kind: 'file', name: 'Mark.svg', getFile: async () => new File([svg], 'Mark.svg', { type: 'image/svg+xml' }) }]; }""", mark)
    face("Top"); tool("Logo"); click_face(0.35, 0.5); page.wait_for_timeout(1500)
    enc.locator("[role=radiogroup][aria-label='How'] button", has_text="Through").click(); page.wait_for_timeout(1200)
    drawn = enc.locator(".encf-label.through .encf-logo").count()
    enc.locator(".ex-feat", has_text="Cut-out 1").click(); page.wait_for_timeout(300)
    enc.locator("input[aria-label='Depth']").fill("0.6"); enc.locator("input[aria-label='Depth']").press("Tab"); page.wait_for_timeout(1200)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    enc.locator("input[aria-label='Wall']").fill("4.5"); enc.locator("input[aria-label='Wall']").press("Tab"); page.wait_for_timeout(800)
    enc.locator("[role=radiogroup][aria-label='Fixing'] button", has_text="Screws").click(); page.wait_for_timeout(800)
    enc.locator("select[aria-label='Seal']").select_option("gasket"); page.wait_for_timeout(2500)
    sp = page.evaluate(f"(() => {{ const s = {ED_DOC}.spec, l = s.labels.at(-1) || {{}}; return [l.text, !!l.logo, l.logo ? l.logo.shapes.map((x) => x.knock ? 'w' : 'd').join('') : '', !!l.through, s.openings[0] && s.openings[0].depth, s.seal.kind]; }})()")
    esum = enc.locator(".enc-sum").inner_text() if enc.locator(".enc-sum").count() else ""
    enotes = " | ".join(enc.locator(".enc-note").all_inner_texts())
    export("3MF")
    tmf = page.evaluate("(window.__saves.find((s) => s.name.endsWith('.3mf')) || {}).text || ''")
    check(f"…a logo from a drawing on the top, cut through ({sp}, {drawn} shapes drawn), a pocket, a printed gasket ({esum[-40:]!r}); its 3MF object",
          sp[:4] == ["Mark", True, "dw", True] and sp[4] == 0.6 and sp[5] == "gasket" and drawn == 2 and "a gasket" in esum and "The gasket: print it in TPU" in enotes and "is cut through" in enotes and 'name="Demo1 Gasket"' in tmf)
    check("…the 3MF in the parts' colours (the base teal, as picked)", 'name="Demo1 Base" displaycolor="#00808AFF"' in tmf)
    shot(page, "125-enclosure-e5.png")
    b.close()

    # The release's stage (26.097 on; 26.098 R2) — features of later releases shown as planned: greyed in the menus, their documents not shown, their controls disabled; this release's on
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = b.new_page(viewport={"width": 1440, "height": 880})
    page.on("pageerror", lambda e: errors.append(f"pageerror (planned features): {e}"))
    page.goto(URL.replace("&features=all", ""))
    page.wait_for_function("window.konium !== undefined"); page.wait_for_timeout(500)
    page.evaluate("window.konium.prefs.set({ openHomePage: false })")
    page.evaluate("window.konium.run('file.openDemo')"); page.wait_for_timeout(2500)
    page.locator(".doctab", has_text="Demo.SchDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(600)
    page.locator(".menubar-item", has_text="File").first.click(); page.wait_for_timeout(200)
    page.locator(".menu-popup .menu-item", has_text="New").first.hover(); page.wait_for_timeout(300)
    nm = page.locator(".menu-popup").last
    planned = sorted(set(x.split("\n")[0].strip() for x in nm.locator(".menu-item.planned").all_inner_texts()))
    tags = nm.locator(".menu-planned").count()
    draftsman = nm.locator(".menu-item", has_text="Draftsman").first.get_attribute("class") or ""
    mbs = nm.locator(".menu-item", has_text="Multi-board Schematic").first.get_attribute("class") or ""
    shot(page, "97-planned-menu.png")
    diagram_cls = nm.locator(".menu-item", has_text="Diagram").first.get_attribute("class") or ""
    enc_cls = nm.locator(".menu-item", has_text="Enclosure").first.get_attribute("class") or ""
    nm.locator(".menu-item", has_text="Enclosure").first.click(); page.wait_for_timeout(3000)
    toast = " ".join(page.locator(".toast").all_inner_texts())
    enc_tabs = page.locator(".doctab", has_text=".Enclosure").count()
    enc_view = page.locator(".enclosure").count()
    page.locator(".menubar-item", has_text="File").first.click(); page.wait_for_timeout(200)
    page.locator(".menu-popup .menu-item", has_text="New").first.hover(); page.wait_for_timeout(300)
    nm = page.locator(".menu-popup").last
    req_cls = nm.locator(".menu-item", has_text="Requirements").first.get_attribute("class") or ""
    nm.locator(".menu-item", has_text="Requirements").first.click(); page.wait_for_timeout(800)
    toast += " " + " ".join(page.locator(".toast").all_inner_texts())
    req_tabs = page.locator(".doctab", has_text=".ReqDoc").count()
    page.evaluate("window.konium.dock.showPanel('requirements')"); page.wait_for_timeout(500)
    req_panel = page.locator("section.reqp").count()
    page.locator(".menubar-item", has_text="File").first.click(); page.wait_for_timeout(200)
    vc_cls = page.locator(".menu-popup .menu-item", has_text="Open Project from Version Control").first.get_attribute("class") or ""
    page.keyboard.press("Escape")
    page.evaluate("window.konium.run('help.about')"); page.wait_for_timeout(300)
    about_rows = page.locator(".about-net tbody tr").count()
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    check(f"Release stage (R8, 26.146): version control on: File › Open Project from Version Control not planned ({'planned' not in vc_cls}); About lists its connection ({about_rows})", "planned" not in vc_cls and about_rows == 16)
    check(f"Release stage (R8, 26.146): nothing in File › New greyed as planned ({planned}, {tags} tags); Diagram, Draftsman, Multi-board Schematic, Enclosure and Requirements on; File › New › Enclosure and › Requirements make one each ({enc_tabs}, {req_tabs}); the Requirements panel opens ({req_panel})",
          planned == [] and tags == 0 and "planned" not in diagram_cls and "planned" not in enc_cls and "planned" not in req_cls
          and "planned" not in draftsman and "planned" not in mbs and "planned feature" not in toast.lower() and enc_tabs >= 1 and enc_view >= 1
          and req_tabs >= 1 and page.locator(".reqdoc").count() >= 1 and req_panel >= 1)
    page.locator(".doctab", has_text="Demo.SchDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(600)
    page.locator(".menubar-item", has_text="Tools").first.click(); page.wait_for_timeout(300)
    tools = page.locator(".menu-popup").last
    si = tools.locator(".menu-item", has_text="Signal Integrity").first.get_attribute("class") or ""
    adv = tools.locator(".menu-item", has_text="Design Adviser").first.get_attribute("class") or ""
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    page.evaluate("window.konium.run('ai.adviser')"); page.wait_for_timeout(500)
    adviser = page.locator(".panel[aria-label='Design Adviser']").count() or page.locator("text=Check Design").count()
    check(f"…Tools › Signal Integrity and Design Adviser on, the adviser's panel opens ({si!r}, {adv!r}, {adviser})", "planned" not in si and "planned" not in adv and "disabled" not in adv and adviser > 0)
    # R8 (scripting, 26.146) on: Tools › Scripts and Help › Scripting Reference, the Scripts panel
    page.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(600)
    page.locator(".menubar-item", has_text="Tools").first.click(); page.wait_for_timeout(300)
    scr = page.locator(".menu-popup").last.locator(".menu-item", has_text="Scripts").first.get_attribute("class") or ""
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    page.evaluate("window.konium.dock.showPanel('scripts')"); page.wait_for_timeout(400)
    scr_panel = page.locator("section.scripts").count()
    page.locator(".menubar-item", has_text="Help").first.click(); page.wait_for_timeout(300)
    scr_ref = page.locator(".menu-popup").last.locator(".menu-item", has_text="Scripting Reference").first.get_attribute("class") or ""
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    check(f"…Scripting (R8) on: Tools › Scripts and Help › Scripting Reference not planned ({scr!r}, {scr_ref!r}), the Scripts panel opens ({scr_panel})", "planned" not in scr and "planned" not in scr_ref and scr_panel == 1 and page.locator(".panel-empty", has_text="Scripting").count() == 0)
    # R16 (power, thermal and EMC analysis; 26.177) on: the five Tools items, the Power Analysis panel a panel of fields
    page.locator(".menubar-item", has_text="Tools").first.click(); page.wait_for_timeout(300)
    pw = page.locator(".menu-popup").last.locator(".menu-item", has_text="Power Analysis").first
    pw_cls = pw.get_attribute("class") or ""; pw_text = pw.inner_text().replace("\n", " ")
    th_cls = page.locator(".menu-popup").last.locator(".menu-item", has_text="Thermal Analysis").first.get_attribute("class") or ""
    emc_cls = page.locator(".menu-popup").last.locator(".menu-item", has_text="EMC Check").first.get_attribute("class") or ""
    pdn_cls = page.locator(".menu-popup").last.locator(".menu-item", has_text="Supply Impedance").first.get_attribute("class") or ""
    fld_cls = page.locator(".menu-popup").last.locator(".menu-item", has_text="Field Solver").first.get_attribute("class") or ""
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    page.evaluate("window.konium.dock.showPanel('powerAnalysis')"); page.wait_for_timeout(400)
    pw_notice = page.locator(".dock-group:has(header[data-panel-id='powerAnalysis'])").inner_text() if page.locator("header[data-panel-id='powerAnalysis']").count() else ""
    check(f"…Power, thermal and EMC analysis (R16, 26.177) on: Tools › Power Analysis, Thermal Analysis, EMC Check, Supply Impedance and Field Solver not planned ({pw_cls!r}, {pw_text!r}); the Power Analysis panel is a panel of fields ({pw_notice[:40]!r})",
          all("planned" not in c and "disabled" not in c for c in (pw_cls, th_cls, emc_cls, pdn_cls, fld_cls)) and "Planned" not in pw_text and "lanned" not in pw_notice
          and page.locator(".powerpanel").count() == 1 and page.locator(".powerpanel select").count() >= 3)
    page.evaluate("window.konium.dock.hidePanel('powerAnalysis')"); page.wait_for_timeout(200)
    # R17 (antenna analysis; 26.180) on: Tools › Antenna Analysis, its panel a panel of fields
    page.locator(".menubar-item", has_text="Tools").first.click(); page.wait_for_timeout(300)
    an = page.locator(".menu-popup").last.locator(".menu-item", has_text="Antenna Analysis").first
    an_cls = an.get_attribute("class") or ""; an_text = an.inner_text().replace("\n", " ")
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    page.evaluate("window.konium.dock.showPanel('antennaAnalysis')"); page.wait_for_timeout(400)
    an_notice = page.locator(".dock-group:has(header[data-panel-id='antennaAnalysis'])").inner_text() if page.locator("header[data-panel-id='antennaAnalysis']").count() else ""
    check(f"…Antenna Analysis (R17, 26.180) on: Tools › Antenna Analysis not planned ({an_cls!r}, {an_text!r}); its panel is a panel of fields, with the example board offered ({an_notice[:40]!r})",
          "planned" not in an_cls and "disabled" not in an_cls and "Planned" not in an_text and "lanned" not in an_notice and page.locator(".antennapanel select").count() >= 3 and "Open the example board" in an_notice)
    page.evaluate("window.konium.dock.hidePanel('antennaAnalysis')"); page.wait_for_timeout(200)
    # A diagram from another tool and a multi-board project opened: the .drawio imported as a Konium diagram (R4); the project opens
    page.evaluate("""window.konium.openBatch([{ name: 'Later.drawio', bytes: new TextEncoder().encode('<mxfile><diagram id="a" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>') },
      { name: 'Later.PrjMbd', bytes: new TextEncoder().encode('[Design]\\r\\nVersion=1.0\\r\\n') }])"""); page.wait_for_timeout(1500)
    pd = page.locator(".planned-doc")
    toast = " ".join(page.locator(".toast").all_inner_texts())
    tabs = " ".join(page.locator(".doctab").all_inner_texts())
    check(f"…a .drawio opens as a Konium diagram (Diagrams on from R4: Later.DgmDoc), no planned-feature notice; a .PrjMbd opens ({toast!r})",
          pd.count() == 0 and page.locator(".dg-svg").count() >= 1 and "Later.DgmDoc" in tabs
          and "not opened" not in toast and "Later.PrjMbd" in page.locator(".panel[aria-label=Projects]").inner_text())
    shot(page, "97-planned-doc.png")
    # A BOM document (R3, 26.100): supply, cost, checks, AI part numbers and JLCPCB on — nothing planned
    page.locator(".doctab", has_text="Demo.SchDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('ad:WorkspaceManager:NewBOM')"); page.wait_for_timeout(800)
    bom = page.locator(".bomdoc")
    heads = bom.locator("thead").inner_text() if bom.count() else ""
    off = [bom.locator(".btn", has_text=t).first.is_disabled() for t in ("Fill Part Numbers With AI", "Update Supplier Data", "Export For JLCPCB")] if bom.count() else []
    on = [bom.locator(".btn", has_text=t).first.is_disabled() for t in ("Set Line Numbers", "Export...")] if bom.count() else []
    check(f"…a BOM document: its parts listed; Production Quantity, BOM Checks, Fill Part Numbers With AI, Update Supplier Data, Export For JLCPCB, Set Line Numbers and Export on, nothing planned ({off}, {on})",
          bom.count() == 1 and "Designator" in heads and off == [False, False, False] and on == [False, False]
          and not bom.locator("input[aria-label='Production Quantity']").is_disabled() and bom.locator(".planned-feature").count() == 0 and bom.locator(".planned-tag").count() == 0
          and "R1" in bom.locator("tbody").inner_text())
    shot(page, "97-planned-bom.png")
    # The board: ActiveRoute's Route Guide and Pin Swapping on (R5); the Signal Integrity panel on
    page.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(1200)
    page.evaluate(f"(() => {{ const ed = {ED}; ed.selectComponent(ed.doc.components.findIndex((c) => c.designator === 'C2')); }})()")
    page.evaluate("window.konium.run('view.panel.activeRoute')"); page.wait_for_timeout(400)
    ar = page.locator(".activeroute")
    rg = ar.locator(".btn", has_text="Route Guide").first
    check("…ActiveRoute: Route Guide, Tune Selected and Pin Swapping on (nothing Planned), ActiveRoute itself on",
          ar.count() == 1 and "Planned" not in rg.inner_text() and ar.locator(".planned-tag").count() == 0 and ar.locator(".planned-feature").count() == 0
          and not ar.locator("section[aria-label='Action'] label", has_text="Pin Swap Routing").locator("input").is_disabled()
          and ar.locator(".btn.default", has_text="ActiveRoute").count() == 1)
    page.locator(".menubar-item", has_text="Tools").first.click(); page.wait_for_timeout(300)
    page.locator(".menu-popup").last.locator(".menu-item", has_text="Signal Integrity").first.click(); page.wait_for_timeout(600)
    toast = " ".join(page.locator(".toast").all_inner_texts())
    try: page.wait_for_function("document.querySelector('.sipanel .si-state')?.textContent.includes('analysed')", timeout=30000)
    except Exception: pass
    sstate = page.locator(".sipanel .si-state").inner_text() if page.locator(".sipanel .si-state").count() else ""
    check(f"…Tools › Signal Integrity opens its panel and screens the nets ({sstate!r})", "planned" not in toast and "nets analysed" in sstate and page.locator(".sipanel .planned-tag").count() == 0)
    b.close()

    # 26.098: trust — About says how Konium is made, lists every connection; Contact the Author; Offline has the browser refuse connections, kept from load to load
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = b.new_page(viewport={"width": 1440, "height": 880})
    page.on("pageerror", lambda e: errors.append(f"pageerror (connections): {e}"))
    page.goto(URL)
    page.wait_for_function("window.konium !== undefined"); page.wait_for_timeout(800)
    net = page.locator(".home-netbox")
    nt = net.inner_text() if net.count() else ""
    check(f"Home page, in view: Network activity — Allow network activity and Check konium.app for updates and What's New, both on; What Konium Designer connects to",
          "Allow network activity" in nt and "Check konium.app for updates" in nt and net.locator("input").nth(0).is_checked() and net.locator("input").nth(1).is_checked()
          and net.bounding_box()["y"] + net.bounding_box()["height"] < 880)
    # Preferences › System › Network Activity: the same switches, and every connection
    page.evaluate("window.konium.state.prefsPage.value = 'sys-network'; window.konium.state.showPrefs.value = true"); page.wait_for_timeout(500)
    pr = page.locator(".dlg.prefs")
    prt = pr.inner_text() if pr.count() else ""
    check("Preferences › System › Network Activity: Allow network activity, Check konium.app for updates, the connections listed",
          "Allow Konium Designer to use network activity" in prt and "Check konium.app for updates and What's New" in prt and pr.locator(".about-net tbody tr").count() == 16)
    shot(page, "99-network-activity.png")
    pr.locator(".btn", has_text="Cancel").click(); page.wait_for_timeout(200)
    net.locator(".link", has_text="What Konium Designer connects to").click(); page.wait_for_timeout(400)
    ab = page.locator(".about-body")
    rows = ab.locator(".about-net tbody tr").all_inner_texts()
    src_link = ab.locator("a.btn", has_text="Source Code")
    check(f"…opens About at Your files and connections: how Konium is made, its source, licence and third-party software, Contact, {len(rows)} connections, all allowed",
          "built from scratch by its author, with the help of AI tools" in ab.inner_text() and "GNU General Public License, version 3 or later" in ab.inner_text()
          and "Copyright (C) 2026" in ab.inner_text() and ab.locator(".btn", has_text="Contact the Author").count() == 1
          and src_link.count() == 1 and src_link.get_attribute("href") == "https://github.com/knivd/konium-designer" and "noopener" in (src_link.get_attribute("rel") or "")
          and ab.locator(".btn", has_text="Licence...").count() == 1 and ab.locator(".btn", has_text="Third-Party Software...").count() == 1
          and ab.locator(".btn", has_text="Audit").count() == 0 and "github.com (the source code)" in rows[-1] and len(rows) == 16 and all(r.rstrip().endswith("Allowed") for r in rows[:-1]) and rows[-1].rstrip().endswith("Your click")
          and any("konium.app, then OpenRouter (openrouter.ai)" in r for r in rows) and any("konium.app, then Digi-Key (api.digikey.com) or Mouser (api.mouser.com)" in r for r in rows) and "ko-fi.com" in rows[-1]
          and ab.evaluate("e => e.scrollTop") > 100)
    shot(page, "98-about-connections.png")
    # Contact the Author (the service stubbed): an address is needed; the message goes as kind=contact with its topic
    sent = []
    def contact(route):
        sent.append(route.request.post_data_buffer or b"")
        route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body='{"ok":true,"id":"x"}')
    page.route("https://konium.app/api/report", contact)
    ab.locator(".btn", has_text="Contact the Author").click(); page.wait_for_timeout(300)
    ct = page.locator(".dlg.contact")
    ct.locator("#ct-topic").select_option("A security problem, reported privately"); page.wait_for_timeout(100)
    topic = ct.locator("#ct-topic").input_value() if ct.count() else ""
    hint = ct.locator("#ct-text").get_attribute("placeholder") or ""
    ct.locator("#ct-email").fill(""); ct.locator("#ct-text").fill("Smoke security report")
    ct.locator(".btn", has_text="Send").click(); page.wait_for_timeout(200)
    asked = "email address is needed" in ct.inner_text() and not sent
    ct.locator("#ct-email").fill("smoke@example.com"); ct.locator(".btn", has_text="Send").click(); page.wait_for_timeout(1200)
    body = sent[0].decode("latin1") if sent else ""
    check(f"Contact the Author: a security problem can be reported privately ({topic!r}, the box says what to write); an address needed; sent as a message (kind=contact), thanked",
          topic == "A security problem, reported privately" and "how to see it happen" in hint and asked and 'name="kind"' in body and "contact" in body and "A security problem, reported privately" in body
          and "Smoke security report" in body and page.locator(".dlg.contact").count() == 0 and "Message sent" in " ".join(page.locator(".toast").all_inner_texts()))
    page.unroute("https://konium.app/api/report")
    page.evaluate("window.konium.run('help.contact')"); page.wait_for_timeout(300)
    menu = page.locator(".dlg.contact").count() == 1
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    check("…Help › Contact the Author opens it too", menu)
    # Offline on: the browser told to refuse connections at once; nothing asked for; About says stopped; kept for the next load
    viol = []
    page.expose_function("__viol", lambda u: viol.append(u))
    page.evaluate("document.addEventListener('securitypolicyviolation', (e) => window.__viol(e.blockedURI))")
    net.locator("input").nth(0).uncheck(); page.wait_for_timeout(400)
    meta = page.evaluate("document.querySelector('meta[http-equiv=Content-Security-Policy][data-konium=offline]')?.content || ''")
    tried = page.evaluate("fetch('https://example.com/x').then(() => 'fetched', () => 'refused')")
    flag = page.evaluate("caches.open('konium-flags').then((c) => c.match(new URL('./__pinned', location.href).href)).then((r) => !!r)")
    wn = page.locator("#whats-new").inner_text()
    page.evaluate("window.konium.run('help.about')"); page.wait_for_timeout(300)
    rows = page.locator(".about-net tbody tr").all_inner_texts()
    page.keyboard.press("Escape")
    check(f"Offline: the page's policy refuses outside connections ({tried}, {len(viol)} refused), What's New not asked for, About says each is stopped, the service worker told",
          "connect-src data: blob:" in meta and tried == "refused" and len(viol) >= 1 and "Network activity is off: What's New" in wn and len(rows) == 16 and all(r.rstrip().endswith("Stopped") for r in rows[:-1]) and rows[-1].rstrip().endswith("Your click") and flag
          and net.locator("input").nth(1).is_disabled() and page.locator(".menubar-chip.offline").count() == 1)
    shot(page, "98-offline.png")
    # Loaded again with Offline on: sealed before the app could connect; the demo, its board and 3D work with nothing refused
    viol.clear()
    page.reload(); page.wait_for_function("window.konium !== undefined"); page.wait_for_timeout(800)
    page.evaluate("document.addEventListener('securitypolicyviolation', (e) => window.__viol(e.blockedURI))")
    meta2 = page.evaluate("document.querySelector('meta[http-equiv=Content-Security-Policy][data-konium=offline]') !== null")
    page.evaluate("window.konium.prefs.set({ openHomePage: false })")
    page.evaluate("window.konium.run('file.openDemo')"); page.wait_for_timeout(2500)
    page.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(1200)
    page.mouse.move(800, 500); page.keyboard.press("3"); page.wait_for_timeout(2500); page.keyboard.press("2"); page.wait_for_timeout(300)
    check(f"…loaded again: sealed at the start; the demo, the board and 3D work, nothing refused ({viol[:3]})", meta2 and len(viol) == 0 and page.locator(".doctab", has_text="Demo.SchDoc").count() == 1)
    # Offline off: connections back from the next load
    page.evaluate("window.konium.prefs.set({ offline: false })"); page.wait_for_timeout(300)
    note = " ".join(page.locator(".toast").all_inner_texts())
    page.reload(); page.wait_for_function("window.konium !== undefined"); page.wait_for_timeout(500)
    meta3 = page.evaluate("document.querySelector('meta[data-konium=offline]') !== null")
    flag3 = page.evaluate("caches.open('konium-flags').then((c) => c.match(new URL('./__pinned', location.href).href)).then((r) => !!r)")
    check(f"…Offline off: connections come back when Konium is loaded again; then no policy, the service worker free again", "loaded again" in note and not meta3 and not flag3)
    b.close()

    # 26.101: Preferences once greyed, wired — the Projects panel as AD starts it, the documents bar, the window's title, shadows, floating panels, and PCB Editor › General
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = b.new_page(viewport={"width": 1440, "height": 880})
    page.on("pageerror", lambda e: errors.append(f"pageerror (preferences 101): {e}"))
    page.goto(URL)
    page.wait_for_function("window.konium !== undefined"); page.wait_for_timeout(500)
    page.evaluate("window.konium.prefs.set({ openHomePage: false })")
    page.evaluate("window.konium.run('file.openDemo')"); page.wait_for_timeout(2500)
    show_panel(page, "projects")
    tree = page.locator(".panel[aria-label=Projects]")
    src_open = tree.locator(".tree-folder-row", has_text="Source Documents").first.get_attribute("aria-expanded")
    lib_open = tree.locator(".tree-folder-row", has_text="Libraries").first.get_attribute("aria-expanded")
    tabs0 = page.locator(".doctab").count()
    tree.locator(".tree-doc", has_text="Symbols.SchDoc").first.click(); page.wait_for_timeout(500)
    tabs1 = page.locator(".doctab").count()
    tree.locator(".tree-doc", has_text="Symbols.SchDoc").first.dblclick(); page.wait_for_timeout(800)
    tabs2 = page.locator(".doctab").count()
    tree.locator(".tree-doc", has_text="Demo.PcbDoc").first.click(); page.wait_for_timeout(500)
    active = page.locator(".doctab.on").inner_text()
    check(f"Projects panel as AD starts it: Source Documents open, Libraries closed ({src_open}, {lib_open}); a click brings an open document to the front, a closed one opens on a double-click ({tabs0}→{tabs1}→{tabs2})",
          src_open == "true" and lib_open == "false" and tabs1 == tabs0 and tabs2 == tabs0 + 1 and "Demo.PcbDoc" in active)
    page.evaluate("window.konium.prefs.set({ projShowPosition: true, projSort: 'alpha' })"); page.wait_for_timeout(300)
    names = [t.strip() for t in tree.locator(".tree-doc .tree-name").all_inner_texts()]
    check(f"…Show document position and Sort Alphabetically: numbered, in order ({names[:4]})", tree.locator(".tree-pos").count() >= 3 and names[:2] == sorted(names[:2], key=str.lower))
    page.evaluate("window.konium.prefs.set({ projShowPosition: false, projSort: 'project' })")
    # The documents bar and the window's title
    widths = {round(x) for x in page.evaluate("[...document.querySelectorAll('.doctab:not(.kind-home)')].map(t => t.getBoundingClientRect().width)")}
    title = page.title()
    page.locator(".doctab", has_text="Symbols.SchDoc").first.dispatch_event("mousedown", {"button": 1}); page.wait_for_timeout(300)
    closed = page.locator(".doctab", has_text="Symbols.SchDoc").count() == 0
    page.evaluate("window.konium.prefs.set({ middleClickCloses: false })")
    page.locator(".doctab", has_text="Demo.SchDoc").first.dispatch_event("mousedown", {"button": 1}); page.wait_for_timeout(300)
    kept = page.locator(".doctab", has_text="Demo.SchDoc").count() == 1
    check(f"Documents bar: equal-width tabs ({widths}); a middle click closes one, not with the switch off; the window's title is the document's ({title!r})",
          widths == {160} and closed and kept and title.startswith("Demo.PcbDoc") and title.endswith("Konium Designer"))
    # Shadows, floating panels hidden while away and see-through while a tool works
    page.evaluate("window.konium.prefs.set({ panelShadows: false, hideFloatsOnBlur: true, transparentFloats: true })"); page.wait_for_timeout(200)
    root = page.evaluate("(() => { const r = document.documentElement; window.dispatchEvent(new Event('blur')); const away = r.hasAttribute('data-away'); window.dispatchEvent(new Event('focus')); return [r.dataset.shadows, r.hasAttribute('data-floats-hide'), r.hasAttribute('data-floats-see'), away, r.hasAttribute('data-away')]; })()")
    page.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(1200)
    page.evaluate("window.konium.run('place.track')"); page.wait_for_timeout(300)
    at_work = page.evaluate("document.documentElement.hasAttribute('data-tool-at-work')")
    page.keyboard.press("Escape"); page.keyboard.press("Escape"); page.wait_for_timeout(200)
    idle = page.evaluate("document.documentElement.hasAttribute('data-tool-at-work')")
    check(f"Shadows off; floating panels hidden while the window is away, see-through while a tool works ({root}, {at_work}, {idle})", root == ["off", True, True, True, False] and at_work and not idle)
    # PCB Editor › General: undo depth, Protect Locked Objects, Click Clears Selection, Double Click Runs Inspector, Confirm Selection Memory Clear
    limit = page.evaluate(f"{ED}.undo.limit")
    moved = page.evaluate(f"""(() => {{ const ed = {ED}; const a = ed.doc.components.findIndex(c => c.designator === 'C1'), b = ed.doc.components.findIndex(c => c.designator === 'C2');
      ed.doc.components[b].bag.set('LOCKED', 'TRUE'); const pa = {{ ...ed.doc.components[a].at }}, pb = {{ ...ed.doc.components[b].at }};
      ed.select([...ed.componentKeys(a), ...ed.componentKeys(b)]); ed.nudge(1, 0);
      const r = [ed.doc.components[a].at.x !== pa.x, ed.doc.components[b].at.x !== pb.x];
      ed.select(ed.componentKeys(b)); ed.deleteSelection(); r.push(ed.doc.components.some(c => c.designator === 'C2'));
      ed.doc.components.find(c => c.designator === 'C2').bag.set('LOCKED', 'FALSE'); return r; }})()""")
    note = " ".join(page.locator(".toast").all_inner_texts())
    page.evaluate("window.konium.prefs.set({ pcbClickClearsSelection: false })")
    page.evaluate(f"(() => {{ const ed = {ED}; ed.selectComponent(ed.doc.components.findIndex(c => c.designator === 'C1')); }})()")
    box = page.locator(".viewport canvas").first.bounding_box()
    page.mouse.click(box["x"] + 30, box["y"] + 30); page.wait_for_timeout(200)
    still = page.evaluate(f"{ED}.selection.size")
    check(f"PCB Editor › General: undo keeps {limit} steps; a locked part stays when the selection moves or is deleted, the rest go ({moved}); a click on empty space keeps the selection ({still})",
          limit == 30 and moved == [True, False, True] and "locked" in note and still > 0)
    page.evaluate("window.konium.prefs.set({ pcbClickClearsSelection: true, pcbDoubleClickInspector: true })")
    page.evaluate(f"(() => {{ const ed = {ED}; const t = ed.doc.prims.find(p => p.kind === 'track' && p.component === 0xffff); window.konium.editObject(ed, `${{t.src.storage}}:${{t.src.index}}`); }})()"); page.wait_for_timeout(500)
    insp = page.locator(".panel[aria-label='PCB Inspector']").count() == 1 and page.locator(".dlg").count() == 0
    check("…Double Click Runs Inspector: a double-click shows the PCB Inspector, not the track's dialog", insp)
    page.evaluate("window.konium.run('ad:PCB:ShowSelectionMemoryDialog')"); page.wait_for_timeout(300)
    page.locator(".dlg.selmem .sm-row").first.locator(".btn", has_text="STO").first.click(); page.wait_for_timeout(200)
    page.locator(".dlg.selmem .sm-row").first.locator(".btn", has_text="Clear").click(); page.wait_for_timeout(300)
    asked = page.locator(".dlg.confirm").count() == 1 and "Clear selection memory 1" in page.locator(".dlg.confirm").inner_text()
    page.keyboard.press("Escape"); page.wait_for_timeout(200); page.keyboard.press("Escape")
    check("…Confirm Selection Memory Clear: Clear asks first", asked)
    # 26.102: Board Insight Display's pad and via names, Monochrome Other Layers; Display's highlighting options; DRC Violations Display
    page.evaluate("window.konium.state.prefsPage.value = 'pcb-insight'; window.konium.state.showPrefs.value = true"); page.wait_for_timeout(400)
    pt = page.locator(".dlg.prefs").inner_text()
    live = [page.locator(".dlg.prefs .pref-row", has_text=t).first.locator("input, select").first.is_disabled() for t in ("Use Smart Display Colour", "Font Name", "Minimum Font Size", "Monochrome Other Layers")]
    page.locator(".dlg.prefs .btn", has_text="Cancel").click(); page.wait_for_timeout(200)
    page.evaluate("window.konium.prefs.set({ pcbSingleMono: true, pcbRepaintIndicator: true })")
    mono = page.evaluate(f"(() => {{ const ed = {ED}; ed.cycleSingleLayer(); ed.cycleSingleLayer(); ed.cycleSingleLayer(); const m = ed.singleLayer; ed.cycleSingleLayer(); return [m, ed.singleLayer, ed.repaintIndicator()]; }})()")
    check(f"Board Insight Display: pad name font, sizes and smart colour, Monochrome Other Layers live ({live}); Shift+S reaches Monochrome; repaint indicator on ({mono})",
          "Maximum Font Size" in pt and live == [False, False, False, False] and mono == ["mono", "off", True])
    page.evaluate("window.konium.prefs.set({ pcbSingleMono: false, pcbRepaintIndicator: false })")
    # 26.103: live highlighting — the net under the cursor lights up; the heads-up display (Shift+H) beside the cursor
    page.evaluate("window.konium.state.prefsPage.value = null")
    pad = page.evaluate(f"(() => {{ const ed = {ED}; const p = ed.doc.prims.find(p => p.kind === 'pad' && p.net !== 0xffff); return [p.at.x, p.at.y, p.net]; }})()")
    px, py = page.evaluate(TO_SCREEN, pad[:2])
    page.mouse.move(px, py, steps=3); page.wait_for_timeout(500)
    lit = page.evaluate(f"{ED}.liveHighlightNet")
    page.keyboard.press("Shift+H"); page.wait_for_timeout(200)
    page.mouse.move(px + 1, py, steps=2); page.wait_for_timeout(1300)
    hud = page.evaluate(f"(() => {{ const h = {ED}.hud(); return h ? h.lines : null; }})()")
    shot(page, "103-live-and-hud.png")
    page.keyboard.press("Shift+H"); page.wait_for_timeout(100)
    check(f"Live highlighting lights the pad's net under the cursor ({lit} = {pad[2]}); Shift+H shows the heads-up display, resting adds what is under it ({hud})",
          lit == pad[2] and hud and hud[0].startswith("x: ") and hud[1].startswith("dx: ") and any(l.startswith("Net ") for l in hud) and any(l.startswith("Pad ") for l in hud)
          and page.evaluate("window.konium.prefs.get().pcbHud") is False)
    # 26.103: PCB display options once greyed — nothing greyed left on these pages; a net's colour override checkered,
    # a selection outlined, strings hard-edged when Antialiased Text is off
    greyed = []
    for pid in ("pcb-display", "pcb-insight", "pcb-insightcolours", "pcb-drcdisplay"):
        page.evaluate(f"window.konium.state.prefsPage.value = '{pid}'; window.konium.state.showPrefs.value = true"); page.wait_for_timeout(300)
        greyed.append(page.locator(".dlg.prefs .pref-todo").count())
        page.locator(".dlg.prefs .btn", has_text="Cancel").click(); page.wait_for_timeout(150)
    page.evaluate("window.konium.state.prefsPage.value = null; window.konium.prefs.set({ pcbAntialiasText: false })")
    look = page.evaluate(f"""(() => {{ const ed = {ED}; const t = ed.doc.prims.find(p => p.kind === 'track' && p.net !== 0xffff); const n = ed.doc.nets.find(x => x.index === t.net);
      n.bag.set('COLOR', '255'); n.bag.set('OVERRIDECOLORFORDRAW', 'TRUE'); ed.invalidate(); const s = ed.scene();
      const over = [...s.groups.values()].filter(g => g.key.endsWith(':over')).map(g => g.pattern.id);
      ed.select([ed.keyOf(ed.doc.prims.indexOf(t))]); ed.invalidateOverlay(); const hl = ed.overlay().groups.get('highlight').prims.count;
      ed.viewport.render();
      return [over[0], hl, !!document.getElementById('konium-hard-text')]; }})()""")
    shot(page, "103-display.png")
    page.evaluate(f"(() => {{ const ed = {ED}; for (const n of ed.doc.nets) n.bag.delete('OVERRIDECOLORFORDRAW'); ed.clearSelection(); ed.invalidate(); window.konium.prefs.set({{ pcbAntialiasText: true }}); }})()")
    check(f"PCB Display, Board Insight and DRC display pages: nothing greyed ({greyed}); a net's colour override checkered, a selection outlined, strings hard-edged as set ({look})",
          greyed == [0, 0, 0, 0] and look[0] == 1 and look[1] > 4 and look[2] is True)
    # 26.104: PCB Editor › General, Interactive Routing and True Type Fonts — nothing greyed; a click on overlapping
    # objects lists them (Display popup selection dialog); Paste with nothing copied in Konium takes another application's drawing
    later = []
    for pid in ("pcb-general", "pcb-routing", "pcb-ttf"):
        page.evaluate(f"window.konium.state.prefsPage.value = '{pid}'; window.konium.state.showPrefs.value = true"); page.wait_for_timeout(300)
        later.append(page.locator(".dlg.prefs .pref-todo[title='Not in Konium Designer yet']").count())
        page.locator(".dlg.prefs .btn", has_text="Cancel").click(); page.wait_for_timeout(150)
    page.evaluate("window.konium.state.prefsPage.value = null")
    pad = page.evaluate(f"(() => {{ const ed = {ED}; const p = ed.doc.prims.find(p => p.kind === 'pad' && p.component !== 0xffff && ed.unitsAt(p.at).length > 1); return [p.at.x, p.at.y]; }})()")
    px, py = page.evaluate(TO_SCREEN, pad)
    page.mouse.click(px, py); page.wait_for_timeout(700)
    items = page.locator(".selpopup .menu-item").all_inner_texts()
    shot(page, "104-popup.png")
    if len(items) > 1: page.locator(".selpopup .menu-item").nth(1).click(); page.wait_for_timeout(300)
    picked = page.evaluate(f"{ED}.selection.size")
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    page.evaluate(f"{ED}.clearSelection()")
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    page.evaluate("navigator.clipboard.writeText('<svg width=\"10mm\" height=\"10mm\" viewBox=\"0 0 10 10\"><rect x=\"1\" y=\"1\" width=\"8\" height=\"8\"/><circle cx=\"5\" cy=\"5\" r=\"2\"/></svg>')")
    n0 = page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'track').length")
    page.evaluate("window.konium.run('edit.paste')"); page.wait_for_timeout(600)
    tool = page.evaluate(f"{ED}.tool.id")
    box = page.locator(".viewport canvas").first.bounding_box()
    page.mouse.move(box["x"] + box["width"] * 0.8, box["y"] + box["height"] * 0.25); page.wait_for_timeout(200)
    shot(page, "104-paste-drawing.png")
    page.mouse.click(box["x"] + box["width"] * 0.8, box["y"] + box["height"] * 0.25); page.wait_for_timeout(400)
    n1 = page.evaluate(f"{ED}.doc.prims.filter(p => p.kind === 'track').length")
    page.keyboard.press("Control+z"); page.wait_for_timeout(300)
    check(f"PCB General, Interactive Routing, True Type Fonts: nothing greyed ({later}); a click on overlapping objects lists them ({items}), picking one selects it ({picked}); "
          f"Paste takes a drawing another application copied, as lines ({tool}: {n1 - n0} tracks)",
          later == [0, 0, 0] and len(items) > 1 and picked > 0 and tool == "paste-drawing" and n1 - n0 >= 40)
    # 26.105: System › View, Transparency, Navigation — nothing greyed; tabs of a kind grouped when they don't fit, on
    # several lines when asked; the Clipboard panel lists a copy
    later = []
    for pid in ("sys-view", "sys-transparency", "sys-nav"):
        page.evaluate(f"window.konium.state.prefsPage.value = '{pid}'; window.konium.state.showPrefs.value = true"); page.wait_for_timeout(300)
        later.append(page.locator(".dlg.prefs .pref-todo[title='Not in Konium Designer yet']").count())
        page.locator(".dlg.prefs .btn", has_text="Cancel").click(); page.wait_for_timeout(150)
    page.evaluate("window.konium.state.prefsPage.value = null")
    show_panel(page, "projects")
    for n in ("Symbols.SchDoc", "Child.SchDoc"):
        page.locator(".panel[aria-label=Projects] .tree-doc", has_text=n).first.dblclick(); page.wait_for_timeout(400)
    page.locator(".doctab", has_text="Demo.PcbDoc").click(); page.wait_for_timeout(300)
    page.set_viewport_size({"width": 760, "height": 880}); page.wait_for_timeout(400)
    grouped = page.locator(".doctab-group").count()
    shot(page, "105-grouped-tabs.png")
    page.set_viewport_size({"width": 1440, "height": 880}); page.wait_for_timeout(300)
    flat = page.locator(".doctab-group").count()
    page.evaluate("window.konium.prefs.set({ multilineTabs: true })"); page.wait_for_timeout(200)
    multi = page.locator(".doctabs.multi").count()
    page.evaluate("window.konium.prefs.set({ multilineTabs: false })")
    page.evaluate(f"(() => {{ const ed = {ED}; const t = ed.doc.prims.find(p => p.kind === 'track'); ed.select([ed.keyOf(ed.doc.prims.indexOf(t))]); }})()")
    page.evaluate("window.konium.run('edit.copy')"); page.wait_for_timeout(200)
    box = page.locator(".viewport canvas").first.bounding_box()
    page.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5); page.wait_for_timeout(300)
    show_panel(page, "clipboard"); page.wait_for_timeout(300)
    clip = page.locator(".panel.clipboard .clip-entry").all_inner_texts()
    check(f"System › View, Transparency, Navigation: nothing greyed ({later}); a narrow window groups tabs of a kind ({grouped}, {flat} wide), multiline on asking ({multi}); the Clipboard panel lists the copy ({clip})",
          later == [0, 0, 0] and grouped >= 1 and flat == 0 and multi == 1 and len(clip) == 1 and clip[0].startswith("PCB: 1 object"))
    # 26.106: Projects Panel, Data Management, Text Editors, Orcad — nothing greyed but version control; the Projects panel
    # ungrouped, ruled, with a sheet's ports under it
    later = []
    for pid in ("sys-projects", "dm-search", "dm-templates", "dm-backup", "text-general", "sch-orcad"):
        page.evaluate(f"window.konium.state.prefsPage.value = '{pid}'; window.konium.state.showPrefs.value = true"); page.wait_for_timeout(300)
        later.append(page.locator(".dlg.prefs .pref-todo[title='Not in Konium Designer yet']").count())
        page.locator(".dlg.prefs .btn", has_text="Cancel").click(); page.wait_for_timeout(150)
    page.evaluate("window.konium.state.prefsPage.value = null; window.konium.prefs.set({ projGroup: 'none', projGrid: true, projDocStructure: true })"); page.wait_for_timeout(300)
    show_panel(page, "projects")
    tree = page.locator(".panel[aria-label=Projects]")
    folders = tree.locator(".tree-project .tree-folder-row").count()
    ruled = page.locator(".panel[aria-label=Projects] .tree.grid").count()
    child = tree.locator(".tree-doc", has_text="Child.SchDoc").first
    tw = child.locator(".tree-twisty")
    if tw.count(): tw.click(); page.wait_for_timeout(200)
    ports = tree.locator(".tree-struct").all_inner_texts()
    shot(page, "106-projects.png")
    page.evaluate("window.konium.prefs.set({ projGroup: 'type', projGrid: false, projDocStructure: false })")
    check(f"Projects Panel, Data Management, Text Editors, Orcad: nothing greyed ({later}); ungrouped ({folders} folders), ruled ({ruled}), a sheet's ports under it ({ports})",
          later == [0, 0, 0, 0, 0, 0] and folders == 0 and ruled == 1 and any(t.startswith("Port ") for t in ports))
    # 26.107: nothing in Preferences greyed as not built; a compiled sheet's tabs (Editor, Compiled), the compiled view
    # read-only; Board Information shown as Reports says
    page.evaluate("window.konium.state.prefsPage.value = 'sys-general'; window.konium.state.showPrefs.value = true"); page.wait_for_timeout(300)
    names = page.locator(".dlg.prefs .prefs-page").all_inner_texts()
    later = 0
    for i in range(len(names)):
        page.locator(".dlg.prefs .prefs-page").nth(i).click(); page.wait_for_timeout(60)
        later += page.locator(".dlg.prefs .pref-todo[title='Not in Konium Designer yet']").count()
    page.locator(".dlg.prefs .btn", has_text="Cancel").click(); page.wait_for_timeout(150)
    page.evaluate("window.konium.state.prefsPage.value = null")
    page.locator(".doctab", has_text="Symbols.SchDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('tools.erc')"); page.wait_for_timeout(500)
    tabs = page.locator(".sheet-tabs .sheet-tab").all_inner_texts()
    if len(tabs) > 1: page.locator(".sheet-tabs .sheet-tab").nth(1).dispatch_event("mousedown"); page.wait_for_timeout(300)
    on = page.locator(".sheet-tabs .sheet-tab.on").inner_text() if page.locator(".sheet-tabs .sheet-tab.on").count() else ""
    refused = page.evaluate(f"(() => {{ const g = {ED}.undo.guard; return g ? g() : null; }})()")
    shot(page, "107-compiled-tab.png")
    if len(tabs) > 1: page.locator(".sheet-tabs .sheet-tab").first.dispatch_event("mousedown"); page.wait_for_timeout(200)
    page.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(300)
    page.evaluate("window.konium.run('ad:PCB:ReportBoardInformation')"); page.wait_for_timeout(300)
    rep = page.locator(".dlg", has_text="Board Information").count()
    page.keyboard.press("Escape"); page.wait_for_timeout(150)
    check(f"Preferences: nothing greyed as not built on {len(names)} pages ({later}); a compiled sheet's tabs ({tabs}), {on} read-only ({refused}); Board Information shown ({rep})",
          later == 0 and len(names) >= 45 and tabs[:2] == ["Editor", "Compiled"] and on == "Compiled" and refused and "compiled view" in refused and rep == 1)
    # Startup screen off: the next start shows a plain screen
    page.evaluate("window.konium.prefs.set({ showStartupScreen: false, pcbDoubleClickInspector: false })"); page.wait_for_timeout(200)
    page.reload(); page.wait_for_function("window.konium !== undefined"); page.wait_for_timeout(300)
    check("Show startup screen off: the next start's screen is plain", "no-boot" in page.evaluate("document.documentElement.className"))
    b.close()

    # No WebGL 2 (turned off, or the graphics driver blocked, as on many Windows 7 computers): the editors draw with the 2D canvas
    b = p.chromium.launch(args=["--disable-webgl2"])
    page = b.new_page(viewport={"width": 1440, "height": 880})
    page.on("pageerror", lambda e: errors.append(f"pageerror (no WebGL 2): {e}"))
    page.goto(URL)
    page.wait_for_function("window.konium !== undefined")
    page.get_by_text("Open the demo project").click(); page.wait_for_timeout(2000)
    body = page.locator("body").inner_text()
    check("No WebGL 2: the demo opens, a notice says the 2D canvas draws instead", "WebGL 2 turned off" in body and "hit an error" not in body)
    drawn = {}
    for name in ("Demo.SchDoc", "Demo.PcbDoc"):
        page.locator(".doctab", has_text=name).first.dispatch_event("mousedown"); page.wait_for_timeout(800)
        # Pixels the editor's canvas drew that differ from its background: the document is on it
        drawn[name] = page.evaluate(f"""(() => {{ const c = {ED}.viewport.canvases[0]; const x = document.createElement('canvas'); x.width = c.width; x.height = c.height;
          const g = x.getContext('2d'); g.drawImage(c, 0, 0); const d = g.getImageData(0, 0, x.width, x.height).data; let n = 0;
          for (let i = 0; i < d.length; i += 4 * 7) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 30) n++; return n; }})()""")
    check(f"…the schematic and the board drawn ({drawn})", all(v > 2000 for v in drawn.values()))
    page.mouse.move(800, 500); page.keyboard.press("3"); page.wait_for_timeout(800)
    check("…3D Layout Mode says it needs WebGL 2", "needs WebGL 2" in page.locator("body").inner_text())
    page.keyboard.press("2"); page.wait_for_timeout(300)
    shot(page, "70-no-webgl2.png")
    b.close()

    # 26.135: what the browser kept under the app's earlier names (made from the present one) moved over at the first start,
    # the earlier keys and databases gone: values in storage, the recent list's database (the name just before) and the
    # autosaves' database (the name before that)
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = b.new_page(viewport={"width": 1440, "height": 880})
    page.on("pageerror", lambda e: errors.append(f"pageerror (earlier name): {e}"))
    page.goto(SITE + "version.json")
    page.evaluate("""(async () => {
      const [A, B] = ['v', 'l'].map((c) => 'konium'.replace('k', 'j').replace('n', c));
      localStorage.setItem(A + '.smokeKept', 'kept'); localStorage.setItem('konium.smokeBoth', 'present'); localStorage.setItem(A + '.smokeBoth', 'earlier');
      localStorage.setItem(B + '.smokeOlder', 'older'); localStorage.setItem(B + '.smokeKept', 'older');
      const make = (name, up) => new Promise((res, rej) => { const r = indexedDB.open(name, 1); r.onupgradeneeded = () => up(r.result); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const put = (db, store, value, key) => new Promise((res, rej) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(value, key); t.oncomplete = res; t.onerror = () => rej(t.error); });
      const rec = await make(A, (db) => { db.createObjectStore('recentProjects', { keyPath: 'key' }); db.createObjectStore('recentDocuments', { keyPath: 'key' }); });
      await put(rec, 'recentDocuments', { key: 'smoke', name: 'Smoke.SchDoc', at: 1 }); rec.close();
      const bk = await make(B + '-backup', (db) => { db.createObjectStore('autosave', { keyPath: 'key' }); db.createObjectStore('history', { keyPath: 'key' }); db.createObjectStore('labels'); });
      await put(bk, 'labels', 'Smoke label', 'smoke'); bk.close();
    })()""")
    page.goto(URL)
    page.wait_for_function("window.konium !== undefined"); page.wait_for_timeout(2500)
    moved = page.evaluate("""(async () => {
      const old = ['v', 'l'].map((c) => 'konium'.replace('k', 'j').replace('n', c));
      const names = (await indexedDB.databases()).map((d) => d.name);
      const read = (name, store, key) => new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains(store)) { db.close(); res(null); return; }
        const g = db.transaction(store).objectStore(store).get(key); g.onsuccess = () => { db.close(); res(g.result ?? null); }; g.onerror = () => { db.close(); res(null); }; }; r.onerror = () => res(null); });
      const keys = Object.keys(localStorage);
      return { kept: localStorage.getItem('konium.smokeKept'), both: localStorage.getItem('konium.smokeBoth'), older: localStorage.getItem('konium.smokeOlder'),
        oldKeys: keys.filter((k) => old.some((o) => k.startsWith(o))).length, oldDbs: names.filter((n) => old.some((o) => n.startsWith(o))).length, label: names.includes('konium-backup') ? await read('konium-backup', 'labels', 'smoke') : null,
        recent: names.includes('konium') ? (await read('konium', 'recentDocuments', 'smoke'))?.name ?? null : null };
    })()""")
    check(f"The earlier names' browser data moved at the first start, nothing left under them ({moved})",
          moved["kept"] == "kept" and moved["both"] == "present" and moved["older"] == "older" and moved["oldKeys"] == 0 and moved["oldDbs"] == 0 and moved["label"] == "Smoke label" and moved["recent"] == "Smoke.SchDoc")
    b.close()

    # R6 (requirements, on from 26.138): a requirements document in the demo project, a
    # requirement and one under it, a section; a part on the board linked from the Requirements panel, verified, the
    # link followed back to the board, and Properties listing it; undone in the document
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = b.new_page(viewport={"width": 1440, "height": 860})
    page.on("pageerror", lambda e: errors.append(f"pageerror (requirements): {e}"))
    page.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    page.goto(URL); page.wait_for_function("window.konium !== undefined"); page.wait_for_timeout(800)
    page.evaluate("window.konium.run('file.openDemo')"); page.wait_for_timeout(2500)
    page.evaluate("window.konium.run('file.newRequirements')"); page.wait_for_timeout(600)
    focused = "document.activeElement && document.activeElement.tagName === 'INPUT'"
    page.get_by_role("button", name="New requirement", exact=True).click(); page.wait_for_function(focused)
    page.keyboard.type("Regulated 3.3 V rail for the MCU"); page.keyboard.press("Tab")
    page.get_by_label("Requirement text").fill("3.3 V \u00b1 3 % at up to 250 mA from the 5 V input."); page.get_by_label("Title", exact=True).click()
    page.get_by_role("button", name="New requirement under the one picked").click(); page.wait_for_function(focused)
    page.keyboard.type("Ripple under 30 mV"); page.keyboard.press("Tab")
    page.get_by_role("button", name="New section").click(); page.wait_for_function(focused)
    page.keyboard.press("Control+a"); page.keyboard.type("Mechanical"); page.keyboard.press("Tab")
    ids = page.locator(".reqdoc-table td.rq-id").all_inner_texts()
    check(f"Requirements: identifiers given in order, the one under its parent indented ({ids})", ids == ["REQ-001", "\u21b3REQ-002"])
    check("Requirements: the section heading", page.locator(".reqdoc-table input.rq-section-title").evaluate_all("els => els.map(e => e.value)") == ["General", "Mechanical"])
    in_project = page.evaluate("(() => { const s = window.konium.state; const d = s.docs.value.find(x => x.doc.kind === 'ReqDoc'); return !!d.projectId; })()")
    check("Requirements: the new document is in the open project", in_project)
    page.evaluate("(() => { const s = window.konium.state; const d = s.docs.value.find(x => x.doc.kind === 'PcbDoc'); s.activeId.value = d.id; })()"); page.wait_for_timeout(1200)
    page.evaluate("(() => { const s = window.konium.state; const od = s.active.value; const ed = od.editor; const c = od.doc.components.find(c => c.designator === 'U1'); ed.select(ed.componentKeys(c.index), false); s.tick.value++; })()")
    page.evaluate("window.konium.dock.showPanel('requirements')"); page.wait_for_timeout(500)
    panel = page.locator("section.reqp")
    panel.locator(".reqp-row").first.click(); page.wait_for_timeout(200)
    panel.get_by_role("button", name="Link the selection").click(); page.wait_for_timeout(300)
    links = panel.locator(".reqp-linklist li").all_inner_texts()
    check(f"Requirements panel: the selected part linked ({links})", len(links) == 1 and "U1" in links[0])
    panel.get_by_label("Verification state").select_option("verified"); page.wait_for_timeout(200)
    check("Requirements panel: the verification set", "Verified" in panel.locator(".reqp-row").first.inner_text())
    page.evaluate("(() => { const s = window.konium.state; s.active.value.editor.select([], false); s.tick.value++; })()")
    panel.locator(".reqp-linklist .link").first.click(); page.wait_for_timeout(500)
    check("Requirements panel: the link followed back selects the part on the board", page.evaluate("window.konium.state.active.value.editor.selection.size") > 0)
    shot(page, "71-requirements-panel.png")
    page.evaluate("window.konium.dock.showPanel('inspector')"); page.wait_for_timeout(400)
    check("Properties: the requirements the selected part is linked to", "REQ-001" in " ".join(page.locator(".insp-reqs").all_inner_texts()))
    page.evaluate("(() => { const s = window.konium.state; const d = s.docs.value.find(x => x.doc.kind === 'ReqDoc'); s.activeId.value = d.id; })()"); page.wait_for_timeout(500)
    page.locator(".reqdoc-table td.rq-id").first.click()
    check("Requirements: the link shown in the document", "U1" in page.locator(".rq-links").inner_text())
    page.get_by_role("button", name="Undo").click(); page.wait_for_timeout(200)
    check("Requirements: the panel's change undone in the document", "Not verified" in page.locator(".reqdoc-table td.rq-ver").first.inner_text())
    # A check against the design: the demo board's copper layers, at most 2: passes, and the verification follows it
    page.locator(".reqdoc-table tr.rq-row").first.click()
    page.get_by_label("Check", exact=True).select_option("layers"); page.get_by_label("Comparison").select_option("<=")
    page.get_by_label("Figure").fill("2"); page.get_by_label("Figure").press("Tab"); page.wait_for_timeout(300)
    check(f"Requirements: a check against the board passes ({page.locator('.rq-result').inner_text()!r})", "Passes" in page.locator(".rq-result").inner_text() and "2 layers" in page.locator(".rq-result").inner_text())
    check("Requirements: the verification follows the check", "Verified" in page.locator(".reqdoc-table td.rq-ver").first.inner_text())
    page.get_by_label("Figure").fill("1"); page.get_by_label("Figure").press("Tab"); page.wait_for_timeout(300)
    check("Requirements: the check fails when the board has more", "Failed" in page.locator(".reqdoc-table td.rq-ver").first.inner_text())
    page.get_by_label("Check", exact=True).select_option("drc"); page.wait_for_timeout(200)
    page.get_by_role("button", name="Check the design rules now").click(); page.wait_for_timeout(1500)
    check(f"Requirements: the design rules checked on request ({page.locator('.rq-result').inner_text()!r})", "Not known" not in page.locator(".rq-result").inner_text())
    shot(page, "72-requirements-document.png")
    saved = page.evaluate("(() => { const s = window.konium.state; const d = s.docs.value.find(x => x.doc.kind === 'ReqDoc'); return JSON.stringify(d.doc.reqs.rows.filter(r => r.kind === 'req').map(r => [r.id, r.parent || '', r.links.length])); })()")
    check(f"Requirements: what the document holds ({saved})", saved == '[["REQ-001","",1],["REQ-002","REQ-001",0]]')
    kept = page.evaluate("(() => { const s = window.konium.state; const d = s.docs.value.find(x => x.doc.kind === 'ReqDoc'); return d.doc.reqs.rows.find(r => r.kind === 'req').check.q; })()")
    check(f"Requirements: the check kept with the requirement ({kept})", kept == "drc")
    # 26.137: out to CSV and Excel, in from a CSV file (its columns matched by their headings, a taken identifier
    # renumbered), a specification split with AI (the service stubbed), and the compliance report in a new tab
    page.evaluate("""() => { window.__saves = []; window.showSaveFilePicker = async (o) => ({ createWritable: async () => ({ write: async (b) => { const u = b instanceof Uint8Array ? b : new Uint8Array(b); window.__saves.push({ name: o.suggestedName, size: u.length, text: new TextDecoder().decode(u) }); }, close: async () => {} }) }); }""")
    for fmt in ("A CSV file", "An Excel workbook"):
        page.get_by_role("button", name="Export requirements to Excel, CSV or the compliance report").click(); page.wait_for_timeout(300)
        page.get_by_label(fmt).check(); page.get_by_role("button", name="Export", exact=True).click(); page.wait_for_timeout(500)
    saves = page.evaluate("window.__saves.map(s => [s.name, s.size, s.text.slice(0, 400)])")
    csv_ok = len(saves) == 2 and saves[0][0].endswith(".csv") and "ID,Section,Title,Requirement" in saves[0][2] and "REQ-002" in saves[0][2]
    check(f"Requirements › Export: a CSV file and an Excel workbook ({[s[:2] for s in saves]})", csv_ok and saves[1][0].endswith(".xlsx") and saves[1][2].startswith("PK"))
    page.get_by_role("button", name="Import requirements from Excel or CSV").click(); page.wait_for_timeout(300)
    page.get_by_label("Table to import").set_input_files({"name": "Customer.csv", "mimeType": "text/csv",
        "buffer": "Req ID,Chapter,Name,Description,MoSCoW\nREQ-001,Mechanical,Mounting holes,Four M3 mounting holes on a 40 mm square.,Shall\nMECH-7,Mechanical,Height,Nothing taller than 12 mm on the top side.,Should\n".encode()})
    page.wait_for_timeout(500)
    picked = page.get_by_label("Column for Title").evaluate("e => e.options[e.selectedIndex].text")
    page.get_by_role("button", name="Import 2 Requirements").click(); page.wait_for_timeout(300)
    got = page.evaluate("(() => { const d = window.konium.state.docs.value.find(x => x.doc.kind === 'ReqDoc'); return d.doc.reqs.rows.slice(-3).map(r => r.kind === 'req' ? r.id + ':' + r.priority : '#' + r.title); })()")
    check(f"Requirements › Import: a CSV file's columns matched (Title from '{picked}'), the identifier taken renumbered ({got})", picked == "Name" and got == ["#Mechanical", "REQ-003:must", "MECH-7:should"])
    ai_jobs = []
    def reqs_route(route):
        if route.request.url.endswith("/config"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"models": [{"id": "m/text", "name": "Text", "roles": ["text"], "weight": 13}],
                                 "defaults": {"model": "m/text"}, "allowance": {"jobs": 20, "left": 20, "weighed": True}, "shareCache": True, "jobs": ["reqs", "ping"],
                                 "cheap": {"id": "qwen/qwen3.8-flash", "name": "Qwen3.8 Flash", "roles": ["text"], "weight": 1}, "cheapJobs": ["reqs"]}))
        ai_jobs.append(json.loads(route.request.post_data))
        ans = {"requirements": [{"section": "Interfaces", "ref": "4.1", "title": "USB-C power input", "text": "The board shall take its power from a USB-C connector.", "type": "interface", "priority": "must", "method": "inspection"},
                                {"section": "Interfaces", "ref": "4.2", "title": "Debug header", "text": "A debug header should be fitted.", "type": "interface", "priority": "should", "method": "inspection"}]}
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": ans, "usage": {"in": 400, "out": 200, "cost": 0.001}, "model": "m/text", "allowance": {"jobs": 20, "left": 19}}))
    page.route("https://konium.app/api/ai/**", reqs_route)
    page.evaluate("window.konium.prefs.set({ aiMode: 'konium' })")
    page.get_by_role("button", name="Split a specification into requirements with AI").click(); page.wait_for_timeout(500)
    page.get_by_label("Specification text").fill("4 Interfaces\n4.1 The board shall take its power from a USB-C connector.\n4.2 A debug header should be fitted.")
    page.get_by_label("Specification name").fill("Customer spec B")
    cheap_note = page.locator(".dlg").inner_text()
    check(f"…Split a specification with AI on the service's cheap text model, whatever is chosen: 1 job token on Qwen3.8 Flash (26.142)", "Free: 1 job token on Qwen3.8 Flash" in cheap_note)
    page.get_by_role("button", name="Split Into Requirements").click()
    page.wait_for_selector(".rq-ai-rows tbody tr", timeout=10000)
    shot(page, "73-requirements-ai-split.png")
    page.get_by_label("Keep Debug header").uncheck()
    page.get_by_role("button", name="Add Ticked (1)").click(); page.wait_for_timeout(300)
    got = page.evaluate("(() => { const d = window.konium.state.docs.value.find(x => x.doc.kind === 'ReqDoc'); return d.doc.reqs.rows.slice(-2).map(r => r.kind === 'req' ? [r.id, r.type, r.verify.method, r.source || ''].join(':') : '#' + r.title); })()")
    sent = ai_jobs[0] if ai_jobs else {}
    check(f"Requirements › Split a specification with AI: the text sent as the 'reqs' job, the one ticked added with its source ({got})",
          sent.get("job") == "reqs" and "USB-C" in sent.get("input", {}).get("text", "") and got == ["#Interfaces", "REQ-004:interface:inspection:Customer spec B 4.1"])
    with page.expect_popup() as pop:
        page.get_by_role("button", name="Compliance report: open it in a new tab").click()
    rep = pop.value; rep.wait_for_load_state()
    rtext = rep.locator("body").inner_text()
    check(f"Requirements › Compliance report: opened in a new tab, every requirement in it ({rep.title()!r})",
          rep.title().startswith("Requirements compliance:") and all(i in rtext for i in ("REQ-001", "REQ-004", "MECH-7")) and "Needs attention" in rtext)
    rep.close()
    # 26.161: a requirement given a parent goes under it; columns dragged wider and back; the connection graph; the
    # Requirements Adviser (unknown to an older service, then stubbed): its proposals applied in one step and undone
    page.locator(".reqdoc-table tr.rq-row", has_text="REQ-004").locator("td.rq-id").click(); page.wait_for_timeout(200)
    page.get_by_label("Parent", exact=True).select_option("REQ-001"); page.wait_for_timeout(300)
    tree_ids = page.locator(".reqdoc-table td.rq-id").all_inner_texts()
    check(f"Requirements: given a parent, a requirement goes under it, after its other children ({tree_ids})", tree_ids[:3] == ["REQ-001", "\u21b3REQ-002", "\u21b3REQ-004"])
    page.get_by_role("button", name="Undo").click(); page.wait_for_timeout(200)
    th = page.locator(".reqdoc-table th.rq-type")
    w0 = th.bounding_box()["width"]; grip = th.locator(".rq-colgrip").bounding_box()
    page.mouse.move(grip["x"] + 3, grip["y"] + 5); page.mouse.down(); page.mouse.move(grip["x"] + 63, grip["y"] + 5, steps=4); page.mouse.up(); page.wait_for_timeout(200)
    w1 = th.bounding_box()["width"]
    th.locator(".rq-colgrip").dblclick(); page.wait_for_timeout(200)
    w2 = th.bounding_box()["width"]
    check(f"Requirements: a column dragged 60 px wider ({w0:.0f} -> {w1:.0f}), double-clicked back ({w2:.0f})", abs(w1 - w0 - 60) <= 2 and abs(w2 - w0) <= 1)
    page.get_by_role("button", name="Connection graph").click(); page.wait_for_timeout(400)
    nreq = page.evaluate("window.konium.state.docs.value.find(x => x.doc.kind === 'ReqDoc').doc.reqs.rows.filter(r => r.kind === 'req').length")
    page.locator(".rg-node", has_text="REQ-002").click(); page.wait_for_timeout(200)
    shot(page, "75-requirements-graph.png")
    check(f"Requirements › Connection graph: a box for each requirement ({page.locator('.rg-node').count()} of {nreq}), the part linked to REQ-001 on the right, the one clicked picked and its parent lit",
          page.locator(".rg-node").count() == nreq and page.locator(".rg-item.rg-part", has_text="U1").count() == 1 and "REQ-002" in page.locator(".rq-head").inner_text()
          and "dim" not in (page.locator(".rg-node", has_text="REQ-001").get_attribute("class") or "") and "dim" in (page.locator(".rg-node", has_text="MECH-7").get_attribute("class") or ""))
    page.get_by_role("button", name="Connection graph").click(); page.wait_for_timeout(300)
    page.locator(".reqdoc-table tr.rq-row", has_text="REQ-001").first.locator("td.rq-id").click(); page.wait_for_timeout(200)
    page.get_by_role("button", name="Requirements Adviser").click(); page.wait_for_timeout(600)
    not_yet = "doesn't do this job yet" in page.locator(".rqa").inner_text()
    page.get_by_role("button", name="Requirements Adviser").click(); page.wait_for_timeout(200)
    adv_asks = []
    def adviser_route(route):
        if route.request.url.endswith("/config"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"models": [{"id": "m/text", "name": "Text", "roles": ["text"], "weight": 13}],
                                 "defaults": {"model": "m/text"}, "allowance": {"jobs": 20, "left": 20, "weighed": True}, "jobs": ["reqs", "reqadvise", "ping"]}))
        adv_asks.append(json.loads(route.request.post_data))
        ans = {"reply": "REQ-001 has no tolerance; I have broken it down.", "changes": [{"id": "REQ-001", "title": "Regulated 3.3 V rail", "text": "The MCU rail shall be 3.3 V \u00b1 3 % at up to 250 mA.", "why": "One wording"}],
               "added": [{"ref": "N1", "parent": "REQ-001", "title": "Load step", "text": "The rail shall stay within \u00b1 5 % for a [value] mA load step.", "type": "electrical", "priority": "should", "method": "test", "why": "Not covered"}]}
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": ans, "usage": {"in": 900, "out": 200, "cost": 0.001}, "model": "m/text", "allowance": {"jobs": 20, "left": 19}}))
    page.unroute("https://konium.app/api/ai/**"); page.route("https://konium.app/api/ai/**", adviser_route)
    page.get_by_role("button", name="Requirements Adviser").click(); page.wait_for_timeout(600)
    page.get_by_role("button", name="Break it down").click()
    page.wait_for_selector(".rqa-prop", timeout=10000)
    shot(page, "76-requirements-adviser.png")
    page.get_by_role("button", name="Apply Ticked (2)").click(); page.wait_for_timeout(300)
    got = page.evaluate("(() => { const d = window.konium.state.docs.value.find(x => x.doc.kind === 'ReqDoc'); const r = d.doc.reqs.rows.filter(r => r.kind === 'req'); return r.map(x => [x.id, x.parent || '', x.title].join(':')); })()")
    sent = adv_asks[0] if adv_asks else {}
    check(f"Requirements Adviser: unknown to an older service ({not_yet}); asked as the 'reqadvise' job with the one picked; its change and new child applied ({got[:4]})",
          not_yet and sent.get("job") == "reqadvise" and sent.get("input", {}).get("picked") == "REQ-001" and "Break the picked requirement down" in sent.get("input", {}).get("ask", "")
          and got[0] == "REQ-001::Regulated 3.3 V rail" and any(g.endswith(":REQ-001:Load step") for g in got) and "Applied" in page.locator(".rqa-actions").inner_text())
    page.get_by_role("button", name="Undo").click(); page.wait_for_timeout(200)
    back = page.evaluate("(() => { const d = window.konium.state.docs.value.find(x => x.doc.kind === 'ReqDoc'); return d.doc.reqs.rows.filter(r => r.kind === 'req').map(x => x.title); })()")
    check(f"Requirements Adviser: one step to undo ({back[:2]})", "Load step" not in back and back[0] == "Regulated 3.3 V rail for the MCU")
    page.get_by_role("button", name="Requirements Adviser").click(); page.wait_for_timeout(200)
    page.unroute("https://konium.app/api/ai/**"); page.route("https://konium.app/api/ai/**", reqs_route)
    # 26.139: a requirement's rich text (bold, a table, a picture) and an attached file, kept in the document; shown in the
    # panel; one step to undo; a Word specification's picture and a table carried into the requirement the AI found
    import zipfile, io, base64
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGNgYGD4z8DAwMAAAAwAAf/oEp9iAAAAAElFTkSuQmCC")
    page.locator(".reqdoc-table tr.rq-row", has_text="MECH-7").locator("td.rq-id").click(); page.wait_for_timeout(300)
    ed = page.get_by_role("textbox", name="Requirement text")
    ed.click(); page.keyboard.press("Control+a"); page.keyboard.type("Nothing taller than ")
    page.keyboard.press("Control+b"); page.keyboard.type("12 mm"); page.keyboard.press("Control+b"); page.keyboard.type(" on the top side, as drawn:"); page.keyboard.press("Enter")
    page.get_by_label("Picture to insert").set_input_files({"name": "outline.png", "mimeType": "image/png", "buffer": png}); page.wait_for_timeout(600)
    page.keyboard.press("Enter")
    page.get_by_role("button", name="Insert a table").click(); page.wait_for_timeout(200)
    page.keyboard.type("Side"); page.keyboard.press("Tab"); page.keyboard.type("Height"); page.keyboard.press("Tab"); page.keyboard.type("Top"); page.keyboard.press("Tab"); page.keyboard.type("12 mm")
    page.locator(".rt-text img").first.click(); page.wait_for_timeout(200)
    page.get_by_role("button", name="Picture medium (400 pixels across)").click(); page.wait_for_timeout(200)
    page.get_by_label("Files to attach").set_input_files({"name": "Housing.pdf", "mimeType": "application/pdf", "buffer": b"%PDF-1.4 test"}); page.wait_for_timeout(600)
    page.get_by_label("Title", exact=True).click(); page.wait_for_timeout(400)
    got = page.evaluate("(() => { const d = window.konium.state.docs.value.find(x => x.doc.kind === 'ReqDoc'); const q = d.doc.reqs.rows.find(r => r.id === 'MECH-7'); return { html: q.html || '', text: q.text, files: (q.files || []).map(f => f.name + ':' + (f.inline ? 'in' : 'att')) }; })()")
    check(f"Requirements › rich text: bold, a picture (made medium), a table, an attached file, all kept with the requirement ({got['files']}; {got['text'][:70]!r})",
          "<b>12 mm</b>" in got["html"] and '<img src="kfile:' in got["html"] and 'width="400"' in got["html"] and "<th>Side</th>" in got["html"] and "<td>12 mm</td>" in got["html"]
          and sorted(got["files"]) == ["Housing.pdf:att", "outline.png:in"] and "| Side | Height |" in got["text"] and page.locator(".rq-clip").count() >= 1)
    shot(page, "74-requirements-rich-text.png")
    page.evaluate("window.konium.dock.showPanel('requirements')"); page.wait_for_timeout(400)
    rp = page.locator("section.reqp")
    rp.locator(".reqp-row", has_text="MECH-7").first.click(); page.wait_for_timeout(300)
    shown = [rp.locator(".reqp-detail .rich img").count(), rp.locator(".reqp-detail .rich table").count(), rp.locator(".reqp-detail .rq-files .link", has_text="Housing.pdf").count()]
    check(f"…shown in the Requirements panel: its picture, its table and its attached file ({shown})", shown == [1, 1, 1])
    page.evaluate("window.konium.dock.slideOut.value = null")
    page.locator(".doctab", has_text=".ReqDoc").first.dispatch_event("mousedown"); page.wait_for_timeout(400)
    nfiles = lambda: page.evaluate("(() => { const d = window.konium.state.docs.value.find(x => x.doc.kind === 'ReqDoc'); const q = d.doc.reqs.rows.find(r => r.id === 'MECH-7'); return (q.files || []).length; })()")
    page.locator(".reqdoc-side").get_by_role("button", name="Remove Housing.pdf").click(); page.wait_for_timeout(300)
    removed = nfiles()
    page.get_by_role("button", name="Undo", exact=True).click(); page.wait_for_timeout(300)
    undone = nfiles()
    check(f"…an attached file removed, and back with Undo ({removed}, {undone})", removed == 1 and undone == 2)
    def docx(xml, rels, media):
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as z:
            z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
            z.writestr("word/document.xml", xml); z.writestr("word/_rels/document.xml.rels", rels)
            for n, d in media.items(): z.writestr(n, d)
        return b.getvalue()
    spec = docx('<w:document><w:body><w:p><w:r><w:t>4.3 The board shall have four M3 holes as in Figure 1.</w:t></w:r></w:p><w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>'
                '<w:p><w:r><w:t>Figure 1: hole positions</w:t></w:r></w:p></w:body></w:document>',
                '<Relationships><Relationship Id="rId5" Type="image" Target="media/image1.png"/></Relationships>', {"word/media/image1.png": png})
    page.unroute("https://konium.app/api/ai/**")
    def reqs2(route):
        if route.request.url.endswith("/config"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"models": [{"id": "m/text", "name": "Text", "roles": ["text"]}],
                                 "defaults": {"model": "m/text"}, "allowance": {"jobs": 20, "left": 19}, "shareCache": True, "jobs": ["reqs", "ping"]}))
        ai_jobs.append(json.loads(route.request.post_data))
        ans = {"requirements": [{"section": "Mechanical", "ref": "4.3", "title": "Mounting holes", "text": "The board shall have four M3 holes as in Figure 1.\n| Hole | Size |\n|---|---|\n| H1 to H4 | M3 |", "type": "mechanical", "priority": "must", "method": "inspection", "pictures": [1]}]}
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": ans, "usage": {"in": 300, "out": 100, "cost": 0.001}, "model": "m/text", "allowance": {"jobs": 20, "left": 18}}))
    page.route("https://konium.app/api/ai/**", reqs2)
    page.get_by_role("button", name="Split a specification into requirements with AI").click(); page.wait_for_timeout(500)
    page.get_by_label("Specification file").set_input_files({"name": "Housing spec.docx", "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "buffer": spec}); page.wait_for_timeout(800)
    marked = page.get_by_label("Specification text").input_value()
    page.get_by_role("button", name="Split Into Requirements").click()
    page.wait_for_selector(".rq-ai-rows tbody tr", timeout=10000)
    thumbs = page.locator(".rq-ai-pics img").count()
    page.get_by_role("button", name="Add Ticked (1)").click(); page.wait_for_timeout(600)
    got = page.evaluate("(() => { const d = window.konium.state.docs.value.find(x => x.doc.kind === 'ReqDoc'); const q = d.doc.reqs.rows.filter(r => r.kind === 'req').at(-1); return { id: q.id, html: q.html || '', files: (q.files || []).map(f => f.name + ':' + (f.inline ? 'in' : 'att')), source: q.source }; })()")
    sent = ai_jobs[-1]["input"]["text"] if ai_jobs else ""
    check(f"Requirements › Split with AI: a Word specification's picture marked in the text sent ({'[Picture 1]' in sent}), shown in the review ({thumbs}), and kept in the requirement with its table ({got['files']}, {got['source']})",
          "[Picture 1]" in marked and "[Picture 1]" in sent and thumbs == 1 and got["files"] == ["image1.png:in"] and '<img src="kfile:' in got["html"] and "<th>Hole</th>" in got["html"] and got["source"] == "Housing spec 4.3")
    page.evaluate("""() => { window.__saves = []; window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, kind: 'file', getFile: async () => new File([], o.suggestedName), createWritable: async () => ({ write: async (b) => { const u = b instanceof Uint8Array ? b : new Uint8Array(b instanceof Blob ? await b.arrayBuffer() : b); window.__saves.push({ name: o.suggestedName, text: new TextDecoder().decode(u) }); }, close: async () => {} }) }); }""")
    page.evaluate("window.konium.run('file.saveAs')"); page.wait_for_timeout(1200)
    saved = page.evaluate("window.__saves.length ? window.__saves.at(-1) : null")
    sj = json.loads(saved["text"]) if saved and saved["text"].lstrip().startswith("{") else {}
    q7 = next((r for r in sj.get("rows", []) if r.get("id") == "MECH-7"), {})
    check(f"…saved in the .ReqDoc: the requirement's formatting and its files ({saved['name'] if saved else None}: {[f.get('name') for f in q7.get('files', [])]})",
          "<b>12 mm</b>" in q7.get("html", "") and sorted(f.get("name") for f in q7.get("files", [])) == ["Housing.pdf", "outline.png"] and all(len(f.get("data", "")) > 8 for f in q7.get("files", [])))
    b.close()

    # 26.143: polygon pads: two circles in a new footprint made a ring pad (Tools › Convert › Create Pad from Selected Primitives)
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.on("pageerror", lambda e: errors.append(f"pageerror (polygon pads): {e}"))
    pg.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined"); pg.wait_for_timeout(600)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.newPcbLib')"); pg.wait_for_timeout(1500)
    for r in (90, 50):
        pg.evaluate("window.konium.run('ad:PCB:PlaceFullCircle')"); pg.wait_for_timeout(200)
        pg.mouse.move(720, 450); pg.wait_for_timeout(100); pg.mouse.click(720, 450); pg.wait_for_timeout(150)
        pg.mouse.move(720 + r, 450); pg.wait_for_timeout(100); pg.mouse.click(720 + r, 450); pg.wait_for_timeout(150)
        pg.mouse.click(720 + r, 450, button="right"); pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    pg.keyboard.press("Control+a"); pg.wait_for_timeout(300)
    pg.locator(".menubar-item", has_text="Tools").first.click(); pg.wait_for_timeout(300)
    pg.locator(".menu-popup .menu-item", has_text="Convert").first.hover(); pg.wait_for_timeout(400)
    pg.locator(".menu-popup .menu-item", has_text="Create Pad from Selected Primitives").first.click(); pg.wait_for_timeout(1000)
    made = pg.evaluate("window.konium.state.active.value.editor.doc.prims.map(p => p.kind + ':' + p.layer + (p.kind === 'region' ? ':' + p.holes.length + (p.padShape !== undefined ? ':shape' : '') : '') + (p.shapeKeys ? ':' + p.shapeKeys.length : ''))")
    sel = pg.evaluate("window.konium.state.active.value.editor.selection.size")
    pg.keyboard.press("Control+z"); pg.wait_for_timeout(500)
    undone = pg.evaluate("window.konium.state.active.value.editor.doc.prims.map(p => p.kind)")
    check(f"Polygon pads (26.143): two circles in a footprint, Tools › Convert › Create Pad from Selected Primitives: a ring pad, its copper, solder mask and paste one object ({sorted(made)}, {sel} selected); undone, the circles are back ({undone})",
          sorted(made) == sorted(["region:1:1:shape", "region:37:1:shape", "region:35:1:shape", "pad:1:3"]) and sel == 4 and sorted(undone) == ["arc", "arc"])
    b.close()

    # Mouse Wheel Configuration (26.147): the grid works, a column at a time (the wheel zooms, Ctrl scrolls up and down,
    # Shift across, Alt does nothing); the Offline chip reads as a word (white on grey), not a plain bar
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.on("pageerror", lambda e: errors.append(f"pageerror (wheel): {e}"))
    pg.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined"); pg.wait_for_timeout(600)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.state.prefsPage.value = 'sys-wheel'; window.konium.state.showPrefs.value = true"); pg.wait_for_timeout(500)
    grid = pg.locator(".dlg.prefs .wheel-table")
    enabled = grid.locator("input:not([disabled])").count()
    for lab in ["Zoom Main Window Wheel", "Vertical Scroll Ctrl"]:
        grid.get_by_label(lab).click(); pg.wait_for_timeout(100)
    ticks = grid.locator("input:checked").evaluate_all("l => l.map(e => e.getAttribute('aria-label'))")
    pg.locator(".dlg.prefs .btn", has_text="OK").click(); pg.wait_for_timeout(300)
    wmap = pg.evaluate("window.konium.prefs.get().wheelMap")
    pg.evaluate("window.konium.prefs.set({ offline: true })"); pg.wait_for_timeout(300)
    chip = pg.evaluate("(() => { const c = document.querySelector('.menubar-chip.offline'); const s = getComputedStyle(c); return [c.textContent, s.color, s.backgroundColor]; })()")
    pg.evaluate("window.konium.prefs.set({ offline: false })")
    # View › Workspace Panels: a panel with no command of its own (Clipboard) opens from there too
    pg.locator(".menubar-item", has_text="View").first.click(); pg.wait_for_timeout(300)
    pg.locator(".menu-popup .menu-item", has_text="Workspace Panels").last.hover(); pg.wait_for_timeout(300)
    pg.locator(".menu-popup .menu-item", has_text="System").last.hover(); pg.wait_for_timeout(300)
    clip_item = pg.locator(".menu-popup .menu-item", has_text="Clipboard").last.get_attribute("class") or ""
    pg.locator(".menu-popup .menu-item", has_text="Clipboard").last.click(); pg.wait_for_timeout(500)
    clip_open = pg.locator('[data-panel-id="clipboard"]').count()
    check(f"View › Workspace Panels › System › Clipboard: not greyed, opens the panel ({clip_item!r}, {clip_open})", "disabled" not in clip_item and clip_open >= 1)
    check(f"Mouse Wheel Configuration (26.147): its 12 cells for zoom and the two scrolls work ({enabled}); the wheel zooms, Ctrl scrolls up and down, Shift across ({ticks}, {wmap}); the Offline chip white on grey ({chip})",
          enabled == 12 and ticks == ["Zoom Main Window Wheel", "Vertical Scroll Ctrl", "Horizontal Scroll Shift"]
          and wmap == {"Wheel": "zoom", "Ctrl": "vscroll", "Shift": "hscroll", "Alt": "none"} and chip == ["Offline", "rgb(255, 255, 255)", "rgb(107, 118, 132)"])
    b.close()

    # R8 (scripting, 26.144; public from 26.146): a script of your own run on the demo board
    # (a part moved, a via added: one step to undo), the sandbox (no network, no page, no storage), an error's line, Stop,
    # and an example's file saved
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.on("pageerror", lambda e: errors.append(f"pageerror (scripting): {e}"))
    pg.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined"); pg.wait_for_timeout(600)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("""() => { window.__saves = [];
      window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, createWritable: async () => ({ write: async (b) => { window.__saves.push({ name: o.suggestedName, text: new TextDecoder().decode(b) }); }, close: async () => {} }) }); }""")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(800)
    pg.locator(".menubar-item", has_text="Tools").first.click(); pg.wait_for_timeout(300)
    pg.locator(".menu-popup .menu-item", has_text="Scripts").first.click(); pg.wait_for_timeout(600)
    panel = pg.locator("section.scripts")
    examples = panel.locator("select[aria-label='Script'] option").all_inner_texts()
    C1 = "(() => { const d = window.konium.state.active.value.editor.doc; const c = d.components.find(c => c.designator === 'C1'); return [c.at.x, c.at.y, d.prims.filter(p => p.kind === 'via').length]; })()"
    before = pg.evaluate(C1)
    def run_script(code, wait=2000):
        panel.locator("textarea.scr-code").fill(code); pg.wait_for_timeout(150)
        panel.locator(".scr-run .btn.default").click(); pg.wait_for_timeout(wait)
        return panel.locator(".scr-log").inner_text()
    panel.locator(".scr-bar .link", has_text="New").click(); pg.wait_for_timeout(300)
    log1 = run_script("const c = board.component('C1');\nc.moveBy(2, 0);\nboard.addVia({ x: 1, y: 1, net: 'GND' });\nprint('moved', c.designator);")
    after = pg.evaluate(C1)
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(500)
    undone = pg.evaluate(C1)
    mine = panel.locator("select[aria-label='Script'] optgroup[label='Your scripts'] option").count()
    check(f"Scripting (R8, 26.144): Tools › Scripts opens the Scripts panel with the examples ({len(examples)}); a new script run on the board: C1 moved 2 mm and a via added ({before} → {after}), what it printed and did ({log1.splitlines()[1:]}); one Undo puts it back ({undone}); kept with your scripts ({mine})",
          len(examples) >= 6 and after[0] - before[0] == round(2 / 25.4 * 1e7) and after[1] == before[1] and after[2] == before[2] + 1 and "moved C1" in log1
          and "1 part moved or turned, 1 object added" in log1 and undone == before and mine == 1)
    shot(pg, "144-scripts.png")
    log2 = run_script("const r = await fetch('https://example.com/');\nprint('fetched', r.status);")
    log3 = run_script("print(typeof localStorage, typeof document, typeof window, typeof parent);\ntry { indexedDB.open('x'); print('idb opened'); } catch (e) { print('idb refused'); }")
    log4 = run_script("print('first');\nnull.x;")
    log4b = run_script("print('first');\nawait Promise.resolve();\nboard.addVia({ x: 1, y: 1, net: 'NOPE' });")
    panel.locator("textarea.scr-code").fill("while (true) {}"); pg.wait_for_timeout(150)
    panel.locator(".scr-run .btn.default").click(); pg.wait_for_timeout(1500)
    stopping = panel.locator(".scr-run .btn", has_text="Stop").count()
    panel.locator(".scr-run .btn", has_text="Stop").click(); pg.wait_for_timeout(500)
    log5 = panel.locator(".scr-log").inner_text()
    alive = pg.evaluate("1 + 1")
    frames = pg.evaluate("document.querySelectorAll('iframe[sandbox]').length")
    check(f"…the sandbox: no network ({log2.splitlines()[-1]!r}); no storage, page or Konium ({log3.splitlines()[1:2]}); an error with its line ({log4.splitlines()[-1]!r}), a method's too ({log4b.splitlines()[-1]!r}); a loop stopped, Konium unharmed ({stopping}, {log5.splitlines()[-1]!r}, {alive}); no frames left ({frames})",
          "fetched" not in log2 and "Nothing was changed" in log2 and "undefined undefined undefined undefined" in log3 and "idb opened" not in log3
          and "first" in log4 and "Line 2:" in log4 and 'Line 3: No net "NOPE"' in log4b and stopping == 1 and "Stopped" in log5 and alive == 2 and frames == 0)
    panel.locator("select[aria-label='Script']").select_option(label="Net report"); pg.wait_for_timeout(300)
    panel.locator(".scr-run .btn.default").click(); pg.wait_for_timeout(2000)
    files = panel.locator(".scr-line.file").all_inner_texts()
    if files: panel.locator(".scr-line.file .link", has_text="Save").first.click(); pg.wait_for_timeout(500)
    saved = pg.evaluate("window.__saves.map(s => s.name + ':' + s.text.split('\\r\\n')[0])")
    check(f"…the Net report example: a file offered ({files}) and saved ({saved})",
          len(files) == 1 and saved == ["Demo-nets.csv:Net,Pads,Vias,Routed length (mm)"])
    scr_jobs = []
    def scr_route(route):
        if route.request.url.endswith("/config"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"models": [{"id": "m/code", "name": "Coder", "roles": ["text"], "weight": 5}],
                                 "defaults": {"model": "m/code"}, "allowance": {"jobs": 20, "left": 20, "weighed": True}, "shareCache": True, "jobs": ["script", "ping"]}))
        scr_jobs.append(json.loads(route.request.post_data))
        ans = {"name": "Count the vias", "code": "// Counts the vias.\nprint(board.vias.length + ' vias');\n", "explanation": "Prints how many vias the board has."}
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": ans, "usage": {"in": 3000, "out": 200, "cost": 0.001}, "model": "m/code", "allowance": {"jobs": 20, "left": 19}}))
    pg.route("https://konium.app/api/ai/**", scr_route)
    pg.evaluate("window.konium.prefs.set({ aiMode: 'konium' })")
    panel.locator(".scr-run .link", has_text="Write with AI").click(); pg.wait_for_timeout(600)
    panel.get_by_label("What the script is to do").fill("count the vias"); pg.wait_for_timeout(200)
    ai_note = panel.locator(".scr-ai").inner_text()
    panel.locator(".scr-ai .btn", has_text="Write").click(); pg.wait_for_timeout(1500)
    shown = panel.locator("select[aria-label='Script']").evaluate("e => e.options[e.selectedIndex].text")
    code_now = panel.locator("textarea.scr-code").input_value()
    panel.locator(".scr-run .btn.default").click(); pg.wait_for_timeout(1500)
    log6 = panel.locator(".scr-log").inner_text()
    sent = scr_jobs[0] if scr_jobs else {}
    ctx = sent.get("input", {}).get("context", "")
    check(f"…Write with AI: its job tokens on the model chosen ({'5 job tokens on Coder' in ai_note}); the job sent the request and the board's names, not the design ({sent.get('job')}, {ctx.splitlines()[:1]}); a new script of yours ({shown!r}) that runs ({log6.splitlines()[:1]})",
          "5 job tokens on Coder" in ai_note and sent.get("job") == "script" and sent.get("input", {}).get("request") == "count the vias" and "Copper layers: Top Layer, Bottom Layer" in ctx and "GND" in ctx
          and shown == "Count the vias" and "print(board.vias.length" in code_now and "3 vias" in log6)
    shot(pg, "144-scripts-ai.png")
    # The Scripting Reference (26.145): Help › Scripting Reference in a tab, its search, Try it, F1 from the script
    pg.locator(".menubar-item", has_text="Help").first.click(); pg.wait_for_timeout(300)
    pg.locator(".menu-popup .menu-item", has_text="Scripting Reference").first.click(); pg.wait_for_timeout(700)
    ref = pg.locator(".help-page")
    ref_sections = ref.locator(".help-section").count()
    ref_tab = pg.locator(".doctab.kind-help.on").count()
    ref.get_by_label("Search the Scripting Reference").fill("diameter hole"); pg.wait_for_timeout(300)
    ref_found = ref.locator(".help-hits a").all_inner_texts()
    ref.get_by_label("Search the Scripting Reference").fill(""); pg.wait_for_timeout(300)
    ref.locator("#scr-start .help-code .link", has_text="Try it").first.click(); pg.wait_for_timeout(600)
    tried = panel.locator("select[aria-label='Script']").evaluate("e => e.options[e.selectedIndex].text")
    tried_code = panel.locator("textarea.scr-code").input_value()
    shot(pg, "145-reference.png")
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(500)
    panel.locator(".scr-run .btn.default").click(); pg.wait_for_timeout(1500)
    tried_log = panel.locator(".scr-log").inner_text()
    panel.locator("textarea.scr-code").focus(); pg.keyboard.press("F1"); pg.wait_for_timeout(500)
    f1 = pg.locator(".doctab.kind-help.on").count() + pg.locator(".help-page").count()
    check(f"Scripting Reference (26.145): Help › Scripting Reference opens in a tab ({ref_tab}) with its {ref_sections} sections; searched ({ref_found}); an example's Try it adds it to your scripts ({tried!r}) and it runs ({tried_log.splitlines()[-1:]}); F1 in a script opens it ({f1})",
          ref_tab == 1 and ref_sections >= 18 and "Adding objects" in ref_found and "Parts" not in ref_found and tried == "Lists the parts, then moves C1 2 mm to the right"
          and "c1.moveBy(2, 0);" in tried_code and "1 part moved or turned" in tried_log and f1 == 2)
    b.close()

    # A project's scripts (26.145): the project open from its folder; Add to Project writes Scripts/<name>.js, edits are saved to it, Delete removes it
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.on("pageerror", lambda e: errors.append(f"pageerror (project scripts): {e}"))
    pg.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined"); pg.wait_for_timeout(600)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("""async () => {
      // (Folder handles not kept between visits here: a handle into the page's own storage can't be)
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
      const root = await navigator.storage.getDirectory();
      const proj = await root.getDirectoryHandle('ScrProj', { create: true });
      for (const f of window.konium.demoFiles()) { const w = await (await proj.getFileHandle(f.name, { create: true })).createWritable(); await w.write(f.bytes); await w.close(); }
      await window.konium.openProjectFolder(proj, 'Demo.PrjPcb');
    }""")
    pg.wait_for_timeout(2000)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(700)
    pg.evaluate("window.konium.run('tools.scripts')"); pg.wait_for_timeout(600)
    panel = pg.locator("section.scripts")
    READ_SCR = """async (name) => { try { const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('ScrProj')).getDirectoryHandle('Scripts');
      return await (await (await d.getFileHandle(name)).getFile()).text(); } catch { return null; } }"""
    panel.locator("select[aria-label='Script']").select_option(label="Net report"); pg.wait_for_timeout(300)
    panel.locator(".scr-bar .link", has_text="Add to Project").click(); pg.wait_for_timeout(1200)
    written = pg.evaluate(READ_SCR, "Net report.js") or ""
    group = panel.locator("select[aria-label='Script'] optgroup[label='Demo.PrjPcb (project)'] option").all_inner_texts()
    panel.locator("textarea.scr-code").fill("// @name ignored\nprint('changed');\n"); pg.wait_for_timeout(1500)
    edited = pg.evaluate(READ_SCR, "Net report.js") or ""
    panel.locator(".scr-bar .link", has_text="Delete").click(); pg.wait_for_timeout(400)
    pg.locator(".dlg .btn", has_text="Delete").click(); pg.wait_for_timeout(1000)
    gone = pg.evaluate(READ_SCR, "Net report.js")
    left = panel.locator("select[aria-label='Script'] optgroup[label='Demo.PrjPcb (project)']").count()
    check(f"…a project's scripts: Add to Project writes Scripts/Net report.js ({written.splitlines()[:1]}) listed with the project ({group}); an edit saved to the file ({edited.splitlines()[1:2]}); Delete removes it ({gone is None}, {left})",
          written.startswith("// @name Net report\n// Every net") and group == ["Net report"] and "print('changed');" in edited and edited.startswith("// @name Net report\n") and gone is None and left == 0)
    # Installed with the title bar folded in (Window Controls Overlay, 26.145): the menu bar drags the window, its buttons don't;
    # the title bar's colour follows the theme. (The display mode can't be emulated here: the rules are applied as parsed.)
    wco = pg.evaluate("""() => { for (const sh of document.styleSheets) for (const r of sh.cssRules) if (r.conditionText && r.conditionText.includes('window-controls-overlay')) {
        const st = document.createElement('style'); st.textContent = [...r.cssRules].map((x) => x.cssText).join('\\n'); document.head.append(st);
        const m = document.querySelector('.menubar'), g = (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region');
        const out = [g(m), g(m.querySelector('.menubar-item')), g(m.querySelector('.menubar-icon')), g(m.querySelector('.navbar'))]; st.remove(); return out; } return null; }""")
    pg.evaluate("window.konium.prefs.set({ theme: 'dark' })"); pg.wait_for_timeout(300)
    dark_bar = pg.evaluate("document.querySelector('meta[name=theme-color]').content")
    pg.evaluate("window.konium.prefs.set({ theme: 'light' })"); pg.wait_for_timeout(300)
    light_bar = pg.evaluate("document.querySelector('meta[name=theme-color]').content")
    check(f"Installed window's title bar (26.145): menu bar drag, menus and buttons not, the path drag ({wco}); title bar colour follows the theme ({dark_bar}, {light_bar})",
          wco == ["drag", "no-drag", "no-drag", "drag"] and dark_bar == "#13201d" and light_bar == "#fbfbfb")
    b.close()

    # R7 (version control, planned until its release: on here with features=all): two designers, Ana and Ben, each in their
    # own browser with a project folder; Konium's store stood in for by a store in memory that keeps the same rules (tags,
    # writes only if new or unchanged). Add, commit and push, open from version control, lock, update, both changing the
    # board (the choice), and the history: a version saved, the board restored, the project exported
    store, store_n = {}, [0]
    def store_route(route):
        req = route.request
        name = req.url.split('/api/vcs/blob/', 1)[1]
        key = (req.headers.get('authorization'), name)
        cur = store.get(key)
        cors = {"access-control-allow-origin": "*", "access-control-expose-headers": "ETag"}
        if req.method == 'OPTIONS':
            return route.fulfill(status=204, headers={**cors, "access-control-allow-headers": "authorization, if-match, if-none-match, content-type", "access-control-allow-methods": "GET, PUT"})
        if req.method == 'GET':
            return route.fulfill(status=200, headers={**cors, "etag": cur[1]}, body=cur[0]) if cur else route.fulfill(status=404, headers=cors, body='{"error":"None"}')
        im, inm = req.headers.get('if-match'), req.headers.get('if-none-match')
        if (inm == '*' and cur) or (im and (not cur or cur[1] != im)):
            return route.fulfill(status=412, headers=cors, body='{}')
        store_n[0] += 1; tag = f'"e{store_n[0]}"'
        store[key] = (req.post_data_buffer, tag)
        route.fulfill(status=200, headers={**cors, "etag": tag}, body='{}')
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    def designer(who, email):
        ctx = b.new_context(viewport={"width": 1440, "height": 900})
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror (version control, {who}): {e}"))
        pg.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
        pg.route("https://konium.app/api/vcs/**", store_route)
        pg.goto(URL); pg.wait_for_function("window.konium !== undefined"); pg.wait_for_timeout(600)
        pg.evaluate(f"window.konium.prefs.set({{ openHomePage: false, vcsName: '{who}', vcsEmail: '{email}', vcsCheckMinutes: 0 }})")
        pg.evaluate("""async () => {
          window.__dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Work', { create: true });
          window.showDirectoryPicker = async () => window.__dir;
          // (Folder handles not kept between visits here: a handle into the page's own storage can't be)
          Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
          window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('.toast'); if (t && window.__toasts.at(-1) !== t.innerText) window.__toasts.push(t.innerText); }).observe(document.body, { childList: true, subtree: true, characterData: true });
          window.__saves = []; window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, createWritable: async () => ({ write: async (b) => { const u = b instanceof Uint8Array ? b : new Uint8Array(b instanceof Blob ? await b.arrayBuffer() : b); window.__saves.push({ name: o.suggestedName, size: u.length }); }, close: async () => {} }) });
        }""")
        pg.evaluate("window.konium.dock.showPanel('projects')")
        return pg
    LIST = """async (path) => { let d = await navigator.storage.getDirectory(); for (const s of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(s);
      const out = []; for await (const [n] of d.entries()) out.push(n); return out.sort(); }"""
    def marks(pg):
        return dict(pg.evaluate("[...document.querySelectorAll('.panel[aria-label=Projects] .tree-doc')].map(r => [r.querySelector('.tree-name').innerText, (r.querySelector('.tree-lock') ? (r.querySelector('.tree-lock').classList.contains('mine') ? 'L' : 'X') : '') + (r.querySelector('.tree-vcs')?.innerText ?? '')])"))
    def vinfo(pg):
        return pg.evaluate("(() => { const p = window.konium.state.projects.value[0]; const i = window.konium.vcs.vcsInfo.value[p.id]; return i && { repo: i.repo, unpushed: i.unpushed, incoming: [...i.incoming], error: i.error, locks: Object.fromEntries(Object.entries(i.locks).map(([k, v]) => [k, v.by])) }; })()")
    def toasts(pg):
        return " | ".join(pg.evaluate("window.__toasts.slice(-3)"))
    def fetch(pg):
        pg.evaluate("window.konium.vcs.refresh(window.konium.state.projects.value[0], { fetch: true })"); pg.wait_for_timeout(1500)
    VIAS = "(() => { const d = window.konium.state.docs.value.find(x => x.doc.kind === 'PcbDoc'); return d ? d.doc.prims.filter(q => q.kind === 'via').length : -1; })()"
    def board(pg):
        pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(700)
    def via_and_save(pg, x, y):
        board(pg)
        pg.evaluate("window.konium.run('place.via')"); pg.mouse.move(x, y); pg.wait_for_timeout(100); pg.mouse.click(x, y); pg.wait_for_timeout(150)
        pg.mouse.click(x, y, button="right"); pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
        pg.keyboard.press("Control+s"); pg.wait_for_timeout(1500)
    def commit(pg, msg, push=True):
        pg.evaluate("window.konium.run('vcs.commit')"); pg.wait_for_timeout(900)
        pg.get_by_label("Commit message").fill(msg)
        pg.get_by_role("button", name="Commit and Push" if push else "Commit Only").click(); pg.wait_for_timeout(3000)
    A = designer('Ana', 'ana@example.com')
    A.evaluate("""async () => {
      const proj = await window.__dir.getDirectoryHandle('Demo', { create: true });
      for (const f of window.konium.demoFiles()) { const w = await (await proj.getFileHandle(f.name, { create: true })).createWritable(); await w.write(f.bytes); await w.close(); }
      window.__dir = proj;
      await window.konium.openProjectFolder(proj, 'Demo.PrjPcb');
    }""")
    A.wait_for_timeout(1500)
    A.evaluate("window.konium.run('vcs.add')"); A.wait_for_timeout(500)
    add_text = A.locator(".dlg").inner_text()
    A.get_by_label("New team's name").fill("Board team")
    A.get_by_role("button", name="Make the Team").click(); A.wait_for_timeout(500)
    A.get_by_role("button", name="Add and Push").click(); A.wait_for_timeout(4000)
    m = marks(A); folder = A.evaluate(LIST, "Work/Demo")
    check(f"Version control › Add Project to Version Control: a new team in Konium's store, the project committed and pushed; every document marked unchanged ({sorted(set(m.values()))}); the folder a Git repository ({'.git' in folder}, {'.gitignore' in folder}); sealed blobs in the store ({len(store)})",
          "Konium's store" in add_text and "Your own Git server" in add_text and m and set(m.values()) == {"✓"} and ".git" in folder and ".gitignore" in folder and len(store) >= 3
          and all(b"Demo" not in v[0] for v in store.values()))
    shot(A, "140-vcs-added.png")
    via_and_save(A, 700, 450)
    m1 = marks(A).get("Demo.PcbDoc")
    commit(A, "Via by the regulator")
    check(f"…a saved change marked as changed ({m1}), then Commit and Push: unchanged again, nothing waiting ({marks(A).get('Demo.PcbDoc')}, {toasts(A)})",
          m1 == "●" and marks(A).get("Demo.PcbDoc") == "✓" and vinfo(A)["unpushed"] is False and "Pushed" in toasts(A))
    key = A.evaluate("JSON.parse(localStorage.getItem('konium.vcsTeams'))[0].key")
    B = designer('Ben', 'ben@example.com')
    B.evaluate("window.konium.run('tools.preferences')"); B.wait_for_timeout(600)
    B.locator(".prefs-tree .prefs-page", has_text="Version Control").first.click(); B.wait_for_timeout(300)
    B.get_by_label("Team key to join").fill(key)
    B.get_by_role("button", name="Join a Team").click(); B.wait_for_timeout(500)
    joined = B.evaluate("JSON.parse(localStorage.getItem('konium.vcsTeams') || '[]').length")
    B.keyboard.press("Escape"); B.wait_for_timeout(300)
    B.evaluate("window.konium.run('vcs.clone')"); B.wait_for_timeout(1500)
    listed = B.locator(".dlg").inner_text()
    B.evaluate("async () => { window.__dir = await window.__dir.getDirectoryHandle('Board', { create: true }); }")
    B.get_by_role("button", name="Choose an Empty Folder…").click(); B.wait_for_timeout(5000)
    bm = marks(B)
    check(f"…Ben joins with the key (Preferences › Version Control: {joined}) and opens the team's project from version control into an empty folder ({len(bm)} documents, {sorted(set(bm.values()))})",
          joined == 1 and "Demo" in listed and len(bm) == len(m) and set(bm.values()) == {"✓"} and "Demo.PrjPcb" in B.evaluate(LIST, "Work/Board"))
    # Ben locks the board; Ana sees it and is told whose it is
    board(B)
    B.evaluate("window.konium.run('vcs.lock')"); B.wait_for_timeout(1500)
    b_lock = marks(B).get("Demo.PcbDoc")
    fetch(A)
    a_lock = marks(A).get("Demo.PcbDoc")
    lock_title = A.locator(".tree-doc[data-name='Demo.PcbDoc'] .tree-lock").get_attribute("title") or ""
    board(A)
    A.evaluate("window.konium.run('vcs.lock')"); A.wait_for_timeout(1500)
    refused = A.locator(".dlg").inner_text() if A.locator(".dlg").count() else ""
    shot(A, "140-vcs-locked.png")
    if refused: A.get_by_role("button", name="Cancel").click(); A.wait_for_timeout(300)
    check(f"…Lock: Ben's board marked as his ({b_lock}); Ana sees whose it is ({a_lock}: {lock_title}) and her Lock is refused, offering to take it over",
          b_lock == "L✓" and a_lock == "X✓" and "Ben" in lock_title and "is locked by Ben" in refused and "Take It Over" in refused)
    vb0 = B.evaluate(VIAS)
    via_and_save(B, 650, 420)
    B.evaluate("window.konium.run('vcs.commit')"); B.wait_for_timeout(900)
    unlock_box = B.get_by_text("Unlock my locked files once pushed (1)").count()
    B.get_by_label("Commit message").fill("Ben's via")
    B.get_by_role("button", name="Commit and Push").click(); B.wait_for_timeout(3500)
    fetch(A)
    am = marks(A); badge = A.evaluate("document.querySelector('.tree-vcs-badges')?.innerText ?? ''")
    va0 = A.evaluate(VIAS)
    A.evaluate("window.konium.run('vcs.update')"); A.wait_for_timeout(3000)
    check(f"…Ben's board pushed, his lock let go with it ({unlock_box}, {vinfo(B)['locks']}); Ana sees it waiting ({am.get('Demo.PcbDoc')}, {badge!r}) and Update brings it in ({va0} → {A.evaluate(VIAS)} vias, {marks(A).get('Demo.PcbDoc')})",
          unlock_box == 1 and vinfo(B)["locks"] == {} and am.get("Demo.PcbDoc") == "↓" and "↓1" in badge and A.evaluate(VIAS) == va0 + 1 and marks(A).get("Demo.PcbDoc") == "✓")
    # Both change the board: Ana pushes first; Ben's push brings hers in and asks which to keep
    via_and_save(A, 600, 400); commit(A, "Ana again")
    via_and_save(B, 720, 480); commit(B, "Ben again")
    asked = B.locator(".dlg").inner_text() if B.locator(".dlg").count() else ""
    shot(B, "140-vcs-both.png")
    if asked:
        B.get_by_label("Keep for Demo.PcbDoc").select_option("both")
        B.get_by_role("button", name="Update", exact=True).click(); B.wait_for_timeout(4500)
    bfolder = B.evaluate(LIST, "Work/Board")
    beside = [n for n in bfolder if re.match(r"Demo \(theirs [0-9a-f]{7}\)\.PcbDoc$", n)]
    check(f"…both changed the board: Ben's push brings Ana's in and asks ({'Changed on Both Sides' in asked}); Both keeps hers beside his ({beside}) and pushes ({vinfo(B)['unpushed']})",
          "Changed on Both Sides" in asked and "Ana" in asked and len(beside) == 1 and vinfo(B)["unpushed"] is False)
    # The board's history: a version saved as a file, the board restored, the project exported
    fetch(A); A.evaluate("window.konium.run('vcs.update')"); A.wait_for_timeout(3000)
    board(A)
    A.evaluate("window.konium.run('vcs.docHistory')"); A.wait_for_timeout(1500)
    hist = A.locator(".vcd-hist-list tbody tr").all_inner_texts()
    shot(A, "140-vcs-history.png")
    A.locator(".vcd-hist-list tbody tr").last.click(); A.wait_for_timeout(500)
    A.get_by_role("button", name="Save This Version As…").click(); A.wait_for_timeout(1000)
    saved1 = A.evaluate("window.__saves.map(s => s.name)")
    A.get_by_role("button", name="Restore This Version").click(); A.wait_for_timeout(300)
    A.get_by_role("button", name="Yes").click(); A.wait_for_timeout(2500)
    restored = marks(A).get("Demo.PcbDoc")
    A.evaluate("window.konium.run('vcs.history')"); A.wait_for_timeout(1500)
    A.locator(".vcd-hist-list tbody tr").nth(1).click(); A.wait_for_timeout(300)
    A.get_by_role("button", name="Export This Version…").click(); A.wait_for_timeout(2000)
    saved2 = A.evaluate("window.__saves.map(s => s.name + ':' + s.size)")
    cmp_link = A.locator(".vcd-cmp").count()
    if cmp_link: A.locator(".vcd-cmp").first.click(); A.wait_for_timeout(2500)
    crows = A.locator(".cmp-list tr").all_inner_texts()
    ckeys = A.locator(".cmp-bar").inner_text() if A.locator(".cmp-bar").count() else ""
    if crows: A.locator(".cmp-list tr").first.click(); A.wait_for_timeout(800)
    cviews = A.evaluate("(() => window.konium.state.docs.value.filter(d => /PcbDoc/.test(d.name) && d.editor && d.editor.viewport).map(d => d.editor.viewport.view))()")
    shot(A, "141-vcs-compare.png")
    if A.locator(".cmp").count(): A.get_by_role("button", name="Close Compare").click(); A.wait_for_timeout(800)
    left = A.evaluate("window.konium.state.docs.value.filter(d => d.forCompare).length")
    A.keyboard.press("Escape")
    check(f"…Document History: the board's versions with who made them ({len(hist)}); a version saved as a file ({saved1}); Restore puts it back, changed and not committed ({restored}); History › Export This Version… zips the project ({saved2[-1:]})",
          len(hist) >= 4 and any("Ben" in h for h in hist) and any("Ana" in h for h in hist) and any(re.match(r"Demo \([0-9a-f]{7}\)\.PcbDoc$", n) for n in saved1)
          and restored == "●" and re.match(r"Demo [0-9a-f]{7}\.zip:\d{4,}$", saved2[-1]))
    check(f"…History › a changed board's Compare (26.141): that version beside the board as it is, side by side at the same place and zoom ({len(cviews)} views), the differences coloured and listed ({len(crows)}: {ckeys.splitlines()[0] if ckeys else ''}); closed, the earlier version goes ({left})",
          cmp_link >= 1 and len(crows) >= 1 and len(cviews) == 2 and cviews[0] == cviews[1] and left == 0)
    b.close()

    # 26.148: the now-and-then donation ask: the day's note from konium.app (checked), Chip in... opens the tip jar's page; I've chipped in rests the ask (26.150); offline, the ask's own words
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1280, "height": 800})
    pg.on("pageerror", lambda e: errors.append(f"pageerror (donate): {e}"))
    pg.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    NOTE = "Konium Designer is a free side project with no adverts. It runs on voluntary donations, so if it has helped you, a gift of any size would be lovely."
    pg.route("**/api/ai/donate-note", lambda r: r.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps({"text": NOTE, "day": "2026-11-08"})))
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined"); pg.wait_for_timeout(600)
    started = pg.evaluate("window.konium.donate.donateCount().starts")
    pg.evaluate("window.konium.donate.showDonateAsk()"); pg.wait_for_timeout(800)
    card = pg.locator(".donate-ask")
    shown = card.inner_text() if card.count() else ""
    shot(pg, "148-donate-ask.png")
    pg.evaluate("window.__opened = []; window.open = (...a) => { window.__opened.push(String(a[0])); return null; }; 0")
    card.locator(".btn", has_text="Chip in").click(); pg.wait_for_timeout(400)
    opened = pg.evaluate("window.__opened")
    after_chip = [card.count(), bool(pg.evaluate("window.konium.donate.donateCount().gave ?? 0"))]
    pg.evaluate("window.konium.prefs.set({ offline: true })"); pg.wait_for_timeout(200)
    pg.evaluate("window.konium.donate.showDonateAsk()"); pg.wait_for_timeout(500)
    own = card.inner_text() if card.count() else ""
    card.locator(".btn", has_text="I've chipped in").click(); pg.wait_for_timeout(300)
    gave = bool(pg.evaluate("window.konium.donate.donateCount().gave ?? 0"))
    check(f"Donation ask (26.148, 26.150): starts counted ({started}); the day's note shown ({shown[:40]!r}); Chip in... opens the tip jar's page ({opened[:1]}) and closes the card, not taken as a donation ({after_chip}); offline, its own words; I've chipped in closes it and rests the ask ({gave})",
          started >= 1 and NOTE in shown and "Not now" in shown and "I've chipped in" in shown and any("ko-fi.com/konium" in str(u) for u in opened) and after_chip == [0, False]
          and "supported entirely by voluntary donations" in own and card.count() == 0 and gave)
    b.close()

    # 26.148: Place › Wire Link on the demo board in place of a +3V3 track: W1 (a Jumper part, its pads joined by a Jumper ID), the wire drawn, one step to undo; 3D draws it
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1280, "height": 800})
    pg.on("pageerror", lambda e: errors.append(f"pageerror (wire link): {e}"))
    pg.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined"); pg.wait_for_timeout(600)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(800)
    WA, WM, WB = (19448819, 17322835), (21033464, 18000000), (22618110, 17322835)
    pg.evaluate(f"""(() => {{ const e = {ED}; const i = e.doc.prims.findIndex(p => p.kind === 'track' && p.layer === 1 && p.a.x === {WA[0]} && p.a.y === {WA[1]} && p.b.x === {WB[0]} && p.b.y === {WB[1]});
      e.selection = new Set([e.keyOf(i)]); window.konium.run('edit.delete'); e.selection = new Set(); e.viewport.fitBox({{ minX: 18400000, minY: 16200000, maxX: 23700000, maxY: 19100000 }}); }})()"""); pg.wait_for_timeout(600)
    comps0 = pg.evaluate(f"{ED}.doc.components.length")
    pg.locator(".menubar-item", has_text="Place").first.click(); pg.wait_for_timeout(300)
    pg.locator(".menu-popup .menu-item", has_text="Wire Link").first.click(); pg.wait_for_timeout(400)
    for x, y in (WA, WM, WB):
        sx, sy = pg.evaluate(TO_SCREEN, [x, y])
        pg.mouse.move(sx, sy); pg.wait_for_timeout(150); pg.mouse.click(sx, sy); pg.wait_for_timeout(350)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    w = pg.evaluate(f"""(() => {{ const d = {ED}.doc; const c = d.components.find(c => c.designator === 'W1'); if (!c) return null;
      const pads = d.prims.filter(p => p.kind === 'pad' && p.component === c.index);
      return [c.pattern, c.bag.get('COMPONENTKIND'), c.bag.get('COMMENT') ?? c.comment, pads.map(p => p.jumper), pads.map(p => d.nets[p.net]?.name), d.prims.filter(p => p.kind === 'track' && p.component === c.index).length]; }})()""")
    shot(pg, "148-wire-link.png")
    pg.evaluate("window.konium.run('view.mode3d')"); pg.wait_for_timeout(3000)
    shot(pg, "148-wire-link-3d.png")
    pg.evaluate("window.konium.run('view.mode2d')"); pg.wait_for_timeout(800)
    pg.keyboard.press("Control+z"); pg.wait_for_timeout(500)
    comps2 = pg.evaluate(f"{ED}.doc.components.length")
    check(f"Wire link (26.148): Place › Wire Link from U1's +3V3 to C2's over a bend: W1 ({w}); Ctrl+Z takes it away in one step ({comps0} → {comps2})",
          w is not None and w[0] == "WIRE-LINK" and str(w[1]) == "6" and w[3] == [1, 1] and w[4] == ["+3V3", "+3V3"] and w[5] >= 2 and comps2 == comps0)
    b.close()

    # 26.163: a document in a window of its own (the board on a second monitor): its tab, menus, layer tabs and drawing
    # there; a click makes it the active document; its right-click menu, the P key's menu and a dialog open in it; cross
    # select from the sheet zooms it at once; closed, the board is back in the main window. Then on the sheet: Shift+drag
    # copies a part (R1 to the next free designator), one step to undo. A Bulgarian sheet (8-bit, no Unicode twins) reads
    # in Cyrillic; a portrait A1 sheet stands on its end.
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1300, "height": 850})
    pg.on("pageerror", lambda e: errors.append(f"pageerror (document window): {e}"))
    pg.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined"); pg.wait_for_timeout(600)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false, crossSelect: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(600)
    with pg.context.expect_page() as pi:
        pg.evaluate("window.konium.run('window.openInNewWindow')")
    pop = pi.value
    pop.on("pageerror", lambda e: errors.append(f"pageerror (document window, second window): {e}"))
    pop.set_viewport_size({"width": 1100, "height": 750}); pop.wait_for_timeout(2000)
    ptabs, mtabs = pop.locator(".doctab").all_inner_texts(), pg.locator(".doctab").all_inner_texts()
    check(f"Document window (26.163): Open In New Window moves the board to a window of its own, with its menus, layer tabs and drawing ({[t.split(chr(10))[0] for t in ptabs]}; main {[t.split(chr(10))[0] for t in mtabs]})",
          [t.split("\n")[0] for t in ptabs] == ["Demo.PcbDoc"] and not any("PcbDoc" in t for t in mtabs) and pop.locator(".viewport canvas").count() >= 1
          and pop.locator(".layerbar").count() == 1 and "Route" in pop.locator(".menubar").inner_text() and pop.title().startswith("Demo.PcbDoc"))
    vb = pop.locator(".viewport").bounding_box(); cx, cy = vb["x"] + vb["width"] / 2, vb["y"] + vb["height"] / 2
    pop.mouse.click(cx, cy); pop.wait_for_timeout(300)
    act = pg.evaluate("window.konium.state.active.value?.name")
    pop.mouse.click(cx, cy, button="right"); pop.wait_for_timeout(400)
    ctx_pop, ctx_main = pop.locator(".menu-popup").count(), pg.locator(".menu-popup").count()
    pop.keyboard.press("Escape"); pop.wait_for_timeout(200)
    pop.keyboard.press("p"); pop.wait_for_timeout(400)
    chain_pop = pop.locator(".menu-popup").count()
    pop.keyboard.press("Escape"); pop.wait_for_timeout(200)
    pg.evaluate("window.konium.run('ad:PCB:DesignOptions')"); pop.wait_for_timeout(600)
    dlg_pop, dlg_main = pop.locator(".dlg").count(), pg.locator(".dlg").count()
    pop.keyboard.press("Escape"); pop.wait_for_timeout(300)
    check(f"…a click there makes it the active document ({act}); its right-click menu ({ctx_pop}, main {ctx_main}), the P key's menu ({chain_pop}) and Board Options ({dlg_pop}, main {dlg_main}) open in that window",
          act == "Demo.PcbDoc" and ctx_pop >= 1 and ctx_main == 0 and chain_pop == 1 and dlg_pop == 1 and dlg_main == 0 and pop.locator(".dlg").count() == 0)
    pg.evaluate("window.konium.prefs.set({ crossSelect: true, crossSelectBehaviour: 'Zoom' })")
    st = pg.locator(".stage").bounding_box(); pg.mouse.click(st["x"] + 30, st["y"] + 30); pg.wait_for_timeout(300)
    cam0 = pg.evaluate("(() => { const d = window.konium.state.docs.value.find(x => /PcbDoc$/i.test(x.name)); const c = d.editor.viewport.cam; return [c.cx, c.cy, c.scale]; })()")
    pg.evaluate(f"(() => {{ const e = {ED}; const c = e.doc.objects.find(o => o.kind === 'component' && o.designator === 'J1'); e.select(['o' + c.index]); window.konium.state.tick.value++; }})()"); pg.wait_for_timeout(800)
    cam1 = pg.evaluate("(() => { const d = window.konium.state.docs.value.find(x => /PcbDoc$/i.test(x.name)); const e = d.editor; const c = e.viewport.cam; return [c.cx, c.cy, c.scale, [...e.selection].map(k => e.primByKey(k)).filter(p => p && p.component >= 0).map(p => e.doc.components[p.component].designator).filter((v, i, a) => a.indexOf(v) === i)]; })()")
    shot(pop, "163-document-window.png")
    check(f"…Cross Select Mode (Zoom): J1 picked on the sheet is selected on the board in the other window and shown there at once ({cam1[3]}; zoom {cam0[2]:.2e} → {cam1[2]:.2e})",
          cam1[3] == ["J1"] and cam1[2] > cam0[2] * 1.5)
    pg.evaluate("window.konium.prefs.set({ crossSelect: false, crossSelectBehaviour: 'Select' })")
    pop.close(); pg.wait_for_timeout(1500)
    back = [t.split("\n")[0] for t in pg.locator(".doctab").all_inner_texts()]
    check(f"…its window closed, the board is back among the main window's tabs ({back})", "Demo.PcbDoc" in back)
    # Shift+drag copy on the sheet
    pg.locator(".doctab", has_text="Demo.SchDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(600)
    DES = f"{ED}.doc.objects.filter(o => o.kind === 'component').map(o => o.designator)"
    n0 = len(pg.evaluate(DES))
    r1 = pg.evaluate(f"(() => {{ const e = {ED}; const o = e.doc.objects.find(o => o.kind === 'component' && o.designator === 'R1'); e.clearSelection(); const b = e.boundsOf(['o' + o.index]); e.zoomToBox(b, 30000000); return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]; }})()"); pg.wait_for_timeout(300)
    sx, sy = pg.evaluate(TO_SCREEN, r1)
    pg.keyboard.down("Shift"); pg.mouse.move(sx, sy); pg.mouse.down(); pg.mouse.move(sx + 160, sy + 60, steps=10); pg.wait_for_timeout(150); pg.mouse.up(); pg.keyboard.up("Shift"); pg.wait_for_timeout(400)
    des = pg.evaluate(DES)
    pg.keyboard.press("Control+z"); pg.wait_for_timeout(400)
    check(f"Shift+drag (26.163): a copy of R1 lands where the button is let go, its designator the next free one ({des[-1] if des else None}); Ctrl+Z takes it away ({n0} → {len(des)} → {len(pg.evaluate(DES))})",
          len(des) == n0 + 1 and re.match(r"^R\d+$", des[-1] or "") and des[-1] != "R1" and des.count(des[-1]) == 1 and len(pg.evaluate(DES)) == n0)
    # A Bulgarian sheet written in code page 1251, portrait A1
    lines = ["|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=3", "|RECORD=31|SHEETSTYLE=3|WORKSPACEORIENTATION=1|BORDERON=T",
             "|RECORD=4|LOCATION.X=200|LOCATION.Y=3000|COLOR=0|FONTID=1|TEXT=ЗАХРАНВАНЕ 12 V|OWNERPARTID=-1", "|RECORD=4|LOCATION.X=200|LOCATION.Y=2900|COLOR=0|FONTID=1|TEXT=Входове|OWNERPARTID=-1"]
    raw = ("\r\n".join(lines) + "\r\n").encode("cp1251")
    pg.evaluate("(a) => window.konium.openBatch([{ name: 'Supply.SchDoc', bytes: Uint8Array.from(atob(a), c => c.charCodeAt(0)) }])", base64.b64encode(raw).decode()); pg.wait_for_timeout(1500)
    got = pg.evaluate(f"(() => {{ const e = {ED}; return [e.doc.records.filter(r => r.bag && r.bag.int('RECORD', -1) === 4).map(r => r.bag.get('TEXT')), e.doc.sheet.width, e.doc.sheet.height]; }})()")
    pg.evaluate("window.konium.run('view.fitDocument')"); pg.wait_for_timeout(500)
    shot(pg, "163-cyrillic-portrait.png")
    check(f"Text in a Windows code page (26.163): a sheet written on a Bulgarian system reads in Cyrillic ({got[0]}); portrait A1 stands on its end ({got[1] // 100000} × {got[2] // 100000})",
          got[0] == ["ЗАХРАНВАНЕ 12 V", "Входове"] and got[1] == 2230 * 100000 and got[2] == 3150 * 100000)
    b.close()

    # 26.164: DipTrace both ways — the unit test's board and schematic (made up from DipTrace's published XML description)
    # opened as one project (its sheet, board and libraries, nets as DipTrace has them, the net port a power port); the
    # demo project through File › Export › DipTrace (a schematic, a board and a component library), opened again.
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1300, "height": 850})
    pg.on("pageerror", lambda e: errors.append(f"pageerror (DipTrace): {e}"))
    pg.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined"); pg.wait_for_timeout(600)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    src164 = open(os.path.join(os.path.dirname(__file__), "..", "diptrace164.test.ts")).read()
    lib164 = re.search(r"const LIB = `(.*?)`;", src164, re.S).group(1)
    brd164 = re.search(r"const BOARD = `(.*?)`;", src164, re.S).group(1).replace("${LIB}", lib164)
    sch164 = re.search(r"const SCHEMATIC = `(.*?)`;", src164, re.S).group(1).replace("${LIB}", lib164)
    pg.evaluate("([a, b]) => window.konium.openBatch([{ name: 'Probe.dchxml', path: 'Probe.dchxml', bytes: new TextEncoder().encode(a) }, { name: 'Probe.dipxml', path: 'Probe.dipxml', bytes: new TextEncoder().encode(b) }])", [sch164, brd164])
    for _ in range(40):
        pg.wait_for_timeout(500)
        if pg.evaluate("window.konium.state.projects.value.some(p => p.name === 'Probe.PrjPcb')"): break
    docs164 = pg.evaluate("(() => { const p = window.konium.state.projects.value.find(p => p.name === 'Probe.PrjPcb'); return p ? p.prj.documents : []; })()")
    check(f"File › Open DipTrace XML (26.164): a schematic and a board of one name one project, with its libraries ({docs164})",
          sorted(d.split('/')[-1].split(chr(92))[-1] for d in docs164) == ["Probe.PcbDoc", "Probe.PcbLib", "Probe.SchDoc", "Probe.SchLib"])
    if pg.locator(".doctab", has_text="Probe.PcbDoc").count(): pg.locator(".doctab", has_text="Probe.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(800)
    brdinfo = pg.evaluate("(() => { const d = window.konium.state.docs.value.find(x => x.name === 'Probe.PcbDoc'); if (!d) return null; const doc = d.editor.doc; return [doc.components.map(c => c.designator).sort(), doc.prims.filter(q => q.kind === 'via').length, doc.polygons.length, doc.nets.map(n => n.name).sort()]; })()")
    pg.evaluate("window.konium.run('view.fitDocument')"); pg.wait_for_timeout(600)
    shot(pg, "164-diptrace-board.png")
    check(f"…the board: its components, the trace's via and the static via, the copper pour, the nets ({brdinfo})",
          brdinfo is not None and brdinfo[0] == ["J1", "R1"] and brdinfo[1] == 2 and brdinfo[2] == 1 and brdinfo[3] == ["GND", "VIN"])
    if pg.locator(".doctab", has_text="Probe.SchDoc").count(): pg.locator(".doctab", has_text="Probe.SchDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(800)
    schinfo = pg.evaluate("(() => { const d = window.konium.state.docs.value.find(x => x.name === 'Probe.SchDoc'); if (!d) return null; const o = d.editor.doc.objects; return [o.filter(q => q.kind === 'component').map(q => q.designator).sort(), o.filter(q => q.kind === 'power').map(q => q.text), o.filter(q => q.kind === 'noerc').length, o.filter(q => q.kind === 'wire').length]; })()")
    pg.evaluate("window.konium.run('view.fitDocument')"); pg.wait_for_timeout(600)
    shot(pg, "164-diptrace-sheet.png")
    check(f"…the sheet: its parts, the net port a power port of its net, the not-connected mark, the wire ({schinfo})",
          schinfo is not None and schinfo[0] == ["R1", "R2"] and schinfo[1] == ["VIN"] and schinfo[2] == 1 and schinfo[3] >= 1)
    # The demo project as DipTrace's XML
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(500)
    pg.evaluate("window.konium.run('file.exportDiptrace')"); pg.wait_for_timeout(400)
    ew = pg.locator(".dlg", has_text="Export Wizard")
    check("File › Export › DipTrace opens the Export Wizard on its type", ew.count() == 1 and "DipTrace" in ew.locator("[role=option][aria-selected=true]").inner_text())
    pg.evaluate("""window.__zip = null; window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, createWritable: async () => ({
      write: async (b) => { const u = b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); window.__zip = Array.from(u); },
      close: async () => {} }) }); true""")
    if ew.get_by_role("button", name="None", exact=True).count(): ew.get_by_role("button", name="None", exact=True).click(); pg.wait_for_timeout(150)
    ew.get_by_role("button", name="Export", exact=True).click()
    for _ in range(60):
        pg.wait_for_timeout(500)
        if pg.evaluate("window.__zip !== null"): break
    raw = pg.evaluate("window.__zip") or []
    names, dz = [], None
    try: dz = zipfile.ZipFile(io.BytesIO(bytes(raw))); names = dz.namelist()
    except Exception as e: print("zip:", e)
    dsch = [n for n in names if n.endswith(".dchxml")]; dbrd = [n for n in names if n.endswith(".dipxml")]
    check(f"…the zip: DipTrace's schematic, board and component library ({names})", bool(dsch) and bool(dbrd) and any(n.endswith(".elixml") for n in names)
          and b'<Source Type="DipTrace-Schematic"' in dz.read(dsch[0])[:300] and b'<Source Type="DipTrace-PCB"' in dz.read(dbrd[0])[:300])
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    if dsch and dbrd:
        pg.evaluate("([a, b]) => window.konium.openBatch([{ name: 'Back164.dchxml', bytes: new Uint8Array(a) }, { name: 'Back164.dipxml', bytes: new Uint8Array(b) }])", [list(dz.read(dsch[0])), list(dz.read(dbrd[0]))])
        for _ in range(40):
            pg.wait_for_timeout(500)
            if pg.evaluate("window.konium.state.projects.value.some(p => p.name === 'Back164.PrjPcb')"): break
        docs = pg.evaluate("(() => { const p = window.konium.state.projects.value.find(p => p.name === 'Back164.PrjPcb'); return p ? p.prj.documents : []; })()")
        check(f"…opened again: imported as a project, its sheets, board and libraries ({len(docs)} documents)", any(d.endswith('.PcbDoc') for d in docs) and sum(d.endswith('.SchDoc') for d in docs) == 3 and any(d.endswith('.SchLib') for d in docs))
    b.close()

    # 26.165: EAGLE's files kept — the demo project exported as EAGLE's files, read back in, and exported again
    # unchanged: the same .sch and .brd, byte for byte, under their own name.
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1300, "height": 850})
    pg.on("pageerror", lambda e: errors.append(f"pageerror (EAGLE kept): {e}"))
    pg.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined"); pg.wait_for_timeout(600)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    def export_zip(cmd):
        pg.evaluate(f"window.konium.run('{cmd}')"); pg.wait_for_timeout(400)
        dlg = pg.locator(".dlg", has_text="Export Wizard")
        pg.evaluate("""window.__zip = null; window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, createWritable: async () => ({
          write: async (b) => { const u = b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); window.__zip = Array.from(u); },
          close: async () => {} }) }); true""")
        if dlg.get_by_role("button", name="None", exact=True).count(): dlg.get_by_role("button", name="None", exact=True).click(); pg.wait_for_timeout(150)
        dlg.get_by_role("button", name="Export", exact=True).click()
        for _ in range(60):
            pg.wait_for_timeout(500)
            if pg.evaluate("window.__zip !== null"): break
        pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
        try: return zipfile.ZipFile(io.BytesIO(bytes(pg.evaluate("window.__zip") or [])))
        except Exception as e: print("zip:", e); return None
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(500)
    z1 = export_zip("file.exportEagle")
    n1 = z1.namelist() if z1 else []
    s1 = [n for n in n1 if n.endswith(".sch")]; b1 = [n for n in n1 if n.endswith(".brd")]
    if s1 and b1:
        pg.evaluate("([a, b]) => window.konium.openBatch([{ name: 'Back165.sch', bytes: new Uint8Array(a) }, { name: 'Back165.brd', bytes: new Uint8Array(b) }])", [list(z1.read(s1[0])), list(z1.read(b1[0]))])
        for _ in range(40):
            pg.wait_for_timeout(500)
            if pg.evaluate("window.konium.state.projects.value.some(p => p.name === 'Back165.PrjPcb')"): break
        pg.wait_for_timeout(800)
        if pg.locator(".doctab", has_text="Back165.PcbDoc").count(): pg.locator(".doctab", has_text="Back165.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(500)
        z2 = export_zip("file.exportEagle")
        n2 = z2.namelist() if z2 else []
        s2 = [n for n in n2 if n.endswith(".sch")]; b2 = [n for n in n2 if n.endswith(".brd")]
        check(f"EAGLE kept (26.165): read in and exported again unchanged, the .sch and .brd are EAGLE's files byte for byte, under their own name ({n2})",
              bool(s2) and bool(b2) and s2[0].endswith("Back165.sch") and b2[0].endswith("Back165.brd") and z2.read(s2[0]) == z1.read(s1[0]) and z2.read(b2[0]) == z1.read(b1[0]))
    else: check("EAGLE kept (26.165): the first export", False)
    b.close()

    # 26.166: Export Wizard › EasyEDA Pro Project — the demo project as one .epro, opened again (in a fresh window) as a project
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1300, "height": 850})
    pg.on("pageerror", lambda e: errors.append(f"pageerror (EasyEDA Pro export): {e}"))
    pg.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined"); pg.wait_for_timeout(600)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(500)
    pg.evaluate("window.konium.run('file.exportEasyedaPro')"); pg.wait_for_timeout(400)
    dlg = pg.locator(".dlg", has_text="Export Wizard")
    sel = dlg.locator(".np-item.on").inner_text() if dlg.locator(".np-item.on").count() else ""
    pg.evaluate("""window.__zip = null; window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, createWritable: async () => ({
      write: async (b) => { const u = b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); window.__zip = Array.from(u); },
      close: async () => {} }) }); true""")
    if dlg.get_by_role("button", name="None", exact=True).count(): dlg.get_by_role("button", name="None", exact=True).click(); pg.wait_for_timeout(150)
    dlg.get_by_role("button", name="Export", exact=True).click()
    for _ in range(60):
        pg.wait_for_timeout(500)
        if pg.evaluate("window.__zip !== null"): break
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    names, inner, epro = [], [], b""
    try:
        z = zipfile.ZipFile(io.BytesIO(bytes(pg.evaluate("window.__zip") or []))); names = z.namelist()
        epro = z.read([n for n in names if n.endswith(".epro")][0]); inner = zipfile.ZipFile(io.BytesIO(epro)).namelist()
    except Exception as e: print("zip:", e)
    check(f"File › Export › EasyEDA Pro... (26.166): the wizard on EasyEDA Pro Project ({sel}), one .epro: project.json, the pages, the board, symbols, footprints ({names}, {len(inner)} files)",
          sel == "EasyEDA Pro Project" and names == ["Demo/Demo.epro"] and "project.json" in inner and sum(n.endswith(".esch") for n in inner) == 3
          and sum(n.endswith(".epcb") for n in inner) == 1 and any(n.endswith(".esym") for n in inner) and any(n.endswith(".efoo") for n in inner))
    b.close()
    if epro:
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        pg = b.new_context(viewport={"width": 1300, "height": 850}).new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror (EasyEDA Pro back): {e}"))
        pg.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
        pg.goto(URL); pg.wait_for_function("window.konium !== undefined"); pg.wait_for_timeout(600)
        pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
        pg.evaluate("(a) => window.konium.openBatch([{ name: 'Back166.epro', bytes: new Uint8Array(a) }])", list(epro))
        docs = []
        for _ in range(40):
            pg.wait_for_timeout(500)
            docs = pg.evaluate("(() => { const p = window.konium.state.projects.value.find(p => p.prj.documents.some(d => /\\.PcbDoc$/i.test(d))); return p ? p.prj.documents : []; })()")
            if docs: break
        pg.wait_for_timeout(800)
        check(f"…opened again: an EasyEDA Pro project, its three sheets, board and libraries ({docs})",
              any(d.endswith(".PcbDoc") for d in docs) and sum(d.endswith(".SchDoc") for d in docs) == 3 and any(d.endswith(".SchLib") for d in docs) and any(d.endswith(".PcbLib") for d in docs))
        b.close()
    else: check("EasyEDA Pro export (26.166): the .epro", False)

    # 26.167: Specctra both ways — the demo board as a Specctra design, and a session of its routes (as a router writes them) read back onto it
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1300, "height": 850})
    pg.on("pageerror", lambda e: errors.append(f"pageerror (Specctra): {e}"))
    pg.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined"); pg.wait_for_timeout(600)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(500)
    pg.evaluate("window.konium.run('file.exportSpecctra')"); pg.wait_for_timeout(400)
    dlg = pg.locator(".dlg", has_text="Export Wizard")
    sel = dlg.locator(".np-item.on").inner_text() if dlg.locator(".np-item.on").count() else ""
    pg.evaluate("""window.__zip = null; window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, createWritable: async () => ({
      write: async (b) => { const u = b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); window.__zip = Array.from(u); },
      close: async () => {} }) }); true""")
    if dlg.get_by_role("button", name="None", exact=True).count(): dlg.get_by_role("button", name="None", exact=True).click(); pg.wait_for_timeout(150)
    dlg.get_by_role("button", name="Export", exact=True).click()
    for _ in range(60):
        pg.wait_for_timeout(500)
        if pg.evaluate("window.__zip !== null"): break
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    names, dsn = [], ""
    try:
        z = zipfile.ZipFile(io.BytesIO(bytes(pg.evaluate("window.__zip") or []))); names = z.namelist()
        dsn = z.read([n for n in names if n.endswith(".dsn")][0]).decode()
    except Exception as e: print("zip:", e)
    check(f"File › Export › Specctra Design... (26.167): the wizard on Specctra Design ({sel}), the board as a .dsn ({names}, {dsn.count('(place ')} parts, {dsn.count('(net ')} nets)",
          sel == "Specctra Design (Autorouter)" and names == ["Demo/Demo.dsn"] and dsn.lstrip().startswith("(pcb") and dsn.count("(place ") == 4 and "(boundary" in dsn and "(wiring" in dsn)
    # A session of the design's own routes (as Freerouting writes one: tenths of a µm), opened with the board in front
    t = lambda v: str(round(float(v) * 10))
    bynet = {}
    for m in re.finditer(r'\(wire \(path (\S+) ([-\d. ]+)\) \(net ("[^"]*"|\S+?)\)', dsn):
        v = m.group(2).split()
        bynet.setdefault(m.group(3), []).append(f"(wire (path {m.group(1)} {' '.join(t(x) for x in v)}))")
    for m in re.finditer(r'\(via ("[^"]*"|\S+) ([-\d.]+) ([-\d.]+) \(net ("[^"]*"|\S+?)\)', dsn):
        bynet.setdefault(m.group(4), []).append(f"(via {m.group(1)} {t(m.group(2))} {t(m.group(3))})")
    ses = "(session Demo.ses (base_design Demo.dsn) (routes (resolution um 10) (network_out " + " ".join(f"(net {n} {' '.join(l)})" for n, l in bynet.items()) + ")))"
    ROUTED = """(() => { const d = window.konium.state.active.value.editor.doc; let n = 0, len = 0;
      for (const q of d.prims) { if ((q.kind !== 'track' && q.kind !== 'arc' && q.kind !== 'via') || (q.component >= 0 && q.component < d.components.length) || q.net < 0 || q.net >= d.nets.length || (q.kind !== 'via' && q.polygon >= 0 && q.polygon < d.polygons.length)) continue;
        if (q.kind === 'via') { n++; continue; } len += q.kind === 'track' ? Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y) : q.r * ((((q.end - q.start) % 360) + 360) % 360 || 360) * Math.PI / 180; }
      return [n, Math.round(len / 3937)]; })()"""
    r0 = pg.evaluate(ROUTED)
    pg.evaluate("(a) => window.konium.openBatch([{ name: 'Demo.ses', bytes: new TextEncoder().encode(a) }])", ses); pg.wait_for_timeout(1500)
    r1 = pg.evaluate(ROUTED)
    got = pg.evaluate("window.konium.state.messages.value.filter(m => m.source === 'Specctra Session').map(m => m.message).join(' | ')")
    check(f"…its session opened with the board in front (26.167): the same routes in place of the board's (vias, length in 0.01 mm: {r0} → {r1}; {got[:90]})",
          len(bynet) > 0 and r1[0] == r0[0] and abs(r1[1] - r0[1]) <= max(2, r0[1] // 500) and "Specctra session read" in got)
    b.close()

    # 26.169: konium.app a website, Konium Designer itself at app/: its pages, the download and its checksum, the contact
    # form; a link made for the app going on to it; the app reading the website's version number, What's New and manifest;
    # the two workers; a copy of the app kept on its version at the old address; files handed on to the app
    import hashlib
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    def site_page(tag):
        c = b.new_context(viewport={"width": 1366, "height": 860}, accept_downloads=True)
        c.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
        pg = c.new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror ({tag}): {e}"))
        pg.on("console", lambda m: errors.append(f"console.{m.type} ({tag}): {m.text}") if m.type == "error" else None)
        return c, pg
    c, pg = site_page("website")
    # (every page in the sitemap: the seven, the guides and their index)
    pages = [u.replace("https://konium.app/", "") for u in re.findall(r"<loc>([^<]+)</loc>", urllib.request.urlopen(SITE + "sitemap.xml").read().decode())]
    seen = {}
    for u in pages:
        pg.goto(SITE + u); pg.wait_for_timeout(200)
        seen[u or "/"] = [("Konium Designer" in pg.title()), pg.locator("footer").inner_text().count("not affiliated"), pg.locator("h1").count()]
    pg.set_viewport_size({"width": 390, "height": 844})
    for u in pages:
        pg.goto(SITE + u); pg.wait_for_timeout(150)
        seen[u or "/"].append(pg.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    pg.set_viewport_size({"width": 1366, "height": 860})
    check(f"the website's {len(pages)} pages (26.169), the seven and the guides: each titled, one heading, the trademark line, no sideways scroll on a phone ({[k for k, v in seen.items() if v != [True, 1, 1, True]] or 'all'})",
          len(pages) == 19 and pages[:7] == ["", "features/", "formats/", "download/", "whats-new/", "faq/", "support/"] and all(v == [True, 1, 1, True] for v in seen.values()))
    # A guide: reached from the footer, through the guides' index; its steps numbered; Install going to the app's install window
    pg.goto(SITE); pg.locator("footer a", has_text="Guides").click(); pg.wait_for_url(SITE + "guides/")
    pg.locator("main a", has_text="Convert Altium to KiCad").click(); pg.wait_for_url(SITE + "guides/altium-to-kicad/")
    g = pg.locator("main")
    check(f"…a guide from the footer's Guides: Convert Altium to KiCad, its two sets of steps numbered, the Formats table's row for KiCad, Install leading to the app ({g.locator('ol.steps').count()} lists, {g.locator('ol.steps li').count()} steps)",
          "Altium" in pg.title() and g.locator("ol.steps").count() == 2 and g.locator("ol.steps li").count() == 11 and "setting for setting" in g.inner_text()
          and g.locator("a.install").first.get_attribute("href") == "../../app/?install" and pg.locator("header nav a").count() == 6)
    scope = pg.evaluate("navigator.serviceWorker.ready.then((r) => r.scope)")
    pg.goto(SITE + "faq/")
    faq = pg.locator("main").inner_text()
    check(f"…its worker for the whole site ({scope}); the FAQ answers whether it works only online, and lists every connection", scope == SITE and "Does Konium Designer only work online?" in faq and "Visit count" in faq and "Version control" in faq)
    # The download: the app's own file, under its version's name, its checksum as the page gives it
    ver = json.load(urllib.request.urlopen(SITE + "version.json"))["version"]
    pg.goto(SITE + "download/")
    shown = pg.locator("code.hash").first.inner_text().strip()
    with pg.expect_download() as dl:
        pg.locator("a[download]").click()
    got = open(dl.value.path(), "rb").read()
    check(f"Download Konium-{ver}.html: the app's file under its version's name, its SHA-256 as the page shows it ({dl.value.suggested_filename}, {len(got)} bytes)",
          dl.value.suggested_filename == f"Konium-{ver}.html" and hashlib.sha256(got).hexdigest() == shown and got == urllib.request.urlopen(SITE + "app/index.html").read())
    # The contact form: to the report service as Help › Contact the Author sends it
    sent = []
    pg.route(SITE + "api/report", lambda r: (sent.append(r.request.post_data_buffer or b""), r.fulfill(status=200, content_type="application/json", body='{"ok":true,"id":"smoke"}'))[1])
    pg.goto(SITE + "support/")
    pg.fill("form.contact textarea[name=text]", "Smoke test message"); pg.click("form.contact button[type=submit]"); pg.wait_for_timeout(200)
    no_email = pg.locator("form.contact .status").inner_text()
    pg.fill("form.contact input[name=email]", "someone@example.org"); pg.select_option("form.contact select[name=topic]", "A security problem, reported privately")
    pg.click("form.contact button[type=submit]"); pg.wait_for_timeout(600)
    body = sent[0].decode("utf-8", "replace") if sent else ""
    check(f"the website's contact form: an address asked for first ({no_email!r}), then the message sent as a contact with its topic ({pg.locator('form.contact .status').inner_text()!r})",
          "email address is needed" in no_email and len(sent) == 1 and 'name="kind"\r\n\r\ncontact' in body and 'name="version"\r\n\r\nwebsite' in body
          and "A security problem, reported privately" in body and "someone@example.org" in body and "Smoke test message" in body and pg.locator("form.contact .status").inner_text().startswith("Sent"))
    # A link made for the app (?debug) goes on to it; the app reads the website's files
    asked = []
    pg.on("request", lambda r: asked.append(r.url) if r.url.endswith(("version.json", "whats-new.json")) else None)
    pg.goto(SITE + "?debug"); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(2500)
    at = pg.url
    manifest = pg.evaluate("document.querySelector('link[rel=manifest]').href")
    for _ in range(40):
        regs = pg.evaluate("navigator.serviceWorker.getRegistrations().then((l) => l.map((r) => r.scope + (r.active ? ' active' : '')).sort())")
        if len(regs) == 2 and all(r.endswith("active") for r in regs): break
        pg.wait_for_timeout(500)
    keys = pg.evaluate("caches.keys()")
    check(f"a link made for the app goes on to it ({at}); the app reads the website's version number and What's New ({sorted(set(asked))}) and its manifest ({manifest}); two workers ({regs}), each with its cache ({keys})",
          at == SITE + "app/?debug" and manifest == SITE + "manifest.webmanifest" and set(asked) >= {SITE + "version.json", SITE + "whats-new.json"} and all(a.startswith(SITE) and "/app/" not in a for a in asked)
          and regs == [SITE + " active", SITE + "app/ active"] and any(k.startswith("konium-app-v") for k in keys) and any(k.startswith("konium-site-v") for k in keys))
    # The website's Install: the app opened with ?install shows its install window at once
    pg.goto(SITE + "app/?install&debug"); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(800)
    gk = pg.locator(".get-body").count()
    pg.goto(SITE + "download/")
    inst = [h for h in pg.locator("a.install").evaluate_all("(l) => l.map((a) => a.href + (a.classList.contains('primary') ? ' gold' : ''))")]
    check(f"the website's Install, gold in the header and on the page: Konium Designer opened with its install window ({inst})", gk == 1 and inst == [SITE + "app/?install gold"] * 2)
    pg.goto(SITE + "app/?debug"); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(800)
    # The hand-over the website's page makes for an app installed before 26.169 that opened files at the old address: read
    # once at the start and cleared. (Its files themselves aren't tried here: this browser fails reading any file handle back
    # from storage, the app's own recent folders' too)
    pg.evaluate("""new Promise((res, rej) => { const r = indexedDB.open('konium-launch', 1); r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => { const db = r.result, t = db.transaction('files', 'readwrite'); t.objectStore('files').put({ at: Date.now(), files: [] }, 'handles'); t.oncomplete = () => { db.close(); res(); }; t.onerror = () => rej(t.error); };
      r.onerror = () => rej(r.error); })""")
    pg.reload(); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1500)
    left = pg.evaluate("indexedDB.databases().then((l) => l.some((d) => d.name === 'konium-launch'))")
    check(f"…the website's hand-over of launched files read once at the start and cleared (left: {left})", left is False)
    c.close()
    # The app as it was kept here up to 26.168 (Offline, or updates off): still served here, on its version, by the website's worker
    c, pg = site_page("kept on its version")
    pg.goto(SITE + "version.json")
    pg.evaluate("""(async () => {
      const page = () => new Response('<!doctype html><title>Kept</title><p id="kept">Konium 26.168, kept on its version</p>', { headers: { 'content-type': 'text/html' } });
      const old = await caches.open('konium-v26.168'); await old.put(location.origin + '/', page()); await old.put(location.origin + '/index.html', page());
      await (await caches.open('konium-flags')).put(location.origin + '/__pinned', new Response('1'));
    })()""")
    pg.goto(SITE); pg.evaluate("navigator.serviceWorker.ready.then(() => true)"); pg.wait_for_timeout(1000)
    pg.goto(SITE); kept = pg.locator("#kept").count()
    keys = pg.evaluate("caches.keys()")
    pg.evaluate("caches.open('konium-flags').then((c) => c.delete(location.origin + '/__pinned'))")
    pg.goto(SITE); back = pg.locator("h1").inner_text() if pg.locator("h1").count() else ""
    check(f"a copy kept on its version at the old address: still served there by the website's worker, its old cache gone ({keys}); updates back on, the website ({back!r})",
          kept == 1 and "konium-v26.168" not in keys and back == "Konium Designer")
    c.close()
    # …and not kept on its version: the app at app/ kept for offline from the start
    c, pg = site_page("moved")
    pg.goto(SITE + "version.json")
    pg.evaluate("caches.open('konium-v26.168').then((c) => c.put(location.origin + '/index.html', new Response('<!doctype html><p>26.168</p>', { headers: { 'content-type': 'text/html' } })))")
    pg.goto(SITE); pg.evaluate("navigator.serviceWorker.ready.then(() => true)"); pg.wait_for_timeout(1500)
    app_kept = pg.evaluate("caches.keys().then(async (ks) => { const k = ks.find((x) => x.startsWith('konium-site-v')); const r = k && await (await caches.open(k)).match(location.origin + '/app/'); return [ks, r ? (await r.text()).includes('id=\"app\"') : false]; })")
    check(f"…not kept on its version: the app at app/ kept for offline at once, the old cache gone ({app_kept[0]})", app_kept[1] and "konium-v26.168" not in app_kept[0])
    # Offline: the website's pages, and the app before its own worker has run
    n0 = len(errors); c.set_offline(True)
    pg.goto(SITE + "features/"); feat = pg.locator("h1").inner_text() if pg.locator("h1").count() else ""
    pg.goto(SITE + "app/?debug"); pg.wait_for_function("window.konium !== undefined", timeout=60000)
    check(f"…offline: the website's pages from its worker ({feat!r}), and the app at app/ before its own worker has run", feat == "Features" and pg.url == SITE + "app/?debug")
    c.set_offline(False)
    errors[n0:] = [e for e in errors[n0:] if "Failed to load resource" not in e and "fetching the script" not in e]  # (offline: the pictures not yet seen, the visit count, the app's worker asked for again)
    c.close()

    # 26.170: the review round's fixes. The library editors with the Properties and Requirements panels open; a requirements
    # document and a diagram made to run script; script in an attribute refused by the page; a panel made to fail
    import base64
    c, pg = site_page("26.170")
    pg.on("dialog", lambda d: d.dismiss())
    pg.goto(SITE + "app/?debug"); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(3000)
    libs = {}
    for name in ("Demo.PcbLib", "Demo.SchLib"):
        pg.evaluate("(n) => { const s = window.konium.state; window.konium.openProjectDocument(s.projects.value[0], n); }", name); pg.wait_for_timeout(1500)
        pg.evaluate("window.konium.dock.showPanel('inspector')"); pg.wait_for_timeout(300)
        pg.evaluate("window.konium.run('edit.selectAll')"); pg.wait_for_timeout(700)
        got = [pg.evaluate("window.konium.state.active.value?.editor?.selection.size ?? -1"), pg.locator(".panel.inspector").count()]
        pg.evaluate("window.konium.dock.showPanel('requirements')"); pg.wait_for_timeout(500)
        libs[name] = got + [pg.locator(".crash").count(), pg.locator(".panel-crash").count(), pg.locator(".doctab").count()]
    check(f"Library editors (26.170): Properties and Requirements open and everything selected, in the PCB library and the schematic library: Konium Designer goes on ({libs})",
          all(v[0] > 0 and v[1] == 1 and v[2] == 0 and v[3] == 0 and v[4] >= 2 for v in libs.values()))
    # A requirements document whose picture's type carries an attribute, with a web page attached
    pg.evaluate("""() => { window.__saves = []; window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, createWritable: async () => ({ write: async () => { window.__saves.push(o.suggestedName); }, close: async () => {} }) }); }""")
    web = base64.b64encode(b"<script>opener && (opener.__opened = 1)</script>").decode()
    req = {"koniumRequirements": 1, "prefix": "REQ", "rows": [{"kind": "section", "title": "General"}, {"kind": "req", "id": "REQ-001", "title": "One", "text": "x", "html": "<p>Picture <img src=\"kfile:f1\"> here</p>",
           "files": [{"id": "f1", "name": "p.png", "type": "image/png\" onerror=\"window.__ran=(window.__ran||0)+1//", "data": base64.b64encode(b"notapicture").decode(), "inline": True},
                     {"id": "f2", "name": "notes.html", "type": "text/html", "data": web}]}]}
    pg.evaluate("(t) => window.konium.openBatch([{ name: 'Crafted.ReqDoc', bytes: new TextEncoder().encode(t) }])", json.dumps(req)); pg.wait_for_timeout(2000)
    row = pg.locator("text=REQ-001").first
    if row.count(): row.click(); pg.wait_for_timeout(600)
    wins = len(c.pages)
    chip = pg.locator("text=notes.html").first
    if chip.count(): chip.click(); pg.wait_for_timeout(1200)
    got = pg.evaluate("[window.__ran ?? null, window.__opened ?? null, window.__saves, [...document.querySelectorAll('img')].filter((i) => i.hasAttribute('onerror')).length]")
    check(f"A requirements document made to run script (26.170): nothing runs as it opens, its picture's type dropped; an attached web page is saved, not opened as a page of Konium ({got}, {len(c.pages) - wins} new windows)",
          row.count() == 1 and chip.count() == 1 and got == [None, None, ["notes.html"], 0] and len(c.pages) == wins)
    # A diagram whose label holds what the label editor's cleaner let through
    label = "&lt;&lt;x&gt;img src=x onerror=&quot;window.__ran=(window.__ran||0)+1&quot;&gt;"
    dgm = f'<mxfile host="x"><diagram id="d" name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="c0" value="{label}" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="60" y="40" width="320" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>'
    pg.evaluate("(t) => window.konium.openBatch([{ name: 'Crafted.drawio', bytes: new TextEncoder().encode(t) }])", dgm); pg.wait_for_timeout(2000)
    cell = pg.locator("g.dg-cell").first
    if cell.count(): cell.dblclick(); pg.wait_for_timeout(600)
    ed = pg.locator(".dg-edit")
    held = ed.first.evaluate("(e) => [e.innerHTML, e.querySelectorAll('img, svg, script').length]") if ed.count() else None
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    check(f"A diagram's label made to run script (26.170): edited, it is text in the editor and nothing runs ({held}, ran {pg.evaluate('window.__ran ?? null')})",
          held is not None and held[0].startswith("&lt;img") and held[1] == 0 and pg.evaluate("window.__ran ?? null") is None)
    # Script in an attribute, however it got into the page: refused
    n1 = len(errors)
    pg.evaluate("document.body.insertAdjacentHTML('beforeend', '<img id=attr170 src=x onerror=\"window.__ran=1\">')"); pg.wait_for_timeout(600)
    refused = [e for e in errors[n1:] if "script-src-attr" in e]
    pg.evaluate("document.getElementById('attr170').remove()")
    check(f"The page refuses script written into an attribute (26.170) ({len(refused)} refused, ran {pg.evaluate('window.__ran ?? null')})", len(refused) == 1 and pg.evaluate("window.__ran ?? null") is None)
    errors[n1:] = [e for e in errors[n1:] if "script-src-attr" not in e and "ERR_FILE_NOT_FOUND" not in e and "Failed to load resource" not in e]
    # A panel that fails: said in its own place, the rest as it was, the panel back with Try Again
    n1 = len(errors)
    pg.evaluate("window.konium.dock.showPanel('messages')"); pg.wait_for_timeout(300)
    pg.evaluate("window.konium.dock.failing.value = 'messages'"); pg.wait_for_timeout(600)
    crash = pg.locator(".panel-crash")
    said = crash.first.inner_text().split("\n")[0] if crash.count() else ""
    alive = [pg.locator(".crash").count(), pg.locator(".doctab").count(), pg.locator(".menubar").count()]
    shot(pg, "170-panel-failed.png")
    pg.evaluate("window.konium.dock.failing.value = null")
    if crash.count(): crash.first.locator("button", has_text="Try Again").click(); pg.wait_for_timeout(500)
    check(f"A panel that fails (26.170): it says so in its own place ({said!r}), Konium Designer and its documents as they were ({alive}); Try Again brings the panel back ({pg.locator('.panel-crash').count()} failed)",
          said.startswith("The Messages panel hit an error.") and alive[0] == 0 and alive[1] >= 3 and pg.locator(".panel-crash").count() == 0)
    errors[n1:] = [e for e in errors[n1:] if "made to fail" not in e]
    c.close()

    # 26.171: a press-and-drag of a track with the mouse (Avoid Obstacles, the default): it goes, stops at another net's
    # pad, and the status bar says what stopped it
    c, pg = site_page("26.171")
    pg.goto(SITE + "app/?debug"); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(3000)
    pg.evaluate("() => { const s = window.konium.state; window.konium.openProjectDocument(s.projects.value[0], 'Demo.PcbDoc'); }"); pg.wait_for_timeout(2500)
    # VIN's long track on the top layer (13.05,7.2 to 26.3,7.2 mm), towards U1's pads 2.2 mm below it
    at = pg.evaluate("""() => {
      const ed = window.konium.state.active.value.editor, t = ed.doc.prims.find((p) => p.kind === 'track' && p.src.index === 3);
      const m = { x: (t.a.x + t.b.x) / 2 - 393701, y: t.a.y }, r = ed.viewport.host.getBoundingClientRect();
      const s = ed.viewport.cam.toScreen(m), e = ed.viewport.cam.toScreen({ x: m.x, y: m.y + 1.8 * 393701 });
      return { from: [r.left + s.x, r.top + s.y], to: [r.left + e.x, r.top + e.y], y: t.a.y, flat: t.a.y === t.b.y };
    }""")
    pg.mouse.move(*at["from"]); pg.mouse.down(); pg.mouse.move(*at["to"], steps=12); pg.wait_for_timeout(300)
    said = pg.locator(".hint").first.inner_text()
    pg.mouse.up(); pg.wait_for_timeout(400)
    got = pg.evaluate("""() => { const ed = window.konium.state.active.value.editor, t = ed.doc.prims.find((p) => p.kind === 'track' && p.src.index === 3); return { y: t.a.y, flat: t.a.y === t.b.y, undo: ed.undo.undoLabel }; }""")
    moved = (got["y"] - at["y"]) / 393701
    check(f"Dragging a track with the mouse (26.171): it goes towards another net's pads and stops clear of them ({moved:.2f} of 1.8 mm), and the status bar says at what ({said!r})",
          at["flat"] and got["flat"] and 0.2 < abs(moved) < 1.75 and got["undo"] == "Drag Track" and "stopped at a pad of " in said)
    c.close()

    # 26.172 (R16 in the making, every feature on): Tools › Power Analysis on the demo board — VIN fed by J1 at 5 V, U1 drawing
    # 0.8 A, returning on GND: the load's voltage, the picture over the board, the cursor's reading, the report
    c, pg = site_page("26.172")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(3000)
    pg.evaluate("() => { const s = window.konium.state; window.konium.openProjectDocument(s.projects.value[0], 'Demo.PcbDoc'); }"); pg.wait_for_timeout(2500)
    pg.locator(".menubar-item", has_text="Tools").first.click(); pg.wait_for_timeout(300)
    item = pg.locator(".menu-popup").last.locator(".menu-item", has_text="Power Analysis").first
    item_cls = item.get_attribute("class") or ""
    item.click(); pg.wait_for_timeout(700)
    pp = pg.locator(".powerpanel")
    first = [pp.locator("select[aria-label='Supply net']").input_value(), pp.locator("select[aria-label='Return net']").input_value(), pp.locator("select[aria-label='Source']").input_value()]
    why = pp.locator(".pw-run [role=status]").inner_text()
    pp.get_by_label("Current of U1").fill("0.8"); pp.get_by_label("Current of U1").press("Tab")
    pp.get_by_label("Voltage", exact=True).fill("5"); pp.get_by_label("Voltage", exact=True).press("Tab"); pg.wait_for_timeout(200)
    pp.get_by_role("button", name="Analyse").click()
    pg.wait_for_function("document.querySelector('.powerpanel .pw-results') !== null", timeout=90000); pg.wait_for_timeout(600)
    res = pp.locator(".pw-results").inner_text()
    row = pp.locator(".pw-results .pcbp-body .pcbp-row").first.inner_text().split("\n")
    volts = float(row[1].split()[0]) if len(row) > 1 else 0
    check(f"Power Analysis (26.172): Tools › Power Analysis on ({item_cls!r}); the panel's first guess for the demo board ({first}), what is missing said ({why!r}); analysed, U1 is left with {volts} V of 5 ({row})",
          "planned" not in item_cls and first == ["VIN", "GND", "J1"] and why == "Give the current of one load at least." and 4.95 < volts < 4.999 and row[0] == "U1"
          and "800 mA from J1" in res and "mW lost in the copper" in res)
    over = pg.evaluate(f"""(() => {{ const ed = {ED}, g = ed.scene().groups.get('analysis'); return {{ images: g ? g.images.length : -1, w: g && g.images[0] ? g.images[0].src.width : 0, layer: ed.currentLayer }}; }})()""")
    at = pg.evaluate(f"""(() => {{ const ed = {ED}, t = ed.doc.prims.find((p) => p.kind === 'track' && p.src.index === 3);
      const r = ed.viewport.host.getBoundingClientRect(), s = ed.viewport.cam.toScreen({{ x: (t.a.x + t.b.x) / 2, y: t.a.y }}); return [r.left + s.x, r.top + s.y]; }})()""")
    pg.mouse.move(at[0] - 6, at[1]); pg.mouse.move(*at); pg.wait_for_timeout(400)
    read = pg.evaluate(f"(() => {{ const h = {ED}.hud(); return h ? h.lines : []; }})()")
    shot(pg, "172-power.png")
    check(f"…the board carries the picture of the layer in front: both nets' copper ({over}); the cursor on VIN's track reads its voltage and current ({read})",
          over["images"] == 2 and over["w"] > 500 and over["layer"] == 1 and len(read) >= 2 and read[0].startswith("VIN: 4.9") and "mV from the source" in read[0] and read[1].endswith("800 mA in the track"))
    pg.evaluate("window.konium.dock.showPanel('powerAnalysis')"); pg.wait_for_timeout(300)
    pp.locator("select[aria-label='On the board']").select_option("density"); pg.wait_for_timeout(500)
    key = pp.locator(".pw-key").inner_text().replace("\n", " ")
    pg.evaluate(f"{ED}.setCurrentLayer(32)"); pg.wait_for_timeout(500)
    bottom = pg.evaluate(f"(() => {{ const g = {ED}.scene().groups.get('analysis'); return g ? g.images.length : -1; }})()")
    with pg.expect_download() as dl:
        pg.evaluate("window.konium.dock.showPanel('powerAnalysis')"); pg.wait_for_timeout(300)
        pp.get_by_role("button", name="Report...").click()
    rep = open(dl.value.path(), encoding="utf-8").read()
    check(f"…Current density has its own key ({key!r}); the bottom layer's copper drawn when it is in front ({bottom}); the report names the set-up and the load ({dl.value.suggested_filename!r})",
          "A/mm²" in key and bottom >= 1 and dl.value.suggested_filename == "Demo_PowerAnalysis.txt" and rep.startswith("Power Analysis: Demo.PcbDoc") and "Supply net      VIN" in rep and "U1" in rep and "NaN" not in rep)
    # The board edited: the picture is of copper that is no longer so, and comes off; the panel asks for another analysis
    pg.evaluate(f"{ED}.setCurrentLayer(1)"); pg.wait_for_timeout(300)
    pg.evaluate(f"(() => {{ const ed = {ED}; ed.select(['Tracks6:3']); }})()"); pg.wait_for_timeout(200)
    pg.evaluate("window.konium.run('edit.delete')"); pg.wait_for_timeout(600)
    gone = pg.evaluate(f"(() => {{ const ed = {ED}, g = ed.scene().groups.get('analysis'); return {{ images: g ? g.images.length : 0, read: (ed.hud()?.lines ?? []).filter((l) => l.includes('from the source')).length, tracks: ed.doc.prims.filter((p) => p.kind === 'track' && p.src.index === 3 && p.net !== 0xffff).length }}; }})()")
    pg.evaluate("window.konium.dock.showPanel('powerAnalysis')"); pg.wait_for_timeout(300)
    stale = pp.locator(".pw-run [role=status]").inner_text()
    check(f"…a track deleted: the picture comes off the board and the cursor reads nothing ({gone}); the panel says to analyse again ({stale!r}), its old results put away ({pp.locator('.pw-results').count()})",
          gone["images"] == 0 and gone["read"] == 0 and "analyse again" in stale and pp.locator(".pw-results").count() == 0)
    c.close()

    # 26.173 (R16 in the making, every feature on): Tools › Thermal Analysis on the demo board — U1 dissipating half a watt in
    # still air: the hottest place, the picture, the reading; then the copper's own heat with the supply of Power Analysis, and
    # the warm-up
    c, pg = site_page("26.173")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(3000)
    pg.evaluate("() => { const s = window.konium.state; window.konium.openProjectDocument(s.projects.value[0], 'Demo.PcbDoc'); }"); pg.wait_for_timeout(2500)
    pg.locator(".menubar-item", has_text="Tools").first.click(); pg.wait_for_timeout(300)
    pg.locator(".menu-popup").last.locator(".menu-item", has_text="Thermal Analysis").first.click(); pg.wait_for_timeout(700)
    tp = pg.locator(".thermalpanel")
    why = tp.locator(".pw-run [role=status]").first.inner_text()
    tp.get_by_label("Power of U1").fill("0.5"); tp.get_by_label("Power of U1").press("Tab")
    tp.get_by_label("Junction to board of U1").fill("15"); tp.get_by_label("Junction to board of U1").press("Tab"); pg.wait_for_timeout(200)
    tp.get_by_role("button", name="Analyse").click()
    pg.wait_for_function("document.querySelector('.thermalpanel .pw-results') !== null", timeout=90000); pg.wait_for_timeout(600)
    res = tp.locator(".pw-results").inner_text()
    hot = float(re.search(r"Hottest place ([\d.]+) °C", res).group(1)) if "Hottest place" in res else 0
    part = tp.locator(".pw-results .pcbp-body .pcbp-row").first.inner_text().split("\n")
    over = pg.evaluate(f"""(() => {{ const ed = {ED}, g = ed.scene().groups.get('analysis'); return {{ images: g ? g.images.length : -1, alpha: g ? g.alpha : 0 }}; }})()""")
    at = pg.evaluate(f"""(() => {{ const ed = {ED}, u = ed.doc.components.find((x) => x.designator === 'U1');
      const r = ed.viewport.host.getBoundingClientRect(), s = ed.viewport.cam.toScreen({{ x: u.at.x, y: u.at.y }}); return [r.left + s.x, r.top + s.y]; }})()""")
    pg.mouse.move(at[0] - 6, at[1]); pg.mouse.move(*at); pg.wait_for_timeout(400)
    read = pg.evaluate(f"(() => {{ const h = {ED}.hud(); return h ? h.lines : []; }})()")
    shot(pg, "173-thermal.png")
    check(f"Thermal Analysis (26.173): what is missing said first ({why!r}); U1 at half a watt in still air: the hottest place {hot} °C on the top layer, U1's board and junction ({part}), nothing out of limits",
          why.startswith("Give the dissipation of one part") and 30 < hot < 100 and "Top Layer" in res and part[0] == "U1" and part[1] == "0.5 W" and len(part) == 4
          and abs(float(part[3].split()[0]) - float(part[2].split()[0]) - 7.5) < 0.11 and "Nothing out of limits." in res and "The warmest parts: U1" in res)
    check(f"…the board carries the layer's temperatures, a little see-through ({over}); the cursor on U1 reads the place ({read})",
          over["images"] == 1 and 0.7 < over["alpha"] < 0.9 and any(re.match(r"^\d+\.\d °C, \d+\.\d above the air$", l) for l in read))
    # The copper's own heat needs a supply set up in Power Analysis: said when there is none, worked turn about when there is
    pg.evaluate("window.konium.dock.showPanel('thermalAnalysis')"); pg.wait_for_timeout(300)
    tp.locator("label", has_text="The copper's own heat").locator("input").check(); pg.wait_for_timeout(200)
    tp.get_by_role("button", name="Analyse").click(); pg.wait_for_timeout(900)
    need = " ".join(pg.locator(".toast").all_inner_texts())
    pg.evaluate("window.konium.run('power.panel')"); pg.wait_for_timeout(500)
    pp = pg.locator(".powerpanel:not(.thermalpanel)")
    pp.get_by_label("Current of U1").fill("2"); pp.get_by_label("Current of U1").press("Tab")
    pp.get_by_label("Voltage", exact=True).fill("5"); pp.get_by_label("Voltage", exact=True).press("Tab"); pg.wait_for_timeout(200)
    pg.evaluate("window.konium.dock.showPanel('thermalAnalysis')"); pg.wait_for_timeout(300)
    tp.get_by_role("button", name="Analyse").click()
    pg.wait_for_function("(document.querySelector('.thermalpanel .pw-results')?.textContent ?? '').includes('Worked with the supply')", timeout=120000); pg.wait_for_timeout(600)
    res2 = tp.locator(".pw-results").inner_text()
    hot2 = float(re.search(r"Hottest place ([\d.]+) °C", res2).group(1))
    turns = int(re.search(r"Worked with the supply (\d+) time", res2).group(1))
    pg.evaluate("window.konium.dock.showPanel('powerAnalysis')"); pg.wait_for_timeout(300)
    prow = pp.locator(".pw-results .pcbp-body .pcbp-row").first.inner_text().split("\n") if pp.locator(".pw-results").count() else []
    check(f"…the copper's own heat: without a supply set up it says so ({need[:70]!r}); with one (2 A to U1) the board is hotter ({hot2} against {hot} °C), worked turn about {turns} times, and Power Analysis shows the supply with its copper warm ({prow})",
          "needs a supply set up in Power Analysis" in need and hot2 > hot + 0.5 and "the copper's" in res2 and 2 <= turns <= 4 and len(prow) == 4 and prow[0] == "U1")
    pg.evaluate("window.konium.dock.showPanel('thermalAnalysis')"); pg.wait_for_timeout(300)
    tp.get_by_role("button", name="Warm-up").click()
    pg.wait_for_function("document.querySelector('.thermalpanel .th-warmup figcaption') !== null", timeout=120000); pg.wait_for_timeout(300)
    cap = tp.locator(".th-warmup figcaption").inner_text()
    lines = tp.locator(".th-warmup polyline").count()
    with pg.expect_download() as dl:
        tp.get_by_role("button", name="Report...").click()
    rep = open(dl.value.path(), encoding="utf-8").read()
    shot(pg, "173-warmup.png")
    check(f"…Warm-up draws the hottest place and the heated part against time ({lines} lines; {cap[:90]!r}); the report has it all ({dl.value.suggested_filename!r})",
          lines == 2 and "half way in" in cap and "time constant of" in cap and dl.value.suggested_filename == "Demo_ThermalAnalysis.txt" and rep.startswith("Thermal Analysis: Demo.PcbDoc")
          and "from the copper" in rep and "Warm-up:" in rep and "NaN" not in rep)
    c.close()

    # 26.174 (R16 in the making, every feature on): Tools › EMC Check on the demo board — its regulator's supply pins against
    # the capacitors beside them; a finding clicked goes to the place; with more room allowed, nothing found
    c, pg = site_page("26.174")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(3000)
    pg.evaluate("() => { const s = window.konium.state; window.konium.openProjectDocument(s.projects.value[0], 'Demo.PcbDoc'); }"); pg.wait_for_timeout(2500)
    pg.locator(".menubar-item", has_text="Tools").first.click(); pg.wait_for_timeout(300)
    pg.locator(".menu-popup").last.locator(".menu-item", has_text="EMC Check").first.click(); pg.wait_for_timeout(700)
    ep = pg.locator(".emcpanel")
    ep.get_by_role("button", name="Check").click()
    pg.wait_for_function("document.querySelector('.emcpanel .pw-results') !== null", timeout=60000); pg.wait_for_timeout(400)
    res = ep.locator(".pw-results").inner_text()
    heads = ep.locator(".emc-kind summary").all_inner_texts()
    found = ep.locator(".pw-issues button").all_inner_texts()
    ep.locator(".pw-issues button").first.click(); pg.wait_for_timeout(700)
    sel = pg.evaluate(f"(() => {{ const ed = {ED}; return [...ed.selection].map((k) => {{ const p = ed.primByKey(k); return p ? p.kind + ' ' + (p.name ?? '') : k; }}); }})()")
    shot(pg, "174-emc.png")
    check(f"EMC Check (26.174): the demo board's one finding, under its rule ({heads}): {found}; clicked, its pads are selected ({sel})",
          heads == ["Supply pins with no capacitor close by (1)"] and len(found) == 1 and found[0].startswith("U1: 3 supply pins") and "C1, is 14 mm away" in found[0]
          and "1 to look at." in res and "and 1 IC;" in res and len(sel) == 3 and all(x.startswith("pad ") for x in sel))
    pg.evaluate("window.konium.dock.showPanel('emcCheck')"); pg.wait_for_timeout(300)
    ep.get_by_label("Decoupling distance").fill("30"); ep.get_by_label("Decoupling distance").press("Tab"); pg.wait_for_timeout(200)
    ep.get_by_role("button", name="Check").click(); pg.wait_for_timeout(1200)
    res2 = ep.locator(".pw-results").inner_text()
    with pg.expect_download() as dl:
        ep.get_by_role("button", name="Report...").click()
    rep = open(dl.value.path(), encoding="utf-8").read()
    check(f"…with 30 mm allowed nothing is found ({res2[:40]!r}); the report ({dl.value.suggested_filename!r})",
          "Nothing found." in res2 and ep.locator(".pw-issues").count() == 0 and dl.value.suggested_filename == "Demo_EMCCheck.txt" and rep.startswith("EMC Check: Demo.PcbDoc") and "Nothing found." in rep)
    c.close()

    # 26.175 (R16 in the making, every feature on): Tools › Supply Impedance on the demo board — VIN against GND from U1,
    # its one capacitor given a value; the curve against the target; then U1 as a switching part and the emission estimate
    c, pg = site_page("26.175")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(3000)
    pg.evaluate("() => { const s = window.konium.state; window.konium.openProjectDocument(s.projects.value[0], 'Demo.PcbDoc'); }"); pg.wait_for_timeout(2500)
    pg.locator(".menubar-item", has_text="Tools").first.click(); pg.wait_for_timeout(300)
    pg.locator(".menu-popup").last.locator(".menu-item", has_text="Supply Impedance").first.click(); pg.wait_for_timeout(700)
    zp = pg.locator(".pdnpanel")
    first = [zp.locator("select[aria-label='Supply net']").input_value(), zp.locator("select[aria-label='Ground net']").input_value(), zp.locator("select[aria-label='Source']").input_value()]
    unknown = zp.locator(".pcbp-row.pw-bad").count()
    zp.get_by_label("Value of C1").fill("10u"); zp.get_by_label("Value of C1").press("Tab")
    zp.get_by_label("Supply voltage").fill("5"); zp.get_by_label("Supply voltage").press("Tab"); pg.wait_for_timeout(200)
    aim = zp.locator("section[aria-label='Target and range'] p").first.inner_text()
    zp.get_by_role("button", name="Analyse").click()
    pg.wait_for_function("document.querySelector('.pdnpanel .pw-results') !== null", timeout=90000); pg.wait_for_timeout(400)
    res = zp.locator(".pw-results").inner_text()
    pts = len((zp.locator(".pdn-chart .pdn-z").first.get_attribute("points") or "").split())
    shot(pg, "175-pdn.png")
    check(f"Supply Impedance (26.175): the panel starts from Power Analysis's supply ({first}); C1 with no value marked ({unknown}) until one is typed; the target said ({aim!r}); analysed from U1: a curve of {pts} points, where it is over the target, and why there are no planes",
          first == ["VIN", "GND", "J1"] and unknown == 1 and zp.locator(".pcbp-row.pw-bad").count() == 0 and "250 mΩ" in aim and pts > 100
          and "Over the target of 250 mΩ" in res and "too little copper area" in res and "U1" in zp.locator("select[aria-label='Looked at from']").input_value())
    zp.locator("select[aria-label='Switching part']").select_option("U1"); pg.wait_for_timeout(300)
    zp.get_by_label("Switching frequency").fill("400"); zp.get_by_label("Switching frequency").press("Tab"); pg.wait_for_timeout(200)
    zp.get_by_role("button", name="Analyse").click()
    pg.wait_for_function("document.querySelectorAll('.pdnpanel .pdn-chart').length === 2", timeout=90000); pg.wait_for_timeout(400)
    res2 = zp.locator(".pw-results").inner_text()
    bars = zp.locator(".pdn-chart .pdn-bar").count()
    with pg.expect_download() as dl:
        zp.get_by_role("button", name="Report...").click()
    rep = open(dl.value.path(), encoding="utf-8").read()
    check(f"…U1 as a switching part at 400 kHz: its harmonics from 150 kHz to 30 MHz against the limits ({bars} bars), the margin said; the report ({dl.value.suggested_filename!r})",
          bars == 75 and re.search(r"conducted emission, estimated: \d+\.\d dB (under|over) the Class B limit at", res2) is not None
          and dl.value.suggested_filename == "Demo_SupplyImpedance.txt" and rep.startswith("Supply Impedance: Demo.PcbDoc") and "Conducted emission" in rep and "NaN" not in rep)
    c.close()

    # 26.176 (R16 in the making, every feature on): Tools › Field Solver — a 0.36 mm track 0.2 mm over its plane is 50 Ω; the
    # demo board's top layer taken from its stack; a pair; the width found for 100 Ω differential
    c, pg = site_page("26.176")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(3000)
    pg.evaluate("() => { const s = window.konium.state; window.konium.openProjectDocument(s.projects.value[0], 'Demo.PcbDoc'); }"); pg.wait_for_timeout(2500)
    pg.locator(".menubar-item", has_text="Tools").first.click(); pg.wait_for_timeout(300)
    pg.locator(".menu-popup").last.locator(".menu-item", has_text="Field Solver").first.click(); pg.wait_for_timeout(700)
    fp = pg.locator(".fieldpanel")
    fp.get_by_role("button", name="Solve").click()
    pg.wait_for_function("document.querySelector('.fieldpanel .field-figures') !== null", timeout=60000); pg.wait_for_timeout(400)
    figs = fp.locator(".field-figures").inner_text().replace("\n", " ")
    z0 = float(re.search(r"Impedance ([\d.]+) Ω", figs).group(1))
    painted = pg.evaluate("(() => { const c = document.querySelector('.fieldpanel .field-picture'), d = c.getContext('2d').getImageData(c.width / 2, c.height - 12, 1, 1).data, e = c.getContext('2d').getImageData(4, 4, 1, 1).data; return [[...d], [...e]]; })()")
    shot(pg, "176-field.png")
    check(f"Field Solver (26.176): a 0.36 mm track of 35 µm copper 0.2 mm over its plane on 4.3 is {z0} Ω ({figs[:110]!r}); the cross-section is drawn, the plane's side blue and the corner in the air not ({painted})",
          49 < z0 < 51.5 and "Effective constant 3.1" in figs and "ps/mm" in figs and "pF/cm" in figs and painted[0][2] > 120 and painted[0][3] == 255)
    fp.locator("select[aria-label='From the board']").select_option(label="Top Layer"); pg.wait_for_timeout(300)
    taken = [fp.get_by_label("Height under").input_value(), fp.get_by_label("Constant under").input_value(), fp.get_by_label("Copper thickness").input_value()]
    fp.locator("label", has_text="A pair, side by side").locator("input").check(); pg.wait_for_timeout(200)
    fp.get_by_label("Impedance wanted").fill("100"); fp.get_by_label("Impedance wanted").press("Tab")
    fp.get_by_role("button", name="Find the width").click()
    pg.wait_for_function("(document.querySelector('.fieldpanel .field-figures')?.textContent ?? '').includes('Differential')", timeout=120000); pg.wait_for_timeout(500)
    figs2 = fp.locator(".field-figures").inner_text().replace("\n", " ")
    zd = float(re.search(r"Differential ([\d.]+) Ω", figs2).group(1))
    check(f"…the demo board's top layer taken from its stack (height, constant, copper: {taken}); as a pair, the width found for 100 Ω differential ({fp.get_by_label('Width').input_value()} mm) solves to {zd} Ω, with its odd and even modes and coupling",
          all(float(x) > 0 for x in taken) and 98.5 < zd < 101.5 and "Odd mode" in figs2 and "Even mode" in figs2 and "Coupling" in figs2)
    c.close()

    # 26.177 (R16 public): the analyses are on in the release itself (no features=all): Tools › Thermal Analysis opens its panel and
    # F1 there opens the guide at its section; a source with no pad on the return net is worked on the supply alone, and said
    c, pg = site_page("26.177")
    pg.goto(URL.replace("&features=all", "")); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(3000)
    pg.evaluate("() => { const s = window.konium.state; window.konium.openProjectDocument(s.projects.value[0], 'Demo.PcbDoc'); }"); pg.wait_for_timeout(2500)
    pg.locator(".menubar-item", has_text="Tools").first.click(); pg.wait_for_timeout(300)
    names = ["Power Analysis", "Supply Impedance", "Thermal Analysis", "EMC Check", "Field Solver"]
    cls = [pg.locator(".menu-popup").last.locator(".menu-item", has_text=n).first.get_attribute("class") or "" for n in names]
    pg.locator(".menu-popup").last.locator(".menu-item", has_text="Thermal Analysis").first.click(); pg.wait_for_timeout(700)
    tp = pg.locator(".thermalpanel")
    tp_n = tp.count()
    tp.get_by_label("Power of U1").focus(); pg.keyboard.press("F1"); pg.wait_for_timeout(600)
    guide = pg.locator(".help-page[aria-label='User Guide']")
    at_top = "(() => { const h = document.querySelector('.help-page'); if (!h) return ''; const top = h.getBoundingClientRect().top; const s = [...h.querySelectorAll('.help-section')].map((e) => [e.id, e.getBoundingClientRect().top - top]).filter((x) => x[1] > -40).sort((a, b) => a[1] - b[1])[0]; return s ? s[0] : ''; })()"
    def guide_at(want):  # the guide scrolls to its section once it is laid out: wait for that
        try: pg.wait_for_function(f"{at_top} === '{want}'", timeout=8000)
        except Exception: pass
        return pg.evaluate(at_top)
    at_section = guide_at("pcb-thermal")
    tucked = pg.locator(".dock-group.gm-slide").count() == 0
    toc = guide.inner_text() if guide.count() else ""
    shot(pg, "177-guide.png")
    check(f"R16 public (26.177): with no features=all the five Tools items are on ({[('planned' in x) for x in cls]}), Tools › Thermal Analysis opens its panel ({tp_n}), and F1 in one of its fields opens the User Guide at Thermal analysis ({at_section!r}), which lists the five sections; the auto-hide panel tucks away ({tucked})",
          all("planned" not in x and "disabled" not in x for x in cls) and tp_n == 1 and at_section == "pcb-thermal" and tucked
          and all(t in toc for t in ("Power analysis", "Supply impedance", "Field solver", "Thermal analysis", "EMC check")))
    pg.locator(".doctab.kind-help .doctab-close").dispatch_event("mousedown"); pg.wait_for_timeout(300)
    # F1 after a click on the panel's own text (the focus is left on the page): still the panel's section; after a click on the board, the editor's
    pg.evaluate("window.konium.dock.showPanel('thermalAnalysis')"); pg.wait_for_timeout(400)
    box = tp.bounding_box(); pg.mouse.click(box["x"] + 60, box["y"] + 8); pg.wait_for_timeout(200)
    pg.keyboard.press("F1"); pg.wait_for_timeout(600)
    by_click = guide_at("pcb-thermal")
    pg.locator(".doctab.kind-help .doctab-close").dispatch_event("mousedown"); pg.wait_for_timeout(300)
    vp = pg.locator(".viewport").first.bounding_box(); pg.mouse.click(vp["x"] + 40, vp["y"] + 40); pg.wait_for_timeout(300)
    pg.keyboard.press("F1"); pg.wait_for_timeout(1500)
    by_board = pg.evaluate(at_top)
    pg.locator(".doctab.kind-help .doctab-close").dispatch_event("mousedown"); pg.wait_for_timeout(300)
    check(f"…F1 after a click on the panel's text opens its section too ({by_click!r}); after a click on the board, the PCB editor's ({by_board!r})", by_click == "pcb-thermal" and by_board not in ("", "pcb-thermal"))
    pg.evaluate("window.konium.run('power.panel')"); pg.wait_for_timeout(700)
    pp = pg.locator(".powerpanel")
    pp.locator("select[aria-label='Supply net']").select_option(label=[o for o in pp.locator("select[aria-label='Supply net'] option").all_inner_texts() if o.startswith("+3V3")][0]); pg.wait_for_timeout(300)
    pp.locator("select[aria-label='Return net']").select_option(label=[o for o in pp.locator("select[aria-label='Return net'] option").all_inner_texts() if o.startswith("VIN")][0]); pg.wait_for_timeout(300)
    pp.locator("select[aria-label='Source']").select_option("C2"); pg.wait_for_timeout(300)
    pp.get_by_label("Current of U1").fill("0.1"); pp.get_by_label("Current of U1").press("Tab")
    pp.get_by_label("Voltage", exact=True).fill("3.3"); pp.get_by_label("Voltage", exact=True).press("Tab"); pg.wait_for_timeout(200)
    pp.get_by_role("button", name="Analyse").click()
    pg.wait_for_function("document.querySelector('.powerpanel .pw-results') !== null", timeout=90000); pg.wait_for_timeout(600)
    res = pp.locator(".pw-results").inner_text()
    row = pp.locator(".pw-results .pcbp-body .pcbp-row").first.inner_text().split("\n")
    shot(pg, "177-lone-source.png")
    check(f"…Power Analysis with a source that has no pad on the return net (+3V3 fed by C2, returning on VIN): the supply is worked alone ({row}) and it is said",
          "C2 has no pad on VIN: the return net is left out" in res and row[0] == "U1" and "Not joined" not in " ".join(row) and re.match(r"3\.\d+ V", row[1] or "") is not None)
    c.close()

    # 26.177 (rebuilt): a board with no netlist drawn by hand: P, T on a new board, five clicks, four joined tracks (the second segment used to
    # be "blocked by an obstacle": the route's own first one)
    c, pg = site_page("26.177-route")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.newPcb')"); pg.wait_for_timeout(2000)
    free = "window.konium.state.active.value.editor.doc.prims.filter((p) => p.kind === 'track').map((t) => [t.a.x, t.a.y, t.b.x, t.b.y, t.net])"
    vp = pg.locator(".viewport").first.bounding_box()
    x0, y0 = vp["x"] + vp["width"] * 0.30, vp["y"] + vp["height"] * 0.75
    pg.mouse.move(x0, y0); pg.mouse.click(x0, y0); pg.wait_for_timeout(200)
    pg.keyboard.press("p"); pg.wait_for_timeout(150); pg.keyboard.press("t"); pg.wait_for_timeout(400)
    notes = []
    for x, y in [(x0, y0), (x0 + 120, y0), (x0 + 120, y0 - 90), (x0 + 260, y0 - 90), (x0 + 260, y0 - 20)]:
        pg.mouse.move(x - 5, y - 3); pg.mouse.move(x, y, steps=4); pg.wait_for_timeout(150)
        pg.mouse.click(x, y); pg.wait_for_timeout(350)
        notes.append("blocked" in pg.locator(".statusbar").inner_text())
    shot(pg, "177-no-net-route.png")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200); pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    tr = pg.evaluate(free)
    joined = all(tr[i][0] == tr[i - 1][2] and tr[i][1] == tr[i - 1][3] for i in range(1, len(tr)))
    check(f"Routing with no net (26.177): P, T on a new board and five clicks lay four joined tracks ({len(tr)}, joined {joined}), none of them blocked ({notes})",
          len(tr) == 4 and joined and not any(notes) and all(t[4] == 0xffff for t in tr))
    pg.keyboard.press("Control+z"); pg.wait_for_timeout(400)
    check(f"…one undo takes the route back ({len(pg.evaluate(free))} tracks)", len(pg.evaluate(free)) == 0)
    c.close()

    # 26.178: the analysis panels' fields stand in columns (each field's box starts where the others do and is as long), and
    # the antenna analysis (R17, with features=all) on Konium's own example board
    c, pg = site_page("26.178")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(3000)
    pg.evaluate("() => { const s = window.konium.state; window.konium.openProjectDocument(s.projects.value[0], 'Demo.PcbDoc'); }"); pg.wait_for_timeout(2500)
    ragged = {}
    for pid, cls in (("powerAnalysis", ".powerpanel"), ("thermalAnalysis", ".thermalpanel"), ("emcCheck", ".emcpanel"), ("supplyImpedance", ".pdnpanel"), ("fieldSolver", ".fieldpanel"), ("antennaAnalysis", ".antennapanel")):
        pg.evaluate(f"window.konium.dock.showPanel('{pid}')"); pg.wait_for_timeout(500)
        # Every field outside the row of the button: where its box (or its list) starts, and where it ends
        boxes = pg.evaluate("""(cls) => [...document.querySelectorAll(cls + ' .pw-field')].filter((f) => !f.closest('.pw-run') && f.offsetParent)
          .map((f) => { const c = f.querySelector('input:not([type=checkbox]), select'); const r = c.getBoundingClientRect(), l = f.getBoundingClientRect(); return [Math.round(r.left - l.left), c.classList.contains('emc-nets') ? -1 : Math.round(r.width), Math.round(l.width)]; })""", cls)
        starts = {b[0] for b in boxes}; widths = {(b[1], b[2]) for b in boxes if b[1] >= 0}
        ragged[cls] = (len(boxes), sorted(starts), sorted({w[0] for w in widths}), len({w[1] for w in widths}))
        if pid == "powerAnalysis": shot(pg, "178-aligned.png")
    check(f"The analysis panels' fields stand in columns (26.178): in each of the six, every box and list starts at one place and those in rows of one width are one length ({ragged})",
          all(v[0] >= 2 and len(v[1]) == 1 and len(v[2]) <= v[3] for v in ragged.values()))
    pg.evaluate("window.konium.run('antenna.example')"); pg.wait_for_timeout(2500)
    ap = pg.locator(".antennapanel")
    form = [ap.locator("select[aria-label='Feed pad']").input_value(), ap.locator("select[aria-label='Ground net']").input_value(), ap.get_by_label("Frequency", exact=True).input_value(), ap.locator("select[aria-label='Detail']").input_value()]
    ap.get_by_role("button", name="Analyse").click(); pg.wait_for_timeout(1500)
    running = ap.locator("progress").count() == 1 and ap.get_by_role("button", name="Stop").count() == 1
    status = ap.locator(".pw-run [role=status]").inner_text()
    pg.wait_for_function("document.querySelector('.antennapanel .pw-results') !== null", timeout=400000); pg.wait_for_timeout(700)
    at_line = ap.locator(".ant-at").inner_text(); gain = ap.locator(".ant-gain").inner_text(); eff = ap.locator(".ant-eff").inner_text(); model = ap.locator(".ant-model").inner_text()
    res = pg.evaluate("(() => { const r = window.konium.state.active.value.editor; return { analysis: !!r.analysis, tracks: r.doc.prims.filter((p) => p.kind === 'track').length }; })()")
    charts = ap.locator(".pw-results svg:not(.icon)").count()
    m_at = re.search(r"At 2450 MHz: ([\d.]+) [+−] j([\d.]+) Ω, S11 (−?-?[\d.]+) dB", at_line)
    shot(pg, "178-antenna.png")
    check(f"Antenna Analysis (R17, 26.178): the example board opens with its feed, ground and frequency guessed ({form}); Analyse runs with a Stop button and its progress ({running}, {status[:50]!r})",
          form == ["FEED", "GND", "2450", "coarse"] and running and "Step" in status)
    check(f"…the results: {at_line!r}; three charts ({charts}); {eff[:40]!r}; {gain[:60]!r}; the current is laid over the board ({res})",
          m_at is not None and float(m_at.group(3).replace("−", "-")) < -10 and charts == 3 and "radiates" in eff and "dBi" in gain and res["analysis"] and res["tracks"] == 3 and "across the gap to GND" in model)
    # The cursor over the stub to ground reads the current there; unticked, the board is as it was
    foot = pg.evaluate("""(() => { const ed = window.konium.state.active.value.editor, t = ed.doc.prims.filter((q) => q.kind === 'track')[0];
      const r = ed.viewport.host.getBoundingClientRect(), s = ed.viewport.cam.toScreen({ x: t.a.x, y: (t.a.y + t.b.y) / 2 }); return [r.left + s.x, r.top + s.y]; })()""")
    pg.mouse.move(foot[0] - 5, foot[1]); pg.mouse.move(foot[0], foot[1]); pg.wait_for_timeout(600)
    hud = pg.evaluate("(() => { const ed = window.konium.state.active.value.editor; return ed.analysis ? ed.analysis.probe(ed.viewport.cam.toWorld({ x: %f - ed.viewport.host.getBoundingClientRect().left, y: %f - ed.viewport.host.getBoundingClientRect().top }), ed.currentLayer) : []; })()" % (foot[0], foot[1]))
    pg.evaluate("window.konium.dock.showPanel('antennaAnalysis')"); pg.wait_for_timeout(300)
    ap.locator("label", has_text="Show the current on the board").locator("input").uncheck(); pg.wait_for_timeout(400)
    off = pg.evaluate("!window.konium.state.active.value.editor.analysis")
    check(f"…the cursor on the stub to ground reads the current ({hud}); Show the current unticked takes the picture off ({off})",
          len(hud) == 2 and "A/m for 1 W" in hud[0] and "dB of the largest" in hud[1] and off)
    # 26.179: the pattern as a shape that turns, the current in motion, the report; no tick for a card drawn in software
    solid = ap.locator("canvas.ant-solid")
    inked = "(() => { const c = document.querySelector('canvas.ant-solid'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, h = 0; for (let q = 0; q < d.length; q += 4) if (d[q + 3]) { n++; h = (h * 31 + d[q] + 7 * d[q + 1] + 13 * d[q + 2] + q) >>> 0; } return [n, h]; })()"
    before = pg.evaluate(inked)
    sb = solid.bounding_box()
    pg.mouse.move(sb["x"] + 110, sb["y"] + 110); pg.mouse.down(); pg.mouse.move(sb["x"] + 160, sb["y"] + 90, steps=4); pg.mouse.up(); pg.wait_for_timeout(300)
    after = pg.evaluate(inked)
    check(f"Antenna Analysis (26.179): the pattern as a shape ({solid.count()} canvas, {before[0]} points of it drawn); dragged, it turns ({before[1] != after[1]})",
          solid.count() == 1 and before[0] > 4000 and after[0] > 4000 and before[1] != after[1])
    ap.locator("label", has_text="Show the current on the board").locator("input").check(); pg.wait_for_timeout(300)
    ap.locator("label", has_text="In motion").locator("input").check(); pg.wait_for_timeout(200)
    seen = pg.evaluate("""async () => { const ed = window.konium.state.active.value.editor, got = new Set();
      for (let q = 0; q < 30; q++) { const im = ed.analysis && ed.analysis.images(ed.currentLayer)[0]; if (im) { const d = im.src.getContext('2d').getImageData(0, 0, im.src.width, im.src.height).data; let h = 0; for (let k = 0; k < d.length; k += 16) h = (h * 31 + d[k] + d[k + 1] * 3 + d[k + 2] * 7) >>> 0; got.add(h); } await new Promise((r) => setTimeout(r, 100)); }
      return got.size; }""")
    ap.locator("label", has_text="In motion").locator("input").uncheck(); pg.wait_for_timeout(300)
    still = pg.evaluate("""async () => { const ed = window.konium.state.active.value.editor, a = ed.analysis.images(ed.currentLayer)[0].src; await new Promise((r) => setTimeout(r, 400)); return ed.analysis.images(ed.currentLayer)[0].src === a; }""")
    with pg.expect_download() as dl:
        ap.get_by_role("button", name="Report...").click()
    rep_text = open(dl.value.path(), encoding="utf-8").read()
    check(f"…In motion shows the current through its cycle ({seen} different pictures in 3 s; half a cycle on is the same picture, so eight at the most), unticked it stands still ({still}); the report ({dl.value.suggested_filename}, {len(rep_text)} characters)",
          seen >= 3 and still and dl.value.suggested_filename == "Antenna Example_Antenna.txt" and "Antenna analysis of Antenna Example.PcbDoc" in rep_text
          and re.search(r"Impedance\s+[\d.]+ [+-] j[\d.]+ Ω", rep_text) is not None and "Best match" in rep_text and "on the processor" in rep_text and rep_text.count("\n") > 60)
    tick_soft = ap.locator("label", has_text="Run on the graphics card").count()
    c.close()

    # 26.180: the UI gone through for fields out of line: what was found stays put right
    c, pg = site_page("26.180")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(3000)
    pg.evaluate("() => { const s = window.konium.state; window.konium.openProjectDocument(s.projects.value[0], 'Demo.PcbDoc'); }"); pg.wait_for_timeout(2500)
    INSIDE = """(sel) => { const d = [...document.querySelectorAll('.dlg')].pop(), f = d.querySelector('.dlg-body').getBoundingClientRect();
      return [...d.querySelectorAll(sel)].map((c) => { const r = c.getBoundingClientRect(); return [Math.round(r.left - f.left), Math.round(f.right - r.right), Math.round(r.width)]; }); }"""
    pg.evaluate("window.konium.run('jump.location')"); pg.wait_for_timeout(500)
    jump = pg.evaluate(INSIDE, "input")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    pg.evaluate("window.konium.run('ad:PCB:ShowSelectionMemoryDialog')"); pg.wait_for_timeout(500)
    mem = pg.evaluate(INSIDE, ".sm-row .btn")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    check(f"A box that asks for a value keeps inside its dialog (26.180): Jump To Location's two boxes ({jump}); Selection Memory's {len(mem)} buttons fit, the last {min((m[1] for m in mem), default=-1)} px inside",
          len(jump) == 2 and all(j[1] >= 8 for j in jump) and len({j[2] for j in jump}) == 1 and len(mem) == 48 and all(m[1] >= 4 and m[0] >= 0 for m in mem))
    pg.evaluate("window.konium.state.prefsPage.value = 'pcb-general'; window.konium.state.showPrefs.value = true"); pg.wait_for_timeout(700)
    pf = pg.evaluate("""() => { const d = document.querySelector('.dlg.prefs'), w = (c) => Math.round(c.getBoundingClientRect().width);
      const ticks = [...d.querySelectorAll('.pref-row.is-check > input[type=checkbox]')].map(w);
      const m = d.querySelector('.pref-multi'), fr = m.closest('fieldset').getBoundingClientRect(), kinds = [...m.querySelectorAll('label')].map((l) => Math.round(fr.right - l.getBoundingClientRect().right));
      const other = [...d.querySelectorAll('fieldset')].find((f) => f.querySelector('legend')?.textContent === 'Other');
      const boxes = [...other.querySelectorAll('.pref-number input, select')].map((c) => [Math.round(c.getBoundingClientRect().left), w(c)]);
      return { ticks: [ticks.length, Math.min(...ticks)], kinds: [kinds.length, Math.min(...kinds)], boxes }; }""")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    check(f"Preferences (26.180): the ticks are at their full size ({pf['ticks'][0]} of them, the smallest {pf['ticks'][1]} px); Shift Click To Select's {pf['kinds'][0]} kinds keep inside their frame (by {pf['kinds'][1]} px); a number's box starts and ends with the lists beside it ({pf['boxes']})",
          pf["ticks"][0] > 8 and pf["ticks"][1] >= 12 and pf["kinds"][0] == 12 and pf["kinds"][1] >= 0 and len(pf["boxes"]) >= 4 and len({tuple(x) for x in pf["boxes"]}) == 1)
    pg.evaluate("() => { const s = window.konium.state; window.konium.openProjectDocument(s.projects.value[0], 'Demo.SchDoc'); }"); pg.wait_for_timeout(1500)
    pg.evaluate("window.konium.run('ad:Sch:DocumentPreferences')"); pg.wait_for_timeout(600)
    one_line = pg.evaluate("""() => [...document.querySelectorAll('.dlg.docopts .do-row > span')].map((n) => Math.round(n.getBoundingClientRect().height)).filter((h) => h > 0)""")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    pg.evaluate("(() => { const e = window.konium.state.active.value.editor; window.konium.editObject(e, 'o' + e.doc.objects.find((o) => o.kind === 'component' && o.designator === 'U1').index); })()"); pg.wait_for_timeout(700)
    cp = pg.evaluate("""() => [...document.querySelectorAll('.dlg.compprops .cp-check input')].map((c) => Math.round(c.getBoundingClientRect().width))""")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    check(f"Names on one line and ticks unsqueezed (26.180): Document Options' {len(one_line)} names are each one line (the tallest {max(one_line, default=0)} px); the component properties' {len(cp)} ticks are full size (the smallest {min(cp, default=0)} px)",
          len(one_line) >= 8 and max(one_line) < 24 and len(cp) >= 8 and min(cp) >= 12)
    c.close()

    # 26.180: Preferences › Schematic › Default Primitives and PCB Editor › Defaults can be changed (the first was a list to read, the
    # second's Edit Values was greyed with no board open), and what is placed starts from them
    c, pg = site_page("26.180-defaults")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    def prefs_at(page_id):
        pg.evaluate(f"window.konium.state.prefsPage.value = '{page_id}'; window.konium.state.showPrefs.value = true"); pg.wait_for_timeout(700)
    def edit_default(name):
        pg.locator(".pdef-row", has_text=re.compile(f"^{re.escape(name)}( \\*)?$")).dispatch_event("mousedown"); pg.wait_for_timeout(150)
        pg.locator(".pdef-buttons .btn", has_text="Edit Values").click(); pg.wait_for_timeout(500)
        return pg.locator(".dlg").last
    def field(d, name): return d.locator("label.dlg-field").filter(has=pg.locator(".dlg-label", has_text=re.compile(f"^{re.escape(name)}$")))
    prefs_at("sch-primitives")
    rows = pg.locator(".pdef-row").count()
    groups = pg.locator(".pdef-pick select option").all_inner_texts()
    d = edit_default("Net Label")
    net_fields = d.locator(".dlg-label").all_inner_texts()
    field(d, "Net").locator("input").fill("CLK1")
    d.locator(".btn.default").click(); pg.wait_for_timeout(300)
    d = edit_default("Wire")
    field(d, "Wire Width").locator("select").select_option("Large")
    d.locator(".btn.default").click(); pg.wait_for_timeout(300)
    d = edit_default("Rectangle")
    rect_fields = d.locator(".dlg-label").all_inner_texts()
    field(d, "Border Width").locator("select").select_option("Medium")
    field(d, "Draw Solid").locator("input").uncheck()
    d.locator(".btn.default").click(); pg.wait_for_timeout(300)
    starred = pg.locator(".pdef-row", has_text="*").all_inner_texts()
    pg.locator(".pdef-pick select").select_option("Wiring Objects"); pg.wait_for_timeout(200)
    wiring = pg.locator(".pdef-row").count()
    check(f"Preferences › Schematic › Default Primitives (26.180), with no sheet open: {rows} primitives, by group ({groups}; {wiring} wiring objects); Edit Values opens a primitive's own properties without where it goes ({net_fields}; {rect_fields}); changed, they are starred ({starred})",
          rows == 31 and groups[0] == "All" and len(groups) == 7 and 8 <= wiring < rows and "Net" in net_fields and "Font" in net_fields and not any(re.match(r"(Location|Corner) [XY]$", f) for f in net_fields + rect_fields)
          and starred == ["Net Label *", "Rectangle *", "Wire *"])
    pg.locator(".dlg.prefs .dlg-foot .btn", has_text="Cancel").click(); pg.wait_for_timeout(400)
    # The board's: Edit Values with no board in front
    prefs_at("pcb-defaults")
    pg.locator(".pdef-row", has_text=re.compile(r"^Track( \*)?$")).dispatch_event("mousedown"); pg.wait_for_timeout(150)
    eb = pg.locator(".pdef-buttons .btn", has_text="Edit Values")
    can = eb.is_enabled()
    eb.click(); pg.wait_for_timeout(700)
    td = pg.locator(".dlg").last
    ttitle = td.locator(".dlg-title").inner_text()
    wbox = td.get_by_label("Width", exact=True)
    wbox.fill("25mil"); wbox.press("Tab")
    td.locator(".btn.default").click(); pg.wait_for_timeout(400)
    pstar = pg.locator(".pdef-row", has_text="*").all_inner_texts()
    check(f"Preferences › PCB Editor › Defaults (26.180): Edit Values is live with no board open ({can}) and opens the track's own dialog ({ttitle!r}); its width changed, Track is starred ({pstar})",
          can and ttitle.startswith("Track") and pstar == ["Track *"])
    pg.locator(".dlg.prefs .dlg-foot .btn", has_text="Cancel").click(); pg.wait_for_timeout(400)
    # What is placed starts from them
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(3000)
    pg.evaluate("() => { const s = window.konium.state; window.konium.openProjectDocument(s.projects.value[0], 'Demo.SchDoc'); }"); pg.wait_for_timeout(1500)
    pg.evaluate(f"{ED}.zoomToBox({{minX: 76000000, maxX: 104000000, minY: 4000000, maxY: 18000000}})"); pg.wait_for_timeout(300)
    def at(x, y): return pg.evaluate(TO_SCREEN, [x, y])
    def click(x, y, **kw): pg.mouse.move(*at(x, y)); pg.wait_for_timeout(60); pg.mouse.click(*at(x, y), **kw); pg.wait_for_timeout(120)
    LAST = "(rec) => { const bags = " + ED + ".doc.records.map((r) => r.bag).filter((b) => b && b.int('RECORD', -1) === rec); const b = bags[bags.length - 1]; return b ? [bags.length, b.get('TEXT') ?? null, b.get('LINEWIDTH') ?? null, b.bool('ISSOLID'), b.get('COLOR') ?? null] : null; }"
    pg.evaluate("window.konium.run('place.netLabel')"); pg.wait_for_timeout(200)
    click(82000000, 15000000); pg.keyboard.press("Escape"); pg.wait_for_timeout(150)
    pg.evaluate("window.konium.run('place.wire')"); pg.wait_for_timeout(200)
    click(80000000, 12000000); click(90000000, 12000000); click(90000000, 12000000, button="right"); pg.keyboard.press("Escape"); pg.wait_for_timeout(150)
    pg.evaluate("window.konium.run('ad:Sch:PlaceRectangle')"); pg.wait_for_timeout(200)
    click(94000000, 10000000); click(100000000, 14000000); pg.keyboard.press("Escape"); pg.wait_for_timeout(150)
    label, wire, rect = pg.evaluate(LAST, 25), pg.evaluate(LAST, 27), pg.evaluate(LAST, 14)
    check(f"…what is placed starts from its default: a net label named {label and label[1]!r}, a wire of width {wire and wire[2]}, a rectangle of border {rect and rect[2]} and not solid ({rect and not rect[3]})",
          label and label[1] == "CLK1" and wire and wire[2] == "3" and rect and rect[2] == "2" and not rect[3])
    # Tab while a rectangle is drawn: its properties; this one and the default take them
    pg.evaluate("window.konium.run('ad:Sch:PlaceRectangle')"); pg.wait_for_timeout(200)
    pg.mouse.move(*at(94000000, 6000000)); pg.keyboard.press("Tab"); pg.wait_for_timeout(500)
    td = pg.locator(".dlg.schprops")
    tab_fields = td.locator(".dlg-label").all_inner_texts() if td.count() else []
    field(td, "Border Width").locator("select").select_option("Large")
    td.locator(".btn.default").click(); pg.wait_for_timeout(300)
    click(94000000, 5000000); click(100000000, 8000000); pg.keyboard.press("Escape"); pg.wait_for_timeout(150)
    rect2 = pg.evaluate(LAST, 14)
    kept = pg.evaluate("JSON.parse(localStorage.getItem('konium.sch.primitiveDefaults.v1')).Rectangle.props.LINEWIDTH")
    # … with Permanent on, Tab's change goes to the one being drawn and no further
    pg.evaluate("window.konium.prefs.set({ schDefaultsPermanent: true })")
    pg.evaluate("window.konium.run('ad:Sch:PlaceRectangle')"); pg.wait_for_timeout(200)
    pg.mouse.move(*at(84000000, 6000000)); pg.keyboard.press("Tab"); pg.wait_for_timeout(500)
    td = pg.locator(".dlg.schprops")
    field(td, "Border Width").locator("select").select_option("Smallest")
    td.locator(".btn.default").click(); pg.wait_for_timeout(300)
    click(84000000, 5000000); click(90000000, 8000000); pg.keyboard.press("Escape"); pg.wait_for_timeout(150)
    rect3 = pg.evaluate(LAST, 14)
    kept2 = pg.evaluate("JSON.parse(localStorage.getItem('konium.sch.primitiveDefaults.v1')).Rectangle.props.LINEWIDTH")
    pg.evaluate("window.konium.prefs.set({ schDefaultsPermanent: false })")
    check(f"…Tab while a rectangle is drawn opens its properties ({tab_fields}): the one drawn takes them (border {rect2 and rect2[2]}) and so does the default ({kept}); with Permanent on the one drawn takes them (border {rect3 and rect3[2]}) and the default stays ({kept2})",
          "Border Width" in tab_fields and rect2 and rect2[2] == "3" and kept == "3" and rect3 and rect3[2] in (None, "0") and kept2 == "3" and rect3[0] == rect2[0] + 1)
    c.close()

    # 26.180: long work pauses on a message, not a timer: the window still draws between the steps, and Stop is still heard
    c, pg = site_page("26.180-breathe")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('antenna.example')"); pg.wait_for_timeout(2500)
    ap = pg.locator(".antennapanel")
    pg.evaluate("() => { window.__frames = 0; window.__timers = 0; const f = () => { window.__frames++; requestAnimationFrame(f); }; requestAnimationFrame(f); const t = () => { window.__timers++; setTimeout(t, 50); }; t(); }")
    ap.get_by_role("button", name="Analyse").click(); pg.wait_for_timeout(1500)
    f0, t0 = pg.evaluate("[window.__frames, window.__timers]")
    seen = set()
    for _ in range(8):
        pg.wait_for_timeout(500)
        seen.add(ap.inner_text().split("Stop")[-1][:60] if ap.get_by_role("button", name="Stop").count() else "")
    f1, t1 = pg.evaluate("[window.__frames, window.__timers]")
    stop = ap.get_by_role("button", name="Stop")
    could_stop = stop.count() == 1
    if could_stop: stop.click()
    pg.wait_for_timeout(2500)
    ended = ap.get_by_role("button", name="Analyse").count() == 1 and ap.get_by_role("button", name="Stop").count() == 0
    check(f"A run's pauses are messages, not timers (26.180): while the antenna's steps go on the window draws ({f1 - f0} frames in 4 s), its timers fire ({t1 - t0}), the progress moves ({len(seen)} different readings), and Stop ends it ({could_stop}, {ended})",
          f1 - f0 >= 8 and t1 - t0 >= 8 and len(seen) >= 3 and could_stop and ended)
    c.close()

    # 26.181: Live Simulation (R18, planned; every feature is on here): the simulation demo's sheet run as a circuit
    c, pg = site_page("26.181-live")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openSimDemo')"); pg.wait_for_timeout(2500)
    pg.evaluate("window.konium.run('live.panel')"); pg.wait_for_timeout(2000)
    lp = pg.locator(".livepanel")
    READ = "window.konium.liveReading()"
    r1 = pg.evaluate(READ)
    pg.wait_for_timeout(1000)
    r2 = pg.evaluate(READ)
    speed = lp.get_by_label("Speed", exact=True).input_value()
    drawn = pg.evaluate(f"(() => {{ const e = {ED}; const s = e.overlay ? e.overlay() : null; return typeof e.liveDraw; }})()")
    check(f"Live Simulation (26.181): the simulation demo's sheet runs: the supply net at {r1 and round(r1['volt'].get('VCC', 0), 3)} V, the collector's at {r1 and round(r1['volt'].get('NetC3_1', 0), 2)} V, {r1 and len(r1['pins'])} pins metered on {r1 and r1['runs']} runs; a second on, the circuit's time has gone from {r1 and r1['time']:.2e} to {r2 and r2['time']:.2e} s at the speed chosen for its 1 kHz source ({speed})",
          r1 and abs(r1["volt"].get("VCC", 0) - 12) < 1e-6 and 4 < r1["volt"].get("NetC3_1", 0) < 9 and len(r1["pins"]) >= 20 and r1["runs"] > 40 and r2["time"] - r1["time"] > 2e-4 and float(speed) == 5e-4 and drawn == "function")
    # What goes into the transistor comes out of it; Hold holds, Go On goes on, From the Start is time 0 again
    kcl = abs(r2["pins"]["Q1|1"] + r2["pins"]["Q1|2"] + r2["pins"]["Q1|3"])
    lp.get_by_role("button", name="Hold").click(); pg.wait_for_timeout(400)
    h1 = pg.evaluate(READ)["time"]; pg.wait_for_timeout(600); h2 = pg.evaluate(READ)["time"]
    lp.get_by_role("button", name="Go On").click(); pg.wait_for_timeout(600)
    g = pg.evaluate(READ)["time"]
    lp.get_by_role("button", name="From the Start").click(); pg.wait_for_timeout(300)
    again = pg.evaluate(READ)["time"]
    lp.get_by_role("button", name="Faster").click(); pg.wait_for_timeout(200)
    faster = lp.get_by_label("Speed", exact=True).input_value()
    check(f"…the transistor's three pins sum to {kcl:.1e} A; Hold holds the time ({h1 == h2}), Go On lets it on ({g > h2}), From the Start is near 0 again ({again:.1e} s); Faster is the next speed ({faster})",
          kcl < 1e-9 and h1 == h2 and g > h2 and again < g and again < 5e-4 and float(faster) == 1e-3)
    # A change to the sheet carries the run on; a part from the panel takes the next designator
    t_before = pg.evaluate(READ)["time"]
    pg.evaluate(f"(() => {{ const e = {ED}, o = e.doc.objects.find((x) => x.kind === 'component' && x.designator === 'R5'); e.select(['o' + o.index]); window.konium.run('edit.delete'); }})()"); pg.wait_for_timeout(700)
    r3 = pg.evaluate(READ)
    lp.get_by_role("button", name="Resistor", exact=True).click(); pg.wait_for_timeout(300)
    pg.evaluate(f"{ED}.zoomToBox({{minX: 9000000, maxX: 56000000, minY: 28000000, maxY: 51000000}})"); pg.wait_for_timeout(300)
    xy = pg.evaluate(TO_SCREEN, [24000000, 33000000])
    pg.mouse.move(*xy); pg.wait_for_timeout(100); pg.mouse.click(*xy); pg.wait_for_timeout(200); pg.keyboard.press("Escape"); pg.wait_for_timeout(600)
    des = pg.evaluate(f"{ED}.doc.objects.filter((o) => o.kind === 'component').map((o) => o.designator).sort()")
    r4 = pg.evaluate(READ)
    check(f"…with R5 deleted the run carries on ({'R5|1' not in r3['pins']}, time {t_before:.1e} to {r3['time']:.1e} s, the supply still {round(r3['volt'].get('VCC', 0), 3)} V); Resistor from the panel places {[d for d in des if d.startswith('R')][-1]} (parts now {len(des)}), and it is in the run ({'R5|1' in r4['pins']})",
          "R5|1" not in r3["pins"] and r3["time"] >= t_before and abs(r3["volt"].get("VCC", 0) - 12) < 1e-6 and "R5" in des and len(des) == 11 and "R5|1" in r4["pins"])
    shot(pg, "26181-live.png")
    # (the panel slid away at the click on the sheet: the command brings it back, and leaves the run as it is)
    pg.evaluate("window.konium.run('live.panel')"); pg.wait_for_timeout(500)
    kept = pg.evaluate(READ)["time"] > r4["time"]
    lp.get_by_role("button", name="Stop").click(); pg.wait_for_timeout(400)
    off = pg.evaluate(f"[{READ}, typeof {ED}.liveDraw === 'function', document.querySelectorAll('.livepanel .btn.default')[0].textContent]")
    check(f"…the command with the run going brings its panel back and leaves the run be ({kept}); Stop takes it off the sheet (no reading: {off[0] is None}, nothing drawn: {not off[1]}); the panel offers {off[2]!r} again", kept and off[0] is None and not off[1] and off[2] == "Start")
    c.close()

    # 26.182: Live Simulation's second build: the scope's probes and three views, a switch thrown, a push button held, a value typed and turned
    c, pg = site_page("26.182-scope")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openSimDemo')"); pg.wait_for_timeout(2500)
    pg.evaluate("window.konium.run('live.panel')"); pg.wait_for_timeout(1800)
    lp = pg.locator(".livepanel"); sp = pg.locator(".livescope")
    READ = "window.konium.liveReading()"
    SCOPE = """(() => { const d = window.konium.liveScope(); if (!d) return null;
      const top = (a) => { let k = 0; for (let j = 1; j < a.length; j++) if (a[j] > a[k]) k = j; return k; };
      return { view: d.view, note: d.note || '', f: d.f ? [d.f[0], d.f[d.f.length - 1], d.f.length] : null,
        probes: d.probes.map((p) => ({ label: p.probe.label, kept: p.kept, gone: p.gone, n: p.v ? p.v.y.length : 0, freq: p.v && p.v.m ? p.v.m.freq : 0, swing: p.v && p.v.m ? p.v.m.max - p.v.m.min : 0,
          imax: p.i && p.i.m ? Math.max(Math.abs(p.i.m.min), Math.abs(p.i.m.max)) : 0, peak: p.a && p.a.length ? d.f[top(p.a)] : 0, gain: p.db && p.db.length ? Math.max(...p.db) : null })) }; })()"""
    def click_doc(at, wait=500):
        x, y = pg.evaluate(TO_SCREEN, at); pg.mouse.click(x, y); pg.wait_for_timeout(wait); return x, y
    # The first click on the sheet tucks the panel away; then the OUT wire is the probe, kept; then the transistor's base pin
    click_doc([15000000, 50000000], 300)
    empty = pg.evaluate(SCOPE)
    click_doc([49000000, 44000000])
    sp.get_by_role("button", name="Keep").first.click(); pg.wait_for_timeout(300)
    click_doc([34800000, 40000000], 3500)
    s_time = pg.evaluate(SCOPE)
    key = sp.locator(".ls-scope").first.locator(".ls-key tbody tr").all_inner_texts()
    heads = sp.locator(".ls-scope").first.locator(".ls-key thead th").all_inner_texts()
    out = s_time["probes"][0] if s_time and s_time["probes"] else {}
    check(f"Live Scope (26.182): it opens with the run, with no probe yet ({empty and len(empty['probes'])}); a click on the OUT wire is the probe, Keep holds it, a click on the transistor's base pin is the next ({[(p['label'], p['kept']) for p in s_time['probes']]}); against time OUT has {out.get('n')} points, swings {out.get('swing', 0):.2f} V and repeats at {out.get('freq', 0):.0f} Hz; the key reads {heads[:6]} over {len(key)} rows",
          sp.count() == 1 and empty and empty["probes"] == [] and [(p["label"], p["kept"]) for p in s_time["probes"]] == [("OUT", True), ("Q1 pin 2", False)] and out["n"] > 200 and 1.5 < out["swing"] < 3 and 950 < out["freq"] < 1050
          and heads[:6] == ["Probe", "Voltage", "Current", "Least", "Most", "Repeats at"] and len(key) == 2 and key[0].startswith("OUT") and "V" in key[0] and "A" in key[0])
    # The same probes as a spectrum (its largest line at the source's 1 kHz) and as the circuit's frequency response (the amplifier's gain)
    sp.get_by_label("Scope 1 shows", exact=True).select_option("spectrum"); pg.wait_for_timeout(1200)
    s_spec = pg.evaluate(SCOPE)
    sp.get_by_label("Scope 1 shows", exact=True).select_option("response"); pg.wait_for_timeout(1200)
    s_resp = pg.evaluate(SCOPE)
    heads_r = sp.locator(".ls-scope").first.locator(".ls-key thead th").all_inner_texts()
    key_r = sp.locator(".ls-scope").first.locator(".ls-key tbody tr").first.inner_text()
    sp.get_by_label("Scope 1 shows", exact=True).select_option("time"); pg.wait_for_timeout(400)
    line = s_spec["f"][0] if s_spec and s_spec["f"] else 0
    check(f"…as a spectrum its lines are {line:.0f} Hz wide and OUT's largest is at {s_spec['probes'][0]['peak']:.0f} Hz; as the frequency response, from {s_resp['f'][0]} Hz to {s_resp['f'][1]:.0e} Hz, OUT's gain reaches {s_resp['probes'][0]['gain']:.1f} dB and the base's {s_resp['probes'][1]['gain']:.1f} dB; the key reads {heads_r[1:6]}: {key_r!r}",
          s_spec["view"] == "spectrum" and line > 0 and abs(s_spec["probes"][0]["peak"] - 1000) <= line * 1.01 and s_resp["view"] == "response" and s_resp["f"][0] == 0.1 and s_resp["f"][1] == 1e8
          and 44 < s_resp["probes"][0]["gain"] < 49 and abs(s_resp["probes"][1]["gain"]) < 0.5 and heads_r[1:6] == ["Most gain", "At", "Phase", "3 dB down at", "And at"] and "dB" in key_r and "Hz" in key_r)
    # Monitors anywhere and scopes side by side, from the right-click menu: the collector's wire in a scope of its own, the emitter's
    # as a monitor on the sheet only; each place watched has its read-out beside it
    def menu_at(at):
        x, y = pg.evaluate(TO_SCREEN, at); pg.mouse.click(x, y, button="right"); pg.wait_for_timeout(500)
        return pg.locator(".menu-popup").last
    m1 = menu_at([37000000, 45000000])
    offered = m1.locator(".menu-item").all_inner_texts()[:4]
    m1.locator(".menu-item", has_text="View in a New Scope").first.click(); pg.wait_for_timeout(600)
    menu_at([37000000, 35000000]).locator(".menu-item", has_text="Monitor Here").first.click(); pg.wait_for_timeout(900)
    mons = pg.evaluate("window.konium.liveMonitors().map((m) => [m.label, m.text, m.kept, m.scopes])")
    ids = pg.evaluate("window.konium.liveScopes()")
    on2 = pg.evaluate("(() => { const d = window.konium.liveScope(2); return d && d.probes.map((p) => p.probe.label); })()")
    names = sp.locator(".ls-scope .ls-name").all_inner_texts()
    side = [round(b["y"]) for b in [sp.locator(".ls-scope").nth(k).bounding_box() for k in range(sp.locator(".ls-scope").count())]]
    m2 = menu_at([37000000, 35000000])
    again = m2.locator(".menu-item").all_inner_texts()[:4]
    m2.locator(".menu-item", has_text="Stop Monitoring Here").first.click(); pg.wait_for_timeout(500)
    left = pg.evaluate("window.konium.liveMonitors().map((m) => m.label)")
    sp.get_by_role("button", name="Close Scope 2").click(); pg.wait_for_timeout(500)
    closed = [pg.evaluate("window.konium.liveScopes()"), pg.evaluate("window.konium.liveMonitors().map((m) => m.label)")]
    check(f"Monitors and scopes (26.182): a right-click on a wire of the running sheet offers {offered[:3]}; View in a New Scope puts the collector's wire on a second scope beside the first ({names}, tops {side}, on it {on2}); Monitor Here keeps the emitter's on the sheet only; each has its read-out ({[m[1] for m in mons]}); there the menu then offers {again[3:4]}, which leaves {left}; closing Scope 2 leaves {closed}",
          offered[:3] == ["Monitor Here", "Add to the Scope", "View in a New Scope"] and ids == [1, 2] and names == ["Scope 1", "Scope 2"] and len(side) == 2 and side[0] == side[1] and on2 == ["NetC3_1"]
          and [m[0] for m in mons] == ["OUT", "Q1 pin 2", "NetC3_1", "NetC2_1"] and all(re.search(r": -?[\d.]+ [mµnpkM]?V, -?[\d.]+ [mµnpkM]?A$", m[1]) for m in mons) and mons[3][3] == [] and mons[2][3] == [2]
          and again[3:4] == ["Stop Monitoring Here"] and left == ["OUT", "Q1 pin 2", "NetC3_1"] and closed == [[1], ["OUT", "Q1 pin 2"]])
    # The palette: the parts as pictures of their symbols, by kind
    pg.evaluate("window.konium.run('live.panel')"); pg.wait_for_timeout(600)
    pal = pg.evaluate("""() => { const s = document.querySelector(".livepanel section[aria-label='Parts for a sketch']");
      const groups = [...s.querySelectorAll('.live-group')].map((g) => [g.getAttribute('aria-label'), g.querySelectorAll('.live-tile').length]);
      const tiles = [...s.querySelectorAll('.live-tile')];
      const drawn = tiles.filter((t) => t.querySelectorAll('.live-art svg :is(line, rect, polyline, polygon, ellipse, path, circle, text)').length >= 1).length;
      const xs = [...new Set(tiles.slice(0, 5).map((t) => Math.round(t.getBoundingClientRect().top)))];
      const ws = [...new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().width)))];
      return { groups, n: tiles.length, drawn, rows: xs.length, widths: ws.length, names: tiles.slice(0, 5).map((t) => t.getAttribute('aria-label')) }; }""")
    check(f"The palette (26.186): {pal['n']} tiles by kind {pal['groups']}, each a picture of its symbol over its name ({pal['drawn']} drawn); the first five in one row ({pal['rows']}), all of one width ({pal['widths']}): {pal['names']}",
          pal["groups"] == [["Passive", 13], ["Diodes and thyristors", 7], ["Transistors", 7], ["Amplifiers and blocks", 8], ["Logic and chips", 21], ["Sources", 15], ["Instruments and outputs", 6], ["Wiring and notes", 5]]
          and pal["n"] == 82 and pal["drawn"] == 82 and pal["rows"] == 1 and pal["widths"] == 1
          and pal["names"] == ["Resistor", "Capacitor", "Polarised capacitor", "Inductor", "Potentiometer"])
    c.close()

    c, pg = site_page("26.182-hands")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openSimDemo')"); pg.wait_for_timeout(2500)
    pg.evaluate("window.konium.run('live.panel')"); pg.wait_for_timeout(1500)
    lp = pg.locator(".livepanel")
    def most(pin, n=12, gap=60):
        top = 0
        for _ in range(n):
            r = pg.evaluate(READ); top = max(top, abs(r["pins"].get(pin, 0)) if r else 0); pg.wait_for_timeout(gap)
        return top
    def place(name, at):
        pg.evaluate("window.konium.run('live.panel')"); pg.wait_for_timeout(500)
        lp.get_by_role("button", name=name, exact=True).click(); pg.wait_for_timeout(400)
        x, y = pg.evaluate(TO_SCREEN, at); pg.mouse.move(x, y); pg.wait_for_timeout(200); pg.mouse.click(x, y); pg.wait_for_timeout(300)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    SW = f"(() => {{ const e = {ED}; const s = e.doc.objects.find((o) => o.kind === 'component' && o.designator === 'SW1'); return s ? [s.displayMode, e.undo.undoLabel] : null; }})()"
    # R5's way to ground taken out; a switch in its place and a ground under it: open, R5 carries nothing; a click closes it; Undo opens it
    pg.evaluate(f"""(() => {{ const e = {ED}; const w = e.doc.objects.find((o) => o.kind === 'wire' && o.pts.length === 2 && o.pts[0].x === 52000000 && o.pts.some((p) => p.y === 36000000));
      const g = e.doc.objects.find((o) => o.kind === 'power' && o.at.x === 52000000 && o.at.y === 36000000);
      e.select(['o' + w.index, 'o' + g.index]); window.konium.run('edit.delete'); }})()"""); pg.wait_for_timeout(500)
    place("Switch", [52000000, 36000000])
    pg.evaluate("window.konium.run('place.gnd')"); pg.wait_for_timeout(300)
    x, y = pg.evaluate(TO_SCREEN, [52000000, 34000000]); pg.mouse.move(x, y); pg.wait_for_timeout(200); pg.mouse.click(x, y); pg.wait_for_timeout(300)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(900)
    i_open = most("R5|1")
    x, y = pg.evaluate(TO_SCREEN, [52000000, 36000000]); pg.mouse.click(x, y); pg.wait_for_timeout(700)
    closed = pg.evaluate(SW); i_closed = most("R5|1")
    probe = pg.evaluate("(() => { const d = window.konium.liveScope(); return d && d.probes.map((p) => p.probe.label); })()")
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(700)
    undone = pg.evaluate(SW); i_undone = most("R5|1")
    check(f"A switch (26.182): placed from the panel as SW1, open it lets {i_open:.1e} A through R5; a click between its contacts closes it ({closed}): {i_closed:.1e} A, and it is the scope's probe ({probe}); Undo opens it again ({undone and undone[0]}, {i_undone:.1e} A)",
          i_open < 1e-7 and closed == [1, "Close SW1"] and i_closed > 3e-6 and probe == ["SW1"] and undone and undone[0] == 0 and i_undone < 1e-7)
    # A push button in its place: closed for as long as the mouse is held on it, and the sheet is as it was
    pg.evaluate(f"(() => {{ const e = {ED}; const s = e.doc.objects.find((o) => o.kind === 'component' && o.designator === 'SW1'); e.select(['o' + s.index]); window.konium.run('edit.delete'); }})()"); pg.wait_for_timeout(500)
    place("Push button", [52000000, 36000000]); pg.wait_for_timeout(600)
    before = pg.evaluate(SW); i_up = most("R5|1", 6)
    x, y = pg.evaluate(TO_SCREEN, [52000000, 36000000]); pg.mouse.move(x, y); pg.mouse.down(); pg.wait_for_timeout(500)
    held = pg.evaluate(SW); i_down = most("R5|1")
    pg.mouse.up(); pg.wait_for_timeout(600)
    after = pg.evaluate(SW); i_after = most("R5|1", 6)
    check(f"A push button (26.182): let be, {i_up:.1e} A; held down with the mouse it is closed ({held and held[0]}): {i_down:.1e} A; let go it is open again ({after and after[0]}, {i_after:.1e} A) and nothing was added to Undo ({before and before[1]!r} → {after and after[1]!r})",
          before and before[0] == 0 and i_up < 1e-7 and held and held[0] == 1 and i_down > 3e-6 and after and after[0] == 0 and i_after < 1e-7 and after[1] == before[1])
    # A value in the panel: typed, then turned with its slider (one step to undo for the whole turn)
    pg.evaluate(f"(() => {{ const e = {ED}; const r = e.doc.objects.find((o) => o.kind === 'component' && o.designator === 'R4'); e.select(['o' + r.index]); }})()"); pg.wait_for_timeout(300)
    pg.evaluate("window.konium.run('live.panel')"); pg.wait_for_timeout(600)
    box = lp.get_by_label("Resistance", exact=True)
    v0 = box.input_value()
    e0 = pg.evaluate(READ)["volt"]
    box.fill("2k"); box.press("Enter"); pg.wait_for_timeout(900)
    v1 = box.input_value(); label = pg.evaluate(f"{ED}.undo.undoLabel")
    sl = lp.get_by_label("Turn the resistance down or up")
    for xx in (20, 40, 60):
        sl.evaluate("(el, x) => { el.value = String(x); el.dispatchEvent(new Event('input', { bubbles: true })); }", xx); pg.wait_for_timeout(150)
    v2 = box.input_value()
    sl.evaluate("(el) => el.dispatchEvent(new Event('change', { bubbles: true }))"); pg.wait_for_timeout(300)
    back = sl.input_value()
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(300); u1 = box.input_value()
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(300); u2 = box.input_value()
    rows = lp.locator("section[aria-label='The part selected'] > .pw-field").count()
    check(f"A part's value in the panel (26.182): R4 selected shows its resistance ({v0}); 2k typed and Enter is a change to the sheet ({v1}, {label!r}); its slider held to 60 of 100 turns it to {v2} and springs back ({back}); one Undo takes the whole turn back ({u1}), the next the typing ({u2}); {rows} rows",
          v0 == "1k" and v1 == "2k" and label == "Change R4's value" and v2 == "7.96k" and back == "0" and u1 == "2k" and u2 == "1k" and rows == 3)   # (its value, the slider under it, and what it is rated for: 26.186)
    c.close()

    # 26.182 (R18 public): Live Simulation is on in the release itself (no features=all); the two icons redrawn in 26.181
    c, pg = site_page("26.182-stage")
    pg.goto(URL.replace("&features=all", "")); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openSimDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".menubar-item", has_text="Design").first.click(); pg.wait_for_timeout(300)
    pg.locator(".menu-popup").last.locator(".menu-item", has_text="Simulate").first.hover(); pg.wait_for_timeout(500)
    sims = pg.locator(".menu-popup").last.locator(".menu-item").all_inner_texts()
    pg.locator(".menu-popup").last.locator(".menu-item", has_text="Live Simulation").first.click(); pg.wait_for_timeout(1800)
    ran = pg.evaluate("window.konium.liveReading()")
    panels = [pg.locator(".livepanel").get_by_role("button", name="Stop").count(), pg.locator(".livescope").count()]
    pg.locator(".livepanel").get_by_role("button", name="Stop").click(); pg.wait_for_timeout(400)
    stopped = pg.evaluate("window.konium.liveReading()")
    ico = pg.evaluate("""() => { const b = (t) => [...document.querySelectorAll('.toolbars .tbtn')].find((x) => (x.getAttribute('aria-label') || '').startsWith(t));
      const fills = (el) => el ? [...el.querySelectorAll('svg *')].map((n) => n.getAttribute('fill')).filter((f) => f && f !== 'none') : [];
      return { open: fills(b('Open')), neu: fills(b('New')), circle: !!b('New')?.querySelector('svg circle') }; }""")
    check(f"R18 public (26.182): with no features=all Design › Simulate offers {sims}; Live Simulation starts the run ({ran is not None and round(ran['volt'].get('VCC', 0), 2)} V on VCC) with its panel and the Live Scope ({panels}); Stop ends it ({stopped is None}). The Open icon is a folder with a document in it ({ico['open']}), New a page with a badge ({ico['neu']}, {ico['circle']})",
          sims == ["Mixed Sim", "Live Simulation", "Live Simulation Examples...", "Run the Selection as a Sketch"] and ran is not None and abs(ran["volt"].get("VCC", 0) - 12) < 1e-6 and panels == [1, 1] and stopped is None
          and ico["open"] == ["#f0c75a", "#ffffff", "#f7da84"] and "#3f9a6a" in ico["neu"] and ico["circle"])
    c.close()
    # 26.183: Live Simulation's kit: the examples, a logic input clicked, a light, a part's own values, the keys
    c, pg = site_page("26.183-kit")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    MON = "window.konium.liveMonitors().map((m) => [m.label, m.text])"
    home = pg.locator(".home-link", has_text="Live Simulation examples...").count()
    pg.evaluate("window.konium.run('live.examples')"); pg.wait_for_timeout(600)
    dlg = pg.locator(".dlg.liveex")
    kinds = dlg.locator(".grid").first.locator(".grid-row").all_inner_texts() if dlg.locator(".grid").count() else []
    if not kinds: kinds = [t for t in dlg.locator("[role=row]").all_inner_texts()]
    first = dlg.get_by_text("Ohm's law", exact=True).count()
    dlg.get_by_text("Logic and chips", exact=True).click(); pg.wait_for_timeout(200)
    about0 = dlg.locator(".liveex-about").inner_text()
    dlg.get_by_text("Logic gates", exact=True).click(); pg.wait_for_timeout(200)
    dlg.get_by_role("button", name="Open and Run").click(); pg.wait_for_timeout(3500)
    name = pg.evaluate("window.konium.state.active.value.name")
    m0 = pg.evaluate(MON)
    # IN1 is low and IN2 high: a click on IN1 makes it high, and the AND and exclusive-OR gates answer
    x, y = pg.evaluate(TO_SCREEN, [16000000, 48000000]); pg.mouse.click(x, y); pg.wait_for_timeout(1500)
    m1 = pg.evaluate(MON)
    mode = pg.evaluate(f"{ED}.doc.objects.find((o) => o.kind === 'component' && o.designator === 'IN1').displayMode")
    note = pg.locator(".livepanel section[aria-label='From the netlist']").count()
    check(f"Live Simulation examples (26.183): Home offers them ({home}); the dialog lists them by kind ({len(kinds)} rows read, Ohm's law first: {first}), says what each shows ({about0[:40]!r}); Logic gates opens as {name!r} and runs: {m0}; a click on IN1 makes it high ({mode}): {m1}; no note about a missing ground ({note})",
          home == 1 and first == 1 and "Click an input" in about0 and name == "Logic gates.SchDoc" and m0 == [["TP1", "0 V"], ["TP2", "5.00 V"], ["TP3", "5.00 V"]]
          and mode == 1 and m1 == [["TP1", "5.00 V"], ["TP2", "5.00 V"], ["TP3", "0 V"]] and note == 0)
    # The 555 timer flashes its LED: started discharged, at half a second a second; its test points on the first scope
    pg.evaluate("window.konium.liveExample('timer')"); pg.wait_for_timeout(3000)
    lit = []
    for _ in range(40):
        lit.append(pg.evaluate("window.konium.liveLights().map((l) => l.brightness)[0] ?? -1")); pg.wait_for_timeout(100)
    lp = pg.locator(".livepanel")
    zero = lp.get_by_label("Start with everything discharged").is_checked()
    speed = lp.get_by_label("Speed", exact=True).input_value()
    sc = pg.evaluate("(() => { const d = window.konium.liveScope(1); return d && d.probes.map((p) => p.probe.label); })()")
    scopes = pg.evaluate("window.konium.liveScopes().length")
    check(f"A 555 flashing an LED (26.183): the LED goes from {min(lit):.2f} to {max(lit):.2f} of its full brightness over four seconds; started discharged ({zero}) at {speed} s a second; its test points on the one scope ({sc}, {scopes} scope)",
          min(lit) < 0.05 and max(lit) > 0.6 and zero and speed == "0.5" and sc == ["TP1", "TP2"] and scopes == 1)
    # A part's own values: the Zener regulator's diode, its Zener voltage typed
    pg.evaluate("window.konium.liveExample('zener')"); pg.wait_for_timeout(3000)
    z0 = pg.evaluate(MON)
    pg.evaluate(f"(() => {{ const e = {ED}; const r = e.doc.objects.find((o) => o.kind === 'component' && o.designator === 'D1'); e.select(['o' + r.index]); }})()"); pg.wait_for_timeout(400)
    fields = pg.evaluate("(() => { const f = window.konium.liveFieldsNow(); return f && [f.name, f.fields.map((x) => x.label + ' ' + x.text + ' ' + x.unit)]; })()")
    box = lp.get_by_label("Zener voltage", exact=True)
    box.fill("3.3"); box.press("Enter"); pg.wait_for_timeout(1500)
    z1 = pg.evaluate(MON)
    volts = lambda m: float(m[0][1].split(" ")[0]) if m and m[0][1].endswith(" V") else -1
    check(f"Every value in the panel (26.183): the Zener regulator reads {z0}; its diode selected lists {fields}; 3.3 typed for the Zener voltage and the output is {z1}",
          abs(volts(z0) - 5.1) < 0.2 and fields and fields[0] == "Zener diode" and fields[1][:2] == ["Zener voltage 5.1 V", "Forward voltage 0.7 V"] and len(fields[1]) == 5 and fields[1][4] == "Rated for 0.5 W" and abs(volts(z1) - 3.3) < 0.2)
    # Keys: R picks up a resistor while the sheet runs, W a wire; with the tick cleared they do not
    pg.evaluate(f"(() => {{ const e = {ED}; e.selection = new Set(); e.invalidateOverlay(); }})()")
    x, y = pg.evaluate(TO_SCREEN, [30000000, 52000000]); pg.mouse.move(x, y); pg.wait_for_timeout(200)
    sel = lambda: pg.evaluate(f"{ED}.selecting")
    parts = lambda: pg.evaluate(f"{ED}.doc.objects.filter((o) => o.kind === 'component').length")
    n0 = parts(); s0 = sel()
    pg.keyboard.press("r"); pg.wait_for_timeout(500); s1 = sel()
    pg.mouse.move(x + 6, y + 4); pg.wait_for_timeout(200); pg.mouse.click(x + 6, y + 4); pg.wait_for_timeout(400); pg.keyboard.press("Escape"); pg.wait_for_timeout(400); n1 = parts(); s2 = sel()
    last = pg.evaluate(f"(() => {{ const c = {ED}.doc.objects.filter((o) => o.kind === 'component'); return [c[c.length - 1].libRef, c[c.length - 1].designator]; }})()")
    pg.keyboard.press("w"); pg.wait_for_timeout(500); s3 = sel(); pg.keyboard.press("Escape"); pg.wait_for_timeout(300); pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    pg.evaluate("window.konium.run('live.panel')"); pg.wait_for_timeout(600)
    tick = lp.get_by_label("Keys place parts")
    tick.uncheck(); pg.wait_for_timeout(300)
    pg.mouse.move(x, y); pg.keyboard.press("r"); pg.wait_for_timeout(500); s4 = sel(); pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    pg.evaluate("window.konium.run('live.panel')"); pg.wait_for_timeout(600)
    badges0 = lp.locator(".live-key").count()
    tick.check(); pg.wait_for_timeout(300)
    badges = lp.locator(".live-key").count()
    check(f"Keys while sketching (26.183): the sheet idle ({s0}); R picks up a resistor ({not s1}), a click places it ({n1 - n0} more part, {last}) and Esc ends it ({s2}); W starts a wire ({not s3}); with Keys place parts cleared R places nothing ({s4}) and the tiles show no keys ({badges0}); ticked again they show {badges}",
          s0 and not s1 and n1 - n0 == 1 and last[0] == "RES" and s2 and not s3 and s4 and badges0 == 0 and badges == 36)
    c.close()
    # 26.184: flip-flops, counter and display, fuse, thyristor, sound; a project sent as a ZIP archive
    c, pg = site_page("26.184-parts")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    LAMP = "window.konium.liveLights().map((l) => +l.brightness.toFixed(2))"
    def click_at(at, hold=0):
        x, y = pg.evaluate(TO_SCREEN, at); pg.mouse.move(x, y); pg.wait_for_timeout(150)
        if hold: pg.mouse.down(); pg.wait_for_timeout(hold); pg.mouse.up()
        else: pg.mouse.click(x, y)
        pg.wait_for_timeout(1200)
    # The counter on its display: the digit goes on with the clock; IN1 high clears it
    pg.evaluate("window.konium.liveExample('counter')"); pg.wait_for_timeout(2500)
    digits = []
    for _ in range(30):
        d = pg.evaluate("window.konium.liveDisplays().map((x) => x.digit)[0] ?? '?'")
        if not digits or digits[-1] != d: digits.append(d)
        pg.wait_for_timeout(150)
    click_at([14000000, 38000000]); pg.wait_for_timeout(800)
    cleared = [pg.evaluate("window.konium.liveDisplays()[0]") for _ in range(3) if pg.wait_for_timeout(500) is None]
    order = all(a.isdigit() and b.isdigit() and int(b) == (int(a) + 1) % 10 for a, b in zip(digits, digits[1:]))
    check(f"A counter on a seven-segment display (26.184): over four seconds and more the digit goes {''.join(digits)}; IN1 clicked high: {[x['digit'] for x in cleared]} (segments {cleared[-1]['lit']})",
          len(digits) >= 3 and order and all(x["digit"] == "0" and x["lit"] == "abcdef" for x in cleared))
    # The fuse: the lamp lit through it; SW1 closed, it blows and stays blown with SW1 open again; a click makes it good
    pg.evaluate("window.konium.liveExample('fuse')"); pg.wait_for_timeout(3000)
    FUSE = "[window.konium.liveFuses().map((f) => f.blown)[0], " + LAMP + "[0]]"
    f0 = pg.evaluate(FUSE)
    click_at([44000000, 43000000]); f1 = pg.evaluate(FUSE)
    click_at([44000000, 43000000]); f2 = pg.evaluate(FUSE)
    undo = pg.evaluate(f"{ED}.undo.undoLabel")
    click_at([23000000, 46000000]); f3 = pg.evaluate(FUSE)
    check(f"A fuse (26.184): whole and the lamp lit {f0}; SW1 closed: blown, the lamp out {f1}; SW1 opened: still blown {f2}; the fuse clicked: whole again, the lamp lit {f3}, and the sheet not changed by it (last Undo {undo!r})",
          f0 == [False, 1] and f1 == [True, 0] and f2 == [True, 0] and f3 == [False, 1] and undo == "Open SW1")
    # The thyristor: SW1 held turns it on, it stays on when let go; SW2 held takes its current and it stays off
    pg.evaluate("window.konium.liveExample('scr')"); pg.wait_for_timeout(3000)
    s0 = pg.evaluate(LAMP)
    click_at([26000000, 37000000], hold=1500); s1 = pg.evaluate(LAMP)
    click_at([50000000, 38000000], hold=1500); s2 = pg.evaluate(LAMP)
    check(f"A thyristor (26.184): the lamp {s0} before; {s1} after SW1 was pressed and let go; {s2} after SW2 was", s0 == [0] and s1[0] > 0.7 and s2 == [0])
    # Sound: the speaker's stretches are played; with the tick cleared they are not
    pg.evaluate("window.konium.liveExample('beats')"); pg.wait_for_timeout(700)
    pg.evaluate("window.konium.run('live.panel')"); pg.wait_for_timeout(500)
    lp = pg.locator(".livepanel")
    tick = lp.get_by_label("Sound from the speaker")
    shown = tick.count() == 1 and tick.is_checked()
    pg.wait_for_function("window.konium.liveSound().played >= 2", timeout=40000)
    so = pg.evaluate("window.konium.liveSound()")
    tick.uncheck(); pg.wait_for_timeout(400)
    p0 = pg.evaluate("window.konium.liveSound().played"); pg.wait_for_timeout(4000)
    p1 = pg.evaluate("window.konium.liveSound()")
    tick.check(); pg.wait_for_timeout(300)
    check(f"Sound (26.184): the panel offers it ({shown}); two tones beating are heard: {so['outputs']}, the sound {so['state']}, {so['played']} stretches played; with the tick cleared {p1['played'] - p0} more in four seconds while {p1['outputs'][0]['stretches'] - so['outputs'][0]['stretches']} more were heard",
          shown and so["state"] == "running" and so["outputs"][0]["designator"] == "LS1" and so["outputs"][0]["peak"] > 0.8 and p1["played"] == p0 and p1["outputs"][0]["stretches"] > so["outputs"][0]["stretches"])
    # A tone at real time: the 555 turns over many times between the scope's samples, and is still read at its own rate, in its band
    pg.evaluate("window.konium.liveExample('tone')"); pg.wait_for_timeout(700)
    TONE = "(() => { const d = window.konium.liveScope(); const p = d && d.probes && d.probes.find((q) => q.probe.label === 'TP1'); const s = p && p.v; if (!s || !s.m) return null; let full = 0; for (let i = 1; i < s.y.length; i++) if (s.lo && s.hi[i] - s.lo[i] > 6) full++; return { freq: s.m.freq, min: s.m.min, max: s.m.max, n: s.y.length, full, span: s.t.length ? s.t[s.t.length - 1] - s.t[0] : 0 }; })()"
    pg.wait_for_function("(() => { const t = " + TONE + "; return !!t && t.span > 0.6 && t.freq > 0; })()", timeout=90000)
    tone = pg.evaluate(TONE)
    spk = pg.evaluate(f"(() => {{ const e = {ED}; const c = e.doc.objects.find((o) => o.kind === 'component' && o.designator === 'LS1'); return [c.libRef, e.doc.objects.filter((o) => o.kind === 'pin' && o.owner === c.index).length]; }})()")
    check(f"A tone at real time (26.184): the speaker is {spk[0]} with {spk[1]} terminals; the 555's output over {tone['span']:.2f} s in {tone['n']} samples reads {tone['freq']:.1f} Hz (218 Hz by its parts), {tone['min']:.2f} V to {tone['max']:.2f} V, {tone['full']} of the samples carrying its whole swing between them",
          spk == ["SPEAKER", 2] and 208 < tone["freq"] < 228 and tone["min"] < 0.2 and tone["max"] > 7.2 and tone["full"] > tone["n"] * 0.1)
    c.close()
    # A project sent as a ZIP archive opens as the files in it; the desktop software's own file beside the project is left closed
    c, pg = site_page("26.184-zip")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    import base64 as _b64, io as _io, zipfile as _zf
    demo = pg.evaluate("window.konium.demoFiles().map((f) => [f.name, btoa(Array.from(f.bytes, (b) => String.fromCharCode(b)).join(''))])")
    buf = _io.BytesIO()
    with _zf.ZipFile(buf, "w", _zf.ZIP_DEFLATED) as z:
        for name, data in demo: z.writestr("Demo/" + name, _b64.b64decode(data))
        z.writestr("Demo/Demo.PrjPcbStructure", "Record=TopLevelDocument|FileName=Demo.SchDoc|SheetNumber=1\r\n")
        z.writestr("Demo/History/Demo.~(1).SchDoc.Zip", b"PK")
    got = pg.evaluate("""async (b) => { const k = window.konium, bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
      const files = await k.unpacked([{ name: 'Demo sent.zip', bytes }]); k.openBatch(files); await new Promise((r) => setTimeout(r, 2500));
      const front = k.state.active.value;
      return { files: files.length, names: files.map((f) => f.name).filter((n) => /Structure|\\.zip$/i.test(n)), projects: k.state.projects.value.map((p) => [p.name, p.files.size]), docs: k.state.docs.value.map((d) => d.name), front: front && front.name, inProject: !!(front && front.projectId) }; }""", _b64.b64encode(buf.getvalue()).decode())
    check(f"A project in a ZIP archive (26.184): {got['files']} files taken from it; the project {got['projects']} opens with {got['docs']}, {got['front']!r} in front; the structure file the desktop software keeps is not opened ({[d for d in got['docs'] if 'Structure' in d]})",
          got["files"] == len(demo) + 1 and got["names"] == ["Demo.PrjPcbStructure"] and len(got["projects"]) == 1 and got["projects"][0][0] == "Demo.PrjPcb" and got["projects"][0][1] >= 2
          and len(got["docs"]) >= 1 and not any("Structure" in d for d in got["docs"]) and got["inProject"])
    c.close()
    # 26.185: calculators, Follow Mouse Trail, the PCB defaults' kinds
    c, pg = site_page("26.185-calc")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    # From the Home page, with nothing open: the panel, its calculators in two groups, the divider as it first stands
    home = pg.locator(".home-links button, .home-links a", has_text="Calculators...")
    home_n = home.count()
    if home_n: home.first.click(); pg.wait_for_timeout(700)
    cp = pg.locator(".calcpanel")
    names = cp.locator("select[aria-label='Calculator'] option").all_text_contents() if cp.count() else []
    groups = cp.locator("select[aria-label='Calculator'] optgroup").evaluate_all("(els) => els.map((g) => [g.label, g.children.length])") if cp.count() else []
    res = lambda: dict(zip(cp.locator("dl.field-figures dt").all_text_contents(), cp.locator("dl.field-figures dd").all_text_contents()))
    r0 = res() if cp.count() else {}
    check(f"Calculators from the Home page with no document open (26.185): the panel ({cp.count()}), {len(names)} calculators in {groups}; the divider as it stands gives {r0.get('Output')} and {r0.get('Nearest E24 pair')}",
          home_n == 1 and cp.count() == 1 and len(names) == 14 and groups == [["Everyday", 10], ["The board", 4]] and r0.get("Output") == "2.5 V" and r0.get("Output resistance") == "5 kΩ")
    # Find: the box worked out cannot be typed in; quantities as an engineer writes them; what is typed is kept over a reload
    cp.locator("select[aria-label='Find']").select_option("r2")
    def put(label, text):
        box = cp.locator(f"input[aria-label='{label}']"); box.fill(text); box.press("Tab"); pg.wait_for_timeout(200)
    put("Input", "5"); put("R1", "10k"); put("Output", "3.3 V")
    found = cp.locator("input[aria-label='R2']")
    r1 = res()
    f_val, f_ro = found.input_value(), found.get_attribute("readonly") is not None
    put("R1", "4k7"); f_val2 = found.input_value()
    put("Output", "6"); say = cp.locator(".pw-results [role=status]").inner_text() if cp.locator(".pw-results [role=status]").count() else ""
    put("Output", "3.3"); put("R1", "10k")
    pg.reload(); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1500)
    pg.evaluate("window.konium.run('tools.calculators')"); pg.wait_for_timeout(700)
    cp = pg.locator(".calcpanel")
    kept = [cp.locator("select[aria-label='Find']").input_value(), cp.locator("input[aria-label='R1']").input_value(), cp.locator("input[aria-label='R2']").input_value()]
    check(f"A divider's R2 for 3.3 V from 5 V (26.185): {f_val} (read only: {f_ro}), {r1.get('Current in R1')} in R1, the nearest pair {r1.get('Nearest E24 pair')}; with R1 4k7: {f_val2}; an output of 6 V: {say!r}; after a reload {kept}",
          f_val == "19.41k" and f_ro and r1.get("Current in R1") == "170 µA" and re.match(r"^R1 [\d.]+ kΩ, R2 [\d.]+ kΩ: 3\.\d+ V \([+-]\d\.\d\d %\)$", r1.get("Nearest E24 pair", "")) is not None
          and f_val2 == "9.124k" and "between 0 V and the input" in say and kept == ["r2", "10k", "19.41k"])
    # A few of the others, by their own figures
    def pick(cid, wait=300):
        cp.locator("select[aria-label='Calculator']").select_option(cid); pg.wait_for_timeout(wait)
    pick("led"); put("Supply", "12"); put("LED voltage", "3.2"); put("Current", "20mA"); put("LEDs in a row", "2"); led = res()
    pick("ohm"); ohm = res()
    pick("standard"); put("Value", "4.99k"); std = res()
    pick("spacing"); put("Voltage", "230"); sp = res()
    check(f"More calculators (26.185): two 3.2 V LEDs at 20 mA from 12 V want {led.get('Resistor')}, next up {led.get('Next E24 value up')} for {led.get('Current with it')}; 5 V across 1 kΩ is {ohm.get('Current')} and {ohm.get('Power')}; 4.99k is {std.get('E24')} in E24 and {std.get('E96')} in E96; 230 V wants {sp.get('Outer layer, bare, up to 3050 m')} on a bare outer layer and {sp.get('Inside the board')} inside",
          led.get("Resistor") == "280 Ω" and led.get("Next E24 value up") == "300 Ω" and led.get("Current with it") == "18.67 mA" and ohm.get("Current") == "5 mA" and ohm.get("Power") == "25 mW"
          and std.get("E24", "").startswith("5.1 k (+2.20 %)") and std.get("E96") == "4.99 k (+0.00 %)" and sp.get("Outer layer, bare, up to 3050 m") == "1.25 mm (49.2 mil)" and sp.get("Inside the board") == "0.2 mm (7.87 mil)")
    # With a board in front: Tools › Calculators in the menu; a selected track's width, copper and length taken; the impedance is the Field Solver's
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(800)
    in_menu = pg.evaluate("(() => { const m = window.konium.menuBar ? window.konium.menuBar('pcb') : null; return m ? JSON.stringify(m).includes('tools.calculators') : null; })()")
    pg.evaluate("window.konium.run('tools.calculators', 'pcb')"); pg.wait_for_timeout(600)
    cp = pg.locator(".calcpanel")
    pick("track")
    from_btn = cp.get_by_role("button", name="From the selected track")
    off = from_btn.is_disabled()
    tr = pg.evaluate(f"""(() => {{ const e = {ED}; const t = e.doc.prims.filter((p) => p.kind === 'track' && p.layer === 1 && p.net !== 0xffff).sort((a, b) => Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y) - Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y))[0];
      e.select([t.src.storage + ':' + t.src.index]); return {{ width: t.width / 10000 * 0.0254, length: Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y) / 10000 * 0.0254 }}; }})()"""); pg.wait_for_timeout(400)
    cp.locator("select[aria-label='Find']").select_option("current"); pg.wait_for_timeout(200)
    from_btn.click(); pg.wait_for_timeout(400)
    got_w, got_l = float(cp.locator("input[aria-label='Width']").input_value()), float(cp.locator("input[aria-label='Length']").input_value())
    trk = res()
    pick("impedance", 400)
    pg.wait_for_function("(() => { const d = document.querySelector('.calcpanel dl.field-figures'); return !!d && /Ω/.test(d.textContent); })()", timeout=60000)
    imp = res()
    check(f"The board's calculators (26.185): the button waits for a track ({off}); the longest track on the top layer, {tr['width']:.3f} mm wide and {tr['length']:.2f} mm long, is taken as {got_w} mm and {got_l} mm and carries {trk.get('Current')} for a 10 °C rise, dropping {trk.get('Voltage dropped')}; a 0.36 mm track 0.2 mm over a plane is {imp.get('Impedance')}",
          in_menu is not False and off and abs(got_w - tr["width"]) < 0.002 and abs(got_l - tr["length"]) < 0.02 and re.match(r"^[\d.]+ m?A$", trk.get("Current", "")) is not None and re.match(r"^[\d.]+ m?V$", trk.get("Voltage dropped", "")) is not None
          and re.match(r"^(4[89]|5[01])\.\d\d Ω$", imp.get("Impedance", "")) is not None)
    # Preferences: Follow Mouse Trail is an option now; PCB Editor › Defaults lists each kind of dimension, a 3D body, the tables and the keepouts
    pg.evaluate("window.konium.run('ad:PCB:PopupOptionsDefaults')"); pg.wait_for_timeout(500)
    rows = pg.locator(".pdef-row").all_inner_texts()
    pg.locator(".pdef-row", has_text=re.compile(r"^Linear Dimension( \*)?$")).dispatch_event("mousedown"); pg.wait_for_timeout(150)
    pg.locator(".pdef-buttons .btn", has_text="Edit Values").click(); pg.wait_for_timeout(300)
    dlg_title = pg.locator(".dlg.bagdefaults .dlg-title, .dlg.bagdefaults header").first.inner_text() if pg.locator(".dlg.bagdefaults").count() else ""
    fields = pg.locator(".dlg.bagdefaults .do-row").count()
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    pg.evaluate("window.konium.state.prefsPage.value = 'pcb-routing'; window.konium.state.showPrefs.value = true"); pg.wait_for_timeout(400)
    trail_row = pg.locator(".dlg.prefs .pref-row", has_text="Follow Mouse Trail")
    trail = [trail_row.count(), trail_row.first.evaluate("(el) => el.classList.contains('pref-todo')") if trail_row.count() else None, trail_row.locator("input").first.is_disabled() if trail_row.count() else None]
    pg.locator(".dlg.prefs .btn", has_text="Cancel").click(); pg.wait_for_timeout(200)
    pg.evaluate("window.konium.state.prefsPage.value = null")
    check(f"PCB Editor › Defaults (26.185): {len(rows)} kinds, in order ({rows[0]} to {rows[-1]}), with {[r for r in rows if 'Dimension' in r or 'Keepout' in r or 'Table' in r or 'Body' in r]}; Linear Dimension's values open as {dlg_title!r} with {fields} boxes",
          len(rows) == 25 and rows == sorted(rows, key=lambda r: r.rstrip(' *')) and sum('Dimension' in r for r in rows) == 10 and any(r.startswith("Component Body") for r in rows) and any(r.startswith("Keepout Track") for r in rows)
          and "Linear Dimension Defaults" in dlg_title and fields == 12)
    check(f"Follow Mouse Trail (26.185): on Preferences › PCB Editor › Interactive Routing it is an option like the others ([rows, greyed, disabled] = {trail})", trail == [1, False, False])
    c.close()
    # 26.186: Live Simulation's follow-ups: the new parts, an oscillator's rate, what a sheet keeps, ratings, solving for a value, a selection as a sketch
    c, pg = site_page("26.186-live")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    def click_at(at, hold=0):
        x, y = pg.evaluate(TO_SCREEN, at); pg.mouse.move(x, y); pg.wait_for_timeout(150)
        if hold: pg.mouse.down(); pg.wait_for_timeout(hold); pg.mouse.up()
        else: pg.mouse.click(x, y)
        pg.wait_for_timeout(1200)
    SAVED = f"(() => {{ const r = {ED}.doc.records.find((x) => x.bag && x.bag.get('NAME') === 'LiveSimulation'); return r ? r.bag.get('TEXT') : null; }})()"
    MONS = "window.konium.liveMonitors().filter((m) => !m.meter).map((m) => m.label)"
    # The ring counter: one LED lit at a time, and not the same one a little later
    pg.evaluate("window.konium.liveExample('chaser')"); pg.wait_for_timeout(3000)
    LIT = "window.konium.liveLights().map((l, i) => (l.brightness > 0.2 ? i : -1)).filter((i) => i >= 0)"
    lit = []
    for _ in range(6): lit.append(pg.evaluate(LIT)); pg.wait_for_timeout(450)
    check(f"A ring counter (26.186): of its ten LEDs the lit one, looked at six times over three seconds: {lit}", all(len(x) == 1 for x in lit) and len({x[0] for x in lit}) >= 3)
    # Quick and slow-blow fuses: SW1 closed, the capacitors' inrush blows the quick one only; a click on it puts a new one in
    pg.evaluate("window.konium.liveExample('inrush')"); pg.wait_for_timeout(3000)
    FUSES = "window.konium.liveFuses().map((f) => [f.designator, f.blown])"
    f0 = pg.evaluate(FUSES)
    click_at([22000000, 50000000]); pg.wait_for_timeout(1500); f1 = pg.evaluate(FUSES)
    lamps = pg.evaluate("window.konium.liveLights().map((l) => [l.designator, +l.brightness.toFixed(1)])")
    check(f"Quick and slow-blow fuses (26.186): whole before {f0}; SW1 closed: {f1}; the lamps {lamps}",
          f0 == [["F1", False], ["F2", False]] and f1 == [["F1", True], ["F2", False]] and lamps[0][1] < 0.2 and lamps[1][1] > 0.8)
    # The astable multivibrator: 20 Hz by its parts, read as that on the scope
    pg.evaluate("window.konium.liveExample('astable')"); pg.wait_for_timeout(1000)
    RATE = "(() => { const d = window.konium.liveScope(); const p = d && d.probes && d.probes.find((q) => q.probe.label === 'TP1'); const s = p && p.v; return s && s.m ? { freq: s.m.freq, span: s.t.length ? s.t[s.t.length - 1] - s.t[0] : 0, min: s.m.min, max: s.m.max } : null; })()"
    pg.wait_for_function("(() => { const t = " + RATE + "; return !!t && t.span > 0.2 && t.freq > 0; })()", timeout=90000)
    ast = pg.evaluate(RATE)
    check(f"The astable multivibrator (26.186): {ast['freq']:.2f} Hz over {ast['span']:.2f} s of the circuit's time (20.1 Hz by its parts), {ast['min']:.2f} V to {ast['max']:.2f} V", 19.6 < ast["freq"] < 20.6 and ast["min"] < 0.1 and ast["max"] > 4.9)
    # Two tones beating: 442 Hz
    pg.evaluate("window.konium.liveExample('beats')"); pg.wait_for_timeout(1000)
    pg.wait_for_function("(() => { const t = " + RATE + "; return !!t && t.span > 0.9 && t.freq > 0; })()", timeout=120000)
    beat = pg.evaluate(RATE)
    check(f"Two tones beating (26.186): 440 Hz and 444 Hz together repeat at {beat['freq']:.1f} Hz over {beat['span']:.2f} s", 436 < beat["freq"] < 448)
    # What a sheet keeps: a monitor kept is the sheet's parameter; it is back at the next run, and Undo takes it off
    pg.evaluate("window.konium.liveExample('divider')"); pg.wait_for_timeout(3000)
    s0 = pg.evaluate(SAVED); dirty0 = pg.evaluate(f"{ED}.undo.canUndo")
    took = pg.evaluate("window.konium.liveProbe({ x: 36000000, y: 40000000 }, 'scope')"); pg.wait_for_timeout(500)
    s1 = pg.evaluate(SAVED); m1 = pg.evaluate(MONS); label = pg.evaluate(f"{ED}.undo.undoLabel")
    pg.evaluate("window.konium.run('live.stop')"); pg.wait_for_timeout(400)
    pg.evaluate("window.konium.run('live.start')"); pg.wait_for_timeout(1500)
    m2 = pg.evaluate(MONS)
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(1200)
    s3 = pg.evaluate(SAVED); m3 = pg.evaluate(MONS)
    pg.evaluate("window.konium.run('edit.redo')"); pg.wait_for_timeout(1200)
    m4 = pg.evaluate(MONS)
    check(f"Kept with the sheet (26.186): the example as it opens keeps nothing ({s0!r}, nothing to undo: {not dirty0}); a wire kept on the scope ({took}) is the sheet's parameter {s1!r} ({label!r}), monitors {m1}; after Stop and Start: {m2}; Undo: {s3!r}, {m3}; Redo: {m4}",
          s0 is None and not dirty0 and took and s1 == "v=1;scopes=time;keep=3600:4000>1" and label == "Change what Live Simulation watches" and m1 == ["OUT"] and m2 == ["OUT"] and s3 is None and m3 == [] and m4 == ["OUT"])
    # Solve for a value: R2 for 3.3 V at the test point
    pg.evaluate(f"(() => {{ const e = {ED}; const r = e.doc.objects.find((o) => o.kind === 'component' && o.designator === 'R2'); e.select(['o' + r.index]); }})()"); pg.wait_for_timeout(300)
    pg.evaluate("window.konium.run('live.panel')"); pg.wait_for_timeout(600)
    lp = pg.locator(".livepanel")
    sv = lp.locator(".live-solve")
    finds = sv.get_by_label("The value to find").locator("option").all_text_contents()
    reads_ = sv.get_by_label("What is to read it").locator("option").all_text_contents()
    sv.get_by_label("What is to read it").select_option(label="TP1, voltage")
    off = sv.get_by_role("button", name="Find It").is_disabled()
    sv.get_by_label("What it is to read").fill("3.3"); sv.get_by_role("button", name="Find It").click(); pg.wait_for_timeout(1500)
    said = sv.locator("[role=status]").inner_text()
    r2 = lp.get_by_label("Resistance", exact=True).input_value()
    tp = pg.evaluate("window.konium.liveMonitors().filter((m) => m.label === 'TP1').map((m) => m.text)")
    widths = sv.locator(".pw-field select, .pw-field input").evaluate_all("(els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().width)))]")
    sv.get_by_label("What it is to read").fill("12"); sv.get_by_role("button", name="Find It").click(); pg.wait_for_timeout(1500)
    none = sv.locator("[role=status]").inner_text()
    check(f"Solve for a value (26.186): R2 offers {finds}, to be read by {reads_}; Find It waits for a number ({off}); for 3.3 V: {said!r}; the box reads {r2}, the test point {tp}; its boxes are of one width ({widths}); for 12 V: {none!r}",
          finds == ["Resistance"] and "TP1, voltage" in reads_ and off and said.startswith("R2's resistance is now 4.925k Ω: TP1 reads 3.30 V at the operating point. The nearest standard value, 5.1k Ω, gives 3.38 V.")
          and r2 == "4.925k" and tp == ["3.30 V"] and len(widths) == 1 and none.startswith("No resistance of R2 from 492.5m Ω to 49.25Meg Ω makes TP1 read 12.0 V: it reads from"))
    # Ratings: R1 of Ohm's law turned down to 22 ohms takes over a watt, and says so; back at 1 k it is let go
    pg.evaluate("window.konium.liveExample('ohm')"); pg.wait_for_timeout(3000)
    pg.evaluate(f"(() => {{ const e = {ED}; const r = e.doc.objects.find((o) => o.kind === 'component' && o.designator === 'R1'); e.select(['o' + r.index]); }})()"); pg.wait_for_timeout(300)
    pg.evaluate("window.konium.run('live.panel')"); pg.wait_for_timeout(600)
    STRESS = "window.konium.liveStress().filter((s) => s.designator === 'R1').map((s) => [s.kind, s.rating, s.over, +s.shown.toFixed(2)])[0]"
    st0 = pg.evaluate(STRESS); rated = lp.get_by_label("Rated for", exact=True).input_value()
    box = lp.get_by_label("Resistance", exact=True)
    box.fill("22"); box.press("Enter"); pg.wait_for_timeout(4000)
    st1 = pg.evaluate(STRESS)
    listed = lp.locator("section[aria-label='Over their ratings'] li").all_inner_texts()
    lp.get_by_label("Rated for", exact=True).fill("2"); lp.get_by_label("Rated for", exact=True).press("Enter"); pg.wait_for_timeout(1500)
    st2 = pg.evaluate(STRESS); gone = lp.locator("section[aria-label='Over their ratings']").count()
    check(f"Ratings (26.186): R1 of Ohm's law is rated for {rated} W and takes {st0}; at 22 ohms: {st1}, the panel lists {listed}; rated for 2 W: {st2}, the list gone ({gone == 0})",
          rated == "0.25" and st0[:3] == ["power", 0.25, False] and st1[2] is True and st1[3] > 1 and len(listed) == 1 and re.match(r"R1: 1\.\d\d W, rated for 250 mW$", listed[0]) and st2[:3] == ["power", 2, False] and gone == 0)
    # A selection as a sketch: the divider's two resistors and its test point taken to a sheet of their own
    pg.evaluate("window.konium.liveExample('divider')"); pg.wait_for_timeout(2500)
    pg.evaluate(f"{ED}.select([])"); pg.evaluate("window.konium.run('live.panel')"); pg.wait_for_timeout(500)
    off0 = pg.locator(".livepanel").get_by_role("button", name="Run the Selection").is_disabled()
    pg.evaluate(f"(() => {{ const e = {ED}; e.select(e.doc.objects.filter((o) => o.owner < 0 && o.record !== 31 && !(o.kind === 'component' && o.designator === 'V1')).map((o) => 'o' + o.index)); }})()"); pg.wait_for_timeout(300)
    pg.evaluate("window.konium.run('live.selection')"); pg.wait_for_timeout(3500)
    sk = pg.evaluate(f"(() => {{ const k = window.konium, d = k.state.active.value, e = d.editor; return {{ name: d.name, free: !d.projectId, parts: e.doc.objects.filter((o) => o.kind === 'component').map((o) => o.designator).sort(), live: !!k.liveReading(), docs: k.state.docs.value.map((x) => x.name) }}; }})()")
    check(f"A selection as a sketch (26.186): with nothing selected the panel's button waits ({off0}); the divider without its source goes to {sk['name']!r} (a document of its own: {sk['free']}) with {sk['parts']}, running ({sk['live']}); the example is still open beside it ({'Voltage divider.SchDoc' in sk['docs']})",
          off0 is True and sk["name"] == "Voltage divider selection.SchDoc" and sk["free"] and sk["parts"] == ["R1", "R2", "TP1"] and sk["live"] and "Voltage divider.SchDoc" in sk["docs"])
    c.close()
    # 26.187: a netlist file loaded into the board in front; a wizard's footprint is the package in 3D
    c, pg = site_page("26.187-netlist")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(800)
    in_menu = pg.evaluate("window.konium.commandIds().includes('pcb.loadNetlist')")
    before = pg.evaluate(f"{ED}.doc.components.map((c) => c.designator).sort().join(',')")
    # The demo's own design as another program would write it (PADS), with no comments in it
    pads_net = "\r\n".join(["*PADS-PCB*", "*PART*", "C1 0805", "C2 0805", "D1 LED0805", "J1 HDR1X2", "R1 0805", "U1 SOT-223", "*NET*",
        "*SIGNAL* +3V3", "C2.1 R1.1 U1.2 U1.4", "*SIGNAL* GND", "C1.2 C2.2 D1.K J1.2", "U1.1", "*SIGNAL* NetD1_A", "D1.A R1.2", "*SIGNAL* VIN", "C1.1 J1.1 U1.3", "*END*", ""])
    with pg.expect_file_chooser() as fc:
        pg.evaluate("window.konium.run('pcb.loadNetlist')")
    fc.value.set_files(files=[{"name": "demo.asc", "mimeType": "text/plain", "buffer": pads_net.encode()}]); pg.wait_for_timeout(900)
    title = pg.locator(".dlg.eco .dlg-title").inner_text().split("\n")[0] if pg.locator(".dlg.eco").count() else ""
    rows = pg.locator(".eco .grid-body .grid-row:not(.eco-group)").all_inner_texts()
    said = (pg.locator(".toast").inner_text() if pg.locator(".toast").count() else "")
    pg.locator(".dlg-foot .btn", has_text="Validate Changes").click(); pg.wait_for_timeout(300)
    ok = [pg.locator(".eco .eco-err").count(), pg.locator(".eco .eco-ok").count()]
    pg.locator(".dlg-foot .btn", has_text="Execute Changes").click(); pg.wait_for_timeout(500)
    pg.locator(".dlg-foot .btn", has_text="Close").click(); pg.wait_for_timeout(500)
    after = pg.evaluate(f"{ED}.doc.components.map((c) => c.designator).sort().join(',')")
    r1 = pg.evaluate(f"(() => {{ const d = {ED}.doc, r = d.components.find((c) => c.designator === 'R1'); return d.prims.filter((p) => p.kind === 'pad' && p.component === r.index).map((p) => [p.name, d.nets[p.net] ? d.nets[p.net].name : '']).sort(); }})()")
    undo = pg.evaluate(f"{ED}.undo.undoLabel")
    # The same file again: nothing to change, and no dialog
    with pg.expect_file_chooser() as fc:
        pg.evaluate("window.konium.run('pcb.loadNetlist')")
    fc.value.set_files(files=[{"name": "demo.asc", "mimeType": "text/plain", "buffer": pads_net.encode()}]); pg.wait_for_timeout(900)
    again = [pg.locator(".dlg.eco").count(), (pg.locator(".toast").inner_text() if pg.locator(".toast").count() else "")]
    # A file that is no netlist
    with pg.expect_file_chooser() as fc:
        pg.evaluate("window.konium.run('pcb.loadNetlist')")
    fc.value.set_files(files=[{"name": "notes.txt", "mimeType": "text/plain", "buffer": b"shopping list"}]); pg.wait_for_timeout(700)
    wrong = (pg.locator(".toast").inner_text() if pg.locator(".toast").count() else "")
    check(f"Design › Netlist › Load a Netlist (26.187): a command of the board's ({in_menu}); a PADS netlist of the demo, with the board at {before}, opens {title!r} with {len(rows)} changes ({said[-90:]!r}); they validate ({ok}) and are carried out: {after}, R1's pads {r1}, one step to undo ({undo!r}); the same file again: {again}; a file that is not one: {wrong[-70:]!r}",
          in_menu and before == "C1,C2,J1,U1" and title == "Engineering Change Order: demo.asc" and len(rows) == 7 and "demo.asc (PADS): 6 parts and 4 nets" in said and ok == [0, 7]
          and after == "C1,C2,D1,J1,R1,U1" and r1 == [["1", "+3V3"], ["2", "NetD1_A"]] and undo == "Load demo.asc" and again[0] == 0 and "nothing to change" in again[1] and "is not a netlist of a kind that is read" in wrong)
    # The package in 3D: an SOIC from the wizard has its body, its leads and its dot, each a 3D body of the footprint
    pg.evaluate("""() => { const f = window.konium.demoFiles().find((x) => x.name === 'Demo.PcbLib'); window.konium.openDocument({ name: 'Demo.PcbLib', bytes: f.bytes }); }"""); pg.wait_for_timeout(900)
    pg.evaluate("window.konium.run('ad:IPCFootprintWizard:Run')"); pg.wait_for_timeout(400)
    pg.locator(".dlg select[aria-label='Component Type']").select_option("SOIC"); pg.wait_for_timeout(200)
    pg.locator(".dlg-foot .btn", has_text="Finish").click(); pg.wait_for_timeout(600)
    soic = pg.evaluate(f"(() => {{ const e = {ED}; const all = e.doc.prims.filter((p) => p.kind === 'body'); return {{ name: e.entry.name, pads: e.doc.prims.filter((p) => p.kind === 'pad').length, bodies: all.length, tallest: Math.max(...all.map((x) => x.overall)) / 10000 * 0.0254, colours: [...new Set(all.map((x) => x.colour))].length }}; }})()")
    pg.evaluate("window.konium.run('view.mode3d')"); pg.wait_for_timeout(1500)
    drawn = pg.evaluate(f"!!{ED}.view3d")
    pg.evaluate("window.konium.run('view.mode2d')"); pg.wait_for_timeout(400)
    check(f"The package in 3D (26.187): the wizard's {soic['name']} has {soic['pads']} pads and {soic['bodies']} 3D bodies (a body in two parts, a dot, three pieces to a lead) in {soic['colours']} colours, the tallest {soic['tallest']:.2f} mm, the package's height; it is drawn in 3D ({drawn})",
          soic["name"] == "SOIC127P600X175-8N" and soic["pads"] == 8 and soic["bodies"] == 27 and soic["colours"] >= 3 and abs(soic["tallest"] - 1.75) < 0.005 and drawn)
    c.close()
    # 26.188: a board of the 1990s' text format opened; a binary board of that time named for what it is
    c, pg = site_page("26.188-older")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    def trk(x1, y1, x2, y2, w, layer, net, tag="FT"): return f"{tag}\r\n0 0 {x1} {y1} {x2} {y2} {w} {layer} 0 {net} 0\r\n 0 0 1 0 0"
    def pad(x, y, w, h, shape, hole, layer, net, name, rot=0): return f"CP\r\n0 0 {x} {y} {w} {h} {shape} {w} {h} {shape} {w} {h} {shape} {hole} 0 {layer} {net} 0 {rot:.3f} 0 0\r\n{name}"
    def txt(x, y, h, layer, stroke, text): return f"CS\r\n0 0 {x} {y} {h} 0.000 0 1 {layer} 0 0 0 0 {stroke} 1 0 0\r\n{text}"
    # A board of this test's own: a resistor and a header, two nets, a route with an arc in it, a via, a keep-out outline
    old = "\r\n".join(["PCB FILE 6 VERSION 2.80", "2 9 3 2 2 1 4 1 4 3",
        "COMP", "RES0805", "0 0 1500000 1200000 1 0 0 0 0 0 0 90.000 1 1 1", txt(1440000, 1290000, 40000, 17, 6000, "R1"), txt(1440000, 1100000, 40000, 17, 6000, "10k"),
        pad(1500000, 1162000, 50000, 60000, 2, 0, 1, 1, "1", 90), pad(1500000, 1238000, 50000, 60000, 2, 0, 1, 2, "2", 90), "ENDCOMP",
        "COMP", "HDR1X2", "0 0 2500000 1200000 1 0 0 0 0 0 0 0.000 1 1 1", txt(2440000, 1320000, 50000, 17, 8000, "J1"), txt(2440000, 1040000, 50000, 17, 8000, "PWR"),
        pad(2500000, 1150000, 65000, 65000, 2, 35000, 34, 2, "1"), pad(2500000, 1250000, 65000, 65000, 1, 35000, 34, 1, "2"), "ENDCOMP",
        trk(1500000, 1162000, 1500000, 1000000, 12000, 1, 1), "FA", "0 0 1600000 1000000 100000 180.000 270.000 12000 1 0 0", " 0 1",
        trk(1600000, 900000, 2000000, 900000, 12000, 1, 1), "FV", "0 0 2000000 900000 50000 28000 0 0 1 0 0 0 1 0 0 1 16", trk(2000000, 900000, 2500000, 1250000, 12000, 16, 1),
        trk(1500000, 1238000, 2500000, 1150000, 12000, 1, 2),
        trk(1000000, 800000, 2800000, 800000, 10000, 28, 0), trk(2800000, 800000, 2800000, 1800000, 10000, 28, 0), trk(2800000, 1800000, 1000000, 1800000, 10000, 28, 0), trk(1000000, 1800000, 1000000, 800000, 10000, 28, 0),
        "NETDEF", "VIN", "0 0 0", "(", "R1-1", "J1-2", ")", "{", "}", "0 0", "NETDEF", "GND", "0 0 0", "(", "R1-2", "J1-1", ")", "{", "}", "0 0", "ENDPCB", ""])
    pg.evaluate("(t) => window.konium.openBatch([{ name: 'Old.PCB', bytes: new TextEncoder().encode(t) }])", old); pg.wait_for_timeout(2500)
    got = pg.evaluate(f"""(() => {{ const k = window.konium, e = k.state.active.value && k.state.active.value.editor, d = e && e.doc;
      if (!d || !d.prims) return {{ front: k.state.active.value ? k.state.active.value.name : null }};
      const n = (kind) => d.prims.filter((p) => p.kind === kind).length, arc = d.prims.find((p) => p.kind === 'arc');
      const xs = d.board.outline.map((p) => p.x), ys = d.board.outline.map((p) => p.y);
      return {{ front: k.state.active.value.name, projects: k.state.projects.value.map((p) => p.name), parts: d.components.map((c) => c.designator + ' ' + c.pattern + ' ' + c.rotation),
        nets: d.nets.map((x) => x.name), counts: [n('track'), n('arc'), n('via'), n('pad'), n('text')], arcNet: arc && d.nets[arc.net] ? d.nets[arc.net].name : null,
        pads: d.prims.filter((p) => p.kind === 'pad').map((p) => d.components[p.component].designator + '-' + p.name + ':' + (d.nets[p.net] ? d.nets[p.net].name : '')),
        size: [(Math.max(...xs) - Math.min(...xs)) / 10000, (Math.max(...ys) - Math.min(...ys)) / 10000] }}; }})()""")
    said = (pg.locator(".toast").inner_text() if pg.locator(".toast").count() else "")
    # A binary board of that time, and a design database: said for what they are, and not opened
    docs0 = pg.evaluate("window.konium.state.docs.value.length")
    pg.evaluate("""() => { const b = (s, lead) => new Uint8Array([...lead, ...[...s].map((ch) => ch.charCodeAt(0)), ...new Array(64).fill(0)]);
      window.konium.openBatch([{ name: 'Board99.PCB', bytes: b('PCB 4.0 Binary File', [19, 0, 0, 0, 19]) }]); }"""); pg.wait_for_timeout(900)
    binary = " ".join(pg.locator(".toast").all_inner_texts())
    docs1 = pg.evaluate("window.konium.state.docs.value.length")
    check(f"A board of the 1990s' text format (26.188): Old.PCB opens as {got.get('front')!r} in {got.get('projects')}: {got.get('parts')}, nets {got.get('nets')}, pads {got.get('pads')}, tracks, arcs, vias, pads and strings {got.get('counts')}, the route's arc on {got.get('arcNet')}, the board {got.get('size')} mil by its keep-out outline ({said[-60:]!r}); a binary board of that time is not opened ({docs1 - docs0} more documents) and is named: {binary[-150:]!r}",
          got.get("front") == "Old.PcbDoc" and got.get("projects") == ["Old.PrjPcb"] and got.get("parts") == ["R1 RES0805 90", "J1 HDR1X2 0"] and got.get("nets") == ["VIN", "GND"]
          and got.get("pads") == ["R1-1:VIN", "R1-2:GND", "J1-1:GND", "J1-2:VIN"] and got.get("counts") == [8, 1, 1, 4, 4] and got.get("arcNet") == "VIN" and got.get("size") == [1800, 1000]
          and docs1 == docs0 and "Board99.PCB: a PCB 4.0 binary board, which is not read here" in binary and "save it as a .PcbDoc" in binary)
    c.close()
    # 26.189: what a click takes on a board: a pad and its component both offered, the chosen one kept; the Selection Filter
    c, pg = site_page("26.189-select")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(800)
    SEL = f"(() => {{ const e = {ED}, d = e.doc; return [...e.selection].map((k) => {{ const p = e.primByKey(k); return p ? p.kind + (p.kind === 'pad' ? ' ' + d.components[p.component].designator + '-' + p.name : '') : k; }}).sort(); }})()"
    pad = pg.evaluate(f"""(() => {{ const e = {ED}, d = e.doc; const c1 = d.components.find((c) => c.designator === 'C1');
      const p = d.prims.find((q) => q.kind === 'pad' && q.component === c1.index && q.name === '1'); return {{ at: [p.at.x, p.at.y], all: e.componentKeys(c1.index).length }}; }})()""")
    x, y = pg.evaluate(TO_SCREEN, pad["at"])
    pg.mouse.move(x, y); pg.wait_for_timeout(200); pg.mouse.click(x, y); pg.wait_for_timeout(900)
    first = len(pg.evaluate(SEL))
    items = pg.locator(".selpopup .menu-item").all_inner_texts()
    pg.locator(".selpopup .menu-item", has_text="Pad C1-1").click(); pg.wait_for_timeout(400)
    chosen = pg.evaluate(SEL)
    # A press on it again keeps it (the list comes again, and goes at the next press), and a double-click opens it as a pad
    pg.mouse.click(x, y); pg.wait_for_timeout(900)
    kept = pg.evaluate(SEL)
    pg.mouse.dblclick(x, y); pg.wait_for_timeout(700)
    dlg = pg.locator(".dlg .dlg-title").first.inner_text().split("\n")[0] if pg.locator(".dlg").count() else ""
    if pg.locator(".dlg").count(): pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    # The Selection Filter: the Inspector with nothing selected
    pg.evaluate(f"{ED}.select([])"); pg.evaluate("window.konium.run('view.panel.properties')"); pg.wait_for_timeout(600)
    sf = pg.locator(".selfilter")
    names = sf.locator(".selfilter-kinds .btn").all_inner_texts()
    pg.mouse.click(x, y); pg.wait_for_timeout(500)
    pg.locator(".selpopup .menu-item", has_text="Pad C1-1").click(); pg.wait_for_timeout(500)
    shown = [t.strip() for t in pg.locator(".inspector .panel-body").inner_text().split("\n") if t.strip() and t.strip() not in ("⊟", "⊞")][0]
    pg.evaluate(f"{ED}.select([])"); pg.wait_for_timeout(300)
    sf = pg.locator(".selfilter")
    lit = sf.locator(".selfilter-kinds .btn.on").count()
    sf.get_by_role("button", name="Components", exact=True).click(); pg.wait_for_timeout(200)
    pg.mouse.move(x, y); pg.mouse.click(x, y); pg.wait_for_timeout(900)
    no_comp = pg.evaluate(SEL)
    items2 = pg.locator(".selpopup .menu-item").all_inner_texts()
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    for k in ("Pads", "Tracks", "Polygons"): sf.get_by_role("button", name=k, exact=True).click()
    pg.wait_for_timeout(200)
    pg.evaluate(f"{ED}.select([])"); pg.wait_for_timeout(200)
    pg.mouse.click(x, y); pg.wait_for_timeout(700)
    none = pg.evaluate(SEL)
    why = " ".join(pg.locator(".toast").all_inner_texts())
    sf = pg.locator(".selfilter")
    sf.locator(".selfilter-all").click(); pg.wait_for_timeout(200)
    back = [sf.locator(".selfilter-all").inner_text(), sf.locator(".selfilter-kinds .btn.on").count()]
    check(f"What a click takes on a board (26.189): a click on C1's pad takes the component ({first} of {pad['all']} primitives) and offers {items}; Pad C1-1 chosen: {chosen}; a press on it again keeps it ({kept}) and a double-click opens {dlg!r}",
          first == pad["all"] and len(items) == 4 and items[0] == "Component C1" and items[1] == "Pad C1-1 (VIN) on Top Layer" and all(re.match(r"^Track \(VIN\) on Top Layer, [\d.]+(mil|mm) long$", t) for t in items[2:]) and items[2] != items[3]
          and chosen == ["pad C1-1"] and kept == ["pad C1-1"] and dlg.startswith("Pad"))
    check(f"The Selection Filter (26.189): the PCB Inspector with nothing selected has {names} ({lit} lit); a pad chosen on its own is shown as {shown!r}; with Components off the click takes {no_comp} and offers {len(items2)} ({items2[:1]}); with Pads, Tracks and Polygons off too it takes {none} and says {why[-90:]!r}; All puts them back ({back})",
          names == ["All - On", "Components", "3D Bodies", "Keepouts", "Tracks", "Arcs", "Pads", "Vias", "Regions", "Polygons", "Fills", "Texts", "Rooms", "Other"] and lit == 14
          and shown == "Pad" and no_comp == ["pad C1-1"] and len(items2) == 3 and items2[0] == "Pad C1-1 (VIN) on Top Layer" and none == [] and "off in the Selection Filter" in why and back == ["All - On", 14])
    c.close()
    # 26.190: an EDIF schematic as xDX Designer writes it, called .eds: taken, and the sheet as it was drawn
    c, pg = site_page("26.190-eds")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    def dsp(v, x, y, just="LOWERLEFT", group="ATTRIBUTE"): return f"(display (figureGroupOverride {group} (visible ({'true' if v else 'false'}))) (justify {just}) (orientation R0) (origin (pt {x} {y})))"
    def xres(i, x, y, value):
        return (f"(instance (rename &0441{i} \"$1{i}\") (viewRef RES (cellRef (name RES_GEN {dsp(False, x + 939800, y - 965200)}) (libraryRef Parts))) (transform (origin (pt {x} {y})))"
                f" (portInstance B1 (designator (stringDisplay \"\" {dsp(False, x, y)}))) (portInstance B2 (designator (stringDisplay \"\" {dsp(False, x + 762000, y)})))"
                f" (designator (stringDisplay \"R?\" {dsp(True, x + 127000, y + 381000)}))"
                f" (property (rename Part_Name \"Part Name\") (string (stringDisplay \"RES_GEN\" {dsp(False, x + 939800, y - 584200)})) (owner \"Test\"))"
                f" (property Value (string (stringDisplay \"{value} \" {dsp(True, x + 127000, y + 127000)})) (owner \"Test\")))")
    def xgnd(i, x, y):
        return (f"(portImplementation (name GND {dsp(False, x, y - 381000, 'UPPERLEFT', 'LABEL')}) (connectLocation (figure GRAPHICS (dot (pt {x} {y}))))"
                f" (instance (rename &0441{i} \"$1{i}\") (viewRef gnd (cellRef gnd (libraryRef Globals))) (transform (origin (pt {x} {y})))))")
    def xwire(*pts): return "(figure NET (path (pointList " + " ".join(f"(pt {x} {y})" for x, y in pts) + ")))"
    def xback(i, des, b1, b2):
        return (f"(instanceBackAnnotate (instanceRef &0441{i} (viewRef SCHEMATIC_VIEW)) (designator \"{des}\"))"
                f" (portBackAnnotate (portRef B1 (instanceRef &0441{i} (viewRef SCHEMATIC_VIEW))) (designator \"{b1}\")) (portBackAnnotate (portRef B2 (instanceRef &0441{i} (viewRef SCHEMATIC_VIEW))) (designator \"{b2}\"))")
    unit = "(technology (numberDefinition (scale 1 (e 1 -8) (unit DISTANCE))))"
    eds = f"""  (edif Divider (edifVersion 2 0 0) (edifLevel 0) (keywordMap (keywordLevel 0))
 (status (written (timestamp 2026 11 17 10 0 0) (program "xDX Designer Edif Exporter" (version "test"))))
 (library Parts (edifLevel 0) {unit}
  (cell RES_GEN (cellType GENERIC) (view RES (viewType SCHEMATIC) (interface (designator "R?")
     (port B1 (direction INOUT) (designator "1") (property (rename Pin_Type "Pin Type") (string "ANALOG")))
     (port B2 (direction INOUT) (designator "2") (property (rename Pin_Type "Pin Type") (string "ANALOG")))
     (symbol (boundingBox (rectangle (pt 0 -101600) (pt 762000 101600))) (figure BOX (rectangle (pt 127000 -101600) (pt 635000 101600)))
      (keywordDisplay cell {dsp(False, 939800, -965200)}) (keywordDisplay designator {dsp(True, 127000, 381000)}) (propertyDisplay Value {dsp(True, 127000, 127000)})
      (portImplementation (name B1 {dsp(False, 25400, -76200, 'UPPERLEFT', 'LABEL')}) (connectLocation (figure GRAPHICS (dot (pt 0 0)))) (figure PIN (path (pointList (pt 127000 0) (pt 0 0)))))
      (portImplementation (name B2 {dsp(False, 660400, -76200, 'UPPERLEFT', 'LABEL')}) (connectLocation (figure GRAPHICS (dot (pt 762000 0)))) (figure PIN (path (pointList (pt 635000 0) (pt 762000 0))))))))))
 (library Globals (edifLevel 0) {unit}
  (cell gnd (cellType GENERIC) (view gnd (viewType GRAPHIC) (interface) (contents (boundingBox (rectangle (pt -127000 -254000) (pt 127000 0)))
     (figure LINE (path (pointList (pt 127000 -254000) (pt -127000 -254000)))) (figure PIN (path (pointList (pt 0 -254000) (pt 0 0))))))))
 (library Design (edifLevel 0) {unit}
  (cell TOP (cellType GENERIC) (view SCHEMATIC_VIEW (viewType SCHEMATIC) (interface (port (rename GND054AGND "GND,AGND")))
    (contents (offPageConnector (rename GND054AGND_off "GND,AGND_(offpage::0)"))
     (page SH1 (pageSize (rectangle (pt 0 0) (pt 12700000 10160000)))
      {xres('I1', 2540000, 7620000, '10k')} {xres('I2', 5080000, 7620000, '4k7')} {xres('I3', 3810000, 6350000, '1k')} {xgnd('I8', 6350000, 7620000)} {xgnd('I9', 5080000, 6350000)}
      (net (name VIN {dsp(False, 1270000, 7645400, 'LOWERLEFT', 'LABEL')}) (joined (portRef B1 (instanceRef &0441I1))) {xwire((1270000, 7620000), (2540000, 7620000))})
      (net OUT (joined (portRef B2 (instanceRef &0441I1)) (portRef B1 (instanceRef &0441I2)) (portRef B1 (instanceRef &0441I3)))
       (net (rename &0441N5 (stringDisplay "$1N5" {dsp(True, 5080000, 7645400, 'LOWERRIGHT', 'LABEL')})) (joined (portRef B2 (instanceRef &0441I1)) (portRef B1 (instanceRef &0441I2)) (portRef B1 (instanceRef &0441I3)))
        {xwire((3302000, 7620000), (5080000, 7620000))} {xwire((3556000, 7620000), (3556000, 6350000), (3810000, 6350000))}))
      (net GND (joined (portRef B2 (instanceRef &0441I2)) (portRef B2 (instanceRef &0441I3)) (portRef GND054AGND_off))
       (net (rename &0441N10 (stringDisplay "$1N10" {dsp(False, 5842000, 7645400, 'LOWERLEFT', 'LABEL')})) (joined (portRef B2 (instanceRef &0441I2)) (portRef GND054AGND_off)) {xwire((5842000, 7620000), (6350000, 7620000))})
       (net (rename &0441N11 (stringDisplay "$1N11" {dsp(False, 4572000, 6375400, 'LOWERLEFT', 'LABEL')})) (joined (portRef B2 (instanceRef &0441I3)) (portRef GND054AGND_off)) {xwire((4572000, 6350000), (5080000, 6350000))})))))
   (viewMap {xback('I1', 'R1', '1', '2')} {xback('I2', 'R2', '1', '2')} {xback('I3', 'R3', '1', '2')})))
 (design Divider (cellRef TOP (libraryRef Design))))
"""
    pg.evaluate("(t) => window.konium.openBatch([{ name: 'Divider.eds', bytes: new TextEncoder().encode(t) }])", eds); pg.wait_for_timeout(2500)
    got = pg.evaluate(f"""(() => {{ const k = window.konium, a = k.state.active.value, d = a && a.editor && a.editor.doc;
      if (!d || !d.objects) return {{ front: a ? a.name : null }};
      const kids = (c) => d.objects.filter((o) => o.owner === c.index);
      const comps = d.objects.filter((o) => o.kind === 'component');
      return {{ front: a.name, docs: k.state.docs.value.map((x) => x.name), parts: comps.map((c) => c.designator + ' ' + kids(c).filter((o) => o.kind === 'text' && !o.hidden).map((o) => o.text).join('/')),
        hidden: comps.map((c) => kids(c).filter((o) => o.kind === 'text' && o.hidden).length), pins: kids(comps[0]).filter((o) => o.kind === 'pin').map((o) => o.designator + ':' + o.electrical + ':' + (o.showName || o.showDesignator)),
        power: d.objects.filter((o) => o.kind === 'power').map((o) => o.text + ':' + o.style), labels: d.objects.filter((o) => o.kind === 'text' && o.role === 'netlabel').map((o) => o.text + ':' + (o.justify % 3)) }}; }})()""")
    said = " ".join(pg.locator(".toast").all_inner_texts())
    check(f"An EDIF schematic as xDX Designer writes it, called .eds (26.190): opens as {got.get('front')!r} of {got.get('docs')}; the parts with what they show {got.get('parts')} ({got.get('hidden')} texts hidden), R1's pins {got.get('pins')}, grounds {got.get('power')}, net labels {got.get('labels')} ({said[-80:]!r})",
          got.get("front") == "Divider.SchDoc" and got.get("parts") == ["R1 R1/10k", "R2 R2/4k7", "R3 R3/1k"] and got.get("hidden") == [1, 1, 1] and got.get("pins") == ["1:4:false", "2:4:false"]
          and got.get("power") == ["GND:2", "GND:2"] and got.get("labels") == ["VIN:0", "OUT:2"])
    c.close()
    # 26.190: the list of overlapping objects stays while the wheel turns and a modifier key goes down; a key or a press elsewhere closes it
    c, pg = site_page("26.190-list")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(800)
    pad = pg.evaluate(f"""(() => {{ const e = {ED}, d = e.doc; const c1 = d.components.find((c) => c.designator === 'C1');
      const p = d.prims.find((q) => q.kind === 'pad' && q.component === c1.index && q.name === '1'); return [p.at.x, p.at.y]; }})()""")
    shown = lambda: pg.locator(".selpopup .menu-item").count()
    x, y = pg.evaluate(TO_SCREEN, pad)
    # (a wheel turning before the click and still turning as the list comes)
    pg.mouse.move(x, y); pg.mouse.wheel(0, -120); pg.wait_for_timeout(300)
    x, y = pg.evaluate(TO_SCREEN, pad); pg.mouse.move(x, y); pg.mouse.click(x, y); pg.wait_for_timeout(450)
    first = shown()
    pg.mouse.wheel(0, -4); pg.wait_for_timeout(150); pg.mouse.wheel(0, -4); pg.wait_for_timeout(200)
    wheel = shown()
    pg.keyboard.down("Shift"); pg.wait_for_timeout(150); pg.keyboard.up("Shift"); pg.keyboard.down("Control"); pg.wait_for_timeout(150); pg.keyboard.up("Control")
    mod = shown()
    pg.locator(".selpopup .menu-item", has_text="Pad C1-1").click(); pg.wait_for_timeout(400)
    picked = pg.evaluate(f"{ED}.selection.size")
    x, y = pg.evaluate(TO_SCREEN, pad); pg.mouse.move(x, y); pg.mouse.click(x, y); pg.wait_for_timeout(600)
    again = shown()
    pg.keyboard.press("a"); pg.wait_for_timeout(200)
    key = shown()
    check(f"The list of overlapping objects (26.190): {first} listed at a click made after a zoom; still {wheel} while the wheel turns on and {mod} after Shift and Ctrl go down; a pick selects {picked}; the list again ({again}) and a letter key closes it ({key})",
          first == 4 and wheel == 4 and mod == 4 and picked == 1 and again == 4 and key == 0)
    c.close()

    # 26.191 (R20, planned: on here with features=all): the Layout Planner on Konium's own example board, the model's answer a stand-in
    c, pg = site_page("26.191-plan")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    plan_jobs = []
    def plan_route(route):
        if route.request.url.endswith("/config"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"models": [{"id": "m/plan", "name": "Stand-in", "roles": ["text", "vision"], "weight": 13}],
                                 "defaults": {"model": "m/plan"}, "allowance": {"jobs": 25, "left": 25, "weighed": True}, "shareCache": True, "jobs": ["layout", "ping"]}))
        body = json.loads(route.request.post_data)
        plan_jobs.append(body)
        again = bool(body["input"].get("previous"))
        ans = {"summary": "A small USB sensor node: USB in at the left, the microcontroller in the middle, the sensor top right.",
               "groups": [{"name": "USB input and regulator", "why": "Power and USB data enter here.", "parts": ["J1", "U1", "C1", "C2"], "main": "J1", "x": 0.12, "y": 0.5, "side": "top"},
                          {"name": "Microcontroller", "why": "Decoupling at its supply pins, the crystal at pins 2 and 3.", "parts": ["U2", "C3", "C4", "C5", "C6", "Y1", "C7", "C8", "R1"], "main": "U2", "x": 0.5, "y": 0.45, "side": "top"},
                          {"name": "Sensor", "why": "Away from the regulator's heat.", "parts": ["U3", "C9", "R2", "R3"], "main": "U3", "x": 0.3 if again else 0.78, "y": 0.82, "side": "top"},
                          {"name": "Debug and indicator", "why": "Reached and seen at the bottom edge.", "parts": ["J3", "D1", "R4", "U77"], "main": "J3", "x": 0.62, "y": 0.1, "side": "top"},
                          {"name": "UART header", "why": "Fixed at the right edge.", "parts": ["J2"], "main": "J2", "x": 0.94, "y": 0.5, "side": "top"}],
               "edges": [{"part": "J1", "edge": "left", "along": 0.5, "why": "The USB cable plugs in from the left."}, {"part": "J3", "edge": "bottom", "along": 0.6, "why": "The debug probe reaches it."}],
               "near": [{"part": "C3", "to": "U2-1", "mm": 2, "why": "Decouples VDD at pin 1."}, {"part": "Y1", "to": "U2-2", "mm": 5, "why": "The crystal at the oscillator pins."}, {"part": "C7", "to": "Y1", "mm": 3, "why": "Load capacitor."}],
               "apart": [{"a": "U1", "b": "U3", "mm": 15, "why": "Heat away from the sensor."}], "clear": [{"part": "J1", "mm": 1.5, "why": "Room for the plug."}],
               "notes": ["Pour ground on the bottom layer."]}
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": ans, "usage": {"in": 2400, "out": 900, "cost": 0.004}, "model": "m/plan", "allowance": {"jobs": 25, "left": 24}}))
    pg.route("https://konium.app/api/ai/**", plan_route)
    # With AI off the panel says so and offers Preferences; with no board in front it offers the example
    pg.evaluate("window.konium.run('ai.layoutExample')"); pg.wait_for_timeout(2500)
    lp = pg.locator(".layout-planner")
    off = lp.inner_text()
    pin = pg.locator("button[aria-label='Pin Layout Planner']")
    if pin.count(): pin.first.click(); pg.wait_for_timeout(500)
    pg.evaluate("window.konium.run('view.fitDocument')"); pg.wait_for_timeout(600)
    pg.evaluate("window.konium.prefs.set({ aiMode: 'konium' })"); pg.wait_for_timeout(900)
    before = lp.inner_text()
    tm = ""
    pg.locator(".menubar-item", has_text="Tools").first.click(); pg.wait_for_timeout(200)
    tm = pg.locator(".menu-popup").last.inner_text()
    pg.keyboard.press("Escape"); pg.wait_for_timeout(100)
    check(f"Layout Planner (26.191): Tools › Layout Planner in the PCB editor ({'Layout Planner...' in tm}); AI off says so ({'AI is off' in off}); the example board in front: 20 parts to place, 1 fixed, what is sent and to where",
          "Layout Planner..." in tm and "AI is off" in off and "Layout Example.PcbDoc" in before and "20 parts to place, 1 fixed, 16 nets" in before and "cover 19% of the board" in before
          and "to the Konium service (konium.app, then OpenRouter)" in before and "No drawing goes" in before and lp.locator(".btn", has_text="Plan the Layout").is_enabled())
    lp.get_by_label("What the layout must do").fill("USB at the left edge")
    lp.locator(".btn", has_text="Plan the Layout").click(); pg.wait_for_timeout(1500)
    txt = lp.inner_text()
    sent = plan_jobs[-1] if plan_jobs else {"job": "", "input": {"board": "", "brief": "", "parts": []}}
    zones = pg.evaluate(f"(() => {{ const z = {ED}.planZones; return z ? [z.zones.length, z.marks.length, z.zones.map((x) => x.name)] : null; }})()")
    shot(pg, "191-plan.png")
    check(f"…Plan the Layout sends the board as text with the brief ({sent['job']}, {len(sent['input']['parts'])} parts named) and shows the plan: its summary, five groups, the edges, what is close, apart and clear, a note; a name the board lacks is said; {zones[0] if zones else 0} zones and {zones[1] if zones else 0} edge marks over the board",
          sent["job"] == "layout" and sent["input"]["brief"] == "USB at the left edge" and sent["input"]["board"].startswith('Board "Layout Example.PcbDoc": 50 × 30 mm, a rectangle.') and len(sent["input"]["parts"]) == 21
          and "A small USB sensor node" in txt and "By Stand-in" in txt and "5 groups, 2 parts at the edges, 3 parts to keep close" in txt and "Left out, not on the board: U77." in txt
          and "USB input and regulator" in txt and "J1 at the left edge, 50% along it. The USB cable plugs in from the left." in txt and "C3 within 2 mm of U2-1. Decouples VDD at pin 1." in txt
          and "U1 and U3 at least 15 mm. Heat away from the sensor." in txt and "J1: 1.5 mm round it. Room for the plug." in txt and "Pour ground on the bottom layer." in txt
          and zones is not None and zones[0] == 5 and zones[1] == 2 and zones[2][1] == "Microcontroller")
    # A group's name selects its parts on the board; Parts lists them
    lp.locator(".lp-name", has_text="Microcontroller").click(); pg.wait_for_timeout(500)
    sel = pg.evaluate(f"(() => {{ const e = {ED}; return e.moveSet().components.map((i) => e.doc.components[i].designator).sort().join(' '); }})()")
    lp.locator(".lp-group", has_text="Sensor").locator(".lp-more").click(); pg.wait_for_timeout(200)
    listed = lp.locator(".lp-group", has_text="Sensor").locator(".lp-parts .lp-part").all_inner_texts()
    check(f"…a group's name selects its parts on the board ({sel}); Parts lists them ({listed})", sel == "C3 C4 C5 C6 C7 C8 R1 U2 Y1" and listed == ["U3", "C9", "R2", "R3"])
    # 26.192: Place by the Plan carries the plan out: every part on the board, each thing the plan asked marked as met, one undo step
    sensor0 = pg.evaluate(f"{ED}.planZones.zones.find((z) => z.name === 'Sensor').box.minX")
    on_board = f"""(() => {{ const d = {ED}.doc, o = d.board.outline, x0 = Math.min(...o.map((p) => p.x)), x1 = Math.max(...o.map((p) => p.x)), y0 = Math.min(...o.map((p) => p.y)), y1 = Math.max(...o.map((p) => p.y));
      return d.components.filter((c) => c.at.x >= x0 && c.at.x <= x1 && c.at.y >= y0 && c.at.y <= y1).length; }})()"""
    before = pg.evaluate(on_board)
    lp.locator(".btn", has_text="Place by the Plan").click()
    pg.wait_for_function(f"{on_board} === 21", timeout=20000); pg.wait_for_timeout(700)
    txt = lp.inner_text()
    j1 = pg.evaluate(f"""(() => {{ const d = {ED}.doc, i = d.components.findIndex((c) => c.designator === 'J1'), x0 = Math.min(...d.board.outline.map((p) => p.x));
      const xs = d.prims.filter((p) => p.kind === 'track' && p.component === i).flatMap((p) => [p.a.x - p.width / 2, p.b.x - p.width / 2]); return Math.round((Math.min(...xs) - x0) / 393.7) / 1000; }})()""")
    shot(pg, "192-placed.png")
    check(f"Place by the Plan (26.192): {before} part on the board before, 21 after; the result is said (2 of 2 at their edges, 3 of 3 close enough, 1 of 1 far enough apart) and each mark follows the board; J1 is {j1} mm from the left edge",
          before == 1 and "Placed: 20 parts" in txt and "2 of 2 at their edges. 3 of 3 close enough. 1 of 1 far enough apart." in txt and "The connections' length is" in txt
          and "J1 at the left edge, 50% along it (there)" in txt and re.search(r"C3 within 2 mm of U2-1 \(now [0-9.]+ mm\)", txt) is not None and re.search(r"U1 and U3 at least 15 mm \(now [0-9.]+ mm\)", txt) is not None
          and lp.locator(".lp-far").count() == 0 and lp.locator(".lp-ok").count() == 6 and 0 <= j1 < 0.1)
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(500)
    undone = pg.evaluate(on_board)
    pg.evaluate("window.konium.run('edit.redo')"); pg.wait_for_timeout(500)
    check(f"…one undo takes the placing back ({undone} on the board), redo puts it there again ({pg.evaluate(on_board)})", undone == 1 and pg.evaluate(on_board) == 21)
    # Plan Again sends the plan made before with what the placer made of it and what to change; the plan changes
    lp.get_by_label("What to change in the plan").fill("the sensor to the left")
    lp.locator(".btn", has_text="Plan Again").click(); pg.wait_for_timeout(1500)
    sensor1 = pg.evaluate(f"{ED}.planZones.zones.find((z) => z.name === 'Sensor').box.minX")
    second = plan_jobs[-1]["input"] if plan_jobs else {}
    check(f"…Plan Again sends the plan made before with what the placer made of it ({second.get('result', '')[:60]!r}) and what to change ({second.get('remarks')}); the plan is round 2 and the Sensor's zone has moved left",
          len(plan_jobs) == 2 and second.get("remarks") == "the sensor to the left" and '"name":"Sensor"' in second.get("previous", "") and second.get("result", "").startswith("Every part is placed.\nAt their edges: 2 of 2.\nClose enough: 3 of 3.")
          and "Round 2, by Stand-in" in lp.inner_text() and sensor1 < sensor0)
    # Make Rooms: a room and a component class for each group, one undo step; the zones are no longer drawn over them
    rooms0 = pg.evaluate(f"{ED}.doc.rules.filter((r) => r.bag.get('RULEKIND') === 'RoomDefinition').length")
    lp.get_by_role("button", name="Make Rooms").click(); pg.wait_for_timeout(600)
    made = pg.evaluate(f"""(() => {{ const d = {ED}.doc; const rooms = d.rules.filter((r) => r.bag.get('RULEKIND') === 'RoomDefinition');
      return [rooms.length, rooms.map((r) => r.bag.get('SCOPE1EXPRESSION'))[1], d.classes.filter((c) => c.kind === 1 && c.name === 'Microcontroller').map((c) => c.members.length)[0], {ED}.planZones === null]; }})()""")
    toast = pg.locator(".toast").last.inner_text() if pg.locator(".toast").count() else ""
    shot(pg, "191-rooms.png")
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(400)
    undone = pg.evaluate(f"{ED}.doc.rules.filter((r) => r.bag.get('RULEKIND') === 'RoomDefinition').length")
    check(f"…Make Rooms: {made[0]} rooms from {rooms0}, each over its class ({made[1]}, {made[2]} members), said ({toast[:40]}); the zones give way to the rooms ({made[3]}); one undo takes them back ({undone})",
          rooms0 == 0 and made[0] == 5 and made[1] == "InComponentClass('Microcontroller')" and made[2] == 9 and made[3] and "5 rooms from the plan" in toast and undone == 0)
    # In the release itself (no features=all; R20, public from 26.195) it is on
    pg.evaluate("window.konium.prefs.set({ aiMode: 'off' })")
    pg.goto(URL.replace("&features=all", "")); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(800)
    pg.locator(".menubar-item", has_text="Tools").first.click(); pg.wait_for_timeout(200)
    cls = pg.locator(".menu-popup .menu-item", has_text="Layout Planner").first.get_attribute("class") or ""
    pg.keyboard.press("Escape"); pg.wait_for_timeout(100)
    check(f"…R20 public (26.195): with no features=all Tools › Layout Planner is on (planned: {'planned' in cls})", "planned" not in cls and "disabled" not in cls)
    c.close()

    # 26.192: the help keeps its place when its tab is left for a document's and come back to
    c, pg = site_page("26.192-help")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.evaluate("window.konium.run('help.guide')"); pg.wait_for_timeout(900)
    pg.locator(".help-chapters .help-chapter", has_text="PCB").first.click(); pg.wait_for_timeout(600)
    pg.locator(".help-body").evaluate("(el) => { el.scrollTop = 2400; }"); pg.wait_for_timeout(400)
    h1 = pg.locator(".help-body h1").inner_text()
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(700)
    gone = pg.locator(".help-page").count()
    pg.locator(".doctab", has_text="User Guide").first.dispatch_event("mousedown"); pg.wait_for_timeout(900)
    back = [pg.locator(".help-body h1").inner_text(), pg.locator(".help-body").evaluate("(el) => el.scrollTop")]
    # A search is kept too; a new request for help goes where it asks
    pg.locator(".help-search").fill("selection filter"); pg.wait_for_timeout(400)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(500)
    pg.locator(".doctab", has_text="User Guide").first.dispatch_event("mousedown"); pg.wait_for_timeout(700)
    kept_q = pg.locator(".help-search").input_value()
    pg.evaluate("window.konium.run('help.guide')"); pg.wait_for_timeout(900)
    fresh = [pg.locator(".help-body h1").inner_text(), pg.locator(".help-body").evaluate("(el) => el.scrollTop"), pg.locator(".help-search").input_value()]
    check(f"the help keeps its place (26.192): in {h1!r} at 2400, the board's tab and back: {back} (the page was drawn anew: {gone == 0}); a search is kept ({kept_q!r}); Help › User Guide again goes where it asks, its search cleared ({fresh})",
          gone == 0 and back[0] == h1 and abs(back[1] - 2400) < 5 and kept_q == "selection filter" and fresh[0] != h1 and fresh[2] == "")
    c.close()

    # 26.193: the Smart Router: the plan from the model (a stand-in here), made the board's rules, carried out by the autorouter
    c, pg = site_page("26.193-route")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    route_jobs = []
    def ai_route(route):
        if route.request.url.endswith("/config"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"models": [{"id": "m/plan", "name": "Stand-in", "roles": ["text", "vision"], "weight": 13}],
                                 "defaults": {"model": "m/plan"}, "allowance": {"jobs": 25, "left": 25, "weighed": True}, "shareCache": True, "jobs": ["layout", "routing", "ping"]}))
        body = json.loads(route.request.post_data)
        route_jobs.append(body)
        again = bool(body["input"].get("previous"))
        ans = {"summary": "A two-layer USB sensor node: signals on the top, ground poured over the bottom.",
               "classes": [{"name": "Crystal", "why": "Short, on one layer.", "nets": ["XTAL1", "XTAL2"], "width": 0.25, "clearance": 0, "layers": ["Top Layer"], "vias": "none", "order": 1},
                           {"name": "USB", "why": "Full speed data.", "nets": ["USB_DP", "USB_DM", "NOPE"], "width": 0.25, "layers": ["top"], "vias": "few", "order": 2},
                           {"name": "Power", "why": "5 V in and the 3.3 V rail.", "nets": ["VBUS", "+3V3"], "width": 0.6 if again else 0.5, "layers": [], "vias": "free", "order": 3},
                           {"name": "Ground", "why": "Into the pour.", "nets": ["GND"], "width": 0.4, "order": 4},
                           {"name": "Signals", "why": "The rest, on the top where they can.", "nets": ["NRST", "TX", "RX", "LED", "LED_A", "SWDIO", "SWCLK", "SCL", "SDA"], "width": 0, "layers": ["Top Layer"], "vias": "free", "order": 5}],
               "via": {"diameter": 0.6, "hole": 0.3, "why": "The board's via is too large beside 0402 parts."},
               "pours": [{"net": "GND", "layer": "Bottom Layer", "why": "One return path under everything."}],
               "pairs": [{"name": "USB", "p": "USB_DP", "n": "USB_DM", "gap": 0.2, "why": "USB data."}],
               "notes": ["The 3.3 V rail was taken as 0.3 A."]}
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": ans, "usage": {"in": 2100, "out": 800, "cost": 0.004}, "model": "m/plan", "allowance": {"jobs": 25, "left": 24}}))
    pg.route("https://konium.app/api/ai/**", ai_route)
    pg.evaluate("window.konium.run('ai.routeExample')")
    pg.wait_for_function("window.konium.state.active.value && window.konium.state.active.value.name === 'Routing Example.PcbDoc'", timeout=30000); pg.wait_for_timeout(1500)
    sr = pg.locator(".smart-router")
    off = sr.inner_text()
    pin = pg.locator("button[aria-label='Pin Smart Router']")
    if pin.count(): pin.first.click(); pg.wait_for_timeout(500)
    pg.evaluate("window.konium.run('view.fitDocument')"); pg.wait_for_timeout(600)
    pg.evaluate("window.konium.prefs.set({ aiMode: 'konium' })"); pg.wait_for_timeout(900)
    before = sr.inner_text()
    pg.locator(".menubar-item", has_text="Tools").first.click(); pg.wait_for_timeout(200)
    tm = pg.locator(".menu-popup").last.inner_text()
    pg.keyboard.press("Escape"); pg.wait_for_timeout(100)
    on_board = pg.evaluate(f"""(() => {{ const d = {ED}.doc, o = d.board.outline, x0 = Math.min(...o.map((p) => p.x)), x1 = Math.max(...o.map((p) => p.x)), y0 = Math.min(...o.map((p) => p.y)), y1 = Math.max(...o.map((p) => p.y));
      return d.components.filter((c) => c.at.x >= x0 && c.at.x <= x1 && c.at.y >= y0 && c.at.y <= y1).length; }})()""")
    check(f"Smart Router (26.193): Tools › Smart Router in the PCB editor ({'Smart Router...' in tm}); AI off says so ({'AI is off' in off}); the example board in front with its {on_board} parts placed: 56 connections to route, what is sent and to where",
          "Smart Router..." in tm and "AI is off" in off and on_board == 21 and "Routing Example.PcbDoc" in before and re.search(r"56 connections to route \(\d+ mm as the crow flies\), 16 nets, 2 copper layers", before) is not None
          and "Sends the board's layers and rules" in before and "to the Konium service (konium.app, then OpenRouter)" in before and "No drawing goes" in before and sr.locator(".btn", has_text="Plan the Routing").is_enabled())
    sr.get_by_label("What the routing must do").fill("The 3.3 V rail carries 0.3 A")
    sr.locator(".btn", has_text="Plan the Routing").click(); pg.wait_for_timeout(1500)
    txt = sr.inner_text()
    sent = route_jobs[-1] if route_jobs else {"job": "", "input": {"board": "", "brief": "", "nets": [], "layers": []}}
    shot(pg, "193-plan.png")
    check(f"…Plan the Routing sends the board as text with the brief ({sent['job']}, {len(sent['input']['nets'])} nets and {sent['input']['layers']} named) and shows the plan: its classes in order with width, layers and vias, the via, the pour, the pair, a note; a net the board lacks is said",
          sent["job"] == "routing" and sent["input"]["brief"] == "The 3.3 V rail carries 0.3 A" and sent["input"]["board"].startswith('Board "Routing Example.PcbDoc": 50 × 30 mm.') and "Nothing is routed yet." in sent["input"]["board"]
          and len(sent["input"]["nets"]) == 16 and sent["input"]["layers"] == ["Top Layer", "Bottom Layer"]
          and "A two-layer USB sensor node" in txt and "By Stand-in" in txt and "5 classes, 1 pour, 1 differential pair" in txt and "Left out, not on the board: NOPE." in txt
          and re.search(r"2 nets; 0\.5 mm wide; any layer; vias as needed\s*; \d+ to route", txt) is not None and re.search(r"2 nets; 0\.25 mm wide; on Top Layer; no vias", txt) is not None
          and re.search(r"9 nets; the board's width \(0\.254 mm\); on Top Layer; vias as needed", txt) is not None
          and "0.6 mm across with a 0.3 mm hole (the board's rule: 1.27 mm with 0.711 mm). The board's via is too large beside 0402 parts." in txt
          and "GND over Bottom Layer. One return path under everything." in txt and "USB: USB_DP and USB_DM, 0.2 mm apart. USB data." in txt and "The 3.3 V rail was taken as 0.3 A." in txt
          and "laid side by side at that gap" in txt)
    # A class's name selects its nets on the board; Nets lists them
    sr.locator(".lp-name", has_text="Crystal").click(); pg.wait_for_timeout(500)
    sel = pg.evaluate(f"(() => {{ const e = {ED}; const nets = new Set(); for (const k of e.selection) {{ const p = e.primByKey(k); if (p && 'net' in p && p.net !== 0xffff) nets.add(e.doc.nets[p.net].name); }} return [...nets].sort().join(' '); }})()")
    sr.locator(".lp-group", has_text="Crystal").locator(".lp-more").click(); pg.wait_for_timeout(200)
    listed = sr.locator(".lp-group", has_text="Crystal").locator(".lp-parts .lp-part").all_inner_texts()
    check(f"…a class's name selects its nets on the board ({sel}); Nets lists them ({listed})", sel == "XTAL1 XTAL2" and listed == ["XTAL1", "XTAL2"])
    # Make the Rules: the plan as the board's own classes, rules, pair and pour, one undo step
    STATE = f"""(() => {{ const d = {ED}.doc; const mine = d.rules.filter((r) => r.bag.get('COMMENT') === 'Smart Router plan');
      const copper = d.prims.filter((p) => p.kind === 'track' && p.polygon === 0xffff && p.component === 0xffff && (p.layer === 1 || p.layer === 32));
      const vias = d.prims.filter((p) => p.kind === 'via');
      const w = (n) => [...new Set(copper.filter((p) => d.nets[p.net] && d.nets[p.net].name === n).map((p) => Math.round(p.width / 393.700787) / 1000))].sort();
      return {{ classes: d.classes.filter((c) => c.kind === 0 && !c.superClass).map((c) => c.name).sort(), rules: mine.map((r) => r.bag.get('NAME')).sort(), power: mine.filter((r) => r.bag.get('NAME') === 'Width_Power').map((r) => [r.bag.get('SCOPE1EXPRESSION'), r.bag.get('PREFEREDWIDTH'), r.bag.get('PRIORITY')])[0] || null,
        polygons: d.polygons.map((g) => [d.nets[g.net] && d.nets[g.net].name, g.layer]), poured: d.prims.filter((p) => p.kind === 'region' && p.polygon !== 0xffff).length, pairs: (d.diffPairs || []).map((b) => b.get('NAME')),
        tracks: copper.length, vias: vias.length, viaSizes: [...new Set(vias.map((v) => Math.round(v.diameter / 393.700787) / 1000 + '/' + Math.round(v.hole / 393.700787) / 1000))], v33: w('+3V3'), xtal: w('XTAL1'), scl: w('SCL'),
        xtalLayers: [...new Set(copper.filter((p) => d.nets[p.net] && /^XTAL/.test(d.nets[p.net].name)).map((p) => p.layer))], undo: {ED}.undo.undoLabel || '' }}; }})()"""
    s0 = pg.evaluate(STATE)
    sr.locator(".btn", has_text="Make the Rules").click(); pg.wait_for_timeout(900)
    s1 = pg.evaluate(STATE)
    toast = pg.locator(".toast").last.inner_text() if pg.locator(".toast").count() else ""
    txt = sr.inner_text()
    made_off = sr.locator(".btn", has_text="Make the Rules").is_disabled()
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(500)
    s2 = pg.evaluate(STATE)
    check(f"…Make the Rules: net classes {s1['classes']}, rules {s1['rules']} (Width_Power {s1['power']}), a pour {s1['polygons']} with copper ({s1['poured']}), the pair {s1['pairs']}, said ({toast[:44]}); the board then has the plan (button off: {made_off}); one undo takes it back ({len(s2['classes'])} classes, {len(s2['polygons'])} pours)",
          s0["classes"] == [] and s0["rules"] == [] and s0["polygons"] == [] and s1["classes"] == ["Crystal", "Ground", "Power", "Signals", "USB"]
          and s1["rules"] == ["ClearanceInPair_USB", "DiffPairsRouting_USB", "RoutingVias_SmartRouter", "Width_Crystal", "Width_Ground", "Width_Power", "Width_USB"] and s1["power"] is not None and s1["power"][0] == "InNetClass('Power')" and s1["power"][2] == "3"
          and s1["polygons"] == [["GND", 32]] and s1["poured"] >= 1 and s1["pairs"] == ["USB"] and "From the plan: 5 net classes, 7 rules, 1 differential pair, 1 pour" in toast
          and made_off and txt.count("(there)") == 2 and s1["tracks"] == 0 and s2["classes"] == [] and s2["rules"] == [] and s2["polygons"] == [] and s2["pairs"] == [])
    # Route by the Plan: the rules, the vias into the pour, every connection left routed in the plan's order; measured; one undo step
    sr.locator(".btn", has_text="Route by the Plan").click()
    pg.wait_for_function("(document.querySelector('.smart-router .lp-result') || {}).innerText && document.querySelector('.smart-router .lp-result').innerText.includes('Routed:')", timeout=90000); pg.wait_for_timeout(900)
    txt = sr.inner_text()
    s3 = pg.evaluate(STATE)
    shot(pg, "193-routed.png")
    m = re.search(r"Routed: (\d+) connections in [^.]*?, and (\d+) pads joined to their pour or plane by a via\. (\d+) vias and (\d+) mm of track added\. None of the 56 connections is left\.", txt)
    check(f"Route by the Plan (26.193): {m.group(1) if m else '?'} connections routed and {m.group(2) if m else '?'} pads joined to the pour by a via each ({s3['tracks']} tracks, {s3['vias']} vias of {s3['viaSizes']}); none of the 56 is left; +3V3 at {s3['v33']} mm, the crystal at {s3['xtal']} on layers {s3['xtalLayers']}, SCL at {s3['scl']}; the USB pair is laid side by side (26.194) and the design rule check finds nothing new; every class is marked routed",
          m is not None and int(m.group(1)) >= 30 and int(m.group(2)) >= 10 and s3["tracks"] > 100 and s3["vias"] == int(m.group(3)) and s3["viaSizes"] == ["0.6/0.3"]
          and 0.5 in s3["v33"] and all(w in (0.5, 0.254) for w in s3["v33"]) and s3["xtal"] == [0.25] and s3["xtalLayers"] == [1] and s3["scl"] == [0.254]
          and "The design rule check found no violation of the copper, hole and pair rules that was not there before the run." in txt and "1 of 1 differential pair laid side by side at its gap." in txt
          and sr.locator(".lp-far").count() == 0 and sr.locator(".lp-group .lp-ok").count() == 5 and s3["undo"] == "Route by the routing plan" and s3["polygons"] == [["GND", 32]])
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(700)
    s4 = pg.evaluate(STATE)
    pg.evaluate("window.konium.run('edit.redo')"); pg.wait_for_timeout(700)
    s5 = pg.evaluate(STATE)
    check(f"…one undo takes the whole run back ({s4['tracks']} tracks, {s4['vias']} vias, {len(s4['polygons'])} pours, {len(s4['rules'])} rules), redo puts it there again ({s5['tracks']} tracks, {s5['vias']} vias)",
          s4["tracks"] == 0 and s4["vias"] == 0 and s4["polygons"] == [] and s4["rules"] == [] and s4["classes"] == [] and s5["tracks"] == s3["tracks"] and s5["vias"] == s3["vias"] and len(s5["rules"]) == 7)
    # Plan Again: the plan goes back with what the router made of it and what to change; routing by the new plan takes the run before back first
    sr.get_by_label("What to change in the plan").fill("The 3.3 V rail wider")
    sr.locator(".btn", has_text="Plan Again").click(); pg.wait_for_timeout(1500)
    second = route_jobs[-1]["input"] if route_jobs else {}
    txt = sr.inner_text()
    sr.locator(".btn", has_text="Route by the Plan").click()
    pg.wait_for_function("(document.querySelector('.smart-router .lp-result') || {}).innerText && document.querySelector('.smart-router .lp-result').innerText.includes('Routed:')", timeout=90000); pg.wait_for_timeout(900)
    s6 = pg.evaluate(STATE)
    res2 = sr.locator(".lp-result").inner_text()
    m2 = re.search(r"(\d+) connections? of 56 (?:is|are) left", res2)
    left = 0 if "None of the 56 connections is left." in res2 else int(m2.group(1)) if m2 else 99
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(700)
    s7 = pg.evaluate(STATE)
    check(f"…Plan Again sends the plan made before with what the router made of it ({second.get('result', '')[:52]!r}) and what to change ({second.get('remarks')}), for the board as it was sent; the plan is round 2; routed by it, +3V3 is at {s6['v33']} mm (0.6 where it fits, narrower at its pads and where that is said), {left} of 56 left, and the run before is not under it (one undo: {s7['tracks']} tracks)",
          len(route_jobs) == 2 and second.get("remarks") == "The 3.3 V rail wider" and '"name":"Power"' in second.get("previous", "") and second.get("result", "").startswith("56 connections to make before the run; none left.")
          and "Nothing is routed yet." in second.get("board", "") and "Round 2, by Stand-in" in txt and "takes it back first" in txt
          and max(s6["v33"]) == 0.6 and s6["tracks"] > 100 and left <= 2 and ("Routed narrower than their class's width" in res2) == (0.254 in s6["v33"])
          and s7["tracks"] == 0 and s7["vias"] == 0 and s7["rules"] == [])
    # In the release itself (no features=all; R20, public from 26.195) it is on, with Plan, Place and Route beside it
    pg.evaluate("window.konium.prefs.set({ aiMode: 'off' })")
    pg.goto(URL.replace("&features=all", "")); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(800)
    pg.locator(".menubar-item", has_text="Tools").first.click(); pg.wait_for_timeout(200)
    cls = pg.locator(".menu-popup .menu-item", has_text="Smart Router").first.get_attribute("class") or ""
    cls2 = pg.locator(".menu-popup .menu-item", has_text="Plan, Place and Route").first.get_attribute("class") or ""
    pg.keyboard.press("Escape"); pg.wait_for_timeout(100)
    check(f"…R20 public (26.195): with no features=all Tools › Smart Router and Tools › Plan, Place and Route are on (planned: {'planned' in cls}, {'planned' in cls2})", "planned" not in cls and "disabled" not in cls and "planned" not in cls2)
    c.close()

    # 26.194: the free-flowing routing style (the preference, Route › Auto Route, Route › Make Free-Flowing, a route placed by hand)
    c, pg = site_page("26.194-flow")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false, pcbRouteStyle: 'corners' })")
    pg.evaluate("window.konium.run('ai.routeExample')")
    pg.wait_for_function("window.konium.state.active.value && window.konium.state.active.value.name === 'Routing Example.PcbDoc'", timeout=30000); pg.wait_for_timeout(1500)
    COPPER = f"""(() => {{ const d = {ED}.doc; const mine = (p) => p.polygon === 0xffff && p.component === 0xffff && (p.layer === 1 || p.layer === 32);
      const tracks = d.prims.filter((p) => p.kind === 'track' && mine(p)), arcs = d.prims.filter((p) => p.kind === 'arc' && mine(p));
      const odd = tracks.filter((t) => {{ const dx = Math.abs(t.a.x - t.b.x), dy = Math.abs(t.a.y - t.b.y); return dx > 2000 && dy > 2000 && Math.abs(dx - dy) > 2000; }}).length;
      const len = tracks.reduce((s, t) => s + Math.hypot(t.a.x - t.b.x, t.a.y - t.b.y), 0) + arcs.reduce((s, a) => s + ((((a.end - a.start) % 360) + 360) % 360) * Math.PI / 180 * a.r, 0);
      return {{ tracks: tracks.length, arcs: arcs.length, odd, vias: d.prims.filter((p) => p.kind === 'via').length, mm: Math.round(len / 393700.787), undo: {ED}.undo.undoLabel || '' }}; }})()"""
    route_all = lambda: (pg.evaluate("window.konium.run('ad:PCB:AutorouteAll')"), pg.wait_for_timeout(300), pg.locator(".dlg .dlg-foot .btn", has_text="Route All").click(),
                         pg.wait_for_function("window.konium.state.messages.value.some((m) => m.source === 'Auto Route' && /Routing finished/.test(m.message))", timeout=90000), pg.wait_for_timeout(800))
    msgs = lambda: pg.evaluate("window.konium.state.messages.value.filter((m) => m.source === 'Auto Route').map((m) => m.message)")
    # With corners (as it was): no arcs
    route_all()
    a0 = pg.evaluate(COPPER); m0 = msgs()
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(600)
    # The preference: Preferences › PCB Editor › Interactive Routing › Routing Style
    pg.locator(".menubar-icon[aria-label=Preferences]").click(); pg.wait_for_timeout(500)
    pg.locator(".prefs-page", has_text="Interactive Routing").click(); pg.wait_for_timeout(400)
    style = pg.locator(".prefs-page-body .pref-row", has_text="Routing Style").locator("select")
    opts = style.locator("option").all_inner_texts() if style.count() else []
    if style.count(): style.select_option("flowing")
    pg.locator(".dlg.prefs .btn", has_text="OK").click(); pg.wait_for_timeout(400)
    pref = pg.evaluate("window.konium.prefs.get().pcbRouteStyle")
    route_all()
    a1 = pg.evaluate(COPPER); m1 = msgs()
    shot(pg, "194-flow.png")
    left = lambda m: next((re.search(r"Failed to complete (\d+) connection", x).group(1) for x in m if "Failed to complete" in x), "?")
    check(f"Free-flowing routing (26.194): Routing Style in Preferences ({opts}, now {pref}); Auto Route All with corners lays no arcs ({a0['tracks']} tracks, {a0['arcs']} arcs, {a0['mm']} mm, {left(m0)} left); free-flowing it lays {a1['arcs']} arcs and {a1['odd']} tracks at other angles, {a1['mm']} mm, {left(m1)} left, said, in one undo step",
          opts == ["Corners", "Free-Flowing"] and pref == "flowing" and a0["arcs"] == 0 and a0["tracks"] > 80 and a1["arcs"] >= 15 and a1["odd"] > 10 and a1["mm"] <= a0["mm"] and left(m1) == left(m0)
          and any("made free-flowing" in x for x in m1) and not any("made free-flowing" in x for x in m0) and a1["vias"] == a0["vias"] and a1["undo"].startswith("Auto Route"))
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(600)
    a2 = pg.evaluate(COPPER)
    # Route › Make Free-Flowing on routes that are there: routed with corners, then reshaped; the selected routes only, then all
    pg.evaluate("window.konium.prefs.set({ pcbRouteStyle: 'corners' })")
    route_all()
    b0 = pg.evaluate(COPPER)
    pg.locator(".menubar-item", has_text="Route").first.click(); pg.wait_for_timeout(200)
    rm = pg.locator(".menu-popup").last.inner_text()
    pg.keyboard.press("Escape"); pg.wait_for_timeout(100)
    pg.evaluate(f"(() => {{ const e = {ED}; const n = e.doc.nets.findIndex((x) => x.name === 'SCL'); e.selectNet(n); }})()"); pg.wait_for_timeout(300)
    pg.evaluate("window.konium.run('route.makeFlowing')")
    pg.wait_for_function(f"{COPPER}.arcs > 0", timeout=60000); pg.wait_for_timeout(700)
    b1 = pg.evaluate(COPPER)
    scl_only = pg.evaluate(f"(() => {{ const d = {ED}.doc; return d.prims.filter((p) => p.kind === 'arc' && p.polygon === 0xffff && p.component === 0xffff).every((a) => d.nets[a.net].name === 'SCL'); }})()")
    toast1 = pg.locator(".toast").last.inner_text() if pg.locator(".toast").count() else ""
    pg.evaluate("window.konium.run('route.makeFlowing')")
    pg.wait_for_function(f"{COPPER}.arcs > {b1['arcs']}", timeout=90000); pg.wait_for_timeout(900)
    b2 = pg.evaluate(COPPER)
    toast2 = pg.locator(".toast").last.inner_text() if pg.locator(".toast").count() else ""
    shot(pg, "194-reflow.png")
    check(f"…Route › Make Free-Flowing ({'Make Free-Flowing' in rm}): with the SCL net selected only its routes are reshaped ({b1['arcs']} arcs, all SCL's: {scl_only}; '{toast1[:40]}'); with nothing selected every route ({b2['arcs']} arcs, {b0['mm']} → {b2['mm']} mm; '{toast2[:60]}'); the vias stay ({b0['vias']} → {b2['vias']})",
          "Make Free-Flowing" in rm and b0["arcs"] == 0 and 0 < b1["arcs"] < b2["arcs"] and scl_only and "made free-flowing" in toast1 and "made free-flowing" in toast2
          and b2["mm"] <= b0["mm"] and b2["vias"] == b0["vias"] and b2["undo"] == "Make routes free-flowing")
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(500)
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(500)
    b3 = pg.evaluate(COPPER)
    check(f"…two undos take the reshaping back ({b3['arcs']} arcs, {b3['tracks']} tracks as before: {b3['tracks'] == b0['tracks']})", b3["arcs"] == 0 and b3["tracks"] == b0["tracks"] and b3["mm"] == b0["mm"])
    # In the release itself (no features=all; R20, public from 26.195): the command and the preference are on
    pg.goto(URL.replace("&features=all", "")); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(800)
    pg.locator(".menubar-item", has_text="Route").first.click(); pg.wait_for_timeout(200)
    cls = pg.locator(".menu-popup .menu-item", has_text="Make Free-Flowing").first.get_attribute("class") or ""
    pg.keyboard.press("Escape"); pg.wait_for_timeout(100)
    pg.locator(".menubar-icon[aria-label=Preferences]").click(); pg.wait_for_timeout(500)
    pg.locator(".prefs-page", has_text="Interactive Routing").click(); pg.wait_for_timeout(400)
    sel = pg.locator(".prefs-page-body .pref-row", has_text="Routing Style").locator("select")
    greyed = sel.is_disabled() if sel.count() else None
    pg.locator(".dlg.prefs .btn", has_text="Cancel").click(); pg.wait_for_timeout(300)
    check(f"…R20 public (26.195): with no features=all Route › Make Free-Flowing is on (planned: {'planned' in cls}) and the Routing Style preference can be set (greyed: {greyed})", "planned" not in cls and greyed is False)
    c.close()

    # 26.195: Plan, Place and Route: the planner and the router as one run with a stop at each stage, then the check; F1 opens their sections
    c, pg = site_page("26.195-run")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false, pcbRouteStyle: 'corners' })")
    run_jobs = []
    def run_ai(route):
        if route.request.url.endswith("/config"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"models": [{"id": "m/plan", "name": "Stand-in", "roles": ["text", "vision"], "weight": 13}],
                                 "defaults": {"model": "m/plan"}, "allowance": {"jobs": 25, "left": 25, "weighed": True}, "shareCache": True, "jobs": ["layout", "routing", "ping"]}))
        body = json.loads(route.request.post_data)
        run_jobs.append(body)
        if body["job"] == "layout":
            ans = {"summary": "A small USB sensor node.",
                   "groups": [{"name": "USB input and regulator", "why": "", "parts": ["J1", "U1", "C1", "C2"], "main": "J1", "x": 0.12, "y": 0.5, "side": "top"},
                              {"name": "Microcontroller", "why": "", "parts": ["U2", "C3", "C4", "C5", "C6", "Y1", "C7", "C8", "R1"], "main": "U2", "x": 0.5, "y": 0.5, "side": "top"},
                              {"name": "Sensor", "why": "", "parts": ["U3", "C9", "R2", "R3"], "main": "U3", "x": 0.78, "y": 0.82, "side": "top"},
                              {"name": "Debug and indicator", "why": "", "parts": ["J3", "D1", "R4"], "main": "J3", "x": 0.62, "y": 0.1, "side": "top"},
                              {"name": "UART header", "why": "", "parts": ["J2"], "main": "J2", "x": 0.94, "y": 0.5, "side": "top"}],
                   "edges": [{"part": "J1", "edge": "left", "along": 0.5}, {"part": "J3", "edge": "bottom", "along": 0.6}],
                   "near": [{"part": "C1", "to": "U1-3", "mm": 3}, {"part": "C2", "to": "U1-2", "mm": 3}, {"part": "C3", "to": "U2-1", "mm": 2}, {"part": "C4", "to": "U2-17", "mm": 2}, {"part": "C5", "to": "U2-32", "mm": 2},
                            {"part": "C6", "to": "U2-5", "mm": 2}, {"part": "Y1", "to": "U2-2", "mm": 5}, {"part": "C7", "to": "Y1", "mm": 3}, {"part": "C8", "to": "Y1", "mm": 3}, {"part": "R1", "to": "U2-4", "mm": 5},
                            {"part": "C9", "to": "U3-1", "mm": 2}, {"part": "R4", "to": "D1", "mm": 4}],
                   "apart": [{"a": "U1", "b": "U3", "mm": 15}], "clear": [{"part": "J1", "mm": 1}], "notes": []}
        else:
            ans = {"summary": "Signals on the top, ground poured over the bottom.",
                   "classes": [{"name": "Crystal", "nets": ["XTAL1", "XTAL2"], "width": 0.25, "layers": ["Top Layer"], "vias": "none", "order": 1},
                               {"name": "USB", "nets": ["USB_DP", "USB_DM"], "width": 0.25, "layers": ["top"], "vias": "few", "order": 2},
                               {"name": "Power", "nets": ["VBUS", "+3V3"], "width": 0.5, "order": 3}, {"name": "Ground", "nets": ["GND"], "width": 0.4, "order": 4},
                               {"name": "Signals", "nets": ["NRST", "TX", "RX", "LED", "LED_A", "SWDIO", "SWCLK", "SCL", "SDA"], "width": 0, "layers": ["Top Layer"], "order": 5, "style": "flowing"}],
                   "via": {"diameter": 0.6, "hole": 0.3}, "pours": [{"net": "GND", "layer": "Bottom Layer"}], "pairs": [{"name": "USB", "p": "USB_DP", "n": "USB_DM", "gap": 0.2}], "notes": []}
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": ans, "usage": {"in": 2000, "out": 700, "cost": 0.003}, "model": "m/plan", "allowance": {"jobs": 25, "left": 24}}))
    pg.route("https://konium.app/api/ai/**", run_ai)
    pg.evaluate("window.konium.run('ai.layoutExample')"); pg.wait_for_timeout(2500)
    pg.evaluate("window.konium.prefs.set({ aiMode: 'konium' })"); pg.wait_for_timeout(600)
    pg.evaluate("window.konium.run('ai.boardRun')"); pg.wait_for_timeout(900)
    pin = pg.locator("button[aria-label='Pin Plan, Place and Route']")
    if pin.count(): pin.first.click(); pg.wait_for_timeout(500)
    br = pg.locator(".board-run")
    before = br.inner_text()
    br.get_by_label("What the board must do").fill("USB at the left edge; ground on the bottom")
    stage_words = lambda: br.locator(".br-stage").evaluate_all("(els) => els.map((e) => e.className.replace('br-stage', '').replace('is-next', '').trim())")
    state = f"""(() => {{ const d = {ED}.doc, o = d.board.outline, x0 = Math.min(...o.map((p) => p.x)), x1 = Math.max(...o.map((p) => p.x)), y0 = Math.min(...o.map((p) => p.y)), y1 = Math.max(...o.map((p) => p.y));
      const mine = (p) => p.polygon === 0xffff && p.component === 0xffff && (p.layer === 1 || p.layer === 32);
      return {{ on: d.components.filter((c) => c.at.x >= x0 && c.at.x <= x1 && c.at.y >= y0 && c.at.y <= y1).length, tracks: d.prims.filter((p) => p.kind === 'track' && mine(p)).length, arcs: d.prims.filter((p) => p.kind === 'arc' && mine(p)).length,
        pours: d.polygons.length, undo: {ED}.undo.undoLabel || '' }}; }})()"""
    br.locator(".btn", has_text="Start").click()
    pg.wait_for_function("document.querySelectorAll('.board-run .br-stage.is-done').length === 1 && !!document.querySelector('.board-run .btn.default') && document.querySelector('.board-run .btn.default').innerText === 'Continue'", timeout=30000); pg.wait_for_timeout(400)
    s1 = pg.evaluate(state); w1 = stage_words(); t1 = br.inner_text()
    check(f"Plan, Place and Route (26.195): the panel for the example board ({'20 parts to place, 56 connections to route' in before}) says two plans are asked ({'Two plans are asked of the model' in before}); Start plans the layout and stops ({w1}): {len(run_jobs)} job ({run_jobs[0]['job'] if run_jobs else ''}, brief given), nothing placed yet ({s1['on']} on the board)",
          "20 parts to place, 56 connections to route" in before and "Two plans are asked of the model" in before and "to the Konium service (konium.app, then OpenRouter)" in before
          and w1 == ["is-done", "is-waiting", "is-waiting", "is-waiting", "is-waiting"] and len(run_jobs) == 1 and run_jobs[0]["job"] == "layout" and run_jobs[0]["input"]["brief"] == "USB at the left edge; ground on the bottom"
          and s1["on"] == 1 and "5 groups, 2 parts at the edges, 12 parts to keep close" in t1 and "The plan in the Layout Planner" in t1)
    br.locator(".btn", has_text="Continue").click()
    pg.wait_for_function("document.querySelectorAll('.board-run .br-stage.is-done').length === 2", timeout=40000); pg.wait_for_timeout(700)
    s2 = pg.evaluate(state); t2 = br.inner_text()
    # The rest in one go: the stops unticked
    br.get_by_label("Stop after each stage for my go-ahead").uncheck()
    br.locator(".btn", has_text="Continue").click()
    pg.wait_for_function("document.querySelectorAll('.board-run .br-stage.is-done, .board-run .br-stage.is-failed').length === 5", timeout=120000); pg.wait_for_timeout(900)
    s3 = pg.evaluate(state); w3 = stage_words(); t3 = br.inner_text()
    shot(pg, "195-run.png")
    check(f"…Continue places by the plan ({s2['on']} parts on the board; 'everything the plan asked is met': {'everything the plan asked is met' in t2}); with the stops unticked the rest runs through ({w3}): the routing planned for the board as placed ({[j['job'] for j in run_jobs]}), routed ({s3['tracks']} tracks, {s3['arcs']} arcs of the free-flowing class, {s3['pours']} pour), the pair side by side, none left, and checked",
          s2["on"] == 21 and "20 parts placed" in t2 and "everything the plan asked is met" in t2 and [j["job"] for j in run_jobs] == ["layout", "routing"] and "Nothing is routed yet." in run_jobs[1]["input"]["board"]
          and w3[:4] == ["is-done", "is-done", "is-done", "is-done"] and s3["tracks"] > 80 and s3["arcs"] > 0 and s3["pours"] == 1 and "1 of 1 pair laid side by side" in t3 and "none of the 56 left" in t3
          and "The design rule check finds" in t3 and "The run is over." in t3 and s3["undo"] == "Route by the routing plan")
    # Two undos: the routing, then the placing
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(700)
    u1 = pg.evaluate(state)
    pg.evaluate("window.konium.run('edit.undo')"); pg.wait_for_timeout(700)
    u2 = pg.evaluate(state)
    check(f"…each stage is one undo: the first takes the routing back ({u1['tracks']} tracks, {u1['pours']} pours, {u1['on']} parts on the board), the second the placing ({u2['on']} on the board)",
          u1["tracks"] == 0 and u1["pours"] == 0 and u1["on"] == 21 and u2["on"] == 1)
    # The plans are the two panels' own; F1 in each opens its section of the User Guide
    pg.evaluate("window.konium.run('edit.redo')"); pg.wait_for_timeout(500)
    pg.evaluate("window.konium.run('edit.redo')"); pg.wait_for_timeout(900)
    pg.evaluate("window.konium.dock.showPanel('smartRouter')"); pg.wait_for_timeout(700)
    pin = pg.locator("button[aria-label='Pin Smart Router']")
    if pin.count(): pin.first.click(); pg.wait_for_timeout(500)
    srt = pg.locator(".smart-router").inner_text()
    at_top = "(() => { const h = document.querySelector('.help-page'); if (!h) return ''; const top = h.getBoundingClientRect().top; const s = [...h.querySelectorAll('.help-section')].map((e) => [e.id, e.getBoundingClientRect().top - top]).filter((x) => x[1] > -40).sort((a, b) => a[1] - b[1])[0]; return s ? s[0] : ''; })()"
    def f1_in(sel, want):
        box = pg.locator(sel).first.bounding_box(); pg.mouse.click(box["x"] + 60, box["y"] + 8); pg.wait_for_timeout(200)
        pg.keyboard.press("F1"); pg.wait_for_timeout(600)
        try: pg.wait_for_function(f"{at_top} === '{want}'", timeout=8000)
        except Exception: pass
        got = pg.evaluate(at_top)
        pg.locator(".doctab.kind-help .doctab-close").dispatch_event("mousedown"); pg.wait_for_timeout(300)
        return got
    h_router = f1_in(".smart-router", "pcb-smart-router")
    # The two panels share a place in the dock: the run's is brought to the front again
    pg.evaluate("window.konium.dock.showPanel('boardRun')"); pg.wait_for_timeout(700)
    pin = pg.locator("button[aria-label='Pin Plan, Place and Route']")
    if pin.count(): pin.first.click(); pg.wait_for_timeout(500)
    h_run = f1_in(".board-run", "pcb-board-run")
    check(f"…the Smart Router shows the run's plan and result ({'Routed:' in srt}, {'5 classes, 1 pour, 1 differential pair' in srt}); F1 in it opens the User Guide at {h_router!r}, in the run's panel at {h_run!r}",
          "Routed:" in srt and "5 classes, 1 pour, 1 differential pair" in srt and "free-flowing" in srt and h_router == "pcb-smart-router" and h_run == "pcb-board-run")
    c.close()

    # 26.196: a save whose place can't be written is downloaded instead and said in a window (no empty file stays); large attachments on a bug report go zipped, in parts
    c, pg = site_page("26.196-save")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('ai.routeExample')"); pg.wait_for_timeout(2500)
    # The file selector gives a file the browser then can't write: the temporary file has gone when it is to be swapped in
    pg.evaluate("""() => { window.__w = { picks: 0, removed: 0, aborted: 0, name: '' };
      window.showSaveFilePicker = async (o) => { window.__w.picks++; window.__w.name = o.suggestedName; return { name: o.suggestedName, kind: 'file',
        createWritable: async () => ({ write: async () => {}, abort: async () => { window.__w.aborted++; },
          close: async () => { throw new DOMException('A requested file or directory could not be found at the time an operation was processed.', 'NotFoundError'); } }),
        getFile: async () => ({ size: 0 }), remove: async () => { window.__w.removed++; } }; }; }""")
    with pg.expect_download() as dl:
        pg.evaluate("window.konium.run('file.save')")
    pg.wait_for_timeout(700)
    saved = open(dl.value.path(), "rb").read()
    wst = pg.evaluate("window.__w")
    dlg = pg.locator(".dlg.confirm")
    dtitle = dlg.locator(".dlg-title").inner_text().split("\n")[0] if dlg.count() else ""
    dtext = dlg.inner_text() if dlg.count() else ""
    toast = pg.locator(".toast").inner_text() if pg.locator(".toast").count() else ""
    shot(pg, "196-not-written.png")
    check(f"A save that can't be written (26.196): the board is downloaded instead ({dl.value.suggested_filename}, {len(saved)} bytes, a compound file: {saved[:4] == bytes([0xD0, 0xCF, 0x11, 0xE0])}); the empty file the selector made is taken away ({wst}); a window says so ('{dtitle}'), and nothing says Saved ('{toast}')",
          dl.value.suggested_filename == "Routing Example.PcbDoc" and len(saved) > 100000 and saved[:4] == bytes([0xD0, 0xCF, 0x11, 0xE0]) and wst["picks"] == 1 and wst["removed"] == 1 and wst["aborted"] == 1
          and dtitle == "Downloaded Instead" and "could not be written to the place chosen" in dtext and "could not be found at the time an operation was processed" in dtext and "look in the browser's downloads folder" in dtext
          and "Security or file-sync software" in dtext and "may have been left" not in dtext and "Saved" not in toast)
    dlg.locator(".btn", has_text="OK").click(); pg.wait_for_timeout(300)
    # A report's diagnostics list the save, and how it went out
    pg.evaluate("window.konium.run('help.reportBug')"); pg.wait_for_timeout(400)
    rb = pg.locator(".dlg.reportbug")
    rb.locator("button.link", has_text="Show what they say").click(); pg.wait_for_timeout(200)
    diag = rb.locator(".rb-diag").inner_text()
    hint = rb.locator(".rb-files").inner_text()
    m = re.search(r"Last saves \(1\):\n\s+\d\d:\d\d:\d\d Routing Example\.PcbDoc: ([\d.]+ (?:KB|MB)), downloaded: the place chosen could not be written", diag)
    check(f"…Help › Report a Bug: the diagnostics list the last saves ({m.group(0).splitlines()[-1].strip() if m else 'not found'}) and the failed write among the errors; the attachments' note says large ones are zipped",
          m is not None and "could not be written (A requested file or directory could not be found" in diag and "Over 8 MB together they are zipped before they go (40 MB zipped at most" in hint)
    # Large attachments: 9 MB that doesn't compress goes as a zip in two parts after the report itself
    got = {"form": b"", "parts": [], "pre": 0}
    cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS"}
    def big(route):
        rq = route.request
        if rq.method == "OPTIONS":
            got["pre"] += 1; return route.fulfill(status=204, headers=cors)
        if "part=" in rq.url:
            got["parts"].append((rq.url, rq.post_data_buffer or b"")); return route.fulfill(status=200, content_type="application/json", headers=cors, body='{"ok":true}')
        got["form"] = rq.post_data_buffer or b""
        route.fulfill(status=200, content_type="application/json", headers=cors, body=json.dumps({"ok": True, "id": "0f8fad5b-d9cb-469f-a165-70867728950e", "upload": {"day": "2026-11-19", "parts": 2, "pass": "p.2.x"}}))
    pg.route("https://konium.app/api/report**", big)
    import os as _os, base64 as _b64
    raw = _os.urandom(9 * 1024 * 1024)
    rb.locator("input[type=file]").set_input_files({"name": "Board.brd", "mimeType": "application/octet-stream", "buffer": raw}); pg.wait_for_timeout(500)
    foot = rb.locator(".dlg-footer, footer").first.inner_text() if rb.locator(".dlg-footer, footer").count() else rb.inner_text()
    rb.locator("#rb-text").fill("Smoke test: a large attachment")
    rb.locator(".btn", has_text="Send").click()
    pg.wait_for_function("!document.querySelector('.dlg.reportbug')", timeout=60000); pg.wait_for_timeout(300)
    toast = pg.locator(".toast").inner_text() if pg.locator(".toast").count() else ""
    form = got["form"].decode("latin1")
    bm = re.search(r'name="bulk"\r\n\r\n(\{.*?\})\r\n', form)
    bulk = json.loads(bm.group(1)) if bm else {}
    zipped = b"".join(_b64.b64decode(json.loads(p)["content"]) for _, p in got["parts"])
    urls = [u.split("?")[1] for u, _ in got["parts"]]
    check(f"…a 9 MB attachment: '{foot.splitlines()[0][:60]}'; the report goes first with the zip named in it ({bulk.get('parts')} parts, {bulk.get('size')} bytes, holding {[h['name'] for h in bulk.get('holds', [])]}) and no file; then {len(got['parts'])} parts with the report's pass ({urls}), which joined are the zip ({len(zipped)} bytes, {zipped[:2]!r}) holding the file; thanked ('{toast}')",
          "zipped before they go" in foot and bulk.get("parts") == 2 and bulk.get("holds") == [{"name": "Board.brd", "size": len(raw)}] and 'name="file"' not in form and "Smoke test: a large attachment" in form
          and urls == ["part=1&id=0f8fad5b-d9cb-469f-a165-70867728950e&d=2026-11-19&t=p.2.x", "part=2&id=0f8fad5b-d9cb-469f-a165-70867728950e&d=2026-11-19&t=p.2.x"]
          and len(zipped) == bulk.get("size") and zipped[:2] == b"PK" and raw[:4096] in zipped and len(_b64.b64decode(json.loads(got["parts"][0][1])["content"])) == 6 * 1024 * 1024 and "Report sent. Thank you!" in toast)
    pg.unroute("https://konium.app/api/report**")
    c.close()

    # 26.197 (R21, step 1, planned: on here with features=all): Tools › Parts, the shelf of parts kept in this browser
    c, pg = site_page("26.197-parts")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    sheet = pg.evaluate("(() => { const d = window.konium.state.docs.value.find((x) => x.doc.kind === 'SchDoc'); window.konium.state.activeId.value = d.id; return d.name; })()"); pg.wait_for_timeout(600)
    pg.evaluate("window.konium.run('parts.panel')"); pg.wait_for_timeout(700)
    pin = pg.locator("button[aria-label='Pin Parts']")
    if pin.count(): pin.first.click(); pg.wait_for_timeout(500)
    pp = pg.locator(".parts-panel")
    empty = pp.inner_text()
    pp.locator(".btn", has_text="Add the Example Part").click(); pg.wait_for_timeout(900)
    rows = pp.locator(".parts-list li").all_inner_texts()
    detail = pp.locator(".parts-card").inner_text() if pp.locator(".parts-card").count() else ""
    count = pp.locator(".parts-count")
    tools = [b.get_attribute("aria-label") for b in pp.locator("button.ex-icon-btn").all()]
    shelf = pg.evaluate("window.konium.parts()")
    shot(pg, "197-parts.png")
    check(f"Tools › Parts (26.197): an empty shelf says what a part is ({'Your shelf is empty' in empty}); Add the Example Part puts it there ({rows}), with its facts and checks; its tools are icons, each named ({tools})",
          "Your shelf is empty" in empty and "Kept in this browser only" in empty and len(rows) == 1 and "KD-EX1833-SO8" in rows[0] and "Konium (example) · SO-8 · 8 pins" in rows[0]
          and len(shelf) == 1 and shelf[0]["package"]["footprint"] == "SOIC127P600X175-8N" and "SOIC127P600X175-8N" in detail and "pads by IPC-7351B" in detail and "Every one of its 8 pins has its pad, and every pad its pin" in detail
          and "It doesn't say which datasheet it was read from" in detail and count.inner_text() == "1" and "My Parts.SchLib" in (count.get_attribute("title") or "")
          and tools == ["Add a Part File", "Add the Example Part", "Save as Integrated Library", "Save as Part File", "Remove"] and pp.locator(".parts-row .parts-mark.pm-warning").count() == 1)
    # Placed in the schematic in front from the shelf's library, with what a bill of materials reads from it
    comps = "window.konium.state.active.value.doc.records.filter((r) => r.bag.get('RECORD') === '1').length"
    n0 = pg.evaluate(comps)
    pp.locator(".btn", has_text="Place").first.click(); pg.wait_for_timeout(400)
    box = pg.locator("canvas").first.bounding_box()
    pg.mouse.move(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.8); pg.wait_for_timeout(150)
    pg.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.8); pg.wait_for_timeout(300)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    placed = pg.evaluate("""(() => { const rs = window.konium.state.active.value.doc.records; const i = rs.findIndex((r) => r.bag.get('RECORD') === '1' && r.bag.get('LIBREFERENCE') === 'KD-EX1833-SO8');
      if (i < 0) return null; const own = rs.filter((r) => r.bag.get('OWNERINDEX') === String(i - 1));
      const param = (n) => (own.find((r) => r.bag.get('RECORD') === '41' && r.bag.get('NAME') === n) || { bag: { get: () => null } }).bag.get('TEXT');
      return { lib: rs[i].bag.get('SOURCELIBRARYNAME'), pins: own.filter((r) => r.bag.get('RECORD') === '2').length, mpn: param('Manufacturer Part Number'), maker: param('Manufacturer'),
        fp: (rs.find((r) => r.bag.get('RECORD') === '45' && r.bag.get('MODELNAME') === 'SOIC127P600X175-8N') ? 'SOIC127P600X175-8N' : '') }; })()""")
    check(f"…Place: the part follows the cursor into {sheet} ({pg.evaluate(comps) - n0} more component): {placed}",
          pg.evaluate(comps) == n0 + 1 and placed is not None and placed["lib"] == "My Parts.SchLib" and placed["pins"] == 8 and placed["mpn"] == "KD-EX1833-SO8" and placed["maker"] == "Konium (example)" and placed["fp"] == "SOIC127P600X175-8N")
    # Out as a part file, off the shelf, and in again from the file
    pg.evaluate("""() => { window.__parts = []; window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, createWritable: async () => ({ write: async (b) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); window.__parts.push({ name: o.suggestedName, b64: btoa(s) }); }, close: async () => {} }) }); }""")
    pp.get_by_role("button", name="Save as Part File").click(); pg.wait_for_timeout(500)
    pp.get_by_role("button", name="Save as Integrated Library").click(); pg.wait_for_timeout(700)
    files = pg.evaluate("window.__parts")
    import base64 as _b64p
    kpart = _b64p.b64decode(files[0]["b64"]) if files else b""
    intlib = _b64p.b64decode(files[1]["b64"]) if len(files) > 1 else b""
    pp.get_by_role("button", name="Remove").click(); pg.wait_for_timeout(400)
    gone = pg.evaluate("window.konium.parts().length")
    pp.locator("input[type=file]").set_input_files({"name": "KD-EX1833-SO8.kpart", "mimeType": "application/octet-stream", "buffer": kpart}); pg.wait_for_timeout(700)
    back = pg.evaluate("window.konium.parts()")
    pp.locator("input[type=file]").set_input_files({"name": "nonsense.kpart", "mimeType": "application/octet-stream", "buffer": b"not a part"}); pg.wait_for_timeout(400)
    refused = pg.locator(".toast").inner_text() if pg.locator(".toast").count() else ""
    check(f"…Save as Part File ({files[0]['name'] if files else ''}, {len(kpart)} bytes, a zip: {kpart[:2] == b'PK'}) and as an integrated library ({files[1]['name'] if len(files) > 1 else ''}, a compound file: {intlib[:4] == bytes([0xD0, 0xCF, 0x11, 0xE0])}); Remove empties the shelf ({gone}); Add a Part File brings it back ({[p['mpn'] for p in back]}); a file that isn't one is refused ('{refused}')",
          len(files) == 2 and files[0]["name"] == "KD-EX1833-SO8.kpart" and kpart[:2] == b"PK" and b"part.json" in kpart and files[1]["name"] == "KD-EX1833-SO8.IntLib" and intlib[:4] == bytes([0xD0, 0xCF, 0x11, 0xE0])
          and gone == 0 and [p["mpn"] for p in back] == ["KD-EX1833-SO8"] and back[0] == shelf[0] and "nonsense.kpart: Not a part file" in refused)
    # A number looked up: on the shelf however it is written; not there, the Component Builder opens with it and finds its datasheet from the number
    pp.locator(".parts-row").first.click(); pg.wait_for_timeout(200)
    pp.get_by_role("button", name="Remove").hover(); pg.wait_for_timeout(100)
    pp.get_by_label("Part number").fill("so-8"); pg.wait_for_timeout(250)
    by_package = pp.locator(".parts-row").count()
    pp.get_by_label("Part number").fill("kd ex1833/so8"); pg.wait_for_timeout(250); pg.keyboard.press("Enter"); pg.wait_for_timeout(300)
    found = pp.locator(".parts-list li.sel").inner_text() if pp.locator(".parts-list li.sel").count() else ""
    pp.get_by_label("Part number").fill("AB123D"); pg.wait_for_timeout(300)
    missing = pp.locator(".parts-callout").inner_text() if pp.locator(".parts-callout").count() else ""
    none_shown = pp.locator(".parts-none").count()
    pjobs = []
    def parts_ai(route):
        url = route.request.url
        if url.endswith("/config"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"models": [{"id": "m/vision", "name": "Vision", "vision": True, "roles": ["text", "vision"]}],
                                 "defaults": {"text": "m/vision", "vision": "m/vision"}, "allowance": {"jobs": 20, "left": 20}, "shareCache": True}))
        if "/fetch?" in url:
            pjobs.append("fetch")
            return route.fulfill(status=200, content_type="application/pdf", headers={"X-Source-Url": "https://maker.example/ab123.pdf", "Access-Control-Expose-Headers": "X-Source-Url"}, body=open(pdf_path, "rb").read())
        if url.endswith("/accept"):
            return route.fulfill(status=200, content_type="application/json", body='{"ok": true}')
        body = json.loads(route.request.post_data)
        pjobs.append(body["job"])
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": {"url": "https://maker.example/ab123.pdf", "page": "", "maker": "Maker", "title": "AB123 datasheet"},
                      "usage": {"in": 300, "out": 50, "cost": 0.0001}, "model": "m/vision", "allowance": {"jobs": 20, "left": 19}}))
    pg.route("https://konium.app/api/ai/**", parts_ai)
    pg.evaluate("window.konium.prefs.set({ aiMode: 'konium' })"); pg.wait_for_timeout(300)
    pp.locator(".btn", has_text="Build It").click(); pg.wait_for_timeout(900)
    aib = pg.locator(".dlg.ai-builder")
    typed = aib.locator("#ai-part").input_value() if aib.count() else ""
    aib.locator(".btn", has_text="Find Its Datasheet").click()
    try: pg.wait_for_function("document.querySelector('.dlg.ai-builder .ai-file') && /pages?/.test(document.querySelector('.dlg.ai-builder .ai-file').innerText)", timeout=30000)
    except Exception: pass
    pg.wait_for_timeout(400)
    file_line = aib.locator(".ai-file").inner_text() if aib.count() else ""
    ready = aib.locator(".btn", has_text="Read the Datasheet").count() if aib.count() else 0
    check(f"…the field narrows the shelf as it is typed in (by package: {by_package}); '{found.splitlines()[0] if found else ''}' is found however it is written; AB123D isn't there ('{missing.splitlines()[0] if missing else ''}'), and Build It opens the Component Builder with the number ('{typed}'); Find Its Datasheet looks for it and fetches it ({pjobs}): '{file_line[:50]}', ready to be read ({ready})",
          by_package == 1 and found.startswith("KD-EX1833-SO8") and "AB123D is not on your shelf." in missing and none_shown == 1 and typed == "AB123D" and pjobs == ["datasheet", "fetch"] and "2 pages" in file_line and ready == 1)
    aib.locator(".btn", has_text="Close").click(); pg.wait_for_timeout(200)
    pg.unroute("https://konium.app/api/ai/**")
    # In the release itself (no features=all) the parts library is planned
    pg.evaluate("window.konium.prefs.set({ aiMode: 'off' })")
    pg.goto(URL.replace("&features=all", "")); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(800)
    pg.locator(".menubar-item", has_text="Tools").first.click(); pg.wait_for_timeout(200)
    item = pg.locator(".menu-popup .menu-item", has_text="Parts...")
    cls = (item.first.get_attribute("class") or "") if item.count() else "missing"
    pg.keyboard.press("Escape"); pg.wait_for_timeout(100)
    check(f"…planned until its release: with no features=all Tools › Parts is shown as planned ({cls})", "planned" in cls)
    c.close()

    # 26.199: single layer mode in the 3D view; the dark theme's icons; Konium's own panels in one style
    c, pg = site_page("26.199-style")
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(800)
    pg.evaluate(f"{ED}.set3d(true)"); pg.wait_for_timeout(2000)
    box = pg.locator(".viewer3d canvas").bounding_box()
    pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    state = lambda: pg.evaluate(f"(() => {{ const e = {ED}, m = e.view3d.model; return [e.singleLayer, m.bodies.length, m.meshes.filter((x) => x.texture).map((x) => x.texture).join(' ')]; }})()")
    whole = state()
    pg.keyboard.press("Shift+S"); pg.wait_for_timeout(900)
    alone = state()
    said = pg.locator(".toast").last.inner_text() if pg.locator(".toast").count() else ""
    shot(pg, "199-3d-single.png")
    # The layer in front changed with single layer mode on: the view follows it (the bottom layer, then back)
    pg.evaluate(f"(() => {{ const e = {ED}; e.setCurrentLayer(32); }})()"); pg.wait_for_timeout(700)
    bottom = pg.evaluate(f"[{ED}.currentLayer, {ED}.singleLayer]")
    pg.evaluate(f"(() => {{ const e = {ED}; e.setCurrentLayer(1); }})()"); pg.wait_for_timeout(500)
    pg.keyboard.press("Shift+S"); pg.wait_for_timeout(900)
    back = state()
    said_off = pg.locator(".toast").last.inner_text() if pg.locator(".toast").count() else ""
    check(f"Single layer mode in the 3D view (26.199): Shift+S shows the layer in front alone ({alone}; '{said}'), without the components' bodies ({whole[1]} before); it follows the layer in front ({bottom}); Shift+S again brings the board back ({back}; '{said_off}')",
          whole[0] == "off" and whole[1] > 0 and alone[0] != "off" and alone[1] == 0 and alone[2] == "top bottom" and "Single layer mode: Top Layer alone" in said
          and bottom == [32, alone[0]] and back[0] == "off" and back[1] == whole[1] and "Single layer mode: off" in said_off)
    pg.evaluate(f"{ED}.set3d(false)"); pg.wait_for_timeout(700)
    # The dark theme: the colour icons are drawn for a light ground, so they are turned light there (and only there)
    ink = "(() => { const i = document.querySelector('.toolbar .cicon, .tbtn .cicon, .cicon'); return i ? getComputedStyle(i).filter : 'missing'; })()"
    classic = pg.evaluate(ink)
    pg.evaluate("window.konium.prefs.set({ theme: 'dark' })"); pg.wait_for_timeout(500)
    dark = pg.evaluate(ink)
    pg.evaluate("window.konium.run('help.getKonium')"); pg.wait_for_timeout(600)
    gk = pg.locator(".get-body")
    pics = pg.evaluate("[...document.querySelectorAll('.get-body .get-option > svg')].map((s) => Math.round(s.getBoundingClientRect().width))")
    heads = pg.evaluate("[...document.querySelectorAll('.get-body .get-option h3')].map((h) => Math.round(h.getBoundingClientRect().left))")
    dl = gk.locator(".btn", has_text="Download Konium-")
    dl_cls = (dl.first.get_attribute("class") or "") if dl.count() else "missing"
    dl_ink = pg.evaluate("(() => { const b = [...document.querySelectorAll('.get-body .btn')].find((x) => x.textContent.includes('Download Konium-')); if (!b) return null; const s = getComputedStyle(b); return [s.color, s.backgroundColor]; })()")
    shot(pg, "199-get-dark.png")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    pg.evaluate("window.konium.prefs.set({ theme: 'classic' })"); pg.wait_for_timeout(400)
    check(f"…the dark theme turns the colour icons light ({classic} → {dark[:40]}); Get Konium Designer: its two pictures one size ({pics}) with the headings on one line ({heads}), the download a filled button whose words stand out from it ({dl_cls}; {dl_ink})",
          classic == "none" and dark.startswith("invert(1)") and len(pics) == 2 and pics[0] == pics[1] == 32 and len(set(heads)) == 1 and "kv-cta" in dl_cls and dl_ink is not None and dl_ink[0] != dl_ink[1])
    # Konium's own panels in one style: a section's name small and upper-case, its tools as named icons, the one action that runs filled
    pg.evaluate("window.konium.run('emc.panel')"); pg.wait_for_timeout(800)
    pin = pg.locator("button[aria-label='Pin EMC Check']")
    if pin.count(): pin.first.click(); pg.wait_for_timeout(500)
    ep = pg.locator(".emcpanel")
    look = lambda sel: pg.evaluate("(s) => { const e = document.querySelector(s); if (!e) return null; const c = getComputedStyle(e); return [c.textTransform, c.borderTopLeftRadius, c.height, !!e.querySelector('svg')]; }", sel)
    h_emc, run_emc, box_emc = look(".emcpanel h4"), look(".emcpanel .pw-run .btn.default"), look(".emcpanel .pw-field input")
    ep.get_by_role("button", name="Check").click(); pg.wait_for_timeout(2500)
    tools = [x.get_attribute("aria-label") for x in ep.locator(".kv-head .ex-icon-btn").all()]
    # With AI off a panel that needs a model says so in the form the empty states share, with the way to Preferences
    pg.evaluate("window.konium.run('ai.layoutPlanner')"); pg.wait_for_timeout(800)
    pin = pg.locator("button[aria-label='Pin Layout Planner']")
    if pin.count(): pin.first.click(); pg.wait_for_timeout(500)
    off = pg.locator(".layout-planner .kv-empty")
    off_text = off.inner_text() if off.count() else ""
    off_btn = [x.inner_text().strip() for x in off.locator(".btn").all()] if off.count() else []
    shot(pg, "199-panels.png")
    check(f"…Konium's own panels in one style: EMC Check's section names {h_emc}, its Check filled with its icon {run_emc}, its fields rounded {box_emc}, its results' tools as icons {tools}; the Layout Planner with AI off: an empty state with its button ({off_btn})",
          h_emc is not None and h_emc[0] == "uppercase" and run_emc is not None and run_emc[1] == "4px" and run_emc[2] == "26px" and run_emc[3] and box_emc is not None and box_emc[1] == "4px" and box_emc[2] == "24px"
          and tools == ["Report..."] and off_text.startswith("AI is off") and "Preferences › System › AI" in off_text and off_btn == ["Open Preferences..."])
    c.close()

    # 26.200: the first build whose source is public. Its licence and the notices of what is built in travel in the file;
    # what the review before it found stays closed: a script's word is checked, a crafted file's styles are numbers, and
    # with network activity off the browser refuses every kind of load while the program's own parts go on working
    c = b.new_context(viewport={"width": 1366, "height": 860}, accept_downloads=True)
    c.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    pg = c.new_page()
    pg.on("pageerror", lambda e: errors.append(f"pageerror (26.200-open): {e}"))
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    pg.evaluate("window.konium.run('help.about')"); pg.wait_for_timeout(500)
    ab = pg.locator(".about-body")
    ab.locator(".btn", has_text="Licence...").click(); pg.wait_for_timeout(500)
    lic = pg.locator(".dlg.third-party").last
    lic_text = lic.inner_text() if lic.count() else ""
    gpl = lic.locator("pre.tp-own").inner_text() if lic.locator("pre.tp-own").count() else ""
    shot(pg, "200-licence.png")
    lic.locator(".btn", has_text="Close").click(); pg.wait_for_timeout(300)
    ab.locator(".btn", has_text="Third-Party Software...").click(); pg.wait_for_timeout(500)
    tp = pg.locator(".dlg.third-party").last
    names = [x.inner_text() for x in tp.locator(".tp-row b").all()]
    tp.locator(".tp-row", has_text="Hershey").click(); pg.wait_for_timeout(300)
    hershey = tp.locator(".tp-text").inner_text() if tp.locator(".tp-text").count() else ""
    tp.locator("input[type=search]").fill("apache"); pg.wait_for_timeout(300)
    apache = [x.inner_text() for x in tp.locator(".tp-row b").all()]
    shot(pg, "200-third-party.png")
    tp.locator(".btn", has_text="Close").click(); pg.wait_for_timeout(300)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    check(f"Open source (26.200): Help › About › Licence shows the copyright line and the licence in full ({len(gpl)} characters); Third-Party Software lists what is built in ({len(names)}), each with its notice; a search narrows it ({apache})",
          "Copyright (C) 2026" in lic_text and "either version 3 of the License, or (at your option) any later version" in lic_text and "github.com/knivd/konium-designer" in lic_text
          and "GNU GENERAL PUBLIC LICENSE" in gpl and "Version 3, 29 June 2007" in gpl and len(gpl) > 30000
          and all(n in names for n in ["preact", "pdfjs-dist", "manifold-3d", "clipper-lib", "isomorphic-git"]) and "Konium Designer" not in names and any(n.startswith("Hershey") for n in names)
          and "Dr. A. V. Hershey" in hershey and "Permission is hereby granted" in hershey and "pdfjs-dist" in apache and "manifold-3d" in apache and "preact" not in apache)

    # A script's frame is the script's word: a result of the script's own making plants nothing and changes nothing
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(800)
    pg.locator(".menubar-item", has_text="Tools").first.click(); pg.wait_for_timeout(300)
    pg.locator(".menu-popup .menu-item", has_text="Scripts").first.click(); pg.wait_for_timeout(600)
    panel = pg.locator("section.scripts")
    panel.locator(".scr-bar .link", has_text="New").click(); pg.wait_for_timeout(300)
    def run_script(code, wait=2000):
        panel.locator("textarea.scr-code").fill(code); pg.wait_for_timeout(150)
        panel.locator(".scr-run .btn.default").click(); pg.wait_for_timeout(wait)
        return panel.locator(".scr-log").inner_text()
    NAMES = "window.konium.state.active.value.editor.doc.components.map((c) => typeof c.designator === 'string' ? c.designator : 'NOT A TEXT').join(' ')"
    was = pg.evaluate(NAMES)
    PLANT = "{ type: 'img', props: { src: 'x', dangerouslySetInnerHTML: { __html: '<img src=x onerror=\\'window.__pwned=1\\'>' } }, key: null, ref: null, constructor: undefined }"
    forged = run_script("self.postMessage({ type: 'done', ops: [{ op: 'designator', id: 'c0', value: " + PLANT + " }], files: [], log: ['said by the script', " + PLANT + "] });\nawait new Promise(() => {});")
    planted1 = pg.evaluate("[document.querySelectorAll('.scr-log img, .scr-log [onerror]').length, window.__pwned === undefined]")
    logonly = run_script("self.postMessage({ type: 'done', ops: [], files: [{ name: " + PLANT + ", text: 'x' }], log: [" + PLANT + ", 'only this line'] });\nawait new Promise(() => {});")
    planted2 = pg.evaluate("[document.querySelectorAll('.scr-log img, .scr-log [onerror]').length, window.__pwned === undefined, document.querySelectorAll('.scr-line.file').length]")
    honest = run_script("print('pads', board.pads.length > 0);")
    check(f"A script's result is the script's word (26.200): one of its own making with an element for a designator fails the run ({forged.splitlines()[-1][:90]!r}), plants nothing ({planted1}, {planted2}) and changes nothing; its own lines stay ({logonly.splitlines()[0]!r}); an honest script runs as before ({honest.splitlines()[0]!r})",
          "said by the script" in forged and "sent back something that is not a designator" in forged and "Nothing was changed" in forged and planted1 == [0, True]
          and logonly.splitlines()[0] == "only this line" and planted2 == [0, True, 0] and pg.evaluate(NAMES) == was and "NOT A TEXT" not in was and honest.startswith("pads true"))

    # A crafted multi-board schematic: its styles' "colours" are markup; the drawing takes numbers only
    import zipfile, io
    SLY = '0);"/><img src=x onerror="window.__pwned=2"><rect fill="rgba(0'
    zb = io.BytesIO()
    with zipfile.ZipFile(zb, "w") as z:
        z.writestr("logical.json", json.dumps({"modules": [{"id": 1, "designator": "M1", "title": "Crafted"}], "powerPorts": [], "connections": [], "conflicts": [], "parameters": []}))
        z.writestr("pages/page_1.json", json.dumps({"size": {"width": 800, "height": 600}, "items": [None, 7, {"id": 10, "$type": "__drawingModule", "logicalObjectId": 1, "rect": {"x": 100, "y": 100, "width": 200, "height": 120}, "fillStyleId": 1, "lineStyleId": 2}]}))
        z.writestr("styles.json", json.dumps({"fillStyles": [{"id": 1, "color": {"r": SLY, "g": SLY, "b": 9, "a": SLY}}], "lineStyles": [None, {"id": 2, "thickness": SLY, "color": {"r": 1, "g": 2, "b": 3}, "dashPattern": [SLY, 4]}]}))
    pg.evaluate("(a) => window.konium.openBatch([{ name: 'Crafted.MbsDoc', bytes: new Uint8Array(a) }])", list(zb.getvalue())); pg.wait_for_timeout(1500)
    art = pg.evaluate("(() => { const a = document.querySelector('.mbsdoc .dd-art'); if (!a) return null; const r = [...a.querySelectorAll('rect')].find((x) => x.getAttribute('width') === '200'); return [a.querySelectorAll('img, script, [onerror], [onload]').length, r ? r.getAttribute('fill') : null, r ? r.getAttribute('stroke') : null, r ? r.getAttribute('stroke-width') : null, window.__pwned === undefined, a.querySelectorAll('text').length]; })()")
    shot(pg, "200-crafted-mbs.png")
    check(f"A crafted multi-board schematic (26.200) opens as a drawing and nothing else: no element of its making, its module drawn with numbers for its colours and width ({art})",
          art is not None and art[0] == 0 and art[1] == "rgba(0,0,9,1)" and art[2] == "rgba(1,2,3,1)" and art[3] == "1.5" and art[4] and art[5] >= 2)

    # Another file with the name of a document that is open: said, not passed off as the open one
    n_docs = pg.evaluate("window.konium.state.docs.value.length")
    pg.evaluate("() => { const f = window.konium.demoFiles().find((x) => x.name === 'Demo.PcbDoc'); window.konium.openBatch([{ name: 'Rev.PcbDoc', bytes: f.bytes }]); }"); pg.wait_for_timeout(1500)
    pg.evaluate("() => { const f = window.konium.demoFiles().find((x) => x.name === 'Demo.PcbLib'); window.konium.openBatch([{ name: 'Rev.PcbDoc', bytes: f.bytes }]); }"); pg.wait_for_timeout(900)
    said2 = " | ".join(pg.locator(".toast").all_inner_texts())
    pg.evaluate("() => { const f = window.konium.demoFiles().find((x) => x.name === 'Demo.PcbDoc'); window.konium.openBatch([{ name: 'Rev.PcbDoc', bytes: f.bytes }]); }"); pg.wait_for_timeout(700)
    check(f"A second file with the name of an open document (26.200) is not opened, and that is said; the same file again just comes forward ({pg.evaluate('window.konium.state.docs.value.length') - n_docs} more document)",
          "Rev.PcbDoc was not opened: another document of that name is open" in said2 and pg.evaluate("window.konium.state.docs.value.length") == n_docs + 1)
    c.close()

    # Network activity off, sealed at the start: every kind of load from outside is refused by the browser, and the
    # program's own parts that are made in memory (the script's frame and worker, the simulator's worker, the 3D view) work
    c = b.new_context(viewport={"width": 1366, "height": 860}, accept_downloads=True)
    c.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    pg = c.new_page()
    pg.on("pageerror", lambda e: errors.append(f"pageerror (26.200-sealed): {e}"))
    # (what was answered from outside: a request the policy refuses is never sent, so it has no answer)
    asked = []
    pg.on("response", lambda r: asked.append(r.url) if not r.url.startswith(("data:", "blob:")) else None)
    pg.goto(URL); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1000)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false, offline: true })"); pg.wait_for_timeout(300)
    pg.reload(); pg.wait_for_function("window.konium !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    asked.clear()
    policy = pg.evaluate("document.querySelector('meta[http-equiv=Content-Security-Policy][data-konium=offline]')?.content || ''")
    refused = pg.evaluate("""async () => {
      const seen = [];
      document.addEventListener('securitypolicyviolation', (e) => seen.push(e.effectiveDirective));
      const tryEl = (make) => new Promise((res) => { const el = make(); el.onload = () => res('loaded'); el.onerror = () => res('refused'); document.head.append(el); setTimeout(() => res('nothing'), 1500); });
      const script = await tryEl(() => Object.assign(document.createElement('script'), { src: 'https://example.com/x.js' }));
      const style = await tryEl(() => Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'https://example.com/x.css' }));
      const img = await tryEl(() => Object.assign(new Image(), { src: 'https://example.com/x.png' }));
      const got = await fetch('https://example.com/x').then(() => 'fetched', () => 'refused');
      let worker = 'made'; try { new Worker('https://example.com/w.js'); } catch (e) { worker = 'refused'; }
      await new Promise((r) => setTimeout(r, 300));
      return { script, style, img, got, worker, seen: [...new Set(seen)].sort().join(' '), manifest: document.querySelectorAll('link[rel=manifest]').length };
    }""")
    pg.evaluate("window.konium.run('file.openDemo')"); pg.wait_for_timeout(2500)
    pg.locator(".doctab", has_text="Demo.PcbDoc").first.dispatch_event("mousedown"); pg.wait_for_timeout(800)
    pg.locator(".menubar-item", has_text="Tools").first.click(); pg.wait_for_timeout(300)
    pg.locator(".menu-popup .menu-item", has_text="Scripts").first.click(); pg.wait_for_timeout(600)
    panel = pg.locator("section.scripts")
    panel.locator(".scr-bar .link", has_text="New").click(); pg.wait_for_timeout(300)
    panel.locator("textarea.scr-code").fill("print('sealed', board.components.length);"); pg.wait_for_timeout(150)
    panel.locator(".scr-run .btn.default").click(); pg.wait_for_timeout(2500)
    sealed_log = panel.locator(".scr-log").inner_text()
    pg.evaluate(f"{ED}.set3d(true)"); pg.wait_for_timeout(2500)
    meshes = pg.evaluate(f"(() => {{ const m = {ED}.view3d && {ED}.view3d.model; return m ? m.meshes.length : 0; }})()")
    pg.evaluate(f"{ED}.set3d(false)"); pg.wait_for_timeout(500)
    outside = [u for u in asked if not u.startswith(SITE) and "127.0.0.1" not in u and "localhost" not in u]
    check(f"Network activity off, sealed (26.200): a script, a style sheet, a picture, a request and a worker from outside are each refused by the browser ({refused}); no manifest is asked for; the program's own script frame runs ({sealed_log.splitlines()[0]!r}) and the 3D view draws ({meshes} meshes); nothing was answered from outside the site ({outside})",
          all(d in policy for d in ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "worker-src data: blob:", "manifest-src 'none'", "connect-src data: blob:"])
          and refused["script"] == "refused" and refused["style"] == "refused" and refused["img"] == "refused" and refused["got"] == "refused" and refused["worker"] == "refused"
          and all(d in refused["seen"] for d in ["script-src-elem", "style-src-elem", "img-src", "connect-src"]) and refused["manifest"] == 0
          and sealed_log.startswith("sealed 4") and meshes > 0 and not outside)
    pg.evaluate("window.konium.prefs.set({ offline: false })")
    c.close()

    # The website says what the program now is: the three blunt answers first, each statement about another product beside its source
    c, pg = site_page("26.200-site")
    pg.goto(SITE + "faq/"); pg.wait_for_timeout(600)
    blunt = pg.evaluate("[...document.querySelectorAll('.qa.blunt')].map((q) => [q.id, [...q.querySelectorAll('a[href^=http]')].map((a) => new URL(a.href).host).filter((h) => h !== 'konium.app').join(' ')])")
    first3 = pg.evaluate("[...document.querySelectorAll('.qa')].slice(0, 3).map((q) => q.id)")
    src_a = pg.evaluate("(() => { const q = document.getElementById('source'); return q ? [q.innerText.includes('GNU General Public License'), [...q.querySelectorAll('a')].some((a) => a.href === 'https://github.com/knivd/konium-designer')] : null; })()")
    pg.goto(SITE + "support/"); pg.wait_for_timeout(400)
    topics = pg.evaluate("[...document.querySelectorAll('form.contact select[name=topic] option')].map((o) => o.textContent)")
    check(f"The website (26.200): the FAQ opens with its three blunt answers ({first3}), what they say of other products beside their own documentation ({blunt}); the source's answer names the licence and links the repository ({src_a}); a security problem can be reported privately ({topics})",
          first3 == ["ai-slop", "kicad", "free-eda"] and len(blunt) == 3 and "docs.kicad.org" in dict(blunt).get("kicad", "") and "prodocs.easyeda.com" in dict(blunt).get("free-eda", "")
          and src_a == [True, True] and topics == ["A question or a comment", "A security problem, reported privately", "Something else"])
    c.close()
    b.close()

    # 26.179: the steps on the graphics card (here one drawn in software, let in by gpu=software): the same as the processor's
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-unsafe-webgpu"])
    c, pg = site_page("26.179-gpu")
    pg.goto(URL + "&gpu=software"); pg.wait_for_function("window.konium !== undefined && window.konium.gpuCheck !== undefined", timeout=60000); pg.wait_for_timeout(1200)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    gc = pg.evaluate("window.konium.gpuCheck(120)")
    pg.evaluate("window.konium.run('antenna.example')"); pg.wait_for_timeout(2500)
    tick_gpu = pg.locator(".antennapanel label", has_text="Run on the graphics card").count()
    check(f"The antenna's steps on the graphics card (26.179): against the processor's on a dipole, the port's voltage differs by {gc and gc['port']:.2e} of its largest and the field by {gc and gc['field']:.2e} over {gc and gc['steps']} steps ({gc and gc['adapter']}); the panel offers the card ({tick_gpu}), and not where there is none ({tick_soft})",
          gc is not None and gc["port"] < 2e-4 and gc["field"] < 2e-3 and tick_gpu == 1 and tick_soft == 0)
    c.close()
    b.close()

print(json.dumps(errors, indent=1))
failed = [n for n, ok in checks if not ok]
print(f"{len(checks) - len(failed)}/{len(checks)} checks passed")
sys.exit(1 if failed or errors else 0)
