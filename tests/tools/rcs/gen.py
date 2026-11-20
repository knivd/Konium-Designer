"""Generate Konium's AD17 menu definitions from Altium Designer 17 resource files."""
import sys, os, re, json, copy, glob
sys.path.insert(0, os.path.dirname(__file__))
from rcs import load

D = sys.argv[1]
MODE = sys.argv[2] if len(sys.argv) > 2 else 'list'
files = [f for f in glob.glob(os.path.join(D, '*')) if f.lower().endswith('.rcs') and not os.path.basename(f).startswith('Default_')]
pls, trees, mods, copies = load(files)
# The Mixed Sim netlist editor's Simulate menu (its launchers live in an AdvSim resource these files
# don't include): captions [est]
pls.setdefault('PLADVSIM:RunSimulation', {'command': 'ADVSIM:RunSimulation', 'caption': '&Run Simulation', 'description': 'Run the simulation of this netlist'})
pls.setdefault('PLADVSIM:RunDialog_AnalysesSetup', {'command': 'ADVSIM:RunDialog', 'caption': '&Analyses Setup...', 'description': 'Set up the analyses'})

# Out of scope: HDL / digital simulation, signal integrity, FPGA / embedded / HDL, vault / VCS / release,
# scripting, collaboration comments, 3D-only views, rigid-flex, legacy and help-site items.
EXCLUDE_PL = re.compile(r'(Vault|VersionControl|VCS|Release|Managed|FPGA|VHDL|Verilog|HDLSimulation|InsertSimulator|WaveSim|Wave:|SiSupport|SignalIntegrity|OpenBus|FSM|HighLevelCode|CCode|CodeSymbol|CodeEntry|Embedded|EditScript|RunScript|Script|TASKING|Synthes|Testbench|Comment|HelpAdvisor|LibraryMigrator|DevicesView|Instrument|PlaceProbe|Stimulus|TestVector|TC2|Supplier|Configuration|ProjectAccess|ProjectOrder|Snippet|RTF|Legacy|Merge|Insight|Lens|Difference(?!s\b)|ShowPhysicalDifferences|GraphicsTest|TestGraphics|DebugReport|NewDocumentForm|Unhide|ShowHidden|Workspace_Component|Licens|NewIn|Exploring|Forum|LocalHistory|StorageManager|Channels|MyAccount|SystemInfo|RunProcess|LogicAnalyser|Bending|SplitLine|Coverlay|3DLayout|Freeze3D|Fold|ZeroRotation|90DegreeRotation|OrthogonalRotation|TestGraphics|xSignal|ActiveRoute|Situs|Halt|ErrorCheckDocument|NewRTF|Notes?Collapse|ImporterManager|Importer|Exporter|GetMore|VerLib|PVLib|NewSimModel|SimModelGenerator|NewText|Viewport|OLE|ViewRotation|ModifyBoardShape|PCB:MoveBoard\b|NewCmpLib|PCB3DLib|SVNDatabaseLib|PLDatabaseLink|SeaOfDocuments|NewWorkspace|NewFilesPanel|ProjectReleaser|ExportConfiguration|BusJoiner|DesignView|ObjectFromFile|Densit|SubProject|Processor|ConfigureComponentWithContext|KeyFrame|3DMovie|AnalyzeSingleNet|AutorouteEx|ContextLengthTuning|EditPolygonVertex|SupplierLink|LibraryToSVN|ShowEPM|NewProject_CORE|NewProject_Harness|NewProject_SystemDesign|Messages_CustomCommand|XSpice|ConfigureItemManager|CompLibGenerator)', re.I)
EXCLUDE_CAPTION = re.compile(r'^(Cancel Edit.*|Workspace|Design &?Workspace|&?Files Panel|Pad Via Library|Verilog L&?ibrary|&?SimModel File|Component Library|&?Text Document|PCB3&?D Library|&?SVN Database Library|Hyperlin&?k|Open Design Wor&?kspace\.\.\.|Save Design Workspace( As)?\.\.\.|Save Managed Project|Open Managed Project\.\.\.|Check Out\.\.\.|&?Import|Underlined Connections|Board Information\.\.\.|FPGA.*|.*Third Party IP.*)$', re.I)

