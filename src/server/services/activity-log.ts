/**
 * The tenant activity log (GRAFT-29.1).
 *
 * One append-only row per thing that happened to a customer's account, so
 * support can answer "what did this customer do, what did we send them, and did
 * anything fail" from `/admin` (GRAFT-29.2 reads it, GRAFT-29.3 renders it,
 * GRAFT-29.4 wires the real call sites). Three properties are the whole reason
 * the collection is shaped this way:
 *
 *  - **Append-only.** The store exposes `append` and nothing else, exactly as
 *    `admin-audit.ts` does. There is no update path and no delete path, not
 *    because they are guarded but because they are not written.
 *  - **A closed taxonomy.** `action` must be a registered family + leaf from
 *    `ACTIVITY_REGISTRY` below. The read API filters by action, so an untyped
 *    row created by a typo would be a row that surface can never surface — the
 *    typo throws instead.
 *  - **PII lives in exactly one field.** `notify.email`'s `to` is the only
 *    address anywhere in this collection. Every other family's context schema
 *    names no free-text personal field at all, and an address that reaches one
 *    of them throws rather than being quietly dropped (see `assertNoStrayPii`).
 *
 * Unlike `admin_audit_log`, which is deliberately global, every row here
 * belongs to a tenant and `tenantId` is required — a tenant-less row is one the
 * read surface could never attribute. It is written directly rather than
 * through the ctx-injecting repository layer for the same reason the admin
 * audit log is: the writer is handed the tenant it is recording *about*, and
 * the reader is a platform admin who is deliberately outside any one tenant.
 */
import { ObjectId } from "mongodb";
import { z } from "zod";

import { getDb } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { TIERS } from "@/server/tiers";

export const ACTIVITIES_COLLECTION = "activities";

/** The row's entire shape. Anything not on this list does not get written. */
export const ACTIVITY_FIELDS = [
  "tenantId",
  "actorType",
  "actorId",
  "action",
  "ok",
  "requestId",
  "at",
  "context",
] as const;

/**
 * Who acted. `customer` is a user of the tenant, `admin` a platform admin
 * acting on it, `system` a scheduled job or webhook with no acting user at all
 * — which is why `actorId` is nullable.
 */
export const ACTOR_TYPES = ["customer", "system", "admin"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

const tier = z.enum(TIERS);

/**
 * The action taxonomy (GRAFT-29.1 AC2), binding on GRAFT-29.2/29.3/29.4.
 *
 * An `action` is `<family>.<leaf>`. Each family owns a Zod schema for its
 * `context`, and that schema is an allow-list in both directions: it names
 * every field that may be stored, and by omission it names every field that may
 * not be. Adding a field here is a deliberate act with a downstream cost, which
 * is the point — the alternative is a free-form blob that accumulates whatever
 * a call site happened to have in scope.
 */
export const ACTIVITY_REGISTRY = {
  "notify.email": {
    actions: ["sent", "failed"] as const,
    context: z.object({
      template: z.string().min(1),
      /**
       * The one field in this entire collection permitted to be personal data
       * (AC4). It is here because "what did we send them" is unanswerable
       * without it, and it is nowhere else for the same reason.
       */
      to: z.string().email(),
      messageId: z.string().optional(),
      /**
       * A code, never the provider's free-text error message: a bounce message
       * routinely quotes the recipient's address back, which is how an address
       * ends up in a field that is not `to` and was never reviewed as PII.
       */
      errorCode: z.string().optional(),
    }),
  },
  "billing.subscription": {
    actions: ["add", "cancel", "expire"] as const,
    context: z.object({
      fromTier: tier.optional(),
      toTier: tier.optional(),
      reason: z.string().optional(),
    }),
  },
  "billing.payment": {
    actions: ["succeeded", "failed", "refunded"] as const,
    context: z.object({
      amountCents: z.number().int(),
      currency: z.string().length(3),
      /**
       * Code, not message — same argument as `notify.email.errorCode`. The
       * taxonomy notes this is for `failed` rows; that is read here as call-site
       * guidance for GRAFT-29.4 rather than a validation rule, so a `refunded`
       * row that genuinely carries a code is not rejected by this schema.
       */
      failureCode: z.string().optional(),
    }),
  },
  account: {
    actions: [
      "signup",
      "login",
      "login_failed",
      "password_reset_requested",
      "password_reset_completed",
    ] as const,
    context: z.object({
      method: z.enum(["password", "oauth"]).optional(),
    }),
  },
  entity: {
    actions: ["created", "updated", "deleted"] as const,
    context: z.object({
      entityDefId: z.string().min(1),
      entityType: z.string().min(1),
      recordId: z.string().min(1),
    }),
  },
} as const;

export type ActivityFamily = keyof typeof ACTIVITY_REGISTRY;

/**
 * Context keys that are personal data wherever they appear. A family whose
 * schema does not name one of these may not receive it — and unlike an ordinary
 * unknown key, which Zod strips, this throws.
 *
 * The asymmetry is deliberate and is AC4. Stripping is right for a caller's
 * incidental noise; it is wrong for an address, because a silently dropped
 * address looks exactly like an address that was never passed, and the call
 * site keeps sending it. The loud failure is the point.
 */
export const PII_CONTEXT_KEYS = ["to", "email"] as const;

export type ActivityEntry = {
  /** The tenant the activity belongs to. Never null — see the header. */
  tenantId: string;
  actorType: ActorType;
  /** The acting user, or null for a system-fired action. Never a name. */
  actorId: string | null;
  /** A registered `<family>.<leaf>` from `ACTIVITY_REGISTRY`. */
  action: string;
  /** Whether the thing that happened succeeded. A failure is still activity. */
  ok: boolean;
  requestId: string;
  at: Date;
  /** Validated against the family's schema; nothing outside it is stored. */
  context: Record<string, unknown>;
};

/** What a caller supplies; `at` is stamped by the writer, not by the caller. */
export type ActivityInput = {
  tenantId: string;
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  ok: boolean;
  requestId: string;
  context?: Record<string, unknown>;
};

/**
 * The base envelope, validated before the family is consulted. Unknown
 * top-level keys are stripped by Zod here and then ignored again by the
 * field-by-field construction in `recordActivity` — the allow-list is what
 * makes AC1 a property of this function rather than a rule callers remember.
 */
const baseSchema = z.object({
  tenantId: z.string().min(1),
  actorType: z.enum(ACTOR_TYPES),
  actorId: z.string().min(1).nullish(),
  action: z.string().min(1),
  ok: z.boolean(),
  requestId: z.string().min(1),
});

/**
 * Split `<family>.<leaf>` at the last dot: families are themselves dotted
 * (`notify.email`, `billing.subscription`), so the leaf is always the final
 * segment and everything before it is the family.
 */
function resolveAction(action: string): { family: ActivityFamily; leaf: string } {
  const cut = action.lastIndexOf(".");
  const family = cut === -1 ? "" : action.slice(0, cut);
  const leaf = cut === -1 ? "" : action.slice(cut + 1);

  const def = (ACTIVITY_REGISTRY as Record<string, { actions: readonly string[] }>)[family];
  if (!def || !def.actions.includes(leaf)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Unregistered activity action '${action}'. Add it to ACTIVITY_REGISTRY before recording it.`,
    );
  }
  return { family: family as ActivityFamily, leaf };
}

/**
 * AC4 — reject an address that reached a family with no address field, before
 * Zod gets the chance to strip it quietly.
 */
function assertNoStrayPii(
  family: ActivityFamily,
  allowed: readonly string[],
  context: Record<string, unknown>,
): void {
  for (const key of PII_CONTEXT_KEYS) {
    if (key in context && !allowed.includes(key)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Activity family '${family}' may not carry '${key}': only notify.email records an address.`,
      );
    }
  }
}

