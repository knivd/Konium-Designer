import { describe, expect, it } from 'vitest';
import toolbarSrc from '../src/app/Toolbar.tsx?raw';
import iconsSrc from '../src/app/icons.tsx?raw';

/** Commands that do the same thing in another place may share a picture; nothing else does. */
const SAME = [
  ['file.open', 'wm.openDoc'], ['file.save', 'wm.saveDoc'], ['file.saveAll', 'wm.saveCategory'], ['file.saveAs', 'wm.saveDocAs'], ['edit.copy', 'msg.copy'],
  ['tools.erc', 'wm.compileProject', 'wm.recompileProject', 'tools.recompile'], ['ad:Sch:SetSnapGrid', 'ad:PCB:PopupSnapGridOther'],
  // A room command and its right-click form for the room under the cursor
  ...['Move', 'EditRoomVertices', 'Autoroute', 'UnRoute', 'SelectRoomConnections', 'Cut', 'WrapRoomsAroundComponentsNonOrtho', 'WrapRoomsAroundComponentsOrtho', 'WrapRoomsAroundComponentsBoundingRect']
    .map((k) => [`ad:PCB:${k}${/^(Move|Autoroute|UnRoute|Cut)$/.test(k) ? 'Room' : ''}`, `ad:PCB:${k.replace('RoomVertices', 'SingleRoomVertices').replace('RoomConnections', 'SingleRoomConnections').replace('Rooms', 'SingleRoom')}${/^(Move|Autoroute|UnRoute|Cut)$/.test(k) ? 'SingleRoom' : ''}`]),
];

describe('toolbar and menu icons', () => {
  it('different commands never share an icon', () => {
    const src = toolbarSrc;
    const a = src.indexOf('const ICONS'), b = src.indexOf('};', a);
    const byIcon = new Map<string, string[]>();
    for (const [, cmd, icon] of src.slice(a, b).matchAll(/'([^']+)':\s*'([^']+)'/g)) byIcon.set(icon!, [...(byIcon.get(icon!) ?? []), cmd!]);
    const shared = [...byIcon.values()].filter((cmds) => cmds.length > 1);
    for (const cmds of shared) expect(SAME.some((g) => cmds.every((c) => g.includes(c)))).toBe(true);
    // Every icon named is drawn
    const icons = iconsSrc;
    for (const icon of byIcon.keys()) expect(icons.includes(`  ${icon}: `)).toBe(true);
  });
});

import { MENUBAR, POPUPS, CONTEXT, TOOLBARS, type MenuSpec } from '../src/app/menus/ad17.gen';
import { iconFor } from '../src/app/Toolbar';

describe('icons as menus and toolbars show them', () => {
  it('every command in a menu or toolbar has a picture of its own (or none)', () => {
    const seen = new Map<string, Set<string>>();
    const walk = (s: MenuSpec, scope: string) => {
      if (!s) return;
      if (s.length === 2 && typeof s[1] === 'string') {
        const icon = iconFor(s[1], scope as never);
        if (icon) { const k = `${scope}|${icon}`; seen.set(k, new Set([...(seen.get(k) ?? []), s[1]])); }
        return;
      }
      if (Array.isArray(s[1])) for (const c of s[1]) walk(c, scope);
    };
    for (const [scope, list] of [...Object.entries(MENUBAR), ...Object.entries(POPUPS)]) for (const m of list) walk(m, scope);
    for (const [scope, m] of Object.entries(CONTEXT)) walk(m, scope);
    for (const [scope, , list] of Object.values(TOOLBARS)) for (const m of list) walk(m, scope);
    const shared = [...seen].filter(([, cmds]) => cmds.size > 1 && !SAME.some((g) => [...cmds].every((c) => g.includes(c))));
    expect(shared.map(([k, cmds]) => `${k}: ${[...cmds].join(', ')}`)).toEqual([]);
  });
});
