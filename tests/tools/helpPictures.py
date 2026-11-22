"""
The User Guide's pictures (src/help/pictures/<id>.webp), made from the app itself: the built-in
demo project and documents made new, never anything else. Run against the built app served at
http://localhost:4173/app/ (vite preview):

    python3 tests/tools/helpPictures.py            # every picture
    python3 tests/tools/helpPictures.py gs-window  # just these

Each recipe sets the app up and returns what to photograph: None for the whole window, or a CSS
selector (cropped to that element, a margin round it). Pictures are WebP at quality 70, the window
1280 x 800 at 1:1, so they stay small enough to live inside the app.
"""
import io
import os
import sys
from playwright.sync_api import sync_playwright
from PIL import Image

URL = "http://localhost:4173/app/?debug&features=all"
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "src", "help", "pictures")
W, H = 1280, 800
RECIPES = {}
# Panels of features the release has not switched on yet (src/core/release.ts): kept out of the pictures' edge tabs
PLANNED_PANELS = ["parts"]


def recipe(name):
    def add(fn):
        RECIPES[name] = fn
        return fn
    return add


# ─── Helpers the recipes share ──────────────────────────────────────────────────────────────

def run(pg, cmd, wait=500):
    pg.evaluate(f"window.konium.run('{cmd}')")
    pg.wait_for_timeout(wait)


def panel(pg, pid, wait=500):
    pg.evaluate(f"window.konium.dock.showPanel('{pid}')")
    pg.wait_for_timeout(wait)


def hide_panel(pg, pid):
    pg.evaluate(f"window.konium.dock.hidePanel('{pid}')")
    pg.wait_for_timeout(300)


def demo(pg, doc=None):
    """The demo project open; `doc` (e.g. 'Demo.PcbDoc') in front."""
    run(pg, "file.openDemo", 2500)
    if doc:
        tab(pg, doc)


def tab(pg, name, wait=800):
    pg.locator(".doctab", has_text=name).first.dispatch_event("mousedown")
    pg.wait_for_timeout(wait)


def menu(pg, *path, wait=350):
    """Open a menu path in the menu bar (leaves the last level open)."""
    pg.locator(".menubar-item", has_text=path[0]).first.click()
    pg.wait_for_timeout(wait)
    for p in path[1:]:
        pg.locator(".menu-popup .menu-item", has_text=p).last.hover()
        pg.wait_for_timeout(wait)


def deselect(pg):
    pg.evaluate("(() => { const e = window.konium.state.active.value?.editor; if (e && e.selection) { e.selection = new Set(); e.invalidate?.(); e.invalidateOverlay?.(); } })()")
    pg.wait_for_timeout(200)


def rest_mouse(pg):
    pg.mouse.move(W - 4, H - 4)
    pg.wait_for_timeout(150)


# ─── Making them ────────────────────────────────────────────────────────────────────────────

def fresh(browser):
    ctx = browser.new_context(viewport={"width": W, "height": H}, locale="en-GB", device_scale_factor=1)
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: print("  page error:", e))
    pg.route("https://cloud.umami.is/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    pg.goto(URL)
    pg.wait_for_function("window.konium !== undefined")
    pg.wait_for_timeout(700)
    pg.evaluate("window.konium.prefs.set({ openHomePage: false })")
    no_planned(pg)
    return ctx, pg


def no_planned(pg):
    """The pictures are taken with every feature on: a panel that is still planned in the release has no tab in them."""
    pg.evaluate("for (const p of %s) window.konium.dock.hidePanel(p)" % PLANNED_PANELS)


def default_layout(pg, wait=300):
    """View › Desktop Layouts › Default, as the release shows it."""
    pg.evaluate("window.konium.dock.restoreLayout('default')")
    no_planned(pg)
    pg.wait_for_timeout(wait)


def shoot(pg, what, name):
    if what is None:
        png = pg.screenshot()
    else:
        el = pg.locator(what).first
        box = el.bounding_box()
        m = 6
        clip = {"x": max(0, box["x"] - m), "y": max(0, box["y"] - m)}
        clip["width"] = min(W - clip["x"], box["width"] + 2 * m)
        clip["height"] = min(H - clip["y"], box["height"] + 2 * m)
        png = pg.screenshot(clip=clip)
    im = Image.open(io.BytesIO(png)).convert("RGB")
    path = os.path.join(OUT, f"{name}.webp")
    im.save(path, "WEBP", quality=70, method=6)
    return im.size, os.path.getsize(path)


def main(names):
    import helpPictures as hp  # the recipes register here (this file run as __main__ is another module)
    import recipes_guide  # noqa: F401  (the recipes, beside this file)
    todo = names or list(hp.RECIPES)
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        for name in todo:
            ctx, pg = fresh(browser)
            try:
                what = hp.RECIPES[name](pg)
                if what is None:
                    rest_mouse(pg)
                elif what == "SCREEN_KEEP_MOUSE":  # the whole window, the mouse left where the recipe put it
                    what = None
                size, n = shoot(pg, what, name)
                print(f"{name}: {size[0]}x{size[1]}, {n // 1024} KB")
            except Exception as e:  # one picture failing doesn't stop the others
                print(f"{name}: FAILED {e}")
            ctx.close()
        browser.close()


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(__file__))
    main(sys.argv[1:])
