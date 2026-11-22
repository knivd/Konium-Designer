"""The User Guide's picture recipes (see helpPictures.py): one per picture id."""
from helpPictures import recipe, run, panel, hide_panel, demo, tab, menu, deselect, default_layout  # noqa: F401

K = "window.konium"


def ev(pg, js, wait=400):
    r = pg.evaluate(js)
    pg.wait_for_timeout(wait)
    return r


def prefs_page(pg, page):
    ev(pg, f"{K}.state.prefsPage.value = '{page}'; {K}.state.showPrefs.value = true", 600)
    return ".dlg.prefs"


def demo_pcb(pg):
    demo(pg)
    ev(pg, f"""(() => {{ const k = {K}, s = k.state; const d = s.docs.value.find(x => x.name === 'Demo.PcbDoc');
      if (d) s.activeId.value = d.id; else k.openProjectDocument(s.projects.value.find(p => p.name === 'Demo.PrjPcb'), 'Demo.PcbDoc'); }})()""", 1200)
    run(pg, "view.fitBoard", 600)


# ─── Getting started ────────────────────────────────────────────────────────────────────────

@recipe("gs-get-konium")
def _(pg):
    run(pg, "help.getKonium", 700)
    return '.dlg[aria-label="Get Konium Designer on this computer"]'


@recipe("gs-home-page")
def _(pg):
    run(pg, "view.home", 1500)
    return None


@recipe("gs-main-window")
def _(pg):
    demo(pg)
    default_layout(pg, 600)
    return None


@recipe("gs-shortcut-keys")
def _(pg):
    demo(pg)
    run(pg, "help.shortcuts", 600)
    return '.dlg[aria-label="Shortcut Keys"]'


@recipe("gs-projects-panel")
def _(pg):
    demo(pg)
    default_layout(pg)
    panel(pg, "projects")
    for _i in range(2):
        ev(pg, "document.querySelectorAll('.tree-folder-row[aria-expanded=\"false\"]').forEach(b => b.click())", 300)
    return 'section.dock-group:has(header[data-panel-id="projects"])'


@recipe("gs-new-project")
def _(pg):
    run(pg, "file.newProject", 600)
    return ".dlg.newproject"


@recipe("gs-project-folder")
def _(pg):
    ev(pg, f"{K}.state.projectAccess.value = {{ name: 'Demo.PrjPcb', file: {K}.demoFiles().find(f => f.name === 'Demo.PrjPcb'), missing: 8 }}", 600)
    return ".dlg.access"


@recipe("gs-import-wizard")
def _(pg):
    run(pg, "file.importWizard", 700)
    return ".dlg.importwizard"


@recipe("gs-backup-prefs")
def _(pg):
    return prefs_page(pg, "dm-backup")


@recipe("gs-storage-manager")
def _(pg):
    demo(pg)
    ev(pg, f"{K}.prefs.set({{ historyAutosaves: true }})")
    ev(pg, f"(async () => {{ {K}.run('edit.selectAll'); {K}.run('edit.nudgeRight'); await {K}.backup.autoSaveNow(); }})()", 800)
    ev(pg, f"(async () => {{ {K}.run('edit.nudgeRight'); await {K}.backup.autoSaveNow(); {K}.run('edit.deselectAll'); }})()", 800)
    panel(pg, "storage")
    ev(pg, f"(() => {{ const l = structuredClone({K}.dock.layout.value); l.zones.left.size = 600; {K}.dock.setLayout(l); }})()", 600)
    return 'section.dock-group:has(header[data-panel-id="storage"])'


@recipe("gs-panel-group")
def _(pg):
    demo(pg)
    default_layout(pg)
    ev(pg, f"{K}.state.activeId.value = {K}.state.docs.value.find(d => d.name === 'Demo.PcbDoc').id", 1000)
    return ".dock-zone.zone-left"


@recipe("gs-preferences")
def _(pg):
    return prefs_page(pg, "sys-general")


@recipe("gs-network")
def _(pg):
    return prefs_page(pg, "sys-network")


@recipe("gs-report-bug")
def _(pg):
    demo(pg)
    run(pg, "help.reportBug", 700)
    return ".dlg.reportbug:not(.contact)"


# ─── PCB design ─────────────────────────────────────────────────────────────────────────────

@recipe("pcb-overview")
def _(pg):
    demo_pcb(pg)
    panel(pg, "projects")
    run(pg, "edit.deselectAll", 300)
    pg.mouse.move(640, 420)
    pg.wait_for_timeout(300)
    return "SCREEN_KEEP_MOUSE"


@recipe("pcb-view-config")
def _(pg):
    demo_pcb(pg)
    run(pg, "pcb.viewConfigurations", 800)
    return ".dlg.viewcfg"


@recipe("pcb-teardrops")
def _(pg):
    demo_pcb(pg)
    run(pg, "ad:PCB:TearDrops", 600)
    return ".dlg.teardropsdlg"


@recipe("pcb-layer-stack")
def _(pg):
    demo_pcb(pg)
    run(pg, "pcb.layerStackManager", 800)
    return ".dlg.lsm"


@recipe("pcb-import")
def _(pg):
    demo_pcb(pg)
    ev(pg, f"(() => {{ const ed = {K}.state.active.value.editor; ed.selectComponent(ed.doc.components.findIndex(c => c.designator === 'C2')); {K}.run('edit.delete'); {K}.run('design.importChanges'); }})()", 1000)
    pg.locator(".dlg.eco .btn", has_text="Validate Changes").first.click()
    pg.wait_for_timeout(800)
    return ".dlg.eco"


@recipe("pcb-rules")
def _(pg):
    demo_pcb(pg)
    run(pg, "design.rules", 800)
    row = pg.locator(".dlg.rules .rules-row", has_text="Clearance_Power").first
    if row.count() == 0:
        pg.locator(".dlg.rules .rules-row", has_text="Electrical").first.dispatch_event("mousedown")
        pg.wait_for_timeout(300)
        pg.locator(".dlg.rules .rules-row", has_text="Clearance").first.dispatch_event("mousedown")
        pg.wait_for_timeout(300)
    pg.locator(".dlg.rules .rules-row", has_text="Clearance_Power").first.dispatch_event("mousedown")
    pg.wait_for_timeout(500)
    return ".dlg.rules"


@recipe("pcb-routing-dialog")
def _(pg):
    demo_pcb(pg)
    run(pg, "route.interactive", 500)
    ev(pg, "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))", 800)
    return ".dlg.irdlg"


@recipe("pcb-activeroute")
def _(pg):
    demo_pcb(pg)
    ev(pg, f"(() => {{ const ed = {K}.state.active.value.editor; ed.selectComponent(ed.doc.components.findIndex(c => c.designator === 'U1')); }})()", 400)
    panel(pg, "activeRoute", 700)
    return 'section.dock-group:has(header[data-panel-id="activeRoute"])'


