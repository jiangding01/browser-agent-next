import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 不变量 169：库代码不读环境变量与文件，也不导入任何 Node 内建模块（任何运行时都能放）。
describe("packages/jev source boundary", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const sources = (readdirSync(dir, { recursive: true }) as string[]).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );
  const builtins = new Set(
    builtinModules.flatMap((name) => [name, "node:" + name, name.split("/")[0]!]),
  );

  function specifiers(source: string): string[] {
    const found: string[] = [];
    const patterns = [
      /\bfrom\s+["']([^"']+)["']/g,
      /\bimport\s+["']([^"']+)["']/g,
      /\bimport\(\s*["']([^"']+)["']\s*\)/g,
      /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) found.push(match[1]!);
    }
    return found;
  }

  it("scans every library source", () => {
    expect(sources).toEqual(
      expect.arrayContaining(["index.ts", "jevClient.ts", "jevDecisionProvider.ts", "jevRequest.ts"]),
    );
  });

  it("detects builtin imports in the forms it checks", () => {
    expect(
      specifiers('import { a } from "fs";\nimport "node:os";\nawait import("path");\nrequire("http");')
        .filter((specifier) => builtins.has(specifier)),
    ).toEqual(["fs", "node:os", "path", "http"]);
  });

  it.each(sources)("%s does not touch process or Node builtin modules", (file) => {
    const source = readFileSync(join(dir, file), "utf8");
    expect(source).not.toMatch(/\bprocess\b/);
    expect(source).not.toMatch(/\brequire\(/);
    expect(specifiers(source).filter((specifier) => builtins.has(specifier))).toEqual([]);
  });
});
