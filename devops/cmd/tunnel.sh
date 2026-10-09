# shellcheck shell=bash
# ops tunnel <env> status|up|down — Tailscale Funnel in front of a hosted env.
#
# Funnel serves only on 443, 8443 and 10000. The app takes 443; MinIO's API
# (presigned upload/download URLs) takes 8443, because S3_ENDPOINT has to be
# a URL the customer's browser can reach (README, pi QA notes 2026-10-08).
# `tailscale serve` would be tailnet-only; funnel is public.
#
# Cloudflare Tunnel is the plan for prod (own domain, subdomains). It is
# configured in the Cloudflare dashboard or cloudflared's config, not here;
# `ops install cloudflared` gets the binary.

cmd_tunnel() {
  ops_env "${1:-}"
  have tailscale || die "tailscale is not installed (ops install tailscale)"
  local s3_port host
  s3_port="$(env_get S3_PORT)"
  host="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//')"
  case "${2:-status}" in
    status)
      tailscale funnel status
      if [[ -n "$host" ]]; then echo; info "this machine: https://$host"; fi
      ;;
    up)
      [[ -n "$host" ]] || die "tailscale is not logged in (sudo tailscale up)"
      tailscale funnel --bg "$OPS_PORT"
      ok "app   https://$host → 127.0.0.1:$OPS_PORT"
      if [[ -n "$s3_port" ]]; then
        tailscale funnel --bg --https=8443 "$s3_port"
        ok "minio https://$host:8443 → 127.0.0.1:$s3_port"
      fi
      echo
      local want_app="https://$host" want_s3="https://$host:8443"
      [[ "$(env_get APP_URL)" == "$want_app" ]] || warn "APP_URL should be $want_app — ops env edit $OPS_ENV"
      [[ -z "$s3_port" || "$(env_get S3_ENDPOINT)" == "$want_s3" ]] || warn "S3_ENDPOINT should be $want_s3 — ops env edit $OPS_ENV"
      audit "tunnel up"
      ;;
    down)
      tailscale funnel --https=443 off || true
      tailscale funnel --https=8443 off || true
      ok "funnel off — $OPS_ENV is no longer public"
      audit "tunnel down"
      ;;
    *) die "usage: ops tunnel <env> status|up|down" ;;
  esac
}
