# Setting up the graft CLI

## Install

The CLI needs Node.js 20 or newer and has no other dependencies.

```bash
npm install -g @graft/cli        # once published
graft --version
```

Until the package is published, install it from a checkout of the Graft repo:

```bash
npm ci && npm run cli:build && npm install -g ./cli
```

## Sign in

```bash
graft login --url https://<your Graft host>
```

The terminal shows a one-time code and opens `<host>/device`. In a browser
where you're signed in to Graft, type the code, check the machine name, pick
the workspace and approve. The terminal finishes within a few seconds. Only
approve a code you started yourself.

In Claude Code, run it as `! graft login --url …` so the code shows up in the
conversation. The assistant can't approve it for you, and shouldn't.

- Over ssh, no browser opens. Open the link on any device, such as your phone.
- `graft whoami` shows who and where you are; `graft logout` ends the session
  on the server.

## Several Graft servers

Each `--profile` keeps its own server and sign-in:

```bash
graft login --profile qa --url https://qa.example
graft --profile qa orders list          # or GRAFT_PROFILE=qa
graft profiles
```

## Common problems

| Symptom | Cause | Fix |
|---|---|---|
| `Not signed in` (exit 3) | Never signed in, signed out, or the 30-day session ended | `graft login` |
| `Your session has expired or was revoked` | Logged out elsewhere, or the session was replaced | `graft login` |
| `No Graft URL for profile` | First run on this profile | `graft login --url …` |
| `error FORBIDDEN` (exit 4) | Your role can't do this (forms and team need owner or admin) | Ask the workspace owner |
| `QUOTA_EXCEEDED` / `FEATURE_NOT_AVAILABLE` | Plan limit or feature | See `guide/plans.md` |
| `RATE_LIMITED` | Too many requests (Free: 60/min per workspace) | Wait for `Retry-After`; use `--all` rather than many single calls |
| `GRAFT_READONLY is set` | A read-only helper tried to write | Expected; do the write in the main conversation |
| `fetch failed` (exit 6) | Server unreachable or wrong URL | Check `graft profiles`, then the URL in a browser |

Exit codes: 0 ok · 1 request refused · 2 usage · 3 not signed in · 4
forbidden · 5 not found · 6 server or network error.
