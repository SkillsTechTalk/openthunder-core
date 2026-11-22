// The Definition of Done policy (.openthunder/done.yml): what a change must satisfy, which evidence counts, who may approve
// an exception. Parsing never throws; anything that makes the policy unreliable is an error the evaluator treats as
// an open required item (fail closed).
//
//   version: 1
//   trust: ci                    # only receipts signed by a trusted key count ("any" accepts self-reported, labeled)
//   keys:
//     - id: ci-main
//       public-key: |
//         -----BEGIN PUBLIC KEY-----
//         ...
//       identities: ["github-actions:acme/app"]
//   approvers: ["Jordan (tech lead)"]
//   require:
//     - tests
//     - coverage: { min: 80, of: changed }
//     - security: { fail-on: error }
//     - check: openapi-compat
//     - check: openthunder.impacted-tests   # evidence OpenThunder produces (receipts it writes)
//   recommend:
//     - check: { id: perf-budget, paths: ["src/hot/**"] }
//   exceptions:
//     - { requirement: coverage, reason: "...", approver: "Jordan (tech lead)", expires: 2026-12-31, follow-up: PROJ-1 }
import * as yaml from 'js-yaml';
import { canonicalJson, sha256 } from './receipt';
import type { ParsedPolicy, Policy, PolicyException, Requirement, RequirementType, TrustedKey } from './types';

export const DEFAULT_POLICY_YAML = `# Definition of Done (done-core). Thresholds are examples: set your own.
version: 1
trust: any            # "ci" = only receipts signed by your CI's key count
approvers: []         # who may approve an exception; empty = none can
require:
  - tests             # the tests ran and passed for this exact revision
  - security          # no scanner finding at error level on the changed files
recommend:
  - coverage: { min: 80, of: changed }
`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TYPES: RequirementType[] = ['tests', 'coverage', 'security', 'check'];

function strList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const xs = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  return xs.length ? xs : undefined;
}

function parseRequirement(entry: unknown, required: boolean, errors: string[]): Requirement | undefined {
  let type: string | undefined;
  let o: Record<string, unknown> = {};
  if (typeof entry === 'string') type = entry.trim();
  else if (entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length === 1) {
    type = Object.keys(entry)[0];
    const v = (entry as Record<string, unknown>)[type];
    if (typeof v === 'string') o = { id: v };
    else if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>;
  }
  if (!type || !TYPES.includes(type as RequirementType)) {
    // Kept (fail closed): an unknown required requirement stays open as "cannot be checked".
    const id = typeof type === 'string' && type ? type : JSON.stringify(entry);
    return { id, type: 'check', checkId: `unsupported:${id}`, required };
  }
  const r: Requirement = { id: type, type: type as RequirementType, required };
  if (type === 'check') {
    const cid = typeof o.id === 'string' ? o.id.trim() : '';
    if (!cid) { errors.push('A "check" requirement needs the id of the check it requires (e.g. "check: openapi-compat").'); return undefined; }
    r.checkId = cid; r.id = `check:${cid}`;
  } else if (typeof o.id === 'string' && o.id.trim()) r.id = o.id.trim();
  if (type === 'coverage') {
    const min = o.min === undefined ? 80 : Number(o.min);
    if (!Number.isFinite(min) || min < 0 || min > 100) errors.push(`coverage min must be a percent from 0 to 100 (got ${JSON.stringify(o.min)}).`);
    else r.min = min;
    const of = o.of ?? 'changed';
    if (of !== 'changed' && of !== 'all') errors.push(`coverage "of" must be "changed" or "all" (got ${JSON.stringify(o.of)}).`);
    else r.of = of;
  }
  if (type === 'security') {
    const f = o['fail-on'] ?? o.failOn ?? 'error';
    if (f !== 'error' && f !== 'warning' && f !== 'note') errors.push(`security fail-on must be error, warning, or note (got ${JSON.stringify(f)}).`);
    else r.failOn = f;
  }
  const paths = strList(o.paths);
  if (paths) r.paths = paths;
  if (typeof o.owner === 'string' && o.owner.trim()) r.owner = o.owner.trim();
  if (typeof o.title === 'string' && o.title.trim()) r.title = o.title.trim();
  if (typeof o.why === 'string' && o.why.trim()) r.why = o.why.trim();
  if (o.trust !== undefined) {
    if (o.trust === 'ci' || o.trust === 'any') r.trust = o.trust;
    else errors.push(`trust must be "ci" or "any" (got ${JSON.stringify(o.trust)}).`);
  }
  return r;
}

