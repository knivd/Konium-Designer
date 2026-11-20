import { useEffect, useRef, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import type { ModelViewKind, PictureOptions } from '../../render/gl3d/ModelView';
import { LIGHT_SETUPS, ROOMS, type Scene } from '../../model/enclosure';

/**
 * Export › Picture: the box drawn as a picture to show (a PNG) at a size, from a side or as the
 * view shows it; set in a room of a colour (the background, shaded or flat, or none), lit by a key
 * light from a direction and the room's ambient light, with the soft shadow it casts. The light and
 * the room are kept with the enclosure (the view takes them too). A preview, and Save.
 */
const SIZES: [string, string, number, number][] = [
  ['hd', '1920 × 1080 (Full HD)', 1920, 1080], ['qhd', '2560 × 1440', 2560, 1440], ['4k', '3840 × 2160 (4K)', 3840, 2160],
  ['sq', '2048 × 2048 (square)', 2048, 2048], ['sqs', '1080 × 1080 (square)', 1080, 1080], ['web', '1200 × 800', 1200, 800], ['own', 'Other size', 0, 0],
];
const VIEWS: [ModelViewKind | '', string][] = [['', 'As the view shows it'], ['iso', 'Isometric'], ['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'], ['top', 'Top']];
let last = { size: 'hd', w: 1600, h: 1200, view: '' as ModelViewKind | '' };

/** Where the light comes from, in words. */
function fromWhere(az: number): string {
  const a = ((az % 360) + 540) % 360 - 180, m = Math.abs(a);
  const side = a < 0 ? 'left' : 'right';
  if (m <= 10) return 'the front';
  if (m >= 170) return 'behind';
  if (m < 70) return `the front ${side}`;
  if (m <= 110) return `the ${side}`;
  return `behind, ${side}`;
}

export function EnclosurePictureDialog({ picture, save, scene: scene0, setScene }: {
  picture: (o: PictureOptions) => Promise<Blob>; save: (bytes: Uint8Array) => Promise<void>;
  scene: Scene; setScene: (s: Scene) => void;
}) {
  const [st, setSt] = useState(last);
  const [sc, setSc] = useState(scene0);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const url = useRef<string | null>(null);
  const size = SIZES.find((x) => x[0] === st.size)!;
  const W = st.size === 'own' ? Math.round(st.w) : size[2], H = st.size === 'own' ? Math.round(st.h) : size[3];
  const opts = (w: number, h: number): PictureOptions => ({ width: w, height: h, background: sc.background, shadow: sc.shadow, view: st.view || null });
  const scene = (p: Partial<Scene>) => { const n = { ...sc, ...p }; setSc(n); setScene(n); };
  // The preview, a moment after a change
  useEffect(() => {
    const t = setTimeout(() => {
      const k = Math.min(1, 470 / W, 260 / H);
      picture(opts(Math.max(16, W * k), Math.max(16, H * k))).then((b) => {
        if (url.current) URL.revokeObjectURL(url.current);
        url.current = URL.createObjectURL(b); setPreview(url.current); setErr('');
      }, (e) => setErr((e as Error).message));
    }, 120);
    return () => clearTimeout(t);
  }, [st.size, st.w, st.h, st.view, sc]);
  useEffect(() => () => { if (url.current) URL.revokeObjectURL(url.current); }, []);
  const ok = async () => {
    if (busy) return;
    if (!(W >= 16 && H >= 16 && W <= 8192 && H <= 8192)) { setErr('A picture is 16 to 8192 pixels each way'); return; }
    if (W * H > 40e6) { setErr('A picture is up to 40 megapixels (8192 × 4608, say)'); return; }
    last = st; setBusy(true);
    try { const b = await picture(opts(W, H)); closeDialog(); await save(new Uint8Array(await b.arrayBuffer())); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const set = (p: Partial<typeof st>) => setSt((cur) => ({ ...cur, ...p }));
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  const setup = LIGHT_SETUPS.find((x) => x.set.azimuth === sc.azimuth && x.set.elevation === sc.elevation && x.set.key === sc.key && x.set.ambient === sc.ambient)?.name ?? '';
  const slider = (label: string, value: number, min: number, max: number, step: number, show: string, on: (v: number) => void, title?: string) => (
    <label title={title}>{label}<span class="encpic-slider"><input type="range" aria-label={/^(From|Height)$/.test(label) ? `Light ${label.toLowerCase()}` : label} min={min} max={max} step={step} value={value} onInput={(e) => on(Number((e.target as HTMLInputElement).value))} /><span class="encpic-val">{show}</span></span></label>
  );
  return (
    <Dialog title="Picture of the Enclosure" width={600} onClose={closeDialog} onAccept={() => { void ok(); return false; }} class="encpic"
      footer={<><span class="muted small">{W} × {H} px, PNG</span><span class="spacer" /><button class="btn default" disabled={busy} onClick={() => void ok()}>{busy ? 'Drawing...' : 'Save...'}</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="encpic-preview" aria-label="Preview">{preview ? <img src={preview} alt="Preview of the picture" /> : <span class="muted small">Drawing the preview...</span>}</div>
      <div class="encpic-form">
        <label>Size<select aria-label="Size" value={st.size} onChange={(e) => set({ size: (e.target as HTMLSelectElement).value })}>{SIZES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
        {st.size === 'own' && <span class="encpic-own">
          <input type="number" aria-label="Width" min={16} max={8192} value={st.w} onChange={(e) => set({ w: Number((e.target as HTMLInputElement).value) || 16 })} /> ×
          <input type="number" aria-label="Height" min={16} max={8192} value={st.h} onChange={(e) => set({ h: Number((e.target as HTMLInputElement).value) || 16 })} /> px
        </span>}
        <label>View<select aria-label="View" value={st.view} onChange={(e) => set({ view: (e.target as HTMLSelectElement).value as ModelViewKind | '' })}>{VIEWS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
        <div class="encpic-sub">Room</div>
        <label>Colour<span class="encpic-rooms" role="radiogroup" aria-label="Room colour">
          {ROOMS.map((r) => <button key={r.colour} type="button" role="radio" aria-checked={sc.env === r.colour} aria-label={r.name} title={r.name} class={`ex-swatch${sc.env === r.colour ? ' on' : ''}`} style={{ background: r.colour }} onClick={() => scene({ env: r.colour })} />)}
          <input type="color" aria-label="Any other room colour" title="Any other colour" value={sc.env} onInput={(e) => scene({ env: (e.target as HTMLInputElement).value.toLowerCase() })} />
        </span></label>
        <label>Background<span class="ex-seg" role="radiogroup" aria-label="Background">{([['gradient', 'Shaded'], ['flat', 'Flat'], ['none', 'None']] as const).map(([k, t]) => <button key={k} type="button" role="radio" aria-checked={sc.background === k} class={sc.background === k ? 'on' : ''} onClick={() => scene({ background: k })}>{t}</button>)}</span></label>
        <div class="encpic-sub">Light</div>
        <label>Set-up<span class="ex-seg" role="radiogroup" aria-label="Lighting set-up">{LIGHT_SETUPS.map((x) => <button key={x.name} type="button" role="radio" aria-checked={setup === x.name} class={setup === x.name ? 'on' : ''} title={x.title} onClick={() => scene(x.set)}>{x.name}</button>)}</span></label>
        {slider('From', sc.azimuth, -180, 180, 1, fromWhere(sc.azimuth), (v) => scene({ azimuth: v }), 'Where the key light comes from, round the box')}
        {slider('Height', sc.elevation, 2, 90, 1, `${Math.round(sc.elevation)}°`, (v) => scene({ elevation: v }), 'How high the key light is: low lights make long shading, 90° is straight above')}
        {slider('Key light', sc.key, 0, 2, 0.05, pct(sc.key), (v) => scene({ key: v }), 'The key light (and the fill and rim that go with it)')}
        {slider('Ambient', sc.ambient, 0, 2, 0.05, pct(sc.ambient), (v) => scene({ ambient: v }), "The room's light from all round, in its colour")}
        <label class="encpic-check"><input type="checkbox" checked={sc.shadow} onChange={() => scene({ shadow: !sc.shadow })} />A soft shadow under it</label>
      </div>
      <p class="muted small encpic-note">The box as the view shows it: assembled or with its top lifted, the board in it or not, in its colours and finishes. The light and the room are kept with the enclosure, and the view takes them too.</p>
      {err && <p class="small error">{err}</p>}
    </Dialog>
  );
}
