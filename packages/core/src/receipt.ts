// Receipts: canonical form, digest, signing, and verification.
// A signature says WHO produced a record and that it was not changed afterwards. It does not say the test was
// meaningful, and it does not make a self-asserted field true: that is why trust is decided here, against keys the
// trusted policy names, and why a key can be limited to the execution identities it may vouch for.
import * as crypto from 'crypto';
import type { EvidenceReceipt, ReceiptTrust, TrustedKey } from './types';

/** Deterministic JSON: sorted keys, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const o = value as Record<string, unknown>;
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

export function sha256(data: string | Buffer): string {
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
}

/** The bytes a signature covers: the receipt without its signature. */
export function signingPayload(r: EvidenceReceipt): string {
  const { signature: _s, ...rest } = r;
  return canonicalJson(rest);
}

export function signReceipt(r: EvidenceReceipt, privateKeyPem: string, keyId: string): EvidenceReceipt {
  const value = crypto.sign(null, Buffer.from(signingPayload(r)), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return { ...r, signature: { keyId, alg: 'ed25519', value } };
}

export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

const KINDS = new Set(['tests', 'coverage', 'security', 'check']);
const OUTCOMES = new Set(['passed', 'failed', 'not-checked', 'measured', 'not-applicable']);

/** Structural problems with a receipt (empty = well-formed). */
export function receiptProblems(r: unknown): string[] {
  const p: string[] = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  const o = r as Record<string, any>;
  if (o.schema !== 'done-evidence-v1') p.push('unknown schema');
  if (!KINDS.has(o.kind)) p.push('unknown kind');
  if (!o.check || typeof o.check.id !== 'string' || !o.check.id || typeof o.check.version !== 'string') p.push('check id and version required');
  if (!o.subject || typeof o.subject.repository !== 'string' || !o.subject.repository || typeof o.subject.revision !== 'string' || !o.subject.revision) p.push('subject repository and revision required');
  if (!o.producer || typeof o.producer.name !== 'string') p.push('producer required');
  if (!o.execution || typeof o.execution.identity !== 'string' || !o.execution.identity) p.push('execution identity required');
  if (typeof o.observedAt !== 'string' || Number.isNaN(Date.parse(o.observedAt))) p.push('observedAt must be a date');
  if (!OUTCOMES.has(o.outcome)) p.push('unknown outcome');
  if (!o.metrics || typeof o.metrics !== 'object') p.push('metrics required');
  if (!Array.isArray(o.limitations)) p.push('limitations required');
  if (!Array.isArray(o.findings)) p.push('findings required');
  return p;
}

export interface ReceiptVerdict {
  trust: ReceiptTrust;
  reason: string;
  keyId?: string;
}

/**
 * How far a receipt can be relied on:
 *   trusted        signed by a key the policy trusts, for an execution identity that key may vouch for
 *   self-reported  well-formed but unsigned (a claim; counts only where the policy accepts claims)
 *   invalid        malformed, signed by an unknown key, a bad signature, or an identity the key may not vouch for
 *                  (never counts; a tampered receipt is worse than none)
 */
export function verifyReceipt(r: EvidenceReceipt, keys: TrustedKey[]): ReceiptVerdict {
  const problems = receiptProblems(r);
  if (problems.length) return { trust: 'invalid', reason: `malformed receipt: ${problems.join('; ')}` };
  if (!r.signature) return { trust: 'self-reported', reason: `unsigned, reported by ${r.execution.identity}` };
  const key = keys.find((k) => k.id === r.signature!.keyId);
  if (!key) return { trust: 'invalid', reason: `signed by key "${r.signature.keyId}", which the policy does not trust` };
  if (r.signature.alg !== 'ed25519') return { trust: 'invalid', reason: `unsupported signature algorithm ${r.signature.alg}` };
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(signingPayload(r)), crypto.createPublicKey(key.publicKey), Buffer.from(r.signature.value, 'base64')); }
  catch { ok = false; }
  if (!ok) return { trust: 'invalid', reason: `the signature does not match the receipt (changed after signing, or the wrong key)` };
  if (key.approver && !key.identities?.length) {
    return { trust: 'invalid', reason: `key "${key.id}" is ${key.approver}'s approval key; it signs policy approvals, not evidence` };
  }
  if (key.identities?.length && !key.identities.includes(r.execution.identity)) {
    return { trust: 'invalid', reason: `key "${key.id}" may not vouch for ${r.execution.identity}` };
  }
  return { trust: 'trusted', reason: `signed by "${key.id}" for ${r.execution.identity}`, keyId: key.id };
}

/** Normalize a repository identity so https, ssh, and .git spellings compare equal. */
export function normalizeRepository(remote: string): string {
  let s = remote.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const ssh = /^[\w.-]+@([^:]+):(.+)$/.exec(s);
  if (ssh) s = `${ssh[1]}/${ssh[2]}`;
  s = s.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  return s.toLowerCase();
}
