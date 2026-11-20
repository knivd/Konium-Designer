"""A look over the whole UI for fields out of line: every picture recipe's dialog or panel and every Preferences page.
For each, the labelled boxes and lists stacked in one column of a container are measured: where each starts and how long it
is; and every control is checked against its frame. A column whose boxes start at different places or are of different
lengths, and a control that stands out of its frame, are listed, with a screenshot to look at. To run before a public
release, with the preview serving the build: python3 -I tests/tools/uiAudit.py <folder for the screenshots> [names...].
With --commands it runs every command instead, with each kind of document in front, and looks at each dialog that opens
(tab by tab) and at every panel: python3 -I tests/tools/uiAudit.py --commands <folder> [pcb,sch,schlib,pcblib,none].
With --views it makes each kind of document new and looks at the fields its view has beside it; with --objects it opens the
properties of one object of each kind in the demo's documents."""
import json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import helpPictures as hp
import recipes_guide as rg  # noqa: F401
from playwright.sync_api import sync_playwright

MODE = "commands" if "--commands" in sys.argv else "views" if "--views" in sys.argv else "objects" if "--objects" in sys.argv else "pictures"
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
OUT = ARGS[0]
ONLY = ARGS[1].split(',') if len(ARGS) > 1 else None
PREFS = "sys-general sys-view sys-transparency sys-nav sys-projects sys-files sys-wheel sys-network sys-keys sys-ai dm-libs dm-search dm-templates dm-backup dm-vcs dm-history sch-general sch-edit sch-wheel sch-compiler sch-autofocus sch-libzoom sch-grids sch-breakwire sch-units sch-primitives sch-orcad sch-devsheets sch-paramsets sch-portrefs pcb-general pcb-display pcb-insight pcb-insightmodes pcb-insightcolours pcb-drcdisplay pcb-routing pcb-ttf pcb-wheel pcb-defaults pcb-reports pcb-layers pcb-models text-general text-display text-colours".split()

