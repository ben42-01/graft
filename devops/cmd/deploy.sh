# shellcheck shell=bash
# ops deploy <env> [ref] · ops rollback <env> · ops releases <env>
#
# A deploy never touches the running release. It builds a new one next to it,
# prepares the database, then swaps one symlink and restarts the unit. If the
# new release does not answer /api/ready, the symlink goes back and the old
# release is restarted — the box is never left on a broken build.
#
# Migrations run *before* the switch, against the database the old release is
# still serving from. They must therefore be backward compatible (add, don't
# rename or drop in the same release) — docs/WORKFLOW.md §5.5, forward-fix.

# shellcheck source=devops/cmd/stack.sh
source "$OPS_DIR/cmd/stack.sh"
# shellcheck source=devops/cmd/units.sh
source "$OPS_DIR/cmd/units.sh"
# shellcheck source=devops/cmd/app.sh
source "$OPS_DIR/cmd/app.sh"

KEEP_RELEASES="${KEEP_RELEASES:-4}"

default_ref() {
  case "$OPS_ENV" in
    prod) echo origin/main ;;
    *) echo origin/develop ;;
  esac
}

deploy_log() {
  printf '%s\t%s\t%s\t%s\n' "$(date -Is)" "${SUDO_USER:-$USER}" "$1" "$2" >>"$OPS_SHARED/deploys.log"
}

# Point `current` at a release atomically: a rename, never a delete + create.
switch_to() {
  ln -sfn "$1" "$OPS_HOME/current.next"
  mv -T "$OPS_HOME/current.next" "$OPS_HOME/current"
}

restart_app() {
  if units_installed && systemctl --user cat "$OPS_UNIT" >/dev/null 2>&1; then
    systemctl --user restart "$OPS_UNIT"
  else
    warn "no systemd unit — start the app yourself from $OPS_HOME/current"
    return 1
  fi
}

cmd_deploy() {
  ops_env "${1:-}"
  require_hosted deploy
  local ref="${2:-$(default_ref)}"

  # One deploy at a time per environment.
  exec 9>"$OPS_SHARED/.deploy.lock"
  flock -n 9 || die "another deploy of $OPS_ENV is running"

  source "$OPS_DIR/cmd/env.sh"
  env_check "$OPS_ENV" || die "fix the env file first (\`ops env edit $OPS_ENV\`)"

  local started=$SECONDS sha stamp rel previous=""
  [[ -e "$OPS_HOME/current" ]] && previous="$(readlink -f "$OPS_HOME/current")"

  info "fetching $ref"
  git -C "$OPS_HOME/repo" fetch --quiet --prune --tags origin
  sha="$(git -C "$OPS_HOME/repo" rev-parse --verify --quiet "$ref^{commit}")" || die "unknown ref '$ref'"
  # Keep the clone's own checkout in step, so `repo/devops/ops` is current too.
  git -C "$OPS_HOME/repo" checkout --quiet --detach "$sha"

  if [[ -n "$previous" && "$(cat "$previous/REVISION" 2>/dev/null)" == "$sha" && "${FORCE:-}" != 1 ]]; then
    ok "$OPS_ENV already runs ${sha:0:7} — nothing to do (FORCE=1 to rebuild)"
    return 0
  fi

  stamp="$(date +%Y%m%d%H%M%S)"
  rel="$OPS_HOME/releases/$stamp-${sha:0:7}"
  info "building $(bold "${sha:0:7}") $(dim "$(git -C "$OPS_HOME/repo" log -1 --format=%s "$sha")")"
  mkdir -p "$rel"
  git -C "$OPS_HOME/repo" archive "$sha" | tar -x -C "$rel"
  echo "$sha" >"$rel/REVISION"
  echo "$ref" >"$rel/REF"
  ln -s "$OPS_SHARED/keys" "$rel/.keys"

  # From here on, a failure leaves a half-built release dir and nothing else.
  _deploy_failed() {
    deploy_log "FAILED ${sha:0:7} ($ref) at: $1" ""
    audit "deploy ${sha:0:7} failed: $1"
    rm -rf "$rel"
    die "deploy failed while: $1 — $OPS_ENV is ${previous:+still on ${previous##*/}}${previous:-not live yet}"
  }

  info "npm ci"
  (cd "$rel" && npm ci --no-audit --no-fund --loglevel=error) || _deploy_failed "npm ci"

  info "next build"
  # Always a production build, whatever NODE_ENV the env file sets
  # (NODE_ENV=development breaks the /404 prerender).
  (cd "$rel" && node_modules/.bin/dotenv -e "$OPS_ENV_FILE" -v NODE_ENV=production -- node_modules/.bin/next build) \
    >"$rel/.build.log" 2>&1 || {
    tail -30 "$rel/.build.log" >&2
    _deploy_failed "next build"
  }
  ok "built in $((SECONDS - started))s"

  info "data stack"
  stack_sync "$rel"
  compose up -d --wait || _deploy_failed "compose up"
  stack_prepare_data "$rel" || _deploy_failed "migrations / indexes / bucket"

  units_install --quiet

  info "switching to ${rel##*/}"
  switch_to "$rel"
  OPS_APP_DIR="$rel"
  restart_app || true

  info "waiting for /api/ready on :$OPS_PORT"
  if wait_ready 120; then
    ok "$(bold "$OPS_ENV") is on ${sha:0:7} ($((SECONDS - started))s)"
    deploy_log "deployed ${sha:0:7} ($ref)" "${rel##*/}"
    audit "deploy ${sha:0:7} ($ref)"
  else
    fail "new release did not become ready"
    journalctl --user -u "$OPS_UNIT" -n 30 --no-pager 2>/dev/null >&2 || true
    if [[ -n "$previous" ]]; then
      warn "rolling back to ${previous##*/}"
      switch_to "$previous"
      restart_app || true
      wait_ready 90 && ok "rolled back; $OPS_ENV is on ${previous##*/}" || fail "the previous release is not ready either — look now"
    fi
    # Kept for a post-mortem (.build.log, the journal), never a rollback target.
    echo "not ready after switch" >"$rel/FAILED"
    deploy_log "ROLLED BACK ${sha:0:7} ($ref): not ready" "${rel##*/}"
    audit "deploy ${sha:0:7} rolled back"
    return 1
  fi

  prune_releases
}

