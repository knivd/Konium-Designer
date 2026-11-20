/**
 * Live Simulation's sound (26.184): the voltage across a speaker, taken from the run's uneven steps,
 * comes out as stretches of samples at a fixed rate of the circuit's time.
 */
import { describe, expect, it } from 'vitest';
import { Listener, SOUND_RATE, playStretch, soundState } from '../src/app/liveSound';

describe('a speaker is listened to (26.184)', () => {
  /** A 440 Hz sine of `amp` volts about `dc`, given to a listener in steps of uneven length for `time` seconds. */
  const feed = (l: Listener, time: number, amp = 2, dc = 2.5, from = 0) => {
    let t = from, k = 0;
    while (t < from + time) { t += [37e-6, 50e-6, 61e-6, 12e-6][k++ % 4]!; l.step(t, dc + amp * Math.sin(2 * Math.PI * 440 * t)); }
  };

  it('half a second of the circuit\'s time at once, at its pitch, the steady level taken off', () => {
    const got: Float32Array[] = [];
    const l = new Listener(2, 0.5, (s) => got.push(s));
    feed(l, 1.2);
    expect(got.map((g) => g.length)).toEqual([Math.round(SOUND_RATE / 2), Math.round(SOUND_RATE / 2)]);
    expect(l.stretches).toBe(2);
    const s = got[1]!;
    // The second stretch (the first is still shedding the 2.5 V it started on): full volume, about nothing, 220 cycles
    const mean = s.reduce((a, v) => a + v, 0) / s.length;
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(Math.max(...s)).toBeGreaterThan(0.97); expect(Math.max(...s)).toBeLessThanOrEqual(1); expect(Math.min(...s)).toBeLessThan(-0.97);
    let rises = 0;
    for (let i = 1; i < s.length; i++) if (s[i - 1]! < 0 && s[i]! >= 0) rises++;
    expect(rises).toBeGreaterThanOrEqual(219); expect(rises).toBeLessThanOrEqual(221);
    // It comes up from nothing and goes down to nothing, so that a stretch played after a wait does not click
    expect(s[0]).toBe(0); expect(s[s.length - 1]).toBe(0); expect(Math.abs(s[40]!) + Math.abs(s[45]!) + Math.abs(s[50]!)).toBeGreaterThan(0.3);
  });

  it('what is louder than full volume is held at it; a run begun again starts a stretch afresh', () => {
    const got: Float32Array[] = [];
    const l = new Listener(2, 0.1, (s) => got.push(s));
    feed(l, 0.25, 10, 0);
    expect(got.length).toBe(2);
    expect(Math.max(...got[1]!)).toBe(1); expect(Math.min(...got[1]!)).toBe(-1); expect(l.peak).toBe(1);
    // 0.05 s into its third stretch the run starts again at time 0: the next stretch is a whole 0.1 s from there
    feed(l, 0.16, 1, 0, 0);
    expect(got.length).toBe(3);
    expect(got[2]!.length).toBe(Math.round(SOUND_RATE * 0.1));
  });

  it('with no sound made ready, a stretch is not played', () => {
    expect(soundState().state).toBe('none');
    expect(playStretch(new Float32Array(100))).toBe(false);
  });
});