# The Layout Planner and the Smart Router: their example boards, with plans written here as a model writes them
# (the panels then say "By example plan"; no model is asked)
EXAMPLE_LAYOUT = {
    "summary": "A small USB sensor node: power comes in at the left, the microcontroller sits in the middle, the sensor away from the regulator, the headers at the edges.",
    "groups": [
        {"name": "USB input and regulator", "why": "The cable's power comes in here and is regulated before it goes on.", "parts": ["J1", "U1", "C1", "C2"], "main": "J1", "x": 0.12, "y": 0.5, "side": "top"},
        {"name": "Microcontroller", "why": "The microcontroller with its decoupling, crystal and reset.", "parts": ["U2", "C3", "C4", "C5", "C6", "Y1", "C7", "C8", "R1"], "main": "U2", "x": 0.5, "y": 0.5, "side": "top"},
        {"name": "Sensor", "why": "The sensor with its pull-ups, away from the regulator's heat.", "parts": ["U3", "C9", "R2", "R3"], "main": "U3", "x": 0.78, "y": 0.82, "side": "top"},
        {"name": "Debug and indicator", "why": "The debug header and the LED, where they can be reached.", "parts": ["J3", "D1", "R4"], "main": "J3", "x": 0.62, "y": 0.1, "side": "top"},
        {"name": "UART header", "why": "Fixed at the right edge.", "parts": ["J2"], "main": "J2", "x": 0.94, "y": 0.5, "side": "top"}],
    "edges": [{"part": "J1", "edge": "left", "along": 0.5, "why": "The USB cable plugs in from the left."}, {"part": "J3", "edge": "bottom", "along": 0.6, "why": "The debug probe plugs in from below."}],
    "near": [{"part": "C1", "to": "U1-3", "mm": 3, "why": "Input capacitor."}, {"part": "C2", "to": "U1-2", "mm": 3, "why": "Output capacitor."}, {"part": "C3", "to": "U2-1", "mm": 2, "why": "Decouples VDD at pin 1."},
             {"part": "C4", "to": "U2-17", "mm": 2, "why": "Decouples VDD at pin 17."}, {"part": "C5", "to": "U2-32", "mm": 2, "why": "Decouples VDD at pin 32."}, {"part": "C6", "to": "U2-5", "mm": 2, "why": "Decouples VDDA."},
             {"part": "Y1", "to": "U2-2", "mm": 5, "why": "The crystal at the oscillator pins."}, {"part": "C7", "to": "Y1", "mm": 3, "why": "Load capacitor."}, {"part": "C8", "to": "Y1", "mm": 3, "why": "Load capacitor."},
             {"part": "R1", "to": "U2-4", "mm": 5, "why": "Reset pull-up."}, {"part": "C9", "to": "U3-1", "mm": 2, "why": "Decouples the sensor."}, {"part": "R4", "to": "D1", "mm": 4, "why": "The LED's resistor."}],
    "apart": [{"a": "U1", "b": "U3", "mm": 15, "why": "The regulator's heat away from the sensor."}],
    "clear": [{"part": "J1", "mm": 1, "why": "Room for the plug."}],
    "notes": ["Pour ground on the bottom layer."]}
EXAMPLE_ROUTING = {
    "summary": "A two-layer USB sensor node: signals on the top, ground poured over the bottom.",
    "classes": [
        {"name": "Crystal", "why": "Short, on one layer, with no vias.", "nets": ["XTAL1", "XTAL2"], "width": 0.25, "clearance": 0, "layers": ["Top Layer"], "vias": "none", "order": 1},
        {"name": "USB", "why": "Full speed data, kept on the top over the ground.", "nets": ["USB_DP", "USB_DM"], "width": 0.25, "layers": ["Top Layer"], "vias": "few", "order": 2},
        {"name": "Power", "why": "5 V in and the 3.3 V rail, well under 1 A.", "nets": ["VBUS", "+3V3"], "width": 0.5, "layers": [], "vias": "free", "order": 3},
        {"name": "Ground", "why": "Into the pour.", "nets": ["GND"], "width": 0.4, "order": 4},
        {"name": "Signals", "why": "The rest, on the top where they can.", "nets": ["NRST", "TX", "RX", "LED", "LED_A", "SWDIO", "SWCLK", "SCL", "SDA"], "width": 0, "layers": ["Top Layer"], "vias": "free", "order": 5}],
    "via": {"diameter": 0.6, "hole": 0.3, "why": "The board's 1.27 mm via is too large beside 0402 parts."},
    "pours": [{"net": "GND", "layer": "Bottom Layer", "why": "One return path under everything."}],
    "pairs": [{"name": "USB", "p": "USB_DP", "n": "USB_DM", "gap": 0.2, "why": "USB data."}],
    "notes": ["The 3.3 V rail was taken as 0.3 A."]}


def example_plans(pg):
    import json

    def reply(route):
        if route.request.url.endswith("/config"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "models": [{"id": "example/plan", "name": "example plan", "roles": ["text", "vision"], "weight": 13}], "defaults": {"model": "example/plan"},
                "allowance": {"jobs": 25, "left": 25, "weighed": True}, "shareCache": True, "jobs": ["layout", "routing", "ping"]}))
        body = json.loads(route.request.post_data)
        ans = EXAMPLE_LAYOUT if body["job"] == "layout" else EXAMPLE_ROUTING
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"answer": ans, "usage": {"in": 0, "out": 0, "cost": 0}, "model": "example/plan", "allowance": {"jobs": 25, "left": 24}}))
    pg.route("https://konium.app/api/ai/**", reply)
    ev(pg, f"{K}.prefs.set({{ aiMode: 'konium' }})", 700)


def pinned(pg, title):
    pin = pg.locator(f"button[aria-label='Pin {title}']")
    if pin.count():
        pin.first.click()
        pg.wait_for_timeout(500)


def placed_example(pg):
    """The planner's example board, planned and placed."""
    example_plans(pg)
    run(pg, "ai.layoutExample", 2500)
    pinned(pg, "Layout Planner")
    pg.locator(".layout-planner .btn", has_text="Plan the Layout").click()
    pg.wait_for_timeout(1500)
    pg.locator(".layout-planner .btn", has_text="Place by the Plan").click()
    pg.wait_for_function("(document.querySelector('.layout-planner .lp-result') || {}).innerText && document.querySelector('.layout-planner .lp-result').innerText.includes('Placed:')", timeout=30000)
    pg.wait_for_timeout(900)


