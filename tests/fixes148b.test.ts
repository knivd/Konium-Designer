import { afterEach, describe, expect, it } from 'vitest';
import { settings } from '../src/core/settings';
import { commands, scopeIncludes, type Command, type Scope } from '../src/core/commands';
import type { AccelNode } from '../src/core/keymap';
import { binToBytes } from '../src/formats/text';
import { readPrjPcb } from '../src/formats/altium/prjpcb';
import { readPcbDoc, type TrackFields } from '../src/formats/altium/pcbdoc';
import { newOutJob, newOutput, outJobKey, outJobOutputs, readOutJob, setOutJobOutputs } from '../src/formats/altium/outjob';
import { demoFiles, demoPcbDoc } from '../src/formats/synthetic/demo';
import { addTracks, removePrims } from '../src/model/pcbEdit';
import { antennasLeft } from '../src/model/routeLoops';
import { L } from '../src/model/layers';
import { mil } from '../src/core/units';
import type { PcbTrack } from '../src/model/pcb';
import { SHORTCUTS } from '../src/app/menus/ad17.gen';
// The app's command modules load in their own order first (they import one another)
import { DEFAULT_SHORTCUTS, MENUS, router } from '../src/app/commands';
import { activeId, activeScope, currentProjectId, docs, projects, type OpenDoc, type Project } from '../src/app/state';
import { openBatch } from '../src/app/actions';
import { PAGES } from '../src/app/settingsSchema';
import { chooseJobVariant, jobVariant, outputVariantName } from '../src/app/outjobRun';
import { deliverOutputs, outputFolder } from '../src/app/dialogs/Outputs';
import type { LoadedDoc } from '../src/formats/registry';

const fs = (globalThis as unknown as { process: { getBuiltinModule(m: string): unknown } }).process.getBuiltinModule('node:fs') as { readFileSync(p: string, enc: string): string };
const src = (p: string) => fs.readFileSync(p, 'utf8');

const saved = structuredClone({ ...settings });
afterEach(() => {
  Object.assign(settings, structuredClone(saved));
  docs.value = []; projects.value = []; activeId.value = null; currentProjectId.value = null;
});

const SCOPES: Scope[] = ['global', 'sch', 'pcb', 'schlib', 'pcblib', 'inspect', 'simview', 'simtext', 'cam'];
const field = (key: string) => PAGES.flatMap((p) => p.sections.flatMap((s) => s.fields)).find((f) => f.key === key)!;
/** A document without an editor of its own, active. */
function openPlain(kind: string, name: string, doc?: LoadedDoc): void {
  docs.value = [{ id: 'x1', name, doc: doc ?? ({ kind, name } as unknown as LoadedDoc), editor: null, bytes: new Uint8Array() } as OpenDoc];
  activeId.value = 'x1';
}
/** Run keys through the dispatch with every command live and recorded instead of run: the command a key reaches. */
function reaches(keys: [combo: string, scope: Scope][]): (string | null)[] {
  const kept = new Map<Command, Pick<Command, 'run' | 'enabled'>>();
  let ran: string | null = null;
  for (const c of commands.all()) { kept.set(c, { run: c.run, enabled: c.enabled }); c.run = () => { ran = c.id; }; c.enabled = () => true; }
  try {
    return keys.map(([combo, scope]) => { ran = null; router.handle(combo, scope); router.cancelChain(); return ran; });
  } finally {
    for (const [c, k] of kept) { c.run = k.run; c.enabled = k.enabled; }
  }
}

