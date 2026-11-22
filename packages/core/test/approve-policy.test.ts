import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { main } from '../src/cli';
import { generateKeyPair } from '../src/receipt';

// `done-core approve-policy`: an approver the BASE policy names signs off on this change's edit to the policy, and
// `evaluate` then counts the edit as approved, until the policy is edited again.
let tmp: string; let repo: string; let keyFile: string; let strangerFile: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
const run = (argv: string[]) => {
  const lines: string[] = [];
  const code = main(argv, repo, {}, (s) => lines.push(s), (s) => lines.push(s));
  return { code, text: lines.join('\n') };
};
const indent = (pem: string) => pem.trim().split('\n').map((l) => `      ${l}`).join('\n');
const POLICY = '.openthunder/done.yml';
const write = (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text);
const intact = (argv: string[]) => {
  const r = run([...argv, '--json']);
  return JSON.parse(r.text).items.find((i: { id: string }) => i.id === 'policy-intact') as { status: string; evidence: string; next?: string };
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'done-core-approve-'));
  repo = path.join(tmp, 'work'); fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  const jordan = generateKeyPair(); const stranger = generateKeyPair();
  keyFile = path.join(tmp, 'jordan.pem'); fs.writeFileSync(keyFile, jordan.privateKey);
  strangerFile = path.join(tmp, 'stranger.pem'); fs.writeFileSync(strangerFile, stranger.privateKey);
  fs.mkdirSync(path.join(repo, '.openthunder'));
  write(POLICY, `version: 1\ntrust: any\nkeys:\n  - id: jordan\n    public-key: |\n${indent(jordan.publicKey)}\n    approver: "Jordan (tech lead)"\napprovers: ["Jordan (tech lead)"]\nrequire: []\nrecommend:\n  - coverage: { min: 80, of: changed }\n`);
  git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'pr');
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('done-core approve-policy', () => {
  it('approves an edit; evaluate counts it; a further edit makes it Outdated', () => {
    write(POLICY, fs.readFileSync(path.join(repo, POLICY), 'utf8').replace('min: 80', 'min: 60'));
    git('commit', '-qam', 'loosen coverage');
    const ev = ['evaluate', '--base', 'main', '--now', '2026-11-22T12:00:00Z'];
    expect(run(ev).code).toBe(1);
    const before = intact(ev);
    expect(before.status).toBe('not-checked');
    expect(before.next).toMatch(/done-core approve-policy/);

    const a = run(['approve-policy', '--base', 'main', '--key', keyFile, '--key-id', 'jordan', '--reason', 'flaky module', '--now', '2026-11-22T11:00:00Z']);
    expect(a.code).toBe(0);
    expect(a.text).toMatch(/Jordan \(tech lead\) approved this edit/);
    const files = fs.readdirSync(path.join(repo, '.openthunder/approvals'));
    expect(files).toHaveLength(1);
    git('add', '-A'); git('commit', '-qm', 'approval');

    expect(run(ev).code).toBe(0);
    const after = intact(ev);
    expect(after.status).toBe('passed');
    expect(after.evidence).toMatch(/Jordan \(tech lead\) approved this exact edit \(signed by key "jordan", 2026-11-22: flaky module\)/);

    // Code commits keep the approval; another policy edit does not.
    write(POLICY, fs.readFileSync(path.join(repo, POLICY), 'utf8').replace('min: 60', 'min: 10'));
    expect(run(ev).code).toBe(1);
    expect(intact(ev).status).toBe('outdated');
  });

  it('a hand-edited approval never counts', () => {
    write(POLICY, fs.readFileSync(path.join(repo, POLICY), 'utf8').replace('min: 80', 'min: 60'));
    expect(run(['approve-policy', '--base', 'main', '--key', keyFile, '--key-id', 'jordan']).code).toBe(0);
    const dir = path.join(repo, '.openthunder/approvals');
    const f = path.join(dir, fs.readdirSync(dir)[0]);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Jordan (tech lead)', 'Sam'));
    const r = intact(['evaluate', '--base', 'main']);
    expect(r.status).toBe('not-checked');
    expect(r.evidence).toMatch(/signature does not match/);
  });

  it('refuses when there is no edit, the key is unknown, or the private key does not match', () => {
    expect(run(['approve-policy', '--base', 'main', '--key', keyFile, '--key-id', 'jordan']).text).toMatch(/does not edit/);
    write(POLICY, fs.readFileSync(path.join(repo, POLICY), 'utf8').replace('min: 80', 'min: 60'));
    expect(run(['approve-policy', '--base', 'main', '--key', keyFile, '--key-id', 'nobody']).text).toMatch(/lists no key "nobody"/);
    const wrong = run(['approve-policy', '--base', 'main', '--key', strangerFile, '--key-id', 'jordan']);
    expect(wrong.code).toBe(1);
    expect(wrong.text).toMatch(/would not count/);
    expect(fs.existsSync(path.join(repo, '.openthunder/approvals'))).toBe(false);
    expect(run(['approve-policy', '--base', 'main']).code).toBe(2);
  });
});
