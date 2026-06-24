import js from "@eslint/js";
import globals from "globals";

// Correctness-focused, not style-focused: Stackmix's interpreter is deliberately
// written in a dense, single-line-per-opcode style, and reformatting it would hurt
// readability. ESLint here catches real mistakes (undefined names, accidental
// reassignations) and leaves the house style alone.
export default [
  {
    ignores: [
      "node_modules/**",
      "**/*.ts",
      "**/*.wat",
      "**/*.wasm",
      "**/*.csv",
      "test/test262/vendor/**", // fetched Test262 corpus (not ours to lint)
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2021,
        WebAssembly: "readonly",
        performance: "readonly",
      },
    },
    rules: {
      // unused locals are worth knowing about, but unused fn args (interpreter
      // op handlers, callbacks) are idiomatic here.
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
      // `while (true) { ... }` is the interpreter's main loop and the migration
      // oscillators — intentional.
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-cond-assign": ["error", "except-parens"],
    },
  },
];
