import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nsisExtractionDirectory } from '../../../../e2e/release/portableExtraction.mjs';

// 配布 CI の単一 exe の段（e2e/release/portableDesktopSupport.ts）が使う展開先の判定。
// NSIS の展開先の名前は "ns" ＋英字1文字＋16進の1〜4桁＋".tmp"（CI run 36818570903 の実物は nsy3217.tmp）。
describe('単一ポータブル exe の NSIS の展開先', () => {
  const temporary = 'D:/a/PointerCAD/PointerCAD/scratchpad/temp/p/241625/t';

  it('この実行の一時フォルダーの直下の NSIS の展開フォルダーの app の本体を受ける', () => {
    for (const name of ['nsy3217.tmp', 'nsi1a2.tmp', 'nsa0.tmp', 'nsz123A.tmp', 'NSY3217.TMP']) {
      const directory = win32.join(temporary, name);
      expect(nsisExtractionDirectory(win32.join(directory, 'app', 'PointerCAD.exe'), temporary)).toBe(directory);
    }
    // 実際の CI の記録のとおりの逆斜線の形と、一時フォルダーの大文字小文字の違いも同じ判定になる。
    const actual = win32.normalize(`${temporary}/nsy3217.tmp/app/PointerCAD.exe`);
    expect(nsisExtractionDirectory(actual, temporary.toUpperCase())).toBe(win32.dirname(win32.dirname(actual)));
  });

  it('名前の決まりに合わない展開先を拒む', () => {
    for (const name of ['nsz.tmp', 'abc123.tmp', 'ns1234.tmp', 'nsyy3217.tmp', 'nsy12345.tmp', 'nsy3g17.tmp',
      'nsy3217.tmp.old', 'nsy3217', 'xnsy3217.tmp']) {
      expect(() => nsisExtractionDirectory(`${temporary}/${name}/app/PointerCAD.exe`, temporary)).toThrow('outside');
    }
  });

  it('別の親・app の外・別の実行ファイル・相対パスを拒む', () => {
    for (const path of ['C:/Windows/PointerCAD.exe', `${temporary}-other/nsy3217.tmp/app/PointerCAD.exe`,
      `${temporary}/nested/nsy3217.tmp/app/PointerCAD.exe`, `D:/a/Temp/nsy3217.tmp/app/PointerCAD.exe`,
      `${temporary}/nsy3217.tmp/PointerCAD.exe`, `${temporary}/nsy3217.tmp/app/sub/PointerCAD.exe`,
      `${temporary}/nsy3217.tmp/other/PointerCAD.exe`, `${temporary}/nsy3217.tmp/app/Other.exe`,
      'nsy3217.tmp/app/PointerCAD.exe']) {
      expect(() => nsisExtractionDirectory(path, temporary)).toThrow('outside');
    }
    expect(() => nsisExtractionDirectory(`${temporary}/nsy3217.tmp/app/PointerCAD.exe`, 'scratchpad/temp/p/241625/t'))
      .toThrow('outside');
  });
});
