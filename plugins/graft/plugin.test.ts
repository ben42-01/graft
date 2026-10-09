import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = __dirname;
const read = (p: string) => readFileSync(join(root, p), "utf8");
const frontmatter = (text: string) => /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";

describe("graft plugin", () => {
  it("the reader agent carries exactly the reader brief", () => {
    const agent = read("agents/graft-reader.md").replace(/^---\n[\s\S]*?\n---\n\n/, "");
    const brief = read("skills/graft/references/reader-brief.md").replace(/^# .*\n\n/, "");
    expect(agent).toBe(brief);
  });

  it("the reader agent runs on the small model with no write tools", () => {
    const fm = frontmatter(read("agents/graft-reader.md"));
    expect(fm).toMatch(/^model: haiku$/m);
    expect(fm).toMatch(/^tools: Bash, Read, Grep, Glob$/m);
  });

  it("every reference SKILL.md points at exists", () => {
    const skill = read("skills/graft/SKILL.md");
    const named = [...skill.matchAll(/`((?:guide|api)\/[a-z-]+\.md|[a-z-]+\.md)`/g)].map(
      (m) => m[1],
    );
    for (const ref of new Set(named)) {
      if (ref === "SKILL.md" || ref.includes("<")) continue;
      expect(() => read(`skills/graft/references/${ref}`), ref).not.toThrow();
    }
  });

  it("the skill frontmatter names the skill and stays within limits", () => {
    const fm = frontmatter(read("skills/graft/SKILL.md"));
    expect(fm).toMatch(/^name: graft$/m);
    const description = /^description: (.*)$/m.exec(fm)?.[1] ?? "";
    expect(description.length).toBeGreaterThan(100);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it("manifests are valid and agree on the name", () => {
    const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
    const market = JSON.parse(
      readFileSync(join(root, "../../.claude-plugin/marketplace.json"), "utf8"),
    );
    expect(plugin.name).toBe("graft");
    expect(market.plugins[0]).toMatchObject({ name: "graft", source: "./plugins/graft" });
  });
});
