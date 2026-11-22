import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateKeyPair, signReceipt, verifyReceipt, normalizeRepository } from '../src/receipt';
import { evaluate, renderDecision, globMatch } from '../src/evaluate';
import { parsePolicy } from '../src/policy';
import { main } from '../src/cli';
import type { EvidenceReceipt } from '../src/types';

const receipt = (over: Partial<EvidenceReceipt> = {}): EvidenceReceipt => ({
  schema: 'done-evidence-v1', kind: 'tests', check: { id: 'junit', version: '1' },
  subject: { repository: 'example.com/acme/app', revision: 'a'.repeat(40) }, producer: { name: 'done-core', version: '0.1.0' },
  execution: { identity: 'github-actions:acme/app' }, observedAt: '2026-11-20T10:00:00Z', outcome: 'passed',
  summary: '3 tests ran and passed.', metrics: { executed: 3 }, limitations: [], findings: [], ...over,
});

describe('receipts', () => {
  it('sign and verify; any change after signing is caught; identities a key may vouch for are enforced', () => {
    const k = generateKeyPair();
    const keys = [{ id: 'ci', publicKey: k.publicKey, identities: ['github-actions:acme/app'] }];
    const signed = signReceipt(receipt(), k.privateKey, 'ci');
    expect(verifyReceipt(signed, keys).trust).toBe('trusted');
    expect(verifyReceipt({ ...signed, metrics: { executed: 300 } }, keys)).toMatchObject({ trust: 'invalid' });
    expect(verifyReceipt(receipt(), keys).trust).toBe('self-reported');
    expect(verifyReceipt(signReceipt(receipt({ execution: { identity: 'local' } }), k.privateKey, 'ci'), keys).reason).toMatch(/may not vouch for local/);
    expect(verifyReceipt({ ...receipt(), subject: { repository: '', revision: '' } } as EvidenceReceipt, keys).trust).toBe('invalid');
  });
  it('repository identities compare across https, ssh, and .git spellings', () => {
    expect(normalizeRepository('git@github.com:Acme/App.git')).toBe('github.com/acme/app');
    expect(normalizeRepository('https://github.com/acme/app')).toBe('github.com/acme/app');
    expect(normalizeRepository('https://token@github.com/acme/app.git/')).toBe('github.com/acme/app');
  });
  it('globs', () => {
    expect(globMatch('src/**', 'src/a/b.ts')).toBe(true);
    expect(globMatch('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(globMatch('**/*.test.ts', 'a/b.test.ts')).toBe(true);
  });
});

describe('the decision explains itself', () => {
  it('each open item has why, evidence, and next; the record names the policy hash and evaluation time', () => {
    const d = evaluate({
      policy: parsePolicy('version: 1\nrequire:\n  - tests\n  - coverage: { min: 80 }\n'),
      integrity: { source: 'done-core.yml on main', editedByChange: false },
      receipts: [receipt({ subject: { repository: 'example.com/acme/app', revision: 'b'.repeat(40) } })],
      subject: { repository: 'example.com/acme/app', revision: 'a'.repeat(40), changedFiles: ['src/a.ts'] }, now: '2026-11-20T12:00:00Z',
    });
    const tests = d.items.find((i) => i.id === 'tests')!;
    expect(tests).toMatchObject({ status: 'outdated', next: 'Run it again on the current code and collect the result.' });
    expect(tests.evidence).toMatch(/only evidence is for revision bbbbbbbbbbbb, not revision aaaaaaaaaaaa/);
    expect(d.policy.hash).toMatch(/^sha256:/);
    const text = renderDecision(d);
    expect(text).toMatch(/^Definition of Done: Not done\n2 of 3 required items open/);
    expect(text).toMatch(/What still keeps this change from Done:/);
    expect(text).toMatch(/Why: The team requires/);
  });
  it('refuses to decide without an explicit evaluation time', () => {
    expect(() => evaluate({ policy: parsePolicy('version: 1\n'), integrity: { source: 'x', editedByChange: false }, receipts: [], subject: { repository: 'r', revision: 'a', changedFiles: [] }, now: 'soon' })).toThrow(/must be an ISO date/);
  });
});

describe('done-core CLI, end to end in a git repository', () => {
  let repo: string;
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  const run = (argv: string[], env: NodeJS.ProcessEnv = {}) => {
    const out: string[] = [];
    const code = main(argv, repo, env, (s) => out.push(s), (s) => out.push(s));
    return { code, text: out.join('\n') };
  };
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'done-core-cli-'));
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
    git('remote', 'add', 'origin', 'git@example.com:acme/app.git');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/cart.ts'), 'export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n');
    expect(run(['init']).code).toBe(0);
    git('add', '-A'); git('commit', '-qm', 'base');
    git('checkout', '-q', '-b', 'feature');
    fs.appendFileSync(path.join(repo, 'src/cart.ts'), 'export const count = (xs: number[]) => xs.length;\n');
    git('commit', '-qam', 'add count');
  });
  afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

  it('no evidence: Not done; a JUnit report for this revision: Done; a new commit makes it Outdated', () => {
    const none = run(['evaluate', '--base', 'main', '--now', '2026-11-20T12:00:00Z']);
    expect(none.code).toBe(1);
    expect(none.text).toMatch(/Tests run and pass\n\s+No evidence for this requirement/);
    fs.writeFileSync(path.join(repo, 'junit.xml'), '<testsuite><testcase name="total"/><testcase name="count"/></testsuite>');
    fs.writeFileSync(path.join(repo, 'empty.sarif'), JSON.stringify({ runs: [{ tool: { driver: { name: 'Semgrep' } }, results: [] }] }));
    fs.writeFileSync(path.join(repo, '.gitignore'), 'junit.xml\nempty.sarif\n.done/\n');
    git('add', '.gitignore'); git('commit', '-qm', 'ignore reports');
    expect(run(['collect', '--format', 'junit', '--report', 'junit.xml']).text).toMatch(/junit: 2 tests ran and passed\.\nReceipt: .*self-reported: no signing key/);
    run(['collect', '--format', 'sarif', '--report', 'empty.sarif']);
    const done = run(['evaluate', '--base', 'main', '--now', '2026-11-20T12:00:00Z']);
    expect(done.text).toMatch(/^Definition of Done: Done/);
    expect(done.text).toMatch(/self-reported by local/);
    expect(done.code).toBe(0);
    fs.appendFileSync(path.join(repo, 'src/cart.ts'), '// more\n');
    git('commit', '-qam', 'more');
    const later = run(['evaluate', '--base', 'main', '--now', '2026-11-20T12:00:00Z']);
    expect(later.code).toBe(1);
    expect(later.text).toMatch(/Outdated\s+Tests run and pass/);
  });

  it('signed in "CI": a policy that requires trusted CI counts only the signed receipt', () => {
    const k = generateKeyPair();
    const policy = `version: 1\ntrust: ci\nkeys:\n  - id: ci\n    public-key: |\n${k.publicKey.trim().split('\n').map((l) => `      ${l}`).join('\n')}\n    identities: ["github-actions:acme/app"]\nrequire:\n  - tests\n`;
    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, '.openthunder/done-core.yml'), policy);
    git('commit', '-qam', 'require ci');
    git('checkout', '-q', 'feature'); git('rebase', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'junit.xml'), '<testsuite><testcase name="a"/></testsuite>');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'junit.xml\n.done/\n'); git('add', '.gitignore'); git('commit', '-qm', 'ignore');
    run(['collect', '--format', 'junit', '--report', 'junit.xml']);
    expect(run(['evaluate', '--base', 'main', '--now', '2026-11-20T12:00:00Z']).text).toMatch(/Only self-reported evidence \(local\)/);
    const ci = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '42', DONE_CORE_SIGNING_KEY: k.privateKey, DONE_CORE_KEY_ID: 'ci' };
    expect(run(['collect', '--format', 'junit', '--report', 'junit.xml'], ci).text).toMatch(/signed with key "ci"/);
    const r = run(['evaluate', '--base', 'main', '--now', '2026-11-20T12:00:00Z']);
    expect(r.text).toMatch(/^Definition of Done: Done/);
    expect(r.text).toMatch(/trusted CI: github-actions:acme\/app/);
  });

  it('a change that loosens the policy is judged by the base branch copy and stays Not done', () => {
    fs.writeFileSync(path.join(repo, '.openthunder/done-core.yml'), 'version: 1\nrequire: []\n');
    git('commit', '-qam', 'loosen');
    const r = run(['evaluate', '--base', 'main', '--now', '2026-11-20T12:00:00Z']);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/This change edits the policy\. It was judged by \.openthunder\/done-core\.yml on main/);
    expect(r.text).toMatch(/Tests run and pass/);
  });

  it('OpenAPI: a removed response field that compiles and passes tests is caught', () => {
    git('checkout', '-q', 'main');
    const spec = { openapi: '3.0.3', paths: { '/cart': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { total: { type: 'number' }, count: { type: 'integer' } } } } } } } } } } };
    fs.writeFileSync(path.join(repo, 'openapi.json'), JSON.stringify(spec));
    git('add', '-A'); git('commit', '-qm', 'spec');
    git('checkout', '-q', 'feature'); git('rebase', '-q', 'main');
    delete (spec.paths['/cart'].get.responses[200].content['application/json'].schema.properties as any).count;
    fs.writeFileSync(path.join(repo, 'openapi.json'), JSON.stringify(spec));
    git('commit', '-qam', 'drop count from the response');
    expect(run(['openapi', '--spec', 'openapi.json', '--base', 'main']).text).toMatch(/openapi-compat: 1 breaking change to the declared API \(first: GET \/cart 200 body\.count: field removed from the response\)/);
  });
});
