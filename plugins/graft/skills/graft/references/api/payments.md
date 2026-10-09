# Payments

_Stripe Connect, so a workspace can take card payments._

Stripe Connect, so a workspace can take card payments.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `GET` `/api/v1/payments/stripe-connect`

Whether the workspace can take card payments through Stripe Checkout, refreshed from Stripe while onboarding is open.

**Auth:** Bearer token

## `DELETE` `/api/v1/payments/stripe-connect`

Disconnect the workspace's Stripe account.

**Auth:** Bearer token

## `POST` `/api/v1/payments/stripe-connect/onboarding`

A Stripe-hosted onboarding link for the workspace's connected account, created on first use. Owner or admin.

**Auth:** Bearer token
