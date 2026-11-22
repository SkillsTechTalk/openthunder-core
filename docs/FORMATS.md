# Formats

## Policy (`.openthunder/done.yml`, read from the base branch)

```yaml
version: 1
trust: ci                 # "ci": only receipts signed by a listed key count; "any": self-reported count, labeled
keys:
  - id: ci
    public-key: |
      -----BEGIN PUBLIC KEY-----
      ...
    identities: ["github-actions:acme/app"]
  - id: jordan                       # an approver's key: signs approvals of policy edits, never evidence
    public-key: |
      -----BEGIN PUBLIC KEY-----
      ...
    approver: "Jordan (tech lead)"
approvers: ["Jordan (tech lead)"]   # who may approve an exception or an edit to this policy
require:
  - tests
  - coverage: { min: 80, of: changed }     # thresholds are examples: choose your own
  - security: { fail-on: error }
  - check: { id: openapi-compat }
  - check: { id: perf-budget, title: "p95 latency stays under 200 ms", paths: ["src/checkout/**"] }
recommend:
  - check: openthunder.protect
exceptions:
  - { requirement: coverage, reason: "Legacy module", approver: "Jordan (tech lead)", expires: 2026-12-31, follow-up: PROJ-1 }
```

One file serves every surface: this CLI, the GitHub Action, the VS Code extension, and the OpenThunder app read the
same `.openthunder/done.yml`, so they give the same answer. (The earlier name `.openthunder/done-core.yml` is still
read when `done.yml` is absent.)

- `check: openthunder.<item>` asks for evidence the OpenThunder app produces (for example `openthunder.impacted-tests`,
  `openthunder.tests-not-weakened`, `openthunder.contracts-intact`). `openthunder done --write-receipts` writes those
  receipts to `.done/receipts`, where this evaluator counts them like any other receipt. Without them the item is
  Not checked, and says how to produce them.
- An exception may name a requirement by its id (`coverage`, `check:perf-budget`) or a check by its check id
  (`openthunder.impacted-tests`).

## Changing the policy (`done-policy-approval-v1`)

A change that edits `.openthunder/done.yml` is still judged by the base branch's copy, so it cannot loosen its own
rules. Its item "The policy that judges this change is unchanged by it" stays Not checked until either the edit is
merged on its own, or an approver signs off on it:

```bash
done-core keygen --out ~/.done-keys        # once; the approver keeps the private key, the public key goes in "keys"
done-core approve-policy --base main --key ~/.done-keys/done-core-private.pem --key-id jordan --reason "raise the bar"
git add .openthunder/approvals && git commit -m "Approve the Definition of Done edit"
```

The approval (`.openthunder/approvals/<hash>.json`) records the repository, the policy path, sha256 of the policy
text before and after, the approver, the time, an optional reason, and an Ed25519 signature. It counts only when the
key is listed in the base policy with `approver:`, that name is in the base policy's `approvers`, and the signature
matches. It is bound to the edit, not to a commit: later code commits keep it; another edit to the policy, or a
changed base policy, makes the item Outdated until it is approved again. An approver's key without `identities`
cannot sign evidence receipts.

What it does not do: Core cannot tell whether the approver also wrote the change. If that matters, require a
reviewer other than the author in your code host as well.

## Evidence receipt (`done-evidence-v1`)

A receipt says what was checked (`check.id`, `check.version`, `kind`), the exact code (`subject.repository`,
`subject.revision`), who ran it (`execution.identity`), when (`observedAt`), the report it came from
(`artifact.digest`), the `outcome` (passed, failed, not-checked, measured, not-applicable), a `summary`, `metrics`,
`findings`, what it cannot show (`limitations`), an optional `remedy`, and an optional Ed25519 `signature` over
everything else. Trust is decided by the verifier against the policy's keys, never by the producer.

## Results

Requirement statuses: Passed, Failed, Not checked, Outdated, Not applicable, Exception approved.
Change: Done, Done with exceptions, Not done.
