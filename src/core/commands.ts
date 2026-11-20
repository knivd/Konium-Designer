/**
 * Every user action is a command with a stable id. Menus, shortcuts, accelerator chains,
 * toolbars and (later) scripting all invoke commands by id, never functions directly.
 */
export type Scope = 'global' | 'sch' | 'pcb' | 'schlib' | 'pcblib' | 'inspect' | 'simview' | 'simtext' | 'cam';

/** A library editor is a kind of its document editor: PCB Library commands include PCB ones. */
const PARENT: Partial<Record<Scope, Scope>> = { pcblib: 'pcb', schlib: 'sch' };
export function scopeIncludes(scopes: readonly Scope[] | undefined, scope: Scope): boolean {
  if (!scopes) return true;
  if (scopes.includes(scope) || scopes.includes('global')) return true;
  const p = PARENT[scope];
  return !!p && scopes.includes(p);
}

export interface Command {
  id: string;
  label: string;
  /** Menu caption that follows the document (Altium's "Compile PCB Project X.PrjPcb"); & marks the accelerator. */
  caption?(): string | undefined;
  /** Scopes where the command is live. Omitted = global. */
  scopes?: Scope[];
  run(): unknown;
  enabled?(): boolean;
  checked?(): boolean;
  /** Shown in menus for not-yet-built features. */
  planned?: boolean;
  /** One of a list that follows the document (the violations at the cursor): left out of menus while it isn't enabled. */
  dynamic?: boolean;
}

class CommandRegistry {
  private map = new Map<string, Command>();

  register(...cmds: Command[]): void {
    for (const c of cmds) {
      if (this.map.has(c.id)) throw new Error(`Duplicate command id ${c.id}`);
      this.map.set(c.id, c);
    }
  }

  get(id: string): Command | undefined { return this.map.get(id); }

  isLive(id: string, scope: Scope): boolean {
    const c = this.map.get(id);
    if (!c || c.planned) return false;
    if (!scopeIncludes(c.scopes, scope)) return false;
    return c.enabled ? c.enabled() : true;
  }

  /** The command run last (View › Command Status names it while its tool is working). */
  last: Command | null = null;
  /** Told when a command fails (thrown, or its promise rejected): the app shows it. */
  onError: ((c: Command, e: unknown) => void) | null = null;
  /** Told of every command run (a macro being recorded). */
  readonly observers = new Set<(c: Command, scope: Scope) => void>();

  run(id: string, scope: Scope): boolean {
    const c = this.map.get(id);
    if (!c || !this.isLive(id, scope)) return false;
    this.last = c;
    for (const o of this.observers) o(c, scope);
    try {
      const r = c.run();
      if (r instanceof Promise) r.catch((e) => this.onError?.(c, e));
    } catch (e) { this.onError?.(c, e); }
    return true;
  }

  all(): Command[] { return [...this.map.values()]; }
}

export const commands = new CommandRegistry();
