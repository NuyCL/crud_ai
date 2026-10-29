// Builds dist/: index.js (ESM), index.min.js (ESM, minified), index.umd.js (global `FeatureFlags` and CommonJS) and
// the type declarations. `--size` prints the gzip size of the minified file and fails if it is over the target.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const TARGET_GZIP_BYTES = 5120;
const common = { entryPoints: ["src/index.ts"], bundle: true, target: "es2022", legalComments: "none", logLevel: "warning" };

rmSync("dist", { recursive: true, force: true });
await build({ ...common, format: "esm", outfile: "dist/index.js" });
await build({ ...common, format: "esm", minify: true, outfile: "dist/index.min.js" });
await build({ ...common, format: "iife", globalName: "FeatureFlags", minify: true, outfile: "dist/index.umd.js" });
// UMD without the AMD branch: a plain <script> gets `FeatureFlags`, require() gets the same object.
const iife = readFileSync("dist/index.umd.js", "utf8");
writeFileSync("dist/index.umd.js", `${iife}\nif(typeof module==="object"&&module.exports)module.exports=FeatureFlags;\n`);
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], { stdio: "inherit" });

const gzip = gzipSync(readFileSync("dist/index.min.js"), { level: 9 }).length;
const line = `dist/index.min.js: ${readFileSync("dist/index.min.js").length} bytes, ${gzip} bytes gzip (target < ${TARGET_GZIP_BYTES})`;
console.log(line);
if (process.argv.includes("--size") && gzip >= TARGET_GZIP_BYTES) {
  console.error("over the size target");
  process.exit(1);
}
