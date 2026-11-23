# Try OpenThunder Core on one real pull request

About 15 minutes. You need a GitHub repository whose CI already runs tests. Nothing leaves your CI runner: Core
reads the reports your workflow writes and the git history, and makes no network call. It never runs your code
itself.

What you get: on every pull request, a run summary that says **Done**, **Done with exceptions**, or **Not done**,
item by item, with the evidence behind each answer and the next step. In report mode it never fails a job.

## 1. Write your Definition of Done (on `main`)

Create `.openthunder/done.yml` and merge it to your default branch. Pull requests are judged by the copy on the
branch they merge into, so a pull request cannot loosen its own rules.

Start with what your CI already produces. This one requires passing tests and asks for coverage of the changed lines
without blocking on it:

```yaml
version: 1
trust: any            # results your CI reports count, labeled self-reported (see step 4 to make them trusted)
approvers: []         # who may approve an exception or a policy edit; empty = none can
require:
  - tests             # the tests ran and passed for this exact commit
recommend:
  - coverage: { min: 80, of: changed }   # a starting point: set your own bar
```

Add `- security` under `require` if your CI writes SARIF (CodeQL, Semgrep, ESLint's SARIF formatter, and others).
The full format is in [FORMATS.md](FORMATS.md).

## 2. Add the workflow

`.github/workflows/definition-of-done.yml`:

```yaml
name: Definition of Done
on: pull_request
permissions: { contents: read }
jobs:
  done:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }          # Core reads the policy and the diff from the base branch
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      # Your tests, writing a JUnit report (and lcov, if you want coverage). Examples below.
      - run: npm ci && npx vitest run --reporter=junit --outputFile=junit.xml --coverage --coverage.reporter=lcov
      # A release tag (or a full commit SHA, if your organization requires pinning to one).
      - uses: SkillsTechTalk/openthunder-core/packages/core/action@v0.1.0
        with:
          junit: junit.xml
          lcov: coverage/lcov.info
          mode: report                    # never fails the job; switch to enforce once you trust it
```

The first run builds Core from that release (a few seconds, locked npm dependencies only).

Producing the reports with other test runners:

| Runner | JUnit | lcov |
|---|---|---|
| Vitest | `--reporter=junit --outputFile=junit.xml` | `--coverage --coverage.reporter=lcov` (needs `@vitest/coverage-v8`) |
| Jest | `jest-junit` reporter (writes `junit.xml`) | `--coverage --coverageReporters=lcov` |
| pytest | `--junitxml=junit.xml` | `pytest-cov`: `--cov --cov-report=lcov` |
| Go | `gotestsum --junitfile junit.xml` | convert with `gcov2lcov` |
| JVM (Gradle, Maven) | `build/test-results/**/*.xml`, `target/surefire-reports/*.xml` | JaCoCo through an lcov converter |

Several reports: separate the paths with commas (`junit: a.xml,b.xml`).

## 3. Open a real pull request

Open one you were going to open anyway, then read **Definition of Done** in the run summary. Things worth noticing:

- **Not checked** means there was no evidence, never a pass. A report your workflow names but never wrote is listed.
- **Outdated** means the evidence is about different code than this commit.
- **Not done** in report mode still lets the job pass. That is on purpose while you try it.

## 4. Optional: make the results trusted CI evidence

```bash
git clone https://github.com/SkillsTechTalk/openthunder-core && cd openthunder-core && npm install && npm run build
node packages/core/dist/cli.js keygen --out ~/done-core-keys   # outside your repository: never commit the private key
```

Store the private key as the repository secret `DONE_CORE_SIGNING_KEY`, add the public key to `keys` in
`done.yml` (with `identities: ["github-actions:<owner>/<repo>"]`), set `trust: ci`, and pass
`signing-key: ${{ secrets.DONE_CORE_SIGNING_KEY }}` to the action. Results that are not signed by that key then no
longer count.

## 5. Tell us how it went

We are looking for teams who try it on real pull requests. The most useful report is short:

1. Did it show a gap you had not noticed (missing, outdated, or untrusted evidence)?
2. Was anything it said wrong or confusing?
3. Is it still turned on a week later? If not, why not?

Open a **Pilot report** issue on this repository. Please share only what you are comfortable making public: item
names and statuses are enough, and no code or report contents are needed. Security problems go through
[SECURITY.md](../SECURITY.md), not issues.
