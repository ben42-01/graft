#!/usr/bin/env node
// Copies the customer docs (the graft-doc Starlight site) into the skill's
// references/, so the skill answers from exactly what the docs site says.
//
//   node plugins/graft/scripts/sync-docs.mjs ../graft-doc     (npm run skill:sync-docs)
//
// Run it after the docs change and commit the result. Only customer-facing
// pages are copied: the user guide, concepts, API conventions and the
// generated API reference. Frontmatter becomes a plain heading; Starlight
// asides (:::note …) become blockquotes; links stay as they are.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const docsRepo = process.argv[2];
if (!docsRepo) {
  console.error("usage: sync-docs.mjs <path to the graft-doc repo>");
  process.exit(2);
}
const src = join(docsRepo, "src/content/docs");
const out = join(dirname(fileURLToPath(import.meta.url)), "../skills/graft/references");

// [source dir, target dir, files or null for all .md]
const SETS = [
  ["getting-started", ".", ["concepts.md", "what-is-graft.md"]],
  ["guide", "guide", null],
  ["developers", ".", ["conventions.md", "authentication.md", "public-forms.md"]],
  ["developers/api", "api", null],
];

function convert(text) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const front = match ? match[1] : "";
  const title = /^title:\s*"?(.*?)"?\s*$/m.exec(front)?.[1] ?? "";
  const description = /^description:\s*"?(.*?)"?\s*$/m.exec(front)?.[1] ?? "";
  let body = match ? text.slice(match[0].length) : text;
  body = body.replace(/^:::(\w+)\n([\s\S]*?)^:::\s*$/gm, (_, kind, inner) =>
    inner
      .trim()
      .split("\n")
      .map(
        (line, i) =>
          `> ${i === 0 ? `**${kind[0].toUpperCase()}${kind.slice(1)}:** ` : ""}${line}`,
      )
      .join("\n"),
  );
  return [`# ${title}`, description ? `\n_${description}_\n` : "", body.trim(), ""].join("\n");
}

for (const dir of ["guide", "api"]) rmSync(join(out, dir), { recursive: true, force: true });
let count = 0;
for (const [from, to, files] of SETS) {
  const names = files ?? readdirSync(join(src, from)).filter((f) => f.endsWith(".md"));
  mkdirSync(join(out, to), { recursive: true });
  for (const name of names) {
    writeFileSync(join(out, to, name), convert(readFileSync(join(src, from, name), "utf8")));
    count++;
  }
}
console.log(`[skill] synced ${count} pages from ${src} into ${out}`);
