/**
 * Idempotent bucket creation — the object-storage half of `create-indexes.ts`,
 * and run the same way in every environment (docs/BACKEND.md §4).
 *
 * Deliberately a script rather than a one-shot compose service: a container
 * that starts, does its job and exits confuses `docker compose up --wait`,
 * which is the flag every `npm run *:db` target relies on. It is also the only
 * shape that works for a managed bucket in production, where there is no
 * compose file at all.
 *
 *   npm run dev:seed    # runs this alongside wait-for-mongo and create-indexes
 */
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
  waitUntilBucketExists,
} from "@aws-sdk/client-s3";
import { requireEnv } from "./lib/db";

async function main() {
  const endpoint = requireEnv("S3_ENDPOINT");
  const bucket = requireEnv("S3_BUCKET");

  const client = new S3Client({
    endpoint,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    credentials: {
      accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
    },
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`[graft] bucket ${bucket} already exists at ${endpoint}`);
    return;
  } catch {
    // Absent, or not readable yet — either way, try to create it. A racing
    // second run gets BucketAlreadyOwnedByYou, handled below.
  }

  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    await waitUntilBucketExists({ client, maxWaitTime: 30 }, { Bucket: bucket });
    console.log(`[graft] bucket ${bucket} created at ${endpoint}`);
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") {
      console.log(`[graft] bucket ${bucket} already exists at ${endpoint}`);
      return;
    }
    console.error(`[graft] could not create bucket ${bucket} at ${endpoint}`);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
