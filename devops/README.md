# devops — running Graft outside an editor

One command, `devops/ops` (also `npm run ops --`), for everything between "the
code is merged" and "a customer says something is broken": installing a box,
deploying, watching, backing up, and looking into a customer's problem.

```bash
devops/ops help              # every command
devops/ops doctor            # what this machine has, lacks, or has wrong
devops/ops status qa         # one screen: app, containers, disk, backups, tunnel
devops/ops @pi status qa     # the same, on the Pi, over (Tailscale) ssh
```

Link it once to type `ops` anywhere: `ln -sf "$PWD/devops/ops" ~/.local/bin/ops`.

## Environments

| env | where | data | how it runs |
|---|---|---|---|
| `dev` | your checkout, `.env.dev` | `graft-dev` compose project, named volumes | `npm run dev` / devctl |
| `qa` local | your checkout, `.env.qa` | `graft-qa` compose, **no volumes** | `verify:full`. Throwaway by design |
| `qa` hosted | `/srv/graft/qa` | `graft-hosted-qa` compose, named volumes | systemd user unit `graft-app@qa` |
| `prod` | `/srv/graft/prod` | `graft-hosted-prod` compose, named volumes | systemd user unit `graft-app@prod` |

An environment is **hosted** when `$GRAFT_ROOT/<env>/shared/.env` exists
(`GRAFT_ROOT` defaults to `/srv/graft`). Otherwise `ops` uses the checkout it
lives in. Force the checkout with `GRAFT_MODE=local`.

Why a separate hosted stack: `docker/docker-compose.qa.yml` is the **test**
stack. It has no volumes, `qa:db:down` runs `down -v`, and `qa:seed` refuses a
database that already has data. That is right for Bruno and wrong for a box
people sign up on: after one reboot, `npm run qa:full` stops at the seed step.
`devops/compose/docker-compose.hosted.yml` is the persistent version. It has
named volumes and restart policies, binds every port to `127.0.0.1` (Docker
bypasses ufw), requires a Redis password, uses append-only Redis, and caps
container log size.

```
/srv/graft/<env>/
  repo/                          git clone that releases are cut from
  releases/20261009083941-f4d5acf/   one built copy per deploy (newest 4 kept)
  current -> releases/…          what graft-app@<env> runs
  shared/
    .env                         the env's secrets, mode 600, nowhere else
    keys/                        JWT keypair, Mongo replica-set keyfile
    stack/                       compose file + mongo init (refreshed each deploy)
    backups/                     ops backup output
    deploys.log                  one line per deploy / rollback
    audit.log                    one line per operator action, support lookups included
```

## A new box (Pi, VPS, spare laptop)

```bash
# 1. Prerequisites: git jq rsync openssl, node 22, docker + compose, tailscale
curl -fsSL <raw url of devops/install/bootstrap.sh> | bash      # or: devops/ops install
#    add the optional ones by name: ops install stripe cloudflared gh bruno
sudo tailscale up --ssh --operator=$USER       # --ssh is what makes `ops @box` work

# 2. Layout, keys and a generated env file
sudo mkdir -p /srv/graft && sudo chown $USER: /srv/graft
git clone https://github.com/ben42-01/graft.git ~/graft && ~/graft/devops/ops host init qa

# 3. Fill APP_URL, S3_ENDPOINT, Stripe, SMTP (the checker tells you what is missing)
~/graft/devops/ops env edit qa

# 4. Build, start the containers, migrate, install systemd units, start, health-check
~/graft/devops/ops deploy qa

# 5. Public URL
/srv/graft/qa/current/devops/ops tunnel qa up
ln -sf /srv/graft/qa/current/devops/ops ~/.local/bin/ops
```

`ops doctor` flags the Pi-specific traps: a Pi 4 CPU that can't run `mongo:7`,
a MinIO digest with no arm64 build, too little memory and swap for `next build`,
and systemd lingering being off (without it, the app stops when you log out of ssh).

### Moving the current Pi off the test stack

The Pi runs `npm run qa:full` from a clone today, on the throwaway stack. To
move it without losing what is in it:

```bash
cd ~/graft                                   # the existing clone
GRAFT_MODE=local devops/ops backup qa move   # dump graft_qa + the bucket from the old stack
devops/ops host init qa --from-env .env.qa --from-keys .keys
#   --from-env carries APP_URL, S3_ENDPOINT, Stripe and SMTP over (fresh DB passwords)
#   --from-keys keeps the JWT keypair, so nobody gets logged out
# stop the old app (Ctrl-C / kill the `next start` on :3100), then:
npm run qa:db:down                           # frees 3100 and the old containers. Its data is in the backup
devops/ops deploy qa
devops/ops restore qa "$PWD/.ops-backups/qa/<stamp>-move"
```

The hosted stack uses its own ports (Mongo 27118, Redis 6480, MinIO 9102/9103),
so the funnel on 3100 keeps working. The funnel for MinIO has to point at 9102
now: `ops tunnel qa up` re-points both.

## Deploying

```bash
ops deploy qa                  # origin/develop  (prod: origin/main)
ops deploy qa v1.2.0           # any branch, tag or sha
ops releases qa                # what is live, what was, the deploy log
ops rollback qa                # the release before the current one
```

A deploy builds a new release next to the live one: `git archive`, `npm ci`,
`next build`. It then brings the containers up, runs `wait-for-mongo`,
migrations, indexes and the bucket, installs the systemd units, swaps the
`current` symlink and restarts. If `/api/ready` does not answer within 120s, it
switches back to the previous release by itself. The live release is never
modified, and two deploys can't overlap (flock).

