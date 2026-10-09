# shellcheck shell=bash
# ops support <env> user|tenant|find|request|grant-readonly
#
# Everything here reads; nothing writes customer data. Each call leaves one
# line in shared/audit.log (who, when, what was looked up), never the result.

cmd_support() {
  ops_env "${1:-}"
  local what="${2:-}"
  shift 2 || true
  case "$what" in
    user | tenant | find)
      [[ $# -gt 0 ]] || die "usage: ops support $OPS_ENV $what <query>"
      audit "support $what $*"
      app_tsx devops/lib/support.ts "$what" "$@"
      ;;
    request)
      [[ -n "${1:-}" ]] || die "usage: ops support $OPS_ENV request <requestId>"
      audit "support request $1"
      support_request "$1"
      ;;
    grant-readonly) grant_readonly ;;
    *) die "usage: ops support <env> user <email> | tenant <id|slug|email> | find <collection> '<filter>' | request <id> | grant-readonly" ;;
  esac
}

# Everything known about one request: its log lines, and the activity row it
# wrote if it changed something. The requestId is what a customer sees in an
# error toast and what every API error body carries.
support_request() {
  local id="$1"
  [[ "$id" =~ ^[A-Za-z0-9_-]+$ ]] || die "that does not look like a request id"
  echo "$(bold "Log lines") $(dim "(last 7 days)")"
  # shellcheck source=devops/cmd/logs.sh
  source "$OPS_DIR/cmd/logs.sh"
  app_log_stream --since "7 days ago" | grep -F "\"requestId\":\"$id\"" | pretty_log || echo "  none found"
  echo
  echo "$(bold "Activity rows")"
  app_tsx devops/lib/support.ts find activities "{\"requestId\":\"$id\"}" --limit 5
}

# Creates (or re-keys) graft_support: `read` on the app database and nothing
# else. Its URI goes into the env file as SUPPORT_MONGODB_URI, which the
# lookups and `ops shell <env> mongo` prefer over the read-write app user.
grant_readonly() {
  local db port pw user=graft_support
  # shellcheck source=devops/cmd/backup.sh
  source "$OPS_DIR/cmd/backup.sh"
  db="$(db_name)"
  port="$(env_get MONGO_PORT)"
  pw="$(gen_secret)"
  # The password travels on stdin, never on a command line. mongosh reads
  # stdin as a REPL, line by line, so each statement is complete on its line.
  mongo_sh "mongosh $MONGO_ROOT_ARGS --quiet '$db'" <<JS >/dev/null
const spec = { pwd: "$pw", roles: [{ role: "read", db: db.getName() }] };
db.getUser("$user") ? db.updateUser("$user", spec) : db.createUser({ user: "$user", ...spec });
JS
  # shellcheck disable=SC2016
  mongo_sh "mongosh $MONGO_ROOT_ARGS --quiet '$db' --eval 'quit(db.getUser(\"$user\") ? 0 : 1)'" ||
    die "could not create $user"
  env_set SUPPORT_MONGODB_URI \
    "mongodb://$user:$pw@127.0.0.1:${port:-27017}/$db?authSource=$db&directConnection=true" "$OPS_ENV_FILE"
  ok "read-only user '$user' on $db; SUPPORT_MONGODB_URI written to $OPS_ENV_FILE"
  audit "support grant-readonly"
}
