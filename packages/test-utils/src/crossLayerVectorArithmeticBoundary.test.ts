import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Limited re-copy guard for six kernel/drawing/fem consumers (not the UI/model files). Each layer reads the one
 * existing definition it may reach without a new dependency: kernel occt → `./sketchCorner.js`, drawing (no
 * kernel/model dependency) → the exported pair in `dimension/series.ts`, fem → `@pointercad/model/vec3`.
 * The guard checks syntax only; it never evaluates or restates the arithmetic.
 */
const consumers: readonly { readonly path: string; readonly specifier: string; readonly names: readonly string[] }[] = [
  { path: 'packages/kernel/src/occt/cylinderDisplayBasis.ts', specifier: './sketchCorner.js', names: ['dotVec'] },
  { path: 'packages/kernel/src/occt/measureShape.ts', specifier: './sketchCorner.js', names: ['dotVec'] },
  { path: 'packages/drawing/src/dimension/autoDimension.ts', specifier: './series.js', names: ['dotVector3'] },
  { path: 'packages/fem/src/cadShellSurfaceMesh.ts', specifier: '@pointercad/model/vec3', names: ['crossVec3', 'dotVec3'] },
  { path: 'packages/fem/src/contactModel.ts', specifier: '@pointercad/model/vec3', names: ['dotVec3', 'subVec3'] },
];
const drawingOwner = 'packages/drawing/src/dimension/series.ts';
const drawingDefinitions = new Set(['dotVector3', 'crossVector3']);

function parse(text: string, name: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
}
function read(name: string): ts.SourceFile {
  return parse(readFileSync(resolve(root, name), 'utf8'), name);
}
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

interface Indexed { readonly base: string; readonly index: number }
interface Product { readonly left: Indexed; readonly right: Indexed }

function indexed(node: ts.Expression, source: ts.SourceFile): Indexed | null {
  const inner = unwrap(node);
  if (!ts.isElementAccessExpression(inner) || !ts.isNumericLiteral(inner.argumentExpression)) return null;
  const index = Number(inner.argumentExpression.text);
  return index === 0 || index === 1 || index === 2 ? { base: inner.expression.getText(source), index } : null;
}
function product(node: ts.Expression, source: ts.SourceFile): Product | null {
  const inner = unwrap(node);
  if (!ts.isBinaryExpression(inner) || inner.operatorToken.kind !== ts.SyntaxKind.AsteriskToken) return null;
  const left = indexed(inner.left, source), right = indexed(inner.right, source);
  return left === null || right === null ? null : { left, right };
}
function sameBases(products: readonly Product[]): boolean {
  return products.every(item => item.left.base === products[0].left.base && item.right.base === products[0].right.base);
}
/** `p[0] * q[0] + p[1] * q[1] + p[2] * q[2]` for any two operand expressions. */
function isInlineDot(node: ts.BinaryExpression, source: ts.SourceFile): boolean {
  if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
  const head = unwrap(node.left);
  if (!ts.isBinaryExpression(head) || head.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
  const terms = [product(head.left, source), product(head.right, source), product(node.right, source)];
  const found = terms.filter((term): term is Product => term !== null);
  return found.length === 3 && sameBases(found)
    && found.every((term, axis) => term.left.index === axis && term.right.index === axis);
}
/** `[p[1]*q[2] - p[2]*q[1], p[2]*q[0] - p[0]*q[2], p[0]*q[1] - p[1]*q[0]]`. */
function isInlineCross(node: ts.ArrayLiteralExpression, source: ts.SourceFile): boolean {
  if (node.elements.length !== 3) return false;
  const pairs = [[1, 2], [2, 0], [0, 1]] as const;
  const products: Product[] = [];
  for (const [position, [first, second]] of pairs.entries()) {
    const element = node.elements[position];
    if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return false;
    const inner = unwrap(element);
    if (!ts.isBinaryExpression(inner) || inner.operatorToken.kind !== ts.SyntaxKind.MinusToken) return false;
    const plus = product(inner.left, source), minus = product(inner.right, source);
    if (plus === null || minus === null || plus.left.index !== first || plus.right.index !== second
      || minus.left.index !== second || minus.right.index !== first) return false;
    products.push(plus, minus);
  }
  return sameBases(products);
}
function inlineVectorArithmetic(source: ts.SourceFile, skip: ReadonlySet<string> = new Set()): readonly string[] {
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && skip.has(node.name.text)) return;
    if (ts.isBinaryExpression(node) && isInlineDot(node, source)) found.push(`dot: ${node.getText(source)}`);
    else if (ts.isArrayLiteralExpression(node) && isInlineCross(node, source)) found.push(`cross: ${node.getText(source)}`);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}
