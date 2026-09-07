/**
 * Object storage — the S3-compatible bucket behind every upload
 * (docs/BACKEND.md §4 "uploads via signed URLs, not through the API", §5).
 *
 * Three things matter enough to call out:
 *
 *   - **Bytes never pass through the API.** The app mints a short-lived
 *     presigned PUT and the browser uploads straight to the bucket, then tells
 *     us it is done. A 1 MB JSON body limit (rate-limit/policy.ts) is a
 *     deliberate ceiling, not an oversight, and proxying a 5 MB photo through
 *     a route handler would mean raising it for every endpoint at once.
 *   - **The bucket is private in every environment.** Reads are served by
 *     redirecting to a presigned GET, so "public" is a decision the
 *     application makes per object (a published form's carousel) rather than a
 *     bucket ACL nobody re-reads. MinIO locally and in QA, any S3-compatible
 *     endpoint in production — same code path, so a signed-URL bug cannot be a
 *     production-only surprise.
 *   - **Env is validated here, not in src/env.ts.** Same reasoning as
 *     billing.ts: those variables gate every route in the app, and a missing
 *     bucket must only ever break media, never the rest of the product.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { AppError } from "@/server/http/envelope";
import { createLogger } from "@/server/log";

const storageEnvSchema = z.object({
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  /**
   * MinIO addresses buckets by path (`endpoint/bucket/key`); real S3 prefers
   * the virtual-host style (`bucket.endpoint/key`). Defaults to path style
   * because that is what dev and QA run, so the local stack works with no
   * variable set at all.
   */
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type StorageEnv = z.infer<typeof storageEnvSchema>;

let cachedEnv: StorageEnv | null = null;

export function storageEnv(): StorageEnv {
  if (cachedEnv) return cachedEnv;
  const parsed = storageEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    createLogger({ requestId: "storage.env" }).error("storage.env.invalid", {
      missing: parsed.error.issues.map((i) => i.path.join(".")),
    });
    throw new AppError("INTERNAL", "File storage is not configured");
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

/** Test seam — `storageEnv` caches, and a test that changes env needs a reset. */
export function resetStorageEnv(): void {
  cachedEnv = null;
  globalThis.__graftS3 = undefined;
}

declare global {
  var __graftS3: S3Client | undefined;
}

/**
 * One cached client per process, stashed on globalThis for the same reason
 * mongo.ts does it: Next.js dev reloads modules on every change, and a client
 * per hot reload leaks sockets.
 */
export function s3(): S3Client {
  if (globalThis.__graftS3) return globalThis.__graftS3;
  const config = storageEnv();
  globalThis.__graftS3 = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    },
  });
  return globalThis.__graftS3;
}

/** Long enough for a slow mobile upload, short enough that a leaked URL rots. */
export const UPLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * Read URLs outlive upload URLs because a form page hands them to a browser
 * that may sit open, and to an OG scraper that fetches minutes later. Still
 * finite: an object is never reachable without the app agreeing to it again.
 */
export const READ_URL_TTL_SECONDS = 60 * 60;

/** The storage port. Everything above it talks in keys, never in SDK commands. */
export type ObjectStore = {
  presignPut(key: string, contentType: string): Promise<string>;
  presignGet(key: string): Promise<string>;
  /** `null` when the object is absent — an upload that never happened. */
  head(key: string): Promise<{ sizeBytes: number; contentType: string | null } | null>;
  remove(key: string): Promise<void>;
};

const isNotFound = (error: unknown): boolean => {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  return status === 404 || (error as { name?: string })?.name === "NotFound";
};

export function s3ObjectStore(): ObjectStore {
  const bucket = () => storageEnv().S3_BUCKET;

  return {
    async presignPut(key, contentType) {
      return getSignedUrl(
        s3(),
        // ContentType is part of the signature: the browser must send exactly
        // this header, so a signed URL for a JPEG cannot be spent on an HTML
        // file that the bucket would then serve back to a visitor.
        new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
        { expiresIn: UPLOAD_URL_TTL_SECONDS },
      );
    },

    async presignGet(key) {
      return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
        expiresIn: READ_URL_TTL_SECONDS,
      });
    },

    async head(key) {
      try {
        const result = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
        return {
          sizeBytes: result.ContentLength ?? 0,
          contentType: result.ContentType ?? null,
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async remove(key) {
      await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
    },
  };
}