**Migrations run before the switch**, against the database the old release is
still serving, and `rollback` does not reverse them. Keep each migration
backward compatible: add in one release, remove in a later one.

## When something is wrong

| Symptom | Start with |
|---|---|
| "The site is down" | `ops status <env>`, then `ops logs <env> --since 15m --errors` |
| A customer quotes an error / request id | `ops support <env> request <requestId>` |
| "I can't log in" / "never got the email" | `ops support <env> user <email>` (verified? sessions?), then `ops logs <env> --since 1h \| grep mail` |
| "My data is gone" | `ops support <env> tenant <slug>`. Counts show soft-deleted rows separately |
| Payments / webhooks failing | `ops stripe <env> check`: key mode, endpoints vs APP_URL, price ids |
| Uploads / images broken on phones | `ops env check <env>` (S3_ENDPOINT must be public) and `ops tunnel <env> status` |
| A bad deploy | `ops rollback <env>` |
| Container unhealthy | `ops logs <env> mongo\|redis\|minio`, then `ops stack <env> restart <service>` |
| Disk filling | `ops status <env>`. Releases keep 4, backups keep 14, container logs are capped at 50MB |

## Customer support access

Rules, in order:

1. **Read-only by default.** `ops support <env> grant-readonly` creates
   `graft_support`, a Mongo user with the `read` role only, and puts its URI in
   the env file. Lookups and `ops shell <env> mongo` use it. Writing takes
   `--write` (the app user) or `--root`, and the second asks you to type the
   env name back.
2. **Every look is audited.** `shared/audit.log` gets who, when and what was
   asked (never the answer) for every lookup, shell, restore and deploy.
3. **Secrets never print.** Any field ending in hash, token, secret, password
   or apiKey is redacted, at any depth, even in `find`.
4. **Personal data stays in the terminal.** Lookups show emails and names
   because finding the person is the point. Don't paste them into tickets or
   chat. The request id is what you share.

```bash
ops support qa user ann@example.com            # account, memberships, verified, sessions, activity
ops support qa tenant fruits-veg4all           # also by id or owner email: billing, members, counts, orders
ops support qa find orders '{"tenantId":"6ac0…","status":"confirmed"}' --limit 5
ops support qa request 2be4bf1d-3283-…         # every log line + activity row for one request
ops support qa tenant acme --json | jq .counts # --json on any lookup, for scripts and the CLI to come
ops shell qa mongo                             # read-only mongosh
ops shell qa redis | minio | app               # redis-cli; mc with alias `local`; bash with env loaded
ops logs qa --tenant 6ac0… --since 2h          # one workspace's requests
```

For anything a support person does more than twice, the admin console
(`/admin`, platform admins via `npm run admin:grant`) is the better home, with
a UI, its own audit log and no shell access needed. These tools are for what it
does not cover yet.

## Backups

`ops backup <env>` writes a `mongodump` of the app database and a copy of the
media bucket (S3 API, so MinIO and real S3 work the same way) into
`shared/backups/<stamp>/`. The systemd timer runs it nightly at 03:15 and keeps
14. Labelled backups (`ops backup qa before-upgrade`) are never pruned.

**A backup on the same disk as the data is not a backup.** Set
`OPS_BACKUP_OFFSITE=user@host:/path` in the env file, and every backup is
rsynced there afterwards. Another tailnet machine works.

`ops restore <env> <stamp>` asks you to type the env name. It takes a
`pre-restore` backup first, stops the app, restores (renaming the database if
the backup came from another env), ensures indexes, and starts the app again.
**Rehearse a restore before you rely on one.**

## Scheduled jobs

`ops deploy` installs these as systemd user timers:

| Timer | What |
|---|---|
| `graft-backup@<env>.timer` | `ops backup <env>`, nightly |
| `graft-trials@<env>.timer` | `ops job <env> expire-trials`, hourly (GO-LIVE §4: needed a schedule) |

`systemctl --user list-timers` shows when each runs next.
`journalctl --user -u graft-backup@qa` shows how the last run went.

## Not built yet, and worth doing before prod

- **Alerting.** Nothing tells anyone that the box is down. Cheapest option: a
  free uptime checker (UptimeRobot, Better Stack) on `APP_URL/api/ready`, plus
  an `OnFailure=` email on the backup unit.
- **Error tracking** (Sentry or similar), with release = the deploy sha.
- **Off-box logs.** The journal rotates, and once the disk dies it's gone.
- **A migrator Mongo user** (GO-LIVE §1). Migrations run as the app user today.
- **`S3_PUBLIC_ENDPOINT`.** The app signs browser URLs with `S3_ENDPOINT`, so
  MinIO has to be public through its own funnel. A separate public signing
  endpoint would let MinIO stay private.
- **Cloudflare Tunnel** config for prod (own domain, subdomains). `ops install
  cloudflared` installs the binary; `ops tunnel` covers Tailscale only.
- **Deploys from CI** (merge to `main` → `ops @prod deploy prod`) once prod exists.

## Files

```
devops/
  ops                     entry point: parses @host, dispatches to cmd/
  lib/common.sh           env model, env-file parsing, confirmations, audit
  lib/support.ts          read-only lookups (user, tenant, find)
  lib/objects.ts          bucket ⇄ directory, for backup/restore
  cmd/*.sh                one file per command group
  compose/docker-compose.hosted.yml
  systemd/                graft-app@, graft-backup@ (+timer), graft-trials@ (+timer)
  install/bootstrap.sh    standalone machine installer (apt)
```
