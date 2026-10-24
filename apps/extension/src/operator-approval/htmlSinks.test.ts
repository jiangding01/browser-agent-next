import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 不变量 128：审批页的页面派生文本只能经 textContent 写入。
// 这里静态禁止审批页源码使用任何会解析 HTML 的写入接口。
const HTML_SINKS = [
  /\.innerHTML\b/,
  /\.outerHTML\b/,
  /\binsertAdjacentHTML\b/,
  /\bdocument\.write(?:ln)?\b/,
  /\bcreateContextualFragment\b/,
  /\bsetHTMLUnsafe\b/,
  /\bparseHTMLUnsafe\b/,
  /\bDOMParser\b/,
];

const directory = fileURLToPath(new URL(".", import.meta.url));

const sources = readdirSync(directory)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

describe("审批页不使用 HTML 解析写入接口", () => {
  it("扫描到审批页源码文件", () => {
    expect(sources).toContain("index.ts");
    expect(sources).toContain("display.ts");
  });

  it.each(sources)("%s 不包含 HTML sink", (name) => {
    const text = readFileSync(directory + name, "utf8");

    for (const sink of HTML_SINKS) {
      expect(text, name + " 使用了 " + sink.source).not.toMatch(sink);
    }
  });
});
