// The open formats (docs/BOUNDARY.md, Layer 1): evidence receipts, policy, and results.
// Serializable, versioned, and free of any OpenThunder-internal concept: a third-party tool can produce a
// receipt this core accepts, and another implementation can decide the same policy the same way.

/** What a piece of evidence is about. */
export type EvidenceKind = 'tests' | 'coverage' | 'security' | 'check';

/**
 * What the producer observed. For tests and custom checks: passed / failed / not-checked. For coverage and
 * security scans the producer only MEASURES ('measured'); the policy's threshold decides pass or fail.
 */
export type EvidenceOutcome = 'passed' | 'failed' | 'not-checked' | 'measured' | 'not-applicable';

export interface EvidenceFinding {
  message: string;
  file?: string;
  line?: number;
  severity?: 'error' | 'warning' | 'note';
  rule?: string;
}

/**
 * An evidence receipt: one check's result, bound to the code it is about.
 * Producer-supplied fields are CLAIMS. They become trusted only when a collector whose key the policy trusts
 * signed the receipt (see receipt.ts). An unsigned receipt is "self-reported" and is labeled so everywhere.
 */
export interface EvidenceReceipt {
  schema: 'done-evidence-v1';
  kind: EvidenceKind;
  /** Which check produced it, and its version (e.g. junit@1, lcov@1, sarif@1, openapi-compat@1, a plugin id). */
  check: { id: string; version: string };
  /** The code it is about: repository identity and the exact tested revision. */
  subject: { repository: string; revision: string };
  /** The tool that wrote the receipt (the collector), not the tool that ran the tests. */
  producer: { name: string; version: string };
  /** Who ran it: a CI workflow identity, or "local:<host>" for a developer machine. */
  execution: { identity: string; runId?: string; runUrl?: string };
  /** When it was observed (ISO 8601, UTC). */
  observedAt: string;
  /** The report the result was read from, by digest (sha256 of its exact bytes). */
  artifact?: { name: string; digest: string };
  outcome: EvidenceOutcome;
  summary: string;
  /** Numbers the policy can apply thresholds to (tests, failures, coveragePercent, errors, ...). */
  metrics: Record<string, number>;
  /** What this evidence does NOT show (always said, never hidden). */
  limitations: string[];
  findings: EvidenceFinding[];
  /** The producer's plain next step when the result is not a pass (shown as "Next"). */
  remedy?: string;
  signature?: { keyId: string; alg: 'ed25519'; value: string };
}

/** How much a receipt can be relied on, decided by the verifier, never by the producer. */
export type ReceiptTrust = 'trusted' | 'self-reported' | 'invalid';

export interface TrustedKey {
  id: string;
  /** Ed25519 public key, PEM (SPKI). */
  publicKey: string;
  /** Execution identities this key may vouch for (e.g. "github-actions:acme/app"). Absent = any. */
  identities?: string[];
  /**
   * The approver (a name in the policy's "approvers") whose key this is. Only such a key can sign a policy approval.
   * An approver's key without "identities" signs approvals only, never evidence.
   */
  approver?: string;
}

/**
 * A signed approval of one edit to the policy file, by an approver the BASE policy names. It is bound to the exact
 * text before and after (sha256 of the file bytes), not to a commit: later code commits keep it valid; any further
 * edit to the policy, or a moved base policy, makes it Outdated. Committed into the change under
 * .openthunder/approvals/ (a signature cannot be forged, so it is safe to carry in the change it approves).
 */
export interface PolicyApproval {
  schema: 'done-policy-approval-v1';
  repository: string;
  policyPath: string;
  basePolicyHash: string;
  newPolicyHash: string;
  approver: string;
  /** ISO 8601, UTC. */
  approvedAt: string;
  reason?: string;
  signature?: { keyId: string; alg: 'ed25519'; value: string };
}

export type RequirementType = 'tests' | 'coverage' | 'security' | 'check';

