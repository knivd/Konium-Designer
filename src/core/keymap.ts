import { commands, scopeIncludes, type Scope } from './commands';
import { Emitter } from './events';

/**
 * Altium-style keyboard model:
 *  1. Active tool gets first refusal (Space, Tab, Esc, Shift+Space, Backspace, * while placing).
 *  2. Direct shortcuts (Ctrl+Z, PgUp, Q, G, Shift+S …), scope-specific before global.
 *  3. Accelerator chains: an unmodified letter opens a menu (P = Place, J = Jump …) at the
 *     cursor; the next letter picks an item. P then W = Place › Wire.
 */

export interface AccelNode {
  key: string;              // single uppercase letter/digit; '' = not reachable by chain
  label: string;
  /** Index of the underlined accelerator letter in label (from Altium's & marker). */
  accelAt?: number;
  command?: string;
  /** For generated items (recent files, open windows): run directly. */
  action?: () => void;
  /** Shown but not available (an empty dynamic list's placeholder, a planned list entry). */
  disabled?: boolean;
  checked?: boolean;
  /** The shortcut shown beside an item that runs an action (a command's comes from the keymap). */
  hint?: string;
  children?: AccelNode[];
  separatorBefore?: boolean;
}

export interface MenuRoot extends AccelNode {
  scopes: Scope[];
  /** Shown in the menu bar. False = popup-only chain root (J, M, S, X, Z …). */
  inMenuBar: boolean;
  /** Alt+letter opens it from the menu bar (its & accelerator). */
  alt?: string;
  /** Shown only while this holds (a diagram's own menus). */
  when?: () => boolean;
  children: AccelNode[];
}

export interface Shortcut {
  combo: string; command: string; scopes?: Scope[];
  /** Editors its scopes take in (a library editor, through its document editor's scope) that the key leaves out. */
  except?: Scope[];
}

export interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; code?: string }

const NAMED: Record<string, string> = {
  ' ': 'Space', Esc: 'Escape', Del: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
};

/** Canonical combo string: "Ctrl+Shift+S", "Shift+S", "S", "*", "PageUp", "Space". Meta maps to Ctrl. */
export function normaliseKey(e: KeyLike): string {
  let k = NAMED[e.key] ?? e.key;
  // Another script's letter (a Cyrillic or Greek layout): the key it is on, as Altium's shortcuts follow keys
  if (k.length === 1 && k.charCodeAt(0) > 127 && e.code) { const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code); if (m) k = m[1] ?? m[2]!; }
  if (k.length === 1) k = k.toUpperCase();
  const isLetter = /^[A-Z0-9]$/.test(k);
  const printable = k.length === 1 && !isLetter;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return k;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  // Shift is implied by the character for punctuation (*, +, _, …)
  // … except on the numeric keypad, where Shift+* (previous signal layer) is its own key
  if (e.shiftKey && (!printable || e.code?.startsWith('Numpad'))) mods.push('Shift');
  return [...mods, k].join('+');
}

/** source 'key' = started by a letter shortcut; 'ui' = menu bar, context menu, buttons. */
export interface ChainState { path: AccelNode[]; scope: Scope; source: 'key' | 'ui' }

export class KeyRouter {
  private pending: AccelNode[] | null = null;
  private pendingScope: Scope = 'global';
  private pendingSource: 'key' | 'ui' = 'ui';
  readonly chain = new Emitter<ChainState | null>();

  constructor(
    private shortcuts: () => Shortcut[],
    private roots: () => MenuRoot[],
  ) {}

  get chainActive(): boolean { return this.pending !== null; }

  cancelChain(): void {
    if (!this.pending) return;
    this.pending = null;
    this.chain.emit(null);
  }

  /** Start a chain programmatically (e.g. from a menu bar click). */
  openChain(root: AccelNode, scope: Scope, source: 'key' | 'ui' = 'ui'): void {
    this.pending = [root];
    this.pendingScope = scope;
    this.pendingSource = source;
    this.chain.emit({ path: this.pending, scope, source });
  }

  /** Step into a submenu picked with the mouse (it may have no accelerator letter). */
  openChild(child: AccelNode): void {
    if (!this.pending || !child.children) return;
    const at = this.pending.indexOf(child);
    if (at >= 0) return;
    this.pending = [...this.pending, child];
    this.chain.emit({ path: this.pending, scope: this.pendingScope, source: this.pendingSource });
  }

  /** Back to an earlier level of the open chain (the mouse moved onto a parent menu's item). */
  truncate(depth: number): void {
    if (!this.pending || this.pending.length <= depth) return;
    this.pending = this.pending.slice(0, depth);
    this.chain.emit({ path: this.pending, scope: this.pendingScope, source: this.pendingSource });
  }

  /** Returns true if the key was consumed. */
  handle(combo: string, scope: Scope, toolKey?: (combo: string) => boolean): boolean {
    if (this.pending) return this.stepChain(combo);
    if (toolKey?.(combo)) return true;

    const sc = this.shortcuts();
    const here = (s: Shortcut) => s.combo === combo && !s.except?.includes(scope);
    const hit = sc.find((s) => here(s) && !!s.scopes && scopeIncludes(s.scopes, scope) && commands.isLive(s.command, scope))
      ?? sc.find((s) => here(s) && !s.scopes && commands.isLive(s.command, scope));
    if (hit) { commands.run(hit.command, scope); return true; }

    if (/^[A-Z]$/.test(combo)) {
      const root = this.roots().find((r) => r.key === combo && r.scopes.includes(scope));
      if (root) { this.openChain(root, scope, 'key'); return true; }
    }
    // Alt+letter: the menu bar menu with that accelerator, as Windows menus open
    const alt = /^Alt\+([A-Z])$/.exec(combo);
    if (alt) {
      const root = this.roots().find((r) => r.inMenuBar && r.alt === alt[1] && r.scopes.includes(scope) && (!r.when || r.when()));
      if (root) { this.openChain(root, scope, 'ui'); return true; }
    }
    // An Altium key for something not built yet says so (Tab keeps moving the focus, Alt+F4 stays the system's)
    if (combo !== 'Tab' && combo !== 'Shift+Tab' && combo !== 'Alt+F4') {
      const planned = sc.find((s) => here(s) && (!s.scopes || scopeIncludes(s.scopes, scope)) && commands.get(s.command)?.planned && scopeIncludes(commands.get(s.command)!.scopes, scope));
      if (planned) { void commands.get(planned.command)!.run(); return true; }
    }
    return false;
  }

  private stepChain(combo: string): boolean {
    const node = this.pending!.at(-1)!;
    if (combo === 'Escape') { this.cancelChain(); return true; }
    const child = node.children?.find((c) => c.key && c.key === combo && !c.disabled);
    if (!child) { this.cancelChain(); return true; }
    if (child.children?.length) {
      this.pending = [...this.pending!, child];
      this.chain.emit({ path: this.pending, scope: this.pendingScope, source: this.pendingSource });
      return true;
    }
    const scope = this.pendingScope;
    this.cancelChain();
    if (child.action) child.action();
    else if (child.command) {
      const c = commands.get(child.command);
      if (c?.planned) void c.run(); else commands.run(child.command, scope);
    }
    return true;
  }
}
