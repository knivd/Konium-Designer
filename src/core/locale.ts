/**
 * The language dates, times and numbers are written in: Britain's (en-GB), or with System ›
 * General › Use localised resources on, this computer's (Konium's own words stay English).
 */
import { settings } from './settings';

export const locale = (): string | undefined => (settings.localised ? undefined : 'en-GB');