def routed_example(pg):
    """The router's example board, planned and routed."""
    example_plans(pg)
    pg.evaluate("window.konium.run('ai.routeExample')")
    pg.wait_for_function("window.konium.state.active.value && window.konium.state.active.value.name === 'Routing Example.PcbDoc'", timeout=30000)
    pg.wait_for_timeout(1500)
    pinned(pg, "Smart Router")
    pg.locator(".smart-router .btn", has_text="Plan the Routing").click()
    pg.wait_for_timeout(1500)
    pg.locator(".smart-router .btn", has_text="Route by the Plan").click()
    pg.wait_for_function("(document.querySelector('.smart-router .lp-result') || {}).innerText && document.querySelector('.smart-router .lp-result').innerText.includes('Routed:')", timeout=90000)
    pg.wait_for_timeout(900)


@recipe("pcb-layout-planner")
def _(pg):
    placed_example(pg)
    return 'section.dock-group:has(header[data-panel-id="layoutPlanner"])'


@recipe("pcb-smart-router")
def _(pg):
    routed_example(pg)
    return 'section.dock-group:has(header[data-panel-id="smartRouter"])'


@recipe("pcb-free-flowing")
def _(pg):
    ev(pg, f"{K}.prefs.set({{ pcbRouteStyle: 'flowing' }})", 300)
    routed_example(pg)
    hide_panel(pg, "smartRouter")
    hide_panel(pg, "libraries")
    hide_panel(pg, "projects")
    deselect(pg)
    run(pg, "view.fitBoard", 900)
    return ".viewport"


@recipe("pcb-polygon")
def _(pg):
    demo_pcb(pg)
    ev(pg, f"{K}.editObject({K}.state.active.value.editor, 'poly:0')", 800)
    return ".dlg.polydlg"


@recipe("pcb-polygon-pad")
def _(pg):
    run(pg, "file.newPcbLib", 1500)
    run(pg, "tools.scripts", 600)
    p = pg.locator("section.scripts")
    p.locator(".scr-bar .link", has_text="New").click()
    pg.wait_for_timeout(300)
    p.locator("textarea.scr-code").fill("board.addPad({ x: 0, y: 0, width: 1.6, name: '1' });\nconst a = board.addArc({ x: 0, y: 0, radius: 1.5, width: 0.05 });\nconst b = board.addArc({ x: 0, y: 0, radius: 2.25, width: 0.05 });\nboard.addArc({ x: 0, y: 0, radius: 2.9, width: 0.15, layer: 'Top Overlay' });\nboard.select([a, b]);")
    pg.wait_for_timeout(200)
    p.locator(".scr-run .btn.default").click()
    pg.wait_for_timeout(1200)
    run(pg, "pcb.padFromSelection", 800)
    hide_panel(pg, "scripts")
    run(pg, "view.fitObjects", 600)
    return None


@recipe("pcb-drc")
def _(pg):
    demo_pcb(pg)
    run(pg, "tools.drc", 800)
    pg.locator(".dlg.drc .rules-tree *", has_text="Rules To Check").last.dispatch_event("mousedown")
    pg.wait_for_timeout(500)
    return ".dlg.drc"


@recipe("pcb-filter")
def _(pg):
    demo_pcb(pg)
    panel(pg, "filter", 600)
    ev(pg, "(() => { const q = document.querySelector('#pcb-filter-query'); q.value = \"IsPad And InNet('GND')\"; q.dispatchEvent(new Event('input', { bubbles: true })); })()", 300)
    pg.locator(".btn", has_text="Apply To All").first.click()
    pg.wait_for_timeout(700)
    return None


@recipe("pcb-panel")
def _(pg):
    demo_pcb(pg)
    panel(pg, "pcb", 700)
    pg.locator('.pcbpanel [aria-label="Nets"] [role=row]', has_text="GND").first.dispatch_event("mousedown")
    pg.wait_for_timeout(600)
    return 'section.dock-group:has(header[data-panel-id="pcb"])'


@recipe("pcb-3d")
def _(pg):
    demo_pcb(pg)
    run(pg, "view.mode3d", 3000)
    run(pg, "view3d.angle", 1200)
    return None


def demo_sch(pg, name="Demo.SchDoc"):
    demo(pg)
    ev(pg, f"""(() => {{ const k = {K}, s = k.state, p = s.projects.value.find(p => p.name === 'Demo.PrjPcb');
      const d = s.docs.value.find(x => x.projectId === p.id && x.name === '{name}');
      if (d) s.activeId.value = d.id; else k.openDocument(p.files.get('{name}'.toLowerCase()), p.id); }})()""", 1200)


ED = f"{K}.state.active.value.editor"
U1 = f"'o' + {ED}.doc.objects.find(o => o.kind === 'component' && o.designator === 'U1').index"


# ─── Schematic capture ──────────────────────────────────────────────────────────────────────

@recipe("sch-overview")
def _(pg):
    demo_sch(pg)
    panel(pg, "projects")
    run(pg, "view.fit", 600)
    return None


@recipe("sch-document-options")
def _(pg):
    demo_sch(pg)
    run(pg, "ad:Sch:DocumentPreferences", 800)
    return ".dlg.docopts"


@recipe("sch-place-part")
def _(pg):
    demo_sch(pg)
    run(pg, "place.part", 800)
    pg.locator(".dlg.placepart2 input[type=text], .dlg.placepart2 input:not([type])").first.fill("LM358")
    pg.wait_for_timeout(600)
    return ".dlg.placepart2"


@recipe("sch-libraries-panel")
def _(pg):
    demo_sch(pg)
    panel(pg, "libraries", 700)
    ev(pg, "(() => { const s = document.querySelector('section.panel.libraries select[aria-label=\"Library\"]') || document.querySelector('section.panel.libraries .lib-pick select'); s.value = 'Demo.SchLib'; s.dispatchEvent(new Event('change', { bubbles: true })); })()", 600)
    ev(pg, "(() => { const r = [...document.querySelectorAll('section.panel.libraries [role=row]')].find(r => r.querySelector('[role=gridcell]')?.textContent.trim() === 'LM358'); r?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); })()", 600)
    return "section.panel.libraries"


@recipe("sch-component-properties")
def _(pg):
    demo_sch(pg)
    ev(pg, f"{K}.editObject({ED}, {U1})", 800)
    return ".dlg.compprops"


@recipe("sch-wiring")
def _(pg):
    demo_sch(pg)
    deselect(pg)
    ev(pg, f"{ED}.zoomToBox({{ minX: 9e6, minY: 28e6, maxX: 82e6, maxY: 49e6 }})", 600)
    return ".viewport"


@recipe("sch-directive-parameters")
def _(pg):
    run(pg, "file.newSch", 1200)
    run(pg, "ad:Sch:PlaceParameterSet", 500)
    box = pg.locator(".viewport").first.bounding_box()
    pg.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    pg.wait_for_timeout(400)
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(300)
    ev(pg, f"{K}.editObject({ED}, 'o' + {ED}.doc.objects.find(o => o.record === 43).index)", 800)
    return ".dlg.directive"


