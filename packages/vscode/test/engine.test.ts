import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gather, classifyReport, detectBase, expiringExceptions, lineOfPath } from '../src/engine';
import { panelHtml, prMarkdown, assistantPrompt, statusBarText } from '../src/render';

let repo: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const touchOld = (rel: string) => { const t = new Date(Date.now() - 3600_000); fs.utimesSync(path.join(repo, rel), t, t); };
const opts = (reports: string[] = [], openApiFiles: string[] = []) => ({ root: repo, base: 'main', policyPath: '.openthunder/done-core.yml', reportFiles: reports.map((r) => path.join(repo, r)), openApiFiles, now: '2026-11-20T12:00:00Z' });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-vscode-core-'));
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  write('src/cart.ts', 'export const total = 1;\n');
  write('.openthunder/done-core.yml', 'version: 1\napprovers: [Jordan]\nrequire:\n  - tests\n  - coverage: { min: 80, of: changed }\n  - check: openapi-compat\n');
  write('openapi.json', JSON.stringify({ openapi: '3.0.3', paths: { '/cart': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { total: { type: 'number' } } } } } } } } } } }));
  git('add', '-A'); git('commit', '-qm', 'base'); git('checkout', '-q', '-b', 'f');
  write('src/cart.ts', 'export const total = 1;\nexport const count = 2;\n');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('gather: evidence found in the workspace, decided by OpenThunder Core', () => {
  it('no reports: Not done, every missing piece is Not checked, and API compatibility runs on its own', () => {
    const g = gather(opts([], ['openapi.json']));
    expect(g.adopted).toBe(true);
    const s = Object.fromEntries(g.decision.items.map((i) => [i.id, i.status]));
    expect(s).toMatchObject({ tests: 'not-checked', coverage: 'not-checked', 'check:openapi-compat': 'passed' });
    expect(g.decision.state).toBe('not-done');
  });

  it('fresh local reports count (labeled local); a report older than the code is Outdated, never a pass', () => {
    write('junit.xml', '<testsuite><testcase name="total"/><testcase name="count"/></testsuite>');
    write('coverage/lcov.info', `SF:${repo}/src/cart.ts\nDA:1,1\nDA:2,1\nend_of_record\n`);
    const g = gather(opts(['junit.xml', 'coverage/lcov.info'], ['openapi.json']));
    const byId = Object.fromEntries(g.decision.items.map((i) => [i.id, i]));
    expect(byId.tests).toMatchObject({ status: 'passed', basis: 'self-reported by local' });
    expect(byId.coverage.status).toBe('passed');
    expect(g.decision.state).toBe('done');
    touchOld('junit.xml');
    const later = gather(opts(['junit.xml', 'coverage/lcov.info'], ['openapi.json']));
    expect(later.decision.items.find((i) => i.id === 'tests')!.status).toBe('outdated');
    expect(later.reports.find((r) => r.file === 'junit.xml')!.status).toBe('outdated');
  });

  it('coverage gaps on changed lines and SARIF findings only on changed files', () => {
    write('coverage/lcov.info', `SF:${repo}/src/cart.ts\nDA:1,1\nDA:2,0\nend_of_record\n`);
    write('scan.sarif', JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'Semgrep' } }, results: [
      { ruleId: 'r1', level: 'error', message: { text: 'on the change' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/cart.ts' }, region: { startLine: 2 } } }] },
      { ruleId: 'r2', level: 'error', message: { text: 'old code' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/legacy.ts' }, region: { startLine: 9 } } }] },
    ] }] }));
    const g = gather(opts(['coverage/lcov.info', 'scan.sarif']));
    expect(g.coverageGaps).toEqual([{ file: 'src/cart.ts', line: 2 }]);
    expect(g.findings.map((f) => f.message)).toEqual(['on the change']);
  });

  it('a breaking API change is reported with its file, and fails the requirement', () => {
    write('openapi.json', JSON.stringify({ openapi: '3.0.3', paths: { '/cart': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: {} } } } } } } } } }));
    const g = gather(opts([], ['openapi.json']));
    expect(g.apiBreaks[0].file).toBe('openapi.json');
    expect(g.apiBreaks[0].findings[0].message).toMatch(/GET \/cart 200 body\.total: field removed/);
    expect(g.decision.items.find((i) => i.id === 'check:openapi-compat')!.status).toBe('failed');
  });

  it('editing the policy locally is flagged, and the base branch copy still judges the change', () => {
    write('.openthunder/done-core.yml', 'version: 1\nrequire: []\n');
    const g = gather(opts());
    expect(g.policyEditedLocally).toBe(true);
    expect(g.decision.items.find((i) => i.id === 'policy-intact')!.status).toBe('not-checked');
    expect(g.decision.items.some((i) => i.id === 'tests')).toBe(true);
  });

  it('no policy on the base branch: the OpenThunder default, marked as not adopted', () => {
    git('stash', '-q'); git('checkout', '-q', 'main'); git('rm', '-q', '.openthunder/done-core.yml'); git('commit', '-qm', 'rm'); git('checkout', '-q', 'f'); git('rebase', '-q', 'main'); git('stash', 'pop', '-q');
    const g = gather(opts());
    expect(g.adopted).toBe(false);
    expect(g.decision.policy.source).toMatch(/OpenThunder default/);
  });
});

