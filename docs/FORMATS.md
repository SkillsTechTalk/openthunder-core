# Formats

## Policy (`.openthunder/done-core.yml`, read from the base branch)

```yaml
version: 1
trust: ci                 # "ci": only receipts signed by a listed key count; "any": self-reported count, labeled
keys:
  - id: ci
    public-key: |
      -----BEGIN PUBLIC KEY-----
      ...
    identities: ["github-actions:acme/app"]
approvers: ["Jordan (tech lead)"]   # who may approve an exception
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

## Evidence receipt (`done-evidence-v1`)

A receipt says what was checked (`check.id`, `check.version`, `kind`), the exact code (`subject.repository`,
`subject.revision`), who ran it (`execution.identity`), when (`observedAt`), the report it came from
(`artifact.digest`), the `outcome` (passed, failed, not-checked, measured, not-applicable), a `summary`, `metrics`,
`findings`, what it cannot show (`limitations`), an optional `remedy`, and an optional Ed25519 `signature` over
everything else. Trust is decided by the verifier against the policy's keys, never by the producer.

## Results

Requirement statuses: Passed, Failed, Not checked, Outdated, Not applicable, Exception approved.
Change: Done, Done with exceptions, Not done.