AUDIT = r"""
(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden' && el.offsetParent !== null; };
  const roots = [...document.querySelectorAll('.dlg, section.dock-group .panel-body, .dock-float .panel-body, .dd-props, .dg-sidebar, .reqdoc-side, .sd-side, .oj-side, .bom-side, .ex-left')].filter(vis);
  const out = [];
  for (const root of roots) {
    const title = (root.querySelector('.dlg-title, header h2, h2, h3')?.textContent || root.closest('section')?.querySelector('header')?.textContent || '').trim().slice(0, 50);
    const all = [...root.querySelectorAll('input:not([type=hidden]), select, textarea, button')].filter(vis);
    // A control that stands out of its frame (its fieldset, or the dialog's or panel's body)
    for (const c of all) {
      const f = c.closest('fieldset') || c.closest('.dlg-body, .panel-body');
      if (!f || !vis(f) || c.closest('[style*="overflow"], .pcbp-body, .tree, table')) continue;
      const r = c.getBoundingClientRect(), fr = f.getBoundingClientRect();
      if (getComputedStyle(f).overflowX !== 'visible' && f.scrollWidth <= f.clientWidth + 1) continue;
      if (r.right > fr.right + 1 || r.left < fr.left - 1) out.push({ title, head: (f.querySelector('legend')?.textContent || f.className).toString().slice(0, 40), kind: 'out of its frame', what: (c.getAttribute('aria-label') || c.textContent || c.tagName).trim().slice(0, 30), by: Math.round(Math.max(r.right - fr.right, fr.left - r.left)) });
    }
    // A tick or a round button squeezed by its row, and a box's name broken over two lines
    for (const c of root.querySelectorAll('input[type=checkbox], input[type=radio]')) {
      if (!vis(c)) continue;
      const r = c.getBoundingClientRect();
      if (r.width < 11 || r.height < 11) out.push({ title, head: (c.closest('fieldset')?.querySelector('legend')?.textContent || '').slice(0, 40), kind: 'squeezed tick', what: (c.closest('label')?.textContent || c.getAttribute('aria-label') || '').trim().slice(0, 30), by: Math.round(Math.min(r.width, r.height)) });
    }
    for (const c of all) {
      if (c.tagName === 'BUTTON' || ['checkbox', 'radio'].includes(c.type) || c.closest('table, .toolbar, .menubar')) continue;
      const n = c.previousElementSibling;
      if (!n || !vis(n) || n.children.length || !/^(SPAN|LABEL|DIV)$/.test(n.tagName) || !n.textContent.trim()) continue;
      const lh = parseFloat(getComputedStyle(n).lineHeight) || parseFloat(getComputedStyle(n).fontSize) * 1.3;
      if (n.getBoundingClientRect().height > lh * 1.8 && n.textContent.trim().length < 40) out.push({ title, head: '', kind: 'name on two lines', what: n.textContent.trim().slice(0, 30), by: Math.round(n.getBoundingClientRect().height) });
    }
    const ctrls = all.filter((c) => (c.tagName === 'SELECT' || (c.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit'].includes(c.type)))
      && !c.closest('table, [role=grid], [role=row], .pcbp-table, .toolbar, .pw-run, .menubar, thead, tbody'));
    // Boxes that share a container: the nearest ancestor holding three boxes or more
    const groups = new Map();
    for (const c of ctrls) {
      let g = c.parentElement;
      while (g && g !== root && [...g.querySelectorAll('input, select')].filter((x) => ctrls.includes(x)).length < 3) g = g.parentElement;
      if (!g) continue;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    for (const [g, cs] of groups) {
      const gr = g.getBoundingClientRect();
      // One box to a row: the first in each row, with its name before it; rows are of one column when their names start together
      const rows = new Map();
      for (const c of cs) { const r = c.getBoundingClientRect(), key = Math.round(r.top / 6); if (!rows.has(key) || rows.get(key).getBoundingClientRect().left > r.left) rows.set(key, c); }
      const cols = new Map();
      for (const c of rows.values()) {
        const row = c.closest('label') || c.parentElement, rl = Math.round(row.getBoundingClientRect().left / 4), cl = c.getBoundingClientRect().left;
        if (cl - row.getBoundingClientRect().left < 24) continue;
        if (!cols.has(rl)) cols.set(rl, []);
        cols.get(rl).push(c);
      }
      for (const firsts of cols.values()) {
        if (firsts.length < 3) continue;
        const lefts = firsts.map((c) => Math.round(c.getBoundingClientRect().left - gr.left)), widths = firsts.map((c) => Math.round(c.getBoundingClientRect().width));
        const nL = new Set(lefts.map((v) => Math.round(v / 3))).size, nW = new Set(widths.map((v) => Math.round(v / 3))).size;
        if (nL > 1 || nW > 1) out.push({ title, head: (g.querySelector('legend, h4, h3')?.textContent || g.getAttribute('aria-label') || g.className || g.tagName).toString().trim().slice(0, 40), kind: nL > 1 ? 'starts' : 'lengths', rows: firsts.length, starts: [...new Set(lefts)].sort((a, b) => a - b).slice(0, 6), lengths: [...new Set(widths)].sort((a, b) => a - b).slice(0, 6) });
      }
    }
  }
  return out;
})()
"""

SKIP = re.compile(r"print|exit|reload|closeAll|closeProject|file\.close|window\.close|autoroute|route\.all|\.auto$|quit|about\.donate|install", re.I)


def line(f):
    return (f["title"][:24], f["head"][:24], f["kind"], f.get("what") or f.get("starts"), f.get("by") or f.get("lengths"))


