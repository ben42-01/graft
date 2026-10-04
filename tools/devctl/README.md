# devctl

A tiny, dependency-free process manager for the local dev stack (think "pm2 lite").
One terminal, one prompt: pick what to run, then stop / restart pieces without losing the rest.

```bash
npm run devctl                 # checkbox picker, then an interactive prompt
npm run devctl -- up           # app + stripe, no picker
npm run devctl -- fresh        # nuke local data, then app + stripe
npm run devctl -- app          # just the dev server (db + seed run first)
```

## Prompt commands

| command               | what it does                                           |
| --------------------- | ------------------------------------------------------ |
| `start <name…>`       | start services/tasks; their `needs` run first (once)   |
| `stop <name…\|all>`   | SIGTERM the whole process group, SIGKILL after 5s      |
| `restart <name…>`     | stop + start                                           |
| `status`              | table of everything and its state                      |
| `mute` / `unmute <n>` | hide / show one service's log lines                    |
| `up`, `fresh`         | presets (see `services.mjs`)                           |
| `quit` / Ctrl-C       | stop everything and exit (second Ctrl-C force-exits)   |

Tab completes commands and names. Logs from every process are interleaved with a coloured
`name │` prefix above the prompt.

## Adding something

Edit `services.mjs`: add `{ name, kind: "task" | "service", cmd, desc, needs?, pick?, default? }`.
Everything else (picker, prompt, completion, status) is driven from that list.

## Layout

- `index.mjs` — CLI: picker, prompt, commands, log printing
- `supervisor.mjs` — spawn / track / kill children (no UI)
- `services.mjs` — the catalogue and presets
- `scripts/stripe-webhook.sh` — Stripe listener (moved from the gitignored `.dev/start-webhook.sh`)

## Notes

- Tasks (`db`, `seed`) run once per session; `restart app` won't reseed. Run `start seed` to force it.
- `stripe` refuses to start if `STRIPE_WEBHOOK_SECRET` in `.env.dev` doesn't match the key's signing
  secret — you'll see that message under the `stripe │` prefix and its status will be `failed`.
- `nuke` and `reset` delete local data; only `nuke` is offered in the picker, unticked.
- Dev stack only. The `qa:*` flow is not wired in.
