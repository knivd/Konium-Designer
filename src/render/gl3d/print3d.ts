/**
 * Documentation Outputs › PCB 3D Print: the board drawn by 3D Layout Mode's renderer from the
 * top, the bottom and an angle, each a page (the views AD17's default 3D print offers [est]).
 */
import type { PcbDocument } from '../../model/pcb';
import { Viewer3D } from './Viewer3D';
import type { ModelFiles } from './stepBodies';

export const PRINT3D_VIEWS: ['top' | 'bottom' | 'angle', string][] = [['top', 'Top View'], ['bottom', 'Bottom View'], ['angle', 'Isometric View']];

export async function print3dPages(doc: PcbDocument, models: ModelFiles, w = 1600, h = 1000): Promise<{ name: string; svg: string; box: { minX: number; minY: number; maxX: number; maxY: number } }[]> {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-${w + 100}px;top:0;width:${w}px;height:${h}px;`;
  document.body.append(host);
  const v = new Viewer3D(host, () => doc, undefined, () => models);
  try {
    if (v.failed) throw new Error('3D printing needs WebGL 2, which this browser has turned off');
    v.layout();
    await v.ready();
    const c = v.canvasElement;
    const rect = { minX: 0, minY: 0, maxX: Math.round((w / h) * 1_000_000 * 1.6), maxY: 1_600_000 };
    return PRINT3D_VIEWS.map(([kind, name]) => {
      const png = v.snapshot(kind);
      return { name, box: rect, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${c.width} ${c.height}" preserveAspectRatio="xMidYMid meet"><image href="${png}" width="${c.width}" height="${c.height}"/></svg>` };
    });
  } finally {
    v.dispose();
    host.remove();
  }
}
