import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
// This finite reviewed set is independent of the spline/2D boundaries owned elsewhere.
const owners = ['packages/ui/src/assembly/mateCommands.ts', 'packages/ui/src/viewport/sectionView.ts',
  'packages/ui/src/viewport/cylinderBasisGuide.ts', 'packages/ui/src/solid/planarHoleInput.ts',
  'packages/ui/src/solid/cutCommands.ts', 'packages/model/src/drawing/gdtAttachment.ts'];

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
}
interface Component { readonly base: string; readonly index: number }
function component(node: ts.Expression): Component | null {
  const value = unwrap(node);
  if (!ts.isElementAccessExpression(value) || value.argumentExpression === undefined
    || !ts.isNumericLiteral(value.argumentExpression)) return null;
  return { base: value.expression.getText(), index: Number(value.argumentExpression.text) };
}
function product(node: ts.Expression): readonly [Component, Component] | null {
  const value = unwrap(node);
  if (!ts.isBinaryExpression(value) || value.operatorToken.kind !== ts.SyntaxKind.AsteriskToken) return null;
  const left = component(value.left), right = component(value.right);
  return left === null || right === null ? null : [left, right];
}
function sumTerms(node: ts.Expression): readonly ts.Expression[] {
  const value = unwrap(node);
  return ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken
    ? [...sumTerms(value.left), ...sumTerms(value.right)] : [value];
}
function isDot(node: ts.Expression): boolean {
  const terms = sumTerms(node);
  if (terms.length !== 3) return false;
  const factors = terms.map(product), first = factors[0];
  return first != null && factors.every((pair, index) => pair !== null
    && pair[0].index === index && pair[1].index === index
    && pair[0].base === first[0].base && pair[1].base === first[1].base);
}
function isCross(node: ts.ArrayLiteralExpression): boolean {
  if (node.elements.length !== 3) return false;
  const order = [[1, 2, 2, 1], [2, 0, 0, 2], [0, 1, 1, 0]];
  let first: readonly [Component, Component] | null = null;
  return node.elements.every((element, index) => {
    const value = unwrap(element);
    if (!ts.isBinaryExpression(value) || value.operatorToken.kind !== ts.SyntaxKind.MinusToken) return false;
    const left = product(value.left), right = product(value.right);
    if (left === null || right === null) return false;
    first ??= left;
    return [left[0].index, left[1].index, right[0].index, right[1].index]
      .every((position, lane) => position === order[index][lane])
      && left[0].base === first[0].base && right[0].base === first[0].base
      && left[1].base === first[1].base && right[1].base === first[1].base;
  });
}

/** Compare syntax trees with only matching component indices erased; never run the arithmetic. */
function laneShape(node: ts.Expression, lane: number): string | null {
  const value = unwrap(node), item = component(value);
  if (item !== null) return item.index === lane ? `${item.base}[#]` : null;
  if (ts.isBinaryExpression(value)) {
    if (![ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken].includes(value.operatorToken.kind)) return null;
    const left = laneShape(value.left, lane), right = laneShape(value.right, lane);
    return left === null || right === null ? null : `(${left}${value.operatorToken.getText()}${right})`;
  }
  return ts.isIdentifier(value) || ts.isNumericLiteral(value) || ts.isPropertyAccessExpression(value) ? value.getText() : null;
}
function isComponentArithmetic(node: ts.ArrayLiteralExpression): boolean {
  if (node.elements.length !== 3 || !node.elements.every(element => ts.isBinaryExpression(unwrap(element)))) return false;
  const shapes = node.elements.map((element, lane) => laneShape(element, lane));
  return shapes[0] !== null && shapes[0].includes('[#]') && shapes.every(shape => shape === shapes[0]);
}
function duplicates(name: string, text: string): readonly string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && isDot(node)) found.push(`dot:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    if (ts.isArrayLiteralExpression(node) && (isCross(node) || isComponentArithmetic(node))) {
      found.push(`components:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source); return found;
}

describe('six reviewed inline 3D arithmetic owners reuse existing vec3 helpers', () => {
  it('keeps component arithmetic out of exactly the six reviewed source files', () => {
    for (const name of owners) expect(duplicates(name, readFileSync(resolve(root, name), 'utf8')), name).toEqual([]);
  });
  it.each([
    'const value = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];',
    'const value = ((left[0] * right[0]) + (left[1] * right[1])) + (left[2] * right[2]);',
    'const value = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];',
    'const value = [a[0] * scale, a[1] * scale, a[2] * scale];',
    'const value = [base[0] + distance * axis[0], base[1] + distance * axis[1], base[2] + distance * axis[2]];',
    'const value = [n[1]*u[2]-n[2]*u[1], n[2]*u[0]-n[0]*u[2], n[0]*u[1]-n[1]*u[0]];',
  ])('rejects an independently supplied duplicate syntax fixture: %s', text => {
    expect(duplicates('fixture.ts', text).length).toBeGreaterThan(0);
  });
  it.each([
    'const value = dotVec3(a, b); const cross = crossVec3(n, u);',
    'const value = addScaled(base, axis, distance);',
    'const basis = [0, 0, 1]; const planar = [a[0] + b[0], a[1] + b[1]];',
    'const extent = low / 2 + high / 2; const normalized = scaleVec3(axis, 1 / length);',
  ])('allows helper calls/constants and leaves 2D or contract-specific scalar math outside this rule: %s', text => {
    expect(duplicates('fixture.ts', text)).toEqual([]);
  });
});
