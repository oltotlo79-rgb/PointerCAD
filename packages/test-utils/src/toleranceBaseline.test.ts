import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { productFiles, productTypeScript } from './packageImportBoundary.testSupport.js';
import * as ts from 'typescript';

interface ParsedSource extends ts.SourceFile { readonly parseDiagnostics: readonly ts.Diagnostic[] }

/** Identify direct absolute differences on either side of an ordered comparison. */
function handwrittenTolerance(source: string, filename = 'source.ts'): string[] {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) as ParsedSource;
  if (tree.parseDiagnostics.length) throw new Error('Unable to parse tolerance input');
  const printer = ts.createPrinter({ removeComments: true });
  const out: string[] = [];
  function difference(node: ts.Expression): boolean {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
      || node.expression.expression.getText(tree) !== 'Math' || node.expression.name.text !== 'abs' || node.arguments.length !== 1) return false;
    let arg = node.arguments[0];
    while (ts.isParenthesizedExpression(arg)) arg = arg.expression;
    return ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.MinusToken;
  }
  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken].includes(node.operatorToken.kind)
      && (difference(node.left) || difference(node.right))) out.push(printer.printNode(ts.EmitHint.Expression, node, tree));
    ts.forEachChild(node, visit);
  }
  visit(tree); return out;
}

function baselineRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reject malformed baseline entries before comparing occurrence counts. */
function checkedToleranceBaseline(value: unknown): Record<string, Record<string, number>> {
  if (!baselineRecord(value)) throw new Error('Invalid tolerance baseline');
  const result = Object.create(null) as Record<string, Record<string, number>>;
  for (const [path, counts] of Object.entries(value)) {
    if (!baselineRecord(counts)) throw new Error('Invalid tolerance baseline counts');
    result[path] = Object.create(null) as Record<string, number>;
    for (const [expression, count] of Object.entries(counts)) {
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid tolerance baseline count');
      result[path][expression] = count;
    }
  }
  return result;
}

/** The original audit also matched Math.abs(value) against an identifier-led bound. */
function originalToleranceExtra(source: string, filename = 'source.ts'): string[] {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) as ParsedSource;
  if (tree.parseDiagnostics.length) throw new Error('Unable to parse tolerance input');
  const printer = ts.createPrinter({ removeComments: true });
  const out: string[] = [];
  const pattern = /^Math\.abs\([^()]*(?:\([^()]*\)[^()]*)*\)\s*(?:<=|<|>|>=)\s*[A-Za-z_][\p{L}\p{N}_.]*/u;
  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && pattern.test(node.getText(tree)) && ts.isCallExpression(node.left)
      && ts.isPropertyAccessExpression(node.left.expression) && node.left.arguments.length === 1) {
      let arg = node.left.arguments[0];
      while (ts.isParenthesizedExpression(arg)) arg = arg.expression;
      const alreadyCovered = ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.MinusToken;
      if (!alreadyCovered) out.push(printer.printNode(ts.EmitHint.Expression, node, tree));
    }
    ts.forEachChild(node, visit);
  }
  visit(tree); return out;
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
function excess(current: readonly string[], allowed: Readonly<Record<string, number>>): string[] {
  const counts: Record<string, number> = {};
  for (const item of current) counts[item] = (counts[item] ?? 0) + 1;
  return Object.entries(counts).filter(([item, count]) => count > (allowed[item] ?? 0)).map(([item]) => item);
}
describe('new handwritten absolute-difference tolerances', () => {
  it('detects one new comparison while allowing an existing one', () => {
    const original = handwrittenTolerance('const a = Math.abs(x-y) <= t;');
    const allowed = Object.fromEntries(original.map(value => [value, 1]));
    expect(excess(original, allowed)).toEqual([]);
    expect(excess(handwrittenTolerance('const a = Math.abs(x-y) <= t; const b = Math.abs(u-v) <= t;'), allowed)).toHaveLength(1);
    expect(handwrittenTolerance('// Math.abs(x-y) <= t\nconst a = Math.abs(x) <= t;')).toEqual([]);
    expect(originalToleranceExtra('const x = Math.abs(a) <= tol;')).toHaveLength(1);
    expect(originalToleranceExtra('const x = Math.abs(a-b) <= tol;')).toEqual([]);
    expect(originalToleranceExtra('// Math.abs(a) <= tol')).toEqual([]);
    const yieldBoundary = 'Math.abs(trial) > plasticBarYieldStressPa(plan.material, kappa)';
    const yieldAllowed = { [yieldBoundary]: 1 };
    expect(excess(originalToleranceExtra(`if (${yieldBoundary}) {}`), yieldAllowed)).toEqual([]);
    expect(excess(originalToleranceExtra(`if (${yieldBoundary}) {} if (${yieldBoundary}) {}`), yieldAllowed)).toEqual([yieldBoundary]);
    expect(excess(originalToleranceExtra('if (Math.abs(other) > limit) {}'), yieldAllowed)).toEqual(['Math.abs(other) > limit']);
    for (const bad of [-1, 1.5, NaN, '1']) {
      expect(() => checkedToleranceBaseline({ path: { expression: bad } })).toThrow('Invalid tolerance baseline count');
    }
  });
  it('does not add direct handwritten comparisons to product sources', () => {
    const baseline = checkedToleranceBaseline(JSON.parse(readFileSync(resolve(root, 'packages/test-utils/src/toleranceBaseline.json'), 'utf8')) as unknown);
    const extraBaseline = checkedToleranceBaseline(JSON.parse(readFileSync(resolve(root, 'packages/test-utils/src/toleranceOriginalExtraBaseline.json'), 'utf8')) as unknown);
    const roots = ['packages', 'apps'].flatMap(group => readdirSync(resolve(root, group), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(resolve(root, group, entry.name, 'src')))
      .map(entry => posix.join(group, entry.name, 'src')));
    const violations = roots.flatMap(dir => productFiles(root, dir, path => productTypeScript(path)
      && !/\.d\.[cm]?ts$/u.test(path) && !/\.spec\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path)))
      .flatMap(path => {
        const source = readFileSync(resolve(root, path), 'utf8');
        return [...excess(handwrittenTolerance(source, path), baseline[path] ?? {}),
          ...excess(originalToleranceExtra(source, path), extraBaseline[path] ?? {})].map(item => path + ': ' + item);
      });
    expect(violations).toEqual([]);
  });
});
