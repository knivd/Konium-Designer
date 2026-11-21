/**
 * Words that follow a number, said whole. A sentence in Konium Designer is written as one piece
 * with its numbers put into it, never glued from pieces of sentences: glued pieces can't be put
 * into another language, where the order of the words, the plural and what agrees with what all
 * differ. This is the one place where a number picks a word; new code uses it and adds no "s" by
 * hand (docs/ARCHITECTURE.md, Interface standards).
 */

/** The noun for a count: "part" or "parts" (the plural given where it is not the noun with an s). */
export const noun = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);
/** A count with its noun: "1 part", "3 parts", "2 net classes". */
export const count = (n: number, one: string, many = `${one}s`): string => `${n} ${noun(n, one, many)}`;
