import { useEffect, useRef } from 'preact/hooks';
import { Viewer3D } from '../../render/gl3d/Viewer3D';
import { footprintDoc } from '../../model/pcbLib';
import type { Footprint } from '../../formats/altium/pcblib';

/**
 * A footprint in 3D (Browse Libraries' and the PCB Model dialog's 3D button): its pads, silk and
 * 3D bodies on a board sized round it, turned with the mouse as in 3D Layout Mode. STEP models
 * show when the footprint's library embeds them [est: linked models aren't looked for here].
 */
export function Footprint3D({ footprint, size }: { footprint: Footprint; size: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const doc = footprintDoc(footprint.name, footprint.records);
    const v = new Viewer3D(host.current, () => doc, undefined, () => new Map());
    return () => v.dispose();
  }, [footprint]);
  return <div ref={host} class="fp3d" style={{ width: `${size}px`, height: `${size}px`, position: 'relative' }} aria-label={`${footprint.name} in 3D`} />;
}
