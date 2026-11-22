import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { evaluate } from '../src/evaluate';
import { parsePolicy } from '../src/policy';
import { generateKeyPair, sha256, signReceipt } from '../src/receipt';
import { signApproval } from '../src/approval';
import type { EvidenceReceipt, PolicyApproval } from '../src/types';

// Runs every conformance case in conformance/cases (the reference behavior other implementations can run too).
const DIR = path.join(__dirname, '..', 'conformance', 'cases');
const KEYS: Record<string, { publicKey: string; privateKey: string }> = {};
const key = (name: string) => (KEYS[name] ??= generateKeyPair());

function expandPolicy(text: string): string {
  return text.replace(/\{\{key:([\w-]+)\}\}/g, (_m, name) => key(name).publicKey.trim().split('\n').map((l) => `      ${l}`).join('\n'));
}

function expandReceipt(r: any, subject: any): EvidenceReceipt {
  let out: EvidenceReceipt = {
    schema: 'done-evidence-v1', kind: r.kind, check: { id: r.check, version: '1' },
    subject: { repository: r.repository ?? subject.repository, revision: r.revision },
    producer: { name: 'conformance', version: '1' }, execution: { identity: r.identity ?? 'local' },
    observedAt: r.observedAt ?? '2026-11-20T11:00:00Z', outcome: r.outcome, summary: r.summary ?? `${r.check} ${r.outcome}`,
    metrics: r.metrics ?? {}, limitations: r.limitations ?? [], findings: r.findings ?? [],
    ...(r.remedy ? { remedy: r.remedy } : {}),
  };
  if (r.sign) out = signReceipt(out, key(r.sign).privateKey, r.sign);
  if (r.tamper) out = { ...out, outcome: out.outcome === 'failed' ? 'passed' : 'failed' };
  return out;
}

// An approval of the case's policy edit. "edit": "earlier" approves a different edit; "base": "other" a different base.
function expandApproval(a: any, c: any, baseHash: string, newHash: string): PolicyApproval {
  let out: PolicyApproval = {
    schema: 'done-policy-approval-v1', repository: a.repository ?? c.subject.repository, policyPath: '.openthunder/done.yml',
    basePolicyHash: a.base === 'other' ? sha256('version: 1\n') : baseHash,
    newPolicyHash: a.edit === 'earlier' ? sha256('an earlier edit') : newHash,
    approver: a.approver, approvedAt: a.approvedAt ?? '2026-11-20T10:00:00Z', ...(a.reason ? { reason: a.reason } : {}),
  };
  if (a.sign) out = signApproval(out, key(a.sign).privateKey, a.sign);
  if (a.tamper) out = { ...out, newPolicyHash: sha256('a looser policy') };
  return out;
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

describe('Definition of Done conformance', () => {
  it('has the cases', () => { expect(files.length).toBeGreaterThanOrEqual(36); });
  for (const f of files) {
    const c = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    it(`${f}: ${c.name}`, () => {
      const baseText = expandPolicy(c.policy);
      const baseHash = sha256(baseText);
      const newHash = sha256(c.changedPolicy !== undefined ? expandPolicy(c.changedPolicy) : `${baseText}# edited\n`);
      const d = evaluate({
        policy: parsePolicy(baseText),
        integrity: {
          source: 'done-core.yml on main', editedByChange: !!c.policyEditedByChange,
          ...(c.approvals ? { basePolicyHash: baseHash, changedPolicyHash: newHash, approvals: c.approvals.map((a: any) => expandApproval(a, c, baseHash, newHash)) } : {}),
        },
        receipts: c.receipts.map((r: any) => expandReceipt(r, c.subject)),
        subject: c.subject, now: c.now,
      });
      const got = Object.fromEntries(d.items.map((i) => [i.id, i.status]));
      for (const [id, status] of Object.entries(c.expect.items)) expect(`${id}=${got[id]}`).toBe(`${id}=${status}`);
      for (const [id, status] of Object.entries(c.expect.underlying ?? {})) expect(d.items.find((i) => i.id === id)?.underlying).toBe(status);
      for (const [id, title] of Object.entries(c.expect.title ?? {})) expect(d.items.find((i) => i.id === id)?.title).toBe(title);
      for (const [id, text] of Object.entries(c.expect.evidenceIncludes ?? {})) expect(d.items.find((i) => i.id === id)?.evidence).toContain(text);
      for (const [id, next] of Object.entries(c.expect.next ?? {})) expect(d.items.find((i) => i.id === id)?.next).toBe(next);
      expect(d.state).toBe(c.expect.state);
      // Universal invariants, on every case:
      for (const i of d.items) {
        if (i.status === 'exception') expect(i.underlying).toBeDefined();       // an exception never hides what the evidence said
        if (i.status === 'passed') expect(i.exception).toBeUndefined();         // a pass is never an exception relabeled
      }
      if (d.items.some((i) => i.required && ['failed', 'not-checked', 'outdated'].includes(i.status))) expect(d.state).toBe('not-done');
    });
  }
});
