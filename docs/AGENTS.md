# Graft — Agentic Development Loop Specification

**Doc:** GRAFT-DOC-04 · Companion to `README.md`, `BACKEND.md`
**Status:** Draft for review

How Graft is built: humans set direction, agents draft issues, implement them from a queue, and soft-review the result against the issue's contract. GitHub is the single source of truth.

---

## 1. Naming & Issue Format

### 1.1 Issue ID Convention

```
GRAFT-<NN>-<type>/<short-slug>
```

- `NN` — zero-padded sequence (GRAFT-01, GRAFT-02, …)
- `type` — one of: `feature` | `bugfix` | `release` | `chore` | `spike` | `security` | `docs`
- Examples:
  - `GRAFT-01-feature/entity-builder-crud`
  - `GRAFT-14-bugfix/form-quota-off-by-one`
  - `GRAFT-20-release/v0.3.0`

Branch name = issue ID. PR title = issue ID + summary. Commits: `GRAFT-14: fix meter reset boundary`.

### 1.3 Branching Model

Standard GitHub flow with a release branch:

| Branch | Role |
|---|---|
| `develop` | **Default branch.** Every feature/bugfix/chore branches from it and every PR targets it. Always deployable to QA. |
| `main` | Release branch. Only ever receives `develop` through a `type:release` contract, then gets tagged. Production deploys from here. |
| `GRAFT-NN-type/slug` | Short-lived work branch, deleted after merge. |

Hotfixes are the one exception: branch from `main`, PR into `main`, then back-merge to `develop` in the same contract so the fix cannot be lost in the next release.

### 1.2 Issue Template (the Contract)

Every issue body follows this template — it IS the contract that build and review agents work against:

```md
## Contract: GRAFT-NN-type/slug

### Context
Why this exists; links to docs (README §, TIERS §, BACKEND §).

### Scope
- In scope: ...
- Out of scope: ...

### Acceptance Criteria
- [ ] AC1 — observable behavior, testable
- [ ] AC2 — ...

### API Contract (if applicable)
Endpoint(s), request/response shapes, error codes.

### Test Contract
- Bruno: /bruno/<folder>/<file>.bru (new or updated) — MUST pass
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
- [ ] Docs updated if behavior/API changed
```

Labels: `type:*`, `area:*` (backend/frontend/infra/docs), `tier-impact`, `agent:draft|queued|building|review|blocked|done`, `priority:P0–P3`.

---

## 2. The Loop — Three Agent Roles

```
Human intent ──► [Drafting Agent] ──► Issue (contract) ──► Queue
                                                            │
              ┌──────────────────────────────◄──────────────┘
              ▼
        [Build Agent] ──► branch + PR ──► CI (tests from contract)
              │                                │
              ▼                                ▼
        [Review Agent] ──► review vs contract ──► pass → human merge
                                   │
                                   └─ fail → change requests → back to Build Agent (max 2 cycles, then human)
```

### 2.1 Drafting Agent

**Trigger:** human writes a rough feature/bug description (issue with label `agent:draft`, or a discussion comment `/draft`).

**Job:**
1. Read the request + relevant docs (README, TIERS, BACKEND).
2. Produce a full contract-format issue: assign next `GRAFT-NN`, choose type, write ACs, derive the Test Contract (name the exact Bruno files), flag tier/security constraints.
3. Split oversized work: if estimated diff > ~600 lines or touches >2 areas, split into sub-issues (`GRAFT-NN.1`, `GRAFT-NN.2`) with dependency order.
4. Set label `agent:queued` only after a human reacts 👍 / comments `/approve` — **humans gate the queue**.

**Quality bar:** every AC must be verifiable by a test or an explicit manual check. Vague ACs ("works well") are rejected by convention.

### 2.2 Build Agent

**Trigger:** picks the highest-priority `agent:queued` issue with no unmet dependencies; sets `agent:building` and assigns itself (lock — one agent per issue).

**Protocol:**
1. Create branch `GRAFT-NN-type/slug` from `develop`.
2. **Tests first:** write/extend the Bruno + unit tests named in the Test Contract before implementation where practical.
3. Implement strictly within Scope; if the contract is ambiguous or wrong, STOP, comment `@needs-clarification` with the specific question, set `agent:blocked`. Never invent scope.
4. Run the full local gate: lint, typecheck, unit, integration, `bru run`.
5. Open PR: title `GRAFT-NN: <summary>`, body links the issue, includes a **Contract Checklist** mapping each AC → test/file/line evidence, and a self-report of anything done outside guidance (with justification).
6. Set `agent:review`.

