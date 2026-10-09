# shellcheck shell=bash
# Shared helpers for devops/ops and its commands. Sourced, never executed.
#
# The one idea in here is the environment model (devops/README.md §Environments):
#
#   local   the repo checkout this file lives in, using .env.dev / .env.qa and
#           the compose files in docker/. That is a laptop, or a server that
#           still runs `npm run qa:full` straight from a clone.
#   hosted  a release layout under $GRAFT_ROOT/<env> (default /srv/graft/<env>)
#           created by `ops host init`. Persistent data, releases, backups.
#
# An environment is hosted when $GRAFT_ROOT/<env>/shared/.env exists. Set
# GRAFT_MODE=local to force the repo checkout, e.g. to back up the old
# ephemeral QA stack before moving a box onto the hosted layout.

OPS_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPS_DIR="$OPS_REPO/devops"
GRAFT_ROOT="${GRAFT_ROOT:-/srv/graft}"

# ── Output ────────────────────────────────────────────────────────────────────
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  _c() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
else
  _c() { printf '%s' "$2"; }
fi
bold() { _c 1 "$*"; }
dim() { _c 2 "$*"; }
red() { _c 31 "$*"; }
green() { _c 32 "$*"; }
yellow() { _c 33 "$*"; }

info() { echo "$(dim "ops │") $*"; }
ok() { echo "$(green "  ✓") $*"; }
warn() { echo "$(yellow "  !") $*" >&2; }
fail() { echo "$(red "  ✗") $*" >&2; }
die() {
  echo "$(red "ops │ error:") $*" >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# ── Env files ─────────────────────────────────────────────────────────────────

# env_get KEY [FILE] — the value of KEY in a dotenv file (last one wins, the
# same as dotenv), with one layer of surrounding quotes removed. Prints nothing
# when the key is absent or commented out.
env_get() {
  local key="$1" file="${2:-$OPS_ENV_FILE}" line value
  [[ -r "$file" ]] || return 0
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -1)" || true
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

# env_set KEY VALUE FILE — replace KEY in place, or append it. Keeps mode 600.
env_set() {
  local key="$1" value="$2" file="$3" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  if grep -qE "^${key}=" "$file"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$file" >"$tmp"
  else
    cat "$file" >"$tmp"
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# A URL-safe random secret with no characters that need escaping in a URI.
gen_secret() { openssl rand -base64 "${1:-32}" | tr -dc 'A-Za-z0-9' | head -c "${2:-32}"; }

# ── Environment resolution ────────────────────────────────────────────────────

# ops_env ENV — resolves everything a command needs to act on ENV and exports
# it as OPS_* variables. Every command calls this first.
ops_env() {
  local env="${1:-}"
  case "$env" in
    dev | qa | prod) ;;
    production) env=prod ;;
    "") die "which environment? (dev | qa | prod)" ;;
    *) die "unknown environment '$env' (dev | qa | prod)" ;;
  esac
  OPS_ENV="$env"
  OPS_HOME="$GRAFT_ROOT/$env"
  OPS_SHARED="$OPS_HOME/shared"

  if [[ "${GRAFT_MODE:-}" != local && -f "$OPS_SHARED/.env" ]]; then
    OPS_MODE=hosted
    OPS_ENV_FILE="$OPS_SHARED/.env"
    # The live release. Before the first deploy there is none, and the clone
    # the host was initialised from stands in for it.
    if [[ -e "$OPS_HOME/current" ]]; then
      OPS_APP_DIR="$(readlink -f "$OPS_HOME/current")"
    else
      OPS_APP_DIR="$OPS_HOME/repo"
    fi
    OPS_PROJECT="graft-hosted-$env"
    OPS_COMPOSE=(docker compose -p "$OPS_PROJECT" --env-file "$OPS_ENV_FILE"
      -f "$OPS_SHARED/stack/docker-compose.hosted.yml")
    OPS_UNIT="graft-app@$env.service"
  else
    [[ "$env" == prod ]] && die "prod has no local mode — there is no $OPS_SHARED/.env on this machine (see \`ops host init\`)"
    OPS_MODE=local
    OPS_ENV_FILE="$OPS_REPO/.env.$env"
    OPS_APP_DIR="$OPS_REPO"
    OPS_PROJECT="graft-$env"
    OPS_COMPOSE=(docker compose --env-file "$OPS_ENV_FILE" -f "$OPS_REPO/docker/docker-compose.$env.yml")
    OPS_UNIT=""
    [[ -f "$OPS_ENV_FILE" ]] || die "$OPS_ENV_FILE is missing — run \`npm run setup\` in $OPS_REPO"
  fi
  OPS_PORT="$(env_get PORT)"
  OPS_PORT="${OPS_PORT:-3000}"
  export OPS_ENV OPS_MODE OPS_HOME OPS_SHARED OPS_ENV_FILE OPS_APP_DIR OPS_PROJECT OPS_UNIT OPS_PORT
}

require_hosted() {
  [[ "$OPS_MODE" == hosted ]] || die "'$1' needs a hosted environment — $OPS_SHARED/.env does not exist on this machine (see \`ops host init $OPS_ENV\`)"
}

# ── Running things ────────────────────────────────────────────────────────────

compose() { "${OPS_COMPOSE[@]}" "$@"; }

# app_run CMD... — run a command from the app directory with the environment's
# env file loaded, the same way the npm scripts do it.
app_run() {
  [[ -x "$OPS_APP_DIR/node_modules/.bin/dotenv" ]] ||
    die "no node_modules in $OPS_APP_DIR — run \`npm ci\` there (or deploy first)"
  (cd "$OPS_APP_DIR" && node_modules/.bin/dotenv -e "$OPS_ENV_FILE" -- "$@")
}

# app_tsx FILE ARGS... — a TypeScript entry point, relative to the app dir.
app_tsx() { app_run node_modules/.bin/tsx "$@"; }

# mongo_sh SCRIPT — run a shell snippet inside the mongo container. The root
# credentials are already in that container's environment (the compose files
# pass them as MONGO_INITDB_ROOT_*), so they never cross a command line here.
mongo_sh() { compose exec -T mongo sh -c "$1"; }
MONGO_ROOT_ARGS='-u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'

# ── Safety ────────────────────────────────────────────────────────────────────

# confirm_typed WORD WHAT — the operator must type WORD back. OPS_YES=1 skips it
# for automation (cron, CI); it is logged when used.
confirm_typed() {
  local word="$1" what="$2" answer
  if [[ "${OPS_YES:-}" == 1 ]]; then
    warn "OPS_YES=1 — skipping confirmation for: $what"
    return 0
  fi
  [[ -t 0 ]] || die "refusing to $what without a terminal (set OPS_YES=1 to override)"
  echo
  echo "$(red "  This will $what.")"
  read -r -p "  Type '$word' to continue: " answer
  [[ "$answer" == "$word" ]] || die "aborted"
}

# audit MESSAGE — append-only trail of operator actions in a hosted env:
# deploys, restores, every support lookup. Who did what, when; never data.
audit() {
  [[ "$OPS_MODE" == hosted ]] || return 0
  printf '%s\t%s\t%s\t%s\n' "$(date -Is)" "${SUDO_USER:-$USER}" "$OPS_ENV" "$*" >>"$OPS_SHARED/audit.log"
}

http_status() { curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-5}" "$1" 2>/dev/null || true; }
