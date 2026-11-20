/**
 * Live Simulation's sound: a speaker on the sheet is listened to as the circuit runs, and
 * what it heard is played through the computer's sound a stretch at a time.
 *
 * The circuit's time is not the listener's: a run may take a second over a millisecond of the
 * circuit, or the other way about. So the output's voltage is sampled at a fixed rate of the
 * circuit's own time, and each stretch of it (half a second, say) is played when it is complete,
 * at its true pitch. A run that keeps pace with the clock is heard without a break, a stretch
 * behind; a slower one is heard in stretches with waits between.
 */

/** Samples for each second of the circuit's time. */
export const SOUND_RATE = 22050;
/** A high-pass at 20 Hz takes a steady level off (a logic output's 0 V to 5 V is heard as a square wave about nothing). */
const HIGH_PASS = 1 / (1 + 2 * Math.PI * 20 / SOUND_RATE);
/** Samples over which a stretch comes up at its start and goes down at its end, so that one played after a wait does not click. */
const FADE = 33;

/** One speaker: the run's steps in, stretches of samples out. */
export class Listener {
  private t = NaN;
  private v = 0;
  /** The next sample's number: its time is k / SOUND_RATE. */
  private k = 0;
  private x1 = 0;
  private y1 = 0;
  private buf: Float32Array;
  private n = 0;
  /** Stretches given out, and the loudest sample so far (1 is full volume). */
  stretches = 0;
  peak = 0;

  /** `full`: the voltage that is full volume; `plays`: seconds of the circuit's time in a stretch. */
  constructor(readonly full: number, readonly plays: number, private readonly out: (samples: Float32Array) => void) {
    this.buf = new Float32Array(Math.max(64, Math.round(SOUND_RATE * Math.min(5, Math.max(0.05, plays)))));
  }

  /** A step of the run: the output's voltage at a time. A time at or before the last one starts afresh (the run began again). */
  step(time: number, v: number): void {
    if (!(time > this.t)) { this.t = time; this.v = v; this.k = Math.ceil(time * SOUND_RATE); this.n = 0; this.x1 = v; this.y1 = 0; return; }
    const span = time - this.t;
    for (let at = this.k / SOUND_RATE; at <= time; at = ++this.k / SOUND_RATE) {
      const x = this.v + (v - this.v) * (at - this.t) / span;
      const y = HIGH_PASS * (this.y1 + x - this.x1);
      this.x1 = x; this.y1 = y;
      const s = Math.max(-1, Math.min(1, y / this.full));
      if (Math.abs(s) > this.peak) this.peak = Math.abs(s);
      this.buf[this.n++] = s;
      if (this.n === this.buf.length) {
        const give = this.buf.slice();
        for (let i = 0; i < FADE && i < give.length / 2; i++) { give[i]! *= i / FADE; give[give.length - 1 - i]! *= i / FADE; }
        this.n = 0; this.stretches++;
        this.out(give);
      }
    }
    this.t = time; this.v = v;
  }
}

let ctx: AudioContext | null = null;
/** When (the context's time) what is queued ends. */
let until = 0;
const queued = new Set<AudioBufferSourceNode>();
let played = 0;

/** The sound made ready: called from a click (a browser lets sound start only from one). */
export function soundReady(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch { ctx = null; }
}
/** A stretch played after what is queued; false where there is no sound to play it with, or the circuit has run so far ahead of the sound that the stretch is let go. */
export function playStretch(samples: Float32Array): boolean {
  if (!ctx || ctx.state !== 'running') return false;
  const now = ctx.currentTime, length = samples.length / SOUND_RATE;
  if (until - now > 2 * length + 0.5) return false;
  const b = ctx.createBuffer(1, samples.length, SOUND_RATE);
  b.getChannelData(0).set(samples);
  const src = ctx.createBufferSource();
  src.buffer = b;
  src.connect(ctx.destination);
  const at = Math.max(now + 0.03, until);
  src.start(at);
  until = at + length;
  queued.add(src);
  src.onended = () => queued.delete(src);
  played++;
  return true;
}
/** What is playing and queued stopped. */
export function soundStop(): void {
  for (const s of queued) { try { s.stop(); } catch { /* it had ended */ } }
  queued.clear();
  until = 0;
}
/** For the tests: whether there is sound, how many stretches were played and how many are queued. */
export const soundState = (): { state: string; played: number; queued: number } => ({ state: ctx?.state ?? 'none', played, queued: queued.size });
