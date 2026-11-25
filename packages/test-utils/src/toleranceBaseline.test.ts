import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { ESLint } from 'eslint';
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
/** eslint.config.js の 1 行の文字の配列の定数を読む(許容差の決まりの範囲は、eslint の設定の 1 か所に持つ)。形が変われば落ちる。 */
function eslintStringArray(text: string, name: string): string[] {
  const match = new RegExp(`^const ${name} = \\[([^\\]]*)\\];`, 'mu').exec(text);
  if (match === null) throw new Error(`eslint.config.js has no ${name}`);
  return [...(match[1] ?? '').matchAll(/'([^']+)'/gu)].map(item => item[1] ?? '');
}
describe('handwritten magnitude comparisons', () => {
  it('detects both forms of handwritten comparison outside lint-covered packages', () => {
    expect(handwrittenTolerance('const a = Math.abs(x-y) <= t;')).toHaveLength(1);
    expect(handwrittenTolerance('// Math.abs(x-y) <= t\nconst a = Math.abs(x) <= t;')).toEqual([]);
    expect(originalToleranceExtra('const x = Math.abs(a) <= tol;')).toHaveLength(1);
    expect(originalToleranceExtra('const x = Math.abs(a-b) <= tol;')).toEqual([]);
    expect(originalToleranceExtra('// Math.abs(a) <= tol')).toEqual([]);
    expect(originalToleranceExtra('if (Math.abs(trial) > plasticBarYieldStressPa(plan.material, kappa)) {}')).toHaveLength(1);
  });
  it('applies the actual magnitude rule to the import-free spline', async () => {
    const config: unknown = await new ESLint({ cwd: root })
      .calculateConfigForFile('packages/kernel/src/math/splineInterpolation.ts');
    expect(config).toHaveProperty(['rules', 'tolerance/comparison'], [2]);
  });
  it('has zero handwritten comparisons in the product trees outside the lint rule', () => {
    const config = readFileSync(resolve(root, 'eslint.config.js'), 'utf8');
    const rulePackages = eslintStringArray(config, 'TOLERANCE_RULE_PACKAGES');
    expect([rulePackages.length > 0, config.includes('`packages/{${TOLERANCE_RULE_PACKAGES.join(\',\')}}/src/**/*.{ts,tsx,mts,cts}`')])
      .toEqual([true, true]);
    const roots = ['packages', 'apps'].flatMap(group => readdirSync(resolve(root, group), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(resolve(root, group, entry.name, 'src')))
      .filter(entry => group !== 'packages' || !rulePackages.includes(entry.name))
      .map(entry => posix.join(group, entry.name, 'src')));
    const violations = roots.flatMap(dir => productFiles(root, dir, path => productTypeScript(path)
      && !/\.d\.[cm]?ts$/u.test(path) && !/\.spec\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path)))
      .flatMap(path => {
        const source = readFileSync(resolve(root, path), 'utf8');
        return [...handwrittenTolerance(source, path), ...originalToleranceExtra(source, path)].map(item => path + ': ' + item);
      });
    expect(violations).toEqual([]);
  });
});
