/**
 * What every device sees while the circuit is solved: the unknowns (node voltages, then branch
 * currents), the matrix and right-hand side it stamps into, the analysis (DC or transient, the
 * time, the step and the integration method's coefficients) and the tolerances. Charges and
 * fluxes keep their history here, for integrating and for estimating the truncation error.
 */

export const CHARGE = 1.6021766208e-19;
export const BOLTZ = 1.38064852e-23;
export const KELVIN = 273.15;
export const vtAt = (tK: number) => (BOLTZ * tK) / CHARGE;

export interface Tolerances {
  reltol: number; abstol: number; vntol: number; chgtol: number; gmin: number; trtol: number;
  itl1: number; itl2: number; itl4: number;
  /** Integration: trapezoidal, or Gear (backward differentiation) up to maxord. */
  method: 'trap' | 'gear';
  maxord: number;
  /** Circuit and nominal temperatures, °C. */
  temp: number; tnom: number;
  /** Advanced Options: pivot ratio, the transient's total iteration limit (0: none), source steps, the sources' ramp at the start of a transient, statistics. */
  pivrel: number; itl5: number; srcsteps: number; ramptime: number; acct: number;
}

export const DEFAULT_TOL: Tolerances = {
  reltol: 1e-3, abstol: 1e-12, vntol: 1e-6, chgtol: 1e-14, gmin: 1e-12, trtol: 7, itl1: 100, itl2: 50, itl4: 10,
  method: 'trap', maxord: 2, temp: 27, tnom: 27,
  pivrel: 1e-3, itl5: 0, srcsteps: 10, ramptime: 0, acct: 0,
};

export type Mode = 'dc' | 'tran';

export class Ctx {
  /** Unknowns: nodes first, then branches. */
  n = 0;
  G = new Float64Array(0);
  b = new Float64Array(0);
  /** The solution of the last iteration (what devices linearise around). */
  x = new Float64Array(0);
  mode: Mode = 'dc';
  time = 0;
  /** This step and the ones before it (newest first). */
  hs: number[] = [1];
  order = 1;
  /** The derivative of a state x: a0·x + history (set per step). */
  a0 = 0;
  /**
   * The same for a junction's charge (a diode's, a transistor's). Where `junctionGear` is set these are taken by Gear's
   * second-order rule while capacitors and inductors keep the method of the run: the trapezoidal rule leaves what settles
   * in nanoseconds ringing from one step to the next at steps of microseconds, and round a transistor with gain the
   * ringing grows (a saturated transistor's collector read 0.04 V and 3.6 V by turns); Gear's rule lets it die at once.
   * Capacitors and inductors are left to the trapezoidal rule, which keeps a tuned circuit's swing where Gear's would wear it down.
   */
  a0j = 0;
  junctionGear = false;
  /** DC sources scaled (source stepping); conductance added to every junction (gmin stepping). */
  srcFactor = 1;
  gminExtra = 0;
  /** First iteration from nothing: junctions start at their critical voltages. */
  initJunctions = false;
  /** Use Initial Conditions: the transient starts from the IC values without an operating point. */
  uic = false;
  /** A device limited its voltages this iteration: not converged yet. */
  noncon = false;
  /** A live run: switches are decided from a solution, not at each iteration (Device.settle). */
  settle = false;
  tol: Tolerances = DEFAULT_TOL;
  tempK = DEFAULT_TOL.temp + KELVIN;
  vt = vtAt(DEFAULT_TOL.temp + KELVIN);
  /** Sources' breakpoints (corners of pulses, PWL points). */
  breaks: number[] = [];

  /** The positions of G ever stamped (the solver's pattern), and a count bumped when it grows. */
  pat: number[] = [];
  patVersion = 0;
  private mark = new Uint8Array(0);
  get re(): Float64Array { return this.G; }
  readonly im = null;

