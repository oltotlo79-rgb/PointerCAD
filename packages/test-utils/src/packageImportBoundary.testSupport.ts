import { readdirSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

export const testOnlyFile = /\.(?:test|testSupport)\.(?:[cm]?[jt]s|[jt]sx)$/u;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringLiteral(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  if (value.type === 'Literal' && typeof value.value === 'string') return value.value;
  if (value.type === 'TSLiteralType') return stringLiteral(value.literal);
  if (value.type === 'TemplateLiteral' && Array.isArray(value.expressions) && value.expressions.length === 0
    && Array.isArray(value.quasis) && value.quasis.length === 1) {
    const part: unknown = value.quasis[0];
    if (record(part) && record(part.value) && typeof part.value.cooked === 'string') return part.value.cooked;
  }
  return undefined;
}

function visitSource(path: string, source: string, visitor: (node: Readonly<Record<string, unknown>>) => void): void {
  let ast: unknown;
  const messages = new Linter().verify(source, [{
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { boundary: { rules: { capture: { create: () => ({ Program(node) { ast = node; } }) } } } },
    rules: { 'boundary/capture': 'error' },
  }], { filename: path });
  if (messages.some(message => message.fatal) || !record(ast)) throw new Error(`Missing parsed source: ${path}`);
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      const children: readonly unknown[] = value;
      children.forEach(visit);
      return;
    }
    if (!record(value) || typeof value.type !== 'string') return;
    visitor(value);
    for (const [key, child] of Object.entries(value)) {
      if (!['parent', 'tokens', 'comments', 'loc', 'range'].includes(key)) visit(child);
    }
  }
  visit(ast);
}

export function moduleSpecifiers(path: string, source: string): string[] {
  const result: string[] = [];
  visitSource(path, source, value => {
    const sourceNode: unknown = value.type === 'TSImportType' ? value.argument
      : ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(String(value.type))
        ? value.source : undefined;
    const specifier = stringLiteral(sourceNode);
    if (specifier !== undefined) result.push(specifier);
  });
  return result;
}

/** Covers imported aliases, qualified types and import types without matching comments. */
export function sourceIdentifiers(path: string, source: string): string[] {
  const result: string[] = [];
  visitSource(path, source, value => {
    if (value.type === 'Identifier' && typeof value.name === 'string') result.push(value.name);
  });
  return result;
}

export function productTypeScript(path: string): boolean {
  // Exclude test implementations, but reject product imports of these files in the policies.
  return /\.(?:[cm]?ts|tsx)$/u.test(path) && !testOnlyFile.test(path);
}

export function productFiles(root: string, directory: string,
  acceptFile: (path: string) => boolean = productTypeScript): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) return productFiles(root, path, acceptFile);
    return entry.isFile() && acceptFile(path) ? [path] : [];
  }).sort();
}

/** Nonliteral dynamic imports cannot be proven to stay within the e2e layer. */
export function unresolvedDynamicImports(path: string, source: string): number {
  let count = 0;
  visitSource(path, source, value => {
    if (value.type === 'ImportExpression' && stringLiteral(value.source) === undefined) count++;
  });
  return count;
}

/** Report whether each parsed module reference is explicitly type-only. */
export function moduleReferences(path: string, source: string): { specifier: string; typeOnly: boolean }[] {
  const result: { specifier: string; typeOnly: boolean }[] = [];
  visitSource(path, source, value => {
    const isImportType = value.type === 'TSImportType';
    const sourceNode: unknown = isImportType ? value.argument
      : ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(String(value.type))
        ? value.source : undefined;
    const specifier = stringLiteral(sourceNode);
    const individualTypes = (value.type === 'ImportDeclaration' || value.type === 'ExportNamedDeclaration')
      && Array.isArray(value.specifiers) && value.specifiers.length > 0
      && value.specifiers.every(item => record(item) && (value.type === 'ImportDeclaration'
        ? item.importKind === 'type' : item.exportKind === 'type'));
    if (specifier !== undefined) result.push({ specifier, typeOnly: isImportType
      || value.importKind === 'type' || value.exportKind === 'type' || individualTypes });
  });
  return result;
}

/** Capture exact source expressions of nonliteral dynamic imports. */
export function dynamicImportExpressions(path: string, source: string): string[] {
  const result: string[] = [];
  visitSource(path, source, value => {
    if (value.type !== 'ImportExpression' || stringLiteral(value.source) !== undefined) return;
    if (!record(value.source) || !Array.isArray(value.source.range) || value.source.range.length !== 2
      || typeof value.source.range[0] !== 'number' || typeof value.source.range[1] !== 'number') {
      throw new Error(`Missing dynamic import expression range: ${path}`);
    }
    result.push(source.slice(value.source.range[0], value.source.range[1]));
  });
  return result;
}
