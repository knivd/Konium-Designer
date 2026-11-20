/**
 * The app's names before Konium Designer, as what was saved under them carries them (browser
 * storage, the browser's databases, markers in files): read once and moved over to the present
 * name. Each is made from the present one (they differ from it in two letters), the most recent
 * first: where both have a value, that one's is taken.
 */
const PRESENT = 'konium';
export const FORMERS: readonly string[] = ['v', 'l'].map((c) => PRESENT.replace('k', 'j').replace('n', c));
/** As board keys have them (upper case). */
export const FORMERS_UP: readonly string[] = FORMERS.map((f) => f.toUpperCase());
/** As record types have them (a capital first). */
export const FORMERS_CAP: readonly string[] = FORMERS.map((f) => f.charAt(0).toUpperCase() + f.slice(1));
/** The first of an object's values under a former name with this ending (the most recent name's). */
export const formerValue = (o: Record<string, unknown>, end = ''): unknown => FORMERS.map((f) => o[f + end]).find((v) => v !== undefined);
