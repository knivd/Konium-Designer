/**
 * A requirement's check against the design, to set up and to read: what is measured, how it is
 * compared and with what figures, whether the verification follows it; and what the design
 * measures now (passes, fails, or can't be told yet, and why).
 */
import { CHECKS, checkKind, checkWords, newCheck, type CheckOp, type CheckQ, type CheckResult, type ReqCheck } from '../model/reqChecks';
import type { Project } from './state';
import { checkDesignRules } from './reqFacts';

const OPS: Record<CheckOp, string> = { '<=': 'at most', '>=': 'at least', '=': 'exactly' };
const MARK = { pass: '✓', fail: '✗', unknown: '?' } as const;

/** The result as a line: "✓ 4 layers", "✗ 52.0 × 30.0 mm", "? Compile the project". */
export function CheckResultLine({ result, check }: { result: CheckResult; check: ReqCheck }) {
  const text = result.status === 'unknown' ? (result.measured ? `${result.measured}: ${result.detail ?? 'not known yet'}` : result.detail ?? 'Not known yet') : result.measured;
  return (
    <div class={`rq-result st-${result.status}`} title={checkWords(check)}>
      <span class="rq-result-mark" aria-hidden="true">{MARK[result.status]}</span>
      <span>{result.status === 'pass' ? 'Passes' : result.status === 'fail' ? 'Fails' : 'Not known'}: {text}{result.status !== 'unknown' && result.detail ? ` (${result.detail})` : ''}</span>
    </div>
  );
}

export function ReqCheckEditor({ check, result, project, onChange }: { check: ReqCheck | undefined; result: CheckResult | null; project: Project | null; onChange: (c: ReqCheck | undefined) => void }) {
  const k = check ? checkKind(check.q) : null;
  const num = (label: string, v: number | undefined, on: (x: number) => void, step = 'any') => (
    <input type="number" class="rq-num" aria-label={label} step={step} value={v ?? 0} onChange={(e) => { const x = Number((e.target as HTMLInputElement).value); if (Number.isFinite(x)) on(x); }} />
  );
  const set = (patch: Partial<ReqCheck>) => check && onChange({ ...check, ...patch });
  return (
    <fieldset class="rq-check">
      <legend>Check against the design</legend>
      <select aria-label="Check" value={check?.q ?? ''} onChange={(e) => { const q = (e.target as HTMLSelectElement).value as CheckQ | ''; onChange(q ? newCheck(q) : undefined); }}>
        <option value="">None: verified by hand</option>
        {CHECKS.map((c) => <option key={c.q} value={c.q} title={c.hint}>{c.name}</option>)}
      </select>
      {check && k && (
        <>
          <div class="rq-check-row">
            {Array.isArray(k.ops) && k.ops.length > 1 && (
              <select aria-label="Comparison" value={check.op} onChange={(e) => set({ op: (e.target as HTMLSelectElement).value as CheckOp })}>{k.ops.map((o) => <option key={o} value={o}>{OPS[o]}</option>)}</select>
            )}
            {Array.isArray(k.ops) && k.ops.length === 1 && <span class="muted">{OPS[k.ops[0]!]}</span>}
            {k.ops === 'fits' && <>{num('Width', check.a, (a) => set({ a }))}<span>×</span>{num(k.figures === 3 ? 'Depth' : 'Height', check.b, (b) => set({ b }))}{k.figures === 3 && <><span>×</span>{num('Height', check.c, (c) => set({ c }))}</>}</>}
            {k.ops === 'covers' && <>{num('Lowest temperature', check.a, (a) => set({ a }))}<span>to</span>{num('Highest temperature', check.b, (b) => set({ b }))}</>}
            {Array.isArray(k.ops) && num(check.q === 'cost' ? 'Cost per board' : 'Figure', check.a, (a) => set({ a }), check.q === 'layers' || check.q === 'parts' || check.q === 'bomLines' ? '1' : 'any')}
            {k.unit && <span class="muted">{k.unit}</span>}
            {check.q === 'cost' && <><span>at</span>{num('Boards', check.qty, (qty) => set({ qty: Math.max(1, Math.round(qty)) }), '1')}<span class="muted">off</span></>}
          </div>
          <p class="muted small rq-check-hint">{k.hint}</p>
          {result && <CheckResultLine result={result} check={check} />}
          {check.q === 'drc' && result?.status === 'unknown' && project && <button class="btn" onClick={() => checkDesignRules(project)}>Check the design rules now</button>}
          <label class="rq-follow"><input type="checkbox" checked={check.follow} onChange={() => set({ follow: !check.follow })} />The verification follows the check</label>
        </>
      )}
    </fieldset>
  );
}
