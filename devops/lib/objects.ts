/**
 * Copies the media bucket to a directory and back — the object-storage half
 * of `ops backup` / `ops restore`.
 *
 *   tsx devops/lib/objects.ts backup  <dir>
 *   tsx devops/lib/objects.ts restore <dir>
 *
 * Talks the S3 API rather than tarring MinIO's volume, so the same code backs
 * up MinIO on a Pi and a real S3 bucket in production, and a backup can be
 * restored into either. `ops` points S3_ENDPOINT at the local container port
 * when it runs this, so a backup never depends on the public tunnel being up.
 *
 * <dir>/index.json records each key's content type; the bytes sit next to it
 * under <dir>/data/<key>.
 */
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { requireEnv } from "../../scripts/lib/db";

type IndexEntry = { key: string; size: number; contentType: string | null };

function client(): S3Client {
  return new S3Client({
    endpoint: requireEnv("S3_ENDPOINT"),
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true",
    credentials: {
      accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
    },
  });
}

/** A key must stay inside <dir>/data — refuse `..` tricks from a hostile key. */
function safePath(root: string, key: string): string {
  const path = resolve(root, key);
  if (!path.startsWith(root + "/")) throw new Error(`refusing unsafe key: ${key}`);
  return path;
}

async function backup(dir: string) {
  const s3 = client();
  const Bucket = requireEnv("S3_BUCKET");
  const dataRoot = resolve(dir, "data");
  await mkdir(dataRoot, { recursive: true });
  const index: IndexEntry[] = [];
  let ContinuationToken: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket, ContinuationToken }));
    for (const item of page.Contents ?? []) {
      if (!item.Key) continue;
      const object = await s3.send(new GetObjectCommand({ Bucket, Key: item.Key }));
      const target = safePath(dataRoot, item.Key);
      await mkdir(dirname(target), { recursive: true });
      await pipeline(object.Body as Readable, createWriteStream(target));
      index.push({
        key: item.Key,
        size: item.Size ?? 0,
        contentType: object.ContentType ?? null,
      });
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  await writeFile(
    join(dir, "index.json"),
    JSON.stringify({ bucket: Bucket, objects: index }, null, 1),
  );
  const bytes = index.reduce((sum, o) => sum + o.size, 0);
  console.log(`[ops] ${index.length} object(s), ${(bytes / 1e6).toFixed(1)} MB from ${Bucket}`);
}

async function restore(dir: string) {
  const s3 = client();
  const Bucket = requireEnv("S3_BUCKET");
  const indexFile = join(dir, "index.json");
  if (!existsSync(indexFile)) throw new Error(`${indexFile} not found`);
  const { objects } = JSON.parse(await readFile(indexFile, "utf8")) as {
    objects: IndexEntry[];
  };
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket }));
  }
  const dataRoot = resolve(dir, "data");
  for (const o of objects) {
    await s3.send(
      new PutObjectCommand({
        Bucket,
        Key: o.key,
        Body: createReadStream(safePath(dataRoot, o.key)),
        ContentLength: o.size,
        ContentType: o.contentType ?? undefined,
      }),
    );
  }
  console.log(`[ops] restored ${objects.length} object(s) into ${Bucket}`);
}

async function main() {
  const [command, dir] = process.argv.slice(2);
  if (!dir || (command !== "backup" && command !== "restore")) {
    console.error("usage: objects.ts backup|restore <dir>");
    process.exit(2);
  }
  await (command === "backup" ? backup(resolve(dir)) : restore(resolve(dir)));
}

main().catch((error) => {
  console.error(`[ops] objects: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
