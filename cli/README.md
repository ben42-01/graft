# graft — Graft from the terminal

Sign in with your browser, then work with your workspace: records, forms,
orders, inventory, reports. Anything the web app can do through the API, the
CLI can do. It also gives scripts and AI assistants (the Graft skill) a safe,
signed-in way in.

```bash
npm install -g @graft/cli          # Node 20+; no other dependencies
graft login --url https://your-graft-host
graft whoami
```

## Signing in

`graft login` shows a one-time code and opens `<your-graft-host>/device`. Type
the code in a browser where you're signed in to Graft, check the machine name,
and approve. The terminal is signed in within a few seconds. The CLI never
sees your password.

- **On a server over ssh?** It won't try to open a browser. Open the link on
  any device, such as your phone.
- **Several workspaces?** You pick one when approving. Switch later with
  `graft workspace use <slug>`.
- **Several Graft servers** (QA and production)? Use `--profile qa` (or
  `GRAFT_PROFILE=qa`) to keep a separate sign-in for each.
- `graft logout` ends the session on the server, not only on this machine.

Only approve a code that **you** just started. Never approve one someone sent
you.

## Using it

```bash
graft help                                     # areas and flags
graft orders --help                            # every orders command
graft describe entities records create         # endpoint, arguments, real examples

graft entities list
graft entities records list <entityId> --all   # every page
graft entities records create <entityId> --set name="Ada" --set email=ada@example.com
graft orders get <orderId>
graft orders transitions <orderId> -d '{"to":"confirmed"}'
graft forms publish <formId>
graft reports summary get

graft api GET /api/v1/reports/usage -q meter=records   # any endpoint, directly
graft commands                                 # the full list with endpoints
```

| Flag | |
|---|---|
| `-d, --data` | Request body: inline JSON, `@file.json`, or `-` for stdin |
| `--set key=value` | One body field; repeatable, dotted keys nest, JSON values parse (`--set qty=3`) |
| `-q, --query key=value` | Query parameter; repeatable |
| `--all` | Follow pagination and return every item |
| `--json` | Print the API's `data` exactly, for `jq` and scripts |
| `-y, --yes` | Skip the confirmation every delete asks for (required without a terminal) |
| `--profile NAME` | Which saved server and sign-in to use |

**Exit codes:** 0 ok · 1 request refused · 2 usage · 3 not signed in · 4
forbidden · 5 not found · 6 server or network error. Errors include the
request id: quote it to support.

## Where things are kept

`~/.config/graft/config.json` (or `$XDG_CONFIG_HOME/graft`, or
`$GRAFT_CONFIG_DIR`). The directory is mode 700 and the file 600. It holds each
profile's server URL and session. The 30-day refresh token rotates on use; a
lock file stops two `graft` processes rotating it at once (which the server
would treat as token theft and sign you out).

| Variable | |
|---|---|
| `GRAFT_URL` | Server URL, overriding the profile's |
| `GRAFT_PROFILE` | Default profile |
| `GRAFT_TOKEN` | An access token to use as-is (never refreshed), for one-off scripts |
| `GRAFT_NO_BROWSER` | Never try to open a browser |
| `NO_COLOR` | Plain output |

Personal API keys for CI and long-running automation are planned for v2.

## How the commands come about

The commands aren't hand-written. They're derived from the API catalogue
(`src/lib/admin/api-catalogue.json`, generated from the routes and the API
test suite by `npm run api:catalogue`), so a new endpoint becomes a new command
when the catalogue is regenerated:

```
GET    /orders                        → graft orders list
POST   /orders                        → graft orders create
GET    /orders/:orderId               → graft orders get <orderId>
GET    /entities/:entityId/records    → graft entities records list <entityId>
POST   /forms/:formId/publish         → graft forms publish <formId>
```

Platform-admin endpoints are never included.

## Developing

```bash
npm run cli -- whoami              # run from source (tsx)
npm run cli:build                  # → cli/dist, with the customer catalogue
npx vitest run cli                 # unit tests
```

Server side of the sign-in: `src/server/services/device-auth.ts`,
`bruno/cli-auth/`, docs/BACKEND.md §3.1.
