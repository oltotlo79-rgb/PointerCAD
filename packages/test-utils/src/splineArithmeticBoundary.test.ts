import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const pure = 'packages/kernel/src/math/splineInterpolation.ts';
const adapter = 'packages/model/src/kernelBridge/splineMath.ts';
const subpath = '@pointercad/kernel/math/spline-interpolation';
function read(name: string): ts.SourceFile {
  return ts.createSourceFile(name, readFileSync(resolve(root, name), 'utf8'), ts.ScriptTarget.Latest, true);
}
function imports(source: ts.SourceFile): readonly string[] {
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) {
      found.push(node.moduleSpecifier?.getText(source) ?? '<unresolved>');
    } else if (ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node)) found.push(node.getText(source));
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) found.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source); return found;
}
function files(directory: string): readonly string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    const name = `${directory}/${entry.name}`;
    return entry.isDirectory() ? files(name) : /\.tsx?$/u.test(name) ? [name] : [];
  });
}
function runtimeReferences(source: ts.SourceFile): readonly string[] {
  const runtime: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && ['Worker', 'SharedWorker', 'WebAssembly', 'fetch', 'importScripts', 'XMLHttpRequest'].includes(node.text)) runtime.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(source); return runtime;
}

describe('bounded pure spline subpath', () => {
  it('has zero imports including type/dynamic/require, hence zero transitive model/OCCT/Worker dependencies', () => {
    const source = read(pure);
    expect(imports(source)).toEqual([]);
    expect(runtimeReferences(source)).toEqual([]);
    const packageJson = JSON.parse(readFileSync(resolve(root, 'packages/kernel/package.json'), 'utf8')) as {
      exports: Record<string, { readonly types: string; readonly default: string }>;
    };
    expect(packageJson.exports['./math/spline-interpolation']).toEqual({
      types: './dist/math/splineInterpolation.d.ts', default: './src/math/splineInterpolation.ts',
    });
  });
  it('limits model subpath access to the dedicated adapter without a barrel/Worker route', () => {
    const users = files('packages/model/src').filter(name => imports(read(name)).some(value =>
      value.includes(subpath) || /kernel[\\/]src[\\/]math[\\/]splineInterpolation/u.test(value)));
    expect(users.map(name => relative(root, resolve(root, name)).replaceAll('\\', '/'))).toEqual([adapter]);
    expect(imports(read(adapter))).toEqual([`'${subpath}'`]);
    expect(imports(read('packages/model/src/sketch/splineMath.ts'))).toContain("'../kernelBridge/splineMath.js'");
    expect(imports(read('packages/kernel/src/occt/makeSplineEdge.ts'))).toContain("'../math/splineInterpolation.js'");
  });
  it('keeps the arithmetic declarations out of the two public adapters', () => {
    const raw = new Set(['basisValues', 'findSpan', 'solveLinearSystem', 'compressKnots', 'chordLengths',
      'interpolateOpen', 'interpolateClosed', 'controlPointData', 'periodicFullKnots', 'expandKnots']);
    for (const name of ['packages/model/src/sketch/splineMath.ts', 'packages/kernel/src/occt/makeSplineEdge.ts']) {
      const declarations = read(name).statements.filter(ts.isFunctionDeclaration).map(node => node.name?.text).filter(value => value !== undefined && raw.has(value));
      expect(declarations, name).toEqual([]);
    }
  });
});

