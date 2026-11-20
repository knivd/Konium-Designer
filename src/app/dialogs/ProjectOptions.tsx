import { Fragment } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { markProjectDirty, notify, type Project } from '../state';
import { iniGet, iniSet, projectParameters, reparse, setProjectParameters } from '../../formats/altium/prjpcb';
import {
  CONNECTION_CODES, ERC_GROUPS, ERC_KINDS, ERC_LEVELS, NET_SCOPES, defaultErc, readErc, writeErc, type ErcLevel, type ErcSettings,
} from '../../model/erc';

/**
 * Project › Project Options, as Altium Designer 17 lays it out (the tabs Konium acts on):
 * Error Reporting (each violation's report mode, grouped as Altium groups them), Connection
 * Matrix (click a cell to step No Report → Warning → Error → Fatal Error), Options (output
 * folder, netlist options, net identifier scope, pin swapping) and Parameters (the project's
 * parameters, which special strings show). OK writes the .PrjPcb's own sections and nothing else.
 */

const LEVEL_CLASS = ['po-n', 'po-w', 'po-e', 'po-f'] as const;
type Tab = 'errors' | 'matrix' | 'options' | 'parameters';

interface Opts {
  outputPath: string; logPath: string; openOutputs: boolean; timestamp: boolean; archive: boolean; separate: boolean;
  ports: boolean; entries: boolean; singlePin: boolean; appendSheet: boolean; higherNames: boolean; powerNames: boolean;
  scope: number; swapLabel: boolean; swapPin: boolean;
}
const OPTION_KEYS: [keyof Opts, string, boolean][] = [
  ['openOutputs', 'OpenOutputs', true], ['timestamp', 'TimestampOutput', false], ['archive', 'ArchiveProject', false], ['separate', 'SeparateFolders', false],
  ['ports', 'AllowPortNetNames', false], ['entries', 'AllowSheetEntryNetNames', true], ['singlePin', 'NetlistSinglePinNets', false],
  ['appendSheet', 'AppendSheetNumberToLocalNets', false], ['higherNames', 'NameNetsHierarchically', false], ['powerNames', 'PowerPortNamesTakePriority', false],
  ['swapLabel', 'PinSwapBy_Netlabel', true], ['swapPin', 'PinSwapBy_Pin', true],
];

function readOpts(p: Project): Opts {
  const g = (k: string) => iniGet(p.prj, 'Design', k);
  const flag = (k: string, def: boolean) => { const v = g(k); return v === undefined ? def : v === '1'; };
  const o = { outputPath: g('OutputPath') ?? `Project Outputs for ${p.name.replace(/\.prjpcb$/i, '')}`, logPath: g('LogFolderPath') ?? '', scope: Number(g('HierarchyMode') ?? 0) || 0 } as Opts;
  for (const [field, key, def] of OPTION_KEYS) (o as unknown as Record<string, boolean>)[field] = flag(key, def);
  return o;
}

