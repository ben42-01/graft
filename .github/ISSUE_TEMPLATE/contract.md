---
name: Graft Contract
about: The contract a Build Agent implements and a Review Agent verifies against
title: "GRAFT-NN-type/short-slug"
labels: ["agent:draft"]
---

## Contract: GRAFT-NN-type/slug

### Context
<!-- Why this exists; link the docs it derives from: docs/Graft.md §, docs/TIERS.md §, docs/BACKEND.md §, docs/WORKFLOW.md § -->

### Scope
- In scope:
- Out of scope:

<!-- Depends-on: GRAFT-NN  (omit the line entirely if there are no dependencies) -->

### Acceptance Criteria
- [ ] AC1 — observable behaviour, testable
- [ ] AC2 —

### API Contract (if applicable)
<!-- Endpoint(s), request/response shapes, error codes. Standard envelope per docs/BACKEND.md §2. -->

### Test Contract
- Bruno: `/bruno/<folder>/<file>.bru` (new or updated) — MUST pass
- Unit: which services/functions require coverage
- Cross-tenant isolation test required: yes/no

### Constraints
- Tier gating involved? Which entitlement keys?
- Security notes (auth surface, rate limits touched)
- Files/areas expected to change (guidance, not law)

### Definition of Done
- [ ] All AC checked
- [ ] Tests in Test Contract pass in CI
- [ ] No lint/type errors, coverage gate holds
- [ ] Docs updated if behaviour/API changed
