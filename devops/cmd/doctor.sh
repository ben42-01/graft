# shellcheck shell=bash
# ops doctor [env] — is this machine able to run Graft, and if an env is given,
# is that environment healthy? Read-only; prints what to do about each finding.
# ops install [tools…] — devops/install/bootstrap.sh.

cmd_install() { exec bash "$OPS_DIR/install/bootstrap.sh" "$@"; }

MINIO_IMAGE_REF="$(grep -oE 'cgr.dev/chainguard/minio@sha256:[0-9a-f]+' "$OPS_DIR/compose/docker-compose.hosted.yml" | head -1)"

cmd_doctor() {
  local bad=0
  _ok() { ok "$*"; }
  _no() { fail "$*"; bad=$((bad + 1)); }

  echo "$(bold "Machine") $(dim "$(uname -m) · $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")")"

  # Tools: name, why, and whether a server needs it.
  local tool why
  while IFS='|' read -r tool why; do
    if have "$tool"; then
      _ok "$(printf "%-12s" "$tool") $(dim "$( { "$tool" --version 2>/dev/null || "$tool" version 2>/dev/null; } | head -1 | cut -c1-60)")"
    elif [[ "$why" == required* ]]; then
      _no "$(printf '%-12s' "$tool") missing — $why (ops install)"
    else
      warn "$(printf '%-12s' "$tool") missing — $why"
    fi
  done <<'EOF'
git|required: deploys clone and fetch
node|required: the app, every script
npm|required
docker|required: Mongo, Redis, MinIO
jq|required: status, logs, stripe check
curl|required: health checks
openssl|required: key + secret generation
rsync|optional: offsite backups
tailscale|optional: Funnel / ssh between boxes (ops install tailscale)
stripe|optional: dev webhook forwarding (ops install stripe)
cloudflared|optional: Cloudflare Tunnel for prod (ops install cloudflared)
gh|optional: PRs and CI from the terminal (ops install gh)
bru|optional: Bruno API suite (ops install bruno)
EOF

  if have node; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    ((major >= 20)) || _no "node $major is too old (package.json engines: >=20)"
    [[ "$(readlink -f "$(command -v node)")" == "$HOME"/.nvm/* ]] &&
      warn "node comes from nvm — fine; ops units pins its path, so re-run \`ops units <env> install\` after switching versions"
  fi
  if have docker; then
    if docker info >/dev/null 2>&1; then
      _ok "docker daemon reachable as $USER"
      docker compose version >/dev/null 2>&1 || _no "docker compose plugin missing"
    else
      _no "cannot talk to docker — is it running, and is $USER in the docker group? (sudo usermod -aG docker $USER, then log in again)"
    fi
  fi

  # Mongo 7 needs ARMv8.2-A: a Pi 5 has it, a Pi 4 does not.
  if [[ "$(uname -m)" == aarch64 ]] && ! grep -qw atomics /proc/cpuinfo; then
    _no "this ARM CPU lacks ARMv8.2 atomics — mongo:7 will not start (Pi 4?). Use Atlas or mongo:4.4"
  fi
  # The digest-pinned MinIO image must have a manifest for this architecture.
  if have docker && [[ -n "$MINIO_IMAGE_REF" ]] && docker info >/dev/null 2>&1; then
    local arch
    arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
    if docker manifest inspect "$MINIO_IMAGE_REF" 2>/dev/null | grep -q "\"architecture\": \"$arch\""; then
      _ok "MinIO image has a $arch build"
    else
      warn "could not confirm the MinIO image has a $arch build (offline, or single-arch digest)"
    fi
  fi

  # Resources. A Next build wants ~2GB; a Pi with 4GB and no swap can OOM.
  local mem_mb swap_mb disk_gb
  mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
  swap_mb="$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)"
  disk_gb="$(df -BG --output=avail "${GRAFT_ROOT%/*}" 2>/dev/null | tail -1 | tr -dc 0-9)"
  ((mem_mb >= 3500)) && _ok "memory ${mem_mb}MB" || warn "memory ${mem_mb}MB — next build may run out; add swap"
  ((mem_mb + swap_mb >= 6000)) || warn "memory+swap $((mem_mb + swap_mb))MB — builds on this box will be tight"
  [[ -n "$disk_gb" ]] && { ((disk_gb >= 10)) && _ok "disk ${disk_gb}GB free" || _no "only ${disk_gb}GB free (each release ~1GB with node_modules)"; }

  # User services survive logout only with lingering.
  if have loginctl && [[ -d "$GRAFT_ROOT" ]]; then
    [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" == yes ]] &&
      _ok "systemd lingering on for $USER" || _no "lingering off — the app stops when you log out (sudo loginctl enable-linger $USER)"
  fi

  if have tailscale; then
    tailscale status >/dev/null 2>&1 && _ok "tailscale up ($(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // "?"' | sed 's/\.$//'))" ||
      warn "tailscale installed but not logged in (sudo tailscale up --ssh --operator=$USER)"
  fi

  # Environments found on this machine.
  echo
  echo "$(bold "Environments")"
  local e found=0
  for e in qa prod; do
    if [[ -f "$GRAFT_ROOT/$e/shared/.env" ]]; then
      found=1
      echo "  $e: hosted at $GRAFT_ROOT/$e"
    fi
  done
  [[ -f "$OPS_REPO/.env.dev" ]] && echo "  dev: local checkout $OPS_REPO" && found=1
  ((found)) || echo "  none — ops host init qa   (or npm install in a checkout for dev)"

  if [[ -n "${1:-}" ]]; then
    echo
    # shellcheck source=devops/cmd/env.sh
    source "$OPS_DIR/cmd/env.sh"
    env_check "$1" || bad=$((bad + 1))
  fi

  echo
  ((bad == 0)) && ok "nothing blocking" || { fail "$bad blocking finding(s)"; return 1; }
}
