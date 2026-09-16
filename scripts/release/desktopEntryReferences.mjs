import ts from 'typescript';

/** Prove the emitted Node entries do not resolve dependencies from the development machine. */
export function inspectDesktopEntry(name, bytes) {
  const source = new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length !== 0) throw new Error('Malformed desktop entry: ' + name);
  const allowed = new Set(name === 'preload/preload.cjs' ? ['electron']
    : ['electron', 'node:path', 'node:url', 'node:fs', 'node:crypto']);
  const references = new Set();
  const accept = node => {
    if (!node || !ts.isStringLiteralLike(node) || !allowed.has(node.text)) {
      throw new Error('Unbundled or dynamic desktop dependency: ' + name);
    }
    references.add(node.text);
  };
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) accept(node.moduleSpecifier);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      if (node.arguments.length !== 1) throw new Error('Invalid desktop dependency call');
      accept(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!references.has('electron')) throw new Error('Desktop entry has no Electron interface');
  return [...references].sort();
}
