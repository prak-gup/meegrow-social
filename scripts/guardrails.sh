#!/usr/bin/env bash
# AX-PRD §3 grep-gates: architectural invariants ESLint can't express.
# Fails the build if an app touches the DB directly, or business logic leaks into apps.
set -euo pipefail

fail=0

# 1. Only packages/db may import the raw drizzle/postgres driver. Everyone else uses withWorkspace.
#    (apps + core services must obtain a handle via the tenant helper.)
if grep -RInE "from 'postgres'|from \"postgres\"|drizzle-orm/postgres-js" \
    --include='*.ts' apps packages/core 2>/dev/null | grep -v -- '-test'; then
  echo "❌ guardrail: raw DB driver imported outside packages/db — use withWorkspace()." >&2
  fail=1
fi

# 2. apps/* must not import from another app (no cross-app business logic).
if grep -RInE "from '(\.\./)*apps/" --include='*.ts' --include='*.tsx' apps 2>/dev/null; then
  echo "❌ guardrail: apps/* importing from another app." >&2
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "✅ guardrails passed"
fi
exit $fail
