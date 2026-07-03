// tierless/compiler — the transform as an importable library (CommonJS).
//
// transform.cjs is compiled from transform.cts's `export = { compile, analyze, DEFAULT_RESOURCES }`
// (see src/transform.cts), so this is a pure passthrough to the auto-generated types/transform.d.cts
// — every signature here is the implementation's own, never hand-declared. `.d.cts` (not `.d.ts`)
// because `export =` is a CommonJS-only construct and this package is "type": "module".
import transform = require("./transform.cjs");
export = transform;
