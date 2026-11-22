# Contributing to OpenThunder Core

Thank you for helping. A few rules keep the project trustworthy.

## Developer Certificate of Origin

Every commit must be signed off (`git commit -s`), certifying the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
you wrote the change or have the right to submit it under this project's license (Apache 2.0).

## What a good change looks like

- **Evidence over opinion.** A requirement is Passed only when evidence shows it. Missing evidence is Not checked,
  never a pass. Evidence for other code is Outdated.
- **Conformance first.** A change to how decisions are made comes with a case in `packages/core/conformance/cases`.
  Those cases are the reference behavior other implementations rely on.
- **No network, no project code.** The core reads files and git. A change that adds a network call or runs project
  code will not be accepted into the core.
- **Tests pass:** `npm install && npm run build && npm test`.

## Adding a check

A check produces an evidence receipt (`done-evidence-v1`, see [docs/FORMATS.md](docs/FORMATS.md)): what it checked,
the exact revision, who ran it, the result, and what it cannot show. Policies require it with `check: <your-id>`.