def pictures(b, report):
    """Each picture recipe's state and each Preferences page."""
    states = [(n, f) for n, f in hp.RECIPES.items() if n not in ("pcb-antenna", "pcb-thermal", "pcb-power", "kd-si", "kd-simulation", "gs-get-konium")]
    states += [("prefs:" + pid, (lambda pid: (lambda pg: rg.prefs_page(pg, pid)))(pid)) for pid in PREFS]
    for name, fn in states:
        if ONLY and not any(name.startswith(o) for o in ONLY): continue
        try:
            ctx, pg = hp.fresh(b)
            pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
            fn(pg)
            pg.wait_for_timeout(300)
            found = pg.evaluate(AUDIT)
            if found:
                report[name] = found
                pg.screenshot(path=os.path.join(OUT, name.replace(":", "_") + ".png"))
            print(name, len(found), [line(f) for f in found][:5], flush=True)
            ctx.close()
        except Exception as e:  # noqa: BLE001
            print(name, "FAILED", str(e)[:120], flush=True)


def commands(b, report):
    """Every command run with each kind of document in front: the dialog it opens (each of its tabs), and every panel."""
    seen = set()
    DLG = "[...document.querySelectorAll('.dlg')].filter((d) => d.getBoundingClientRect().width > 4).map((d) => (d.querySelector('.dlg-title')?.textContent || '').trim())"

    def look(pg, name):
        found = pg.evaluate(AUDIT)
        if found:
            report[name] = found
            pg.screenshot(path=os.path.join(OUT, re.sub(r"[^A-Za-z0-9_.-]+", "_", name)[:80] + ".png"))
            print(name, len(found), [line(f) for f in found][:5], flush=True)

    def start(doc):
        ctx, pg = hp.fresh(b)
        pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
        if doc:
            rg.demo_sch(pg, doc)
        return ctx, pg

    def front(pg, doc):
        pg.evaluate("(n) => { const s = window.konium.state, d = s.docs.value.find((x) => x.name === n); if (d && s.activeId.value !== d.id) s.activeId.value = d.id; }", doc)

    for scope, doc in (("pcb", "Demo.PcbDoc"), ("sch", "Demo.SchDoc"), ("schlib", "Demo.SchLib"), ("pcblib", "Demo.PcbLib"), ("none", None)):
        if ONLY and scope not in ONLY: continue
        ctx, pg = start(doc)
        ids = [i for i in pg.evaluate("window.konium.commandIds()") if not SKIP.search(i)]
        print(scope, len(ids), "commands", flush=True)
        ran = 0
        for cid in ids:
            try:
                if not pg.evaluate(f"window.konium.run({json.dumps(cid)})"): continue
                ran += 1
                pg.wait_for_timeout(280)
                titles = pg.evaluate(DLG)
                if titles and titles[-1] not in seen:
                    seen.add(titles[-1])
                    look(pg, f"{scope} {cid} {titles[-1]}")
                    tabs = pg.locator(".dlg >> nth=-1").locator(".dlg-tabs button")
                    for t in range(1, min(tabs.count(), 12)):
                        tabs.nth(t).click(); pg.wait_for_timeout(200)
                        look(pg, f"{scope} {cid} {titles[-1]} tab {t + 1}")
                for _ in range(6):
                    pg.keyboard.press("Escape"); pg.wait_for_timeout(90)
                    if not pg.evaluate(DLG): break
                if pg.evaluate(DLG) or ran % 60 == 0:  # a dialog that will not go, or the document well used: a new start
                    ctx.close(); ctx, pg = start(doc)
                elif doc:
                    front(pg, doc)
            except Exception as e:  # noqa: BLE001
                print(scope, cid, "FAILED", str(e)[:100], flush=True)
                try: ctx.close()
                except Exception: pass  # noqa: BLE001
                ctx, pg = start(doc)
        # The panels this kind of document has
        for pid in re.findall(r"\{ id: '(\w+)'", open(os.path.join(HERE, '..', '..', 'src', 'app', 'dock', 'panels.ts')).read()):
            if pid in seen: continue
            try:
                hp.panel(pg, pid, 500)
                if pg.locator(f"[data-panel-id='{pid}'][aria-selected='true']").count():
                    seen.add(pid); look(pg, f"{scope} panel {pid}")
                hp.hide_panel(pg, pid)
            except Exception as e:  # noqa: BLE001
                print(scope, "panel", pid, "FAILED", str(e)[:100], flush=True)
        ctx.close()
    print("dialogs and panels looked at:", len(seen), flush=True)


