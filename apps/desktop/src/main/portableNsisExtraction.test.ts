import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { portableExtractionDirectory } from '../../../../scripts/release/portableLaunch.mjs';
import { NSIS_PLUGINS_DIRECTORY, nsisExtractionDirectory } from './portableExtraction.mjs';

// 製品の終了後の片付け（portableCleanup.ts）と、配布 CI の単一 exe の段（scripts/release/portableLaunch.mjs →
// e2e/release/portableDesktopSupport.ts）が共有する、ただ1つの展開先の判定。
// NSIS の展開先の名前は "ns" ＋英字1文字＋16進の1〜4桁＋".tmp"（CI run 36818570903 の実物は nsy3217.tmp）。
describe('単一ポータブル exe の NSIS の展開先（共有の判定）', () => {
  const temporary = 'D:/a/PointerCAD/PointerCAD/scratchpad/temp/p/241625/t';

  /** The release script throws where the shared judgement returns null; both must agree on every case. */
  function accepted(executable: string, folder = temporary): string | null {
    const shared = nsisExtractionDirectory(executable, folder);
    if (shared === null) expect(() => portableExtractionDirectory(executable, folder)).toThrow('outside');
    else expect(portableExtractionDirectory(executable, folder)).toBe(shared);
    return shared;
  }

  it('この実行の一時フォルダーの直下の NSIS の展開フォルダーの app の本体を受ける', () => {
    // a と z は3文字目の両端、i は v1.0.0 が唯一受けていた形。
    for (const name of ['nsy3217.tmp', 'nsi1a2.tmp', 'nsa0.tmp', 'nsz123A.tmp', 'NSY3217.TMP', 'nszffff.tmp', 'nsiAD.tmp']) {
      const directory = win32.join(temporary, name);
      expect(accepted(win32.join(directory, 'app', 'PointerCAD.exe'))).toBe(directory);
    }
    // 実際の CI の記録のとおりの逆斜線の形と、一時フォルダーの大文字小文字の違いも同じ判定になる。
    const actual = win32.normalize(`${temporary}/nsy3217.tmp/app/PointerCAD.exe`);
    expect(accepted(actual, temporary.toUpperCase())).toBe(win32.dirname(win32.dirname(actual)));
  });

  it('名前の決まりに合わない展開先を拒む', () => {
    for (const name of ['nsz.tmp', 'abc123.tmp', 'ns1234.tmp', 'nsyy3217.tmp', 'nsy12345.tmp', 'nsy3g17.tmp',
      'nsy3217.tmp.old', 'nsy3217', 'xnsy3217.tmp', 'pointercad-cleanup-abc123']) {
      expect(NSIS_PLUGINS_DIRECTORY.test(name), name).toBe(false);
      expect(accepted(`${temporary}/${name}/app/PointerCAD.exe`), name).toBeNull();
    }
  });

  it('別の親・app の外・別の実行ファイル・相対パスを拒む', () => {
    for (const path of ['C:/Windows/PointerCAD.exe', `${temporary}-other/nsy3217.tmp/app/PointerCAD.exe`,
      `${temporary}/nested/nsy3217.tmp/app/PointerCAD.exe`, `D:/a/Temp/nsy3217.tmp/app/PointerCAD.exe`,
      `${temporary}/nsy3217.tmp/PointerCAD.exe`, `${temporary}/nsy3217.tmp/app/sub/PointerCAD.exe`,
      `${temporary}/nsy3217.tmp/other/PointerCAD.exe`, `${temporary}/nsy3217.tmp/app/Other.exe`,
      'nsy3217.tmp/app/PointerCAD.exe']) {
      expect(accepted(path), path).toBeNull();
    }
    expect(accepted(`${temporary}/nsy3217.tmp/app/PointerCAD.exe`, 'scratchpad/temp/p/241625/t')).toBeNull();
  });
});