describe('bounded pure vector subpath', () => {
  const vector = 'packages/kernel/src/math/vectorArithmetic.ts';
  const vectorSubpath = '@pointercad/kernel/math/vector-arithmetic';
  it('has zero imports and an explicit export entry, hence no kernel index/OCCT/Worker route', () => {
    expect(imports(read(vector))).toEqual([]);
    expect(runtimeReferences(read(vector))).toEqual([]);
    const packageJson = JSON.parse(readFileSync(resolve(root, 'packages/kernel/package.json'), 'utf8')) as {
      exports: Record<string, { readonly types: string; readonly default: string }>;
    };
    expect(packageJson.exports['./math/vector-arithmetic']).toEqual({
      types: './dist/math/vectorArithmetic.d.ts', default: './src/math/vectorArithmetic.ts',
    });
  });
  it('reaches model only through its dedicated bridge and kernel callers through relative imports', () => {
    const users = files('packages/model/src').filter(name => imports(read(name)).some(value =>
      value.includes(vectorSubpath) || /kernel[\\/]src[\\/]math[\\/]vectorArithmetic/u.test(value)));
    expect(users.map(name => relative(root, resolve(root, name)).replaceAll('\\', '/'))).toEqual(['packages/model/src/kernelBridge/vectorMath.ts']);
    expect(imports(read('packages/model/src/kernelBridge/vectorMath.ts'))).toEqual([`'${vectorSubpath}'`]);
    expect(imports(read('packages/model/src/sketch/vec3.ts'))).toEqual(["'../kernelBridge/vectorMath.js'"]);
    for (const name of ['packages/kernel/src/occt/placeBodies.ts', 'packages/kernel/src/occt/sphereTangent.ts']) {
      expect(imports(read(name)), name).toContain("'../math/vectorArithmetic.js'");
    }
  });
  it('keeps the moved declarations out of the four former owners', () => {
    const moved = new Set(['isFiniteQuaternion', 'addScaled', 'scaleFrom']);
    for (const name of ['packages/kernel/src/occt/placeBodies.ts', 'packages/kernel/src/occt/sphereTangent.ts',
      'packages/model/src/assembly/placementMath.ts', 'packages/ui/src/viewport/createMeasureLayer.ts']) {
      const declarations = read(name).statements.filter(ts.isFunctionDeclaration).map(node => node.name?.text)
        .filter(value => value !== undefined && moved.has(value));
      expect(declarations, name).toEqual([]);
    }
  });
});

describe('surface arc cross product uses the existing kernel helper', () => {
  it('imports crossVec as cross and does not redefine the same operation', () => {
    const source = read('packages/kernel/src/occt/surfaceArcOrigins.ts');
    const imported = source.statements.filter(ts.isImportDeclaration).some(node =>
      node.moduleSpecifier.getText(source) === "'./sketchCorner.js'"
      && node.importClause?.namedBindings !== undefined
      && ts.isNamedImports(node.importClause.namedBindings)
      && node.importClause.namedBindings.elements.some(element => element.propertyName?.text === 'crossVec'
        && element.name.text === 'cross'));
    expect(imported).toBe(true);
    expect(source.statements.filter(ts.isFunctionDeclaration).map(node => node.name?.text)).not.toContain('cross');
  });
});

describe('helix cross product reuses kernel arithmetic', () => {
  it('uses crossVec while keeping the signed-zero normalization wrapper', () => {
    const source = read('packages/kernel/src/occt/makeHelix.ts');
    const imported = source.statements.filter(ts.isImportDeclaration).some(node =>
      node.moduleSpecifier.getText(source) === "'./sketchCorner.js'"
      && node.importClause?.namedBindings !== undefined
      && ts.isNamedImports(node.importClause.namedBindings)
      && node.importClause.namedBindings.elements.some(element => element.name.text === 'crossVec'));
    expect(imported).toBe(true);
    const cross = source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'cross');
    expect(cross?.getText(source)).toContain('crossVec(a, b)');
    expect(cross?.getText(source)).toContain('normalizeZero(value[0])');
    expect(cross?.getText(source)).toContain('normalizeZero(value[1])');
    expect(cross?.getText(source)).toContain('normalizeZero(value[2])');
  });
});

describe('kernel native geometry uses shared vector arithmetic', () => {
  it('uses crossVec without duplicating its arithmetic in the three consumers', () => {
    for (const path of ['packages/kernel/src/occt/analysisShellQuality.ts',
      'packages/kernel/src/occt/editSolidFace.ts', 'packages/kernel/src/occt/moveSolidHole.ts']) {
      const code = read(path);
      const importNode = code.statements.filter(ts.isImportDeclaration).find(node =>
        node.moduleSpecifier.getText(code) === "'./sketchCorner.js'");
      expect(importNode?.getText(code), path).toContain('crossVec');
      expect(code.getText(), path).not.toContain('a[1] * b[2] - a[2] * b[1]');
    }
    expect(read('packages/kernel/src/occt/analysisShellQuality.ts').getText()).toContain('= dotVec;');
  });
});

