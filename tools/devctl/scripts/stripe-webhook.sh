#!/usr/bin/env bash
# Forward Stripe webhooks (billing + Connect checkout) to the local dev server. Safe to run from any directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="$ROOT/.env.dev"

STRIPE_KEY="$(grep '^STRIPE_SECRET_KEY=' "$ENV_FILE" | cut -d= -f2-)"
if [ -z "$STRIPE_KEY" ]; then
  # An empty --api-key makes the CLI fall back to its `stripe login` account,
  # which has a different webhook secret than the app's key.
  echo "STRIPE_SECRET_KEY not found in $ENV_FILE" >&2
  exit 1
fi

# The secret the app must have in STRIPE_WEBHOOK_SECRET for this key.
EXPECTED="$(stripe listen --api-key "$STRIPE_KEY" --print-secret | grep -oE 'whsec_[A-Za-z0-9]+' | head -1)"
CURRENT="$(grep '^STRIPE_WEBHOOK_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
if [ "$EXPECTED" != "$CURRENT" ]; then
  echo "STRIPE_WEBHOOK_SECRET in .env.dev does not match this key's signing secret." >&2
  echo "Expected ${EXPECTED:0:10}…, found ${CURRENT:0:10}…  — update it and restart npm run dev." >&2
  exit 1
fi

# The CLI signs Connect events with the same secret, so the Connect variable
# must hold the same value locally (deployed, it is a separate endpoint's secret).
CURRENT_CONNECT="$(grep '^STRIPE_CONNECT_WEBHOOK_SECRET=' "$ENV_FILE" | cut -d= -f2- || true)"
if [ "$EXPECTED" != "$CURRENT_CONNECT" ]; then
  echo "STRIPE_CONNECT_WEBHOOK_SECRET in .env.dev does not match this key's signing secret." >&2
  echo "Expected ${EXPECTED:0:10}…, found ${CURRENT_CONNECT:0:10}…  — update it and restart npm run dev." >&2
  exit 1
fi

# One listener: account events -> billing, connected-account events -> Connect checkout.
stripe listen --api-key "$STRIPE_KEY" \
  --forward-to localhost:3000/api/v1/webhooks/stripe \
  --forward-connect-to localhost:3000/api/v1/webhooks/stripe-connect