export type ActivityStore = {
  append(entry: ActivityEntry): Promise<void>;
};

export type ActivityDeps = {
  activities: ActivityStore;
  now: () => Date;
};

/**
 * Ids are stored as ObjectIds, as everywhere else in the schema, so a row joins
 * to `tenants` and `users` without a cast when GRAFT-29.2 reads it. Context ids
 * (`entityDefId`, `recordId`) stay strings: they are validated facts about the
 * row, not join keys this collection resolves.
 */
export function mongoActivityStore(): ActivityStore {
  return {
    async append(entry) {
      const db = await getDb();
      await db.collection(ACTIVITIES_COLLECTION).insertOne({
        _id: new ObjectId(),
        tenantId: new ObjectId(entry.tenantId),
        actorType: entry.actorType,
        actorId: entry.actorId ? new ObjectId(entry.actorId) : null,
        action: entry.action,
        ok: entry.ok,
        requestId: entry.requestId,
        at: entry.at,
        context: entry.context,
      });
    },
  };
}

let defaultStore: ActivityStore | undefined;
const store = () => (defaultStore ??= mongoActivityStore());

/**
 * Append one row for one thing that happened.
 *
 * Order matters: the action is resolved and the context validated *before* the
 * store is touched, so a rejected call leaves nothing behind (AC2). The
 * document is then assembled field by field rather than spread from `input`,
 * which is what makes "no PII in the activity log" a property of this function
 * instead of a rule every future caller has to remember (AC1).
 *
 * A store failure propagates unchanged (AC7). Whether a failed activity write
 * should fail the parent operation is the caller's decision to make in
 * GRAFT-29.4, and swallowing it here would make that decision for them.
 */
export async function recordActivity(
  input: ActivityInput,
  deps: Partial<ActivityDeps> = {},
): Promise<ActivityEntry> {
  const base = baseSchema.parse(input);
  const { family } = resolveAction(base.action);
  const schema = ACTIVITY_REGISTRY[family].context;

  const rawContext = input.context ?? {};
  assertNoStrayPii(family, Object.keys(schema.shape), rawContext);
  // Zod strips anything the family schema does not name (AC3).
  const context = schema.parse(rawContext) as Record<string, unknown>;

  const entry: ActivityEntry = {
    tenantId: base.tenantId,
    actorType: base.actorType,
    actorId: base.actorId ?? null,
    action: base.action,
    ok: base.ok,
    requestId: base.requestId,
    at: (deps.now ?? (() => new Date()))(),
    context,
  };

  await (deps.activities ?? store()).append(entry);
  return entry;
}
