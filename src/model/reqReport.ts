/**
 * A project's requirements compliance report, as one HTML page to keep, send or print: how many
 * requirements are verified, failed, waived or not verified yet (all of them, and by priority);
 * those that need attention (failed, and Must ones not verified); then every requirement under its
 * document and section, with how it is verified and the evidence (its check against the design and
 * what the design measures, the note, what it is linked to).
 */
import { LINK_KINDS, METHODS, PRIORITIES, inTreeOrder, isReq, labelOf, type Priority, type Requirement, type Requirements, type VerifyState } from './requirements';
import { checkWords, type CheckResult } from './reqChecks';
import { showPictures, sizeOf, sizeWords } from './richText';
import { NO_SCRIPT } from '../core/reportHtml';

export interface ReportInput {
  project: string;
  docs: { name: string; reqs: Requirements }[];
  state: (r: Requirement) => VerifyState;
  result: (r: Requirement) => CheckResult | null;
  when: Date;
  version: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const STATE_WORDS: Record<VerifyState, string> = { verified: 'Verified', failed: 'Failed', waived: 'Waived', open: 'Not verified' };
const ORDER: VerifyState[] = ['verified', 'waived', 'failed', 'open'];

interface Counts { all: number; verified: number; waived: number; failed: number; open: number }
const zero = (): Counts => ({ all: 0, verified: 0, waived: 0, failed: 0, open: 0 });

/** The counts: all live requirements, and by priority (obsolete ones left out). */
export function reportCounts(reqs: Requirement[], state: (r: Requirement) => VerifyState): { total: Counts; by: Record<Priority, Counts> } {
  const total = zero();
  const by = { must: zero(), should: zero(), could: zero() } as Record<Priority, Counts>;
  for (const r of reqs) {
    if (r.status === 'obsolete') continue;
    const s = state(r);
    for (const c of [total, by[r.priority]]) { c.all++; c[s]++; }
  }
  return { total, by };
}

const bar = (c: Counts) => (c.all ? `<div class="bar" role="img" aria-label="${ORDER.map((s) => `${c[s]} ${STATE_WORDS[s].toLowerCase()}`).join(', ')}">${ORDER.filter((s) => c[s]).map((s) => `<span class="${s}" style="width:${((100 * c[s]) / c.all).toFixed(2)}%"></span>`).join('')}</div>` : '');
/** Its attached files, by name and size (they stay in the requirements document). */
const attached = (r: Requirement) => { const a = (r.files ?? []).filter((f) => !f.inline); return a.length ? `<div class="muted att">Attached: ${a.map((f) => `${esc(f.name)} (${sizeWords(sizeOf(f))})`).join(', ')}</div>` : ''; };
const pill = (s: VerifyState | 'obsolete') => `<span class="pill ${s}">${s === 'obsolete' ? 'Obsolete' : STATE_WORDS[s]}</span>`;

export function reportHtml(i: ReportInput): string {
  const reqs = i.docs.flatMap((d) => d.reqs.rows.filter(isReq));
  const { total, by } = reportCounts(reqs, i.state);
  const done = total.verified + total.waived;
  const pct = total.all ? Math.round((100 * done) / total.all) : 0;
  const date = i.when.toISOString().slice(0, 10);
  const attention = reqs.filter((r) => r.status !== 'obsolete' && (i.state(r) === 'failed' || (r.priority === 'must' && i.state(r) === 'open')));

  const evidence = (r: Requirement) => {
    const out: string[] = [];
    const res = i.result(r);
    if (r.check) {
      const word = res ? (res.status === 'pass' ? 'passes' : res.status === 'fail' ? 'fails' : 'not known') : 'not known';
      out.push(`<div class="chk ${res?.status ?? 'unknown'}"><b>Check:</b> ${esc(checkWords(r.check))}: <b>${word}</b>${res?.measured ? ` (${esc(res.measured)})` : ''}${res?.detail ? `; ${esc(res.detail)}` : ''}</div>`);
    }
    if (r.verify.note.trim()) out.push(`<div>${esc(r.verify.note.trim()).replace(/\n/g, '<br>')}</div>`);
    if (r.links.length) out.push(`<div class="links">Linked to ${r.links.map((l) => `${esc(labelOf(LINK_KINDS, l.kind))} <b>${esc(l.ref)}</b>`).join(', ')}</div>`);
    return out.join('') || '<span class="muted">None</span>';
  };

  const docBlocks = i.docs.map((d) => {
    // Each section with its requirements (those before the first section on their own); sections with none left out
    const groups: { title: string | null; reqs: Requirement[] }[] = [{ title: null, reqs: [] }];
    for (const r of inTreeOrder(d.reqs.rows)) { if (r.kind === 'section') groups.push({ title: r.title, reqs: [] }); else groups[groups.length - 1]!.reqs.push(r); }
    const head = '<table><thead><tr><th class="id">ID</th><th>Requirement</th><th class="pri">Priority</th><th class="meth">Method</th><th class="st">Verification</th><th>Evidence</th></tr></thead><tbody>';
    const parts = groups.filter((g) => g.reqs.length).map((g) => `${g.title !== null ? `<h3>${esc(g.title)}</h3>` : ''}${head}${g.reqs.map((r) => {
      const s = r.status === 'obsolete' ? 'obsolete' : i.state(r);
      return `<tr class="${r.status === 'obsolete' ? 'obs' : ''}"><td class="id">${esc(r.id)}${r.parent ? `<div class="muted">under ${esc(r.parent)}</div>` : ''}</td><td><b>${esc(r.title || '(untitled)')}</b>${r.html ? `<div class="rich">${showPictures(r.html, r.files)}</div>` : r.text.trim() ? `<div>${esc(r.text.trim()).replace(/\n/g, '<br>')}</div>` : ''}${r.source ? `<div class="muted">Source: ${esc(r.source)}</div>` : ''}${attached(r)}</td><td class="pri">${esc(labelOf(PRIORITIES, r.priority))}</td><td class="meth">${esc(labelOf(METHODS, r.verify.method))}</td><td class="st">${pill(s)}</td><td class="ev">${evidence(r)}</td></tr>`;
    }).join('')}</tbody></table>`);
    const n = d.reqs.rows.filter(isReq).length;
    return `<section><h2>${esc(d.name)} <span class="muted">${n} requirement${n === 1 ? '' : 's'}</span></h2>${parts.join('') || '<p class="muted">No requirements.</p>'}</section>`;
  });

  const row = (name: string, c: Counts) => `<tr><th>${name}</th><td>${c.all}</td><td>${c.verified}</td><td>${c.waived}</td><td class="${c.failed ? 'bad' : ''}">${c.failed}</td><td>${c.open}</td><td class="barcell">${bar(c)}</td></tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">${NO_SCRIPT}<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Requirements compliance: ${esc(i.project)}</title>
<style>
:root { --ink: #1d2733; --muted: #6a7682; --line: #d6dde4; --ok: #2f8a4a; --waive: #7a8a9a; --bad: #c0392b; --open: #d9a21b; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: #fff; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 8px; border-bottom: 2px solid var(--ink); padding-bottom: 4px; } h3 { font-size: 14px; margin: 18px 0 6px; }
.muted { color: var(--muted); font-weight: normal; } .meta { color: var(--muted); margin-bottom: 18px; }
.headline { display: flex; gap: 24px; align-items: baseline; margin: 12px 0; flex-wrap: wrap; } .big { font-size: 34px; font-weight: 700; }
table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; } th, td { text-align: left; vertical-align: top; padding: 5px 7px; border-bottom: 1px solid var(--line); }
thead th { background: #eef2f6; font-size: 12px; } thead { display: table-header-group; } tr { break-inside: avoid; }
.summary td, .summary th { text-align: right; } .summary th:first-child { text-align: left; } .summary { max-width: 760px; } .summary .barcell { width: 40%; }
.bad { color: var(--bad); font-weight: 700; }
.bar { display: flex; height: 12px; border-radius: 3px; overflow: hidden; background: #eef2f6; min-width: 120px; }
.bar span { display: block; height: 100%; } .bar .verified { background: var(--ok); } .bar .waived { background: var(--waive); } .bar .failed { background: var(--bad); } .bar .open { background: var(--open); }
.id { white-space: nowrap; font-family: ui-monospace, Consolas, monospace; width: 80px; } .pri, .meth { width: 74px; } .st { width: 104px; } .ev { width: 32%; font-size: 12px; }
.pill { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11px; font-weight: 600; color: #fff; white-space: nowrap; }
.pill.verified { background: var(--ok); } .pill.waived { background: var(--waive); } .pill.failed { background: var(--bad); } .pill.open { background: var(--open); color: #2a2000; } .pill.obsolete { background: #bbb; }
.chk.pass b:last-of-type { color: var(--ok); } .chk.fail b:last-of-type { color: var(--bad); } .links { color: var(--muted); }
tr.obs td { color: var(--muted); text-decoration: line-through; } tr.obs td.st, tr.obs td.ev { text-decoration: none; }
ul.attn { margin: 4px 0; padding-left: 20px; }
.rich { margin-top: 2px; } .rich p { margin: 0 0 4px; } .rich ul, .rich ol { margin: 0 0 4px; padding-left: 18px; }
.rich table { border-collapse: collapse; width: auto; margin: 2px 0 6px; } .rich td, .rich th { border: 1px solid var(--line); padding: 2px 6px; }
.rich th { background: #eef2f6; } .rich img { max-width: 100%; height: auto; } .att { font-size: 11px; } footer { margin-top: 32px; color: var(--muted); font-size: 11px; }
@media print { body { padding: 0; } @page { size: A4; margin: 14mm; } h2 { break-after: avoid; } h3 { break-after: avoid; } }
</style></head>
<body><main>
<h1>Requirements compliance: ${esc(i.project)}</h1>
<div class="meta">${date} · ${i.docs.map((d) => esc(d.name)).join(', ') || 'no requirements documents'} · made by Konium Designer ${esc(i.version)}</div>
<div class="headline"><div><span class="big">${pct}%</span> verified or waived</div><div>${done} of ${total.all} requirements${by.must.all ? `; Must: ${by.must.verified + by.must.waived} of ${by.must.all}` : ''}${total.failed ? `; <span class="bad">${total.failed} failed</span>` : ''}</div></div>
<table class="summary"><thead><tr><th></th><th>All</th><th>Verified</th><th>Waived</th><th>Failed</th><th>Not verified</th><th></th></tr></thead><tbody>
${row('All requirements', total)}${(['must', 'should', 'could'] as Priority[]).filter((p) => by[p].all).map((p) => row(labelOf(PRIORITIES, p), by[p])).join('')}
</tbody></table>
${attention.length ? `<h2>Needs attention <span class="muted">${attention.length}</span></h2><ul class="attn">${attention.map((r) => `<li>${pill(i.state(r))} <b>${esc(r.id)}</b> ${esc(r.title || '(untitled)')} <span class="muted">${esc(labelOf(PRIORITIES, r.priority))}</span></li>`).join('')}</ul>` : ''}
${docBlocks.join('\n')}
<footer>Obsolete requirements are struck through and left out of the counts. Attached files are listed by name: they are kept in the requirements document. A requirement whose verification follows its check against the design is verified or failed by what the design measured when this report was made.</footer>
</main></body></html>
`;
}
