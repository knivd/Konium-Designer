/**
 * Files of the 1990s' programs that are known by their first bytes and not read here (26.188):
 * what each is, and the way to get it in. Their layouts are not public and no file of them has
 * been seen beside the same design in a format that is read, so nothing is guessed: the file is
 * named for what it is and the desktop software, which opens them all, is the way in.
 *
 * Read: the board text format `PCB FILE 6` (formats/protel/pcbAscii) and the binary boards of
 * version 5.0 (formats/altium/pcb5).
 */
import { bytesToBin } from '../text';
import { isCfb } from '../cfb/cfb';

export interface OlderFile { /** What the file is, as a phrase after "a" ("PCB 4.0 binary board"). */ what: string; /** How to get it in. */ way: string }

const BOARD_WAY = 'Open it in the desktop software and save it as a .PcbDoc (or as PCB ASCII, or PCB 2.8 ASCII), then open that';

/** The file as one of those formats, or null. */
export function olderFile(name: string, bytes: Uint8Array): OlderFile | null {
  if (isCfb(bytes)) return null;
  const head = bytesToBin(bytes.subarray(0, 160));
  const board = /PCB ([34])\.0 Binary File/.exec(head);
  if (board) return { what: `PCB ${board[1]}.0 binary board`, way: BOARD_WAY };
  // (the board formats before those, binary and text; version 6 of the text one is read)
  const file = /PCB FILE (\d+)/.exec(head);
  if (file && file[1] !== '6') return { what: `board in an early format (PCB FILE ${file[1]})`, way: BOARD_WAY };
  if (!head.startsWith('|HEADER=')) {
    const sch = /Protel for Windows - Schematic (Capture|Library Editor) (Binary|Ascii) File Version (\d[\d.]*)/.exec(head);
    if (sch) return { what: `${sch[1] === 'Capture' ? 'schematic' : 'schematic library'} in the ${sch[2] === 'Binary' ? 'binary' : 'text'} format of the 1990s (version ${sch[3]})`,
      way: `Open it in the desktop software and save it as a ${sch[1] === 'Capture' ? '.SchDoc' : '.SchLib'}, then open that` };
  }
  if (/\.ddb$/i.test(name) && head.slice(4, 19) === 'Standard Jet DB') return { what: 'design database (.ddb)', way: 'The desktop software\'s Import Wizard unpacks it into a project, whose documents open here' };
  return null;
}
