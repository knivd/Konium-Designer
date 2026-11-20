import { signal } from '@preact/signals';
import type { ComponentType } from 'preact';
import { ownerOf, uiWin, useWin } from '../docWindows';

/**
 * One place that shows the feature dialogs (Compile, Rules, DRC, ECO, outputs …). A command
 * opens one with showDialog(Component, props); the component closes itself with closeDialog().
 */
/** win: the window it opened in (a document window's command opens it there). */
interface Open { C: ComponentType<Record<string, unknown>>; props: Record<string, unknown>; win: Window }
const stack = signal<Open[]>([]);
/** The open dialogs, top last (scripts and tests read what a command asks). */
export const dialogStack = stack;

export function showDialog<P extends object>(C: ComponentType<P>, props: P = {} as P): void {
  stack.value = [...stack.value, { C: C as unknown as ComponentType<Record<string, unknown>>, props: props as Record<string, unknown>, win: uiWin.peek() }];
}
export function closeDialog(): void { stack.value = stack.value.slice(0, -1); }
export const dialogOpen = () => stack.value.length > 0;

export function Dialogs() {
  const here = useWin();
  return <>{stack.value.map(({ C, props, win }, i) => (ownerOf(win) === here ? <C key={i} {...props} /> : null))}</>;
}
