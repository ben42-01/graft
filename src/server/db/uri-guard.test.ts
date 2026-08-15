import { describe, expect, it } from "vitest";
import { assertDestructiveTargetIsLocal, hostsFromUri } from "./uri-guard";

const local = "mongodb://graft_app:pw@localhost:27017/graft_dev?authSource=graft_dev";

describe("hostsFromUri", () => {
  it("strips credentials and port", () => {
    expect(hostsFromUri(local)).toEqual(["localhost"]);
  });

  it("handles replica set host lists", () => {
    expect(hostsFromUri("mongodb://a.example:27017,b.example:27018/db")).toEqual([
      "a.example",
      "b.example",
    ]);
  });

  it("returns nothing for a non-mongo URI", () => {
    expect(hostsFromUri("postgres://localhost/db")).toEqual([]);
  });
});

describe("assertDestructiveTargetIsLocal", () => {
  it("allows the local docker stack", () => {
    expect(assertDestructiveTargetIsLocal(local, "development")).toEqual({ safe: true });
  });

  it("allows the qa stack on its own port", () => {
    const qa = "mongodb://graft_app:pw@localhost:27018/graft_qa?authSource=graft_qa";
    expect(assertDestructiveTargetIsLocal(qa, "test")).toEqual({ safe: true });
  });

  // The tests that actually matter — GO-LIVE.md §2 requires this verified.
  it("refuses Atlas hosts", () => {
    const atlas = "mongodb://u:p@graft-prod-shard-00-01.ab12c.mongodb.net:27017/graft";
    const result = assertDestructiveTargetIsLocal(atlas, "development");
    expect(result.safe).toBe(false);
  });

  it("refuses any mongodb+srv URI outright", () => {
    const srv = "mongodb+srv://u:p@cluster.ab12c.mongodb.net/graft";
    expect(assertDestructiveTargetIsLocal(srv, "development").safe).toBe(false);
  });

  it("refuses when NODE_ENV is production even for a local host", () => {
    expect(assertDestructiveTargetIsLocal(local, "production").safe).toBe(false);
  });

  it("refuses a replica set where only one member is remote", () => {
    const mixed = "mongodb://u:p@localhost:27017,prod.mongodb.net:27017/graft";
    expect(assertDestructiveTargetIsLocal(mixed, "development").safe).toBe(false);
  });

  it("refuses an unset or unparseable URI", () => {
    expect(assertDestructiveTargetIsLocal(undefined, "development").safe).toBe(false);
    expect(assertDestructiveTargetIsLocal("not-a-uri", "development").safe).toBe(false);
  });
});
