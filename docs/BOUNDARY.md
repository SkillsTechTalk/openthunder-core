# What is open, and what is not

| Layer | What | License |
|---|---|---|
| Formats | The policy file, evidence receipts, result words, conformance cases | Apache 2.0 (this repository) |
| Verification core | The evaluator, importers, OpenAPI check, CLI, GitHub Action, VS Code extension | Apache 2.0 (this repository) |
| Advanced analyzers | Deeper checks in the official OpenThunder downloads | Proprietary, free to use |
| Team and Enterprise | Organization policy, approvals, audit retention, reporting, hosting | Commercial service |

Rules this repository keeps:

1. It builds, tests, and runs its quickstart with no private package, no account, and no AI key.
2. It never depends on a hidden verdict from closed code. A closed analyzer's result enters only as an evidence
   receipt, the same interface any third-party check uses, and is labeled with its producer.
3. Local enforcement, reports, evidence export, and exception rules are free. What is paid is coordinating them across
   an organization.
4. Proprietary plugins are optional and explicit: their publisher, version, license, permissions, and network behavior
   are shown, and nothing is downloaded silently.