def views(b, report):
    """Each kind of document made new, for the fields its own view has beside it (a drawing's, a diagram's, an output job's)."""
    ctx, pg = hp.fresh(b)
    ids = [i for i in pg.evaluate("window.konium.commandIds()") if re.match(r"file\.new|ad:WorkspaceManager:New", i)]
    ctx.close()
    print(len(ids), "kinds of new document", flush=True)
    for cid in ids:
        try:
            ctx, pg = hp.fresh(b)
            pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
            hp.demo(pg)
            if pg.evaluate(f"window.konium.run({json.dumps(cid)})"):
                pg.wait_for_timeout(1500)
                found = pg.evaluate(AUDIT)
                if found:
                    report[cid] = found
                    pg.screenshot(path=os.path.join(OUT, cid + ".png"))
                print(cid, len(found), [line(f) for f in found][:5], flush=True)
            ctx.close()
        except Exception as e:  # noqa: BLE001
            print(cid, "FAILED", str(e)[:100], flush=True)


def objects(b, report):
    """The properties of one object of each kind in the demo's documents (what a double-click opens), tab by tab."""
    KEYS = """(() => { const e = window.konium.state.active.value.editor, d = e.doc, out = {};
      if (d.prims) {
        d.prims.forEach((p, i) => { const k = p.kind + ('component' in p && p.component !== 0xffff ? ' in a component' : '') + (p.isDesignator ? ' designator' : ''); if (!(k in out)) out[k] = e.keyOf(i); });
        if (d.polygons?.length) out.polygon = 'poly:0';
        if (d.dimensions?.length) out.dimension = 'dim:0';
      } else d.objects.forEach((o) => { if (!(o.kind in out)) out[o.kind] = 'o' + o.index; });
      return out; })()"""
    seen = set()
    for doc in ("Demo.PcbDoc", "Demo.SchDoc", "Symbols.SchDoc", "Child.SchDoc", "Demo.SchLib", "Demo.PcbLib"):
        ctx, pg = hp.fresh(b)
        pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
        rg.demo_sch(pg, doc)
        keys = pg.evaluate(KEYS)
        print(doc, len(keys), "kinds of object", flush=True)
        for kind, key in keys.items():
            try:
                pg.evaluate(f"window.konium.editObject(window.konium.state.active.value.editor, {json.dumps(key)})")
                pg.wait_for_timeout(450)
                title = pg.evaluate("(document.querySelector('.dlg .dlg-title')?.textContent || '').trim()")
                if title and (title, kind) not in seen:
                    seen.add((title, kind))
                    tabs = pg.locator(".dlg >> nth=-1").locator(".dlg-tabs button")
                    for t in range(max(1, min(tabs.count(), 12))):
                        if t: tabs.nth(t).click(); pg.wait_for_timeout(200)
                        found = pg.evaluate(AUDIT)
                        name = f"{doc} {kind}" + (f" tab {t + 1}" if t else "")
                        if found:
                            report[name] = found
                            pg.screenshot(path=os.path.join(OUT, re.sub(r"[^A-Za-z0-9_.-]+", "_", name) + ".png"))
                        print(name, "|", title[:40], len(found), [line(f) for f in found][:5], flush=True)
                for _ in range(4):
                    pg.keyboard.press("Escape"); pg.wait_for_timeout(90)
            except Exception as e:  # noqa: BLE001
                print(doc, kind, "FAILED", str(e)[:100], flush=True)
        ctx.close()


with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    report = {}
    {"commands": commands, "views": views, "objects": objects, "pictures": pictures}[MODE](b, report)
    json.dump(report, open(os.path.join(OUT, "report.json"), "w"), indent=1)
    b.close()
