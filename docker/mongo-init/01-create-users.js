// Graft — least-privilege app user (docs/WORKFLOW.md §4.2)
//
// Runs once, as root, on first container start against MONGO_INITDB_DATABASE.
// Credentials come from the container environment — never hardcoded here, so this
// file is safe to commit.
//
// The app user gets readWrite on its own database and nothing else: no admin, no
// other DBs, no cluster privileges. The app never holds root credentials.

const dbName = db.getName();
const user = process.env.GRAFT_APP_USER;
const pwd = process.env.GRAFT_APP_PASSWORD;

if (!user || !pwd) {
  throw new Error(
    "GRAFT_APP_USER / GRAFT_APP_PASSWORD not set on the mongo container — run `npm run setup` to generate .env.dev",
  );
}

const existing = db.getUser(user);
if (existing) {
  print(`[graft] app user '${user}' already exists on '${dbName}' — skipping`);
} else {
  db.createUser({
    user,
    pwd,
    roles: [{ role: "readWrite", db: dbName }],
  });
  print(`[graft] created least-privilege app user '${user}' on '${dbName}'`);
}
