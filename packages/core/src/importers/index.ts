// Importers turn a report CI already produces into the body of a receipt. Rule for all of them: a report that is
// malformed, empty, all skipped, or zero tests never reads as a pass; what the report cannot show is a limitation.
import type { EvidenceFinding, EvidenceKind, EvidenceOutcome } from '../types';

export interface ImportedEvidence {
  kind: EvidenceKind;
  check: { id: string; version: string };
  outcome: EvidenceOutcome;
  summary: string;
  metrics: Record<string, number>;
  limitations: string[];
  findings: EvidenceFinding[];
}

// ── JUnit XML ────────────────────────────────────────────────────────────────────────────────────

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1]] = m[3] ?? m[4] ?? '';
  return out;
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** JUnit XML (the format most runners write: JUnit, pytest, Jest, Vitest, Go via go-junit-report, Maven Surefire). */
export function importJUnit(xml: string): ImportedEvidence {
  const base = { kind: 'tests' as const, check: { id: 'junit', version: '1' } };
  const body = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (!/<testsuites?[\s>]/.test(body)) {
    return { ...base, outcome: 'not-checked', summary: 'Not a JUnit report (no <testsuite> or <testsuites> element).', metrics: {}, limitations: ['The file could not be read as JUnit XML.'], findings: [] };
  }
  let tests = 0, failures = 0, errors = 0, skipped = 0;
  const findings: EvidenceFinding[] = [];
  // Each <testcase ...> either self-closes or has a body with <failure>, <error>, <skipped>.
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    tests++;
    const a = attrs(m[1]);
    const inner = m[3] ?? '';
    const name = unescapeXml([a.classname, a.name].filter(Boolean).join(' > ') || '(unnamed test)');
    if (/<skipped\b/.test(inner)) { skipped++; continue; }
    const f = /<(failure|error)\b([^>]*)/.exec(inner);
    if (f) {
      if (f[1] === 'failure') failures++; else errors++;
      const fa = attrs(f[2]);
      findings.push({ message: `${name}: ${unescapeXml(fa.message ?? f[1])}`.slice(0, 300), ...(a.file ? { file: a.file } : {}), ...(a.line ? { line: Number(a.line) } : {}), severity: 'error' });
    }
  }
  const executed = tests - skipped;
  const metrics = { tests, executed, failures, errors, skipped };
  if (tests === 0) return { ...base, outcome: 'not-checked', summary: 'The report contains no test cases.', metrics, limitations: ['Zero tests: nothing was proven.'], findings: [] };
  if (executed === 0) return { ...base, outcome: 'not-checked', summary: `All ${tests} tests were skipped.`, metrics, limitations: ['Every test was skipped: nothing was proven.'], findings: [] };
  const limitations = ['Shows which tests ran and passed; not what they assert or which code they cover.'];
  if (skipped) limitations.push(`${skipped} of ${tests} tests were skipped.`);
  if (failures || errors) {
    return { ...base, outcome: 'failed', summary: `${failures + errors} of ${executed} executed tests failed${errors ? ` (${errors} with errors)` : ''}.`, metrics, limitations, findings: findings.slice(0, 50) };
  }
  return { ...base, outcome: 'passed', summary: `${executed} test${executed === 1 ? '' : 's'} ran and passed${skipped ? `, ${skipped} skipped` : ''}.`, metrics, limitations, findings: [] };
}

// ── lcov ─────────────────────────────────────────────────────────────────────────────────────────

/** Changed lines per repo-relative file (from `git diff -U0`), for measuring changed-line coverage. */
export type ChangedLines = Record<string, number[]>;

