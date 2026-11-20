import { useState } from 'preact/hooks';
import { docs, notify, projects, tick, type OpenDoc } from './state';
import { showDialog } from './dialogs';
import { openMenuAt } from './MenuBar';
import { GerberSetupDialog, DrillSetupDialog, PickPlaceSetupDialog, TestPointSetupDialog, outputFolder } from './dialogs/Outputs';
import { PcbPrintoutDialog } from './dialogs/PcbPrints';
import { OUTPUT_KINDS, newOutput, outJobKey, outJobMedia, outJobOutputs, outputConfig, setOutJobKey, setOutJobOutputs, setOutputConfig,
  type OutJobDocument, type OutJobMedium, type OutJobOutput } from '../formats/altium/outjob';
import { drillFromConfig, drillToConfig, gerberFromConfig, gerberToConfig, pnpFromConfig, pnpToConfig, printJobFromConfig, printJobToConfig } from '../formats/altium/outjobConfig';
import { FILE_TYPES, PRINT_TYPES, chooseJobVariant, jobVariant, outputBoard, runContainer } from './outjobRun';
import { defaultJob } from '../model/printouts';
import { readVariants } from '../model/variants';
import { defaultTestPointSetup } from '../formats/gerber/testpoints';

const MEDIUM_KIND: Record<string, string> = { Printer: 'Print Job', Publish: 'PDF', GeneratedFiles: 'Folder Structure', Multimedia: 'Video' };
const NO_VARIANT = '[No Variations]';
/** Variant Choice of a job whose outputs each build a variant of their own (not all the same). */
const EACH_OWN = '[Each output\'s own]';

/**
 * An Output Job open in its tab, laid out as AD17's: the outputs under their categories (Netlist,
 * Documentation, Assembly, Fabrication, Report, Validation, Export), each with its data source,
 * description and Enabled box for the container selected on the right; [Add New … Output] under
 * each category; the Output Containers (Print Job, PDF, Folder Structure) with Generate content;
 * the Variant Choice. Right-click an output for Configure, Rename, Duplicate, Delete, Move Up / Down;
 * double-click configures it. Changes mark the job unsaved (File › Save writes the .OutJob).
 */
