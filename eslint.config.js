import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  {
    files: [
      "server/**/*.mjs",
      "tests/server/**/*.mjs",
      "workers/**/*.mjs",
      "tests/workers/**/*.mjs",
      "tests/fixtures/**/*.mjs",
      "tests/runtime/**/*.mjs",
      "scripts/**/*.mjs",
    ],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        process: "readonly",
        console: "readonly",
        AbortController: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        Response: "readonly",
        Headers: "readonly",
        Request: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        crypto: "readonly",
        structuredClone: "readonly",
        btoa: "readonly",
        atob: "readonly",
      },
    },
  },
);
