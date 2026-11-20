import { settings } from '../core/settings';
import { nextName } from '../model/schPlace';

/** The next name on placement as Preferences › Schematic › Graphical Editing › Auto-Increment sets it. */
export const autoNext = (s: string, secondary = false): string =>
  nextName(s, secondary ? settings.schIncSecondary : settings.schIncPrimary, settings.schRemoveLeadingZeroes);
