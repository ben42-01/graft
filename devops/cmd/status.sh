# shellcheck shell=bash
# ops status <env> — everything worth glancing at, on one screen.

row() { printf '  %-12s %s\n' "$1" "$2"; }

cmd_status() {
  ops_env "${1:-}"
  local code app_url
  app_url="$(env_get APP_URL)"
  echo "$(bold "Graft $OPS_ENV") $(dim "· $OPS_MODE · $(hostname) · $(date '+%F %T')")"
  echo

  # Release
  if [[ "$OPS_MODE" == hosted ]]; then
    local cur last
    cur="$(readlink -f "$OPS_HOME/current" 2>/dev/null || true)"
    if [[ -n "$cur" ]]; then row release "${cur##*/}"; else row release "$(yellow "none — run ops deploy $OPS_ENV")"; fi
    last="$(tail -1 "$OPS_SHARED/deploys.log" 2>/dev/null | cut -f1,3)"
    [[ -n "$last" ]] && row "last deploy" "$(dim "$last")"
  else
    row checkout "$(git -C "$OPS_REPO" rev-parse --abbrev-ref HEAD) @ $(git -C "$OPS_REPO" rev-parse --short HEAD)"
  fi

  # App
  if [[ -n "$OPS_UNIT" ]]; then
    local state
    state="$(systemctl --user is-active "$OPS_UNIT" 2>/dev/null || true)"
    [[ "$state" == active ]] && row unit "$(green active) $(dim "$OPS_UNIT")" || row unit "$(red "${state:-not installed}") $(dim "$OPS_UNIT")"
  fi
  local ready
  ready="$(curl -s --max-time 5 "http://127.0.0.1:$OPS_PORT/api/ready" 2>/dev/null || true)"
  if [[ "$ready" == *'"status":"ready"'* ]]; then
    local latency=""
    have jq && latency="$(jq -r '.data.checks // .checks | "mongo \(.mongo.latencyMs)ms · redis \(.redis.latencyMs)ms"' <<<"$ready" 2>/dev/null || true)"
    row app "$(green ready) on :$OPS_PORT $(dim "$latency")"
  elif [[ -n "$ready" ]]; then
    row app "$(red degraded) on :$OPS_PORT $(dim "$(head -c 200 <<<"$ready")")"
  else
    row app "$(red "not answering") on :$OPS_PORT"
  fi
  if [[ -n "$app_url" && ! "$app_url" =~ localhost|127\.0\.0\.1 ]]; then
    code="$(http_status "$app_url/api/health" 8)"
    [[ "$code" == 200 ]] && row public "$(green 200) $app_url" || row public "$(red "${code:-no answer}") $app_url"
  fi

  # Containers
  echo
  echo "  $(bold containers)"
  compose ps --format '{{.Service}}\t{{.State}}\t{{.Health}}\t{{.RunningFor}}' 2>/dev/null |
    while IFS=$'\t' read -r svc state health since; do
      local h="$health"
      [[ "$health" == healthy ]] && h="$(green healthy)" || h="$(red "${health:-$state}")"
      printf '    %-8s %s %s\n' "$svc" "$h" "$(dim "up $since")"
    done
  [[ -n "$(compose ps -q 2>/dev/null)" ]] || echo "    $(red "none running") $(dim "— ops stack $OPS_ENV up")"

  # Machine
  echo
  local base="${OPS_HOME}"
  [[ -d "$base" ]] || base="$OPS_REPO"
  row disk "$(df -h "$base" | awk 'NR==2 {print $4 " free of " $2 " (" $5 " used)"}')"
  row memory "$(free -h | awk '/^Mem:/ {print $7 " available of " $2}')"
  row load "$(cut -d' ' -f1-3 /proc/loadavg)"

  # Backups
  # shellcheck source=devops/cmd/backup.sh
  source "$OPS_DIR/cmd/backup.sh"
  local newest age
  newest="$(ls -1d "$(backup_root)"/*/ 2>/dev/null | sed 's|/$||' | sort | tail -1 || true)"
  if [[ -n "$newest" ]]; then
    age=$(( ($(date +%s) - $(stat -c %Y "$newest")) / 3600 ))
    if ((age > 26)) && [[ "$OPS_MODE" == hosted ]]; then
      row backup "$(red "${age}h old") ${newest##*/}"
    else
      row backup "${newest##*/} $(dim "(${age}h ago)")"
    fi
  else
    row backup "$([[ "$OPS_MODE" == hosted ]] && red none || dim none)"
  fi

  # Timers
  if [[ "$OPS_MODE" == hosted ]] && have systemctl; then
    local timers
    timers="$(systemctl --user list-timers "graft-*@$OPS_ENV.timer" --no-legend 2>/dev/null |
      awk '{print $NF ": next " $2 " " $3}' | paste -sd ';' | sed 's/;/ · /g')"
    row timers "${timers:-$(yellow "none — ops units $OPS_ENV install")}"
  fi

  # Tunnel
  if have tailscale; then
    local funnel
    funnel="$(tailscale funnel status 2>/dev/null | grep -E "proxy http://127.0.0.1:$OPS_PORT|proxy http://localhost:$OPS_PORT" -B3 | grep -oE 'https://[^ ]+' | head -1 || true)"
    [[ -n "$funnel" ]] && row funnel "$funnel → :$OPS_PORT" || row funnel "$(dim "not funnelling :$OPS_PORT")"
  fi
}
