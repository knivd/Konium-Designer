/**
 * A character reference's character (&#8364; or &#x20AC;). One that names no character, as a
 * damaged file's may, is the replacement character rather than an error that stops the file
 * being read.
 */
export const charOf = (n: number): string => (Number.isInteger(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '�');