@recipe("sch-inspector")
def _(pg):
    demo_sch(pg)
    ev(pg, f"{ED}.select([{U1}])", 300)
    panel(pg, "inspector", 700)
    return "section.panel.inspector"


@recipe("sch-find-similar")
def _(pg):
    demo_sch(pg)
    ev(pg, f"{ED}.cursor = {{ x: 25000000, y: 40500000 }}", 200)
    run(pg, "edit.findSimilar", 800)
    return ".dlg.findsim"


@recipe("sch-filter")
def _(pg):
    demo_sch(pg)
    panel(pg, "filter", 600)
    ev(pg, "(() => { const q = document.querySelector('#filter-query'); q.value = \"IsPart And (Designator Like 'C*')\"; q.dispatchEvent(new Event('input', { bubbles: true })); })()", 300)
    pg.locator("section.panel .btn", has_text="Apply").first.click()
    pg.wait_for_timeout(700)
    return None


@recipe("sch-hierarchy")
def _(pg):
    demo_sch(pg, "Symbols.SchDoc")
    deselect(pg)
    ev(pg, f"{ED}.zoomToBox({{ minX: 45e6, minY: 4e6, maxX: 69e6, maxY: 21e6 }})", 600)
    return ".viewport"


@recipe("sch-annotate")
def _(pg):
    demo_sch(pg)
    run(pg, "tools.annotate", 800)
    pg.locator(".dlg.annotate .btn", has_text="Reset All").first.click()
    pg.wait_for_timeout(500)
    return ".dlg.annotate"


@recipe("sch-messages")
def _(pg):
    demo_sch(pg)
    run(pg, "tools.erc", 4000)  # the "Compiled …" notice gone before the picture
    return None


@recipe("sch-connection-matrix")
def _(pg):
    demo_sch(pg)
    run(pg, "ad:WorkspaceManager:ConfigureOptions", 800)
    pg.locator(".dlg.projopts [role=tab], .dlg.projopts .tab", has_text="Connection Matrix").first.click()
    pg.wait_for_timeout(500)
    return ".dlg.projopts"


@recipe("sch-eco")
def _(pg):
    demo_sch(pg)
    run(pg, "design.updatePcb", 1000)
    pg.locator(".dlg.eco .btn", has_text="Validate Changes").first.click()
    pg.wait_for_timeout(800)
    return ".dlg.eco"


# ─── Libraries and components ───────────────────────────────────────────────────────────────

def lib_row(pg, root, text):
    ev(pg, f"(() => {{ const r = [...document.querySelectorAll('{root} [role=row]')].find(r => r.querySelector('[role=gridcell]')?.textContent.trim() === '{text}'); r?.dispatchEvent(new MouseEvent('mousedown', {{ bubbles: true }})); }})()", 500)


@recipe("lib-libraries-panel")
def _(pg):
    return sch_libraries(pg)


def sch_libraries(pg):
    demo_sch(pg)
    panel(pg, "libraries", 700)
    ev(pg, "(() => { const s = document.querySelector('section.panel.libraries .lib-pick select'); s.value = 'Demo.SchLib'; s.dispatchEvent(new Event('change', { bubbles: true })); })()", 600)
    lib_row(pg, "section.panel.libraries .lib-list", "LM358")
    return "section.panel.libraries"


@recipe("lib-install")
def _(pg):
    demo_sch(pg)
    run(pg, "ad:Sch:AddRemoveLibraryInSchEditor", 800)
    pg.locator('.dlg[aria-label="Available Libraries"] [role=tab], .dlg[aria-label="Available Libraries"] .tab', has_text="Project").first.click()
    pg.wait_for_timeout(500)
    return '.dlg[aria-label="Available Libraries"]'


@recipe("lib-sch-editor")
def _(pg):
    demo_sch(pg, "Demo.SchLib")
    panel(pg, "library", 600)
    ev(pg, f"{ED}.showSymbol(5)", 400)
    run(pg, "view.fitObjects", 600)
    return None


@recipe("lib-sch-panel")
def _(pg):
    demo_sch(pg, "Demo.SchLib")
    panel(pg, "library", 600)
    ev(pg, f"{ED}.showSymbol(4)", 500)
    return "section.panel.schlib"


@recipe("lib-sch-component")
def _(pg):
    demo_sch(pg, "Demo.SchLib")
    ev(pg, f"{ED}.showSymbol(4)", 400)
    run(pg, "schlib.componentProperties", 800)
    return ".dlg.libcomp"


@recipe("lib-sch-pins")
def _(pg):
    demo_sch(pg, "Demo.SchLib")
    ev(pg, f"{ED}.showSymbol(4)", 400)
    ev(pg, f"(() => {{ const e = {ED}; const pin = e.doc.objects.find(o => o.kind === 'pin' && o.name === 'VIN'); {K}.editObject(e, 'o' + pin.index); }})()", 800)
    return '.dlg[aria-label="Pin Properties"]'


@recipe("lib-sch-models")
def _(pg):
    demo_sch(pg, "Demo.SchLib")
    ev(pg, f"{ED}.showSymbol(4)", 400)
    run(pg, "ad:Sch:ModelManager", 800)
    return ".dlg.modelmgr"


@recipe("lib-pcb-editor")
def _(pg):
    demo_sch(pg, "Demo.PcbLib")
    panel(pg, "library", 600)
    ev(pg, f"{ED}.showFootprint(3)", 600)
    return None


@recipe("lib-pcb-footprint")
def _(pg):
    demo_sch(pg, "Demo.PcbLib")
    ev(pg, f"{ED}.showFootprint(3)", 500)
    ev(pg, f"(() => {{ const e = {ED}; const p = e.doc.prims.find(x => x.kind === 'pad' && x.name === '4'); {K}.editObject(e, p.src.storage + ':' + p.src.index); }})()", 800)
    return ".dlg.padd"


@recipe("lib-component-wizard")
def _(pg):
    demo_sch(pg, "Demo.PcbLib")
    run(pg, "ad:CompMake:RunWizard", 800)
    return '.dlg[aria-label="Component Wizard"]'


@recipe("lib-ipc-wizard")
def _(pg):
    demo_sch(pg, "Demo.PcbLib")
    run(pg, "ad:IPCFootprintWizard:Run", 800)
    return ".dlg.ipcwizard"


@recipe("lib-3d")
def _(pg):
    demo_sch(pg, "Demo.PcbLib")
    ev(pg, f"{ED}.showFootprint(3)", 500)
    run(pg, "ad:PCB:PlaceComponentBody", 800)
    return ".dlg.body3d"


@recipe("lib-reports")
def _(pg):
    demo_sch(pg, "Demo.SchLib")
    run(pg, "ad:Sch:ComponentRuleCheck", 800)
    return ".dlg.rulecheck"


@recipe("lib-update")
def _(pg):
    demo_sch(pg)
    run(pg, "ad:WorkspaceManager:ConfigureLibrarySynch", 1000)
    return ".dlg.updatelib"


