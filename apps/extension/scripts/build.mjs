import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const tsconfig = path.resolve(root, "../../tsconfig.json");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await Promise.all([
  build({
    entryPoints: [path.join(root, "src/content/index.ts")],
    outfile: path.join(dist, "content/index.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome106"],
    sourcemap: true,
    tsconfig,
  }),
  build({
    entryPoints: [path.join(root, "src/background/index.ts")],
    outfile: path.join(dist, "background/index.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome106"],
    sourcemap: true,
    tsconfig,
  }),
]);

await Promise.all([
  cp(
    path.join(root, "manifest.json"),
    path.join(dist, "manifest.json"),
  ),
  cp(
    path.join(root, "e2e-harness.html"),
    path.join(dist, "e2e-harness.html"),
  ),
]);
