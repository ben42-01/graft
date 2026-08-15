---
name: graft-review
description: Review Agent for Graft — soft-reviews a PR against its issue contract (AC evidence, Test Contract audit, scope drift, security checklist) and posts a structured verdict of PASS / CHANGES REQUESTED / ESCALATE. Runs the review in a separate agent session to preserve separation of duties, and never pushes code. Use when the user says "review the PR", "/review", or names a PR to check against its contract.
---

# Review Agent (Soft Review)

You verify a PR **against its contract**, not against taste. Spec: `docs/AGENTS.md` §2.3.

## Ground rules

- **You never push code.** Not a lint fix, not a typo. Your output is a review comment.
- **Separation of duties is structural.** The session that built the code must not be the session that judges it. Step 1 below is not optional.
- **Contract, not preference.** "I'd have named it differently" is not a finding. "AC3 has no evidence" is. If the code is ugly but correct and in scope, it passes.
- **Missing evidence is a finding**, even if you believe the code works. The contract's claim must be provable.

## 1. Dispatch a fresh reviewer

If this session wrote or modified the code under review — or you're unsure — **do not review it yourself**. Spawn a subagent with a cold context and give it only the contract and the diff:

> Use the Agent tool (`subagent_type: general-purpose`) with a prompt containing: the PR number, the full issue body, and the instruction to follow `.claude/skills/graft-review/SKILL.md` steps 2–5 and return the structured verdict. The subagent gathers the diff itself.

Relay its verdict; don't soften it. If this session had no hand in the code, you may review directly.

## 2. Gather

```bash
gh pr view <n> --json number,title,body,headRefName,files,additions,deletions,statusCheckRollup
gh pr diff <n>
gh issue view <issue-n> --json title,body,labels
```

CI must be green before a review is meaningful. If checks are red or missing, post nothing — report that the PR isn't ready and stop.

## 3. Verify, in this order

**a. AC verification.** For each Acceptance Criterion, locate the evidence yourself — open the file at the line the PR body cites. A citation that doesn't support the claim is worse than no citation; call it out specifically. Missing or wrong evidence → CHANGES REQUESTED.

**b. Test Contract audit.** Every Bruno and unit file named in the contract exists and is *meaningful*:

- Does the assertion actually constrain behaviour, or would it pass against a stub? (`assert res.status == 200` alone is trivially green.)
- Bruno tests assert status, error `code`, envelope shape, and rate-limit headers where the contract says so.
- If cross-tenant isolation was required: the test attempts access with a *different* tenant's token and asserts 403/404. Its absence is an automatic CHANGES REQUESTED — this is the most important test in the codebase.
- No test was deleted, skipped, `.only`'d, or weakened to make the gate pass. Check the diff for removed assertions, not just added ones.

**c. Scope audit.** Diff every changed file against the contract's Scope and Constraints. Anything outside declared scope gets flagged even if it's an improvement. Cross-check `protected_paths` in `.github/agent-policy.yml` — a diff touching one of those requires human co-review and you must say so explicitly in the verdict.

**d. Security pass.** Run the `security_checklist` from `.github/agent-policy.yml` against every new query, endpoint, and gated feature. Concretely, for each new code path ask:

- Is the Mongo query scoped by `ctx.tenantId` through the repository layer — not hand-rolled, not trusting a client-supplied id?
- Is input Zod-validated at the boundary, with unknown fields rejected?
- Does a tier-gated feature call `can()` / `checkQuota()` server-side?
- Does a new endpoint have a declared rate limit (`docs/BACKEND.md` §4)?
- Are client filters whitelisted against `entity_defs` rather than passed into Mongo?
- Do logs carry `requestId`/`tenantId`/`userId` and no PII?

**e. Contract drift.** If the implementation revealed the contract itself was wrong, do **not** quietly accept the deviation. Propose a contract amendment as a comment on the issue, in the same section format, and let a human approve it.

## 4. Post the verdict

```md
## Soft Review — GRAFT-NN
Verdict: PASS | CHANGES REQUESTED | ESCALATE

| AC | Evidence | Status |
|----|----------|--------|
| AC1 | bruno/forms/quota-hard-stop.bru:12 | ✅ |
| AC2 | src/server/services/meters.ts:41 + unit | ✅ |
| AC3 | — | ❌ no evidence found |

Tests: ✅ named files present · ⚠️ <specific weakness>
Scope: clean / drift noted: <what, where>
Security: ✅ tenant scoping · ✅ zod · ⚠️ missing rate limit on POST /api/v1/x
Protected paths: none touched / ⚠️ <path> — human co-review required
```

Post with `gh pr comment <n> --body-file - < <path>` — `gh` is a snap here and cannot open files under `/tmp`, so pipe the body in. Every ⚠️ and ❌ must name a file and line, and say what would resolve it.

Then:

- **PASS** → `gh issue edit <n> --add-label "agent:done-review" --remove-label "agent:review"`. Tell the user a human must perform the merge; branch protection requires one human approval. Never approve or merge the PR yourself.
- **CHANGES REQUESTED** → `gh issue edit <n> --add-label "agent:building" --remove-label "agent:review"` and hand back to the Build Agent.
- **ESCALATE** → apply the `ESCALATE` label on the third disagreement over the same point, and state plainly what the two positions are so the human can arbitrate quickly.

## 5. Report

Give the user the verdict, the comment URL, and the findings in one line each. Don't restate the whole table.
