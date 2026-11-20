/**
 * A part number as it is compared and as it names things. Kept apart from the part's package
 * (partPackage.ts) so that the world library's service can use it without the library readers.
 */

/** A part number as compared: upper case, letters and digits only (as the datasheet finder compares them). */
export const partKey = (mpn: string): string => mpn.toUpperCase().replace(/[^A-Z0-9]/g, '');
/** A part number as a library name: what a file name and a library reference take. */
export const partName = (mpn: string): string => mpn.trim().replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 80) || 'Part';
