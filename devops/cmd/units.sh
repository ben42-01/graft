# shellcheck shell=bash
# ops units <env> install|remove — systemd user units for a hosted environment.

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILES=(graft-app@.service graft-backup@.service graft-backup@.timer graft-trials@.service graft-trials@.timer)

units_installed() { [[ -f "$UNIT_DIR/graft-app@.service" ]]; }

# units_install [--quiet] — render the templates and enable them for OPS_ENV.
# Called by every deploy, so a changed unit file reaches the box with the code.
units_install() {
  have systemctl || die "no systemctl on this machine — run the app another way (see README)"
  local node_dir changed=0 f rendered
  node_dir="$(dirname "$(readlink -f "$(command -v node)")")"
  mkdir -p "$UNIT_DIR"
  for f in "${UNIT_FILES[@]}"; do
    rendered="$(sed -e "s|@ROOT@|$GRAFT_ROOT|g" -e "s|@NODE_DIR@|$node_dir|g" "$OPS_DIR/systemd/$f")"
    if [[ ! -f "$UNIT_DIR/$f" ]] || [[ "$(cat "$UNIT_DIR/$f")" != "$rendered" ]]; then
      printf '%s\n' "$rendered" >"$UNIT_DIR/$f"
      changed=1
    fi
  done
  ((changed)) && systemctl --user daemon-reload
  systemctl --user enable --quiet "graft-app@$OPS_ENV.service"
  systemctl --user enable --now --quiet "graft-backup@$OPS_ENV.timer" "graft-trials@$OPS_ENV.timer"
  [[ "${1:-}" == --quiet ]] || ok "units installed in $UNIT_DIR and enabled for $OPS_ENV"

  # Without lingering, user units stop when the last session closes — the
  # classic "the app died when I logged out of ssh".
  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]]; then
    loginctl enable-linger "$USER" 2>/dev/null ||
      warn "user services stop at logout until you run: sudo loginctl enable-linger $USER"
  fi
}

cmd_units() {
  ops_env "${1:-}"
  require_hosted units
  case "${2:-}" in
    install) units_install ;;
    remove)
      systemctl --user disable --now "graft-app@$OPS_ENV.service" "graft-backup@$OPS_ENV.timer" "graft-trials@$OPS_ENV.timer" || true
      ok "disabled the $OPS_ENV units (template files left in $UNIT_DIR for other environments)"
      ;;
    *) die "usage: ops units <env> install|remove" ;;
  esac
}
