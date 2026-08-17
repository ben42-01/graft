/**
 * Public form page — unit coverage (GRAFT-10). The database-backed lookup
 * itself (`findByPublicSlug`, `accounts.findTenantById`) is stubbed here; the
 * points worth proving without a database are the 404-collapse rule, the
 * badge/tier decision (AC5) and the OG metadata shape (AC4).
 */
import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import type { FormDoc } from "./forms";
import { buildFormOgMetadata, getPublicFormPage, shouldShowBadge } from "./public-form-page";

const TENANT_ID = new ObjectId("000000000000000000000001");

const form = (over: Partial<FormDoc> = {}): FormDoc & { _id: ObjectId } => ({
  _id: new ObjectId("000000000000000000000031"),
  tenantId: TENANT_ID,
  entityDefId: new ObjectId("000000000000000000000021"),
  name: "Contact",
  slug: "contact",
  publicSlug: "acme/contact",
  visibility: "public",
  published: true,
  enabled: true,
  killSwitchAt: null,
  killSwitchBy: null,
  fields: [{ key: "name", label: "Name", type: "text", required: true }],
  showBadge: true,
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

describe("shouldShowBadge", () => {
  it("AC5 — shows on Free", () => {
    expect(shouldShowBadge({ showBadge: true }, "free")).toBe(true);
  });

  it("AC5 — hides on Premium regardless of the stored flag", () => {
    expect(shouldShowBadge({ showBadge: true }, "premium")).toBe(false);
  });

  it("respects the stored flag when it's already false", () => {
    expect(shouldShowBadge({ showBadge: false }, "free")).toBe(false);
  });
});

describe("buildFormOgMetadata", () => {
  it("AC4 — names the form and the tenant in both title and description", () => {
    const meta = buildFormOgMetadata({ formName: "Contact", tenantName: "Acme" });
    expect(meta.title).toContain("Contact");
    expect(meta.title).toContain("Acme");
    expect(meta.description).toContain("Contact");
    expect(meta.description).toContain("Acme");
  });
});

describe("getPublicFormPage", () => {
  const tenant = {
    id: TENANT_ID.toHexString(),
    name: "Acme",
    slug: "acme",
    tier: "free" as const,
    limits: {} as never,
    branding: { logoUrl: "https://cdn.example.com/logo.png", primaryColor: "#1d4ed8" },
  };

  it("AC1 — returns page data for a published, enabled form", async () => {
    const page = await getPublicFormPage("acme", "contact", {
      findByPublicSlug: async () => form(),
      accounts: { findTenantById: async () => tenant } as never,
    });
    expect(page).toEqual({
      formName: "Contact",
      fields: form().fields,
      tenantName: "Acme",
      tenantSlug: "acme",
      formSlug: "contact",
      branding: tenant.branding,
      showBadge: true,
    });
  });

  it("AC1 — 404-collapses an unknown slug", async () => {
    const page = await getPublicFormPage("acme", "contact", {
      findByPublicSlug: async () => null,
      accounts: { findTenantById: async () => tenant } as never,
    });
    expect(page).toBeNull();
  });

  it("AC1 — 404-collapses an unpublished form", async () => {
    const page = await getPublicFormPage("acme", "contact", {
      findByPublicSlug: async () => form({ published: false }),
      accounts: { findTenantById: async () => tenant } as never,
    });
    expect(page).toBeNull();
  });

  it("AC1 — 404-collapses a killed form (enabled:false outranks published)", async () => {
    const page = await getPublicFormPage("acme", "contact", {
      findByPublicSlug: async () => form({ enabled: false }),
      accounts: { findTenantById: async () => tenant } as never,
    });
    expect(page).toBeNull();
  });

  it("404-collapses a malformed slug segment rather than reaching the database", async () => {
    let called = false;
    const page = await getPublicFormPage("Not Valid!", "contact", {
      findByPublicSlug: async () => {
        called = true;
        return form();
      },
      accounts: { findTenantById: async () => tenant } as never,
    });
    expect(page).toBeNull();
    expect(called).toBe(false);
  });

  it("falls back to no branding when the tenant never set any", async () => {
    const page = await getPublicFormPage("acme", "contact", {
      findByPublicSlug: async () => form(),
      accounts: { findTenantById: async () => ({ ...tenant, branding: null }) } as never,
    });
    expect(page?.branding).toEqual({ logoUrl: null, primaryColor: null });
  });
});
