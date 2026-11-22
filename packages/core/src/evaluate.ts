// The evaluator (docs/BOUNDARY.md, Layer 2): given a trusted policy, evidence receipts, the change, and an explicit
// evaluation time, decide each requirement and the change. Pure and deterministic: same inputs, same decision.
//
// Rules this file exists to keep:
//   - Missing required evidence keeps the change Not done ("Not checked" is never shown as Failed).
//   - Evidence for another revision cannot approve this one (Outdated).
//   - Where the policy asks for trusted CI, a self-reported receipt does not count; a tampered or unknown-key
//     receipt never counts anywhere.
//   - An exception needs an approver the policy names, a scope that covers the change, and an expiry not passed.
//     It keeps the underlying result: an exception is never Passed.
//   - A change that edits the policy is judged by the trusted policy, and stays Not done until approved elsewhere.
//   - A requirement this evaluator cannot check stays open; a policy with errors is itself an open item.
import { policyHash } from './policy';
import { verifyReceipt } from './receipt';
import type {
  Decision, DecisionState, EvidenceReceipt, ItemResult, ItemStatus, ParsedPolicy, PolicyException, PolicyIntegrity,
  ReceiptTrust, Requirement, Subject,
} from './types';

export const POLICY_INTACT = 'policy-intact';
export const POLICY_READABLE = 'policy-readable';

export const STATUS_LABEL: Record<ItemStatus, string> = {
  passed: 'Passed', failed: 'Failed', 'not-checked': 'Not checked', outdated: 'Outdated',
  'not-applicable': 'Not applicable', exception: 'Exception approved',
};
const STATE_LABEL: Record<DecisionState, Decision['label']> = { done: 'Done', 'done-with-exceptions': 'Done with exceptions', 'not-done': 'Not done' };

export interface EvaluateInput {
  policy: ParsedPolicy;
  integrity: PolicyIntegrity;
  receipts: EvidenceReceipt[];
  subject: Subject;
  /** ISO 8601 evaluation time. Required: exception expiry must be reproducible. */
  now: string;
}

