#!/bin/sh
# Leak check for a tree that is about to be public, or already is. Run inside its git work tree.
# Usage: scripts/leak-check.sh <patterns-file>   (one ERE per line, no blank lines)
set -eu
patterns=${1:-}
[ -s "$patterns" ] || { echo "leak-check: patterns file missing or empty" >&2; exit 2; }
private_paths='^(archive/|private/|public-repo(/|$)|\.gitea/|\.wsagency/|dev-docs/tickets/|dev-docs/agents/|AGENTS\.md$|CLAUDE\.md$|worker/wrangler\.production\.jsonc$|assets/brand/|assets/ws-artefacts-|assets/ws-logo\.svg$|assets/ws-agency-report-template\.html$|ws-artefacts-pricing-plan\.html$|worker/test/pricing-plan\.test\.ts$|dev-docs/decisions/00(01|08|22|36)-|dev-docs/research/(platform-cost-model|gitea-commit-from-server-feasibility|gitless-cf-worker-feasibility|artefact-compatibility-ruleset)\.md$)'
set +e
git ls-files | grep -E "$private_paths"; paths=$?
git grep -n -I -i -E -f "$patterns"; content=$?
set -e
[ "$paths" -eq 1 ] || { echo "leak-check: private path tracked" >&2; exit 1; }
[ "$content" -eq 1 ] || { echo "leak-check: content pattern matched, or git grep failed" >&2; exit 1; }
echo "leak-check: clean"