export function ProjectOptionsDialog({ project, tab: tab0 = 'errors' }: { project: Project; tab?: Tab }) {
  const [tab, setTab] = useState<Tab>(tab0);
  const [erc, setErc] = useState<ErcSettings>(() => readErc(project.prj));
  const [opts, setOpts] = useState<Opts>(() => readOpts(project));
  const [params, setParams] = useState(() => projectParameters(project.prj));
  const [pSel, setPSel] = useState<number | null>(null);
  const [kSel, setKSel] = useState<number | null>(null);
  const setLevel = (n: number, l: ErcLevel) => { const levels = new Map(erc.levels); levels.set(n, l); setErc({ ...erc, levels }); };
  const setAll = (l: ErcLevel) => setErc({ ...erc, levels: new Map(ERC_KINDS.map((k) => [k.n, l])) });
  const cycle = (i: number, j: number) => {
    const m = erc.matrix.map((r) => [...r]);
    const v = (((m[i]![j] ?? 0) + 1) % 4) as ErcLevel;
    m[i]![j] = v; m[j]![i] = v;
    setErc({ ...erc, matrix: m });
  };

  const ok = () => {
    const prj = project.prj;
    const before = prj.lines.join('\n');
    writeErc(prj, erc);
    const d = (k: string, v: string) => { if (iniGet(prj, 'Design', k) !== v) iniSet(prj, 'Design', k, v); };
    d('OutputPath', opts.outputPath); d('LogFolderPath', opts.logPath); d('HierarchyMode', String(opts.scope));
    for (const [field, key] of OPTION_KEYS) d(key, opts[field] ? '1' : '0');
    const named = params.filter((x) => x.name.trim());
    const old = projectParameters(prj);
    if (named.length !== old.length || named.some((x, i) => x.name !== old[i]!.name || x.value !== old[i]!.value)) setProjectParameters(prj, named);
    reparse(prj);
    closeDialog();
    if (prj.lines.join('\n') !== before) { markProjectDirty(project); notify(`Project options of ${project.name} changed`); }
  };

  const groups = useMemo(() => ERC_GROUPS.map((g) => ({ g, kinds: ERC_KINDS.filter((k) => k.group === g) })).filter((x) => x.kinds.length), []);
  const check = (label: string, key: keyof Opts) => (
    <label class="do-check"><input type="checkbox" checked={!!opts[key]} onChange={(e) => setOpts({ ...opts, [key]: (e.target as HTMLInputElement).checked })} />{label}</label>
  );

  return (
    <Dialog title={`Options for PCB Project ${project.name}`} width={860} height={640} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="projopts"
      footer={<>
        {tab === 'errors' || tab === 'matrix' ? <button class="btn" onClick={() => { const d = defaultErc(); setErc(tab === 'errors' ? { ...erc, levels: d.levels } : { ...erc, matrix: d.matrix }); }}>Set To Installation Defaults</button> : null}
        <span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button>
      </>}>
      <div class="dlg-tabs" role="tablist">
        {([['errors', 'Error Reporting'], ['matrix', 'Connection Matrix'], ['options', 'Options'], ['parameters', 'Parameters']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'errors' ? (
        <div class="po-errors" role="grid" aria-label="Error Reporting">
          <div class="po-erow cp-ghead" role="row"><span>Violation Type Description</span><span>Report Mode</span></div>
          {groups.map(({ g, kinds }) => (
            <Fragment key={g}>
              <div class="po-group" role="row"><span>Violations Associated with {g}</span></div>
              {kinds.map((k) => {
                const l = erc.levels.get(k.n) ?? k.def;
                return (
                  <div key={k.key} class={`po-erow${kSel === k.n ? ' on' : ''}`} role="row" onMouseDown={() => setKSel(k.n)}>
                    <span>{k.label}</span>
                    <select class={LEVEL_CLASS[l]} value={String(l)} aria-label={k.label} onChange={(e) => setLevel(k.n, Number((e.target as HTMLSelectElement).value) as ErcLevel)}>
                      {ERC_LEVELS.map((x, i) => <option key={x} value={String(i)}>{x}</option>)}
                    </select>
                  </div>
                );
              })}
            </Fragment>
          ))}
          <div class="po-allrow">
            {ERC_LEVELS.map((x, i) => <button key={x} class="btn" onClick={() => setAll(i as ErcLevel)}>{i === 0 ? 'All Off' : `All ${x}`}</button>)}
          </div>
        </div>
      ) : tab === 'matrix' ? (
        <div class="po-matrix">
          <p class="muted small">Each cell is the report for a net joining the two kinds of objects; click to change it. A pin, port or sheet entry joined to nothing is the Unconnected column.</p>
          <table class="po-mtable" aria-label="Connection Matrix">
            <thead><tr><th />{CONNECTION_CODES.map((c) => <th key={c} class="po-colhead"><span>{c}</span></th>)}</tr></thead>
            <tbody>
              {CONNECTION_CODES.map((r, i) => (
                <tr key={r}><th class="po-rowhead">{r}</th>
                  {CONNECTION_CODES.map((c, j) => {
                    const l = erc.matrix[i]![j] ?? 0;
                    return <td key={c} class={`po-cell ${LEVEL_CLASS[l]}`} title={`${r} – ${c}: ${ERC_LEVELS[l]}`} aria-label={`${r} to ${c}: ${ERC_LEVELS[l]}`} onClick={() => cycle(i, j)} />;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div class="po-legend">{ERC_LEVELS.map((x, i) => <span key={x}><i class={`po-swatch ${LEVEL_CLASS[i]}`} />{x}</span>)}</div>
        </div>
      ) : tab === 'options' ? (
        <div class="po-options">
          <fieldset><legend>Output Path</legend>
            <label class="do-row" title="Where outputs are written, from the project's folder (Project Outputs for the project when empty)"><span>Output Path</span><input type="text" value={opts.outputPath} onInput={(e) => setOpts({ ...opts, outputPath: (e.target as HTMLInputElement).value })} /></label>
            <label class="do-row"><span>ECO Log Path</span><input type="text" value={opts.logPath} onInput={(e) => setOpts({ ...opts, logPath: (e.target as HTMLInputElement).value })} /></label>
          </fieldset>
          <fieldset><legend>Output Options</legend>
            <div class="po-two">{check('Open outputs after compile', 'openOutputs')}{check('Timestamp folder', 'timestamp')}{check('Archive project document', 'archive')}{check('Use separate folder for each output type', 'separate')}</div>
          </fieldset>
          <fieldset><legend>Netlist Options</legend>
            <div class="po-two">{check('Allow Ports to Name Nets', 'ports')}{check('Append Sheet Numbers to Local Nets', 'appendSheet')}
              {check('Allow Sheet Entries to Name Nets', 'entries')}{check('Higher Level Names Take Priority', 'higherNames')}
              {check('Allow Single Pin Nets', 'singlePin')}{check('Power Port Names Take Priority', 'powerNames')}</div>
          </fieldset>
          <fieldset><legend>Net Identifier Scope</legend>
            <select value={String(opts.scope)} aria-label="Net Identifier Scope" onChange={(e) => setOpts({ ...opts, scope: Number((e.target as HTMLSelectElement).value) })}>
              {NET_SCOPES.map((x, i) => <option key={x} value={String(i)}>{x}</option>)}
            </select>
          </fieldset>
          <fieldset><legend>Allow Pin-Swapping Using These Methods</legend>
            <div class="po-two">{check('Adding / Removing Net-Labels', 'swapLabel')}{check('Changing Schematic Pins', 'swapPin')}</div>
          </fieldset>
        </div>
      ) : (
        <div class="do-params">
          <div class="cp-grid" role="grid" aria-label="Project parameters">
            <div class="do-prow cp-ghead" role="row"><span>Name</span><span>Value</span></div>
            {params.map((p, i) => (
              <div key={i} class={`do-prow${pSel === i ? ' on' : ''}`} role="row" onMouseDown={() => setPSel(i)}>
                <input type="text" value={p.name} aria-label="Parameter name" onInput={(e) => setParams(params.map((q, k) => (k === i ? { ...q, name: (e.target as HTMLInputElement).value } : q)))} />
                <input type="text" value={p.value} aria-label={`${p.name} value`} onInput={(e) => setParams(params.map((q, k) => (k === i ? { ...q, value: (e.target as HTMLInputElement).value } : q)))} />
              </div>
            ))}
          </div>
          <div class="cp-buttons">
            <button class="btn" onClick={() => { setParams([...params, { name: `Parameter${params.length + 1}`, value: '' }]); setPSel(params.length); }}>Add...</button>
            <button class="btn" disabled={pSel === null || !params[pSel]} onClick={() => { setParams(params.filter((_, k) => k !== pSel)); setPSel(null); }}>Remove...</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Place › Directives › Specific No ERC: which violations the marker suppresses. */
export function SpecificNoErcDialog({ onOk, initial = [] }: { onOk: (kinds: string[]) => void; initial?: string[] }) {
  const [on, setOn] = useState<Set<string>>(new Set(initial));
  const [filter, setFilter] = useState('');
  const shown = ERC_KINDS.filter((k) => !filter || k.label.toLowerCase().includes(filter.toLowerCase()));
  const ok = () => { if (!on.size) { notify('Choose at least one violation to suppress', 'error'); return; } closeDialog(); onOk([...on]); };
  return (
    <Dialog title="Specific No ERC" width={520} height={560} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="noercdlg"
      footer={<><span class="muted small">{on.size} selected</span><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <input type="text" placeholder="Filter violations" value={filter} aria-label="Filter violations" onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
      <div class="po-errors">
        {ERC_GROUPS.map((g) => {
          const kinds = shown.filter((k) => k.group === g);
          if (!kinds.length) return null;
          return (
            <Fragment key={g}>
              <div class="po-group"><span>Violations Associated with {g}</span></div>
              {kinds.map((k) => (
                <label key={k.key} class="po-erow po-pick">
                  <input type="checkbox" checked={on.has(k.label)} onChange={(e) => { const n = new Set(on); if ((e.target as HTMLInputElement).checked) n.add(k.label); else n.delete(k.label); setOn(n); }} />
                  <span>{k.label}</span>
                </label>
              ))}
            </Fragment>
          );
        })}
      </div>
    </Dialog>
  );
}