/** Glob to RegExp: `**` any depth, `*` within a segment, `?` one character. */
export function globMatch(pattern: string, file: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(file.replace(/\\/g, '/').replace(/^\.\//, ''));
}

/** A git revision (optionally "<sha>-dirty"), as opposed to a descriptive label a producer used. */
function isRevision(r: string): boolean { return /^[0-9a-f]{7,40}(-dirty)?$/i.test(r); }
function showRevision(r: string): string {
  return r.endsWith('-dirty') ? `the uncommitted changes on ${r.slice(0, 12)}` : `revision ${r.slice(0, 12)}`;
}

function list(xs: string[], n = 3): string {
  return xs.slice(0, n).join(', ') + (xs.length > n ? ` and ${xs.length - n} more` : '');
}

const TITLES: Record<string, (r: Requirement) => string> = {
  tests: () => 'Tests run and pass',
  coverage: (r) => `${r.of === 'all' ? 'Codebase' : 'Changed lines'} covered (at least ${r.min ?? 80}%)`,
  security: (r) => `No scanner finding at ${r.failOn ?? 'error'} level or above on the changed files`,
  check: (r) => `The "${r.checkId}" check runs and passes`,
};
const WHY: Record<string, (r: Requirement) => string> = {
  tests: () => 'The team requires the tests to run and pass on this exact revision.',
  coverage: (r) => `The team requires at least ${r.min ?? 80}% line coverage of ${r.of === 'all' ? 'the codebase' : 'the changed lines'} (a team setting).`,
  security: (r) => `The team does not merge a change with a ${r.failOn ?? 'error'}-level scanner finding on the files it changes.`,
  check: (r) => `The team requires the "${r.checkId}" check to pass on this revision.`,
};

function matchesRequirement(req: Requirement, r: EvidenceReceipt): boolean {
  if (req.type === 'check') return r.check.id === req.checkId;
  return r.kind === req.type;
}

const RANK = { note: 1, warning: 2, error: 3 } as const;

interface Counted { receipt: EvidenceReceipt; trust: ReceiptTrust }

function decideFromReceipts(req: Requirement, current: Counted[], subject: Subject): Pick<ItemResult, 'status' | 'evidence' | 'next'> {
  const rs = current.map((c) => c.receipt);
  const latest = (xs: EvidenceReceipt[]) => xs.slice().sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  if (req.type === 'tests' || req.type === 'check') {
    // Defensive against third-party producers: "passed" with zero executed tests proves nothing.
    const real = rs.map((r) => (r.outcome === 'passed' && req.type === 'tests' && r.metrics.executed === 0 ? { ...r, outcome: 'not-checked' as const, summary: `${r.summary} (zero tests executed)` } : r));
    if (real.length && real.every((r) => r.outcome === 'not-applicable')) return { status: 'not-applicable', evidence: real[0].summary };
    const failed = real.find((r) => r.outcome === 'failed');
    if (failed) {
      if (failed.remedy) return { status: 'failed', evidence: failed.summary, next: failed.remedy };
      const f = failed.findings[0];
      const at = f?.file && !f.message.includes(f.file) ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
      return { status: 'failed', evidence: failed.summary, next: f ? `Resolve this, then produce fresh evidence: ${f.message}${at}.` : 'Fix what failed, then produce fresh evidence.' };
    }
    const passed = real.find((r) => r.outcome === 'passed');
    if (passed) return { status: 'passed', evidence: passed.summary };
    const nc = real.find((r) => r.outcome !== 'not-applicable') ?? real[0];
    return { status: 'not-checked', evidence: nc ? `${nc.summary}${nc.limitations[0] ? ` ${nc.limitations[0]}` : ''}` : 'No result.', next: nc?.remedy ?? 'Fix what kept the check from proving anything, then produce fresh evidence.' };
  }
  if (req.type === 'coverage') {
    const measured = rs.filter((r) => r.outcome === 'measured');
    const r = latest(measured);
    if (!r) return { status: 'not-checked', evidence: rs[0] ? rs[0].summary : 'No coverage measurement.', next: 'Run the tests with coverage and collect the report for this revision.' };
    const pct = req.of === 'all' ? r.metrics.coveragePercent : r.metrics.changedCoveragePercent;
    if (pct === undefined) {
      return { status: 'not-checked', evidence: req.of === 'all' ? 'The coverage receipt has no total.' : 'The coverage receipt has no changed-line measurement (no changed lines were given when it was collected, or none are instrumented).', next: 'Collect the coverage report with the change\'s base (so changed lines can be measured).' };
    }
    const min = req.min ?? 80;
    if (pct >= min) return { status: 'passed', evidence: r.summary };
    const f = r.findings[0];
    return { status: 'failed', evidence: `${pct}% is below ${min}%. ${r.summary}`, next: f?.file ? `Add a test that runs ${f.file}:${f.line}.` : 'Add tests for the uncovered lines.' };
  }
  // security
  const measured = rs.filter((r) => r.outcome === 'measured');
  if (!measured.length) return { status: 'not-checked', evidence: rs[0] ? rs[0].summary : 'No scan result.', next: 'Run the scanner and collect its SARIF for this revision.' };
  const changed = new Set(subject.changedFiles.map((f) => f.replace(/^\.\//, '')));
  const threshold = RANK[req.failOn ?? 'error'];
  const hits = measured.flatMap((r) => r.findings).filter((f) => RANK[f.severity ?? 'warning'] >= threshold && (!f.file || changed.has(f.file)));
  if (!hits.length) return { status: 'passed', evidence: `${measured.map((r) => r.summary).join(' ')} None at ${req.failOn ?? 'error'} level or above on the changed files.` };
  const h = hits[0];
  return { status: 'failed', evidence: `${hits.length} finding${hits.length === 1 ? '' : 's'} at ${req.failOn ?? 'error'} level or above on the changed files (first: ${h.message}${h.file ? `, ${h.file}${h.line ? `:${h.line}` : ''}` : ''}).`, next: `Fix ${h.rule ?? 'the finding'}${h.file ? ` at ${h.file}${h.line ? `:${h.line}` : ''}` : ''}, then re-scan.` };
}

function exceptionFor(req: Requirement, input: EvaluateInput, today: string, notes: string[]): PolicyException | undefined {
  const approvers = input.policy.policy.approvers.map((a) => a.toLowerCase());
  for (const e of input.policy.policy.exceptions) {
    if (e.requirement !== req.id) continue;
    if (!approvers.includes(e.approver.toLowerCase())) { notes.push(`The exception for "${req.id}" names ${e.approver}, who is not listed under "approvers"; it does not apply.`); continue; }
    if (e.expires < today) { notes.push(`The exception for "${req.id}" approved by ${e.approver} expired on ${e.expires}; it does not apply.`); continue; }
    if (e.paths?.length && !input.subject.changedFiles.every((f) => e.paths!.some((p) => globMatch(p, f)))) {
      notes.push(`The exception for "${req.id}" covers only ${list(e.paths)}; this change touches other files too, so it does not apply.`);
      continue;
    }
    return e;
  }
  return undefined;
}

/** Pure: decide a change. */
export function evaluate(input: EvaluateInput): Decision {
  if (Number.isNaN(Date.parse(input.now))) throw new Error('evaluate: "now" must be an ISO date (it decides exception expiry).');
  const today = new Date(input.now).toISOString().slice(0, 10);
  const { policy } = input.policy;
  const notes = [...input.policy.notes];
  const items: ItemResult[] = [];

  if (!input.integrity.enforcedElsewhere) items.push(input.integrity.editedByChange
    ? { id: POLICY_INTACT, title: 'The policy that judges this change is unchanged by it', required: true, status: 'not-checked', why: 'A change cannot loosen the rules that decide it.', evidence: `This change edits the policy. It was judged by ${input.integrity.source}; the edit applies only after it is approved and merged.`, next: 'Have the policy change approved outside this change (for example by a code owner of the policy file), then merge it on its own.' }
    : { id: POLICY_INTACT, title: 'The policy that judges this change is unchanged by it', required: true, status: 'passed', why: 'A change cannot loosen the rules that decide it.', evidence: `Judged by ${input.integrity.source}.` });
  if (input.policy.errors.length) {
    items.push({ id: POLICY_READABLE, title: 'The policy can be read', required: true, status: 'not-checked', why: 'A policy with problems cannot say what the team requires.', evidence: input.policy.errors.join(' '), next: 'Fix the policy on the base branch.' });
  }

  // Verify every receipt once.
  const verified = input.receipts.map((receipt) => ({ receipt, v: verifyReceipt(receipt, policy.keys) }));
  for (const { receipt, v } of verified) if (v.trust === 'invalid') notes.push(`A ${receipt?.check?.id ?? 'unknown'} receipt was ignored: ${v.reason}.`);
  const sameRepo = (r: EvidenceReceipt) => r.subject.repository.toLowerCase() === input.subject.repository.toLowerCase();
  for (const { receipt, v } of verified) if (v.trust !== 'invalid' && !sameRepo(receipt)) notes.push(`A ${receipt.check.id} receipt for ${receipt.subject.repository} was ignored: it is about another repository.`);

  for (const req of policy.requirements) {
    const title = req.title ?? (TITLES[req.type] ?? TITLES.check)(req);
    const why = req.why ?? (WHY[req.type] ?? WHY.check)(req);
    const base = { id: req.id, title, required: req.required, why, ...(req.owner ? { owner: req.owner } : {}) };
    if (req.checkId?.startsWith('unsupported:')) {
      items.push({ ...base, title: req.id, why: 'Your team asked for this requirement.', status: 'not-checked', evidence: `OpenThunder cannot check "${req.id}" yet.`, next: req.required ? 'Use a supported requirement (tests, coverage, security, check), or record an exception.' : undefined });
      continue;
    }
    if (req.paths?.length && !input.subject.changedFiles.some((f) => req.paths!.some((p) => globMatch(p, f)))) {
      items.push({ ...base, status: 'not-applicable', evidence: `Applies only to changes under ${list(req.paths)}.` });
      continue;
    }
    const appliesWhy = req.paths?.length ? ` It applies because this change touches ${list(req.paths)}.` : '';
    const needs = req.trust ?? policy.trust;
    const relevant = verified.filter(({ receipt, v }) => v.trust !== 'invalid' && sameRepo(receipt) && matchesRequirement(req, receipt));
    const counted: Counted[] = relevant.filter(({ v }) => needs === 'any' || v.trust === 'trusted').map(({ receipt, v }) => ({ receipt, trust: v.trust }));
    const current = counted.filter((c) => c.receipt.subject.revision === input.subject.revision);
    const older = counted.filter((c) => c.receipt.subject.revision !== input.subject.revision);
    const recordOf = (cs: Counted[]) => cs.map((c) => ({ check: `${c.receipt.check.id}@${c.receipt.check.version}`, revision: c.receipt.subject.revision, trust: c.trust, ...(c.receipt.artifact ? { digest: c.receipt.artifact.digest } : {}) }));
    let r: ItemResult;
    if (!current.length) {
      if (older.length) {
        const o = older.slice().sort((a, b) => b.receipt.observedAt.localeCompare(a.receipt.observedAt))[0].receipt;
        const evidence = isRevision(o.subject.revision)
          ? `The only evidence is for ${showRevision(o.subject.revision)}, not ${showRevision(input.subject.revision)}: it describes other code.`
          : `The only evidence is older than this code (${o.subject.revision}).`;
        r = { ...base, status: 'outdated', evidence, next: 'Run it again on the current code and collect the result.', receipts: recordOf(older) };
      } else if (relevant.length && needs === 'ci') {
        r = { ...base, status: 'not-checked', evidence: `Only self-reported evidence (${list([...new Set(relevant.map((x) => x.receipt.execution.identity))])}); this requirement counts only receipts signed by trusted CI.`, next: 'Run it in CI with the trusted collector, so the receipt is signed.', receipts: relevant.map(({ receipt, v }) => ({ check: `${receipt.check.id}@${receipt.check.version}`, revision: receipt.subject.revision, trust: v.trust })) };
      } else {
        r = { ...base, status: 'not-checked', evidence: 'No evidence for this requirement was provided for this change.', next: req.type === 'check' ? `Run the "${req.checkId}" check and collect its receipt.` : `Collect a ${req.type === 'tests' ? 'JUnit' : req.type === 'coverage' ? 'coverage (lcov)' : 'SARIF'} report for this revision.` };
      }
    } else {
      const d = decideFromReceipts(req, current, input.subject);
      const trusted = current.filter((c) => c.trust === 'trusted');
      const basis = trusted.length
        ? `trusted CI: ${list([...new Set(trusted.map((c) => c.receipt.execution.identity))])}`
        : `self-reported by ${list([...new Set(current.map((c) => c.receipt.execution.identity))])}`;
      r = { ...base, ...d, basis, receipts: recordOf(current) };
      if (appliesWhy && r.status !== 'not-applicable') r.why = `${r.why}${appliesWhy}`;
    }
    if (r.status === 'failed' || r.status === 'not-checked' || r.status === 'outdated') {
      const ex = exceptionFor(req, input, today, notes);
      if (ex) r = { ...r, underlying: r.status, status: 'exception', exception: ex, next: ex.followUp ? `Follow-up: ${ex.followUp}.` : undefined };
    }
    items.push(r);
  }

  const required = items.filter((i) => i.required);
  const open = required.filter((i) => i.status === 'failed' || i.status === 'not-checked' || i.status === 'outdated');
  const excepted = required.filter((i) => i.status === 'exception');
  const state: DecisionState = open.length ? 'not-done' : excepted.length ? 'done-with-exceptions' : 'done';
  const summary = state === 'not-done'
    ? `${open.length} of ${required.length} required item${required.length === 1 ? '' : 's'} open: ${open.slice(0, 3).map((i) => `${i.title} (${STATUS_LABEL[i.status]})`).join('; ')}${open.length > 3 ? `; and ${open.length - 3} more` : ''}.`
    : state === 'done-with-exceptions'
      ? `All ${required.length} required items met, ${excepted.length} by an approved exception (${excepted.map((i) => `${i.title}: ${i.exception!.approver}, ${i.exception!.untilLabel ?? `until ${i.exception!.expires}`}`).join('; ')}).`
      : `All ${required.length} required item${required.length === 1 ? '' : 's'} met.`;
  return {
    schema: 'done-decision-v1', state, label: STATE_LABEL[state], summary,
    subject: input.subject, policy: { source: input.integrity.source, hash: policyHash(policy) },
    evaluatedAt: input.now, items, notes,
  };
}

/** Plain text: what still keeps the change from Done first. */
export function renderDecision(d: Decision): string {
  const L = [`Definition of Done: ${d.label}`, d.summary];
  const row = (i: ItemResult) => {
    const pad = ''.padEnd(19);
    const out = [`  ${STATUS_LABEL[i.status].padEnd(19)}${i.title}${i.owner ? ` (owner: ${i.owner})` : ''}`];
    out.push(i.status === 'exception'
      ? `  ${pad}Was ${STATUS_LABEL[i.underlying!]}: ${i.evidence} Accepted by ${i.exception!.approver} ${i.exception!.untilLabel ?? `until ${i.exception!.expires}`}: "${i.exception!.reason}".`
      : `  ${pad}${i.evidence}${i.basis ? ` (${i.basis})` : ''}`);
    if (i.status === 'failed' || i.status === 'not-checked' || i.status === 'outdated') out.push(`  ${pad}Why: ${i.why}`);
    if (i.next) out.push(`  ${pad}Next: ${i.next}`);
    return out.join('\n');
  };
  const isOpen = (i: ItemResult) => i.required && (i.status === 'failed' || i.status === 'not-checked' || i.status === 'outdated');
  const open = d.items.filter(isOpen);
  const met = d.items.filter((i) => i.required && !isOpen(i));
  const rec = d.items.filter((i) => !i.required);
  if (open.length) L.push('', 'What still keeps this change from Done:', ...open.map(row));
  if (met.length) L.push('', 'Required, met:', ...met.map(row));
  if (rec.length) L.push('', 'Recommended (never holds a change):', ...rec.map(row));
  if (d.notes.length) L.push('', ...d.notes.map((n) => `Note: ${n}`));
  L.push('', `Decided for ${d.subject.repository} at ${d.subject.revision.slice(0, 12)}, ${d.subject.changedFiles.length} changed file${d.subject.changedFiles.length === 1 ? '' : 's'}, using ${d.policy.source} (${d.policy.hash.slice(7, 19)}), at ${d.evaluatedAt}.`);
  return L.join('\n');
}
