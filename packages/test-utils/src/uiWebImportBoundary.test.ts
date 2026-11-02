import { existsSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { moduleSpecifiers, productFiles, testOnlyFile } from './packageImportBoundary.testSupport.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const productSources = ['packages/ui/src', 'apps/web/src', 'apps/web/service-worker'];
const exactMathOwner = 'packages/ui/src/math/localExactMathEngine.ts';
// These are the existing fixed local programs, not an exemption for arbitrary raw imports.
const exactMathPrograms = [
  '../../../expression/src/math/exactRuntime/cas_mappings.py?raw',
  '../../../expression/src/math/exactRuntime/cas_limit_bounds.py?raw',
  '../../../expression/src/math/exactRuntime/cas_sets.py?raw',
  '../../../expression/src/math/exactRuntime/cas_equation_systems.py?raw',
  '../../../expression/src/math/exactRuntime/cas_ode_input.py?raw',
  '../../../expression/src/math/exactRuntime/cas_ode.py?raw',
  '../../../expression/src/math/exactRuntime/cas_equations.py?raw',
  '../../../expression/src/math/exactRuntime/cas_fourier_series.py?raw',
  '../../../expression/src/math/exactRuntime/cas_transforms.py?raw',
  '../../../expression/src/math/exactRuntime/cas_fourier.py?raw',
  '../../../expression/src/math/exactRuntime/cas_gamma_functions.py?raw',
  '../../../expression/src/math/exactRuntime/cas_error_functions.py?raw',
  '../../../expression/src/math/exactRuntime/cas_bessel_functions.py?raw',
  '../../../expression/src/math/exactRuntime/cas_airy_functions.py?raw',
  '../../../expression/src/math/exactRuntime/cas_elliptic_functions.py?raw',
  '../../../expression/src/math/exactRuntime/cas_zeta_functions.py?raw',
  '../../../expression/src/math/exactRuntime/cas_lambert_functions.py?raw',
  '../../../expression/src/math/exactRuntime/cas_taylor.py?raw',
  '../../../expression/src/math/exactRuntime/cas_input.py?raw',
  '../../../expression/src/math/exactRuntime/cas_result.py?raw',
  '../../../expression/src/math/exactRuntime/cas_evaluate.py?raw',
  '../../../expression/src/math/exactRuntime/cas_linear.py?raw',
  '../../../expression/src/math/exactRuntime/cas_decompositions.py?raw',
  '../../../expression/src/math/exactRuntime/cas_spectral.py?raw',
  '../../../expression/src/math/exactRuntime/cas_discrete.py?raw',
  '../../../expression/src/math/exactRuntime/cas_limits.py?raw',
  '../../../expression/src/math/exactRuntime/cas_integrals.py?raw',
  '../../../expression/src/math/exactRuntime/cas_derivatives.py?raw',
  '../../../expression/src/math/exactRuntime/cas_vector_calculus.py?raw',
  '../../../expression/src/math/exactRuntime/cas_vector_products.py?raw',
  '../../../expression/src/math/exactRuntime/cas_line_integrals.py?raw',
  '../../../expression/src/math/exactRuntime/cas_box_domain.py?raw',
  '../../../expression/src/math/exactRuntime/cas_region_integrals.py?raw',
  '../../../expression/src/math/exactRuntime/cas_sequences.py?raw',
  '../../../expression/src/math/exactRuntime/cas_sequence_ranges.py?raw',
  '../../../expression/src/math/exactRuntime/cas_integer.py?raw',
  '../../../expression/src/math/exactRuntime/cas_probability.py?raw',
  '../../../expression/src/math/exactRuntime/cas_probability_laws.py?raw',
  '../../../expression/src/math/exactRuntime/cas_probability_domain.py?raw',
  '../../../expression/src/math/exactRuntime/cas_extended_dispatch.py?raw',
  '../../../expression/src/math/exactRuntime/cas_cardinality.py?raw',
  '../../../expression/src/math/exactRuntime/cas_vector_projection.py?raw',
  '../../../expression/src/math/exactRuntime/cas_matrix_constructors.py?raw',
  '../../../expression/src/math/exactRuntime/cas_set_relations.py?raw',
  '../../../expression/src/math/exactRuntime/cas_logic_extended.py?raw',
];

function productModule(path: string): boolean {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path) && !testOnlyFile.test(path);
}