@recipe("lib-ai-setup")
def _(pg):
    ev(pg, f"{K}.prefs.set({{ aiMode: 'local' }})")
    return prefs_page(pg, "sys-ai")


@recipe("lib-ai-builder")
def _(pg):
    ev(pg, f"{K}.prefs.set({{ aiMode: 'local' }})")
    demo_sch(pg, "Demo.SchLib")
    run(pg, "ai.componentBuilder", 900)
    return ".dlg.ai-builder"


@recipe("lib-database")
def _(pg):
    demo_sch(pg, "Demo.DbLib")
    ev(pg, "(() => { const s = document.querySelector('.dblib .dbl-source'); if (s && !/^Connected/.test(s.textContent.trim())) s.querySelector('.btn.default')?.click(); })()", 1000)
    return ".dblink.dblib"


# ─── Outputs and manufacturing ─────────────────────────────────────────────────────────────

@recipe("out-gerber-setup")
def _(pg):
    demo_pcb(pg)
    run(pg, "output.gerber", 800)
    pg.locator('.dlg[aria-label="Gerber Setup"] .out-tabs button', has_text="Layers").click()
    pg.wait_for_timeout(400)
    return '.dlg[aria-label="Gerber Setup"]'


@recipe("out-drill-setup")
def _(pg):
    demo_pcb(pg)
    run(pg, "output.drill", 800)
    return '.dlg[aria-label="NC Drill Setup"]'


@recipe("out-pick-place")
def _(pg):
    demo_pcb(pg)
    run(pg, "output.pnp", 800)
    return '.dlg[aria-label="Pick and Place Setup"]'


@recipe("out-bom")
def _(pg):
    demo(pg, "Demo.SchDoc")
    run(pg, "reports.bom", 1000)
    return ".dlg.bom"


@recipe("out-bom-document")
def _(pg):
    demo(pg, "Demo.SchDoc")
    run(pg, "ad:WorkspaceManager:NewBOM", 1500)
    hide_panel(pg, "projects")
    hide_panel(pg, "storage")
    pg.locator(".bomdoc tbody tr").first.locator("td").nth(1).click()
    pg.wait_for_timeout(500)
    ev(pg, "document.querySelector('.bomdoc .bom-scroll').scrollLeft = 0", 300)
    return None


@recipe("out-outjob")
def _(pg):
    demo(pg)
    ev(pg, f"""(() => {{ const k = {K}, s = k.state; k.openProjectDocument(s.projects.value.find(p => p.name === 'Demo.PrjPcb'), 'Demo.OutJob'); }})()""", 1500)
    return None


@recipe("out-print-preview")
def _(pg):
    demo_pcb(pg)
    run(pg, "output.assemblyDrawings", 1500)
    return ".dlg.printpreview"


@recipe("out-printout")
def _(pg):
    demo_pcb(pg)
    run(pg, "output.final", 1500)
    pg.locator(".dlg.printpreview button", has_text="Configuration...").click()
    pg.wait_for_timeout(800)
    return ".dlg.pcbprintout"


@recipe("out-draftsman")
def _(pg):
    demo_pcb(pg)
    run(pg, "file.newDraftsman", 2500)
    return None


@recipe("out-testpoint-setup")
def _(pg):
    demo_pcb(pg)
    run(pg, "output.testPoint", 800)
    return '.dlg[aria-label="Fabrication Testpoint Setup"]'


@recipe("out-fab-profile")
def _(pg):
    demo_pcb(pg)
    run(pg, "design.fabProfile", 800)
    return ".dlg.fab-profile"


@recipe("out-cam")
def _(pg):
    demo_pcb(pg)
    run(pg, "output.gerber", 800)
    pg.locator('.dlg[aria-label="Gerber Setup"] button', has_text="OK").click()
    pg.wait_for_timeout(3000)  # the run writes a zip (the demo has no folder) and opens the files in a CAM document
    return None


@recipe("out-packager")
def _(pg):
    demo(pg, "Demo.PcbDoc")
    run(pg, "ad:WorkspaceManager:Archive", 1500)
    return ".dlg.packager"


# ─── Reference ──────────────────────────────────────────────────────────────────────────────

@recipe("ref-prefs-search")
def _(pg):
    prefs_page(pg, "sys-general")
    pg.fill(".dlg.prefs .prefs-tree input.prefs-search", "snap")
    pg.wait_for_timeout(500)
    return ".dlg.prefs"


@recipe("ref-keyboard-shortcuts")
def _(pg):
    prefs_page(pg, "sys-keys")
    pg.fill('.dlg.prefs input[placeholder="Filter commands"]', "align")
    pg.wait_for_timeout(500)
    return ".dlg.prefs"


@recipe("ref-save-as")
def _(pg):
    demo(pg, "Demo.SchDoc")
    run(pg, "file.saveAs", 700)
    return '.dlg[aria-label="Save [Demo.SchDoc] As..."]'


# ─── Tools beyond the board ─────────────────────────────────────────────────────────────────

def new_enclosure(pg):
    demo_pcb(pg)
    run(pg, "file.newEnclosure", 4000)   # the solids take a moment to build


def new_reqs(pg):
    demo_sch(pg)
    run(pg, "file.newRequirements", 1200)

    def add(title, check=None, typ=None):
        pg.locator('.reqdoc-bar button[aria-label="New requirement"]').click(); pg.wait_for_timeout(300)
        pg.keyboard.type(title); pg.keyboard.press("Tab"); pg.wait_for_timeout(300)
        if typ:
            pg.select_option('.reqdoc-side select[aria-label="Type"]', typ)
        if check:
            pg.select_option('.rq-check select[aria-label="Check"]', check); pg.wait_for_timeout(400)
    add("Two copper layers", "layers")
    add("Fits a 50 x 30 mm space", "boardSize", "mechanical")
    pg.fill('.rq-check input[aria-label="Width"]', "50"); pg.keyboard.press("Tab")
    pg.fill('.rq-check input[aria-label="Height"]', "30"); pg.keyboard.press("Tab")
    add("Runs from a 5 V supply", None, "electrical")
    pg.locator(".reqdoc-table tr.rq-row td.rq-id").first.click(); pg.wait_for_timeout(500)


@recipe("kd-adviser")
def _(pg):
    ev(pg, f"{K}.prefs.set({{ aiMode: 'local', aiModels: {{ 'local:model': 'qwen3:32b' }} }})")
    demo_sch(pg)
    run(pg, "ai.adviser", 1500)
    return 'section.dock-group:has(header[data-panel-id="adviser"])'


@recipe("kd-requirements")
def _(pg):
    new_reqs(pg)
    return None


