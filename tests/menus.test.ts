import { describe, expect, it } from 'vitest';
import { commands } from '../src/core/commands';
import { CONTEXT, MENUBAR, POPUPS, TOOLBARS, type MenuSpec } from '../src/app/menus/ad17.gen';
import { parseCaption } from '../src/app/menus';
import { DEFAULT_SHORTCUTS, MENUS } from '../src/app/commands';

function ids(specs: readonly MenuSpec[], out: Set<string>): Set<string> {
  for (const s of specs) {
    if (s === 0 || s.length === 1) continue;
    if (Array.isArray(s[1])) ids(s[1] as MenuSpec[], out); else out.add(s[1] as string);
  }
  return out;
}

describe('AD17 menus', () => {
  it('every menu, popup, context and toolbar command is registered (live or planned)', () => {
    const all = new Set<string>();
    for (const v of Object.values(MENUBAR)) ids(v, all);
    for (const v of Object.values(POPUPS)) ids(v, all);
    for (const v of Object.values(CONTEXT)) if (Array.isArray(v) && Array.isArray(v[1])) ids(v[1] as MenuSpec[], all);
    for (const [, , items] of Object.values(TOOLBARS)) ids(items, all);
    const missing = [...all].filter((id) => !commands.get(id));
    expect(missing).toEqual([]);
  });

  it('run-time lists (outputs, reports, panels) name registered commands', () => {
    const missing = new Set<string>();
    const walk = (n: { command?: string; children?: unknown[] }, d: number) => {
      if (n.command && !n.command.startsWith('file.recent.') && !commands.get(n.command)) missing.add(n.command);
      if (d < 6) for (const c of (n.children ?? []) as never[]) walk(c, d + 1);
    };
    for (const m of MENUS) walk(m, 0);
    expect([...missing]).toEqual([]);
  });

  it('every default shortcut names a registered command', () => {
    expect(DEFAULT_SHORTCUTS.filter((s) => !commands.get(s.command)).map((s) => `${s.combo} ${s.command}`)).toEqual([]);
  });

  it('parses & accelerators', () => {
    expect(parseCaption('Annotate Schematics Q&uietly...')).toEqual({ label: 'Annotate Schematics Quietly...', key: 'U', accelAt: 21 });
    expect(parseCaption('Save && Close')).toEqual({ label: 'Save & Close', key: '', accelAt: undefined });
  });

  it('menu bars follow AD17: schematic, PCB and PCB library', () => {
    const bar = (s: string) => MENUS.filter((m) => m.inMenuBar && m.scopes.includes(s as never)).map((m) => m.label);
    expect(bar('sch')).toEqual(['File', 'Edit', 'View', 'Project', 'Place', 'Design', 'Tools', 'Reports', 'Window', 'Help']);
    expect(bar('pcb')).toEqual(['File', 'Edit', 'View', 'Project', 'Place', 'Design', 'Tools', 'Route', 'Reports', 'Window', 'Help']);
    expect(bar('pcblib')).not.toContain('Route');
    expect(bar('pcblib')).not.toContain('Design');
  });

  it('chains reach Altium items: T, A, U = Annotate Quietly; F, F, G = Gerber', () => {
    const root = (scope: string, k: string) => MENUS.find((m) => m.inMenuBar && m.key === k && m.scopes.includes(scope as never))!;
    const step = (n: { children?: { key: string; command?: string; children?: unknown }[] }, k: string) => n.children!.find((c) => c.key === k)!;
    const t = root('sch', 'T');
    expect(step(step(t, 'A') as never, 'U').command).toBe('tools.annotateQuietly');
    const f = root('pcb', 'F');
    expect(step(step(f, 'F') as never, 'G').command).toBe('output.gerber');
  });
});
