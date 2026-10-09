# shellcheck shell=bash
# ops app <env> start|stop|restart|status

# wait_ready [SECONDS] — poll /api/ready (Mongo + Redis reachable) until 200.
wait_ready() {
  local deadline=$((SECONDS + ${1:-90})) code
  while ((SECONDS < deadline)); do
    code="$(http_status "http://127.0.0.1:$OPS_PORT/api/ready" 3)"
    [[ "$code" == 200 ]] && return 0
    sleep 2
  done
  return 1
}

app_ctl() {
  [[ -n "$OPS_UNIT" ]] || die "the $OPS_ENV app is not run by ops locally — use \`npm run dev\` / \`npm run qa:app\`"
  systemctl --user "$@" "$OPS_UNIT"
}

cmd_app() {
  ops_env "${1:-}"
  require_hosted app
  case "${2:-status}" in
    start | stop | restart)
      app_ctl "$2"
      audit "app $2"
      if [[ "$2" != stop ]]; then
        info "waiting for /api/ready on :$OPS_PORT"
        wait_ready 90 && ok "ready" || die "not ready after 90s — \`ops logs $OPS_ENV app --since 5m\`"
      fi
      ;;
    status) app_ctl status --no-pager || true ;;
    *) die "usage: ops app <env> start|stop|restart|status" ;;
  esac
}

# ops job <env> <name> — one-off and scheduled jobs.
cmd_job() {
  ops_env "${1:-}"
  case "${2:-}" in
    expire-trials) app_tsx scripts/expire-trials.ts ;;
    *) die "usage: ops job <env> expire-trials" ;;
  esac
}
