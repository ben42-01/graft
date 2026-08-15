/**
 * Shared Mongo helpers for the script layer (seeds, indexes, migrations).
 *
 * Scripts get their env from dotenv-cli (`dotenv -e .env.dev -- tsx ...`), so
 * they read process.env directly and fail loudly when it is missing.
 */
import { MongoClient, type Db } from "mongodb";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `[graft] ${name} is not set — run scripts via npm (they load the right .env file)`,
    );
    process.exit(1);
  }
  return value;
}

export function dbNameFromUri(uri: string): string {
  const path = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/i.exec(uri)?.[1];
  return path ? decodeURIComponent(path) : "graft";
}

export async function connect(): Promise<{ client: MongoClient; db: Db; uri: string }> {
  const uri = requireEnv("MONGODB_URI");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  await client.connect();
  return { client, db: client.db(dbNameFromUri(uri)), uri };
}

/** Collections Graft owns (docs/Graft.md §4.2). */
export const COLLECTIONS = [
  "tenants",
  "users",
  "plugins_enabled",
  "entity_defs",
  "records",
  "forms",
  "form_submissions",
  "dashboards",
  "usage_meters",
  "audit_log",
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];
