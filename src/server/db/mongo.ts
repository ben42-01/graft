import { MongoClient, type Db } from "mongodb";
import { env } from "@/env";

/**
 * One cached MongoClient per process (docs/GO-LIVE.md §2 — serverless pooling).
 * Next.js dev reloads modules on every change, so the client is stashed on
 * globalThis to avoid leaking a connection pool per hot reload.
 */
declare global {
  var __graftMongo: { client: MongoClient; promise: Promise<MongoClient> } | undefined;
}

function dbNameFromUri(uri: string): string {
  const path = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/i.exec(uri)?.[1];
  return path ? decodeURIComponent(path) : "graft";
}

export function getMongoClient(): Promise<MongoClient> {
  const uri = env().MONGODB_URI;
  if (!globalThis.__graftMongo) {
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5_000,
    });
    globalThis.__graftMongo = { client, promise: client.connect() };
  }
  return globalThis.__graftMongo.promise;
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(dbNameFromUri(env().MONGODB_URI));
}
