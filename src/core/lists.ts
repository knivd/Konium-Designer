/**
 * Lists of any length. A call takes only so many arguments (about 120,000 in Chromium), and
 * push(...items) passes every item as one: with a large board's worth of them (a routing session's
 * tracks, a hatched pour) it fails with "Maximum call stack size exceeded". These go one by one.
 */

/** Every item added to the end of a list. */
export function pushAll<T>(to: T[], items: ArrayLike<T>): void {
  for (let i = 0; i < items.length; i++) to.push(items[i]!);
}
