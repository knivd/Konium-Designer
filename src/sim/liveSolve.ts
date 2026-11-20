/**
 * Solve for a value (26.186): the value of a part at which something read of the circuit comes to
 * a target. `at(x)` is the reading with the value x (NaN where the circuit has no solution there).
 * The value is looked for across its range where it has one (a potentiometer's position), else
 * four decades either side of what it is now, else (a value that is nothing, or under it: an
 * offset) ten times its size either way; of the places where the reading passes the target, the
 * one nearest to what the value is now is narrowed to four figures.
 */
export type Sought =
  | { found: true; value: number; reads: number }
  /** No value does it: where it was looked for, and what the reading came to there (NaN: the circuit had no solution anywhere). */
  | { found: false; from: number; to: number; least: number; most: number };

export function solveValue(at: (x: number) => number, target: number, now: number, range?: readonly [number, number]): Sought {
  const log = !range && now > 0;
  const grid: number[] = range ? Array.from({ length: 41 }, (_, k) => range[0] + (range[1] - range[0]) * k / 40)
    : log ? Array.from({ length: 33 }, (_, k) => now * 10 ** ((k - 16) / 4))
      : Array.from({ length: 41 }, (_, k) => (k - 20) / 2 * Math.max(1, Math.abs(now)));
  const ys = grid.map(at), dist = (x: number) => (log ? Math.abs(Math.log(x / now)) : Math.abs(x - now));
  let best = -1;
  for (let k = 0; k + 1 < grid.length; k++) {
    const a = ys[k]! - target, b = ys[k + 1]! - target;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a * b > 0) continue;
    if (best < 0 || Math.min(dist(grid[k]!), dist(grid[k + 1]!)) < Math.min(dist(grid[best]!), dist(grid[best + 1]!))) best = k;
  }
  if (best < 0) {
    const seen = ys.filter(Number.isFinite);
    return { found: false, from: grid[0]!, to: grid[grid.length - 1]!, least: seen.length ? Math.min(...seen) : NaN, most: seen.length ? Math.max(...seen) : NaN };
  }
  let lo = grid[best]!, hi = grid[best + 1]!, flo = ys[best]! - target, exact = flo === 0 ? lo : ys[best + 1]! - target === 0 ? hi : NaN;
  for (let n = 0; n < 48 && Number.isNaN(exact); n++) {
    const mid = log ? Math.sqrt(lo * hi) : (lo + hi) / 2, f = at(mid) - target;
    if (!Number.isFinite(f)) break;
    if (f === 0) exact = mid; else if (f * flo < 0) hi = mid; else { lo = mid; flo = f; }
  }
  const value = Number((Number.isNaN(exact) ? (log ? Math.sqrt(lo * hi) : (lo + hi) / 2) : exact).toPrecision(4));
  return { found: true, value, reads: at(value) };
}