function forbiddenSpecifiers(path: string, source: string): string[] {
  const owner = path.startsWith('packages/ui/') ? 'packages/ui' : 'apps/web';
  return moduleSpecifiers(path, source).filter(specifier => {
    const pathname = specifier.split(/[?#]/u)[0] ?? '';
    if (testOnlyFile.test(pathname)) return true;
    if (path === exactMathOwner && exactMathPrograms.includes(specifier)) return false;
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
    const target = posix.normalize(posix.join(posix.dirname(path), pathname));
    return /^scripts(?:\/|$)/u.test(target)
      || (/^(?:packages|apps)\/[^/]+\/src(?:\/|$)/u.test(target) && !target.startsWith(`${owner}/src/`));
  });
}

const oldReferences = [
  ['packages/ui/src/assembly/steelBendPicker.ts', '../../../model/src/assembly/standard/steelBend.js'],
  ['packages/ui/src/help/offlineManualNavigation.ts', '../../../../scripts/vite/offlineProtocol.mjs'],
  ['apps/web/src/bootstrap.ts', '../../../packages/ui/src/shell/startupPresentation.js'],
  ['apps/web/src/startupMarkup.ts', '../../../packages/ui/src/shell/startupMarkup.js'],
  ['apps/web/src/startupRecovery.ts', '../../../packages/ui/src/shell/startupRecovery.js'],
  ['apps/web/src/pwa/offlineTransfer.ts', '../../../../scripts/vite/offlineProtocol.mjs'],
  ['apps/web/src/pwa/offlineServing.ts', '../../../../scripts/vite/offlineProtocol.mjs'],
  ['apps/web/src/pwa/offlineRouting.ts', '../../../../scripts/vite/offlineProtocol.mjs'],
  ['apps/web/src/pwa/offlineReady.ts', '../../../../scripts/vite/offlineProtocol.mjs'],
  ['apps/web/src/pwa/offlinePreparation.ts', '../../../../scripts/vite/offlineProtocol.mjs'],
  ['apps/web/src/pwa/offlineNetwork.ts', '../../../../scripts/vite/offlineProtocol.mjs'],
  ['apps/web/src/pwa/offlineInventory.ts', '../../../../scripts/vite/offlineProtocol.mjs'],
  ['apps/web/service-worker/main.ts', '../../../scripts/vite/offlineProtocol.mjs'],
] as const;

describe('UI and Web use product package entries instead of private source and build scripts', () => {
  for (const [path, specifier] of oldReferences) {
    it(`rejects the original reference in ${path}`, () => {
      expect(forbiddenSpecifiers(path, `import { value } from '${specifier}';`)).toEqual([specifier]);
    });
  }

  const forms = [
    (name: string) => `import value from '${name}';`,
    (name: string) => `import type { Value } from '${name}';`,
    (name: string) => `export { value } from '${name}';`,
    (name: string) => `export * from '${name}';`,
    (name: string) => `export type { Value } from '${name}';`,
    (name: string) => `import('${name}');`,
    (name: string) => `import(\`${name}\`);`,
    (name: string) => `type Value = import('${name}').Value;`,
  ];
  for (const [index, form] of forms.entries()) {
    it(`checks module form ${index + 1} in new nested files and service workers`, () => {
      for (const [path, privateName, scriptName] of [
        ['packages/ui/src/future/nested.ts', '../../../model/src/index.js', '../../../../scripts/vite/offlineProtocol.mjs'],
        ['apps/web/src/future/nested.ts', '../../../../packages/ui/src/index.ts', '../../../../scripts/vite/offlineProtocol.mjs'],
        ['apps/web/service-worker/future/nested.ts', '../../../../packages/ui/src/index.ts', '../../../../scripts/vite/offlineProtocol.mjs'],
      ] as const) {
        for (const name of [privateName, scriptName, privateName + '?raw', './future.test.js', './future.testSupport.ts?raw']) {
          expect(forbiddenSpecifiers(path, form(name))).toEqual([name]);
        }
        for (const name of ['@pointercad/ui/offline-protocol', '@pointercad/model', './sibling.js', '../worker.js']) {
          expect(forbiddenSpecifiers(path, form(name))).toEqual([]);
        }
      }
    });
  }

  it('allows exactly the existing owner and Python program list, with no raw source bypass', () => {
    const source = readFileSync(resolve(root, exactMathOwner), 'utf8');
    expect(moduleSpecifiers(exactMathOwner, source).filter(name => name.endsWith('.py?raw')).sort())
      .toEqual([...exactMathPrograms].sort());
    expect(new Set(exactMathPrograms).size).toBe(exactMathPrograms.length);
    for (const name of exactMathPrograms) {
      const target = posix.join(posix.dirname(exactMathOwner), name.slice(0, -4));
      expect(existsSync(resolve(root, target))).toBe(true);
      expect(forbiddenSpecifiers(exactMathOwner, `import code from '${name}';`)).toEqual([]);
      expect(forbiddenSpecifiers('packages/ui/src/math/another.ts', `import code from '${name}';`)).toEqual([name]);
    }
    for (const name of ['../../../expression/src/math/exactRuntime/new.py?raw',
      '../../../expression/src/math/exactRuntime/cas_mappings.ts?raw',
      '../../../expression/src/math/exactRuntime/cas_mappings.py?raw#extra',
      '../../../../scripts/new.py?raw']) {
      expect(forbiddenSpecifiers(exactMathOwner, `import code from '${name}';`)).toEqual([name]);
    }
  });

  it('excludes test files while keeping JavaScript, TypeScript and future nested products in the inventory', () => {
    for (const path of ['apps/web/src/a.test.ts', 'apps/web/src/a.testSupport.ts', 'packages/ui/src/a.test.tsx']) {
      expect(productModule(path)).toBe(false);
    }
    for (const path of ['apps/web/src/future/a.ts', 'apps/web/service-worker/future/a.mjs',
      'packages/ui/src/future/a.tsx', 'packages/ui/src/settings/offlineProtocol.mjs']) {
      expect(productModule(path)).toBe(true);
    }
    const source = `// import value from '../../../../scripts/build.mjs';
      /* export * from '../../../model/src/index.js'; */
      const label = "import('../../../model/src/index.js')";
      const template = \`export * from '../../../../scripts/build.mjs';\`;
      type Label = '../../../model/src/index.js';`;
    expect(moduleSpecifiers('packages/ui/src/future/a.ts', source)).toEqual([]);
  });

  it('scans current and subsequently added product files including the service worker', () => {
    const files = productSources.flatMap(source => productFiles(root, source, productModule));
    for (const [path] of oldReferences) expect(files).toContain(path);
    expect(files).toContain('packages/ui/src/settings/offlineProtocol.mjs');
    const failures = files.flatMap(path => forbiddenSpecifiers(path, readFileSync(resolve(root, path), 'utf8'))
      .map(specifier => ({ path, specifier })));
    expect(failures).toEqual([]);
  });
});
