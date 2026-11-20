/**
 * Design › Import From Child Projects (the multi-board schematic): each module's child project
 * compiled, its connectors (parts whose System parameter is Connector, as AD marks them) taken
 * into the module with their pins and the nets on them, and an entry for each connector the
 * module hasn't one for, docked on its right side. Entries already there keep their place.
 */
import { compileProject } from '../model/compile';
import { change, nextMbsId, type MbsDocument, type MbsItem, type MbsModule } from '../formats/altium/multiboard';
import { compileOptions, projectSheets } from './project';
import { projects, type Project } from './state';

const childOf = (m: MbsModule): Project | null => {
  const n = (m.source?.sourceProject ?? '').split(/[\\/]/).pop()?.toLowerCase();
  return n ? projects.value.find((p) => p.name.toLowerCase() === n) ?? null : null;
};

export function importFromChildren(d: MbsDocument): { modules: number; connectors: number; entries: number; missing: string[] } {
  const res = { modules: 0, connectors: 0, entries: 0, missing: [] as string[] };
  const page = d.pages[0];
  const plans: { m: MbsModule; comps: MbsModule['components']; newEntries: MbsModule['entries']; map: { key: number; value: number }[]; items: MbsItem[] }[] = [];
  for (const m of d.logical.modules) {
    const p = childOf(m);
    if (!p) { res.missing.push(m.source?.sourceProject ?? m.designator); continue; }
    const sheets = projectSheets(p).filter((s) => /\.schdoc$/i.test(s.name));
    if (!sheets.length) { res.missing.push(p.name); continue; }
    const c = compileProject(sheets, compileOptions(p));
    const netOf = new Map<string, string>();
    for (const n of c.nets) for (const pin of n.pins) netOf.set(`${pin.designator}\u0000${pin.pin}`.toUpperCase(), n.name);
    const comps: MbsModule['components'] = [];
    for (const comp of c.components) {
      const sys = Object.entries(comp.params).find(([k]) => k.toLowerCase() === 'system')?.[1];
      if (!/^connector$/i.test((sys ?? '').trim())) continue;
      const pins = new Map<string, string>();
      for (const n of c.nets) for (const pin of n.pins) if (pin.designator === comp.designator && !pins.has(pin.pin)) pins.set(pin.pin, pin.name);
      const list = [...pins].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
      comps.push({
        designator: comp.designator, comment: comp.comment, id: nextMbsId(d),
        pins: list.map(([num, name]) => {
          const net = netOf.get(`${comp.designator}\u0000${num}`.toUpperCase());
          return { pinId: num, name: name || num, number: num, parameters: net ? [{ name: 'ExternalNetName', value: net, id: nextMbsId(d) }] : [], id: nextMbsId(d) };
        }),
      });
    }
    // An entry for each connector without one, docked on the right, below those there
    const rect = page?.data.items.find((i) => i.$type === '__drawingModule' && i.logicalObjectId === m.id);
    const newEntries: MbsModule['entries'] = [], items: MbsItem[] = [], map: { key: number; value: number }[] = [];
    let k = (m.entries ?? []).length;
    for (const comp of comps) {
      let e = (m.entries ?? []).find((x) => (x.definedDesignator || x.calculatedDesignator) === comp.designator);
      if (!e) {
        e = { calculatedDesignator: comp.designator, id: nextMbsId(d) };
        (e as { parameters?: unknown[] }).parameters = [];
        newEntries.push(e);
        if (rect) items.push({ $type: '__drawingModuleEntry', offset: { y: -((rect.rect?.height ?? 100) - 30 - k * 24) }, logicalObjectId: e.id, lineStyleId: 2, fillStyleId: 2, dockType: 2, anchor: 5, parentId: rect.id, selectable: true, id: nextMbsId(d) });
        k++;
      }
      for (const pin of comp.pins) map.push({ key: pin.id, value: e.id });
    }
    plans.push({ m, comps, newEntries, map, items });
    res.modules++; res.connectors += comps.length; res.entries += newEntries.length;
  }
  if (!plans.length) return res;
  const before = plans.map((x) => ({ comps: x.m.components, entries: x.m.entries, map: x.m.entryPinMap }));
  change(d, 'Import From Child Projects', () => {
    for (const x of plans) {
      x.m.components = x.comps;
      x.m.entries = [...(x.m.entries ?? []), ...x.newEntries];
      x.m.entryPinMap = { map: x.map };
      if (page) page.data.items.push(...x.items);
    }
  }, () => {
    plans.forEach((x, i) => {
      x.m.components = before[i]!.comps; x.m.entries = before[i]!.entries; x.m.entryPinMap = before[i]!.map;
      if (page) page.data.items = page.data.items.filter((it) => !x.items.includes(it));
    });
  });
  return res;
}