function parseList(raw: unknown, required: boolean, errors: string[]): Requirement[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) { errors.push(`"${required ? 'require' : 'recommend'}" must be a list.`); return []; }
  return raw.map((e) => parseRequirement(e, required, errors)).filter((x): x is Requirement => !!x);
}

function parseKeys(raw: unknown, errors: string[]): TrustedKey[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) { errors.push('"keys" must be a list.'); return []; }
  const out: TrustedKey[] = [];
  for (const k of raw) {
    const o = (k ?? {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const pk = typeof o['public-key'] === 'string' ? o['public-key'] : typeof o.publicKey === 'string' ? o.publicKey : '';
    if (!id || !/BEGIN PUBLIC KEY/.test(pk)) { errors.push(`A trusted key needs an id and a PEM public key${id ? ` ("${id}")` : ''}.`); continue; }
    const ids = strList(o.identities);
    out.push({ id, publicKey: pk, ...(ids ? { identities: ids } : {}) });
  }
  return out;
}

function parseExceptions(raw: unknown, errors: string[]): PolicyException[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) { errors.push('"exceptions" must be a list.'); return []; }
  const out: PolicyException[] = [];
  for (const e of raw) {
    const o = (e ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
    const expires = o.expires instanceof Date ? o.expires.toISOString().slice(0, 10) : s('expires');
    const ex: PolicyException = { requirement: s('requirement'), reason: s('reason'), approver: s('approver'), expires };
    const missing = [!ex.requirement && 'requirement', !ex.reason && 'reason', !ex.approver && 'approver', !DAY.test(expires) && 'expires (YYYY-MM-DD)'].filter(Boolean);
    if (missing.length) { errors.push(`An exception${ex.requirement ? ` for "${ex.requirement}"` : ''} was ignored: it needs ${missing.join(', ')}.`); continue; }
    const paths = strList(o.paths);
    if (paths) ex.paths = paths;
    const f = s('follow-up') || s('followUp');
    if (f) ex.followUp = f;
    out.push(ex);
  }
  return out;
}

/** Pure: parse a policy text. */
export function parsePolicy(text: string): ParsedPolicy {
  const errors: string[] = [];
  const notes: string[] = [];
  const empty: Policy = { version: 1, trust: 'any', keys: [], approvers: [], requirements: [], exceptions: [] };
  let doc: unknown;
  try { doc = yaml.load(text); } catch (err) {
    return { policy: empty, errors: [`The policy is not valid YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`], notes };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { policy: empty, errors: ['The policy must be a map (version, trust, require, ...).'], notes };
  const o = doc as Record<string, unknown>;
  if (o.version === undefined) errors.push('The policy needs "version: 1" at the top. (A file without it is the earlier OpenThunder format: write each OpenThunder item as "check: openthunder.<item>", for example "check: openthunder.impacted-tests".)');
  else if (o.version !== 1) errors.push(`Unsupported policy version ${JSON.stringify(o.version)}; this evaluator reads version 1.`);
  const trust = o.trust === undefined ? 'any' : o.trust;
  if (trust !== 'ci' && trust !== 'any') errors.push(`trust must be "ci" or "any" (got ${JSON.stringify(o.trust)}).`);
  const byId = new Map<string, Requirement>();
  for (const r of [...parseList(o.recommend, false, errors), ...parseList(o.require, true, errors)]) byId.set(r.id, r);
  const known = new Set(['version', 'trust', 'keys', 'approvers', 'require', 'recommend', 'exceptions']);
  const unknown = Object.keys(o).filter((k) => !known.has(k));
  if (unknown.length) notes.push(`Unknown keys ignored: ${unknown.join(', ')}.`);
  const policy: Policy = {
    version: 1, trust: trust === 'ci' ? 'ci' : 'any', keys: parseKeys(o.keys, errors), approvers: strList(o.approvers) ?? [],
    requirements: [...byId.values()], exceptions: parseExceptions(o.exceptions, errors),
  };
  if (policy.trust === 'ci' && !policy.keys.length) errors.push('trust is "ci" but no trusted keys are listed, so no evidence can count.');
  return { policy, errors, notes };
}

export function policyHash(p: Policy): string {
  return sha256(canonicalJson(p));
}
