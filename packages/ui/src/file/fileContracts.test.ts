import { describe, expect, it, vi } from 'vitest';
import { extensionsOf } from './fileGateway.js';
import { nativeFileFilter, isFileDialogKind, FILE_KIND_SPECS } from '@pointercad/ui/file-contracts';

// The file contract is also imported by Electron's main process; it must not load React.
vi.mock('react', () => { throw new Error('ファイル契約の読込にReactは不要です'); });

describe('Web/Desktop共通のファイル選択契約', () => {
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