describe('helpers', () => {
  it('classifies reports and finds the base branch', () => {
    expect(classifyReport('a/junit.xml', '<testsuite>')).toBe('junit');
    expect(classifyReport('coverage/lcov.info', 'SF:x')).toBe('lcov');
    expect(classifyReport('out.sarif', '{}')).toBe('sarif');
    expect(classifyReport('pom.xml', '<project>')).toBeUndefined();
    expect(detectBase(repo, '')).toBe('main');
    expect(detectBase(repo, 'release/1.2')).toBe('release/1.2');
  });
  it('exceptions expiring within two weeks, and the line of an API path', () => {
    const text = 'version: 1\nexceptions:\n  - { requirement: tests, reason: r, approver: J, expires: 2026-11-25 }\n  - { requirement: coverage, reason: r, approver: J, expires: 2027-03-01 }\n';
    expect(expiringExceptions(text, '2026-11-20')).toEqual([{ requirement: 'tests', expires: '2026-11-25', line: 3 }]);
    expect(lineOfPath('{\n  "paths": {\n    "/cart": {}\n  }\n}', '/cart')).toBe(3);
    expect(lineOfPath('paths:\n  /cart:\n    get: {}\n', '/cart')).toBe(2);
  });
});

describe('what the extension shows and copies', () => {
  it('panel: open items first with next step and why; escapes text; the policy guard and default notices', () => {
    write('.openthunder/done-core.yml', 'version: 1\nrequire: []\n');
    const g = gather(opts());
    const html = panelHtml({ decision: g.decision, adopted: g.adopted, policyEditedLocally: g.policyEditedLocally, reportsUsed: 0, reportsOutdated: 0 }, 'n0nce', 'vscode-resource:');
    expect(html.indexOf('What still keeps this change from Done')).toBeGreaterThan(-1);
    expect(html.indexOf('What still keeps this change from Done')).toBeLessThan(html.indexOf('<footer>'));
    expect(html).toMatch(/You are editing the policy/);
    expect(html).toMatch(/→ /);
    expect(html).toMatch(/Content-Security-Policy/);
    expect(html).not.toMatch(/<script>(?!.*nonce)/);
    expect(statusBarText(g.decision, true).text).toMatch(/DoD: \d+ open/);
  });
  it('PR markdown and the assistant prompt say what is open and forbid gaming the policy', () => {
    const g = gather(opts());
    expect(prMarkdown(g.decision)).toMatch(/^### Definition of Done: Not done\n/);
    expect(prMarkdown(g.decision)).toMatch(/\| Not checked \| Tests run and pass \|/);
    const p = assistantPrompt(g.decision);
    expect(p).toMatch(/Do not weaken the policy, delete tests, or lower thresholds/);
    expect(p).toMatch(/1\. /);
  });
});
