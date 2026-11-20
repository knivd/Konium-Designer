import type { BBox } from '../core/geom';

export type DocKind = 'SchDoc' | 'PcbDoc' | 'PrjPcb' | 'SchLib' | 'PcbLib' | 'IntLib' | 'OutJob' | 'BomDoc' | 'DbLink' | 'DbLib' | 'StepDoc' | 'SimText' | 'SimData' | 'CamDoc' | 'Draftsman' | 'MbsDoc' | 'MbaDoc' | 'Diagram' | 'Enclosure' | 'ReqDoc' | 'Unknown';

export interface Diagnostic {
  level: 'info' | 'warn' | 'error';
  message: string;
  where?: string;
}

export class Diagnostics {
  readonly items: Diagnostic[] = [];
  info(message: string, where?: string): void { this.items.push({ level: 'info', message, where }); }
  warn(message: string, where?: string): void { this.items.push({ level: 'warn', message, where }); }
  error(message: string, where?: string): void { this.items.push({ level: 'error', message, where }); }
}

/** Packed 0xRRGGBB. Altium stores colours as Windows COLORREF (0x00BBGGRR). */
export type Rgb = number;
export const fromBgr = (c: number): Rgb => ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff);
export const toBgr = (c: Rgb): number => ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff);

export interface HasBounds { bounds(): BBox }
