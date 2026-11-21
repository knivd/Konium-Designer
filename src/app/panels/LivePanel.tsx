/**
 * Live Simulation (Design › Simulate › Live Simulation): the sheet in front run as a circuit
 * while it is drawn. Start and Stop, Hold, From the Start, how fast the circuit's time goes,
 * what the colours stand for, what the netlist said, and the parts a sketch is made of.
 */
import { useMemo, useRef, useState } from 'preact/hooks';
import { active, activeScope, tick } from '../state';
import { SchEditor } from '../../editors/sch/SchEditor';
import { LIVE_GROUPS, LIVE_PARTS, LIVE_SPEEDS, SYMBOL_STYLES, liveSymbols, setLiveSymbols, againLive, clearProbes, endLiveDrag, holdLive, live, liveAudio, liveFields, livePartSymbol, liveReadables, liveSolve, placeLivePart, scope, setLiveField, setLiveSpeed, setLiveZero, setSketchKeys, setSound, si, sketchKeys, sound, spiceText, startLive, stepLiveSpeed, stopLive, voltColour, type LiveField } from '../liveSim';
import { SymbolPreview } from '../dialogs/PlacePart';
import { isSpiceNumber, spiceNumber } from '../../sim/num';
import { commands } from '../../core/commands';
import { RATING_PARAMS } from '../../sim/liveStress';
import { inStyle, type SymbolStyle } from '../../formats/synthetic/simLib';
import { Tool } from './kv';

/**
 * Solve for a value: one of the selected part's values found so that something the running sheet reads (a meter, a
 * monitor, the probe) comes to what is typed, with the circuit at its operating point.
 */
