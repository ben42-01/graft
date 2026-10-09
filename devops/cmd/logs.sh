# shellcheck shell=bash
# ops logs <env> [app|mongo|redis|minio] [-f] [--since 1h] [--request ID] [--tenant ID] [--errors] [--raw]
#
# App lines are the JSON the app writes (src/server/log.ts: ts, level, msg,
# requestId, tenantId, userId, …). They are shown as one readable line each;
# --raw keeps the JSON for piping into jq.

# The app's stdout for this environment, oldest first. Extra args go to journalctl.
app_log_stream() {
  [[ "$OPS_MODE" == hosted ]] ||
    die "the $OPS_ENV app runs in your terminal locally (npm run dev / qa:app) — its logs are there"
  journalctl --user -u "$OPS_UNIT" -o cat --no-pager "$@"
}

# match_all PATTERN... — keep lines containing every pattern (fixed strings).
match_all() {
  PATS="$(printf '%s\n' "$@")" awk 'BEGIN { n = split(ENVIRON["PATS"], p, "\n") }
    { for (i = 1; i <= n; i++) if (p[i] != "" && index($0, p[i]) == 0) next; print; fflush() }'
}

# JSON log line → "time LEVEL msg key=value…"; anything else passes through.
pretty_log() {
  if [[ -n "${RAW:-}" ]] || ! have jq; then
    cat
    return
  fi
  jq -R -r --unbuffered '
    . as $raw | (try fromjson catch null) as $j
    | if ($j | type) == "object" and $j.msg then
        ($j.ts // "" | .[11:19]) + " " + (($j.level // "") | ascii_upcase | .[0:5]) + " " + $j.msg
        + ([$j | del(.ts, .level, .msg) | to_entries[]
            | " " + .key + "=" + (if (.value | type) == "string" then .value else (.value | tojson) end)] | join(""))
      else $raw end'
}

cmd_logs() {
  ops_env "${1:-}"
  shift || true
  local svc=app follow=() since=() filters=()
  RAW=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      app | mongo | redis | minio) svc="$1"; shift ;;
      -f | --follow) follow=(-f); shift ;;
      --since) since=(--since "$2"); shift 2 ;;
      --request) filters+=("\"requestId\":\"$2\""); shift 2 ;;
      --tenant) filters+=("\"tenantId\":\"$2\""); shift 2 ;;
      --errors) filters+=('"level":"error"'); shift ;;
      --raw) RAW=1; shift ;;
      *) die "unknown option '$1'" ;;
    esac
  done
  [[ ${#filters[@]} -gt 0 ]] && audit "logs $svc ${filters[*]}"

  if [[ "$svc" != app ]]; then
    # docker takes "1h" / "30m" / a timestamp for --since.
    compose logs --no-log-prefix "${follow[@]}" "${since[@]}" "$svc"
    return
  fi

  [[ ${#since[@]} -eq 0 && ${#follow[@]} -eq 0 ]] && since=(--since "-1h")
  # journalctl takes "-1h"/"1 hour ago"; translate the docker-style "1h".
  [[ ${#since[@]} -gt 0 && "${since[1]}" =~ ^[0-9]+[smhd]$ ]] && since[1]="-${since[1]}"
  app_log_stream "${since[@]}" "${follow[@]}" | match_all "${filters[@]}" | pretty_log
}