@recipe("kd-requirements-panel")
def _(pg):
    new_reqs(pg)
    panel(pg, "requirements", 800)
    pg.locator(".reqp-row", has_text="REQ-002").first.click(); pg.wait_for_timeout(500)
    return 'section.dock-group:has(header[data-panel-id="requirements"])'


@recipe("kd-requirements-ai")
def _(pg):
    ev(pg, f"{K}.prefs.set({{ aiMode: 'local', aiModels: {{ 'local:model': 'qwen3:32b' }} }})")
    demo_sch(pg)
    run(pg, "file.newRequirements", 1200)
    pg.locator('button[aria-label="Split a specification into requirements with AI"]').click(); pg.wait_for_timeout(800)
    pg.fill('textarea[aria-label="Specification text"]', "3 Power\n3.1 The board shall run from a 5 V supply.\n3.2 It shall draw no more than 100 mA.\n4 Size\n4.1 The board shall fit within 50 x 30 mm.")
    pg.fill('input[aria-label="Specification name"]', "Demo spec rev A"); pg.wait_for_timeout(300)
    return ".dlg.rq-ai"


def new_diagram(pg):
    demo_sch(pg)
    run(pg, "file.newDiagram", 1200)
    pg.locator(".dg-konium .btn").first.click(); pg.wait_for_timeout(800)   # Add Project Sheets
    pg.locator(".dg-host").focus(); pg.keyboard.press("Control+Shift+H"); pg.wait_for_timeout(500)


@recipe("kd-diagrams")
def _(pg):
    new_diagram(pg)
    return None


@recipe("kd-diagram-format")
def _(pg):
    new_diagram(pg)
    pg.locator(".dg-svg g.dg-cell.linked").first.click(); pg.wait_for_timeout(500)
    return ".dg-side"


@recipe("kd-enclosure")
def _(pg):
    new_enclosure(pg)
    return None


@recipe("kd-enclosure-box")
def _(pg):
    new_enclosure(pg)
    pg.locator('.ex-right [aria-label="Fixing"] button', has_text="Screws").click(); pg.wait_for_timeout(1500)
    pg.locator('.ex-right section[aria-label="Box"] .ex-sec-head').click(); pg.wait_for_timeout(300)   # fold Box so Closing shows
    return ".ex-right"


@recipe("kd-enclosure-feature")
def _(pg):
    new_enclosure(pg)
    pg.locator(".ex-tool", has_text="Cut-out").click(); pg.wait_for_timeout(300)
    pg.locator(".encf-svg").click(); pg.wait_for_timeout(2000)   # centre of the Front face
    return None


@recipe("kd-enclosure-text")
def _(pg):
    new_enclosure(pg)
    pg.locator(".ex-tool", has_text="Text").click(); pg.wait_for_timeout(300)
    pg.locator(".encf-svg").click(); pg.wait_for_timeout(800)
    pg.fill('.ex-right input[aria-label="Text"]', "POWER"); pg.wait_for_timeout(1500)
    pg.locator(".ex-tool", has_text="Select").click(); pg.wait_for_timeout(300)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(1500)   # nothing picked: the cut word shows in 3D
    return ".ex-centre"


@recipe("kd-enclosure-plate")
def _(pg):
    new_enclosure(pg)
    pg.locator('button[aria-label="Print plate: the parts as they print"]').click(); pg.wait_for_timeout(1200)
    return ".enc-3d"


@recipe("kd-enclosure-picture")
def _(pg):
    new_enclosure(pg)
    pg.locator(".ex-export").click(); pg.wait_for_timeout(300)
    pg.locator(".menu-popup .menu-item", has_text="Picture (PNG)...").click(); pg.wait_for_timeout(2500)
    return ".dlg.encpic"


@recipe("kd-step-editor")
def _(pg):
    run(pg, "file.newStepModel", 1200)
    pg.locator(".sd-bar .btn", has_text="Box").first.click(); pg.wait_for_timeout(800)
    pg.locator(".sd-bar .btn", has_text="Cylinder").first.click(); pg.wait_for_timeout(1200)
    return None


@recipe("kd-si")
def _(pg):
    demo_pcb(pg)
    run(pg, "si.panel", 3000)
    pg.locator(".si-nets .pcbp-body .pcbp-row").first.dispatch_event("mousedown"); pg.wait_for_timeout(600)
    return 'section.dock-group:has(header[data-panel-id="signalIntegrity"])'


@recipe("pcb-power")
def _(pg):
    demo_pcb(pg)
    run(pg, "power.panel", 700)
    p = pg.locator(".powerpanel")
    p.get_by_label("Current of U1").fill("0.8"); p.get_by_label("Current of U1").press("Tab")
    p.get_by_label("Voltage", exact=True).fill("5"); p.get_by_label("Voltage", exact=True).press("Tab")
    pg.wait_for_timeout(200)
    p.get_by_role("button", name="Analyse").click()
    pg.wait_for_function("document.querySelector('.powerpanel .pw-results') !== null", timeout=60000)
    pg.wait_for_timeout(600)
    # The cursor on VIN's track between J1 and C1 (clear of the panel), for its read-out
    at = ev(pg, f"""(() => {{ const ed = {K}.state.active.value.editor, d = ed.doc, vin = d.nets.findIndex((n) => n.name === 'VIN');
      const t = d.prims.filter((p) => p.kind === 'track' && p.net === vin && p.layer === 1 && Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) > 3 * 393701).sort((p, q) => (p.a.x + p.b.x) - (q.a.x + q.b.x))[0];
      const r = ed.viewport.host.getBoundingClientRect(), s = ed.viewport.cam.toScreen({{ x: (t.a.x + t.b.x) / 2, y: (t.a.y + t.b.y) / 2 }}); return [r.left + s.x, r.top + s.y]; }})()""", 100)
    pg.mouse.move(at[0] - 6, at[1]); pg.mouse.move(at[0], at[1]); pg.wait_for_timeout(500)
    return "SCREEN_KEEP_MOUSE"


@recipe("pcb-thermal")
def _(pg):
    demo_pcb(pg)
    run(pg, "thermal.panel", 700)
    p = pg.locator(".thermalpanel")
    p.get_by_label("Power of U1").fill("0.5"); p.get_by_label("Power of U1").press("Tab")
    p.get_by_label("Junction to board of U1").fill("15"); p.get_by_label("Junction to board of U1").press("Tab")
    pg.wait_for_timeout(200)
    p.get_by_role("button", name="Analyse").click()
    pg.wait_for_function("document.querySelector('.thermalpanel .pw-results') !== null", timeout=60000)
    pg.wait_for_timeout(600)
    # The cursor between J1 and C1 (clear of the panel), for its read-out
    at = ev(pg, f"""(() => {{ const ed = {K}.state.active.value.editor, d = ed.doc, c = d.components.find((x) => x.designator === 'J1'), u = d.components.find((x) => x.designator === 'C1');
      const r = ed.viewport.host.getBoundingClientRect(), s = ed.viewport.cam.toScreen({{ x: (c.at.x + u.at.x) / 2, y: (c.at.y + u.at.y) / 2 - 2 * 393701 }}); return [r.left + s.x, r.top + s.y]; }})()""", 100)
    pg.mouse.move(at[0] - 6, at[1]); pg.mouse.move(at[0], at[1]); pg.wait_for_timeout(500)
    return "SCREEN_KEEP_MOUSE"


