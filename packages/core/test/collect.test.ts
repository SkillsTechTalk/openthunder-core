import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildReceipt, readReceipts, writeReceipt, currentRevision, changedFiles, changedLines, executionFromEnv, repositoryIdentity, fileAtRef } from '../src/collect';
import { generateKeyPair, verifyReceipt } from '../src/receipt';
import { importJUnit } from '../src/importers';

describe('buildReceipt', () => {
  it('binds the result to the subject, digests the report, and signs with the producer included', () => {
    const k = generateKeyPair();
    const r = buildReceipt(importJUnit('<testsuite><testcase name="a"/></testsuite>'), {
      repository: 'example.com/acme/app', revision: 'c'.repeat(40), execution: { identity: 'github-actions:acme/app' },
      observedAt: '2026-11-20T10:00:00Z', artifact: { name: 'junit.xml', bytes: 'x' }, producer: { name: 'plugin', version: '2' },
      signing: { privateKeyPem: k.privateKey, keyId: 'ci' },
    });
    expect(r).toMatchObject({ subject: { revision: 'c'.repeat(40) }, producer: { name: 'plugin', version: '2' }, artifact: { name: 'junit.xml' }, outcome: 'passed' });
    expect(r.artifact!.digest).toBe('sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
    expect(verifyReceipt(r, [{ id: 'ci', publicKey: k.publicKey }]).trust).toBe('trusted');
    expect(verifyReceipt({ ...r, producer: { name: 'someone-else', version: '2' } }, [{ id: 'ci', publicKey: k.publicKey }]).trust).toBe('invalid');
  });
});

describe('executionFromEnv never names the machine or the person', () => {
  it('CI identities from the environment; otherwise just "local"', () => {
    expect(executionFromEnv({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'Acme/App', GITHUB_RUN_ID: '7', GITHUB_SERVER_URL: 'https://github.com' })).toEqual({ identity: 'github-actions:acme/app', runId: '7', runUrl: 'https://github.com/Acme/App/actions/runs/7' });
    expect(executionFromEnv({ GITLAB_CI: 'true', CI_PROJECT_PATH: 'acme/app' })).toEqual({ identity: 'gitlab-ci:acme/app' });
    expect(executionFromEnv({ USER: 'someone', HOSTNAME: 'laptop' })).toEqual({ identity: 'local' });
  });
});

describe('git helpers', () => {
  let repo: string;
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'done-core-collect-'));
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'one\ntwo\nthree\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    git('checkout', '-q', '-b', 'f');
  });
  afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

  it('changed files and changed lines vs base, untracked files included, receipts under .done/ excluded', () => {
    fs.writeFileSync(path.join(repo, 'a.ts'), 'one\nTWO\nthree\nfour\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'new\n');
    fs.mkdirSync(path.join(repo, '.done/receipts'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.done/receipts/x.json'), '{}');
    expect(changedFiles(repo, 'main')).toEqual(['a.ts', 'b.ts']);
    expect(changedLines(repo, 'main')).toEqual({ 'a.ts': [2, 4] });
  });

  it('uncommitted work is "<sha>-dirty"; receipts alone do not make the tree dirty', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    fs.mkdirSync(path.join(repo, '.done/receipts'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.done/receipts/x.json'), '{}');
    expect(currentRevision(repo)).toEqual({ revision: head, dirty: false });
    fs.writeFileSync(path.join(repo, 'a.ts'), 'changed\n');
    expect(currentRevision(repo)).toEqual({ revision: `${head}-dirty`, dirty: true });
  });

  it('repository identity from origin, or local/<folder>; files read at a ref', () => {
    expect(repositoryIdentity(repo)).toBe(`local/${path.basename(repo)}`);
    git('remote', 'add', 'origin', 'https://github.com/Acme/App.git');
    expect(repositoryIdentity(repo)).toBe('github.com/acme/app');
    expect(fileAtRef(repo, 'main', 'a.ts')).toBe('one\ntwo\nthree\n');
    expect(fileAtRef(repo, 'main', 'missing.ts')).toBeNull();
    expect(fileAtRef(repo, 'no-such-ref', 'a.ts')).toBeNull();
  });

  it('write and read receipts; an unreadable file is reported, not trusted', () => {
    const dir = path.join(repo, '.done/receipts');
    const r = buildReceipt(importJUnit('<testsuite><testcase name="a"/></testsuite>'), { repository: 'r', revision: 'abc', execution: { identity: 'local' } });
    writeReceipt(dir, r);
    fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
    const back = readReceipts(dir);
    expect(back.receipts.length).toBe(1);
    expect(back.unreadable).toEqual(['broken.json']);
    expect(readReceipts(path.join(repo, 'nowhere'))).toEqual({ receipts: [], unreadable: [] });
  });
});
