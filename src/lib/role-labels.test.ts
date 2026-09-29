import { describe, expect, it } from "vitest";
import { roleLabel, roleLabels } from "./role-labels";

describe("role labels", () => {
  it("maps owner, admin and member, and shows admin as Manager (AC7)", () => {
    expect(roleLabel("owner")).toBe("Owner");
    expect(roleLabel("admin")).toBe("Manager");
    expect(roleLabel("member")).toBe("Member");
  });

  it("never lets the word admin through, even for an unknown role", () => {
    expect(roleLabel("something-else")).toBe("Member");
    for (const role of ["owner", "admin", "member", "x"]) {
      expect(roleLabel(role).toLowerCase()).not.toContain("admin");
    }
  });

  it("joins several roles and defaults an empty list to Member", () => {
    expect(roleLabels(["admin", "member"])).toBe("Manager, Member");
    expect(roleLabels([])).toBe("Member");
  });
});
