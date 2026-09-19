import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

function workspaceSource(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@browser-agent-next/core": workspaceSource("./packages/core/src/index.ts"),
      "@browser-agent-next/refs": workspaceSource("./packages/refs/src/index.ts"),
      "@browser-agent-next/policy": workspaceSource("./packages/policy/src/index.ts"),
      "@browser-agent-next/runtime": workspaceSource("./packages/runtime/src/index.ts"),
      "@browser-agent-next/eval": workspaceSource("./packages/eval/src/index.ts"),
      "@browser-agent-next/perception": workspaceSource("./packages/perception/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
  },
});