@recipe("pcb-emc")
def _(pg):
    demo_pcb(pg)
    run(pg, "emc.panel", 700)
    p = pg.locator(".emcpanel")
    p.get_by_role("button", name="Check").click()
    pg.wait_for_function("document.querySelector('.emcpanel .pw-results') !== null", timeout=60000)
    pg.wait_for_timeout(400)
    p.locator(".pw-issues button").first.click()
    pg.wait_for_timeout(900)
    return None


@recipe("pcb-pdn")
def _(pg):
    demo_pcb(pg)
    run(pg, "pdn.panel", 700)
    p = pg.locator(".pdnpanel")
    p.get_by_label("Value of C1").fill("10u"); p.get_by_label("Value of C1").press("Tab")
    p.get_by_label("Supply voltage").fill("5"); p.get_by_label("Supply voltage").press("Tab")
    pg.wait_for_timeout(200)
    p.get_by_role("button", name="Analyse").click()
    pg.wait_for_function("document.querySelector('.pdnpanel .pw-results') !== null", timeout=60000)
    pg.wait_for_timeout(400)
    p.locator(".pw-results").scroll_into_view_if_needed()
    ev(pg, "document.querySelector('.pdnpanel').scrollTop = 1e6", 300)
    return 'section.dock-group:has(header[data-panel-id="supplyImpedance"])'


@recipe("pcb-field")
def _(pg):
    demo_pcb(pg)
    run(pg, "field.panel", 700)
    p = pg.locator(".fieldpanel")
    p.get_by_role("button", name="Solve").click()
    pg.wait_for_function("document.querySelector('.fieldpanel .pw-results') !== null", timeout=60000)
    pg.wait_for_timeout(500)
    ev(pg, "document.querySelector('.fieldpanel').scrollTop = 1e6", 300)
    return 'section.dock-group:has(header[data-panel-id="fieldSolver"])'


@recipe("calculators")
def _(pg):
    demo(pg, "Demo.SchDoc")
    run(pg, "tools.calculators", 700)
    p = pg.locator(".calcpanel")
    p.locator("select[aria-label='Find']").select_option("r2")
    box = p.locator("input[aria-label='Output']"); box.fill("3.3"); box.press("Tab")
    pg.wait_for_timeout(300)
    return 'section.dock-group:has(header[data-panel-id="calculators"])'


@recipe("pcb-antenna")
def _(pg):
    run(pg, "antenna.example", 2500)
    run(pg, "view.fitBoard", 600)
    p = pg.locator(".antennapanel")
    p.get_by_role("button", name="Analyse").click()
    pg.wait_for_function("document.querySelector('.antennapanel .pw-results') !== null", timeout=280000)
    pg.wait_for_timeout(600)
    # The cursor on the arm, clear of the panel
    at = ev(pg, f"""(() => {{ const ed = {K}.state.active.value.editor, d = ed.doc;
      const t = d.prims.filter((q) => q.kind === 'track').sort((a, b) => Math.abs(b.b.x - b.a.x) - Math.abs(a.b.x - a.a.x))[0];
      const r = ed.viewport.host.getBoundingClientRect(), s = ed.viewport.cam.toScreen({{ x: t.a.x + (t.b.x - t.a.x) * 0.15, y: t.a.y }}); return [r.left + s.x, r.top + s.y]; }})()""", 100)
    pg.evaluate("window.konium.dock.showPanel('antennaAnalysis')"); pg.wait_for_timeout(300)
    pg.mouse.move(at[0] - 6, at[1]); pg.mouse.move(at[0], at[1]); pg.wait_for_timeout(500)
    return "SCREEN_KEEP_MOUSE"


@recipe("kd-simulation")
def _(pg):
    demo_sch(pg)
    run(pg, "sim.mixedSim", 1500)
    return ".dlg.analyses-setup"


@recipe("sch-live")
def _(pg):
    # Live Simulation on one of its examples: the 555 timer flashing an LED, held with the LED lit, R2 selected (its value in the panel)
    ev(pg, "window.konium.liveExample('timer')", 3500)
    pin = pg.locator("button[aria-label='Pin Live Simulation']")
    if pin.count():
        pin.first.click()
        pg.wait_for_timeout(600)
    ev(pg, "window.konium.state.active.value.editor.fitObjects()", 600)
    ev(pg, "(() => { const e = window.konium.state.active.value.editor; const r = e.doc.objects.find((o) => o.kind === 'component' && o.designator === 'R2'); e.select(['o' + r.index]); })()", 400)
    # Three cycles on the scope, then the next moment the LED is lit
    pg.wait_for_timeout(5000)
    # (held as the LED comes on: waited for dark first, so that the hold falls at the start of its lit time on any machine)
    pg.wait_for_function("window.konium.liveLights().every((l) => l.brightness < 0.1)", timeout=20000)
    pg.wait_for_function("window.konium.liveLights().some((l) => l.brightness > 0.6)", timeout=20000)
    run(pg, "live.hold", 500)
    ev(pg, "document.querySelector(\".livepanel section[aria-label='The part selected']\").scrollIntoView({block: 'end'})", 300)
    return None


@recipe("kd-vcs-prefs")
def _(pg):
    return prefs_page(pg, "dm-vcs")


@recipe("kd-compare")
def _(pg):
    demo_pcb(pg)
    ev(pg, f"{K}.prefs.set({{ historyAutosaves: true }})")
    ev(pg, f"(async () => {{ const e = {ED}; e.selection = new Set([...e.componentKeys(2)]); {K}.run('edit.nudgeRight'); await {K}.backup.autoSaveNow(); }})()", 1000)
    ev(pg, f"(() => {{ const e = {ED}; e.selection = new Set([...e.componentKeys(1)]); {K}.run('edit.nudgeUp10'); e.selection = new Set([...e.componentKeys(3)]); {K}.run('edit.delete'); e.selection = new Set(); e.invalidateOverlay(); }})()", 800)
    panel(pg, "storage", 800)
    pg.locator('section.storage table[aria-label="Local History"] tbody tr', has_text="Version").first.click(button="right"); pg.wait_for_timeout(400)
    pg.locator(".menu-popup .menu-item", has_text="Compare").first.click(); pg.wait_for_timeout(2500)
    return None


# ─── Wire links (pcb-wire-link*) ──────────────────────────────────────────────────────────────

