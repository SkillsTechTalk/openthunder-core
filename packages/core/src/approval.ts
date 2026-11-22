// Policy approvals: how an edit to the Definition of Done is approved outside the change that makes it.
// The change is still judged by the base branch's policy. An approval only says that an approver the BASE policy
// names, holding a key the BASE policy lists for them, signed off on exactly this edit (the text before and after).
// It cannot be produced by the change author without that key, and it cannot be moved to a different edit.
import * as crypto from 'crypto';
import { canonicalJson, normalizeRepository, sha256 } from './receipt';
import type { Policy, PolicyApproval } from './types';

export const APPROVALS_DIR = '.openthunder/approvals';
/** The hash recorded for a policy file the change deletes. */
export const ABSENT_POLICY = 'absent';

export function policyTextHash(text: string | null): string {
  return text === null ? ABSENT_POLICY : sha256(text);
}

export function approvalPayload(a: PolicyApproval): string {
  const { signature: _s, ...rest } = a;
  return canonicalJson(rest);
}

export function signApproval(a: PolicyApproval, privateKeyPem: string, keyId: string): PolicyApproval {
  const value = crypto.sign(null, Buffer.from(approvalPayload(a)), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return { ...a, signature: { keyId, alg: 'ed25519', value } };
}

/** The file an approval is written to (one per approved edit). */
export function approvalFileName(a: PolicyApproval): string {
  return `${a.newPolicyHash.replace(/^sha256:/, '').slice(0, 16)}.json`;
}

function problems(a: unknown): string[] {
  if (!a || typeof a !== 'object') return ['not an object'];
  const o = a as Record<string, unknown>;
  const p: string[] = [];
  if (o.schema !== 'done-policy-approval-v1') p.push('unknown schema');
  for (const k of ['repository', 'policyPath', 'basePolicyHash', 'newPolicyHash', 'approver']) if (typeof o[k] !== 'string' || !o[k]) p.push(`${k} required`);
  if (typeof o.approvedAt !== 'string' || Number.isNaN(Date.parse(o.approvedAt))) p.push('approvedAt must be a date');
  return p;
}

export type ApprovalVerdict =
  | { status: 'valid'; approval: PolicyApproval; keyId: string }
  | { status: 'stale'; approval: PolicyApproval; keyId: string; reason: string }
  | { status: 'invalid'; reason: string };

/**
 * Check one approval against the BASE policy and the edit under review.
 *   valid    signed by an approver's key the base policy lists, for this repository and exactly this edit
 *   stale    genuine, but for a different edit (the policy changed again, or the base policy moved)
 *   invalid  malformed, unsigned, unknown or non-approver key, bad signature, name not an approver, other repository
 */
export function verifyApproval(
  raw: unknown, base: Policy, edit: { repository: string; basePolicyHash: string; changedPolicyHash: string },
): ApprovalVerdict {
  const p = problems(raw);
  if (p.length) return { status: 'invalid', reason: `malformed approval: ${p.join('; ')}` };
  const a = raw as PolicyApproval;
  if (!a.signature) return { status: 'invalid', reason: `the approval by ${a.approver} is not signed` };
  const key = base.keys.find((k) => k.id === a.signature!.keyId);
  if (!key) return { status: 'invalid', reason: `the approval is signed by key "${a.signature.keyId}", which the base policy does not list` };
  if (a.signature.alg !== 'ed25519') return { status: 'invalid', reason: `unsupported signature algorithm ${a.signature.alg}` };
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(approvalPayload(a)), crypto.createPublicKey(key.publicKey), Buffer.from(a.signature.value, 'base64')); }
  catch { ok = false; }
  if (!ok) return { status: 'invalid', reason: 'the approval\'s signature does not match it (changed after signing, or the wrong key)' };
  if (!key.approver) return { status: 'invalid', reason: `key "${key.id}" is not an approver's key (add "approver:" to it in the base policy)` };
  if (key.approver !== a.approver) return { status: 'invalid', reason: `key "${key.id}" belongs to ${key.approver}, but the approval names ${a.approver}` };
  if (!base.approvers.includes(a.approver)) return { status: 'invalid', reason: `${a.approver} is not in the base policy's approvers` };
  if (normalizeRepository(a.repository) !== normalizeRepository(edit.repository)) return { status: 'invalid', reason: `the approval is for another repository (${a.repository})` };
  if (a.basePolicyHash !== edit.basePolicyHash) return { status: 'stale', approval: a, keyId: key.id, reason: 'the base branch\'s policy changed after it was approved' };
  if (a.newPolicyHash !== edit.changedPolicyHash) return { status: 'stale', approval: a, keyId: key.id, reason: 'the policy was edited again after it was approved' };
  return { status: 'valid', approval: a, keyId: key.id };
}