  size(n: number): void {
    this.n = n;
    this.G = new Float64Array(n * n);
    this.b = new Float64Array(n);
    this.x = new Float64Array(n);
    this.mark = new Uint8Array(n * n);
    this.pat = [];
    this.patVersion++;
  }
  clear(): void {
    if (this.pat.length * 8 < this.G.length) for (const f of this.pat) this.G[f] = 0; else this.G.fill(0);
    this.b.fill(0);
  }
  v(i: number): number { return i < 0 ? 0 : this.x[i]!; }
  add(i: number, j: number, v: number): void {
    if (i < 0 || j < 0) return;
    const f = i * this.n + j;
    if (!this.mark[f]) { this.mark[f] = 1; this.pat.push(f); this.patVersion++; }
    this.G[f] += v;
  }
  rhs(i: number, v: number): void { if (i >= 0) this.b[i] += v; }
  /** A conductance between two nodes. */
  g(a: number, b: number, g: number): void { this.add(a, a, g); this.add(b, b, g); this.add(a, b, -g); this.add(b, a, -g); }
  /** A current I leaving node a through the device into node b. */
  i(a: number, b: number, I: number): void { this.rhs(a, -I); this.rhs(b, I); }
  /** A current from a to b of g·(v(cp) − v(cn)). */
  vccs(a: number, b: number, cp: number, cn: number, g: number): void {
    if (g === 0) return;
    this.add(a, cp, g); this.add(a, cn, -g); this.add(b, cp, -g); this.add(b, cn, g);
  }
  /**
   * A nonlinear current I(a→b) linearised: I0 at the controlling voltages v0 with slopes g —
   * stamped as conductances plus the current I0 − Σ g·v0.
   */
  nonlinear(a: number, b: number, I0: number, ctrl: [number, number, number, number][]): void {
    let ieq = I0;
    for (const [cp, cn, g, v0] of ctrl) { this.vccs(a, b, cp, cn, g); ieq -= g * v0; }
    this.i(a, b, ieq);
  }
  setTemp(c: number): void { this.tempK = c + KELVIN; this.vt = vtAt(this.tempK); }

  /** Integration coefficients for this step: the method's a0, and order. */
  coefficients(): void {
    const h = this.hs[0]!;
    const h1 = this.hs[1] ?? h, gear = (2 * h + h1) / (h * (h + h1));
    if (this.order === 1) this.a0 = 1 / h;
    else if (this.tol.method === 'trap') this.a0 = 2 / h;
    else this.a0 = gear;
    this.a0j = this.order !== 1 && this.junctionGear ? gear : this.a0;
  }
}

/**
 * A state integrated over time (a capacitor's charge, an inductor's flux): its values at this
 * and earlier time points, and its derivative (the current, the voltage) at them.
 */
export class State {
  /** Newest first: [0] this iteration, [1] the last accepted point … */
  q = [0, 0, 0, 0];
  d = [0, 0];
  /** A junction's charge: taken by Gear's rule where the run asks that of junctions (Ctx.junctionGear). */
  constructor(readonly junction = false) {}

  /** Start every point at a value (the operating point). */
  reset(q: number, d = 0): void { this.q.fill(q); this.d.fill(d); }

  /** The derivative at this point for value q (and the factor a0 its slope is scaled by). */
  integrate(c: Ctx, q: number): number {
    this.q[0] = q;
    if (c.mode !== 'tran') { this.d[0] = 0; return 0; }
    let d: number;
    if (c.order === 1) d = (q - this.q[1]!) / c.hs[0]!;
    else if (c.tol.method === 'trap' && !(this.junction && c.junctionGear)) d = (2 / c.hs[0]!) * (q - this.q[1]!) - this.d[1]!;
    else {
      const h = c.hs[0]!, h1 = c.hs[1] ?? h;
      const a0 = (2 * h + h1) / (h * (h + h1)), a1 = -(h + h1) / (h * h1), a2 = h / (h1 * (h + h1));
      d = a0 * q + a1 * this.q[1]! + a2 * this.q[2]!;
    }
    this.d[0] = d;
    return d;
  }

  accept(): void {
    this.q[3] = this.q[2]!; this.q[2] = this.q[1]!; this.q[1] = this.q[0]!;
    this.d[1] = this.d[0]!;
  }

