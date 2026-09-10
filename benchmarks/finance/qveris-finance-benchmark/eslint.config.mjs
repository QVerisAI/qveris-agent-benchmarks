// Minimal flat config, deliberately import-free so `npx eslint` works without
// a local node_modules (the package itself has zero dependencies).
// Scope: catch dead/undefined code mechanically; style stays convention-based.
const nodeGlobals = Object.fromEntries(
  [
    "console",
    "process",
    "Buffer",
    "URL",
    "URLSearchParams",
    "fetch",
    "AbortController",
    "AbortSignal",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "setImmediate",
    "queueMicrotask",
    "structuredClone",
    "performance",
    "TextDecoder",
    "TextEncoder",
    "globalThis",
  ].map((name) => [name, "readonly"]),
);

export default [
  {
    files: ["**/*.mjs"],
    ignores: ["node_modules/**"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-self-assign": "error",
      "no-unsafe-negation": "error",
      "valid-typeof": "error",
      "use-isnan": "error",
      "no-fallthrough": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
