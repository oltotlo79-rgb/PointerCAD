import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { moduleSpecifiers, productFiles, productTypeScript, sourceIdentifiers, testOnlyFile }
  from './packageImportBoundary.testSupport.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const femSource = 'packages/fem/src';

function forbiddenSpecifiers(path: string, source: string): string[] {
  return moduleSpecifiers(path, source).filter(specifier => {
    const pathname = specifier.split(/[?#]/u)[0] ?? '';
    if (testOnlyFile.test(pathname)) return true;
    // Only Python raw assets are exempt, never TypeScript/JavaScript raw source.
    if (/\.py\?raw$/u.test(specifier)) return false;
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
    const target = posix.normalize(posix.join(posix.dirname(path), pathname));
    return /^packages\/[^/]+\/src(?:\/|$)/u.test(target)
      && target !== femSource && !target.startsWith(`${femSource}/`);
  });
}

const oldReferences = [
  { path: 'packages/fem/src/cadTetraMesh.ts', source: "import { readSolidCadSavedInput, solidCadFaceKey, type SolidCadSavedInput } from '../../model/src/analysis/solidCadInput.js';" },
  { path: 'packages/fem/src/solidAnalysisTranslation.ts', source: "import { readOptionalMaterialCapacity } from '../../model/src/analysis/analysisValidation.js';" },
  { path: 'packages/fem/src/solidContactModel.ts', source: "import { InputIssue } from '../../model/src/analysis/analysisValidation.js';" },
  { path: 'packages/fem/src/solidContactSearch.ts', source: "import { InputIssue } from '../../model/src/analysis/analysisValidation.js';" },
];

describe('FEM uses public package entries instead of another package src', () => {
  for (const original of oldReferences) {
    it(`rejects the original reference in ${original.path}`, () => {
      expect(forbiddenSpecifiers(original.path, original.source)).toHaveLength(1);
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
    it(`checks import/export form ${index + 1} including nested future files`, () => {
      const path = `${femSource}/future/nested.ts`;
      for (const name of ['../../../model/src/analysis/analysisValidation.js',
        '../../../model/src/analysis/analysisValidation.ts?raw', '../../../model/./src/../src/index.js',
        '../../../expression/src/index.js']) {
        expect(forbiddenSpecifiers(path, form(name))).toEqual([name]);
      }
      for (const name of ['@pointercad/model/beam-analysis', './sibling.js', '../client.js']) {
        expect(forbiddenSpecifiers(path, form(name))).toEqual([]);
      }
    });
  }

  it('excludes only test files and prevents product code importing the excluded files', () => {
    for (const path of [`${femSource}/future.test.ts`, `${femSource}/future.testSupport.ts`]) {
      expect(productTypeScript(path)).toBe(false);
    }
    for (const path of [`${femSource}/future.ts`, `${femSource}/nested/future.tsx`]) {
      expect(productTypeScript(path)).toBe(true);
    }
    for (const form of forms) {
      for (const name of ['./future.test.js', './future.testSupport.js', './future.testSupport.ts?raw']) {
        expect(forbiddenSpecifiers(`${femSource}/future.ts`, form(name))).toEqual([name]);
      }
    }
  });

  it('allows Python raw assets without opening a raw TypeScript bypass', () => {
    const path = `${femSource}/future.ts`;
    expect(forbiddenSpecifiers(path, "import code from '../../model/src/worker.py?raw';")).toEqual([]);
    for (const name of ['../../model/src/worker.ts?raw', '../../model/src/worker.js?raw',
      '../../model/src/worker.py?rawness', '../../model/src/worker.py?raw#extra']) {
      expect(forbiddenSpecifiers(path, `import code from '${name}';`)).toEqual([name]);
    }
  });

  it('does not confuse comments and ordinary string contents with module syntax', () => {
    const source = `// import { value } from '../../model/src/index.js';
      /* export * from '../../model/src/index.js'; */
      const example = "import('../../model/src/index.js')";
      const template = \`export * from '../../model/src/index.js';\`;
      type Label = '../../model/src/index.js';`;
    expect(moduleSpecifiers(`${femSource}/future.ts`, source)).toEqual([]);
  });

  it('keeps CAD settings on FEM physical input types instead of the model saved schema', () => {
    const path = `${femSource}/cadSolidAnalysis.ts`;
    const savedTypes = [
      "import type { SolidCadSavedInput } from '@pointercad/model/beam-analysis';",
      "import type { SolidCadSavedInput as Saved } from '@pointercad/model/beam-analysis';",
      "type Saved = import('@pointercad/model/beam-analysis').SolidCadSavedInput;",
      "import type * as Model from '@pointercad/model/beam-analysis'; type Saved = Model.SolidCadSavedInput;",
    ];
    for (const source of savedTypes) expect(sourceIdentifiers(path, source)).toContain('SolidCadSavedInput');
    const physicalInput = "import type { SolidMaterial, SolidVector3 } from './solidAnalysisModel.js';"
      + ' interface Settings { readonly material: SolidMaterial; readonly tractionMPa: SolidVector3 }';
    expect(sourceIdentifiers(path, physicalInput)).not.toContain('SolidCadSavedInput');
    expect(sourceIdentifiers(path, "// SolidCadSavedInput\nconst label = 'SolidCadSavedInput';"))
      .not.toContain('SolidCadSavedInput');
    expect(sourceIdentifiers(path, readFileSync(resolve(root, path), 'utf8'))).not.toContain('SolidCadSavedInput');
  });

  it('scans every current and subsequently added FEM product TypeScript file', () => {
    const files = productFiles(root, femSource);
    expect(files.length).toBeGreaterThan(0);
    for (const original of oldReferences) expect(files).toContain(original.path);
    const failures = files.flatMap(path => forbiddenSpecifiers(path, readFileSync(resolve(root, path), 'utf8'))
      .map(specifier => ({ path, specifier })));
    expect(failures).toEqual([]);
  });
});
