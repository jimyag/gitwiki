import { expect, test } from "bun:test";
import { checkHealth } from "../src/lib/health";
import type { HealthPage } from "../src/lib/api";

const page = (id: string, file: string, body: string): HealthPage => ({ id, file, title: id, body, meta: { tags: [], draft: false, date: "", description: "" } });

test("health checks local GFM links and the same anchors as preview", () => {
  const target = page("guide", "guide/_index.md", "## 安装 **说明**\n\n## 安装 **说明**\n\nSetext heading\n---\n\n## $E=mc^2$\n");
  const source = page("guide/start", "guide/start.md", [
    "[ok](/guide#安装-说明)",
    "[duplicate](./_index.md#安装-说明-1)",
    "[setext](/guide#setext-heading)",
    "[missing](/gone)",
    "![missing](assets/missing.png)",
    "![exists](assets/diagram%20one.png)",
    "[attachment](assets/manual.pdf#page=2)",
    "[anchor](/guide#nope)",
    "[reference][ref]",
    "",
    "[ref]: /gone-reference",
    "`[example](/ignored)`",
    "```md", "[example](/ignored-too)", "```",
    "[web](https://external.invalid/missing)",
    "[mail](mailto:someone@example.com)",
    "[protocol](//external.invalid/missing)",
    "[bad encoding](/%ZZ)",
    "## Local", "[local](#local)",
    "Footnote[^one]", "", "[^one]: A footnote.",
    "", "[math](/guide#emc2)",
  ].join("\n"));
  const issues = checkHealth({ pages: [target, source], files: [target.file, source.file, "guide/assets/diagram one.png", "guide/assets/manual.pdf"] });
  expect(issues.map(i => [i.kind, i.line, i.target])).toEqual([
    ["page", 4, "/gone"], ["asset", 5, "assets/missing.png"], ["anchor", 8, "/guide#nope"],
    ["page", 9, "/gone-reference"], ["page", 19, "/%ZZ"],
  ]);
});

test("health checks replacement references and home links", () => {
  const home = page("_index", "_index.md", "## Home\n[home](/#home)\n![image](assets/a.png)");
  home.meta = { ...home.meta, deprecated: true, replaced_by: "gone" };
  expect(checkHealth({ pages: [home], files: ["_index.md", "assets/a.png"] }).map(i => i.kind)).toEqual(["replacement"]);
});