describe('1. Ctrl+S and File › Save for the documents without an editor (Output Job, BOM document, Draftsman)', () => {
  it('they run under the inspect scope, and Ctrl+S saves there as everywhere else', () => {
    expect(DEFAULT_SHORTCUTS.some((s) => s.combo === 'Ctrl+S' && s.command === 'file.save' && (!s.scopes || scopeIncludes(s.scopes, 'inspect')))).toBe(true);
    for (const [kind, name] of [['OutJob', 'Job.OutJob'], ['BomDoc', 'Parts.BomDoc'], ['Draftsman', 'Draw.PCBDwf']]) {
      openPlain(kind, name);
      expect(activeScope.value).toBe('inspect');
      expect(commands.isLive('file.save', 'inspect')).toBe(true);
      expect(reaches([['Ctrl+S', 'inspect']])).toEqual(['file.save']);
    }
  });
  it('their File menu has Save, Save As and Save Copy As (before Save Project); the menu with no document open has none', () => {
    const file = (scope: Scope) => MENUS.find((m) => m.inMenuBar && m.label === 'File' && m.scopes.includes(scope))!;
    const kids = file('inspect').children;
    const at = (cmd: string) => kids.findIndex((n) => n.command === cmd);
    expect(['file.save', 'file.saveAs', 'file.saveCopyAs'].map((c) => kids[at(c)]?.key)).toEqual(['S', 'A', 'Y']);
    expect(at('file.save')).toBeLessThan(at('wm.saveProject'));
    expect(kids.filter((n) => ['S', 'A', 'Y'].includes(n.key)).length).toBe(3);
    expect(file('global').children.some((n) => n.command === 'file.save')).toBe(false);
    // An Output Job's File › Save writes it (its own changed flag is what Save clears)
    expect(src('src/app/actions.ts')).toMatch(/if \(od\.doc\.kind === 'OutJob'\) \{ od\.doc\.dirty = false/);
  });
});

describe('2. One key, one command in each scope', () => {
  it('no two commands share a default key in the same scope (none allowed)', () => {
    const clashes: string[] = [];
    for (const sc of SCOPES) {
      const by = new Map<string, Set<string>>();
      for (const s of DEFAULT_SHORTCUTS) {
        if ((s.scopes && !scopeIncludes(s.scopes, sc)) || s.except?.includes(sc)) continue;
        const c = commands.get(s.command);
        if (c && !scopeIncludes(c.scopes, sc)) continue;
        by.set(s.combo, new Set([...(by.get(s.combo) ?? []), s.command]));
      }
      for (const [k, v] of by) if (v.size > 1) clashes.push(`${sc} ${k}: ${[...v].join(', ')}`);
    }
    expect(clashes).toEqual([]);
  });
  it('each key reaches the command that keeps it', () => {
    const table: [string, Scope, string][] = [
      ['Ctrl+N', 'sch', 'file.new'], ['Ctrl+N', 'inspect', 'file.new'],
      ['Ctrl+Shift+V', 'sch', 'ad:Sch:PasteSpecial'], ['Ctrl+Shift+V', 'schlib', 'align.distributeV'], ['Ctrl+Shift+V', 'pcb', 'align.distributeV'],
      ['Ctrl+Shift+G', 'pcb', 'ad:PCB:PopupSnapGridOther'], ['Ctrl+Shift+G', 'pcblib', 'ad:PCB:PopupSnapGridOther'], ['Ctrl+Shift+G', 'sch', 'view.visibleGrid'],
      ['Ctrl+End', 'pcb', 'jump.currentOrigin'], ['Ctrl+Home', 'pcb', 'jump.origin'],
      ['Ctrl+PageDown', 'sch', 'view.fitObjects'], ['Ctrl+Tab', 'pcb', 'window.next'], ['Ctrl+Tab', 'inspect', 'window.next'],
      ['Alt+Shift+I', 'pcb', 'ad:PCB:AlignComponentsTopSideBySide'], ['Alt+ArrowLeft', 'pcblib', 'plib.prev'], ['F12', 'pcblib', 'ad:PCB:PCBExpressionFilter'],
      ['Ctrl+C', 'sch', 'edit.copy'], ['Ctrl+C', 'cam', 'ad:CAMTASTIC:EditCopy'], ['Ctrl+C', 'simview', 'simview.copyText'],
      ['Escape', 'sch', 'edit.deselectAll'], ['Escape', 'cam', 'ad:CAMTASTIC:EscapeBreak'], ['Escape', 'simview', 'ad:SimView:ClearFilter'],
    ];
    expect(reaches(table.map(([k, sc]) => [k, sc]))).toEqual(table.map(([, , c]) => c));
    // Ctrl+C on its own no longer copies a message: the Messages panel does, while it has the focus
    expect(DEFAULT_SHORTCUTS.some((s) => s.command === 'msg.copy')).toBe(false);
    expect(src('src/app/panels/Panels.tsx')).toMatch(/class="messages-body"[^>]*tabIndex=\{-1\} onKeyDown=[\s\S]{0,200}'c'[\s\S]{0,80}commands\.run\('msg\.copy'/);
  });
  it('the generated defaults and their generator are patched the same way', () => {
    const emit = src('tests/tools/rcs/emit.py');
    const drops = [...emit.matchAll(/\('([^']+)', '([^']+)'\): (None|\{[^}]*\})/g)].map((m) => ({ combo: m[1]!, id: m[2]!, scopes: m[3] === 'None' ? null : [...m[3]!.matchAll(/'(\w+)'/g)].map((x) => x[1]!) }));
    expect(drops.length).toBe(14);
    for (const d of drops) {
      const row = SHORTCUTS.find(([c, i]) => c === d.combo && i === d.id);
      if (d.scopes === null) expect(row, `${d.combo} ${d.id}`).toBeUndefined();
      else expect(row?.[2].filter((s) => d.scopes!.includes(s)), `${d.combo} ${d.id}`).toEqual([]);
    }
    expect(emit).toMatch(/shortcuts\.setdefault\(\('Ctrl\+S', 'file\.save'\), set\(\)\)\.add\('inspect'\)/);
    expect(SHORTCUTS.find(([c, i]) => c === 'Ctrl+S' && i === 'file.save')?.[2]).toContain('inspect');
  });
});

describe('3. Help menu accelerators', () => {
  it('every letter once in each editor\'s Help menu; User Guide on U, Get Konium Designer on G', () => {
    for (const h of MENUS.filter((m) => m.inMenuBar && m.label === 'Help')) {
      const keys = h.children.map((n: AccelNode) => n.key).filter(Boolean);
      expect(new Set(keys).size, h.scopes.join()).toBe(keys.length);
      expect(h.children.find((n) => n.command === 'help.guide')?.key).toBe('U');
      expect(h.children.find((n) => n.command === 'help.getKonium')?.key).toBe('G');
    }
  });
});

describe('File menu accelerators (26.148)', () => {
  it('every letter once in each editor\'s File menu; Export Wizard on W, Exit on X', () => {
    for (const h of MENUS.filter((m) => m.inMenuBar && m.label === 'File')) {
      const keys = h.children.map((n: AccelNode) => n.key).filter(Boolean);
      expect(new Set(keys).size, h.scopes.join()).toBe(keys.length);
      const ew = h.children.find((n) => n.command === 'file.exportWizard');
      if (ew) expect(ew.key).toBe('W');
    }
  });
});

describe('4. Preference help texts say what the code does', () => {
  it('Autosave desktop: off only stops saving; the layout saved last still loads', () => {
    const help = field('autosaveDesktop').help!;
    expect(help).toMatch(/saved last/);
    expect(help).not.toMatch(/starts with the default layout\.$/);
    expect(src('src/app/dock/store.ts')).toMatch(/if \(settings\.autosaveDesktop\) writeLocal\(KEY/);
  });
  it('Auto-hide the documents bar counts the Home page and help tabs, as the bar does', () => {
    expect(field('autoHideTabs').help).toMatch(/Home page[\s\S]*help/);
    // (the main window's bar: a document window has no Home or help tab)
    expect(src('src/app/Chrome.tsx')).toMatch(/shown\.length \+ \(main && homeOpen\.value \? 1 : 0\) \+ \(main && helpOpen\.value \? 1 : 0\) <= 1/);
  });
  it('Default Units: Q toggles units in the PCB editors (where it is bound)', () => {
    expect(field('defaultUnits').help).toMatch(/Q toggles units in the PCB editors/);
    const q = DEFAULT_SHORTCUTS.filter((s) => s.combo === 'Q' && s.command === 'view.units');
    expect(q.flatMap((s) => s.scopes ?? ['global'])).toEqual(['pcb', 'pcblib']);
  });
  it('Open every document opens every document of the project', () => {
    settings.openProjectDocs = 'all';
    settings.restoreOpenDocs = false;
    openBatch(demoFiles());
    const prj = readPrjPcb(demoFiles().find((f) => f.name === 'Demo.PrjPcb')!.bytes, 'Demo.PrjPcb');
    expect(docs.value.map((d) => d.name).sort()).toEqual(prj.documents.map((d) => d.split(/[\\/]/).pop()!).sort());
  });
  it('the first schematic and the board, by default', () => {
    settings.openProjectDocs = 'schpcb';
    settings.restoreOpenDocs = false;
    openBatch(demoFiles());
    expect(docs.value.map((d) => d.name).sort()).toEqual(['Demo.PcbDoc', 'Demo.SchDoc']);
  });
});

describe('5. Routing preferences nothing used', () => {
  const O = mil(9000), P = (x: number, y: number) => ({ x: O + mil(x), y: O + mil(y) });
  const T = (a: [number, number], b: [number, number]): TrackFields => ({ layer: L.TOP, a: P(...a), b: P(...b), width: mil(10), net: 0 });
  const sameAs = (t: PcbTrack, f: TrackFields) => t.layer === f.layer && t.a.x === f.a.x && t.a.y === f.a.y && t.b.x === f.b.x && t.b.y === f.b.y;
  it('Remove Net Antennas: the stub the old way\'s removal leaves dead-ended goes, and what dead-ends behind it', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const old = T([0, 0], [100, 0]);
    const stub = [T([50, 0], [50, 50]), T([50, 50], [80, 50])];
    const route = [T([0, 0], [0, -30]), T([0, -30], [100, -30]), T([100, -30], [100, 0])];
    const joined = T([100, 0], [100, 60]);   // on the old way's end, where the new route ends too
    const locked = T([20, 0], [20, 40]);
    addTracks(doc, [old, ...stub, ...route, joined, locked]).apply();
    const find = (f: TrackFields) => doc.prims.find((p): p is PcbTrack => p.kind === 'track' && sameAs(p, f))!;
    removePrims(doc, [find(old)]).apply();
    find(locked).locked = true;
    const gone = antennasLeft(doc, 0, [old], route);
    expect(gone.map((t) => stub.findIndex((f) => sameAs(t, f))).sort()).toEqual([0, 1]);
    expect(antennasLeft(doc, 0, [], route)).toEqual([]);
    // The router takes them out with the loop, when asked
    expect(src('src/editors/pcb/RouteTool.ts')).toMatch(/if \(settings\.pcbRemoveNetAntennas\) \{\s*const stubs = antennasLeft\(ed\.doc, net, loop\.remove/);
    const f = field('pcbRemoveNetAntennas');
    expect([f.notYet, f.off?.({ ...settings, pcbRemoveLoops: false }), f.off?.({ ...settings, pcbRemoveLoops: true })]).toEqual([undefined, true, false]);
  });
  it('Follow Mouse Trail and Preferred Subnet Jumper Length act (26.185: they were greyed, "Not available yet")', () => {
    expect(field('pcbFollowMouseTrail').notYet).toBeUndefined();
    expect(field('pcbFollowMouseTrail').help).toMatch(/the way the cursor went/);
    const dlg = src('src/app/dialogs/RoutingDialog.tsx');
    expect(dlg).not.toMatch(/Not available yet/);
    expect(dlg).toMatch(/check\('pcbFollowMouseTrail', 'Follow Mouse Trail', false, false, '/);
    expect(dlg).not.toMatch(/Preferred Subnet Jumper Length<\/span>\s*<LenInput [^>]*disabled/);
    // The router keeps the cursor's trail and goes by it; Add Subnet Jumpers starts from the preferred length and keeps the one used
    expect(src('src/editors/pcb/RouteTool.ts')).toMatch(/settings\.pcbFollowMouseTrail \? this\.alongTrail\(/);
    expect(src('src/app/dialogs/Pcb41Dialogs.tsx')).toMatch(/useState\(parseLength\(settings\.pcbSubnetJumperLength\)/);
  });

});

describe('6. Output Jobs', () => {
  const job = (scope: string, own = 'Full') => readOutJob(binToBytes(['[OutputJobFile]', 'Version=1.0', '[OutputGroup1]', 'Name=Output Group 1', 'Description=',
    'OutputMedium1=Folder Structure', 'OutputMedium1_Type=GeneratedFiles',
    'OutputType1=BOM_PartType', 'OutputName1=Bill of Materials', 'OutputCategory1=Report', 'OutputDocumentPath1=', `OutputVariantName1=${own}`, 'OutputDefault1=0',
    'OutputType2=Gerber', 'OutputName2=Gerber Files', 'OutputCategory2=Fabrication', 'OutputDocumentPath2=', 'OutputVariantName2=', 'OutputDefault2=0',
    'VariantName=Lite', `VariantScope=${scope}`, ''].join('\r\n')), 'X.OutJob');
  it('a new job builds the selected variant for every output', () => {
    const j = newOutJob('Job1.OutJob');
    expect(outJobKey(j, 'OutputGroup1', 'VariantScope')).toBe('0');
    const o = newOutput('BOM_PartType', 'Bill of Materials', 'Report', '');
    o.rest.push(['OutputVariantName#', 'Full']);
    setOutJobOutputs(j, [o]);
    chooseJobVariant(j, 'Lite');
    expect(outputVariantName(j, outJobOutputs(j)[0]!)).toBe('Lite');
    expect(jobVariant(j)).toBe('Lite');
  });
  it('Build the selected variant on a job saved with each output\'s own: it shows theirs, and choosing one makes every output build it', () => {
    const a = job('1');
    expect(jobVariant(a)).toBeNull();                 // Full and none: each its own
    expect(jobVariant(job('1', ''))).toBe('');        // all none
    chooseJobVariant(a, 'Lite');
    expect(outJobKey(a, 'OutputGroup1', 'VariantScope')).toBe('0');
    expect(outJobOutputs(a).map((o) => outputVariantName(a, o))).toEqual(['Lite', 'Lite']);
    chooseJobVariant(a, '[No Variations]');
    expect(outJobOutputs(a).map((o) => outputVariantName(a, o))).toEqual(['', '']);
    expect(jobVariant(job('0'))).toBe('Lite');
  });

  const project = (outputPath: string | null, extra: Partial<Project> = {}): Project => ({
    id: 'p1', name: 'Demo.PrjPcb', files: new Map(), folder: 'Demo', path: 'Demo.PrjPcb',
    prj: readPrjPcb(binToBytes(['[Design]', 'Version=1.0', ...(outputPath === null ? [] : [`OutputPath=${outputPath}`]), ''].join('\r\n')), 'Demo.PrjPcb'), ...extra,
  });
  it('the project\'s Output Path, from the project\'s folder; Project Outputs for <project> when it is empty or can\'t be reached', () => {
    expect(outputFolder(project(null), 'Demo.PcbDoc')).toEqual(['Project Outputs for Demo']);
    expect(outputFolder(project(''), 'Demo.PcbDoc')).toEqual(['Project Outputs for Demo']);
    expect(outputFolder(project('Project Outputs for Demo'), 'Demo.PcbDoc')).toEqual(['Project Outputs for Demo']);
    expect(outputFolder(project('Out\\Fab\\'), 'Demo.PcbDoc')).toEqual(['Out', 'Fab']);
    expect(outputFolder(project('.\\Out'), 'Demo.PcbDoc')).toEqual(['Out']);
    expect(outputFolder(project('C:\\Work\\Demo\\Generated'), 'Demo.PcbDoc')).toEqual(['Generated']);
    expect(outputFolder(project('C:\\Elsewhere\\Generated'), 'Demo.PcbDoc')).toEqual(['Project Outputs for Demo']);
    expect(outputFolder(project('..\\Shared'), 'Demo.PcbDoc')).toEqual(['Project Outputs for Demo']);
    expect(outputFolder(null, 'Board.PcbDoc')).toEqual(['Project Outputs for Board']);
  });
  it('outputs are written there', async () => {
    interface Dir { name: string; dirs: Map<string, Dir>; files: Map<string, Uint8Array> }
    const dir = (name: string): Dir & Record<string, unknown> => {
      const d: Dir & Record<string, unknown> = { name, kind: 'directory', dirs: new Map(), files: new Map() };
      d.queryPermission = async () => 'granted';
      d.getDirectoryHandle = async (n: string, o?: { create?: boolean }) => { let x = d.dirs.get(n); if (!x) { if (!o?.create) throw new Error(`no ${n}`); x = dir(n); d.dirs.set(n, x); } return x; };
      d.getFileHandle = async (n: string) => ({ name: n, createWritable: async () => ({ write: async (b: Uint8Array) => { d.files.set(n, b); }, close: async () => undefined }) });
      return d;
    };
    const root = dir('Demo');
    const p = project('Out\\Fab', { dir: root as unknown as FileSystemDirectoryHandle });
    await deliverOutputs(p, 'Demo.PcbDoc', 'Gerber Files', [{ name: 'Demo.GTL', text: 'G04*' }]);
    expect([...root.dirs.keys()]).toEqual(['Out']);
    expect([...root.dirs.get('Out')!.dirs.get('Fab')!.files.keys()]).toEqual(['Demo.GTL']);
    const q = project(null, { dir: dir('Demo') as unknown as FileSystemDirectoryHandle });
    await deliverOutputs(q, 'Demo.PcbDoc', 'Gerber Files', [{ name: 'Demo.GTL', text: 'G04*' }]);
    expect([...(q.dir as unknown as Dir).dirs.get('Project Outputs for Demo')!.files.keys()]).toEqual(['Demo.GTL']);
    // The Output Job's Folder Structure container names the folder
    expect(src('src/app/OutJobView.tsx')).toMatch(/outputFolder\(p, od\.name\)\.join/);
  });
});
