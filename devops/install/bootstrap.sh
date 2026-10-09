#!/usr/bin/env bash
# Graft — install what a machine needs to run, operate or develop Graft.
#
# Standalone on purpose: it runs on a fresh Debian / Ubuntu / Raspberry Pi OS
# box before the repo is cloned, so it sources nothing from the repo.
#
#   devops/install/bootstrap.sh                    # the server set: base node docker tailscale
#   devops/install/bootstrap.sh stripe cloudflared # just these
#   devops/install/bootstrap.sh --all              # everything below
#   devops/install/bootstrap.sh --dry-run --all    # print what would run
#
# Tools:  base (git curl jq rsync openssl …), node (22 LTS), docker (+ compose
#         plugin), tailscale, stripe (CLI), cloudflared, gh, bruno (API test CLI)
#
# Idempotent: anything already installed at a good enough version is skipped.
# Every package comes from its vendor's own apt repository or install script,
# signed, never a random binary.
set -euo pipefail

NODE_MAJOR=22
SERVER_SET=(base node docker tailscale)
ALL=(base node docker tailscale stripe cloudflared gh bruno)

DRY=0
want=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --all) want=("${ALL[@]}") ;;
    -h | --help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    base | node | docker | tailscale | stripe | cloudflared | gh | bruno) want+=("$arg") ;;
    *) echo "unknown tool '$arg' — one of: ${ALL[*]}" >&2; exit 2 ;;
  esac
done
[[ ${#want[@]} -gt 0 ]] || want=("${SERVER_SET[@]}")
# Every other installer needs curl and gpg, so base always goes first.
[[ " ${want[*]} " == *" base "* ]] || want=(base "${want[@]}")

if [[ -t 1 ]]; then DIM=$'\033[2m' GREEN=$'\033[32m' RESET=$'\033[0m'; else DIM="" GREEN="" RESET=""; fi
say() { printf '%sbootstrap │%s %s\n' "$DIM" "$RESET" "$*"; }
done_() { printf '%s  ✓%s %s\n' "$GREEN" "$RESET" "$*"; }
run() {
  if ((DRY)); then printf '    $ %s\n' "$*"; else "$@"; fi
}
# sh -c for pipelines, so --dry-run can print them whole.
run_sh() {
  if ((DRY)); then printf '    $ %s\n' "$1"; else sh -c "$1"; fi
}
have() { command -v "$1" >/dev/null 2>&1; }

SUDO=""
if [[ $EUID -ne 0 ]]; then
  have sudo || { echo "needs root or sudo" >&2; exit 1; }
  SUDO="sudo"
fi

have apt-get || {
  echo "this installer supports Debian, Ubuntu and Raspberry Pi OS (apt)." >&2
  echo "elsewhere, install by hand: ${want[*]} — see devops/README.md §Machine" >&2
  exit 1
}
ARCH="$(dpkg --print-architecture)"
say "$(. /etc/os-release && echo "$PRETTY_NAME") · $ARCH · installing: ${want[*]}"

APT_UPDATED=0
apt_install() {
  if ((!APT_UPDATED)); then
    run $SUDO apt-get update -qq
    APT_UPDATED=1
  fi
  run $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
}

# add_apt_repo NAME KEY_URL "deb line with @KEYRING@"
add_apt_repo() {
  local name="$1" key_url="$2" line="$3" keyring="/usr/share/keyrings/$1.gpg"
  if [[ ! -f "$keyring" ]]; then
    run_sh "curl -fsSL '$key_url' | gpg --dearmor | $SUDO tee '$keyring' >/dev/null"
  fi
  run_sh "echo '${line//@KEYRING@/$keyring}' | $SUDO tee /etc/apt/sources.list.d/$name.list >/dev/null"
  APT_UPDATED=0
}

install_base() {
  local missing=() p
  for p in git curl ca-certificates gnupg jq rsync openssl; do
    dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
  done
  if [[ ${#missing[@]} -eq 0 ]]; then done_ "base tools already installed"; return; fi
  apt_install "${missing[@]}"
  done_ "base: ${missing[*]}"
}

install_node() {
  if have node && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]]; then
    done_ "node $(node -v) already installed ($(command -v node))"
    return
  fi
  # NodeSource, system-wide: systemd units need a node that does not live in
  # one user's ~/.nvm.
  add_apt_repo nodesource "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
    "deb [signed-by=@KEYRING@] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main"
  apt_install nodejs
  done_ "node $NODE_MAJOR"
}

install_docker() {
  if have docker && docker compose version >/dev/null 2>&1; then
    done_ "docker $(docker --version | cut -d' ' -f3 | tr -d ,) + compose already installed"
  else
    # Docker's own convenience script: picks the right repo for the distro and arch.
    run_sh "curl -fsSL https://get.docker.com | $SUDO sh"
    done_ "docker"
  fi
  if [[ $EUID -ne 0 ]] && ! id -nG "$USER" | grep -qw docker; then
    run $SUDO usermod -aG docker "$USER"
    say "added $USER to the docker group — log out and back in (or \`newgrp docker\`)"
  fi
}

install_tailscale() {
  if have tailscale; then done_ "tailscale already installed"; else
    run_sh "curl -fsSL https://tailscale.com/install.sh | sh"
    done_ "tailscale"
  fi
  # Funnel and `tailscale funnel` without sudo want the operator set to us.
  say "next: $SUDO tailscale up --ssh --operator=$USER   (--ssh lets \`ops @host\` work with no keys)"
}

install_stripe() {
  if have stripe; then done_ "stripe CLI already installed"; return; fi
  add_apt_repo stripe "https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public" \
    "deb [signed-by=@KEYRING@] https://packages.stripe.dev/stripe-cli-debian-local stable main"
  apt_install stripe
  done_ "stripe CLI — then: stripe login"
}

install_cloudflared() {
  if have cloudflared; then done_ "cloudflared already installed"; return; fi
  add_apt_repo cloudflare-main "https://pkg.cloudflare.com/cloudflare-main.gpg" \
    "deb [signed-by=@KEYRING@] https://pkg.cloudflare.com/cloudflared any main"
  apt_install cloudflared
  done_ "cloudflared — then: cloudflared tunnel login"
}

install_gh() {
  if have gh; then done_ "gh already installed"; return; fi
  add_apt_repo githubcli-archive-keyring "https://cli.github.com/packages/githubcli-archive-keyring.gpg" \
    "deb [arch=$ARCH signed-by=@KEYRING@] https://cli.github.com/packages stable main"
  apt_install gh
  done_ "gh — then: gh auth login"
}

install_bruno() {
  if have bru; then done_ "bruno CLI already installed"; return; fi
  have npm || { echo "bruno needs node first (bootstrap.sh node bruno)" >&2; return 1; }
  # Global npm needs root with a system node, not with nvm.
  local npm_sudo=""
  [[ "$(npm prefix -g)" == /usr* ]] && npm_sudo="$SUDO"
  run $npm_sudo npm install -g --no-fund --no-audit @usebruno/cli
  done_ "bruno CLI (bru)"
}

for tool in "${want[@]}"; do
  say "── $tool"
  "install_$tool"
done
say "done. Check the machine with: devops/ops doctor"
