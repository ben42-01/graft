# System

_Health, readiness and the public signing keys._

Health, readiness and the public signing keys.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `GET` `/api/.well-known/jwks.json`

The public keys (JWKS) that verify Graft's RS256 access tokens. Use it to verify a token yourself without calling Graft.

**Auth:** None

## `GET` `/api/health`

Liveness: the process is up. Touches no dependency.

**Auth:** None

## `GET` `/api/ready`

Readiness: Mongo and Redis are reachable. Returns `503` when either is down.

**Auth:** None