WIRE_A, WIRE_BEND, WIRE_B = (19448819, 17322835), (21033464, 18000000), (22618110, 17322835)   # the demo's +3V3 on Top, U1's side and C2's side


def wire_link_board(pg):
    """The demo board with the +3V3 track between U1 and C2 taken out, and a wire link put in its place."""
    demo_pcb(pg)
    ev(pg, f"""(() => {{ const e = {ED}, [ax, ay] = {list(WIRE_A)}, [bx, by] = {list(WIRE_B)};
      const i = e.doc.prims.findIndex(p => p.kind === 'track' && p.layer === 1 && p.a.x === ax && p.a.y === ay && p.b.x === bx && p.b.y === by);
      e.selection = new Set([e.keyOf(i)]); {K}.run('edit.delete'); e.selection = new Set(); e.invalidateOverlay(); }})()""", 600)
    ev(pg, f"(() => {{ const e = {ED}; e.viewport.fitBox({{ minX: 18400000, minY: 16200000, maxX: 23700000, maxY: 19100000 }}); }})()", 400)
    run(pg, "place.wireLink", 400)
    for x, y in (WIRE_A, WIRE_BEND, WIRE_B):
        sx, sy = pg.evaluate(f"""([x, y]) => {{ const e = {ED}; const r = e.viewport.host.getBoundingClientRect(); const s = e.viewport.cam.toScreen({{x, y}}); return [r.left + s.x, r.top + s.y]; }}""", [x, y])
        pg.mouse.move(sx, sy); pg.wait_for_timeout(200)
        pg.mouse.click(sx, sy); pg.wait_for_timeout(400)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(2800)   # the toast gone


@recipe("pcb-wire-link")
def _(pg):
    wire_link_board(pg)
    return None


@recipe("pcb-wire-link-3d")
def _(pg):
    wire_link_board(pg)
    run(pg, "view.mode3d", 3500)
    return ".stage"


# ─── 26.191: pictures for what came in 26.185 to 26.190 ───────────────────────────────────

@recipe("pcb-netlist")
def _(pg):
    # Design › Netlist › Load a Netlist: a netlist of the demo's own with a resistor, an LED and a net more, set against the board
    demo_pcb(pg)
    net = "\r\n".join(["*PADS-PCB*", "*PART*", "C1 0805", "C2 0805", "D1 LED0805", "J1 HDR1X2", "R1 0805", "U1 SOT-223", "*NET*",
                       "*SIGNAL* +3V3", "C2.1 R1.1 U1.2 U1.4", "*SIGNAL* GND", "C1.2 C2.2 D1.K J1.2", "U1.1", "*SIGNAL* NetD1_A", "D1.A R1.2", "*SIGNAL* VIN", "C1.1 J1.1 U1.3", "*END*", ""])
    with pg.expect_file_chooser() as fc:
        pg.evaluate(f"{K}.run('pcb.loadNetlist')")
    fc.value.set_files(files=[{"name": "demo.asc", "mimeType": "text/plain", "buffer": net.encode()}])
    pg.wait_for_timeout(1200)
    pg.locator(".dlg-foot .btn", has_text="Validate Changes").click()
    pg.wait_for_timeout(600)
    return ".dlg"


@recipe("pcb-selection-filter")
def _(pg):
    # The Selection Filter in the PCB Inspector with nothing selected: tracks, arcs, pads, vias, regions and polygons on, the rest off
    demo_pcb(pg)
    run(pg, "view.panel.properties", 700)
    pin = pg.locator("button[aria-label='Pin PCB Inspector'], button[aria-label='Pin Inspector']")
    if pin.count():
        pin.first.click()
        pg.wait_for_timeout(500)
    sf = pg.locator(".selfilter")
    for k in ("Components", "3D Bodies", "Keepouts", "Fills", "Texts", "Rooms", "Other"):
        sf.get_by_role("button", name=k, exact=True).click()
    pg.wait_for_timeout(300)
    return ".selfilter"


@recipe("sch-live-ratings")
def _(pg):
    # Live Simulation's LED example with its resistor made too small: the LED over its rating, and Solve for a value set up to find the resistor
    ev(pg, "window.konium.liveExample('led')", 3500)
    pin = pg.locator("button[aria-label='Pin Live Simulation']")
    if pin.count():
        pin.first.click()
        pg.wait_for_timeout(600)
    ev(pg, f"{ED}.fitObjects()", 600)
    pick = f"(() => {{ const e = {ED}; const c = e.doc.objects.find((o) => o.kind === 'component' && o.designator === 'R1'); e.select(['o' + c.index]); }})()"
    ev(pg, pick, 500)
    lp = pg.locator(".livepanel")
    box = lp.locator("input[aria-label='Resistance']")
    box.fill("47")
    box.press("Enter")
    pg.wait_for_timeout(600)
    at = ev(pg, f"""(() => {{ const ed = {ED}, c = ed.doc.objects.find((o) => o.kind === 'component' && o.designator === 'SW1');
      const r = ed.viewport.host.getBoundingClientRect(), s = ed.viewport.cam.toScreen({{ x: c.at.x, y: c.at.y }}); return [r.left + s.x, r.top + s.y]; }})()""", 100)
    pg.mouse.click(at[0], at[1])
    pg.wait_for_timeout(600)
    ev(pg, pick, 500)
    pg.wait_for_function("window.konium.liveStress().some((s) => s.over)", timeout=20000)
    pg.wait_for_timeout(1500)
    sv = lp.locator(".live-solve")
    sv.locator("select[aria-label='What is to read it']").select_option(label="SW1, current")
    sv.get_by_label("What it is to read").fill("20m")
    ev(pg, "document.querySelector(\".livepanel section[aria-label='The part selected']\").scrollIntoView({block: 'start'})", 400)
    return None


@recipe("lib-ipc-3d")
def _(pg):
    # The IPC Compliant Footprint Wizard's SOIC as it stands in 3D: the moulded body off the board, its gull-wing leads, the dot at pin 1
    ev(pg, f"""(() => {{ const f = {K}.demoFiles().find((x) => x.name === 'Demo.PcbLib'); {K}.openDocument({{ name: 'Demo.PcbLib', bytes: f.bytes }}); }})()""", 1200)
    run(pg, "ad:IPCFootprintWizard:Run", 500)
    pg.locator(".dlg select[aria-label='Component Type']").select_option("SOIC")
    pg.wait_for_timeout(200)
    pg.locator(".dlg-foot .btn", has_text="Finish").click()
    pg.wait_for_timeout(700)
    run(pg, "view.mode3d", 2500)
    pg.mouse.move(640, 400)
    pg.keyboard.press("8")
    pg.wait_for_timeout(1500)
    pg.keyboard.down("Control")
    pg.mouse.wheel(0, -360)
    pg.keyboard.up("Control")
    pg.wait_for_timeout(1200)
    return None
