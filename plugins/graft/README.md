# Graft plugin for Claude

Puts Graft inside Claude: ask how something works, or ask about and change
your own workspace ("which form brought in the most bookings this month?",
"add Jane Murphy to Customers", "confirm order …").

| Part | |
|---|---|
| `skills/graft/` | The **graft** skill. It knows the Graft docs (`references/`) and works through the `graft` CLI |
| `agents/graft-reader.md` | A read-only helper on a small, cheap model (Haiku). The skill hands it bulky lookups, such as paging, counting and totalling, and keeps judgement and every change for itself |

## Install

1. Install and sign in to the CLI: see `skills/graft/references/setup.md`
   (`graft login --url https://<your Graft host>`).
2. In Claude Code:

   ```
   /plugin marketplace add ben42-01/graft
   /plugin install graft@graft
   ```

   Or, as a plain skill without the helper agent, copy `skills/graft` to
   `~/.claude/skills/graft`. The skill then starts a general-purpose helper on
   Haiku with the same brief, or does the work itself where subagents aren't
   available (claude.ai).

## How it stays safe

- It acts as **you**, through the browser sign-in, with your role's
  permissions and nothing more. Platform-admin endpoints don't exist in the CLI.
- The helper runs with `GRAFT_READONLY=1`, and the CLI refuses any request
  but GET. That's enforced, not just asked.
- Deletes, cancellations, money and bulk changes are confirmed with you
  first, then read back.

## Maintaining

- The docs in `skills/graft/references/` are copied from the docs site:
  `npm run skill:sync-docs -- ../graft-doc`, then commit.
- `agents/graft-reader.md` repeats `references/reader-brief.md` after its
  frontmatter; `plugins/graft/plugin.test.ts` fails if they drift.
- Commands come from the API catalogue through the CLI, so new endpoints need
  no skill change.
