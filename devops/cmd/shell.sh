# shellcheck shell=bash
# ops shell <env> mongo|redis|minio|app [--write | --root]
#
# Mongo opens read-only (the graft_support user) unless --write (the app user)
# or --root is given; both are audited. Debugging rarely needs a write, and a
# read-only session cannot turn a typo into an incident.

cmd_shell() {
  ops_env "${1:-}"
  local target="${2:-}" mode="${3:-}"
  case "$target" in
    mongo) shell_mongo "$mode" ;;
    redis)
      audit "shell redis"
      compose exec redis redis-cli
      ;;
    minio)
      audit "shell minio"
      # `mc` is in the image; alias `local` points at this MinIO, so
      # `mc ls local/<bucket>` works straight away.
      # shellcheck disable=SC2016
      compose exec minio sh -c 'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && echo "mc alias: local → try: mc ls local" && exec sh'
      ;;
    app)
      audit "shell app"
      info "a shell in $OPS_APP_DIR with the $OPS_ENV env loaded — e.g. node_modules/.bin/tsx scripts/…"
      app_run bash --norc -i
      ;;
    *) die "usage: ops shell <env> mongo|redis|minio|app [--write|--root]" ;;
  esac
}

shell_mongo() {
  local mode="$1" db user pw
  # shellcheck source=devops/cmd/backup.sh
  source "$OPS_DIR/cmd/backup.sh"
  db="$(db_name)"
  case "$mode" in
    --root)
      confirm_typed "$OPS_ENV" "open a ROOT Mongo shell on $OPS_ENV"
      audit "shell mongo --root"
      # shellcheck disable=SC2016
      compose exec mongo sh -c "exec mongosh $MONGO_ROOT_ARGS '$db'"
      return
      ;;
    --write)
      user="$(env_get MONGO_APP_USER)"
      pw="$(env_get MONGO_APP_PASSWORD)"
      warn "read-WRITE shell as $user"
      audit "shell mongo --write"
      ;;
    "")
      local uri
      uri="$(env_get SUPPORT_MONGODB_URI)"
      [[ -n "$uri" ]] || die "no read-only user yet — run \`ops support $OPS_ENV grant-readonly\` (or pass --write)"
      user=graft_support
      pw="$(sed -E 's|^mongodb://[^:]+:([^@]+)@.*|\1|' <<<"$uri")"
      audit "shell mongo (read-only)"
      ;;
    *) die "unknown option '$mode'" ;;
  esac
  # `-e NAME` without a value forwards it from this environment, so the
  # password never sits in a process list for the length of the session.
  MONGO_USER="$user" MONGO_PW="$pw" compose exec -e MONGO_USER -e MONGO_PW mongo \
    sh -c "exec mongosh -u \"\$MONGO_USER\" -p \"\$MONGO_PW\" --authenticationDatabase '$db' '$db'"
}
