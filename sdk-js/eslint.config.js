import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["dist/", "node_modules/"]),
  js.configs.recommended,
  tseslint.configs.strict,
  tseslint.configs.stylistic,
  {
    rules: {
      eqeqeq: ["error", "always"],
    },
  },
  {
    // the build script and the tests are plain Node modules
    files: ["build.mjs", "test/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", setTimeout: "readonly", clearTimeout: "readonly", fetch: "readonly", URL: "readonly", AbortController: "readonly", Response: "readonly", DOMException: "readonly" },
    },
  },
);