/** lcov tracefile (Istanbul/nyc, c8, Vitest, Jest, coverage.py lcov, gcov/lcov, many others). */
export function importLcov(text: string, opts: { changedLines?: ChangedLines; stripPrefix?: string } = {}): ImportedEvidence {
  const base = { kind: 'coverage' as const, check: { id: 'lcov', version: '1' } };
  const files = new Map<string, Map<number, number>>();
  let current: Map<number, number> | undefined;
  let sawRecord = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      let f = line.slice(3).replace(/\\/g, '/');
      if (opts.stripPrefix && f.startsWith(opts.stripPrefix)) f = f.slice(opts.stripPrefix.length).replace(/^\//, '');
      current = files.get(f) ?? new Map();
      files.set(f, current);
    } else if (line.startsWith('DA:') && current) {
      const [ln, hits] = line.slice(3).split(',');
      const n = Number(ln), h = Number(hits);
      if (Number.isFinite(n) && Number.isFinite(h)) current.set(n, Math.max(current.get(n) ?? 0, h));
    } else if (line === 'end_of_record') { sawRecord = true; current = undefined; }
  }
  let found = 0, hit = 0;
  for (const m of files.values()) for (const h of m.values()) { found++; if (h > 0) hit++; }
  if (!sawRecord && !files.size) {
    return { ...base, outcome: 'not-checked', summary: 'Not an lcov tracefile.', metrics: {}, limitations: ['The file could not be read as lcov.'], findings: [] };
  }
  if (!found) return { ...base, outcome: 'not-checked', summary: 'The coverage report has no instrumented lines.', metrics: { linesFound: 0 }, limitations: ['Nothing was measured.'], findings: [] };
  const metrics: Record<string, number> = { linesFound: found, linesHit: hit, coveragePercent: round1((hit / found) * 100) };
  const limitations = ['Line coverage shows which lines ran under a test, not that a test checked their behavior.'];
  const findings: EvidenceFinding[] = [];
  if (opts.changedLines) {
    let cFound = 0, cHit = 0, unknown = 0;
    for (const [file, lines] of Object.entries(opts.changedLines)) {
      const m = files.get(file);
      for (const ln of lines) {
        const h = m?.get(ln);
        if (h === undefined) { unknown++; continue; }
        cFound++;
        if (h > 0) cHit++;
        else if (findings.length < 50) findings.push({ message: 'changed line not covered', file, line: ln });
      }
    }
    metrics.changedLinesFound = cFound;
    metrics.changedLinesHit = cHit;
    if (cFound) metrics.changedCoveragePercent = round1((cHit / cFound) * 100);
    if (unknown) limitations.push(`${unknown} changed lines are not instrumented in this report (new files, other languages, or non-code lines).`);
  } else {
    limitations.push('No changed lines were given, so changed-line coverage was not measured.');
  }
  return { ...base, outcome: 'measured', summary: `${metrics.coveragePercent}% of ${found} instrumented lines covered${metrics.changedCoveragePercent !== undefined ? `; ${metrics.changedCoveragePercent}% of ${metrics.changedLinesFound} changed lines` : ''}.`, metrics, limitations, findings };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

// ── SARIF ────────────────────────────────────────────────────────────────────────────────────────

/** SARIF 2.1.0 (CodeQL, Semgrep, ESLint, Snyk, Trivy, Checkov, and most scanners). Measures; the policy decides. */
export function importSarif(text: string): ImportedEvidence {
  const base = { kind: 'security' as const, check: { id: 'sarif', version: '1' } };
  let doc: any;
  try { doc = JSON.parse(text); } catch {
    return { ...base, outcome: 'not-checked', summary: 'Not valid SARIF (not JSON).', metrics: {}, limitations: ['The file could not be read as SARIF.'], findings: [] };
  }
  if (!doc || !Array.isArray(doc.runs)) {
    return { ...base, outcome: 'not-checked', summary: 'Not SARIF (no "runs").', metrics: {}, limitations: ['The file could not be read as SARIF.'], findings: [] };
  }
  if (!doc.runs.length) return { ...base, outcome: 'not-checked', summary: 'The SARIF file has no runs: no scanner ran.', metrics: {}, limitations: ['Nothing was scanned.'], findings: [] };
  const findings: EvidenceFinding[] = [];
  const counts = { error: 0, warning: 0, note: 0 };
  const tools: string[] = [];
  for (const run of doc.runs) {
    const tool = run?.tool?.driver?.name;
    if (typeof tool === 'string') tools.push(tool);
    for (const r of Array.isArray(run?.results) ? run.results : []) {
      if (r?.suppressions?.length) continue;
      const level: 'error' | 'warning' | 'note' = r?.level === 'error' ? 'error' : r?.level === 'note' || r?.level === 'none' ? 'note' : 'warning';
      counts[level]++;
      const loc = r?.locations?.[0]?.physicalLocation;
      const uri: string | undefined = loc?.artifactLocation?.uri;
      findings.push({
        message: String(r?.message?.text ?? r?.ruleId ?? 'finding').slice(0, 300),
        ...(uri ? { file: uri.replace(/^file:\/\//, '').replace(/^\.\//, '') } : {}),
        ...(loc?.region?.startLine ? { line: Number(loc.region.startLine) } : {}),
        severity: level,
        ...(r?.ruleId ? { rule: String(r.ruleId) } : {}),
      });
    }
  }
  const total = counts.error + counts.warning + counts.note;
  return {
    ...base, outcome: 'measured',
    summary: `${tools.length ? tools.join(', ') : 'The scanner'} reported ${total} finding${total === 1 ? '' : 's'} (${counts.error} error, ${counts.warning} warning, ${counts.note} note).`,
    metrics: { errors: counts.error, warnings: counts.warning, notes: counts.note, findings: total },
    limitations: ['Shows what the scanner reported; a scanner finds only the problems its rules cover. Suppressed results are not counted.'],
    findings: findings.slice(0, 200),
  };
}
