import { describe, expect, it } from 'vitest';
import { KeyRouter, normaliseKey, type MenuRoot, type Shortcut } from '../src/core/keymap';
import { commands } from '../src/core/commands';

const ran: string[] = [];
commands.register(
  { id: 't.wire', label: 'Wire', scopes: ['sch'], run: () => { ran.push('wire'); } },
  { id: 't.track', label: 'Track', scopes: ['pcb'], run: () => { ran.push('track'); } },
  { id: 't.undo', label: 'Undo', run: () => { ran.push('undo'); } },
  { id: 't.units', label: 'Units', scopes: ['pcb'], run: () => { ran.push('units'); } },
);
const shortcuts: Shortcut[] = [{ combo: 'Ctrl+Z', command: 't.undo' }, { combo: 'Q', command: 't.units', scopes: ['pcb'] }];
const roots: MenuRoot[] = [
  { key: 'P', label: 'Place', scopes: ['sch'], inMenuBar: true, children: [{ key: 'W', label: 'Wire', command: 't.wire' }] },
  { key: 'P', label: 'Place', scopes: ['pcb'], inMenuBar: true, children: [{ key: 'T', label: 'Track', command: 't.track' }] },
];

describe('normaliseKey', () => {
  const k = (key: string, m: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
    normaliseKey({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...m });
  it('canonicalises', () => {
    expect(k('z', { ctrlKey: true })).toBe('Ctrl+Z');
    expect(k('S', { shiftKey: true })).toBe('Shift+S');
    expect(k('*', { shiftKey: true })).toBe('*');
    expect(k(' ')).toBe('Space');
    expect(k(' ', { shiftKey: true })).toBe('Shift+Space');
    expect(k('PageDown', { ctrlKey: true })).toBe('Ctrl+PageDown');
  });
});

describe('KeyRouter', () => {
  it('runs accelerator chains per scope', () => {
    const r = new KeyRouter(() => shortcuts, () => roots);
    ran.length = 0;
    expect(r.handle('P', 'sch')).toBe(true);
    expect(r.chainActive).toBe(true);
    r.handle('W', 'sch');
    expect(ran).toEqual(['wire']);
    r.handle('P', 'pcb'); r.handle('T', 'pcb');
    expect(ran).toEqual(['wire', 'track']);
  });

  it('direct shortcuts beat chains; tools beat both; unknown chain key cancels', () => {
    const r = new KeyRouter(() => shortcuts, () => roots);
    ran.length = 0;
    r.handle('Q', 'pcb');
    r.handle('Ctrl+Z', 'sch');
    expect(ran).toEqual(['units', 'undo']);
    expect(r.handle('Ctrl+Z', 'sch', (c) => c === 'Ctrl+Z')).toBe(true);
    expect(ran).toHaveLength(2);
    r.handle('P', 'sch'); r.handle('X', 'sch');
    expect(r.chainActive).toBe(false);
    expect(r.handle('Q', 'sch')).toBe(false); // pcb-only
  });
});