describe('model and UI use their shared three-dimensional vector operations', () => {
  it('keeps the five shared operations connected to the model vector module', () => {
    const entries = [
      ['packages/ui/src/solidAnalysis/solidFieldView.ts', '@pointercad/model/vec3', ['crossVec3', 'dotVec3']],
      ['packages/ui/src/solid/measure.ts', '@pointercad/model/vec3', ['crossVec3']],
      ['packages/model/src/measure/mathGeometry.ts', '../sketch/vec3.js', ['crossVec3', 'dotVec3']],
    ] as const;
    for (const [path, specifier, names] of entries) {
      const code = read(path);
      const imported = code.statements.filter(ts.isImportDeclaration).find(node =>
        ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === specifier);
      const bindings = imported?.importClause?.namedBindings;
      expect(bindings !== undefined && ts.isNamedImports(bindings), path).toBe(true);
      if (bindings === undefined || !ts.isNamedImports(bindings)) throw new Error(`missing vector imports: ${path}`);
      for (const name of names) expect(bindings.elements.some(element => (element.propertyName ?? element.name).text === name), path).toBe(true);
      expect(code.getText(), path).not.toContain('a[1] * b[2] - a[2] * b[1]');
      expect(code.getText(), path).not.toContain('left[1] * right[2] - left[2] * right[1]');
    }
  });
});

describe('mate target body lookup has one owner', () => {
  function declaration(source: ts.SourceFile, name: string): string {
    return source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === name)?.getText(source) ?? '';
  }
  it('keeps the sub-shape lookup in model and lets the subassembly occurrence drive delegate to it', () => {
    const model = read('packages/model/src/assembly/resolveConstrainedAssembly.ts');
    const drive = read('packages/ui/src/store/assemblyOccurrenceDriveSlice.ts');
    expect(declaration(model, 'createBodyMateTargetOptions')).toContain('createSubShapeReferenceResolver()');
    expect(declaration(model, 'createBodyMateTargetResolver')).toContain('createBodyMateTargetOptions(bodies)');
    expect(declaration(model, 'createBodyMateTargetResolver')).not.toContain('createSubShapeReferenceResolver');
    expect(declaration(drive, 'occurrenceTargetOptions')).toContain('createBodyMateTargetOptions(bodies)');
    expect(drive.getText()).not.toContain('createSubShapeReferenceResolver');
    expect(drive.getText()).not.toContain('resolution.match.geometry');
  });
});

describe('UI two-dimensional orientation uses the model determinant', () => {
  const determinant = /\((\w+)\[0\] - (\w+)\[0\]\) \* \((\w+)\[1\] - \2\[1\]\) - \(\1\[1\] - \2\[1\]\) \* \(\3\[0\] - \2\[0\]\)/u;
  it('imports crossVec2 from the model entry and does not repeat the three-point arithmetic', () => {
    for (const path of ['packages/ui/src/sketch/facePointOrder.ts', 'packages/ui/src/drawing/drawingPick.ts']) {
      const code = read(path);
      const imported = code.statements.filter(ts.isImportDeclaration).some(node =>
        ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@pointercad/model'
        && node.importClause?.namedBindings !== undefined
        && ts.isNamedImports(node.importClause.namedBindings)
        && node.importClause.namedBindings.elements.some(element => (element.propertyName ?? element.name).text === 'crossVec2'));
      expect(imported, path).toBe(true);
      expect(determinant.test(code.getText()), path).toBe(false);
    }
  });
  it('recognizes the removed inline form under any names and accepts the shared call', () => {
    expect(determinant.test('(b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])')).toBe(true);
    expect(determinant.test('(y[0] - x[0]) * (z[1] - x[1]) - (y[1] - x[1]) * (z[0] - x[0])')).toBe(true);
    expect(determinant.test('crossVec2([b[0] - a[0], b[1] - a[1]], [c[0] - a[0], c[1] - a[1]])')).toBe(false);
  });
});
