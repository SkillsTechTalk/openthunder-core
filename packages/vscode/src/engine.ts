// The extension's engine: gather the evidence for the current change and decide it with OpenThunder Core.
// No VS Code import here (testable on its own). Reads files and git only; never runs project code; no network.
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  evaluate, parsePolicy, importJUnit, importLcov, importSarif, compareOpenApi, parseSpec, buildReceipt, readReceipts,
  currentRevision, changedFiles, changedLines, fileAtRef, repositoryIdentity, policyAtBase, DEFAULT_POLICY_YAML,
  readApprovals, sha256, policyTextHash, APPROVALS_DIR,
  type Decision, type EvidenceReceipt, type EvidenceFinding, type ImportedEvidence,
} from 'openthunder-core';

export const RECEIPTS_DIR = '.done/receipts';

export interface GatherOptions {
  root: string;
  /** Configured base branch; empty = detect. */
  base?: string;
  /** Where the policy lives; empty = .openthunder/done.yml (or the earlier .openthunder/done-core.yml). */
  policyPath?: string;
  /** Candidate report files (absolute), found by the host (VS Code's file search). */
  reportFiles: string[];
  /** OpenAPI files (repo-relative) to compare with the base branch. */
  openApiFiles: string[];
  now?: string;
}

export interface Gathered {
  decision: Decision;
  base: string;
  /** True when the base branch has a policy; false = the OpenThunder default, shown for information. */
  adopted: boolean;
  /** The working copy edits the policy (it still does not judge this change). */
  policyEditedLocally: boolean;
  /** Changed lines no test runs, from a fresh coverage report. */
  coverageGaps: { file: string; line: number }[];
  /** Scanner findings on the changed files, from fresh SARIF. */
  findings: EvidenceFinding[];
  /** Breaking API changes per OpenAPI file. */
  apiBreaks: { file: string; findings: EvidenceFinding[] }[];
  /** Which reports were used, and why some were not. */
  reports: { file: string; kind: string; status: 'used' | 'outdated' | 'unreadable' }[];
}

function git(root: string, args: string[]): string | null {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

/** The branch the change merges into: configured, else origin's default branch, else main or master. */
export function detectBase(root: string, configured?: string): string {
  if (configured && configured.trim()) return configured.trim();
  const head = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head) return head.replace(/^refs\/remotes\//, '');
  for (const b of ['origin/main', 'main', 'origin/master', 'master']) if (git(root, ['rev-parse', '--verify', '--quiet', `${b}^{commit}`])) return b;
  return 'HEAD';
}

/** What kind of report a file is, by name and content. */
export function classifyReport(file: string, text: string): 'junit' | 'lcov' | 'sarif' | undefined {
  if (/\.sarif(\.json)?$/i.test(file) || (/"runs"\s*:/.test(text) && /"version"\s*:\s*"2\.1\.0"/.test(text))) return 'sarif';
  if (/\.info$/i.test(file) || /^SF:/m.test(text)) return 'lcov';
  if (/\.xml$/i.test(file) && /<testsuites?[\s>]/.test(text)) return 'junit';
  return undefined;
}

function newestMtime(root: string, rels: string[]): number {
  let best = 0;
  for (const r of rels) { try { best = Math.max(best, fs.statSync(path.join(root, r)).mtimeMs); } catch { /* deleted */ } }
  return best;
}

/** Line of an OpenAPI path key in the spec text (for placing a diagnostic), 1-indexed; 1 when not found. */
export function lineOfPath(text: string, apiPath: string): number {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes(`"${apiPath}"`) || l.trimStart().startsWith(`${apiPath}:`) || l.includes(`'${apiPath}'`));
  return i >= 0 ? i + 1 : 1;
}