function snippet(text: string): readonly string[] {
  return inlineVectorArithmetic(parse(text, 'snippet.ts'));
}
function importSpecifiers(source: ts.SourceFile): readonly string[] {
  return source.statements.filter(ts.isImportDeclaration)
    .map(node => ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : node.moduleSpecifier.getText(source));
}
function importedNames(source: ts.SourceFile, specifier: string): readonly string[] {
  return source.statements.filter(ts.isImportDeclaration).flatMap(node => {
    const bindings = node.importClause?.namedBindings;
    if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== specifier
      || node.importClause?.isTypeOnly === true || bindings === undefined || !ts.isNamedImports(bindings)) return [];
    return bindings.elements.filter(element => !element.isTypeOnly).map(element => (element.propertyName ?? element.name).text);
  });
}

describe('cross-layer inline vector arithmetic guard', () => {
  it('detects the inline forms it guards against (negative examples)', () => {
    expect(snippet('const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];')).toHaveLength(1);
    expect(snippet('const d = point.modelPoint[0] * vector[0] + point.modelPoint[1] * vector[1] + point.modelPoint[2] * vector[2];')).toHaveLength(1);
    expect(snippet('const d =\n  directionA[0] * directionB[0] +\n  directionA[1] * directionB[1] +\n  directionA[2] * directionB[2];')).toHaveLength(1);
    expect(snippet('const c = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];')).toHaveLength(1);
    expect(snippet('f([x[1] * normal[2] - x[2] * normal[1], x[2] * normal[0] - x[0] * normal[2], x[0] * normal[1] - x[1] * normal[0]]);')).toHaveLength(1);
  });
  it('leaves different contracts and calls alone (positive near misses)', () => {
    expect(snippet('const d = a[0] * b[0] + a[1] * b[1];')).toEqual([]);
    expect(snippet('const d = a[0] * b[1] + a[1] * b[2] + a[2] * b[0];')).toEqual([]);
    expect(snippet('const d = a[0] * b[0] + c[1] * b[1] + a[2] * b[2];')).toEqual([]);
    expect(snippet('const z = a[0] * b[1] - a[1] * b[0];')).toEqual([]);
    expect(snippet('const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2]];')).toEqual([]);
    expect(snippet('const d = dotVec3(a, b), c = crossVec3(a, b);')).toEqual([]);
  });
  it('keeps the five consumers on their layer entry without inline copies', () => {
    for (const { path, specifier, names } of consumers) {
      const source = read(path);
      expect(importedNames(source, specifier), path).toEqual(expect.arrayContaining([...names]));
      expect(inlineVectorArithmetic(source), path).toEqual([]);
    }
  });
  it('keeps one drawing-layer definition pair and no other inline copy in its owner', () => {
    const source = read(drawingOwner);
    const exported = source.statements.filter(ts.isFunctionDeclaration)
      .filter(node => node.name !== undefined && drawingDefinitions.has(node.name.text)
        && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true)
      .map(node => node.name?.text);
    expect(exported).toHaveLength(2);
    expect(new Set(exported)).toEqual(drawingDefinitions);
    expect(inlineVectorArithmetic(source, drawingDefinitions)).toEqual([]);
  });
  it('adds no cross-layer dependency to reach the shared arithmetic', () => {
    for (const path of [drawingOwner, 'packages/drawing/src/dimension/autoDimension.ts']) {
      expect(importSpecifiers(read(path)).filter(value => value.startsWith('@pointercad/')), path).toEqual([]);
    }
    for (const path of ['packages/fem/src/cadShellSurfaceMesh.ts', 'packages/fem/src/contactModel.ts']) {
      expect(importSpecifiers(read(path)).filter(value => value.startsWith('@pointercad/kernel')), path).toEqual([]);
    }
    for (const path of ['packages/kernel/src/occt/cylinderDisplayBasis.ts', 'packages/kernel/src/occt/measureShape.ts']) {
      expect(importSpecifiers(read(path)).filter(value => value.startsWith('@pointercad/')), path).toEqual([]);
    }
    const drawingPackage = JSON.parse(readFileSync(resolve(root, 'packages/drawing/package.json'), 'utf8')) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    expect(Object.keys(drawingPackage.dependencies ?? {}).filter(name => name.startsWith('@pointercad/'))).toEqual([]);
  });
});
