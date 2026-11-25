# OpenCascade.js for PointerCAD

This package contains the closed OpenCascade.js 2.0.0-beta.b5ff984 build for
PointerCAD. OCCT is 7.6.2 and Emscripten is 3.1.14. The IGES reader and writer
add four registrations to the previous 244. The package name, npm version,
entry points and licence are inherited from the preceding closed package.

The final JavaScript already contains the PointerCAD CSP changes. The
three generated files in `dist/` and the uncompressed Wasm identity are
recorded in `materialization.json`.

See [the native build and corresponding source](../iges-build/WINDOWS.md).
