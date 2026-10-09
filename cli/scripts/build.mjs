#!/usr/bin/env node
// Builds the publishable CLI into cli/dist: compiles src/ with tsc and ships the
// customer half of the API catalogue next to it. Platform-admin endpoints are
// dropped here, not only at runtime, so the package never describes them.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(cli, "..");
const dist = join(cli, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
execFileSync(join(repo, "node_modules", ".bin", "tsc"), ["-p", join(cli, "tsconfig.json")], {
  stdio: "inherit",
});

const catalogue = JSON.parse(
  readFileSync(join(repo, "src/lib/admin/api-catalogue.json"), "utf8"),
);
const endpoints = catalogue.endpoints.filter((e) => e.auth !== "platform-admin");
writeFileSync(join(dist, "catalogue.json"), JSON.stringify({ endpoints }) + "\n");
chmodSync(join(dist, "main.js"), 0o755);
console.log(`[graft-cli] built ${dist} — ${endpoints.length} endpoints in the catalogue`);
