import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { extensionsOf } from './fileGateway.js';
import { nativeFileFilter, isFileDialogKind, FILE_KIND_SPECS } from '@pointercad/ui/file-contracts';

// The file contract is also imported by Electron's main process; it must not load React.
vi.mock('react', () => { throw new Error('ファイル契約の読込にReactは不要です'); });

describe('Web/Desktop共通のファイル選択契約', () => {
  it('CSVは読込対象CAD形式には混ぜず、共通の保存フィルタに載せる', () => {
    expect(nativeFileFilter('csv')).toEqual({ name: 'CSV', extensions: ['csv'] });
    expect(extensionsOf('csv')).toEqual(['.csv']);
  });
  it('全形式の拡張子とその順序が両方の入口で一致する', () => {
    for (const kind of Object.keys(FILE_KIND_SPECS)) {
      if (!isFileDialogKind(kind)) throw new Error(`形式が解決できません: ${kind}`);
      const filter = nativeFileFilter(kind);
      expect(filter.extensions.map(extension => `.${extension}`)).toEqual(extensionsOf(kind));
      expect(filter.name.length).toBeGreaterThan(0);
    }
  });

  it.each(['__proto__', 'constructor', 'toString', '', 'STEP', 'unknown'])(
    '画面から受け取った未知の種類%sを拒否する', kind => {
      expect(isFileDialogKind(kind)).toBe(false);
    },
  );

  it('OSへ渡した拡張子配列の変更が次のダイアログへ漏れない', () => {
    nativeFileFilter('step').extensions.push('unexpected');
    expect(nativeFileFilter('step').extensions).toEqual(['step', 'stp']);
    expect(extensionsOf('step')).toEqual(['.step', '.stp']);
  });
});

function runtimeImports(text: string): string[] {
  const source = ts.createSourceFile('file.ts', text, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (clause?.isTypeOnly) continue;
    if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
      && clause.namedBindings.elements.every(element => element.isTypeOnly)) continue;
    imports.push(statement.moduleSpecifier.text);
  }
  return imports;
}

it('文書操作への逆参照を型だけにし、共有する読込エラーと部品dirty cacheを一箇所に保つ', () => {
  const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
  for (const name of ['assemblyFile.ts', 'drawingFile.ts']) {
    expect(runtimeImports(source(name))).not.toContain('./partFile.js');
    expect(source(name)).toContain("import type { PartFileDeps } from './partFile.js'");
    expect(runtimeImports(source(name))).toContain('./documentReadError.js');
  }
  for (const name of ['documentReadError.ts', 'partDocumentDirty.ts']) {
    expect(runtimeImports(source(name)).filter(path =>
      ['./partFile.js', './assemblyFile.js', './drawingFile.js'].includes(path))).toEqual([]);
  }
  const part = source('partFile.ts');
  expect(part).toContain("export { openErrorMessageKey } from './documentReadError.js'");
  expect(part).toContain("export { hasUnsavedChanges } from './partDocumentDirty.js'");
  expect(part).not.toContain('let cachedDocument');
  expect(source('partDocumentDirty.ts').match(/let cachedDocument/g)).toHaveLength(1);
});
