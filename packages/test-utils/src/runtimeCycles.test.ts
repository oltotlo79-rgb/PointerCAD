import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatRuntimeCycleDiagnostics, inspectRuntimeCycles, isRuntimeProductSource } from '../../../scripts/lib/runtimeCycles.mjs';

const root = path.resolve('runtime-cycle-virtual-fixture');
const a = 'packages/demo/src/a.ts', b = 'packages/demo/src/b.ts', c = 'packages/demo/src/c.ts';
function inspect(entries: readonly (readonly [string, string])[]) {
  return inspectRuntimeCycles(root, new Map(entries));
}

describe('static runtime import cycle admission', () => {
  it('detects two-node relative .js imports as actual .ts sources', () => {
    const result = inspect([[a, "import { b } from './b.js'; export const a = b;"], [b, "import { a } from './a.js'; export const b = a;"]]);
    expect(result.edges).toEqual([[a, b], [b, a]]);
    expect(result.cycles).toEqual([[a, b]]); expect(result.ok).toBe(false);
  });
  it('detects a self import', () => {
    expect(inspect([[a, "import './a.js';"]]).cycles).toEqual([[a]]);
  });
  it.each(["export { b } from './b.js';", "export * from './b.js';", "export * as ns from './b.js';"])(
    'follows runtime reexports: %s', declaration => {
      const result = inspect([[a, declaration], [b, "import './a.js'; export const b = 1;"]]);
      expect(result.cycles).toEqual([[a, b]]);
    });
  it('excludes type-only imports/reexports, declarations and dynamic imports', () => {
    const result = inspect([[a, "import type { T } from './b.js'; import { type T as U } from './b.js'; export type { T } from './b.js'; export { type T as V } from './b.js'; export type * from './b.js'; void import('./b.js');"],
      [b, "import './a.js'; export interface T {}"], ['packages/demo/src/value.d.ts', "import './a.js';"]]);
    expect(result.edges).toEqual([[b, a]]); expect(result.cycles).toEqual([]); expect(result.ok).toBe(true);
  });
  it('includes side-effect imports and relative .tsx implementation files', () => {
    const tsx = 'packages/demo/src/b.tsx';
    expect(inspect([[a, "import './b.js';"], [tsx, "import './a.js';"]]).cycles).toEqual([[a, tsx]]);
  });
  it('uses actual tsconfig paths and workspace runtime exports rather than declaration outputs', () => {
    const target = 'packages/leaf/src/index.ts';
    const result = inspect([
      ['tsconfig.json', JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', baseUrl: '.', paths: { '@demo/*': ['packages/demo/src/*'] } } })],
      ['packages/leaf/package.json', JSON.stringify({ name: '@pointercad/leaf', exports: { '.': { types: './dist/index.d.ts', default: './src/index.ts' } } })],
      [a, "import '@pointercad/leaf';"], [target, "import '@demo/a';"],
    ]);
    expect(result.diagnostics).toEqual([]); expect(result.cycles).toEqual([[a, target]]);
  });
  it('rejects missing internal imports and unexported workspace subpaths without rejecting external libraries', () => {
    const result = inspect([[a, "import './missing.js'; import '@pointercad/leaf/private'; import 'external-library';"]]);
    expect(result.ok).toBe(false); expect(result.diagnostics).toHaveLength(2);
    expect(formatRuntimeCycleDiagnostics(result)).toContain('./missing.js');
    expect(formatRuntimeCycleDiagnostics(result)).toContain('@pointercad/leaf/private');
  });
  it('resolves real exported stylesheet assets without making them runtime code nodes', () => {
    const result = inspect([
      ['packages/leaf/package.json', JSON.stringify({ name: '@pointercad/leaf', exports: { './style.css': './style.css' } })],
      ['packages/leaf/style.css', 'body {}'], [a, "import '@pointercad/leaf/style.css';"],
    ]);
    expect(result.ok).toBe(true); expect(result.files).toEqual([a]); expect(result.edges).toEqual([]);
  });
  it('reports all SCCs and stable codepoint ordering regardless of inventory order', () => {
    const entries = [[a, "import './b.js';"], [b, "import './a.js';"], [c, "import './c.js';"]] satisfies readonly (readonly [string, string])[];
    const result = inspect(entries);
    expect(result.cycles).toEqual([[a, b], [c]]);
    expect(inspect([...entries].reverse())).toEqual(result);
    expect(formatRuntimeCycleDiagnostics(result)).toBe(formatRuntimeCycleDiagnostics(inspect([...entries].reverse())));
  });
  it('retains the audit product scope and only its test/config/generated exclusions', () => {
    for (const file of ['packages/demo/src/a.ts', 'apps/demo/src/main.tsx', 'packages/demo/build/worker.mjs']) expect(isRuntimeProductSource(file)).toBe(true);
    for (const file of ['packages/demo/src/a.test.ts', 'packages/demo/vitest.config.ts', 'packages/demo/integration/a.ts',
      'packages/demo/dist/a.js', 'packages/demo/node_modules/a.js', 'packages/fem/runtime/assets/a.js', 'packages/demo/src/a.d.ts', 'e2e/tests/a.ts']) expect(isRuntimeProductSource(file)).toBe(false);
  });
});
