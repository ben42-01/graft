# shellcheck shell=bash
# ops stripe <env> check|listen
#
# check  — talks to the Stripe API with the environment's own key (curl, no
#          Stripe CLI needed): is the key valid and in the right mode, do both
#          webhook endpoints exist for *this* APP_URL and are they enabled, do
#          the price ids resolve. The usual reason "payments don't work on QA".
# listen — dev only: the Stripe CLI forwarding to localhost (devctl's script).

stripe_api() {
  curl -s --max-time 10 -u "$STRIPE_KEY:" "https://api.stripe.com/v1/$1"
}

cmd_stripe() {
  ops_env "${1:-}"
  case "${2:-check}" in
    check) stripe_check ;;
    listen)
      [[ "$OPS_ENV" == dev ]] || die "hosted environments use dashboard webhook endpoints, not the CLI (README → Hosted QA, step 4)"
      exec bash "$OPS_REPO/tools/devctl/scripts/stripe-webhook.sh"
      ;;
    *) die "usage: ops stripe <env> check|listen" ;;
  esac
}

stripe_check() {
  have jq || die "needs jq (ops install jq)"
  local problems=0 app_url account mode
  STRIPE_KEY="$(env_get STRIPE_SECRET_KEY)"
  app_url="$(env_get APP_URL)"
  [[ -n "$STRIPE_KEY" && "$STRIPE_KEY" != __set_me__ ]] || die "STRIPE_SECRET_KEY is not set in $OPS_ENV_FILE"
  [[ "$STRIPE_KEY" == *dummy* ]] && die "STRIPE_SECRET_KEY is the local dummy — nothing to check"

  mode="test"
  [[ "$STRIPE_KEY" == *_live_* ]] && mode=live
  account="$(stripe_api account)"
  if [[ "$(jq -r '.error.message // empty' <<<"$account")" != "" ]]; then
    fail "key rejected: $(jq -r '.error.message' <<<"$account")"
    return 1
  fi
  ok "key valid · $(bold "$mode") mode · account $(jq -r '.id' <<<"$account") $(dim "($(jq -r '.settings.dashboard.display_name // .business_profile.name // "unnamed"' <<<"$account"))")"
  if [[ "$OPS_ENV" == prod && "$mode" != live ]]; then fail "production is on a TEST key"; problems=$((problems + 1)); fi
  if [[ "$OPS_ENV" != prod && "$mode" == live ]]; then fail "$OPS_ENV is on a LIVE key"; problems=$((problems + 1)); fi

  # Webhook endpoints: both must exist for this APP_URL and be enabled.
  local endpoints path want found
  endpoints="$(stripe_api 'webhook_endpoints?limit=100')"
  echo
  echo "  $(bold "webhook endpoints") $(dim "on this account")"
  jq -r '.data[] | "    \(.status)\t\(.url)\t\(.enabled_events | length) events"' <<<"$endpoints" | column -t -s $'\t' || true
  echo
  if [[ "$OPS_ENV" == dev ]]; then
    info "dev uses \`ops stripe dev listen\` — endpoints are not required"
  else
    for path in stripe stripe-connect; do
      want="$app_url/api/v1/webhooks/$path"
      found="$(jq -r --arg u "$want" '.data[] | select(.url == $u) | .status' <<<"$endpoints" | head -1)"
      case "$found" in
        enabled) ok "$want" ;;
        "") fail "no endpoint for $want"; problems=$((problems + 1)) ;;
        *) fail "$want is $found"; problems=$((problems + 1)) ;;
      esac
    done
    # Stale endpoints for an old funnel URL keep failing deliveries and spam
    # the dashboard with "endpoint disabled" mail.
    jq -r --arg base "$app_url" '.data[] | select(.url | contains("/api/v1/webhooks/")) | select(.url | startswith($base) | not) | .url' <<<"$endpoints" |
      while read -r stale; do warn "endpoint for another URL: $stale (old tunnel? another env sharing this account?)"; done
  fi

  # Prices.
  local key id price
  for key in STRIPE_PRICE_PREMIUM_MONTHLY STRIPE_PRICE_PREMIUM_ANNUAL; do
    id="$(env_get "$key")"
    [[ -z "$id" || "$id" == __set_me__ || "$id" == *dummy* ]] && { warn "$key not set"; continue; }
    price="$(stripe_api "prices/$id")"
    if [[ -n "$(jq -r '.error.message // empty' <<<"$price")" ]]; then
      fail "$key=$id: $(jq -r '.error.message' <<<"$price")"; problems=$((problems + 1))
    else
      ok "$key $(jq -r '"\(.unit_amount / 100) \(.currency | ascii_upcase) / \(.recurring.interval // "once") · active=\(.active)"' <<<"$price")"
    fi
  done

  echo
  ((problems == 0)) && ok "Stripe looks right for $OPS_ENV" || { fail "$problems problem(s)"; return 1; }
}
