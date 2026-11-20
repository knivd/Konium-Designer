import { useMemo, useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { PromptDialog, ConfirmDialog } from './Confirm';
import { notify } from '../state';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { itemChange } from '../../model/pcbEco';
import { removeNet, renameNet } from '../../model/pcbEdit';
import { NO_NET } from '../../model/pcb';

const ALL = '<All Nets>';

/**
 * Design › Netlist › Edit Nets (Netlist Manager): the net classes, the nets of the one picked
 * (Add, Edit to rename, Delete: its objects left on No Net) and the pins of the focused net.
 */
export function NetlistManagerDialog({ ed }: { ed: PcbEditor }) {
  const doc = ed.doc;
  const [, setRev] = useState(0);
  const refresh = () => { setRev((r) => r + 1); ed.invalidate(); };
  const classes = [ALL, ...doc.classes.filter((c) => c.kind === 0 && !c.superClass).map((c) => c.name)];
  const [cls, setCls] = useState(ALL);
  const members = cls === ALL ? null : new Set(doc.classes.find((c) => c.kind === 0 && c.name === cls)?.members.map((m) => m.toLowerCase()) ?? []);
  const nets = doc.nets.filter((n) => !members || members.has(n.name.toLowerCase()));
  const [focus, setFocus] = useState<number | null>(nets[0]?.index ?? null);
  const net = focus !== null ? doc.nets[focus] : undefined;
  const pins = useMemo(() => (net ? doc.prims.filter((p) => p.kind === 'pad' && p.net === net.index).map((p) => {
    const pad = p as { component: number; name: string };
    return `${pad.component !== NO_NET ? doc.components[pad.component]?.designator ?? '?' : 'Free'}-${pad.name}`;
  }).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : []), [net, doc.prims]);
  const taken = (name: string, except?: number) => doc.nets.some((n) => n.index !== except && n.name.toLowerCase() === name.toLowerCase());
  const add = () => showDialog(PromptDialog, { title: 'Edit Net', fields: [{ label: 'Net Name', value: `NewNet${doc.nets.length + 1}` }], onOk: ([v]: string[]) => {
    const name = (v ?? '').trim();
    if (!name || taken(name)) { notify(name ? `A net named ${name} already exists` : 'Give the net a name', 'error'); return; }
    ed.undo.transact(`Add net ${name}`, (tx) => tx.add(itemChange(doc, { kind: 'addNet', group: 'Add Nets', action: 'Add', object: name, net: name }, () => undefined)));
    setFocus(doc.nets.length - 1); refresh();
  } });
  const edit = () => { if (!net) return; showDialog(PromptDialog, { title: 'Edit Net', fields: [{ label: 'Net Name', value: net.name }], onOk: ([v]: string[]) => {
    const name = (v ?? '').trim();
    if (!name || name === net.name) return;
    if (taken(name, net.index)) { notify(`A net named ${name} already exists`, 'error'); return; }
    ed.undo.transact(`Rename net ${net.name} to ${name}`, (tx) => tx.add(renameNet(doc, net.index, name))); refresh();
  } }); };
  const del = () => { if (!net) return; showDialog(ConfirmDialog, { message: `Delete net ${net.name}? Its ${pins.length} pins and routing are left on No Net.`, onYes: () => {
    ed.undo.transact(`Delete net ${net.name}`, (tx) => tx.add(removeNet(doc, net.index))); setFocus(null); refresh();
  } }); };
  return (
    <Dialog title="Netlist Manager" width={900} height={560} onClose={closeDialog} class="netmgr"
      footer={<><span class="muted small">{doc.nets.length} nets</span><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <div class="nm-cols">
        <fieldset><legend>Net Classes</legend>
          <div class="nm-list"><Grid rows={classes} sel={classes.indexOf(cls)} onSel={(i) => { setCls(classes[i]!); setFocus(null); }} cols={[{ label: 'Class', get: (c: string) => c }]} /></div>
        </fieldset>
        <fieldset><legend>Nets In Class</legend>
          <div class="nm-list"><Grid rows={nets} sel={net ? nets.indexOf(net) : null} onSel={(i) => setFocus(nets[i]!.index)} onOpen={(i) => { setFocus(nets[i]!.index); setTimeout(edit, 0); }} empty="No nets."
            cols={[{ label: 'Net', get: (n: { name: string }) => n.name }]} /></div>
          <div class="nm-buttons"><button class="btn" onClick={add} disabled={cls !== ALL} title={cls !== ALL ? 'Add nets under <All Nets>' : undefined}>Add...</button>
            <button class="btn" onClick={edit} disabled={!net}>Edit...</button><button class="btn" onClick={del} disabled={!net}>Delete...</button></div>
        </fieldset>
        <fieldset><legend>Pins In Focused Net</legend>
          <div class="nm-list"><Grid rows={pins} empty={net ? 'No pins.' : 'Pick a net.'} cols={[{ label: 'Pin', get: (p: string) => p }]} /></div>
        </fieldset>
      </div>
    </Dialog>
  );
}
