#!/usr/bin/env bash
# Demo 1 (docs/BOUNDARY.md): the open core alone, no closed analyzer, no account, no AI key, no network.
# Story: CI is green, but the coverage evidence is from an older commit and a required check never ran.
# The reports below stand in for what a test runner and coverage tool would write in CI; they are synthetic.
set -euo pipefail
CORE="node $(cd "$(dirname "$0")/../../packages/core" && pwd)/dist/cli.js"
DEMO=$(mktemp -d)
cd "$DEMO"
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
git init -q -b main && git config user.email demo@example.com && git config user.name Demo
git remote add origin git@example.com:acme/shop.git
mkdir -p src
cat > src/cart.ts <<'TS'
export function total(prices: number[]): number {
  return prices.reduce((a, b) => a + b, 0);
}
TS
cat > openapi.json <<'JSON'
{"openapi":"3.0.3","paths":{"/cart":{"get":{"responses":{"200":{"content":{"application/json":{"schema":{"type":"object","properties":{"total":{"type":"number"},"items":{"type":"integer"}}}}}}}}}}}
JSON
printf 'junit.xml\nlcov.info\n.done/\n' > .gitignore
mkdir -p .openthunder
cat > .openthunder/done.yml <<'YML'
version: 1
trust: any
approvers: ["Jordan (tech lead)"]
require:
  - tests
  - coverage: { min: 80, of: changed }
  - check: openapi-compat
  - check: load-test
exceptions:
  - requirement: check:load-test
    reason: "No load environment until Q1; traffic on /cart is low"
    approver: "Jordan (tech lead)"
    expires: 2026-12-31
    follow-up: "SHOP-212"
YML
git add -A && git commit -qm "base"
git checkout -q -b feature

ci_tests() { printf '<testsuite><testcase classname="cart" name="total"/><testcase classname="cart" name="discount"/></testsuite>' > junit.xml; $CORE collect --format junit --report junit.xml >/dev/null; }
ci_coverage() {
  n=$(wc -l < src/cart.ts | tr -d ' ')
  { echo "SF:src/cart.ts"; for i in $(seq 1 "$n"); do echo "DA:$i,1"; done; echo "end_of_record"; } > lcov.info
  $CORE collect --format lcov --report lcov.info --base main >/dev/null
}

cat >> src/cart.ts <<'TS'
export function discount(total: number, pct: number): number {
  return total * (1 - pct / 100);
}
TS
git commit -qam "add discount"
ci_tests; ci_coverage
step "Commit 1: tests and coverage collected for this commit"

cat >> src/cart.ts <<'TS'
export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
TS
git commit -qam "add round"
ci_tests   # the coverage job did not re-run (cached), and nobody ran the API check
step "Commit 2: CI is green (tests passed), but is this change Done?"
$CORE evaluate --base main --now 2026-11-20T12:00:00Z || true

step "Fix the evidence: coverage for this commit, and run the API check"
ci_coverage
$CORE openapi --spec openapi.json --base main
$CORE evaluate --base main --now 2026-11-20T12:00:00Z || true
echo
echo "(demo repository: $DEMO)"
