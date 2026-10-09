# shellcheck shell=bash
# ops stack <env> up|down|ps|restart [service]

# stack_sync SRC — copy the compose file and Mongo init scripts from a release
# (or checkout) into shared/stack/, where the hosted compose project runs from.
stack_sync() {
  local src="$1" dst="$OPS_SHARED/stack"
  mkdir -p "$dst/mongo-init"
  install -m 644 "$src/devops/compose/docker-compose.hosted.yml" "$dst/docker-compose.hosted.yml"
  install -m 755 "$src/docker/mongo-entrypoint.sh" "$dst/mongo-entrypoint.sh"
  rm -f "$dst"/mongo-init/*
  install -m 644 "$src"/docker/mongo-init/* "$dst/mongo-init/"
}

# stack_up — containers up and healthy, then the database made ready for the
# app: replica set initiated, migrations, indexes, bucket. Every step is
# idempotent, so this is safe on every deploy.
stack_up() {
  [[ "$OPS_MODE" == hosted ]] && stack_sync "$OPS_APP_DIR"
  compose up -d --wait
  ok "containers healthy"
}

# with_local_s3 CMD... — run CMD against this box's own MinIO port. S3_ENDPOINT
# in the env file is the public address browsers use; from the box itself it
# may not even resolve. (dotenv never overrides a variable already set.)
with_local_s3() {
  local s3_port
  s3_port="$(env_get S3_PORT)"
  if [[ -n "$s3_port" ]]; then
    S3_ENDPOINT="http://127.0.0.1:$s3_port" "$@"
  else
    "$@"
  fi
}

stack_prepare_data() {
  local OPS_APP_DIR="${1:-$OPS_APP_DIR}"
  # Chained with && rather than relying on set -e: callers run this on the
  # left of `||`, where bash switches errexit off, and a failed migration
  # must not be followed by "ready".
  app_tsx scripts/wait-for-mongo.ts &&
    app_tsx scripts/migrate.ts up &&
    app_tsx scripts/create-indexes.ts &&
    with_local_s3 app_tsx scripts/ensure-bucket.ts
}

cmd_stack() {
  ops_env "${1:-}"
  local action="${2:-ps}"
  shift 2 || true
  case "$action" in
    up)
      stack_up
      if [[ "$OPS_MODE" == hosted ]]; then
        stack_prepare_data
      else
        info "local stack — seed it with \`npm run $OPS_ENV:seed\` as usual"
      fi
      ;;
    down)
      # Never `-v` here. Wiping a hosted stack's volumes is not a stack
      # operation; it is `docker volume rm` with your eyes open.
      compose down
      audit "stack down"
      ;;
    restart) compose restart "$@" ;;
    ps) compose ps ;;
    *) die "usage: ops stack <env> up|down|ps|restart [service]" ;;
  esac
}