export interface Requirement {
  /** Stable id used in results and exceptions (defaults to the type, or "check:<id>"). */
  id: string;
  type: RequirementType;
  required: boolean;
  /** coverage: percent threshold (an adjustable team setting). */
  min?: number;
  /** coverage: measure the changed lines or the whole codebase. */
  of?: 'changed' | 'all';
  /** security: the lowest severity that fails. */
  failOn?: 'error' | 'warning' | 'note';
  /** check: the check id a receipt must carry. */
  checkId?: string;
  /** Applies only when the change touches one of these paths (globs). */
  paths?: string[];
  owner?: string;
  /** Overrides the policy-wide trust rule for this requirement. */
  trust?: 'ci' | 'any';
  /** Plain-words title and reason, shown instead of the defaults (useful for custom checks). */
  title?: string;
  why?: string;
}

export interface PolicyException {
  requirement: string;
  reason: string;
  approver: string;
  /** YYYY-MM-DD, inclusive. */
  expires: string;
  /** Applies only when every changed file matches one of these. Absent = any change. */
  paths?: string[];
  followUp?: string;
  /** Shown instead of "until <date>" (e.g. "for this change only" for an acceptance bound to one change). */
  untilLabel?: string;
}

export interface Policy {
  version: 1;
  /** 'ci' = only receipts signed by a trusted key count; 'any' = self-reported receipts count, labeled as such. */
  trust: 'ci' | 'any';
  keys: TrustedKey[];
  /** Who may approve an exception. Empty = no exception is valid. */
  approvers: string[];
  requirements: Requirement[];
  exceptions: PolicyException[];
}

export interface ParsedPolicy {
  policy: Policy;
  /** Problems that make the policy unreliable: the evaluator treats them as an open required item. */
  errors: string[];
  notes: string[];
}

/** The change being decided. */
export interface Subject {
  repository: string;
  /** The exact revision; uncommitted work must be a revision no receipt can match (e.g. "<sha>-dirty"). */
  revision: string;
  changedFiles: string[];
}

/** Where the policy came from and whether this change edits it. */
export interface PolicyIntegrity {
  /** e.g. ".openthunder/done.yml on origin/main". */
  source: string;
  /** The change under review edits the policy file. The edit never judges the change that makes it. */
  editedByChange: boolean;
  /** The caller enforces policy integrity itself (for example an admin approval of policy edits), so no item is added. */
  enforcedElsewhere?: boolean;
  /** sha256 of the base branch's policy file bytes (needed to check approvals of an edit). */
  basePolicyHash?: string;
  /** sha256 of this change's policy file bytes ("absent" when the change deletes it). */
  changedPolicyHash?: string;
  /** Approvals carried by the change (read from .openthunder/approvals/). Checked against the BASE policy's keys. */
  approvals?: PolicyApproval[];
}

export type ItemStatus = 'passed' | 'failed' | 'not-checked' | 'outdated' | 'not-applicable' | 'exception';
export type DecisionState = 'done' | 'done-with-exceptions' | 'not-done';

export interface ItemResult {
  id: string;
  title: string;
  required: boolean;
  status: ItemStatus;
  why: string;
  evidence: string;
  /** How far the evidence can be relied on: trusted CI identity, or self-reported. */
  basis?: string;
  next?: string;
  owner?: string;
  underlying?: Exclude<ItemStatus, 'exception'>;
  exception?: PolicyException;
  /** Receipts that decided it, by check and digest (for the record). */
  receipts?: { check: string; revision: string; trust: ReceiptTrust; digest?: string }[];
}

export interface Decision {
  schema: 'done-decision-v1';
  state: DecisionState;
  label: 'Done' | 'Done with exceptions' | 'Not done';
  summary: string;
  subject: Subject;
  policy: { source: string; hash: string };
  /** The explicit evaluation time used for exception expiry (results are reproducible from it). */
  evaluatedAt: string;
  items: ItemResult[];
  notes: string[];
}
