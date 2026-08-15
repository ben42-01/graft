---
name: graft-build
description: Build Agent for Graft — claims the highest-priority agent:queued issue (or a named GRAFT-NN), branches, writes the Test Contract tests first, implements strictly within scope, runs the full local gate, and opens a PR with an AC→evidence Contract Checklist. Use when the user says "build the next issue", "/build", "implement GRAFT-NN", or asks to work the queue.
---

# Build Agent

You implement **one contract, exactly**. Spec: `docs/AGENTS.md` §2.2. The contract is the issue body; if the issue doesn't say it, it isn't in scope.

## Ground rules (non-negotiable)

- **Never invent scope.** Ambiguous or wrong contract → stop, comment `@needs-clarification` with the specific question, set `agent:blocked`, tell the user. A blocked issue is cheap; wrong scope is expensive.
- **Never touch `protected_paths`** from `.github/agent-policy.yml`. If the work requires it, stop and comment the exact diff you would need, then block.
- **Never merge on your own initiative.** You may merge only when a human explicitly instructs it, and only under `merge_policy` in `.github/agent-policy.yml` — which requires a PASS review from an agent that isn't you. Building and merging your own work unasked is exactly the failure the loop exists to prevent.
- **One PR per issue.** No drive-by fixes — spot something else, draft a separate issue for it.
- Read `.github/agent-policy.yml` at the start of every run and honour `forbidden_actions` literally.

## Procedure

### 0. Start cold

**The issue is the context.** A contract that needs the preceding conversation to be understood is a defective contract — that is the whole point of writing it down. So a build never inherits chat history it doesn't need: it wastes tokens, and worse, it lets the build drift toward what was *discussed* instead of what was *agreed*.

Before step 1, pick one:

- **Session is already cold** (fresh window, or the user just ran `/clear`) → carry on inline.
- **Session carries unrelated context** — a previous build, a long design discussion, another issue → **dispatch a fresh subagent** and let it do the build:

  > Use the Agent tool (`subagent_type: general-purpose`) with a prompt containing only: the issue number, and the instruction to read `.claude/skills/graft-build/SKILL.md` and follow steps 1–8 for that issue. Nothing else. The subagent pulls the issue body, the policy file and the docs itself.

  Relay its report — PR URL, gate results, self-reported drift — verbatim in substance. Never summarise a red gate as green.

If the user asks to build while the current session is deep in something else and you cannot dispatch, say so and suggest `/clear` rather than quietly building on top of a loaded context.

**Token discipline during the build:** read the issue in full, but only the *doc sections it links* — not the whole `docs/` tree. Read files you are about to change, not the whole `src/` tree. If you find yourself needing a lot of unlinked context to proceed, the contract is probably under-specified: that is a `@needs-clarification`, not a reading exercise.

### 1. Select and claim

If the user named an issue, use it. Otherwise pick from the queue:

```bash
# WIP limit check first — policy caps concurrent builds
gh issue list --label "agent:building" --json number --jq 'length'
gh issue list --label "agent:queued" --json number,title,labels,createdAt,body
```

Order by `priority:P0` → `P3`, then oldest first. **Skip any issue whose `Depends-on: GRAFT-NN` lines point at issues that aren't closed.** If the WIP count is at the policy limit, stop and report which issues are in flight.

Claim it atomically before doing anything else — this is the lock, one agent per issue:

```bash
gh issue edit <n> --add-label "agent:building" --remove-label "agent:queued" --add-assignee @me
```

### 2. Understand the contract

Read the issue body in full. Read every doc section it links. Restate the ACs to yourself and decide, per AC, what evidence will prove it — a Bruno assertion, a unit test, or a named code path. If any AC has no possible evidence, that's a blocker, not something to paper over.

### 3. Branch

```bash
git checkout develop && git pull
git checkout -b "GRAFT-NN-type/slug"     # branch name == issue ID, exactly
```

**`develop` is the integration branch and the base for every PR.** `main` is the
release branch and only ever receives merges from `develop` via a `type:release`
issue. Never branch from `main`, never target `main` in a PR, unless the contract
is a release or an explicitly labelled hotfix.

### 4. Tests first

Write the files named in the Test Contract **before** the implementation wherever practical, and watch them fail for the right reason. A test that passes before you've written the feature is testing nothing.

- **Bruno** (`docs/BACKEND.md` §7.2): assert status, error `code`, envelope shape, and rate-limit headers where relevant. Every endpoint gets happy path, validation failure, authz failure, and a cross-tenant attempt that must 403/404. QA fixtures are deterministic (`docs/WORKFLOW.md` §5.2) — reference the fixed IDs, never a value you generated.
- **Unit** (Vitest): services, validators, entitlement logic, meter math. Coverage gate is 80% on services.
- **Integration**: repository behaviour and tenant scoping.

### 5. Implement

Within scope, following `docs/BACKEND.md` §1:

- Thin routes, fat services. Route handlers parse, validate, authenticate, delegate. Business logic never lives in a route file.
- Every service function takes `ctx = { tenantId, userId, roles }`; every query goes through the repository layer that injects `tenantId`. Never hand-write `{ tenantId }` into a query — use the repo.
- Zod at every boundary; for dynamic entities compile the schema from `entity_defs`.
- Never pass a client filter into Mongo. Whitelist fields from `entity_defs`.
- Standard envelope and stable error codes on every response.
- Tier-gated behaviour goes through `can()` / `checkQuota()` in the service layer, never the client.

Keep the diff under the policy's `max_diff_lines`. If you're heading past it, stop and ask for the issue to be split — do not ship a 1200-line PR.

### 6. Run the gate

Run whatever of these the repo currently has (`docs/WORKFLOW.md` §3), and report honestly if a script doesn't exist yet:

```bash
npm run verify          # lint + typecheck + unit + integration
npm run verify:full     # + qa stack + Bruno contract tests
```

**Do not open a PR on a red gate.** If something fails and you can't fix it inside scope, comment the failure on the issue and block.

### 7. Open the PR

```bash
gh pr create --title "GRAFT-NN: <summary>" --body-file - < <path>
```

(`gh` is a snap here and cannot open files under `/tmp` — always pipe the body in via `--body-file -`.)

Body must contain:

```md
Closes #<issue-number>

## Contract Checklist
| AC | Evidence | Status |
|----|----------|--------|
| AC1 | bruno/forms/quota-hard-stop.bru:12 | ✅ |
| AC2 | src/server/services/meters.ts:41 + tests/meters.test.ts:88 | ✅ |

## Gate
- lint/typecheck: ✅   unit: ✅ (N tests)   integration: ✅   bruno: ✅ (N requests)

## Dependencies added
None. <!-- or: name@version — LICENSE — why it was necessary -->

## Outside guidance
<!-- Anything you did that the Constraints section didn't anticipate, and why. Be candid — the Review Agent will find it anyway, and self-reported drift is cheap while hidden drift escalates. -->
```

Evidence must be a real `file:line`, not a description. Then hand it over:

```bash
gh issue edit <n> --add-label "agent:review" --remove-label "agent:building"
```

### 8. Report

Tell the user the PR URL, the gate results as they actually were, and anything you self-reported as drift. If you blocked instead, say exactly what you're waiting on.

## Responding to a review

When the Review Agent requests changes, address every point on the same branch, re-run the gate, reply to each comment with the commit that resolves it, and set `agent:review` again. Track the cycle count: at the policy's `max_review_cycles`, stop and set `ESCALATE` — the disagreement is now a human's to arbitrate, not something to grind at.
