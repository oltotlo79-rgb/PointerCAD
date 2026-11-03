import * as ts from 'typescript';
interface ParsedSource extends ts.SourceFile { readonly parseDiagnostics: readonly ts.Diagnostic[] }
/** Identify direct absolute differences on either side of an ordered comparison. */
export function handwrittenTolerance(source: string, filename = 'source.ts'): string[] {
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
export function checkedToleranceBaseline(value: unknown): Record<string, Record<string, number>> {
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
export function originalToleranceExtra(source: string, filename = 'source.ts'): string[] {
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