/** What a part is rated for is not something the circuit answers to. */
const RATED = new Set(Object.values(RATING_PARAMS));
function Solve({ index, fields }: { index: number; fields: LiveField[] }) {
  const can = fields.filter((f) => !f.choices && Number.isFinite(f.value) && !RATED.has(f.param)), reads = liveReadables();
  const [param, setParam] = useState(''), [key, setKey] = useState(''), [target, setTarget] = useState(''), [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  if (!can.length) return null;
  const p = can.find((f) => f.param === param) ?? can[0]!, k = reads.find((x) => x.key === key) ?? reads[0];
  const go = () => { if (k) setSaid(liveSolve(index, p.param, k.key, spiceNumber(target.trim()))); };
  return (
    <div class="live-solve" role="group" aria-label="Solve for a value">
      <h5>Solve for a value</h5>
      <div class="pw-field">
        <span>Find its</span>
        <select aria-label="The value to find" value={p.param} onChange={(e) => { setParam((e.target as HTMLSelectElement).value); setSaid(null); }}>
          {can.map((f) => <option key={f.param} value={f.param}>{f.label}</option>)}
        </select>
      </div>
      <div class="pw-field">
        <span>So that</span>
        <select aria-label="What is to read it" value={k?.key ?? ''} disabled={!reads.length} onChange={(e) => { setKey((e.target as HTMLSelectElement).value); setSaid(null); }}>
          {reads.length ? reads.map((x) => <option key={x.key} value={x.key}>{x.label}, {x.unit === 'V' ? 'voltage' : 'current'}</option>) : <option value="">nothing is watched yet</option>}
        </select>
      </div>
      <div class="pw-field">
        <span>Reads</span>
        <input type="text" aria-label="What it is to read" value={target} placeholder={k?.unit === 'A' ? '20m' : '3.3'} onInput={(e) => setTarget((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
        <span class="pw-unit">{k?.unit ?? 'V'}</span>
      </div>
      <div class="pw-run"><button class="btn" disabled={!k || !isSpiceNumber(target.trim())} onClick={go}>Find It</button></div>
      {said && <p class={said.ok ? 'pw-note' : 'pw-issue'} role="status">{said.text}</p>}
      {!said && <p class="pw-note">{reads.length ? 'The value is found with the circuit at its operating point (its sources at their steady values), and written to the part.' : 'Click a wire or a pin first, or place a test point: the value is found for what it reads.'}</p>}
    </div>
  );
}

const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`;
/** "1 ms a second": how much of the circuit's time passes in a second of yours. */
export const speedText = (s: number) => (s === 1 ? 'real time' : `${si(s, 's')} a second`);

/**
 * One value of the part selected: its box (Enter takes what is typed) and, under it, a slider that turns the value down
 * to a tenth or up to ten times while it is held, and springs back to the middle when let go.
 */
function FieldRow({ index, f }: { index: number; f: LiveField }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [turn, setTurn] = useState(0);
  const base = useRef<number | null>(null);
  const take = (text: string) => {
    setDraft(null);
    const v = text.trim();
    if (v !== f.text && isSpiceNumber(v)) setLiveField(index, f.param, v);
  };
  // One of a few: a list
  if (f.choices) {
    return (
      <div class="pw-field">
        <span>{f.label}</span>
        <select aria-label={f.label} value={f.choices.find((c) => c.toLowerCase() === f.text.toLowerCase()) ?? f.choices[0]} onChange={(e) => setLiveField(index, f.param, (e.target as HTMLSelectElement).value)}>
          {f.choices.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <span>{f.unit}</span>
      </div>
    );
  }
  const turnable = Number.isFinite(f.value) && f.value !== 0;
  return (
    <>
      <div class="pw-field">
        <span>{f.label}</span>
        <input aria-label={f.label} value={draft ?? f.text} spellcheck={false}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter') take((e.target as HTMLInputElement).value); else if (e.key === 'Escape') setDraft(null); e.stopPropagation(); }}
          onBlur={(e) => { if (draft !== null) take((e.target as HTMLInputElement).value); }} />
        <span>{f.unit}</span>
      </div>
      {f.range && <div class="pw-field live-turn">
        <span />
        <input type="range" aria-label={`Set the ${f.label.toLowerCase()}`} min={f.range[0]} max={f.range[1]} step={1} value={Number.isFinite(f.value) ? f.value : f.range[0]}
          onInput={(e) => setLiveField(index, f.param, (e.target as HTMLInputElement).value, true)} onChange={endLiveDrag} />
        <span />
      </div>}
      {f.turn && <div class="pw-field live-turn">
        <span />
        <input type="range" aria-label={`Turn the ${f.label.toLowerCase()} down or up`} min={-100} max={100} step={1} value={turn} disabled={!turnable}
          onInput={(e) => {
            const x = Number((e.target as HTMLInputElement).value);
            if (base.current === null) base.current = f.value;
            setTurn(x);
            setLiveField(index, f.param, spiceText(base.current * 10 ** (x / 100)), true);
          }}
          onChange={() => { base.current = null; setTurn(0); endLiveDrag(); }} />
        <span />
      </div>}
    </>
  );
}

/** What a sketch is joined up with: each a placing command of the sheet's, with a small drawing of its own. */
const INK = '#800000', JOIN = '#000080';
const WIRING: { label: string; command: string; hint: string; key?: string; art: preact.JSX.Element }[] = [
  { label: 'Wire', command: 'place.wire', hint: 'Wire', key: 'w', art: <svg viewBox="0 0 48 30"><path d="M6 22H24V8H42" fill="none" stroke={JOIN} stroke-width="1.6" /><circle cx="6" cy="22" r="2.2" fill={JOIN} /><circle cx="42" cy="8" r="2.2" fill={JOIN} /></svg> },
  { label: 'Ground', command: 'place.gnd', hint: 'Ground: 0 V, where voltages are measured from', key: 'g', art: <svg viewBox="0 0 48 30"><path d="M24 4V15M14 15H34M17.5 19.5H30.5M21 24H27" fill="none" stroke={INK} stroke-width="1.6" /></svg> },
  { label: 'Supply', command: 'place.vcc', hint: 'A supply\'s power port (VCC): every port of one name is one net', art: <svg viewBox="0 0 48 30"><path d="M24 26V11M15 11H33" fill="none" stroke={INK} stroke-width="1.6" /><text x="24" y="8" font-size="7" text-anchor="middle" fill={INK}>VCC</text></svg> },
  { label: 'Net label', command: 'place.netLabel', hint: 'A net label: wires with one name are one net', art: <svg viewBox="0 0 48 30"><path d="M6 21H42" fill="none" stroke={JOIN} stroke-width="1.6" /><text x="24" y="16" font-size="9" text-anchor="middle" fill={INK}>OUT</text></svg> },
  { label: 'Text', command: 'place.text', hint: 'A line of text: a note on the sketch', key: 't', art: <svg viewBox="0 0 48 30"><text x="24" y="21" font-size="15" text-anchor="middle" fill={JOIN}>Abc</text></svg> },
];
/** A key as its tile shows it: a capital means with Shift. */
const keyHint = (k?: string) => (k ? ` (key: ${k === k.toUpperCase() && k !== k.toLowerCase() ? `Shift+${k}` : k.toUpperCase()})` : '');

/** The palette: the parts a sketch is made of as their own symbols, by kind; a click puts one on the cursor. */
function Palette({ enabled, keys, style }: { enabled: boolean; keys: boolean; style: SymbolStyle }) {
  const tile = (id: string, label: string, caption: string, hint: string, key: string | undefined, art: preact.ComponentChildren, go: () => void) => (
    <button key={id} class="live-tile" disabled={!enabled} title={`${hint}${keys ? keyHint(key) : ''}`} aria-label={label} onClick={go}>
      <span class="live-art">{art}{keys && key && <kbd class="live-key">{key}</kbd>}</span>
      <span class={`live-cap${caption.length > 10 ? ' long' : ''}`}>{caption}</span>
    </button>
  );
  return (
    <>
      {LIVE_GROUPS.map((g) => (
        <div key={g} class="live-group" role="group" aria-label={g}>
          <h5>{g}</h5>
          <div class="live-tiles">
            {LIVE_PARTS.filter((p) => p.group === g).map((p) => { const sym = livePartSymbol(p); return tile(p.id, inStyle(p.label, style), inStyle(p.caption ?? p.label, style), inStyle(p.hint, style), p.key, sym && <SymbolPreview bags={sym.bags} part={1} />, () => placeLivePart(p.id)); })}
          </div>
        </div>
      ))}
      <div class="live-group" role="group" aria-label="Wiring and notes">
        <h5>Wiring and notes</h5>
        <div class="live-tiles">
          {WIRING.map((w) => tile(w.command, w.label, w.label, w.hint, w.key, w.art, () => void commands.run(w.command, activeScope.value)))}
        </div>
      </div>
    </>
  );
}

export function LivePanel() {
  void tick.value;
  const st = live.value, e = active.value?.editor;
  const sheet = e instanceof SchEditor && !e.libraryMode;
  if (!sheet && !st) return <p class="panel-empty">Bring a schematic sheet in front to run it live.</p>;
  const part = sheet ? liveFields() : null;
  const keys = sketchKeys.value;
  const style = liveSymbols.value;
  const palette = useMemo(() => <Palette enabled={sheet} keys={keys} style={style} />, [sheet, keys, style]);
  const go = (command: string) => () => void commands.run(command, activeScope.value);
  const name = sheet ? active.value!.name : st?.sheet ?? '';
  const watched = scope.value.kept.length;
  const behind = !!st && st.running && !st.error && st.pace > 0 && st.pace < st.speed * 0.8;
  const audio = st ? liveAudio() : 0;
  return (
    <div class="panel-body powerpanel livepanel">
      <div class="kv-head live-head">
        <h4 title={`${name}: a circuit is a schematic sheet, saved and opened as one`}>{name}</h4>
        <span class="kv-tools">
          <Tool icon="liveNew" label="New Circuit" title="New circuit: a blank sheet of its own for a sketch. What is open stays as it is" onClick={go('live.new')} />
          <Tool icon="liveOpen" label="Open a Circuit" title="Open a circuit: any schematic file (a circuit is saved as one)" onClick={go('file.open')} />
          <Tool icon="save" label="Save the Circuit" title="Save this circuit as a schematic file (Ctrl+S): its monitors and scopes are kept with it" disabled={!sheet} onClick={go('file.save')} />
          <Tool icon="liveExamples" label="Examples" title="Examples: circuits that run as they open, each a document of its own" onClick={go('live.examples')} />
        </span>
      </div>
      <div class="pw-run">
        {st
          ? <button class="btn default" onClick={stopLive}>Stop</button>
          : <button class="btn default" disabled={!sheet} onClick={() => startLive()}>Start</button>}
        <button class="btn" disabled={!st} onClick={() => holdLive()}>{st && !st.running ? 'Go On' : 'Hold'}</button>
        <button class="btn" disabled={!st} title="Time 0 again, the circuit at its operating point" onClick={againLive}>From the Start</button>
      </div>
      {st && <section aria-label="Time">
        <h4>Time</h4>
        <div class="pw-field">
          <span>Speed</span>
          <select aria-label="Speed" value={String(st.speed)} onChange={(ev) => setLiveSpeed(Number((ev.target as HTMLSelectElement).value))}>
            {LIVE_SPEEDS.map((s) => <option key={s} value={String(s)}>{speedText(s)}</option>)}
          </select>
          <span class="live-steps">
            <button class="btn" aria-label="Slower" title="Slower" onClick={() => stepLiveSpeed(-1)}>−</button>
            <button class="btn" aria-label="Faster" title="Faster" onClick={() => stepLiveSpeed(1)}>+</button>
          </span>
        </div>
        <label class="live-keys" title="From the Start begins as a circuit just switched on, every capacitor and inductor empty, in place of its settled state. An oscillator needs it: its balanced state is a settled state too">
          <input type="checkbox" checked={st.zero} onChange={(e) => setLiveZero((e.target as HTMLInputElement).checked)} /> Start with everything discharged
        </label>
        {audio > 0 && <label class="live-keys" title="The voltage across a speaker is played through the computer's sound, a stretch of the circuit's time at once, at its true pitch">
          <input type="checkbox" checked={sound.value} onChange={(e) => setSound((e.target as HTMLInputElement).checked)} /> Sound from the speaker
        </label>}
        {audio > 0 && sound.value && audio / st.speed > 2.5 && <p class="pw-note">Each {si(audio, 's')} of the circuit's time is played when it has run: at this speed, every {si(audio / st.speed, 's')}.</p>}
        <p class="live-time">{st.sheet}: {si(st.time, 's')} of the circuit's time{st.running ? '' : ', held'}.</p>
        {behind && <p class="pw-note">Going at {si(st.pace, 's')} a second: the circuit needs more steps than there is time for at the speed asked.</p>}
        {st.error && <p class="pw-issue" role="alert">{st.error}</p>}
      </section>}
      {st && !st.error && <section aria-label="What the colours show">
        <h4>What the colours show</h4>
        <div class="live-scale" aria-label={`Voltage colours from ${si(-st.vmax, 'V')} to ${si(st.vmax, 'V')}`}
          style={{ background: `linear-gradient(to right, ${[-1, -0.5, -0.1, 0, 0.1, 0.5, 1].map((t) => hex(voltColour(t, 1))).join(', ')})` }} />
        <div class="live-scale-ends"><span>{si(-st.vmax, 'V')}</span><span>0 V</span><span>{si(st.vmax, 'V')}</span></div>
        <p class="pw-note">Dots move the way the current flows, the faster the more of it (the most now: {si(st.imax, 'A')}). The cursor on a wire or a pin reads its voltage and current.</p>
      </section>}
      {st && !st.error && <section aria-label="Monitors and scopes">
        <h4>Monitors and scopes</h4>
        <div class="pw-run">
          <button class="btn" onClick={() => void commands.run('live.scope', activeScope.value)}>Show the Scope</button>
          <button class="btn" disabled={!watched} onClick={() => clearProbes()}>Clear Monitors</button>
        </div>
        <p class="pw-note">Click a wire, a pin or a two-pin part: its voltage and current are read out beside it and drawn on the Live Scope. Keep, on the scope, leaves it there as a monitor while you take the next; right-click a point for Monitor Here and View in a New Scope. {watched ? `${watched} kept now.` : ''}</p>
      </section>}
      {part && <section aria-label="The part selected">
        <h4>{part.designator}: {part.name}</h4>
        {part.fields.map((f) => <FieldRow key={`${part.index}:${f.param}`} index={part.index} f={f} />)}
        <p class="pw-note">Type a value and press Enter (4.7k, 100n, 2.2Meg). Hold a slider to turn its value down to a tenth or up to ten times{st ? '; the run goes on as it changes' : ''}.</p>
        {st && !st.error && <Solve key={part.index} index={part.index} fields={part.fields} />}
      </section>}
      {st && st.stress.length > 0 && <section aria-label="Over their ratings">
        <h4>Over their ratings</h4>
        <ul class="live-notes">
          {st.stress.slice(0, 8).map((t) => <li key={t} class="live-warn">{t}</li>)}
          {st.stress.length > 8 && <li>And {st.stress.length - 8} more.</li>}
        </ul>
        <p class="pw-note">Each is ringed on the sheet. Select one to see what it is rated for, and change it.</p>
      </section>}
      {st && st.notes.length > 0 && <section aria-label="From the netlist">
        <h4>From the netlist</h4>
        <ul class="live-notes">
          {st.notes.slice(0, 6).map((n, i) => <li key={i} class={`live-${n.level}`}>{n.text}</li>)}
          {st.notes.length > 6 && <li>And {st.notes.length - 6} more: Design › Simulate › Mixed Sim lists them all in Messages.</li>}
        </ul>
      </section>}
      <section aria-label="Parts for a sketch">
        <h4>Parts for a sketch</h4>
        <div class="pw-run">
          <button class="btn" onClick={() => void commands.run('live.examples', activeScope.value)}>Examples...</button>
          <button class="btn" disabled={!commands.get('live.selection')?.enabled?.()} title="What is selected on this sheet goes to a schematic of its own and runs there, with rails for the supplies its power ports name: a part of a design on the bench"
            onClick={() => void commands.run('live.selection', activeScope.value)}>Run the Selection</button>
        </div>
        <div class="pw-field" title="How resistors, capacitors and inductors are drawn. Changing it redraws those of this sheet (Undo brings them back): each keeps its place, its values and its wires">
          <span>Symbols</span>
          <select aria-label="Symbols" value={style} onChange={(e) => setLiveSymbols((e.target as HTMLSelectElement).value as SymbolStyle)}>
            {SYMBOL_STYLES.map(([id, label, hint]) => <option key={id} value={id} title={hint}>{label}</option>)}
          </select>
          <span />
        </div>
        <label class="live-keys" title="While the sheet runs, a key places its part (R a resistor, C a capacitor, W a wire and so on) in place of the menu it opens otherwise">
          <input type="checkbox" checked={keys} onChange={(e) => setSketchKeys((e.target as HTMLInputElement).checked)} /> Keys place parts
        </label>
        {palette}
        <p class="pw-note">Click a part, or press its key while the sheet runs, and place it. Each has its model built in: nothing to look up. Select a part on the sheet to change its values here.</p>
      </section>
    </div>
  );
}
