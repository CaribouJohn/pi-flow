// Ambient shim: electrobun ships untyped .ts source (no bundled .d.ts) that
// imports `three` — an optional transitive dep for its experimental 3D view,
// unused by this shell. pi-flow hoists three@0.165.0 to the workspace root, so
// tsc resolves electrobun's import to three's untyped .js and reports an
// implicit-any (TS7016). Declaring the module `any` lets the dashboard
// typecheck pass without pulling in @types/three. (Hiss avoids this only
// because `three` isn't resolvable from its desktop package.) See slice #206.
declare module "three";
