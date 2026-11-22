import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { main } from '../src/cli';
import { generateKeyPair } from '../src/receipt';
import { decisionMarkdown } from '../src/markdown';

// `done-core ci`: what the GitHub Action runs. Collect the workflow's reports, evaluate against the base branch's
// policy, write the run summary and outputs, fail the job only in enforce mode.
let tmp: string; let repo: string; let summary: string; let outputs: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
const run = (argv: string[], env: NodeJS.ProcessEnv = {}) => {
  const lines: string[] = [];
  const code = main(argv, repo, { GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: outputs, ...env }, (s) => lines.push(s), (s) => lines.push(s));
  return { code, text: lines.join('\n') };
};
const key = generateKeyPair();
const pem = key.publicKey.trim().split('\n').map((l) => `      ${l}`).join('\n');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'done-core-ci-'));
  const remote = path.join(tmp, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  repo = path.join(tmp, 'work'); fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  git('remote', 'add', 'origin', remote);
  fs.mkdirSync(path.join(repo, '.openthunder')); fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, '.openthunder/done.yml'), `version: 1\ntrust: ci\nkeys:\n  - id: ci\n    public-key: |\n${pem}\nrequire:\n  - tests\n  - check: openapi-compat\n`);
  fs.writeFileSync(path.join(repo, 'openapi.json'), JSON.stringify({ openapi: '3.0.3', paths: { '/a': { get: { responses: { 200: {} } } } } }));
  fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'junit.xml\n.done/\n');
  git('add', '-A'); git('commit', '-qm', 'base'); git('push', '-q', 'origin', 'main'); git('fetch', '-q', 'origin');
  git('checkout', '-q', '-b', 'pr');
  fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
  git('commit', '-qam', 'change');
  fs.writeFileSync(path.join(repo, 'junit.xml'), '<testsuite><testcase name="a"/></testsuite>');
  summary = path.join(tmp, 'summary.md'); outputs = path.join(tmp, 'outputs.txt');
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('done-core ci', () => {
  it('in a pull request, with the CI signing key: base from GITHUB_BASE_REF, Done, summary and outputs written', () => {
    const r = run(['ci', '--junit', 'junit.xml', '--openapi', 'openapi.json', '--now', '2026-11-21T12:00:00Z'], { GITHUB_BASE_REF: 'main', GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/app', DONE_CORE_SIGNING_KEY: key.privateKey, DONE_CORE_KEY_ID: 'ci' });
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/^Definition of Done: Done/);
    expect(r.text).toMatch(/trusted CI: github-actions:acme\/app/);
    expect(fs.readFileSync(summary, 'utf8')).toMatch(/^### Definition of Done: Done\n/);
    expect(fs.readFileSync(outputs, 'utf8')).toBe('state=done\nopen=0\n');
  });

  it('without a key, trust: ci counts nothing; report mode never fails the job, enforce mode does', () => {
    const report = run(['ci', '--base', 'origin/main', '--junit', 'junit.xml', '--openapi', 'openapi.json']);
    expect(report.code).toBe(0);
    expect(report.text).toMatch(/Only self-reported evidence/);
    expect(report.text).toMatch(/report mode: this does not fail the job/);
    expect(fs.readFileSync(summary, 'utf8')).toMatch(/No signing key was configured/);
    expect(fs.readFileSync(outputs, 'utf8')).toMatch(/^state=not-done\nopen=2\n/);
    expect(run(['ci', '--base', 'origin/main', '--junit', 'junit.xml', '--openapi', 'openapi.json', '--mode', 'enforce']).code).toBe(1);
  });

  it('a report named in the workflow but missing is said, and its requirement stays Not checked', () => {
    const r = run(['ci', '--base', 'origin/main', '--junit', 'reports/junit.xml'], { DONE_CORE_SIGNING_KEY: key.privateKey, DONE_CORE_KEY_ID: 'ci', GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/app' });
    expect(r.text).toMatch(/A report named in the workflow was not found: reports\/junit\.xml/);
    expect(r.text).toMatch(/Not checked\s+Tests run and pass/);
  });

  it('no policy on the base branch: says how to set it up; fails only in enforce mode', () => {
    git('checkout', '-q', 'main'); git('rm', '-q', '.openthunder/done.yml'); git('commit', '-qm', 'rm'); git('push', '-q', 'origin', 'main'); git('fetch', '-q', 'origin'); git('checkout', '-q', 'pr');
    expect(run(['ci', '--base', 'origin/main']).text).toMatch(/No \.openthunder\/done\.yml on origin\/main/);
    expect(run(['ci', '--base', 'origin/main', '--mode', 'enforce']).code).toBe(1);
    expect(fs.readFileSync(summary, 'utf8')).toMatch(/### Definition of Done: not set up/);
  });

  it('refuses to guess the base outside a pull request, and rejects an unknown mode', () => {
    expect(run(['ci']).code).toBe(2);
    expect(run(['ci', '--base', 'origin/main', '--mode', 'strict']).code).toBe(2);
  });
});

describe('decisionMarkdown', () => {
  it('open items first, met next, recommended collapsed, exceptions keep what the evidence said', () => {
    const md = decisionMarkdown({
      schema: 'done-decision-v1', state: 'not-done', label: 'Not done', summary: '1 of 3 required items open.',
      subject: { repository: 'r', revision: 'a'.repeat(40), changedFiles: [] }, policy: { source: 'done-core.yml on main', hash: 'sha256:' + '1'.repeat(64) },
      evaluatedAt: '2026-11-21T12:00:00Z', notes: ['a note'],
      items: [
        { id: 'tests', title: 'Tests run and pass', required: true, status: 'outdated', why: 'w', evidence: 'old | report', next: 'Run again' },
        { id: 'x', title: 'Load test', required: true, status: 'exception', underlying: 'not-checked', why: 'w', evidence: 'No evidence.', exception: { requirement: 'x', reason: 'no env', approver: 'Jordan', expires: '2026-12-31' } },
        { id: 'c', title: 'Coverage', required: false, status: 'not-checked', why: 'w', evidence: 'No report.' },
      ],
    });
    expect(md.indexOf('What still keeps this change from Done')).toBeLessThan(md.indexOf('Required, met'));
    expect(md).toMatch(/\| Outdated \| Tests run and pass \| old \\\| report \| Run again \|/);
    expect(md).toMatch(/\| Exception approved \| Load test \| Was Not checked: No evidence\. Accepted by Jordan until 2026-12-31: "no env"\. \|/);
    expect(md).toMatch(/<details><summary>Recommended/);
    expect(md).toMatch(/> a note/);
  });
});
