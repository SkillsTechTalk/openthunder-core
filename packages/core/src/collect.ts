// The collector: binds an imported result to the code it is about, and signs it when it runs with a trusted key.
// The collector is what makes CI evidence trustworthy without every test runner signing its own report: CI runs
// the tests, then runs the collector with a key only CI holds (a CI secret). On a laptop there is no key, so the
// receipt is self-reported and labeled so.
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeRepository, sha256, signReceipt } from './receipt';
import type { ImportedEvidence, ChangedLines } from './importers';
import type { EvidenceReceipt } from './types';

export const PRODUCER = { name: 'done-core', version: '0.1.0' };

export interface CollectContext {
  repository: string;
  revision: string;
  execution: EvidenceReceipt['execution'];
  observedAt?: string;
  artifact?: { name: string; bytes: Buffer | string };
  signing?: { privateKeyPem: string; keyId: string };
  /** The tool writing the receipt, when it is not done-core itself (a plugin analyzer). Part of what is signed. */
  producer?: { name: string; version: string };
}

export function buildReceipt(ev: ImportedEvidence, ctx: CollectContext): EvidenceReceipt {
  const r: EvidenceReceipt = {
    schema: 'done-evidence-v1', kind: ev.kind, check: ev.check,
    subject: { repository: ctx.repository, revision: ctx.revision },
    producer: ctx.producer ?? PRODUCER, execution: ctx.execution,
    observedAt: ctx.observedAt ?? new Date().toISOString(),
    ...(ctx.artifact ? { artifact: { name: ctx.artifact.name, digest: sha256(ctx.artifact.bytes) } } : {}),
    outcome: ev.outcome, summary: ev.summary, metrics: ev.metrics, limitations: ev.limitations, findings: ev.findings,
  };
  return ctx.signing ? signReceipt(r, ctx.signing.privateKeyPem, ctx.signing.keyId) : r;
}

export function writeReceipt(dir: string, r: EvidenceReceipt): string {
  fs.mkdirSync(dir, { recursive: true });
  const name = `${r.check.id}-${r.subject.revision.slice(0, 12)}-${crypto.randomBytes(3).toString('hex')}.json`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(r, null, 2) + '\n');
  return file;
}

export function readReceipts(dir: string): { receipts: EvidenceReceipt[]; unreadable: string[] } {
  const receipts: EvidenceReceipt[] = [];
  const unreadable: string[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return { receipts, unreadable }; }
  for (const n of names) {
    try { receipts.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch { unreadable.push(n); }
  }
  return { receipts, unreadable };
}

// ── git ──────────────────────────────────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): string | null {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
}

/** Repository identity: the normalized origin URL, or "local/<folder>" when there is no remote. */
export function repositoryIdentity(cwd: string): string {
  const url = git(cwd, ['config', '--get', 'remote.origin.url'])?.trim();
  if (url) return normalizeRepository(url);
  const top = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  return `local/${path.basename(top || cwd)}`;
}

/** The revision being decided. Uncommitted work is "<sha>-dirty", which no receipt for <sha> can match. */
export function currentRevision(cwd: string): { revision: string; dirty: boolean } {
  const head = git(cwd, ['rev-parse', 'HEAD'])?.trim();
  if (!head) throw new Error('Not a git repository with at least one commit.');
  const status = git(cwd, ['status', '--porcelain', '--untracked-files=normal']) ?? '';
  // Receipts the collector writes under .done/ never make the tree dirty.
  const dirty = status.split('\n').some((l) => l.trim() && !l.slice(3).startsWith('.done/'));
  return { revision: dirty ? `${head}-dirty` : head, dirty };
}

function mergeBase(cwd: string, base: string): string {
  const mb = git(cwd, ['merge-base', base, 'HEAD'])?.trim();
  if (!mb) throw new Error(`Base '${base}' did not resolve to a commit.`);
  return mb;
}

/** Files the change touches vs base (committed + uncommitted + untracked). */
export function changedFiles(cwd: string, base: string): string[] {
  const mb = mergeBase(cwd, base);
  const out = new Set<string>();
  for (const l of (git(cwd, ['diff', '--name-only', mb]) ?? '').split('\n')) if (l.trim()) out.add(l.trim());
  for (const l of (git(cwd, ['ls-files', '--others', '--exclude-standard']) ?? '').split('\n')) if (l.trim()) out.add(l.trim());
  return [...out].filter((f) => !f.startsWith('.done/')).sort();
}

/** Added or modified line numbers per file vs base (from `git diff -U0`). */
export function changedLines(cwd: string, base: string): ChangedLines {
  const mb = mergeBase(cwd, base);
  const out: ChangedLines = {};
  let file: string | undefined;
  for (const l of (git(cwd, ['diff', '-U0', '--no-color', mb]) ?? '').split('\n')) {
    if (l.startsWith('+++ ')) { file = l.startsWith('+++ b/') ? l.slice(6) : undefined; continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m && file) {
      const start = Number(m[1]), n = m[2] === undefined ? 1 : Number(m[2]);
      for (let i = 0; i < n; i++) (out[file] ??= []).push(start + i);
    }
  }
  return out;
}

export function fileAtRef(cwd: string, ref: string, rel: string): string | null {
  const commit = git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim();
  if (!commit) return null;
  return git(cwd, ['show', `${commit}:./${rel}`]);
}

/** Who is running this: CI identity from the environment, or "local". Never a host or user name. */
export function executionFromEnv(env: NodeJS.ProcessEnv = process.env): EvidenceReceipt['execution'] {
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY) {
    const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
    return { identity: `github-actions:${env.GITHUB_REPOSITORY.toLowerCase()}`, ...(env.GITHUB_RUN_ID ? { runId: env.GITHUB_RUN_ID } : {}), ...(runUrl ? { runUrl } : {}) };
  }
  if (env.GITLAB_CI === 'true' && env.CI_PROJECT_PATH) return { identity: `gitlab-ci:${env.CI_PROJECT_PATH.toLowerCase()}`, ...(env.CI_PIPELINE_ID ? { runId: env.CI_PIPELINE_ID } : {}) };
  return { identity: 'local' };
}

export const POLICY_FILE = '.openthunder/done.yml';
/** The earlier name, still read when the base branch has no done.yml. */
export const LEGACY_POLICY_FILE = '.openthunder/done-core.yml';

/** The policy that judges a change: the base branch's copy (an explicit path, else done.yml, else the earlier name). */
export function policyAtBase(cwd: string, base: string, explicit?: string): { policyPath: string; trustedText: string | null } {
  if (explicit) return { policyPath: explicit, trustedText: fileAtRef(cwd, base, explicit) };
  const text = fileAtRef(cwd, base, POLICY_FILE);
  if (text !== null) return { policyPath: POLICY_FILE, trustedText: text };
  const legacy = fileAtRef(cwd, base, LEGACY_POLICY_FILE);
  return legacy !== null ? { policyPath: LEGACY_POLICY_FILE, trustedText: legacy } : { policyPath: POLICY_FILE, trustedText: null };
}