def is_excluded(n):
    if n['kind'] == 'link':
        plid = n.get('plid', '')
        cap = caption(n)
        if EXCLUDE_PL.search(plid): return True
        return bool(EXCLUDE_CAPTION.search(cap))
    if n['kind'] == 'tree':
        # CAMtastic's own File › Import stays (the others' Import menus are the Import Wizard's)
        if n.get('id', '').startswith('MNCAMtastic_Menu_0'): return False
        if EXCLUDE_CAPTION.search(n.get('caption', '')): return True
        return bool(re.search(r'(Key Frame|3D Movie|Version Control|Local His|Script Files|Embedded|System &?Level|Design Workspace|Recent Design Workspaces|Recen&?t Workspaces|Project Panel|Unhide|Insight|Differences|Create &?HDL|Refere&?nces|Code &?Entry|Code &?Symbol|Hyperlin|RT&?F|Popups|Snippets|Legacy|Compare and Merge|xSignals|Split Planes)', n.get('caption', '')))
    return False

def caption(n):
    if n['kind'] == 'tree': return n.get('caption', '')
    pl = pls.get(n.get('plid'), {})
    return n.get('caption') or pl.get('caption', '')

def expand(node):
    out = []
    for c in node.get('children', []):
        if c['kind'] == 'treecopy':
            orig = trees.get(c.get('originalid'))
            if orig is None: continue
            t = copy.deepcopy(orig); t['children'] = expand(t); out.append(t)
        elif c['kind'] == 'tree':
            t = dict(c); t['children'] = expand(c); out.append(t)
        else:
            out.append(c)
    return out

def prune(children):
    out = []
    for c in children:
        if c['kind'] in ('linkrepeat',):
            out.append(c); continue
        if c['kind'] == 'separator': out.append(c); continue
        if c['kind'] not in ('link', 'tree'): continue
        if is_excluded(c): continue
        if c['kind'] == 'link' and not pls.get(c.get('plid')): continue
        if c['kind'] == 'tree':
            c = dict(c); c['children'] = prune(c['children'])
            if not any(x['kind'] != 'separator' for x in c['children']): continue
        out.append(c)
    # tidy separators
    tidy = []
    for c in out:
        if c['kind'] == 'separator' and (not tidy or tidy[-1]['kind'] == 'separator'): continue
        tidy.append(c)
    while tidy and tidy[-1]['kind'] == 'separator': tidy.pop()
    # drop repeated links (same PL twice in a row, e.g. the nine Update Other variants)
    dedup = []
    for c in tidy:
        if dedup and c['kind'] == 'link' and dedup[-1]['kind'] == 'link' and re.sub(r'\d+$', '', c.get('plid', '')) == re.sub(r'\d+$', '', dedup[-1].get('plid', '')) and caption(c) == caption(dedup[-1]):
            continue
        dedup.append(c)
    return dedup

def root(tid):
    t = dict(trees[tid]); t['children'] = prune(expand(t)); return t

def walk(node, fn, depth=0):
    for c in node['children']:
        fn(c, depth)
        if c['kind'] == 'tree': walk(c, fn, depth + 1)

ROOTS = {'sch': 'MNSchematicMenu', 'pcb': 'MNPCBMenu', 'pcblib': 'MNPCBLibMenu', 'schlib': 'MNSchLibMenu', 'global': 'MNNoDocument', 'dxp': 'MNSystemMenu'}

if MODE == 'list':
    seen = {}
    for scope, tid in ROOTS.items():
        t = root(tid)
        def f(c, d, scope=scope):
            if c['kind'] == 'link':
                pl = pls[c['plid']]
                key = c['plid']
                seen.setdefault(key, [caption(c), pl.get('command', ''), pl.get('params', ''), set()])[3].add(scope)
        walk(t, f)
    for k, (cap, cmd, params, scopes) in sorted(seen.items()):
        print(f"{k}\t{cap}\t{cmd} {params}\t{','.join(sorted(scopes))}")
elif MODE == 'tree':
    for tid in sys.argv[3:]:
        t = root(ROOTS.get(tid, tid))
        def f(c, d):
            ind = '  ' * d
            if c['kind'] == 'separator': print(ind + '----')
            elif c['kind'] == 'tree': print(ind + '[' + caption(c) + ']' + (' popup=' + c['popup'] if c.get('popup') else ''))
            elif c['kind'] == 'linkrepeat': print(ind + '(dynamic ' + c.get('plid', '') + ')')
            else:
                pl = pls[c['plid']]
                sc = ' | '.join(x for x in [pl.get('shortcut1'), pl.get('shortcut2')] if x)
                print(ind + caption(c) + ('   <' + sc + '>' if sc else '') + '   ' + c['plid'])
        walk(t, f)