**Hard rules:**
- No changes to files outside the repo's agent-allowed paths (`.github/agent-policy.yml` defines protected paths: CI config, auth core, billing webhooks require human co-review).
- No new dependencies without listing them + license + reason in the PR body.
- No secrets, no disabling tests, no lowering coverage thresholds, no `eslint-disable` without justification comment.
- Max diff ~600 lines; larger → go back and ask Drafting Agent/human to split.

### 2.3 Review Agent (Soft Review)

**Trigger:** PR labeled `agent:review` with green CI.

**Job — review the code against the contract, not taste:**
1. **AC verification:** for each Acceptance Criterion, locate the evidence (test or code path). Missing evidence = request changes.
2. **Test Contract audit:** the named Bruno/unit tests exist, are meaningful (assert real behavior, not trivially green), and cross-tenant isolation test is present when required.
3. **Scope audit:** flag any diff outside declared Scope/Constraints.
4. **Security pass:** checklist from BACKEND.md — tenantId scoping on every new query, input validated with Zod, rate limiting on new endpoints, no PII in logs, entitlement checks for tier-gated features.
5. **Contract drift:** if the implementation revealed the contract was wrong, the review agent proposes a contract amendment on the issue (human approves) rather than silently accepting deviation.

**Output:** a structured review comment:

```md
## Soft Review — GRAFT-NN
Verdict: PASS | CHANGES REQUESTED | ESCALATE

| AC | Evidence | Status |
|----|----------|--------|
| AC1 | bruno/forms/quota-hard-stop.bru | ✅ |
| AC2 | src/server/services/meters.ts:41 + unit | ✅ |

Scope: clean / drift noted: ...
Security: ✅ tenant scoping, ✅ zod, ⚠️ missing rate limit on X
```

- **PASS** → label `agent:done-review`; the PR is mergeable but nothing merges until a human says so. On that instruction an agent may perform the merge (`/graft-merge`), skipping any PR that fails a precondition and reporting it.
- **CHANGES REQUESTED** → back to Build Agent. Max **2 build↔review cycles**; on the 3rd disagreement → `ESCALATE` label, human arbitrates.
- Review Agent never pushes code. Separation of duties: the building agent and reviewing agent are never the same session/identity.

---

## 3. Queue Mechanics

- The queue is simply GitHub issues with `agent:queued`, ordered by `priority:P*` then age.
- Dependencies declared with `Depends-on: GRAFT-NN` in the issue body; the Build Agent skips issues with open dependencies.
- WIP limit: max 3 concurrent `agent:building` issues to keep merge conflicts low.
- Daily digest comment on a pinned "GRAFT Board" issue: queued/building/review/blocked counts + oldest blocked item.

## 4. Release Flow (`type:release`)

- `GRAFT-NN-release/vX.Y.Z` issue is drafted by the Drafting Agent: collects issues merged into `develop` since the last tag, generates changelog grouped by type, lists migration steps.
- Build Agent bumps version and updates CHANGELOG.md on `develop`, then opens the `develop` → `main` PR. A human merges and tags.
- Releases always require human sign-off; agents never deploy to production.

## 5. Guardrails Summary (non-negotiable)

1. Humans gate: queue entry, contract amendments, merge authorisation, releases, protected paths. Merging is *execution* — once a human says "merge it", an agent performs the merge under `merge_policy` in `.github/agent-policy.yml`, which still requires green CI and a PASS review from an agent that didn't write the code. Agents never merge unasked.
2. Agents never modify CI/security config, billing webhooks, or auth core without human co-review.
3. Every PR maps 1:1 to one issue; no drive-by changes.
4. All agent actions are comments/commits in GitHub — fully auditable, no side channels.
5. When uncertain: block and ask. A blocked issue is cheap; wrong scope is expensive.

## 6. Bootstrap Checklist

- [ ] `.github/ISSUE_TEMPLATE/contract.md` (template above)
- [ ] `.github/agent-policy.yml` (protected paths, WIP limit, diff limit)
- [ ] Labels created (`type:*`, `agent:*`, `priority:*`, `area:*`)
- [ ] Branch protection: CI green + 1 human review required on `develop` and `main`; no force-push, no deletion
- [ ] Bruno CI job wired (see BACKEND.md §7.3)
- [ ] Pinned "GRAFT Board" issue for digests
- [ ] First drafted issue: `GRAFT-01-feature/auth-and-tenant-bootstrap`

## 7. Open Questions

- Which agent runtime (Claude Code in GH Actions, scheduled workers, or manual invocation to start)?
- Should the Review Agent also run an automated dependency/license check, or leave to CI?
- Sub-issue numbering (`GRAFT-NN.1`) vs separate sequential IDs?
