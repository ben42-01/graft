#!/usr/bin/env bash
# Runs the verify / verify:full stages with output sent to log files.
# Prints one line per stage; on failure prints only the tail of that stage's log
# and stops. Usage: scripts/quiet-gate.sh [full]   (default: verify stages only)
set -u
# `full` calls dotenv/tsx directly, outside an npm script, so they need to be on PATH.
export PATH="$PWD/node_modules/.bin:$PATH"
LOG_DIR="${GATE_LOG_DIR:-/tmp/graft-gate}"
TAIL_LINES="${GATE_TAIL_LINES:-40}"
mkdir -p "$LOG_DIR"

stages=(
  "lint|npm run lint"
  "typecheck|npm run typecheck"
  "unit|npm run test"
  "component|npm run test:component"
  "integration|npm run test:integration"
)
if [ "${1:-}" = "full" ]; then
  stages+=(
    "qa:db|npm run qa:db"
    "qa:seed|npm run qa:seed"
    "qa:build|npm run qa:build"
    "bruno|dotenv -e .env.qa -- tsx scripts/with-qa-app.ts npm run test:api"
    "qa:down|npm run qa:db:down"
  )
fi

for stage in "${stages[@]}"; do
  name="${stage%%|*}"
  cmd="${stage#*|}"
  log="$LOG_DIR/${name//:/-}.log"
  start=$SECONDS
  if bash -c "$cmd" >"$log" 2>&1; then
    echo "PASS  $name ($((SECONDS - start))s)"
  else
    echo "FAIL  $name ($((SECONDS - start))s) — full log: $log"
    echo "----- last $TAIL_LINES lines -----"
    tail -n "$TAIL_LINES" "$log"
    # Leave the QA stack down-able even when a stage fails mid-way.
    [ "${1:-}" = "full" ] && echo "note: run 'npm run qa:db:down' before re-running the full gate"
    exit 1
  fi
done
echo "GATE OK"