export function gather(o: GatherOptions): Gathered {
  const root = o.root;
  const base = detectBase(root, o.base);
  const repository = repositoryIdentity(root);
  const { revision } = currentRevision(root);
  const changed = changedFiles(root, base);
  const lines = changedLines(root, base);
  const { policyPath, trustedText } = policyAtBase(root, base, o.policyPath || undefined);
  const adopted = trustedText !== null;
  let working: string | null = null;
  try { working = fs.readFileSync(path.join(root, policyPath), 'utf8'); } catch { working = null; }
  const policyEditedLocally = adopted && working !== null && working !== trustedText;

  // Local reports carry no revision. Bind one to this change only when it is newer than the last commit and every
  // changed file; otherwise it describes older code and is Outdated. Always self-reported (labeled "local").
  const headTime = Number(git(root, ['log', '-1', '--format=%ct']) ?? 0) * 1000;
  // Reports themselves (often untracked, so "changed") are evidence, not code: they never make each other look old.
  const reportRels = new Set(o.reportFiles.map((abs) => path.relative(root, abs).split(path.sep).join('/')));
  const codeTime = Math.max(headTime, newestMtime(root, changed.filter((f) => !reportRels.has(f))));
  const receipts: EvidenceReceipt[] = [];
  const reports: Gathered['reports'] = [];
  const coverageGaps: Gathered['coverageGaps'] = [];
  const findings: EvidenceFinding[] = [];
  const changedSet = new Set(changed);
  for (const abs of o.reportFiles) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    let text: string; let mtime: number;
    try { text = fs.readFileSync(abs, 'utf8'); mtime = fs.statSync(abs).mtimeMs; } catch { reports.push({ file: rel, kind: '?', status: 'unreadable' }); continue; }
    const kind = classifyReport(rel, text);
    if (!kind) continue;
    const fresh = mtime >= codeTime;
    let ev: ImportedEvidence = kind === 'junit' ? importJUnit(text) : kind === 'sarif' ? importSarif(text) : importLcov(text, { changedLines: lines, stripPrefix: `${root.split(path.sep).join('/')}/` });
    ev = { ...ev, limitations: [...ev.limitations, `Local report ${rel}; its freshness is judged by file times (${fresh ? 'newer than the code' : 'older than the code'}).`] };
    receipts.push(buildReceipt(ev, { repository, revision: fresh ? revision : `report file ${rel} is older than your latest changes`, execution: { identity: 'local' }, observedAt: new Date(mtime).toISOString(), artifact: { name: rel, bytes: text } }));
    reports.push({ file: rel, kind, status: fresh ? 'used' : 'outdated' });
    if (fresh && kind === 'lcov') for (const f of ev.findings) if (f.file && f.line) coverageGaps.push({ file: f.file, line: f.line });
    if (fresh && kind === 'sarif') for (const f of ev.findings) if (f.file && changedSet.has(f.file)) findings.push(f);
  }
  // Receipts written by the CLI, CI, or a plugin (for example OpenThunder protect), used as they are.
  receipts.push(...readReceipts(path.join(root, RECEIPTS_DIR)).receipts);

  // API compatibility: keyless, so it simply runs for every declared spec that exists on both sides.
  const apiBreaks: Gathered['apiBreaks'] = [];
  for (const spec of o.openApiFiles) {
    const oldText = fileAtRef(root, base, spec);
    let newText: string | null = null;
    try { newText = fs.readFileSync(path.join(root, spec), 'utf8'); } catch { newText = null; }
    if (oldText === null || newText === null) continue;
    let ev: ImportedEvidence;
    try { ev = compareOpenApi(parseSpec(oldText), parseSpec(newText), spec); } catch { continue; }
    receipts.push(buildReceipt(ev, { repository, revision, execution: { identity: 'local' }, artifact: { name: spec, bytes: newText } }));
    if (ev.findings.length) apiBreaks.push({ file: spec, findings: ev.findings });
  }

  const decision = evaluate({
    policy: parsePolicy(adopted ? trustedText! : DEFAULT_POLICY_YAML),
    integrity: {
      source: adopted ? `${policyPath} on ${base}` : 'the OpenThunder default (not adopted by this repository)', editedByChange: policyEditedLocally,
      // An approver's signed approval of this exact edit (done-core approve-policy), checked against the base policy.
      ...(policyEditedLocally ? { basePolicyHash: sha256(trustedText!), changedPolicyHash: policyTextHash(working), approvals: readApprovals(path.join(root, APPROVALS_DIR)).approvals } : {}),
    },
    receipts, subject: { repository, revision, changedFiles: changed }, now: o.now ?? new Date().toISOString(),
  });
  return { decision, base, adopted, policyEditedLocally, coverageGaps, findings, apiBreaks, reports };
}

/** Exceptions in a policy text that expire within `days` of `today` (YYYY-MM-DD), with their line. */
export function expiringExceptions(text: string, today: string, days = 14): { requirement: string; expires: string; line: number }[] {
  const p = parsePolicy(text).policy;
  const limit = new Date(Date.parse(today) + days * 86400000).toISOString().slice(0, 10);
  const lines = text.split('\n');
  return p.exceptions.filter((e) => e.expires >= today && e.expires <= limit).map((e) => ({
    requirement: e.requirement, expires: e.expires, line: Math.max(1, lines.findIndex((l) => l.includes(e.expires)) + 1),
  }));
}

// ── OpenThunder's own checks (the free app), as a plugin that writes receipts ─────────────────────────────────
// The open extension never contains OpenThunder's analyzers. When the policy asks for `check: openthunder.<item>`,
// this runs the installed `openthunder` command, which writes its evidence as receipts to .done/receipts; the
// panel then counts them like any other receipt (labeled self-reported unless signed by trusted CI).

export interface OpenThunderRun { status: 'written' | 'not-installed' | 'failed'; message: string; count?: number }

type Exec = (cmd: string, args: string[], opts: { cwd: string; encoding: 'utf8'; maxBuffer: number; timeout: number }) => string;

export function runOpenThunderChecks(root: string, base: string, command = 'openthunder', exec: Exec = execFileSync as unknown as Exec): OpenThunderRun {
  const args = ['done', '--write-receipts', '--json', ...(base ? ['--base', base] : [])];
  let out: string;
  try {
    out = exec(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  } catch (e) {
    const err = e as { code?: string; status?: number; stdout?: string };
    if (err.code === 'ENOENT') return { status: 'not-installed', message: `OpenThunder is not installed (no "${command}" command found). It is free: https://openthunder.dev` };
    // Exit 1 = Not done: the receipts were still written.
    if (err.status === 1 && typeof err.stdout === 'string') out = err.stdout;
    else return { status: 'failed', message: `OpenThunder could not finish, so no receipts were written${err.status !== undefined ? ` (exit ${err.status})` : ''}.` };
  }
  try {
    const j = JSON.parse(out) as { receiptsWritten?: { count: number; dir: string; signed: boolean } };
    const w = j.receiptsWritten;
    if (!w) return { status: 'failed', message: 'OpenThunder ran but wrote no receipts (an older version? update it from https://openthunder.dev).' };
    return { status: 'written', count: w.count, message: `OpenThunder wrote ${w.count} receipt${w.count === 1 ? '' : 's'} to ${w.dir} (${w.signed ? 'signed' : 'self-reported'}).` };
  } catch {
    return { status: 'failed', message: 'OpenThunder ran but its output could not be read (an older version? update it from https://openthunder.dev).' };
  }
}
