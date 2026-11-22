import { describe, it, expect } from 'vitest';
import { importJUnit, importLcov, importSarif } from '../src/importers';
import { compareOpenApi, parseSpec } from '../src/openapi';

describe('JUnit: nothing that proves nothing ever passes', () => {
  it('passing, failing, partly skipped', () => {
    const pass = importJUnit('<testsuite tests="2"><testcase classname="a" name="one"/><testcase name="two"></testcase></testsuite>');
    expect(pass).toMatchObject({ outcome: 'passed', metrics: { tests: 2, executed: 2, failures: 0 } });
    const fail = importJUnit('<testsuites><testsuite><testcase classname="Cart" name="totals"><failure message="expected 3 got 4"/></testcase><testcase name="ok"/></testsuite></testsuites>');
    expect(fail).toMatchObject({ outcome: 'failed', summary: '1 of 2 executed tests failed.' });
    expect(fail.findings[0].message).toBe('Cart > totals: expected 3 got 4');
    const some = importJUnit('<testsuite><testcase name="a"/><testcase name="b"><skipped/></testcase></testsuite>');
    expect(some).toMatchObject({ outcome: 'passed', summary: '1 test ran and passed, 1 skipped.' });
    expect(some.limitations).toContain('1 of 2 tests were skipped.');
  });
  it('zero tests, all skipped, and not-JUnit are Not checked', () => {
    expect(importJUnit('<testsuite tests="0"></testsuite>').outcome).toBe('not-checked');
    expect(importJUnit('<testsuite><testcase name="a"><skipped/></testcase></testsuite>')).toMatchObject({ outcome: 'not-checked', summary: 'All 1 tests were skipped.' });
    expect(importJUnit('{"not":"xml"}').outcome).toBe('not-checked');
  });
  it('a <testcase> mentioned inside a comment or CDATA is not counted', () => {
    expect(importJUnit('<testsuite><!-- <testcase name="ghost"/> --></testsuite>').outcome).toBe('not-checked');
  });
});

describe('lcov', () => {
  const LCOV = 'SF:/repo/src/a.ts\nDA:1,1\nDA:2,0\nDA:3,4\nend_of_record\nSF:/repo/src/b.ts\nDA:1,0\nend_of_record\n';
  it('measures the total, and the changed lines when given them, with repo-relative paths', () => {
    const r = importLcov(LCOV, { stripPrefix: '/repo/', changedLines: { 'src/a.ts': [2, 3, 9], 'src/new.ts': [1] } });
    expect(r).toMatchObject({ outcome: 'measured', metrics: { linesFound: 4, linesHit: 2, coveragePercent: 50, changedLinesFound: 2, changedLinesHit: 1, changedCoveragePercent: 50 } });
    expect(r.findings).toEqual([{ message: 'changed line not covered', file: 'src/a.ts', line: 2 }]);
    expect(r.limitations.join(' ')).toMatch(/2 changed lines are not instrumented/);
  });
  it('without changed lines, says changed-line coverage was not measured', () => {
    expect(importLcov(LCOV).limitations.join(' ')).toMatch(/changed-line coverage was not measured/);
  });
  it('empty or foreign files are Not checked', () => {
    expect(importLcov('').outcome).toBe('not-checked');
    expect(importLcov('SF:a.ts\nend_of_record\n').outcome).toBe('not-checked');
  });
});

describe('SARIF', () => {
  it('measures findings by level, skips suppressed ones, keeps file and line', () => {
    const r = importSarif(JSON.stringify({ runs: [{ tool: { driver: { name: 'Semgrep' } }, results: [
      { ruleId: 'sql-injection', level: 'error', message: { text: 'SQL built from input' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/db.ts' }, region: { startLine: 12 } } }] },
      { ruleId: 'x', message: { text: 'w' } },
      { ruleId: 'y', level: 'error', message: { text: 'suppressed' }, suppressions: [{ kind: 'inSource' }] },
    ] }] }));
    expect(r).toMatchObject({ outcome: 'measured', metrics: { errors: 1, warnings: 1, findings: 2 } });
    expect(r.findings[0]).toEqual({ message: 'SQL built from input', file: 'src/db.ts', line: 12, severity: 'error', rule: 'sql-injection' });
  });
  it('not JSON, no runs, or zero runs is Not checked', () => {
    expect(importSarif('nope').outcome).toBe('not-checked');
    expect(importSarif('{}').outcome).toBe('not-checked');
    expect(importSarif('{"runs":[]}').outcome).toBe('not-checked');
  });
});

describe('OpenAPI compatibility', () => {
  const v1 = {
    openapi: '3.0.3', paths: {
      '/orders/{id}': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } } } },
      '/orders': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { item: { type: 'string' }, note: { type: 'string' } }, required: ['item'] } } } }, responses: { 201: {} } } },
    },
    components: { schemas: { Order: { type: 'object', properties: { id: { type: 'string' }, total: { type: 'number' }, lines: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' } } } } } } } },
  };
  const clone = () => JSON.parse(JSON.stringify(v1));

  it('additions are never breaking', () => {
    const v2 = clone();
    v2.components.schemas.Order.properties.currency = { type: 'string' };
    v2.paths['/health'] = { get: { responses: { 200: {} } } };
    expect(compareOpenApi(v1, v2)).toMatchObject({ outcome: 'passed', metrics: { operationsCompared: 2, breakingChanges: 0 } });
  });

  it('a removed response field (through a $ref, nested in an array), a retyped field, a newly required request field, a removed operation', () => {
    const v2 = clone();
    delete v2.components.schemas.Order.properties.lines.items.properties.sku;
    v2.components.schemas.Order.properties.total = { type: 'string' };
    v2.paths['/orders'].post.requestBody.content['application/json'].schema.required = ['item', 'note'];
    delete v2.paths['/orders/{id}'].get;
    v2.paths['/orders/{id}'].delete = { responses: { 204: {} } };
    const r = compareOpenApi(v1, v2, 'openapi.json');
    expect(r.outcome).toBe('failed');
    expect(r.findings.map((f) => f.rule).sort()).toEqual(['operation-removed', 'request-field-now-required']);
    const v3 = clone();
    delete v3.components.schemas.Order.properties.lines.items.properties.sku;
    v3.components.schemas.Order.properties.total = { type: 'string' };
    expect(compareOpenApi(v1, v3).findings.map((f) => f.message)).toEqual([
      'GET /orders/{id} 200 body.total: type changed from number to string',
      'GET /orders/{id} 200 body.lines[].sku: field removed from the response',
    ]);
  });

  it('YAML specs parse; Swagger 2.0 and non-specs are Not checked, never passed', () => {
    expect(parseSpec('openapi: 3.0.0\npaths: {}\n').openapi).toBe('3.0.0');
    expect(compareOpenApi({ swagger: '2.0', paths: {} }, { swagger: '2.0', paths: {} }).outcome).toBe('not-checked');
    expect(compareOpenApi({ hello: 1 }, v1).outcome).toBe('not-checked');
    expect(compareOpenApi({ openapi: '3.0.0', paths: {} }, v1).outcome).toBe('not-checked');
  });
});
