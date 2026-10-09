# shellcheck shell=bash
# ops backup <env> · ops backups <env> · ops restore <env> <backup>
#
# A backup is a directory:
#   <stamp>/mongo.archive.gz   mongodump --archive --gzip of the app database
#   <stamp>/objects/           the media bucket (devops/lib/objects.ts)
#   <stamp>/manifest           env, database, release, counts
#
# Hosted: $GRAFT_ROOT/<env>/shared/backups. Local: <repo>/.ops-backups/<env>.
# BACKUP_KEEP (default 14) are kept. If the env file sets OPS_BACKUP_OFFSITE
# (an rsync target such as `laptop:/backups/graft-qa`), every backup is also
# copied there — a backup on the same disk as the data does not survive the disk.

backup_root() {
  if [[ "$OPS_MODE" == hosted ]]; then
    echo "$OPS_SHARED/backups"
  else
    echo "$OPS_REPO/.ops-backups/$OPS_ENV"
  fi
}

db_name() {
  local db
  db="$(env_get MONGO_DB)"
  [[ -n "$db" ]] || db="$(env_get MONGODB_URI | sed -E 's|^mongodb(\+srv)?://[^/]+/([^?]+).*|\2|')"
  echo "$db"
}

# shellcheck source=devops/cmd/stack.sh
source "$OPS_DIR/cmd/stack.sh"
objects_run() { with_local_s3 app_tsx devops/lib/objects.ts "$@"; }

# do_backup [LABEL] — takes a backup and leaves its directory in BACKUP_DIR.
do_backup() {
  local label="${1:-}" root stamp dir db
  root="$(backup_root)"
  stamp="$(date +%Y%m%d-%H%M%S)${label:+-$label}"
  dir="$root/$stamp"
  db="$(db_name)"
  mkdir -p "$dir"
  chmod 700 "$root" "$dir"

  info "mongo: dumping $(bold "$db")"
  # shellcheck disable=SC2016
  mongo_sh "mongodump $MONGO_ROOT_ARGS --db='$db' --archive --gzip --quiet" >"$dir/mongo.archive.gz" || {
    rm -rf "$dir"
    die "mongodump failed — is the stack up? (\`ops stack $OPS_ENV ps\`)"
  }
  ok "mongo.archive.gz $(du -h "$dir/mongo.archive.gz" | cut -f1)"

  info "objects: copying the bucket"
  objects_run backup "$dir/objects" || warn "bucket copy failed — the backup has the database only"

  {
    echo "env=$OPS_ENV"
    echo "db=$db"
    echo "created=$(date -Is)"
    echo "host=$(hostname)"
    echo "release=$(cat "$OPS_APP_DIR/REVISION" 2>/dev/null || git -C "$OPS_REPO" rev-parse HEAD 2>/dev/null)"
  } >"$dir/manifest"
  chmod -R go-rwx "$dir"
  BACKUP_DIR="$dir"
}

prune_backups() {
  local keep="${BACKUP_KEEP:-14}" root n=0 b
  root="$(backup_root)"
  # Only automatic backups are pruned; labelled ones (pre-restore, manual)
  # stay until someone deletes them.
  while read -r b; do
    n=$((n + 1))
    if ((n > keep)); then rm -rf "$b"; fi
  done < <(ls -1d "$root"/*/ 2>/dev/null | sed 's|/$||' | grep -E '/[0-9]{8}-[0-9]{6}$' | sort -r)
}

cmd_backup() {
  ops_env "${1:-}"
  local label="${2:-}" dir offsite
  [[ -z "$label" || "$label" =~ ^[a-z0-9-]+$ ]] || die "label must be lowercase letters, digits and dashes"
  do_backup "$label"
  dir="$BACKUP_DIR"
  prune_backups
  ok "backup: $dir ($(du -sh "$dir" | cut -f1))"
  audit "backup ${dir##*/}"

  offsite="$(env_get OPS_BACKUP_OFFSITE)"
  if [[ -n "$offsite" ]]; then
    info "copying off the box to $offsite"
    rsync -a --delete "$(backup_root)/" "$offsite/" && ok "offsite copy done" || {
      fail "offsite copy to $offsite failed"
      return 1
    }
  elif [[ "$OPS_ENV" == prod ]]; then
    warn "no OPS_BACKUP_OFFSITE — prod backups live on the same disk as prod data"
  fi
}

cmd_backups() {
  ops_env "${1:-}"
  local root b
  root="$(backup_root)"
  echo "$(bold Backups) $(dim "($root)")"
  for b in $(ls -1d "$root"/*/ 2>/dev/null | sed 's|/$||' | sort -r); do
    printf '  %-34s %6s  %s\n' "${b##*/}" "$(du -sh "$b" | cut -f1)" "$(dim "$(grep -E '^release=' "$b/manifest" 2>/dev/null | cut -c9-15)")"
  done
}

cmd_restore() {
  ops_env "${1:-}"
  local src="${2:-}" root dir src_db db
  [[ -n "$src" ]] || die "usage: ops restore <env> <backup dir or name>  (\`ops backups $OPS_ENV\` lists them)"
  root="$(backup_root)"
  if [[ -d "$src" ]]; then dir="$(readlink -f "$src")"; else dir="$root/$src"; fi
  [[ -f "$dir/mongo.archive.gz" ]] || die "$dir has no mongo.archive.gz"
  src_db="$(grep -E '^db=' "$dir/manifest" 2>/dev/null | cut -d= -f2)"
  db="$(db_name)"
  src_db="${src_db:-$db}"

  echo
  echo "  restore  $(bold "${dir##*/}")  $(dim "($(grep -E '^(env|created)=' "$dir/manifest" 2>/dev/null | tr '\n' ' '))")"
  echo "  into     $(bold "$OPS_ENV") / $db $( [[ "$src_db" != "$db" ]] && echo "$(dim "(renamed from $src_db)")")"
  confirm_typed "$OPS_ENV" "REPLACE every collection in $OPS_ENV/$db with the backup"

  info "safety backup of what is there now"
  do_backup pre-restore
  ok "safety backup: $BACKUP_DIR"

  local was_running=0
  if [[ "$OPS_MODE" == hosted ]] && systemctl --user is-active --quiet "$OPS_UNIT" 2>/dev/null; then
    was_running=1
    info "stopping the app during the restore"
    systemctl --user stop "$OPS_UNIT"
  fi

  info "mongo: restoring"
  # --drop replaces each collection; nsFrom/nsTo lets a QA backup land in a
  # differently named database (e.g. the old graft_qa test stack → hosted).
  mongo_sh "mongorestore $MONGO_ROOT_ARGS --archive --gzip --drop --quiet \
    --nsInclude='$src_db.*' --nsFrom='$src_db.*' --nsTo='$db.*'" <"$dir/mongo.archive.gz" ||
    die "mongorestore failed — the safety backup is in $root"
  ok "database restored"

  if [[ -f "$dir/objects/index.json" ]]; then
    info "objects: restoring the bucket"
    objects_run restore "$dir/objects" || warn "bucket restore failed"
  fi

  # Indexes are not guaranteed to match the code that is running now.
  app_tsx scripts/create-indexes.ts >/dev/null && ok "indexes ensured"
  audit "restore ${dir##*/} into $db"

  if ((was_running)); then
    systemctl --user start "$OPS_UNIT"
    ok "app started again"
  fi
}