  /** The step the truncation error allows (SPICE's divided-difference estimate). */
  lte(c: Ctx): number {
    const order = c.order;
    const tol0 = c.tol.abstol + c.tol.reltol * Math.max(Math.abs(this.d[0]!), Math.abs(this.d[1]!));
    const chargetol = (c.tol.reltol * Math.max(Math.max(Math.abs(this.q[0]!), Math.abs(this.q[1]!)), c.tol.chgtol)) / c.hs[0]!;
    const tol = Math.max(tol0, chargetol);
    const diff = this.q.slice(0, order + 2);
    const delta = c.hs.slice(0, order + 1);
    while (delta.length < order + 1) delta.push(delta.at(-1)!);
    const deltmp = [...delta];
    let j = order;
    for (;;) {
      for (let i = 0; i <= j; i++) diff[i] = (diff[i]! - diff[i + 1]!) / deltmp[i]!;
      if (--j < 0) break;
      for (let i = 0; i <= j; i++) deltmp[i] = deltmp[i + 1]! + delta[i]!;
    }
    const factor = c.tol.method === 'trap' && !(this.junction && c.junctionGear) ? (order === 1 ? 0.5 : 1 / 12) : [0.5, 0.2222222222, 0.1363636364, 0.096, 0.07299270073, 0.05830903790][order - 1]!;
    let del = (c.tol.trtol * tol) / Math.max(c.tol.abstol, factor * Math.abs(diff[0]!));
    if (order === 2) del = Math.sqrt(del);
    else if (order > 2) del = Math.exp(Math.log(del) / order);
    return del;
  }
}

/** pn-junction voltage limiting (SPICE's pnjlim): keeps an exponential from overflowing between iterations. */
export function pnjlim(vnew: number, vold: number, vt: number, vcrit: number, c: Ctx): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    c.noncon = true;
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      return arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    }
    return vt * Math.log(vnew / vt);
  }
  return vnew;
}

/** FET gate voltage limiting (SPICE's fetlim). */
export function fetlim(vnew: number, vold: number, vto: number): number {
  const vtsthi = Math.abs(2 * (vold - vto)) + 2, vtstlo = vtsthi / 2 + 2, vtox = vto + 3.5, delv = vnew - vold;
  if (vold >= vto) {
    if (vold >= vtox) {
      if (delv <= 0) { if (vnew >= vtox) { if (-delv > vtstlo) return vold - vtstlo; } else return Math.max(vnew, vto + 2); }
      else if (delv >= vtsthi) return vold + vtsthi;
    } else return delv <= 0 ? Math.max(vnew, vto - 0.5) : Math.min(vnew, vto + 4);
  } else if (delv <= 0) { if (-delv > vtsthi) return vold - vtsthi; }
  else { const vtemp = vto + 0.5; if (vnew <= vtemp) { if (delv > vtstlo) return vold + vtstlo; } else return vtemp; }
  return vnew;
}

/** Drain–source voltage limiting (SPICE's limvds). */
export function limvds(vnew: number, vold: number): number {
  if (vold >= 3.5) { if (vnew > vold) return Math.min(vnew, 3 * vold + 2); if (vnew < 3.5) return Math.max(vnew, 2); }
  else { if (vnew > vold) return Math.min(vnew, 4); return Math.max(vnew, -0.5); }
  return vnew;
}

/** A depletion charge and capacitance (junction capacitance cj0, built-in vj, grading m, forward-bias coefficient fc). */
export function depletion(v: number, cj0: number, vj: number, m: number, fc: number): [number, number] {
  if (cj0 === 0) return [0, 0];
  if (v < fc * vj) {
    const arg = 1 - v / vj, sarg = Math.exp(-m * Math.log(arg));
    return [vj * cj0 * (1 - arg * sarg) / (1 - m), cj0 * sarg];
  }
  const f1 = (vj * (1 - Math.exp((1 - m) * Math.log(1 - fc)))) / (1 - m);
  const f2 = Math.exp((1 + m) * Math.log(1 - fc));
  const f3 = 1 - fc * (1 + m);
  const czof2 = cj0 / f2;
  return [cj0 * f1 + czof2 * (f3 * (v - fc * vj) + (m / (2 * vj)) * (v * v - fc * fc * vj * vj)), czof2 * (f3 + (m * v) / vj)];
}
