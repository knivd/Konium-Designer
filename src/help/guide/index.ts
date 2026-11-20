/** The User Guide's chapters, in order. */
import type { Chapter } from '../types';
import { GETTING_STARTED } from './gettingStarted';
import { SCHEMATIC } from './schematic';
import { LIBRARIES } from './libraries';
import { PCB } from './pcb';
import { OUTPUTS } from './outputs';
import { TOOLS } from './tools';
import { GUIDE_REFERENCE } from './reference';

export const GUIDE_CHAPTERS: Chapter[] = [GETTING_STARTED, SCHEMATIC, LIBRARIES, PCB, OUTPUTS, TOOLS, GUIDE_REFERENCE];