export function OutJobView({ od }: { od: OpenDoc }) {
  void tick.value;
  const job = od.doc as OutJobDocument;
  const [, redraw] = useState(0);
  const [sel, setSel] = useState<number | null>(null);
  const changed = () => { job.dirty = true; tick.value++; redraw((x) => x + 1); };
  const outs = outJobOutputs(job), media = outJobMedia(job).filter((m) => m.type !== 'Multimedia');
  const target = outJobKey(job, 'OutputGroup1', 'TargetOutputMedium') ?? '';
  const cur = media.find((m) => m.name === target) ?? media[0];
  const p = od.projectId ? projects.value.find((x) => x.id === od.projectId) ?? null : null;
  const boards = p ? p.prj.documents.filter((d) => /\.pcbdoc$/i.test(d)).map((d) => d.split(/[\\/]/).pop()!) : docs.value.filter((d) => d.doc.kind === 'PcbDoc').map((d) => d.name);
  const variants = p ? readVariants(p.prj).map((v) => v.name) : [];
  const save = (list: OutJobOutput[]) => { setOutJobOutputs(job, list); changed(); };
  // Variant Choice: the variant every output builds; choosing one here makes every output build it
  // (a job saved with each output naming its own shows theirs when they agree, else that each has its own)
  const jv = jobVariant(job);
  const shownVariant = jv === null ? EACH_OWN : jv || NO_VARIANT;
  const chooseVariant = (v: string) => { if (v === EACH_OWN) return; chooseJobVariant(job, v); changed(); };

  const toggle = (o: OutJobOutput) => {
    if (!cur) return;
    const list = outJobOutputs(job), x = list.find((y) => y.n === o.n)!;
    const on = (x.media.get(cur.m) ?? 0) > 0;
    x.media.set(cur.m, on ? 0 : Math.max(0, ...list.map((y) => y.media.get(cur.m) ?? 0)) + 1);
    save(list);
  };
  const selectContainer = (m: OutJobMedium) => { setOutJobKey(job, 'OutputGroup1', 'TargetOutputMedium', m.name); save(outJobOutputs(job)); };

  const configure = (o: OutJobOutput) => {
    const b = outputBoard(p, o);
    const keep = (recs: Record<string, string>[]) => { const list = outJobOutputs(job), x = list.find((y) => y.n === o.n)!; setOutputConfig(x, recs); save(list); };
    const kind = PRINT_TYPES[o.type];
    if (kind && kind !== 'sch') {
      if (!b) { notify('The output has no PCB document to configure against', 'error'); return; }
      const j = printJobFromConfig(kind, o.name, outputConfig(o), defaultJob(b, kind));
      const stack = b.board.copperStack;
      showDialog(PcbPrintoutDialog, { doc: b, job: j, keep: false, onOk: (nj: typeof j) => keep(printJobToConfig(nj, [stack[0]!, stack.at(-1)!])) });
      return;
    }
    if (!b && /^(Gerber|NC Drill|Pick Place|Test Points)$/.test(o.type)) { notify('The output has no PCB document to configure against', 'error'); return; }
    switch (o.type) {
      case 'Gerber': showDialog(GerberSetupDialog, { doc: b!, initial: gerberFromConfig(b!, outputConfig(o)), onSave: (s: ReturnType<typeof gerberFromConfig>) => keep(gerberToConfig(s)) }); return;
      case 'NC Drill': showDialog(DrillSetupDialog, { doc: b!, initial: drillFromConfig(outputConfig(o)), onSave: (s: ReturnType<typeof drillFromConfig>) => keep(drillToConfig(s)) }); return;
      case 'Pick Place': showDialog(PickPlaceSetupDialog, { doc: b!, initial: pnpFromConfig(outputConfig(o)), onSave: (s: ReturnType<typeof pnpFromConfig>) => keep(pnpToConfig(s)) }); return;
      case 'Test Points': showDialog(TestPointSetupDialog, { doc: b!, initial: defaultTestPointSetup(), onSave: () => notify('In an Output Job the Test Point Report writes IPC-D-356A and text, in inches from the relative origin') }); return;
      default: notify(`${o.name} has nothing to configure in Konium Designer`);
    }
  };
  const rename = (o: OutJobOutput) => {
    const name = prompt('Output name', o.name);
    if (!name?.trim()) return;
    const list = outJobOutputs(job); list.find((y) => y.n === o.n)!.name = name.trim(); save(list);
  };
  const remove = (o: OutJobOutput) => { save(outJobOutputs(job).filter((y) => y.n !== o.n)); setSel(null); };
  const duplicate = (o: OutJobOutput) => {
    const list = outJobOutputs(job), i = list.findIndex((y) => y.n === o.n);
    const copy: OutJobOutput = { ...o, n: 0, name: `${o.name} (copy)`, media: new Map(), rest: o.rest.map(([k, v]) => [k, v] as [string, string]) };
    list.splice(i + 1, 0, copy); save(list);
  };
  const move = (o: OutJobOutput, d: -1 | 1) => {
    const list = outJobOutputs(job), i = list.findIndex((y) => y.n === o.n), same = list.filter((y) => y.category === o.category);
    const k = same.findIndex((y) => y.n === o.n), other = same[k + d];
    if (!other) return;
    const j = list.indexOf(other);
    [list[i], list[j]] = [list[j]!, list[i]!]; save(list);
  };
  const menu = (e: MouseEvent, o: OutJobOutput) => {
    e.preventDefault(); setSel(o.n);
    openMenuAt({ key: '', label: '', children: [
      { key: 'C', label: 'Configure...', accelAt: 0, action: () => configure(o) },
      { key: 'R', label: 'Rename', accelAt: 0, action: () => rename(o) },
      { key: 'U', label: 'Duplicate', accelAt: 1, action: () => duplicate(o) },
      { key: 'D', label: 'Delete', accelAt: 0, action: () => remove(o) },
      { key: 'P', label: 'Move Up', accelAt: 5, action: () => move(o, -1), separatorBefore: true },
      { key: 'W', label: 'Move Down', accelAt: 7, action: () => move(o, 1) },
    ] }, e.clientX, e.clientY);
  };
  const add = (e: MouseEvent, cat: (typeof OUTPUT_KINDS)[number]) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenuAt({ key: '', label: '', children: cat.types.map(([type, name]) => ({ key: '', label: name, action: () => {
      const list = outJobOutputs(job);
      list.push(newOutput(type, name, cat.category, PRINT_TYPES[type] && PRINT_TYPES[type] !== 'sch' || FILE_TYPES.has(type) && !/BOM|Protel|Electrical/.test(type) ? boards[0] ?? '' : ''));
      save(list);
    } })) }, r.left, r.bottom + 1);
  };
  const addContainer = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const next = Math.max(0, ...outJobMedia(job).map((m) => m.m)) + 1;
    const put = (name: string, type: string) => () => {
      const g = job.sections.find((s) => s.name === 'OutputGroup1')!;
      let at = 0;
      g.entries.forEach(([k], i) => { if (/^OutputMedium\d+/.test(k)) at = i + 1; });
      g.entries.splice(at, 0, [`OutputMedium${next}`, name], [`OutputMedium${next}_Type`, type]);
      save(outJobOutputs(job));
    };
    openMenuAt({ key: '', label: '', children: [{ key: 'P', label: 'PDF', accelAt: 0, action: put(`PDF${next}`, 'Publish') }, { key: 'F', label: 'Folder Structure', accelAt: 0, action: put(`Folder Structure${next}`, 'GeneratedFiles') }] }, r.left, r.bottom + 1);
  };
  const desc = (o: OutJobOutput) => (o.type === 'BOM_PartType' ? 'Bill of Materials' : o.type === 'Protel' ? 'Netlist (.NET)' : o.type);
  const source = (o: OutJobOutput) => {
    const pcb = (PRINT_TYPES[o.type] && PRINT_TYPES[o.type] !== 'sch') || /^(Gerber|Gerber X2|IPC2581|NC Drill|Pick Place|Test Points|Design Rules Check|ODB|ExportSTEP|PCB 3D Print|AutoCAD dwg\/dxf PCB)$/.test(o.type);
    if (!pcb) return <span class="muted">[Project Physical Documents]</span>;
    return (
      <select aria-label={`${o.name} data source`} value={o.document} onChange={(e) => { const list = outJobOutputs(job); list.find((y) => y.n === o.n)!.document = (e.target as HTMLSelectElement).value; save(list); }}>
        {!o.document && <option value="">{boards[0] ?? '[PCB Document]'}</option>}
        {boards.map((b) => <option key={b} value={b}>{b}</option>)}
      </select>
    );
  };
  return (
    <div class="outjob" aria-label={`Output Job ${od.name}`}>
      <div class="oj-main">
        <div class="oj-head"><span>Outputs</span><span>Data Source</span><span>Output Description</span><span>Enabled</span></div>
        <div class="oj-list">
          {OUTPUT_KINDS.map((cat) => (
            <div key={cat.category} class="oj-cat">
              <div class="oj-cat-title">{cat.title}</div>
              {outs.filter((o) => o.category === cat.category).map((o) => (
                <div key={o.n} class={`oj-row${sel === o.n ? ' on' : ''}`} onMouseDown={() => setSel(o.n)} onDblClick={() => configure(o)} onContextMenu={(e) => menu(e, o)}>
                  <span class="oj-name">{o.name}</span>
                  <span>{source(o)}</span>
                  <span class="muted">{desc(o)}</span>
                  <span class="oj-en"><input type="checkbox" aria-label={`${o.name} enabled in ${cur?.name ?? ''}`} checked={!!cur && (o.media.get(cur.m) ?? 0) > 0} disabled={!cur} onChange={() => toggle(o)} />
                    {cur && (o.media.get(cur.m) ?? 0) > 0 && <span class="oj-order">{o.media.get(cur.m)}</span>}</span>
                </div>
              ))}
              <div class="oj-add"><button class="linkish" onClick={(e) => add(e, cat)}>[Add New {cat.title.replace(/s$/, '')}]</button></div>
            </div>
          ))}
          {outs.filter((o) => !OUTPUT_KINDS.some((c) => c.category === o.category)).length > 0 && (
            <div class="oj-cat"><div class="oj-cat-title">Other Outputs</div>
              {outs.filter((o) => !OUTPUT_KINDS.some((c) => c.category === o.category)).map((o) => (
                <div key={o.n} class={`oj-row${sel === o.n ? ' on' : ''}`} onMouseDown={() => setSel(o.n)} onContextMenu={(e) => menu(e, o)}>
                  <span class="oj-name">{o.name}</span><span /><span class="muted">{desc(o)}</span>
                  <span class="oj-en"><input type="checkbox" checked={!!cur && (o.media.get(cur.m) ?? 0) > 0} disabled={!cur} onChange={() => toggle(o)} /></span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div class="oj-side">
        <fieldset><legend>Variant Choice</legend>
          <label class="do-row oj-variant"><span>Build the selected variant</span>
            <select value={shownVariant} onChange={(e) => chooseVariant((e.target as HTMLSelectElement).value)}>
              {shownVariant === EACH_OWN && <option value={EACH_OWN}>{EACH_OWN}</option>}
              <option>{NO_VARIANT}</option>{variants.map((v) => <option key={v}>{v}</option>)}
              {shownVariant !== EACH_OWN && shownVariant !== NO_VARIANT && !variants.includes(shownVariant) && <option>{shownVariant}</option>}
            </select></label>
        </fieldset>
        <div class="oj-cont-title">Output Containers</div>
        {media.map((m) => (
          <div key={m.m} class={`oj-cont${cur?.m === m.m ? ' on' : ''}`} onMouseDown={() => selectContainer(m)} role="button" aria-pressed={cur?.m === m.m}>
            <div class="oj-cont-name">{m.name}</div>
            <div class="muted small">{MEDIUM_KIND[m.type] ?? m.type}{m.type === 'GeneratedFiles' ? ` · ${p ? outputFolder(p, od.name).join('\\') : 'Project Outputs for the project'}` : ''}</div>
            <div class="oj-cont-actions">
              <button class="linkish" onClick={(e) => { e.stopPropagation(); void runContainer(od, m); }}>{m.type === 'Printer' ? 'Print' : 'Generate content'}</button>
              <span class="muted small">{outs.filter((o) => (o.media.get(m.m) ?? 0) > 0).length} output{outs.filter((o) => (o.media.get(m.m) ?? 0) > 0).length === 1 ? '' : 's'}</span>
            </div>
          </div>
        ))}
        <button class="linkish" onClick={addContainer}>[Add New Output Container]</button>
      </div>
    </div>
  );
}
