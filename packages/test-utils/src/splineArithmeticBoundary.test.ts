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