# Keep the newest $KEEP_RELEASES, and never the one `current` points at.
prune_releases() {
  local cur rel n=0
  cur="$(readlink -f "$OPS_HOME/current")"
  while read -r rel; do
    n=$((n + 1))
    if ((n > KEEP_RELEASES)) && [[ "$rel" != "$cur" ]]; then rm -rf "$rel"; fi
  done < <(ls -1dt "$OPS_HOME"/releases/*/ 2>/dev/null | sed 's|/$||')
}

cmd_rollback() {
  ops_env "${1:-}"
  require_hosted rollback
  exec 9>"$OPS_SHARED/.deploy.lock"
  flock -n 9 || die "a deploy of $OPS_ENV is running"
  local cur target
  cur="$(readlink -f "$OPS_HOME/current")"
  # The newest healthy release older than the current one.
  target="$(for r in "$OPS_HOME"/releases/*/; do r="${r%/}"; [[ -f "$r/FAILED" ]] || echo "$r"; done |
    sort | awk -v c="$cur" '$0 == c {print prev; exit} {prev = $0}')"
  [[ -n "$target" ]] || die "no release older than ${cur##*/} to roll back to"
  info "rolling $(bold "$OPS_ENV") back: ${cur##*/} → ${target##*/}"
  warn "migrations are not reversed — the older code runs against the newer schema"
  switch_to "$target"
  restart_app || true
  if wait_ready 90; then
    ok "$OPS_ENV is on ${target##*/}"
    deploy_log "rollback to $(cat "$target/REVISION" | cut -c1-7)" "${target##*/}"
    audit "rollback to ${target##*/}"
  else
    die "${target##*/} is not ready — \`ops logs $OPS_ENV app --since 5m\`"
  fi
}

cmd_releases() {
  ops_env "${1:-}"
  require_hosted releases
  local cur rel mark
  cur="$(readlink -f "$OPS_HOME/current" 2>/dev/null || true)"
  echo "$(bold Releases) $(dim "($OPS_HOME/releases)")"
  for rel in $(ls -1d "$OPS_HOME"/releases/*/ 2>/dev/null | sed 's|/$||' | sort -r); do
    mark="  "
    [[ "$rel" == "$cur" ]] && mark="$(green "▶ ")"
    echo "  $mark${rel##*/}  $(dim "$(cat "$rel/REF" 2>/dev/null)")$([[ -f "$rel/FAILED" ]] && red "  failed: $(cat "$rel/FAILED")")"
  done
  echo
  echo "$(bold "Recent deploys") $(dim "(shared/deploys.log)")"
  tail -10 "$OPS_SHARED/deploys.log" 2>/dev/null | sed 's/^/  /' || echo "  none yet"
}
