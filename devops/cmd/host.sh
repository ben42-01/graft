# shellcheck shell=bash
# ops host init <env> [--repo URL] [--from-env FILE] [--from-keys DIR]
#
# Creates the hosted layout for one environment:
#
#   $GRAFT_ROOT/<env>/
#     repo/                 git clone deploys are cut from (also a usable ops)
#     releases/<stamp>-<sha>/  one built copy of the app per deploy
#     current -> releases/…  what the app unit runs
#     shared/
#       .env                the environment's secrets (mode 600)
#       keys/               JWT keypair + Mongo replica-set keyfile
#       stack/              compose file + mongo init, refreshed on deploy
#       backups/            `ops backup` output
#       deploys.log         one line per deploy / rollback
#       audit.log           one line per operator action (support lookups too)

cmd_host() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    init) host_init "$@" ;;
    *) die "usage: ops host init <env> [--repo URL] [--from-env FILE] [--from-keys DIR]" ;;
  esac
}

host_init() {
  local env="" repo_url="" from_env="" from_keys=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo) repo_url="$2"; shift 2 ;;
      --from-env) from_env="$2"; shift 2 ;;
      --from-keys) from_keys="$2"; shift 2 ;;
      *) env="$1"; shift ;;
    esac
  done
  case "$env" in
    qa | prod) ;;
    production) env=prod ;;
    *) die "usage: ops host init qa|prod [--repo URL] [--from-env FILE] [--from-keys DIR]" ;;
  esac
  repo_url="${repo_url:-$(git -C "$OPS_REPO" remote get-url origin 2>/dev/null || true)}"
  [[ -n "$repo_url" ]] || die "no --repo given and $OPS_REPO has no origin remote"

  local home="$GRAFT_ROOT/$env" shared="$GRAFT_ROOT/$env/shared"
  info "initialising $(bold "$env") under $home"

  if ! mkdir -p "$home" 2>/dev/null; then
    die "cannot create $home — run once: sudo mkdir -p $GRAFT_ROOT && sudo chown $USER: $GRAFT_ROOT"
  fi
  mkdir -p "$home/releases" "$shared/keys/mongo" "$shared/stack" "$shared/backups"
  chmod 700 "$shared" "$shared/keys" "$shared/keys/mongo" "$shared/backups"

  if [[ -d "$home/repo/.git" ]]; then
    ok "repo/ already cloned"
  else
    git clone --quiet "$repo_url" "$home/repo"
    ok "cloned $repo_url"
  fi

  # Key material. Generated here with openssl rather than `npm run setup`,
  # which writes into a checkout, not into shared/.
  local k="$shared/keys"
  if [[ -f "$k/jwt-private.pem" ]]; then
    ok "JWT keypair already present"
  elif [[ -n "$from_keys" ]]; then
    # Carrying the keypair over keeps existing sessions valid across the move.
    install -m 600 "$from_keys/jwt-private.pem" "$k/jwt-private.pem"
    install -m 644 "$from_keys/jwt-public.pem" "$k/jwt-public.pem"
    ok "JWT keypair copied from $from_keys"
  else
    (umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$k/jwt-private.pem" 2>/dev/null)
    openssl pkey -in "$k/jwt-private.pem" -pubout -out "$k/jwt-public.pem"
    chmod 644 "$k/jwt-public.pem"
    ok "JWT keypair generated (RS256, 2048-bit)"
  fi
  if [[ -f "$k/mongo/keyfile" ]]; then
    ok "Mongo keyfile already present"
  else
    (umask 077 && openssl rand -base64 600 | tr -d '\n' >"$k/mongo/keyfile")
    ok "Mongo keyfile generated"
  fi

  if [[ -f "$shared/.env" ]]; then
    ok "shared/.env already present — left untouched"
  else
    # shellcheck source=devops/cmd/env.sh
    source "$OPS_DIR/cmd/env.sh"
    if [[ -n "$from_env" ]]; then env_init "$env" --from "$from_env"; else env_init "$env"; fi
  fi

  echo
  info "next steps:"
  echo "    1. $(bold "ops env edit $env")   fill APP_URL, S3_ENDPOINT, Stripe, SMTP"
  echo "    2. $(bold "ops deploy $env")     first release; also starts the containers and installs the"
  echo "                         systemd units (app, nightly backup, hourly trial expiry)"
  echo "    3. $(bold "ops tunnel $env up")  public URL via Tailscale Funnel"
  echo "    $(dim "ops lives at $home/current/devops/ops after the first deploy; link it with:")"
  echo "    $(dim "ln -sf $home/current/devops/ops ~/.local/bin/ops")"
}
