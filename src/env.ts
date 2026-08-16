import { z } from "zod";

/**
 * Server environment, validated once at the boundary (docs/BACKEND.md §1.3).
 * A missing or malformed variable fails loudly at startup rather than as a
 * confusing runtime error three layers deep.
 *
 * Server-only: never import this from a client component.
 */
export const schema = z.object({
  /**
   * No default (GRAFT-02.1 AC1). APP_ENV decides whether header-based identity is
   * accepted, so defaulting it to "dev" meant a deploy that forgot the variable
   * quietly became a development box. Every .env file sets it explicitly; a
   * missing one is now a startup failure rather than an open door.
   */
  APP_ENV: z.enum(["dev", "qa", "production"]),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MONGODB_URI: z.string().url().startsWith("mongodb"),
  REDIS_URL: z.string().url().startsWith("redis"),
  APP_URL: z.string().url().default("http://localhost:3000"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment:\n${issues}\n\nRun \`npm run setup\` to generate local env files.`,
    );
  }
  cached = parsed.data;
  return cached;
}
