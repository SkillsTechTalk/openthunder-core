# OpenThunder Core

**Know whether a change is actually done, and why.** OpenThunder Core checks a change against your team's
Definition of Done using the evidence your tools already produce: JUnit test reports, lcov coverage, SARIF scanner
results, and an OpenAPI compatibility check. Every answer names its evidence.

```
Definition of Done: Not done
2 of 5 required items open: Changed lines covered (at least 80%) (Outdated); The "openapi-compat" check runs and passes (Not checked).
```

- **Honest statuses.** Passed, Failed, **Not checked** (no evidence is never a pass), **Outdated** (evidence from older
  code cannot approve newer code), Not applicable, and **Exception approved**: a named approver accepted a risk until a
  date, and the record still shows what the evidence said.
- **Rules a change cannot loosen.** The policy is read from the branch you merge into.
- **Trusted CI evidence.** Receipts signed by your CI's key count where the policy requires it; self-reported results
  are labeled as such.
- **Local and keyless.** No account, no server, no AI key, no network. It reads files and git; it never runs your code.

## What is in this repository

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) | The evaluator, the evidence importers, the OpenAPI check, the `done-core` CLI, and a GitHub Action |
| [`packages/vscode`](packages/vscode) | **OpenThunder: Definition of Done** for VS Code, including a GitHub Copilot agent-mode tool |
| [`packages/core/conformance`](packages/core/conformance) | The reference behavior any implementation can run |

## Quick start

```bash
git clone https://github.com/SkillsTechTalk/openthunder-core && cd openthunder-core
npm install && npm run build && npm install -g ./packages/core   # gives you the done-core command

cd your-repo
done-core init                      # writes .openthunder/done-core.yml; commit it to your main branch
done-core collect --format junit --report junit.xml
done-core collect --format lcov --report coverage/lcov.info --base main
done-core evaluate --base main
```

Or try the five-minute demo: `examples/definition-of-done/demo.sh`.

In CI, see [`packages/core/action/example-workflow.yml`](packages/core/action/example-workflow.yml).

## Open source, and what is not

This repository is Apache 2.0: use it, change it, ship it, including commercially. The official OpenThunder downloads
(Desktop, the Marketplace extension) are free and build on this code, and add proprietary analyzers as clearly labeled
plugins. Team and Enterprise features are a paid service. See [docs/BOUNDARY.md](docs/BOUNDARY.md).

## Contributing

Contributions are welcome under the Developer Certificate of Origin: sign off each commit (`git commit -s`).
See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

OpenThunder™ is a trademark of Skills Tech Talk, LLC; see [TRADEMARKS.md](TRADEMARKS.md).
